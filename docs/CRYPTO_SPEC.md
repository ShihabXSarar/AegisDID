Field: BN254 scalar field r
Hash: Poseidon (circomlib parameters, x^5 S-box)

Embedding quantization:
  z ∈ R^128, L2-normalized
  q_i = clamp(round(z_i * 127), -127, 127)
  u_i = q_i + 128           ∈ [1, 255]   // field-safe unsigned encoding
  MODEL_HASH = keccak256(model_bytes) mod r

Embedding commitment:
  h_j    = Poseidon16(u_[16j .. 16j+15])   for j = 0..7
  C_emb  = Poseidon9(h_0..h_7, salt)        salt ← 254-bit CSPRNG (browser crypto.getRandomValues)

Identity commitment (Merkle leaf):
  C_id   = Poseidon3(idSecret, C_emb, MODEL_HASH)
  idSecret ← 254-bit CSPRNG, stored in browser IndexedDB, never transmitted

Nullifier:
  nf     = Poseidon3(idSecret, policyId, epoch)

Similarity (fixed point, in-circuit):
  dot    = Σ_{i=0}^{127} (u_live_i - 128) * (u_reg_i - 128)
  range  : dot ∈ [-2097152, 2097152]
  accept : dot + 2^22  >=  tauQ + 2^22
  tauQ   = round(tau_cosine * 127 * 127), stored on-chain per policy

Merkle: binary IMT, depth 20, Poseidon2, zero-leaf = 0
