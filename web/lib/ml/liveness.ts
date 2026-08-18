/**
 * AegisDID — Real-time Client-Side Liveness Challenge
 * Strictly adheres to docs/CRYPTO_SPEC.md and .agents/rules/00-project.md.
 * 
 * IMPORTANT: ZERO network requests. All facial landmark tracking runs client-side.
 */

export interface LandmarkPoint {
  x: number;
  y: number;
  z?: number;
}

export interface LivenessState {
  hasBlinked: boolean;
  hasTurnedHead: boolean;
  isComplete: boolean;
  livenessScore: number;
  currentPrompt: string;
  earValue: number;
  yawRatio: number;
}

// MediaPipe FaceMesh key indices for EAR (Eye Aspect Ratio)
// Left eye: 33 (outer), 160, 158 (top), 133 (inner), 153, 144 (bottom)
const LEFT_EYE = [33, 160, 158, 133, 153, 144];
// Right eye: 263 (outer), 385, 387 (top), 362 (inner), 373, 380 (bottom)
const RIGHT_EYE = [263, 385, 387, 362, 373, 380];

// Landmarks for head orientation
const NOSE_TIP = 1;
const LEFT_FACE_EDGE = 234;
const RIGHT_FACE_EDGE = 454;

function distance(p1: LandmarkPoint, p2: LandmarkPoint): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Compute Eye Aspect Ratio (EAR)
 */
export function calculateEyeAspectRatio(landmarks: LandmarkPoint[], eyeIndices: number[]): number {
  const [p1, p2, p3, p4, p5, p6] = eyeIndices.map((idx) => landmarks[idx]);
  if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) return 0.3;

  const vertical1 = distance(p2, p6);
  const vertical2 = distance(p3, p5);
  const horizontal = distance(p1, p4);

  if (horizontal === 0) return 0.3;
  return (vertical1 + vertical2) / (2.0 * horizontal);
}

/**
 * Compute Head Yaw Ratio (ratio of nose distance to left vs right edges)
 */
export function calculateHeadYawRatio(landmarks: LandmarkPoint[]): number {
  const nose = landmarks[NOSE_TIP];
  const left = landmarks[LEFT_FACE_EDGE];
  const right = landmarks[RIGHT_FACE_EDGE];

  if (!nose || !left || !right) return 1.0;

  const distLeft = distance(nose, left);
  const distRight = distance(nose, right);

  if (distRight === 0) return 1.0;
  return distLeft / distRight;
}

/**
 * Liveness Tracker Class managing the 5-second active anti-spoofing challenge
 */
export class LivenessTracker {
  private blinkDipDetected = false;
  private blinkRecovered = false;
  private headTurnDetected = false;
  private startTime = 0;
  private durationLimitMs = 6000; // 6 seconds window

  constructor() {
    this.reset();
  }

  public reset() {
    this.blinkDipDetected = false;
    this.blinkRecovered = false;
    this.headTurnDetected = false;
    this.startTime = Date.now();
  }

  public processFrame(landmarks: LandmarkPoint[]): LivenessState {
    if (!landmarks || landmarks.length < 468) {
      return {
        hasBlinked: this.blinkRecovered,
        hasTurnedHead: this.headTurnDetected,
        isComplete: false,
        livenessScore: 0,
        currentPrompt: 'Please position your face directly in the frame',
        earValue: 0.3,
        yawRatio: 1.0,
      };
    }

    const elapsed = Date.now() - this.startTime;
    const isTimeout = elapsed > this.durationLimitMs;

    // 1. Calculate Eye Aspect Ratio (EAR)
    const leftEar = calculateEyeAspectRatio(landmarks, LEFT_EYE);
    const rightEar = calculateEyeAspectRatio(landmarks, RIGHT_EYE);
    const avgEar = (leftEar + rightEar) / 2.0;

    // Blink detection logic: drop below 0.18, then recover above 0.24
    if (avgEar < 0.18) {
      this.blinkDipDetected = true;
    }
    if (this.blinkDipDetected && avgEar > 0.24) {
      this.blinkRecovered = true;
    }

    // 2. Calculate Head Yaw Ratio
    const yaw = calculateHeadYawRatio(landmarks);
    // Standard centered yaw is roughly between 0.75 and 1.35
    // Significant turn to left or right: < 0.60 or > 1.65
    if (yaw < 0.60 || yaw > 1.65) {
      this.headTurnDetected = true;
    }

    // Determine state and prompt
    const isComplete = this.blinkRecovered && this.headTurnDetected;
    let score = 0;
    if (this.blinkRecovered) score += 50;
    if (this.headTurnDetected) score += 50;

    let currentPrompt = '';
    if (!this.blinkRecovered) {
      currentPrompt = 'Action 1/2: Please blink your eyes naturally';
    } else if (!this.headTurnDetected) {
      currentPrompt = 'Action 2/2: Please turn your head slightly left or right';
    } else {
      currentPrompt = 'Liveness Challenge Verified (100%)';
    }

    if (isTimeout && !isComplete) {
      currentPrompt = 'Challenge timed out. Please try again.';
    }

    return {
      hasBlinked: this.blinkRecovered,
      hasTurnedHead: this.headTurnDetected,
      isComplete,
      livenessScore: score,
      currentPrompt,
      earValue: avgEar,
      yawRatio: yaw,
    };
  }
}
