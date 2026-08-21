# AegisDID Model Evaluation Results — FAR/TAR

**Status: MEASURED.** Every number on this page was produced by
`web/scripts/far_tar_eval.mts` against the deployed face pipeline. Raw output:
`web/.eval/far_tar_results.json`.

> **Correction to an earlier revision.** This file previously contained a `[TBD]` metrics table and
> the sentence "Selected threshold ensures FAR < 0.1% while maximizing TAR for unconstrained
> humanitarian environments." That was an unmeasured guarantee and has been removed. Nothing had been
> evaluated at the time it was written. The measurement below also contradicts the threshold example
> used elsewhere in the project — see §6.

---

## 1. What was measured, and on which model

The evaluation drives the **deployed** pipeline, not a proxy:

| Stage | Component |
|---|---|
| Detection | face-api.js `TinyFaceDetector`, `inputSize: 224`, `scoreThreshold: 0.15` |
| Alignment | `FaceLandmark68Net` → dlib-style aligned crop (`useDlibAlignment: true`) |
| Embedding | `FaceRecognitionNet`, 128-d |
| Weights | `web/public/models` — the exact seven files `MODEL_HASH` commits to |
| Quantizer | `lib/ml/quantize.ts` `quantizeEmbedding` |
| Comparison | `lib/ml/quantize.ts` `computeQuantizedDotProduct` (the circuit's fixed-point dot) |

This deliberately does **not** use `tools/generate_lfw_eval.py`, which scores dlib's own ResNet-34
through the `face_recognition` package. That is a different network from the one this app ships, so
its numbers would describe something the prototype does not run. See `docs/EVAL_PLAN.md`.

Because scores are reported in **`tauQ` units**, they are directly the value an authority passes to
`AegisAid.createPolicy`. No conversion step sits between this table and a deployed policy.

### Reproduce

```bash
cd tools && ./venv/bin/python lfw_export_raw.py     # decode LFW → web/.eval/images.bin
```

```bash
cd web && node scripts/far_tar_eval.mts
```

The second command caches raw descriptors to `web/.eval/descriptors.f32`, so re-analysis is seconds
rather than the ~25-minute inference pass.

## 2. Corpus

| Property | Value |
|---|---|
| Source | LFW funneled (scikit-learn fetch, figshare mirror) |
| Images decoded | 1,000 |
| Identities | 250 (those with the most images, so genuine pairs exist) |
| Usable descriptors | **951** |
| Rejected: no face detected | 3 |
| Rejected: multiple strong faces | 46 |
| Detection rate | **99.7%** |
| Genuine pairs | **1,357** |
| Impostor pairs | **450,368** |

The 46 multi-face rejections are correct behaviour, not failures: LFW press photos frequently contain
a bystander, and `lib/ml/face.ts` refuses ambiguous frames rather than guessing which face to enrol.

**Resolution floor.** With 450,368 impostor pairs, the smallest non-zero FAR this corpus can resolve
is 1/450,368 = **2.22 × 10⁻⁶**. A measured FAR of 0 below means *"below that floor"*, **not** "zero".

## 3. Correctness gate — the pipeline reproduces the reference model

A FAR/TAR table is worthless if the harness misconfigured alignment, pixel range or weight loading.
So before reporting similarity, the harness scores the corpus in dlib's **native** metric —
Euclidean descriptor distance at threshold 0.6, where dlib publishes **99.38%** LFW accuracy.

| Quantity | Measured |
|---|---|
| Genuine mean Euclidean distance | 0.4367 |
| Impostor mean Euclidean distance | 0.8116 |
| TAR at distance ≤ 0.6 | 98.23% |
| FAR at distance ≤ 0.6 | 0.88% |
| **Balanced accuracy at 0.6** | **98.68%** |

The harness **fails and refuses to write results** if balanced accuracy falls below 98%.

98.68% is close to but below dlib's published 99.38%, and the gap is expected rather than a defect:
dlib's figure uses the standard LFW restricted protocol (6,000 curated pairs, 10-fold
cross-validation with a per-fold threshold, 50/50 genuine/impostor), while this is all-pairs at a
single fixed threshold over a corpus deliberately biased toward the **most-photographed** identities
— whose images span more years, ages and lighting, making genuine pairs harder. Balanced accuracy is
used because impostor pairs outnumber genuine ones ~332:1, which would make raw accuracy ~99.7%
regardless of whether the model worked.

**Gate result: PASSED.** The similarity figures below are therefore measurements of the deployed
model, not of a broken harness.

## 4. Score distributions, in circuit units

`dot = Σ(u_live,i − 128)(u_reg,i − 128)`; cosine ≈ `dot / 16129`.

| | mean dot | mean cosine | min | p1 | median | p99 | max |
|---|---|---|---|---|---|---|---|
| **Genuine** (same person) | 15,354 | 0.9520 | 13,894 | 14,695 | 15,369 | — | 15,996 |
| **Impostor** (different people) | 13,508 | 0.8375 | 11,122 | — | 13,533 | 14,668 | 15,588 |

**Read the impostor row carefully.** Two *different* people score cosine **0.8375** on average. This
is not an error — it is a property of this descriptor family, and §6 explains why it invalidates an
example used elsewhere in this project.

Raw descriptor L2 norm before quantization: mean **1.4213**, min 1.2113, max 1.6937. The descriptors
are **not** unit vectors; `quantizeEmbedding` divides by the measured norm itself, so normalization
is enforced by the quantizer rather than inherited from the model.

## 5. Threshold sweep

| cosine τ | `tauQ` | TAR | FAR | inside sound range? |
|---|---|---|---|---|
| 0.20 | 3,226 | 100.00% | **100.0000%** | yes |
| 0.30 | 4,839 | 100.00% | **100.0000%** | yes |
| 0.40 | 6,452 | 100.00% | **100.0000%** | yes |
| 0.50 | 8,064 | 100.00% | **100.0000%** | yes |
| 0.60 | 9,677 | 100.00% | **100.0000%** | yes |
| 0.65 | 10,484 | 100.00% | **100.0000%** | yes |
| 0.70 | 11,290 | 100.00% | 99.9980% | yes |
| 0.75 | 12,097 | 100.00% | 99.3696% | yes |
| 0.80 | 12,903 | 100.00% | 85.6100% | yes |
| 0.85 | 13,710 | 100.00% | 37.6865% | yes |
| 0.90 | 14,516 | 99.63% | 2.4718% | yes |
| 0.95 | 15,323 | 57.92% | 0.0020% | yes |

### Operating points

Smallest `tauQ` meeting each FAR target, which is also the one maximizing TAR at that FAR:

| FAR target | `tauQ` | cosine | TAR | measured FAR | false accepts |
|---|---|---|---|---|---|
| ≤ 1 × 10⁻² | 14,669 | 0.9095 | **99.19%** | 0.99963% | 4,502 / 450,368 |
| ≤ 1 × 10⁻³ | **14,984** | 0.9290 | **91.30%** | 0.09925% | 447 / 450,368 |
| ≤ 1 × 10⁻⁴ | 15,209 | 0.9430 | 73.54% | 0.00977% | 44 / 450,368 |
| = 0 (below the floor) | 15,589 | 0.9665 | 18.72% | 0.00000% | 0 / 450,368 |

**Equal error rate: 0.8916%** at `tauQ` 14,686 (cosine 0.9105) — FAR 0.8988%, FRR 0.8843%.

### Recommended starting value for a demo policy

**`tauQ = 14984`** (cosine ≈ 0.929, FAR ≈ 1 × 10⁻³, TAR ≈ 91.3%).

Rationale, stated as a trade-off rather than an optimum: on this corpus, roughly 1 impostor pair in
1,000 is accepted and roughly 1 genuine attempt in 11 is rejected. For aid distribution a false
reject denies a real person rations, so a deployment would likely accept a higher FAR in exchange for
TAR — but that is a policy decision with an operator override, and no override path exists
(`docs/ETHICS_DPIA.md` §4). This value is a defensible demo default, **not** a validated field
setting.

## 6. Critical finding — the documented example threshold accepts everyone

`docs/CRYPTO_SPEC.md` uses `cosineToTauQ(0.5) = 8065` as its worked example, and the live Base
Sepolia policy 103 was created with `tauQ = 1`. Both are inside the sound range
`[MIN_TAU_Q, MAX_TAU_Q] = [1, 16129]`, so the contract accepts them and the circuit's comparator does
not fail open. **Both have a measured FAR of 100%.**

Every cosine threshold at or below **0.65** admits every impostor pair in this corpus — 450,368 out
of 450,368. The cause is in §4: these descriptors descend from dlib's Euclidean-trained network and
are not mean-centred, so unrelated faces already sit at cosine ~0.84. The entire usable band is
roughly **0.90 – 0.97** (`tauQ` ≈ 14,500 – 15,600); below it the system is an unconditional accept.

This is the concrete evidence behind the caveat repeated across the docs: **`AegisAid`'s `tauQ`
bounds enforce soundness, not adequacy.** They stop a `tauQ` that would make `GreaterEqThan(24)` wrap
and return 1 unconditionally; they cannot stop a policy that is simply wrong. A policy created with a
plausible-sounding cosine of 0.5 verifies a valid Groth16 proof and grants aid to any face.

Practical consequences:
- Never derive a demo `tauQ` from an intuition about cosine similarity. Use §5.
- Base Sepolia policy 103 (`tauQ = 1`) must not be presented as a working policy. See
  `docs/DEPLOYMENT.md` §0.3.
- An authority UI should warn below `tauQ` ≈ 14,500. The dashboard currently validates only the
  soundness bound, so this warning does **not** exist (`GAP`).

## 7. What these numbers do NOT establish

- **They do not describe the intended population.** LFW is adult, largely Western press
  photography. Nothing here predicts accuracy for children, veiled faces, weathered or injured
  skin, or low-light field capture. A false reject means a person is denied aid.
  See `docs/MODEL_CARD.md`.
- **No demographic breakdown was measured**, so the prototype cannot show it fails evenly across
  skin tone, age or sex.
- **Liveness is not exercised at all.** Every input is a still photograph. These figures describe the
  recognition threshold only; the EAR/yaw liveness check is defeatable by a replay video
  (`docs/THREAT_MODEL.md`).
- **Both images of every pair are stills.** Production compares an enrolment session against a later
  claim session — different camera, lighting and pose — which is strictly harder than this.
- **FAR = 0 is not zero**, only below the 2.22 × 10⁻⁶ resolution floor of §2.
