# AegisDID Cryptographic Specification

Every value below is what `circuits/aegis_claim.circom` and the TypeScript in `web/lib` actually
compute. Agreement between the two is enforced by `web/scripts/circuit_conformance.mts`
(29 assertions, real Groth16 `fullProve` + `verify`; run `npm run test:circuit` from `web/`).

## Field and hash

- **Field:** BN254 scalar field, order
  `r = 21888242871839275222246405745257275088548364400416034343698204186575808495617`
- **Hash:** Poseidon, circomlib parameters (x^5 S-box). The browser uses `circomlibjs`; the
  circuit uses `circomlib`. Conformance between them is asserted by the test above.

## Embedding quantization

```
z         in R^128        (face-api.js FaceRecognitionNet descriptor — NOT unit norm)
z_hat     = z / ||z||_2                                  L2-normalized by the quantizer
q_i       = clamp(round(z_hat_i * 127), -127, 127)       in [-127, 127]
u_i       = q_i + 128                                    in [1, 255]
```

`u_i` is the field-safe unsigned encoding fed to the circuit as a private input. The shift by 128
is undone in-circuit before the dot product.

> **Normalization is performed by `quantizeEmbedding`, not inherited from the model.** The raw
> FaceRecognitionNet descriptor is not a unit vector: measured over 951 LFW descriptors its L2 norm
> has mean **1.4213** (min 1.2113, max 1.6937). An earlier revision of this spec described `z`
> itself as "L2-normalized", which would make the division redundant — it is not. Removing it would
> scale every `q_i` by an arbitrary per-image factor and break the cosine interpretation below.
> See `docs/RESULTS.md` §4.

## Model hash

```
MODEL_HASH = keccak256( domain-separated concatenation of all 7 pipeline artifacts ) mod r
           = 0x1515797c52937818f1db7a4b94f66e99c5805171e6d78ddc5280933e981c6ff4  (mod r)
```

The hash covers **all seven** files in `web/public/models` that affect the descriptor — the
TinyFaceDetector, FaceLandmark68Net, and FaceRecognitionNet manifests and weight shards — each
domain-separated by its filename, so reordering or renaming shards changes the hash. Computed by
`tools/compute_model_hash.mjs`.

> An earlier value, `0x198d997c…`, covered only the recognition shards and must not be reused.
> Binding a policy to the narrower hash would let a changed detector or landmark model alter the
> descriptor without changing `modelHash`.

`MODEL_HASH` is bound into `C_id`, so a commitment enrolled under one model cannot be proved
against a policy pinned to another: changing `modelHash` breaks Merkle inclusion, not just the
public-signal comparison.

## Embedding commitment

```
h_j    = Poseidon16(u[16j .. 16j+15])        for j = 0..7
C_emb  = Poseidon9(h_0, ..., h_7, salt)
```

`salt` is a 254-bit value from the browser CSPRNG (`crypto.getRandomValues`), stored in IndexedDB
and never transmitted.

## Identity commitment (Merkle leaf)

```
C_id   = Poseidon3(idSecret, C_emb, MODEL_HASH)
```

`idSecret` is a 254-bit CSPRNG value, stored in browser IndexedDB, never transmitted. The
enrolment API rejects any request body containing `idSecret`, `salt`, `embedding`, `descriptor`,
`uReg`, or `uLive` with HTTP 403 — tested by field *presence*, not truthiness, so a
present-but-falsy `{"idSecret": 0}` is also refused.

## Nullifier

```
nf     = Poseidon3(idSecret, policyId, epoch)
```

Binding to both `policyId` and `epoch` means nullifiers are unlinkable across policies and
re-usable across epochs (one claim per epoch). Verified by conformance test §7.

## Similarity (fixed point, in-circuit)

```
dot    = SUM_{i=0}^{127} (u_live_i - 128) * (u_reg_i - 128)
```

**Attainable range.** Each factor lies in [-127, 127], so each product lies in [-16129, 16129]
and the 128-term sum lies in:

```
dot in [-2064512, 2064512]          where 2064512 = 128 * 127 * 127
```

For L2-normalized inputs the cosine similarity is recovered as `dot / 127^2 = dot / 16129`, so a
self-match gives `dot ~= 16129` and the *practical* range is far narrower than the algebraic
bound above. The algebraic bound is what the comparator must accommodate.

**Acceptance test, exactly as implemented** (`aegis_claim.circom` lines 109–112):

```
GreaterEqThan(24):  in[0] = dot  + 2097152      // 2097152 = 2^21
                    in[1] = tauQ + 2097152
                    out === 1
```

The `+2^21` offset shifts the signed `dot` into the non-negative range the comparator requires:
`-2064512 + 2^21 = 32640 >= 0`, and `2064512 + 2^21 = 4161664 < 2^24`, so both comparator inputs
fit the 24-bit width for every attainable `dot`.

> **Correction.** An earlier revision of this document stated the offset as `2^22` and the range
> as `[-2097152, 2097152]`. Both were wrong: the circuit literal `2097152` is `2^21`, not `2^22`,
> and `2097152` is the *offset*, not the range endpoint — the true endpoint is `128 * 127^2 =
> 2064512`. The numbers here match the circuit source.

**Threshold.**

```
tauQ   = round(tau_cosine * 127 * 127)
```

Stored on-chain per policy and compared against public signal `[4]` by `AegisAid.claimAid`, so a
beneficiary cannot substitute a lenient threshold. The boundary is
**inclusive**: a face whose measured `dot` equals `tauQ` exactly is accepted (asserted by
conformance test §3b, which proves at `tauQ == dot` and fails at `tauQ == dot + 1`).

> **`cosineToTauQ(0.5) = 8065` is arithmetically correct and operationally catastrophic.** Do not
> use it, or any similar intuition-derived value, as a policy threshold. Measured on real faces
> through the deployed pipeline, **every cosine threshold ≤ 0.65 has a FAR of 100%** — 450,368
> impostor pairs out of 450,368 accepted. The cause is that FaceRecognitionNet descriptors are
> trained for Euclidean distance and are not mean-centred, so two *different* people score cosine
> ≈ 0.8375 on average. The usable band is only ≈ **0.90 – 0.97** (`tauQ` ≈ 14,500 – 15,600).
> Take thresholds from `docs/RESULTS.md` §5, never from a guess about cosine similarity.

**Valid `tauQ` domain — ENFORCED.**

```
MIN_TAU_Q = 1
MAX_TAU_Q = 127 * 127 = 16129      // = cosineToTauQ(1.0)
```

`AegisAid.createPolicy` reverts `InvalidTauQ()` outside this range, `AegisAid.claimAid` re-checks
it, and the client refuses the policy in `lib/chain/client.ts`, `lib/ml/quantize.ts`, the claim
page and the dashboard. The bound exists because **an out-of-range `tauQ` is fail-open, not
fail-closed** — this was measured, not reasoned about:

| `tauQ` | Synthetic non-matching vector (cosine 0.0889) |
|---|---|
| `8065` (cosine 0.5) | rejected — circuit assert at line 112 |
| `0` | **PROVED** — accepts any `dot >= 0` |
| `2^24` | rejected — circuit assert |
| `r - 1` | **PROVED** — a valid Groth16 proof for a different person |
| `r - 1000000` | **PROVED** |

Reproduce with `node scripts/tauq_bound_probe.mts` from `web/`. Root cause: circomlib's
`GreaterEqThan(n)` is `LessThan(n)(in[1], in[0] + 1)`, whose range check runs through
`Num2Bits(n+1)`. A `tauQ` expressed as a large field residue makes that decomposition wrap, so the
comparator returns `1` unconditionally and the biometric threshold is never applied. The circuit
cannot defend itself — `tauQ` is a public input — so the contract is the enforcement point.

`MAX_TAU_Q` is a usability and comparator-window cap, **not** the largest attainable `dot`.
Because `q_i = round(127 * z_i)` is an integer rounding, a genuine self-match scatters around
`16129` rather than landing on it — measured over 20,000 random unit vectors, `dot` for a vector
against itself ranges **15852 to 16447** (`scripts/quantize_test.mts` §9). A policy at
`tauQ = 16129` is sound but already too strict to be reliably claimable.

> The bound enforces **soundness, not adequacy**. A `tauQ` inside `[1, 16129]` can still be a bad
> threshold — and on this model most of the range is catastrophically bad. FAR/TAR has now been
> measured on the deployed pipeline: use the operating points in `docs/RESULTS.md` §5
> (`tauQ = 14984` for FAR ≈ 10⁻³ at TAR 91.3%). `docs/RESULTS.md` §6 shows that a policy at
> `tauQ = 8065` — a "cosine 0.5" threshold — accepts **every** face while producing perfectly valid
> Groth16 proofs.

## Merkle tree

- Binary incremental Merkle tree, **depth 20** (capacity 2^20 = 1,048,576 leaves)
- Internal node: `Poseidon2(left, right)`
- Zero leaf: `0`; zero-hash ladder `z_0 = 0`, `z_{i+1} = Poseidon2(z_i, z_i)`
- `pathIndices[i] = 1` means the current node is the **right** child at level `i`

**Empty-tree root** (the ladder top, `z_20`):

```
15019797232609675441998260052101280400536945603062888308240081994073687793470
```

This is **non-zero**, and is therefore distinct from the all-zero `bytes32` value that
`AegisAid.policies[id].cohortRoot` holds before any root is published. Both are refused by the
authority dashboard for different reasons: the all-zero value is the "no root published"
sentinel, while the empty-tree root is structurally valid but contains no beneficiary, so every
claim against it would fail.

## Public signals

Order is fixed and asserted end-to-end (circuit, contract, client, and both test scripts):

```
[0] nullifier   [1] root   [2] policyId   [3] epoch   [4] tauQ   [5] modelHash
```

`root`, `policyId`, `epoch`, `tauQ`, and `modelHash` are declared public in the circuit;
`nullifier` is a public output.

## Circuit size (measured)

`npx snarkjs r1cs info circuits/build/aegis_claim.r1cs`:

| Metric | Value |
|---|---|
| Curve | bn-128 |
| Constraints | 32,168 |
| Wires | 32,193 |
| Private inputs | 298 |
| Public inputs | 5 |
| Public outputs | 1 |
| Labels | 52,495 |
