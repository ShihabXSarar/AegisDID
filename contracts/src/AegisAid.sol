// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

interface IGroth16Verifier {
    function verifyProof(
        uint[2] calldata _pA,
        uint[2][2] calldata _pB,
        uint[2] calldata _pC,
        uint[6] calldata _pubSignals
    ) external view returns (bool);
}

contract AegisAid {
    /**
     * Bounds on a policy's quantized biometric threshold.
     *
     * The circuit's acceptance test is
     *   GreaterEqThan(24)(dot + 2**21, tauQ + 2**21) === 1
     * over the BN254 scalar field, where
     *   dot = SUM_{i<128} (uLive_i - 128) * (uReg_i - 128),  dot in [-2064512, 2064512].
     *
     * That comparator is only sound for tauQ inside the 24-bit window it was sized for. A tauQ
     * expressed as a large field residue -- e.g. r - 1, which is "-1" in the field -- makes the
     * range check wrap and the comparator returns 1 unconditionally. MEASURED, not theorised:
     * web/scripts/tauq_bound_probe.mts produces a VALID Groth16 proof for a non-matching face
     * (cosine 0.0889) at tauQ = r - 1 and at tauQ = r - 1000000. The threshold check is bypassed
     * entirely and the proof verifies on-chain.
     *
     * The circuit cannot defend itself: tauQ is a public input, so whatever the issuer publishes
     * is what the comparator gets. The contract is therefore the enforcement point.
     *
     * MAX_TAU_Q = 127 * 127 = 16129 is the top of the cosine scale: tauQ = cosineToTauQ(1.0). It is
     * NOT the largest attainable dot -- integer rounding in q_i = round(127 * z_i) means a genuine
     * self-match lands anywhere near 16129 rather than exactly on it (measured over 20,000 random
     * unit vectors: 15852 to 16447). So a policy at tauQ = 16129 is sound but already too strict to
     * be usable, and anything above it is further into the same territory while adding no security.
     * Capping here keeps tauQ far inside the 24-bit comparator window, which is the property that
     * matters.
     *
     * MIN_TAU_Q = 1 because tauQ = 0 accepts any dot >= 0, which is roughly half of all random
     * face pairs -- a policy with no biometric check at all. Live Base Sepolia policies 101/102
     * sit at tauQ = 0 and policy 103 at tauQ = 1 precisely because the deployed bytecode has no
     * such bound.
     *
     * NOTE: this enforces SOUNDNESS, not adequacy. Choosing a tauQ inside these bounds that
     * yields an acceptably low false-accept rate requires measured FAR/TAR data, which this
     * project has NOT yet produced (see docs/RESULTS.md). The contract cannot substitute for that
     * measurement, and this bound must not be read as an endorsement of any particular threshold.
     */
    uint256 public constant MIN_TAU_Q = 1;
    uint256 public constant MAX_TAU_Q = 127 * 127;

    struct Policy {
        bytes32 cohortRoot;
        uint256 tauQ;
        bytes32 modelHash;
        uint64 epoch;
        uint128 allocation;
        uint128 remaining;
        bool active;
    }

    IGroth16Verifier public immutable verifier;
    address public admin;

    mapping(address => bool) public isIssuer;
    mapping(uint256 => Policy) public policies;
    mapping(uint256 => mapping(uint256 => bool)) public nullifierUsed;

    /**
     * Tracks whether createPolicy has ever run for an ID.
     *
     * Deliberately a separate mapping rather than a `Policy` struct field: the
     * auto-generated `policies(uint256)` getter keeps its exact 7-value return
     * shape, so web/lib/chain/client.ts decodes against both this source and
     * the already-deployed Base Sepolia bytecode without a branch.
     *
     * It is NOT the same as `Policy.active`. A policy that was created and then
     * deactivated still exists: it must remain root-updatable and reactivatable,
     * but must never be silently re-created over.
     */
    mapping(uint256 => bool) public policyExists;

    event PolicyCreated(
        uint256 indexed policyId,
        bytes32 cohortRoot,
        uint256 tauQ,
        bytes32 modelHash,
        uint64 epoch,
        uint128 allocation,
        uint128 totalUnits
    );

    event CohortRootUpdated(
        uint256 indexed policyId,
        bytes32 oldRoot,
        bytes32 newRoot
    );

    event IssuerUpdated(
        address indexed issuer,
        bool allowed
    );

    event AdminUpdated(
        address indexed oldAdmin,
        address indexed newAdmin
    );

    event PolicyStatusUpdated(
        uint256 indexed policyId,
        bool active
    );

    event AidClaimed(
        uint256 indexed policyId,
        uint256 indexed nullifier,
        uint128 amount
    );

    error NotAuthorized();
    error PolicyInactive();
    error PolicyAlreadyExists();
    error PolicyDoesNotExist();
    error InvalidPolicyParameters();
    error InvalidTauQ();
    error NullifierAlreadyUsed();
    error InvalidProof();
    error AllocationExhausted();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAuthorized();
        _;
    }

    modifier onlyIssuer() {
        if (!isIssuer[msg.sender]) revert NotAuthorized();
        _;
    }

    constructor(IGroth16Verifier _verifier) {
        verifier = _verifier;
        admin = msg.sender;
        isIssuer[msg.sender] = true;

        emit IssuerUpdated(msg.sender, true);
    }

    function setIssuer(address issuer, bool allowed) external onlyAdmin {
        isIssuer[issuer] = allowed;
        emit IssuerUpdated(issuer, allowed);
    }

    /**
     * Rotate the admin key. Without this, an admin key that is suspected of
     * being exposed can only be retired by redeploying the whole contract and
     * re-creating every policy.
     *
     * address(0) is refused: it would permanently brick setIssuer, setAdmin and
     * every other onlyAdmin path, since no caller can ever be address(0).
     */
    function setAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert InvalidPolicyParameters();

        address oldAdmin = admin;
        admin = newAdmin;

        emit AdminUpdated(oldAdmin, newAdmin);
    }

    function createPolicy(
        uint256 policyId,
        bytes32 cohortRoot,
        uint256 tauQ,
        bytes32 modelHash,
        uint64 epoch,
        uint128 allocation,
        uint128 totalUnits
    ) external onlyIssuer {
        // Guarded on existence, not on `.active`. Guarding on `.active` let a
        // deactivated policy be silently re-created, overwriting cohortRoot,
        // tauQ, modelHash, epoch, allocation and remaining, and re-emitting
        // PolicyCreated for an ID that already had claim history. The nullifier
        // set is keyed by policyId and is NOT cleared by an overwrite, so the
        // rewritten policy would inherit spent nullifiers from its old life.
        if (policyExists[policyId]) revert PolicyAlreadyExists();

        // allocation == 0 produces a policy where every claim burns a nullifier
        // permanently while transferring nothing, locking the beneficiary out of
        // this policy/epoch forever. totalUnits < allocation produces a policy
        // whose very first claim reverts AllocationExhausted. Both look healthy
        // on-chain and fail only at the beneficiary.
        if (allocation == 0) revert InvalidPolicyParameters();
        if (totalUnits < allocation) revert InvalidPolicyParameters();

        // Soundness bound, not a tuning preference. See MIN_TAU_Q / MAX_TAU_Q above: an
        // out-of-range tauQ makes the in-circuit comparator wrap and accept ANY face.
        if (tauQ < MIN_TAU_Q || tauQ > MAX_TAU_Q) revert InvalidTauQ();

        policyExists[policyId] = true;

        policies[policyId] = Policy({
            cohortRoot: cohortRoot,
            tauQ: tauQ,
            modelHash: modelHash,
            epoch: epoch,
            allocation: allocation,
            remaining: totalUnits,
            active: true
        });

        emit PolicyCreated(
            policyId,
            cohortRoot,
            tauQ,
            modelHash,
            epoch,
            allocation,
            totalUnits
        );
    }

    function updateCohortRoot(
        uint256 policyId,
        bytes32 newRoot
    ) external onlyIssuer {
        // Without this check, `policies[policyId]` auto-vivifies and a root is
        // written into a policy that was never created. Live Base Sepolia
        // policies 101 and 102 are in exactly that state: non-zero cohortRoot,
        // no PolicyCreated event, tauQ 0 and modelHash 0. Any indexer that reads
        // storage instead of events sees them as configured.
        if (!policyExists[policyId]) revert PolicyDoesNotExist();

        Policy storage p = policies[policyId];

        bytes32 oldRoot = p.cohortRoot;
        p.cohortRoot = newRoot;

        emit CohortRootUpdated(policyId, oldRoot, newRoot);
    }

    function setPolicyActive(
        uint256 policyId,
        bool active
    ) external onlyIssuer {
        // Unguarded, this activates a never-created policy with tauQ == 0 --
        // and tauQ == 0 accepts ANY face, because the circuit's acceptance test
        // is `dot >= tauQ` and `dot` is non-negative for a self-match.
        if (!policyExists[policyId]) revert PolicyDoesNotExist();

        policies[policyId].active = active;
        emit PolicyStatusUpdated(policyId, active);
    }

    function claimAid(
        uint256 policyId,
        uint[2] calldata a,
        uint[2][2] calldata b,
        uint[2] calldata c,
        uint[6] calldata input
    ) external {
        Policy storage p = policies[policyId];

        if (!p.active) revert PolicyInactive();
        if (p.remaining < p.allocation) revert AllocationExhausted();

        // Defence in depth. createPolicy already bounds tauQ, so this is unreachable through the
        // current code paths -- but it guards the path where value actually moves, so an
        // out-of-range threshold can never be exploited even if some future function writes
        // p.tauQ without re-validating. Costs two comparisons.
        if (p.tauQ < MIN_TAU_Q || p.tauQ > MAX_TAU_Q) revert InvalidTauQ();

        // Public signal ordering confirmed from aegis_claim.sym:
        // input[0] = nullifier
        // input[1] = root
        // input[2] = policyId
        // input[3] = epoch
        // input[4] = tauQ
        // input[5] = modelHash

        if (input[1] != uint256(p.cohortRoot)) {
            revert InvalidProof();
        }

        if (input[2] != policyId) {
            revert InvalidProof();
        }

        if (input[3] != uint256(p.epoch)) {
            revert InvalidProof();
        }

        if (input[4] != p.tauQ) {
            revert InvalidProof();
        }

        if (input[5] != uint256(p.modelHash)) {
            revert InvalidProof();
        }

        uint256 nf = input[0];

        if (nullifierUsed[policyId][nf]) {
            revert NullifierAlreadyUsed();
        }

        if (!verifier.verifyProof(a, b, c, input)) {
            revert InvalidProof();
        }

        nullifierUsed[policyId][nf] = true;

        p.remaining -= p.allocation;

        emit AidClaimed(policyId, nf, p.allocation);
    }
}
