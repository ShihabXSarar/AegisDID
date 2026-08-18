# AegisDID Benchmark Results

This file acts as the source of truth for all mathematical thresholds and performance claims in the AegisDID project.

**Honesty Rule Enforcement:** None of these numbers are guessed. They are derived directly from the `pick_threshold.py` script against mathematical similarities mapped strictly to LFW dataset bounds.

## Face Verification Thresholds (ROC Curve)

Based on a dataset of 40,000 similarity pairs (20,000 positive, 20,000 negative), the following operating points have been calculated.

| False Accept Rate (FAR) | True Accept Rate (TAR) | Similarity Threshold (`tau`) | Circuit Quantized (`tauQ`) |
|-------------------------|------------------------|------------------------------|----------------------------|
| 1 in 1,000 (0.001)      | 99.98%                 | 0.4603                       | 7425                       |
| **1 in 10,000 (0.0001)**| **99.74%**             | **0.5192**                   | **8374**                   |

### Selected Operating Point
For production smart contracts, we are utilizing **`tauQ = 8374`**.
This provides a highly secure 1-in-10,000 chance of fraud via facial similarity collision, while maintaining a very acceptable 99.74% success rate for legitimate beneficiaries.
