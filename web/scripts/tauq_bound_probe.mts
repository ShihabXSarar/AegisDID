/**
 * Probe: what does the circuit do when tauQ is outside the range the
 * GreaterEqThan(24) comparator was sized for?
 *
 * The acceptance test is:
 *   GreaterEqThan(24)(dot + 2^21, tauQ + 2^21) === 1
 *
 * circomlib's GreaterEqThan(n) is LessThan(n)(in[1], in[0]+1), and LessThan(n)
 * range-checks `in[0] + 2^n - in[1]` through Num2Bits(n+1). With a tauQ that is
 * a large field element (e.g. r - k, i.e. "negative"), that expression can land
 * back inside the 25-bit window with bit 24 clear -- which would mean ACCEPT for
 * any dot at all.
 *
 * This decides whether an out-of-range tauQ is fail-closed (unprovable) or
 * fail-open (forgeable). Real proving, no shortcuts.
 *
 * Run: node scripts/tauq_bound_probe.mts   (from web/)
 */

import path from 'path';
import * as snarkjs from 'snarkjs';
import { MerkleTree } from '../lib/merkle/tree.ts';
import {
  computeEmbeddingCommitment,
  computeIdentityCommitment,
} from '../lib/ml/commitments.ts';
import { quantizeEmbedding, computeQuantizedDotProduct } from '../lib/ml/quantize.ts';

const WASM = path.join(process.cwd(), 'public/zk/aegis_claim.wasm');
const ZKEY = path.join(process.cwd(), 'public/zk/aegis_final.zkey');

const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MODEL_HASH =
  BigInt('0x1515797c52937818f1db7a4b94f66e99c5805171e6d78ddc5280933e981c6ff4') % R;

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
}

const rngA = makeRng(11);
const rngB = makeRng(9999);
// Two INDEPENDENT identities: their similarity is far below any sane threshold.
const embReg = normalize(Array.from({ length: 128 }, () => rngA() * 2 - 1));
const embLive = normalize(Array.from({ length: 128 }, () => rngB() * 2 - 1));

const uReg = quantizeEmbedding(embReg);
const uLive = quantizeEmbedding(embLive);
const dot = computeQuantizedDotProduct(uReg, uLive);

console.log(`measured dot between two DIFFERENT identities: ${dot} (cos ${(dot / 16129).toFixed(4)})`);

const idSecret = 123456789n;
const salt = 987654321n;
const policyId = 42n;
const epoch = 1n;

const cEmb = await computeEmbeddingCommitment(uReg, salt);
const cId = await computeIdentityCommitment(idSecret, cEmb, MODEL_HASH);

const tree = new MerkleTree(20, 0n);
await tree.init();
tree.insert(cId);
const { root, pathElements, pathIndices } = tree.getPath(0);

async function attempt(label: string, tauQ: bigint) {
  const input = {
    root: root.toString(),
    policyId: policyId.toString(),
    epoch: epoch.toString(),
    tauQ: tauQ.toString(),
    modelHash: MODEL_HASH.toString(),
    idSecret: idSecret.toString(),
    salt: salt.toString(),
    uReg: uReg.map(String),
    uLive: uLive.map(String),
    pathElements: pathElements.map(String),
    pathIndices: pathIndices.map(String),
  };
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
    console.log(`  ${label}: PROVED  <-- accepted a non-matching face`);
    console.log(`     publicSignals[4] (tauQ) = ${publicSignals[4]}`);
    return { proved: true, proof, publicSignals };
  } catch (e) {
    const msg = String(e).split('\n')[0].slice(0, 110);
    console.log(`  ${label}: rejected — ${msg}`);
    return { proved: false };
  }
}

console.log('\nCase A: sane tauQ above the measured dot (must be rejected)');
await attempt('tauQ = 8065 (cos 0.5)', 8065n);

console.log('\nCase B: tauQ = 0 (issuer sets a degenerate threshold)');
await attempt('tauQ = 0', 0n);

console.log('\nCase C: tauQ just above the 24-bit comparator window');
await attempt('tauQ = 2^24', 1n << 24n);

console.log('\nCase D: tauQ as a large field element ("negative" residue)');
const r1 = await attempt('tauQ = r - 1', R - 1n);
const r2 = await attempt('tauQ = r - 1000000', R - 1000000n);

console.log('\n' + '='.repeat(70));
if (r1.proved || r2.proved) {
  console.log('RESULT: FAIL-OPEN. An out-of-range tauQ lets a NON-MATCHING face prove.');
  console.log('        The contract must reject such tauQ values at createPolicy time.');
} else {
  console.log('RESULT: FAIL-CLOSED. An out-of-range tauQ makes the circuit unsatisfiable.');
}
console.log('='.repeat(70));
process.exit(0);
