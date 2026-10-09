/** Host-private integrity for one visible collection position; never read authority. */
import { base64UrlToBytes, bytesToBase64Url } from '@canlang/identity';
import type { WorkScope } from '@canlang/contracts';

const DOMAIN = 'can-page-cursor';
const VERSION = 1;
const LIFETIME_MS = 15 * 60 * 1_000;
const MAX_TOKEN_CHARS = 4_096;

export interface PageCursorPosition {
  readonly revision: number;
  /** ID of the final returned authorized row; no stored sort values. */
  readonly after: string;
}

export type PageCursorDecoded =
  | { readonly status: 'valid'; readonly bindingDigest: string; readonly position: PageCursorPosition }
  | { readonly status: 'invalid' | 'stale' };

/** Fixed-domain codec; the admitted page adapter owns the checked binding tuple. */
export interface PageCursorCodec {
  encode(bindingDigest: string, position: PageCursorPosition, nowMs: number): Promise<string>;
  decode(token: string, nowMs: number): Promise<PageCursorDecoded>;
}

/** Trusted host assertion for this exact store; never derived from a URL or cursor. */
export interface PageReadsBinding {
  readonly scope: Readonly<WorkScope>;
  /** Authored source identity, distinct from a deployment release pin. */
  readonly sourceIdentity: string;
  readonly cursors?: PageCursorCodec;
}

function canonicalBytes(value: string): Uint8Array | null {
  const bytes = base64UrlToBytes(value);
  return bytes !== null && bytesToBase64Url(bytes) === value ? bytes : null;
}

function validTime(nowMs: number): boolean {
  return Number.isSafeInteger(nowMs) && nowMs >= 0 && Number.isSafeInteger(nowMs + LIFETIME_MS);
}

/** Construct once at host startup with the configured canonical 32-byte private key. */
export async function createPageCursorCodec(key: Uint8Array | string): Promise<PageCursorCodec> {
  const keyBytes = typeof key === 'string' ? canonicalBytes(key) : key;
  if (!(keyBytes instanceof Uint8Array) || keyBytes.length !== 32) {
    throw new TypeError('Page cursors require a 32-byte host key or its canonical base64url encoding.');
  }
  const signingKey = await globalThis.crypto.subtle.importKey(
    'raw', keyBytes.slice(), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
  return Object.freeze({
    async encode(bindingDigest: string, position: PageCursorPosition, nowMs: number): Promise<string> {
      if (typeof bindingDigest !== 'string' || !/^[a-f0-9]{64}$/.test(bindingDigest) || !validTime(nowMs) ||
          !Number.isSafeInteger(position.revision) || position.revision < 0 ||
          typeof position.after !== 'string' || position.after === '') {
        throw new TypeError('Page cursors require a checked binding digest, revision, visible position and clock.');
      }
      const payload = new TextEncoder().encode(JSON.stringify([
        DOMAIN, VERSION, bindingDigest, position.revision, position.after, nowMs, nowMs + LIFETIME_MS,
      ]));
      // Base64url length plus the fixed 32-byte MAC and separator, before signing.
      if (Math.ceil(payload.length * 4 / 3) + 44 > MAX_TOKEN_CHARS) {
        throw new TypeError('Page cursor exceeds its token size limit.');
      }
      const signature = await globalThis.crypto.subtle.sign('HMAC', signingKey, payload);
      return `${bytesToBase64Url(payload)}.${bytesToBase64Url(new Uint8Array(signature))}`;
    },
    async decode(token: string, nowMs: number): Promise<PageCursorDecoded> {
      if (!validTime(nowMs)) throw new TypeError('Page cursor clock must be a non-negative safe millisecond value.');
      if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS) return { status: 'invalid' };
      const segments = token.split('.');
      if (segments.length !== 2) return { status: 'invalid' };
      const payload = canonicalBytes(segments[0]!), signature = canonicalBytes(segments[1]!);
      if (payload === null || signature === null || signature.length !== 32 ||
          !await globalThis.crypto.subtle.verify('HMAC', signingKey, signature.slice(), payload.slice())) {
        return { status: 'invalid' };
      }
      let parsed: unknown, text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
        parsed = JSON.parse(text) as unknown;
      } catch { return { status: 'invalid' }; }
      if (!Array.isArray(parsed) || parsed.length !== 7 || JSON.stringify(parsed) !== text ||
          parsed[0] !== DOMAIN || parsed[1] !== VERSION ||
          typeof parsed[2] !== 'string' || !/^[a-f0-9]{64}$/.test(parsed[2]) ||
          !Number.isSafeInteger(parsed[3]) || parsed[3] < 0 ||
          typeof parsed[4] !== 'string' || parsed[4] === '' ||
          !validTime(parsed[5]) || !Number.isSafeInteger(parsed[6]) || parsed[6] !== parsed[5] + LIFETIME_MS) {
        return { status: 'invalid' };
      }
      if (parsed[5] > nowMs || parsed[6] <= nowMs) return { status: 'stale' };
      return { status: 'valid', bindingDigest: parsed[2], position: { revision: parsed[3], after: parsed[4] } };
    },
  });
}
