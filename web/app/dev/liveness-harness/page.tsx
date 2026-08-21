'use client';

/**
 * DEVELOPMENT-ONLY liveness harness.
 *
 * ISOLATION (required by the project's security rules): this page exercises the real
 * LivenessTracker against SYNTHETIC landmark traces so the challenge can be verified without a
 * camera. It renders nothing but numbers and it is not reachable from any navigation. It cannot
 * affect a claim: the tracker instances here are local to this component, the page never touches
 * the camera, an embedding, a proof, a wallet, or the chain, and /claim constructs its own tracker.
 * There is no "pass liveness" affordance here — feeding it a static trace fails, exactly as a held
 * photo does at /claim.
 *
 * The traces below are the field failure the fix addresses: a real subject whose steady open-eye
 * EAR was 0.277, blinking normally, counted 0 of 1 blinks over 42.9 s.
 */

import { useState } from 'react';
import { LivenessTracker, BLINK_DIP_FACTOR, BLINK_RECOVER_FACTOR, type LandmarkPoint } from '../../../lib/ml/liveness';

const EYE_H = 30;
const FACE_W = 200;

/** Inverts the production EAR/yaw geometry so a requested (ear, yaw) is what the tracker computes. */
function makeLandmarks(ear: number, yaw: number): LandmarkPoint[] {
  const pts: LandmarkPoint[] = Array.from({ length: 68 }, () => ({ x: 0, y: 0 }));
  const v = ear * EYE_H;
  pts[36] = { x: 0, y: 0 };
  pts[39] = { x: EYE_H, y: 0 };
  pts[37] = { x: 10, y: -v / 2 };
  pts[41] = { x: 10, y: v / 2 };
  pts[38] = { x: 20, y: -v / 2 };
  pts[40] = { x: 20, y: v / 2 };
  pts[45] = { x: 100, y: 0 };
  pts[42] = { x: 100 + EYE_H, y: 0 };
  pts[44] = { x: 110, y: -v / 2 };
  pts[46] = { x: 110, y: v / 2 };
  pts[43] = { x: 120, y: -v / 2 };
  pts[47] = { x: 120, y: v / 2 };
  pts[0] = { x: 0, y: 200 };
  pts[16] = { x: FACE_W, y: 200 };
  pts[30] = { x: (FACE_W * yaw) / (1 + yaw), y: 150 };
  return pts;
}

interface Row {
  name: string;
  detail: string;
  ok: boolean;
}

const OPEN = 0.277;
const JITTER = [0.277, 0.305, 0.288, 0.316, 0.271, 0.298, 0.322, 0.284, 0.279, 0.311, 0.290, 0.276];

export default function LivenessHarnessPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);

  // EXPLICIT ISOLATION, not incidental. Being unlinked is not isolation — the route would still
  // answer in a deployed build. This refuses to exist outside a development server, so a
  // testnet/production deployment has no dev harness surface at all. Inlined rather than read from
  // a helper so the condition is statically visible to the bundler and dead-code eliminated.
  if (process.env.NODE_ENV === 'production') {
    return (
      <main className="min-h-screen bg-slate-950 text-slate-400 p-8 font-mono text-sm">
        This development-only harness is disabled outside a development build.
      </main>
    );
  }

  async function run() {
    setRunning(true);
    setRows([]);
    const out: Row[] = [];

    // --- 1. Field scenario: jittery calibration, then one natural blink ---------------
    {
      const t = new LivenessTracker();
      for (const e of JITTER) t.processFrame(makeLandmarks(e, 1.0));
      let s = t.processFrame(makeLandmarks(OPEN, 1.0));

      const oldBaseline =
        [...JITTER].sort((a, b) => b - a).slice(0, 3).reduce((x, v) => x + v, 0) / 3;
      out.push({
        name: 'old top-3 estimator would be unreachable',
        detail: `old baseline ${oldBaseline.toFixed(4)} -> recover ${(oldBaseline * 0.88).toFixed(4)} vs open ${OPEN}`,
        ok: oldBaseline * 0.88 > OPEN,
      });
      out.push({
        name: 'new median baseline tracks the true open EAR',
        detail: `baseline ${s.earBaseline.toFixed(4)} (open ${OPEN})`,
        ok: Math.abs(s.earBaseline - OPEN) < 0.02,
      });
      out.push({
        name: 'recover threshold is reachable',
        detail: `recover ${(s.earBaseline * BLINK_RECOVER_FACTOR).toFixed(4)} < open ${OPEN}`,
        ok: s.earBaseline * BLINK_RECOVER_FACTOR < OPEN,
      });

      // Complete whichever action comes first, then blink / turn as required.
      const closed = OPEN * BLINK_DIP_FACTOR * 0.8;
      const start = performance.now();
      for (let i = 0; i < 400 && !s.isComplete && performance.now() - start < 8000; i++) {
        const step = s.sequence[s.stepIndex];
        if (step === 'turn') {
          s = t.processFrame(makeLandmarks(OPEN, 1.45));
          s = t.processFrame(makeLandmarks(OPEN, 1.0));
        } else {
          s = t.processFrame(makeLandmarks(closed, 1.0));
          await new Promise((r) => setTimeout(r, 90)); // real wall-clock closure
          s = t.processFrame(makeLandmarks(OPEN, 1.0));
        }
      }
      out.push({
        name: 'challenge completes with natural actions (real clock)',
        detail: `score ${s.livenessScore}/100, blinks ${s.blinkCount}/${s.requiredBlinks}, t ${(s.elapsedMs / 1000).toFixed(1)}s, "${s.currentPrompt}"`,
        ok: s.isComplete && !s.isTimedOut,
      });
    }

    // --- 2. ATTACK: a static photo (constant EAR, constant yaw) -----------------------
    {
      const t = new LivenessTracker();
      let s = t.processFrame(makeLandmarks(0.29, 1.0));
      for (let i = 0; i < 2000; i++) s = t.processFrame(makeLandmarks(0.29, 1.0));
      out.push({
        name: 'ATTACK static photo: no blink, no turn, never completes',
        detail: `blinks ${s.blinkCount}, closures ${s.blinkDipsSeen}, turned ${s.hasTurnedHead}, score ${s.livenessScore}`,
        ok: !s.isComplete && s.blinkCount === 0 && !s.hasTurnedHead && s.livenessScore === 0,
      });
    }

    // --- 3. ATTACK: hand over the lens / sustained closure ----------------------------
    {
      const t = new LivenessTracker();
      for (let i = 0; i < 14; i++) t.processFrame(makeLandmarks(0.30, 1.0));
      const closed = 0.30 * BLINK_DIP_FACTOR * 0.8;
      t.processFrame(makeLandmarks(closed, 1.0));
      const start = performance.now();
      while (performance.now() - start < 2500) t.processFrame(makeLandmarks(closed, 1.0));
      const s = t.processFrame(makeLandmarks(0.30, 1.0));
      out.push({
        name: 'ATTACK sustained occlusion is not credited as a blink',
        detail: `2.5 s closure -> blinks ${s.blinkCount}`,
        ok: s.blinkCount === 0,
      });
    }

    // --- 4. Randomization is live (not a fixed script an attacker can pre-record) -----
    {
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const t = new LivenessTracker();
        seen.add(t.challengeDescription);
      }
      out.push({
        name: 'challenge is randomized per attempt',
        detail: `${seen.size} distinct challenges across 200 resets`,
        ok: seen.size >= 3,
      });
    }

    setRows(out);
    setRunning(false);
  }

  const failed = rows.filter((r) => !r.ok).length;

  return (
    <main className="min-h-screen bg-slate-950 text-slate-200 p-8 font-mono text-sm">
      <h1 className="text-lg font-bold mb-1">Liveness harness (development only)</h1>
      <p className="text-xs text-slate-500 mb-6 max-w-2xl">
        Drives the real LivenessTracker with synthetic landmark traces. No camera, no embedding, no
        proof, no chain. Not linked from the app.
      </p>
      <button
        onClick={run}
        disabled={running}
        className="px-4 py-2 rounded bg-emerald-700 disabled:bg-slate-800 disabled:text-slate-500"
      >
        {running ? 'running…' : 'run'}
      </button>
      <div className="mt-6 space-y-2">
        {rows.map((r) => (
          <div key={r.name} className={r.ok ? 'text-emerald-400' : 'text-red-400'}>
            <div>
              {r.ok ? 'PASS' : 'FAIL'} — {r.name}
            </div>
            <div className="text-slate-500 pl-12 text-xs">{r.detail}</div>
          </div>
        ))}
      </div>
      {rows.length > 0 && (
        <div className="mt-6 pt-4 border-t border-slate-800" data-testid="verdict">
          {rows.length - failed} passed, {failed} failed
        </div>
      )}
    </main>
  );
}
