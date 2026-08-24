# AegisDID Threat Model

This document outlines the security assumptions, identified threats, and mitigating controls in
the AegisDID architecture.

**Scope note.** AegisDID is a **prototype**. This document distinguishes three states, and every
row and mitigation below is labelled with one:

| Label | Meaning |
|---|---|
| **IMPLEMENTED** | Present in this repository and exercised by an automated test |
| **NOT IMPLEMENTED** | Described as future/production design only. No code exists in this repo. |
| **PARTIAL** | Code exists but is not wired into the running application |

Claims are deliberately conservative. Where a control is absent, the residual risk is stated as
the risk *actually carried today*, not the risk the production design would carry.

---

## 1. Trust Assumptions

| Guarantee | Strength | Status | Depends on |
|---|---|---|---|
| No double-claim per (policy, epoch) | Unconditional (cryptographic) | IMPLEMENTED | Nullifier uniqueness enforced on-chain in `AegisAid.claimAid` |
| Biometric threshold actually met | Unconditional (cryptographic) | IMPLEMENTED | In-circuit fixed-point cosine compared against the on-chain `tauQ` |
| Cohort membership genuine | Unconditional (cryptographic) | IMPLEMENTED | Depth-20 Poseidon Merkle inclusion proved in-circuit against the on-chain root |
| Raw biometrics never reach the server | Structural | IMPLEMENTED | Descriptor and quantized vector never leave the browser; the enrol API rejects them (HTTP 403) |
| Embedding came from a live human, right now | **Conditional** | PARTIAL | Software-only liveness challenge. No hardware attestation. See §2.1. |
| Enrolled cohort contains no duplicate people | **NOT GUARANTEED** | NOT IMPLEMENTED | Nothing in the running system detects duplicate enrolment. See §2.4. |
| Claim submissions are unlinkable at the network layer | **NOT GUARANTEED** | NOT IMPLEMENTED | Claims are submitted directly from the beneficiary's browser. See §2.3. |

### 1.1 What the ZK proof does and does not establish

The Groth16 proof establishes exactly six public facts, in this order:
`[0] nullifier, [1] root, [2] policyId, [3] epoch, [4] tauQ, [5] modelHash`.

It proves that the prover knows an `idSecret`, a salt, and two quantized embeddings such that:
the registered commitment is in the cohort tree under `root`; the live and registered embeddings
have a fixed-point dot product `>= tauQ`; and the nullifier is `Poseidon3(idSecret, policyId, epoch)`.

It does **not** prove that the live embedding came from a camera, that a human was present, or
that the person is who they claim to be in any civil-registry sense. Those are the province of
liveness (§2.1) and enrolment procedure (§2.2), both of which are weaker than the cryptography.

---

## 2. Identified Threats & Mitigations

### 2.1 Compromised browser forging a live capture

**Threat.** A rooted device, a patched browser, or a virtual camera feeds a synthetic embedding
straight to the prover, or replays a previous recording to satisfy the liveness challenge.

**What is implemented.** An *active* software liveness challenge split across two modules:

- `web/lib/ml/mediapipeLiveness.ts` — signal extraction via **MediaPipe Face Landmarker**
  (`@mediapipe/tasks-vision`, model and WASM served from `web/public/mediapipe/`, zero network
  requests at runtime). It emits only the `eyeBlinkLeft` / `eyeBlinkRight` blendshape
  coefficients, a roll-invariant head yaw in degrees, interocular scale, and a confidence value.
- `web/lib/ml/liveness.ts` — a **pure, DOM-free state machine** that consumes those signals. It
  holds no reference to MediaPipe, face-api, the DOM or any timer, and takes `now` as a
  parameter, which is what makes the whole challenge deterministically testable from Node.

Note the deliberate responsibility split: **face-api.js still owns identity** (the 128-D
descriptor that feeds quantisation, commitments and the ZK proof); MediaPipe owns **liveness
only**. The two never exchange data.

Per attempt the challenge randomly draws an action **order** (blink-then-turn or
turn-then-blink). The blink count is fixed at **2** and is not randomisable — a randomised
requirement could be drawn downward, which would weaken the check. It requires:

- **two genuine blinks**, each credited only on a completed `OPEN → CLOSING → CLOSED → OPEN`
  transition where the closure (a) lasted 80–700 ms, (b) contained at least 2 frames whose raw
  coefficient cleared 0.5, and (c) showed *bilateral* agreement (both eyelids ≥ 0.30). Entry and
  exit use a hysteresis band (enter ≥ 0.50, exit ≤ 0.32) so a coefficient hovering mid-band
  cannot oscillate a counter; and
- **one head-yaw excursion** of ≥ 18° from the calibrated neutral pose, in either direction,
  sustained for ≥ 180 ms, followed by a return to within 8° also sustained for ≥ 180 ms;

all inside a 45 s window measured from the first usable face, after a 12-frame calibration phase
that refuses to complete while the eyes read closed. Blink updates are **suspended** beyond ±22°
yaw, where blendshape confidence is not trustworthy — but blinks already credited are never
revoked. Losing the face for more than 2.5 s mid-challenge wipes all progress, so a subject
cannot be swapped part-way through.

Two properties are worth calling out because they were *defects* in the previous version:

- **The randomised order is binding.** Exactly one action is live at a time; the inactive
  action's FSM still runs for telemetry but cannot increment anything. A single pre-recorded clip
  containing both actions therefore satisfies one order and fails the other.
- **The blink signal is absolute, not baseline-relative.** v2 derived blink from the Eye Aspect
  Ratio of face-api's 68-point landmarks against a rolling baseline. That produced a false
  positive whenever the camera moved *away* (EAR collapses as landmark quantisation error grows
  relative to the eye, while the slow baseline stays high — a textbook dip-and-recovery), and it
  progressively degraded, because each near-miss dragged the baseline down. Blendshape
  coefficients are scale-invariant and need no baseline, so both failure modes are structurally
  impossible rather than merely less likely.

`web/scripts/liveness_test.mts` (**75 assertions, all passing**, `npm run test:liveness` from
`web/`) drives the real state machine against synthetic signal traces with an injected clock, so
every duration boundary is exercised exactly. It covers a one-frame coefficient spike, a sub-80 ms
closure, a ~1 s held closure, a ~3 s occlusion, a one-eyed closure, camera distance changing in
both directions, dropped landmarks mid-closure, multi-face frames, and non-finite (NaN/Infinity)
signals. **Every failure path fails closed:** if MediaPipe, the camera, the model or the landmarks
fail, there is no liveness success, no proof and no claim — there is no fallback to a dummy
blink, dummy landmarks or hardcoded success anywhere in the subsystem.

**What this defeats.** A held-up printed photo or a still image on a second screen: 1200 frames
of a perfectly static face yield score 0 and a timeout. A held-shut-eyes or hand-over-lens
occlusion of any duration, which is counted as a *closure* but never as a blink. And a single
fixed recording, since the required action order differs per attempt.

**What this does NOT defeat — stated plainly.**
1. **An attacker who can produce video on demand.** A short interactive clip, a puppeteered
   deepfake, or a cooperating accomplice recorded on request satisfies every check above. The
   randomization raises the cost of a *pre-recorded* replay; it does not stop an adaptive one.
2. **Frame injection.** Anything that can substitute the `getUserMedia` stream, or call the
   prover directly with a chosen descriptor, bypasses liveness entirely. Liveness is enforced by
   the page's own JavaScript, which the device owner fully controls. **The circuit does not
   constrain liveness, and the contract cannot observe it.**
3. **A high-resolution replay on a good display** under favourable lighting will produce
   plausible blendshape dynamics. MediaPipe's blendshapes are a *semantic* estimate of eyelid
   position; they say nothing about whether the pixels came from a face or from a screen. There
   is no texture, depth, reflectance or rPPG analysis in this system.

**We do not claim perfect anti-spoofing.** Any statement that AegisDID prevents presentation
attacks in general would be false.

**Production direction (NOT IMPLEMENTED).** Hardware-backed key attestation — Android
StrongBox / Play Integrity, or iOS App Attest — signing sensor frames before the prover sees
them, so the ZK statement can include "these pixels came from an attested sensor". No code for
this exists in this repository.

**Residual risk carried today: HIGH.** This is the weakest link in the system and the honest
reason AegisDID is a prototype rather than a deployable aid-distribution control.

### 2.2 Coercive enrolment by an aid worker

**Threat.** A corrupt official forces a beneficiary to enrol their face under an identity the
official controls, or enrols under duress and retains the device.

**What is implemented.** The architecture removes the *central biometric database* that makes
this attack scale: no template, descriptor, or image is stored server-side, so coercion must be
repeated per person and leaves no biometric record. A beneficiary who declines generates no
biometric artefact at all, so there is no "refusal" record to retaliate against.

**What this does NOT address.** The `idSecret` lives in the beneficiary's browser IndexedDB. An
official who controls the device controls the identity. Nothing cryptographic distinguishes a
freely-given enrolment from a coerced one.

**Residual risk: MEDIUM, and procedural only.** Mitigation is organizational (witness presence,
grievance channels, staff rotation), not technical. This document does not claim otherwise.

### 2.3 Cross-policy linkage via network metadata

**Threat.** Nullifiers are unlinkable across policies by construction — `Poseidon3(idSecret,
policyId, epoch)` reveals nothing about `idSecret` or about the nullifier for a different
`policyId`. But an observer who sees the *transactions* can correlate source IP address, wallet
address, and timing to re-link claims that the cryptography kept separate.

**Status: NOT IMPLEMENTED.** In the current prototype the beneficiary's browser submits
`claimAid` directly through their own wallet. Consequently:

- **The submitting wallet address is a stable, public linker** across every claim that wallet
  makes, in every policy. This is a stronger linkage channel than IP, and it is present today.
- The RPC endpoint sees the originating IP.

An earlier revision of this document claimed "beneficiaries submit proofs via an anonymizing
relayer, potentially utilizing Tor or mix-nets" with residual risk "Low". **That was false: no
relayer exists in this repository.** The claim has been removed.

**Production direction (NOT IMPLEMENTED).** A relayer or account-abstraction paymaster that
submits proofs on the beneficiary's behalf so no beneficiary-linked address touches the chain,
combined with network-level anonymization. Note that a naive relayer merely moves the trust —
the relayer itself then sees the correlation.

**Residual risk carried today: HIGH for metadata linkage** (unchanged for the cryptographic
nullifier unlinkability, which is genuine and holds regardless).

### 2.4 Sybil attack via duplicate enrolment

**Threat.** One person enrols several times — different devices, different `idSecret` values —
and collects one allocation per enrolment. Each enrolment is a distinct, individually valid
identity, so every downstream cryptographic check passes.

**Status: NOT IMPLEMENTED. This is the principal unmitigated attack against the system.**

A standalone script, `tools/dedup-lsh.py`, implements coarse locality-sensitive hashing over
quantized embeddings. It is **not wired into the enrolment path and is not invoked by any part of
the running application.** More fundamentally, it *cannot* be wired in as designed: LSH
bucketing requires the authority to receive the 128-dimensional embedding, and the enrolment API
deliberately refuses embeddings — `web/app/api/enroll/route.ts` rejects `uReg`, `uLive`,
`embedding`, `descriptor`, `idSecret`, and `salt` with HTTP 403, which is the property that
makes "no biometric honey-pot" true. **Authority-side dedup and zero-server-side-biometrics are
in direct conflict, and this project chose the latter.**

An earlier revision of this document described LSH dedup as a *current prototype mitigation* with
residual risk "Medium". **That was false on two counts** — it is not running, and it is
architecturally incompatible with the privacy property the project actually delivers. Both claims
have been removed.

**What actually limits Sybil abuse today:** only the authority's own out-of-band enrolment
procedure — a human deciding who is allowed to enrol, and how many times. That is a
non-cryptographic control that this system neither implements nor verifies. The name
"Sybil-Resistant" in the project title refers to the *per-identity, per-epoch* guarantee (one
claim per enrolled commitment, cryptographically enforced), **not** to a guarantee that distinct
commitments correspond to distinct people.

**Directions, with their real costs (all NOT IMPLEMENTED).**
- *Biometric uniqueness in ZK:* prove non-membership against every enrolled embedding without
  revealing it. Correct, and computationally prohibitive on the target hardware.
- *Trusted enrolment hardware:* a kiosk that attests it saw exactly one live person.
- *Procedural LSH under explicit consent:* run dedup at a supervised enrolment station, which
  reintroduces a server-side biometric and must be disclosed as such in the DPIA.

**Residual risk carried today: HIGH.**

### 2.5 Authority publishing a root that excludes or targets beneficiaries

**Threat.** The issuer controls `cohortRoot`. A malicious or careless issuer can publish a root
that omits a beneficiary (denial of service) or contains only one beneficiary (deanonymization by
cohort size — a claim against a one-leaf cohort identifies its claimant).

**What is implemented.** Root changes are public and event-logged (`CohortRootUpdated(policyId,
oldRoot, newRoot)`), so exclusion is detectable after the fact. The beneficiary client compares
the API-supplied root against the on-chain root before proving and **refuses to proceed** on
mismatch rather than silently re-deriving a root that would verify — a claimant-controlled root
would defeat the entire cohort check. The authority dashboard refuses to publish the all-zero
sentinel root and refuses to publish the empty-tree root (which is non-zero and looks valid).

**What this does NOT address.** Nothing prevents the issuer from publishing a valid root over a
cohort they chose adversarially. Small-cohort anonymity loss is inherent: with `n` enrolled
beneficiaries, a claim is anonymous only within that set.

**Residual risk: MEDIUM.** Detectable, not preventable. Mitigation is transparency and cohort
size discipline.

### 2.6 Issuer / admin key compromise

**Threat.** The issuer key can rewrite any policy's cohort root and deactivate policies. The
admin key can grant issuer rights to any address.

**What is implemented.** Role separation (`admin` vs `isIssuer`), and per-function authorization
tested in `contracts/test/AegisAid.t.sol`. Contract source now also enforces policy existence
before `updateCohortRoot` / `setPolicyActive`, rejects `allocation == 0` and
`totalUnits < allocation`, and provides `setAdmin` for key rotation.

**Deployment caveat — IMPORTANT.** The **deployed** Base Sepolia instance at
`0xAB2fa997c25B0B02E635052166d0192b5Eab5765` predates those fixes. On that instance:
`updateCohortRoot` writes into policy slots that were never created (live policies 101 and 102
are in exactly this state — non-zero root, no `PolicyCreated` event, `tauQ = 0`), and there is
**no `setAdmin`, so its admin key cannot be rotated without redeploying.** The operative
protection for the live demo is client-side: the dashboard and `web/lib/chain/client.ts` refuse
policy IDs that have no `PolicyCreated` event, so a ghost policy cannot be selected in the UI.
That is a UI-layer guard, not a contract-layer one.

**Residual risk: MEDIUM on a fresh deployment, HIGH on the current testnet deployment.**

### 2.7 Proving-key / circuit trust

**Threat.** The Groth16 proving and verifying keys come from a Powers-of-Tau ceremony. Whoever
knows the toxic waste can forge proofs for arbitrary statements.

**Status.** The demo `aegis_final.zkey` was produced by a **single-contributor local ceremony**,
not a multi-party one. Anyone with the local ceremony transcript could forge claims.

**Residual risk: HIGH for any real deployment; acceptable for a demo whose value transfer is
zero.** A production deployment requires a multi-party ceremony with published transcripts.

---

## 3. Summary of unmitigated risks

Ranked by what a reviewer should worry about first:

1. **Duplicate enrolment (§2.4)** — no technical control exists. Cryptographic guarantees are
   per-commitment, not per-person.
2. **Adaptive liveness spoofing and frame injection (§2.1)** — liveness is enforced in
   attacker-controlled JavaScript and is not part of the ZK statement.
3. **Single-contributor trusted setup (§2.7)**.
4. **Wallet-address linkage across claims (§2.3)** — the nullifier is unlinkable; the submitting
   address is not.
5. **Deployed-contract gaps (§2.6)** — mitigated in source, not in the deployed bytecode.
