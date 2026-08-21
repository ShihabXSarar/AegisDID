# Benchmark Results

All figures below were produced by commands in this repository and are reproducible. Anything not
actually measured is marked **NOT MEASURED** rather than estimated.

Measured on: Foundry `forge` 1.7.1, Solc 0.8.35, `contracts/test/AegisAid.t.sol` (31 tests,
31 passed / 0 failed).

## Circuit size

`npx snarkjs r1cs info circuits/build/aegis_claim.r1cs`

| Metric | Value |
|---|---|
| Curve | bn-128 |
| Constraints | 32,168 |
| Wires | 32,193 |
| Private inputs | 298 |
| Public inputs | 5 |
| Public outputs | 1 |
| Labels | 52,495 |

## Gas — local Foundry measurement

Reproduce with:

```bash
forge test --gas-report
```

| Item | Gas |
|---|---|
| **`claimAid` — successful claim** | **294,571** |
| `Groth16Verifier.verifyProof` (of the above) | 222,361 |
| `claimAid` — reverting paths (min) | 35,650 |
| `createPolicy` | 163,786 (max) |
| `updateCohortRoot` | 33,487 |
| `setPolicyActive` | 33,204 |
| `AegisAid` deployment | 1,601,170 (size 7,545 bytes) |
| `Groth16Verifier` deployment | 479,294 (size 1,999 bytes) |

Notes on reading these numbers:

- The successful claim is the **max** column for `claimAid`; the min/median reflect the 11 tests
  that deliberately revert (unauthorised issuer, spent nullifier, wrong root, out-of-range `tauQ`,
  and so on), which cost far less. Quoting the average (101,710) would understate a real claim.
- The Groth16 pairing check dominates: **222,361 of 294,571 gas (75.5%)** is `verifyProof`. The
  AegisAid bookkeeping — nullifier write, allocation decrement, event — accounts for the remaining
  ~72,000.
- `test_validClaim()` reports 419,537 gas as a whole, but that includes the test's own
  `createPolicy` and issuer setup. The figure to quote for a claim transaction is 294,571.
- This is the gas consumed by the `claimAid` call under Foundry's EVM. A real transaction also pays
  the 21,000 base cost plus calldata, so the on-chain total will be higher.

> **Correction.** An earlier revision of this file recorded `claimAid` at **294,260** gas. The
> current measured value is **294,571**. The 311-gas increase is from the defence-in-depth
> `tauQ` bound re-check added to `claimAid` (`p.tauQ < MIN_TAU_Q || p.tauQ > MAX_TAU_Q`) and the
> `policyExists` guard. The old number was not wrong when written; it is stale.

## Gas — authoritative on-chain measurement: **NOT MEASURED**

No `claimAid` transaction has ever executed on Base Sepolia. A read-only audit of
`AegisAid` at `0xAB2fa997c25B0B02E635052166d0192b5Eab5765` found **zero `AidClaimed` events** in the
contract's history.

To obtain this figure, someone with a funded Base Sepolia wallet must complete a real claim and
record the explorer's "Gas Used by Transaction". It cannot be derived from the local number: L2 gas
accounting on Base includes an L1 data-availability component that Foundry does not model.

## Proving performance — browser, measured

Measured in a real Chromium session on the `/diagnostics` page (single sample, not an average):

| Stage | Time |
|---|---|
| Groth16 `fullProve` (WASM witness + proof) | 1,875 ms |
| Proof verification (`snarkjs.groth16.verify`) | 23 ms |

Both from `circuits/build/aegis_claim_js/aegis_claim.wasm` and `circuits/aegis_final.zkey`.
Single-sample timings on one machine; treat as an order-of-magnitude figure, not a benchmark.

## Conformance and unit tests — measured

| Suite | Command (from `web/`) | Result |
|---|---|---|
| Circuit ↔ TypeScript conformance | `npm run test:circuit` | 29 / 29 assertions, 1,659 ms |
| Liveness state machine | `npm run test:liveness` | 79 / 79 assertions |
| Quantization + `tauQ` bound | `npm run test:quantize` | all assertions pass |
| Solidity | `forge test` (from `contracts/`) | 31 passed / 0 failed |

## Recognition accuracy (FAR/TAR) — measured

Measured on the **deployed** face pipeline (the seven weight files `MODEL_HASH` commits to) over 951
usable LFW descriptors: 1,357 genuine and 450,368 impostor pairs. Reproduce with
`node scripts/far_tar_eval.mts` from `web/`.

| Metric | Value |
|---|---|
| Detection rate | 99.7% |
| Correctness gate — balanced accuracy at dlib's Euclidean 0.6 | 98.68% (dlib publishes 99.38%) |
| Equal error rate | 0.8916% at `tauQ` 14,686 |
| FAR ≈ 10⁻³ operating point | `tauQ` **14,984**, TAR **91.30%** |
| FAR ≈ 10⁻² operating point | `tauQ` 14,669, TAR 99.19% |
| Resolution floor | 2.22 × 10⁻⁶ (a measured FAR of 0 means "below this", not "zero") |

**Every cosine threshold ≤ 0.65 measured FAR 100%.** Full tables, method, and the reasons these
figures do not transfer to the intended population: `docs/RESULTS.md`. Do not quote a number from
here without reading §7 there.
