import numpy as np

class LSHDedup:
    def __init__(self, num_hyperplanes=16, num_tables=4):
        """
        Locality Sensitive Hashing (LSH) for coarse near-duplicate detection.
        This provides O(1) time complexity bucket checks for Sybil resistance.
        """
        self.num_hyperplanes = num_hyperplanes
        self.num_tables = num_tables
        self.dim = 128
        
        # Generate random hyperplanes for each table
        np.random.seed(42)
        self.hyperplanes = [np.random.randn(self.num_hyperplanes, self.dim) for _ in range(self.num_tables)]
        
        # Hash tables mapping bucket signatures to lists of user IDs
        self.tables = [{} for _ in range(self.num_tables)]
        
    def _hash_vector(self, vec, table_idx):
        """Projects a vector into a binary signature using random hyperplanes."""
        projections = np.dot(self.hyperplanes[table_idx], vec)
        # Convert positive projections to '1' and negative to '0'
        signature = ''.join(['1' if p > 0 else '0' for p in projections])
        return signature

    def enroll(self, user_id, embedding):
        """
        Hashes an embedding and checks for coarse duplicates.
        Returns a warning list of potential duplicate user_ids if found.
        """
        potential_duplicates = set()
        
        # Check all LSH tables
        for i in range(self.num_tables):
            sig = self._hash_vector(embedding, i)
            
            # If the bucket already has entries, they are potential near-duplicates
            if sig in self.tables[i]:
                for dup_id in self.tables[i]:
                    potential_duplicates.add(dup_id)
                self.tables[i].append(user_id)
            else:
                self.tables[i] = [user_id]
                
        if potential_duplicates:
            print(f"⚠️  WARNING: Coarse duplicate detected! User {user_id} shares a hash bucket with {list(potential_duplicates)}")
        else:
            print(f"✅ User {user_id} enrolled cleanly.")
            
        return list(potential_duplicates)

if __name__ == "__main__":
    print("Testing LSH Deduplication...")
    dedup = LSHDedup(num_hyperplanes=12, num_tables=5)
    
    base_face = np.random.randn(128)
    
    # User 1 registers
    dedup.enroll("User_Alice", base_face)
    
    # Completely different person registers
    dedup.enroll("User_Bob", np.random.randn(128))
    
    # Attacker tries to register with Alice's photo (near identical embedding)
    hacked_face = base_face + (np.random.randn(128) * 0.05)
    dedup.enroll("Attacker_Eve", hacked_face)
