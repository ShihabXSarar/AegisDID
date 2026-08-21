import { NextResponse } from 'next/server';
import { getTree, findCommitmentIndex, isValidCommitment } from '../../../../lib/merkle/store';

/**
 * AegisDID — Merkle inclusion path for one commitment.
 *
 * PRIVACY NOTE: this endpoint is a linkability surface. Querying it reveals to the authority
 * that the holder of a particular C_id is preparing a claim, and the response's sibling set
 * narrows the holder to one leaf index. It does NOT reveal the biometric or idSecret, and the
 * on-chain claim itself is unlinkable to the C_id. Documented in docs/THREAT_MODEL.md rather
 * than papered over; a production deployment would serve the whole tree or use PIR.
 *
 * The lookup compares field elements, not strings. A string compare 404s a legitimate
 * beneficiary whenever the stored and queried representations differ only in leading zeros or
 * hex letter case — the same leaf, rejected for a formatting difference.
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const commitment = searchParams.get('commitment');

    if (!commitment) {
      return NextResponse.json({ error: 'commitment parameter is required' }, { status: 400 });
    }

    const check = isValidCommitment(commitment);
    if (!check.ok) {
      return NextResponse.json(
        { error: `Invalid commitment: ${check.reason}` },
        { status: 400 }
      );
    }

    const index = findCommitmentIndex(commitment);
    if (index === -1) {
      return NextResponse.json(
        {
          error:
            'Commitment not found in the cohort tree. This device is not enrolled with this authority.',
        },
        { status: 404 }
      );
    }

    const tree = await getTree();
    const pathData = tree.getPath(index);

    return NextResponse.json({
      root: pathData.root.toString(),
      leafIndex: index,
      pathElements: pathData.pathElements.map((p) => p.toString()),
      pathIndices: pathData.pathIndices,
    });
  } catch (err: unknown) {
    console.error('API merkle path error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}
