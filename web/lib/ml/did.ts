/**
 * AegisDID — Client-Side did:key Generator (Ed25519)
 *
 * Produces a REAL did:key: an Ed25519 keypair is generated, the public key is multicodec-
 * prefixed (0xed 0x01) and base58btc-encoded per the did:key method spec, and the secret key
 * is returned so it can be sealed in the same browser enclave as `idSecret`.
 *
 * SECURITY / HONESTY: an earlier version of this file filled 32 random bytes and labelled them
 * an "Ed25519 public key". That produced a syntactically valid did:key string that nobody —
 * including the holder — could ever authenticate against, because no private key existed for
 * it. Anything that later relied on it (a verifiable credential, a signed claim receipt) would
 * have been unverifiable. It is now a genuine keypair.
 *
 * The DID is NOT part of the Sybil-resistance argument: nullifier uniqueness and Merkle
 * membership carry that, and the DID is deliberately never sent on-chain or bound into any
 * commitment. It exists as a portable, self-certifying handle for the beneficiary record.
 */

import { ed25519 } from '@noble/curves/ed25519';

// Base58 alphabet (Bitcoin / base58btc, as required by the did:key multibase 'z' prefix)
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function encodeBase58(bytes: Uint8Array): string {
  const digits = [0];
  for (let i = 0; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let result = '';
  // Each leading zero byte encodes to one leading '1'.
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    result += ALPHABET[0];
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    result += ALPHABET[digits[i]];
  }
  return result;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('Invalid hex length for a key.');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface DIDKeyPair {
  /** did:key:z6Mk… — safe to publish. */
  did: string;
  /** 32-byte Ed25519 public key, hex with 0x prefix. Safe to publish. */
  publicKeyHex: string;
  /** 32-byte Ed25519 secret key, hex with 0x prefix. NEVER transmit. */
  privateKeyHex: string;
}

/**
 * Generate a fresh Ed25519 keypair and its did:key identifier.
 *
 * Throws if no CSPRNG is available rather than falling back to Math.random(); a predictable
 * DID secret key would be worse than no key at all.
 */
export function generateDIDKeyPair(): DIDKeyPair {
  const csprng = globalThis.crypto;
  if (!csprng || typeof csprng.getRandomValues !== 'function') {
    throw new Error(
      'No cryptographically secure random source available — refusing to generate a DID key.'
    );
  }

  const secretKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(secretKey);

  // did:key requires multicodec ed25519-pub = 0xed 0x01 (varint), then multibase base58btc 'z'.
  const prefixed = new Uint8Array(2 + publicKey.length);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(publicKey, 2);

  return {
    did: `did:key:z${encodeBase58(prefixed)}`,
    publicKeyHex: '0x' + toHex(publicKey),
    privateKeyHex: '0x' + toHex(secretKey),
  };
}

/**
 * Sign a message with a stored DID secret key.
 *
 * NOT CURRENTLY CALLED. This is an available primitive, not an active mechanism: nothing in the
 * app signs anything with the DID key today, and no claim receipt is authenticated. Kept because
 * the keypair is real and signing it is the obvious next use, but do not cite its existence as
 * evidence that receipts are signed. See docs/DID_SPEC.md ("Signing helpers — PARTIAL").
 */
export function signWithDIDKey(privateKeyHex: string, message: Uint8Array): string {
  return '0x' + toHex(ed25519.sign(message, fromHex(privateKeyHex)));
}

/** Verify a signature against a stored DID public key. Also has no call sites — see above. */
export function verifyWithDIDKey(
  publicKeyHex: string,
  message: Uint8Array,
  signatureHex: string
): boolean {
  try {
    return ed25519.verify(fromHex(signatureHex), message, fromHex(publicKeyHex));
  } catch {
    return false;
  }
}
