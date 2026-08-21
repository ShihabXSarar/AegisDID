/**
 * AegisDID — Viem Blockchain Client
 * Interacts with the deployed AegisAid.sol contract.
 *
 * SECURITY NOTES
 *  - This module contains NO private keys. Every state-changing call goes through the
 *    user's injected wallet (MetaMask) so the signer is always explicit.
 *  - There is deliberately NO beneficiary-side `updateCohortRoot` helper. Letting a
 *    claimant publish the cohort root they are about to prove against would make the
 *    Merkle membership check meaningless. Publishing roots is an issuer-only action and
 *    lives in the authority dashboard.
 *  - The target chain is chosen explicitly by NEXT_PUBLIC_CHAIN_ID. There is no silent
 *    fallback between local and testnet state.
 */

import { createPublicClient, http, custom, parseAbi, Address, createWalletClient, Chain } from 'viem';
import { baseSepolia, foundry } from 'viem/chains';
import { Groth16Proof } from '../zk/prover';
import {
  MIN_TAU_Q,
  MAX_TAU_Q,
  isTauQSound,
  TAU_Q_FAR_1E3,
  TAU_Q_MEASURED_FAR_100,
  tauQAdequacyWarning,
} from '../ml/quantize';

/** Exact operator-facing message required when the API root and on-chain root disagree. */
export const ROOT_MISMATCH_MESSAGE =
  'Merkle root mismatch — authority must publish the current cohort root.';

/**
 * Refusal message for a policy whose on-chain tauQ is outside the range where the in-circuit
 * comparator is sound.
 *
 * This check exists client-side because the CURRENTLY DEPLOYED Base Sepolia bytecode predates
 * AegisAid's MIN_TAU_Q / MAX_TAU_Q bound: its policies 101 and 102 sit at tauQ = 0. Reading such a
 * policy and proving against it would produce a proof that verifies while the biometric threshold
 * was never really enforced — a fake success in every sense that matters. So the client refuses
 * rather than displaying a green tick.
 */
export function tauQUnsoundMessage(policyId: number, tauQ: bigint): string {
  return (
    `Policy #${policyId} has tauQ = ${tauQ.toString()}, outside the sound range ` +
    `[${MIN_TAU_Q}, ${MAX_TAU_Q}]. The in-circuit comparator is only sound inside that range; ` +
    'outside it the biometric threshold can be bypassed entirely. Refusing to claim — the ' +
    'authority must re-create this policy with a valid tauQ.'
  );
}

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID || '84532');

/** True when pointed at Base Sepolia. Development-only affordances must stay off here. */
export const IS_TESTNET_MODE = CHAIN_ID === 84532;
export const IS_LOCAL_CHAIN = CHAIN_ID === 31337;

export const ACTIVE_CHAIN: Chain = IS_LOCAL_CHAIN ? foundry : baseSepolia;

export const CHAIN_LABEL = IS_LOCAL_CHAIN
  ? 'Local Anvil (31337)'
  : IS_TESTNET_MODE
    ? 'Base Sepolia (84532)'
    : `Chain ${CHAIN_ID}`;

// Contract address. Base Sepolia default is the documented deployment (docs/DEPLOYMENT.md).
export const AEGIS_AID_ADDRESS: Address =
  (process.env.NEXT_PUBLIC_AEGIS_AID_ADDRESS as Address) ||
  '0xAB2fa997c25B0B02E635052166d0192b5Eab5765';

/**
 * First block to scan for PolicyCreated events. Local chains start at 0; the Base Sepolia
 * value is the AegisAid deployment block so scans stay cheap.
 */
export const DEPLOYMENT_BLOCK: bigint = IS_LOCAL_CHAIN
  ? 0n
  : BigInt(process.env.NEXT_PUBLIC_DEPLOYMENT_BLOCK || '45651880');

// ABI must exactly match AegisAid.sol — event signatures determine topic0 hash
export const AEGIS_AID_ABI = parseAbi([
  'function createPolicy(uint256 policyId, bytes32 cohortRoot, uint256 tauQ, bytes32 modelHash, uint64 epoch, uint128 allocation, uint128 totalUnits) external',
  'function updateCohortRoot(uint256 policyId, bytes32 newRoot) external',
  'function setPolicyActive(uint256 policyId, bool active) external',
  'function setIssuer(address issuer, bool allowed) external',
  'function claimAid(uint256 policyId, uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[6] calldata input) external',
  'function policies(uint256) external view returns (bytes32 cohortRoot, uint256 tauQ, bytes32 modelHash, uint64 epoch, uint128 allocation, uint128 remaining, bool active)',
  'function nullifierUsed(uint256, uint256) external view returns (bool)',
  'function isIssuer(address) external view returns (bool)',
  'function admin() external view returns (address)',
  'function verifier() external view returns (address)',
  // Events — signatures MUST match the contract exactly (parameter count + types determine topic0)
  'event PolicyCreated(uint256 indexed policyId, bytes32 cohortRoot, uint256 tauQ, bytes32 modelHash, uint64 epoch, uint128 allocation, uint128 totalUnits)',
  'event CohortRootUpdated(uint256 indexed policyId, bytes32 oldRoot, bytes32 newRoot)',
  'event AidClaimed(uint256 indexed policyId, uint256 indexed nullifier, uint128 amount)',
  'event IssuerUpdated(address indexed issuer, bool allowed)',
  'event PolicyStatusUpdated(uint256 indexed policyId, bool active)',
]);

const ZERO_ROOT = `0x${'0'.repeat(64)}`;

/**
 * Re-exported so UI code has a single import for "what does the chain layer consider a valid
 * threshold". The values themselves live next to the quantization scheme that defines them and
 * must stay in sync with AegisAid.MIN_TAU_Q / MAX_TAU_Q.
 *
 * tauQAdequacyWarning / TAU_Q_FAR_1E3 are a different question — soundness is enforceable on-chain,
 * adequacy is not. They are advisory only and must never gate a claim.
 */
export {
  MIN_TAU_Q,
  MAX_TAU_Q,
  isTauQSound,
  TAU_Q_FAR_1E3,
  TAU_Q_MEASURED_FAR_100,
  tauQAdequacyWarning,
};

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
  /** True when the cohort root is all-zero, i.e. no beneficiary can ever produce a valid path. */
  rootUnpublished: boolean;
  /**
   * True when tauQ is outside [MIN_TAU_Q, MAX_TAU_Q] and the in-circuit threshold comparison is
   * therefore unsound. A policy in this state must not be claimed against. Reachable only on the
   * already-deployed bytecode, which has no such bound.
   */
  tauQUnsound: boolean;
}

export function getPublicClient() {
  const fallbackRpc = IS_LOCAL_CHAIN
    ? 'http://127.0.0.1:8545'
    : 'https://base-sepolia-rpc.publicnode.com';
  return createPublicClient({
    chain: ACTIVE_CHAIN,
    transport: http(process.env.NEXT_PUBLIC_RPC_URL || fallbackRpc),
  });
}

export function getExplorerTxUrl(txHash: string): string {
  if (IS_LOCAL_CHAIN) return '';
  return `https://sepolia.basescan.org/tx/${txHash}`;
}

/**
 * Format a snarkjs proof into the Solidity calldata shape expected by Groth16Verifier.
 *
 * snarkjs emits G2 coordinates as [c0, c1] while the generated Solidity verifier expects
 * [c1, c0], so pi_b's inner pairs are swapped here. Verified end-to-end against the real
 * verifier by contracts/test/AegisAid.t.sol::test_validClaim.
 */
export function formatProofForSolidity(proof: Groth16Proof, publicSignals: string[]) {
  const a: [bigint, bigint] = [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])];

  const b: [[bigint, bigint], [bigint, bigint]] = [
    [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
    [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
  ];

  const c: [bigint, bigint] = [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])];

  if (publicSignals.length !== 6) {
    throw new Error(
      `Expected 6 public signals [nullifier, root, policyId, epoch, tauQ, modelHash], got ${publicSignals.length}.`
    );
  }

  const input: [bigint, bigint, bigint, bigint, bigint, bigint] = [
    BigInt(publicSignals[0]),
    BigInt(publicSignals[1]),
    BigInt(publicSignals[2]),
    BigInt(publicSignals[3]),
    BigInt(publicSignals[4]),
    BigInt(publicSignals[5]),
  ];

  return { a, b, c, input };
}

function toPolicyInfo(policyId: number, policyData: readonly unknown[]): PolicyInfo {
  const [cohortRoot, tauQ, modelHash, epoch, allocation, remaining, active] = policyData as [
    string, bigint, string, bigint, bigint, bigint, boolean
  ];

  const rootUnpublished = cohortRoot === ZERO_ROOT;
  const tauQUnsound = !isTauQSound(tauQ);

  return {
    policyId,
    cohortRoot,
    tauQ,
    modelHash,
    epoch: Number(epoch),
    allocation,
    remaining,
    active,
    rootUnpublished,
    tauQUnsound,
    name: `Policy #${policyId}`,
    description: !active
      ? 'Inactive — the issuer has disabled claims for this policy.'
      : tauQUnsound
        ? `Unsafe — tauQ ${tauQ.toString()} is outside [${MIN_TAU_Q}, ${MAX_TAU_Q}], so the biometric threshold is not enforceable. Claims are refused.`
        : rootUnpublished
          ? 'Active but no cohort root has been published yet — claims cannot succeed.'
          : `Active. Allocation: ${allocation.toString()} units per beneficiary.`,
  };
}

/** Read a single policy's on-chain state by ID. */
export async function readPolicyOnChain(policyId: number): Promise<PolicyInfo> {
  const publicClient = getPublicClient();
  const policyData = await publicClient.readContract({
    address: AEGIS_AID_ADDRESS,
    abi: AEGIS_AID_ABI,
    functionName: 'policies',
    args: [BigInt(policyId)],
  });

  return toPolicyInfo(policyId, policyData as readonly unknown[]);
}

/**
 * Discover every policy ID that has actually been created, by scanning PolicyCreated logs.
 *
 * There is deliberately no hardcoded ID list. A hardcoded list both hides policies created
 * later and surfaces phantom policies for IDs that were never created — the deployed
 * contract's `updateCohortRoot` writes a root into any slot, so a non-zero root alone does
 * not prove a policy exists. Only a PolicyCreated event does.
 */
export async function discoverPolicyIds(): Promise<number[]> {
  const publicClient = getPublicClient();
  const ids = new Set<number>();
  const latestBlock = await publicClient.getBlockNumber();
  const CHUNK = 45000n;
  const eventAbi = AEGIS_AID_ABI.find(
    (x) => x.type === 'event' && x.name === 'PolicyCreated'
  ) as any;

  let from = DEPLOYMENT_BLOCK;
  while (from <= latestBlock) {
    const to = from + CHUNK > latestBlock ? latestBlock : from + CHUNK;
    const logs = await publicClient.getLogs({
      address: AEGIS_AID_ADDRESS,
      event: eventAbi,
      fromBlock: from,
      toBlock: to,
    });
    for (const log of logs) {
      // eventAbi is untyped (looked up at runtime), so viem cannot infer decoded args here.
      const args = (log as unknown as { args?: { policyId?: bigint } }).args;
      if (args?.policyId != null) ids.add(Number(args.policyId));
    }
    from = to + 1n;
  }

  return [...ids].sort((a, b) => a - b);
}

/**
 * Fetch every created policy with its current on-chain state (active and inactive).
 * Used by the authority dashboard.
 */
export async function fetchAllPolicies(): Promise<PolicyInfo[]> {
  const ids = await discoverPolicyIds();
  const out: PolicyInfo[] = [];
  for (const id of ids) {
    out.push(await readPolicyOnChain(id));
  }
  return out;
}

/** Fetch only the policies a beneficiary could claim against. */
export async function fetchActivePolicies(): Promise<PolicyInfo[]> {
  const all = await fetchAllPolicies();
  return all.filter((p) => p.active);
}

/** Has this nullifier already been spent for this policy? Read-only pre-flight check. */
export async function isNullifierUsed(policyId: number, nullifier: string | bigint): Promise<boolean> {
  const publicClient = getPublicClient();
  return (await publicClient.readContract({
    address: AEGIS_AID_ADDRESS,
    abi: AEGIS_AID_ABI,
    functionName: 'nullifierUsed',
    args: [BigInt(policyId), BigInt(nullifier)],
  })) as boolean;
}

/** Is this address authorised to create policies / publish roots? */
export async function checkIsIssuer(account: Address): Promise<boolean> {
  const publicClient = getPublicClient();
  return (await publicClient.readContract({
    address: AEGIS_AID_ADDRESS,
    abi: AEGIS_AID_ABI,
    functionName: 'isIssuer',
    args: [account],
  })) as boolean;
}

export interface RootCheckResult {
  matches: boolean;
  onChainRoot: string;
  localRoot: string;
  policy: PolicyInfo;
}

/**
 * Compare the root returned by the authority's Merkle API against the root the contract
 * will actually enforce, BEFORE any proving work is done.
 *
 * On mismatch the caller must abort with ROOT_MISMATCH_MESSAGE. The root is never silently
 * repaired on the beneficiary side: the proof must be bound to the root the verifier checks,
 * and only the issuer may change that root.
 */
export async function checkCohortRoot(policyId: number, localRoot: string): Promise<RootCheckResult> {
  const policy = await readPolicyOnChain(policyId);
  return {
    matches: BigInt(policy.cohortRoot) === BigInt(localRoot),
    onChainRoot: policy.cohortRoot,
    localRoot,
    policy,
  };
}

async function getWalletClient() {
  if (typeof window === 'undefined' || !(window as any).ethereum) {
    throw new Error('A browser wallet (MetaMask) is required to submit on-chain transactions.');
  }

  const walletClient = createWalletClient({
    chain: ACTIVE_CHAIN,
    transport: custom((window as any).ethereum),
  });

  const [account] = await walletClient.requestAddresses();
  if (!account) throw new Error('No wallet account authorised. Unlock MetaMask and try again.');

  try {
    await walletClient.switchChain({ id: ACTIVE_CHAIN.id });
  } catch (error: any) {
    if (error?.code === 4902 || error?.message?.includes('Unrecognized chain ID')) {
      await (window as any).ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [
          IS_LOCAL_CHAIN
            ? {
                chainId: '0x7a69',
                chainName: 'Anvil Local',
                nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                rpcUrls: ['http://127.0.0.1:8545'],
              }
            : {
                chainId: '0x14a34',
                chainName: 'Base Sepolia Testnet',
                nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                rpcUrls: ['https://base-sepolia-rpc.publicnode.com'],
                blockExplorerUrls: ['https://sepolia.basescan.org'],
              },
        ],
      });
    } else {
      throw error;
    }
  }

  // Re-read after the switch so the returned account is definitely on the target chain.
  const currentChainId = await walletClient.getChainId();
  if (currentChainId !== ACTIVE_CHAIN.id) {
    throw new Error(
      `Wallet is on chain ${currentChainId} but this deployment targets ${CHAIN_LABEL}. Switch networks and retry.`
    );
  }

  return { walletClient, account };
}

/**
 * Submit a real Groth16 proof to AegisAid.claimAid.
 *
 * Re-checks the cohort root immediately before signing (the root may have been rotated while
 * the proof was being generated) and aborts with ROOT_MISMATCH_MESSAGE rather than sending a
 * transaction that is guaranteed to revert. Returns the real transaction hash; there is no
 * simulated or synthesised hash path.
 *
 * Also re-checks tauQ soundness here, not just in the UI: this is the single function that turns
 * a proof into a transaction, so it is the one place a bypass cannot route around.
 */
export async function submitClaimToContract(
  policyId: number,
  proof: Groth16Proof,
  publicSignals: string[]
): Promise<string> {
  const { a, b, c, input } = formatProofForSolidity(proof, publicSignals);

  const rootCheck = await checkCohortRoot(policyId, publicSignals[1]);
  if (!rootCheck.matches) {
    throw new Error(ROOT_MISMATCH_MESSAGE);
  }

  if (rootCheck.policy.tauQUnsound) {
    throw new Error(tauQUnsoundMessage(policyId, rootCheck.policy.tauQ));
  }

  // The proof's own tauQ signal must equal the policy's. The contract enforces this too, but
  // catching it here keeps a mismatch from being reported to the user as an opaque revert.
  if (input[4] !== rootCheck.policy.tauQ) {
    throw new Error(
      `Proof was generated for tauQ ${input[4].toString()} but policy #${policyId} enforces ` +
        `${rootCheck.policy.tauQ.toString()}. Regenerate the proof against the current policy.`
    );
  }

  const { walletClient, account } = await getWalletClient();

  return walletClient.writeContract({
    address: AEGIS_AID_ADDRESS,
    abi: AEGIS_AID_ABI,
    functionName: 'claimAid',
    args: [BigInt(policyId), a, b, c, input],
    account,
    chain: ACTIVE_CHAIN,
  });
}

/**
 * Issuer action: publish a new cohort root for an EXISTING policy.
 *
 * Used only by the authority dashboard. Refuses IDs with no PolicyCreated event, because the
 * deployed contract will happily write a root into a slot that was never initialised.
 */
export async function publishCohortRoot(policyId: number, newRoot: string): Promise<string> {
  const createdIds = await discoverPolicyIds();
  if (!createdIds.includes(policyId)) {
    throw new Error(
      `Policy #${policyId} has never been created on ${CHAIN_LABEL}. Create the policy before publishing a root.`
    );
  }

  const { walletClient, account } = await getWalletClient();
  const authorised = await checkIsIssuer(account);
  if (!authorised) {
    throw new Error(`Connected account ${account} is not an authorised issuer on ${CHAIN_LABEL}.`);
  }

  return walletClient.writeContract({
    address: AEGIS_AID_ADDRESS,
    abi: AEGIS_AID_ABI,
    functionName: 'updateCohortRoot',
    args: [BigInt(policyId), newRoot as `0x${string}`],
    account,
    chain: ACTIVE_CHAIN,
  });
}

export interface CreatePolicyParams {
  policyId: number;
  cohortRoot: string;
  tauQ: bigint;
  modelHash: string;
  epoch: number;
  allocation: bigint;
  totalUnits: bigint;
}

/** Issuer action: create a policy. */
export async function createPolicyOnChain(p: CreatePolicyParams): Promise<string> {
  // Enforced client-side as well as in the contract, because the deployed Base Sepolia bytecode
  // has no tauQ bound: without this, the dashboard could still stage a policy that accepts any
  // face. Fail before the wallet prompt so the operator sees why, not a bare revert.
  if (!isTauQSound(p.tauQ)) {
    throw new Error(
      `tauQ ${p.tauQ.toString()} is outside the sound range [${MIN_TAU_Q}, ${MAX_TAU_Q}]. ` +
        'Outside that range the in-circuit comparator can be made to accept any face. ' +
        'Set tauQ = round(cosine × 127²) with cosine in (0, 1].'
    );
  }
  if (p.allocation <= 0n) {
    throw new Error('allocation must be greater than 0; a zero allocation burns a nullifier and pays nothing.');
  }
  if (p.totalUnits < p.allocation) {
    throw new Error('totalUnits must be at least allocation, or the first claim reverts immediately.');
  }

  const { walletClient, account } = await getWalletClient();
  const authorised = await checkIsIssuer(account);
  if (!authorised) {
    throw new Error(`Connected account ${account} is not an authorised issuer on ${CHAIN_LABEL}.`);
  }

  return walletClient.writeContract({
    address: AEGIS_AID_ADDRESS,
    abi: AEGIS_AID_ABI,
    functionName: 'createPolicy',
    args: [
      BigInt(p.policyId),
      p.cohortRoot as `0x${string}`,
      p.tauQ,
      p.modelHash as `0x${string}`,
      BigInt(p.epoch),
      p.allocation,
      p.totalUnits,
    ],
    account,
    chain: ACTIVE_CHAIN,
  });
}

/** Issuer action: activate or deactivate a policy. */
export async function setPolicyActiveOnChain(policyId: number, active: boolean): Promise<string> {
  const { walletClient, account } = await getWalletClient();
  const authorised = await checkIsIssuer(account);
  if (!authorised) {
    throw new Error(`Connected account ${account} is not an authorised issuer on ${CHAIN_LABEL}.`);
  }

  return walletClient.writeContract({
    address: AEGIS_AID_ADDRESS,
    abi: AEGIS_AID_ABI,
    functionName: 'setPolicyActive',
    args: [BigInt(policyId), active],
    account,
    chain: ACTIVE_CHAIN,
  });
}
