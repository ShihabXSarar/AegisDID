// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/Groth16Verifier.sol";
import "../src/AegisAid.sol";

contract Deploy is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployerAddress = vm.addr(deployerPrivateKey);

        console.log("Deploying with address:", deployerAddress);

        vm.startBroadcast(deployerPrivateKey);

        Groth16Verifier verifier = new Groth16Verifier();
        console.log("Groth16Verifier deployed at:", address(verifier));

        AegisAid aid = new AegisAid(IGroth16Verifier(address(verifier)));
        console.log("AegisAid deployed at:", address(aid));

        vm.stopBroadcast();
    }
}
