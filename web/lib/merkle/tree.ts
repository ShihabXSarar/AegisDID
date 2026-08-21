// web/lib/merkle/tree.ts
//
// Binary incremental Merkle tree, depth 20, Poseidon(2) internal nodes, zero-leaf 0.
// Must match circuits/aegis_claim.circom exactly:
//   - zero-hash ladder: z_0 = zeroValue, z_{i+1} = Poseidon(z_i, z_i)
//   - pathIndices[i] = 1 means the current node is the RIGHT child at level i
// Verified against the real circuit by web/scripts/circuit_conformance.mts, which folds a path
// produced here through snarkjs groth16.fullProve + verify (run: npm run test:circuit).

// circomlibjs is imported lazily inside init(), not statically at module scope. A static
// `import { buildPoseidon } from 'circomlibjs'` pulls the whole ~1.4 MB library into the initial
// JS chunk of any page that merely references MerkleTree (this took /diagnostics from 5.5 kB to
// 1.4 MB). init() is already async, so deferring costs nothing. lib/ml/commitments.ts uses the
// same pattern.

export class MerkleTree {
  private depth: number;
  private zeroValue: bigint;
  private nodes: Record<number, bigint[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private poseidon: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private F: any;
  /** Memoized zero-hash ladder. Rebuilt once in init(); see getZeroHash(). */
  private zeroHashes: bigint[] = [];

  constructor(depth: number = 20, zeroValue: bigint = 0n) {
    this.depth = depth;
    this.zeroValue = zeroValue;
    this.nodes = {};
    for (let i = 0; i <= depth; i++) {
      this.nodes[i] = [];
    }
  }

  async init() {
    const { buildPoseidon } = await import('circomlibjs');
    this.poseidon = await buildPoseidon();
    this.F = this.poseidon.F;

    // Precompute z_0..z_depth once. The previous implementation recomputed the ladder from
    // scratch on every call, inside the per-level insert loop: O(depth^2) Poseidon hashes per
    // insert (~200 at depth 20), all of them redundant.
    this.zeroHashes = new Array(this.depth + 1);
    this.zeroHashes[0] = this.zeroValue;
    for (let i = 1; i <= this.depth; i++) {
      this.zeroHashes[i] = this.hash(this.zeroHashes[i - 1], this.zeroHashes[i - 1]);
    }
  }

  private hash(left: bigint, right: bigint): bigint {
    const hashBuffer = this.poseidon([left, right]);
    return this.F.toObject(hashBuffer);
  }

  private getZeroHash(level: number): bigint {
    if (!this.zeroHashes.length) {
      throw new Error('MerkleTree.init() must be awaited before use.');
    }
    return this.zeroHashes[level];
  }

  public insert(leaf: bigint) {
    let currentIndex = this.nodes[0].length;
    this.nodes[0][currentIndex] = leaf;

    let currentLevel = 0;
    while (currentLevel < this.depth) {
      const isRightNode = currentIndex % 2 === 1;
      const leftIndex = isRightNode ? currentIndex - 1 : currentIndex;
      const rightIndex = isRightNode ? currentIndex : currentIndex + 1;

      const leftNode = this.nodes[currentLevel][leftIndex] ?? this.getZeroHash(currentLevel);
      const rightNode = this.nodes[currentLevel][rightIndex] ?? this.getZeroHash(currentLevel);

      const parentHash = this.hash(leftNode, rightNode);
      currentIndex = Math.floor(currentIndex / 2);
      currentLevel++;
      this.nodes[currentLevel][currentIndex] = parentHash;
    }
  }

  public get leafCount(): number {
    return this.nodes[0].length;
  }

  public getRoot(): bigint {
    return this.nodes[this.depth][0] ?? this.getZeroHash(this.depth);
  }

  public getPath(index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= this.nodes[0].length) {
      throw new Error(
        `Leaf index ${index} is out of range; the tree holds ${this.nodes[0].length} leaves.`
      );
    }

    const pathElements: bigint[] = [];
    const pathIndices: number[] = [];

    let currentIndex = index;
    for (let level = 0; level < this.depth; level++) {
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;

      const siblingNode = this.nodes[level][siblingIndex] ?? this.getZeroHash(level);

      pathElements.push(siblingNode);
      pathIndices.push(isRightNode ? 1 : 0);

      currentIndex = Math.floor(currentIndex / 2);
    }

    return {
      root: this.getRoot(),
      pathElements,
      pathIndices,
    };
  }
}
