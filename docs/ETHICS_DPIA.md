# Data Protection Impact Assessment & Ethical Framework

This document records the data-protection posture of the **AegisDID prototype**. Claims below are
marked `VERIFIED` (checked against running code or a test in this repository), `BY DESIGN` (follows
from the construction, not separately tested), or `GAP` (a known shortfall).

> **Correction to an earlier revision.** Two claims in the previous version of this document were
> too strong and are corrected in place below: (1) "Cross-agency tracking is cryptographically
> prevented by design" — it is not, because the identity commitment `C_id` contains no `policyId`
> and is therefore *identical* across agencies (§2.2); (2) the framing that a central breach
> "eliminat[es] the risk of biometric exposure to hostile state actors" — it eliminates the
> *central honey-pot*, but the on-device store holds a plaintext biometric template, so device
> seizure still exposes one (§2.4). Both were overclaims about privacy and are the kind of
> statement a DPIA must not get wrong.

## 1. Context & Purpose

Collecting biometric data from vulnerable populations (e.g. refugees) carries significant risk,
given documented incidents of mission creep and unauthorised data sharing. AegisDID aims to provide
Sybil-resistant identity verification for aid distribution **without** creating a central biometric
database.

Scope note: this is a **prototype**, not a deployed system. It has had no field trial, no
independent audit, and no measurement of accuracy on a population resembling its intended users
(see §5 and `docs/RESULTS.md`).

## 2. ICRC & UNHCR Principles Alignment

### 2.1 Data Minimisation — `VERIFIED`

The server stores **zero biometric templates**.

- The raw facial image never leaves the device; frames are processed in-page and discarded.
- The 128-dimensional embedding never leaves the browser.
- Only the Poseidon commitment `C_id` is transmitted to the aid authority.

This is enforced, not merely intended: `POST /api/enroll` rejects any request body containing
`idSecret`, `salt`, `embedding`, `descriptor`, `uReg`, or `uLive` with **HTTP 403**, tested by field
*presence* rather than truthiness so a present-but-falsy `{"idSecret": 0}` is also refused. Seven
leakage probes covering these fields return 403.

### 2.2 Purpose Limitation — `PARTIAL`, with a real linkage gap

**What holds (`BY DESIGN`).** Nullifiers are bound to both `policyId` and `epoch`:
`nf = Poseidon3(idSecret, policyId, epoch)`. Two nullifiers from the same person under different
policies are unlinkable to anyone without `idSecret`. So the *claim* events published on-chain do
not reveal that the WFP-ration claimant and the UNHCR-medical claimant are the same person.

**What does NOT hold (`GAP`).** The identity commitment is
`C_id = Poseidon3(idSecret, C_emb, MODEL_HASH)` — it contains **no `policyId`**. The same
beneficiary therefore presents the **same `C_id`** to every policy and every agency. Consequences:

- Two agencies that compare their cohort lists can identify shared beneficiaries by exact `C_id`
  match, without breaking any cryptography.
- An adversary obtaining two agencies' enrolment lists can do the same.
- This is precisely the "unauthorised data sharing / mission creep" risk named in §1, so the
  previous claim that cross-agency tracking is "cryptographically prevented" was wrong.

What the linkage does and does not reveal: it reveals *that* the same person is enrolled in both
programmes. It does not reveal their face, name, or embedding, and it does not let either agency
claim on their behalf.

Mitigation, not implemented here: derive a per-agency commitment (e.g. bind a domain separator or
agency identifier into `C_id`) so each authority holds an unlinkable leaf. That is an architectural
change to the commitment scheme and the circuit, and is deliberately **not** made in this prototype.

### 2.3 Do No Harm — central breach — `BY DESIGN`

If the aid authority's store is compromised, the attacker obtains a list of `C_id` field elements
and their Merkle positions. Because `C_id` commits to a 254-bit CSPRNG `idSecret` and `C_emb`
commits to a 254-bit CSPRNG `salt`, recovering facial features from that list is **computationally
infeasible** under Poseidon preimage resistance — including by dictionary attack, since the
attacker cannot test a candidate face without the per-user `salt` and `idSecret`.

Stated precisely: this is a computational assumption, not an information-theoretic impossibility.
Subject to §2.2, the breach also reveals which beneficiaries are common to other programmes whose
lists the attacker also holds.

### 2.4 On-device data at rest — `GAP`

The browser enclave (`web/lib/ml/storage.ts`, IndexedDB `aegis_did_secure_storage`) persists, in
**plaintext**, with no encryption at rest and no passphrase or OS-keystore binding:

| Field | Sensitivity |
|---|---|
| `uReg` | **The quantized 128-value biometric template** |
| `idSecret` | Full claim authority for this identity |
| `salt` | Opens `C_emb` given the template |
| `didPrivateKey` | Ed25519 secret key behind the DID |

Implications for the intended population, which must be stated plainly because the threat is
realistic for refugees:

- **Device seizure or confiscation** (e.g. at a checkpoint) yields a usable biometric template plus
  every secret needed to claim as that person. The "no central honey-pot" property does not help
  here; it moves the biometric to the edge rather than removing it.
- **Coerced unlock** has the same effect, and unlike a central database there is no institutional
  gatekeeper to refuse the request.
- Anyone with the device can claim: possession of `idSecret` *is* the authorisation. The biometric
  check happens on the same device and is not a second factor against a device-level attacker.

Not mitigated in this prototype. A deployment would need at minimum encryption at rest keyed by a
beneficiary-held secret, and an explicit decision about what happens when that secret is coerced.

### 2.5 Device loss and re-enrolment — `GAP`

There is no credential portability or backup (`docs/DID_SPEC.md`: the Verifiable Credential is
`NOT IMPLEMENTED`). Clearing site data, switching browsers, or losing the device makes the
enrolment **unrecoverable**.

The beneficiary must re-enrol, and the authority **cannot distinguish an honest re-enrolment from a
Sybil attempt** (`docs/THREAT_MODEL.md` §2.4): a new `idSecret` and `salt` produce a completely
different `C_id`, and no server-side biometric exists to deduplicate against. The consent script in
§3 does warn about this ("If you lose this device, you will need to re-register"), but the
*fairness* consequence is not resolved: whichever way the authority sets its policy, it either
denies re-enrolment to honest people who lost a phone, or admits duplicate enrolments.

## 3. Consent Script

In a hypothetical pilot, beneficiaries would be read the following in their own language (e.g.
Bangla for Rohingya refugees). This script is **not** currently presented anywhere in the
application — there is no consent UI in the prototype (`GAP`).

**English:**
"We are offering a new way to receive your rations. If you choose this method, your phone will scan
your face to prove it is you, but no picture of your face is ever saved or sent to us. You will hold
the only 'key' on this device. If you lose this device, you will need to re-register. Do you consent
to use this system?"

**Bangla:**
"আমরা আপনার রেশন গ্রহণের একটি নতুন পদ্ধতি অফার করছি। আপনি যদি এই পদ্ধতিটি বেছে নেন, তবে আপনার ফোনটি আপনিই কিনা তা প্রমাণ করতে আপনার মুখ স্ক্যান করবে, তবে আপনার মুখের কোনো ছবি কখনও সংরক্ষিত বা আমাদের কাছে পাঠানো হবে না। আপনি এই ডিভাইসে একমাত্র 'চাবি' ধরে রাখবেন। আপনি যদি এই ডিভাইসটি হারিয়ে ফেলেন, তবে আপনাকে পুনরায় নিবন্ধন করতে হবে। আপনি কি এই সিস্টেমটি ব্যবহার করতে সম্মত?"

An honest script should additionally disclose §2.4 (the template and keys are stored on the device
in the clear, so someone who takes the phone can both see the template and claim as the holder) and
§2.2 (another agency holding the same list can tell you are enrolled with them too).

## 4. Fairness and exclusion

- **Accuracy is unmeasured on the intended population.** The recognition threshold has been
  evaluated only on LFW — adult, largely Western, press photography. Any false-reject rate measured
  there says little about children, veiled faces, weathered skin, injury, or low-light field
  conditions. A false reject means **a person is denied aid**. See `docs/RESULTS.md` and
  `docs/MODEL_CARD.md`.
- **Demographic error rates are not measured at all.** No per-group breakdown exists, so the
  prototype cannot show that it fails equally across groups. Face recognition is known to have
  uneven error rates across skin tone, age and sex.
- **Device and literacy dependence.** The flow assumes a personal smartphone with a working camera
  and a browser capable of WASM proving. Beneficiaries without one are excluded outright.
- **No appeal path.** There is no operator override or manual adjudication route for someone the
  system refuses. For a benefit-distribution system this is a serious omission.

## 5. Limitations

- **Coercive enrolment.** The system cannot prevent an aid worker from coercing a beneficiary at
  enrolment. It does avoid creating a permanent central biometric "refusal" record, since no
  server-side biometric exists either way.
- **Liveness is software-only.** The EAR/yaw blink-and-turn check runs on unsigned camera frames
  and is **defeatable by a replay video** of a genuine beneficiary. There is no hardware TEE
  attestation of frame provenance. Do not represent this system as spoof-proof
  (`docs/THREAT_MODEL.md`, `docs/MODEL_CARD.md`).
- **Threshold soundness is enforced; threshold adequacy is a policy choice.**
  `AegisAid.MIN_TAU_Q`/`MAX_TAU_Q` prevent a `tauQ` that would make the in-circuit comparator
  fail open, but a value inside that range can still be a poor operating point.
- **Cross-agency linkability via `C_id`** (§2.2) and **plaintext on-device secrets** (§2.4) are
  unresolved.
- **No independent review.** No external security audit, no penetration test, no ethics-board
  review, and no field trial has taken place.
