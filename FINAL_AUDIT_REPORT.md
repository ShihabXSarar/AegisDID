# AegisDID — Final Audit & Liveness-Hardening Report

**Date:** 2026-08-24 (§13 live-run pass extended 2026-08-25)
**Scope of this pass:** replace and harden the browser liveness / anti-spoofing subsystem (the
face-api EAR challenge → MediaPipe Face Landmarker), then run full regression across the
untouched identity / ZK / chain stack and record an honest, evidence-backed readiness verdict.

> **Ground rule honoured throughout:** no fake proofs, no fake transactions, no hardcoded
> liveness success, no fabricated metrics. Every "PASS" below is backed by a command that was
> actually run this session; anything I could not verify with the tools available is marked
> **NOT VERIFIED**, not guessed.

---

## 0. OVERALL VERDICT

### **READY WITH KNOWN LIMITATIONS**

The system builds, type-checks, lints, and passes every automated test suite (identity
quantisation, ZK circuit conformance with a *real* Groth16 proof, Solidity contract suite, and the
new deterministic liveness suite). The deployed contract has verifiably **accepted a real claim on
Base Sepolia** — an `AidClaimed` event decoded straight from the chain, not from app state (§13.2).
Two limitations keep this from an unqualified "READY":

1. **Software-only liveness is defeatable by an on-demand replay video or by frame injection.**
   This is inherent to doing liveness in page JavaScript that the device owner controls, is
   documented in `docs/THREAT_MODEL.md` §2.1, and carries a **HIGH** residual risk. It can only
   be closed by hardware sensor attestation, which is explicitly out of scope and not implemented.
2. **The live-webcam behaviours (Tests A–I) could not be machine-verified by me** — the available
   tooling cannot grant a real `getUserMedia` camera stream. They are reported by the operator as
   passing (see §6); I record that as their attestation, distinct from my own verified evidence.

This is a **prototype ready for a competition demo and technical review**, not a deployable
aid-distribution control. That framing matches the project's own documentation.

---

## 1. ROOT CAUSE — why the old liveness was replaced

v2 derived blink from the **Eye Aspect Ratio (EAR)** of face-api.js's 68-point landmarks compared
against a rolling baseline (`ear < baseline * 0.72`). Three failure modes, two of them observed in
the field:

1. **Missed real blinks.** face-api's eyelid landmarks are regressed from a 224 px crop and barely
   track a fast eyelid, so EAR often dipped far less than the threshold. Field capture showed a
   subject blinking normally for 42.9 s and being counted **0 of 1**.
2. **Phantom blink when the camera moved away.** EAR is only scale-invariant in theory; as the
   face shrinks, landmark quantisation error grows relative to the eye, collapsing EAR while the
   slow baseline EMA stayed high — a textbook dip-and-recovery that counted as a blink.
3. **Self-reinforcing degradation.** The baseline EMA admitted partial closures, so each near-miss
   dragged the baseline down, moving the threshold further from the blink minimum and making
   detection progressively worse the harder the user tried.

The fix is **a different signal, not a new threshold.** MediaPipe Face Landmarker emits
`eyeBlinkLeft` / `eyeBlinkRight` blendshape coefficients — a semantic, already-normalised [0,1]
estimate of eyelid closure, trained end-to-end. It is scale-invariant (so failure mode 2 is
structurally impossible) and needs no adaptive baseline (so failure mode 3 cannot exist).

---

## 2. NEW ARCHITECTURE

Two modules, a deliberate responsibility split, and a hard fail-closed boundary.

```
camera ─┬─▶ face-api.js  ──▶ 128-D descriptor ──▶ quantise ──▶ commitments ──▶ Merkle ──▶ ZK proof   [IDENTITY — unchanged]
        │
        └─▶ MediaPipe FaceLandmarker ──▶ LivenessSignals ──▶ LivenessTracker (pure FSM)              [LIVENESS — new]
```

| File | Role |
|---|---|
| `web/lib/ml/mediapipeLiveness.ts` *(new)* | Loads the Face Landmarker (GPU→CPU retry), runs one synchronous inference per frame, and converts it to the small numeric `LivenessSignals` struct. Every failure path returns `ok:false`. No synthetic landmark, dummy blendshape, or hardcoded success anywhere. |
| `web/lib/ml/liveness.ts` *(rewritten)* | A **pure, DOM-free, timer-free** state machine. Consumes `LivenessSignals`, takes `now` as a parameter. No reference to MediaPipe, face-api, or the DOM — which is what makes it deterministically testable from Node. |
| `web/app/claim/page.tsx` *(liveness wiring only)* | MediaPipe drives liveness every frame; face-api's alignment probe is throttled to 200 ms and is now **cosmetic only** (viewfinder chrome), which is what previously let a far-away face fake a blink. Fail-closed engine gate before the camera opens; engine-status banner; new telemetry row. |

**Privacy / secret-exposure:** zero network requests at runtime — model and WASM are served from
`web/public/mediapipe/`. No frame, landmark, descriptor, or blendshape ever leaves the browser.
Dev telemetry exposes only blendshape/pose scores and FSM state — **never** raw pixels, embeddings,
`idSecret`, `salt`, or any ZK private-witness value.

**MODEL_HASH safety (critical):** MediaPipe assets went to `web/public/mediapipe/`, deliberately
**not** `web/public/models/`. `MODEL_HASH` is `keccak256` over every file in `public/models` and is
committed on-chain in every policy; adding a file there would invalidate every existing commitment.
Re-verified this session: **`0x1515797c…981c6ff4`, unchanged** (7 files, 7,023,338 model bytes).

**Fail-closed (Step 19):** if MediaPipe, the camera, the model, or the landmarks fail, there is no
liveness success, no proof, and no claim. `handleStartVerification` awaits `initLivenessEngine()`
and aborts to an error state on failure — the camera is never opened. There is no fallback path.

---

## 3. BLINK ALGORITHM

Temporal FSM `OPEN → CLOSING → CLOSED → OPEN`, plus `LOCKED` (over-long closure / occlusion) and
`SUSPENDED` (pose unreliable). A blink is credited **exactly once**, on the confirmed
`CLOSED → OPEN` edge, only if **all** of:

- **Duration** 80–700 ms (`BLINK_MIN_MS`…`BLINK_MAX_MS`).
- **At least 2 frames** inside the closure read above `BLINK_CLOSE_ENTER` (`BLINK_MIN_CLOSED_FRAMES`).
  Combined with the 80 ms floor, a *single* anomalous 30 fps frame (~66 ms) can never be a blink no
  matter how high its coefficient spikes.
- **Bilateral agreement:** both eyelids reach ≥ `BLINK_BILATERAL_MIN` (0.30) — a one-eyed landmark
  spike is discarded.
- **Hysteresis:** enter ≥ 0.50, exit ≤ 0.32, so a coefficient hovering mid-band cannot oscillate a
  counter.

Guarantees enforced (and tested): no double-count; a single blink never becomes 2/2 however long
the eyes stay open; a prolonged closure becomes `LOCKED` and is counted as a *closure* but never a
blink; a camera-distance change never increments the counter; blink updates are **suspended**
beyond ±22° yaw but **already-credited blinks are never revoked**.

---

## 4. HEAD-TURN ALGORITHM

Requires a **sustained** yaw deviation of ≥ 18° from the calibrated neutral pose (either
direction), held ≥ 180 ms, **then** a **sustained** return to within 8°, also held ≥ 180 ms. Yaw is
computed from a roll- and scale-invariant orthonormal face frame (outer-eye axis × forehead-chin
axis → face normal → `atan2`), and only `|yaw − baseline|` is ever used, so no sign-convention can
cause a false accept/reject. A single out-of-range frame satisfies neither half (both require dwell).

---

## 5. THE RANDOMISED ORDER IS BINDING (security fix found this pass)

Per attempt the challenge draws a random action **order** (blink-first or turn-first). The blink
**count is fixed at 2** and is *not* randomisable — a randomisable count could be drawn downward,
weakening the check. Critically, the order is now **binding**: exactly one action is live at a time;
the inactive action's FSM still runs for telemetry but **cannot score**. A single pre-recorded clip
containing both actions therefore satisfies one order and fails the other. (In v2 the order was
decorative — both counters advanced regardless — so one clip satisfied either order.)

---

## 6. TESTS & VERIFICATION EVIDENCE

### 6.1 Machine-verified this session (all commands actually run)

| Check | Command | Result |
|---|---|---|
| Deterministic liveness FSM | `node scripts/liveness_test.mts` | **75 / 75 PASS** |
| Identity quantisation | `node scripts/quantize_test.mts` | **61 / 61 PASS** |
| ZK circuit conformance (real proof) | `node scripts/circuit_conformance.mts` | **29 / 29 PASS**, positive proof 1,748 ms |
| Solidity contract suite | `forge test` | **31 / 31 PASS** |
| Type check | `npx tsc --noEmit` | **clean (exit 0)** |
| Lint | `npx eslint app lib scripts --quiet` | **clean (exit 0)** |
| Production build | `npm run build:verify` | **success**, 11 routes |
| Dev-harness isolation | build output | `/dev/liveness-harness` = **382 B** (dead-code eliminated in production) |
| MODEL_HASH stability | `node tools/compute_model_hash.mjs` | **`0x1515797c…981c6ff4`, unchanged** |
| On-chain demo policy 107 | `cast call policies(107)` | root `0x163f2ace…fbe7`, **tauQ 14984**, modelHash canonical, epoch 1, allocation 110, remaining 5000, **active** |

The liveness suite includes the attack/regression cases required by the mandate: one-frame
coefficient spike, sub-80 ms closure, ~1 s held closure, ~3 s occlusion, one-eyed closure, camera
distance changing **both** directions (the v2 phantom-blink regression), dropped landmarks
mid-closure, multi-face frames, non-finite (NaN/Infinity) signals, a 1,200-frame static-photo
attack (score 0, times out), and out-of-order scripted actions under both orders.

### 6.2 Live-webcam behaviours (Tests A–I) — **NOT VERIFIED by me**

These require a real camera stream that the available tooling cannot grant, so I did **not**
machine-verify them and will not claim I did:

- A. genuine blink counts · B. two blinks complete the blink action · C. head turn + return
  completes · D. combined challenge completes in the randomised order · E. static printed photo
  fails · F. phone/second-screen replay of a still fails · G. camera pulled away produces no
  phantom blink · H. "Verified" never shows before `blinkCount ≥ required && headTurnComplete` ·
  I. engine-load failure blocks the claim.

**Operator attestation:** you have reported that the live liveness flow passes on your machine.
That is recorded here as your testimony and is consistent with every deterministic test above, but
it is **your** confirmation, not an independent machine verification by me.

---

## 7. FILES CHANGED

**Liveness subsystem (in scope):**
- `web/lib/ml/mediapipeLiveness.ts` — **new**, MediaPipe signal extraction.
- `web/lib/ml/liveness.ts` — **rewritten**, pure MediaPipe-driven FSM.
- `web/app/claim/page.tsx` — liveness wiring only (engine load/gate/banner/telemetry/loop).
- `web/app/dev/liveness-harness/page.tsx` — rewritten to drive the real FSM with synthetic signals.
- `web/scripts/liveness_test.mts` — rewritten, 75 deterministic assertions.
- `web/scripts/liveness_repro.mts` — **deleted** (referenced the removed EAR API).
- `web/package.json` / `web/package-lock.json` — added `@mediapipe/tasks-vision`.
- `web/public/mediapipe/**` — **new** vendored model + WASM (not in `public/models`, see §2).

**Docs (accuracy, in scope for this pass):**
- `docs/THREAT_MODEL.md` §2.1 — rewritten to describe the v3 liveness honestly.
- `docs/RESULTS.md` — liveness note corrected (no fabricated PAD rate).

**Integration fixes (outside the liveness subsystem — see §13 for why they were made anyway):**
- `web/lib/chain/client.ts` — `getLogs` chunk reduced 45000 → 9500 with a narrower 900-block retry,
  and the chunking extracted into one exported `getLogsChunked()` helper so no caller carries its own
  span literal. Read-path only. No change to proof verification, root comparison, nullifier handling
  or `tauQ` bounds.
- `web/app/dashboard/page.tsx` — `fetchEvents()` now uses that shared helper instead of its own
  duplicate 45000-block loop, and a failed log query surfaces as "history unknown" instead of being
  swallowed into a false "no claim has ever been verified" assertion (§13.2). `handlePublishRoot()`
  re-reads the authority root immediately before signing and refuses to publish a stale or
  unconfirmable one (§13.3). Read-path plus a *tightened* write guard; nothing was loosened.

**Untouched (verified unchanged):** all contracts / Solidity / Circom / Groth16 verifier / Merkle /
commitments / DID / enrolment API / policy creation / deployment. `web/lib/ml/face.ts` identity
pipeline is unchanged. The claim *page* is unchanged apart from the liveness wiring in
`app/claim/page.tsx` noted above.

---

## 8. KNOWN LIMITATIONS (stated plainly)

1. **Liveness is defeatable by on-demand video or frame injection.** Software-only liveness runs in
   page JS the device owner controls; the circuit does not constrain it and the contract cannot
   observe it. **Residual risk: HIGH.** Closing it needs hardware sensor attestation (Android
   StrongBox / Play Integrity, iOS App Attest) — **not implemented**.
2. **No presentation-attack detection rate (APCER/BPCER) is measured.** None is claimed. The
   FAR/TAR figures in `docs/RESULTS.md` describe *recognition* only (LFW stills), never liveness.
3. **Recognition accuracy is measured on LFW**, which is adult, largely Western press photography —
   it does not predict accuracy for the intended humanitarian population. A false reject denies aid.
4. **Live-webcam Tests A–I** are operator-reported, not machine-verified here (§6.2).

---

## 9. REPORTED SEPARATELY — pre-existing issues NOT fixed (per "do not fix unrelated bugs")

- **Dead dependencies:** `@mediapipe/camera_utils` and `@mediapipe/face_mesh` in `web/package.json`
  have **zero usage** anywhere in `app`, `lib`, or `scripts`. They are legacy MediaPipe packages
  superseded by `@mediapipe/tasks-vision`. Left in place; safe to remove in a separate change.
- **Build-time lint warnings:** several `@typescript-eslint/no-explicit-any` warnings in
  `lib/chain/client.ts`, `lib/zk/prover.ts`, `app/enroll/page.tsx` (warnings, not errors; outside
  the liveness scope; unchanged).
- **One more swallowed-error path, same shape as §13.2, NOT fixed.** `fetchContractRoles()` in
  `app/dashboard/page.tsx:118` `console.error`s and leaves `adminAddress` / `verifierAddress` at `''`,
  which the Contract Roles panel renders as `…` — i.e. an *unread* value is displayed as *still
  loading*, indefinitely. Milder than §13.2 because it asserts nothing false, but the same class of
  defect. (Checked the others: `fetchOnChainPolicies` sets `policyLoadError` and `fetchLatestRoot`
  sets an error status, so those two do surface.)
- **Cosmetic typo:** `app/dashboard/page.tsx:562` has `bg-slate-950\70` — a backslash where the
  Tailwind opacity separator should be `/`. The class silently does not apply. Left as found.

---

## 10. BLOCKERS

**No code blockers.** The tree compiles, all automated suites pass, and the on-chain demo policy is
live and correctly parameterised.

**One operator action is required before a claim can succeed** (found in the later live-run pass, see
§13.4): every created policy carries a cohort root older than the current commitment store — policy
110 holds the 11-leaf root, 101/107/108 the 9-leaf root, while the store now holds 12 — so `/claim`
fail-closes on the root check. An issuer must publish the current root once, **after** the last
enrolment. That is an authority action by design — the claim page refusing a stale root is the cohort
check working, and "fixing" it in code would mean accepting a claimant-supplied root. Procedure in
§11a.

The only gate on an unqualified "READY" remains the inherent software-liveness limitation (§8.1),
which is a documented design boundary, not a bug to fix.

---

## 11. FINAL DEMO PROCEDURE

1. **Start the web app** from `web/`:
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000`. (Do **not** run `npm run build` against `.next` while the dev
   server is up — use `npm run build:verify`, which builds into `.next-verify`.)
2. **Enroll** at `/enroll`: capture a face → 128-D descriptor → quantise → commitment. Runs fully
   client-side.
3. **Claim** at `/claim` against **policy 107** (Base Sepolia, chain 84532):
   - The on-device liveness model loads first; if it fails, the claim is blocked (fail-closed).
   - Complete the randomised challenge: **2 genuine blinks** + **one head turn and return**, in
     whatever order the attempt asks. "Verified" appears **only** after both actions complete.
   - A real Groth16 proof is generated in-browser and submitted; the contract verifies it and
     decrements policy 107's `remaining` (110 units per claim, 5000 remaining → ~45 claims left).
4. **Show the negative cases** for the security story: a held-up printed photo or a still on a
   phone times out at score 0; pulling the camera away produces **no** phantom blink.
5. **Contracts on Base Sepolia:** AegisAid `0xAB2fa997c25B0B02E635052166d0192b5Eab5765`,
   Groth16Verifier `0x05ea2aDa4aB61F46b247B7b6c6943D74e99A06bd`. Public signal order
   `[nullifier, root, policyId, epoch, tauQ, modelHash]`.

---

## 12. FINAL LIVENESS VERDICT (Step 20)

Per the master prompt, "READY" for the liveness subsystem requires a **real webcam** confirmation of
7 behaviours, which I cannot drive with the available tools. On my own machine-verified evidence
alone, the honest verdict for the *live-camera* claim is therefore:

- **Liveness code + deterministic behaviour: READY** (75/75, fail-closed, isolated, MODEL_HASH
  intact, no secret exposure).
- **Live-webcam confirmation: NOT VERIFIED by me** — operator-reported as passing (§6.2).

Combined with the always-present, documented software-liveness limitation, the **overall system
verdict is READY WITH KNOWN LIMITATIONS** (§0).

---

## 13. LIVE-RUN PASS — three integration blockers found while bringing the app up on Base Sepolia

This section covers a later pass whose goal was narrower: switch the running app from local Anvil to
Base Sepolia and confirm the operator can actually exercise it. Three blockers surfaced that no
earlier check had caught, because all three live *between* components that each tested fine alone.

### 13.1 FIXED — policy discovery was incompatible with the configured RPC

**Symptom.** `/claim` and `/dashboard` would render "Could not read policies from Base Sepolia" and
list **nothing**. No policy could be selected, so no claim was reachable at all.

**Cause.** `discoverPolicyIds()` requested `eth_getLogs` in **45,000-block** spans. The endpoint in
`web/.env.local`, `https://sepolia.base.org`, refuses any `getLogs` span wider than ~10,000 blocks.
The deployment-to-head range is ~259,000 blocks, so the **first** chunk was rejected, the rejection
propagated out of `discoverPolicyIds`, and the pages fell into their error branch.

**Why it was missed.** Policy 107 had been verified with `cast call policies(107)` — an `eth_call`,
which has **no** range limit. Reading a policy by ID and *discovering* which policies exist are two
different RPC paths, and only the first had ever been exercised against this endpoint.

**Evidence (both run against the live endpoint):**

| Chunk span | Result |
|---|---|
| 45,000 (old) | **FAILED** — provider rejected the range |
| 10,000 | SUCCESS — returned `[101, 103, 107, 108]` |
| 9,500 + 900 retry (new) | **SUCCESS** — `[101, 103, 107, 108]`, 28 requests, ~10 s, 0 fallbacks |

**Fix.** Chunk reduced to 9,500 (margin under the observed ceiling) with a 900-block retry walk for
stricter providers. A refused narrow span still propagates: discovery must never return a *partial*
policy list, because a silently missing policy is indistinguishable in the UI from a deactivated one.

**Confirmed in a real browser after the fix:** `/dashboard` lists policies 101, 103, 107 and 108;
`/claim` shows no load error; the header reads "Base Sepolia (84532)" with zero Anvil references;
`admin()` resolves to `0xcB2d8FaBEBB0b4f47F4Ea450C61643673d263744`; and both ML engines initialise
(`face-api.js models loaded successfully`, MediaPipe `Graph successfully started running` on a real
GL context). `tsc --noEmit` clean, `eslint --quiet` clean, liveness 75/75 and quantize 61/61 after
the change.

### 13.2 FIXED — the audit log asserted "no claim has ever been verified" while its query was failing

**This was the most serious finding of the pass, because it was a false statement rendered as fact.**

`fetchEvents()` in `web/app/dashboard/page.tsx` carried a **second, independent copy** of the same
45,000-block span as §13.1 — its own `const CHUNK = 45000n` literal, one file away. That query failed
on every load with HTTP 413 / `eth_getLogs is limited to a 10,000 range`, and the failure was
swallowed into a bare `console.error`. `events` therefore stayed `[]`, and the panel rendered:

> "No AidClaimed events on Base Sepolia (84532) — No claim has ever been verified by this contract.
> **This is the true on-chain state, not a loading failure.**"

The parenthetical was precisely wrong: it *was* a loading failure. Worse, this is the panel a
reviewer would check after a successful claim, and a real claim would not have appeared in it.

**What the fix revealed.** The contract has already verified a real claim. Decoded straight from
`eth_getLogs` against `https://sepolia.base.org`, independently of the app:

| Field | Value |
|---|---|
| event | `AidClaimed` (`topic0 0x4ce68d65…482f`) |
| policyId | **101** |
| nullifier | `3474950125237763170820485956386511732697518291285896180905380623572147756046` |
| amount | 50 units |
| block | 45780472 |
| tx | `0x2aef39446c00c1df119d38ac2f011d4f3af2171d53345efb2eabef459b57ee30` |
| timestamp | 2026-08-21T16:20:32Z |

The nullifier the UI now renders matches that on-chain topic **byte for byte**. So the deployed
Groth16 verifier has genuinely accepted a proof produced by this app and disbursed against it — the
end-to-end flow has completed on a public testnet at least once. **This corrects an earlier
statement in this report** that no claim had ever been verified by this contract; that claim was
itself an artefact of the broken query.

**Fix.** Both log readers now share one exported `getLogsChunked()` helper in
`web/lib/chain/client.ts`, so there is a single chunking policy rather than a per-caller literal —
having two copies of the span is how this survived alongside §13.1. `fetchEvents` no longer converts
a failure into an empty list: it sets an error state, the header reads `AidClaimed events (unknown)`
instead of `(0)`, and the panel says the history is **unknown** and prints the RPC error, rather than
asserting zero claims.

**Verified after the fix, in a real browser against Base Sepolia:** audit log reads
`AidClaimed events (1)` and renders policy #101 / block 45780472 / 50 units with the matching
nullifier; no `413` and no `Failed to fetch events` in the console after a clean reload; `/claim`
shows no policy-load error; `tsc --noEmit` clean; `eslint --quiet` clean; liveness 75/75 and
quantize 61/61.

*Not exercised live:* the new error branch itself. Reaching it requires an RPC that refuses even a
900-block span, which the configured endpoint does not. It is typechecked and reviewed, not
demonstrated — stated here rather than implied as tested.

### 13.3 FIXED — the publish button could sign a stale cohort root

`handlePublishRoot()` signed `latestRoot`, a React state value captured when the tab last loaded.
Every enrolment moves the root, so a dashboard left open across an enrolment would publish a root
that was already obsolete. That transaction *succeeds*, costs real gas, and then fails every claim
with the exact "Merkle root mismatch" the publish was meant to clear — the most confusing possible
outcome, because the operator watched it confirm.

It now re-reads `/api/enroll` immediately before signing. On drift it refreshes the staged root,
signs **nothing**, and tells the operator to press Publish again so they see the value actually going
on-chain; if the re-read fails it refuses outright rather than signing an unconfirmed root. Verified
that a fresh load stages `12 ENROLLED` / `0x1de8f2c3…48d1` and that this equals what
`/api/enroll` returns at press time (so the guard passes through rather than blocking a correct
publish). The drift and failure branches require a connected issuer wallet to reach and were not
exercised live.

### 13.4 OPEN, needs an operator decision — the cohort root has moved past the published root

**This is not a bug.** It is the fail-closed root check behaving exactly as designed, and it must be
resolved by an authority action, not by code.

Policies 101, 107 and 108 all publish cohort root
`0x163f2ace5c502b1d73ad667b4b589339b0b663403f8e423edaf20ba28b05fbe7`. By recomputing the tree over
every prefix of the local commitment store, that root is the tree at **exactly 9 leaves**. The store
now holds **12**, so the live root is
`0x1de8f2c3de9bb5182e59486e37f4a4ec3b35b3b174323c5b851e02b93a4d48d1` — independently recomputed from
`web/.cache/commitments.json` via the app's own `MerkleTree` and confirmed equal to what
`/api/enroll` serves, with the newest leaf holding a valid inclusion path to it.

| Cohort size | Root | Published as |
|---|---|---|
| 8 leaves | `0x10ac1cef…0eb7` | policy 102's root (a ghost policy: `tauQ` 0, never created) |
| **9 leaves** | `0x163f2ace…fbe7` | **policies 101, 107, 108** |
| 11 leaves | `0x11c7e40c…14dd` | **policy 110** (created at 11 leaves, then a 12th was enrolled) |
| **12 leaves (current)** | `0x1de8f2c3…48d1` | **not published anywhere** |

The claim page compares the *full current* tree root against the on-chain root and refuses on
mismatch — correctly, since accepting a claimant-derived root would defeat the entire cohort check.

**This is the exact cause of the operator's reported "Claim Blocked — Merkle root mismatch."** Their
new policy **110** is correctly configured in every other respect (`tauQ` 14984, canonical
`modelHash`, epoch 1, allocation 50, remaining 5000, active) but carries the **11-leaf** root that was
current when they created it; they then enrolled a 12th leaf to test with, which moved the root. Their
claim page also reported `measured dot = 15582 · policy tauQ = 14984` — so **liveness passed and the
biometric threshold passed**; only the cohort-root comparison stopped it. The remedy is one
wallet-signed `updateCohortRoot(110, 0x1de8f2c3…48d1)`.

**Consequence for a demo.** Enrolling a fresh face appends another leaf and moves the root again.
So a fresh enroll→claim run **cannot** complete until an issuer publishes the resulting root. The
authorised publisher on the deployed contract is `admin` = `0xcB2d8FaBEBB0b4f47F4Ea450C61643673d263744`
(`isIssuer(admin) == true`; no `IssuerUpdated` event has ever granted rights to anyone else). The
dashboard reads authorisation from the contract rather than assuming it, so connecting any other
wallet will correctly refuse to publish.

**Therefore the correct demo order is: enrol everyone first → publish the root once → then claim.**
Publishing before the last enrolment invalidates it again. See §11a.

### 13.5 Policy hygiene on the live deployment

Verified state of every discovered policy, for anyone choosing a demo target:

| Policy | root | tauQ | modelHash | active | usable? |
|---|---|---|---|---|---|
| 101 | 9-leaf root | 14984 | canonical | yes | root stale (alloc 50, rem 4950 — has **one real claim**, §13.2) |
| 102 | 8-leaf root | **0** | **zero** | no | **no — ghost, never created** |
| 103 | **all-zero** | **1** | **`0x1111…`** | yes | **no — `tauQ` 1 is measured FAR 100%** |
| 107 | 9-leaf root | 14984 | canonical | yes | root stale (alloc 110, rem 5000) |
| 108 | 9-leaf root | 14984 | canonical | yes | root stale (alloc 50, rem 5000) |
| **110** | 11-leaf root | 14984 | canonical | yes | **yes — current demo target** once its root is republished (alloc 50, rem 5000) |

Every non-ghost policy needs a root republish before a claim against the 12-leaf cohort can succeed;
the choice of which one to republish is arbitrary, and 110 is used below only because it is the
operator's own.

Policy 103 must not be demonstrated: `tauQ = 1` accepts **any** face (`docs/RESULTS.md` §6), and its
root is the all-zero sentinel so no valid path exists anyway. Policy 102 is the `updateCohortRoot`
on-an-uncreated-policy artefact already documented in `docs/THREAT_MODEL.md` §2.6.

---

## 11a. REVISED DEMO PROCEDURE (supersedes §11 step ordering)

1. Start the app from `web/`: `npm run dev`, open `http://localhost:3000`. Confirm the header reads
   **Base Sepolia (84532)**. (Never `npm run build` against `.next` while dev is up — use
   `npm run build:verify`.)
2. **Enrol every face you intend to claim with, first.** Each enrolment appends a leaf and moves the
   cohort root.
3. **Then publish the root once**, at `/dashboard`, connected as the issuer
   (`0xcB2d8FaBEBB0b4f47F4Ea450C61643673d263744`), onto a policy carrying the canonical `modelHash`
   and a sound `tauQ` — currently **110** (or 101/107/108). One wallet-signed `updateCohortRoot`
   transaction. No redeploy, no new policy needed. Reload the dashboard first: if the staged root
   drifted since the tab opened, the button now refuses to sign and refreshes the value instead
   (§13.3), so press it a second time to publish what it then shows.
4. **Then claim** at `/claim` against that same policy: liveness (2 blinks + head turn and return, in
   the randomised order) → in-browser Groth16 proof → wallet-signed `claimAid`. Needs Base Sepolia ETH
   for gas.
5. Confirm on-chain: the dashboard audit log should gain a second `AidClaimed` row (it already shows
   one real claim from 2026-08-21, §13.2). If that panel ever says the history is **unknown**, the RPC
   is failing — it will no longer silently report zero.
6. Negative cases for the security story: a printed photo or a still on a phone times out at score 0;
   pulling the camera away produces no phantom blink.

**Do not enrol again between steps 3 and 4** — that moves the root past what you just published and
step 4 will block again.

If step 3 is skipped, step 4 stops with "Merkle root mismatch — authority must publish the current
cohort root." That message is the system working, not a failure.
