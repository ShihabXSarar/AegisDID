/**
 * AegisDID — Real-time Client-Side Liveness Challenge
 *
 * IMPORTANT: ZERO network requests. All facial landmark tracking runs client-side.
 *
 * The challenge is an *active* software liveness test built from face-api.js 68-point
 * landmarks. It requires, in a per-session randomized order:
 *
 *   - `requiredBlinks` complete blinks (EAR dip below baseline, then recovery, with the
 *     closure lasting a physiologically plausible 40-900 ms), and
 *   - one head yaw turn away from the calibrated frontal pose and back to it.
 *
 * SECURITY / HONESTY: this is software-only liveness. It defeats a held-up still photo
 * (no EAR dynamics, no yaw excursion) and defeats replay of one fixed recording (the
 * required action order and blink count are randomized per attempt, and the whole
 * challenge is time-boxed). It does NOT defeat an attacker who can synthesize or select
 * video on demand, nor one who can inject frames into getUserMedia. Defeating those
 * requires hardware attestation of the sensor, which this web prototype does not have.
 * See docs/THREAT_MODEL.md §2.1.
 */

export interface LandmarkPoint {
  x: number;
  y: number;
  z?: number;
}

export type LivenessAction = 'blink' | 'turn';

export interface LivenessState {
  hasBlinked: boolean;
  hasTurnedHead: boolean;
  isComplete: boolean;
  livenessScore: number;
  currentPrompt: string;
  earValue: number;
  yawRatio: number;
  /** ms since the first frame that contained a usable face. 0 before the clock starts. */
  elapsedMs: number;
  isTimedOut: boolean;
  calibrating: boolean;
  blinkCount: number;
  requiredBlinks: number;
  /** The randomized action order for this attempt. */
  sequence: LivenessAction[];
  /** Index into `sequence` of the action currently being asked for. */
  stepIndex: number;
  /**
   * Current adaptive open-eye EAR baseline, and the EAR the eye must fall below to start a
   * closure. Surfaced so the UI can show WHY a blink is not registering. The original failure
   * this diagnostic exists for was invisible: the prompt said "blink once" while the thresholds
   * that made blinking impossible were private state.
   */
  earBaseline: number;
  earDipThreshold: number;
  /** Closures observed, whether or not they were plausible enough to count as blinks. */
  blinkDipsSeen: number;
}

// ---------------------------------------------------------------------------
// Tunables (exported so unit tests reference the same numbers as the runtime)
// ---------------------------------------------------------------------------

/** Frames of a usable face required before the EAR/yaw baselines are trusted. */
export const CALIBRATION_FRAMES = 12;
/**
 * Whole challenge must finish within this window, measured from the first usable face.
 *
 * Was 20 s, which a first-time user cannot reliably meet: the window also covers calibration and
 * the subject has to read each prompt before acting. A real session was observed reaching 42.9 s.
 * The replay defence is the randomized action order and blink count (4 combinations), not the
 * tightness of this box, so widening it costs nothing that docs/THREAT_MODEL.md claims.
 */
export const CHALLENGE_TIMEOUT_MS = 40_000;
/** Losing the face for longer than this after the clock starts restarts the challenge. */
export const FACE_LOST_RESET_MS = 2_000;

/** EAR must fall below baseline * this to register the start of a closure. */
export const BLINK_DIP_FACTOR = 0.75;
/**
 * EAR must climb back above baseline * this for the closure to count as a blink.
 *
 * MUST stay comfortably below 1.0. This threshold is compared against the subject's OPEN-eye EAR,
 * so if it lands above that value the closure can never complete — the blink is disqualified after
 * BLINK_MAX_MS and `awaitingReopen` then waits on the same unreachable number, killing blink
 * detection for the rest of the attempt. That is not hypothetical: at 0.88 with the old
 * top-3-of-12 baseline estimator it was measured failing on a real subject whose steady open EAR
 * was 0.277 against a recover threshold of 0.2784 (scripts/liveness_repro.mts). 0.82 against a
 * median baseline leaves an ~18% margin.
 */
export const BLINK_RECOVER_FACTOR = 0.82;
/** A closure shorter than this is detector noise, longer than this is not a blink. */
export const BLINK_MIN_MS = 40;
export const BLINK_MAX_MS = 900;

/**
 * Rate at which the open-eye baseline tracks drift, per frame, once calibrated.
 *
 * A frozen baseline cannot survive the things that actually happen in a 40-second session:
 * the subject leans, the auto-exposure shifts, they squint while concentrating. If the steady open
 * EAR drifts below baseline * BLINK_RECOVER_FACTOR the blink detector dies exactly as described
 * above. Slow enough (2%/frame, gated to frontal open-eye frames) that it cannot be driven
 * anywhere within one blink.
 *
 * This does NOT weaken the still-photo defence: a photo presents a CONSTANT EAR, the baseline
 * converges onto that constant, and a constant signal never crosses baseline * BLINK_DIP_FACTOR.
 */
export const BASELINE_EMA_ALPHA = 0.02;

/**
 * A disqualified closure that never reopens is force-cleared after this long, re-seeding the
 * baseline from the current frame. Backstop so no input can leave the blink detector permanently
 * unable to count, whatever the baseline is.
 */
export const AWAITING_REOPEN_ESCAPE_MS = 1_200;

/** Yaw must reach baseline * this (or baseline / this) to count as turned away. */
export const TURN_AWAY_FACTOR = 1.28;
/** Yaw must come back inside baseline * [1/this, this] to count as returned to centre. */
export const TURN_RETURN_FACTOR = 1.2;

/** Baselines outside these ranges mean the landmarks are not trustworthy. */
const EAR_BASELINE_MIN = 0.10;
const EAR_BASELINE_MAX = 0.65;
const YAW_BASELINE_MIN = 0.40;
const YAW_BASELINE_MAX = 2.50;

// face-api.js 68-point indices.
// Left eye ring: 36 (outer), 37, 38, 39 (inner), 40, 41 — EAR = (|37-41| + |38-40|) / (2|36-39|)
const LEFT_EYE = [36, 37, 38, 39, 40, 41];
// Right eye ring, ordered to give the same EAR formula shape.
const RIGHT_EYE = [45, 44, 43, 42, 47, 46];

// Landmarks for head orientation. 30 is the nose tip (most sensitive to yaw);
// 0 and 16 are the outermost jaw points.
const NOSE_TIP = 30;
const LEFT_FACE_EDGE = 0;
const RIGHT_FACE_EDGE = 16;

function distance(p1: LandmarkPoint, p2: LandmarkPoint): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Median of a non-empty sample array. Even counts average the two middle values. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Compute Eye Aspect Ratio (EAR) for one eye. Returns 0 when the landmarks are unusable
 * so callers can distinguish "no signal" from "eye open".
 */
export function calculateEyeAspectRatio(landmarks: LandmarkPoint[], eyeIndices: number[]): number {
  const [p1, p2, p3, p4, p5, p6] = eyeIndices.map((idx) => landmarks[idx]);
  if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) return 0;

  const vertical1 = distance(p2, p6);
  const vertical2 = distance(p3, p5);
  const horizontal = distance(p1, p4);

  if (horizontal === 0) return 0;
  return (vertical1 + vertical2) / (2.0 * horizontal);
}

/**
 * Head yaw proxy: horizontal distance from the nose tip to each outer jaw point.
 * 1.0 is a centred frontal pose; turning the head drives it away from 1.0.
 * X-axis only, so head roll and pitch do not contaminate the signal.
 */
export function calculateHeadYawRatio(landmarks: LandmarkPoint[]): number {
  const nose = landmarks[NOSE_TIP];
  const left = landmarks[LEFT_FACE_EDGE];
  const right = landmarks[RIGHT_FACE_EDGE];

  if (!nose || !left || !right) return 1.0;

  const dxLeft = Math.abs(nose.x - left.x);
  const dxRight = Math.abs(right.x - nose.x);

  if (dxRight === 0) return 1.0;
  return dxLeft / dxRight;
}

/** Uniform integer in [0, n) from the CSPRNG when available. */
function randomBelow(n: number): number {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    // Rejection-free enough for n <= 4: bias is ~2^-30.
    globalThis.crypto.getRandomValues(buf);
    return buf[0] % n;
  }
  return Math.floor(Math.random() * n);
}

/**
 * Liveness tracker for the active anti-spoofing challenge.
 *
 * `processFrame` is safe to call at any rate with any landmark array; it never throws.
 * Callers must gate progress on the returned `isComplete`, which is only ever true when
 * every action in the randomized sequence was performed inside the time box.
 */
export class LivenessTracker {
  // Challenge definition — re-randomized on every reset().
  private sequence: LivenessAction[] = ['blink', 'turn'];
  private requiredBlinks = 1;

  // Progress
  private stepIndex = 0;
  private blinkCount = 0;
  private turnedAway = false;
  private turnReturned = false;
  private completedAt: number | null = null;

  // Clock — null until the first frame containing a usable face.
  private startedAt: number | null = null;
  private lastFaceAt = 0;

  // Calibration
  private earSamples: number[] = [];
  private yawSamples: number[] = [];
  private baselineEar = 0;
  private baselineYaw = 1;
  private calibrated = false;

  // Blink state machine
  private dipStartedAt: number | null = null;
  /**
   * True while a closure has been disqualified (too long) but the eye has not yet
   * reopened. Without this, `dipStartedAt = null` means both "eye is open" and
   * "closure disqualified", so the machine re-arms on the very next still-closed
   * frame: the closure clock restarts mid-closure and an occlusion of ANY length
   * ends in a textbook-duration "blink". A held-up photo plus a hand passing the
   * lens would satisfy the blink requirement with no eyelid dynamics at all.
   */
  private awaitingReopen = false;
  /** When `awaitingReopen` latched, for the AWAITING_REOPEN_ESCAPE_MS backstop. */
  private awaitingReopenSince = 0;
  private blinkDipsSeen = 0;
  /**
   * Duration of the most recent closure that was seen but NOT credited, so the prompt can say
   * which way to adjust. Without this the user sees a counter that will not move and no reason:
   * a closure too fast for the detector's sample rate and one held too long to be a blink look
   * identical from the outside.
   */
  private lastRejectedClosureMs: number | null = null;

  /** Kept for backwards compatibility with existing callers; true once the clock starts. */
  public hasStarted = false;

  constructor() {
    this.reset();
  }

  /** Human-readable description of the randomized challenge, for the UI. */
  public get challengeDescription(): string {
    return this.sequence
      .map((a) =>
        a === 'blink'
          ? this.requiredBlinks === 1
            ? 'blink once'
            : `blink ${this.requiredBlinks} times`
          : 'turn your head and face forward again'
      )
      .join(', then ');
  }

  public reset() {
    // Randomize the action order and the blink count so a single pre-recorded clip
    // cannot satisfy every attempt.
    this.sequence = randomBelow(2) === 0 ? ['blink', 'turn'] : ['turn', 'blink'];
    this.requiredBlinks = 1 + randomBelow(2); // 1 or 2

    this.stepIndex = 0;
    this.blinkCount = 0;
    this.turnedAway = false;
    this.turnReturned = false;
    this.completedAt = null;

    this.startedAt = null;
    this.lastFaceAt = 0;
    this.hasStarted = false;

    this.earSamples = [];
    this.yawSamples = [];
    this.baselineEar = 0;
    this.baselineYaw = 1;
    this.calibrated = false;

    this.dipStartedAt = null;
    this.awaitingReopen = false;
    this.awaitingReopenSince = 0;
    this.blinkDipsSeen = 0;
    this.lastRejectedClosureMs = null;
  }

  /** Wipe progress but keep the same randomized challenge and restart the clock. */
  private restartProgress(now: number) {
    this.stepIndex = 0;
    this.blinkCount = 0;
    this.turnedAway = false;
    this.turnReturned = false;
    this.completedAt = null;
    this.dipStartedAt = null;
    this.awaitingReopen = false;
    this.awaitingReopenSince = 0;
    this.blinkDipsSeen = 0;
    this.lastRejectedClosureMs = null;
    this.earSamples = [];
    this.yawSamples = [];
    this.calibrated = false;
    this.startedAt = now;
  }

  private snapshot(overrides: Partial<LivenessState>): LivenessState {
    const now = Date.now();
    const elapsedMs = this.startedAt === null ? 0 : now - this.startedAt;
    const blinkDone = this.blinkCount >= this.requiredBlinks;
    const turnDone = this.turnedAway && this.turnReturned;
    let score = 0;
    if (blinkDone) score += 50;
    if (turnDone) score += 50;

    return {
      hasBlinked: blinkDone,
      hasTurnedHead: turnDone,
      isComplete: this.completedAt !== null,
      livenessScore: score,
      currentPrompt: '',
      earValue: 0,
      yawRatio: 1,
      elapsedMs,
      isTimedOut: false,
      calibrating: !this.calibrated,
      blinkCount: this.blinkCount,
      requiredBlinks: this.requiredBlinks,
      sequence: [...this.sequence],
      stepIndex: this.stepIndex,
      earBaseline: this.baselineEar,
      earDipThreshold: this.baselineEar * BLINK_DIP_FACTOR,
      blinkDipsSeen: this.blinkDipsSeen,
      ...overrides,
    };
  }

  public processFrame(landmarks: LandmarkPoint[]): LivenessState {
    const now = Date.now();

    // ---- No usable face -------------------------------------------------
    if (!landmarks || landmarks.length < 68) {
      if (
        this.startedAt !== null &&
        this.completedAt === null &&
        this.lastFaceAt > 0 &&
        now - this.lastFaceAt > FACE_LOST_RESET_MS
      ) {
        // Face left the frame mid-challenge. Restart so a subject cannot be swapped
        // half way through the sequence.
        this.restartProgress(now);
        this.lastFaceAt = 0;
        return this.snapshot({
          currentPrompt: 'Face lost — challenge restarted. Look at the camera.',
        });
      }
      return this.snapshot({
        currentPrompt: 'Position your face inside the guide',
      });
    }

    // ---- Clock starts on the first usable face --------------------------
    if (this.startedAt === null) {
      this.startedAt = now;
      this.hasStarted = true;
    }
    this.lastFaceAt = now;

    const elapsedMs = now - this.startedAt;
    const timedOut = this.completedAt === null && elapsedMs > CHALLENGE_TIMEOUT_MS;

    const leftEar = calculateEyeAspectRatio(landmarks, LEFT_EYE);
    const rightEar = calculateEyeAspectRatio(landmarks, RIGHT_EYE);
    const avgEar = (leftEar + rightEar) / 2.0;
    const yaw = calculateHeadYawRatio(landmarks);

    // Already finished: latch the result so a later frame cannot un-complete it.
    if (this.completedAt !== null) {
      return this.snapshot({
        currentPrompt: 'Liveness challenge verified',
        earValue: avgEar,
        yawRatio: yaw,
      });
    }

    if (timedOut) {
      return this.snapshot({
        currentPrompt: 'Challenge timed out. Press restart and try again.',
        earValue: avgEar,
        yawRatio: yaw,
        isTimedOut: true,
      });
    }

    // ---- Calibration ----------------------------------------------------
    if (!this.calibrated) {
      if (avgEar > 0) this.earSamples.push(avgEar);
      this.yawSamples.push(yaw);

      if (this.earSamples.length >= CALIBRATION_FRAMES && this.yawSamples.length >= CALIBRATION_FRAMES) {
        // MEDIAN EAR, not the mean of the top 3.
        //
        // The top-3 estimator was chosen to be robust to a blink during calibration, and it is —
        // but it is systematically biased HIGH, because it deliberately samples the upper tail of
        // face-api.js landmark jitter (~10% frame to frame). The resulting baseline sat ~14% above
        // the subject's real open-eye EAR, which pushed baseline * BLINK_RECOVER_FACTOR ABOVE the
        // EAR that open eyes actually produce and made blinking undetectable. Measured on a real
        // session: open EAR 0.277 vs a recover threshold of 0.2784 (scripts/liveness_repro.mts).
        //
        // The median is robust to a calibration blink for a better reason: a blink is a ~5% duty
        // cycle event, so closed frames can never be half of the window. It is simultaneously
        // robust to the jitter peaks the top-3 estimator was actively selecting for.
        const ear = median(this.earSamples);
        const medianYaw = median(this.yawSamples);

        if (ear < EAR_BASELINE_MIN || ear > EAR_BASELINE_MAX) {
          // Implausible eye geometry: keep sampling rather than trusting it.
          this.earSamples = [];
          this.yawSamples = [];
          return this.snapshot({
            currentPrompt: 'Hold still, calibrating...',
            earValue: avgEar,
            yawRatio: yaw,
          });
        }

        this.baselineEar = ear;
        this.baselineYaw =
          medianYaw >= YAW_BASELINE_MIN && medianYaw <= YAW_BASELINE_MAX ? medianYaw : 1.0;
        this.calibrated = true;
      } else {
        return this.snapshot({
          currentPrompt: 'Hold still, calibrating...',
          earValue: avgEar,
          yawRatio: yaw,
        });
      }
    }

    // ---- Run only the currently requested action ------------------------
    const activeAction = this.sequence[this.stepIndex];

    if (activeAction === 'blink') {
      const dipThreshold = this.baselineEar * BLINK_DIP_FACTOR;
      const recoverThreshold = this.baselineEar * BLINK_RECOVER_FACTOR;

      if (this.dipStartedAt === null) {
        if (this.awaitingReopen) {
          // A disqualified closure is still in progress. Do NOT start timing a new
          // closure until the eye has genuinely reopened past the recover threshold.
          if (avgEar > recoverThreshold) {
            this.awaitingReopen = false;
          } else if (
            avgEar >= dipThreshold &&
            avgEar >= EAR_BASELINE_MIN &&
            avgEar <= EAR_BASELINE_MAX &&
            now - this.awaitingReopenSince > AWAITING_REOPEN_ESCAPE_MS
          ) {
            // BACKSTOP for a miscalibrated baseline, NOT an escape from occlusion.
            //
            // `awaitingReopen` waits on the same threshold the closure failed to reach, so if that
            // threshold is unreachable the latch never clears and blink detection is dead for the
            // rest of the attempt — the observed field failure. The two situations are
            // distinguishable: EAR parked in the hysteresis dead band (>= dipThreshold, so NOT a
            // closed eye, yet <= recoverThreshold) for over a second means the baseline no longer
            // describes this subject. EAR still below dipThreshold means the eye really is shut,
            // and the latch MUST hold — clearing it there would re-arm the closure clock
            // mid-occlusion and turn any occlusion into a textbook-duration "blink", which is the
            // attack the latch exists to stop (scripts/liveness_test.mts §5).
            this.awaitingReopen = false;
            this.baselineEar = avgEar;
          }
        } else if (avgEar > 0 && avgEar < dipThreshold) {
          this.dipStartedAt = now;
          this.blinkDipsSeen++;
        }
      } else {
        const closedMs = now - this.dipStartedAt;
        if (avgEar > recoverThreshold) {
          if (closedMs >= BLINK_MIN_MS && closedMs <= BLINK_MAX_MS) {
            this.blinkCount++;
            this.lastRejectedClosureMs = null;
          } else {
            this.lastRejectedClosureMs = closedMs;
          }
          // Either counted or rejected as implausible. The eye is demonstrably open
          // again, so the machine can re-arm immediately.
          this.dipStartedAt = null;
        } else if (closedMs > BLINK_MAX_MS) {
          // Sustained closure (or occlusion) is not a blink. Latch until reopening.
          this.dipStartedAt = null;
          this.awaitingReopen = true;
          this.awaitingReopenSince = now;
          this.lastRejectedClosureMs = closedMs;
        }
      }

      if (this.blinkCount >= this.requiredBlinks) {
        this.stepIndex++;
      }
    } else if (activeAction === 'turn') {
      const awayHigh = this.baselineYaw * TURN_AWAY_FACTOR;
      const awayLow = this.baselineYaw / TURN_AWAY_FACTOR;
      const returnHigh = this.baselineYaw * TURN_RETURN_FACTOR;
      const returnLow = this.baselineYaw / TURN_RETURN_FACTOR;

      if (!this.turnedAway) {
        if (yaw >= awayHigh || yaw <= awayLow) this.turnedAway = true;
      } else if (!this.turnReturned) {
        if (yaw <= returnHigh && yaw >= returnLow) this.turnReturned = true;
      }

      if (this.turnedAway && this.turnReturned) {
        this.stepIndex++;
      }
    }

    // ---- Track drift in the open-eye baseline ---------------------------
    // Gated so only demonstrably-open, demonstrably-frontal frames contribute:
    //   - no closure in progress (this frame did not cross the dip threshold),
    //   - EAR above the dip threshold, so a blink during the 'turn' step cannot drag it down,
    //   - head near the calibrated frontal pose, because yaw foreshortens the eye's horizontal
    //     span and therefore INFLATES EAR — adapting during a turn would raise the baseline and
    //     re-create the unreachable-recovery bug at the moment the blink step begins.
    const frontal =
      yaw <= this.baselineYaw * TURN_RETURN_FACTOR && yaw >= this.baselineYaw / TURN_RETURN_FACTOR;
    if (
      this.dipStartedAt === null &&
      !this.awaitingReopen &&
      frontal &&
      avgEar >= this.baselineEar * BLINK_DIP_FACTOR &&
      avgEar >= EAR_BASELINE_MIN &&
      avgEar <= EAR_BASELINE_MAX
    ) {
      this.baselineEar =
        this.baselineEar * (1 - BASELINE_EMA_ALPHA) + avgEar * BASELINE_EMA_ALPHA;
    }

    if (this.stepIndex >= this.sequence.length) {
      this.completedAt = now;
      return this.snapshot({
        currentPrompt: 'Liveness challenge verified',
        earValue: avgEar,
        yawRatio: yaw,
      });
    }

    // ---- Prompt for the current step ------------------------------------
    const step = this.sequence[this.stepIndex];
    const stepLabel = `Action ${this.stepIndex + 1}/${this.sequence.length}`;
    let prompt: string;
    if (step === 'blink') {
      const remaining = this.requiredBlinks - this.blinkCount;
      const base =
        this.requiredBlinks === 1
          ? `${stepLabel}: blink once`
          : `${stepLabel}: blink ${remaining} more time${remaining === 1 ? '' : 's'}`;
      // A closure was seen and thrown away. Say which way to adjust rather than leaving a
      // counter that silently refuses to move.
      let hint = '';
      if (this.lastRejectedClosureMs !== null) {
        hint =
          this.lastRejectedClosureMs > BLINK_MAX_MS
            ? ' — that was held too long for a blink; blink quickly'
            : ' — hold your eyes shut a moment longer';
      }
      prompt = base + hint;
    } else {
      // Say what to do, not what is being measured. "turn your head slowly to one side" left a
      // real user unsure how far, in which direction, and whether it had registered.
      prompt = this.turnedAway
        ? `${stepLabel}: now turn back and face the camera`
        : `${stepLabel}: turn your head left or right, then back`;
    }

    return this.snapshot({
      currentPrompt: prompt,
      earValue: avgEar,
      yawRatio: yaw,
    });
  }
}
