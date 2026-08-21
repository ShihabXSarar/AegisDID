import numpy as np
import sys
import json

class LSHDedup:
    def __init__(self, num_hyperplanes=16, seed=42):
        """
        Coarse locality-sensitive hashing (LSH) for quantized embeddings.
        This is a PROCEDURAL safeguard against near-duplicates during enrollment,
        not a cryptographic block.
        """
        np.random.seed(seed)
        # We generate random hyperplanes for 128D space
        self.hyperplanes = np.random.randn(num_hyperplanes, 128)
        self.buckets = {}
        
    def _get_hash(self, u_emb):
        """
        Compute the LSH hash bucket for a given quantized embedding.
        u_emb: 128D array of uint8 values (quantized)
        """
        # Convert back to zero-centered for dot product
        z = np.array(u_emb, dtype=np.float32) - 128.0
        
        # Project onto hyperplanes
        projections = np.dot(self.hyperplanes, z)
        
        # Binary quantization based on the sign of projection
        bits = projections > 0
        
        # Convert boolean array to an integer hash
        bucket_hash = 0
        for b in bits:
            bucket_hash = (bucket_hash << 1) | int(b)
            
        return bucket_hash
        
    def add_and_check(self, commitment_id, u_emb):
        """
        Add a new enrollment to a bucket and check if it already contains others.
        Returns a list of potential duplicate commitment IDs.
        """
        h = self._get_hash(u_emb)
        
        if h in self.buckets:
            duplicates = self.buckets[h].copy()
            self.buckets[h].append(commitment_id)
            return duplicates
        else:
            self.buckets[h] = [commitment_id]
            return []

if __name__ == "__main__":
    # Quick test logic if run directly
    print("Testing Procedural LSH Dedup Tool...")
    dedup = LSHDedup(num_hyperplanes=16)
    
    # Generate two random similar vectors
    base = np.random.randint(50, 200, 128)
    almost_same = base + np.random.randint(-2, 3, 128)
    completely_diff = np.random.randint(50, 200, 128)
    
    print("Base vector added:")
    dups = dedup.add_and_check("c_id_1", base)
    print(f"Duplicates found: {dups}")
    
    print("\nAlmost identical vector added:")
    dups = dedup.add_and_check("c_id_2", almost_same)
    print(f"Duplicates found (should flag c_id_1): {dups}")
    if len(dups) > 0:
        print("-> ADMIN WARNING: Near-duplicate enrollment candidate detected!")
        
    print("\nCompletely different vector added:")
    dups = dedup.add_and_check("c_id_3", completely_diff)
    print(f"Duplicates found (should be empty): {dups}")
