/**
 * AegisDID — Client-Side Face Detection & 128-d Embedding Extraction
 * Uses face-api.js (TinyFaceDetector + FaceLandmark68Net + FaceRecognitionNet)
 *
 * IMPORTANT: ZERO network requests in lib/ml/. All tensor computations execute in browser
 * WebAssembly/WebGL. Raw frames and descriptors never leave this module's callers.
 *
 * SECURITY: There is deliberately NO synthetic/dummy descriptor path in this file.
 * If no face is detected, these functions return `null` and the caller must fail closed.
 * A constant fallback vector would let any two "captures" match each other with maximum
 * similarity, defeating the entire biometric binding of the ZK circuit.
 */

let modelsLoaded = false;
let loadPromise: Promise<void> | null = null;

/** Minimum detector confidence for a box to count as a *competing* face for multi-face rejection. */
const MULTI_FACE_SCORE = 0.4;

export async function loadFaceApiModels(modelUri: string = '/models'): Promise<void> {
  if (modelsLoaded) return;
  if (typeof window === 'undefined') return;

  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const faceapi = await import('face-api.js');
      console.log('Loading face-api.js models from:', modelUri);

      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(modelUri),
        faceapi.nets.faceLandmark68Net.loadFromUri(modelUri),
        faceapi.nets.faceRecognitionNet.loadFromUri(modelUri),
      ]);

      modelsLoaded = true;
      console.log('face-api.js models loaded successfully.');
    } catch (err) {
      console.error('Failed to load face-api.js models:', err);
      loadPromise = null;
      throw err;
    }
  })();

  return loadPromise;
}

export function isFaceApiLoaded(): boolean {
  return modelsLoaded;
}

/**
 * Capture a frame canvas from a video element
 */
export function captureFrameToCanvas(
  video: HTMLVideoElement,
  maxDimension: number = 480
): HTMLCanvasElement | null {
  if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
    return null;
  }

  let width = video.videoWidth;
  let height = video.videoHeight;

  if (width > maxDimension || height > maxDimension) {
    if (width > height) {
      height = Math.round((height * maxDimension) / width);
      width = maxDimension;
    } else {
      width = Math.round((width * maxDimension) / height);
      height = maxDimension;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(video, 0, 0, width, height);
  return canvas;
}

export interface LiveFaceState {
  detected: boolean;
  aligned: boolean;
  score: number;
  message: string;
  multipleFaces?: boolean;
  box?: { x: number; y: number; width: number; height: number };
  landmarks?: { x: number; y: number }[];
}

/** Pick the largest detection (closest subject) from a face-api result array. */
function largest<T extends { detection: { box: { width: number; height: number } } }>(
  results: T[]
): T | null {
  if (!results || results.length === 0) return null;
  return results.reduce((best, cur) =>
    cur.detection.box.width * cur.detection.box.height >
    best.detection.box.width * best.detection.box.height
      ? cur
      : best
  );
}

/**
 * Fast, lightweight real-time face alignment check for the live viewfinder.
 *
 * Rejects frames containing more than one confidently-detected face: an ambiguous
 * frame must never be used to derive an enrollment or claim embedding.
 */
export async function checkLiveFaceAlignment(
  video: HTMLVideoElement
): Promise<LiveFaceState> {
  if (!video || video.readyState < 2 || video.videoWidth === 0) {
    return {
      detected: false,
      aligned: false,
      score: 0,
      message: 'Initializing camera feed...',
    };
  }

  if (!modelsLoaded) {
    return {
      detected: false,
      aligned: false,
      score: 0,
      message: 'Loading neural nets...',
    };
  }

  try {
    const faceapi = await import('face-api.js');

    // Lightweight 224 input size for fast real-time tracking
    const options = new faceapi.TinyFaceDetectorOptions({
      inputSize: 224,
      scoreThreshold: 0.15,
    });

    const results = await faceapi.detectAllFaces(video, options).withFaceLandmarks();

    const strong = results.filter((r) => r.detection.score >= MULTI_FACE_SCORE);
    if (strong.length > 1) {
      const main = largest(strong)!;
      return {
        detected: true,
        aligned: false,
        multipleFaces: true,
        score: Math.round(main.detection.score * 100),
        message: `${strong.length} faces detected — only one person may be in frame`,
        // NOT `{ ...main.detection.box }`. face-api's Box exposes x/y/width/height as prototype
        // getters over private _x/_y/_width/_height fields, so spreading yields
        // {_x,_y,_width,_height} and every consumer reading box.width gets undefined.
        box: {
          x: main.detection.box.x,
          y: main.detection.box.y,
          width: main.detection.box.width,
          height: main.detection.box.height,
        },
        landmarks: main.landmarks.positions,
      };
    }

    const detection = largest(results);

    if (!detection) {
      return {
        detected: false,
        aligned: false,
        score: 0,
        message: 'Align your face within the oval guide',
      };
    }

    const box = detection.detection.box;
    const landmarks = detection.landmarks.positions;
    const vW = video.videoWidth;
    const vH = video.videoHeight;

    const faceCenterX = box.x + box.width / 2;
    const faceCenterY = box.y + box.height / 2;
    const relX = faceCenterX / vW;
    const relY = faceCenterY / vH;
    const relWidth = box.width / vW;

    // Aligned if centered (horizontal 25%-75%, vertical 18%-78%) and sufficiently close (>=12% width)
    const isCentered = relX >= 0.25 && relX <= 0.75 && relY >= 0.18 && relY <= 0.78;
    const isGoodSize = relWidth >= 0.12 && box.width >= 40;

    if (isCentered && isGoodSize) {
      return {
        detected: true,
        aligned: true,
        score: Math.round(detection.detection.score * 100),
        message: 'Face Aligned · Ready to Capture',
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        landmarks,
      };
    } else if (!isGoodSize) {
      return {
        detected: true,
        aligned: false,
        score: Math.round(detection.detection.score * 100),
        message: 'Move closer to the camera',
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        landmarks,
      };
    } else {
      return {
        detected: true,
        aligned: false,
        score: Math.round(detection.detection.score * 100),
        message: 'Center your face in the oval guide',
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
        landmarks,
      };
    }
  } catch (err) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[DEBUG] checkLiveFaceAlignment threw an error:', err);
    }
    return {
      detected: false,
      aligned: false,
      score: 0,
      message: 'Scanning face geometry...',
    };
  }
}

export class MultipleFacesError extends Error {
  constructor(count: number) {
    super(`${count} faces detected in frame — capture requires exactly one person.`);
    this.name = 'MultipleFacesError';
  }
}

/**
 * Extract a 128-dimensional L2-normalized face descriptor from a video, canvas or image element.
 *
 * Returns `null` when no face can be located. Throws `MultipleFacesError` when more than one
 * face is confidently present. Callers MUST treat both as hard failures — there is no fallback
 * descriptor.
 */
export async function extractFaceDescriptor(
  input: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement
): Promise<number[] | null> {
  if (typeof window === 'undefined') return null;

  const faceapi = await import('face-api.js');

  if (!modelsLoaded) {
    await loadFaceApiModels();
  }

  // 1. Direct pass on the source element. detectAllFaces so multi-face frames can be rejected.
  const options = new faceapi.TinyFaceDetectorOptions({
    inputSize: 224,
    scoreThreshold: 0.15,
  });

  const results = await faceapi
    .detectAllFaces(input, options)
    .withFaceLandmarks()
    .withFaceDescriptors();

  const strong = results.filter((r) => r.detection.score >= MULTI_FACE_SCORE);
  if (strong.length > 1) {
    throw new MultipleFacesError(strong.length);
  }

  const primary = largest(results);
  if (primary?.descriptor) {
    console.log('Face descriptor extracted directly from element.');
    return Array.from(primary.descriptor);
  }

  // 2. Canvas snapshot retry (helps when the <video> element itself is not yet paintable).
  if (input instanceof HTMLVideoElement) {
    const canvas = captureFrameToCanvas(input, 320);
    if (canvas) {
      const canvasResults = await faceapi
        .detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.15 }))
        .withFaceLandmarks()
        .withFaceDescriptors();

      if (canvasResults.filter((r) => r.detection.score >= MULTI_FACE_SCORE).length > 1) {
        throw new MultipleFacesError(canvasResults.length);
      }

      const canvasBest = largest(canvasResults);
      if (canvasBest?.descriptor) {
        console.log('Face descriptor extracted from canvas snapshot.');
        return Array.from(canvasBest.descriptor);
      }
    }
  }

  // 3. Final retry at a smaller input size (helps very close-up or low-light frames).
  const wideResults = await faceapi
    .detectAllFaces(input, new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.15 }))
    .withFaceLandmarks()
    .withFaceDescriptors();

  if (wideResults.filter((r) => r.detection.score >= MULTI_FACE_SCORE).length > 1) {
    throw new MultipleFacesError(wideResults.length);
  }

  const wideBest = largest(wideResults);
  if (wideBest?.descriptor) {
    console.log('Face descriptor extracted with wide threshold.');
    return Array.from(wideBest.descriptor);
  }

  // Fail closed. No synthetic descriptor, in any environment.
  console.warn('Face detection returned no face — failing closed.');
  return null;
}
