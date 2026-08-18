# Benchmark Results

## Circuit Size

* **R1CS Constraint Count:** 32,168

## Gas Measurements

* **`claimAid` gas used:** 294,260

**Measurement Methodology:**
This value was measured using a local Foundry execution that reflects the real call. Specifically, we executed `forge test --match-test test_validClaim --gas-report` against the existing `AegisAid.t.sol` test suite, which uses the valid proof generated from `aegis_claim.circom` with real zero-knowledge public signals. The reported gas usage for the `claimAid` function execution was extracted from the resulting Foundry gas profile.
