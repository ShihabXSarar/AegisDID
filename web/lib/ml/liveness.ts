/**
 * AegisDID — Real-time Client-Side Liveness Challenge (v3, MediaPipe-driven)
 *
 * IMPORTANT: ZERO network requests. All facial analysis runs client-side.
 *
 * This module is deliberately PURE: it consumes already-extracted per-frame signals
 * (`LivenessSignals`) and contains no reference to MediaPipe, face-api, the DOM or any
 * timer. Signal extraction lives in `lib/ml/mediapipeLiveness.ts`. The split exists so the
 * whole challenge state machine is deterministically testable from Node without a camera —
 * see `scripts/liveness_test.mts`.
 *
 * WHY THIS REPLACED THE EAR IMPLEMENTATION
 * ----------------------------------------
 * v2 derived blink from the Eye Aspect Ratio of face-api.js's 68-point landmarks, compared
 * against a rolling baseline (`ear < baseline * 0.75`). Field testing showed three failures:
 *
 *   1. Real blinks were missed. face-api's eyelid landmarks are regressed from a 224px crop
 *      and barely track a fast eyelid, so EAR often dropped far less than 25%.
 *   2. Moving the camera AWAY produced a phantom blink. EAR is only scale-invariant in
 *      theory; as the face shrinks, landmark quantisation error grows relative to the eye,
 *      collapsing EAR while the slow baseline EMA stayed high — a textbook dip+recovery.
 *   3. The baseline EMA admitted partial closures, so each near-miss blink dragged the
 *      baseline down, lowering the dip threshold further from the blink minimum and making
 *      detection progressively worse the more the user tried.
 *
 * The fix is not a new threshold — it is a different signal. MediaPipe Face Landmarker emits
 * `eyeBlinkLeft` / `eyeBlinkRight` blendshape coefficients: a semantic, already-normalised
 * 0..1 estimate of eyelid closure, trained end-to-end. It does not depend on face scale, so
 * failure mode (2) is structurally impossible, and it needs no adaptive baseline, so failure
 * mode (3) cannot exist. Absolute thresholds with hysteresis replace relative ones.
 */

/** Which physical actions the challenge can ask for. */
export type LivenessAction = 'blink' | 'turn';

/** Explicit blink sub-state. A blink is only credited on a complete CLOSED -> open edge. */
export type BlinkPhase =
  | 'open'
  | 'closing'
  | 'closed'
  /** Closure exceeded BLINK_MAX_MS (eyes held shut, or occlusion). Must fully reopen, uncounted. */
  | 'locked'
  /** Head pose left the range where blink confidence is trustworthy. Frozen, uncounted. */
  | 'suspended';

/** Explicit top-level challenge state. */
export type ChallengeState =
  | 'idle'
  | 'calibrating'
  | 'awaiting-blink'
  | 'awaiting-turn'
  | 'awaiting-return'
  | 'complete'
  | 'timeout';

export type FaceQuality =
  | 'good'
  | 'no-face'
  | 'multiple-faces'
  | 'too-small'
  | 'low-confidence'
  | 'unstable'
  | 'pose-extreme'
  | 'unknown';

/**
 * Per-frame signals extracted from MediaPipe Face Landmarker.
 *
 * `blinkLeft` / `blinkRight` are the raw blendshape coefficients in [0,1] (1 = fully closed).
 * `yawDeg` is a signed head-yaw estimate in degrees, 0 = facing the camera. `faceScale` is the
 * interocular distance normalised by frame width (scale-invariant), `faceScalePx` the same in
 * pixels. `ok: false` means this frame yielded nothing usable and must not advance anything.
 */
export interface LivenessSignals {
  ok: boolean;
  blinkLeft: number;
  blinkRight: number;
  yawDeg: number;
  faceScale: number;
  faceScalePx: number;
  confidence: number;
  /** Set when >1 face is in frame: an ambiguous frame must never advance the challenge. */
  multipleFaces?: boolean;
}

export interface LivenessState {
  // --- progress ---
  hasBlinked: boolean;
  hasTurnedHead: boolean;
  isComplete: boolean;
  livenessScore: number;
  currentPrompt: string;
  elapsedMs: number;
  isTimedOut: boolean;
  calibrating: boolean;
  blinkCount: number;
  requiredBlinks: number;
  sequence: LivenessAction[];
  stepIndex: number;
  challengeState: ChallengeState;

  // --- development telemetry (never includes pixels, embeddings or secrets) ---
  blinkScore: number;
  smoothedBlinkScore: number;
  blinkPhase: BlinkPhase;
  /** Closure events observed, including ones rejected for being too short/long. */
  closuresSeen: number;
  yawDeg: number;
  smoothedYawDeg: number;
  yawBaselineDeg: number;
  faceScale: number;
  faceScalePx: number;
  confidence: number;
  faceQuality: FaceQuality;
  qualityMessage: string;
}

// ---------------------------------------------------------------------------
// Tunables. Blink thresholds are ABSOLUTE blendshape coefficients, not ratios
// against a moving baseline — that is the core of the v3 fix.
// ---------------------------------------------------------------------------

export const REQUIRED_BLINKS = 2;
export const CALIBRATION_FRAMES = 12;
export const CHALLENGE_TIMEOUT_MS = 45_000;
export const FACE_LOST_RESET_MS = 2_500;

/** Enter closure above this; leave only below BLINK_CLOSE_EXIT (hysteresis band). */
export const BLINK_CLOSE_ENTER = 0.5;
export const BLINK_CLOSE_EXIT = 0.32;
/** Both eyes must reach this during a closure — rejects one-sided landmark noise. */
export const BLINK_BILATERAL_MIN = 0.3;
/** Eyes must look genuinely open before a challenge starts, and to leave `locked`. */
export const BLINK_OPEN_MAX = 0.25;
/**
 * Physiological closure window. 80 ms is the floor because at 30 fps a SINGLE anomalous frame
 * spans ~66 ms; requiring 80 ms plus BLINK_MIN_CLOSED_FRAMES means one bad frame can never be
 * credited as a blink regardless of how high its coefficient spikes.
 */
export const BLINK_MIN_MS = 80;
export const BLINK_MAX_MS = 700;
/** Frames that must actually read above BLINK_CLOSE_ENTER inside one closure. */
export const BLINK_MIN_CLOSED_FRAMES = 2;
export const BLINK_SMOOTH_ALPHA = 0.55;

/** Beyond this yaw deviation, blendshape blink confidence is not trustworthy. */
export const BLINK_POSE_LIMIT_DEG = 22;

export const TURN_DEV_DEG = 18;
export const TURN_RETURN_DEG = 8;
/** A turn (and a return) must persist this long — one noisy frame must never complete it. */
export const TURN_DWELL_MS = 180;
export const YAW_SMOOTH_ALPHA = 0.35;

export const MIN_FACE_SCALE = 0.055;
export const MIN_FACE_PX = 24;
export const MIN_CONFIDENCE = 0.5;
/** Relative interocular change that marks the frame unstable (fast distance change). */
export const SCALE_STABLE_TOL = 0.35;
export const SCALE_EMA_ALPHA = 0.05;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function randomBelow(n: number): number {
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return buf[0] % n;
  }
  return Math.floor(Math.random() * n);
}

export class LivenessTracker {
  private sequence: LivenessAction[] = ['blink', 'turn'];
  private readonly requiredBlinks = REQUIRED_BLINKS;
  private stepIndex = 0;
  private blinkCount = 0;
  private closuresSeen = 0;

  private turnedAway = false;
  private turnReturned = false;
  private turnCandidateSince: number | null = null;
  private returnCandidateSince: number | null = null;

  private startedAt: number | null = null;
  private completedAt: number | null = null;
  private lastFaceAt = 0;

  // calibration
  private calibrated = false;
  private blinkSamples: number[] = [];
  private yawSamples: number[] = [];
  private scaleSamples: number[] = [];
  private baselineYawDeg = 0;
  private baselineScale = 0;

  // blink FSM
  private blinkPhase: BlinkPhase = 'open';
  private smoothedBlink = 0;
  private smoothedBlinkInit = false;
  private closureStartedAt: number | null = null;
  private closurePeakBilateral = 0;
  /** Frames inside the current closure whose raw coefficient cleared BLINK_CLOSE_ENTER. */
  private closureFramesAbove = 0;
  private lastRejectedClosureMs: number | null = null;

  // pose
  private smoothedYawDeg = 0;
  private smoothedYawInit = false;

  // quality
  private faceQuality: FaceQuality = 'unknown';
  private qualityMessage = '';

  public hasStarted = false;

  constructor() {
    this.reset();
  }

  public get challengeDescription(): string {
    return this.sequence
      .map((a) =>
        a === 'blink'
          ? `blink ${this.requiredBlinks} times`
          : 'turn your head left or right, then face forward again'
      )
      .join(', then ');
  }

  public reset() {
    // Randomised action ORDER is preserved as an anti-scripting measure. The blink count is
    // fixed at REQUIRED_BLINKS so the requirement cannot be randomised downward.
    this.sequence = randomBelow(2) === 0 ? ['blink', 'turn'] : ['turn', 'blink'];
    this.stepIndex = 0;
    this.blinkCount = 0;
    this.closuresSeen = 0;
    this.turnedAway = false;
    this.turnReturned = false;
    this.turnCandidateSince = null;
    this.returnCandidateSince = null;
    this.startedAt = null;
    this.completedAt = null;
    this.lastFaceAt = 0;
    this.hasStarted = false;
    this.calibrated = false;
    this.blinkSamples = [];
    this.yawSamples = [];
    this.scaleSamples = [];
    this.baselineYawDeg = 0;
    this.baselineScale = 0;
    this.blinkPhase = 'open';
    this.smoothedBlink = 0;
    this.smoothedBlinkInit = false;
    this.closureStartedAt = null;
    this.closurePeakBilateral = 0;
    this.closureFramesAbove = 0;
    this.lastRejectedClosureMs = null;
    this.smoothedYawDeg = 0;
    this.smoothedYawInit = false;
    this.faceQuality = 'unknown';
    this.qualityMessage = '';
  }

  /** Wipe progress but keep the (already randomised) challenge, e.g. after losing the face. */
  private restartProgress(now: number) {
    this.stepIndex = 0;
    this.blinkCount = 0;
    this.closuresSeen = 0;
    this.turnedAway = false;
    this.turnReturned = false;
    this.turnCandidateSince = null;
    this.returnCandidateSince = null;
    this.completedAt = null;
    this.calibrated = false;
    this.blinkSamples = [];
    this.yawSamples = [];
    this.scaleSamples = [];
    this.blinkPhase = 'open';
    this.smoothedBlinkInit = false;
    this.closureStartedAt = null;
    this.closurePeakBilateral = 0;
    this.closureFramesAbove = 0;
    this.lastRejectedClosureMs = null;
    this.smoothedYawInit = false;
    this.startedAt = now;
  }

  private snapshot(overrides: Partial<LivenessState>): LivenessState {
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
      elapsedMs: 0,
      isTimedOut: false,
      calibrating: !this.calibrated,
      blinkCount: this.blinkCount,
      requiredBlinks: this.requiredBlinks,
      sequence: [...this.sequence],
      stepIndex: this.stepIndex,
      challengeState: 'idle',
      blinkScore: 0,
      smoothedBlinkScore: this.smoothedBlink,
      blinkPhase: this.blinkPhase,
      closuresSeen: this.closuresSeen,
      yawDeg: 0,
      smoothedYawDeg: this.smoothedYawDeg,
      yawBaselineDeg: this.baselineYawDeg,
      faceScale: 0,
      faceScalePx: 0,
      confidence: 0,
      faceQuality: this.faceQuality,
      qualityMessage: this.qualityMessage,
      ...overrides,
    };
  }

  /**
   * Classify frame usability. Returns null when the frame is good enough to drive the
   * challenge; otherwise the quality verdict and a user-facing instruction.
   */
  private assessQuality(s: LivenessSignals): { quality: FaceQuality; message: string } | null {
    if (s.multipleFaces) {
      return { quality: 'multiple-faces', message: 'Only one person may be in frame' };
    }
    if (!s.ok) {
      return { quality: 'no-face', message: 'Position your face inside the guide' };
    }
    // Fail closed on non-finite signals. Without this a NaN slips through every numeric gate
    // below (NaN < x and NaN > x are both false) and would be treated as a usable frame.
    if (
      !Number.isFinite(s.blinkLeft) ||
      !Number.isFinite(s.blinkRight) ||
      !Number.isFinite(s.yawDeg) ||
      !Number.isFinite(s.faceScale) ||
      !Number.isFinite(s.faceScalePx) ||
      !Number.isFinite(s.confidence)
    ) {
      return { quality: 'unknown', message: 'Face tracking unstable — hold still' };
    }
    if (s.confidence < MIN_CONFIDENCE) {
      return { quality: 'low-confidence', message: 'Face the camera' };
    }
    if (s.faceScale < MIN_FACE_SCALE || s.faceScalePx < MIN_FACE_PX) {
      return { quality: 'too-small', message: 'Move slightly closer' };
    }
    // Fast distance change: the frame is real but geometry is in flux, so do not let it
    // advance any action. This is belt-and-braces — blendshapes are already scale-invariant.
    if (
      this.calibrated &&
      this.baselineScale > 0 &&
      Math.abs(s.faceScale - this.baselineScale) / this.baselineScale > SCALE_STABLE_TOL
    ) {
      return { quality: 'unstable', message: 'Hold still' };
    }
    return null;
  }

  public processFrame(signals: LivenessSignals, now: number = Date.now()): LivenessState {
    const quality = this.assessQuality(signals);

    // ---- unusable frame -------------------------------------------------
    if (quality) {
      this.faceQuality = quality.quality;
      this.qualityMessage = quality.message;

      const lostTooLong =
        this.startedAt !== null &&
        this.completedAt === null &&
        this.lastFaceAt > 0 &&
        now - this.lastFaceAt > FACE_LOST_RESET_MS;

      // A frame we cannot trust must not leave the blink FSM mid-closure, or the closure
      // would later be completed by an unrelated reopen.
      if (this.blinkPhase === 'closing' || this.blinkPhase === 'closed') {
        this.blinkPhase = 'locked';
        this.closureStartedAt = null;
        this.closurePeakBilateral = 0;
        this.closureFramesAbove = 0;
      }
      this.turnCandidateSince = null;
      this.returnCandidateSince = null;

      if (lostTooLong) {
        this.restartProgress(now);
        this.lastFaceAt = 0;
        return this.snapshot({
          currentPrompt: 'Face lost — challenge restarted. Look at the camera.',
          challengeState: 'calibrating',
          elapsedMs: 0,
        });
      }

      return this.snapshot({
        currentPrompt: quality.message,
        challengeState: this.calibrated ? this.currentChallengeState() : 'calibrating',
        elapsedMs: this.startedAt === null ? 0 : now - this.startedAt,
      });
    }

    this.faceQuality = 'good';
    this.qualityMessage = '';

    if (this.startedAt === null) {
      this.startedAt = now;
      this.hasStarted = true;
    }
    this.lastFaceAt = now;

    const rawBlink = (signals.blinkLeft + signals.blinkRight) / 2;
    const bilateral = Math.min(signals.blinkLeft, signals.blinkRight);

    // Short EMA: kills single-frame spikes without lagging a ~150ms blink.
    if (!this.smoothedBlinkInit) {
      this.smoothedBlink = rawBlink;
      this.smoothedBlinkInit = true;
    } else {
      this.smoothedBlink =
        this.smoothedBlink * (1 - BLINK_SMOOTH_ALPHA) + rawBlink * BLINK_SMOOTH_ALPHA;
    }

    if (!this.smoothedYawInit) {
      this.smoothedYawDeg = signals.yawDeg;
      this.smoothedYawInit = true;
    } else {
      this.smoothedYawDeg =
        this.smoothedYawDeg * (1 - YAW_SMOOTH_ALPHA) + signals.yawDeg * YAW_SMOOTH_ALPHA;
    }

    const elapsedMs = now - this.startedAt;

    const telemetry = {
      blinkScore: rawBlink,
      smoothedBlinkScore: this.smoothedBlink,
      yawDeg: signals.yawDeg,
      smoothedYawDeg: this.smoothedYawDeg,
      faceScale: signals.faceScale,
      faceScalePx: signals.faceScalePx,
      confidence: signals.confidence,
      elapsedMs,
    };

    if (this.completedAt !== null) {
      return this.snapshot({
        ...telemetry,
        currentPrompt: 'Liveness challenge verified',
        challengeState: 'complete',
      });
    }

    if (elapsedMs > CHALLENGE_TIMEOUT_MS) {
      return this.snapshot({
        ...telemetry,
        currentPrompt: 'Challenge timed out. Press restart and try again.',
        challengeState: 'timeout',
        isTimedOut: true,
      });
    }

    // ---- calibration ----------------------------------------------------
    if (!this.calibrated) {
      // Require the eyes to START open, so a user who begins mid-blink cannot have the
      // closed state adopted as normal.
      if (rawBlink > BLINK_OPEN_MAX) {
        this.blinkSamples = [];
        this.yawSamples = [];
        this.scaleSamples = [];
        return this.snapshot({
          ...telemetry,
          currentPrompt: 'Hold still with your eyes open, calibrating...',
          challengeState: 'calibrating',
        });
      }

      this.blinkSamples.push(rawBlink);
      this.yawSamples.push(signals.yawDeg);
      this.scaleSamples.push(signals.faceScale);

      if (this.blinkSamples.length < CALIBRATION_FRAMES) {
        return this.snapshot({
          ...telemetry,
          currentPrompt: 'Hold still, calibrating...',
          challengeState: 'calibrating',
        });
      }

      this.baselineYawDeg = median(this.yawSamples);
      this.baselineScale = median(this.scaleSamples);
      this.smoothedYawDeg = this.baselineYawDeg;
      this.calibrated = true;
      this.blinkPhase = 'open';
    }

    // Track slow, legitimate distance drift so the stability gate does not latch.
    this.baselineScale =
      this.baselineScale * (1 - SCALE_EMA_ALPHA) + signals.faceScale * SCALE_EMA_ALPHA;

    const yawDev = this.smoothedYawDeg - this.baselineYawDeg;
    const poseReliableForBlink = Math.abs(yawDev) <= BLINK_POSE_LIMIT_DEG;

    // Randomised order is only an anti-scripting measure if it is BINDING: exactly one action
    // is live at a time, so a pre-recorded "blink twice then turn" clip cannot satisfy both
    // orders. Inactive actions still run their FSM for telemetry but cannot score.
    const active = this.sequence[this.stepIndex];

    this.updateBlinkFsm(rawBlink, bilateral, poseReliableForBlink, now, active === 'blink');

    if (active === 'turn') {
      this.updateTurnFsm(yawDev, now);
    } else {
      this.turnCandidateSince = null;
      this.returnCandidateSince = null;
    }

    // Advance the sequence when the active action is satisfied.
    if (active === 'blink' && this.blinkCount >= this.requiredBlinks) {
      this.stepIndex++;
    } else if (active === 'turn' && this.turnedAway && this.turnReturned) {
      this.stepIndex++;
    }

    if (this.stepIndex >= this.sequence.length) {
      this.completedAt = now;
      return this.snapshot({
        ...telemetry,
        currentPrompt: 'Liveness challenge verified',
        challengeState: 'complete',
      });
    }

    return this.snapshot({
      ...telemetry,
      currentPrompt: this.buildPrompt(),
      challengeState: this.currentChallengeState(),
    });
  }

  /**
   * OPEN -> CLOSING -> CLOSED -> OPEN. A blink is credited exactly once, on the confirmed
   * CLOSED -> open edge, and only if the closure lasted a physiologically plausible time.
   *
   * `countable` is false while the blink step is not the active action; the FSM still tracks
   * phase for telemetry but the counter is not touched.
   */
  private updateBlinkFsm(
    raw: number,
    bilateral: number,
    poseReliable: boolean,
    now: number,
    countable: boolean
  ): void {
    // Step 7: during strong rotation eyelid coefficients are unreliable. Freeze — but never
    // discard blinks already credited.
    if (!poseReliable) {
      if (this.blinkPhase !== 'suspended') {
        this.blinkPhase = 'suspended';
        this.closureStartedAt = null;
        this.closurePeakBilateral = 0;
        this.closureFramesAbove = 0;
      }
      return;
    }

    switch (this.blinkPhase) {
      case 'suspended':
        // Require a clean open reading before trusting the eyes again.
        if (raw <= BLINK_CLOSE_EXIT) this.blinkPhase = 'open';
        return;

      case 'locked':
        // A long closure/occlusion must fully reopen and is never counted.
        if (raw <= BLINK_OPEN_MAX) this.blinkPhase = 'open';
        return;

      case 'open':
        if (this.smoothedBlink >= BLINK_CLOSE_ENTER) {
          this.blinkPhase = 'closing';
          this.closureStartedAt = now;
          this.closurePeakBilateral = bilateral;
          this.closureFramesAbove = raw >= BLINK_CLOSE_ENTER ? 1 : 0;
        }
        return;

      case 'closing':
        this.closurePeakBilateral = Math.max(this.closurePeakBilateral, bilateral);
        if (raw >= BLINK_CLOSE_ENTER) this.closureFramesAbove++;
        // Confirm the closure only once BOTH eyelids agree; a one-eyed spike is noise.
        if (this.closurePeakBilateral >= BLINK_BILATERAL_MIN) {
          this.blinkPhase = 'closed';
        } else if (this.smoothedBlink <= BLINK_CLOSE_EXIT) {
          // Reopened without ever being a real bilateral closure — discard, do not count.
          this.blinkPhase = 'open';
          this.closureStartedAt = null;
          this.closurePeakBilateral = 0;
          this.closureFramesAbove = 0;
        } else if (this.closureStartedAt !== null && now - this.closureStartedAt > BLINK_MAX_MS) {
          this.blinkPhase = 'locked';
          this.closureStartedAt = null;
          this.closurePeakBilateral = 0;
          this.closureFramesAbove = 0;
        }
        return;

      case 'closed': {
        this.closurePeakBilateral = Math.max(this.closurePeakBilateral, bilateral);
        if (raw >= BLINK_CLOSE_ENTER) this.closureFramesAbove++;
        const closedMs = this.closureStartedAt === null ? 0 : now - this.closureStartedAt;

        if (this.smoothedBlink <= BLINK_CLOSE_EXIT) {
          // Reopened: this is the single point where a blink can be credited.
          this.closuresSeen++;
          const plausible =
            closedMs >= BLINK_MIN_MS &&
            closedMs <= BLINK_MAX_MS &&
            this.closureFramesAbove >= BLINK_MIN_CLOSED_FRAMES;
          if (plausible) {
            if (countable) this.blinkCount++;
            this.lastRejectedClosureMs = null;
          } else {
            this.lastRejectedClosureMs = closedMs;
          }
          this.blinkPhase = 'open';
          this.closureStartedAt = null;
          this.closurePeakBilateral = 0;
          this.closureFramesAbove = 0;
        } else if (closedMs > BLINK_MAX_MS) {
          // Held shut too long: not a blink, and must not re-trigger while still closed.
          this.closuresSeen++;
          this.lastRejectedClosureMs = closedMs;
          this.blinkPhase = 'locked';
          this.closureStartedAt = null;
          this.closurePeakBilateral = 0;
          this.closureFramesAbove = 0;
        }
        return;
      }
    }
  }

  /**
   * Turn requires a sustained deviation from the calibrated neutral yaw followed by a
   * sustained return. Either direction is accepted; a single noisy frame cannot satisfy
   * either half because both require TURN_DWELL_MS of persistence.
   */
  private updateTurnFsm(yawDev: number, now: number): void {
    if (!this.turnedAway) {
      if (Math.abs(yawDev) >= TURN_DEV_DEG) {
        if (this.turnCandidateSince === null) this.turnCandidateSince = now;
        if (now - this.turnCandidateSince >= TURN_DWELL_MS) {
          this.turnedAway = true;
          this.turnCandidateSince = null;
        }
      } else {
        this.turnCandidateSince = null;
      }
      return;
    }

    if (!this.turnReturned) {
      if (Math.abs(yawDev) <= TURN_RETURN_DEG) {
        if (this.returnCandidateSince === null) this.returnCandidateSince = now;
        if (now - this.returnCandidateSince >= TURN_DWELL_MS) {
          this.turnReturned = true;
          this.returnCandidateSince = null;
        }
      } else {
        this.returnCandidateSince = null;
      }
    }
  }

  private currentChallengeState(): ChallengeState {
    if (this.completedAt !== null) return 'complete';
    if (!this.calibrated) return 'calibrating';
    const active = this.sequence[this.stepIndex];
    if (active === 'blink') return 'awaiting-blink';
    if (active === 'turn') return this.turnedAway ? 'awaiting-return' : 'awaiting-turn';
    return 'idle';
  }

  private buildPrompt(): string {
    const step = this.sequence[this.stepIndex];
    const stepLabel = `Action ${this.stepIndex + 1}/${this.sequence.length}`;

    if (step === 'blink') {
      const remaining = this.requiredBlinks - this.blinkCount;
      let prompt = `${stepLabel}: blink ${remaining} more time${remaining === 1 ? '' : 's'}`;
      if (this.blinkPhase === 'locked') {
        prompt += ' — open your eyes fully, then blink';
      } else if (this.lastRejectedClosureMs !== null) {
        prompt +=
          this.lastRejectedClosureMs > BLINK_MAX_MS
            ? ' — that was held too long for a blink; blink quickly'
            : ' — hold your eyes shut a moment longer';
      }
      return prompt;
    }

    return this.turnedAway
      ? `${stepLabel}: now turn back and face the camera`
      : `${stepLabel}: turn your head left or right, then back`;
  }
}
