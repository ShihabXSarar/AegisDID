/**
 * AegisDID — Client-Side Groth16 ZK Prover
 * Strictly adheres to docs/CRYPTO_SPEC.md.
 *
 * Runs snarkjs `groth16.fullProve` in WebAssembly against the compiled circuit artifacts in
 * public/zk/.
 *
 * SECURITY: there is deliberately NO mock/fallback proving path. If the artifacts are missing
 * or the witness does not satisfy the constraints, this throws. A synthesised proof would be
 * rejected by the on-chain verifier anyway, and surfacing one as a success would be a lie.
 */

export interface CircuitWitness {
  // Public inputs
  root: string;
  policyId: string | number;
  epoch: string | number;
  tauQ: string | number;
  modelHash: string;

  // Private inputs
  uLive: number[];
  uReg: number[];
  salt: string;
  idSecret: string;
  pathElements: string[];
  pathIndices: number[];
}

export interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

export interface ProverResult {
  proof: Groth16Proof;
  publicSignals: string[];
  provingTimeMs: number;
}

/**
 * Check that the compiled circuit .wasm and .zkey artifacts are actually served from public/zk/.
 *
 * A Next.js dev server answers unknown paths with an HTML 404 page, so a bare `res.ok` is not
 * enough — an HTML content-type means the binary is absent and snarkjs would fail deep inside
 * WASM instantiation with an opaque error.
 */
async function checkCircuitArtifactsExist(wasmPath: string, zkeyPath: string): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  try {
    const [wasmRes, zkeyRes] = await Promise.all([
      fetch(wasmPath, { method: 'HEAD' }),
      fetch(zkeyPath, { method: 'HEAD' }),
    ]);
    const isBinary = (r: Response) =>
      r.ok && !(r.headers.get('content-type') || '').includes('text/html');
    return isBinary(wasmRes) && isBinary(zkeyRes);
  } catch {
    return false;
  }
}

/**
 * Generate Groth16 Proof using snarkjs
 */
export async function generateAegisClaimProof(
  witness: CircuitWitness,
  onProgress?: (status: string) => void
): Promise<ProverResult> {
  const startTime = performance.now();
  onProgress?.('Preparing circuit witness & computing in-circuit nullifier...');

  // Format witness bigints / numbers into string representations
  const formattedWitness = {
    root: witness.root.toString(),
    policyId: witness.policyId.toString(),
    epoch: witness.epoch.toString(),
    tauQ: witness.tauQ.toString(),
    modelHash: witness.modelHash.toString(),
    uLive: witness.uLive,
    uReg: witness.uReg,
    salt: witness.salt.toString(),
    idSecret: witness.idSecret.toString(),
    pathElements: witness.pathElements.map((p) => p.toString()),
    pathIndices: witness.pathIndices.map((i) => Number(i)),
  };

  const wasmPath = '/zk/aegis_claim.wasm';
  const zkeyPath = '/zk/aegis_final.zkey';

  onProgress?.('Checking compiled circuit artifacts (/zk/aegis_claim.wasm)...');
  const artifactsReady = await checkCircuitArtifactsExist(wasmPath, zkeyPath);

  if (artifactsReady) {
    try {
      // Dynamic import to prevent SSR issues
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const snarkjs = (await import('snarkjs')) as any;

      onProgress?.('Executing Groth16 fullProve in WebAssembly...');
      const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        formattedWitness,
        wasmPath,
        zkeyPath
      );

      const provingTimeMs = Math.round(performance.now() - startTime);
      onProgress?.(`ZK Proof Generated in ${provingTimeMs}ms`);

      return {
        proof,
        publicSignals,
        provingTimeMs,
      };
    } catch (snarkErr: any) {
      console.error('snarkjs proving failed:', snarkErr);
      throw new Error(`Zero-Knowledge Proof Generation Failed: ${snarkErr.message || 'Constraint violation'}. This usually means your face does not match the enrolled identity or you are not in the cohort.`);
    }
  } else {
    throw new Error('Circuit artifacts not found. Please ensure aegis_claim.wasm and aegis_final.zkey exist in the public/zk directory.');
  }
}
