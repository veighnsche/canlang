/**
 * Anti-forgery tokens bound to the browser session.
 *
 * DESIGN requires "current CSRF" on canonical POSTs without fixing the
 * mechanism. Lane-06 design: the CSRF token is derived server-side as
 * HMAC-SHA256(key = UTF-8 session bearer token, message = 'can-csrf-v1'),
 * base64url-encoded. Properties: zero storage (recomputed per request from
 * the presented session cookie), bound to the session (rotating the session
 * rotates the token), and unforgeable without the HttpOnly session token.
 * The browser sends it in the `x-csrf-token` header; S4 enforces presence
 * and validity on every mutating route.
 */
import { bytesToBase64Url, timingSafeEqualText } from './tokens.js';

export const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_MESSAGE = 'can-csrf-v1';

export async function deriveCsrfToken(sessionToken: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(sessionToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(CSRF_MESSAGE),
  );
  return bytesToBase64Url(new Uint8Array(mac));
}

export async function verifyCsrfToken(
  sessionToken: string,
  presented: string,
): Promise<boolean> {
  if (sessionToken.length === 0 || presented.length === 0) return false;
  const expected = await deriveCsrfToken(sessionToken);
  return timingSafeEqualText(expected, presented);
}
