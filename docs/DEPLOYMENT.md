# AegisDID Deployment Guide

This guide outlines the process for manually deploying the AegisDID smart contracts (`Groth16Verifier` and `AegisAid`) to the Base Sepolia testnet.

## 1. Base Sepolia Requirements

Before deploying, ensure you have the following ready:
* **MetaMask Wallet**: Installed and configured in your browser.
* **Base Sepolia Network**: Add Base Sepolia to your MetaMask networks.
* **Test ETH**: Obtain Base Sepolia test ETH from a public faucet (e.g., Coinbase or Alchemy faucet).
* **RPC URL**: An active Base Sepolia RPC endpoint URL (e.g., from Alchemy, Infura, or public RPC).

## 2. Local Secret Setup

You need to provide your deployment credentials securely to the local environment.

1. Navigate to the `contracts/` directory.
2. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
3. Open `.env` and fill in your details:
   ```text
   BASE_SEPOLIA_RPC_URL=<your_rpc_url>
   PRIVATE_KEY=<your_wallet_private_key>
   ```

> **WARNING**: NEVER commit your `.env` file to version control. It contains your private key. Ensure it remains ignored by Git (it is already in `.gitignore`).

## 3. Deployment Command

Once the environment is configured, use Foundry to deploy the contracts. 

From within the `contracts/` directory, run the following command (assuming a Bash or WSL environment):
```bash
forge script script/Deploy.s.sol:Deploy --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast
```
*Note: Foundry will automatically load variables from `.env` and pass them into the script.*

## 4. Post-Deployment Output to Record

The following are the actual recorded values from the Base Sepolia deployment (Block 45651880):

* **`Groth16Verifier` address**: `0x05ea2aDa4aB61F46b247B7b6c6943D74e99A06bd`
  * [Base Sepolia Explorer Link](https://base-sepolia.blockscout.com/address/0x05ea2aDa4aB61F46b247B7b6c6943D74e99A06bd)
  * Deployment Transaction: `0x56aaadab5da1e8277aca5baac3aeb49c94d4b92cd465a9ed36a22de0eb6084cf`
* **`AegisAid` address**: `0xAB2fa997c25B0B02E635052166d0192b5Eab5765`
  * [Base Sepolia Explorer Link](https://base-sepolia.blockscout.com/address/0xAB2fa997c25B0B02E635052166d0192b5Eab5765)
  * Deployment Transaction: `0xbce234b92c6f3a4ebe5e30416e03368d17a0b91fa2a5549a989c90609f0c2523`
* **Total deployment cost**: `0.000012188637242442 ETH`

These values should be added to the project configuration (e.g., `web/.env.local` and `dashboard/.env.local`).

## 5. Verifying the Deployment

To verify the deployment was successful:
1. Search for your contract addresses on the [Base Sepolia Blockscout](https://base-sepolia.blockscout.com/) or [Basescan Sepolia](https://sepolia.basescan.org/).
2. Confirm that the `AegisAid` contract has the correct initial state, with the deploying address set as the `admin` and an active `isIssuer`.

## 6. Measuring Real `claimAid` Gas Cost

The project requires measuring the actual gas cost of a `claimAid` execution.

**Local Foundry Measurement**:
You can inspect the local gas usage by running tests with verbosity or utilizing `--gas-report`:
```bash
forge test --match-test test_validClaim -vv
```

**Authoritative On-Chain Measurement**:
To obtain the *authoritative* gas consumed:
1. Complete the full integration with the web/dashboard app.
2. Execute a real `claimAid` transaction on Base Sepolia.
3. Locate the transaction hash on the Base Sepolia block explorer.
4. Record the exact "Gas Used by Transaction" value reported by the explorer.
5. Add this final measured value to `benchmarks/RESULTS.md`.
