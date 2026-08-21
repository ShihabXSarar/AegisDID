# AegisDID Deployment Guide

Covers deploying `Groth16Verifier` and `AegisAid`, and — importantly — the state of the **existing**
Base Sepolia deployment, which is **not** equivalent to the current source tree. Read §0 before
demonstrating anything against Base Sepolia.

---

## 0. STOP — status of the existing Base Sepolia deployment

Verified by read-only RPC calls against chain ID **84532** on the addresses in §4.

### 0.1 The deployed bytecode predates the security hardening — `VERIFIED`

The `AegisAid` at `0xAB2fa997c25B0B02E635052166d0192b5Eab5765` was compiled from an **older**
version of `src/AegisAid.sol`. Evidence:

| Probe on the deployed contract | Result | Meaning |
|---|---|---|
| `cast call … "MIN_TAU_Q()(uint256)"` | reverts | function absent |
| `cast call … "MAX_TAU_Q()(uint256)"` | reverts | function absent |
| `cast call … "policyExists(uint256)(bool)" 101` | reverts | function absent |
| `setAdmin(address)` selector `0x704b6c02` in `cast code` | 0 occurrences | function absent |
| deployed code size | 5,716 bytes | current build is 7,545 bytes |

Consequences for anything demonstrated against this address:

1. **The `tauQ` soundness bound is NOT enforced on-chain.** An issuer can create a policy with
   `tauQ = 0` or a large field residue, and the in-circuit comparator then **fails open** — a
   non-matching face produces a valid Groth16 proof. This was measured, not theorised
   (`web/scripts/tauq_bound_probe.mts`; see `docs/CRYPTO_SPEC.md`). The client refuses such policies
   (`lib/chain/client.ts`, `lib/ml/quantize.ts`, the claim page and the dashboard), so the shipped
   UI fails closed — but the *contract* would accept the proof, so the guarantee is client-side only
   at this address.
2. **`updateCohortRoot` has no policy-existence guard**, so a root can be published for a policy
   that was never created. This is not hypothetical — see §0.3.
3. **The admin cannot be rotated**, because `setAdmin` does not exist in the deployed bytecode.

To get the hardened behaviour on-chain, the contracts must be **redeployed** (§3). That is the only
remedy for items 1–3; there is no upgrade path, as neither contract is a proxy.

### 0.2 The recorded admin key was exposed — `VERIFIED`

`cast call … "admin()(address)"` returns `0xcB2d8FaBEBB0b4f47F4Ea450C61643673d263744`, and
`isIssuer` for that address is `true`.

The **private key for this address was found in plaintext** in a working-tree file
(`web/verify_policy_103.mjs`, since deleted). It was never committed — verified absent from git
history — and it is testnet-only, but it must be treated as compromised:

- **Never send mainnet funds, or any funds you care about, to this address.**
- Because the deployed contract has no `setAdmin`, this key holds admin and issuer authority over
  that deployment **permanently**.
- Generate a **fresh** deployer key for any redeployment. Do not reuse this one.
- `.gitignore` covers `.env` and `.env.*` (verified: `contracts/.env` and `web/.env.local` are both
  ignored and absent from history), but it does **not** cover `*.mjs`. Never put a key in a script.

### 0.3 The existing demo policies are unusable — `VERIFIED`

Live `policies(uint256)` reads:

| Policy | cohortRoot | tauQ | modelHash | epoch | allocation | totalUnits | active |
|---|---|---|---|---|---|---|---|
| 101 | `0x10ac1cef…e20eb7` | 0 | `0x00…00` | 0 | 0 | 0 | **false** |
| 102 | `0x10ac1cef…e20eb7` | 0 | `0x00…00` | 0 | 0 | 0 | **false** |
| 103 | `0x00…00` | 1 | `0x1111…1111` | 1 | 10 | 5000 | **true** |

- **101 and 102** hold a non-zero cohort root while never having been created (`allocation = 0`,
  `active = false`). This is the missing-existence-guard defect of §0.1 item 2, visible in
  production state. They are not claimable: `claimAid` rejects an inactive policy.
- **103** is active but cannot ever produce a successful claim: `cohortRoot` is the all-zero "no
  root published" sentinel, so no Merkle membership proof can verify against it. Its `modelHash`
  is the placeholder `0x1111…1111`, not the canonical
  `0x1515797c52937818f1db7a4b94f66e99c5805171e6d78ddc5280933e981c6ff4`, so an enrolled `C_id` would
  not match its cohort anyway. Its `tauQ = 1` is *inside* the sound range but corresponds to a
  cosine threshold of ~0.00006 — effectively no biometric threshold at all. It is a stark example of
  the "soundness, not adequacy" caveat in `docs/CRYPTO_SPEC.md`.
- **`AidClaimed` events in the contract's entire history: 0.** No claim has ever succeeded on
  Base Sepolia.

So a Base Sepolia demo requires the authority to create a **correct** policy first (§5). That is a
state-changing transaction requiring a funded key and is therefore a **manual operator step**.

---

## 1. Requirements

* **MetaMask** (or any wallet) with Base Sepolia configured.
* **Base Sepolia test ETH** from a public faucet (Coinbase, Alchemy).
* **A Base Sepolia RPC URL** (Alchemy, Infura, or a public endpoint).
* **Foundry** (`forge`, `cast`). On Windows these live in WSL, not on the Windows PATH.

## 2. Local secret setup

```bash
cp contracts/.env.example contracts/.env
```

Fill in:

```text
BASE_SEPOLIA_RPC_URL=<your_rpc_url>
PRIVATE_KEY=<a_freshly_generated_deployer_key>
```

> **Never commit `.env`.** It is already ignored via `.gitignore` (`.env`, `.env.*`). Do not place a
> key in any other file type — `*.mjs`, `*.ts` and `*.json` are **not** ignored.

## 3. Deploy

From `contracts/`:

```bash
forge script script/Deploy.s.sol:Deploy --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast
```

`Deploy.s.sol` reads the key with `vm.envUint("PRIVATE_KEY")` and Foundry loads `.env`
automatically. Verify locally first:

```bash
forge build && forge test
```

Expected: **31 passed, 0 failed**.

## 4. Recorded deployment values

From the existing deployment at block 45,651,880 — see §0 for why these are **not** current with
the source:

* **`Groth16Verifier`**: `0x05ea2aDa4aB61F46b247B7b6c6943D74e99A06bd`
  ([explorer](https://base-sepolia.blockscout.com/address/0x05ea2aDa4aB61F46b247B7b6c6943D74e99A06bd))
  · deploy tx `0x56aaadab5da1e8277aca5baac3aeb49c94d4b92cd465a9ed36a22de0eb6084cf`
* **`AegisAid`**: `0xAB2fa997c25B0B02E635052166d0192b5Eab5765`
  ([explorer](https://base-sepolia.blockscout.com/address/0xAB2fa997c25B0B02E635052166d0192b5Eab5765))
  · deploy tx `0xbce234b92c6f3a4ebe5e30416e03368d17a0b91fa2a5549a989c90609f0c2523`
* Total deployment cost: `0.000012188637242442 ETH`

After redeploying, update **`web/.env.local`** (`NEXT_PUBLIC_AEGIS_AID_ADDRESS`,
`NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_CHAIN_ID=84532`). There is no separate dashboard app to
configure — the authority dashboard is a route inside the web app (`web/app/dashboard`); the
top-level `dashboard/` directory is an empty placeholder.

> **Never expose a private key through a `NEXT_PUBLIC_*` variable.** Everything so prefixed is
> inlined into the browser bundle. Only the RPC URL, chain ID and contract addresses belong there.

## 5. Creating a working policy

A claim needs a policy whose parameters are all correct simultaneously:

| Field | Requirement |
|---|---|
| `cohortRoot` | The **current** authority root, non-zero, and not the empty-tree root `15019797232609675441998260052101280400536945603062888308240081994073687793470` |
| `tauQ` | **`14984`** (cosine 0.929) — the measured FAR ≈ 10⁻³ / TAR 91.3% operating point. Never 1, never 16129, and never a value derived from an intuition about cosine similarity: every threshold ≤ cosine 0.65 has a **measured FAR of 100%** (`docs/RESULTS.md` §5–§6) |
| `modelHash` | Exactly `0x1515797c52937818f1db7a4b94f66e99c5805171e6d78ddc5280933e981c6ff4` |
| `epoch` | Matching what the claim page uses |
| `allocation` | Non-zero, `<= totalUnits` |

Publish the root **after** enrolments, and re-publish whenever the cohort changes: a beneficiary
whose leaf is not under the on-chain root cannot claim. The claim flow compares the authority's root
against the on-chain root and **refuses** on mismatch with
"Merkle root mismatch — authority must publish the current cohort root." It does not silently
repair the root beneficiary-side.

## 6. Local demo without a testnet

`contracts/script/SetupLocalDemo.s.sol` deploys both contracts against Anvil and creates a working
policy. This is the recommended path for a demo: no faucet, no key custody, and the **current**
hardened bytecode.

```bash
anvil                                            # terminal 1
forge script script/SetupLocalDemo.s.sol:SetupLocalDemo \
  --rpc-url http://127.0.0.1:8545 --broadcast    # terminal 2
```

Then point `web/.env.local` at `http://127.0.0.1:8545` with the printed addresses and chain ID
`31337`.

> Local-demo tooling must stay isolated from testnet mode. Anvil addresses and keys belong only in a
> local `.env.local`; never let a demo shortcut become reachable when the app is pointed at
> Base Sepolia.

## 7. Verifying a deployment

```bash
cast call <AegisAid> "admin()(address)"     --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call <AegisAid> "isIssuer(address)(bool)" <deployer> --rpc-url "$BASE_SEPOLIA_RPC_URL"
cast call <AegisAid> "MAX_TAU_Q()(uint256)" --rpc-url "$BASE_SEPOLIA_RPC_URL"   # must return 16129
```

The third call is the quickest way to tell hardened bytecode from the old deployment: on the
current source it returns `16129`; on the deployment in §4 it **reverts**.

## 8. Gas

Local Foundry measurements (`forge test --gas-report`) are recorded in `benchmarks/RESULTS.md`:
`claimAid` **294,571** gas, of which `Groth16Verifier.verifyProof` is **222,361**.

The authoritative on-chain figure is **NOT MEASURED** — no `claimAid` transaction has ever executed
on Base Sepolia (§0.3). It cannot be derived from the local number, because Base's L2 gas accounting
adds an L1 data-availability component Foundry does not model. To obtain it: complete a real claim,
open the transaction on the explorer, and record "Gas Used by Transaction" into
`benchmarks/RESULTS.md`.
