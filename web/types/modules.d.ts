declare module 'circomlibjs' {
  export function buildPoseidon(): Promise<any>;
  export function buildBabyjub(): Promise<any>;
  export function buildEddsa(): Promise<any>;
}

declare module 'snarkjs' {
  export const groth16: {
    fullProve(
      witness: any,
      wasmFile: string | Uint8Array,
      zkeyFile: string | Uint8Array
    ): Promise<{ proof: any; publicSignals: string[] }>;
    verify(
      vKey: any,
      publicSignals: string[],
      proof: any
    ): Promise<boolean>;
  };
}

declare module '@mediapipe/camera_utils' {
  export class Camera {
    constructor(videoElement: HTMLVideoElement, options: { onFrame: () => Promise<void> | void; width?: number; height?: number });
    start(): Promise<void>;
    stop(): void;
  }
}

declare module '@mediapipe/face_mesh' {
  export interface Results {
    multiFaceLandmarks?: Array<Array<{ x: number; y: number; z: number }>>;
  }
  export class FaceMesh {
    constructor(config?: { locateFile?: (file: string) => string });
    setOptions(options: { maxNumFaces?: number; refineLandmarks?: boolean; minDetectionConfidence?: number; minTrackingConfidence?: number }): void;
    onResults(callback: (results: Results) => void): void;
    send(input: { image: HTMLVideoElement | HTMLCanvasElement | HTMLImageElement }): Promise<void>;
    close(): Promise<void>;
  }
}
