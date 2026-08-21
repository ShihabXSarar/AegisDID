/**
 * AegisDID — Liveness challenge unit tests.
 *
 * Purpose: prove that lib/ml/liveness.ts actually rejects the attacks it claims to reject,
 * and actually accepts a genuine live subject. Nothing is mocked except the two ambient
 * sources of nondeterminism the tracker reads directly:
 *
 *   - Date.now()                  -> a virtual clock, so blink-duration and timeout
 *                                    windows are exercised exactly at their boundaries
 *                                    instead of "probably fast enough".
 *   - crypto.getRandomValues()    -> a scripted queue, so the randomized action order and
 *                                    blink count can be pinned per test. The randomization
 *                                    itself is then tested separately WITHOUT the stub.
 *
 * The landmark arrays are synthesized to hit an exact EAR and yaw ratio by inverting the
 * production formulas' geometry, so a test that says "EAR 0.15" really does drive
 * calculateEyeAspectRatio to 0.15.
 *
 * Covers:
 *   1.  EAR / yaw primitives, including their degenerate-input returns
 *   2.  Calibration gate: no action counts before CALIBRATION_FRAMES
 *   3.  Calibration refuses implausible eye geometry rather than trusting it
 *   4.  Genuine blink accepted; blink too short and too long rejected
 *   5.  Sustained closure (occlusion) rejected
 *   6.  Turn requires BOTH away and return-to-centre
 *   7.  ATTACK: static photo never completes and times out
 *   8.  ATTACK: actions performed out of the requested order do not count
 *   9.  Timeout enforced at CHALLENGE_TIMEOUT_MS
 *  10.  Face lost mid-challenge wipes progress (no subject swap)
 *  11.  Completion latches: a later frame cannot un-complete it
 *  12.  livenessScore only reaches 100 on genuine completion
 *  13.  Randomization is real: both orders and both blink counts occur
 *  14.  processFrame never throws on malformed input
 *
 * Run:  node scripts/liveness_test.mts        (from web/)
 */

// ---------------------------------------------------------------------------
// Clock + CSPRNG stubs. Installed BEFORE liveness.ts is imported, because the
// LivenessTracker constructor calls reset(), which draws from the CSPRNG.
// ---------------------------------------------------------------------------

let virtualNow = 1_700_000_000_000;
const realDateNow = Date.now;
Date.now = () => virtualNow;

/** Values randomBelow() will observe, in order. Empty queue => fall back to 0. */
let randomQueue: number[] = [];
const realGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
let randomStubbed = false;

function stubRandom(queue: number[]) {
  randomQueue = [...queue];
  randomStubbed = true;
  Object.defineProperty(globalThis.crypto, 'getRandomValues', {
    value: (buf: Uint32Array) => {
      buf[0] = randomQueue.length > 0 ? (randomQueue.shift() as number) : 0;
      return buf;
    },
    configurable: true,
    writable: true,
  });
}

function unstubRandom() {
  randomStubbed = false;
  Object.defineProperty(globalThis.crypto, 'getRandomValues', {
    value: realGetRandomValues,
    configurable: true,
    writable: true,
  });
}

// Start with a stub so import-time construction is deterministic if it ever happens.
stubRandom([]);

import {
  LivenessTracker,
  calculateEyeAspectRatio,
  calculateHeadYawRatio,
  CALIBRATION_FRAMES,
  CHALLENGE_TIMEOUT_MS,
  FACE_LOST_RESET_MS,
  BLINK_DIP_FACTOR,
  BLINK_RECOVER_FACTOR,
  BLINK_MIN_MS,
  BLINK_MAX_MS,
  TURN_AWAY_FACTOR,
  TURN_RETURN_FACTOR,
  AWAITING_REOPEN_ESCAPE_MS,
  type LandmarkPoint,
  type LivenessState,
} from '../lib/ml/liveness.ts';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(name);
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function approx(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) <= tol;
}

// ---------------------------------------------------------------------------
// Landmark synthesis.
//
// Inverts the production geometry so a requested (ear, yaw) is what the
// production functions actually compute:
//
//   EAR  = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|)
//          -> with both verticals = v and horizontal = H, EAR = v / H
//   yaw  = |nose.x - leftEdge.x| / |rightEdge.x - nose.x|
//          -> with edges at x=0 and x=W, nose.x = W*yaw / (1 + yaw)
// ---------------------------------------------------------------------------

const EYE_H = 30; // horizontal eye width in synthetic px
const FACE_W = 200; // jaw-edge span in synthetic px

function makeLandmarks(ear: number, yaw: number): LandmarkPoint[] {
  const pts: LandmarkPoint[] = Array.from({ length: 68 }, () => ({ x: 0, y: 0 }));

  const v = ear * EYE_H; // vertical opening that yields the requested EAR

  // Left eye ring, production order [36 outer, 37, 38, 39 inner, 40, 41].
  pts[36] = { x: 0, y: 0 };
  pts[39] = { x: EYE_H, y: 0 };
  pts[37] = { x: 10, y: -v / 2 };
  pts[41] = { x: 10, y: v / 2 };
  pts[38] = { x: 20, y: -v / 2 };
  pts[40] = { x: 20, y: v / 2 };

  // Right eye ring, production order [45, 44, 43, 42, 47, 46].
  pts[45] = { x: 100, y: 0 };
  pts[42] = { x: 100 + EYE_H, y: 0 };
  pts[44] = { x: 110, y: -v / 2 };
  pts[46] = { x: 110, y: v / 2 };
  pts[43] = { x: 120, y: -v / 2 };
  pts[47] = { x: 120, y: v / 2 };

  // Head pose: jaw edges fixed, nose tip slides to produce the requested ratio.
  pts[0] = { x: 0, y: 200 };
  pts[16] = { x: FACE_W, y: 200 };
  pts[30] = { x: (FACE_W * yaw) / (1 + yaw), y: 150 };

  return pts;
}

const NO_FACE: LandmarkPoint[] = [];

/** Advance the virtual clock and feed one frame. */
function frame(t: LivenessTracker, ear: number, yaw: number, dtMs = 33): LivenessState {
  virtualNow += dtMs;
  return t.processFrame(makeLandmarks(ear, yaw));
}

function blankFrame(t: LivenessTracker, dtMs = 33): LivenessState {
  virtualNow += dtMs;
  return t.processFrame(NO_FACE);
}

/** Feed enough steady frames to complete calibration. Returns the last state. */
function calibrate(t: LivenessTracker, ear = 0.30, yaw = 1.0): LivenessState {
  let s = frame(t, ear, yaw, 0); // first usable face starts the clock
  for (let i = 1; i < CALIBRATION_FRAMES; i++) s = frame(t, ear, yaw);
  return s;
}

/**
 * Fresh tracker with a pinned challenge.
 * randomBelow(2) is drawn twice in reset(): [0] picks the action order,
 * [1] picks requiredBlinks (1 + draw).
 */
function makeTracker(order: 'blink-first' | 'turn-first', blinks: 1 | 2): LivenessTracker {
  stubRandom([order === 'blink-first' ? 0 : 1, blinks - 1]);
  return new LivenessTracker();
}

/** One physiologically plausible blink at the given closure duration. */
function doBlink(t: LivenessTracker, baseline: number, closureMs: number, yaw = 1.0) {
  const closed = baseline * BLINK_DIP_FACTOR * 0.8; // comfortably below the dip threshold
  frame(t, closed, yaw, 33); // closure begins; dipStartedAt = now
  return frame(t, baseline, yaw, closureMs); // reopen after exactly closureMs
}

/** Turn away past the threshold, then return to centre. */
function doTurn(t: LivenessTracker, ear: number, baselineYaw = 1.0) {
  const away = baselineYaw * TURN_AWAY_FACTOR * 1.1;
  frame(t, ear, away);
  return frame(t, ear, baselineYaw);
}

// ===========================================================================
console.log('\n=== 1. EAR / yaw primitives ===');
// ===========================================================================
{
  const LEFT_EYE = [36, 37, 38, 39, 40, 41];
  const RIGHT_EYE = [45, 44, 43, 42, 47, 46];

  const lm = makeLandmarks(0.3, 1.0);
  const l = calculateEyeAspectRatio(lm, LEFT_EYE);
  const r = calculateEyeAspectRatio(lm, RIGHT_EYE);
  check('synthesized EAR matches production formula (left)', approx(l, 0.3, 1e-12), `got ${l}`);
  check('synthesized EAR matches production formula (right)', approx(r, 0.3, 1e-12), `got ${r}`);

  const y = calculateHeadYawRatio(lm);
  check('synthesized yaw matches production formula', approx(y, 1.0, 1e-12), `got ${y}`);

  const y2 = calculateHeadYawRatio(makeLandmarks(0.3, 1.6));
  check('yaw synthesis is invertible at 1.6', approx(y2, 1.6, 1e-12), `got ${y2}`);

  // Degenerate inputs must return the documented sentinels, not NaN.
  check('EAR returns 0 on missing landmarks', calculateEyeAspectRatio([], LEFT_EYE) === 0);

  const collapsed: LandmarkPoint[] = Array.from({ length: 68 }, () => ({ x: 5, y: 5 }));
  check(
    'EAR returns 0 when horizontal span is 0 (no divide-by-zero)',
    calculateEyeAspectRatio(collapsed, LEFT_EYE) === 0
  );
  check(
    'yaw returns 1.0 when jaw span is 0 (no divide-by-zero)',
    calculateHeadYawRatio(collapsed) === 1.0
  );
  check('yaw returns 1.0 on missing landmarks', calculateHeadYawRatio([]) === 1.0);
}

// ===========================================================================
console.log('\n=== 2. Calibration gate ===');
// ===========================================================================
{
  const t = makeTracker('blink-first', 1);

  let s = frame(t, 0.3, 1.0, 0);
  check('clock starts on first usable face', s.elapsedMs === 0 && s.calibrating);

  // One frame short of the requirement.
  for (let i = 1; i < CALIBRATION_FRAMES - 1; i++) s = frame(t, 0.3, 1.0);
  check(
    `still calibrating at ${CALIBRATION_FRAMES - 1} frames`,
    s.calibrating,
    `frames=${CALIBRATION_FRAMES - 1}`
  );

  s = frame(t, 0.3, 1.0);
  check(`calibrated at exactly ${CALIBRATION_FRAMES} frames`, !s.calibrating);
  check('no action credited during calibration', s.blinkCount === 0 && !s.hasTurnedHead);
}
{
  // A blink during the calibration window must not be credited.
  const t = makeTracker('blink-first', 1);
  frame(t, 0.3, 1.0, 0);
  for (let i = 1; i < CALIBRATION_FRAMES - 3; i++) frame(t, 0.3, 1.0);
  frame(t, 0.10, 1.0); // eyes shut mid-calibration
  frame(t, 0.30, 1.0, 120);
  const s = frame(t, 0.3, 1.0);
  check(
    'blink performed before calibration completes is not credited',
    s.blinkCount === 0,
    `blinkCount=${s.blinkCount}`
  );
  check('baseline is robust to a blink during calibration', !s.calibrating);
}

// ===========================================================================
console.log('\n=== 3. Calibration refuses implausible eye geometry ===');
// ===========================================================================
{
  // EAR 0.90 is above EAR_BASELINE_MAX: the tracker must keep resampling forever
  // rather than adopt a baseline that would make any dip look like a blink.
  const t = makeTracker('blink-first', 1);
  let s = frame(t, 0.90, 1.0, 0);
  for (let i = 0; i < CALIBRATION_FRAMES * 4; i++) s = frame(t, 0.90, 1.0);
  check('EAR baseline above max is never adopted', s.calibrating);
  check('implausible geometry cannot complete the challenge', !s.isComplete);
}
{
  const t = makeTracker('blink-first', 1);
  let s = frame(t, 0.05, 1.0, 0);
  for (let i = 0; i < CALIBRATION_FRAMES * 4; i++) s = frame(t, 0.05, 1.0);
  check('EAR baseline below min is never adopted', s.calibrating);
}
{
  // An out-of-range YAW baseline falls back to 1.0 rather than blocking calibration,
  // because EAR is the security-critical signal here.
  const t = makeTracker('blink-first', 1);
  let s = frame(t, 0.30, 5.0, 0);
  for (let i = 1; i < CALIBRATION_FRAMES; i++) s = frame(t, 0.30, 5.0);
  check('out-of-range yaw baseline does not block calibration', !s.calibrating);
}

// ===========================================================================
console.log('\n=== 4. Blink duration window ===');
// ===========================================================================
{
  const t = makeTracker('blink-first', 1);
  calibrate(t);
  const s = doBlink(t, 0.30, 150);
  check('genuine 150 ms blink is credited', s.blinkCount === 1, `blinkCount=${s.blinkCount}`);
  check('crediting the last required blink advances the step', s.stepIndex === 1);
  check('hasBlinked set once requiredBlinks reached', s.hasBlinked);
}
{
  const t = makeTracker('blink-first', 1);
  calibrate(t);
  const s = doBlink(t, 0.30, BLINK_MIN_MS - 1);
  check(
    `closure of ${BLINK_MIN_MS - 1} ms rejected as detector noise`,
    s.blinkCount === 0,
    `blinkCount=${s.blinkCount}`
  );
}
{
  const t = makeTracker('blink-first', 1);
  calibrate(t);
  const s = doBlink(t, 0.30, BLINK_MIN_MS);
  check(`closure of exactly ${BLINK_MIN_MS} ms accepted (inclusive lower bound)`, s.blinkCount === 1);
}
{
  const t = makeTracker('blink-first', 1);
  calibrate(t);
  const s = doBlink(t, 0.30, BLINK_MAX_MS);
  check(`closure of exactly ${BLINK_MAX_MS} ms accepted (inclusive upper bound)`, s.blinkCount === 1);
}
{
  const t = makeTracker('blink-first', 1);
  calibrate(t);
  const s = doBlink(t, 0.30, BLINK_MAX_MS + 1);
  check(
    `closure of ${BLINK_MAX_MS + 1} ms rejected as too long to be a blink`,
    s.blinkCount === 0,
    `blinkCount=${s.blinkCount}`
  );
}
{
  // Two blinks required: one is not enough.
  const t = makeTracker('blink-first', 2);
  calibrate(t);
  let s = doBlink(t, 0.30, 150);
  check('requiredBlinks=2 pinned by the CSPRNG stub', s.requiredBlinks === 2);
  check('one blink of two does not satisfy the step', !s.hasBlinked && s.stepIndex === 0);
  s = doBlink(t, 0.30, 150);
  check('second blink satisfies the step', s.hasBlinked && s.stepIndex === 1);
}
{
  // A dip that never recovers above the recover threshold is not a blink.
  const t = makeTracker('blink-first', 1);
  calibrate(t);
  const partial = 0.30 * BLINK_RECOVER_FACTOR * 0.95; // above dip, below recover
  frame(t, 0.30 * BLINK_DIP_FACTOR * 0.8, 1.0);
  const s = frame(t, partial, 1.0, 150);
  check(
    'partial reopening below the recover threshold is not a blink',
    s.blinkCount === 0,
    `partialEar=${partial.toFixed(4)} recoverThreshold=${(0.30 * BLINK_RECOVER_FACTOR).toFixed(4)}`
  );
}

// ===========================================================================
console.log('\n=== 5. Sustained closure / occlusion ===');
// ===========================================================================
{
  // Eyes (or a covering hand) held shut for 3 s, then reopened. The closure is
  // discarded on the way, so the reopen must not retroactively count.
  const t = makeTracker('blink-first', 1);
  calibrate(t);
  const closed = 0.30 * BLINK_DIP_FACTOR * 0.8;
  frame(t, closed, 1.0); // closure begins
  frame(t, closed, 1.0, 1000);
  frame(t, closed, 1.0, 1000); // now past BLINK_MAX_MS -> discarded
  const s = frame(t, 0.30, 1.0, 100);
  check(
    'sustained 2 s closure then reopen is not credited as a blink',
    s.blinkCount === 0,
    `blinkCount=${s.blinkCount}`
  );

  // But a genuine blink immediately afterwards still works: the state machine recovered.
  const s2 = doBlink(t, 0.30, 150);
  check('state machine recovers after a discarded closure', s2.blinkCount === 1);
}
{
  /**
   * REGRESSION. The original code set `dipStartedAt = null` when a closure
   * exceeded BLINK_MAX_MS, which meant "eye is open" and "closure disqualified"
   * were the same state. The machine therefore re-armed on the very next
   * still-closed frame, restarting the closure clock mid-closure, so an occlusion
   * of ANY duration ended in a textbook 100 ms "blink". A held-up photo plus a
   * hand passing the lens satisfied the blink requirement with zero eyelid
   * dynamics -- defeating the one attack the module claims to stop.
   *
   * Swept across many occlusion lengths and frame rates because the original bug
   * only reproduced when the disqualification landed on a still-closed frame.
   */
  let credited = 0;
  const cases: string[] = [];
  for (const occlusionMs of [950, 1000, 1500, 2000, 3000, 5000, 9000]) {
    for (const stepMs of [33, 100, 250, 500]) {
      const t = makeTracker('blink-first', 1);
      calibrate(t);
      const closed = 0.30 * BLINK_DIP_FACTOR * 0.8;
      let held = 0;
      frame(t, closed, 1.0, 33);
      while (held < occlusionMs) {
        frame(t, closed, 1.0, stepMs);
        held += stepMs;
      }
      const s = frame(t, 0.30, 1.0, 100); // eye reappears
      if (s.blinkCount > 0) {
        credited++;
        cases.push(`${occlusionMs}ms@${stepMs}ms`);
      }
    }
  }
  check(
    'occlusion of any length x frame rate is never credited as a blink',
    credited === 0,
    credited === 0 ? '28 combinations, 0 credited' : `credited: ${cases.join(', ')}`
  );
}
{
  // The latch must not be sticky: a genuine blink after a long occlusion still counts.
  const t = makeTracker('blink-first', 1);
  calibrate(t);
  const closed = 0.30 * BLINK_DIP_FACTOR * 0.8;
  frame(t, closed, 1.0);
  for (let i = 0; i < 20; i++) frame(t, closed, 1.0, 250); // 5 s occlusion
  frame(t, 0.30, 1.0, 100); // reopen -> clears the latch
  const s = doBlink(t, 0.30, 150);
  check('genuine blink after a long occlusion is still credited', s.blinkCount === 1);
}

// ===========================================================================
console.log('\n=== 6. Turn requires away AND return ===');
// ===========================================================================
{
  const t = makeTracker('turn-first', 1);
  calibrate(t);
  const s0 = frame(t, 0.30, 1.0);
  check('turn-first order pinned by the CSPRNG stub', s0.sequence[0] === 'turn');

  // Turn away only.
  const s1 = frame(t, 0.30, TURN_AWAY_FACTOR * 1.1);
  check('turning away alone does not satisfy the turn', !s1.hasTurnedHead && s1.stepIndex === 0);

  // Not far enough back yet.
  const s2 = frame(t, 0.30, TURN_RETURN_FACTOR * 1.2);
  check('returning only part way does not satisfy the turn', !s2.hasTurnedHead);

  // All the way back to centre.
  const s3 = frame(t, 0.30, 1.0);
  check('away then back to centre satisfies the turn', s3.hasTurnedHead && s3.stepIndex === 1);
}
{
  // An excursion that never crosses TURN_AWAY_FACTOR is not a turn.
  const t = makeTracker('turn-first', 1);
  calibrate(t);
  let s = frame(t, 0.30, TURN_AWAY_FACTOR * 0.95);
  s = frame(t, 0.30, 1.0);
  check('sub-threshold head movement is not a turn', !s.hasTurnedHead);
}
{
  // Turning the other way (yaw below baseline/factor) must also count.
  const t = makeTracker('turn-first', 1);
  calibrate(t);
  frame(t, 0.30, 1 / (TURN_AWAY_FACTOR * 1.1));
  const s = frame(t, 0.30, 1.0);
  check('turning to the other side also counts', s.hasTurnedHead);
}

// ===========================================================================
console.log('\n=== 7. ATTACK: held-up static photo ===');
// ===========================================================================
{
  // A printed photo or a still on a phone screen: perfectly valid 68 landmarks,
  // perfectly constant. No EAR dynamics, no yaw excursion.
  const t = makeTracker('blink-first', 1);
  let s = frame(t, 0.30, 1.0, 0);
  let frames = 1;
  // Run past the timeout at ~30 fps.
  while (s.elapsedMs <= CHALLENGE_TIMEOUT_MS + 500) {
    s = frame(t, 0.30, 1.0, 33);
    frames++;
  }
  check(
    'static photo never completes the challenge',
    !s.isComplete,
    `${frames} frames, ${s.elapsedMs} ms`
  );
  check('static photo scores 0', s.livenessScore === 0, `score=${s.livenessScore}`);
  check('static photo is reported as timed out', s.isTimedOut);
  check('static photo credited no blinks', s.blinkCount === 0);
  check('static photo credited no turn', !s.hasTurnedHead);
}

// ===========================================================================
console.log('\n=== 8. ATTACK: actions out of the requested order ===');
// ===========================================================================
{
  // A replayed clip that always performs turn-then-blink must fail an attempt
  // whose randomized order is blink-then-turn.
  const t = makeTracker('blink-first', 1);
  calibrate(t);

  // Perform the TURN while 'blink' is the active action.
  frame(t, 0.30, TURN_AWAY_FACTOR * 1.1);
  let s = frame(t, 0.30, 1.0);
  check('turn performed during the blink step is not credited', !s.hasTurnedHead && s.stepIndex === 0);

  // Now blink: advances to the turn step.
  s = doBlink(t, 0.30, 150);
  check('blink advances to the turn step', s.stepIndex === 1 && !s.isComplete);

  // The earlier turn must not carry over -- it has to be performed again.
  s = frame(t, 0.30, 1.0);
  check('earlier out-of-order turn did not carry over', !s.hasTurnedHead && !s.isComplete);

  // Perform it in order this time.
  s = doTurn(t, 0.30);
  check('challenge completes when both actions are done in order', s.isComplete);
  check('completed challenge scores 100', s.livenessScore === 100, `score=${s.livenessScore}`);
}
{
  // Mirror case: blink during the turn step is not credited early.
  const t = makeTracker('turn-first', 1);
  calibrate(t);
  let s = doBlink(t, 0.30, 150);
  check('blink performed during the turn step is not credited', s.blinkCount === 0);
  s = doTurn(t, 0.30);
  check('turn completes its own step', s.hasTurnedHead && s.stepIndex === 1 && !s.isComplete);
  s = doBlink(t, 0.30, 150);
  check('blink then completes the challenge', s.isComplete && s.livenessScore === 100);
}

// ===========================================================================
console.log('\n=== 9. Timeout ===');
// ===========================================================================
{
  const t = makeTracker('blink-first', 1);
  calibrate(t);

  // Jump to just inside the window: still live.
  virtualNow += CHALLENGE_TIMEOUT_MS - 2000;
  let s = frame(t, 0.30, 1.0, 0);
  check('challenge still live just inside the timeout', !s.isTimedOut, `elapsedMs=${s.elapsedMs}`);

  // Cross the boundary.
  virtualNow += 2100;
  s = frame(t, 0.30, 1.0, 0);
  check('timeout fires past CHALLENGE_TIMEOUT_MS', s.isTimedOut, `elapsedMs=${s.elapsedMs}`);

  // A perfect blink+turn after the timeout must not rescue the attempt.
  s = doBlink(t, 0.30, 150);
  s = doTurn(t, 0.30);
  check('actions after the timeout cannot complete the challenge', !s.isComplete);
  check('timed-out attempt still scores 0', s.livenessScore === 0);
}
{
  // A challenge already completed inside the window is not retroactively timed out.
  const t = makeTracker('blink-first', 1);
  calibrate(t);
  doBlink(t, 0.30, 150);
  let s = doTurn(t, 0.30);
  check('challenge completed inside the window', s.isComplete);
  virtualNow += CHALLENGE_TIMEOUT_MS * 3;
  s = frame(t, 0.30, 1.0, 0);
  check('completed challenge is not retroactively timed out', s.isComplete && !s.isTimedOut);
}

// ===========================================================================
console.log('\n=== 10. Face lost mid-challenge wipes progress ===');
// ===========================================================================
{
  const t = makeTracker('blink-first', 1);
  calibrate(t);
  let s = doBlink(t, 0.30, 150);
  check('precondition: blink credited before face loss', s.blinkCount === 1 && s.stepIndex === 1);

  // Brief dropout under the grace period must NOT reset.
  s = blankFrame(t, FACE_LOST_RESET_MS - 500);
  check('short dropout does not reset progress', s.blinkCount === 1, `blinkCount=${s.blinkCount}`);

  // Re-acquire, then drop out for longer than the grace period.
  s = frame(t, 0.30, 1.0);
  s = blankFrame(t, FACE_LOST_RESET_MS + 100);
  check('long dropout resets progress', s.blinkCount === 0 && s.stepIndex === 0);
  check('long dropout forces re-calibration (no subject swap)', s.calibrating);
  check('long dropout reports the restart to the user', /restart/i.test(s.currentPrompt));

  // The restart also restarts the clock, so the attempt is not born timed out.
  s = frame(t, 0.30, 1.0);
  check('restart resets the clock', s.elapsedMs < CHALLENGE_TIMEOUT_MS && !s.isTimedOut);
}

// ===========================================================================
console.log('\n=== 11. Completion latches ===');
// ===========================================================================
{
  const t = makeTracker('blink-first', 1);
  calibrate(t);
  doBlink(t, 0.30, 150);
  let s = doTurn(t, 0.30);
  check('precondition: challenge complete', s.isComplete);

  s = frame(t, 0.30, 1.0);
  check('later normal frame keeps isComplete', s.isComplete);

  s = blankFrame(t, FACE_LOST_RESET_MS * 3);
  check('losing the face after completion does not un-complete', s.isComplete);

  s = t.processFrame(Array.from({ length: 68 }, () => ({ x: NaN, y: NaN })));
  check('garbage frame after completion does not un-complete', s.isComplete);
  check('score stays 100 after completion', s.livenessScore === 100);
}

// ===========================================================================
console.log('\n=== 12. Score is only 100 on genuine completion ===');
// ===========================================================================
{
  const t = makeTracker('blink-first', 1);
  const s0 = calibrate(t);
  check('score 0 before any action', s0.livenessScore === 0);

  const s1 = doBlink(t, 0.30, 150);
  check('score 50 after one of two actions', s1.livenessScore === 50, `score=${s1.livenessScore}`);

  const s2 = doTurn(t, 0.30);
  check('score 100 only after both actions', s2.livenessScore === 100);
}

// ===========================================================================
console.log('\n=== 13. Randomization is real (unstubbed CSPRNG) ===');
// ===========================================================================
{
  unstubRandom();

  const orders = new Set<string>();
  const blinkCounts = new Set<number>();
  const descriptions = new Set<string>();

  for (let i = 0; i < 400; i++) {
    const t = new LivenessTracker();
    const s = t.processFrame(makeLandmarks(0.3, 1.0));
    orders.add(s.sequence.join('>'));
    blinkCounts.add(s.requiredBlinks);
    descriptions.add(t.challengeDescription);
  }

  check(
    'both action orders occur across 400 attempts',
    orders.size === 2,
    [...orders].join(' | ')
  );
  check(
    'both blink counts occur across 400 attempts',
    blinkCounts.size === 2 && blinkCounts.has(1) && blinkCounts.has(2),
    [...blinkCounts].sort().join(',')
  );
  check(
    'challengeDescription varies with the drawn challenge',
    descriptions.size === 4,
    `${descriptions.size} distinct descriptions`
  );
  check(
    'requiredBlinks is never outside {1,2}',
    [...blinkCounts].every((n) => n === 1 || n === 2)
  );

  // reset() must re-randomize an existing tracker, not keep the first draw.
  const t = new LivenessTracker();
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    t.reset();
    const s = t.processFrame(makeLandmarks(0.3, 1.0));
    seen.add(`${s.sequence.join('>')}:${s.requiredBlinks}`);
  }
  check('reset() re-randomizes the challenge', seen.size === 4, `${seen.size} distinct challenges`);

  stubRandom([]);
}

// ===========================================================================
console.log('\n=== 14. Malformed input never throws ===');
// ===========================================================================
{
  const t = makeTracker('blink-first', 1);
  const hostile: unknown[] = [
    [],
    null,
    undefined,
    Array.from({ length: 67 }, () => ({ x: 1, y: 1 })), // one short of 68
    Array.from({ length: 68 }, () => ({ x: NaN, y: NaN })),
    Array.from({ length: 68 }, () => ({ x: Infinity, y: -Infinity })),
    Array.from({ length: 68 }, () => ({ x: 5, y: 5 })), // fully collapsed
    Array.from({ length: 68 }),                          // holes
    Array.from({ length: 500 }, () => ({ x: 1, y: 2 })),
  ];

  let threw: string | null = null;
  for (const h of hostile) {
    try {
      virtualNow += 33;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      t.processFrame(h as any);
    } catch (e) {
      threw = `${JSON.stringify(String(e))} on ${Array.isArray(h) ? `array(${h.length})` : String(h)}`;
      break;
    }
  }
  check('processFrame never throws on malformed landmarks', threw === null, threw ?? '9 hostile inputs');

  // And none of that garbage can complete a challenge.
  const s = t.processFrame(Array.from({ length: 68 }, () => ({ x: 5, y: 5 })));
  check('malformed input cannot complete the challenge', !s.isComplete && s.livenessScore === 0);
}

// ===========================================================================
// Teardown + verdict
// ===========================================================================

// ===========================================================================
console.log('\n=== 15. Baseline estimation and drift (field-failure regression) ===');
// ===========================================================================
{
  /**
   * REGRESSION for a REAL observed failure, not a hypothetical one: a subject on /claim blinked
   * for 42.9 s and the counter stayed at 0/1, telemetry reading "EAR 0.277 / yaw 1.67".
   *
   * The baseline was the MEAN OF THE TOP 3 of 12 calibration samples. That is robust to a blink
   * during calibration but systematically biased HIGH, because it deliberately samples the upper
   * tail of face-api.js landmark jitter (~10% frame to frame). With the trace below the estimate
   * came out at 0.3163 against a true open EAR of 0.277, putting the recover threshold
   * (baseline * 0.88 = 0.2784) ABOVE the value open eyes produce. Closures could start and never
   * complete; after BLINK_MAX_MS each was disqualified into `awaitingReopen`, which waits on that
   * same unreachable threshold — so blink detection was dead for the rest of the attempt.
   *
   * The invariant this test pins: the recover threshold MUST sit below the subject's steady
   * open-eye EAR. If it does not, the challenge is unpassable no matter what the user does.
   */
  const OPEN = 0.277;
  const JITTER = [0.277, 0.305, 0.288, 0.316, 0.271, 0.298, 0.322, 0.284, 0.279, 0.311, 0.290, 0.276];
  check(
    'precondition: the jitter trace does defeat a top-3 estimator',
    [...JITTER].sort((a, b) => b - a).slice(0, 3).reduce((s, v) => s + v, 0) / 3 * 0.88 > OPEN
  );

  const t = makeTracker('turn-first', 1); // the order from the field screenshot
  let s = t.processFrame(makeLandmarks(JITTER[0], 1.0));
  for (const e of JITTER.slice(1)) s = frame(t, e, 1.0);
  s = frame(t, OPEN, 1.0);

  check(
    'baseline from a jittery calibration stays near the true open EAR',
    Math.abs(s.earBaseline - OPEN) < 0.02,
    `baseline=${s.earBaseline.toFixed(4)} vs open ${OPEN}`
  );
  check(
    'recover threshold is reachable from the steady open EAR',
    s.earBaseline * BLINK_RECOVER_FACTOR < OPEN,
    `recover=${(s.earBaseline * BLINK_RECOVER_FACTOR).toFixed(4)} < ${OPEN}`
  );
  check(
    'dip threshold stays below the open EAR so open eyes are not read as closed',
    s.earDipThreshold < OPEN,
    `dip=${s.earDipThreshold.toFixed(4)}`
  );

  doTurn(t, OPEN);
  s = frame(t, OPEN, 1.0);
  check('turn step completes (as it did in the field)', s.hasTurnedHead);

  // The exact thing the user did, once.
  const closed = OPEN * BLINK_DIP_FACTOR * 0.8;
  frame(t, closed, 1.0, 66);
  frame(t, closed, 1.0, 66);
  s = frame(t, OPEN, 1.0, 66);
  check('the FIRST genuine blink is credited', s.blinkCount === 1, `blinkCount=${s.blinkCount}`);
  check('challenge completes instead of timing out', s.isComplete && !s.isTimedOut);
  check('elapsed is nowhere near the timeout', s.elapsedMs < 5_000, `${(s.elapsedMs / 1000).toFixed(1)}s`);
}
{
  // A blink DURING calibration must not drag the median down. Blinks are a ~5% duty cycle event,
  // so closed frames can never be half the window — which is why the median is robust for a
  // better reason than the top-3 estimator was.
  const t = makeTracker('blink-first', 1);
  let s = t.processFrame(makeLandmarks(0.30, 1.0));
  const trace = [0.30, 0.30, 0.11, 0.09, 0.30, 0.30, 0.30, 0.30, 0.30, 0.30, 0.30, 0.30];
  for (const e of trace.slice(1)) s = frame(t, e, 1.0);
  s = frame(t, 0.30, 1.0);
  check(
    'two closed frames during calibration do not corrupt the baseline',
    Math.abs(s.earBaseline - 0.30) < 0.01,
    `baseline=${s.earBaseline.toFixed(4)}`
  );
  const s2 = doBlink(t, 0.30, 150);
  check('blink still detected after a blink-contaminated calibration', s2.blinkCount === 1);
}
{
  /**
   * Drift. The baseline is calibrated in the first ~0.4 s but the challenge now runs up to 40 s,
   * during which the subject leans, the auto-exposure shifts, or they squint while reading the
   * prompt. A frozen baseline re-creates the unreachable-recovery failure above; the EMA tracks it.
   */
  const t = makeTracker('blink-first', 1);
  calibrate(t, 0.34, 1.0);
  // EAR settles 25% lower than calibration -- e.g. the subject sat back from the camera.
  let s = frame(t, 0.34, 1.0);
  const before = s.earBaseline;
  for (let i = 0; i < 120; i++) s = frame(t, 0.255, 1.0);
  check(
    'baseline tracks a sustained downward drift in open-eye EAR',
    s.earBaseline < before - 0.03 && s.earBaseline > 0.24,
    `${before.toFixed(4)} -> ${s.earBaseline.toFixed(4)}`
  );
  const s2 = doBlink(t, 0.255, 150);
  check('blink is detected at the drifted-to EAR', s2.blinkCount === 1, `blinkCount=${s2.blinkCount}`);
}
{
  // ATTACK: the drift tracker must not be usable to fake a blink. A static photo has a CONSTANT
  // EAR; the baseline converges onto that constant and a constant never crosses baseline * 0.75.
  const t = makeTracker('blink-first', 1);
  calibrate(t, 0.29, 1.0);
  let s = frame(t, 0.29, 1.0);
  for (let i = 0; i < 1500; i++) s = frame(t, 0.29, 1.0); // ~50 s of a held-up photo, past the timeout
  check(
    'a constant EAR never becomes a blink however long it is held',
    s.blinkCount === 0 && s.blinkDipsSeen === 0,
    `dips=${s.blinkDipsSeen}`
  );
  check('static photo still times out rather than completing', s.isTimedOut && !s.isComplete);
}
{
  /**
   * The awaitingReopen backstop must fire ONLY for a miscalibrated baseline, never for an
   * occlusion. Distinguishing signal: EAR parked in the hysteresis dead band
   * (>= dipThreshold, so not a closed eye, yet <= recoverThreshold).
   *
   * Case A: EAR in the dead band. Baseline is wrong -> re-seed and recover.
   */
  const t = makeTracker('blink-first', 1);
  calibrate(t, 0.30, 1.0);
  // Force a stuck closure, then park EAR inside the dead band [0.225, 0.246].
  const closed = 0.30 * BLINK_DIP_FACTOR * 0.8;
  frame(t, closed, 1.0);
  frame(t, closed, 1.0, 1000);
  frame(t, closed, 1.0, 1000); // disqualified -> awaitingReopen latched
  let s = frame(t, 0.235, 1.0, 100);
  check('precondition: parked in the dead band, blink not yet possible', s.blinkCount === 0);
  for (let i = 0; i < 40; i++) s = frame(t, 0.235, 1.0, 50); // > AWAITING_REOPEN_ESCAPE_MS
  check(
    'backstop re-seeds the baseline from a dead-band EAR',
    Math.abs(s.earBaseline - 0.235) < 0.01,
    `baseline=${s.earBaseline.toFixed(4)}`
  );
  const s2 = doBlink(t, 0.235, 150);
  check('blink detection recovers after the backstop fires', s2.blinkCount === 1);
}
{
  /**
   * Case B: EAR still below dipThreshold — the eye really is shut, or a hand covers the lens.
   * The latch MUST hold. Clearing it would re-arm the closure clock mid-occlusion, so the
   * eventual reopen would read as a textbook-duration blink with zero eyelid dynamics.
   * Swept well past AWAITING_REOPEN_ESCAPE_MS at several frame rates.
   */
  let credited = 0;
  const cases: string[] = [];
  for (const occlusionMs of [1500, 2000, 4000, 8000, 12000]) {
    for (const stepMs of [33, 100, 250]) {
      const t = makeTracker('blink-first', 1);
      calibrate(t, 0.30, 1.0);
      const closed = 0.30 * BLINK_DIP_FACTOR * 0.8;
      let held = 0;
      frame(t, closed, 1.0, 33);
      while (held < occlusionMs) {
        frame(t, closed, 1.0, stepMs);
        held += stepMs;
      }
      const s = frame(t, 0.30, 1.0, 100); // eye reappears
      if (s.blinkCount > 0) {
        credited++;
        cases.push(`${occlusionMs}ms@${stepMs}ms`);
      }
    }
  }
  check(
    'the backstop does NOT let an occlusion past the latch',
    credited === 0,
    credited === 0
      ? `15 combinations past ${AWAITING_REOPEN_ESCAPE_MS}ms, 0 credited`
      : `credited: ${cases.join(', ')}`
  );
}
{
  // Feedback on a rejected closure. A blink faster than BLINK_MIN_MS and one held past
  // BLINK_MAX_MS both leave the counter unmoved; the prompt must say which way to adjust.
  const t = makeTracker('blink-first', 1);
  calibrate(t, 0.30, 1.0);
  const closed = 0.30 * BLINK_DIP_FACTOR * 0.8;
  frame(t, closed, 1.0, 33);
  let s = frame(t, 0.30, 1.0, 10); // 10 ms closure: below BLINK_MIN_MS
  check('too-fast closure is not credited', s.blinkCount === 0);
  check(
    'prompt tells the user to hold the blink longer',
    /longer/.test(s.currentPrompt),
    `"${s.currentPrompt}"`
  );
  s = frame(t, 0.30, 1.0, 33);

  const t2 = makeTracker('blink-first', 1);
  calibrate(t2, 0.30, 1.0);
  frame(t2, closed, 1.0, 33);
  frame(t2, closed, 1.0, 1000); // past BLINK_MAX_MS -> disqualified
  let s2 = frame(t2, 0.30, 1.0, 100);
  s2 = frame(t2, 0.30, 1.0, 33);
  check(
    'prompt tells the user the closure was too long',
    /too long/.test(s2.currentPrompt),
    `"${s2.currentPrompt}"`
  );

  // And the hint clears once a blink is actually credited.
  const s3 = doBlink(t, 0.30, 150);
  check('hint clears after a credited blink', s3.blinkCount === 1 && !/longer/.test(s3.currentPrompt));
}
{
  // Turn thresholds must stay non-overlapping: away must be strictly outside the return band,
  // or "turned away" and "returned to centre" could be satisfied by the same pose.
  check(
    'turn away band is strictly outside the return band',
    TURN_AWAY_FACTOR > TURN_RETURN_FACTOR,
    `away ${TURN_AWAY_FACTOR} > return ${TURN_RETURN_FACTOR}`
  );
  // The field screenshot showed yaw 1.67 reached against a ~1.0 baseline, so the required
  // excursion is comfortably achievable; pin that it is not larger than what was observed.
  check(
    'required yaw excursion is within what a real subject reached (1.67)',
    TURN_AWAY_FACTOR < 1.67,
    `away factor ${TURN_AWAY_FACTOR}`
  );
}

// ===========================================================================
// Teardown + verdict
// ===========================================================================

Date.now = realDateNow;
if (randomStubbed) unstubRandom();

console.log(`\n${'='.repeat(60)}`);
console.log(`Liveness tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nFailing:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
}
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
