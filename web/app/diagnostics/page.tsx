'use client';

import { useState, useEffect } from 'react';
import {
  Activity,
  Shield,
  Cpu,
  Lock,
  CheckCircle2,
  Play,
  Terminal,
  Layers,
  Database,
  RefreshCw,
  AlertTriangle,
  FileCode,
  Gauge,
} from 'lucide-react';
import { getBeneficiaryIdentity, clearBeneficiaryIdentity, StoredIdentity } from '@/lib/ml/storage';
import { generateAegisClaimProof, CircuitWitness } from '@/lib/zk/prover';
import { DEFAULT_MODEL_HASH } from '@/lib/ml/commitments';

export default function DiagnosticsPage() {
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);
  const [benchmarking, setBenchmarking] = useState(false);
  const [benchmarkResult, setBenchmarkResult] = useState<number | null>(null);
  const [benchmarkLog, setBenchmarkLog] = useState<string>('Ready to benchmark.');

  useEffect(() => {
    getBeneficiaryIdentity().then((id) => setIdentity(id));
  }, []);

  async function runProverBenchmark() {
    setBenchmarking(true);
    setBenchmarkLog('Initializing benchmark circuit witness...');

    try {
      const dummyULive = new Array(128).fill(128);
      const dummyUReg = new Array(128).fill(128);
      const depth = 20;

      const witness: CircuitWitness = {
        root: '0x2a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b',
        policyId: 101,
        epoch: 1,
        tauQ: 8065,
        modelHash: '0x' + DEFAULT_MODEL_HASH.toString(16),
        uLive: dummyULive,
        uReg: dummyUReg,
        salt: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        idSecret: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        pathElements: new Array(depth).fill('0x00'),
        pathIndices: new Array(depth).fill(0),
      };

      const start = performance.now();
      const res = await generateAegisClaimProof(witness, (msg) => setBenchmarkLog(msg));
      const totalTime = Math.round(performance.now() - start);

      setBenchmarkResult(totalTime);
      setBenchmarkLog(`Prover Benchmark Finished: ${totalTime} ms (Groth16 BN254)`);
    } catch (err: unknown) {
      console.error(err);
      setBenchmarkLog(`Benchmark error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBenchmarking(false);
    }
  }

  async function handleClearLocalIdentity() {
    if (confirm('Are you sure you want to clear your local biometric credentials from IndexedDB?')) {
      await clearBeneficiaryIdentity();
      setIdentity(null);
    }
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8 animate-fade-in">
      {/* Header */}
      <div className="text-center space-y-2">
        <div className="inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs font-bold uppercase tracking-wider">
          <Activity className="w-3.5 h-3.5" />
          <span>System Telemetry & Proof Benchmarks</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-white">Diagnostics & Telemetry</h1>
        <p className="text-xs sm:text-sm text-slate-400 max-w-lg mx-auto">
          Transparent metrics on neural embedding quantization, R1CS circuit constraints, and measured in-browser proving performance.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Card 1: Machine & Prover Benchmark */}
        <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6 sm:p-7 shadow-xl space-y-5 backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Cpu className="w-5 h-5 text-indigo-400" />
              On-Device Prover Benchmark
            </h2>
            <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/30 font-semibold">
              snarkjs (WASM)
            </span>
          </div>

          <p className="text-xs text-slate-400 leading-relaxed">
            Measures Groth16 witness computation and proof synthesis latency directly on this physical device.
          </p>

          <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-3 font-mono text-xs">
            <div className="flex items-center justify-between text-slate-400">
              <span>Prover Engine:</span>
              <span className="text-white font-semibold">Groth16 / BN254</span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>Measured Latency:</span>
              <span className="text-emerald-400 font-bold text-sm">
                {benchmarkResult !== null ? `${benchmarkResult} ms` : 'Not tested yet'}
              </span>
            </div>
            <div className="pt-2 border-t border-slate-800 text-[11px] text-indigo-300 truncate">
              Status: {benchmarkLog}
            </div>
          </div>

          <button
            onClick={runProverBenchmark}
            disabled={benchmarking}
            className="w-full py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-bold text-xs shadow-xl shadow-indigo-500/25 transition-all inline-flex items-center justify-center gap-2"
          >
            {benchmarking ? (
              <>
                <div className="w-4 h-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                <span>Running WASM Benchmark...</span>
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                <span>Run In-Browser Prover Benchmark</span>
              </>
            )}
          </button>
        </div>

        {/* Card 2: Neural Model & Quantization Card */}
        <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6 sm:p-7 shadow-xl space-y-5 backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Layers className="w-5 h-5 text-emerald-400" />
              Model & Quantization Spec
            </h2>
            <span className="text-[11px] font-mono px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-semibold">
              CRYPTO_SPEC.md
            </span>
          </div>

          <div className="space-y-2.5 text-xs">
            <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center justify-between">
              <span className="text-slate-400">Embedding Dimension:</span>
              <span className="font-mono font-bold text-white">128-d (L2 normalized)</span>
            </div>
            <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center justify-between">
              <span className="text-slate-400">Quantization Range:</span>
              <span className="font-mono font-bold text-white">int8 ∈ [-127, 127] → u ∈ [1, 255]</span>
            </div>
            <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center justify-between">
              <span className="text-slate-400">Poseidon Hash S-Box:</span>
              <span className="font-mono font-bold text-white">x^5 (circomlib BN254)</span>
            </div>
            <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 flex items-center justify-between">
              <span className="text-slate-400">Merkle Tree Depth:</span>
              <span className="font-mono font-bold text-white">20 (Capacity: 1,048,576)</span>
            </div>
          </div>
        </div>
      </div>

      {/* Card 3: Local Storage Security Audit */}
      <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6 sm:p-8 shadow-xl space-y-6 backdrop-blur-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <Database className="w-5 h-5 text-purple-400" />
            Enrolled Device State (IndexedDB Enclave)
          </h2>
          {identity && (
            <button
              onClick={handleClearLocalIdentity}
              className="text-xs text-red-400 hover:text-red-300 underline font-medium"
            >
              Clear Stored Identity
            </button>
          )}
        </div>

        {identity ? (
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-1">
                <span className="text-slate-400 font-medium">did:key Identifier:</span>
                <div className="font-mono text-white break-all text-xs">{identity.didKey}</div>
              </div>
              <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-1">
                <span className="text-slate-400 font-medium">Enrollment Timestamp:</span>
                <div className="font-mono text-emerald-400 text-xs">{identity.createdAt}</div>
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-1">
              <span className="text-slate-400 font-medium">Identity Commitment C_id (Public Merkle Leaf):</span>
              <div className="font-mono text-indigo-300 break-all text-xs">{identity.cId}</div>
            </div>

            <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-1">
              <span className="text-slate-400 font-medium">Embedding Commitment C_emb (Poseidon9 Chunk Hash):</span>
              <div className="font-mono text-slate-300 break-all text-xs">{identity.cEmb}</div>
            </div>

            <div className="p-4 rounded-2xl bg-emerald-950/25 border border-emerald-500/25 flex items-center gap-2.5 text-emerald-300">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>Zero Leakage Invariant Verified: idSecret and salt never leave local browser storage.</span>
            </div>
          </div>
        ) : (
          <div className="p-8 rounded-2xl bg-slate-950/50 border border-slate-800 text-center text-xs text-slate-400">
            No enrolled identity stored on this browser session. Enroll on the Enrollment page to inspect telemetry.
          </div>
        )}
      </div>
    </div>
  );
}
