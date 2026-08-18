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

    function createPolicy(
        uint256 policyId,
        bytes32 cohortRoot,
        uint256 tauQ,
        bytes32 modelHash,
        uint64 epoch,
        uint128 allocation,
        uint128 totalUnits
    ) external onlyIssuer {
        if (policies[policyId].active) revert PolicyAlreadyExists();

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
        Policy storage p = policies[policyId];

        bytes32 oldRoot = p.cohortRoot;
        p.cohortRoot = newRoot;

        emit CohortRootUpdated(policyId, oldRoot, newRoot);
    }

    function setPolicyActive(
        uint256 policyId,
        bool active
    ) external onlyIssuer {
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
