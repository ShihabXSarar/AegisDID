/**
 * AegisDID — Client-Side did:key Generator
 * Creates a standard did:key identifier for the beneficiary.
 */

// Base58 alphabet (BTC)
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
  // Leading zeros
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) {
    result += ALPHABET[0];
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    result += ALPHABET[digits[i]];
  }
  return result;
}

/**
 * Generate a did:key identifier client-side (Ed25519 multicodec 0xed01 prefix).
 */
export function generateDIDKey(): string {
  const pubKeyBytes = new Uint8Array(32);
  if (typeof window !== 'undefined' && window.crypto) {
    window.crypto.getRandomValues(pubKeyBytes);
  } else {
    for (let i = 0; i < 32; i++) pubKeyBytes[i] = Math.floor(Math.random() * 256);
  }

  // Multicodec prefix for ed25519-pub is 0xed 0x01
  const prefixed = new Uint8Array(34);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(pubKeyBytes, 2);

  const multibase = 'z' + encodeBase58(prefixed);
  return `did:key:${multibase}`;
}
