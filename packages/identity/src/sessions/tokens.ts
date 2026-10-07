/**
 * Opaque bearer-token primitives: issuance, SHA-256 hashing, byte
 * comparison, base64url codecs.
 *
 * WebCrypto globals only (`globalThis.crypto.subtle`); no node:crypto, so
 * this module runs identically in Node and workerd. Raw tokens are returned
 * to exactly one caller (login response, addressed mail); only hex SHA-256
 * digests are stored or compared.
 */
import { base64urlnopad, hex } from '@scure/base';
import { webRandom } from '../ports.js';
import type { RandomSource } from '../ports.js';

/** Raw bearer-token size: 256 bits. */
export const OPAQUE_TOKEN_BYTES = 32;

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpadded URL-safe encoding, shared with persisted password fields. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return base64urlnopad.encode(bytes);
}

/** Decode the established URL alphabet, including ignored unused tail bits. */
export function base64UrlToBytes(s: string): Uint8Array | null {
  const remainder = s.length % 4;
  if (s.length === 0 || remainder === 1 || /[^A-Za-z0-9_-]/.test(s)) return null;
  // Strict library decoding requires zero unused bits. Preserve the historical
  // byte-decoder domain with only this final-sextet mask; bearer hashing never
  // uses this normalization and continues to hash the exact presented text.
  if (remainder === 2 || remainder === 3) {
    const last = B64U.indexOf(s[s.length - 1] ?? '');
    s = s.slice(0, -1) + B64U[last & (remainder === 2 ? 0x30 : 0x3c)];
  }
  try {
    return base64urlnopad.decode(s);
  } catch {
    return null;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return hex.encode(bytes);
}

function hexToBytes(s: string): Uint8Array | null {
  if (s.length === 0) return null;
  try {
    return hex.decode(s);
  } catch {
    return null;
  }
}

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  // slice() normalizes to an ArrayBuffer-backed view for WebCrypto typing.
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes.slice());
  return bytesToHex(new Uint8Array(digest));
}

export async function sha256HexText(text: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(text));
}

/**
 * Hex byte comparison. False on malformed input or length mismatch.
 * The full byte loop does not establish a host-level timing guarantee.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const ab = hexToBytes(a);
  const bb = hexToBytes(b);
  if (ab === null || bb === null || ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/** UTF-8 byte comparison for non-hex secrets (CSRF). */
export function timingSafeEqualText(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Issue one opaque bearer token. The raw `token` goes to exactly one
 * presenter (cookie, addressed mail, OAuth redirect); `token_sha256` is
 * what the store holds.
 */
export async function createOpaqueToken(
  random: RandomSource = webRandom,
): Promise<{ token: string; token_sha256: string }> {
  const raw = random.randomBytes(OPAQUE_TOKEN_BYTES);
  const token = bytesToBase64Url(raw);
  // Hash the presented text form: every lookup hashes the bearer string.
  const token_sha256 = await sha256HexText(token);
  return { token, token_sha256 };
}
