import { NextResponse } from 'next/server';
import { getTree, saveEnrollment, getEnrollments, isValidCommitment } from '../../../lib/merkle/store';

/**
 * AegisDID — Authority enrollment endpoint.
 *
 * Accepts ONLY an identity commitment plus a DID and a timestamp. The 403 below is a hard
 * invariant, not a courtesy: if a client ever tries to send a raw embedding, idSecret or salt,
 * the request is refused rather than logged-and-accepted.
 *
 * NOT IMPLEMENTED — biometric de-duplication. docs/THREAT_MODEL.md previously claimed the
 * authority performs LSH dedup here; it does not, and it cannot without receiving the very
 * vectors this endpoint refuses. Consequence, stated plainly: one person can enroll twice, get
 * two unrelated commitments and two distinct nullifiers, and claim twice. Sybil resistance in
 * the deployed prototype rests on nullifier uniqueness per (policy, epoch) and on the issuer
 * controlling who enters the cohort tree — NOT on biometric uniqueness across enrollments.
 */

export async function POST(request: Request) {
  try {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
    }

    // Shape check before anything else. The `in` operator below throws a TypeError on a
    // primitive, so a body of `123` or `"x"` would become an opaque 500 without this.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json(
        { error: 'Request body must be a JSON object.' },
        { status: 400 }
      );
    }
    const body = parsed as Record<string, unknown>;
    const { cId, didKey, timestamp } = body as {
      cId?: unknown;
      didKey?: unknown;
      timestamp?: unknown;
    };

    // Invariant: no raw biometric material or secrets may ever cross the network.
    //
    // Tested by presence (`in`), not truthiness. `if (body.idSecret)` let a present-but-falsy
    // field through — `{"idSecret": 0}` or `{"salt": ""}` passed the guard. Neither leaks
    // anything on its own, but a guard that depends on the *value* of the field it is meant to
    // forbid is the wrong shape, and /diagnostics now asserts this rejection at runtime.
    const FORBIDDEN_FIELDS = ['uReg', 'uLive', 'embedding', 'descriptor', 'idSecret', 'salt'];
    const offending = FORBIDDEN_FIELDS.filter((f) => f in body);
    if (offending.length > 0) {
      return NextResponse.json(
        {
          error: 'Security Violation: Raw biometric vectors or secrets must never be transmitted.',
          rejectedFields: offending,
        },
        { status: 403 }
      );
    }

    if (cId === undefined || cId === null) {
      return NextResponse.json({ error: 'cId (Identity Commitment) is required' }, { status: 400 });
    }

    // Validate BEFORE persisting. Writing first and parsing later permanently bricked the
    // authority service (every later getTree() threw), which was reproduced and is now fixed.
    const check = isValidCommitment(cId);
    if (!check.ok) {
      return NextResponse.json(
        { error: `Invalid identity commitment: ${check.reason}` },
        { status: 400 }
      );
    }

    const result = saveEnrollment({
      cId: cId as string,
      didKey: typeof didKey === 'string' && didKey.length > 0 ? didKey : 'unknown',
      timestamp:
        typeof timestamp === 'string' && timestamp.length > 0
          ? timestamp
          : new Date().toISOString(),
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: `Enrollment rejected: ${result.reason}` },
        { status: 400 }
      );
    }

    const tree = await getTree();
    const root = tree.getRoot();

    return NextResponse.json({
      success: true,
      message: result.duplicate
        ? 'Commitment was already registered for Merkle inclusion (idempotent re-submission)'
        : 'Commitment registered for Merkle inclusion',
      cId,
      leafIndex: result.index,
      duplicate: result.duplicate === true,
      count: getEnrollments().length,
      newRoot: root.toString(),
    });
  } catch (err: unknown) {
    console.error('API enroll error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}

export async function GET() {
  // Wrapped: an unhandled throw here previously returned a bodyless 500, so the dashboard
  // could not tell "authority unreachable" from "authority state corrupt".
  try {
    const tree = await getTree();
    return NextResponse.json({
      root: tree.getRoot().toString(),
      count: getEnrollments().length,
    });
  } catch (err: unknown) {
    console.error('API enroll GET error:', err);
    return NextResponse.json(
      {
        error: `Could not build the cohort tree: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
      { status: 500 }
    );
  }
}
