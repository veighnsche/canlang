/**
 * Opaque bearer-token primitives: issuance, SHA-256 hashing, constant-time
 * comparison, base64url codecs.
 *
 * WebCrypto globals only (`globalThis.crypto.subtle`); no node:crypto, so
 * this module runs identically in Node and workerd. Raw tokens are returned
 * to exactly one caller (login response, addressed mail); only hex SHA-256
 * digests are stored or compared.
 */
import { webRandom } from '../ports.js';
import type { RandomSource } from '../ports.js';

/** Raw bearer-token size: 256 bits. */
export const OPAQUE_TOKEN_BYTES = 32;

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Manual bytes->base64url (no Buffer/btoa: workerd-safe). */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64U[(n >> 18) & 63] ?? '';
    out += B64U[(n >> 12) & 63] ?? '';
    if (i + 1 < bytes.length) out += B64U[(n >> 6) & 63] ?? '';
    if (i + 2 < bytes.length) out += B64U[n & 63] ?? '';
  }
  return out;
}

/** Manual base64url->bytes. Returns null on malformed input (never throws). */
export function base64UrlToBytes(s: string): Uint8Array | null {
  if (s.length === 0 || s.length % 4 === 1) return null;
  const vals: number[] = [];
  for (const ch of s) {
    const v = B64U.indexOf(ch);
    if (v < 0) return null;
    vals.push(v);
  }
  const out: number[] = [];
  for (let i = 0; i < vals.length; i += 4) {
    const a = vals[i] ?? 0;
    const b = vals[i + 1] ?? 0;
    const c = vals[i + 2] ?? 0;
    const d = vals[i + 3] ?? 0;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    out.push((n >> 16) & 255);
    if (i + 2 < vals.length) out.push((n >> 8) & 255);
    if (i + 3 < vals.length) out.push(n & 255);
  }
  return new Uint8Array(out);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(s: string): Uint8Array | null {
  if (s.length === 0 || s.length % 2 !== 0) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(v)) return null;
    out[i] = v;
  }
  return out;
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
 * Constant-time hex comparison. False on malformed input or length
 * mismatch; all digests here are fixed-length SHA-256 so length is not
 * secret, but the byte loop itself is constant-time.
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

/** Constant-time UTF-8 string comparison for non-hex secrets (CSRF). */
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
