'use client';

import { useState, useEffect, useCallback } from 'react';
import { parseAbi } from 'viem';
import {
  AEGIS_AID_ADDRESS,
  AEGIS_AID_ABI,
  DEPLOYMENT_BLOCK,
  getPublicClient,
  getExplorerTxUrl,
  fetchAllPolicies,
  checkIsIssuer,
  createPolicyOnChain,
  publishCohortRoot,
  setPolicyActiveOnChain,
  PolicyInfo,
  CHAIN_LABEL,
  ACTIVE_CHAIN,
  IS_LOCAL_CHAIN,
  isTauQSound,
  tauQAdequacyWarning,
  TAU_Q_MEASURED_FAR_100,
  MIN_TAU_Q,
  MAX_TAU_Q,
} from '../../lib/chain/client';
import { DEFAULT_MODEL_HASH, DEFAULT_MODEL_HASH_BYTES32 } from '../../lib/ml/commitments';
import {
  Shield,
  CheckCircle2,
  AlertTriangle,
  Users,
  History,
  Plus,
  RefreshCw,
  Ban,
  KeyRound,
  Power,
} from 'lucide-react';

const ZERO_ROOT = '0x' + '0'.repeat(64);

interface ClaimEvent {
  policyId?: string;
  nullifier?: string;
  amount?: string;
  txHash?: string;
  block?: string;
}

type StatusKind = 'success' | 'error' | 'info';

export default function DashboardPage() {
  const [account, setAccount] = useState<string | null>(null);
  const [isIssuer, setIsIssuer] = useState<boolean | null>(null);
  const [adminAddress, setAdminAddress] = useState<string>('');
  const [verifierAddress, setVerifierAddress] = useState<string>('');
  const [latestRoot, setLatestRoot] = useState<string>('');
  const [enrollmentCount, setEnrollmentCount] = useState<number | null>(null);
  const [events, setEvents] = useState<ClaimEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ type: StatusKind; message: string } | null>(null);
  const [policies, setPolicies] = useState<PolicyInfo[]>([]);
  const [loadingPolicies, setLoadingPolicies] = useState(true);
  const [policyLoadError, setPolicyLoadError] = useState<string>('');
  const [selectedPolicyId, setSelectedPolicyId] = useState<number | null>(null);

  // Create Policy form state
  const [createPolicyId, setCreatePolicyId] = useState<string>('101');
  // The measured FAR ~= 1e-3 / TAR 91.3% operating point (cosine 0.929), from docs/RESULTS.md §5.
  // Do NOT "simplify" this to a round cosine: 8065 (cosine 0.50) was the previous default and has a
  // MEASURED FAR of 100% on this model — 450,368 of 450,368 impostor pairs accepted (RESULTS.md §6).
  // A policy created with that default enforces no biometric check while producing valid proofs.
  const [createTauQ, setCreateTauQ] = useState<string>('14984');
  const [createEpoch, setCreateEpoch] = useState<string>('1');
  const [createAllocation, setCreateAllocation] = useState<string>('50');
  const [createTotalUnits, setCreateTotalUnits] = useState<string>('5000');

  const fetchOnChainPolicies = useCallback(async () => {
    setLoadingPolicies(true);
    setPolicyLoadError('');
    try {
      const all = await fetchAllPolicies();
      setPolicies(all);
      setSelectedPolicyId((prev) => {
        if (prev !== null && all.some((p) => p.policyId === prev)) return prev;
        return all[0]?.policyId ?? null;
      });
    } catch (e) {
      console.error('Failed to fetch on-chain policies', e);
      setPolicyLoadError(
        `Could not read policies from ${CHAIN_LABEL}: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setLoadingPolicies(false);
    }
  }, []);

  const fetchContractRoles = useCallback(async () => {
    try {
      const publicClient = getPublicClient();
      const [admin, verifier] = await Promise.all([
        publicClient.readContract({
          address: AEGIS_AID_ADDRESS,
          abi: AEGIS_AID_ABI,
          functionName: 'admin',
        }),
        publicClient.readContract({
          address: AEGIS_AID_ADDRESS,
          abi: AEGIS_AID_ABI,
          functionName: 'verifier',
        }),
      ]);
      setAdminAddress(admin as string);
      setVerifierAddress(verifier as string);
    } catch (e) {
      console.error('Failed to read contract roles', e);
    }
  }, []);

  const fetchLatestRoot = useCallback(async () => {
    try {
      const res = await fetch('/api/enroll');
      if (!res.ok) {
        setStatus({
          type: 'error',
          message: `The authority enrollment service returned HTTP ${res.status}. Cannot read the staged cohort root.`,
        });
        return;
      }
      const data = await res.json();
      const rootBigInt = BigInt(data.root);
      setLatestRoot('0x' + rootBigInt.toString(16).padStart(64, '0'));
      if (typeof data.count === 'number') setEnrollmentCount(data.count);
    } catch (e) {
      console.error('Failed to fetch latest root', e);
      setStatus({
        type: 'error',
        message: `Could not reach the authority enrollment service: ${
          e instanceof Error ? e.message : String(e)
        }`,
      });
    }
  }, []);

  const fetchEvents = useCallback(async () => {
    try {
      const publicClient = getPublicClient();
      const latestBlock = await publicClient.getBlockNumber();
      const eventAbi = parseAbi([
        'event AidClaimed(uint256 indexed policyId, uint256 indexed nullifier, uint128 amount)',
      ])[0];

      const allLogs = [];
      const CHUNK = 45000n;
      let from = DEPLOYMENT_BLOCK;
      while (from <= latestBlock) {
        const to = from + CHUNK > latestBlock ? latestBlock : from + CHUNK;
        const logs = await publicClient.getLogs({
          address: AEGIS_AID_ADDRESS,
          event: eventAbi,
          fromBlock: from,
          toBlock: to,
        });
        allLogs.push(...logs);
        from = to + 1n;
      }

      setEvents(
        allLogs
          .map((l) => ({
            policyId: l.args.policyId?.toString(),
            nullifier: l.args.nullifier?.toString(),
            amount: l.args.amount?.toString(),
            txHash: l.transactionHash,
            block: l.blockNumber?.toString(),
          }))
          .reverse()
      );
    } catch (e) {
      console.error('Failed to fetch events', e);
    }
  }, []);

  useEffect(() => {
    fetchLatestRoot();
    fetchEvents();
    fetchOnChainPolicies();
    fetchContractRoles();
  }, [fetchLatestRoot, fetchEvents, fetchOnChainPolicies, fetchContractRoles]);

  async function connectWallet() {
    if (typeof window === 'undefined' || !(window as any).ethereum) {
      setStatus({
        type: 'error',
        message: 'A browser wallet (MetaMask) is required to perform issuer actions.',
      });
      return;
    }
    try {
      const accounts: string[] = await (window as any).ethereum.request({
        method: 'eth_requestAccounts',
      });
      const addr = accounts?.[0];
      if (!addr) throw new Error('No account authorised.');

      setAccount(addr);

      // The only honest authorisation signal is the contract's own isIssuer mapping.
      const authorised = await checkIsIssuer(addr as `0x${string}`);
      setIsIssuer(authorised);

      setStatus(
        authorised
          ? {
              type: 'success',
              message: `Connected ${addr} — contract confirms isIssuer = true on ${CHAIN_LABEL}.`,
            }
          : {
              type: 'error',
              message: `Connected ${addr}, but AegisAid.isIssuer(${addr}) is FALSE on ${CHAIN_LABEL}. Every issuer transaction from this account will revert with NotIssuer. The contract admin must call setIssuer first.`,
            }
      );
    } catch (e: any) {
      setStatus({ type: 'error', message: e?.shortMessage || e?.message || String(e) });
    }
  }

  async function withTx(
    label: string,
    action: () => Promise<string>,
    after?: () => Promise<void>
  ) {
    setLoading(true);
    setStatus({ type: 'info', message: `${label}: requesting wallet signature…` });
    try {
      const hash = await action();
      setStatus({ type: 'info', message: `${label}: submitted ${hash}. Waiting for a receipt…` });

      const publicClient = getPublicClient();
      const receipt = await publicClient.waitForTransactionReceipt({ hash: hash as `0x${string}` });

      if (receipt.status === 'success') {
        setStatus({
          type: 'success',
          message: `${label} confirmed in block ${receipt.blockNumber}. Tx ${hash}`,
        });
        if (after) await after();
      } else {
        // Never report a reverted transaction as a success.
        setStatus({
          type: 'error',
          message: `${label} REVERTED on-chain (status ${receipt.status}). Tx ${hash} — no state changed.`,
        });
      }
    } catch (e: any) {
      const msg = e?.shortMessage || e?.message || String(e);
      if (msg.includes('PolicyAlreadyExists')) {
        setStatus({
          type: 'error',
          message: `Reverted: policy #${createPolicyId} already exists on ${CHAIN_LABEL}. Policy IDs are immutable once created.`,
        });
      } else if (msg.includes('NotIssuer')) {
        setStatus({
          type: 'error',
          message: `Reverted with NotIssuer: ${account} is not an authorised issuer on ${CHAIN_LABEL}.`,
        });
      } else if (msg.includes('User rejected') || msg.includes('user rejected')) {
        setStatus({ type: 'error', message: `${label} cancelled in the wallet. Nothing was sent.` });
      } else {
        setStatus({ type: 'error', message: `${label} failed: ${msg}` });
      }
    } finally {
      setLoading(false);
    }
  }

  function handleCreatePolicy() {
    if (!account) {
      setStatus({ type: 'error', message: 'Connect an issuer wallet first.' });
      return;
    }
    const id = Number(createPolicyId);
    if (!Number.isInteger(id) || id <= 0) {
      setStatus({ type: 'error', message: 'Policy ID must be a positive integer.' });
      return;
    }
    const tauQ = Number(createTauQ);
    if (!Number.isInteger(tauQ) || !isTauQSound(tauQ)) {
      setStatus({
        type: 'error',
        message:
          `tauQ must be an integer in [${MIN_TAU_Q}, ${MAX_TAU_Q}] — it is round(cosine × 127²). ` +
          'Outside that range the in-circuit comparator can be made to accept any face, so ' +
          'AegisAid rejects it (error InvalidTauQ).',
      });
      return;
    }

    // A policy created with the zero root is not claimable until a root is published. Say so
    // rather than letting the operator believe the policy is ready.
    const cohortRoot = latestRoot || ZERO_ROOT;

    withTx(
      `createPolicy #${id}`,
      () =>
        createPolicyOnChain({
          policyId: id,
          cohortRoot,
          tauQ: BigInt(tauQ),
          modelHash: DEFAULT_MODEL_HASH_BYTES32,
          epoch: Number(createEpoch),
          allocation: BigInt(createAllocation),
          totalUnits: BigInt(createTotalUnits),
        }),
      async () => {
        await fetchOnChainPolicies();
        if (cohortRoot === ZERO_ROOT) {
          setStatus({
            type: 'info',
            message: `Policy #${id} created, but with the ZERO cohort root — no beneficiary can prove membership yet. Enroll beneficiaries, then publish the root.`,
          });
        } else if (enrollmentCount === 0) {
          // Non-zero but still empty: see the empty-tree note in handlePublishRoot().
          setStatus({
            type: 'info',
            message: `Policy #${id} created with the EMPTY-TREE root (the authority has zero enrollments). The root is non-zero and looks valid, but the cohort contains nobody. Enroll beneficiaries, then publish the updated root.`,
          });
        }
      }
    );
  }

  function handlePublishRoot() {
    if (!account) {
      setStatus({ type: 'error', message: 'Connect an issuer wallet first.' });
      return;
    }
    if (!latestRoot) {
      setStatus({
        type: 'error',
        message: 'No staged root available from the authority service — nothing to publish.',
      });
      return;
    }
    if (latestRoot === ZERO_ROOT) {
      setStatus({
        type: 'error',
        message:
          'The staged root is all zeroes. That is the "no root published" sentinel the contract ' +
          'starts with, not a real tree root, so publishing it would leave the policy unclaimable.',
      });
      return;
    }
    /**
     * Distinct from the check above. An EMPTY depth-20 tree has a perfectly valid, NON-zero
     * root (the zero-hash ladder top: 15019797232609675441998260052101280400536945603062888308240081994073687793470),
     * so a zero-root check does not catch it. Publishing that root advertises a cohort that
     * contains nobody: no beneficiary can produce an inclusion path, and every claim fails with
     * an opaque constraint error rather than an explicable reason.
     */
    if (enrollmentCount === 0) {
      setStatus({
        type: 'error',
        message:
          'The authority has zero enrollments, so the staged root is the empty-tree root. It is ' +
          'non-zero and looks valid, but no beneficiary is in it and every claim would fail. ' +
          'Enroll at least one beneficiary before publishing.',
      });
      return;
    }
    if (selectedPolicyId === null) {
      setStatus({
        type: 'error',
        message: 'No created policy selected. Create a policy before publishing a root.',
      });
      return;
    }

    const targetPolicyId: number = selectedPolicyId;
    const target = policies.find((p) => p.policyId === targetPolicyId);
    if (target) {
      const modelOk = (() => {
        try {
          return BigInt(target.modelHash) === DEFAULT_MODEL_HASH;
        } catch {
          return false;
        }
      })();
      if (!modelOk) {
        setStatus({
          type: 'error',
          message: `Policy #${targetPolicyId} is bound to modelHash ${target.modelHash}, which is not the model this authority is running (${DEFAULT_MODEL_HASH_BYTES32}). Publishing this root would still leave every claim failing. Create a policy for the current model instead.`,
        });
        return;
      }
    }

    withTx(
      `updateCohortRoot #${targetPolicyId}`,
      () => publishCohortRoot(targetPolicyId, latestRoot),
      fetchOnChainPolicies
    );
  }

  function handleToggleActive(policyId: number, next: boolean) {
    if (!account) {
      setStatus({ type: 'error', message: 'Connect an issuer wallet first.' });
      return;
    }
    withTx(
      `setPolicyActive #${policyId} → ${next}`,
      () => setPolicyActiveOnChain(policyId, next),
      fetchOnChainPolicies
    );
  }

  const cosineOfTauQ = Number(createTauQ) / (127 * 127);
  const tauQEntrySound =
    Number.isInteger(Number(createTauQ)) && isTauQSound(Number(createTauQ));
  // Adequacy, not soundness. The old hint here flagged only cosine < 0.1, which called the
  // FAR-100% value 8065 (cosine 0.50) acceptable. Now driven by the measured data.
  const tauQWarning = tauQEntrySound ? tauQAdequacyWarning(Number(createTauQ)) : null;

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div className="text-center space-y-2">
        <div className="inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-full bg-purple-500/15 border border-purple-500/30 text-purple-300 text-xs font-bold uppercase tracking-wider">
          <KeyRound className="w-3.5 h-3.5" />
          <span>Authority Console</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-white">Issuer Dashboard</h1>
        <p className="text-xs sm:text-sm text-slate-400 max-w-xl mx-auto">
          Create relief policies, publish cohort Merkle roots, and audit every disbursement on{' '}
          {CHAIN_LABEL}. All writes are signed by your own wallet — this app holds no keys.
        </p>
      </div>

      {status && (
        <div
          className={`p-4 rounded-2xl border text-xs sm:text-sm flex items-start gap-3 break-words ${
            status.type === 'error'
              ? 'bg-red-950/50 border-red-500/30 text-red-300'
              : status.type === 'success'
                ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
                : 'bg-indigo-950/40 border-indigo-500/30 text-indigo-200'
          }`}
        >
          {status.type === 'error' ? (
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5 text-red-400" />
          ) : status.type === 'success' ? (
            <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5 text-emerald-400" />
          ) : (
            <RefreshCw className="w-5 h-5 shrink-0 mt-0.5 text-indigo-400 animate-spin" />
          )}
          <div className="flex-1 leading-relaxed font-mono text-[11px] sm:text-xs">
            {status.message}
          </div>
        </div>
      )}

      {/* Connection + role panel */}
      <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6 backdrop-blur-xl space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-lg font-bold text-white">Wallet &amp; on-chain roles</h2>
            <p className="text-xs text-slate-400">
              Authorisation is read from the contract, not assumed from connecting.
            </p>
          </div>
          <button
            onClick={connectWallet}
            className="px-6 py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-lg shadow-indigo-500/20 shrink-0"
          >
            {account ? 'Reconnect / Re-check role' : 'Connect Wallet'}
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[11px] font-mono">
          <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 break-all">
            <div className="text-slate-500 mb-1">connected account</div>
            <div className="text-slate-200">{account || 'not connected'}</div>
          </div>
          <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 break-all">
            <div className="text-slate-500 mb-1">isIssuer(account)</div>
            <div
              className={
                isIssuer === null
                  ? 'text-slate-400'
                  : isIssuer
                    ? 'text-emerald-400'
                    : 'text-red-400'
              }
            >
              {isIssuer === null ? 'not checked' : String(isIssuer)}
            </div>
          </div>
          <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 break-all">
            <div className="text-slate-500 mb-1">AegisAid.admin()</div>
            <div className="text-slate-200">{adminAddress || '…'}</div>
          </div>
          <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 break-all">
            <div className="text-slate-500 mb-1">AegisAid.verifier()</div>
            <div className="text-slate-200">{verifierAddress || '…'}</div>
          </div>
          <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 break-all sm:col-span-2">
            <div className="text-slate-500 mb-1">
              AegisAid @ {CHAIN_LABEL} (chainId {ACTIVE_CHAIN.id})
            </div>
            <div className="text-slate-200">{AEGIS_AID_ADDRESS}</div>
          </div>
          <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800 break-all sm:col-span-2">
            <div className="text-slate-500 mb-1">
              authority modelHash (keccak over web/public/models, mod r)
            </div>
            <div className="text-slate-200">{DEFAULT_MODEL_HASH_BYTES32}</div>
          </div>
        </div>

        {isIssuer === false && (
          <div className="p-3 rounded-xl bg-amber-950/40 border border-amber-500/30 text-[11px] text-amber-200 flex items-start gap-2">
            <Ban className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
            <span className="leading-relaxed">
              This account is not an issuer. The buttons below are left enabled deliberately so you
              can observe the contract reject the call — they will revert with{' '}
              <code>NotIssuer</code> rather than silently appear to work.
            </span>
          </div>
        )}
      </div>

      {/* On-Chain Policy State */}
      <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 backdrop-blur-xl overflow-hidden">
        <div className="border-b border-slate-800 p-6 flex items-center justify-between gap-4">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <Shield className="h-4 w-4 text-emerald-400" />
            Created policies on {CHAIN_LABEL}
          </h3>
          <button
            onClick={fetchOnChainPolicies}
            className="text-xs text-emerald-400 hover:text-emerald-300 font-bold flex items-center gap-1.5 shrink-0"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
        <div className="p-6">
          {loadingPolicies ? (
            <div className="text-center text-slate-400 py-8 animate-pulse text-sm">
              Scanning PolicyCreated logs from block {DEPLOYMENT_BLOCK.toString()}…
            </div>
          ) : policyLoadError ? (
            <div className="p-4 rounded-2xl bg-red-950/40 border border-red-500/30 text-xs text-red-300 font-mono break-all">
              {policyLoadError}
            </div>
          ) : policies.length === 0 ? (
            <div className="text-center text-slate-400 py-8 text-sm space-y-2">
              <AlertTriangle className="h-7 w-7 mx-auto text-amber-400" />
              <p className="text-xs max-w-md mx-auto leading-relaxed">
                No <code>PolicyCreated</code> event exists for this contract. Nothing has been
                created yet — policy IDs are discovered from events only, never guessed.
              </p>
            </div>
          ) : (
            <div className="space-y-3.5">
              {policies.map((policy) => {
                const modelOk = (() => {
                  try {
                    return BigInt(policy.modelHash) === DEFAULT_MODEL_HASH;
                  } catch {
                    return false;
                  }
                })();
                // Adequacy of an already-created threshold. The previous heuristic here was
                // `tauQ < 1000`, which showed no warning at all for tauQ = 8065 — the value
                // measured at FAR 100% (docs/RESULTS.md §6). Measured floor instead of a guess.
                const tauQAdvice = policy.tauQUnsound
                  ? null
                  : tauQAdequacyWarning(Number(policy.tauQ));
                return (
                  <div
                    key={policy.policyId}
                    className={`p-4 rounded-2xl border ${
                      policy.active
                        ? 'border-emerald-500/40 bg-emerald-950/20'
                        : 'border-slate-800 bg-slate-950/50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <span className="font-bold text-white text-sm">
                        Policy #{policy.policyId}
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full border ${
                            policy.active
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                              : 'bg-red-500/10 text-red-400 border-red-500/30'
                          }`}
                        >
                          {policy.active ? 'ACTIVE' : 'INACTIVE'}
                        </span>
                        <button
                          onClick={() => handleToggleActive(policy.policyId, !policy.active)}
                          disabled={loading}
                          className="text-[10px] font-bold px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 inline-flex items-center gap-1"
                        >
                          <Power className="w-3 h-3" />
                          {policy.active ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[11px] text-slate-400 font-mono break-all">
                      <div className="sm:col-span-2">
                        cohortRoot: <span className="text-slate-200">{policy.cohortRoot}</span>
                      </div>
                      <div className="sm:col-span-2">
                        modelHash: <span className="text-slate-200">{policy.modelHash}</span>
                      </div>
                      <div>
                        tauQ: <span className="text-slate-200">{policy.tauQ.toString()}</span>{' '}
                        <span className="text-slate-500">
                          {policy.tauQUnsound
                            ? '(out of range — not a valid threshold)'
                            : `(cosine ≈ ${(Number(policy.tauQ) / (127 * 127)).toFixed(4)})`}
                        </span>
                      </div>
                      <div>
                        epoch: <span className="text-slate-200">{policy.epoch}</span>
                      </div>
                      <div>
                        allocation:{' '}
                        <span className="text-slate-200">{policy.allocation.toString()}</span>
                      </div>
                      <div>
                        remaining:{' '}
                        <span className="text-slate-200">{policy.remaining.toString()}</span>
                      </div>
                    </div>

                    {(policy.rootUnpublished ||
                      !modelOk ||
                      policy.tauQUnsound ||
                      tauQAdvice) && (
                      <div className="mt-3 space-y-1.5">
                        {policy.rootUnpublished && (
                          <div className="text-[11px] text-amber-300 bg-amber-950/40 border border-amber-500/25 rounded-xl px-3 py-2 leading-relaxed">
                            Cohort root is zero — no beneficiary can produce a valid inclusion proof.
                            Publish a root below.
                          </div>
                        )}
                        {!modelOk && (
                          <div className="text-[11px] text-amber-300 bg-amber-950/40 border border-amber-500/25 rounded-xl px-3 py-2 leading-relaxed">
                            modelHash does not match this authority&apos;s model. Commitments enrolled
                            here can never satisfy this policy.
                          </div>
                        )}
                        {policy.tauQUnsound ? (
                          <div className="text-[11px] text-red-300 bg-red-950/40 border border-red-500/30 rounded-xl px-3 py-2 leading-relaxed">
                            SECURITY — UNSOUND THRESHOLD: tauQ = {policy.tauQ.toString()} is outside
                            [{MIN_TAU_Q}, {MAX_TAU_Q}]. The circuit compares{' '}
                            <span className="font-mono">dot + 2²¹ ≥ tauQ + 2²¹</span> with a 24-bit
                            comparator; outside that range the comparison is not sound and a
                            non-matching face can produce a valid proof (measured — see
                            web/scripts/tauq_bound_probe.mts). The beneficiary app refuses to claim
                            against this policy. tauQ cannot be edited after creation, so this policy
                            must be deactivated and re-created under a new ID.
                          </div>
                        ) : (
                          tauQAdvice && (
                            <div
                              className={`text-[11px] rounded-xl px-3 py-2 leading-relaxed ${
                                Number(policy.tauQ) <= TAU_Q_MEASURED_FAR_100
                                  ? 'text-red-300 bg-red-950/40 border border-red-500/30'
                                  : 'text-amber-300 bg-amber-950/40 border border-amber-500/25'
                              }`}
                            >
                              {Number(policy.tauQ) <= TAU_Q_MEASURED_FAR_100 ? 'SECURITY: ' : ''}
                              tauQ = {policy.tauQ.toString()} (cosine{' '}
                              {(Number(policy.tauQ) / (127 * 127)).toFixed(4)}) — {tauQAdvice}
                            </div>
                          )
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Create Policy */}
        <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 backdrop-blur-xl overflow-hidden">
          <div className="border-b border-slate-800 p-6">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Plus className="h-4 w-4 text-indigo-400" />
              Create policy on {CHAIN_LABEL}
            </h3>
          </div>
          <div className="p-6 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-[11px] font-bold text-slate-400 mb-1.5 uppercase tracking-wide">
                  Policy ID
                </span>
                <input
                  type="number"
                  value={createPolicyId}
                  onChange={(e) => setCreatePolicyId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl py-2.5 px-3 text-sm text-white font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-bold text-slate-400 mb-1.5 uppercase tracking-wide">
                  Epoch
                </span>
                <input
                  type="number"
                  value={createEpoch}
                  onChange={(e) => setCreateEpoch(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl py-2.5 px-3 text-sm text-white font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </label>
              <label className="block col-span-2">
                <span className="block text-[11px] font-bold text-slate-400 mb-1.5 uppercase tracking-wide">
                  tauQ = round(cosine × 127²) — valid range [{MIN_TAU_Q}, {MAX_TAU_Q}]
                </span>
                <input
                  type="number"
                  min={MIN_TAU_Q}
                  max={MAX_TAU_Q}
                  value={createTauQ}
                  onChange={(e) => setCreateTauQ(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl py-2.5 px-3 text-sm text-white font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <span
                  className={`block mt-1.5 text-[11px] font-mono ${
                    !tauQEntrySound
                      ? 'text-red-400'
                      : tauQWarning
                        ? 'text-amber-400'
                        : 'text-slate-500'
                  }`}
                >
                  {!tauQEntrySound
                    ? `⇒ out of range — AegisAid reverts with InvalidTauQ, and outside [${MIN_TAU_Q}, ${MAX_TAU_Q}] the in-circuit threshold is not enforceable at all`
                    : `⇒ cosine threshold ${cosineOfTauQ.toFixed(4)}${
                        tauQWarning ? ` — ${tauQWarning}` : ' — measured operating point'
                      }`}
                </span>
              </label>
              <label className="block">
                <span className="block text-[11px] font-bold text-slate-400 mb-1.5 uppercase tracking-wide">
                  Allocation / beneficiary
                </span>
                <input
                  type="number"
                  value={createAllocation}
                  onChange={(e) => setCreateAllocation(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl py-2.5 px-3 text-sm text-white font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </label>
              <label className="block">
                <span className="block text-[11px] font-bold text-slate-400 mb-1.5 uppercase tracking-wide">
                  Total units
                </span>
                <input
                  type="number"
                  value={createTotalUnits}
                  onChange={(e) => setCreateTotalUnits(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-xl py-2.5 px-3 text-sm text-white font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </label>
            </div>

            <div className="bg-slate-950/70 rounded-xl p-3 text-[11px] text-slate-400 space-y-1.5 font-mono border border-slate-800 break-all">
              <div>
                cohortRoot:{' '}
                <span className={latestRoot ? 'text-slate-200' : 'text-amber-400'}>
                  {latestRoot || '(none staged — will send the zero root)'}
                </span>
              </div>
              <div>
                modelHash: <span className="text-slate-200">{DEFAULT_MODEL_HASH_BYTES32}</span>
              </div>
            </div>

            <button
              onClick={handleCreatePolicy}
              disabled={loading || !account}
              className="w-full bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-3.5 rounded-2xl font-bold text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex justify-center items-center gap-2 shadow-lg shadow-indigo-500/20"
            >
              {loading && (
                <div className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
              )}
              Create Policy
            </button>
            <p className="text-[11px] text-slate-500 text-center leading-relaxed">
              Requires <code>isIssuer</code>. The receipt is awaited and a revert is reported as a
              failure, never as a success.
            </p>
          </div>
        </div>

        {/* Publish Cohort Root */}
        <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 backdrop-blur-xl overflow-hidden">
          <div className="border-b border-slate-800 p-6 flex items-center justify-between gap-4">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <Users className="h-4 w-4 text-blue-400" />
              Publish cohort root
            </h3>
            <button
              onClick={fetchLatestRoot}
              className="text-xs text-blue-400 hover:text-blue-300 font-bold shrink-0"
            >
              Refresh
            </button>
          </div>
          <div className="p-6 space-y-5">
            <div>
              <span className="block text-[11px] font-bold text-slate-400 mb-1.5 uppercase tracking-wide">
                Staged root from the authority tree
                {enrollmentCount !== null && ` · ${enrollmentCount} enrolled`}
              </span>
              <div className="bg-slate-950/70 font-mono text-[11px] p-3 rounded-xl border border-slate-800 break-all text-slate-200">
                {latestRoot || 'No root available from /api/enroll.'}
              </div>
            </div>

            <label className="block">
              <span className="block text-[11px] font-bold text-slate-400 mb-1.5 uppercase tracking-wide">
                Target policy (created policies only)
              </span>
              <select
                value={selectedPolicyId ?? ''}
                onChange={(e) => setSelectedPolicyId(e.target.value === '' ? null : Number(e.target.value))}
                disabled={policies.length === 0}
                className="w-full bg-slate-950 border border-slate-700 rounded-xl py-2.5 px-3 text-sm text-white font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              >
                {policies.length === 0 && <option value="">No created policies found</option>}
                {policies.map((p) => (
                  <option key={p.policyId} value={p.policyId}>
                    Policy #{p.policyId} {p.active ? '(active)' : '(inactive)'}
                  </option>
                ))}
              </select>
              <span className="block mt-1.5 text-[11px] text-slate-500 leading-relaxed">
                Only IDs with a <code>PolicyCreated</code> event are offered. The deployed contract
                will happily write a root into an uninitialised slot, which creates a policy that
                looks real but has no parameters.
              </span>
            </label>

            <button
              onClick={handlePublishRoot}
              disabled={loading || !latestRoot || selectedPolicyId === null}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white px-4 py-3.5 rounded-2xl font-bold text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex justify-center items-center gap-2 shadow-lg shadow-blue-500/20"
            >
              {loading && (
                <div className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
              )}
              Publish Root to {CHAIN_LABEL}
            </button>
            <p className="text-[11px] text-slate-500 text-center leading-relaxed">
              Beneficiaries can never publish a root. This is the only path, and it requires{' '}
              <code>isIssuer</code>.
            </p>
          </div>
        </div>
      </div>

      {/* Audit Log */}
      <div className="rounded-3xl border border-slate-800/80 bg-slate-900/70 backdrop-blur-xl overflow-hidden">
        <div className="border-b border-slate-800 p-6 flex items-center justify-between gap-4">
          <h3 className="text-base font-bold text-white flex items-center gap-2">
            <History className="h-4 w-4 text-purple-400" />
            Audit log · AidClaimed events ({events.length})
          </h3>
          <button
            onClick={fetchEvents}
            className="text-xs text-purple-400 hover:text-purple-300 font-bold shrink-0"
          >
            Refresh
          </button>
        </div>
        <div className="p-6 min-h-[180px]">
          {events.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-slate-400 space-y-2 py-8 text-center">
              <AlertTriangle className="h-7 w-7 text-amber-400" />
              <p className="text-sm font-medium text-slate-300">
                No AidClaimed events on {CHAIN_LABEL}
              </p>
              <p className="text-xs max-w-md leading-relaxed">
                No claim has ever been verified by this contract. This is the true on-chain state,
                not a loading failure.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {events.map((ev, i) => (
                <div
                  key={`${ev.txHash}-${i}`}
                  className="bg-slate-950/70 p-3.5 rounded-2xl border border-slate-800 text-sm"
                >
                  <div className="flex justify-between text-slate-500 text-[11px] mb-1.5 font-mono">
                    <span>Policy #{ev.policyId}</span>
                    <span>Block {ev.block}</span>
                  </div>
                  <div className="font-mono text-[11px] text-slate-300 break-all mb-2">
                    nullifier: {ev.nullifier}
                  </div>
                  <div className="flex justify-between items-center gap-3">
                    <span className="text-emerald-400 font-bold flex items-center gap-1.5 text-[11px]">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {ev.amount} units disbursed
                    </span>
                    {!IS_LOCAL_CHAIN && ev.txHash && (
                      <a
                        href={getExplorerTxUrl(ev.txHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-indigo-400 hover:text-indigo-300 underline text-[11px] shrink-0"
                      >
                        View tx ↗
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
