// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {Groth16Verifier} from "../src/Groth16Verifier.sol";
import {AegisAid, IGroth16Verifier} from "../src/AegisAid.sol";
import {console} from "forge-std/console.sol";

contract SetupLocalDemo is Script {
    function run() external {
        // Use Anvil account #0 for the deployer/issuer
        uint256 deployerPrivateKey = vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        
        vm.startBroadcast(deployerPrivateKey);

        Groth16Verifier verifier = new Groth16Verifier();
        AegisAid aegis = new AegisAid(IGroth16Verifier(address(verifier)));

        // Pre-populate with the mock policies expected by the frontend
        // Policy 101: UNHCR Emergency Ration Distribution
        // dummy root: 0x2a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b
        aegis.createPolicy(
            101,
            0x2a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b,
            8065,
            0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b,
            1,
            50,
            5000
        );

        // Policy 102: WFP Monthly Cash-for-Work Stipend
        // dummy root: 0x3b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c
        aegis.createPolicy(
            102,
            0x3b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c,
            9677,
            0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b,
            1,
            120,
            12000
        );

        vm.stopBroadcast();

        console.log("---- LOCAL DEMO SETUP COMPLETE ----");
        console.log("Groth16Verifier deployed at:", address(verifier));
        console.log("AegisAid deployed at:", address(aegis));
        console.log("-----------------------------------");
        console.log("To use with frontend:");
        console.log("1. Add to web/.env.local:");
        console.log("   NEXT_PUBLIC_AEGIS_AID_ADDRESS=%s", address(aegis));
        console.log("   NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545");
        console.log("2. Restart the Next.js development server");
        console.log("3. In the Claim Aid UI, use the 'Local Dev: Sync Enrolled Root to Contract' button before claiming");
    }
}
