/**
 * AegisDID — Circuit conformance test.
 *
 * Purpose: prove that the TypeScript the browser actually runs and the compiled Circom circuit
 * agree, using REAL Groth16 proving and verification. Nothing here is mocked. Every assertion
 * either passes against circuits/build artifacts or the script exits non-zero.
 *
 * It imports the production modules directly (lib/merkle/tree.ts, lib/ml/commitments.ts,
 * lib/ml/quantize.ts) rather than reimplementing their logic, so a drift between the app and
 * the circuit fails this test instead of failing silently in front of a judge.
 *
 * Covers:
 *   1. Poseidon commitment chain: C_emb = P9(P16(chunk_j)…, salt), C_id = P3(idSecret, C_emb, mh)
 *   2. Merkle depth-20 inclusion: TS root == in-circuit recomputed root
 *   3. Public signal ORDER: [nullifier, root, policyId, epoch, tauQ, modelHash]
 *   4. Nullifier binding: nf == Poseidon3(idSecret, policyId, epoch)
 *   5. In-circuit similarity == TS computeQuantizedDotProduct
 *   6. NEGATIVE: below-threshold similarity is unprovable
 *   7. NEGATIVE: a commitment outside the tree is unprovable (wrong root)
 *   8. NEGATIVE: a modelHash different from the enrolled one is unprovable
 *   9. NEGATIVE: tampering with a public signal makes verification fail
 *
 * Run:  node scripts/circuit_conformance.ts        (from web/)
 */

import fs from 'fs';
import path from 'path';
import * as snarkjs from 'snarkjs';
import { MerkleTree } from '../lib/merkle/tree.ts';
import {
  getPoseidon,
  computeEmbeddingCommitment,
  computeIdentityCommitment,
  computeNullifier,
} from '../lib/ml/commitments.ts';
import { quantizeEmbedding, computeQuantizedDotProduct, cosineToTauQ } from '../lib/ml/quantize.ts';

const WASM = path.join(process.cwd(), 'public/zk/aegis_claim.wasm');
const ZKEY = path.join(process.cwd(), 'public/zk/aegis_final.zkey');
const VKEY = path.join(process.cwd(), 'public/zk/vkey.json');

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Deterministic PRNG so runs are reproducible. Not used for anything security-relevant. */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A synthetic 128-d face embedding. Shape only — no claim about real face statistics. */
function syntheticEmbedding(seed: number): number[] {
  const rng = makeRng(seed);
  return Array.from({ length: 128 }, () => rng() * 2 - 1);
}

/** Same person, slightly different frame: small perturbation of the same direction. */
function perturb(embedding: number[], seed: number, magnitude: number): number[] {
  const rng = makeRng(seed);
  return embedding.map((v) => v + (rng() * 2 - 1) * magnitude);
}

async function prove(witness: Record<string, unknown>) {
  return snarkjs.groth16.fullProve(witness, WASM, ZKEY);
}

/** Assert that witness generation / proving is IMPOSSIBLE for an unsatisfiable witness. */
async function expectUnprovable(name: string, witness: Record<string, unknown>) {
  try {
    await prove(witness);
    check(name, false, 'a proof was generated for an witness that must not satisfy the circuit');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(name, true, `circuit rejected it (${msg.split('\n')[0].slice(0, 90)})`);
  }
}

async function main() {
  console.log('AegisDID circuit conformance test');
  console.log('='.repeat(72));

  for (const [label, p] of [
    ['wasm', WASM],
    ['zkey', ZKEY],
    ['vkey', VKEY],
  ] as const) {
    if (!fs.existsSync(p)) {
      console.error(`Missing ${label} artifact at ${p}. Build the circuit first.`);
      process.exit(1);
    }
  }
  const vkey = JSON.parse(fs.readFileSync(VKEY, 'utf8'));
  const poseidon = await getPoseidon();
  const F = poseidon.F;

  // ---------------------------------------------------------------- setup
  const idSecret = 0x1f2e3d4c5b6a79887766554433221100n;
  const salt = 0x0abcdef1234567890fedcba987654321n;
  const modelHash = 11111111n;
  const policyId = 42n;
  const epoch = 7n;
  const tauQ = BigInt(cosineToTauQ(0.5)); // round(0.5 * 127 * 127) = 8065

  check('cosineToTauQ(0.5) == 8065', tauQ === 8065n, `got ${tauQ}`);

  const regEmbedding = syntheticEmbedding(1234);
  const uReg = quantizeEmbedding(regEmbedding);
  check(
    'quantized register vector is 128 values in [1,255]',
    uReg.length === 128 && uReg.every((v) => Number.isInteger(v) && v >= 1 && v <= 255)
  );

  // Same person, different frame.
  const uLiveSame = quantizeEmbedding(perturb(regEmbedding, 555, 0.06));
  // A different person entirely.
  const uLiveOther = quantizeEmbedding(syntheticEmbedding(98765));

  const dotSame = computeQuantizedDotProduct(uLiveSame, uReg);
  const dotOther = computeQuantizedDotProduct(uLiveOther, uReg);

  // A mid-range case matters more than the two extremes: it is where the threshold actually has
  // to discriminate. Calibrated at runtime by blending the two identities in embedding space
  // until the measured int8 similarity lands near 0.65 * 127^2, so the test is deterministic
  // without hardcoding a magic vector.
  let uLiveMid = uLiveSame;
  let dotMid = dotSame;
  const target = 0.65 * 127 * 127;
  for (let w = 99; w >= 1; w--) {
    const blended = regEmbedding.map((v, i) => (v * w) / 100 + (uLiveOther[i] - 128) * (100 - w) / 100 / 127);
    const candidate = quantizeEmbedding(blended);
    const d = computeQuantizedDotProduct(candidate, uReg);
    if (d <= target) {
      uLiveMid = candidate;
      dotMid = d;
      break;
    }
  }

  // NOTE ON UNITS: the app defines its threshold as tauQ = round(cosine * 127^2), so the
  // "cosine" reported everywhere is dot / 127^2. That is the quantity the circuit compares, and
  // it is what is printed here. It is NOT normalised by the actual quantized vector norms, so
  // it can read marginally above 1.0 when rounding inflates a vector's norm.
  console.log(
    `\n  measured int8 dot (dot / 127^2 = the circuit's comparison unit):\n` +
      `    same person   : ${dotSame} (${(dotSame / 16129).toFixed(4)})\n` +
      `    mid-similarity: ${dotMid} (${(dotMid / 16129).toFixed(4)})\n` +
      `    different      : ${dotOther} (${(dotOther / 16129).toFixed(4)})\n` +
      `    tauQ           : ${tauQ} (${(Number(tauQ) / 16129).toFixed(4)})`
  );
  check('same-person similarity is above tauQ', BigInt(dotSame) >= tauQ);
  check('different-person similarity is below tauQ', BigInt(dotOther) < tauQ);
  check(
    'mid-similarity case sits strictly between the two extremes',
    dotMid < dotSame && dotMid > dotOther,
    `${dotOther} < ${dotMid} < ${dotSame}`
  );

  // -------------------------------------------------- commitment chain
  const cEmb = await computeEmbeddingCommitment(uReg, salt);
  const cId = await computeIdentityCommitment(idSecret, cEmb, modelHash);

  // Independently recompute the spec formula to catch a drift in commitments.ts.
  const chunks: bigint[] = [];
  for (let j = 0; j < 8; j++) {
    chunks.push(F.toObject(poseidon(uReg.slice(16 * j, 16 * j + 16).map(BigInt))));
  }
  const cEmbSpec = F.toObject(poseidon([...chunks, salt]));
  const cIdSpec = F.toObject(poseidon([idSecret, cEmbSpec, modelHash]));
  check('C_emb matches Poseidon9(Poseidon16(chunks), salt)', cEmb === cEmbSpec);
  check('C_id matches Poseidon3(idSecret, C_emb, modelHash)', cId === cIdSpec);

  // ------------------------------------------------------------ tree
  const tree = new MerkleTree(20, 0n);
  await tree.init();
  tree.insert(cId);
  const { root, pathElements, pathIndices } = tree.getPath(0);
  check('tree holds exactly one leaf', tree.leafCount === 1);
  check('path has 20 elements and 20 indices', pathElements.length === 20 && pathIndices.length === 20);

  // Independently verify the TS path folds to the TS root.
  let folded = cId;
  for (let i = 0; i < 20; i++) {
    folded =
      pathIndices[i] === 1
        ? F.toObject(poseidon([pathElements[i], folded]))
        : F.toObject(poseidon([folded, pathElements[i]]));
  }
  check('TS Merkle path folds to the TS root', folded === root);

  const expectedNullifier = await computeNullifier(idSecret, policyId, epoch);

  const baseWitness = {
    root,
    policyId,
    epoch,
    tauQ,
    modelHash,
    uLive: uLiveSame.map(BigInt),
    uReg: uReg.map(BigInt),
    salt,
    idSecret,
    pathElements,
    pathIndices,
  };

  // ----------------------------------------------- 1. positive proof
  console.log('\n[1] Valid claim — real Groth16 proof');
  const t0 = Date.now();
  const { proof, publicSignals } = await prove(baseWitness);
  const provingMs = Date.now() - t0;
  console.log(`  proving took ${provingMs} ms (node, not browser)`);

  check('exactly 6 public signals', publicSignals.length === 6, `got ${publicSignals.length}`);
  check(
    'publicSignals[0] == nullifier == Poseidon3(idSecret, policyId, epoch)',
    BigInt(publicSignals[0]) === expectedNullifier,
    `${publicSignals[0]}`
  );
  check('publicSignals[1] == root', BigInt(publicSignals[1]) === root);
  check('publicSignals[2] == policyId', BigInt(publicSignals[2]) === policyId);
  check('publicSignals[3] == epoch', BigInt(publicSignals[3]) === epoch);
  check('publicSignals[4] == tauQ', BigInt(publicSignals[4]) === tauQ);
  check('publicSignals[5] == modelHash', BigInt(publicSignals[5]) === modelHash);

  const verified = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  check('proof verifies against vkey.json', verified === true);

  // ------------------------------- 2. tampered public signal must fail
  console.log('\n[2] Tampered public signal must fail verification');
  const tampered = [...publicSignals];
  tampered[0] = (BigInt(tampered[0]) + 1n).toString(); // forge a different nullifier
  check(
    'flipping the nullifier invalidates the proof',
    (await snarkjs.groth16.verify(vkey, tampered, proof)) === false
  );
  const tamperedRoot = [...publicSignals];
  tamperedRoot[1] = (BigInt(tamperedRoot[1]) + 1n).toString();
  check(
    'flipping the root invalidates the proof',
    (await snarkjs.groth16.verify(vkey, tamperedRoot, proof)) === false
  );

  // ------------------------------------ 3. below-threshold similarity
  console.log('\n[3] Wrong person (similarity below tauQ) must be unprovable');
  await expectUnprovable('a different face cannot satisfy the threshold', {
    ...baseWitness,
    uLive: uLiveOther.map(BigInt),
  });

  // -------------------------- 3b. mid-range similarity discriminates
  console.log('\n[3b] Mid-similarity face: accepted under a lenient tauQ, rejected under a strict one');
  const midLenient = await prove({ ...baseWitness, uLive: uLiveMid.map(BigInt), tauQ: BigInt(dotMid) });
  check(
    'mid-similarity proves when tauQ == its measured similarity (boundary is inclusive)',
    (await snarkjs.groth16.verify(vkey, midLenient.publicSignals, midLenient.proof)) === true,
    `tauQ=${dotMid}`
  );
  await expectUnprovable('mid-similarity fails when tauQ is one unit above it', {
    ...baseWitness,
    uLive: uLiveMid.map(BigInt),
    tauQ: BigInt(dotMid + 1),
  });

  // --------------------------------------------- 4. not in the cohort
  console.log('\n[4] Commitment outside the cohort tree must be unprovable');
  const otherTree = new MerkleTree(20, 0n);
  await otherTree.init();
  otherTree.insert(cId + 1n); // somebody else's leaf
  const foreign = otherTree.getPath(0);
  await expectUnprovable('a foreign root cannot be satisfied', {
    ...baseWitness,
    root: foreign.root,
    pathElements: foreign.pathElements,
    pathIndices: foreign.pathIndices,
  });

  // ------------------------------------------------ 5. wrong modelHash
  console.log('\n[5] Policy bound to a different modelHash must be unprovable');
  await expectUnprovable('changing modelHash breaks Merkle inclusion', {
    ...baseWitness,
    modelHash: modelHash + 1n,
  });

  // ------------------------------------------------ 6. raised tauQ
  console.log('\n[6] Policy with tauQ above the measured similarity must be unprovable');
  await expectUnprovable('tauQ above the measured dot cannot be satisfied', {
    ...baseWitness,
    tauQ: BigInt(dotSame + 1),
  });

  // --------------------------- 7. nullifier changes with policy/epoch
  console.log('\n[7] Nullifier is bound to (policyId, epoch)');
  const otherEpoch = await prove({ ...baseWitness, epoch: epoch + 1n });
  check(
    'a different epoch yields a different nullifier',
    BigInt(otherEpoch.publicSignals[0]) !== BigInt(publicSignals[0])
  );
  check(
    'nullifier for epoch+1 matches Poseidon3(idSecret, policyId, epoch+1)',
    BigInt(otherEpoch.publicSignals[0]) === (await computeNullifier(idSecret, policyId, epoch + 1n))
  );
  const otherPolicy = await prove({ ...baseWitness, policyId: policyId + 1n });
  check(
    'a different policyId yields a different nullifier',
    BigInt(otherPolicy.publicSignals[0]) !== BigInt(publicSignals[0])
  );

  console.log('\n' + '='.repeat(72));
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log(`Positive-proof latency (node): ${provingMs} ms`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
