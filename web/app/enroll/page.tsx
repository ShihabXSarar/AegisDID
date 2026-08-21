'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Shield,
  Camera,
  AlertTriangle,
  Copy,
  Check,
  ArrowRight,
  RefreshCw,
  Lock,
  Key,
  UserCheck,
  Smartphone,
  Eye,
} from 'lucide-react';
import {
  extractFaceDescriptor,
  loadFaceApiModels,
  checkLiveFaceAlignment,
  LiveFaceState,
  MultipleFacesError,
} from '@/lib/ml/face';
import { quantizeEmbedding } from '@/lib/ml/quantize';
import {
  generateRandomScalar,
  computeEmbeddingCommitment,
  computeIdentityCommitment,
  DEFAULT_MODEL_HASH,
  DEFAULT_MODEL_HASH_BYTES32,
} from '@/lib/ml/commitments';
import { saveBeneficiaryIdentity, getBeneficiaryIdentity, StoredIdentity } from '@/lib/ml/storage';
import { generateDIDKeyPair } from '@/lib/ml/did';
import Link from 'next/link';

type Step = 'idle' | 'camera' | 'processing' | 'success' | 'error';

export default function EnrollPage() {
  const [step, setStep] = useState<Step>('idle');
  const [statusMessage, setStatusMessage] = useState<string>('Align face inside the oval target.');
  const [existingIdentity, setExistingIdentity] = useState<StoredIdentity | null>(null);
  const [enrolledIdentity, setEnrolledIdentity] = useState<StoredIdentity | null>(null);
  const [publishedRoot, setPublishedRoot] = useState<string>('');
  const [copiedDID, setCopiedDID] = useState(false);
  const [copiedCID, setCopiedCID] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>('');

  // Live face detection & alignment state
  const [liveFace, setLiveFace] = useState<LiveFaceState>({
    detected: false,
    aligned: false,
    score: 0,
    message: 'Align face inside oval guide',
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const detectionIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const detectingRef = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);
  const isStartingCameraRef = useRef<boolean>(false);

  // Callback ref: fires immediately when the <video> element mounts/unmounts
  // This is the ONLY reliable way to attach a stream on mobile browsers
  const videoCallbackRef = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (node && streamRef.current) {
      node.srcObject = streamRef.current;
      node.muted = true;
      node.setAttribute('playsinline', 'true');
      node.play().catch((err) => console.warn('callback ref play failed:', err));
    }
  }, []);

  // Check for existing identity
  useEffect(() => {
    isMountedRef.current = true;
    let isMounted = true;

    async function init() {
      try {
        const id = await getBeneficiaryIdentity();
        if (id && isMounted) setExistingIdentity(id);
      } catch (err) {
        console.error(err);
      }
    }
    init();

    const handleBeforeUnload = () => stopCamera();
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handleBeforeUnload);

    return () => {
      isMountedRef.current = false;
      isMounted = false;
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handleBeforeUnload);
      stopCamera();
    };
  }, []);

  // Fallback: if video element was already mounted when stream arrives, attach now
  useEffect(() => {
    if ((step === 'camera' || step === 'processing') && videoRef.current && streamRef.current) {
      if (videoRef.current.srcObject !== streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
        videoRef.current.muted = true;
        videoRef.current.setAttribute('playsinline', 'true');
        videoRef.current.play().catch((err) => console.warn('fallback play failed:', err));
      }
    }
  }, [step]);

  async function startCamera(): Promise<MediaStream | null> {
    try {
      if (isStartingCameraRef.current) return null;

      if (streamRef.current) {
        const hasActiveTracks = streamRef.current.getTracks().some((t) => t.readyState === 'live');
        if (hasActiveTracks) {
          return streamRef.current;
        } else {
          stopCamera();
        }
      }

      isStartingCameraRef.current = true;

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(
          'Camera API is unavailable. A secure context (https:// or http://localhost) is required.'
        );
      }

      const constraints: MediaStreamConstraints = {
        audio: false,
        video: {
          facingMode: { ideal: 'user' },
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
      };

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }

      if (!isMountedRef.current) {
        stream.getTracks().forEach((track) => {
          track.stop();
          track.enabled = false;
        });
        return null;
      }

      streamRef.current = stream;
      return stream;
    } catch (err: any) {
      console.error('Camera access error:', err);
      let msg = `Camera error: ${err?.name || 'Unknown'} — ${err?.message || String(err)}`;

      if (
        err?.name === 'NotReadableError' ||
        err?.name === 'TrackStartError' ||
        err?.message?.includes('NotReadableError')
      ) {
        msg =
          'The camera could not be started. Another application may be holding it — close Zoom, Teams, OBS or another browser tab using the camera, then try again.';
      } else if (err?.name === 'NotAllowedError') {
        msg =
          'Camera permission was denied. Grant camera access for this site in your browser settings and try again.';
      } else if (err?.name === 'NotFoundError') {
        msg = 'No camera device was found on this machine.';
      }

      setErrorMessage(msg);
      return null;
    } finally {
      isStartingCameraRef.current = false;
    }
  }

  /** Bring up the camera, load models, and start the alignment loop. Shared by all entry points. */
  async function beginCapture() {
    setErrorMessage('');
    setStatusMessage('Requesting camera permissions...');

    const stream = await startCamera();
    if (!stream) {
      setStep('idle');
      return;
    }

    setStep('camera');

    // Let the <video> mount before attaching the stream.
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.muted = true;
      videoRef.current.setAttribute('playsinline', 'true');
      videoRef.current.play().catch((err) => console.warn('direct play failed:', err));
    }

    setStatusMessage('Initializing neural nets...');
    try {
      await loadFaceApiModels();
      setStatusMessage('Align your face inside the guide');
      startLiveFaceDetectionLoop();
    } catch (err) {
      console.error(err);
      setErrorMessage(
        `Failed to load the face-api.js model weights from /models: ${
          err instanceof Error ? err.message : String(err)
        }. Enrollment cannot continue.`
      );
      setStatusMessage('Model load failed.');
    }
  }

  // Real-time live face alignment loop — sequential pattern prevents overlapping inference
  function startLiveFaceDetectionLoop() {
    if (detectionIntervalRef.current) clearInterval(detectionIntervalRef.current);
    detectingRef.current = false;

    const runDetection = async () => {
      if (detectingRef.current) return;
      const video = videoRef.current;
      if (!video || video.readyState < 2 || video.paused || video.videoWidth === 0) return;

      detectingRef.current = true;
      try {
        const state = await checkLiveFaceAlignment(video);
        if (isMountedRef.current) setLiveFace(state);
      } catch {
        // ignore per-frame check errors
      } finally {
        detectingRef.current = false;
      }
    };

    detectionIntervalRef.current = setInterval(runDetection, 700);
  }

  function stopCamera() {
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
      detectionIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        track.stop();
        track.enabled = false;
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      if (videoRef.current.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach((track) => {
          track.stop();
          track.enabled = false;
        });
        videoRef.current.srcObject = null;
      }
      videoRef.current.pause();
      videoRef.current.removeAttribute('src');
      videoRef.current.load();
    }
  }

  /** Return to the live viewfinder after a recoverable failure. */
  function recoverToCamera(message: string) {
    setStep('camera');
    setErrorMessage(message);
    startLiveFaceDetectionLoop();
  }

  async function handleCaptureAndEnroll() {
    // Require a properly framed face before spending inference on a capture, and before
    // committing anything. A badly framed crop produces a low-quality template that will
    // silently fail every future claim.
    if (!liveFace.aligned) {
      setErrorMessage(
        liveFace.multipleFaces
          ? 'More than one face is in frame. Enrollment requires exactly one person.'
          : `Face is not correctly framed (${liveFace.message}). Align inside the oval guide before enrolling.`
      );
      return;
    }

    // Pause the alignment loop so it does not compete with capture inference.
    if (detectionIntervalRef.current) {
      clearInterval(detectionIntervalRef.current);
      detectionIntervalRef.current = null;
    }

    setStep('processing');
    setErrorMessage('');

    try {
      if (!videoRef.current) {
        throw new Error('Camera video element is not active.');
      }

      setStatusMessage('Extracting 128-dimensional face embedding tensor...');
      await new Promise<void>((r) => setTimeout(r, 50));

      let descriptor: number[] | null;
      try {
        descriptor = await extractFaceDescriptor(videoRef.current);
      } catch (err) {
        if (err instanceof MultipleFacesError) {
          recoverToCamera(`${err.message} Ensure nobody else is visible behind you, then retry.`);
          return;
        }
        throw err;
      }

      if (!descriptor) {
        recoverToCamera(
          'No face could be extracted from the frame. Move into good, even lighting, fill the oval guide, and retry.'
        );
        return;
      }

      setStatusMessage('Quantizing embedding into int8 range per CRYPTO_SPEC...');
      await new Promise<void>((r) => setTimeout(r, 30));
      const uReg = quantizeEmbedding(descriptor);

      setStatusMessage('Generating 254-bit CSPRNG secrets and Poseidon commitments...');
      const idSecret = generateRandomScalar();
      const salt = generateRandomScalar();

      await new Promise<void>((r) => setTimeout(r, 30));
      setStatusMessage('Computing embedding commitment C_emb (8-chunk Poseidon)...');
      const cEmb = await computeEmbeddingCommitment(uReg, salt);

      await new Promise<void>((r) => setTimeout(r, 20));
      setStatusMessage('Computing identity commitment C_id (Poseidon3)...');
      const cId = await computeIdentityCommitment(idSecret, cEmb, DEFAULT_MODEL_HASH);

      setStatusMessage('Generating Ed25519 did:key keypair...');
      const didPair = generateDIDKeyPair();

      const newIdentity: StoredIdentity = {
        idSecret: '0x' + idSecret.toString(16),
        salt: '0x' + salt.toString(16),
        uReg,
        cEmb: '0x' + cEmb.toString(16),
        cId: '0x' + cId.toString(16),
        didKey: didPair.did,
        didPublicKey: didPair.publicKeyHex,
        didPrivateKey: didPair.privateKeyHex,
        modelHash: DEFAULT_MODEL_HASH_BYTES32,
        createdAt: new Date().toISOString(),
      };

      /*
       * ORDER MATTERS. Publish C_id to the authority FIRST, and only persist locally once the
       * commitment is actually in the cohort tree.
       *
       * If we saved locally first and the publish failed, the user would hold a credential that
       * looks enrolled but has no Merkle leaf, so /api/merkle/path would 404 and every claim
       * would fail with an unexplainable error. The reverse ordering is safe: a leaf with no
       * local secret is simply unclaimable by anyone.
       *
       * ONLY C_id, the DID, and a timestamp cross the network. No vector, no secret, no salt.
       */
      setStatusMessage('Publishing Identity Commitment C_id for Merkle inclusion...');
      let res: Response;
      try {
        res = await fetch('/api/enroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cId: newIdentity.cId,
            didKey: newIdentity.didKey,
            timestamp: newIdentity.createdAt,
          }),
        });
      } catch (netErr) {
        throw new Error(
          `Could not reach the authority enrollment endpoint (/api/enroll): ${
            netErr instanceof Error ? netErr.message : String(netErr)
          }. Nothing was saved — retry when the service is reachable.`
        );
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          `The authority rejected this enrollment (HTTP ${res.status}${
            body?.error ? `: ${body.error}` : ''
          }). Your commitment is NOT in the cohort tree, so nothing was saved locally.`
        );
      }

      const enrollResult = await res.json().catch(() => ({}));
      if (!enrollResult?.success) {
        throw new Error(
          'The authority returned an unexpected response and did not confirm Merkle inclusion. Nothing was saved locally.'
        );
      }
      if (enrollResult?.newRoot) {
        setPublishedRoot('0x' + BigInt(enrollResult.newRoot).toString(16));
      }

      setStatusMessage('Sealing credentials in the browser IndexedDB enclave (strictly local)...');
      await saveBeneficiaryIdentity(newIdentity);

      stopCamera();
      setEnrolledIdentity(newIdentity);
      setExistingIdentity(newIdentity);
      setStep('success');
    } catch (err: unknown) {
      console.error('Enrollment error:', err);
      recoverToCamera(
        err instanceof Error ? err.message : 'An error occurred during enrollment. Nothing was saved.'
      );
    }
  }

  function handleCopy(text: string, type: 'did' | 'cid') {
    navigator.clipboard.writeText(text);
    if (type === 'did') {
      setCopiedDID(true);
      setTimeout(() => setCopiedDID(false), 2000);
    } else {
      setCopiedCID(true);
      setTimeout(() => setCopiedCID(false), 2000);
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8 animate-fade-in">
      {/* Header */}
      <div className="text-center space-y-2">
        <div className="inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 text-xs font-bold uppercase tracking-wider">
          <Shield className="w-3.5 h-3.5" />
          <span>Step 1 · One-Time Registration</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-white">Enroll Beneficiary Identity</h1>
        <p className="text-xs sm:text-sm text-slate-400 max-w-lg mx-auto">
          Capture your biometric profile locally. Raw images and secrets stay strictly inside this
          browser enclave.
        </p>
      </div>

      {/* Visual Stepper */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4 text-center text-xs font-medium">
        <div
          className={`p-3 rounded-2xl border transition-all ${
            step === 'camera' || step === 'processing'
              ? 'bg-indigo-950/40 border-indigo-500/50 text-indigo-300'
              : 'bg-slate-900/40 border-slate-800 text-slate-500'
          }`}
        >
          <div className="font-bold text-white">1. Face Capture</div>
          <span className="text-[10px] text-slate-400">Camera &amp; 128-d Tensor</span>
        </div>

        <div
          className={`p-3 rounded-2xl border transition-all ${
            step === 'processing'
              ? 'bg-indigo-950/40 border-indigo-500/50 text-indigo-300 animate-pulse'
              : step === 'success'
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                : 'bg-slate-900/40 border-slate-800 text-slate-500'
          }`}
        >
          <div className="font-bold text-white">2. ZK Commitments</div>
          <span className="text-[10px] text-slate-400">Poseidon C_id &amp; C_emb</span>
        </div>

        <div
          className={`p-3 rounded-2xl border transition-all ${
            step === 'success'
              ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
              : 'bg-slate-900/40 border-slate-800 text-slate-500'
          }`}
        >
          <div className="font-bold text-white">3. DID Key Issued</div>
          <span className="text-[10px] text-slate-400">Ready to Claim</span>
        </div>
      </div>

      {/* Existing Identity Alert */}
      {existingIdentity && step !== 'success' && (
        <div className="p-4 rounded-2xl bg-indigo-950/40 border border-indigo-500/30 flex items-start gap-3">
          <Smartphone className="w-5 h-5 text-indigo-400 shrink-0 mt-0.5" />
          <div className="text-xs text-indigo-200 space-y-1">
            <div className="font-bold text-white">Existing Enrolled Identity Detected</div>
            <p className="font-mono text-[11px] text-indigo-300/90 break-all">
              {existingIdentity.didKey}
            </p>
            <p className="text-indigo-400 text-[11px]">
              Capturing a new face replaces the stored biometric secret on this device. The previous
              commitment stays in the cohort tree but becomes unclaimable, because its idSecret is
              overwritten.
            </p>
          </div>
        </div>
      )}

      {/* Main Container */}
      <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6 sm:p-8 shadow-2xl space-y-6 backdrop-blur-xl">
        {/* Error Notice */}
        {errorMessage && (
          <div className="p-4 rounded-2xl bg-red-950/50 border border-red-500/30 text-red-300 text-xs sm:text-sm flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 leading-relaxed break-words">{errorMessage}</div>
            <button
              onClick={() => {
                setErrorMessage('');
                beginCapture();
              }}
              className="text-xs underline text-red-200 hover:text-white shrink-0 px-2 py-1"
            >
              Retry
            </button>
          </div>
        )}

        {/* State: Idle / Wait for User Gesture */}
        {step === 'idle' && (
          <div className="flex flex-col items-center justify-center py-10 space-y-6">
            <div className="w-20 h-20 bg-indigo-900/30 border border-indigo-500/30 rounded-full flex items-center justify-center text-indigo-400 shadow-xl shadow-indigo-500/20">
              <Eye className="w-10 h-10" />
            </div>
            <div className="text-center space-y-1.5">
              <h3 className="text-lg font-bold text-white">Biometric Enclave Ready</h3>
              <p className="text-xs sm:text-sm text-slate-400 max-w-sm mx-auto">
                Tap below to activate the camera, align your face inside the guide, and generate your
                zero-knowledge biometric credentials.
              </p>
            </div>
            <button
              onClick={beginCapture}
              className="px-8 py-3.5 bg-gradient-to-r from-indigo-600 to-indigo-500 hover:from-indigo-500 hover:to-indigo-400 text-white font-bold rounded-2xl shadow-xl shadow-indigo-500/25 transition-all transform active:scale-95 flex items-center gap-2 text-sm"
            >
              <Camera className="w-4 h-4" />
              <span>Start Camera &amp; Face Scan</span>
            </button>
          </div>
        )}

        {/* State: Camera Active */}
        {(step === 'camera' || step === 'processing') && (
          <div className="space-y-6">
            {/* Viewfinder Frame */}
            <div
              className={`relative aspect-[3/4] sm:aspect-video max-w-sm sm:max-w-md mx-auto rounded-3xl overflow-hidden bg-black border-2 transition-all duration-300 shadow-2xl flex items-center justify-center ${
                liveFace.multipleFaces
                  ? 'border-red-400 shadow-[0_0_30px_rgba(248,113,113,0.4)]'
                  : liveFace.aligned
                    ? 'border-emerald-400 shadow-[0_0_35px_rgba(16,185,129,0.4)]'
                    : liveFace.detected
                      ? 'border-amber-400/80 shadow-[0_0_25px_rgba(245,158,11,0.3)]'
                      : 'border-indigo-500/40 shadow-indigo-500/20'
              }`}
            >
              <video
                ref={videoCallbackRef}
                autoPlay
                playsInline
                muted
                onLoadedMetadata={(e) => {
                  const v = e.target as HTMLVideoElement;
                  v.play().catch((err) => {
                    console.warn('Autoplay blocked:', err);
                    setErrorMessage(
                      `The browser blocked video playback (${err?.message || 'autoplay policy'}). Interact with the page and retry.`
                    );
                  });
                }}
                style={{ transform: 'scaleX(-1)' }}
                className={`w-full h-full object-cover ${
                  step === 'processing' ? 'opacity-40 blur-sm' : ''
                }`}
              />

              {/* Dynamic Live Face Alignment Reticle */}
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div
                  className={`w-52 h-68 sm:w-48 sm:h-60 rounded-[48%] transition-all duration-300 ${
                    liveFace.aligned
                      ? 'border-3 border-solid border-emerald-400 bg-emerald-500/10 shadow-[0_0_35px_rgba(16,185,129,0.7)] animate-pulse'
                      : liveFace.detected
                        ? 'border-2 border-dashed border-amber-400/90 bg-amber-500/5 shadow-[0_0_20px_rgba(245,158,11,0.4)]'
                        : 'border-2 border-dashed border-indigo-400/70 shadow-[0_0_15px_rgba(99,102,241,0.25)] animate-pulse-slow'
                  }`}
                />
              </div>

              {/* Corner Framing Crosshairs with Dynamic Colors */}
              <div
                className={`absolute top-4 left-4 w-6 h-6 border-t-2 border-l-2 transition-colors ${
                  liveFace.aligned
                    ? 'border-emerald-400'
                    : liveFace.detected
                      ? 'border-amber-400'
                      : 'border-indigo-400'
                }`}
              />
              <div
                className={`absolute top-4 right-4 w-6 h-6 border-t-2 border-r-2 transition-colors ${
                  liveFace.aligned
                    ? 'border-emerald-400'
                    : liveFace.detected
                      ? 'border-amber-400'
                      : 'border-indigo-400'
                }`}
              />
              <div
                className={`absolute bottom-4 left-4 w-6 h-6 border-b-2 border-l-2 transition-colors ${
                  liveFace.aligned
                    ? 'border-emerald-400'
                    : liveFace.detected
                      ? 'border-amber-400'
                      : 'border-indigo-400'
                }`}
              />
              <div
                className={`absolute bottom-4 right-4 w-6 h-6 border-b-2 border-r-2 transition-colors ${
                  liveFace.aligned
                    ? 'border-emerald-400'
                    : liveFace.detected
                      ? 'border-amber-400'
                      : 'border-indigo-400'
                }`}
              />

              {/* Real-time Status Badge Floating on Viewfinder */}
              <div className="absolute top-4 inset-x-0 flex justify-center pointer-events-none px-4">
                <div
                  className={`px-3.5 py-1.5 rounded-full backdrop-blur-md text-xs font-bold flex items-center gap-2 shadow-lg transition-all duration-300 ${
                    liveFace.multipleFaces
                      ? 'bg-red-950/85 border border-red-400 text-red-300'
                      : liveFace.aligned
                        ? 'bg-emerald-950/85 border border-emerald-400 text-emerald-300 shadow-emerald-500/30'
                        : liveFace.detected
                          ? 'bg-amber-950/85 border border-amber-400 text-amber-300 shadow-amber-500/20'
                          : 'bg-slate-950/80 border border-slate-700 text-slate-300'
                  }`}
                >
                  <span
                    className={`w-2.5 h-2.5 rounded-full ${
                      liveFace.multipleFaces
                        ? 'bg-red-400'
                        : liveFace.aligned
                          ? 'bg-emerald-400 animate-ping'
                          : liveFace.detected
                            ? 'bg-amber-400'
                            : 'bg-slate-400'
                    }`}
                  />
                  <span>
                    {liveFace.multipleFaces
                      ? liveFace.message
                      : liveFace.aligned
                        ? `Face Aligned (${liveFace.score}%) · Ready`
                        : liveFace.detected
                          ? liveFace.message
                          : 'Align face inside oval guide'}
                  </span>
                </div>
              </div>

              {/* Processing Spinner Overlay */}
              {step === 'processing' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center space-y-3 p-4 text-center bg-black/75 backdrop-blur-sm">
                  <div className="w-12 h-12 rounded-full border-3 border-emerald-400 border-t-transparent animate-spin" />
                  <p className="text-xs sm:text-sm font-bold text-white max-w-xs">{statusMessage}</p>
                </div>
              )}
            </div>

            {/* Instruction & Action Button */}
            <div className="text-center space-y-4">
              <p className="text-xs text-slate-400 flex items-center justify-center gap-1.5 font-medium">
                <Lock className="w-3.5 h-3.5 text-emerald-400" />
                Zero Biometric Leakage: tensor extracted in-memory, no photos stored or transmitted.
              </p>

              <div className="flex items-center justify-center">
                <button
                  onClick={handleCaptureAndEnroll}
                  disabled={step === 'processing' || !liveFace.aligned}
                  className={`w-full sm:w-auto px-10 py-4 rounded-2xl font-bold text-xs sm:text-sm shadow-xl transition-all transform active:scale-95 inline-flex items-center justify-center gap-2.5 ${
                    liveFace.aligned && step !== 'processing'
                      ? 'bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white shadow-emerald-500/30 ring-2 ring-emerald-400/50'
                      : 'bg-slate-800 text-slate-500 cursor-not-allowed shadow-none'
                  }`}
                >
                  <Camera className="w-4 h-4" />
                  <span>
                    {step === 'processing'
                      ? 'Committing…'
                      : liveFace.aligned
                        ? 'Capture & Enroll (Face Ready)'
                        : 'Waiting for aligned face…'}
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* State: Enrollment Success */}
        {step === 'success' && enrolledIdentity && (
          <div className="space-y-6 animate-fade-in">
            <div className="p-6 rounded-3xl bg-emerald-950/40 border border-emerald-500/30 text-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 text-emerald-400 mx-auto flex items-center justify-center shadow-lg shadow-emerald-500/20">
                <UserCheck className="w-6 h-6" />
              </div>
              <h2 className="text-xl sm:text-2xl font-black text-white">
                Beneficiary Enrolled Successfully
              </h2>
              <p className="text-xs sm:text-sm text-emerald-300/90 max-w-md mx-auto leading-relaxed">
                Your 128-d biometric embedding was quantized and committed, and the authority
                confirmed the commitment is now a leaf in the cohort Merkle tree. Secret keys are
                sealed in this browser enclave.
              </p>
            </div>

            {/* Issued Credentials Cards */}
            <div className="space-y-3.5 text-xs sm:text-sm">
              {/* DID Card */}
              <div className="p-4 sm:p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-slate-400 font-semibold">
                  <span className="flex items-center gap-1.5 text-slate-200">
                    <Key className="w-4 h-4 text-indigo-400" />
                    Decentralized Identifier (did:key · Ed25519)
                  </span>
                  <button
                    onClick={() => handleCopy(enrolledIdentity.didKey, 'did')}
                    className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300 font-medium text-xs px-2.5 py-1 rounded-lg bg-indigo-500/10 border border-indigo-500/20"
                  >
                    {copiedDID ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>{copiedDID ? 'Copied' : 'Copy DID'}</span>
                  </button>
                </div>
                <div className="font-mono text-white break-all text-xs bg-slate-950/70 p-3 rounded-xl border border-slate-800">
                  {enrolledIdentity.didKey}
                </div>
              </div>

              {/* Public Identity Commitment C_id */}
              <div className="p-4 sm:p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-2">
                <div className="flex items-center justify-between text-slate-400 font-semibold">
                  <span className="flex items-center gap-1.5 text-slate-200">
                    <Shield className="w-4 h-4 text-emerald-400" />
                    Identity Commitment (C_id / Merkle Leaf)
                  </span>
                  <button
                    onClick={() => handleCopy(enrolledIdentity.cId, 'cid')}
                    className="flex items-center gap-1 text-emerald-400 hover:text-emerald-300 font-medium text-xs px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20"
                  >
                    {copiedCID ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    <span>{copiedCID ? 'Copied' : 'Copy C_id'}</span>
                  </button>
                </div>
                <div className="font-mono text-emerald-300 break-all text-xs bg-slate-950/70 p-3 rounded-xl border border-slate-800">
                  {enrolledIdentity.cId}
                </div>
              </div>

              {/* Model binding + resulting cohort root */}
              <div className="p-4 sm:p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-2 font-mono text-[11px] break-all">
                <div>
                  <span className="text-slate-500">bound modelHash: </span>
                  <span className="text-slate-200">{enrolledIdentity.modelHash}</span>
                </div>
                {publishedRoot && (
                  <div>
                    <span className="text-slate-500">cohort root after inclusion: </span>
                    <span className="text-slate-200">{publishedRoot}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Honest operational caveats */}
            <div className="p-4 rounded-2xl bg-amber-950/40 border border-amber-500/30 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-200/90 space-y-2">
                <div className="font-bold text-amber-200">Before you can claim</div>
                <p className="leading-relaxed">
                  Your commitment is in the authority&apos;s tree, but a claim only succeeds once an
                  authorised issuer <strong>publishes this cohort root on-chain</strong> for a policy
                  bound to the same model hash. Until then the claim page will correctly refuse with
                  a root mismatch.
                </p>
                <div className="font-bold text-amber-200 pt-1">Device-bound identity limitation</div>
                <p className="leading-relaxed">
                  For unconditional privacy, your secret identity seed is stored{' '}
                  <strong>solely on this physical device</strong>. If you clear browser data or lose
                  this device without a backup, this identity cannot be recovered by any central
                  authority.
                </p>
              </div>
            </div>

            {/* Next Action */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
              <Link
                href="/claim"
                className="w-full sm:w-auto px-8 py-3.5 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs sm:text-sm inline-flex items-center justify-center gap-2 shadow-xl shadow-emerald-500/25"
              >
                <span>Proceed to Claim Aid</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
              <button
                onClick={() => {
                  setEnrolledIdentity(null);
                  setPublishedRoot('');
                  beginCapture();
                }}
                className="w-full sm:w-auto px-6 py-3.5 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs sm:text-sm inline-flex items-center justify-center gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                <span>Re-enroll</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
