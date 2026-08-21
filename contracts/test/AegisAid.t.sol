// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AegisAid.sol";
import "./ProofFixture.sol";
import "../src/Groth16Verifier.sol";

contract AegisAidTest is Test {
    AegisAid internal aid;
    Groth16Verifier internal verifier;

    address internal admin = address(this);
    address internal issuer = address(0x1111);
    address internal attacker = address(0x2222);

    uint256 internal constant POLICY_ID = 1;
    uint256 internal constant TAU_Q = 100;
    uint64 internal constant EPOCH = 1;
    uint128 internal constant ALLOCATION = 10;
    uint128 internal constant TOTAL_UNITS = 20;

    bytes32 internal constant MODEL_HASH =
        bytes32(uint256(555));

    bytes32 internal goodRoot =
        bytes32(
            uint256(
                10783720918936994395894826524553743139029595551765483391935774837465090552306
            )
        );

    function setUp() public {
        verifier = new Groth16Verifier();
        aid = new AegisAid(IGroth16Verifier(address(verifier)));

        aid.setIssuer(issuer, true);
    }

    function _createGoodPolicy() internal {
        aid.createPolicy(
            POLICY_ID,
            goodRoot,
            TAU_Q,
            MODEL_HASH,
            EPOCH,
            ALLOCATION,
            TOTAL_UNITS
        );
    }

    function _proof()
        internal
        pure
        returns (
            uint[2] memory a,
            uint[2][2] memory b,
            uint[2] memory c,
            uint[6] memory input
        )
    {
        a = ProofFixture.proofA();
        b = ProofFixture.proofB();
        c = ProofFixture.proofC();
        input = ProofFixture.publicSignals();
    }

    function test_validClaim() public {
        _createGoodPolicy();

        (
            uint[2] memory a,
            uint[2][2] memory b,
            uint[2] memory c,
            uint[6] memory input
        ) = _proof();

        aid.claimAid(POLICY_ID, a, b, c, input);

        assertTrue(aid.nullifierUsed(POLICY_ID, input[0]));

        (
            ,
            ,
            ,
            ,
	    ,
            uint128 remaining,
            bool active
        ) = aid.policies(POLICY_ID);

        assertEq(remaining, 10);
        assertTrue(active);
    }

    function test_replayReverts() public {
        _createGoodPolicy();

        (
            uint[2] memory a,
            uint[2][2] memory b,
            uint[2] memory c,
            uint[6] memory input
        ) = _proof();

        aid.claimAid(POLICY_ID, a, b, c, input);

        vm.expectRevert(AegisAid.NullifierAlreadyUsed.selector);
        aid.claimAid(POLICY_ID, a, b, c, input);
    }

    function test_nonIssuerCannotCreatePolicy() public {
        vm.prank(attacker);

        vm.expectRevert(AegisAid.NotAuthorized.selector);

        aid.createPolicy(
            99,
            bytes32(uint256(1)),
            100,
            bytes32(uint256(555)),
            1,
            10,
            10
        );
    }

    function test_wrongRootReverts() public {
        _createGoodPolicy();

        (
            uint[2] memory a,
            uint[2][2] memory b,
            uint[2] memory c,
            uint[6] memory input
        ) = _proof();

        input[1] = uint256(goodRoot) + 1;

        vm.expectRevert(AegisAid.InvalidProof.selector);
        aid.claimAid(POLICY_ID, a, b, c, input);
    }

    function test_wrongPolicyIdReverts() public {
        _createGoodPolicy();

        (
            uint[2] memory a,
            uint[2][2] memory b,
            uint[2] memory c,
            uint[6] memory input
        ) = _proof();

        input[2] = 999;

        vm.expectRevert(AegisAid.InvalidProof.selector);
        aid.claimAid(POLICY_ID, a, b, c, input);
    }

    function test_wrongEpochReverts() public {
        _createGoodPolicy();

        (
            uint[2] memory a,
            uint[2][2] memory b,
            uint[2] memory c,
            uint[6] memory input
        ) = _proof();

        input[3] = 999;

        vm.expectRevert(AegisAid.InvalidProof.selector);
        aid.claimAid(POLICY_ID, a, b, c, input);
    }

    function test_wrongTauReverts() public {
        _createGoodPolicy();

        (
            uint[2] memory a,
            uint[2][2] memory b,
            uint[2] memory c,
            uint[6] memory input
        ) = _proof();

        input[4] = 999;

        vm.expectRevert(AegisAid.InvalidProof.selector);
        aid.claimAid(POLICY_ID, a, b, c, input);
    }

    function test_wrongModelHashReverts() public {
        _createGoodPolicy();

        (
            uint[2] memory a,
            uint[2][2] memory b,
            uint[2] memory c,
            uint[6] memory input
        ) = _proof();

        input[5] = 999;

        vm.expectRevert(AegisAid.InvalidProof.selector);
        aid.claimAid(POLICY_ID, a, b, c, input);
    }

    function test_policyCannotBeCreatedTwice() public {
        _createGoodPolicy();

        vm.expectRevert(AegisAid.PolicyAlreadyExists.selector);

        aid.createPolicy(
            POLICY_ID,
            goodRoot,
            TAU_Q,
            MODEL_HASH,
            EPOCH,
            ALLOCATION,
            TOTAL_UNITS
        );
    }

    function test_inactivePolicyReverts() public {
        _createGoodPolicy();

        aid.setPolicyActive(POLICY_ID, false);

        (
            uint[2] memory a,
            uint[2][2] memory b,
            uint[2] memory c,
            uint[6] memory input
        ) = _proof();

        vm.expectRevert(AegisAid.PolicyInactive.selector);
        aid.claimAid(POLICY_ID, a, b, c, input);
    }

    function test_onlyAdminCanSetIssuer() public {
        vm.prank(attacker);

        vm.expectRevert(AegisAid.NotAuthorized.selector);

        aid.setIssuer(attacker, true);
    }

    function test_issuerCanUpdateRoot() public {
        _createGoodPolicy();

        bytes32 newRoot = bytes32(uint256(12345));

        vm.prank(issuer);
        aid.updateCohortRoot(POLICY_ID, newRoot);

        (
            bytes32 storedRoot,
            ,
            ,
            ,
            ,
            ,
        ) = aid.policies(POLICY_ID);

        assertEq(storedRoot, newRoot);
    }
function test_allocationExhausted() public {
    aid.createPolicy(
        POLICY_ID,
        goodRoot,
        TAU_Q,
        MODEL_HASH,
        EPOCH,
        ALLOCATION,
        10
    );

    (
        uint[2] memory a,
        uint[2][2] memory b,
        uint[2] memory c,
        uint[6] memory input
    ) = _proof();

    // First claim consumes all 10 units.
    aid.claimAid(POLICY_ID, a, b, c, input);

    // A second claim cannot proceed because allocation is exhausted.
    // The first claim already used this nullifier, but the contract
    // checks allocation exhaustion before the nullifier check.
    vm.expectRevert(AegisAid.AllocationExhausted.selector);
    aid.claimAid(POLICY_ID, a, b, c, input);
}

    /* ================================================================== *
     *  Policy-existence regression tests.
     *
     *  Added after a read-only audit of the live Base Sepolia deployment
     *  showed policies 101 and 102 holding NON-ZERO cohort roots while having
     *  emitted no PolicyCreated event -- i.e. updateCohortRoot had written into
     *  slots that were never initialised. A root sitting in an uncreated policy
     *  is not merely untidy: it makes a non-existent policy look configured to
     *  any off-chain indexer that reads storage instead of events, and
     *  setPolicyActive can then flip it live with tauQ == 0 (which accepts any
     *  face, since the circuit's test is dot >= tauQ) and modelHash == 0.
     * ================================================================== */

    function test_updateCohortRootOnNonexistentPolicyReverts() public {
        uint256 ghostId = 424242;

        // Precondition: nothing has ever been written to this slot.
        (bytes32 rootBefore, , , , , , bool activeBefore) = aid.policies(ghostId);
        assertEq(rootBefore, bytes32(0));
        assertFalse(activeBefore);
        assertFalse(aid.policyExists(ghostId));

        vm.prank(issuer);
        vm.expectRevert(AegisAid.PolicyDoesNotExist.selector);
        aid.updateCohortRoot(ghostId, bytes32(uint256(999)));

        // The slot must remain untouched.
        (bytes32 rootAfter, , , , , , ) = aid.policies(ghostId);
        assertEq(rootAfter, bytes32(0));
    }

    function test_setPolicyActiveOnNonexistentPolicyReverts() public {
        uint256 ghostId = 515151;

        vm.prank(issuer);
        vm.expectRevert(AegisAid.PolicyDoesNotExist.selector);
        aid.setPolicyActive(ghostId, true);

        (, , , , , , bool active) = aid.policies(ghostId);
        assertFalse(active);
    }

    /**
     * createPolicy guarded on `.active`, not on existence. A policy that was
     * created and then deactivated could therefore be silently re-created,
     * overwriting tauQ, modelHash, epoch, allocation and remaining while
     * re-emitting PolicyCreated for an ID that already had claim history --
     * and nullifierUsed is keyed by policyId and is NOT cleared, so the
     * rewritten policy inherits spent nullifiers from its previous life.
     */
    function test_createPolicyCannotOverwriteDeactivatedPolicy() public {
        _createGoodPolicy();

        aid.setPolicyActive(POLICY_ID, false);

        vm.expectRevert(AegisAid.PolicyAlreadyExists.selector);
        aid.createPolicy(
            POLICY_ID,
            bytes32(uint256(1)), // different root
            1, // dangerously permissive tauQ
            bytes32(uint256(2)), // different model
            99,
            1,
            1000
        );

        // Original parameters must survive the rejected overwrite.
        (
            bytes32 root,
            uint256 tauQ,
            bytes32 modelHash,
            uint64 epoch,
            ,
            ,
        ) = aid.policies(POLICY_ID);

        assertEq(root, goodRoot);
        assertEq(tauQ, TAU_Q);
        assertEq(modelHash, MODEL_HASH);
        assertEq(epoch, EPOCH);
    }

    /**
     * policyExists must not be conflated with active. A deactivated policy
     * still exists and must remain root-updatable and reactivatable.
     */
    function test_deactivatedPolicyStillExistsForIssuerOps() public {
        _createGoodPolicy();
        aid.setPolicyActive(POLICY_ID, false);

        assertTrue(aid.policyExists(POLICY_ID));

        bytes32 newRoot = bytes32(uint256(777));
        vm.prank(issuer);
        aid.updateCohortRoot(POLICY_ID, newRoot);

        vm.prank(issuer);
        aid.setPolicyActive(POLICY_ID, true);

        (bytes32 root, , , , , , bool active) = aid.policies(POLICY_ID);
        assertEq(root, newRoot);
        assertTrue(active);
    }

    /* ================================================================== *
     *  Policy parameter sanity.
     *
     *  Both of these produce a policy that looks healthy on-chain and fails
     *  only at the beneficiary, after they have already burned a claim.
     * ================================================================== */

    /** allocation == 0 burns a nullifier permanently while paying nothing. */
    function test_createPolicyRejectsZeroAllocation() public {
        vm.expectRevert(AegisAid.InvalidPolicyParameters.selector);
        aid.createPolicy(
            POLICY_ID,
            goodRoot,
            TAU_Q,
            MODEL_HASH,
            EPOCH,
            0,
            TOTAL_UNITS
        );
    }

    /** totalUnits < allocation makes the very first claim revert, forever. */
    function test_createPolicyRejectsTotalUnitsBelowAllocation() public {
        vm.expectRevert(AegisAid.InvalidPolicyParameters.selector);
        aid.createPolicy(
            POLICY_ID,
            goodRoot,
            TAU_Q,
            MODEL_HASH,
            EPOCH,
            10,
            9
        );
    }

    /** totalUnits == allocation is the legitimate single-beneficiary case. */
    function test_createPolicyAllowsExactlyOneAllocation() public {
        aid.createPolicy(
            POLICY_ID,
            goodRoot,
            TAU_Q,
            MODEL_HASH,
            EPOCH,
            10,
            10
        );

        (
            ,
            ,
            ,
            ,
            uint128 allocation,
            uint128 remaining,
            bool active
        ) = aid.policies(POLICY_ID);

        assertEq(allocation, 10);
        assertEq(remaining, 10);
        assertTrue(active);
    }

    /* ================================================================== *
     *  Admin rotation.
     *
     *  The deployed Base Sepolia instance has no setAdmin, so its admin key can
     *  never be retired without redeploying and re-creating every policy.
     * ================================================================== */

    function test_adminCanRotateAdmin() public {
        address newAdmin = address(0x3333);

        aid.setAdmin(newAdmin);
        assertEq(aid.admin(), newAdmin);

        // The old admin loses authority immediately.
        vm.expectRevert(AegisAid.NotAuthorized.selector);
        aid.setIssuer(attacker, true);

        // The new admin has it.
        vm.prank(newAdmin);
        aid.setIssuer(attacker, true);
        assertTrue(aid.isIssuer(attacker));
    }

    function test_nonAdminCannotRotateAdmin() public {
        vm.prank(attacker);
        vm.expectRevert(AegisAid.NotAuthorized.selector);
        aid.setAdmin(attacker);
    }

    /** Rotating to address(0) would brick every onlyAdmin path forever. */
    function test_adminCannotRotateToZeroAddress() public {
        vm.expectRevert(AegisAid.InvalidPolicyParameters.selector);
        aid.setAdmin(address(0));
    }

    /* ================================================================== *
     *  tauQ soundness bound.
     *
     *  This is the highest-severity finding in the contract. The circuit's
     *  acceptance test is GreaterEqThan(24)(dot + 2**21, tauQ + 2**21) over the
     *  BN254 scalar field. A tauQ expressed as a large field residue makes that
     *  comparator's internal range check wrap, so it returns 1 unconditionally
     *  and the biometric threshold is bypassed entirely.
     *
     *  MEASURED, not theorised: web/scripts/tauq_bound_probe.mts produces a
     *  VALID Groth16 proof for a NON-MATCHING face (measured cosine 0.0889) at
     *  tauQ = r - 1 and at tauQ = r - 1000000, and that proof verifies. tauQ = 0
     *  likewise accepts any dot >= 0.
     *
     *  The circuit cannot defend itself -- tauQ is a public input -- so the
     *  contract is the enforcement point.
     * ================================================================== */

    uint256 internal constant FIELD_R =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    /** tauQ = 0 disables the biometric check: dot >= 0 for ~half of random pairs. */
    function test_createPolicyRejectsZeroTauQ() public {
        vm.expectRevert(AegisAid.InvalidTauQ.selector);
        aid.createPolicy(POLICY_ID, goodRoot, 0, MODEL_HASH, EPOCH, ALLOCATION, TOTAL_UNITS);
    }

    /**
     * tauQ = r - 1 is "-1" in the field. Proven to make the comparator wrap and
     * accept an unrelated face. This is the exact value the probe exploited.
     */
    function test_createPolicyRejectsFieldNegativeTauQ() public {
        vm.expectRevert(AegisAid.InvalidTauQ.selector);
        aid.createPolicy(
            POLICY_ID,
            goodRoot,
            FIELD_R - 1,
            MODEL_HASH,
            EPOCH,
            ALLOCATION,
            TOTAL_UNITS
        );
    }

    function test_createPolicyRejectsLargeFieldResidueTauQ() public {
        vm.expectRevert(AegisAid.InvalidTauQ.selector);
        aid.createPolicy(
            POLICY_ID,
            goodRoot,
            FIELD_R - 1000000,
            MODEL_HASH,
            EPOCH,
            ALLOCATION,
            TOTAL_UNITS
        );
    }

    /** Just past the 24-bit comparator window. */
    function test_createPolicyRejectsTauQAboveComparatorWindow() public {
        vm.expectRevert(AegisAid.InvalidTauQ.selector);
        aid.createPolicy(
            POLICY_ID,
            goodRoot,
            1 << 24,
            MODEL_HASH,
            EPOCH,
            ALLOCATION,
            TOTAL_UNITS
        );
    }

    /**
     * Above the top of the cosine scale. Not "unreachable" -- quantization rounding puts a genuine
     * self-match anywhere from 15852 to 16447 (measured, web/scripts/quantize_test.mts section 9) --
     * but a threshold up there is unusable, and the cap is what keeps tauQ inside the comparator
     * window.
     */
    function test_createPolicyRejectsTauQAboveMax() public {
        // Read the bound BEFORE expectRevert: vm.expectRevert applies to the very
        // next external call, and aid.MAX_TAU_Q() is itself an external staticcall.
        uint256 tooHigh = aid.MAX_TAU_Q() + 1;

        vm.expectRevert(AegisAid.InvalidTauQ.selector);
        aid.createPolicy(
            POLICY_ID,
            goodRoot,
            tooHigh,
            MODEL_HASH,
            EPOCH,
            ALLOCATION,
            TOTAL_UNITS
        );
    }

    /** Both bounds are inclusive: MIN_TAU_Q and MAX_TAU_Q must be accepted. */
    function test_createPolicyAcceptsTauQAtBounds() public {
        uint256 lo = aid.MIN_TAU_Q();
        uint256 hi = aid.MAX_TAU_Q();

        aid.createPolicy(1001, goodRoot, lo, MODEL_HASH, EPOCH, ALLOCATION, TOTAL_UNITS);
        aid.createPolicy(1002, goodRoot, hi, MODEL_HASH, EPOCH, ALLOCATION, TOTAL_UNITS);

        (, uint256 tauLo, , , , , ) = aid.policies(1001);
        (, uint256 tauHi, , , , , ) = aid.policies(1002);
        assertEq(tauLo, 1);
        assertEq(tauHi, 127 * 127);
    }

    /** MAX_TAU_Q must equal cosineToTauQ(1.0) as computed by web/lib/ml/quantize.ts. */
    function test_tauQBoundsMatchQuantizationScheme() public view {
        assertEq(aid.MAX_TAU_Q(), 16129);
        assertEq(aid.MIN_TAU_Q(), 1);
    }

    /**
     * Defence in depth: claimAid re-checks the bound on the path where value
     * moves. Reached here by writing a hostile tauQ straight into storage, which
     * models a future code path that sets p.tauQ without re-validating.
     */
    function test_claimAidRejectsOutOfRangeTauQEvenIfStored() public {
        _createGoodPolicy();

        (, uint256 tauBefore, , , , , ) = aid.policies(POLICY_ID);
        assertEq(tauBefore, TAU_Q);

        // Storage layout: verifier is immutable (no slot), MIN/MAX_TAU_Q are
        // constants (no slot), so admin = 0, isIssuer = 1, policies = 2.
        // Within Policy: cohortRoot = +0, tauQ = +1.
        bytes32 tauSlot = bytes32(uint256(keccak256(abi.encode(POLICY_ID, uint256(2)))) + 1);
        assertEq(
            uint256(vm.load(address(aid), tauSlot)),
            TAU_Q,
            "tauQ is not at the expected storage slot"
        );

        vm.store(address(aid), tauSlot, bytes32(FIELD_R - 1));

        (, uint256 tauAfter, , , , , ) = aid.policies(POLICY_ID);
        assertEq(tauAfter, FIELD_R - 1, "hostile tauQ not written");

        (
            uint[2] memory a,
            uint[2][2] memory b,
            uint[2] memory c,
            uint[6] memory input
        ) = _proof();

        vm.expectRevert(AegisAid.InvalidTauQ.selector);
        aid.claimAid(POLICY_ID, a, b, c, input);
    }
}
