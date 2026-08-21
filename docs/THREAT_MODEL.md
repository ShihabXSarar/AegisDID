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

**What is implemented.** An *active* software liveness challenge (`web/lib/ml/liveness.ts`) built
on face-api.js 68-point landmarks. Per attempt it randomly draws an action order
(blink-then-turn or turn-then-blink) and a blink count (1 or 2), and requires:

- each blink to be a real EAR excursion — below `baseline * 0.72`, recovering above
  `baseline * 0.88`, with the closure lasting 40–900 ms; and
- one head-yaw excursion past `baseline * 1.45` (or below `baseline / 1.45`) and a return to
  within `baseline * [1/1.15, 1.15]`;

all inside a 20 s window measured from the first usable face, with a 12-frame calibration phase
whose EAR baseline is rejected outright if it falls outside [0.10, 0.65]. Losing the face for
more than 2 s mid-challenge wipes all progress, so a subject cannot be swapped part-way through.

`web/scripts/liveness_test.mts` (79 assertions, run `npm run test:liveness` from `web/`) verifies
these behaviours against a virtual clock, including the boundary cases at exactly 40 ms and
900 ms and a 28-combination sweep proving that an occlusion of any duration is never miscredited
as a blink.

**What this defeats.** A held-up printed photo or a still image on a second screen: the test
harness runs 623 frames of a perfectly static face and the challenge times out with score 0.
Also a single fixed recording, since the required action order and blink count differ per attempt.

**What this does NOT defeat — stated plainly.**
1. **An attacker who can produce video on demand.** A short interactive clip, a puppeteered
   deepfake, or a cooperating accomplice recorded on request satisfies every check above. The
   randomization raises the cost of a *pre-recorded* replay; it does not stop an adaptive one.
2. **Frame injection.** Anything that can substitute the `getUserMedia` stream, or call the
   prover directly with a chosen descriptor, bypasses liveness entirely. Liveness is enforced by
   the page's own JavaScript, which the device owner fully controls. **The circuit does not
   constrain liveness, and the contract cannot observe it.**
3. **A high-resolution replay on a good display** under favourable lighting may produce plausible
   EAR dynamics.

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
