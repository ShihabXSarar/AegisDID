# AegisDID — Identity Handle Specification

**Status legend used throughout this document:** `IMPLEMENTED` (present in this repository and
exercised by code), `PARTIAL` (present but not wired into any flow), `NOT IMPLEMENTED` (described
as a design intent only).

> **Correction.** An earlier revision of this document described a W3C Verifiable Credential 2.0,
> issued as a compact JWS, with a `credentialSubject` carrying `idCommitment`, `policyCohort`,
> `modelHash` and `enrollmentEpoch`. **No such credential exists in this repository.** Nothing
> issues, signs, stores, transmits or verifies a VC; `POST /api/enroll` returns only
> `{success, message, cId, leafIndex, duplicate, count, newRoot}`. The section below marks it
> NOT IMPLEMENTED rather than leaving the description standing as if it shipped.

## Core identity primitive — `IMPLEMENTED`

| Property | Value |
|---|---|
| Method | `did:key` |
| Curve | Ed25519 (`@noble/curves/ed25519`) |
| Encoding | multicodec `ed25519-pub` = `0xed 0x01`, then multibase base58btc (`z` prefix) |
| Generation | Fully client-side, in `web/lib/ml/did.ts` (`generateDIDKeyPair`) |
| Call site | `web/app/enroll/page.tsx` during enrolment |
| Storage | Browser IndexedDB alongside `idSecret` and `salt`; the secret key is never transmitted |
| Chain write at enrolment | **None** |

The keypair is genuine: `ed25519.getPublicKey(secretKey)` derives the published key, so the holder
can actually authenticate against their DID. (An earlier version of `did.ts` filled 32 random bytes
and labelled them a public key — a syntactically valid `did:key` with no corresponding private key.
That is fixed, and the file records the fix.)

### What the DID is *not*

The DID carries **no part of the Sybil-resistance argument**. That rests entirely on nullifier
uniqueness (`nf = Poseidon3(idSecret, policyId, epoch)`) and Merkle membership of `C_id`. The DID
is deliberately never sent on-chain, never bound into any commitment, and never checked by
`AegisAid.sol` or by the circuit. It is a portable, self-certifying handle for the local
beneficiary record and nothing more.

Consequently: **possessing a DID grants no authority to claim.** Authorization comes exclusively
from a valid Groth16 proof binding an enrolled `C_id` to the on-chain cohort root, a live biometric
match above the policy `tauQ`, and an unspent nullifier.

## Signing helpers — `PARTIAL`

`web/lib/ml/did.ts` exports `signWithDIDKey` and `verifyWithDIDKey`. They are correct Ed25519
sign/verify wrappers, and they have **no call sites**: nothing in the app signs or verifies
anything with the DID key today. They are available primitives, not an active mechanism. Do not
cite them as evidence that claim receipts are authenticated — no receipt is signed.

## Verifiable Credential — `NOT IMPLEMENTED`

The design intent was for the enrolling authority to issue a portability credential:

* Format: W3C Verifiable Credential Data Model 2.0
* Representation: compact JWS
* Issuer: the enrolling authority's DID
* `credentialSubject`: `idCommitment`, `policyCohort`, `modelHash`, `enrollmentEpoch`

**None of this is built.** Concretely, the following are all absent from the codebase: an authority
signing key or DID, a credential data model, a JWS serializer, a credential store, a verification
path, and any API surface that would return a credential.

Two consequences worth stating plainly:

1. **No portability.** A beneficiary cannot move their enrolment to another device or browser.
   `idSecret`, `salt`, `uReg` and the DID secret key live only in that browser's IndexedDB. Clearing
   site data, switching browsers, or losing the device means the enrolment is unrecoverable and the
   beneficiary must re-enrol (which the authority's duplicate-detection cannot distinguish from a
   Sybil attempt — see `docs/THREAT_MODEL.md` §2.4).
2. **Nothing is lost security-wise.** Because the VC was never an authorization artifact, its
   absence does not weaken any claim check. It removes a convenience feature, not a control.

If this is implemented later it needs, at minimum: an authority key with a defined custody and
rotation story, a decision on where the credential is stored, and an explicit statement that
verifying it still does not authorize a claim.

## Privacy constraints — `IMPLEMENTED` (enforced by the enrolment API)

No biometric data, face image, embedding vector, `idSecret`, or `salt` leaves the browser.
`POST /api/enroll` rejects any request body containing `idSecret`, `salt`, `embedding`,
`descriptor`, `uReg`, or `uLive` with **HTTP 403**, tested by field *presence* rather than
truthiness so a present-but-falsy `{"idSecret": 0}` is refused too. The authority stores only
`C_id` values and their Merkle positions.

The system also holds no beneficiary name or other PII — but note that this is because the
prototype has **no beneficiary-registration step at all**, not because PII is collected and then
protected. A real deployment that adds intake records must revisit this section.
