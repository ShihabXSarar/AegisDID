/**
 * AegisDID — Liveness challenge unit tests (v3, MediaPipe signal state machine).
 *
 * Purpose: prove that lib/ml/liveness.ts actually rejects the attacks it claims to reject, and
 * actually accepts a genuine live subject.
 *
 * NOTHING is mocked except crypto.getRandomValues(), and only so the randomized action ORDER can
 * be pinned per test. The randomization itself is then tested separately WITHOUT the stub. The
 * clock is not stubbed at all: processFrame() takes an explicit `now`, so every duration boundary
 * (blink min/max, turn dwell, face-lost, challenge timeout) is exercised exactly, not
 * "probably fast enough".
 *
 * The inputs are the MediaPipe signals the production extractor produces — eyelid blendshape
 * coefficients in [0,1], signed yaw in degrees, interocular scale, confidence. There is no
 * landmark geometry to invert any more, which is the point: the v2 tests had to synthesize
 * 68-point rings to hit a target EAR, and the EAR was exactly the fragile part.
 *
 * Covers:
 *   A. Tunable sanity (hysteresis bands ordered, REQUIRED_BLINKS fixed at 2)
 *   B. Calibration: gate, eyes-must-start-open, neutral pose captured
 *   C. Quality gating: no-face, multi-face, too-small, low-confidence, unstable, non-finite
 *   D. Blink: genuine accepted; 1-frame spike, sub-80 ms, >700 ms, one-eyed all rejected
 *   E. Blink: no double-count, prolonged closure never becomes 2/2, distance change never counts
 *   F. Blink suspended outside the reliable pose range, credited blinks preserved
 *   G. Turn: needs sustained deviation AND sustained return; either direction; noise rejected
 *   H. Order is binding: the inactive action cannot score
 *   I. Timeout, face-lost reset, completion latch, score only 100 on genuine completion
 *   J. processFrame never throws on malformed input
 *
 * Run:  node scripts/liveness_test.mts        (from web/)
 */

// ---------------------------------------------------------------------------
// CSPRNG stub. Installed BEFORE liveness.ts is imported, because the
// LivenessTracker constructor calls reset(), which draws from the CSPRNG.
// ---------------------------------------------------------------------------

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

stubRandom([]);

import {
  LivenessTracker,
  REQUIRED_BLINKS,
  CALIBRATION_FRAMES,
  CHALLENGE_TIMEOUT_MS,
  FACE_LOST_RESET_MS,
  BLINK_CLOSE_ENTER,
  BLINK_CLOSE_EXIT,
  BLINK_BILATERAL_MIN,
  BLINK_OPEN_MAX,
  BLINK_MIN_MS,
  BLINK_MAX_MS,
  BLINK_MIN_CLOSED_FRAMES,
  BLINK_POSE_LIMIT_DEG,
  TURN_DEV_DEG,
  TURN_RETURN_DEG,
  TURN_DWELL_MS,
  MIN_FACE_SCALE,
  MIN_FACE_PX,
  MIN_CONFIDENCE,
  SCALE_STABLE_TOL,
  type LivenessSignals,
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

function section(title: string) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// Signal synthesis + an explicit virtual clock (never installed globally)
// ---------------------------------------------------------------------------

const FRAME_MS = 33; // ~30 fps, the rate MediaPipe VIDEO mode runs at on a laptop
const OPEN = 0.05; // eyeBlink* coefficient with eyes open
const CLOSED = 0.9; // eyeBlink* coefficient at full closure
const BASE_SCALE = 0.18; // interocular / frame width
const BASE_PX = 115;

let vnow = 1_700_000_000_000;

function sig(o: Partial<LivenessSignals> = {}): LivenessSignals {
  return {
    ok: true,
    blinkLeft: OPEN,
    blinkRight: OPEN,
    yawDeg: 0,
    faceScale: BASE_SCALE,
    faceScalePx: BASE_PX,
    confidence: 0.99,
    ...o,
  };
}

/** Advance the virtual clock, then feed one frame. */
function frame(t: LivenessTracker, o: Partial<LivenessSignals> = {}, dt = FRAME_MS): LivenessState {
  vnow += dt;
  return t.processFrame(sig(o), vnow);
}

/** Fresh tracker with a pinned action order (reset() draws randomBelow(2) exactly once). */
function makeTracker(order: 'blink-first' | 'turn-first'): LivenessTracker {
  stubRandom([order === 'blink-first' ? 0 : 1]);
  return new LivenessTracker();
}

/** Feed exactly CALIBRATION_FRAMES usable frames. Returns the last state. */
function calibrate(t: LivenessTracker, o: Partial<LivenessSignals> = {}): LivenessState {
  let s = frame(t, o, 0); // first usable face starts the clock
  for (let i = 1; i < CALIBRATION_FRAMES; i++) s = frame(t, o);
  return s;
}

/**
 * One closure of `closedFrames` frames followed by enough open frames for the smoothed
 * coefficient to fall back under BLINK_CLOSE_EXIT (the reopen edge).
 */
function doBlink(
  t: LivenessTracker,
  closedFrames = 3,
  o: Partial<LivenessSignals> = {},
  openFrames = 5
): LivenessState {
  let s: LivenessState = frame(t, { ...o, blinkLeft: CLOSED, blinkRight: CLOSED });
  for (let i = 1; i < closedFrames; i++) {
    s = frame(t, { ...o, blinkLeft: CLOSED, blinkRight: CLOSED });
  }
  for (let i = 0; i < openFrames; i++) s = frame(t, o);
  return s;
}

function doTurn(t: LivenessTracker, yawDeg = 35, frames = 18): LivenessState {
  let s: LivenessState = frame(t, { yawDeg });
  for (let i = 1; i < frames; i++) s = frame(t, { yawDeg });
  return s;
}

function doReturn(t: LivenessTracker, frames = 18): LivenessState {
  let s: LivenessState = frame(t);
  for (let i = 1; i < frames; i++) s = frame(t);
  return s;
}

/** Complete whichever action the pinned sequence asks for first, then the other. */
function completeChallenge(t: LivenessTracker, s0: LivenessState): LivenessState {
  let s = s0;
  for (let guard = 0; guard < 10 && !s.isComplete; guard++) {
    const step = s.sequence[s.stepIndex];
    if (step === 'turn') {
      doTurn(t);
      s = doReturn(t);
    } else {
      s = doBlink(t);
    }
  }
  return s;
}

// ===========================================================================
// A. Tunable sanity
// ===========================================================================
section('A. Tunables');
{
  check(
    'two blinks are required and the count is not randomizable',
    REQUIRED_BLINKS === 2,
    `REQUIRED_BLINKS=${REQUIRED_BLINKS}`
  );
  check(
    'closure hysteresis band is ordered (exit < enter)',
    BLINK_CLOSE_EXIT < BLINK_CLOSE_ENTER,
    `exit ${BLINK_CLOSE_EXIT} < enter ${BLINK_CLOSE_ENTER}`
  );
  check(
    'the "fully open" bar is stricter than the reopen bar',
    BLINK_OPEN_MAX < BLINK_CLOSE_EXIT,
    `open ${BLINK_OPEN_MAX} < exit ${BLINK_CLOSE_EXIT}`
  );
  check(
    'bilateral agreement floor is below the closure entry threshold',
    BLINK_BILATERAL_MIN < BLINK_CLOSE_ENTER,
    `bilateral ${BLINK_BILATERAL_MIN} < enter ${BLINK_CLOSE_ENTER}`
  );
  check(
    'blink duration window is physiological',
    BLINK_MIN_MS >= 80 && BLINK_MAX_MS <= 800 && BLINK_MIN_MS < BLINK_MAX_MS,
    `[${BLINK_MIN_MS}, ${BLINK_MAX_MS}] ms`
  );
  check(
    'a single 30 fps frame cannot span the minimum closure',
    BLINK_MIN_MS > 2 * FRAME_MS - 1 || BLINK_MIN_CLOSED_FRAMES >= 2,
    `min ${BLINK_MIN_MS} ms, min frames ${BLINK_MIN_CLOSED_FRAMES}`
  );
  check(
    'turn away band is strictly outside the return band',
    TURN_DEV_DEG > TURN_RETURN_DEG,
    `away ${TURN_DEV_DEG}° > return ${TURN_RETURN_DEG}°`
  );
  check(
    'turn dwell exceeds one frame period at 30 fps',
    TURN_DWELL_MS > FRAME_MS,
    `dwell ${TURN_DWELL_MS} ms > frame ${FRAME_MS} ms`
  );
  check(
    'a legitimate turn threshold is reachable before blink tracking is suspended',
    BLINK_POSE_LIMIT_DEG > TURN_DEV_DEG,
    `pose limit ${BLINK_POSE_LIMIT_DEG}° > turn ${TURN_DEV_DEG}°`
  );
}

// ===========================================================================
// B. Calibration
// ===========================================================================
section('B. Calibration');
{
  const t = makeTracker('blink-first');
  let s = frame(t, {}, 0);
  check('first frame is calibrating, not scoring', s.calibrating && s.challengeState === 'calibrating');
  for (let i = 1; i < CALIBRATION_FRAMES - 1; i++) s = frame(t);
  check(
    `still calibrating at ${CALIBRATION_FRAMES - 1} frames`,
    s.calibrating,
    `state ${s.challengeState}`
  );
  s = frame(t);
  check('calibrated on the required frame count', !s.calibrating, `state ${s.challengeState}`);
  check(
    'neutral yaw baseline captured at ~0°',
    Math.abs(s.yawBaselineDeg) < 0.5,
    `baseline ${s.yawBaselineDeg.toFixed(3)}°`
  );
}
{
  // A subject who arrives mid-blink must not have the closed state adopted as normal.
  const t = makeTracker('blink-first');
  let s = frame(t, { blinkLeft: CLOSED, blinkRight: CLOSED }, 0);
  for (let i = 0; i < 40; i++) s = frame(t, { blinkLeft: CLOSED, blinkRight: CLOSED });
  check(
    'calibration refuses to complete while the eyes are shut',
    s.calibrating && /eyes open/i.test(s.currentPrompt),
    `"${s.currentPrompt}"`
  );
  for (let i = 0; i < CALIBRATION_FRAMES; i++) s = frame(t);
  check('calibration completes once the eyes open', !s.calibrating);
}
{
  // No action can score before calibration finishes.
  const t = makeTracker('blink-first');
  frame(t, {}, 0);
  const s = doBlink(t, 3);
  check(
    'no blink is credited before calibration completes',
    s.blinkCount === 0,
    `blinks ${s.blinkCount}, calibrating ${s.calibrating}`
  );
}

// ===========================================================================
// C. Quality gating
// ===========================================================================
section('C. Quality gating');
{
  const t = makeTracker('blink-first');
  calibrate(t);
  check('ok:false -> no-face', frame(t, { ok: false }).faceQuality === 'no-face');
  check(
    'multipleFaces -> multiple-faces',
    frame(t, { ok: false, multipleFaces: true }).faceQuality === 'multiple-faces'
  );
  check(
    'faceScale below the floor -> too-small',
    frame(t, { faceScale: MIN_FACE_SCALE / 2, faceScalePx: 60 }).faceQuality === 'too-small',
    `floor ${MIN_FACE_SCALE}`
  );
  check(
    'faceScalePx below the floor -> too-small',
    frame(t, { faceScalePx: MIN_FACE_PX - 1 }).faceQuality === 'too-small',
    `floor ${MIN_FACE_PX}px`
  );
  check(
    'confidence below the floor -> low-confidence',
    frame(t, { confidence: MIN_CONFIDENCE / 2 }).faceQuality === 'low-confidence'
  );
  const jump = BASE_SCALE * (1 + SCALE_STABLE_TOL * 2);
  check(
    'abrupt interocular jump -> unstable',
    frame(t, { faceScale: jump, faceScalePx: BASE_PX * (1 + SCALE_STABLE_TOL * 2) })
      .faceQuality === 'unstable',
    `${BASE_SCALE} -> ${jump.toFixed(3)}`
  );
  for (const bad of [NaN, Infinity, -Infinity]) {
    check(
      `non-finite blink coefficient (${bad}) fails closed`,
      frame(t, { blinkLeft: bad, blinkRight: bad }).faceQuality === 'unknown'
    );
    check(
      `non-finite yaw (${bad}) fails closed`,
      frame(t, { yawDeg: bad }).faceQuality === 'unknown'
    );
  }
}

// ===========================================================================
// D. Blink acceptance and rejection
// ===========================================================================
section('D. Blink detection');
{
  const t = makeTracker('blink-first');
  calibrate(t);
  const s = doBlink(t, 3);
  check(
    'a genuine ~130 ms bilateral closure counts exactly 1',
    s.blinkCount === 1 && s.closuresSeen === 1,
    `blinks ${s.blinkCount}, closures ${s.closuresSeen}, phase ${s.blinkPhase}`
  );
  check('phase returns to open after the blink', s.blinkPhase === 'open');
}
{
  const t = makeTracker('blink-first');
  calibrate(t);
  const s = doBlink(t, 1);
  check(
    'a ONE-FRAME coefficient spike is not a blink',
    s.blinkCount === 0 && s.closuresSeen === 1,
    `blinks ${s.blinkCount}, closures ${s.closuresSeen}`
  );
  check(
    'the rejected spike is explained to the user',
    /longer/i.test(s.currentPrompt),
    `"${s.currentPrompt}"`
  );
}
{
  // Held shut for ~1 s: longer than BLINK_MAX_MS, so it is a closure, never a blink.
  const t = makeTracker('blink-first');
  calibrate(t);
  const s = doBlink(t, 30);
  check(
    'a ~1 s held closure is never credited as a blink',
    s.blinkCount === 0,
    `blinks ${s.blinkCount}, closures ${s.closuresSeen}, phase ${s.blinkPhase}`
  );
  check(
    'the user is told the closure was too long',
    /too long/i.test(s.currentPrompt),
    `"${s.currentPrompt}"`
  );
}
{
  // ATTACK: hand over the lens for 3 s. Must not become 2/2 on reopen.
  const t = makeTracker('blink-first');
  calibrate(t);
  const s = doBlink(t, 90, {}, 8);
  check(
    'ATTACK ~3 s occlusion never becomes 2/2',
    s.blinkCount === 0 && !s.hasBlinked,
    `blinks ${s.blinkCount}/${s.requiredBlinks}, closures ${s.closuresSeen}`
  );
}
{
  // One eyelid only: MediaPipe sometimes reports an asymmetric spike. Bilateral agreement
  // means it can never confirm a closure.
  const t = makeTracker('blink-first');
  calibrate(t);
  let s = frame(t, { blinkLeft: 1.0, blinkRight: BLINK_BILATERAL_MIN - 0.01 });
  for (let i = 0; i < 5; i++) s = frame(t, { blinkLeft: 1.0, blinkRight: BLINK_BILATERAL_MIN - 0.01 });
  for (let i = 0; i < 6; i++) s = frame(t);
  check(
    'a one-eyed closure is discarded, not counted',
    s.blinkCount === 0 && s.closuresSeen === 0,
    `blinks ${s.blinkCount}, closures ${s.closuresSeen}, phase ${s.blinkPhase}`
  );
}
{
  // Coefficient parked inside the hysteresis band: never enters a closure at all.
  const t = makeTracker('blink-first');
  calibrate(t);
  let s: LivenessState | null = null;
  const mid = (BLINK_CLOSE_ENTER + BLINK_CLOSE_EXIT) / 2;
  for (let i = 0; i < 60; i++) s = frame(t, { blinkLeft: mid, blinkRight: mid });
  check(
    'a coefficient inside the hysteresis band never opens a closure',
    s!.blinkCount === 0 && s!.closuresSeen === 0 && s!.blinkPhase === 'open',
    `coeff ${mid.toFixed(3)}, phase ${s!.blinkPhase}`
  );
}

// ===========================================================================
// E. Counting integrity
// ===========================================================================
section('E. Counting integrity');
{
  const t = makeTracker('blink-first');
  calibrate(t);
  doBlink(t, 3);
  const s = doBlink(t, 3);
  check(
    'two genuine blinks count exactly 2 and satisfy the action',
    s.blinkCount === 2 && s.hasBlinked,
    `blinks ${s.blinkCount}/${s.requiredBlinks}, closures ${s.closuresSeen}`
  );
}
{
  const t = makeTracker('blink-first');
  calibrate(t);
  // A long open tail after one blink must not double-credit it.
  const s = doBlink(t, 3, {}, 60);
  check(
    'a single blink never becomes 2/2 no matter how long the eyes stay open',
    s.blinkCount === 1,
    `blinks ${s.blinkCount}/${s.requiredBlinks}`
  );
}
{
  // REGRESSION for the v2 field failure: pulling the camera away produced a phantom blink,
  // because EAR collapsed with face scale. Blendshape coefficients do not.
  const t = makeTracker('blink-first');
  calibrate(t);
  let s: LivenessState | null = null;
  for (let i = 0; i < 100; i++) {
    const f = 1 - i / 130; // shrink to ~23% of the calibrated interocular distance
    s = frame(t, { faceScale: BASE_SCALE * f, faceScalePx: BASE_PX * f });
  }
  check(
    'REGRESSION camera pulled away: zero phantom blinks',
    s!.blinkCount === 0 && s!.closuresSeen === 0,
    `blinks ${s!.blinkCount}, closures ${s!.closuresSeen}, quality ${s!.faceQuality}`
  );
}
{
  // ...and the same moving toward the camera.
  const t = makeTracker('blink-first');
  calibrate(t);
  let s: LivenessState | null = null;
  for (let i = 0; i < 100; i++) {
    const f = 1 + i / 60;
    s = frame(t, { faceScale: BASE_SCALE * f, faceScalePx: BASE_PX * f });
  }
  check(
    'REGRESSION camera pushed closer: zero phantom blinks',
    s!.blinkCount === 0 && s!.closuresSeen === 0,
    `blinks ${s!.blinkCount}, closures ${s!.closuresSeen}, quality ${s!.faceQuality}`
  );
}
{
  // Landmark dropout mid-closure must not let an unrelated reopen complete the closure.
  const t = makeTracker('blink-first');
  calibrate(t);
  frame(t, { blinkLeft: CLOSED, blinkRight: CLOSED });
  frame(t, { blinkLeft: CLOSED, blinkRight: CLOSED });
  const mid = frame(t, { ok: false });
  let s = mid;
  for (let i = 0; i < 6; i++) s = frame(t);
  check(
    'a dropout mid-closure locks the FSM instead of crediting a blink',
    s.blinkCount === 0,
    `blinks ${s.blinkCount}, phase after dropout ${mid.blinkPhase}`
  );
}

// ===========================================================================
// F. Pose gating for blink
// ===========================================================================
section('F. Pose gating');
{
  const t = makeTracker('blink-first');
  calibrate(t);
  // Ramp the smoothed yaw well past the reliability limit, then blink.
  for (let i = 0; i < 12; i++) frame(t, { yawDeg: 60 });
  const s = doBlink(t, 3, { yawDeg: 60 });
  check(
    `blink is not credited beyond ±${BLINK_POSE_LIMIT_DEG}° yaw`,
    s.blinkCount === 0,
    `blinks ${s.blinkCount}, phase ${s.blinkPhase}`
  );
}
{
  // A blink credited BEFORE the head turns must survive the turn (Step 7).
  const t = makeTracker('blink-first');
  calibrate(t);
  doBlink(t, 3);
  doBlink(t, 3);
  const before = t.processFrame(sig(), vnow);
  for (let i = 0; i < 20; i++) frame(t, { yawDeg: 60 });
  const s = frame(t, { yawDeg: 60 });
  check(
    'credited blinks are preserved while the pose is unreliable',
    s.blinkCount === before.blinkCount && s.blinkCount === 2,
    `before ${before.blinkCount}, during rotation ${s.blinkCount}`
  );
}

// ===========================================================================
// G. Head turn
// ===========================================================================
section('G. Head turn');
{
  const t = makeTracker('turn-first');
  calibrate(t);
  let s: LivenessState | null = null;
  for (let i = 0; i < 60; i++) s = frame(t);
  check(
    'a perfectly neutral pose never satisfies the turn',
    !s!.hasTurnedHead,
    `smoothed yaw ${s!.smoothedYawDeg.toFixed(2)}°`
  );
}
{
  const t = makeTracker('turn-first');
  calibrate(t);
  let s: LivenessState | null = null;
  for (let i = 0; i < 60; i++) s = frame(t, { yawDeg: TURN_DEV_DEG - 8 });
  check(
    'small head motion below the threshold never satisfies the turn',
    !s!.hasTurnedHead,
    `held ${TURN_DEV_DEG - 8}°, smoothed ${s!.smoothedYawDeg.toFixed(2)}°`
  );
}
{
  const t = makeTracker('turn-first');
  calibrate(t);
  // One noisy frame far past the threshold, immediately back to centre.
  frame(t, { yawDeg: 90 });
  let s = frame(t);
  const afterSpike = s.hasTurnedHead;
  for (let i = 0; i < 10; i++) s = frame(t);
  check(
    'a single out-of-range frame does not satisfy the turn',
    !afterSpike && !s.hasTurnedHead,
    `dwell requirement ${TURN_DWELL_MS} ms`
  );
}
{
  const t = makeTracker('turn-first');
  calibrate(t);
  const s = doTurn(t, 35);
  check(
    'turning away without returning does not complete the action',
    !s.hasTurnedHead && s.challengeState === 'awaiting-return',
    `state ${s.challengeState}`
  );
}
for (const [label, yaw] of [
  ['left', -35],
  ['right', 35],
] as const) {
  const t = makeTracker('turn-first');
  calibrate(t);
  doTurn(t, yaw);
  const s = doReturn(t);
  check(
    `a ${label} turn (${yaw}°) followed by a return completes the action`,
    s.hasTurnedHead,
    `smoothed yaw ${s.smoothedYawDeg.toFixed(2)}°, state ${s.challengeState}`
  );
}
{
  // Noise on top of a real turn must not break it, and must not complete it early.
  const t = makeTracker('turn-first');
  calibrate(t);
  let s: LivenessState | null = null;
  for (let i = 0; i < 24; i++) s = frame(t, { yawDeg: 30 + (i % 2 === 0 ? 6 : -6) });
  const awayUnderNoise = s!.challengeState === 'awaiting-return';
  for (let i = 0; i < 24; i++) s = frame(t, { yawDeg: i % 2 === 0 ? 2 : -2 });
  check(
    'a noisy but genuine turn + return still completes',
    awayUnderNoise && s!.hasTurnedHead,
    `state ${s!.challengeState}`
  );
}

// ===========================================================================
// H. The randomized order is binding
// ===========================================================================
section('H. Order enforcement');
{
  const t = makeTracker('turn-first');
  let s = calibrate(t);
  check('pinned order is turn-first', s.sequence[0] === 'turn', `[${s.sequence.join(', ')}]`);
  doBlink(t, 3);
  s = doBlink(t, 3);
  check(
    'ATTACK out-of-order: blinks performed during the turn step do not score',
    s.blinkCount === 0 && s.closuresSeen === 2 && !s.isComplete,
    `blinks ${s.blinkCount}, closures ${s.closuresSeen}`
  );
  doTurn(t);
  s = doReturn(t);
  check(
    'the turn step completes and the challenge advances to blink',
    s.hasTurnedHead && s.stepIndex === 1 && !s.isComplete,
    `step ${s.stepIndex}, score ${s.livenessScore}`
  );
  doBlink(t, 3);
  s = doBlink(t, 3);
  check(
    'blinks performed in the blink step complete the challenge',
    s.isComplete && s.blinkCount === 2 && s.livenessScore === 100,
    `blinks ${s.blinkCount}, score ${s.livenessScore}`
  );
}
{
  const t = makeTracker('blink-first');
  let s = calibrate(t);
  check('pinned order is blink-first', s.sequence[0] === 'blink', `[${s.sequence.join(', ')}]`);
  doTurn(t);
  s = doReturn(t);
  check(
    'ATTACK out-of-order: a turn performed during the blink step does not score',
    !s.hasTurnedHead && s.livenessScore === 0,
    `turned ${s.hasTurnedHead}, score ${s.livenessScore}`
  );
}

// ===========================================================================
// I. Session-level behaviour
// ===========================================================================
section('I. Session behaviour');
{
  // ATTACK: a static photo. Constant coefficients, constant pose, forever.
  const t = makeTracker('blink-first');
  let s = calibrate(t);
  for (let i = 0; i < 1400; i++) s = frame(t);
  check(
    'ATTACK static photo: no blink, no turn, score 0, never completes',
    !s.isComplete && s.blinkCount === 0 && !s.hasTurnedHead && s.livenessScore === 0,
    `blinks ${s.blinkCount}, closures ${s.closuresSeen}, turned ${s.hasTurnedHead}, timedOut ${s.isTimedOut}`
  );
  check(
    'ATTACK static photo eventually times out',
    s.isTimedOut,
    `elapsed ${(s.elapsedMs / 1000).toFixed(1)}s vs ${(CHALLENGE_TIMEOUT_MS / 1000).toFixed(0)}s`
  );
}
{
  const t = makeTracker('blink-first');
  calibrate(t);
  const before = frame(t, {}, CHALLENGE_TIMEOUT_MS - 2000);
  check('not timed out just under the limit', !before.isTimedOut, `t ${before.elapsedMs} ms`);
  const after = frame(t, {}, 2500);
  check(
    'timed out just over the limit',
    after.isTimedOut && after.challengeState === 'timeout',
    `t ${after.elapsedMs} ms`
  );
}
{
  // Face lost mid-challenge wipes progress, so a second subject cannot inherit the first's
  // credited actions.
  const t = makeTracker('blink-first');
  calibrate(t);
  const withBlink = doBlink(t, 3);
  check('a blink is credited before the face is lost', withBlink.blinkCount === 1);
  let s = frame(t, { ok: false }, 500);
  check(
    'a brief dropout does not wipe progress',
    s.blinkCount === 1,
    `after 500 ms, blinks ${s.blinkCount}`
  );
  for (let i = 0; i < 4; i++) frame(t, { ok: false }, 500);
  s = frame(t, { ok: false }, 500); // this one triggers the restart > 2500ms
  check(
    `face lost longer than ${FACE_LOST_RESET_MS} ms restarts the challenge`,
    s.blinkCount === 0 && /restarted/i.test(s.currentPrompt),
    `"${s.currentPrompt}"`
  );
}
{
  // Completion latches: a later frame cannot un-complete it, and cannot re-score it.
  const t = makeTracker('blink-first');
  const s0 = calibrate(t);
  let s = completeChallenge(t, s0);
  check(
    'the challenge completes with genuine actions',
    s.isComplete && s.livenessScore === 100 && !s.isTimedOut,
    `blinks ${s.blinkCount}/${s.requiredBlinks}, t ${(s.elapsedMs / 1000).toFixed(2)}s`
  );
  for (let i = 0; i < 200; i++) s = frame(t);
  check('completion latches across later frames', s.isComplete && s.livenessScore === 100);
  s = frame(t, { ok: false }, 10_000);
  check(
    'losing the face after completion does not revoke it',
    s.isComplete,
    `state ${s.challengeState}`
  );
  s = frame(t, {}, CHALLENGE_TIMEOUT_MS * 2);
  check('a completed challenge never reports a timeout', s.isComplete && !s.isTimedOut);
}
{
  // reset() must clear a completed challenge.
  const t = makeTracker('blink-first');
  const s0 = calibrate(t);
  completeChallenge(t, s0);
  t.reset();
  const s = frame(t, {}, 0);
  check(
    'reset() clears completion and progress',
    !s.isComplete && s.blinkCount === 0 && !s.hasTurnedHead && s.livenessScore === 0,
    `state ${s.challengeState}`
  );
}
{
  // Partial progress must never reach a passing score.
  const t = makeTracker('blink-first');
  calibrate(t);
  doBlink(t, 3);
  const s = doBlink(t, 3);
  check(
    'one satisfied action scores 50, not 100',
    s.livenessScore === 50 && !s.isComplete,
    `score ${s.livenessScore}, blinks ${s.blinkCount}`
  );
}

// ===========================================================================
// J. Robustness + real randomization
// ===========================================================================
section('J. Robustness and randomization');
{
  const t = makeTracker('blink-first');
  let threw = false;
  const nasty: Partial<LivenessSignals>[] = [
    { blinkLeft: NaN, blinkRight: NaN, yawDeg: NaN, faceScale: NaN, faceScalePx: NaN, confidence: NaN },
    { blinkLeft: -5, blinkRight: 12, yawDeg: 1e9, faceScale: -1, faceScalePx: -1, confidence: 5 },
    { ok: false, multipleFaces: true },
    { blinkLeft: 0, blinkRight: 0, yawDeg: 0, faceScale: 0, faceScalePx: 0, confidence: 0 },
  ];
  try {
    for (const n of nasty) for (let i = 0; i < 5; i++) frame(t, n);
  } catch (err) {
    threw = true;
    console.error('    threw:', err);
  }
  check('processFrame never throws on malformed signals', !threw);
  const s = frame(t, {}, 0);
  check(
    'malformed signals never produce progress',
    s.blinkCount === 0 && !s.hasTurnedHead && s.livenessScore === 0,
    `score ${s.livenessScore}`
  );
}
{
  unstubRandom();
  const orders = new Set<string>();
  let blinkCountsAlwaysTwo = true;
  for (let i = 0; i < 400; i++) {
    const t = new LivenessTracker();
    const s = t.processFrame(sig(), vnow);
    orders.add(s.sequence.join('>'));
    if (s.requiredBlinks !== REQUIRED_BLINKS) blinkCountsAlwaysTwo = false;
  }
  check(
    'action order is genuinely randomized across attempts',
    orders.size === 2,
    `${orders.size} distinct orders: ${[...orders].join(' | ')}`
  );
  check(
    'the required blink count is never randomized downward',
    blinkCountsAlwaysTwo,
    `always ${REQUIRED_BLINKS}`
  );
  check(
    'challengeDescription states the real requirement',
    new LivenessTracker().challengeDescription.includes(`${REQUIRED_BLINKS} times`),
    new LivenessTracker().challengeDescription
  );
}

// ===========================================================================
// Teardown + verdict
// ===========================================================================

if (randomStubbed) unstubRandom();

console.log(`\n${'='.repeat(60)}`);
console.log(`Liveness tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nFailing:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
}
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
