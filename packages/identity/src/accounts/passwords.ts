/**
 * Password hashing and verification for the default `auth email password`
 * primitive (DESIGN section 4).
 *
 * PBKDF2-HMAC-SHA-256 via WebCrypto SubtleCrypto, which runs identically in
 * Node and workerd (node:crypto scrypt and argon2 do not run in workerd).
 * Parameters follow OWASP 2023 guidance: 600k iterations, 16-byte salt,
 * 32-byte key. Encoding is a versioned modular string so parameters can
 * migrate without a format break. Policy floor/ceiling (8..512 chars) is
 * lane-06 authored; DESIGN pins verified-email registration, not password
 * rules.
 */
import { IdentityError, webRandom } from '../ports.js';
import type { RandomSource } from '../ports.js';
import { base64UrlToBytes, bytesToBase64Url } from '../sessions/tokens.js';
import { timingSafeEqualBytes } from '../sessions/comparison.js';

export const PBKDF2_ITERATIONS = 600000;
export const PBKDF2_SALT_BYTES = 16;
export const PBKDF2_KEY_BYTES = 32;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 512;
const ENCODING_ALG = 'pbkdf2-sha256';

export function checkPasswordPolicy(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new IdentityError(
      'validation',
      `Password must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`,
      'password',
    );
  }
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const base = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    // slice() normalizes to an ArrayBuffer-backed view for WebCrypto typing.
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt.slice(), iterations },
    base,
    PBKDF2_KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(
  password: string,
  random: RandomSource = webRandom,
): Promise<string> {
  checkPasswordPolicy(password);
  const salt = random.randomBytes(PBKDF2_SALT_BYTES);
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  return `${ENCODING_ALG}$${PBKDF2_ITERATIONS}$${bytesToBase64Url(salt)}$${bytesToBase64Url(key)}`;
}

interface ParsedEncoding {
  readonly iterations: number;
  readonly salt: Uint8Array;
  readonly key: Uint8Array;
}

function parseEncoding(encoded: string): ParsedEncoding | null {
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== ENCODING_ALG) return null;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0 || iterations > 10_000_000) {
    return null;
  }
  const salt = base64UrlToBytes(parts[2] ?? '');
  const key = base64UrlToBytes(parts[3] ?? '');
  if (salt === null || key === null) return null;
  if (salt.length !== PBKDF2_SALT_BYTES || key.length !== PBKDF2_KEY_BYTES) return null;
  return { iterations, salt, key };
}

/**
 * Verify a password against a stored encoding. Returns false for wrong
 * passwords, malformed encodings, and derivation failures. Native comparison
 * faults propagate; parsing and derivation have no constant-time guarantee.
 */
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const parsed = parseEncoding(encoded);
  if (parsed === null) return false;
  let derived: Uint8Array;
  try {
    derived = await deriveKey(password, parsed.salt, parsed.iterations);
  } catch {
    return false;
  }
  return timingSafeEqualBytes(derived, parsed.key);
}
