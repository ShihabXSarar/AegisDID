/**
 * AegisDID — Reproducible MODEL_HASH computation.
 *
 * MODEL_HASH binds an identity commitment to the exact biometric feature extractor that
 * produced its embedding. If the model weights change, every previously-issued commitment
 * must stop verifying, because a different network produces a different embedding space and
 * cosine similarity across the two is meaningless.
 *
 * Definition (canonical — mirrored in docs/CRYPTO_SPEC.md):
 *
 *   files     = every file in web/public/models, sorted by byte-wise filename order
 *   preimage  = concat over files of ( utf8(filename) || 0x00 || file_bytes )
 *   MODEL_HASH = keccak256(preimage) mod r        (r = BN254 scalar field order)
 *
 * The filename is included and NUL-separated so that renaming a shard, reordering shards, or
 * swapping two files of equal length changes the hash.
 *
 *   node tools/compute_model_hash.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256 } from '../web/node_modules/viem/_esm/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(HERE, '..', 'web', 'public', 'models');

// BN254 scalar field order r
const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const names = readdirSync(MODELS_DIR)
  .filter((n) => statSync(join(MODELS_DIR, n)).isFile())
  .sort();

if (names.length === 0) {
  console.error(`No model files found in ${MODELS_DIR}`);
  process.exit(1);
}

const parts = [];
let totalBytes = 0;
console.log(`Model directory: ${MODELS_DIR}`);
console.log('Files (byte-wise filename order):');
for (const name of names) {
  const bytes = readFileSync(join(MODELS_DIR, name));
  const perFile = keccak256(new Uint8Array(bytes));
  console.log(`  ${name.padEnd(48)} ${String(bytes.length).padStart(9)} bytes  keccak256=${perFile}`);
  parts.push(Buffer.from(name, 'utf8'), Buffer.from([0x00]), bytes);
  totalBytes += bytes.length;
}

const preimage = Buffer.concat(parts);
const digest = keccak256(new Uint8Array(preimage));
const reduced = BigInt(digest) % R;

console.log('');
console.log(`file count                : ${names.length}`);
console.log(`model bytes (excl. names) : ${totalBytes}`);
console.log(`preimage bytes            : ${preimage.length}`);
console.log(`keccak256(preimage)       : ${digest}`);
console.log(`reduced mod r (hex)       : 0x${reduced.toString(16).padStart(64, '0')}`);
console.log(`reduced mod r (decimal)   : ${reduced}`);
console.log(`reduction changed value   : ${BigInt(digest) !== reduced}`);
