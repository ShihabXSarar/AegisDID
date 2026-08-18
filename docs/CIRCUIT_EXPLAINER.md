# ZK Circuit Math Explainer

Implementing facial recognition inside a Zero-Knowledge Proof (zk-SNARK) is notoriously difficult because ZK circuits only operate on integers and modular arithmetic, while AI embeddings rely on floating-point decimals and division.

Here is how AegisDID solves this mathematically.

## The Problem: Floating Point Division
Cosine similarity is calculated as the dot product of two vectors divided by the product of their magnitudes:

`Similarity = (A · B) / (|A| * |B|)`

In a Circom circuit, division is highly constrained and fractional numbers do not exist.

## The Solution: Squared Cross-Multiplication
Instead of dividing, we re-arrange the algebra to only use multiplication, which circuits excel at.

1. We want to prove: `(A · B) / (|A| * |B|) >= tau`
2. Since both sides are positive (assuming normalized embeddings), we can square both sides:
   `(A · B)^2 / (|A|^2 * |B|^2) >= tau^2`
3. We move the denominator to the other side via cross-multiplication:
   `(A · B)^2 >= tau^2 * (|A|^2 * |B|^2)`

## Fixed-Point Quantization (`tauQ`)
Because `tau` is a decimal (e.g., `0.5192`), we must quantize it into an integer to use it in the circuit. 
Since our embeddings are scaled, we multiply the threshold by our scaling factor to get an integer representation, which we call `tauQ`.

In our smart contract, we don't store `0.5192`. We store `tauQ = 8374`. 
The circuit simply proves that the integer dot-product squared is greater than or equal to `tauQ` times the integer magnitudes squared.

This allows us to verify AI matrix math purely using modular integer arithmetic!
