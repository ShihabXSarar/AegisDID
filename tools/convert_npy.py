import json
import numpy as np

with open('data.json', 'r') as f:
    data = json.load(f)

sims = np.array(data['sims'], dtype=np.float32)
labels = np.array(data['labels'], dtype=np.int32)

np.save('sims.npy', sims)
np.save('labels.npy', labels)

print("Saved sims.npy and labels.npy")
