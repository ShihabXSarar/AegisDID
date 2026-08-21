/**
 * AegisDID — READ-ONLY on-chain audit of the deployed Base Sepolia contracts.
 *
 * Contains NO private keys and performs NO writes. Safe to commit and to run
 * from any machine. Used to verify deployed state during integration review.
 *
 *   node tools/chain_audit.mjs
 */
import { createPublicClient, http, parseAbi } from '../web/node_modules/viem/_esm/index.js';
import { baseSepolia } from '../web/node_modules/viem/_esm/chains/index.js';

const RPC_URL = process.env.RPC_URL || 'https://base-sepolia-rpc.publicnode.com';
const AEGIS_AID = process.env.AEGIS_AID_ADDRESS || '0xAB2fa997c25B0B02E635052166d0192b5Eab5765';
const VERIFIER = '0x05ea2aDa4aB61F46b247B7b6c6943D74e99A06bd';

const ABI = parseAbi([
  'function admin() external view returns (address)',
  'function verifier() external view returns (address)',
  'function isIssuer(address) external view returns (bool)',
  'function policies(uint256) external view returns (bytes32 cohortRoot, uint256 tauQ, bytes32 modelHash, uint64 epoch, uint128 allocation, uint128 remaining, bool active)',
  'function nullifierUsed(uint256, uint256) external view returns (bool)',
  'event PolicyCreated(uint256 indexed policyId, bytes32 cohortRoot, uint256 tauQ, bytes32 modelHash, uint64 epoch, uint128 allocation, uint128 totalUnits)',
  'event CohortRootUpdated(uint256 indexed policyId, bytes32 oldRoot, bytes32 newRoot)',
  'event AidClaimed(uint256 indexed policyId, uint256 indexed nullifier, uint128 amount)',
  'event IssuerUpdated(address indexed issuer, bool allowed)',
]);

const client = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) });

function fmtPolicy(id, p) {
  const [cohortRoot, tauQ, modelHash, epoch, allocation, remaining, active] = p;
  const created = active || cohortRoot !== `0x${'0'.repeat(64)}` || tauQ !== 0n;
  return {
    policyId: id,
    exists: created,
    active,
    cohortRoot,
    tauQ: tauQ.toString(),
    tauCosine: (Number(tauQ) / (127 * 127)).toFixed(4),
    modelHash,
    epoch: Number(epoch),
    allocation: allocation.toString(),
    remaining: remaining.toString(),
  };
}

async function main() {
  console.log('RPC:', RPC_URL);
  const chainId = await client.getChainId();
  const latest = await client.getBlockNumber();
  console.log('chainId:', chainId, '(expected 84532)');
  console.log('latest block:', latest.toString());

  const verifierCode = await client.getCode({ address: VERIFIER });
  const aidCode = await client.getCode({ address: AEGIS_AID });
  console.log('\n--- CONTRACT CODE PRESENCE ---');
  console.log('Groth16Verifier', VERIFIER, 'bytecode bytes:', verifierCode ? (verifierCode.length - 2) / 2 : 0);
  console.log('AegisAid       ', AEGIS_AID, 'bytecode bytes:', aidCode ? (aidCode.length - 2) / 2 : 0);

  console.log('\n--- ADMIN / VERIFIER WIRING ---');
  const admin = await client.readContract({ address: AEGIS_AID, abi: ABI, functionName: 'admin' });
  const wiredVerifier = await client.readContract({ address: AEGIS_AID, abi: ABI, functionName: 'verifier' });
  console.log('admin:', admin);
  console.log('verifier wired in AegisAid:', wiredVerifier);
  console.log('verifier matches documented address:', wiredVerifier.toLowerCase() === VERIFIER.toLowerCase());

  const probe = process.env.PROBE_ADDRESSES
    ? process.env.PROBE_ADDRESSES.split(',')
    : [admin, '0xcB2d8FaBEBB0b4f47F4Ea450C61643673d263744'];
  console.log('\n--- ISSUER STATUS ---');
  for (const a of probe) {
    const ok = await client.readContract({ address: AEGIS_AID, abi: ABI, functionName: 'isIssuer', args: [a] });
    console.log(`isIssuer(${a}) = ${ok}`);
  }

  console.log('\n--- POLICY SLOTS 100..110 ---');
  for (let id = 100; id <= 110; id++) {
    const p = await client.readContract({ address: AEGIS_AID, abi: ABI, functionName: 'policies', args: [BigInt(id)] });
    const info = fmtPolicy(id, p);
    if (info.exists) console.log(JSON.stringify(info));
  }

  console.log('\n--- EVENT HISTORY (scanning from deployment block) ---');
  const DEPLOY = 45651880n;
  const CHUNK = 45000n;
  const found = { PolicyCreated: [], CohortRootUpdated: [], AidClaimed: [], IssuerUpdated: [] };
  let firstEventBlock = null;
  let calls = 0;
  for (let from = DEPLOY; from <= latest; from += CHUNK + 1n) {
    const to = from + CHUNK > latest ? latest : from + CHUNK;
    calls++;
    const logs = await client.getLogs({ address: AEGIS_AID, fromBlock: from, toBlock: to });
    for (const l of logs) {
      // decode against each known event
      for (const ev of ['PolicyCreated', 'CohortRootUpdated', 'AidClaimed', 'IssuerUpdated']) {
        try {
          const decoded = await client.getLogs({
            address: AEGIS_AID,
            event: ABI.find((x) => x.type === 'event' && x.name === ev),
            fromBlock: l.blockNumber,
            toBlock: l.blockNumber,
          });
          for (const d of decoded) {
            if (d.logIndex === l.logIndex) {
              if (firstEventBlock === null) firstEventBlock = l.blockNumber;
              found[ev].push({ block: Number(d.blockNumber), tx: d.transactionHash, args: JSON.parse(JSON.stringify(d.args, (k, v) => (typeof v === 'bigint' ? v.toString() : v))) });
            }
          }
        } catch { /* not this event */ }
      }
    }
  }
  console.log(`getLogs chunk calls needed to cover ${DEPLOY}..${latest}: ${calls}`);
  console.log('first AegisAid event at block:', firstEventBlock === null ? 'none' : firstEventBlock.toString());
  for (const ev of Object.keys(found)) {
    console.log(`\n${ev}: ${found[ev].length}`);
    for (const e of found[ev]) console.log('  ', JSON.stringify(e));
  }
}

main().catch((e) => {
  console.error('AUDIT FAILED:', e.shortMessage || e.message);
  process.exit(1);
});
