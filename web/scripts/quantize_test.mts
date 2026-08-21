/**
 * Unit tests for web/lib/ml/quantize.ts — the quantization scheme and the tauQ soundness bound.
 *
 * WHY THIS EXISTS
 *   web/scripts/tauq_bound_probe.mts proved, with a real Groth16 proof, that an out-of-range tauQ
 *   lets a NON-MATCHING face (measured cosine 0.0889) satisfy the circuit: circomlib's
 *   GreaterEqThan(24) range-checks through Num2Bits(25), so a tauQ expressed as a large BN254
 *   field residue wraps and the comparator returns 1 unconditionally. tauQ = 0 accepts any
 *   non-negative dot.
 *
 *   The circuit cannot defend itself (tauQ is a public input), so the bound is enforced in two
 *   places: AegisAid.sol (MIN_TAU_Q / MAX_TAU_Q, 8 tests in contracts/test/AegisAid.t.sol) and the
 *   client (this file's subject). The client copy matters because the AegisAid bytecode already
 *   deployed to Base Sepolia predates the bound — policies 101 and 102 there sit at tauQ = 0.
 *
 * These are pure-arithmetic tests: no proving, no network, no browser. Run with
 *   node scripts/quantize_test.mts       (or `npm run test:quantize`)
 */

import {
  quantizeEmbedding,
  computeQuantizedDotProduct,
  cosineToTauQ,
  verifySimilarityThreshold,
  isTauQSound,
  MIN_TAU_Q,
  MAX_TAU_Q,
  CIRCUIT_COMPARATOR_OFFSET,
} from '../lib/ml/quantize.ts';

let passed = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** BN254 scalar field order. */
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Deterministic pseudo-random unit vector, so runs are reproducible. */
function unitVector(seed: number): number[] {
  let s = seed >>> 0;
  const v: number[] = [];
  for (let i = 0; i < 128; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    v.push((s / 0xffffffff) * 2 - 1);
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return v.map((x) => x / norm);
}

// ------------------------------------------------------------------ 1. quantization
console.log('\n[1] Quantization: q_i = clamp(round(z_i*127), -127, 127), u_i = q_i + 128');
{
  const u = quantizeEmbedding(unitVector(1));
  check('output length is 128', u.length === 128, `got ${u.length}`);
  check(
    'every u_i is an integer in [1, 255]',
    u.every((x) => Number.isInteger(x) && x >= 1 && x <= 255),
    `min ${Math.min(...u)} max ${Math.max(...u)}`
  );

  // A vector along one axis: z_0 = 1 quantizes to q = 127, u = 255. Every other axis is 0 -> 128.
  const axis = new Array(128).fill(0);
  axis[0] = 1;
  const uAxis = quantizeEmbedding(axis);
  check('z = e_0 gives u_0 = 255', uAxis[0] === 255, `got ${uAxis[0]}`);
  check(
    'z = e_0 gives u_i = 128 for i > 0',
    uAxis.slice(1).every((x) => x === 128)
  );

  const negAxis = new Array(128).fill(0);
  negAxis[0] = -1;
  check('z = -e_0 gives u_0 = 1', quantizeEmbedding(negAxis)[0] === 1);

  let threw = false;
  try {
    quantizeEmbedding(new Array(127).fill(0.1));
  } catch {
    threw = true;
  }
  check('a non-128-dimensional embedding is rejected', threw);
}

// ------------------------------------------------------------------ 2. dot product range
console.log('\n[2] Dot product: attainable range is [-2064512, 2064512], not [-2^21, 2^21]');
{
  const maxU = new Array(128).fill(255); // every q_i = +127
  const minU = new Array(128).fill(1); // every q_i = -127
  const zeroU = new Array(128).fill(128); // every q_i = 0

  check(
    'maximal positive dot is 128*127^2 = 2064512',
    computeQuantizedDotProduct(maxU, maxU) === 2064512,
    `got ${computeQuantizedDotProduct(maxU, maxU)}`
  );
  check(
    'maximal negative dot is -2064512',
    computeQuantizedDotProduct(maxU, minU) === -2064512,
    `got ${computeQuantizedDotProduct(maxU, minU)}`
  );
  check('all-zero q gives dot 0', computeQuantizedDotProduct(zeroU, zeroU) === 0);

  // 2064512 < 2^21 strictly, which is exactly why the offset shifts every attainable dot
  // into [32640, 4161664] and both comparator inputs fit 24 bits.
  check('2064512 < 2^21 (offset strictly dominates the range)', 2064512 < CIRCUIT_COMPARATOR_OFFSET);
  check('offset is 2^21, not 2^22', CIRCUIT_COMPARATOR_OFFSET === 2 ** 21);
  check(
    'shifted maximum fits the 24-bit comparator',
    2064512 + CIRCUIT_COMPARATOR_OFFSET < 2 ** 24,
    `${2064512 + CIRCUIT_COMPARATOR_OFFSET}`
  );
  check(
    'shifted minimum is non-negative',
    -2064512 + CIRCUIT_COMPARATOR_OFFSET >= 0,
    `${-2064512 + CIRCUIT_COMPARATOR_OFFSET}`
  );

  let threw = false;
  try {
    computeQuantizedDotProduct(maxU, new Array(64).fill(128));
  } catch {
    threw = true;
  }
  check('mismatched vector lengths are rejected', threw);
}

// ------------------------------------------------------------------ 3. self-match vs cross-match
console.log('\n[3] Self-match clears a 0.5 threshold; an unrelated vector does not');
{
  const a = quantizeEmbedding(unitVector(7));
  const b = quantizeEmbedding(unitVector(99));
  const dotSelf = computeQuantizedDotProduct(a, a);
  const dotCross = computeQuantizedDotProduct(a, b);
  const tau = cosineToTauQ(0.5);

  console.log(
    `        dotSelf=${dotSelf} (cos ${(dotSelf / 16129).toFixed(4)})  ` +
      `dotCross=${dotCross} (cos ${(dotCross / 16129).toFixed(4)})  tauQ=${tau}`
  );
  check('self-match dot >= tauQ(0.5)', dotSelf >= tau);
  check('cross-match dot < tauQ(0.5)', dotCross < tau);
  check('verifySimilarityThreshold accepts the self-match', verifySimilarityThreshold(a, a, tau));
  check('verifySimilarityThreshold rejects the cross-match', !verifySimilarityThreshold(a, b, tau));
}

// ------------------------------------------------------------------ 4. cosineToTauQ
console.log('\n[4] cosineToTauQ = round(cosine * 127^2)');
{
  check('cosineToTauQ(0.5) == 8065', cosineToTauQ(0.5) === 8065, `got ${cosineToTauQ(0.5)}`);
  check('cosineToTauQ(1.0) == 16129', cosineToTauQ(1.0) === 16129, `got ${cosineToTauQ(1.0)}`);
  check('cosineToTauQ(0) == 0', cosineToTauQ(0) === 0);
  check('cosineToTauQ(1.0) == MAX_TAU_Q', cosineToTauQ(1.0) === MAX_TAU_Q);
}

// ------------------------------------------------------------------ 5. the bound itself
console.log('\n[5] Bound values must match AegisAid.MIN_TAU_Q / MAX_TAU_Q exactly');
{
  check('MIN_TAU_Q == 1', MIN_TAU_Q === 1, `got ${MIN_TAU_Q}`);
  check('MAX_TAU_Q == 16129', MAX_TAU_Q === 16129, `got ${MAX_TAU_Q}`);
}

// ------------------------------------------------------------------ 6. isTauQSound
console.log('\n[6] isTauQSound: inclusive bounds, bigint-safe, never throws');
{
  check('accepts MIN_TAU_Q (inclusive)', isTauQSound(MIN_TAU_Q));
  check('accepts MAX_TAU_Q (inclusive)', isTauQSound(MAX_TAU_Q));
  check('accepts 8065 (cosine 0.5)', isTauQSound(8065));

  check('rejects 0 — accepts any non-negative dot', !isTauQSound(0));
  check('rejects MAX_TAU_Q + 1', !isTauQSound(MAX_TAU_Q + 1));
  check('rejects 2^24 (past the comparator window)', !isTauQSound(2 ** 24));
  check('rejects -1 as a JS number', !isTauQSound(-1));
  check('rejects 2064512 (max attainable dot, still above MAX_TAU_Q)', !isTauQSound(2064512));

  // The exact values the probe exploited, as they arrive from an on-chain read: bigint.
  check('rejects bigint r - 1 (the proven exploit value)', !isTauQSound(R - 1n));
  check('rejects bigint r - 1000000 (also proven)', !isTauQSound(R - 1000000n));
  check('accepts bigint 8065', isTauQSound(8065n));
  check('rejects bigint 0', !isTauQSound(0n));
  check('rejects bigint 16130', !isTauQSound(16130n));
  check('accepts bigint 16129', isTauQSound(16129n));

  // Render paths call this on raw form input; a throw would blank the page.
  let threw = false;
  try {
    check('rejects NaN without throwing', !isTauQSound(NaN));
    check('rejects Infinity without throwing', !isTauQSound(Infinity));
    check('rejects -Infinity without throwing', !isTauQSound(-Infinity));
    check('rejects a non-integer', !isTauQSound(8065.5));
  } catch (e) {
    threw = true;
    console.log(`        threw: ${(e as Error).message}`);
  }
  check('isTauQSound never throws on hostile input', !threw);
}

// ------------------------------------------------------------------ 7. refusal, not imitation
console.log('\n[7] verifySimilarityThreshold REFUSES an unsound tauQ rather than imitating the wrap');
{
  const a = quantizeEmbedding(unitVector(7));
  const b = quantizeEmbedding(unitVector(99));

  for (const [label, bad] of [
    ['0', 0],
    ['-1', -1],
    ['MAX_TAU_Q + 1', MAX_TAU_Q + 1],
    ['2^24', 2 ** 24],
  ] as [string, number][]) {
    let threw = false;
    let message = '';
    try {
      verifySimilarityThreshold(a, b, bad);
    } catch (e) {
      threw = true;
      message = (e as Error).message;
    }
    check(`tauQ = ${label} throws instead of returning a verdict`, threw);
    check(
      `tauQ = ${label} error names the sound range`,
      message.includes(`[${MIN_TAU_Q}, ${MAX_TAU_Q}]`),
      message
    );
  }

  // The critical case: the wrapped comparator would say "match" for a NON-matching pair. The
  // client must not agree with it — a thrown error is a refusal, `true` would be a fake success.
  let returnedTrue = false;
  try {
    returnedTrue = verifySimilarityThreshold(a, b, 0);
  } catch {
    /* expected */
  }
  check(
    'a non-matching pair at tauQ = 0 never returns true (no fake success)',
    returnedTrue === false
  );
}

// ------------------------------------------------------------------ 8. boundary inclusivity
console.log('\n[8] The threshold boundary is inclusive: dot == tauQ is a match');
{
  // Build a pair whose dot lands exactly on a chosen in-range tauQ. q_live = e_0 * 127 and
  // q_reg = e_0 * k gives dot = 127k, so k = 63 gives dot = 8001.
  const live = new Array(128).fill(128);
  live[0] = 255; // q = +127
  const reg = new Array(128).fill(128);
  reg[0] = 128 + 63; // q = +63
  const dot = computeQuantizedDotProduct(live, reg);
  check('constructed dot is 8001', dot === 8001, `got ${dot}`);
  check('dot == tauQ is accepted (inclusive)', verifySimilarityThreshold(live, reg, dot));
  check('dot == tauQ - 1 is accepted', verifySimilarityThreshold(live, reg, dot - 1));
  check('dot == tauQ + 1 is rejected', !verifySimilarityThreshold(live, reg, dot + 1));
}

// ------------------------------------------------------------------ 9. self-match spread
console.log('\n[9] Quantization rounding: a genuine self-match does NOT land exactly on 16129');
{
  // Establishes the measured figure quoted in AegisAid.sol and quantize.ts, so it is reproducible
  // rather than an assertion in a comment. q_i = round(127 * z_i) is an integer rounding, so
  // dot = SUM q_i^2 scatters around 127^2 * ||z||^2 = 16129 instead of hitting it.
  let min = Infinity;
  let max = -Infinity;
  const N = 20000;
  for (let seed = 1; seed <= N; seed++) {
    const u = quantizeEmbedding(unitVector(seed));
    const d = computeQuantizedDotProduct(u, u);
    if (d < min) min = d;
    if (d > max) max = d;
  }
  console.log(`        self-dot over ${N} random unit vectors: min=${min} max=${max} (127² = 16129)`);

  check('some self-matches land BELOW 16129', min < 16129, `min ${min}`);
  check('some self-matches land ABOVE 16129', max > 16129, `max ${max}`);
  check('the measured spread matches the documented 15852..16447', min === 15852 && max === 16447, `got ${min}..${max}`);
  check(
    'so MAX_TAU_Q is a usability/comparator cap, not the max attainable dot',
    max > MAX_TAU_Q,
    `max self-dot ${max} > MAX_TAU_Q ${MAX_TAU_Q}`
  );
  check(
    'even the largest self-match stays well inside the 24-bit comparator window',
    max + CIRCUIT_COMPARATOR_OFFSET < 2 ** 24
  );
}

// ------------------------------------------------------------------ summary
console.log('\n' + '='.repeat(70));
if (failures.length === 0) {
  console.log(`quantize.ts: ${passed} assertions passed, 0 failed`);
  console.log('='.repeat(70));
} else {
  console.log(`quantize.ts: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('='.repeat(70));
  process.exit(1);
}
