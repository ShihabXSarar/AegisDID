'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import {
  Award,
  Shield,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  Cpu,
  RefreshCw,
  ChevronRight,
  Ban,
  Layers,
} from 'lucide-react';
import { getBeneficiaryIdentity, StoredIdentity } from '@/lib/ml/storage';
import {
  extractFaceDescriptor,
  loadFaceApiModels,
  checkLiveFaceAlignment,
  LiveFaceState,
  MultipleFacesError,
} from '@/lib/ml/face';
import { quantizeEmbedding, computeQuantizedDotProduct } from '@/lib/ml/quantize';
import { LivenessTracker, LivenessState } from '@/lib/ml/liveness';
import { generateAegisClaimProof, CircuitWitness, ProverResult } from '@/lib/zk/prover';
import {
  fetchActivePolicies,
  PolicyInfo,
  submitClaimToContract,
  getExplorerTxUrl,
  AEGIS_AID_ADDRESS,
  checkCohortRoot,
  isNullifierUsed,
  ROOT_MISMATCH_MESSAGE,
  tauQUnsoundMessage,
  CHAIN_LABEL,
  IS_LOCAL_CHAIN,
  isTauQSound,
  MIN_TAU_Q,
  MAX_TAU_Q,
} from '@/lib/chain/client';
import { DEFAULT_MODEL_HASH, computeNullifier } from '@/lib/ml/commitments';

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
  const [policies, setPolicies] = useState<PolicyInfo[]>([]);
  const [selectedPolicy, setSelectedPolicy] = useState<PolicyInfo | null>(null);
  const [isLoadingPolicies, setIsLoadingPolicies] = useState<boolean>(true);
  const [policyLoadError, setPolicyLoadError] = useState<string>('');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [isDoubleClaim, setIsDoubleClaim] = useState<boolean>(false);
  const [livenessState, setLivenessState] = useState<LivenessState | null>(null);
  const [proverResult, setProverResult] = useState<ProverResult | null>(null);
  const [txHash, setTxHash] = useState<string>('');
  const [claimedRoot, setClaimedRoot] = useState<string>('');
  const [claimedNullifier, setClaimedNullifier] = useState<string>('');
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
  const isMountedRef = useRef<boolean>(true);
  const isStartingCameraRef = useRef<boolean>(false);
  const detectingRef = useRef<boolean>(false);
  /**
   * Monotonic token identifying the current detection loop. Incrementing it makes every
   * previously-scheduled frame callback return immediately, so re-entering the camera phase
   * can never leave two loops feeding the same LivenessTracker.
   */
  const loopGenRef = useRef<number>(0);

  // Callback ref: fires immediately when <video> mounts — only reliable way on mobile
  const videoCallbackRef = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    if (node && streamRef.current) {
      node.srcObject = streamRef.current;
      node.muted = true;
      node.setAttribute('playsinline', 'true');
      node.play().catch((err) => console.warn('callback ref play failed:', err));
    }
  }, []);

  const loadPolicies = useCallback(() => {
    setIsLoadingPolicies(true);
    setPolicyLoadError('');
    return fetchActivePolicies()
      .then((fetchedPolicies) => {
        if (!isMountedRef.current) return;
        setPolicies(fetchedPolicies);
        setSelectedPolicy((prev) => {
          if (prev) {
            const still = fetchedPolicies.find((p) => p.policyId === prev.policyId);
            if (still) return still;
          }
          return fetchedPolicies[0] ?? null;
        });
        setIsLoadingPolicies(false);
      })
      .catch((err: unknown) => {
        console.error('Failed to fetch policies:', err);
        if (!isMountedRef.current) return;
        setIsLoadingPolicies(false);
        setPolicyLoadError(
          `Could not read policies from ${CHAIN_LABEL} at ${AEGIS_AID_ADDRESS}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      });
  }, []);

  // Load stored identity, on-chain policies, and the face models
  useEffect(() => {
    isMountedRef.current = true;
    getBeneficiaryIdentity().then((id) => {
      if (isMountedRef.current) setIdentity(id);
    });

    loadPolicies();
    loadFaceApiModels().catch((err) => console.error('Model load failed:', err));

    const handleBeforeUnload = () => stopCamera();
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener('pagehide', handleBeforeUnload);

    return () => {
      isMountedRef.current = false;
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.removeEventListener('pagehide', handleBeforeUnload);
      stopCamera();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Attach the stream whenever the camera phase mounts the <video>
  useEffect(() => {
    if (phase === 'liveness-camera' && videoRef.current && streamRef.current) {
      if (videoRef.current.srcObject !== streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
        videoRef.current.muted = true;
        videoRef.current.setAttribute('playsinline', 'true');
        videoRef.current.play().catch((err) => console.warn('useEffect play failed:', err));
      }
    }
  }, [phase]);

  async function startCamera(): Promise<MediaStream | null> {
    try {
      if (isStartingCameraRef.current) return null;

      if (streamRef.current) {
        const hasActiveTracks = streamRef.current.getTracks().some((t) => t.readyState === 'live');
        if (hasActiveTracks) return streamRef.current;
        stopCamera();
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
      console.error('Camera error:', err);
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

  /** Invalidate the current detection loop so no further frames are processed. */
  function stopLivenessLoop() {
    loopGenRef.current += 1;
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }

  function stopCamera() {
    stopLivenessLoop();
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

  /** Leave the camera phase and clear all liveness evidence. */
  function abandonLiveness(nextPhase: ClaimPhase) {
    stopCamera();
    livenessTrackerRef.current.reset();
    setLivenessState(null);
    setLiveFace({
      detected: false,
      aligned: false,
      score: 0,
      message: 'Align face in the target guide',
    });
    setPhase(nextPhase);
  }

  // Real-time liveness & alignment loop. Sequential mutex prevents overlapping inference.
  function runLivenessLoop() {
    const myGen = ++loopGenRef.current;

    const checkFrame = () => {
      if (myGen !== loopGenRef.current) return; // superseded
      if (!isMountedRef.current || !videoRef.current) return;

      if (!detectingRef.current) {
        detectingRef.current = true;

        checkLiveFaceAlignment(videoRef.current)
          .then((faceRes) => {
            if (myGen !== loopGenRef.current) return;
            setLiveFace(faceRes);
            // A frame with more than one face contributes no landmarks to the challenge.
            const landmarks = faceRes.multipleFaces ? [] : faceRes.landmarks || [];
            setLivenessState(livenessTrackerRef.current.processFrame(landmarks));
          })
          .catch((err) => {
            console.error('runLivenessLoop error:', err);
          })
          .finally(() => {
            detectingRef.current = false;
          });
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
    if (!selectedPolicy) return;

    setErrorMessage('');
    setIsDoubleClaim(false);
    setMeasuredSimilarity(null);
    setProverResult(null);
    setTxHash('');
    setClaimedRoot('');
    setClaimedNullifier('');

    // Pre-flight: block the whole flow on conditions that make a valid claim impossible,
    // BEFORE asking for the camera. Each check states the real reason.
    const preflight = await runPreflight(selectedPolicy, identity);
    if (preflight) {
      setErrorMessage(preflight);
      setPhase('error');
      return;
    }

    const stream = await startCamera();
    if (!stream) {
      setPhase('error');
      return;
    }

    setLivenessState(null);
    setPhase('liveness-camera');

    // Let the <video> mount before attaching the stream.
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.muted = true;
      videoRef.current.setAttribute('playsinline', 'true');
      videoRef.current.play().catch((err) => console.warn('direct play failed:', err));
    }

    livenessTrackerRef.current.reset();
    runLivenessLoop();
  }

  /**
   * Checks that can be made before any biometric capture. Returns an error string to abort
   * with, or null to proceed. Almost nothing here is a security control the contract relies on —
   * these conditions are also enforced by the circuit or by AegisAid.sol, and they exist so a
   * doomed claim fails with an honest reason instead of an opaque prover assert.
   *
   * The tauQ soundness check is the one exception: the AegisAid bytecode currently deployed to
   * Base Sepolia predates MIN_TAU_Q/MAX_TAU_Q, so for those policies this really is the only
   * enforcement point. See tauQUnsoundMessage in lib/chain/client.ts.
   */
  async function runPreflight(policy: PolicyInfo, id: StoredIdentity): Promise<string | null> {
    if (policy.tauQUnsound) {
      return tauQUnsoundMessage(policy.policyId, policy.tauQ);
    }

    if (policy.rootUnpublished) {
      return `Policy #${policy.policyId} has no published cohort root (root is 0x00…0). ${ROOT_MISMATCH_MESSAGE}`;
    }

    // The circuit recomputes C_id from the *public* modelHash. If the policy was created for
    // a different feature extractor than the one that produced this enrollment, the derived
    // leaf simply is not in the cohort tree.
    let policyModelHash: bigint;
    try {
      policyModelHash = BigInt(policy.modelHash);
    } catch {
      return `Policy #${policy.policyId} has an unreadable modelHash (${policy.modelHash}).`;
    }
    if (policyModelHash !== DEFAULT_MODEL_HASH) {
      return (
        `Model mismatch. Policy #${policy.policyId} is bound to modelHash ${policy.modelHash}, ` +
        `but this device runs the face-api.js weight set with modelHash 0x${DEFAULT_MODEL_HASH.toString(16)}. ` +
        `A proof for this policy cannot be produced from this enrollment — the authority must publish a policy for the current model.`
      );
    }
    if (id.modelHash && BigInt(id.modelHash) !== policyModelHash) {
      return (
        `Your enrolled commitment was bound to modelHash ${id.modelHash}, which does not match ` +
        `policy #${policy.policyId} (${policy.modelHash}). Re-enroll against the current model.`
      );
    }

    // Nullifier pre-flight — the contract is still the authority here, this only avoids
    // spending 10s of proving time on a claim that is already spent.
    try {
      const nf = await computeNullifier(BigInt(id.idSecret), policy.policyId, policy.epoch);
      const used = await isNullifierUsed(policy.policyId, nf);
      if (used) {
        setIsDoubleClaim(true);
        return (
          `Already claimed. Nullifier ${nf.toString()} is recorded on ${CHAIN_LABEL} for policy ` +
          `#${policy.policyId} epoch ${policy.epoch}. One claim per identity per epoch.`
        );
      }
    } catch (err) {
      console.warn('Nullifier pre-flight check failed (continuing; contract still enforces it):', err);
    }

    if (policy.remaining < policy.allocation) {
      return (
        `Allocation exhausted. Policy #${policy.policyId} has ${policy.remaining.toString()} units left, ` +
        `below the ${policy.allocation.toString()}-unit per-beneficiary allocation.`
      );
    }

    return null;
  }

  async function handleCompleteVerificationAndProve() {
    if (!identity || !selectedPolicy) return;

    // Gate strictly on the tracker's latched result.
    if (!livenessState?.isComplete) {
      setErrorMessage(
        'Liveness challenge not completed. Perform the requested actions in the order shown.'
      );
      return;
    }

    setIsExtracting(true);
    setErrorMessage('');
    setIsDoubleClaim(false);

    try {
      if (!videoRef.current) throw new Error('Camera stream is not active.');

      setStatusMessage('Scanning camera frame for facial landmarks & descriptor...');
      let liveDescriptor: number[] | null;
      try {
        liveDescriptor = await extractFaceDescriptor(videoRef.current);
      } catch (err) {
        if (err instanceof MultipleFacesError) {
          setIsExtracting(false);
          setErrorMessage(`${err.message} Ensure nobody else is visible behind you, then retry.`);
          return;
        }
        throw err;
      }

      if (!liveDescriptor) {
        setIsExtracting(false);
        setErrorMessage(
          'No face could be extracted from the frame. Move into good, even lighting, fill the oval guide, and retry.'
        );
        return;
      }

      const uLive = quantizeEmbedding(liveDescriptor);

      // Biometric capture is done — release the camera.
      stopCamera();
      setPhase('proving');
      setStatusMessage('Frame captured. Quantizing embedding to int8 per CRYPTO_SPEC...');

      // --- Fixed-point similarity, exactly as the circuit computes it ---
      const uReg = identity.uReg;
      const dot = computeQuantizedDotProduct(uLive, uReg);
      setMeasuredSimilarity(dot);

      // Re-checked here as well as in runPreflight: the policy list is refreshed asynchronously,
      // so the selected policy could in principle have been read again between the two points.
      // Number(selectedPolicy.tauQ) below is only safe once tauQ is known to be <= 16129.
      if (!isTauQSound(selectedPolicy.tauQ)) {
        throw new Error(tauQUnsoundMessage(selectedPolicy.policyId, selectedPolicy.tauQ));
      }

      const tauQ = Number(selectedPolicy.tauQ);
      console.log(`Measured in-circuit similarity dot=${dot} vs tauQ=${tauQ}`);

      if (dot < tauQ) {
        throw new Error(
          `Biometric match failed. Measured in-circuit similarity is ${dot}, below the policy threshold ` +
            `tauQ=${tauQ} (cosine ${(dot / (127 * 127)).toFixed(4)} < ${(tauQ / (127 * 127)).toFixed(4)}). ` +
            `The live face does not match the enrolled template on this device.`
        );
      }

      // --- Merkle path from the authority, then root agreement with the contract ---
      setStatusMessage('Requesting Merkle inclusion path from the authority...');
      const pathRes = await fetch(`/api/merkle/path?commitment=${identity.cId}`);
      if (!pathRes.ok) {
        const errorData = await pathRes.json().catch(() => ({}));
        throw new Error(
          errorData.error ||
            `Authority returned HTTP ${pathRes.status} for the Merkle path. This commitment may not be enrolled.`
        );
      }
      const pathData = await pathRes.json();
      const pathElements: string[] = pathData.pathElements;
      const pathIndices: number[] = pathData.pathIndices;

      if (!Array.isArray(pathElements) || !Array.isArray(pathIndices) || !pathData.root) {
        throw new Error('Authority returned a malformed Merkle path response.');
      }

      const apiRoot = '0x' + BigInt(pathData.root).toString(16);

      // §16 root validation — BEFORE any proving work. The root is never repaired locally.
      setStatusMessage(`Comparing authority root against the on-chain cohort root on ${CHAIN_LABEL}...`);
      const rootCheck = await checkCohortRoot(selectedPolicy.policyId, apiRoot);
      if (!rootCheck.matches) {
        console.error('Root mismatch', {
          apiRoot,
          onChainRoot: rootCheck.onChainRoot,
          policyId: selectedPolicy.policyId,
        });
        throw new Error(ROOT_MISMATCH_MESSAGE);
      }
      setClaimedRoot(rootCheck.onChainRoot);

      // --- Witness assembly. Every public value comes from the contract. ---
      const witness: CircuitWitness = {
        root: rootCheck.onChainRoot,
        policyId: selectedPolicy.policyId,
        epoch: selectedPolicy.epoch,
        tauQ: selectedPolicy.tauQ.toString(),
        modelHash: selectedPolicy.modelHash,
        uLive,
        uReg,
        salt: identity.salt,
        idSecret: identity.idSecret,
        pathElements,
        pathIndices,
      };

      const result = await generateAegisClaimProof(witness, (msg) => setStatusMessage(msg));
      setProverResult(result);
      setClaimedNullifier(result.publicSignals[0]);

      setPhase('submitting');
      setStatusMessage(`Submitting Groth16 proof to AegisAid.claimAid on ${CHAIN_LABEL}...`);

      const hash = await submitClaimToContract(
        selectedPolicy.policyId,
        result.proof,
        result.publicSignals
      );

      setTxHash(hash);
      setPhase('success');
      loadPolicies(); // refresh remaining allocation from chain
    } catch (err: unknown) {
      console.error('Claim process error:', err);
      const errText = err instanceof Error ? err.message : String(err);

      if (errText.includes('NullifierAlreadyUsed')) {
        setIsDoubleClaim(true);
        setErrorMessage(
          'Double-claim reverted by AegisAid.sol: this nullifier is already recorded for this policy and epoch.'
        );
      } else if (errText.includes('AllocationExhausted')) {
        setErrorMessage('Reverted by AegisAid.sol: the policy allocation is exhausted.');
      } else if (errText.includes('PolicyInactive')) {
        setErrorMessage('Reverted by AegisAid.sol: this policy is not active.');
      } else if (errText.includes('User rejected') || errText.includes('user rejected')) {
        setErrorMessage('Transaction rejected in the wallet. No claim was submitted.');
      } else {
        setErrorMessage(errText);
      }
      setPhase('error');
    } finally {
      setIsExtracting(false);
    }
  }

  const timedOut = livenessState?.isTimedOut === true;

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
          Generate an anonymous zero-knowledge proof of your enrolled identity and claim allocated
          rations on {CHAIN_LABEL}.
        </p>
      </div>

      {/* Breadcrumb Steps */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4 text-center text-xs font-medium">
        <div
          className={`p-3 rounded-2xl border transition-all ${
            phase === 'select-policy'
              ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-300'
              : 'bg-slate-900/40 border-slate-800 text-slate-500'
          }`}
        >
          <div className="font-bold text-white">1. Select Policy</div>
          <span className="text-[10px] text-slate-400">Ration &amp; Epoch</span>
        </div>

        <div
          className={`p-3 rounded-2xl border transition-all ${
            phase === 'liveness-camera'
              ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-300'
              : 'bg-slate-900/40 border-slate-800 text-slate-500'
          }`}
        >
          <div className="font-bold text-white">2. Liveness Check</div>
          <span className="text-[10px] text-slate-400">Anti-Spoofing</span>
        </div>

        <div
          className={`p-3 rounded-2xl border transition-all ${
            phase === 'proving' || phase === 'submitting' || phase === 'success'
              ? 'bg-emerald-950/40 border-emerald-500/50 text-emerald-300'
              : 'bg-slate-900/40 border-slate-800 text-slate-500'
          }`}
        >
          <div className="font-bold text-white">3. ZK Proof &amp; Claim</div>
          <span className="text-[10px] text-slate-400">{CHAIN_LABEL}</span>
        </div>
      </div>

      {/* Main Container */}
      <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6 sm:p-8 shadow-2xl space-y-6 backdrop-blur-xl">
        {/* Error / notice banner */}
        {errorMessage && (
          <div
            className={`p-4 sm:p-5 rounded-2xl border flex items-start gap-3.5 ${
              isDoubleClaim
                ? 'bg-amber-950/60 border-amber-500/40 text-amber-200 shadow-xl shadow-amber-500/10'
                : 'bg-red-950/50 border-red-500/30 text-red-300'
            }`}
          >
            {isDoubleClaim ? (
              <Ban className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            )}
            <div className="flex-1 space-y-1 text-xs sm:text-sm">
              <div className="font-bold text-white">
                {isDoubleClaim
                  ? 'Double-Claim Protection Active (Nullifier Replay Blocked)'
                  : 'Claim Blocked'}
              </div>
              <p className="leading-relaxed break-words">{errorMessage}</p>
              {measuredSimilarity !== null && selectedPolicy && (
                <p className="font-mono text-[11px] text-slate-400 pt-1">
                  measured dot = {measuredSimilarity} · policy tauQ ={' '}
                  {selectedPolicy.tauQ.toString()}
                </p>
              )}
            </div>
            {phase === 'error' && (
              <button
                onClick={() => {
                  setErrorMessage('');
                  setIsDoubleClaim(false);
                  abandonLiveness('select-policy');
                }}
                className="text-xs underline text-slate-300 hover:text-white px-2 py-1 shrink-0"
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
                    You must first enroll your biometric profile on this device before generating
                    zero-knowledge proofs.
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
                    <span className="text-[11px] font-mono text-emerald-400">
                      {policies.length} active on {CHAIN_LABEL}
                    </span>
                  </div>

                  {isLoadingPolicies ? (
                    <div className="p-8 text-center text-slate-400 text-sm">
                      <div className="animate-pulse">Reading PolicyCreated logs from {CHAIN_LABEL}…</div>
                    </div>
                  ) : policyLoadError ? (
                    <div className="p-5 space-y-3 text-center border border-red-500/30 bg-red-950/30 rounded-2xl">
                      <p className="text-xs text-red-300 break-words font-mono">{policyLoadError}</p>
                      <button
                        onClick={() => loadPolicies()}
                        className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold inline-flex items-center gap-2"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Retry
                      </button>
                    </div>
                  ) : policies.length === 0 ? (
                    <div className="p-6 space-y-3 text-center text-amber-300 text-sm border border-amber-500/20 bg-amber-950/20 rounded-2xl">
                      <p className="text-xs leading-relaxed">
                        No policy on {CHAIN_LABEL} at{' '}
                        <span className="font-mono">{AEGIS_AID_ADDRESS}</span> is currently active.
                        An authorised issuer must create and activate a policy in the dashboard.
                      </p>
                      <button
                        onClick={() => loadPolicies()}
                        className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold inline-flex items-center gap-2"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Refresh
                      </button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-3.5">
                      {policies.map((p) => {
                        const modelMatches = (() => {
                          try {
                            return BigInt(p.modelHash) === DEFAULT_MODEL_HASH;
                          } catch {
                            return false;
                          }
                        })();
                        const claimable = !p.rootUnpublished && modelMatches && !p.tauQUnsound;
                        return (
                          <div
                            key={p.policyId}
                            onClick={() => setSelectedPolicy(p)}
                            className={`cursor-pointer p-5 rounded-2xl border transition-all ${
                              selectedPolicy?.policyId === p.policyId
                                ? 'border-emerald-500/80 bg-emerald-950/30 shadow-xl shadow-emerald-500/10'
                                : 'border-slate-800 bg-slate-900/40 hover:border-slate-700'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-4">
                              <div>
                                <div className="font-bold text-white text-base">{p.name}</div>
                                <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                                  {p.description}
                                </p>
                              </div>
                              <span className="text-xs font-mono font-bold px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 shrink-0">
                                {p.allocation.toString()} Units / Beneficiary
                              </span>
                            </div>
                            <div className="mt-4 pt-3 border-t border-slate-800/80 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-slate-400 font-mono">
                              <span>Policy ID: #{p.policyId}</span>
                              <span>Epoch: {p.epoch}</span>
                              <span>τQ: {p.tauQ.toString()}</span>
                              <span className="text-emerald-400 font-semibold">
                                Remaining: {p.remaining.toString()} Units
                              </span>
                            </div>
                            {!claimable && (
                              <div
                                className={`mt-3 flex items-start gap-2 text-[11px] rounded-xl px-3 py-2 ${
                                  p.tauQUnsound
                                    ? 'text-red-300 bg-red-950/40 border border-red-500/30'
                                    : 'text-amber-300 bg-amber-950/40 border border-amber-500/25'
                                }`}
                              >
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                <span className="leading-relaxed">
                                  {p.tauQUnsound
                                    ? `UNSAFE POLICY — τQ = ${p.tauQ.toString()} is outside [${MIN_TAU_Q}, ${MAX_TAU_Q}]. ` +
                                      'The in-circuit biometric threshold cannot be enforced at this value, so claims against ' +
                                      'this policy are refused. The authority must re-create it with a valid τQ.'
                                    : p.rootUnpublished
                                      ? 'No cohort root published — no beneficiary can produce a valid inclusion proof for this policy yet.'
                                      : `Bound to a different model (modelHash ${p.modelHash.slice(
                                          0,
                                          12
                                        )}…). This device cannot produce a matching commitment.`}
                                </span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="pt-2">
                  <button
                    onClick={handleStartVerification}
                    disabled={!selectedPolicy || isLoadingPolicies}
                    className="w-full py-4 rounded-2xl bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold text-sm shadow-xl shadow-emerald-500/25 transition-all inline-flex items-center justify-center gap-2"
                  >
                    <Shield className="w-4 h-4" />
                    <span>Proceed to Liveness Challenge</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Phase 2: Liveness Camera */}
        {phase === 'liveness-camera' && (
          <div className="space-y-6">
            <div
              className={`relative aspect-[3/4] sm:aspect-video max-w-sm sm:max-w-md mx-auto rounded-3xl overflow-hidden bg-black border-2 transition-all duration-300 shadow-2xl flex items-center justify-center ${
                liveFace.multipleFaces
                  ? 'border-red-400 shadow-[0_0_30px_rgba(248,113,113,0.4)]'
                  : liveFace.aligned
                    ? 'border-emerald-400 shadow-[0_0_35px_rgba(16,185,129,0.4)]'
                    : liveFace.detected
                      ? 'border-amber-400/80 shadow-[0_0_25px_rgba(245,158,11,0.3)]'
                      : 'border-emerald-500/40 shadow-emerald-500/20'
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
                className="w-full h-full object-cover"
              />

              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div
                  className={`w-52 h-68 sm:w-48 sm:h-60 rounded-[48%] transition-all duration-300 ${
                    liveFace.aligned
                      ? 'border-3 border-solid border-emerald-400 bg-emerald-500/10 shadow-[0_0_35px_rgba(16,185,129,0.7)] animate-pulse'
                      : liveFace.detected
                        ? 'border-2 border-dashed border-amber-400/90 bg-amber-500/5 shadow-[0_0_20px_rgba(245,158,11,0.4)]'
                        : 'border-2 border-dashed border-emerald-400/80 shadow-[0_0_25px_rgba(16,185,129,0.3)] animate-pulse-slow'
                  }`}
                />
              </div>

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
                        ? `Face tracked (${liveFace.score}%)`
                        : liveFace.detected
                          ? liveFace.message
                          : 'Align face within guide'}
                  </span>
                </div>
              </div>

              {isExtracting && (
                <div className="absolute inset-0 bg-black/75 backdrop-blur-xs flex flex-col items-center justify-center space-y-2 p-4 text-center">
                  <div className="w-10 h-10 rounded-full border-3 border-emerald-400 border-t-transparent animate-spin" />
                  <span className="text-xs text-white font-bold">
                    Extracting descriptor & computing int8 tensor...
                  </span>
                </div>
              )}
            </div>

            {/* Challenge panel */}
            <div className="p-4 sm:p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-3">
              <div className="flex items-center justify-between text-xs font-bold">
                <span className="text-slate-300">Randomized anti-spoofing challenge</span>
                <span
                  className={
                    livenessState?.isComplete
                      ? 'text-emerald-400 font-mono'
                      : 'text-amber-400 font-mono'
                  }
                >
                  {livenessState?.livenessScore ?? 0} / 100
                </span>
              </div>

              <div
                className={`text-center text-xs font-mono font-medium py-2 px-3 rounded-lg ${
                  timedOut
                    ? 'bg-red-950/50 text-red-300 border border-red-500/30'
                    : livenessState?.isComplete
                      ? 'bg-emerald-950/50 text-emerald-300 border border-emerald-500/30'
                      : 'bg-slate-950/50 text-slate-300'
                }`}
              >
                {livenessState?.currentPrompt || 'Initializing liveness tracker...'}
              </div>

              {livenessState && !livenessState.calibrating && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                  {livenessState.sequence.map((action, i) => {
                    const done =
                      action === 'blink' ? livenessState.hasBlinked : livenessState.hasTurnedHead;
                    const active = i === livenessState.stepIndex && !livenessState.isComplete;
                    return (
                      <div
                        key={action}
                        className={`flex items-center gap-2 p-2 rounded-xl border ${
                          done
                            ? 'bg-emerald-950/30 border-emerald-500/20 text-emerald-300'
                            : active
                              ? 'bg-amber-950/30 border-amber-500/30 text-amber-200'
                              : 'bg-slate-950/50 border-slate-700/50 text-slate-400'
                        }`}
                      >
                        <CheckCircle2
                          className={`w-4 h-4 shrink-0 ${done ? 'text-emerald-400' : 'text-slate-600'}`}
                        />
                        <span>
                          Action {i + 1}:{' '}
                          {action === 'blink'
                            ? `blink ${livenessState.requiredBlinks}× (${livenessState.blinkCount}/${livenessState.requiredBlinks})`
                            : 'turn head left or right & back'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/*
                Diagnostics, not decoration. The blink failure that prompted this row was
                invisible from the UI: the prompt read "blink once" while the thresholds that
                made blinking impossible were private tracker state. Showing the live EAR next to
                the value it must cross makes "my blink isn't registering" a readable condition.
              */}
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] font-mono text-slate-500 pt-1">
                <span
                  className={
                    livenessState && livenessState.earValue > 0 &&
                    livenessState.earValue < livenessState.earDipThreshold
                      ? 'text-amber-400'
                      : undefined
                  }
                >
                  EAR {livenessState?.earValue?.toFixed(3) ?? '—'}
                  {livenessState && !livenessState.calibrating
                    ? ` / dip < ${livenessState.earDipThreshold.toFixed(3)}`
                    : ''}
                </span>
                <span>yaw {livenessState?.yawRatio?.toFixed(2) ?? '—'}</span>
                {livenessState && !livenessState.calibrating && (
                  <span>closures {livenessState.blinkDipsSeen}</span>
                )}
                <span>t {((livenessState?.elapsedMs ?? 0) / 1000).toFixed(1)}s</span>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <button
                onClick={() => handleCompleteVerificationAndProve()}
                disabled={isExtracting || !livenessState?.isComplete}
                className={`w-full sm:w-auto px-10 py-4 rounded-2xl font-bold text-xs sm:text-sm shadow-xl transition-all inline-flex items-center justify-center gap-2 ${
                  livenessState?.isComplete && !isExtracting
                    ? 'bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 text-white shadow-emerald-500/25'
                    : 'bg-slate-800 text-slate-500 cursor-not-allowed shadow-none'
                }`}
              >
                <Cpu className="w-4 h-4" />
                <span>{isExtracting ? 'Scanning face…' : 'Verify Live Face & Generate ZK Proof'}</span>
              </button>

              <button
                onClick={() => {
                  livenessTrackerRef.current.reset();
                  setLivenessState(null);
                  stopLivenessLoop();
                  runLivenessLoop();
                }}
                disabled={isExtracting}
                className="w-full sm:w-auto px-5 py-4 rounded-2xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 font-semibold text-xs inline-flex items-center justify-center gap-2"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Restart challenge</span>
              </button>

              <button
                onClick={() => abandonLiveness('select-policy')}
                disabled={isExtracting}
                className="w-full sm:w-auto px-5 py-4 rounded-2xl text-slate-400 hover:text-white disabled:opacity-50 font-semibold text-xs"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Phase 3: Proving / Submitting */}
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
                {phase === 'proving' ? 'Generating In-Browser ZK Proof' : `Submitting to ${CHAIN_LABEL}`}
              </h3>
              <p className="text-xs sm:text-sm text-slate-400 font-mono max-w-md bg-slate-950 p-3 rounded-xl border border-slate-800 break-words">
                {statusMessage}
              </p>
              {measuredSimilarity !== null && selectedPolicy && (
                <p className="text-[11px] font-mono text-slate-500">
                  in-circuit dot = {measuredSimilarity} ≥ τQ = {selectedPolicy.tauQ.toString()}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Phase 4: Success receipt */}
        {phase === 'success' && (
          <div className="space-y-6 animate-fade-in">
            <div className="p-6 sm:p-8 rounded-3xl bg-emerald-950/40 border border-emerald-500/40 text-center space-y-3 shadow-2xl shadow-emerald-500/15">
              <div className="w-14 h-14 rounded-2xl bg-emerald-500/20 text-emerald-400 mx-auto flex items-center justify-center shadow-lg shadow-emerald-500/25">
                <CheckCircle2 className="w-8 h-8" />
              </div>
              <h2 className="text-2xl sm:text-3xl font-black text-white">
                Aid Allocation Successfully Claimed
              </h2>
              <p className="text-xs sm:text-sm text-emerald-300/90 max-w-md mx-auto leading-relaxed">
                The Groth16 proof was verified on-chain by AegisAid.sol and your single-use
                nullifier is now recorded on {CHAIN_LABEL}.
              </p>
            </div>

            <div className="space-y-3.5 text-xs sm:text-sm">
              <div className="p-4 sm:p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-2">
                <div className="text-slate-400 font-semibold">On-chain transaction hash</div>
                <div className="font-mono text-emerald-400 break-all text-xs bg-slate-950/80 p-3 rounded-xl border border-slate-800">
                  {txHash}
                </div>
                {!IS_LOCAL_CHAIN && (
                  <div className="pt-2">
                    <a
                      href={getExplorerTxUrl(txHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 underline font-medium"
                    >
                      <span>View transaction on BaseScan Sepolia</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                )}
              </div>

              <div className="p-4 sm:p-5 rounded-2xl bg-slate-900/90 border border-slate-800 space-y-2.5">
                <div className="flex items-center gap-2 text-slate-400 font-semibold">
                  <Layers className="w-3.5 h-3.5" />
                  <span>Verified public signals</span>
                </div>
                <dl className="space-y-1.5 font-mono text-[11px] break-all">
                  <div>
                    <dt className="text-slate-500 inline">[0] nullifier: </dt>
                    <dd className="text-slate-200 inline">{claimedNullifier}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500 inline">[1] root: </dt>
                    <dd className="text-slate-200 inline">{claimedRoot}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500 inline">[2] policyId: </dt>
                    <dd className="text-slate-200 inline">{selectedPolicy?.policyId}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500 inline">[3] epoch: </dt>
                    <dd className="text-slate-200 inline">{selectedPolicy?.epoch}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500 inline">[4] tauQ: </dt>
                    <dd className="text-slate-200 inline">{selectedPolicy?.tauQ.toString()}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-500 inline">[5] modelHash: </dt>
                    <dd className="text-slate-200 inline">{selectedPolicy?.modelHash}</dd>
                  </div>
                </dl>
              </div>

              <div className="grid grid-cols-2 gap-3.5 text-xs">
                {proverResult && (
                  <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800">
                    <span className="text-slate-400 font-medium">Proving latency (this device)</span>
                    <div className="text-base font-bold text-white font-mono mt-1">
                      {proverResult.provingTimeMs} ms
                    </div>
                  </div>
                )}
                {measuredSimilarity !== null && (
                  <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800">
                    <span className="text-slate-400 font-medium">Measured similarity (int8 dot)</span>
                    <div className="text-base font-bold text-white font-mono mt-1">
                      {measuredSimilarity}
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono">
                      cosine ≈ {(measuredSimilarity / (127 * 127)).toFixed(4)}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
              <button
                onClick={() => {
                  setErrorMessage('');
                  setIsDoubleClaim(false);
                  abandonLiveness('select-policy');
                }}
                className="w-full sm:w-auto px-6 py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs inline-flex items-center justify-center gap-2 shadow-lg shadow-indigo-500/20"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Attempt a second claim (tests replay protection)</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
