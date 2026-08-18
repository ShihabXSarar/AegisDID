/**
 * AegisDID — Client-side Poseidon Commitments & Nullifiers
 * Strictly adheres to docs/CRYPTO_SPEC.md.
 * 
 * IMPORTANT: Strictly local computation. Zero network imports allowed in lib/ml/.
 */

// circomlibjs provides buildPoseidon
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let poseidonInstance: any = null;

export async function getPoseidon() {
  if (!poseidonInstance) {
    // Dynamic import to avoid SSR issues
    const { buildPoseidon } = await import('circomlibjs');
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

/**
 * Generate a cryptographically secure 254-bit scalar random value (BN254 scalar field safe).
 */
export function generateRandomScalar(): bigint {
  const bytes = new Uint8Array(32);
  if (typeof window !== 'undefined' && window.crypto) {
    window.crypto.getRandomValues(bytes);
  } else {
    // Fallback for node testing if needed
    for (let i = 0; i < 32; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  // Clear top bits to ensure it fits comfortably within the BN254 scalar field r
  bytes[0] &= 0x1f;

  let hex = '0x';
  for (let i = 0; i < 32; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return BigInt(hex);
}

/**
 * Default MODEL_HASH placeholder (keccak256 hash of face-api weights mod r)
 */
export const DEFAULT_MODEL_HASH = BigInt(
  '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b'
);

/**
 * Compute the Embedding Commitment C_emb
 * Chunking:
 *   h_j   = Poseidon16(u_[16j .. 16j+15]) for j = 0..7
 *   C_emb = Poseidon9(h_0..h_7, salt)
 */
export async function computeEmbeddingCommitment(u: number[], salt: bigint): Promise<bigint> {
  if (u.length !== 128) {
    throw new Error('u must have exactly 128 elements');
  }

  const poseidon = await getPoseidon();
  const chunkHashes: bigint[] = [];

  for (let j = 0; j < 8; j++) {
    const chunk = u.slice(j * 16, (j + 1) * 16).map((val) => BigInt(val));
    const h_j = poseidon(chunk);
    chunkHashes.push(poseidon.F.toObject(h_j));
  }

  const topInputs = [...chunkHashes, salt];
  const topHash = poseidon(topInputs);
  return poseidon.F.toObject(topHash);
}

/**
 * Compute the Identity Commitment (Merkle leaf) C_id
 * Formula:
 *   C_id = Poseidon3(idSecret, C_emb, MODEL_HASH)
 */
export async function computeIdentityCommitment(
  idSecret: bigint,
  cEmb: bigint,
  modelHash: bigint = DEFAULT_MODEL_HASH
): Promise<bigint> {
  const poseidon = await getPoseidon();
  const cidHash = poseidon([idSecret, cEmb, modelHash]);
  return poseidon.F.toObject(cidHash);
}

/**
 * Compute the Nullifier
 * Formula:
 *   nf = Poseidon3(idSecret, policyId, epoch)
 */
export async function computeNullifier(
  idSecret: bigint,
  policyId: bigint | number | string,
  epoch: bigint | number | string
): Promise<bigint> {
  const poseidon = await getPoseidon();
  const nfHash = poseidon([idSecret, BigInt(policyId), BigInt(epoch)]);
  return poseidon.F.toObject(nfHash);
}
