/**
 * Browser session cookie transport: build/parse/clear.
 *
 * Lane-06 authored cookie contract (DESIGN pins sessions as part of the
 * default auth primitive without fixing the encoding): one `can_session`
 * bearer cookie, HttpOnly, Secure, SameSite=Lax, Path=/, explicit Max-Age.
 * Local insecure development must opt out explicitly per call.
 */
import { parseCookie, stringifySetCookie } from 'cookie';
import { IdentityError } from '../ports.js';

export const SESSION_COOKIE_NAME = 'can_session';

export interface SessionCookieOptions {
  readonly maxAgeSeconds: number;
  /** Default true. Pass false only for local http:// development. */
  readonly secure?: boolean;
  readonly domain?: string;
}

export function buildSessionCookie(
  token: string,
  opts: SessionCookieOptions,
): string {
  if (token.length === 0) {
    throw new IdentityError('validation', 'Cannot set an empty session cookie.');
  }
  if (!Number.isInteger(opts.maxAgeSeconds) || opts.maxAgeSeconds <= 0) {
    throw new IdentityError('validation', 'Session cookie needs a positive Max-Age.');
  }
  return serializeSessionCookie(token, opts.maxAgeSeconds, opts);
}

/**
 * Expire the session cookie (sign-out response). Mirrors the Secure default:
 * a non-Secure Set-Cookie cannot overwrite a Secure cookie on HTTPS.
 */
export function buildSessionClearCookie(opts: { secure?: boolean; domain?: string } = {}): string {
  return serializeSessionCookie('', 0, opts);
}

/**
 * Extract the first `can_session` value from a Cookie header. Returns null
 * when absent or empty. Never throws on attacker-controlled input.
 */
export function parseSessionCookie(
  header: string | readonly string[] | undefined,
): string | null {
  if (header === undefined) return null;
  const combined = typeof header === 'string' ? header : header.join('; ');
  const cookies = parseCookie(combined, { decode: (value) => value });
  for (const [name, rawValue] of Object.entries(cookies)) {
    if (name.trim() !== SESSION_COOKIE_NAME) continue;
    const value = (rawValue ?? '').trim();
    if (value.length === 0) return null;
    try {
      const decoded = decodeURIComponent(value);
      return decoded.length > 0 ? decoded : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Library grammar with the established session attribute order. */
function serializeSessionCookie(
  token: string,
  maxAge: number,
  opts: { secure?: boolean; domain?: string },
): string {
  // Encoding precedes Domain validation, including URIError for lone surrogates.
  const encoded = encodeURIComponent(token);
  if (opts.domain === '') {
    throw new IdentityError('validation', 'Session cookie Domain is invalid.');
  }
  let serialized: string;
  try {
    serialized = stringifySetCookie({
      name: SESSION_COOKIE_NAME,
      value: encoded,
      maxAge,
      ...(opts.domain !== undefined ? { domain: opts.domain } : {}),
      path: '/',
      httpOnly: true,
      secure: opts.secure ?? true,
      sameSite: 'lax',
    }, { encode: (value) => value });
  } catch {
    throw new IdentityError('validation', 'Session cookie Domain is invalid.');
  }
  // Only split the library output: encoded values and validated Domains cannot
  // contain segment delimiters. These fixed options determine every position.
  const segments = serialized.split('; ');
  const hasDomain = opts.domain !== undefined;
  const pathIndex = hasDomain ? 3 : 2;
  return [
    segments[0], segments[pathIndex], segments[pathIndex + 1],
    segments[segments.length - 1], segments[1],
    ...((opts.secure ?? true) ? [segments[pathIndex + 2]] : []),
    ...(hasDomain ? [segments[2]] : []),
  ].join('; ');
}
