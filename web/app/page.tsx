'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Shield,
  UserPlus,
  Award,
  Activity,
  Lock,
  Cpu,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { getBeneficiaryIdentity, StoredIdentity } from '@/lib/ml/storage';

export default function HomePage() {
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getBeneficiaryIdentity().then((id) => {
      setIdentity(id);
      setLoading(false);
    });
  }, []);

  return (
    <div className="space-y-12 animate-fade-in">
      {/* Hero Section */}
      <div className="relative overflow-hidden rounded-3xl border border-indigo-500/25 bg-gradient-to-b from-indigo-950/40 via-slate-900/60 to-slate-950/80 p-6 sm:p-12 shadow-2xl backdrop-blur-xl">
        <div className="absolute top-0 right-0 -mt-10 -mr-10 w-80 h-80 rounded-full bg-indigo-500/10 blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-0 -mb-10 -ml-10 w-80 h-80 rounded-full bg-emerald-500/10 blur-3xl pointer-events-none" />

        <div className="relative z-10 flex flex-col md:flex-row items-center justify-between gap-8 sm:gap-12">
          <div className="max-w-2xl space-y-5 text-center sm:text-left">
            <div className="inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-xs font-bold uppercase tracking-wider">
              <Shield className="w-3.5 h-3.5 text-indigo-400" />
              <span>Edge AI & Zero-Knowledge Architecture</span>
            </div>

            <h1 className="text-3xl sm:text-5xl lg:text-6xl font-black tracking-tight text-white leading-[1.15]">
              Self-Sovereign <br className="hidden sm:block" />
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 via-purple-300 to-emerald-400">
                Zero-Knowledge
              </span>{' '}
              Identity
            </h1>

            <p className="text-sm sm:text-base text-slate-300 leading-relaxed max-w-xl">
              AegisDID enables refugees and disaster-displaced individuals to prove identity and claim relief rations <strong>without disclosing biometric data, names, or secret keys</strong> to any central server.
            </p>

            {/* Identity Status Pill */}
            <div className="pt-2 flex flex-col sm:flex-row items-center gap-3">
              {loading ? (
                <div className="inline-flex items-center space-x-2 text-xs text-slate-400">
                  <div className="w-4 h-4 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
                  <span>Scanning local IndexedDB secure enclave...</span>
                </div>
              ) : identity ? (
                <div className="w-full sm:w-auto inline-flex items-center gap-3 p-3.5 rounded-2xl bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 text-xs">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
                  <div className="text-left truncate">
                    <div className="font-bold text-emerald-200">Active Identity Enrolled on This Device</div>
                    <div className="text-[11px] text-emerald-400/80 font-mono truncate max-w-xs sm:max-w-md">
                      {identity.didKey}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="w-full sm:w-auto inline-flex items-center gap-2.5 p-3.5 rounded-2xl bg-amber-950/30 border border-amber-500/20 text-amber-300 text-xs">
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                  <span>No biometric identity enrolled on this browser yet.</span>
                </div>
              )}
            </div>
          </div>

          {/* Hero Logo Showcase */}
          <div className="shrink-0 p-6 rounded-3xl bg-slate-900/80 border border-indigo-500/30 shadow-2xl shadow-indigo-500/20 backdrop-blur-md flex flex-col items-center justify-center">
            <div className="relative w-44 h-44 sm:w-56 sm:h-56">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/logo.png"
                alt="AegisDID Official Emblem"
                width={224}
                height={224}
                style={{ filter: 'drop-shadow(0 0 25px rgba(99,102,241,0.4))' }}
                className="object-contain w-full h-full"
              />
            </div>
            <div className="mt-3 text-center">
              <div className="text-xs font-bold text-slate-200 tracking-wider">A PROJECT BY</div>
              <div className="text-[11px] font-mono text-indigo-400 font-semibold">ZEROTRUST LABS</div>
            </div>
          </div>
        </div>
      </div>

      {/* Action Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Card 1: Enroll */}
        <Link
          href="/enroll"
          className="group relative rounded-3xl border border-slate-800/80 bg-slate-900/50 p-6 sm:p-7 hover:border-indigo-500/60 hover:bg-slate-900/90 transition-all shadow-xl hover:shadow-indigo-500/10 flex flex-col justify-between"
        >
          <div className="space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 group-hover:scale-110 group-hover:bg-indigo-600 group-hover:text-white transition-all">
              <UserPlus className="w-6 h-6" />
            </div>
            <h2 className="text-xl font-bold text-white group-hover:text-indigo-300 transition-colors">
              1. Enroll Beneficiary
            </h2>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
              Extract 128-d biometric embedding, quantize to int8, generate cryptographic secrets in local IndexedDB, and publish only your Identity Commitment (C_id).
            </p>
          </div>
          <div className="mt-6 flex items-center text-xs font-bold text-indigo-400 group-hover:translate-x-1 transition-transform">
            <span>Start Enrollment</span>
            <ArrowRight className="w-4 h-4 ml-1.5" />
          </div>
        </Link>

        {/* Card 2: Claim Aid */}
        <Link
          href="/claim"
          className="group relative rounded-3xl border border-slate-800/80 bg-slate-900/50 p-6 sm:p-7 hover:border-emerald-500/60 hover:bg-slate-900/90 transition-all shadow-xl hover:shadow-emerald-500/10 flex flex-col justify-between"
        >
          <div className="space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-emerald-600/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 group-hover:scale-110 group-hover:bg-emerald-600 group-hover:text-white transition-all">
              <Award className="w-6 h-6" />
            </div>
            <h2 className="text-xl font-bold text-white group-hover:text-emerald-300 transition-colors">
              2. Claim Aid Allocation
            </h2>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
              Verify liveness with eye-blink & head-turn challenges, generate a Groth16 ZK proof in a Web Worker, and claim relief on Base Sepolia.
            </p>
          </div>
          <div className="mt-6 flex items-center text-xs font-bold text-emerald-400 group-hover:translate-x-1 transition-transform">
            <span>Generate Proof & Claim</span>
            <ArrowRight className="w-4 h-4 ml-1.5" />
          </div>
        </Link>

        {/* Card 3: Diagnostics */}
        <Link
          href="/diagnostics"
          className="group relative rounded-3xl border border-slate-800/80 bg-slate-900/50 p-6 sm:p-7 hover:border-amber-500/60 hover:bg-slate-900/90 transition-all shadow-xl hover:shadow-amber-500/10 flex flex-col justify-between"
        >
          <div className="space-y-4">
            <div className="w-12 h-12 rounded-2xl bg-amber-600/20 border border-amber-500/30 flex items-center justify-center text-amber-400 group-hover:scale-110 group-hover:bg-amber-600 group-hover:text-white transition-all">
              <Activity className="w-6 h-6" />
            </div>
            <h2 className="text-xl font-bold text-white group-hover:text-amber-300 transition-colors">
              3. System Diagnostics
            </h2>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
              Run interactive prover latency benchmarks, inspect circuit constraint metrics, and verify zero-network leakage security invariants.
            </p>
          </div>
          <div className="mt-6 flex items-center text-xs font-bold text-amber-400 group-hover:translate-x-1 transition-transform">
            <span>Open Telemetry</span>
            <ArrowRight className="w-4 h-4 ml-1.5" />
          </div>
        </Link>
      </div>

      {/* How It Works Visual Step-by-Step */}
      <div className="rounded-3xl border border-slate-800/80 bg-slate-900/40 p-6 sm:p-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-lg font-bold text-white flex items-center gap-2">
              <Cpu className="w-5 h-5 text-indigo-400" />
              How In-Browser Zero-Knowledge Identity Works
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              100% of mathematical proving runs client-side in WebAssembly without server dependencies
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-2">
            <div className="w-7 h-7 rounded-lg bg-indigo-500/20 text-indigo-400 font-bold text-xs flex items-center justify-center">
              1
            </div>
            <div className="font-bold text-white text-xs">On-Device Capture</div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Camera extracts 128-d face embedding via `face-api.js` directly in browser memory.
            </p>
          </div>

          <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-2">
            <div className="w-7 h-7 rounded-lg bg-purple-500/20 text-purple-400 font-bold text-xs flex items-center justify-center">
              2
            </div>
            <div className="font-bold text-white text-xs">int8 Quantization</div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Float vector converts to field-safe integers (u in [1, 255]) matching circom specifications.
            </p>
          </div>

          <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-2">
            <div className="w-7 h-7 rounded-lg bg-emerald-500/20 text-emerald-400 font-bold text-xs flex items-center justify-center">
              3
            </div>
            <div className="font-bold text-white text-xs">Groth16 Prover</div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              `snarkjs` proves biometric match and Merkle membership in a background Web Worker.
            </p>
          </div>

          <div className="p-4 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-2">
            <div className="w-7 h-7 rounded-lg bg-cyan-500/20 text-cyan-400 font-bold text-xs flex items-center justify-center">
              4
            </div>
            <div className="font-bold text-white text-xs">Base Sepolia Claim</div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Smart contract verifies proof against stored policy tauQ and logs single-use nullifier.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
