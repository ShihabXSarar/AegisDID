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

/** BN254 scalar field order r. */
export const FIELD_ORDER = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
);

/**
 * Generate a uniformly random scalar in [1, r) using the platform CSPRNG.
 *
 * SECURITY: There is deliberately NO Math.random() fallback. `idSecret` and `salt` are the
 * only things standing between a leaked commitment and a linkable biometric record; deriving
 * either from a non-cryptographic PRNG would make them predictable. If no CSPRNG is
 * available this throws rather than returning a weak value.
 */
export function generateRandomScalar(): bigint {
  const csprng = globalThis.crypto;
  if (!csprng || typeof csprng.getRandomValues !== 'function') {
    throw new Error(
      'No cryptographically secure random source available — refusing to generate an identity secret.'
    );
  }

  // Rejection sampling over the full 256-bit range gives a uniform result in [1, r).
  // P(reject) < 2^-4 per draw, so this terminates immediately in practice.
  for (let attempt = 0; attempt < 64; attempt++) {
    const bytes = new Uint8Array(32);
    csprng.getRandomValues(bytes);

    let hex = '0x';
    for (let i = 0; i < 32; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    const candidate = BigInt(hex);
    if (candidate > 0n && candidate < FIELD_ORDER) return candidate;
  }

  throw new Error('Failed to sample a field element after 64 attempts.');
}

/**
 * MODEL_HASH — binds a commitment to the exact biometric feature extractor.
 *
 * Computed as keccak256( concat over web/public/models of (name || 0x00 || bytes) ) mod r,
 * over all 7 face-api.js weight/manifest files, sorted by filename. Reproduce with:
 *
 *   node tools/compute_model_hash.mjs
 *
 * Last computed 2026-08-21 over 7,023,338 model bytes:
 *   keccak256(preimage) = 0x4579c7ef33c51842aa2bc0021677c6f6edb439ba6090fe6d966288d2881c6ff5
 *   mod r               = 0x1515797c52937818f1db7a4b94f66e99c5805171e6d78ddc5280933e981c6ff4
 *
 * Changing any model file MUST change this constant, which invalidates every existing
 * commitment — that is the intended behaviour, not a bug.
 */
export const DEFAULT_MODEL_HASH = BigInt(
  '0x1515797c52937818f1db7a4b94f66e99c5805171e6d78ddc5280933e981c6ff4'
);

/** MODEL_HASH as a 32-byte hex string for on-chain policy parameters. */
export const DEFAULT_MODEL_HASH_BYTES32 =
  '0x' + DEFAULT_MODEL_HASH.toString(16).padStart(64, '0');

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

/*
 * NOTE: a `computeMerkleRoot(leaf, depth)` helper was removed here.
 *
 * It hashed Poseidon(current, 0) at every level, which is NOT the root of an incremental
 * Merkle tree with zero leaves — that requires the zero-hash ladder
 * (z_0 = 0, z_{i+1} = Poseidon(z_i, z_i)). The helper therefore produced a root that no
 * real tree ever has, and using it to fill in a witness would silently create proofs that
 * can never verify against a published cohort root.
 *
 * The authoritative implementation is lib/merkle/tree.ts, and the root a beneficiary proves
 * against always comes from the authority's /api/merkle/path response.
 */
