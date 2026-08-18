import numpy as np
from sklearn.metrics import roc_curve

# Ensure the files exist before running. We will generate dummy ones later if real ones aren't provided.
sim   = np.load("sims.npy")      # cosine similarities over a public face-verification pair dataset
label = np.load("labels.npy")    # 1 = same identity, 0 = different
fpr, tpr, thr = roc_curve(label, sim)
for target in (1e-3, 1e-4):
    i = np.argmin(np.abs(fpr - target))
    tau = thr[i]
    if tau == np.inf:
        tau = 1.0
    print(f"FAR={target:g}  tau={tau:.4f}  TAR={tpr[i]:.4f}  tauQ={round(tau*127*127)}")
