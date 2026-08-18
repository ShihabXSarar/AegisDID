# AegisDID — Always On

## Non-negotiables
- Never invent cryptographic constructions. All commitments, nullifiers, and
  encodings MUST match docs/CRYPTO_SPEC.md byte-for-byte. If the spec is
  ambiguous, STOP and ask; do not guess.
- Raw face images, raw embeddings, the salt, and the idSecret NEVER leave the
  browser. No network call (fetch, axios, contract call) may carry image
  bytes, embedding vectors, the salt, or idSecret. Flag any code that would
  violate this before writing it.
- The smart contract MUST read cohortRoot/tauQ/modelHash/epoch from its own
  storage and compare them against the proof's public signals. A
  caller-supplied threshold or root anywhere is a critical security bug —
  treat it as a build-blocking error, not a style note.
- No secrets in source. Use .env + .env.example, never hardcode private keys.
- Every security-relevant change (nullifier logic, verifier wiring, policy
  checks) needs a Foundry test that fails before the fix and passes after.

## Stack (do not substitute without asking the team)
Next.js 15 (App Router, TypeScript, Tailwind) | face-api.js | @mediapipe/face_mesh
| circomlibjs (client-side Poseidon) | snarkjs (Groth16, WASM, in a Web Worker)
| viem | Solidity 0.8.24 + Foundry | Base Sepolia testnet

## Honesty rule
Never write a comment, README line, or UI string claiming a performance number
that hasn't actually been measured and recorded in benchmarks/RESULTS.md. Use
"target:" for any unmeasured goal. This project is graded partly on honesty
about its own limitations — say what's NOT solved as clearly as what is.

## Working style
Use Planning Mode. Propose a short implementation plan before writing code
for any new feature. After finishing a phase, list what you tested and what
you did NOT test, and wait for review before starting the next phase.
