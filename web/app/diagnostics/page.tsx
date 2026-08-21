'use client';

/**
 * AegisDID — Diagnostics & Telemetry
 *
 * Every number on this page is measured at runtime on the visitor's own device, or is a
 * constant with its measurement command written next to it. Nothing here is aspirational.
 *
 * WHAT CHANGED AND WHY (the previous version of this page was broken in a way that mattered):
 *
 *  1. The prover benchmark could never succeed. It built its witness from
 *     `new Array(128).fill(128)` for BOTH uLive and uReg. Since q_i = u_i - 128, every q_i was
 *     zero, so the in-circuit dot product was 0 against `tauQ: 8065` and the similarity
 *     constraint could not be satisfied. It also passed a fabricated `root` and an all-zero
 *     20-element path, so Merkle inclusion failed independently. "Measured Latency" was
 *     therefore permanently stuck on "Not tested yet" and the button only ever produced an
 *     error. It now builds a real satisfiable witness: a real quantized vector, real Poseidon
 *     commitments, and a real depth-20 Merkle path from the same MerkleTree class the authority
 *     uses. The reported latency is a real measurement of real Groth16 proving.
 *
 *  2. The page hardcoded a green "Zero Leakage Invariant Verified" banner. That asserted a
 *     security property without checking anything. It is replaced by a probe that actually
 *     POSTs each forbidden field to /api/enroll and reports the real HTTP status per field,
 *     so a regression in the server-side guard shows up here as FAIL.
 *
 * SCOPE: this page is a local self-test. It performs no blockchain transaction, reads no
 * camera, and never uses the visitor's stored identity as proving input — the benchmark
 * witness is synthetic and generated fresh on each run.
 */

import { useState, useEffect } from 'react';
import {
  Activity,
  Cpu,
  Layers,
  Database,
  Play,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Hash,
  Trash2,
} from 'lucide-react';
import { getBeneficiaryIdentity, clearBeneficiaryIdentity, StoredIdentity } from '@/lib/ml/storage';
import { generateAegisClaimProof, CircuitWitness } from '@/lib/zk/prover';
import {
  DEFAULT_MODEL_HASH,
  DEFAULT_MODEL_HASH_BYTES32,
  computeEmbeddingCommitment,
  computeIdentityCommitment,
  computeNullifier,
  generateRandomScalar,
} from '@/lib/ml/commitments';
import { quantizeEmbedding, computeQuantizedDotProduct, cosineToTauQ } from '@/lib/ml/quantize';
import { MerkleTree } from '@/lib/merkle/tree';

/* ------------------------------------------------------------------ *
 * Measured circuit facts.
 *
 * Reproduce with:
 *   npx snarkjs r1cs info circuits/build/aegis_claim.r1cs
 *
 * Last measured 2026-08-21 on circuits/build/aegis_claim.r1cs:
 *   Curve bn-128 · Wires 32193 · Constraints 32168
 *   Private inputs 298 · Public inputs 5 · Outputs 1 · Labels 52495
 * ------------------------------------------------------------------ */
const R1CS = {
  constraints: 32168,
  wires: 32193,
  privateInputs: 298,
  publicInputs: 5,
  outputs: 1,
} as const;

const BENCH_DEPTH = 20;
/** Deliberately not a real policy ID. The benchmark never touches the chain. */
const BENCH_POLICY_ID = 999999;
const BENCH_EPOCH = 1;
/**
 * The measured FAR ~= 1e-3 operating point (tauQ 14984), not a round guess. Was 0.5 (tauQ 8065),
 * which is the value docs/RESULTS.md §6 measures at FAR 100% — showing it here as the number a
 * working proof is built against taught the wrong threshold by example. The synthetic self-match
 * witness scores dot ~= 16039, so it clears this just as easily.
 */
const BENCH_TAU_COSINE = 14984 / (127 * 127);
/** 127 * 127 — the scale tauQ is expressed in, used only to print a human-readable cosine. */
const Q_SCALE = 127 * 127;

type StepStatus = 'pending' | 'running' | 'pass' | 'fail';

interface BenchStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
}

const BENCH_STEPS: ReadonlyArray<readonly [string, string]> = [
  ['quantize', 'Quantize synthetic 128-d vector → u ∈ [1,255]'],
  ['similarity', 'Confirm in-circuit dot product clears tauQ'],
  ['commit', 'Poseidon commitments: C_emb → C_id'],
  ['tree', 'Real depth-20 Merkle tree + inclusion path'],
  ['prove', 'Groth16 fullProve (WASM, on this device)'],
  ['verify', 'Verify proof locally against public/zk/vkey.json'],
  ['signals', 'Public signals match locally recomputed values'],
];

/**
 * Deterministic pseudo-random vector for the benchmark.
 *
 * A fixed LCG, not crypto randomness, so the benchmark is reproducible run-to-run and
 * comparable across machines. This is NOT biometric data: no camera is opened and the
 * visitor's enrolled embedding is never used as proving input.
 */
function syntheticVector(seed: number): number[] {
  let s = seed >>> 0;
  const out = new Array<number>(128);
  for (let i = 0; i < 128; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = (s / 0x100000000) * 2 - 1; // uniform in [-1, 1)
  }
  return out;
}

function shortHex(v: bigint): string {
  const h = '0x' + v.toString(16).padStart(64, '0');
  return `${h.slice(0, 10)}…${h.slice(-8)}`;
}

/**
 * Artifact size, or an explanation of why it is unknown.
 *
 * `null` means "still probing" and MUST resolve. A dev server that gzips a response omits
 * Content-Length entirely, so a HEAD alone leaves this stuck on "measuring…" forever with no error
 * — a panel that silently never finishes is indistinguishable from one that is broken. Hence the
 * explicit 'unavailable' state.
 */
type ArtifactSize = number | null | 'unavailable';

function formatBytes(n: ArtifactSize): string {
  if (n === 'unavailable') return 'not reported (compressed in transit)';
  if (n === null) return 'measuring…';
  return `${(n / 1048576).toFixed(2)} MB (${n.toLocaleString()} B)`;
}

/**
 * Forbidden-field probes for the zero-leakage assertion.
 *
 * NOTE ON SAFETY: every probe carries a deliberately INVALID cId. /api/enroll rejects the
 * forbidden field with 403 before it reaches persistence, but even if that guard were removed
 * the invalid commitment would be refused by validation with 400, so a probe can never insert
 * a junk leaf into the authority's real cohort tree.
 */
const PROBE_CID = 'diagnostics-probe-not-a-field-element';
const LEAK_PROBES: ReadonlyArray<{ field: string; payload: Record<string, unknown> }> = [
  { field: 'idSecret', payload: { cId: PROBE_CID, idSecret: '12345678901234567890' } },
  { field: 'salt', payload: { cId: PROBE_CID, salt: '98765432109876543210' } },
  { field: 'embedding', payload: { cId: PROBE_CID, embedding: [0.11, -0.42, 0.07] } },
  { field: 'uReg', payload: { cId: PROBE_CID, uReg: [139, 117, 128] } },
  { field: 'uLive', payload: { cId: PROBE_CID, uLive: [139, 117, 128] } },
  { field: 'descriptor', payload: { cId: PROBE_CID, descriptor: [0.5, 0.5] } },
  // Present-but-falsy. The original guard tested truthiness (`if (body.idSecret)`) and let
  // this through; it now tests presence with `in`.
  { field: 'idSecret (falsy value)', payload: { cId: PROBE_CID, idSecret: 0 } },
];

interface LeakResult {
  field: string;
  status: number | null;
  pass: boolean;
  note: string;
}

export default function DiagnosticsPage() {
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const [benchmarking, setBenchmarking] = useState(false);
  const [steps, setSteps] = useState<BenchStep[]>([]);
  const [progress, setProgress] = useState('Idle. No benchmark has been run in this session.');
  const [proveMs, setProveMs] = useState<number | null>(null);
  const [verifyMs, setVerifyMs] = useState<number | null>(null);
  const [witnessInfo, setWitnessInfo] = useState<{ dot: number; tauQ: number } | null>(null);
  const [benchError, setBenchError] = useState<string | null>(null);

  const [wasmBytes, setWasmBytes] = useState<ArtifactSize>(null);
  const [zkeyBytes, setZkeyBytes] = useState<ArtifactSize>(null);
  const [artifactError, setArtifactError] = useState<string | null>(null);

  const [probing, setProbing] = useState(false);
  const [leakResults, setLeakResults] = useState<LeakResult[] | null>(null);

  useEffect(() => {
    getBeneficiaryIdentity()
      .then((id) => setIdentity(id))
      .catch(() => setIdentity(null));
  }, []);

  // Real measured artifact sizes — this is what a beneficiary's device must download.
  useEffect(() => {
    (async () => {
      try {
        const [w, z] = await Promise.all([
          fetch('/zk/aegis_claim.wasm', { method: 'HEAD' }),
          fetch('/zk/aegis_final.zkey', { method: 'HEAD' }),
        ]);
        const isBinary = (r: Response) =>
          r.ok && !(r.headers.get('content-type') || '').includes('text/html');
        if (!isBinary(w) || !isBinary(z)) {
          setArtifactError(
            `Circuit artifacts are NOT being served (wasm HTTP ${w.status}, zkey HTTP ${z.status}). ` +
              'Proving cannot work on this deployment.'
          );
          return;
        }
        const wl = w.headers.get('content-length');
        const zl = z.headers.get('content-length');
        // A gzipped response carries no Content-Length. Say so rather than spinning forever:
        // "not reported" is a fact, an endless "measuring…" is a bug that looks like a fact.
        setWasmBytes(wl ? Number(wl) : 'unavailable');
        setZkeyBytes(zl ? Number(zl) : 'unavailable');
      } catch (err: unknown) {
        setArtifactError(
          `Could not probe circuit artifacts: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })();
  }, []);

  async function runProverBenchmark() {
    setBenchmarking(true);
    setBenchError(null);
    setProveMs(null);
    setVerifyMs(null);
    setWitnessInfo(null);

    let local: BenchStep[] = BENCH_STEPS.map(([id, label]) => ({ id, label, status: 'pending' }));
    setSteps(local);
    const mark = (id: string, status: StepStatus, detail?: string) => {
      local = local.map((s) => (s.id === id ? { ...s, status, detail } : s));
      setSteps(local);
    };

    try {
      // 1 — quantize
      mark('quantize', 'running');
      setProgress('Quantizing synthetic vector…');
      const u = quantizeEmbedding(syntheticVector(0xa3615d1d));
      mark('quantize', 'pass', `u[0..5] = [${u.slice(0, 6).join(', ')}, …] (128 values)`);

      // 2 — similarity. uLive = uReg is the maximum-similarity case on purpose: this measures
      // proving LATENCY, and it is not a statement about matching accuracy.
      mark('similarity', 'running');
      const tauQ = cosineToTauQ(BENCH_TAU_COSINE);
      const dot = computeQuantizedDotProduct(u, u);
      if (dot < tauQ) {
        mark('similarity', 'fail', `dot = ${dot} < tauQ = ${tauQ}`);
        throw new Error(
          `Benchmark witness is unsatisfiable: dot ${dot} < tauQ ${tauQ}. Refusing to prove.`
        );
      }
      setWitnessInfo({ dot, tauQ });
      mark(
        'similarity',
        'pass',
        `dot = ${dot} ≥ tauQ = ${tauQ}  (dot/127² = ${(dot / Q_SCALE).toFixed(4)})`
      );

      // 3 — commitments
      mark('commit', 'running');
      setProgress('Computing Poseidon commitments…');
      const salt = generateRandomScalar();
      const idSecret = generateRandomScalar();
      const cEmb = await computeEmbeddingCommitment(u, salt);
      const cId = await computeIdentityCommitment(idSecret, cEmb, DEFAULT_MODEL_HASH);
      mark('commit', 'pass', `C_id = ${shortHex(cId)}`);

      // 4 — real Merkle path. The benchmark leaf is placed at index 1 so pathIndices[0] = 1,
      // which exercises the right-child branch of the circuit's path folding.
      mark('tree', 'running');
      setProgress('Building depth-20 Merkle tree…');
      const tree = new MerkleTree(BENCH_DEPTH, 0n);
      await tree.init();
      tree.insert(generateRandomScalar()); // decoy leaf 0
      tree.insert(cId); // benchmark leaf 1
      tree.insert(generateRandomScalar()); // decoy leaf 2
      const { root, pathElements, pathIndices } = tree.getPath(1);
      mark(
        'tree',
        'pass',
        `root = ${shortHex(root)} · ${tree.leafCount} leaves · leaf idx 1 · pathIndices[0] = ${pathIndices[0]}`
      );

      const witness: CircuitWitness = {
        root: root.toString(),
        policyId: BENCH_POLICY_ID,
        epoch: BENCH_EPOCH,
        tauQ,
        modelHash: DEFAULT_MODEL_HASH.toString(),
        uLive: u,
        uReg: u,
        salt: salt.toString(),
        idSecret: idSecret.toString(),
        pathElements: pathElements.map((p) => p.toString()),
        pathIndices,
      };

      // 5 — prove
      mark('prove', 'running');
      const wallStart = performance.now();
      const result = await generateAegisClaimProof(witness, (msg) => setProgress(msg));
      const wallMs = Math.round(performance.now() - wallStart);
      setProveMs(result.provingTimeMs);
      mark(
        'prove',
        'pass',
        `${result.provingTimeMs} ms reported · ${wallMs} ms wall · ${result.proof.protocol}/${result.proof.curve}`
      );

      // 6 — verify locally with the real verification key
      mark('verify', 'running');
      setProgress('Verifying proof against public/zk/vkey.json…');
      const vkRes = await fetch('/zk/vkey.json');
      if (!vkRes.ok) throw new Error(`vkey.json is not served (HTTP ${vkRes.status}).`);
      const vkey = await vkRes.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const snarkjs = (await import('snarkjs')) as any;
      const vStart = performance.now();
      const valid: boolean = await snarkjs.groth16.verify(vkey, result.publicSignals, result.proof);
      const vMs = Math.round(performance.now() - vStart);
      setVerifyMs(vMs);
      if (!valid) {
        mark('verify', 'fail', 'groth16.verify returned false');
        throw new Error('Proof failed local verification against vkey.json.');
      }
      mark('verify', 'pass', `valid = true · ${vMs} ms`);

      // 7 — public signal ordering and values
      mark('signals', 'running');
      const expectedNullifier = await computeNullifier(idSecret, BENCH_POLICY_ID, BENCH_EPOCH);
      const names = ['nullifier', 'root', 'policyId', 'epoch', 'tauQ', 'modelHash'];
      const expected = [
        expectedNullifier,
        root,
        BigInt(BENCH_POLICY_ID),
        BigInt(BENCH_EPOCH),
        BigInt(tauQ),
        DEFAULT_MODEL_HASH,
      ];
      if (result.publicSignals.length !== 6) {
        mark('signals', 'fail', `expected 6 public signals, got ${result.publicSignals.length}`);
        throw new Error(`Circuit returned ${result.publicSignals.length} public signals, not 6.`);
      }
      const mismatched = expected
        .map((e, i) => (BigInt(result.publicSignals[i]) === e ? null : `[${i}] ${names[i]}`))
        .filter((x): x is string => x !== null);
      if (mismatched.length > 0) {
        mark('signals', 'fail', `mismatch at ${mismatched.join(', ')}`);
        throw new Error(`Public signal mismatch at ${mismatched.join(', ')}.`);
      }
      mark(
        'signals',
        'pass',
        'all 6 match, in order [nullifier, root, policyId, epoch, tauQ, modelHash]'
      );

      setProgress(
        `Complete. Proof generated and locally verified in ${result.provingTimeMs} ms + ${vMs} ms.`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Prover benchmark failed:', err);
      setBenchError(msg);
      setProgress('Benchmark failed — see the error below.');
      local = local.map((s) => (s.status === 'running' ? { ...s, status: 'fail' } : s));
      setSteps(local);
    } finally {
      setBenchmarking(false);
    }
  }

  async function runLeakageProbe() {
    setProbing(true);
    setLeakResults(null);
    const out: LeakResult[] = [];
    for (const probe of LEAK_PROBES) {
      try {
        const res = await fetch('/api/enroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(probe.payload),
        });
        const pass = res.status === 403;
        out.push({
          field: probe.field,
          status: res.status,
          pass,
          note: pass
            ? 'refused with 403 before persistence'
            : `EXPECTED 403, GOT ${res.status} — the server-side guard is not rejecting this field`,
        });
      } catch (err: unknown) {
        out.push({
          field: probe.field,
          status: null,
          pass: false,
          note: `request failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      setLeakResults([...out]);
    }
    setProbing(false);
  }

  async function handleClearLocalIdentity() {
    await clearBeneficiaryIdentity();
    setIdentity(null);
    setConfirmClear(false);
  }

  const allStepsPassed = steps.length > 0 && steps.every((s) => s.status === 'pass');
  const leakAllPass = leakResults !== null && leakResults.length === LEAK_PROBES.length && leakResults.every((r) => r.pass);
  const leakAnyFail = leakResults !== null && leakResults.some((r) => !r.pass);

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-fade-in">
      {/* Header */}
      <div className="text-center space-y-2">
        <div className="inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs font-bold uppercase tracking-wider">
          <Activity className="w-3.5 h-3.5" />
          <span>System Telemetry &amp; Proof Benchmarks</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-white">Diagnostics &amp; Telemetry</h1>
        <p className="text-xs sm:text-sm text-slate-400 max-w-xl mx-auto">
          Local self-test. Every latency shown is measured on this device; every circuit constant
          lists the command that produced it. No blockchain transaction is sent and the camera is
          never opened from this page.
        </p>
      </div>

      {artifactError && (
        <div className="p-4 rounded-2xl bg-red-950/40 border border-red-500/40 flex items-start gap-3 text-xs text-red-300">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>{artifactError}</span>
        </div>
      )}

      {/* Prover benchmark */}
      <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6 sm:p-7 shadow-xl space-y-5 backdrop-blur-xl">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <Cpu className="w-5 h-5 text-indigo-400" />
            On-Device Prover Benchmark
          </h2>
          <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/30 font-semibold">
            snarkjs · Groth16 · BN254
          </span>
        </div>

        <p className="text-xs text-slate-400 leading-relaxed">
          Builds a <strong className="text-slate-200">genuinely satisfiable</strong> witness —
          real quantized vector, real Poseidon commitments, real depth-20 Merkle path from the same{' '}
          <code className="text-indigo-300">MerkleTree</code> class the authority uses — then runs a
          real <code className="text-indigo-300">groth16.fullProve</code> and verifies the result
          locally against the deployed verification key. The witness is synthetic and freshly
          generated: your enrolled identity is never used as proving input.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 font-mono text-xs">
          <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800">
            <div className="text-slate-500 text-[11px]">Proving latency</div>
            <div className="text-emerald-400 font-bold text-base">
              {proveMs !== null ? `${proveMs} ms` : '—'}
            </div>
          </div>
          <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800">
            <div className="text-slate-500 text-[11px]">Local verify latency</div>
            <div className="text-emerald-400 font-bold text-base">
              {verifyMs !== null ? `${verifyMs} ms` : '—'}
            </div>
          </div>
          <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800">
            <div className="text-slate-500 text-[11px]">Witness dot / tauQ</div>
            <div className="text-white font-bold text-base">
              {witnessInfo ? `${witnessInfo.dot} / ${witnessInfo.tauQ}` : '—'}
            </div>
          </div>
        </div>

        {steps.length > 0 && (
          <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-2 font-mono text-[11px]">
            {steps.map((s) => (
              <div key={s.id} className="flex items-start gap-2">
                <span className="shrink-0 mt-0.5">
                  {s.status === 'pass' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                  {s.status === 'fail' && <XCircle className="w-3.5 h-3.5 text-red-400" />}
                  {s.status === 'running' && (
                    <span className="block w-3.5 h-3.5 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
                  )}
                  {s.status === 'pending' && (
                    <span className="block w-3.5 h-3.5 rounded-full border-2 border-slate-700" />
                  )}
                </span>
                <span className="flex-1 min-w-0">
                  <span
                    className={
                      s.status === 'fail'
                        ? 'text-red-300'
                        : s.status === 'pass'
                          ? 'text-slate-300'
                          : 'text-slate-500'
                    }
                  >
                    {s.label}
                  </span>
                  {s.detail && (
                    <span className="block text-slate-500 break-all">↳ {s.detail}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 text-[11px] text-indigo-300 break-words">
          Status: {progress}
        </div>

        {benchError && (
          <div className="p-4 rounded-2xl bg-red-950/40 border border-red-500/40 flex items-start gap-3 text-xs text-red-300">
            <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <span className="break-words">{benchError}</span>
          </div>
        )}

        {allStepsPassed && !benchError && (
          <div className="p-4 rounded-2xl bg-emerald-950/25 border border-emerald-500/25 flex items-start gap-2.5 text-xs text-emerald-300">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <span>
              End-to-end proving path is functional on this device: witness satisfied the
              constraints, the proof verified against <code>vkey.json</code>, and all six public
              signals matched independently recomputed values.
            </span>
          </div>
        )}

        <button
          onClick={runProverBenchmark}
          disabled={benchmarking}
          className="w-full py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-bold text-xs shadow-xl shadow-indigo-500/25 transition-all inline-flex items-center justify-center gap-2"
        >
          {benchmarking ? (
            <>
              <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
              <span>Running WASM benchmark…</span>
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              <span>Run In-Browser Prover Benchmark</span>
            </>
          )}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Measured circuit facts */}
        <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6 sm:p-7 shadow-xl space-y-5 backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Hash className="w-5 h-5 text-sky-400" />
              Compiled Circuit (measured)
            </h2>
            <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full bg-sky-500/10 text-sky-400 border border-sky-500/30 font-semibold">
              r1cs info
            </span>
          </div>

          <div className="space-y-2.5 text-xs">
            {[
              ['R1CS constraints', R1CS.constraints.toLocaleString()],
              ['Wires', R1CS.wires.toLocaleString()],
              ['Private inputs', String(R1CS.privateInputs)],
              [
                'Public signals',
                `${R1CS.publicInputs + R1CS.outputs} (${R1CS.publicInputs} in + ${R1CS.outputs} out)`,
              ],
              ['Circuit WASM', formatBytes(wasmBytes)],
              ['Proving key (zkey)', formatBytes(zkeyBytes)],
            ].map(([k, v]) => (
              <div
                key={k}
                className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center justify-between gap-2"
              >
                <span className="text-slate-400">{k}:</span>
                <span className="font-mono font-bold text-white text-right">{v}</span>
              </div>
            ))}
          </div>

          <p className="text-[11px] text-slate-500 leading-relaxed">
            Constraint counts reproduced with{' '}
            <code className="text-slate-400">
              npx snarkjs r1cs info circuits/build/aegis_claim.r1cs
            </code>
            . Artifact sizes are read live from this deployment&apos;s{' '}
            <code className="text-slate-400">Content-Length</code> headers.
          </p>
        </div>

        {/* Model & quantization spec */}
        <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6 sm:p-7 shadow-xl space-y-5 backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Layers className="w-5 h-5 text-emerald-400" />
              Model &amp; Quantization Spec
            </h2>
            <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-semibold">
              CRYPTO_SPEC.md
            </span>
          </div>

          <div className="space-y-2.5 text-xs">
            {[
              // The raw descriptor is NOT unit-norm (measured mean L2 1.4213); the quantizer
              // normalizes it. See docs/CRYPTO_SPEC.md and docs/RESULTS.md §4.
              ['Embedding', '128-d, L2-normalized by the quantizer'],
              ['Quantization', 'q = clamp(round(z·127)) → u = q+128 ∈ [1,255]'],
              ['Poseidon S-box', 'x^5 (circomlib, BN254)'],
              ['Merkle depth', '20 (capacity 1,048,576)'],
              ['Threshold form', 'tauQ = round(cos·127²); accept if dot ≥ tauQ'],
            ].map(([k, v]) => (
              <div
                key={k}
                className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 flex items-start justify-between gap-2"
              >
                <span className="text-slate-400 shrink-0">{k}:</span>
                <span className="font-mono font-bold text-white text-right break-all">{v}</span>
              </div>
            ))}
          </div>

          <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 space-y-1">
            <span className="text-slate-400 text-xs">MODEL_HASH (binds the extractor):</span>
            <div className="font-mono text-[10px] text-emerald-300 break-all">
              {DEFAULT_MODEL_HASH_BYTES32}
            </div>
            <span className="text-[10px] text-slate-500 block">
              Reproduce with <code>node tools/compute_model_hash.mjs</code>.
            </span>
          </div>
        </div>
      </div>

      {/* Zero-leakage runtime assertion */}
      <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6 sm:p-8 shadow-xl space-y-5 backdrop-blur-xl">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
            Zero-Leakage Assertion (live check)
          </h2>
          <button
            onClick={runLeakageProbe}
            disabled={probing}
            className="text-xs px-3.5 py-2 rounded-xl bg-amber-600/90 hover:bg-amber-500 disabled:opacity-50 text-white font-bold transition-all"
          >
            {probing ? 'Probing…' : 'Run leakage probe'}
          </button>
        </div>

        <p className="text-xs text-slate-400 leading-relaxed">
          Sends each forbidden field to <code className="text-amber-300">POST /api/enroll</code> and
          reports the real HTTP status. A pass means the authority endpoint refuses the field with{' '}
          <strong className="text-slate-200">403 before persistence</strong>. Every probe carries an
          intentionally invalid <code>cId</code>, so no probe can ever add a leaf to the real cohort
          tree.
        </p>

        {leakResults === null ? (
          <div className="p-6 rounded-2xl bg-slate-950/50 border border-slate-800 text-center text-xs text-slate-400">
            Not run in this session. This panel makes no claim until you run the probe.
          </div>
        ) : (
          <div className="space-y-2 font-mono text-[11px]">
            {leakResults.map((r) => (
              <div
                key={r.field}
                className={`p-3 rounded-xl border flex items-start gap-2 ${
                  r.pass
                    ? 'bg-emerald-950/20 border-emerald-500/25 text-emerald-300'
                    : 'bg-red-950/30 border-red-500/40 text-red-300'
                }`}
              >
                {r.pass ? (
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                ) : (
                  <XCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                )}
                <span className="flex-1 min-w-0">
                  <span className="text-white">{r.field}</span> → HTTP{' '}
                  {r.status ?? 'no response'}
                  <span className="block break-words">↳ {r.note}</span>
                </span>
              </div>
            ))}
          </div>
        )}

        {leakAllPass && (
          <div className="p-4 rounded-2xl bg-emerald-950/25 border border-emerald-500/25 text-xs text-emerald-300">
            All {LEAK_PROBES.length} forbidden fields were refused with 403 on this deployment.
            Scope of this result: it proves the <em>server</em> rejects secrets if they are sent. It
            does not by itself prove the client never sends them — that is enforced by construction
            in <code>app/enroll/page.tsx</code>, which transmits only{' '}
            <code>cId</code>, <code>didKey</code> and <code>timestamp</code>, and is observable in
            the browser Network tab.
          </div>
        )}
        {leakAnyFail && (
          <div className="p-4 rounded-2xl bg-red-950/40 border border-red-500/40 text-xs text-red-300">
            At least one forbidden field was NOT refused with 403. Treat this as a live privacy
            regression and do not run a demo until it is fixed.
          </div>
        )}
      </div>

      {/* Local device state */}
      <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6 sm:p-8 shadow-xl space-y-6 backdrop-blur-xl">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <Database className="w-5 h-5 text-purple-400" />
            Enrolled Device State (IndexedDB)
          </h2>
          {identity && !confirmClear && (
            <button
              onClick={() => setConfirmClear(true)}
              className="text-xs text-red-400 hover:text-red-300 font-medium inline-flex items-center gap-1.5"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear stored identity
            </button>
          )}
        </div>

        {confirmClear && (
          <div className="p-4 rounded-2xl bg-red-950/30 border border-red-500/40 space-y-3">
            <p className="text-xs text-red-200">
              This permanently deletes <code>idSecret</code>, <code>salt</code> and the stored
              commitments from this browser. They exist nowhere else — the authority only ever
              received <code>C_id</code>. You will not be able to claim against any cohort that
              already contains your leaf, and re-enrolling produces a different commitment.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleClearLocalIdentity}
                className="text-xs px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-bold"
              >
                Delete permanently
              </button>
              <button
                onClick={() => setConfirmClear(false)}
                className="text-xs px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {identity ? (
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-1">
                <span className="text-slate-400 font-medium">did:key identifier:</span>
                <div className="font-mono text-white break-all text-xs">{identity.didKey}</div>
              </div>
              <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-1">
                <span className="text-slate-400 font-medium">Enrollment timestamp:</span>
                <div className="font-mono text-emerald-400 text-xs">{identity.createdAt}</div>
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-1">
              <span className="text-slate-400 font-medium">
                C_id — identity commitment (this is the public Merkle leaf):
              </span>
              <div className="font-mono text-indigo-300 break-all text-xs">{identity.cId}</div>
            </div>

            <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-1">
              <span className="text-slate-400 font-medium">
                C_emb — embedding commitment (Poseidon9 over 8 chunk hashes + salt):
              </span>
              <div className="font-mono text-slate-300 break-all text-xs">{identity.cEmb}</div>
            </div>

            <div className="p-4 rounded-2xl bg-slate-950/60 border border-slate-800 text-slate-400 leading-relaxed">
              Deliberately not rendered anywhere on this page: <code>idSecret</code>,{' '}
              <code>salt</code>, and the quantized vector <code>uReg</code>. They are read only
              inside the prover, where they enter the circuit as private witness values. The two
              commitments above are shown because they are hiding: recovering the vector from{' '}
              <code>C_emb</code> requires the salt.
            </div>
          </div>
        ) : (
          <div className="p-8 rounded-2xl bg-slate-950/50 border border-slate-800 text-center text-xs text-slate-400">
            No enrolled identity in this browser. Enroll first to inspect local device state.
          </div>
        )}
      </div>
    </div>
  );
}
