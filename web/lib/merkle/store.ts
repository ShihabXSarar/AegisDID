// web/lib/merkle/store.ts
//
// AegisDID — Authority-side cohort commitment store.
//
// This is the ONLY server-side state in the prototype. It holds identity commitments (C_id)
// and nothing else: no embeddings, no idSecret, no salt. See app/api/enroll/route.ts, which
// rejects any request carrying those fields.
//
// AVAILABILITY HARDENING (fixed defect): an earlier version wrote every POSTed record to disk
// with no validation and only converted it with BigInt() afterwards, while building the tree.
// A single unauthenticated POST of {"cId":"not-a-number"} therefore poisoned commitments.json
// permanently — getTree() threw on the bad record, so GET /api/enroll, /api/merkle/path and
// every subsequent enrollment returned HTTP 500 forever, surviving server restarts. Reproduced
// live before the fix. Two independent changes close it:
//   1. isValidCommitment() gates writes, so poison never reaches disk (route.ts).
//   2. getEnrollments() filters unusable records on read, so an ALREADY poisoned store
//      self-heals into a working service instead of staying bricked.
// Defence in depth matters here because (1) alone would leave existing corrupt files broken.

import fs from 'fs';
import path from 'path';
import { MerkleTree } from './tree';
import { FIELD_ORDER } from '../ml/commitments';

const STORE_PATH = path.join(process.cwd(), '.cache', 'commitments.json');

export const TREE_DEPTH = 20;
/** Zero-leaf sentinel. A commitment equal to this is indistinguishable from an empty slot. */
export const ZERO_LEAF = 0n;

export interface EnrollmentRecord {
  cId: string;
  didKey: string;
  timestamp: string;
}

export interface CommitmentValidation {
  ok: boolean;
  /** Canonical decimal form of the field element, present only when ok. */
  value?: bigint;
  reason?: string;
}

/**
 * Validate a commitment string as a usable Merkle leaf.
 *
 * Accepts decimal or 0x-hex integers. Rejects:
 *  - anything BigInt() cannot parse (the availability bug above),
 *  - 0, which is the zero-leaf sentinel: a leaf of 0 is indistinguishable from an empty slot,
 *    so it would let a holder claim inclusion at any unfilled index,
 *  - values >= r, which are not field elements and would be silently reduced by the circuit,
 *    producing a leaf that differs from the one the authority stored.
 */
export function isValidCommitment(raw: unknown): CommitmentValidation {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'cId must be a string.' };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'cId must not be empty.' };
  }
  if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(trimmed)) {
    return {
      ok: false,
      reason: 'cId must be a decimal or 0x-prefixed hexadecimal integer.',
    };
  }

  let value: bigint;
  try {
    value = BigInt(trimmed);
  } catch {
    return { ok: false, reason: 'cId is not a parseable integer.' };
  }

  if (value === ZERO_LEAF) {
    return { ok: false, reason: 'cId must not be zero (that is the empty-leaf sentinel).' };
  }
  if (value >= FIELD_ORDER) {
    return {
      ok: false,
      reason: 'cId must be less than the BN254 scalar field order r.',
    };
  }

  return { ok: true, value };
}

/**
 * Read all enrollments, dropping any record that cannot be used as a leaf.
 *
 * Dropping rather than throwing is deliberate: the service must keep serving valid
 * beneficiaries even if the file was corrupted (by an old unvalidated build, a partial write,
 * or manual editing). Every drop is logged loudly so the operator can see it — this is not a
 * silent repair of security-relevant state, it only skips records that could never have
 * produced a verifiable proof anyway.
 */
export function getEnrollments(): EnrollmentRecord[] {
  if (!fs.existsSync(STORE_PATH)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (e) {
    console.error(
      `[merkle/store] commitments.json is not valid JSON and is being ignored. ` +
        `Fix or remove ${STORE_PATH}. Cause:`,
      e
    );
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.error('[merkle/store] commitments.json does not contain an array; ignoring it.');
    return [];
  }

  const out: EnrollmentRecord[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < parsed.length; i++) {
    const record = parsed[i] as Partial<EnrollmentRecord> | null;
    const check = isValidCommitment(record?.cId);
    if (!check.ok) {
      console.error(
        `[merkle/store] SKIPPING corrupt enrollment at index ${i}: ${check.reason} ` +
          `(value: ${JSON.stringify(record?.cId)}). It can never yield a valid proof.`
      );
      continue;
    }

    // Canonicalise by field element, so 0x0a and 0xA and 10 are one leaf, not three.
    const key = check.value!.toString();
    if (seen.has(key)) {
      console.warn(
        `[merkle/store] SKIPPING duplicate commitment at index ${i} (already inserted). ` +
          `Duplicate leaves inflate the tree without granting anything.`
      );
      continue;
    }
    seen.add(key);

    out.push({
      cId: record!.cId as string,
      didKey: typeof record?.didKey === 'string' ? record.didKey : 'unknown',
      timestamp: typeof record?.timestamp === 'string' ? record.timestamp : '',
    });
  }

  return out;
}

/** Is this commitment already in the cohort? Compared as a field element, not as a string. */
export function hasCommitment(cId: string): boolean {
  const check = isValidCommitment(cId);
  if (!check.ok) return false;
  return findCommitmentIndex(cId) !== -1;
}

/**
 * Index of a commitment in the tree, or -1.
 *
 * Compares field elements rather than strings: '0x0a', '0xA' and '10' are the same leaf, and a
 * string compare would 404 a beneficiary whose stored representation differs by a leading zero
 * or letter case from the one the authority persisted.
 */
export function findCommitmentIndex(cId: string): number {
  const check = isValidCommitment(cId);
  if (!check.ok) return -1;
  const target = check.value!;
  const records = getEnrollments();
  for (let i = 0; i < records.length; i++) {
    // Records from getEnrollments() are pre-validated, so BigInt() cannot throw here.
    if (BigInt(records[i].cId) === target) return i;
  }
  return -1;
}

export interface SaveResult {
  ok: boolean;
  /** Index of the leaf in the tree (existing index when the commitment was already present). */
  index?: number;
  duplicate?: boolean;
  reason?: string;
}

/**
 * Append a validated commitment.
 *
 * Rejects invalid commitments BEFORE touching the disk, and treats a repeat submission of the
 * same commitment as idempotent rather than appending a second identical leaf. Idempotency
 * matters because the enroll page publishes before it saves locally: a client retry after a
 * dropped response must not produce two leaves for one credential.
 */
export function saveEnrollment(record: EnrollmentRecord): SaveResult {
  const check = isValidCommitment(record.cId);
  if (!check.ok) {
    return { ok: false, reason: check.reason };
  }

  const existingIndex = findCommitmentIndex(record.cId);
  if (existingIndex !== -1) {
    return { ok: true, index: existingIndex, duplicate: true };
  }

  const records = getEnrollments();
  records.push({
    cId: record.cId.trim(),
    didKey: record.didKey,
    timestamp: record.timestamp,
  });

  // getEnrollments() already dropped unusable rows, so this write also cleans the file.
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(records, null, 2));

  return { ok: true, index: records.length - 1, duplicate: false };
}

let cachedTree: MerkleTree | null = null;
let cachedTreeKey = '';

/**
 * Build (or reuse) the cohort tree.
 *
 * The cache key is the full leaf list, not just its length: keying on length alone would serve
 * a stale root after an in-place edit of commitments.json, and the root is the value the
 * on-chain policy is compared against.
 */
export async function getTree(): Promise<MerkleTree> {
  const records = getEnrollments();
  const key = records.map((r) => BigInt(r.cId).toString()).join(',');

  if (cachedTree && cachedTreeKey === key) {
    return cachedTree;
  }

  const tree = new MerkleTree(TREE_DEPTH, ZERO_LEAF);
  await tree.init();
  for (const record of records) {
    tree.insert(BigInt(record.cId));
  }

  cachedTree = tree;
  cachedTreeKey = key;
  return tree;
}
