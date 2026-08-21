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
 *
 * Attainable range: each factor is in [-127, 127], so each product is in [-16129, 16129] and the
 * 128-term sum is in [-2064512, 2064512], where 2064512 = 128 * 127 * 127.
 *
 * (An earlier comment gave the range as [-2097152, 2097152]. That is 2^21, which is the circuit's
 * comparator OFFSET, not the range endpoint. See MAX_TAU_Q below and docs/CRYPTO_SPEC.md.)
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
 * Comparator offset used by the circuit: GreaterEqThan(24)(dot + 2^21, tauQ + 2^21).
 * Shifts the signed dot product into the non-negative range the comparator requires.
 */
export const CIRCUIT_COMPARATOR_OFFSET = 2097152; // 2^21

/**
 * Soundness bounds on tauQ. MUST stay in sync with AegisAid.MIN_TAU_Q / MAX_TAU_Q.
 *
 * The circuit's GreaterEqThan(24) comparator is only sound for tauQ inside the 24-bit window it
 * was sized for. A tauQ expressed as a large BN254 field residue — e.g. r - 1, i.e. "-1" in the
 * field — makes its internal range check wrap so it returns 1 unconditionally, bypassing the
 * biometric threshold entirely.
 *
 * MEASURED, not theorised: web/scripts/tauq_bound_probe.mts produces a VALID Groth16 proof for a
 * non-matching face (cosine 0.0889) at tauQ = r - 1 and at tauQ = r - 1000000. tauQ = 0 likewise
 * accepts any dot >= 0, i.e. roughly half of all random face pairs.
 *
 * MAX_TAU_Q = cosineToTauQ(1.0) = 16129 is the top of the cosine scale. It is NOT the largest
 * attainable dot: integer rounding in q_i = round(127 * z_i) means a genuine self-match lands near
 * 16129 rather than on it (measured over 20,000 random unit vectors: 15852 to 16447). A policy at
 * tauQ = 16129 is therefore sound but already too strict to be usable; the cap's real job is to
 * keep tauQ far inside the 24-bit comparator window.
 *
 * These bounds enforce SOUNDNESS, not adequacy — a tauQ inside them can still be a poor
 * threshold, and on this model most of the range is catastrophically bad. FAR/TAR has now been
 * measured on the deployed pipeline; use TAU_Q_FAR_1E3 below rather than an intuited cosine
 * (docs/RESULTS.md §5).
 */
export const MIN_TAU_Q = 1;
export const MAX_TAU_Q = 127 * 127; // 16129

/**
 * MEASURED operating point: FAR 0.099% at TAR 91.30% (cosine 0.9290), from 951 LFW descriptors
 * through the deployed pipeline — 1,357 genuine and 450,368 impostor pairs.
 * Reproduce: `node scripts/far_tar_eval.mts` from web/. Full tables: docs/RESULTS.md §5.
 */
export const TAU_Q_FAR_1E3 = 14984;

/**
 * MEASURED adequacy floor. Every cosine threshold <= 0.65 (tauQ <= 10484) accepted 450,368 of
 * 450,368 impostor pairs — a FAR of 100%. FaceRecognitionNet descriptors are trained for Euclidean
 * distance and are not mean-centred, so two DIFFERENT people score cosine ~0.8375 on average; the
 * usable band is only ~0.90-0.97. This is why a "cosine 0.5" threshold (tauQ 8065) is sound,
 * plausible-looking, and enforces no biometric check whatsoever. See docs/RESULTS.md §6.
 */
export const TAU_Q_MEASURED_FAR_100 = 10484; // cosineToTauQ(0.65)

/**
 * Adequacy — distinct from soundness (isTauQSound). Answers "is this threshold any good", which the
 * contract cannot enforce and the circuit cannot know. Advisory: returns a warning for the operator,
 * never a hard rejection, because the measurement is on LFW and not on the deployed population.
 *
 * Returns null when the value is at or above the measured FAR ~= 1e-3 point.
 */
export function tauQAdequacyWarning(tauQ: number): string | null {
  if (!Number.isFinite(tauQ)) return null;
  if (tauQ <= TAU_Q_MEASURED_FAR_100) {
    return `MEASURED FAR 100% — every impostor pair in the evaluation was accepted at cosine ≤ 0.65 (tauQ ≤ ${TAU_Q_MEASURED_FAR_100}). This policy would enforce no biometric check while producing valid proofs.`;
  }
  if (tauQ < TAU_Q_FAR_1E3) {
    return `Below the measured FAR ≈ 10⁻³ point (tauQ ${TAU_Q_FAR_1E3}). Usable, but the false-accept rate rises steeply here — see docs/RESULTS.md §5.`;
  }
  if (tauQ > 15852) {
    return `Above the lowest measured genuine self-match dot (15852). Legitimate beneficiaries will be rejected; a policy at MAX_TAU_Q ${MAX_TAU_Q} is sound but not reliably claimable.`;
  }
  return null;
}

/**
 * Whether a tauQ value is inside the range where the in-circuit comparator is sound.
 * Accepts bigint because on-chain reads arrive as bigint.
 *
 * Never throws: NaN, Infinity and non-integers are simply unsound. Callers use this in render
 * paths where a throw would blank the page.
 */
export function isTauQSound(tauQ: number | bigint): boolean {
  if (typeof tauQ === 'number') {
    if (!Number.isInteger(tauQ)) return false;
    return tauQ >= MIN_TAU_Q && tauQ <= MAX_TAU_Q;
  }
  return tauQ >= BigInt(MIN_TAU_Q) && tauQ <= BigInt(MAX_TAU_Q);
}

/**
 * Check if the similarity meets or exceeds tauQ.
 *
 * Refuses out-of-range tauQ rather than mirroring the circuit's wrap-around behaviour: this
 * function is used for local pre-flight feedback, and silently agreeing with an unsound circuit
 * acceptance would tell the user "your face matched" when the threshold was actually bypassed.
 */
export function verifySimilarityThreshold(uLive: number[], uReg: number[], tauQ: number): boolean {
  if (!isTauQSound(tauQ)) {
    throw new Error(
      `tauQ ${tauQ} is outside the sound range [${MIN_TAU_Q}, ${MAX_TAU_Q}]. ` +
        'The in-circuit comparator wraps outside this range and would accept any face.'
    );
  }
  const dot = computeQuantizedDotProduct(uLive, uReg);
  return dot + CIRCUIT_COMPARATOR_OFFSET >= tauQ + CIRCUIT_COMPARATOR_OFFSET;
}
