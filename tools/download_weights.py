import os
import urllib.request

base_url = "https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights/"
weights_dir = "models"

files = [
    "tiny_face_detector_model-weights_manifest.json",
    "tiny_face_detector_model-shard1",
    "face_landmark_68_model-weights_manifest.json",
    "face_landmark_68_model-shard1",
    "face_recognition_model-weights_manifest.json",
    "face_recognition_model-shard1",
    "face_recognition_model-shard2"
]

if not os.path.exists(weights_dir):
    os.makedirs(weights_dir)

for f in files:
    url = base_url + f
    out_path = os.path.join(weights_dir, f)
    if not os.path.exists(out_path):
        print(f"Downloading {f}...")
        try:
            urllib.request.urlretrieve(url, out_path)
            print(f"Downloaded {f}")
        except Exception as e:
            print(f"Failed to download {f}: {e}")
    else:
        print(f"{f} already exists.")
print("All weights downloaded.")
