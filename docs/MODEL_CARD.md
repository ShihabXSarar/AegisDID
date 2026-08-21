# Model Card: AegisDID Quantized Face Verification

## Model Details
- **Architecture:** ResNet-34 based face recognition model (port of `dlib`'s
  `dlib_face_recognition_resnet_model_v1.dat` to `face-api.js`).
- **Detection & alignment:** `TinyFaceDetector` (`inputSize: 224`, `scoreThreshold: 0.15`) →
  `FaceLandmark68Net` → dlib-style aligned crop.
- **Input:** 150×150 cropped and aligned facial image, pixel range 0–255, mean-subtracted with
  `meanRgb = [122.782, 117.001, 104.298]` and divided by 256 inside the network.
- **Output:** 128-dimensional floating-point descriptor.
- **Weights:** the seven files in `web/public/models`, committed to by
  `MODEL_HASH = 0x1515797c52937818f1db7a4b94f66e99c5805171e6d78ddc5280933e981c6ff4`. That hash is a
  public signal of the circuit and a stored policy field, so a policy is bound to these exact weights.
- **Quantization:** `q_i = clamp(round(z_i · 127), −127, 127)`, `u_i = q_i + 128 ∈ [1, 255]`.
  `quantizeEmbedding` divides by the descriptor's **measured** L2 norm first — the raw descriptors are
  **not** unit vectors (measured mean norm 1.4213), so normalization is enforced by the quantizer, not
  inherited from the model.

## Intended Use
- **Primary use case:** verifying that a live camera feed on a beneficiary's own device matches a
  previously enrolled cryptographic commitment held by that same device.
- **Out of scope:** 1-to-N surveillance, identification without consent, deduplication against a
  central biometric database (none exists), and any facial analysis (age, gender, emotion).

## Metrics & Performance — MEASURED

Measured on the deployed pipeline described above, on 951 usable LFW descriptors
(1,357 genuine / 450,368 impostor pairs). Full tables, method and caveats in
[`RESULTS.md`](RESULTS.md); raw output in `web/.eval/far_tar_results.json`.

| | Value |
|---|---|
| Detection rate | 99.7% |
| Correctness gate (balanced accuracy at dlib's native Euclidean 0.6) | 98.68% — dlib publishes 99.38% |
| Equal error rate | 0.8916% at `tauQ` 14,686 (cosine 0.9105) |
| FAR ≈ 10⁻³ operating point | `tauQ` 14,984 (cosine 0.9290), TAR 91.30% |
| FAR ≈ 10⁻² operating point | `tauQ` 14,669 (cosine 0.9095), TAR 99.19% |

**The usable threshold band is narrow and high: cosine ≈ 0.90 – 0.97.** Because these descriptors
are trained for Euclidean distance and are not mean-centred, *different* people already score cosine
≈ 0.8375 on average. Every cosine threshold ≤ 0.65 had a **measured FAR of 100%** on this corpus.
A `tauQ` can therefore be inside the contract's sound range `[1, 16129]` and still accept every face
— see `RESULTS.md` §6.

### These metrics do not transfer to the intended population

LFW is **adult, largely Western press and celebrity photography** under favourable lighting. It is
not representative of a humanitarian enrolment population. Nothing measured here predicts accuracy
for children, veiled faces, weathered or injured skin, non-Western populations, or low-light field
capture on a low-end handset. In this system a false reject means **a person is denied aid**, and
there is no operator override or appeal path (`ETHICS_DPIA.md` §4).

**No demographic breakdown was measured.** The prototype cannot demonstrate that error rates are
even across skin tone, age or sex. Face recognition is well documented to be uneven on exactly these
axes, and the absence of a measurement is a gap, not evidence of fairness.

**Liveness was not exercised.** Every evaluation input is a still photograph. These figures describe
the recognition threshold only.

## Limitations
- Accuracy depends heavily on lighting and camera quality (edge-AI constraints).
- Quantization introduces precision loss that narrows the separation between edge-case genuine and
  impostor scores. A genuine self-match does not land at a fixed value: measured over 20,000 random
  unit vectors, self-dot lands anywhere in **15,852 – 16,447**, so 16,129 is not an attainable
  maximum (`web/scripts/quantize_test.mts` §9).
- **Software-only liveness.** The EAR blink / yaw head-turn check runs on unsigned camera frames and
  is **defeatable by a replay video** of a genuine beneficiary. There is no hardware TEE attestation
  of frame provenance. This system must not be represented as spoof-proof
  (`THREAT_MODEL.md`).
- A still photograph held to the camera is rejected only because it cannot satisfy the blink and
  head-turn challenges — not because any anti-spoofing model is running. There is none.
- The 46/1,000 multi-face rejections in evaluation reflect a deliberate fail-closed choice: an
  ambiguous frame is refused rather than resolved by guessing. In the field this will reject
  legitimate users in crowded enrolment settings.
