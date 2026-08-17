# AegisDID — Complete Team Build Plan
### For a 3-person team, short timeline, working prototype for BCOLBD

Read this whole document once before touching a keyboard. It replaces every previous plan. Everyone on the team should read at least their own section (Part 4/5/6) plus Part 0–3.

---

## PART 0 — The one strategic decision that changes everything

The original design (whitepaper + advisor notes) proposed a **native Android app** using Flutter + a Rust-based mobile ZK prover (`mopro`) + Android NDK. That toolchain alone can eat 1–2 full days before you write a single feature, and it only works reliably on Linux/Mac.

**We are replacing it with a web app.** Beneficiary and field-worker both use a phone's Chrome browser. The camera, face embedding, liveness check, and **ZK proof generation all run client-side in the browser** using WebAssembly (`snarkjs`). No server ever sees a face image, an embedding, or a proof witness — the privacy guarantee is identical to the native version. This is a completely legitimate embodiment of "runs on a commodity smartphone" and you will say so explicitly in your paper (see Part 9's "Known Limitations" text).

What this buys you:
- No Flutter, no Android Studio, no NDK, no Rust↔mobile FFI, no `mopro`.
- One codebase (Next.js), not two.
- `snarkjs` proving in a Web Worker in a browser is a solved, well-documented path — Antigravity is very good at this.
- Any teammate can test on any device instantly by opening a URL.

What you lose (say this out loud in your submission — it's a strength, not a weakness, if you own it):
- No hardware-backed key attestation (Android Keystore / StrongBox / Play Integrity) — a rooted **phone's browser** could theoretically be manipulated. State this in your Trust Assumptions table as a "conditional guarantee," exactly like the advisor doc suggested, just re-labelled for the web context.
- No native offline QR-relay between two physical phones. You can still demo offline-first behavior (service worker caches the app, proof generation works with WiFi off, only submission needs a connection) — that's genuinely offline-first and demoable.

We keep everything else that was good in the advisor's crypto redesign: **the ZK circuit does the actual biometric threshold check and Merkle-membership check in-circuit**, not a rubber-stamped boolean. That is the part that makes judges take you seriously, and it costs nothing extra to keep on the web stack.

---

## PART 1 — Final architecture (lock this, do not redesign mid-build)

```
Beneficiary's phone browser (Next.js PWA)
 ├─ Camera capture (getUserMedia)
 ├─ MediaPipe FaceMesh → liveness challenge (blink + head turn)
 ├─ face-api.js → 128-d face embedding (all in-browser, TensorFlow.js/WASM)
 ├─ Quantize embedding to int8, build ZK witness
 ├─ snarkjs (Groth16) proof generation — Web Worker, WASM
 └─ Submit {proof, publicSignals} via wallet (or relayer) to smart contract
        │
        ▼
Base Sepolia testnet
 ├─ Groth16Verifier.sol (auto-generated from the circuit)
 ├─ AegisAid.sol — checks proof against ITS OWN stored policy params,
 │                  rejects reused nullifiers, emits AidClaimed
 └─ DIDRegistry.sol — beneficiary DID ↔ identity commitment binding

Aid-authority dashboard (Next.js, separate route or app)
 ├─ Create/manage policies (cohort Merkle root, threshold, model hash)
 ├─ Enroll beneficiaries → add to Merkle tree → publish new root
 └─ Read-only audit log of AidClaimed events (no identity ever shown)
```

No raw image, no raw embedding, no salt, ever leaves the browser tab. Only Poseidon commitments, ZK proofs, and public policy numbers touch the network.

---

## PART 2 — Accounts & shared setup (all 3 people do this, Day 1 morning)

1. **Node.js 20 LTS** — [nodejs.org](https://nodejs.org) — everyone installs this, no exceptions.
2. **Git** + a **GitHub account** each. Person A creates one **public repo** (`aegisdid`) and adds Person B and C as collaborators.
3. **MetaMask** browser extension, each person creates a wallet — but only Person A's wallet needs real use (as contract deployer/admin). Get **Base Sepolia** testnet ETH from a faucet (search "Base Sepolia faucet", e.g. the Coinbase or Alchemy one) into Person A's wallet.
4. Everyone creates a **personal Gmail account** if they don't already use one for Antigravity sign-in, and installs **Chrome**.
5. **Antigravity IDE** — [antigravity.google/download](https://antigravity.google/download). Each person installs it locally and opens their own clone of the shared repo. Work happens on **separate git branches** (`persona-circuits`, `personb-app`, `personc-docs-dashboard`), merged via pull request at the end of each day. This lets three Antigravity agents work in parallel without stepping on each other.
6. Agree on the daily merge time (e.g. every evening) so nobody's branch drifts too far.

---

## PART 3 — Repo skeleton (Person A creates this on Day 1, everyone `git pull`)

```
aegisdid/
├─ .agents/rules/           ← Antigravity workspace rules (Part 7)
├─ docs/                    ← the 5 spec docs (Part 6)
├─ circuits/                ← Person A
├─ contracts/                ← Person A
├─ web/                      ← Next.js app — beneficiary + field worker (Person B)
│   ├─ app/enroll/
│   ├─ app/claim/
│   ├─ lib/ml/               (face-api.js, mediapipe, quantize, witness)
│   ├─ lib/zk/               (snarkjs worker)
│   └─ lib/chain/            (viem/ethers contract calls)
├─ dashboard/                 ← Next.js aid-authority console (Person C, or a route inside web/)
├─ tools/                    ← Python: quantize.py, pick_threshold.py, dedup-lsh.py (Person C)
├─ benchmarks/                ← results tables + scripts (Person C)
└─ README.md
```

Person A runs, once, to create the skeleton:
```bash
mkdir aegisdid && cd aegisdid
git init
mkdir -p .agents/rules docs circuits contracts web dashboard tools benchmarks
git add -A && git commit -m "skeleton"
git remote add origin <your github repo url>
git push -u origin main
```
Everyone else: `git clone <repo url> && cd aegisdid && git checkout -b <your-branch>`

---

## PART 4 — Person A: Crypto & Chain Lead (circuits + smart contracts)

**This is the technical heart of the submission. Do this first, alone, before any app code exists — the app is useless without a working circuit and a deployed contract to call.**

### 4.1 Install (Ubuntu/WSL2 recommended, see below)

**Try this first on any OS** — circom publishes prebuilt binaries:
- Go to `github.com/iden3/circom/releases`, download the binary for your OS (Windows/.exe, macOS, or Linux), put it on your PATH, run `circom --version`.

**If that doesn't work for your platform**, install WSL2 + Ubuntu:
```powershell
# In Windows PowerShell (as admin), one time:
wsl --install -d Ubuntu-24.04
```
Then inside the Ubuntu terminal:
```bash
# Rust (needed to build circom from source)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential cmake pkg-config libssl-dev git

# circom from source
git clone https://github.com/iden3/circom.git
cd circom && cargo build --release && cargo install --path circom
circom --version   # expect 2.2.x

# snarkjs + circomlib
npm install -g snarkjs
cd ~/aegisdid/circuits && npm init -y && npm i circomlib

# Foundry (contracts)
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

Mac users: `brew install rust node` then follow the same circom/snarkjs/foundry steps (skip apt lines).

### 4.2 The crypto spec — write `docs/CRYPTO_SPEC.md` with EXACTLY this content

This file is the contract between the circuit, the contract, and the app. Copy it verbatim, don't paraphrase it — every teammate's Antigravity agent will read this file and must produce code that agrees with the other two.

```
Field: BN254 scalar field r
Hash: Poseidon (circomlib parameters, x^5 S-box)

Embedding quantization:
  z ∈ R^128, L2-normalized
  q_i = clamp(round(z_i * 127), -127, 127)
  u_i = q_i + 128           ∈ [1, 255]   // field-safe unsigned encoding
  MODEL_HASH = keccak256(model_bytes) mod r

Embedding commitment:
  h_j    = Poseidon16(u_[16j .. 16j+15])   for j = 0..7
  C_emb  = Poseidon9(h_0..h_7, salt)        salt ← 254-bit CSPRNG (browser crypto.getRandomValues)

Identity commitment (Merkle leaf):
  C_id   = Poseidon3(idSecret, C_emb, MODEL_HASH)
  idSecret ← 254-bit CSPRNG, stored in browser IndexedDB, never transmitted

Nullifier:
  nf     = Poseidon3(idSecret, policyId, epoch)

Similarity (fixed point, in-circuit):
  dot    = Σ_{i=0}^{127} (u_live_i - 128) * (u_reg_i - 128)
  range  : dot ∈ [-2097152, 2097152]
  accept : dot + 2^22  >=  tauQ + 2^22
  tauQ   = round(tau_cosine * 127 * 127), stored on-chain per policy

Merkle: binary IMT, depth 20, Poseidon2, zero-leaf = 0
```

### 4.3 Build the circuit — `circuits/aegis_claim.circom`

Create this file exactly as below (this is unchanged from the validated design — it's correct and testable):

```circom
pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/mux1.circom";

template ByteRange(n) {
    signal input in[n];
    component b[n];
    for (var i = 0; i < n; i++) {
        b[i] = Num2Bits(8);
        b[i].in <== in[i];
    }
}

template EmbeddingCommit() {
    signal input u[128];
    signal input salt;
    signal output out;

    component chunk[8];
    for (var j = 0; j < 8; j++) {
        chunk[j] = Poseidon(16);
        for (var k = 0; k < 16; k++) { chunk[j].inputs[k] <== u[16*j + k]; }
    }
    component top = Poseidon(9);
    for (var j = 0; j < 8; j++) { top.inputs[j] <== chunk[j].out; }
    top.inputs[8] <== salt;
    out <== top.out;
}

template MerkleInclusion(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    signal cur[depth + 1];
    cur[0] <== leaf;

    component h[depth];
    component muxL[depth];
    component muxR[depth];

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        muxL[i] = Mux1();
        muxL[i].c[0] <== cur[i];
        muxL[i].c[1] <== pathElements[i];
        muxL[i].s    <== pathIndices[i];

        muxR[i] = Mux1();
        muxR[i].c[0] <== pathElements[i];
        muxR[i].c[1] <== cur[i];
        muxR[i].s    <== pathIndices[i];

        h[i] = Poseidon(2);
        h[i].inputs[0] <== muxL[i].out;
        h[i].inputs[1] <== muxR[i].out;
        cur[i + 1] <== h[i].out;
    }
    root <== cur[depth];
}

template AegisClaim(depth) {
    signal input root;
    signal input policyId;
    signal input epoch;
    signal input tauQ;
    signal input modelHash;
    signal output nullifier;

    signal input uLive[128];
    signal input uReg[128];
    signal input salt;
    signal input idSecret;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    component rL = ByteRange(128); for (var i=0;i<128;i++) { rL.in[i] <== uLive[i]; }
    component rR = ByteRange(128); for (var i=0;i<128;i++) { rR.in[i] <== uReg[i];  }

    component ec = EmbeddingCommit();
    for (var i=0;i<128;i++) { ec.u[i] <== uReg[i]; }
    ec.salt <== salt;

    component cid = Poseidon(3);
    cid.inputs[0] <== idSecret;
    cid.inputs[1] <== ec.out;
    cid.inputs[2] <== modelHash;

    component mk = MerkleInclusion(depth);
    mk.leaf <== cid.out;
    for (var i=0;i<depth;i++) {
        mk.pathElements[i] <== pathElements[i];
        mk.pathIndices[i]  <== pathIndices[i];
    }
    root === mk.root;

    signal prods[128];
    signal acc[129];
    acc[0] <== 0;
    for (var i=0;i<128;i++) {
        prods[i] <== (uLive[i] - 128) * (uReg[i] - 128);
        acc[i+1] <== acc[i] + prods[i];
    }
    component ge = GreaterEqThan(24);
    ge.in[0] <== acc[128] + 2097152;
    ge.in[1] <== tauQ     + 2097152;
    ge.out === 1;

    component nf = Poseidon(3);
    nf.inputs[0] <== idSecret;
    nf.inputs[1] <== policyId;
    nf.inputs[2] <== epoch;
    nullifier <== nf.out;
}

component main { public [ root, policyId, epoch, tauQ, modelHash ] } = AegisClaim(20);
```

(Note: dropped `attestationHash` from the original advisor design since there's no hardware attestation in the web version — cleaner and matches what we're actually building. Six public signals become five: `[nullifier(output), root, policyId, epoch, tauQ, modelHash]`.)

### 4.4 Compile, set up keys, test — run these commands in order

```bash
cd circuits
circom aegis_claim.circom --r1cs --wasm --sym -o build -l node_modules
snarkjs r1cs info build/aegis_claim.r1cs        # WRITE DOWN the constraint count for your paper

snarkjs powersoftau new bn128 16 pot16_0000.ptau -v
snarkjs powersoftau contribute pot16_0000.ptau pot16_0001.ptau -v --name="aegis contribution"
snarkjs powersoftau prepare phase2 pot16_0001.ptau pot16_final.ptau -v

snarkjs groth16 setup build/aegis_claim.r1cs pot16_final.ptau aegis_0000.zkey
snarkjs zkey contribute aegis_0000.zkey aegis_final.zkey -v --name="aegis contribution"
snarkjs zkey export verificationkey aegis_final.zkey vkey.json
snarkjs zkey export solidityverifier aegis_final.zkey ../contracts/src/Groth16Verifier.sol
```

Then **copy these three files into the web app** — Person B's code needs them:
```bash
mkdir -p ../web/public/zk
cp build/aegis_claim_js/aegis_claim.wasm ../web/public/zk/
cp aegis_final.zkey ../web/public/zk/
cp vkey.json ../web/public/zk/
```

Write a quick Node test script `circuits/test.js` that builds a **known-good witness** (matching values, similarity above threshold, correct Merkle path) and a **known-bad witness** (similarity below threshold) and confirms the first proves+verifies and the second fails to satisfy constraints. Run it, screenshot the output — this is your evidence for the demo.

### 4.5 Smart contracts — `contracts/src/AegisAid.sol`

The single most important line of code in this whole project is the requirement that the contract reads its policy parameters from **its own storage**, not from the caller. If you get this wrong, your ZK check is decorative. Use this exact contract:

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

interface IGroth16Verifier {
    function verifyProof(
        uint[2] calldata a, uint[2][2] calldata b, uint[2] calldata c,
        uint[5] calldata input   // [nullifier, root, policyId, epoch, tauQ, modelHash] minus nullifier as output -> actually snarkjs orders public signals as [output..., public inputs...] check exported Verifier.sol for exact order and match it here
    ) external view returns (bool);
}

contract AegisAid {
    struct Policy {
        bytes32 cohortRoot;
        uint256 tauQ;
        bytes32 modelHash;
        uint64  epoch;
        uint128 allocation;
        uint128 remaining;
        bool    active;
    }

    IGroth16Verifier public immutable verifier;
    address public admin;
    mapping(address => bool) public isIssuer;
    mapping(uint256 => Policy) public policies;
    mapping(uint256 => mapping(uint256 => bool)) public nullifierUsed;

    event PolicyCreated(uint256 indexed policyId, bytes32 cohortRoot, uint256 tauQ);
    event CohortRootUpdated(uint256 indexed policyId, bytes32 oldRoot, bytes32 newRoot);
    event AidClaimed(uint256 indexed policyId, uint256 nullifier, uint128 amount);

    error NotAuthorized();
    error PolicyInactive();
    error NullifierAlreadyUsed();
    error InvalidProof();
    error AllocationExhausted();

    modifier onlyAdmin()  { if (msg.sender != admin)   revert NotAuthorized(); _; }
    modifier onlyIssuer() { if (!isIssuer[msg.sender]) revert NotAuthorized(); _; }

    constructor(IGroth16Verifier _v) {
        verifier = _v; admin = msg.sender; isIssuer[msg.sender] = true;
    }

    function createPolicy(
        uint256 policyId, bytes32 cohortRoot, uint256 tauQ, bytes32 modelHash,
        uint64 epoch, uint128 allocation, uint128 totalUnits
    ) external onlyIssuer {
        require(!policies[policyId].active, "exists");
        policies[policyId] = Policy(cohortRoot, tauQ, modelHash, epoch, allocation, totalUnits, true);
        emit PolicyCreated(policyId, cohortRoot, tauQ);
    }

    function updateCohortRoot(uint256 policyId, bytes32 newRoot) external onlyIssuer {
        bytes32 old = policies[policyId].cohortRoot;
        policies[policyId].cohortRoot = newRoot;
        emit CohortRootUpdated(policyId, old, newRoot);
    }

    // input array ordering MUST exactly match what snarkjs exported in Groth16Verifier.sol — copy it from there
    function claimAid(
        uint256 policyId,
        uint[2] calldata a, uint[2][2] calldata b, uint[2] calldata c,
        uint[6] calldata input   // adjust length to match verifier's expected public signal count
    ) external {
        Policy storage p = policies[policyId];
        if (!p.active) revert PolicyInactive();
        if (p.remaining < p.allocation) revert AllocationExhausted();

        require(input[1] == uint256(p.cohortRoot), "root mismatch");
        require(input[2] == policyId,               "policy mismatch");
        require(input[3] == uint256(p.epoch),        "epoch mismatch");
        require(input[4] == p.tauQ,                  "tau mismatch");
        require(input[5] == uint256(p.modelHash),    "model mismatch");

        uint256 nf = input[0];
        if (nullifierUsed[policyId][nf]) revert NullifierAlreadyUsed();

        // cast input array to the shape verifyProof expects — align with generated verifier
        if (!verifier.verifyProof(a, b, c, [input[1], input[2], input[3], input[4], input[5]]))
            revert InvalidProof();

        nullifierUsed[policyId][nf] = true;
        p.remaining -= p.allocation;
        emit AidClaimed(policyId, nf, p.allocation);
    }
}
```

**Important note for Antigravity to fix precisely:** snarkjs' exported `Groth16Verifier.sol` has a specific, fixed public-signal ordering and array size that depends on exactly how many public signals your circuit declares. Don't hand-guess it — after Section 4.4 exports `Groth16Verifier.sol`, open it, read its exact `verifyProof` signature, and make `AegisAid.sol` match that signature exactly. Tell Antigravity to do this alignment as an explicit step and to write a test that calls `claimAid` successfully before moving on.

### 4.6 Foundry tests + deploy

Ask Antigravity (Part 8, Prompt A) to write Foundry tests proving these all fail correctly: nullifier replay, caller trying to pass a lower `tauQ` than policy (should be impossible since it's read from storage, but test it), stale cohort root, wrong `modelHash`, wrong `epoch`, non-issuer creating a policy, claiming against an exhausted allocation. Then deploy to Base Sepolia and record the contract address + a block-explorer link — you'll need this on stage.

### 4.7 Also produce (Person A, quick items)
- `docs/DID_SPEC.md`: state you use **did:key with Ed25519**, generated client-side, no chain write needed at enrollment. The enrolling authority issues a compact **W3C Verifiable Credential 2.0** JWS containing `credentialSubject.idCommitment`, `policyCohort`, `modelHash`, `enrollmentEpoch`, `issuer` — no biometric, no name. State plainly the VC is for portability; the ZK proof, not the VC, is the authorization.
- Fix your paper's citation errors now (5 minutes, big credibility payoff): reference used for "W3C Verifiable Credentials" should point to the actual **W3C VC Data Model 2.0 Recommendation**, not NIST SP 800-57. The CASIA anti-spoofing citation should point to the actual ICB 2012 paper, not a ResearchGate "Request PDF" stub.

---

## PART 5 — Person B: App & On-device AI Lead (Next.js beneficiary app)

You build the thing judges will actually touch. Nothing here needs Ubuntu — Windows/Mac + Node is fine.

### 5.1 Install
```bash
node -v   # confirm 20+
npx create-next-app@latest web --typescript --tailwind --app
cd web
npm i face-api.js @mediapipe/face_mesh @mediapipe/camera_utils snarkjs viem
```

### 5.2 What you're building, in order

**1. Enrollment flow (`app/enroll/page.tsx`)**
- Camera capture via `getUserMedia`.
- Run `face-api.js` (TinyFaceDetector + FaceRecognitionNet models — download the pretrained weights from the `face-api.js` model repo, put them in `public/models/`) to get a 128-d embedding.
- Quantize the embedding per `docs/CRYPTO_SPEC.md` exactly (`q_i = clamp(round(z_i*127), -127, 127); u_i = q_i + 128`).
- Generate a 254-bit `idSecret` and a `salt` via `crypto.getRandomValues`, store them in browser **IndexedDB** — never send them anywhere.
- Compute `Poseidon` commitments **client-side** using `circomlibjs` (`npm i circomlibjs`) to get `C_emb` and `C_id`.
- Send only `C_id` (not the embedding, not the secret) to the aid-authority dashboard/API so it can be added to the enrollment Merkle tree.
- Show the beneficiary their `did:key` and a clear plain-language warning: "if you lose this device and haven't backed up your recovery phrase, you lose this identity" — state this honestly in the UI, it's a real limitation.

**2. Liveness challenge (`lib/ml/liveness.ts`)**
- Use `@mediapipe/face_mesh` to track face landmarks in real time.
- Challenge: prompt the user to **blink** (detect via eye-aspect-ratio dropping and recovering) **and** **turn their head** (detect via landmark x-displacement) within a ~5 second window.
- Output a `livenessScore` (0–100) — for the MVP this can simply be "challenge completed correctly" → 100, else 0. Be honest in `docs/MODEL_CARD.md` that this is a software-only liveness check without hardware attestation.

**3. Claim flow (`app/claim/page.tsx`)**
- Select an active policy (fetched from chain via `viem`).
- Camera capture → liveness challenge → embedding → quantize.
- Fetch the beneficiary's own **Merkle path** for their `idCommitment` from the dashboard's API (the dashboard, built by Person C, maintains the tree and can return a path for a given commitment).
- Assemble the full witness object matching the circuit's inputs exactly: `root, policyId, epoch, tauQ, modelHash, uLive, uReg, salt, idSecret, pathElements, pathIndices`.
- Run `snarkjs.groth16.fullProve(witness, "/zk/aegis_claim.wasm", "/zk/aegis_final.zkey")` **inside a Web Worker** (so the UI thread doesn't freeze) — show a progress spinner, this can take a few seconds on a phone.
- Submit `{proof, publicSignals}` to `AegisAid.claimAid(...)` via `viem` + the user's MetaMask (mobile MetaMask app or WalletConnect for phone browser testing).
- Show the on-chain confirmation with a block-explorer link.

**4. A "Diagnostics" screen** — model hash, circuit constraint count, measured proving time on this device, last claim status. This exists purely to make your demo look credible; keep it visible during judging.

### 5.3 Hard rule for you specifically
Nothing in `lib/ml/` may import anything that makes a network request. If you (or Antigravity) ever add a `fetch()` call inside a file that also touches a camera frame or an embedding array, that's a bug — stop and refactor. This is the core privacy claim of the whole project; guard it like your grade depends on it, because it does.

---

## PART 6 — Person C: Data, Docs & Dashboard Lead

You do three things: get real numbers into the project (not guesses), write the documents that make judges trust you, and build the admin side.

### 6.1 Install
```bash
python3 -m venv venv && source venv/bin/activate   # or venv\Scripts\activate on Windows
pip install tensorflow numpy scikit-learn pillow
node -v   # for the dashboard, same Next.js stack as Person B
```

### 6.2 Get real numbers (do this before writing any doc that cites a number)

You will NOT train a face model from scratch — use a pretrained one and just **measure** it.

`tools/pick_threshold.py`:
```python
import numpy as np
from sklearn.metrics import roc_curve

sim   = np.load("sims.npy")      # cosine similarities over a public face-verification pair dataset
label = np.load("labels.npy")    # 1 = same identity, 0 = different
fpr, tpr, thr = roc_curve(label, sim)
for target in (1e-3, 1e-4):
    i = np.argmin(np.abs(fpr - target))
    tau = thr[i]
    print(f"FAR={target:g}  tau={tau:.4f}  TAR={tpr[i]:.4f}  tauQ={round(tau*127*127)}")
```
Run this against a small public benchmark (e.g. a subset of LFW pairs run through `face-api.js`'s recognition model in a quick Node/Python script) to get a **real** `tau` and its false-accept rate. Report FAR at your chosen operating point — this single number, backed by a curve, is worth more to judges than any amount of UI polish. Put `tauQ` into the policy you create on-chain.

### 6.3 Write the docs (all go in `docs/`)

- **`docs/THREAT_MODEL.md`** — take the threat table from the whitepaper's §6.1, and for each threat add: concrete mechanism that stops it, residual risk, whether the mitigation is cryptographic or procedural. Add this **Trust Assumptions table** (this is the single highest-value paragraph in your whole submission — judges reward honesty about limits far more than confident overclaiming):

| Guarantee | Strength | Depends on |
|---|---|---|
| No double-claim per allocation | Unconditional (cryptographic) | Nullifier uniqueness on-chain |
| Biometric threshold actually met | Unconditional | In-circuit fixed-point cosine check vs on-chain τ |
| Cohort membership genuine | Unconditional | Merkle inclusion proof in-circuit |
| Embedding came from a live human, right now | **Conditional** | Software liveness challenge only — no hardware attestation in this web prototype |
| Enrolled cohort contains no duplicate people | **Conditional** | No cryptographic dedup implemented; see enrollment dedup note below |

  Also explicitly add three threats: a compromised/rooted browser forging the live embedding (no hardware attestation in this prototype — stated limitation); coercive enrollment by an aid worker (cite your own whitepaper reference [5] about the Cox's Bazar case — say the system should make *refusing* enrollment survivable, and note how: no central biometric store means a refusal doesn't create a permanent record of the refusal either); and cross-policy linkage via timing correlation on the relayer/submission side.

- **Enrollment-time Sybil resistance — pick a position, don't dodge it.** Given your timeline, implement the lightest honest option: a **coarse locality-sensitive hash (LSH) bucket check** at enrollment. `tools/dedup-lsh.py` buckets each new enrollment's embedding into a coarse hash bucket and flags the dashboard admin if a bucket already has an entry (near-duplicate warning, not an automatic block). Document plainly: this leaks coarse similarity information and is a **procedural, not cryptographic**, safeguard — name the tradeoff instead of hiding it.

- **`docs/MODEL_CARD.md`** — which pretrained model, its license, the quantization method, and your real measured FAR/TAR at the chosen τ. Leave nothing as a placeholder by submission day.

- **`docs/ETHICS_DPIA.md`** — two pages. State plainly that no real beneficiary data is collected in this prototype. Map the design to ICRC's *Handbook on Data Protection in Humanitarian Action* principles (purpose limitation, data minimization, do-no-harm) and to UNHCR's data protection policy. Write a short consent script in Bangla and English for a hypothetical future volunteer pilot. Almost no competing team will have this document — it's a direct answer to the exact harm (Rohingya biometric data sharing) your own whitepaper opens with.

- **`docs/EVAL_PLAN.md` + `benchmarks/RESULTS.md`** — tables (fill with real measured numbers as they come in from A and B): circuit constraint count, proving time (median + worst of ~20 runs on an actual phone, not a laptop), on-chain gas per `claimAid` call, FAR/TAR at τ. Use the real ISO/IEC 30107-3 terms (APCER/BPCER) if you have time to run a basic spoof test with a printed photo vs the liveness check — naming the standard signals seriousness even with a small sample.

### 6.4 Build the dashboard (`dashboard/` or a route inside `web/`)
- Wallet-gated admin page (only the deployer address, or addresses you add as `isIssuer`, can access it).
- Create/deactivate policies (calls `AegisAid.createPolicy`).
- Maintain the enrollment Merkle tree: receive new `C_id` values from the enroll flow, rebuild the tree (a simple JS incremental Merkle tree library is fine), publish the new root via `updateCohortRoot`, and expose an API endpoint that returns a Merkle path for a given `C_id` (Person B's claim flow calls this).
- Live table of `AidClaimed` events read from chain via `viem` — policy ID, nullifier, timestamp only. No identity data, ever, by construction.
- The near-duplicate warning banner from the LSH check above.

---

## PART 7 — Antigravity workspace rules (create this file once, everyone's agent reads it)

Save as `.agents/rules/00-project.md`, mark it **Always On** in Antigravity's rules settings:

```markdown
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
```

---

## PART 8 — The three Antigravity prompts (one per person, paste after opening your branch)

### Prompt A — for Person A (circuits + contracts)
```
/grill-me

You are building the cryptographic core of AegisDID, a privacy-preserving
humanitarian aid identity system for a hackathon (BCOLBD, AI category).
Read docs/CRYPTO_SPEC.md fully before doing anything — it is the source of
truth for every hash, commitment, and encoding. Also read .agents/rules/00-project.md.

I already have circuits/aegis_claim.circom written and compiling (paste it in
if not already in the repo). Your job, in this order, stopping for my review
after each step:

1. Run the full compile → powers-of-tau → groth16 setup → export verifier
   pipeline. Report the exact R1CS constraint count.
2. Write circuits/test.js: build one KNOWN-GOOD witness (matching commitments,
   similarity above threshold, valid Merkle path) and one KNOWN-BAD witness
   (similarity below threshold). Prove the first succeeds and verifies, and
   confirm the second FAILS to satisfy the circuit constraints. Show me both
   results before continuing.
3. Copy the compiled .wasm, .zkey, and vkey.json into web/public/zk/.
4. Set up a Foundry project in contracts/. Open the exported Groth16Verifier.sol
   and tell me its EXACT verifyProof function signature (argument types and
   the length/order of the public-signals array) before writing AegisAid.sol —
   do not guess this, read the generated file.
5. Implement AegisAid.sol matching that exact signature: issuer-managed
   policies (cohortRoot, tauQ, modelHash, epoch, allocation, remaining,
   active), per-policy nullifier mapping, custom errors, full NatSpec, an
   event for every state change. The contract MUST compare the proof's public
   signals against values read from ITS OWN storage — never trust a
   caller-supplied root or threshold. Treat any deviation from this as a
   critical bug.
6. Write Foundry tests that PROVE these attacks fail: nullifier replay; a
   proof built against a stale cohort root; a proof with mismatched
   modelHash; a proof with wrong epoch; a non-issuer trying to create a
   policy; claiming against an exhausted allocation. Target high coverage,
   show me the coverage report.
7. Write a Base Sepolia deploy script reading RPC/key from .env (never commit
   the .env file). Deploy, give me the contract address and a block-explorer
   link, and print the gas cost of one claimAid call.

Stop after each numbered step and wait for my go-ahead.
```

### Prompt B — for Person B (Next.js app)
```
/grill-me

You are building the beneficiary-facing web app for AegisDID. Read
docs/CRYPTO_SPEC.md and .agents/rules/00-project.md fully before writing
anything — the encodings in CRYPTO_SPEC.md are non-negotiable and must match
exactly what Person A's circuit expects.

Stack: Next.js 15 App Router + TypeScript + Tailwind, face-api.js for face
detection/embedding, @mediapipe/face_mesh for liveness, circomlibjs for
client-side Poseidon hashing, snarkjs for proof generation in a Web Worker,
viem for contract calls.

Absolute constraint: nothing in lib/ml/ may import networking code. Raw
images, embeddings, salt, and idSecret must never appear in any fetch/axios/
contract call argument. Flag this explicitly in code review comments.

Build in this order, stop after each phase for my review:

Phase 1 — Enrollment flow (app/enroll/page.tsx): camera capture, face
detection + embedding via face-api.js, quantize per CRYPTO_SPEC.md exactly
(q_i = clamp(round(z_i*127), -127, 127); u_i = q_i + 128), generate idSecret
and salt via crypto.getRandomValues, store them in IndexedDB, compute C_emb
and C_id via circomlibjs Poseidon exactly matching the spec's chunking
(Poseidon16 over 8 chunks of 16, then Poseidon9 over the 8 chunk hashes plus
salt), send ONLY C_id to a placeholder API route for the dashboard to
consume. Show the generated did:key and a plain-language warning about device
loss.

Phase 2 — Liveness (lib/ml/liveness.ts): MediaPipe FaceMesh, require a blink
(eye-aspect-ratio dip and recovery) AND a head turn (landmark x-displacement)
within roughly 5 seconds, output a 0-100 liveness score.

Phase 3 — Claim flow (app/claim/page.tsx): policy selector reading active
policies from chain via viem, camera + liveness challenge, embedding +
quantization, fetch this beneficiary's Merkle path from a dashboard API
endpoint (stub it if the dashboard isn't ready yet, I'll wire it up),
assemble the full witness object exactly matching the circuit's public/private
inputs, run snarkjs.groth16.fullProve in a Web Worker with a progress
indicator, submit the proof to AegisAid.claimAid via viem + MetaMask, show
on-chain confirmation with a block-explorer link.

Phase 4 — Diagnostics page: model hash, circuit constraint count, measured
proving time on this device (actually measure it, don't estimate it), last
claim status.

Never invent a fallback that quietly bypasses proving — if snarkjs fails,
show a clear error, don't fake success.
```

### Prompt C — for Person C (dashboard + tooling)
```
/grill-me

You are building the aid-authority dashboard and data tooling for AegisDID.
Read docs/CRYPTO_SPEC.md and .agents/rules/00-project.md first.

Stack: Next.js 15 (can share the web/ app as a separate route group, or a
standalone app in dashboard/ — ask me which), viem for contract calls,
Python (tools/) for model evaluation scripts.

Build in this order, stop after each phase for review:

Phase 1 — tools/pick_threshold.py: given cosine-similarity and label arrays
from a public face-verification pair dataset, compute an ROC curve and print
tau, tauQ (round(tau*127*127)), FAR, and TAR at FAR targets of 1e-3 and 1e-4.
I will supply the sims.npy/labels.npy files or tell you how to generate them.

Phase 2 — tools/dedup-lsh.py: a simple locality-sensitive-hash bucketing
function over quantized embeddings that flags near-duplicate enrollments for
admin review. This is a procedural safeguard, not a cryptographic guarantee —
say so in the code comments.

Phase 3 — Dashboard: wallet-gated admin page (only addresses marked isIssuer
on-chain can access). Create/deactivate policies UI calling
AegisAid.createPolicy. An incremental Merkle tree service that accepts new
C_id values (POST endpoint), rebuilds the tree, calls updateCohortRoot on
chain, and exposes a GET endpoint returning a Merkle path for a given C_id
(Person B's claim flow will call this). A live read-only table of AidClaimed
events from chain via viem — policy ID, nullifier, timestamp ONLY, never any
identity data, enforce this by construction (don't even fetch beneficiary
info in this view).

Phase 4 — benchmarks/RESULTS.md with tables for: circuit constraint count,
proving time distribution, claimAid gas cost, FAR/TAR at tau. Leave numbers
blank with clear placeholders until Person A/B supply real measurements —
never fill in a guessed number.

Ask me before deciding dashboard-as-separate-app vs dashboard-as-route.
```

---

## PART 9 — Integration checklist (once all 3 branches exist)

1. Merge Person A's branch first (circuits + contracts) — nothing else works without a deployed contract address.
2. Update `web/.env.local` and `dashboard/.env.local` with the deployed `AegisAid` address and RPC URL.
3. Merge Person C's branch (dashboard needs the contract address to create policies).
4. Person C creates one real test policy on-chain with a real `tauQ` from `pick_threshold.py`.
5. Merge Person B's branch (app needs an active policy to test the claim flow against).
6. Full run-through, together, on one real phone: enroll → dashboard shows the new commitment → admin publishes updated Merkle root → claim → proof generates → transaction confirms → dashboard's audit table shows the new `AidClaimed` event.
7. **Then, live, try to break it**: submit the same claim twice (second one should revert with `NullifierAlreadyUsed`), hold a printed photo up to the camera during a claim (liveness challenge should fail to complete).

---

## PART 10 — Demo script (what to actually show judges)

1. **Enroll a beneficiary on stage** — show the DID, show the plain-language device-loss warning.
2. **Make a valid claim** — show the proving progress bar, show the on-chain confirmation, click through to the block explorer.
3. **Try to claim again with the same identity, same policy, live, on stage.** Let it revert with `NullifierAlreadyUsed`. This five-second moment is worth more than twenty slides.
4. **Hold up a printed photo of your own face** during a claim attempt — show the liveness challenge failing to pass.
5. **Show the Foundry test suite passing**, specifically the attack tests (root mismatch, tau mismatch, replay) — a terminal full of green checkmarks that says "attack X: reverted as expected" is very persuasive to a technical judge.
6. **End on the numbers table** — constraint count, proving time (median/worst of ~20 runs on your actual demo phone), gas per claim, measured FAR at your chosen τ.
7. **Final slide: "What we did not solve."** List: hardware-backed attestation (native app only), full in-circuit proving of the neural network itself, Groth16's trusted setup (mention you'd move to a ceremony with published transcripts, or to PLONK, for production), cryptographic (vs. procedural) enrollment deduplication, and cross-population fairness validation. Volunteering this before judges find it converts a weakness into evidence you understand your own system — and it keeps your live demo consistent with what your paper already, admirably, says.

---

## PART 11 — Text to paste into the whitepaper (Known Limitations addition)

> This prototype implements verification and proof generation in a browser-based Progressive Web App rather than a native mobile application. This preserves the paper's core privacy guarantee — no biometric evidence leaves the beneficiary's device — while trading off hardware-backed key attestation (e.g., Android StrongBox / Play Integrity), which a production deployment would add as a further defense against a compromised device forging a live capture. The ZK circuit performs the fixed-point cosine-similarity threshold check and Merkle cohort-membership check in-circuit, rather than committing to an externally computed boolean, closing the "garbage-in, garbage-out" gap present in naive commit-and-prove designs. Enrollment-time Sybil resistance is addressed procedurally, via coarse locality-sensitive-hash duplicate flagging for administrator review, rather than cryptographically; we state plainly that this is the one place in the design where privacy and deduplication genuinely trade off against each other.

---

That's the whole plan. If everyone starts at Part 2, works their own Part (4, 5, or 6) with their own Antigravity prompt from Part 8, and you integrate on schedule from Part 9, you'll have a working, live, on-chain, break-it-on-stage demo — which is exactly what wins this category.
