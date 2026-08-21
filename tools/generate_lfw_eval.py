import numpy as np
import face_recognition
from sklearn.datasets import fetch_lfw_pairs
import os

print("Fetching LFW pairs...")
# Fetch a subset of LFW pairs (e.g., the '10_folds' subset, we'll take one fold for speed)
# 'train' subset is 2200 pairs. We'll use train for the evaluation to have enough statistics
lfw_pairs = fetch_lfw_pairs(subset='train', color=True, resize=1.0)
pairs = lfw_pairs.pairs
labels = lfw_pairs.target

print(f"Loaded {len(pairs)} pairs.")

def quantize_embedding(emb):
    # L2 normalize just in case
    norm = np.linalg.norm(emb)
    if norm > 0:
        emb = emb / norm
    # q_i = clamp(round(z_i * 127), -127, 127)
    q = np.clip(np.round(emb * 127), -127, 127)
    # u_i = q_i + 128
    return q + 128

def fixed_point_dot(u1, u2):
    # dot = Σ_{i=0}^{127} (u1_i - 128) * (u2_i - 128)
    diff1 = u1 - 128
    diff2 = u2 - 128
    return np.sum(diff1 * diff2)

sims = []
valid_labels = []

print("Extracting embeddings and computing similarities...")
# Process a maximum of 1000 pairs to keep it fast for the hackathon
max_pairs = min(1000, len(pairs))
for i in range(max_pairs):
    img1 = pairs[i][0].astype('uint8')
    img2 = pairs[i][1].astype('uint8')
    
    # Get embeddings
    enc1 = face_recognition.face_encodings(img1)
    enc2 = face_recognition.face_encodings(img2)
    
    if len(enc1) > 0 and len(enc2) > 0:
        u1 = quantize_embedding(enc1[0])
        u2 = quantize_embedding(enc2[0])
        
        # We need cosine similarity equivalent for ROC curve. 
        # Since tauQ = round(tau * 127 * 127), tau = dot / (127*127)
        dot = fixed_point_dot(u1, u2)
        sim = dot / (127.0 * 127.0)
        
        sims.append(sim)
        valid_labels.append(labels[i])
        
    if i % 100 == 0:
        print(f"Processed {i}/{max_pairs} pairs...")

np.save("sims.npy", np.array(sims))
np.save("labels.npy", np.array(valid_labels))

print(f"Saved sims.npy and labels.npy with {len(sims)} valid pairs.")
