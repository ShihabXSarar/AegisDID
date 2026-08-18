# AegisDID Cryptographic Identity Specification

This document details the Decentralized Identity (DID) and Verifiable Credential (VC) specification for AegisDID.

## Core Identity Primitive
* **Method**: `did:key`
* **Cryptographic Curve**: Ed25519
* **Generation**: Fully client-side. The `did:key` is derived from a locally generated Ed25519 key pair in the beneficiary's browser.
* **Chain Write Requirement**: None. There is **no chain write required at enrollment**.

## Verifiable Credential (VC)
The enrolling authority issues a credential asserting the beneficiary's enrollment in a specific policy cohort.

* **Format**: W3C Verifiable Credential Data Model 2.0
* **Representation**: Compact JWS (JSON Web Signature)
* **Issuer**: The enrolling aid authority (represented by their DID).

### Credential Subject payload
The `credentialSubject` object contains exactly the following fields:
* `idCommitment`: The Poseidon hash commitment (`C_id`) representing the beneficiary.
* `policyCohort`: The specific cohort (Merkle tree) the beneficiary is enrolled in.
* `modelHash`: The hash of the AI model used for the biometric embedding.
* `enrollmentEpoch`: The temporal epoch of the enrollment.

### Privacy Constraints
* **No Biometric Data**: The VC does NOT contain any raw biometric data, face images, or embedding vectors.
* **No Beneficiary Name**: The VC does NOT contain the beneficiary's real name or any personally identifiable information (PII).

### Authorization Model
The Verifiable Credential exists purely for **portability** (allowing the beneficiary to carry their cohort membership proof locally). 

The VC itself does **not** grant authorization to claim aid. **Authorization comes exclusively from the ZK proof** which cryptographically verifies the `idCommitment` against the on-chain Merkle root and the real-time biometric similarity check.
