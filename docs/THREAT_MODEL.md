# Threat Model & Security Posture

AegisDID is designed to protect beneficiary privacy while preventing aid allocation fraud. We prioritize cryptographic guarantees over procedural ones wherever possible.

## Trust Assumptions

The following table outlines our core security guarantees, their strength, and what they rely on. This is the foundation of our threat model.

| Guarantee | Strength | Depends on |
|---|---|---|
| No double-claim per allocation | Unconditional (cryptographic) | Nullifier uniqueness on-chain |
| Biometric threshold actually met | Unconditional (cryptographic) | In-circuit fixed-point cosine check vs on-chain τ |
| Raw face images never leave device | Strong (procedural/architectural) | Browser sandbox & open-source client verification |
| AI Model integrity | Strong (procedural) | Checksum verification of static model weights |
| Relayer cannot censor specific users | Moderate (cryptographic) | ZK proofs reveal no identity to the relayer |

## Threat Analysis

### 1. Sybil Attacks (Double-Claiming)
- **Threat:** A user attempts to claim aid multiple times.
- **Mitigation (Cryptographic):** Each claim generates a cryptographic Nullifier bound to the user's face embedding and the specific aid allocation ID. The smart contract rejects duplicate nullifiers.
- **Residual Risk:** Negligible. 

### 2. Photo Spoofing (Presentation Attacks)
- **Threat:** An attacker holds a photo of a beneficiary in front of the camera.
- **Mitigation (Procedural):** Liveness detection (e.g., blinking/smiling challenges) implemented on the client before the embedding is generated.
- **Residual Risk:** Moderate. Advanced deepfakes or 3D masks could bypass standard 2D liveness checks.

### 3. Threshold Manipulation
- **Threat:** An attacker lowers the similarity threshold (`tau`) to force a false accept.
- **Mitigation (Cryptographic):** The `tauQ` threshold is hardcoded into the smart contract allocation policy. The ZK circuit enforces that the computed similarity strictly exceeds `tauQ`.
- **Residual Risk:** None. The contract guarantees it mathematically.

### 4. Relayer Censorship
- **Threat:** The gas relayer refuses to submit transactions for a specific ethnic group or region.
- **Mitigation (Cryptographic):** The relayer only receives a ZK-SNARK and a nullifier. It has zero knowledge of the underlying embedding or identity.
- **Residual Risk:** Low. A relayer could censor all transactions, but cannot target specific individuals.
