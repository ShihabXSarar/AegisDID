# Threat Model & Security Posture

AegisDID is designed to protect beneficiary privacy while preventing aid allocation fraud. We prioritize cryptographic guarantees over procedural ones wherever possible.

## Trust Assumptions

The following table outlines our core security guarantees, their strength, and what they rely on. This is the foundation of our threat model.

| Guarantee | Strength | Depends on |
|---|---|---|
| No double-claim per allocation | Unconditional (cryptographic) | Nullifier uniqueness on-chain |
| Biometric threshold actually met | Unconditional | In-circuit fixed-point cosine check vs on-chain τ |
| Cohort membership genuine | Unconditional | Merkle inclusion proof in-circuit |
| Embedding came from a live human, right now | **Conditional** | Software liveness challenge only — no hardware attestation in this web prototype |
| Enrolled cohort contains no duplicate people | **Conditional** | No cryptographic dedup implemented; see enrollment dedup note below |

## Threat Analysis

### 1. Sybil Attacks (Double-Claiming)
- **Threat:** A user attempts to claim aid multiple times.
- **Mitigation (Cryptographic):** Each claim generates a cryptographic Nullifier bound to the user's face embedding and the specific aid allocation ID. The smart contract rejects duplicate nullifiers.

### 2. Compromised Browser Forging Embeddings
- **Threat:** A rooted/jailbroken browser intercepts the camera feed or JavaScript logic to forge a "live" embedding without a real human.
- **Mitigation (Limitation):** This is a stated limitation of our prototype. Because we operate in a web browser, we rely entirely on software liveness checks. We do not have hardware attestation (like Apple's Secure Enclave) in this web prototype.

### 3. Coercive Enrollment by Aid Workers
- **Threat:** A corrupt aid worker coerces a beneficiary into enrolling against their will, or forces them to hand over their identity.
- **Mitigation (Procedural & Architectural):** We specifically designed AegisDID to make *refusing* enrollment survivable. Because there is no central biometric database (embeddings remain on the device), refusing to enroll does not create a permanent record of the refusal or flag the user in a centralized system.

### 4. Cross-Policy Linkage via Timing Correlation
- **Threat:** An attacker monitoring the relayer attempts to correlate when a specific nullifier is submitted across different aid policies to track a refugee's movements or aid history.
- **Mitigation (Cryptographic/Network):** While the relayer only receives a ZK-SNARK and a nullifier (with zero identity data), timing correlation is a known residual risk on public blockchains. Future versions will require mixnets or randomized submission delays to break timing analysis.
