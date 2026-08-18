import os
import urllib.request

MODELS_DIR = os.path.join(os.path.dirname(__file__), "..", "web", "public", "models")
os.makedirs(MODELS_DIR, exist_ok=True)

# Using jsdelivr CDN for fast, reliable delivery without rate limits
BASE_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights/"

FILES = [
    "tiny_face_detector_model-weights_manifest.json",
    "tiny_face_detector_model-shard1",
    "face_landmark_68_model-weights_manifest.json",
    "face_landmark_68_model-shard1",
    "face_recognition_model-weights_manifest.json",
    "face_recognition_model-shard1",
    "face_recognition_model-shard2",
]

print(f"Downloading face-api.js model weights to {MODELS_DIR}...")

for filename in FILES:
    dest_path = os.path.join(MODELS_DIR, filename)
    if os.path.exists(dest_path) and os.path.getsize(dest_path) > 0:
        print(f"  [OK] {filename} already exists")
        continue
    url = BASE_URL + filename
    print(f"  Downloading {filename}...")
    try:
        urllib.request.urlretrieve(url, dest_path)
        print(f"  [OK] Downloaded {filename} ({os.path.getsize(dest_path)} bytes)")
    except Exception as e:
        print(f"  [FAIL] {filename}: {e}")

print("Done.")
