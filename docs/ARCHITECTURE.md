# System Architecture

AegisDID uses a hybrid stack of Client-side AI, Zero-Knowledge Proofs, and Smart Contracts to achieve scalable, privacy-preserving aid distribution.

## Data Flow Diagram

```text
+-------------------+        +--------------------+       +-----------------------+
|  Beneficiary      |        |  Client Device     |       |  AegisDID Blockchain  |
|                   |        |  (Browser / PWA)   |       |                       |
| 1. Looks at Phone +------->| 2. face-api.js     |       |                       |
|                   |        |    Extracts 128-d  |       |                       |
+-------------------+        |    Embedding       |       |                       |
                             |                    |       |                       |
                             | 3. SnarkJS         +------>| 5. Verifier Contract  |
                             |    Generates ZK    |       |    Checks Proof       |
                             |    Proof (Groth16) |       |                       |
                             |                    |       | 6. Vault Contract     |
                             | 4. Sends Proof to  |       |    Checks Nullifier & |
                             |    Relayer (Gas)   |       |    Dispenses Aid      |
                             +--------------------+       +-----------------------+
```

## Component Breakdown

1. **Client-side AI (Next.js PWA):** The browser uses `face-api.js` to extract a 128-dimensional face embedding. The raw image is instantly discarded.
2. **ZK Circuit (Circom):** The embedding is fed into a `circom` circuit. The circuit proves that the embedding matches a known hash (authentication) or that the distance between two embeddings meets the threshold `tauQ`. It outputs a Zero-Knowledge Proof.
3. **Gas Relayer:** To prevent beneficiaries from needing crypto wallets to pay for gas, the client sends the ZK proof to a relayer. The relayer pays the transaction fee.
4. **Smart Contracts (Solidity):** The Verifier contract cryptographically validates the ZK proof. If valid, the Vault contract checks that the unique Nullifier hasn't been used, and dispenses the aid token.
