# AegisDID: Sybil-Resistant Decentralized Identity for Humanitarian Relief via Edge AI and ZK-ML

A secure, AI-powered decentralized identity platform built for the Blockchain Olympiad 2026. This repository contains the complete source code for the prototype, including frontend, backend, AI services, Blockchain integration, and Documentation.

## Overview
AegisDID provides a privacy-preserving, sybil-resistant identity solution tailored for humanitarian aid distribution. It relies on a Next.js Progressive Web App (PWA) operating on edge devices (commodity smartphones) running AI inference (MediaPipe and Face-api.js) and Zero-Knowledge Proofs (snarkjs) completely within the browser. 

No raw biometric data (images, face embeddings, or private keys) ever leaves the device. The system only submits cryptographic ZK proofs and public signals to the Base Sepolia testnet to verify identity and claim aid.

## Key Features
*   **Edge AI Biometrics:** In-browser face detection, 128-D face embeddings (via `face-api.js`), and deterministic liveness detection (blink and head turn via `MediaPipe Face Landmarker`).
*   **ZK-ML Identity:** Biometric embeddings are quantized and committed using a Poseidon hash. Threshold matching is done completely in-circuit.
*   **Zero-Knowledge Proofs:** Client-side Groth16 proof generation using `snarkjs` and WebAssembly to prove identity and membership without revealing who the person is.
*   **Smart Contracts:** Deployed on **Base Sepolia**. Uses auto-generated Groth16 verifiers, policy management, and Merkle tree state to ensure no double-claiming (Sybil resistance).
*   **100% Privacy:** Fail-closed privacy model. All liveness signals and biometric processing happen locally.

## Architecture

```text
Beneficiary's phone browser (Next.js PWA)
 ├─ Camera capture (getUserMedia)
 ├─ MediaPipe FaceMesh → liveness challenge (blink + head turn)
 ├─ face-api.js → 128-d face embedding (all in-browser, TensorFlow.js/WASM)
 ├─ Quantize embedding to int8, build ZK witness
 ├─ snarkjs (Groth16) proof generation — Web Worker, WASM
 └─ Submit {proof, publicSignals} via wallet (or relayer) to smart contract
        │
        ▼
Base Sepolia testnet
 ├─ Groth16Verifier.sol (auto-generated from the circuit)
 ├─ AegisAid.sol — checks proof against ITS OWN stored policy params,
 │                  rejects reused nullifiers, emits AidClaimed
 └─ DIDRegistry.sol — beneficiary DID ↔ identity commitment binding

Aid-authority dashboard (Next.js)
 ├─ Create/manage policies (cohort Merkle root, threshold, model hash)
 ├─ Enroll beneficiaries → add to Merkle tree → publish new root
 └─ Read-only audit log of AidClaimed events (no identity ever shown)
```

## Repository Structure
*   `circuits/`: Circom circuits for embedding quantization, commitment, and similarity verification.
*   `contracts/`: Solidity smart contracts (Foundry) for AegisAid and Groth16 Verification.
*   `web/`: Next.js Web App for both beneficiaries and field workers.
    *   `lib/ml/`: MediaPipe and face-api integration.
    *   `lib/zk/`: snarkjs Web Worker integration.
    *   `lib/chain/`: Contract interaction via viem/ethers.
*   `dashboard/`: Next.js aid-authority console to manage policies and enroll beneficiaries.
*   `docs/`: Extensive architectural specs and threat models.

## Getting Started

### Prerequisites
*   Node.js 20 LTS
*   Rust (for circom)
*   Foundry (for contracts)

### Setup
1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-org/AegisDID.git
    cd AegisDID
    ```
2.  **Install dependencies:**
    Navigate to the respective folders (`web`, `dashboard`, `circuits`) and run `npm install`.
3.  **Run the Web App:**
    ```bash
    cd web
    npm run dev
    ```

## Known Limitations & Threat Model
As a prototype, AegisDID relies on software-only liveness in the browser, which carries a residual risk of being defeated by on-demand replay video or frame injection. Real-world deployment would require hardware sensor attestation. The ZK circuit and smart contracts, however, provide strong mathematical guarantees of privacy and sybil-resistance.

## License
See the `LICENSE` file for details.
