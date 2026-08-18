/**
 * AegisDID — Client-Side Face Detection & 128-d Embedding Extraction
 * Uses face-api.js (TinyFaceDetector + FaceLandmark68Net + FaceRecognitionNet)
 * 
 * IMPORTANT: ZERO network requests in lib/ml/. All tensor computations execute in browser WebAssembly/WebGL.
 */

let modelsLoaded = false;
let loadPromise: Promise<void> | null = null;

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
  box?: { x: number; y: number; width: number; height: number };
}

/**
 * Fast, lightweight real-time face alignment check for live viewfinder preview
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

    const detection = await faceapi.detectSingleFace(video, options);

    if (!detection) {
      return {
        detected: false,
        aligned: false,
        score: 0,
        message: 'Align your face within the oval guide',
      };
    }

    const box = detection.box;
    const vW = video.videoWidth;
    const vH = video.videoHeight;

    const faceCenterX = box.x + box.width / 2;
    const faceCenterY = box.y + box.height / 2;
    const relX = faceCenterX / vW;
    const relY = faceCenterY / vH;
    const relWidth = box.width / vW;

    // Aligned if centered (horizontal 25%-75%, vertical 20%-75%) and sufficiently close (>=12% width)
    const isCentered = relX >= 0.25 && relX <= 0.75 && relY >= 0.18 && relY <= 0.78;
    const isGoodSize = relWidth >= 0.12 && box.width >= 40;

    if (isCentered && isGoodSize) {
      return {
        detected: true,
        aligned: true,
        score: Math.round(detection.score * 100),
        message: 'Face Aligned · Ready to Capture',
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
      };
    } else if (!isGoodSize) {
      return {
        detected: true,
        aligned: false,
        score: Math.round(detection.score * 100),
        message: 'Move closer to the camera',
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
      };
    } else {
      return {
        detected: true,
        aligned: false,
        score: Math.round(detection.score * 100),
        message: 'Center your face in the oval guide',
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
      };
    }
  } catch {
    return {
      detected: false,
      aligned: false,
      score: 0,
      message: 'Scanning face geometry...',
    };
  }
}

/**
 * Extract 128-dimensional L2-normalized face descriptor from video or canvas element.
 * Optimized for mobile speed and reliability without multi-second freezes.
 */
export async function extractFaceDescriptor(
  input: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement
): Promise<number[] | null> {
  if (typeof window === 'undefined') return null;

  try {
    const faceapi = await import('face-api.js');

    if (!modelsLoaded) {
      await loadFaceApiModels();
    }

    // 1. Direct pass on video/image element
    const options = new faceapi.TinyFaceDetectorOptions({
      inputSize: 224,
      scoreThreshold: 0.15,
    });

    const detection = await faceapi
      .detectSingleFace(input, options)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (detection?.descriptor) {
      console.log('Face descriptor extracted directly from element.');
      return Array.from(detection.descriptor);
    }

    // 2. Fast canvas snapshot fallback
    if (input instanceof HTMLVideoElement) {
      const canvas = captureFrameToCanvas(input, 320);
      if (canvas) {
        const canvasDetection = await faceapi
          .detectSingleFace(
            canvas,
            new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.10 })
          )
          .withFaceLandmarks()
          .withFaceDescriptor();

        if (canvasDetection?.descriptor) {
          console.log('Face descriptor extracted from canvas snapshot.');
          return Array.from(canvasDetection.descriptor);
        }
      }
    }

    // 3. Fallback pass with broader threshold
    const wideDetection = await faceapi
      .detectSingleFace(
        input,
        new faceapi.TinyFaceDetectorOptions({ inputSize: 160, scoreThreshold: 0.10 })
      )
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (wideDetection?.descriptor) {
      console.log('Face descriptor extracted with wide threshold.');
      return Array.from(wideDetection.descriptor);
    }

    console.warn('Face detection returned no face.');
    return null;
  } catch (err) {
    console.error('Error during extractFaceDescriptor:', err);
    return null;
  }
}
