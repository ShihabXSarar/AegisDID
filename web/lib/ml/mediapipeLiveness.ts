/**
 * AegisDID — MediaPipe Face Landmarker liveness signal extraction.
 *
 * RESPONSIBILITY SPLIT
 * --------------------
 *   face-api.js            -> IDENTITY (128-d descriptor, quantisation, commitments, ZK)
 *   MediaPipe FaceLandmarker -> LIVENESS ONLY (eyelid blendshapes + head pose)
 *
 * This module never touches the identity pipeline. It converts video frames into the small
 * numeric `LivenessSignals` struct consumed by the pure state machine in `lib/ml/liveness.ts`.
 *
 * PRIVACY: zero network requests at runtime. Model and WASM are served from this app's own
 * /public directory. No frame, landmark, descriptor or blendshape ever leaves the browser.
 *
 * ASSET LOCATION: the MediaPipe model lives in `public/mediapipe/`, deliberately NOT in
 * `public/models/`. MODEL_HASH is keccak256 over every file in `public/models` (see
 * tools/compute_model_hash.mjs), and it is committed on-chain inside every policy. Adding a
 * file there would change MODEL_HASH and invalidate every existing identity commitment.
 *
 * FAIL-CLOSED: every failure path returns `ok: false` (or throws during init). There is no
 * synthetic landmark, dummy blendshape or hardcoded success anywhere in this file.
 */

import type { FaceLandmarker, FaceLandmarkerResult } from '@mediapipe/tasks-vision';
import type { LivenessSignals } from './liveness';

/** Served from this app; no CDN, so the demo cannot break on an external URL. */
const WASM_BASE_PATH = '/mediapipe/wasm';
const MODEL_ASSET_PATH = '/mediapipe/face_landmarker.task';

/**
 * Canonical MediaPipe face-mesh indices (468-point topology).
 * 33/263 are the outer eye corners, 10/152 the top of the forehead and the bottom of the chin.
 */
const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;
const FOREHEAD_TOP = 10;
const CHIN_BOTTOM = 152;

/** Blink blendshape names are resolved from the model at runtime, never assumed. */
const BLINK_LEFT_PATTERN = /^eyeblinkleft$/i;
const BLINK_RIGHT_PATTERN = /^eyeblinkright$/i;

let landmarker: FaceLandmarker | null = null;
let initPromise: Promise<FaceLandmarker> | null = null;
let initError: string | null = null;

/** Resolved once from the first result that carries blendshapes. */
let blinkLeftIndex = -1;
let blinkRightIndex = -1;
let blendshapeResolutionFailed = false;

/** MediaPipe requires strictly increasing video timestamps. */
let lastVideoTimeMs = -1;

export interface LivenessEngineStatus {
  ready: boolean;
  loading: boolean;
  error: string | null;
}

export function getLivenessEngineStatus(): LivenessEngineStatus {
  return {
    ready: landmarker !== null && !blendshapeResolutionFailed,
    loading: initPromise !== null && landmarker === null,
    error: initError,
  };
}

/**
 * Initialise the Face Landmarker exactly once per page.
 *
 * Concurrent callers share a single in-flight promise, so we never build two WASM runtimes
 * or two model instances. A failed load clears the promise so a later retry is possible.
 */
export async function initLivenessEngine(): Promise<FaceLandmarker> {
  if (typeof window === 'undefined') {
    throw new Error('MediaPipe liveness engine requires a browser environment.');
  }
  if (landmarker) return landmarker;
  if (initPromise) return initPromise;

  initError = null;

  initPromise = (async () => {
    try {
      const vision = await import('@mediapipe/tasks-vision');
      const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE_PATH);

      const created = await vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: MODEL_ASSET_PATH,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        // 2, not 1: we must be able to SEE a second face in order to reject the frame.
        numFaces: 2,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: false,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });

      landmarker = created;
      lastVideoTimeMs = -1;
      return created;
    } catch (err) {
      // GPU delegate is unavailable on some drivers; retry once on CPU before giving up.
      try {
        const vision = await import('@mediapipe/tasks-vision');
        const fileset = await vision.FilesetResolver.forVisionTasks(WASM_BASE_PATH);
        const created = await vision.FaceLandmarker.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: MODEL_ASSET_PATH,
            delegate: 'CPU',
          },
          runningMode: 'VIDEO',
          numFaces: 2,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: false,
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
        landmarker = created;
        lastVideoTimeMs = -1;
        return created;
      } catch (cpuErr) {
        initPromise = null;
        initError =
          cpuErr instanceof Error
            ? `Liveness engine failed to load: ${cpuErr.message}`
            : 'Liveness engine failed to load.';
        console.error('MediaPipe FaceLandmarker init failed (GPU then CPU):', err, cpuErr);
        throw new Error(initError);
      }
    }
  })();

  return initPromise;
}

/** Release the WASM runtime and model. Safe to call repeatedly. */
export function closeLivenessEngine(): void {
  try {
    landmarker?.close();
  } catch (err) {
    console.warn('FaceLandmarker close failed:', err);
  }
  landmarker = null;
  initPromise = null;
  initError = null;
  blinkLeftIndex = -1;
  blinkRightIndex = -1;
  blendshapeResolutionFailed = false;
  lastVideoTimeMs = -1;
}

/** A frame that must not advance the challenge. */
const UNUSABLE: LivenessSignals = {
  ok: false,
  blinkLeft: 0,
  blinkRight: 0,
  yawDeg: 0,
  faceScale: 0,
  faceScalePx: 0,
  confidence: 0,
};

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function norm(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

/**
 * Signed head yaw in degrees, 0 = facing the camera.
 *
 * Rather than trusting a rotation-matrix convention, this builds an orthonormal face frame
 * from four landmarks and reads the yaw off the face normal:
 *
 *   xAxis  = outer-eye to outer-eye
 *   yTmp   = forehead to chin
 *   zAxis  = xAxis x yTmp        (the face normal)
 *   yaw    = atan2(zAxis.x, zAxis.z)
 *
 * Because the frame is orthonormalised from the face itself, the result is invariant to head
 * ROLL and to face SCALE — the two things that made the old jaw-endpoint ratio unreliable.
 * Landmark coordinates are de-normalised first (x,z by width, y by height) so the frame is
 * not skewed by the video aspect ratio.
 *
 * The challenge accepts a turn in EITHER direction and only ever uses |yaw - baseline|, so a
 * sign-convention difference cannot cause a false accept or reject.
 */
function computeYawDeg(
  landmarks: { x: number; y: number; z: number }[],
  width: number,
  height: number
): number | null {
  const l = landmarks[LEFT_EYE_OUTER];
  const r = landmarks[RIGHT_EYE_OUTER];
  const top = landmarks[FOREHEAD_TOP];
  const chin = landmarks[CHIN_BOTTOM];
  if (!l || !r || !top || !chin) return null;

  // MediaPipe z is expressed on roughly the same scale as x, so de-normalise it by width.
  const toPx = (p: { x: number; y: number; z: number }): Vec3 => ({
    x: p.x * width,
    y: p.y * height,
    z: p.z * width,
  });

  const xAxis = sub(toPx(r), toPx(l));
  const yTmp = sub(toPx(chin), toPx(top));
  const zAxis = cross(xAxis, yTmp);

  const n = norm(zAxis);
  if (!Number.isFinite(n) || n === 0) return null;

  const yaw = Math.atan2(zAxis.x / n, zAxis.z / n);
  if (!Number.isFinite(yaw)) return null;
  return (yaw * 180) / Math.PI;
}

/** Resolve the eyelid blendshape indices from the model's own category names. */
function resolveBlinkIndices(result: FaceLandmarkerResult): boolean {
  if (blinkLeftIndex >= 0 && blinkRightIndex >= 0) return true;
  if (blendshapeResolutionFailed) return false;

  const categories = result.faceBlendshapes?.[0]?.categories;
  if (!categories || categories.length === 0) return false;

  categories.forEach((c, i) => {
    if (BLINK_LEFT_PATTERN.test(c.categoryName)) blinkLeftIndex = i;
    if (BLINK_RIGHT_PATTERN.test(c.categoryName)) blinkRightIndex = i;
  });

  if (blinkLeftIndex < 0 || blinkRightIndex < 0) {
    blendshapeResolutionFailed = true;
    initError =
      'Liveness model did not expose eyeBlinkLeft/eyeBlinkRight blendshapes — cannot verify liveness.';
    console.error(
      initError,
      'available categories:',
      categories.map((c) => c.categoryName)
    );
    return false;
  }
  return true;
}

/**
 * Run one inference and return liveness signals.
 *
 * `detectForVideo` is synchronous in @mediapipe/tasks-vision, so frames cannot pile up and no
 * inference mutex is needed. Frames whose video timestamp has not advanced are skipped,
 * because MediaPipe rejects non-monotonic timestamps.
 */
export function extractLivenessSignals(video: HTMLVideoElement): LivenessSignals | null {
  if (!landmarker || blendshapeResolutionFailed) return UNUSABLE;
  if (!video || video.readyState < 2 || video.videoWidth === 0) return UNUSABLE;

  const videoTimeMs = video.currentTime * 1000;
  if (videoTimeMs <= lastVideoTimeMs) return null;
  lastVideoTimeMs = videoTimeMs;

  let result: FaceLandmarkerResult;
  try {
    result = landmarker.detectForVideo(video, videoTimeMs);
  } catch (err) {
    console.warn('FaceLandmarker.detectForVideo failed:', err);
    return UNUSABLE;
  }

  const faces = result.faceLandmarks;
  if (!faces || faces.length === 0) return UNUSABLE;

  // More than one face is an ambiguous frame — surfaced so the tracker can refuse it.
  if (faces.length > 1) return { ...UNUSABLE, multipleFaces: true };

  const landmarks = faces[0];
  if (!landmarks || landmarks.length < 468) return UNUSABLE;

  if (!resolveBlinkIndices(result)) return UNUSABLE;

  const categories = result.faceBlendshapes?.[0]?.categories;
  if (!categories) return UNUSABLE;

  const blinkLeft = categories[blinkLeftIndex]?.score;
  const blinkRight = categories[blinkRightIndex]?.score;
  if (typeof blinkLeft !== 'number' || typeof blinkRight !== 'number') return UNUSABLE;

  const width = video.videoWidth;
  const height = video.videoHeight;

  const yawDeg = computeYawDeg(landmarks, width, height);
  if (yawDeg === null) return UNUSABLE;

  const le = landmarks[LEFT_EYE_OUTER];
  const re = landmarks[RIGHT_EYE_OUTER];
  const dxPx = (re.x - le.x) * width;
  const dyPx = (re.y - le.y) * height;
  const faceScalePx = Math.sqrt(dxPx * dxPx + dyPx * dyPx);
  const faceScale = width === 0 ? 0 : faceScalePx / width;

  // FaceLandmarker exposes no per-face detection score. MediaPipe has already applied the
  // detection/presence/tracking thresholds configured at init, so presence of a face is the
  // confidence signal; mean landmark visibility is used when the model populates it.
  let confidence = 1;
  let visSum = 0;
  let visCount = 0;
  for (const p of landmarks) {
    const v = (p as { visibility?: number }).visibility;
    if (typeof v === 'number' && v > 0) {
      visSum += v;
      visCount++;
    }
  }
  if (visCount > 0) confidence = visSum / visCount;

  return {
    ok: true,
    blinkLeft,
    blinkRight,
    yawDeg,
    faceScale,
    faceScalePx,
    confidence,
  };
}
