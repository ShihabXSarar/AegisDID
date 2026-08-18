# Evaluation Plan & Benchmarks

This document tracks the actual, measured performance of the AegisDID system across the AI, ZK, and Blockchain layers.

## 1. Biometric Performance (ISO/IEC 30107-3 Standards)

Measured via mathematical projection of LFW curves (`tools/pick_threshold.py`).

| Metric | Measured Value | Target |
|--------|----------------|--------|
| APCER (Attack Presentation Classification Error Rate / FAR) | 0.0001 | <= 0.001 |
| BPCER (Bona Fide Presentation Classification Error Rate / FRR) | 0.0026 | <= 0.01 |
| Operating Threshold (`tau`) | 0.5192 | N/A |
| Quantized Threshold (`tauQ`) | 8374 | N/A |

## 2. Zero-Knowledge Circuit Complexity

*To be filled when Person A completes the Circom circuits.*

| Metric | Measured Value |
|--------|----------------|
| Total Constraint Count | [PENDING PERSON A] |
| R1CS File Size | [PENDING PERSON A] |
| Proving Key Size | [PENDING PERSON A] |

## 3. Mobile Proving Time

*To be filled by Person B after testing on physical mobile hardware (not laptops).*

| Run | Proving Time (ms) | Device Specs |
|-----|-------------------|--------------|
| Median of 20 runs | [PENDING PERSON B] | [e.g., iPhone 12] |
| Worst-case run | [PENDING PERSON B] | [e.g., iPhone 12] |

## 4. Blockchain Gas Efficiency

*To be filled when Person A deploys the Solidity contracts.*

| Operation | Gas Used | Cost in USD (est. at 20 gwei) |
|-----------|----------|-------------------------------|
| `createPolicy()` | [PENDING] | [PENDING] |
| `updateCohortRoot()` | [PENDING] | [PENDING] |
| `claimAid()` (Verification) | [PENDING] | [PENDING] |
