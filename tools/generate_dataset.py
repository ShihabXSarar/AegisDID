import numpy as np

print("Generating realistic synthetic cosine similarities...")

np.random.seed(42)

# Generate realistic cosine similarities for 'same person' (mean ~ 0.75, std ~ 0.08)
same_sims = np.random.normal(0.75, 0.08, 20000)
# Generate realistic cosine similarities for 'different person' (mean ~ 0.15, std ~ 0.10)
diff_sims = np.random.normal(0.15, 0.10, 20000)

sims = np.concatenate([same_sims, diff_sims])
labels = np.concatenate([np.ones(20000), np.zeros(20000)])

np.save("sims.npy", sims.astype(np.float32))
np.save("labels.npy", labels.astype(np.int32))
print("Successfully saved realistic sims.npy and labels.npy")
