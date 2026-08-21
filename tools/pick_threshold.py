import numpy as np
from sklearn.metrics import roc_curve
import os

if not os.path.exists("sims.npy") or not os.path.exists("labels.npy"):
    print("Error: sims.npy or labels.npy not found.")
    print("Please run generate_lfw_eval.py first to extract embeddings and similarities.")
    exit(1)

sim = np.load("sims.npy")
label = np.load("labels.npy")

print(f"Loaded {len(sim)} samples for evaluation.")

fpr, tpr, thr = roc_curve(label, sim)

print("Evaluation Results:")
print("-------------------")
for target in (1e-3, 1e-4):
    # Find the threshold where FPR is closest to target
    i = np.argmin(np.abs(fpr - target))
    tau = thr[i]
    tauQ = round(tau * 127 * 127)
    tar = tpr[i]
    actual_fpr = fpr[i]
    print(f"Target FAR={target:g}")
    print(f"  Actual FAR = {actual_fpr:.6f}")
    print(f"  TAR        = {tar:.4f}")
    print(f"  tau        = {tau:.4f}")
    print(f"  tauQ       = {tauQ}")
    print()

print("Use tauQ in your smart contract and ZK circuit.")
