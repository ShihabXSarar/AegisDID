# Evaluation Plan: AegisDID Face Verification Model

> **This plan was superseded before execution.** It specified measuring **dlib's** HOG detector and
> ResNet-34 through the Python `face_recognition` package. That is a *different* network from the one
> the prototype actually runs, so its FAR/TAR would have been a **proxy** for the deployed model
> rather than a measurement of it — and the threshold `tauQ` it produced would have been applied to a
> pipeline it had never scored.
>
> The evaluation that was actually carried out drives the deployed face-api.js pipeline directly.
> Method, results and caveats: [`RESULTS.md`](RESULTS.md). Harness:
> `web/scripts/far_tar_eval.mts`.
>
> This file is retained to record what changed and why. §5 states the difference and §6 records one
> assumption in the original plan that the measurement disproved.

## 1. Dataset

The **Labeled Faces in the Wild (LFW)** dataset, funneled version. LFW contains 13,233 images of
5,749 people under unconstrained conditions.

*As executed:* 1,000 images across the 250 identities holding the most images were decoded, yielding
951 usable descriptors, 1,357 genuine pairs and 450,368 impostor pairs. The standard 6,000-pair
restricted protocol was **not** used; all-pairs scoring was used instead, because it produces ~75×
more impostor pairs and a FAR of 10⁻³ is not measurable at all from 3,000 impostor pairs.

## 2. Preprocessing

*As planned (dlib route — not executed):*
1. dlib HOG-based face detector.
2. 68-point landmarks → affine alignment.
3. dlib ResNet-34 → 128-d descriptor.

*As executed (deployed route):*
1. face-api.js `TinyFaceDetector`, `inputSize: 224`, `scoreThreshold: 0.15` — the values in
   `web/lib/ml/face.ts`.
2. `FaceLandmark68Net` → `landmarks.align(null, { useDlibAlignment: true })`.
3. `FaceRecognitionNet` from `web/public/models`, the seven files `MODEL_HASH` commits to.
4. Quantization by the shipped `quantizeEmbedding` — `q_i = clamp(round(z_i · 127), −127, 127)`,
   `u_i = q_i + 128`.

Because Node has no image decoder and the project carries no image-decoding dependency, Pillow
decodes LFW to raw RGB (`tools/lfw_export_raw.py`) and Node reads those bytes into a `tf.Tensor3D` at
range 0–255 — exactly what `tf.browser.fromPixels()` yields in the browser.

## 3. Evaluation Procedure

1. Extract quantized embeddings for all usable images.
2. Compute the fixed-point dot product for every unordered pair using the shipped
   `computeQuantizedDotProduct`, labelling each pair genuine or impostor.
3. Compute TAR and FAR across `tauQ`.
4. Report operating points, EER, and the corpus resolution floor.

*Added during execution:* **a correctness gate.** Before any similarity number is reported, the
harness scores the corpus in dlib's native metric (Euclidean distance at 0.6, where dlib publishes
99.38% LFW accuracy) and **aborts without writing results** if balanced accuracy falls below 98%.
Without this, a harness bug in alignment or pixel range would have produced a plausible-looking
table describing nothing. It measured 98.68% and passed.

## 4. Execution Tools

| Tool | Role |
|---|---|
| `web/scripts/far_tar_eval.mts` | **The evaluation.** Drives the deployed pipeline; writes `web/.eval/far_tar_results.json`. |
| `tools/lfw_export_raw.py` | Decodes LFW to raw RGB for the harness. |
| `tools/generate_lfw_eval.py` | *Superseded.* dlib/`face_recognition` proxy route. Retained, unused for the reported figures. |
| `tools/pick_threshold.py` | *Superseded.* Threshold selection now happens inside the harness, in `tauQ` units. |

## 5. Why the substitution matters

`MODEL_HASH` binds a policy to a specific set of weights, and `tauQ` is stored on-chain per policy.
A threshold measured on dlib's ResNet-34 and then deployed against the face-api.js port would be a
threshold for a model the contract does not commit to. The two networks share a lineage but not their
outputs; the difference is not knowable without measuring both. Measuring the deployed model removes
the assumption entirely.

## 6. An assumption in this plan that the measurement disproved

Step 3.4 above reads: *"select a threshold `tauQ` that provides `FAR < 0.001` (0.1%), maximizing
TAR."* That target is achievable — `tauQ` 14,984 gives FAR 0.099% at TAR 91.30% — but the plan
carried an unstated assumption that any "reasonable" cosine threshold would be in the right
neighbourhood. It is not:

**Every cosine threshold ≤ 0.65 had a measured FAR of 100%.** These descriptors are trained for
Euclidean distance and are not mean-centred, so unrelated faces sit at cosine ≈ 0.8375 on average.
The usable band is only ≈ 0.90 – 0.97. Had the threshold been chosen by intuition rather than
measured — as `docs/CRYPTO_SPEC.md`'s `cosineToTauQ(0.5) = 8065` example invites — the deployed
system would have accepted every face while appearing to enforce a biometric check. See
[`RESULTS.md`](RESULTS.md) §6.
