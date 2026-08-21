#!/usr/bin/env python3
"""
Export LFW funneled images as a raw RGB blob for the Node-side FAR/TAR harness.

WHY RAW BYTES
  The evaluation must measure the *deployed* face pipeline — face-api.js TinyFaceDetector +
  FaceLandmark68Net + FaceRecognitionNet, the exact weights that MODEL_HASH commits to. That
  pipeline is JavaScript, so the descriptors have to be computed in Node. Node has no built-in
  JPEG/PNG decoder and this project has no image-decoding npm dependency, so Python decodes
  (Pillow) and hands over uncompressed RGB. Node reads the bytes straight into a tf.Tensor3D,
  which is exactly what tf.browser.fromPixels() produces in the browser (uint8 range 0-255).

  This deliberately does NOT use tools/generate_lfw_eval.py, which measures dlib's own
  ResNet-34 via `face_recognition`. That is a different model from the one deployed, so its
  numbers would be a proxy, not a measurement of what ships.

PAIRING STRATEGY
  Descriptors are computed once per image, then every unordered pair is labelled genuine
  (same identity) or impostor (different identity). That yields far more pairs per decoded
  image than a fixed pair list: ~1000 images gives ~1800 genuine and ~500k impostor pairs,
  which is what makes a FAR down to 1e-3 measurable at all.

Usage:  ./venv/bin/python lfw_export_raw.py [--max-ids 250] [--max-per-id 4] [--out ../web/.eval]
"""

import argparse
import json
import os
import sys

from PIL import Image

LFW_DIR = os.path.expanduser("~/scikit_learn_data/lfw_home/lfw_funneled")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-ids", type=int, default=250, help="identities with >=2 images to include")
    ap.add_argument("--max-per-id", type=int, default=4, help="images per identity")
    ap.add_argument("--out", default="../web/.eval", help="output directory")
    ap.add_argument("--size", type=int, default=250, help="square edge length written per image")
    args = ap.parse_args()

    if not os.path.isdir(LFW_DIR):
        print(f"ERROR: LFW not found at {LFW_DIR}", file=sys.stderr)
        print("Run: ./venv/bin/python -c 'from sklearn.datasets import fetch_lfw_people;"
              " fetch_lfw_people(min_faces_per_person=200, resize=0.25)'", file=sys.stderr)
        return 1

    # Identities with at least 2 images, so genuine pairs exist. Sorted for reproducibility.
    people = []
    for name in sorted(os.listdir(LFW_DIR)):
        d = os.path.join(LFW_DIR, name)
        if not os.path.isdir(d):
            continue
        imgs = sorted(f for f in os.listdir(d) if f.lower().endswith(".jpg"))
        if len(imgs) >= 2:
            people.append((name, imgs))

    print(f"identities with >=2 images: {len(people)} (of {len(os.listdir(LFW_DIR))} total)")

    # Prefer identities with more images first: more genuine pairs per decoded image.
    people.sort(key=lambda p: (-len(p[1]), p[0]))
    people = people[: args.max_ids]

    os.makedirs(args.out, exist_ok=True)
    blob_path = os.path.join(args.out, "images.bin")
    manifest_path = os.path.join(args.out, "manifest.json")

    S = args.size
    items = []
    written = 0
    with open(blob_path, "wb") as blob:
        for ident_index, (name, imgs) in enumerate(people):
            for fn in imgs[: args.max_per_id]:
                path = os.path.join(LFW_DIR, name, fn)
                try:
                    with Image.open(path) as im:
                        im = im.convert("RGB")
                        if im.size != (S, S):
                            im = im.resize((S, S), Image.BILINEAR)
                        blob.write(im.tobytes())
                except Exception as e:  # a corrupt file must not silently shrink the corpus
                    print(f"  SKIP {name}/{fn}: {type(e).__name__}: {e}", file=sys.stderr)
                    continue
                items.append({"identity": ident_index, "name": name, "file": fn})
                written += 1

    genuine = 0
    per_id: dict[int, int] = {}
    for it in items:
        per_id[it["identity"]] = per_id.get(it["identity"], 0) + 1
    for k in per_id.values():
        genuine += k * (k - 1) // 2
    total_pairs = written * (written - 1) // 2

    manifest = {
        "source": "LFW funneled (scikit-learn fetch, figshare mirror)",
        "height": S,
        "width": S,
        "channels": 3,
        "count": written,
        "identities": len(per_id),
        "bytesPerImage": S * S * 3,
        "expectedGenuinePairs": genuine,
        "expectedImpostorPairs": total_pairs - genuine,
        "items": items,
    }
    with open(manifest_path, "w") as f:
        json.dump(manifest, f)

    print(f"wrote {written} images ({len(per_id)} identities) -> {blob_path}")
    print(f"  {os.path.getsize(blob_path) / 1e6:.1f} MB raw, {S}x{S}x3 uint8 each")
    print(f"  pairs available: {genuine} genuine, {total_pairs - genuine} impostor")
    return 0


if __name__ == "__main__":
    sys.exit(main())
