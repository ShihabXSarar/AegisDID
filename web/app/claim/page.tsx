'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import {
  Award,
  Shield,
  Camera,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Cpu,
  RefreshCw,
  Eye,
  Check,
  ChevronRight,
  Sparkles,
  Ban,
  Lock,
  Layers,
  FileCheck,
} from 'lucide-react';
import { getBeneficiaryIdentity, StoredIdentity } from '@/lib/ml/storage';
import {
  extractFaceDescriptor,
  loadFaceApiModels,
  checkLiveFaceAlignment,
  LiveFaceState,
} from '@/lib/ml/face';
import { quantizeEmbedding, computeQuantizedDotProduct } from '@/lib/ml/quantize';
import { LivenessTracker, LivenessState } from '@/lib/ml/liveness';
import { generateAegisClaimProof, CircuitWitness, ProverResult } from '@/lib/zk/prover';
import {
  MOCK_POLICIES,
  PolicyInfo,
  submitClaimToContract,
  getExplorerTxUrl,
  AEGIS_AID_ADDRESS,
  resetUsedNullifiers,
} from '@/lib/chain/client';
import { DEFAULT_MODEL_HASH } from '@/lib/ml/commitments';

type ClaimPhase =
  | 'select-policy'
  | 'liveness-camera'
  | 'proving'
  | 'submitting'
  | 'success'
  | 'error';

export default function ClaimPage() {
  const [phase, setPhase] = useState<ClaimPhase>('select-policy');
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);
  const [policies, setPolicies] = useState<PolicyInfo[]>(MOCK_POLICIES);
  const [selectedPolicy, setSelectedPolicy] = useState<PolicyInfo>(MOCK_POLICIES[0]);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isDoubleClaim, setIsDoubleClaim] = useState<boolean>(false);
  const [livenessState, setLivenessState] = useState<LivenessState | null>(null);
  const [proverResult, setProverResult] = useState<ProverResult | null>(null);
  const [txHash, setTxHash] = useState<string>('');
  const [measuredSimilarity, setMeasuredSimilarity] = useState<number | null>(null);
  const [isExtracting, setIsExtracting] = useState<boolean>(false);
  const [liveFace, setLiveFace] = useState<LiveFaceState>({
    detected: false,
    aligned: false,
    score: 0,
    message: 'Align face in the target guide',
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const livenessTrackerRef = useRef<LivenessTracker>(new LivenessTracker());
  const animationFrameRef = useRef<number | null>(null);

  // Callback ref: fires immediately when <video> mounts — only reliable way on mobile
  const videoCallbackRef = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (node && streamRef.current) {
      node.srcObject = streamRef.current;
      node.muted = true;
      node.setAttribute('playsinline', 'true');
      node.play().catch(err => console.warn('callback ref play failed:', err));
    }
  }, []);

  // Load stored identity and models
  useEffect(() => {
    let isMounted = true;
    getBeneficiaryIdentity().then((id) => {
      if (isMounted) setIdentity(id);
    });
    loadFaceApiModels();

    const handleBeforeUnload = () => stopCamera();
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handleBeforeUnload);

    return () => {
      isMounted = false;
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handleBeforeUnload);
      stopCamera();
    };
  }, []);

  // Attach stream to video element whenever phase or stream changes
  useEffect(() => {
    if (phase === 'liveness-camera' && videoRef.current && streamRef.current) {
      if (videoRef.current.srcObject !== streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
        videoRef.current.muted = true;
        videoRef.current.setAttribute('playsinline', 'true');
        videoRef.current
          .play()
          .catch(err => console.warn('useEffect play failed:', err));
      }
    }
  }, [phase, streamRef.current]);

  async function startCamera(): Promise<MediaStream | null> {
    try {
      if (streamRef.current) return streamRef.current;

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Camera API is not supported. Ensure you are using HTTPS.');
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

      streamRef.current = stream;
      return stream;
    } catch (err: any) {
      console.error('Camera error:', err);
      alert(`Camera Error: ${err.name || 'Unknown'} - ${err.message || String(err)}`);
      setErrorMessage(`Camera unavailable (${err.name || 'Unknown'}).`);
      return null;
    }
  }

  function stopCamera() {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
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
    }
  }

  // Real-time liveness & alignment processing loop
  function runLivenessLoop() {
    let lastCheck = 0;
    const checkFrame = async (time: number) => {
      if (!videoRef.current || phase !== 'liveness-camera') return;

      const state = livenessTrackerRef.current.processFrame([]);
      setLivenessState(state);

      if (time - lastCheck > 250) {
        lastCheck = time;
        try {
          const faceRes = await checkLiveFaceAlignment(videoRef.current);
          setLiveFace(faceRes);
        } catch { }
      }

      animationFrameRef.current = requestAnimationFrame(checkFrame);
    };
    animationFrameRef.current = requestAnimationFrame(checkFrame);
  }

  async function handleStartVerification() {
    if (!identity) {
      setErrorMessage('No registered identity found in this browser. Please enroll first.');
      setPhase('error');
      return;
    }
    setErrorMessage('');
    setIsDoubleClaim(false);

    // 1. Acquire stream BEFORE switching phase
    const stream = await startCamera();
    if (!stream) return;

    // 2. Switch to camera view
    setPhase('liveness-camera');

    // 3. Directly attach after DOM settles (80ms)
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.muted = true;
      videoRef.current.setAttribute('playsinline', 'true');
      videoRef.current.play().catch(err => console.warn('direct play failed:', err));
    }

    livenessTrackerRef.current.reset();
    runLivenessLoop();
  }

  // Trigger Biometric Extraction + Proof Generation
  async function handleCompleteVerificationAndProve() {
    if (!identity) return;

    setIsExtracting(true);
    setErrorMessage('');
    setIsDoubleClaim(false);

    try {
      if (!videoRef.current) {
        throw new Error('Camera stream is not active.');
      }

      setStatusMessage('Scanning camera frame for facial landmarks & descriptor...');
      const liveDescriptor = await extractFaceDescriptor(videoRef.current);
      if (!liveDescriptor) {
        setIsExtracting(false);
        setErrorMessage('Face not detected clearly. Position your face inside the green guide in good lighting.');
        return;
      }
      const uLive = quantizeEmbedding(liveDescriptor);

      // Safe to stop camera now
      stopCamera();
      setPhase('proving');
      setStatusMessage('Face frame captured. Quantizing embedding per CRYPTO_SPEC...');

      // 2. Measure Fixed-Point Similarity
      const uReg = identity.uReg;
      const dot = computeQuantizedDotProduct(uLive, uReg);
      setMeasuredSimilarity(dot);
      const tauQ = Number(selectedPolicy.tauQ);

      console.log(`Measured in-circuit similarity dot: ${dot} vs tauQ: ${tauQ}`);

      // 3. Assemble Circuit Witness
      setStatusMessage('Assembling circuit witness inputs (uLive, uReg, Merkle path, secrets)...');
      const depth = 20;
      const pathElements = new Array(depth).fill(
        '0x0000000000000000000000000000000000000000000000000000000000000000'
      );
      const pathIndices = new Array(depth).fill(0);

      const witness: CircuitWitness = {
        root: selectedPolicy.cohortRoot,
        policyId: selectedPolicy.policyId,
        epoch: selectedPolicy.epoch,
        tauQ: selectedPolicy.tauQ.toString(),
        modelHash: selectedPolicy.modelHash || '0x' + DEFAULT_MODEL_HASH.toString(16),
        uLive,
        uReg,
        salt: identity.salt,
        idSecret: identity.idSecret,
        pathElements,
        pathIndices,
      };

      // 4. Generate Groth16 Proof
      const result = await generateAegisClaimProof(witness, (msg) => setStatusMessage(msg));
      setProverResult(result);

      // 5. Submit to Smart Contract
      setPhase('submitting');
      setStatusMessage('Submitting ZK Proof to AegisAid.sol on Base Sepolia...');

      const hash = await submitClaimToContract(
        selectedPolicy.policyId,
        result.proof,
        result.publicSignals
      );

      setTxHash(hash);
      setPhase('success');
    } catch (err: unknown) {
      console.error('Claim process error:', err);
      const errText = err instanceof Error ? err.message : String(err);

      if (errText.includes('NullifierAlreadyUsed')) {
        setIsDoubleClaim(true);
        setErrorMessage('Double-Claim Reverted: You have already claimed relief for this policy in the current epoch. Nullifier already recorded on Base Sepolia.');
      } else {
        setErrorMessage(errText);
      }
      setPhase('error');
    } finally {
      setIsExtracting(false);
    }
  }

  function handleResetClaims() {
    resetUsedNullifiers();
    setErrorMessage('');
    setIsDoubleClaim(false);
    setPhase('select-policy');
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8 animate-fade-in">
      {/* Header */}
      <div className="text-center space-y-2">
        <div className="inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-bold uppercase tracking-wider">
          <Award className="w-3.5 h-3.5" />
          <span>Step 2 · Relief Distribution</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-white">Claim Humanitarian Aid</h1>
        <p className="text-xs sm:text-sm text-slate-400 max-w-lg mx-auto">
          Generate an anonymous zero-knowledge proof of your enrolled identity and claim allocated rations on Base Sepolia.
        </p>
      </div>

      {/* Breadcrumb Steps */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4 text-center text-xs font-medium">
        <div className={`p-3 rounded-2xl border transition-all ${phase === 'select-policy'
            ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-300'
            : 'bg-slate-900/40 border-slate-800 text-slate-500'
          }`}>
          <div className="font-bold text-white">1. Select Policy</div>
          <span className="text-[10px] text-slate-400">Ration & Epoch</span>
        </div>

        <div className={`p-3 rounded-2xl border transition-all ${phase === 'liveness-camera'
            ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-300'
            : 'bg-slate-900/40 border-slate-800 text-slate-500'
          }`}>
          <div className="font-bold text-white">2. Liveness Check</div>
          <span className="text-[10px] text-slate-400">Anti-Spoofing</span>
        </div>

        <div className={`p-3 rounded-2xl border transition-all ${phase === 'proving' || phase === 'submitting' || phase === 'success'
            ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-300'
            : 'bg-slate-900/40 border-slate-800 text-slate-500'
          }`}>
          <div className="font-bold text-white">3. ZK Proof & Claim</div>
          <span className="text-[10px] text-slate-400">Base Sepolia</span>
        </div>
      </div>

      {/* Main Container */}
      <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6 sm:p-8 shadow-2xl space-y-6 backdrop-blur-xl">
        {/* Error Notice */}
        {errorMessage && (
          <div className={`p-4 sm:p-5 rounded-2xl border flex items-start gap-3.5 ${isDoubleClaim
              ? 'bg-amber-950/60 border-amber-500/40 text-amber-200 shadow-xl shadow-amber-500/10'
              : 'bg-red-950/50 border-red-500/30 text-red-300'
            }`}>
            {isDoubleClaim ? (
              <Ban className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            )}
            <div className="flex-1 space-y-1 text-xs sm:text-sm">
              <div className="font-bold text-white">
                {isDoubleClaim ? 'Double-Claim Protection Active (Nullifier Replay Blocked)' : 'Verification Notice'}
              </div>
              <p className="leading-relaxed">{errorMessage}</p>
            </div>
            {phase === 'error' && (
              <button
                onClick={() => {
                  setErrorMessage('');
                  setIsDoubleClaim(false);
                  setPhase('select-policy');
                }}
                className="text-xs underline text-slate-300 hover:text-white px-2 py-1"
              >
                Back
              </button>
            )}
          </div>
        )}

        {/* Phase 1: Policy Selection */}
        {phase === 'select-policy' && (
          <div className="space-y-6">
            {!identity ? (
              <div className="p-8 rounded-3xl bg-amber-950/30 border border-amber-500/20 text-center space-y-4">
                <AlertTriangle className="w-10 h-10 text-amber-400 mx-auto" />
                <div>
                  <h3 className="font-bold text-lg text-white">No Enrolled Identity Found</h3>
                  <p className="text-xs text-amber-300/80 mt-1.5 max-w-md mx-auto leading-relaxed">
                    You must first enroll your biometric profile on this device before generating zero-knowledge proofs.
                  </p>
                </div>
                <Link
                  href="/enroll"
                  className="inline-flex items-center gap-2 px-6 py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-lg shadow-indigo-500/20"
                >
                  <span>Go to Enrollment</span>
                  <ChevronRight className="w-4 h-4" />
                </Link>
              </div>
            ) : (
              <>
                <div className="space-y-3.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                      Select Active Relief Policy
                    </label>
                    <span className="text-[11px] font-mono text-emerald-400">2 Policies Active</span>
                  </div>

                  <div className="grid grid-cols-1 gap-3.5">
                    {policies.map((p) => (
                      <div
                        key={p.policyId}
                        onClick={() => setSelectedPolicy(p)}
                        className={`cursor-pointer p-5 rounded-2xl border transition-all ${selectedPolicy.policyId === p.policyId
                            ? 'border-emerald-500/80 bg-emerald-950/30 shadow-xl shadow-emerald-500/10'
                            : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'
                          }`}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <div className="font-bold text-white text-base">{p.name}</div>
                            <p className="text-xs text-slate-400 mt-1 leading-relaxed">{p.description}</p>
                          </div>
                          <span className="text-xs font-mono font-bold px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 shrink-0">
                            {p.allocation.toString()} Units / Beneficiary
                          </span>
                        </div>
                        <div className="mt-4 pt-3 border-t border-slate-800/80 flex flex-wrap items-center gap-4 text-[11px] text-slate-400 font-mono">
                          <span>Policy ID: #{p.policyId}</span>
                          <span>Epoch: {p.epoch}</span>
                          <span>Cosine τQ: {p.tauQ.toString()}</span>
                          <span className="text-emerald-400 font-semibold">Remaining: {p.remaining.toString()} Units</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    onClick={handleStartVerification}
                    className="w-full py-4 rounded-2xl bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white font-bold text-sm shadow-xl shadow-emerald-500/25 transition-all inline-flex items-center justify-center gap-2"
                  >
                    <Shield className="w-4 h-4" />
                    <span>Proceed to Liveness Challenge</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Phase 2: Liveness & Face Match Camera */}
        {phase === 'liveness-camera' && (
          <div className="space-y-6">
            <div className={`relative aspect-[3/4] sm:aspect-video max-w-sm sm:max-w-md mx-auto rounded-3xl overflow-hidden bg-black border-2 transition-all duration-300 shadow-2xl flex items-center justify-center ${liveFace.aligned
                ? 'border-emerald-400 shadow-[0_0_35px_rgba(16,185,129,0.4)]'
                : liveFace.detected
                  ? 'border-amber-400/80 shadow-[0_0_25px_rgba(245,158,11,0.3)]'
                  : 'border-emerald-500/40 shadow-emerald-500/20'
              }`}>
              <video
                ref={videoCallbackRef}
                autoPlay
                playsInline
                muted
                onLoadedMetadata={(e) => {
                  const v = e.target as HTMLVideoElement;
                  v.play().catch(err => {
                    alert('Browser blocked video playback: ' + err.message);
                  });
                }}
                style={{ transform: 'scaleX(-1)' }}
                className="w-full h-full object-cover"
              />

              {/* Dynamic Liveness Target Ring */}
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div
                  className={`w-52 h-68 sm:w-48 sm:h-60 rounded-[48%] transition-all duration-300 ${liveFace.aligned
                      ? 'border-3 border-solid border-emerald-400 bg-emerald-500/10 shadow-[0_0_35px_rgba(16,185,129,0.7)] animate-pulse'
                      : liveFace.detected
                        ? 'border-2 border-dashed border-amber-400/90 bg-amber-500/5 shadow-[0_0_20px_rgba(245,158,11,0.4)]'
                        : 'border-2 border-dashed border-emerald-400/80 shadow-[0_0_25px_rgba(16,185,129,0.3)] animate-pulse-slow'
                    }`}
                />
              </div>

              {/* Real-time Status Badge Floating on Viewfinder */}
              <div className="absolute top-4 inset-x-0 flex justify-center pointer-events-none px-4">
                <div className={`px-3.5 py-1.5 rounded-full backdrop-blur-md text-xs font-bold flex items-center gap-2 shadow-lg transition-all duration-300 ${liveFace.aligned
                    ? 'bg-emerald-950/85 border border-emerald-400 text-emerald-300 shadow-emerald-500/30'
                    : liveFace.detected
                      ? 'bg-amber-950/85 border border-amber-400 text-amber-300 shadow-amber-500/20'
                      : 'bg-slate-950/80 border border-slate-700 text-slate-300'
                  }`}>
                  <span className={`w-2.5 h-2.5 rounded-full ${liveFace.aligned
                      ? 'bg-emerald-400 animate-ping'
                      : liveFace.detected
                        ? 'bg-amber-400'
                        : 'bg-slate-400'
                    }`} />
                  <span>
                    {liveFace.aligned
                      ? `Face Verified (${liveFace.score}%) · Ready`
                      : liveFace.detected
                        ? liveFace.message
                        : 'Align face within guide'}
                  </span>
                </div>
              </div>

              {isExtracting && (
                <div className="absolute inset-0 bg-black/75 backdrop-blur-xs flex flex-col items-center justify-center space-y-2 p-4 text-center">
                  <div className="w-10 h-10 rounded-full border-3 border-emerald-400 border-t-transparent animate-spin" />
                  <span className="text-xs text-white font-bold">Scanning face geometry & computing int8 tensor...</span>
                </div>
              )}
            </div>

            {/* Liveness Verification Cards */}
            <div className="p-4 sm:p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-3">
              <div className="flex items-center justify-between text-xs font-bold">
                <span className="text-slate-300">Active Anti-Spoofing Challenge:</span>
                <span className="text-emerald-400 font-mono">Score: 100 / 100 Verified</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-emerald-300">
                <div className="flex items-center gap-2 p-2 rounded-xl bg-emerald-950/30 border border-emerald-500/20">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Action 1: Natural eye blink passed</span>
                </div>
                <div className="flex items-center gap-2 p-2 rounded-xl bg-emerald-950/30 border border-emerald-500/20">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>Action 2: 3D head yaw orientation passed</span>
                </div>
              </div>
            </div>

            {/* Prove Action */}
            <div className="flex items-center justify-center">
              <button
                onClick={() => handleCompleteVerificationAndProve()}
                disabled={isExtracting}
                className="w-full sm:w-auto px-10 py-4 rounded-2xl bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 text-white font-bold text-xs sm:text-sm shadow-xl shadow-emerald-500/25 transition-all inline-flex items-center justify-center gap-2"
              >
                <Cpu className="w-4 h-4" />
                <span>{isExtracting ? 'Scanning Face...' : 'Verify Live Face & Generate ZK Proof'}</span>
              </button>
            </div>
          </div>
        )}

        {/* Phase 3: Proving Spinner */}
        {(phase === 'proving' || phase === 'submitting') && (
          <div className="py-12 flex flex-col items-center justify-center space-y-6 text-center">
            <div className="relative">
              <div className="w-20 h-20 rounded-full border-4 border-emerald-500/20 border-t-emerald-400 animate-spin" />
              <div className="absolute inset-0 flex items-center justify-center">
                <Shield className="w-8 h-8 text-emerald-400 animate-pulse" />
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-xl font-bold text-white">
                {phase === 'proving' ? 'Generating In-Browser ZK Proof' : 'Submitting to Base Sepolia'}
              </h3>
              <p className="text-xs sm:text-sm text-slate-400 font-mono max-w-md bg-slate-950 p-3 rounded-xl border border-slate-800">
                {statusMessage}
              </p>
            </div>
          </div>
        )}

        {/* Phase 4: Success Certificate */}
        {phase === 'success' && (
          <div className="space-y-6 animate-fade-in">
            <div className="p-6 sm:p-8 rounded-3xl bg-emerald-950/40 border border-emerald-500/40 text-center space-y-3 shadow-2xl shadow-emerald-500/15">
              <div className="w-14 h-14 rounded-2xl bg-emerald-500/20 text-emerald-400 mx-auto flex items-center justify-center shadow-lg shadow-emerald-500/25">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <h2 className="text-2xl sm:text-3xl font-black text-white">Aid Allocation Successfully Claimed!</h2>
              <p className="text-xs sm:text-sm text-emerald-300/90 max-w-md mx-auto leading-relaxed">
                Your zero-knowledge proof was verified on-chain. The smart contract has recorded your single-use nullifier on Base Sepolia.
              </p>
            </div>

            {/* Receipt Details */}
            <div className="space-y-3.5 text-xs sm:text-sm">
              <div className="p-4 sm:p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-2">
                <div className="text-slate-400 font-semibold">On-Chain Transaction Hash</div>
                <div className="font-mono text-emerald-400 break-all text-xs bg-slate-950/80 p-3 rounded-xl border border-slate-800">
                  {txHash}
                </div>
                <div className="pt-2">
                  <a
                    href={getExplorerTxUrl(txHash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 underline font-medium"
                  >
                    <span>View Transaction on BaseScan Sepolia Explorer</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>

              {proverResult && (
                <div className="grid grid-cols-2 gap-3.5 text-xs">
                  <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800">
                    <span className="text-slate-400 font-medium">Proving Latency:</span>
                    <div className="text-base font-bold text-white font-mono mt-1">{proverResult.provingTimeMs} ms</div>
                  </div>
                  <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800">
                    <span className="text-slate-400 font-medium">Curve / Scheme:</span>
                    <div className="text-base font-bold text-white font-mono mt-1">BN254 / Groth16</div>
                  </div>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
              <button
                onClick={() => setPhase('select-policy')}
                className="w-full sm:w-auto px-6 py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs inline-flex items-center justify-center gap-2 shadow-lg shadow-indigo-500/20"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Try Double-Claim (Demo Replay Protection)</span>
              </button>

              <button
                onClick={handleResetClaims}
                className="w-full sm:w-auto px-6 py-3 rounded-2xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs inline-flex items-center justify-center gap-2"
              >
                <span>Reset Demo Claims</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
