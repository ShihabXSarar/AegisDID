/**
 * REPRODUCTION + FIX VERIFICATION for the field failure seen on /claim: "Action 2: blink 1x (0/1)"
 * after 42.9 s of a user blinking normally, with telemetry "EAR 0.277 / yaw 1.67".
 *
 * ROOT CAUSE (confirmed by this script before the fix): the open-eye baseline was calibrated as the
 * MEAN OF THE TOP 3 of 12 EAR samples, which deliberately samples the upper tail of face-api.js
 * landmark jitter and so sat ~14% above the subject's true open-eye EAR. Recovery requires
 * avgEar > baseline * BLINK_RECOVER_FACTOR; at 0.88 that threshold landed at 0.2784 while the eye's
 * actual open value was 0.277. A closure could start but never complete, was disqualified after
 * BLINK_MAX_MS, and `awaitingReopen` then latched waiting on the SAME unreachable threshold — so
 * blink detection was dead for the remainder of the attempt.
 *
 * Pre-fix output (top-3 baseline 0.3163, recover 0.2784): 40 genuine blinks -> 0 counted, timed out.
 * This script now asserts the opposite. Run: node scripts/liveness_repro.mts     (from web/)
 */

let virtualNow = 1_700_000_000_000;
Date.now = () => virtualNow;

// Force sequence ['turn','blink'] with requiredBlinks = 1, matching the screenshot.
// reset() draws randomBelow(2) twice: first picks order (1 => ['turn','blink']), second the count
// (0 => requiredBlinks 1).
const queue: number[] = [1, 0];
Object.defineProperty(globalThis.crypto, 'getRandomValues', {
  value: (buf: Uint32Array) => {
    buf[0] = queue.length > 0 ? (queue.shift() as number) : 0;
    return buf;
  },
  configurable: true,
  writable: true,
});

const { LivenessTracker, BLINK_DIP_FACTOR, BLINK_RECOVER_FACTOR } = await import(
  '../lib/ml/liveness.ts'
);
type LandmarkPoint = { x: number; y: number };

const EYE_H = 30;
const FACE_W = 200;

function makeLandmarks(ear: number, yaw: number): LandmarkPoint[] {
  const pts: LandmarkPoint[] = Array.from({ length: 68 }, () => ({ x: 0, y: 0 }));
  const v = ear * EYE_H;
  pts[36] = { x: 0, y: 0 };
  pts[39] = { x: EYE_H, y: 0 };
  pts[37] = { x: 10, y: -v / 2 };
  pts[41] = { x: 10, y: v / 2 };
  pts[38] = { x: 20, y: -v / 2 };
  pts[40] = { x: 20, y: v / 2 };
  pts[45] = { x: 100, y: 0 };
  pts[42] = { x: 100 + EYE_H, y: 0 };
  pts[44] = { x: 110, y: -v / 2 };
  pts[46] = { x: 110, y: v / 2 };
  pts[43] = { x: 120, y: -v / 2 };
  pts[47] = { x: 120, y: v / 2 };
  pts[0] = { x: 0, y: 200 };
  pts[16] = { x: FACE_W, y: 200 };
  pts[30] = { x: (FACE_W * yaw) / (1 + yaw), y: 150 };
  return pts;
}

const t = new LivenessTracker();
function frame(ear: number, yaw: number, dt = 66) {
  virtualNow += dt;
  return t.processFrame(makeLandmarks(ear, yaw));
}

// The subject's true steady open-eye EAR, as displayed in the field telemetry.
const OPEN = 0.277;
// Landmark jitter during calibration. face-api.js EAR jitter of ~10% frame-to-frame is ordinary;
// taking the top 3 of 12 samples systematically lands in that upper tail.
const CALIB = [
  0.277, 0.305, 0.288, 0.316, 0.271, 0.298, 0.322, 0.284, 0.279, 0.311, 0.290, 0.276,
];

console.log('=== Field scenario: open EAR 0.277 with ~10% calibration jitter ===\n');

const top3 = [...CALIB].sort((a, b) => b - a).slice(0, 3);
const inflated = top3.reduce((s, v) => s + v, 0) / 3;
console.log(`steady open EAR                 = ${OPEN}`);
console.log(`OLD estimator (mean of top 3)   = ${inflated.toFixed(4)}`);
console.log(`  its recover threshold @0.88   = ${(inflated * 0.88).toFixed(4)}  <-- above 0.277: unreachable`);

// Calibrate at a centred pose with the jitter trace above.
let s = t.processFrame(makeLandmarks(CALIB[0], 1.0));
for (const e of CALIB.slice(1)) s = frame(e, 1.0);
s = frame(OPEN, 1.0);
console.log(`NEW estimator (median)          = ${s.earBaseline.toFixed(4)}`);
console.log(`  dip threshold     @${BLINK_DIP_FACTOR}      = ${s.earDipThreshold.toFixed(4)}`);
console.log(
  `  recover threshold @${BLINK_RECOVER_FACTOR}     = ${(s.earBaseline * BLINK_RECOVER_FACTOR).toFixed(4)}  <-- open 0.277 clears it by ${(
    (OPEN / (s.earBaseline * BLINK_RECOVER_FACTOR) - 1) * 100
  ).toFixed(1)}%\n`
);

// Action 1 is 'turn': away then back.
for (let i = 0; i < 6; i++) frame(OPEN, 1.6);
for (let i = 0; i < 6; i++) frame(OPEN, 1.0);
s = frame(OPEN, 1.0);
console.log(`after turn: hasTurnedHead=${s.hasTurnedHead}  stepIndex=${s.stepIndex}`);

// Now the subject blinks normally. Each blink: two closed frames (~132 ms closure, physiologically
// textbook) then open. Count how many attempts it takes to register the required blink.
let blinks = 0;
for (let i = 0; i < 40; i++) {
  frame(0.12, 1.0); // eyelid down
  frame(0.10, 1.0); // fully closed
  for (let k = 0; k < 8; k++) s = frame(OPEN, 1.0); // eyes open again, ~530 ms
  blinks++;
  if (s.blinkCount >= s.requiredBlinks) break;
}

console.log(`\ngenuine blinks fed:      ${blinks}`);
console.log(`blinkCount registered:   ${s.blinkCount} / ${s.requiredBlinks}`);
console.log(`closures observed:       ${s.blinkDipsSeen}`);
console.log(`elapsed:                 ${(s.elapsedMs / 1000).toFixed(1)} s`);
console.log(`isTimedOut:              ${s.isTimedOut}`);
console.log(`isComplete:              ${s.isComplete}`);
console.log(`prompt:                  "${s.currentPrompt}"`);

const fixed = s.isComplete && !s.isTimedOut && blinks === 1;
console.log(
  `\n${fixed ? 'FIXED' : 'STILL BROKEN'}: the first genuine blink ${
    fixed ? 'completed the challenge' : `did not register (took ${blinks} attempts)`
  }.`
);
process.exit(fixed ? 0 : 1);
