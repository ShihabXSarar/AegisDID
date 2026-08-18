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
      
}
