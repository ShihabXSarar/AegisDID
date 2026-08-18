import type { Metadata } from 'next';
import './globals.css';
import Link from 'next/link';
import { UserPlus, Award, Activity, Home, ShieldCheck } from 'lucide-react';

export const metadata: Metadata = {
  title: 'AegisDID — Zero-Knowledge Biometric Identity',
  description: 'Sybil-Resistant Decentralized Identity for Humanitarian Relief via Edge AI & ZK-ML.',
  icons: {
    icon: '/logo.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#060911] text-slate-100 min-h-screen flex flex-col antialiased selection:bg-indigo-500 selection:text-white pb-16 sm:pb-0">
        {/* Top Header */}
        <header className="sticky top-0 z-50 border-b border-indigo-950/60 bg-[#060911]/90 backdrop-blur-xl">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 h-20 flex items-center justify-between">
            {/* Brand Logo — uses plain <img> so it works in ALL environments (tunnel, mobile, localhost) */}
            <Link href="/" className="flex items-center space-x-3 group">
              <div className="relative w-12 h-12 sm:w-14 sm:h-14 flex items-center justify-center group-hover:scale-105 transition-transform shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/logo.png"
                  alt="AegisDID Logo"
                  width={56}
                  height={56}
                  style={{ filter: 'drop-shadow(0 0 12px rgba(99,102,241,0.5))' }}
                  className="object-contain w-full h-full"
                />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-400 border border-indigo-500/30">
                    Client ZK
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 hidden sm:block font-medium">
                  Privacy · Identity · Dignity
                </p>
              </div>
            </Link>

            {/* Desktop Navigation Links */}
            <nav className="hidden sm:flex items-center space-x-2">
              <Link href="/" className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:text-white hover:bg-slate-800/60 transition-all">
                <Home className="w-4 h-4 text-slate-400" />
                <span>Overview</span>
              </Link>
              <Link href="/enroll" className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:text-white hover:bg-slate-800/60 transition-all">
                <UserPlus className="w-4 h-4 text-indigo-400" />
                <span>Enroll</span>
              </Link>
              <Link href="/claim" className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:text-white hover:bg-slate-800/60 transition-all">
                <Award className="w-4 h-4 text-emerald-400" />
                <span>Claim Aid</span>
              </Link>
              <Link href="/diagnostics" className="flex items-center space-x-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:text-white hover:bg-slate-800/60 transition-all">
                <Activity className="w-4 h-4 text-amber-400" />
                <span>Diagnostics</span>
              </Link>
            </nav>

            {/* Network Status Badge */}
            <div className="hidden lg:flex items-center space-x-2.5 px-3 py-1.5 rounded-full bg-slate-900/80 border border-slate-800 text-xs font-mono">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-slate-300">Base Sepolia</span>
              <span className="text-slate-600">|</span>
              <span className="text-indigo-400 font-semibold">WASM Ready</span>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6 sm:py-10">
          {children}
        </main>

        {/* Mobile Bottom Nav */}
        <nav className="sm:hidden fixed bottom-0 left-0 right-0 z-50 bg-[#060911]/95 backdrop-blur-lg border-t border-slate-800 flex items-center justify-around py-2.5 px-2">
          <Link href="/" className="flex flex-col items-center gap-0.5 text-[10px] text-slate-400 hover:text-white transition-colors">
            <Home className="w-5 h-5" />
            <span>Home</span>
          </Link>
          <Link href="/enroll" className="flex flex-col items-center gap-0.5 text-[10px] text-indigo-400 font-semibold">
            <UserPlus className="w-5 h-5" />
            <span>Enroll</span>
          </Link>
          <Link href="/claim" className="flex flex-col items-center gap-0.5 text-[10px] text-emerald-400 font-semibold">
            <Award className="w-5 h-5" />
            <span>Claim</span>
          </Link>
          <Link href="/diagnostics" className="flex flex-col items-center gap-0.5 text-[10px] text-amber-400 font-semibold">
            <Activity className="w-5 h-5" />
            <span>Diagnostics</span>
          </Link>
        </nav>

        {/* Footer */}
        <footer className="border-t border-slate-800/80 bg-[#060911] py-8 text-xs text-slate-500 hidden sm:block">
          <div className="max-w-6xl mx-auto px-4 flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="AegisDID" width={22} height={22} className="object-contain shrink-0" />
              <div>
                <p className="font-semibold text-slate-300">AegisDID — Commodity Smartphone Zero-Knowledge Biometric Identity</p>
                <p className="text-[11px] text-slate-500">Privacy-preserving relief distribution powered by client-side WebAssembly & Groth16</p>
              </div>
            </div>
            <span className="flex items-center gap-1.5 text-emerald-400 font-medium">
              <ShieldCheck className="w-4 h-4" />
              Zero Biometric Leakage Invariant
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
