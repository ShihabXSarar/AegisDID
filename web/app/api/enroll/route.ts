import { NextResponse } from 'next/server';

// In-memory / mock store for enrolled commitments until Person C's dashboard API is attached
const enrolledCommitments: Array<{ cId: string; didKey: string; timestamp: string }> = [];

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { cId, didKey, timestamp } = body;

    if (!cId) {
      return NextResponse.json({ error: 'cId (Identity Commitment) is required' }, { status: 400 });
    }

    // Invariant Check: Ensure no raw vectors were accidentally sent
    if (body.uReg || body.embedding || body.idSecret || body.salt) {
      return NextResponse.json(
        { error: 'Security Violation: Raw biometric vectors or secrets must never be transmitted.' },
        { status: 403 }
      );
    }

    enrolledCommitments.push({
      cId,
      didKey: didKey || 'unknown',
      timestamp: timestamp || new Date().toISOString(),
    });

    return NextResponse.json({
      success: true,
      message: 'Commitment registered for Merkle inclusion',
      cohortSize: enrolledCommitments.length,
      cId,
    });
  } catch (err: unknown) {
    console.error('API enroll error:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({
    cohort: enrolledCommitments,
    totalEnrolled: enrolledCommitments.length,
  });
}
