/**
 * AegisDID — Quantization & In-Circuit Similarity Calculations
 * Strictly adheres to docs/CRYPTO_SPEC.md.
 * 
 * IMPORTANT: Strictly local computation. Zero network imports allowed in lib/ml/.
 */

/**
 * Quantize an L2-normalized 128-dimensional float embedding into field-safe unsigned uint8 format.
 * Formula:
 *   q_i = clamp(round(z_i * 127), -127, 127)
 *   u_i = q_i + 128  ∈ [1, 255]
 */
export function quantizeEmbedding(embedding: number[] | Float32Array): number[] {
  if (embedding.length !== 128) {
    throw new Error(`Expected 128-dimensional embedding, received ${embedding.length}`);
  }

  // Calculate L2 norm to ensure normalization
  let normSq = 0;
  for (let i = 0; i < 128; i++) {
    normSq += embedding[i] * embedding[i];
  }
  const norm = Math.sqrt(normSq) || 1.0;

  const u: number[] = new Array(128);
  for (let i = 0; i < 128; i++) {
    const z_i = embedding[i] / norm; // Ensure L2-normalized
    const q_i = Math.max(-127, Math.min(127, Math.round(z_i * 127)));
    u[i] = q_i + 128; // Shift to [1, 255]
  }

  return u;
}

/**
 * Compute the fixed-point dot product between live and registered quantized embeddings.
 * Formula:
 *   dot = Σ_{i=0}^{127} (u_live_i - 128) * (u_reg_i - 128)
 * Range: dot ∈ [-2097152, 2097152]
 */
export function computeQuantizedDotProduct(uLive: number[], uReg: number[]): number {
  if (uLive.length !== 128 || uReg.length !== 128) {
    throw new Error('Both embeddings must be 128 elements long');
  }

  let dot = 0;
  for (let i = 0; i < 128; i++) {
    const qLive = uLive[i] - 128;
    const qReg = uReg[i] - 128;
    dot += qLive * qReg;
  }
  return dot;
}

/**
 * Calculate the quantized threshold tauQ from a cosine threshold tau_cosine.
 * tauQ = round(tau_cosine * 127 * 127)
 */
export function cosineToTauQ(tauCosine: number): number {
  return Math.round(tauCosine * 127 * 127);
}

/**
 * Check if the similarity meets or exceeds tauQ.
 */
export function verifySimilarityThreshold(uLive: number[], uReg: number[], tauQ: number): boolean {
  const dot = computeQuantizedDotProduct(uLive, uReg);
  return (dot + 2097152) >= (tauQ + 2097152);
}
