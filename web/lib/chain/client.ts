/**
 * AegisDID — Viem Blockchain Client for Base Sepolia
 * Interacts with AegisAid.sol smart contract.
 */

import { createPublicClient, http, custom, parseAbi, Address, createWalletClient } from 'viem';
import { baseSepolia } from 'viem/chains';
import { Groth16Proof } from '../zk/prover';

// Contract Address on Base Sepolia (set via .env or default placeholder)
export const AEGIS_AID_ADDRESS: Address =
  (process.env.NEXT_PUBLIC_AEGIS_AID_ADDRESS as Address) ||
  '0x4e65001275991A57E860c2394142F80824982631';

export const AEGIS_AID_ABI = parseAbi([
  'function createPolicy(uint256 policyId, bytes32 cohortRoot, uint256 tauQ, bytes32 modelHash, uint64 epoch, uint128 allocation, uint128 totalUnits) external',
  'function updateCohortRoot(uint256 policyId, bytes32 newRoot) external',
  'function claimAid(uint256 policyId, uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[6] calldata input) external',
  'function policies(uint256) external view returns (bytes32 cohortRoot, uint256 tauQ, bytes32 modelHash, uint64 epoch, uint128 allocation, uint128 remaining, bool active)',
  'function nullifierUsed(uint256, uint256) external view returns (bool)',
  'event PolicyCreated(uint256 indexed policyId, bytes32 cohortRoot, uint256 tauQ)',
  'event AidClaimed(uint256 indexed policyId, uint256 nullifier, uint128 amount)',
]);

export interface PolicyInfo {
  policyId: number;
  cohortRoot: string;
  tauQ: bigint;
  modelHash: string;
  epoch: number;
  allocation: bigint;
  remaining: bigint;
  active: boolean;
  name?: string;
  description?: string;
}

// Fallback/Demo Mock Policies
export const MOCK_POLICIES: PolicyInfo[] = [
  {
    policyId: 101,
    cohortRoot: '0x2a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b',
    tauQ: BigInt(8065), // tau = 0.50 -> 0.50 * 127 * 127 = 8065
    modelHash: '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
    epoch: 1,
    allocation: BigInt(50),
    remaining: BigInt(5000),
    active: true,
    name: 'UNHCR Emergency Ration Distribution',
    description: 'Bi-weekly emergency food ration allocation for registered displaced individuals.',
  },
  {
    policyId: 102,
    cohortRoot: '0x3b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c',
    tauQ: BigInt(9677), // tau = 0.60 -> 0.60 * 127 * 127 = 9677
    modelHash: '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b',
    epoch: 1,
    allocation: BigInt(120),
    remaining: BigInt(12000),
    active: true,
    name: 'WFP Monthly Cash-for-Work Stipend',
    description: 'Monthly direct unconditional cash support with high-assurance biometric matching.',
  },
];

// In-browser nullifier tracker (replicates smart contract nullifierUsed mapping for demo)
const usedNullifiers = new Set<string>();

export function isNullifierUsedLocal(policyId: number, nullifier: string): boolean {
  return usedNullifiers.has(`${policyId}-${nullifier.toLowerCase()}`);
}

export function markNullifierUsedLocal(policyId: number, nullifier: string): void {
  usedNullifiers.add(`${policyId}-${nullifier.toLowerCase()}`);
}

export function resetUsedNullifiers(): void {
  usedNullifiers.clear();
}

export function getPublicClient() {
  return createPublicClient({
    chain: baseSepolia,
    transport: http(process.env.NEXT_PUBLIC_RPC_URL || 'https://sepolia.base.org'),
  });
}

export function getExplorerTxUrl(txHash: string): string {
  return `https://sepolia.basescan.org/tx/${txHash}`;
}

/**
 * Format snarkjs proof into Solidity calldata uint parameters
 */
export function formatProofForSolidity(proof: Groth16Proof, publicSignals: string[]) {
  const a: [bigint, bigint] = [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])];

  const b: [[bigint, bigint], [bigint, bigint]] = [
    [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
    [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
  ];

  const c: [bigint, bigint] = [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])];

  const input: [bigint, bigint, bigint, bigint, bigint, bigint] = [
    BigInt(publicSignals[0] || '0'),
    BigInt(publicSignals[1] || '0'),
    BigInt(publicSignals[2] || '0'),
    BigInt(publicSignals[3] || '0'),
    BigInt(publicSignals[4] || '0'),
    BigInt(publicSignals[5] || '0'),
  ];

  return { a, b, c, input };
}

/**
 * Submit Claim Transaction to AegisAid contract on Base Sepolia
 */
export async function submitClaimToContract(
  policyId: number,
  proof: Groth16Proof,
  publicSignals: string[]
): Promise<string> {
  const nullifier = publicSignals[0];

  // 1. Anti-Replay / Double-Claim Check
  if (isNullifierUsedLocal(policyId, nullifier)) {
    throw new Error(
      `NullifierAlreadyUsed: Double-claim detected! You have already claimed relief for Policy #${policyId} in this epoch.`
    );
  }

  if (typeof window === 'undefined' || !(window as any).ethereum) {
    // Simulate transaction execution on Base Sepolia
    console.log('Simulating on-chain transaction execution for Nullifier:', nullifier);
    await new Promise((r) => setTimeout(r, 1500));

    // Record nullifier as consumed on-chain
    markNullifierUsedLocal(policyId, nullifier);

    const randomSuffix = Math.random().toString(16).substring(2, 10);
    return `0x7f1a8c4d2e9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a${randomSuffix}`;
  }

  const walletClient = createWalletClient({
    chain: baseSepolia,
    transport: custom((window as any).ethereum),
  });

  const [account] = await walletClient.requestAddresses();
  const { a, b, c, input } = formatProofForSolidity(proof, publicSignals);

  const hash = await walletClient.writeContract({
    address: AEGIS_AID_ADDRESS,
    abi: AEGIS_AID_ABI,
    functionName: 'claimAid',
    args: [BigInt(policyId), a, b, c, input],
    account,
  });

  markNullifierUsedLocal(policyId, nullifier);
  return hash;
}
