'use client';

/**
 * DEVELOPMENT-ONLY liveness harness.
 *
 * ISOLATION (required by the project's security rules): this page exercises the real
 * LivenessTracker against SYNTHETIC MediaPipe signal traces so the challenge can be verified
 * without a camera. It renders nothing but numbers and it is not reachable from any navigation.
 * It cannot affect a claim: the tracker instances here are local to this component, the page
 * never touches the camera, an embedding, a proof, a wallet, or the chain, and /claim constructs
 * its own tracker. There is no "pass liveness" affordance here — feeding it a static trace fails,
 * exactly as a held photo does at /claim.
 *
 * The traces cover the two field failures the v3 rewrite addresses: a real subject blinking
 * normally counted 0 of 1 blinks, and moving the camera away counted a phantom blink.
 */

import { useState } from 'react';
import {
  LivenessTracker,
  BLINK_CLOSE_ENTER,
  BLINK_POSE_LIMIT_DEG,
  CALIBRATION_FRAMES,
  REQUIRED_BLINKS,
  TURN_DEV_DEG,
  type LivenessSignals,
  type LivenessState,
} from '../../../lib/ml/liveness';

const FRAME_MS = 33;
const OPEN_COEFF = 0.05;
const CLOSED_COEFF = 0.9;
const BASE_SCALE = 0.18;
const BASE_SCALE_PX = 115;

function sig(overrides: Partial<LivenessSignals> = {}): LivenessSignals {
  return {
    ok: true,
    blinkLeft: OPEN_COEFF,
    blinkRight: OPEN_COEFF,
    yawDeg: 0,
    faceScale: BASE_SCALE,
    faceScalePx: BASE_SCALE_PX,
    confidence: 0.99,
    ...overrides,
  };
}

/** Deterministic injected clock — no wall-clock waits, no stubbed globals. */
function makeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    tick: (ms = FRAME_MS) => (now += ms),
  };
}

type Clock = ReturnType<typeof makeClock>;

function calibrate(t: LivenessTracker, c: Clock): LivenessState {
  let s = t.processFrame(sig(), c.now());
  for (let i = 0; i < CALIBRATION_FRAMES + 2; i++) {
    c.tick();
    s = t.processFrame(sig(), c.now());
  }
  return s;
}

/** One physiologically plausible blink: ~100 ms of closure, then a confirmed reopen. */
function blinkOnce(t: LivenessTracker, c: Clock, yawDeg = 0): LivenessState {
  let s = t.processFrame(sig({ blinkLeft: CLOSED_COEFF, blinkRight: CLOSED_COEFF, yawDeg }), c.now());
  for (let i = 0; i < 2; i++) {
    c.tick();
    s = t.processFrame(sig({ blinkLeft: CLOSED_COEFF, blinkRight: CLOSED_COEFF, yawDeg }), c.now());
  }
  for (let i = 0; i < 4; i++) {
    c.tick();
    s = t.processFrame(sig({ yawDeg }), c.now());
  }
  return s;
}

/** Turn away past TURN_DEV_DEG, dwell, return to neutral, dwell. */
function turnAndReturn(t: LivenessTracker, c: Clock): LivenessState {
  let s = t.processFrame(sig({ yawDeg: 35 }), c.now());
  for (let i = 0; i < 15; i++) {
    c.tick();
    s = t.processFrame(sig({ yawDeg: 35 }), c.now());
  }
  for (let i = 0; i < 15; i++) {
    c.tick();
    s = t.processFrame(sig(), c.now());
  }
  return s;
}

interface Row {
  name: string;
  detail: string;
  ok: boolean;
}

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

  function run() {
    setRunning(true);
    setRows([]);
    const out: Row[] = [];

    // --- 1. Calibration establishes a neutral pose, not a blink baseline --------------
    {
      const c = makeClock();
      const t = new LivenessTracker();
      const s = calibrate(t, c);
      out.push({
        name: 'calibration completes and fixes a neutral yaw baseline',
        detail: `calibrating=${s.calibrating}, yawBaseline=${s.yawBaselineDeg.toFixed(2)}°, state=${s.challengeState}`,
        ok: !s.calibrating && Math.abs(s.yawBaselineDeg) < 1,
      });
      out.push({
        name: 'blink threshold is an absolute coefficient, not a moving ratio',
        detail: `closed enter ≥ ${BLINK_CLOSE_ENTER}, observed open coeff ${s.blinkScore.toFixed(3)}`,
        ok: s.blinkScore < BLINK_CLOSE_ENTER,
      });
    }

    // --- 2. Natural actions complete the challenge (both possible orders) -------------
    {
      const c = makeClock();
      const t = new LivenessTracker();
      let s = calibrate(t, c);
      for (let guard = 0; guard < 8 && !s.isComplete; guard++) {
        const step = s.sequence[s.stepIndex];
        if (step === 'turn') s = turnAndReturn(t, c);
        else s = blinkOnce(t, c);
        c.tick();
      }
      out.push({
        name: 'challenge completes with natural blinks + head turn',
        detail: `score ${s.livenessScore}/100, blinks ${s.blinkCount}/${s.requiredBlinks}, order [${s.sequence.join(', ')}], t ${(s.elapsedMs / 1000).toFixed(2)}s`,
        ok: s.isComplete && !s.isTimedOut && s.blinkCount >= REQUIRED_BLINKS,
      });
    }

    // --- 3. One blink is counted exactly once ----------------------------------------
    {
      const c = makeClock();
      const t = new LivenessTracker();
      calibrate(t, c);
      const s = blinkOnce(t, c);
      out.push({
        name: 'a single blink counts 1, never 2',
        detail: `blinks ${s.blinkCount}/${s.requiredBlinks}, closures ${s.closuresSeen}, phase ${s.blinkPhase}`,
        ok: s.blinkCount === 1 && s.closuresSeen === 1,
      });
    }

    // --- 4. ATTACK: a static photo (constant coefficients, constant pose) -------------
    {
      const c = makeClock();
      const t = new LivenessTracker();
      let s = calibrate(t, c);
      for (let i = 0; i < 1200; i++) {
        c.tick();
        s = t.processFrame(sig(), c.now());
      }
      out.push({
        name: 'ATTACK static photo: no blink, no turn, never completes',
        detail: `blinks ${s.blinkCount}, closures ${s.closuresSeen}, turned ${s.hasTurnedHead}, score ${s.livenessScore}, timedOut ${s.isTimedOut}`,
        ok: !s.isComplete && s.blinkCount === 0 && !s.hasTurnedHead && s.livenessScore === 0,
      });
    }

    // --- 5. ATTACK: hand over the lens / sustained closure ---------------------------
    {
      const c = makeClock();
      const t = new LivenessTracker();
      calibrate(t, c);
      let s = t.processFrame(sig({ blinkLeft: CLOSED_COEFF, blinkRight: CLOSED_COEFF }), c.now());
      for (let i = 0; i < 90; i++) {
        c.tick();
        s = t.processFrame(sig({ blinkLeft: CLOSED_COEFF, blinkRight: CLOSED_COEFF }), c.now());
      }
      for (let i = 0; i < 6; i++) {
        c.tick();
        s = t.processFrame(sig(), c.now());
      }
      out.push({
        name: 'ATTACK ~3 s sustained closure is never credited as a blink',
        detail: `blinks ${s.blinkCount}, closures ${s.closuresSeen}, phase ${s.blinkPhase}`,
        ok: s.blinkCount === 0,
      });
    }

    // --- 6. REGRESSION: moving the camera away must not fake a blink -----------------
    // This is the exact v2 field failure. The blendshape coefficient is scale-invariant, so
    // shrinking the face changes faceScale and nothing else.
    {
      const c = makeClock();
      const t = new LivenessTracker();
      let s = calibrate(t, c);
      for (let i = 0; i < 120; i++) {
        c.tick();
        const f = 1 - i / 160; // face shrinks to ~25% of its calibrated size
        s = t.processFrame(
          sig({ faceScale: BASE_SCALE * f, faceScalePx: BASE_SCALE_PX * f }),
          c.now()
        );
      }
      out.push({
        name: 'REGRESSION camera pulled away: zero phantom blinks',
        detail: `blinks ${s.blinkCount}, closures ${s.closuresSeen}, final quality ${s.faceQuality}, iod ${s.faceScalePx.toFixed(0)}px`,
        ok: s.blinkCount === 0 && s.closuresSeen === 0,
      });
    }

    // --- 7. Blink updates are suspended during strong head rotation ------------------
    {
      const c = makeClock();
      const t = new LivenessTracker();
      calibrate(t, c);
      const s = blinkOnce(t, c, 45); // 45° >> BLINK_POSE_LIMIT_DEG
      out.push({
        name: `blink is not counted beyond ±${BLINK_POSE_LIMIT_DEG}° yaw`,
        detail: `blinks ${s.blinkCount}, phase ${s.blinkPhase} (yaw 45°)`,
        ok: s.blinkCount === 0,
      });
    }

    // --- 8. A turn needs sustained deviation AND a sustained return ------------------
    {
      const c = makeClock();
      const t = new LivenessTracker();
      calibrate(t, c);
      // one noisy frame past the threshold
      let s = t.processFrame(sig({ yawDeg: 60 }), c.now());
      c.tick();
      s = t.processFrame(sig(), c.now());
      const afterSpike = s.hasTurnedHead;

      // sustained turn, but no return
      for (let i = 0; i < 20; i++) {
        c.tick();
        s = t.processFrame(sig({ yawDeg: 35 }), c.now());
      }
      out.push({
        name: 'a single out-of-range frame does not satisfy the turn',
        detail: `after 1-frame spike hasTurnedHead=${afterSpike} (needs ${TURN_DEV_DEG}° sustained)`,
        ok: afterSpike === false,
      });
      out.push({
        name: 'turn without returning to centre does not complete the action',
        detail: `hasTurnedHead=${s.hasTurnedHead}, state=${s.challengeState}`,
        ok: s.hasTurnedHead === false,
      });
    }

    // --- 9. Unusable frames never advance anything -----------------------------------
    {
      const c = makeClock();
      const t = new LivenessTracker();
      calibrate(t, c);
      let s = t.processFrame(sig({ ok: false }), c.now());
      for (let i = 0; i < 40; i++) {
        c.tick();
        s = t.processFrame(sig({ ok: false }), c.now());
      }
      const noFace = s.faceQuality;
      c.tick();
      s = t.processFrame(sig({ multipleFaces: true, ok: false }), c.now());
      out.push({
        name: 'dropped landmarks and multi-face frames are refused, not guessed',
        detail: `lost-face quality=${noFace}, multi-face quality=${s.faceQuality}, blinks ${s.blinkCount}`,
        ok: noFace === 'no-face' && s.faceQuality === 'multiple-faces' && s.blinkCount === 0,
      });
    }

    // --- 10. Randomization is live (not a fixed script an attacker can pre-record) ----
    {
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) seen.add(new LivenessTracker().challengeDescription);
      out.push({
        name: 'challenge order is randomized per attempt',
        detail: `${seen.size} distinct challenge orders across 200 resets`,
        ok: seen.size >= 2,
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
        Drives the real LivenessTracker with synthetic MediaPipe signal traces and an injected
        clock. No camera, no embedding, no proof, no chain. Not linked from the app.
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
