/**
 * Browser session cookie transport: build/parse/clear.
 *
 * Lane-06 authored cookie contract (DESIGN pins sessions as part of the
 * default auth primitive without fixing the encoding): one `can_session`
 * bearer cookie, HttpOnly, Secure, SameSite=Lax, Path=/, explicit Max-Age.
 * Local insecure development must opt out explicitly per call.
 */
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
  const secure = opts.secure ?? true;
  let cookie =
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${opts.maxAgeSeconds}`;
  if (secure) cookie += '; Secure';
  if (opts.domain !== undefined) cookie += `; Domain=${opts.domain}`;
  return cookie;
}

/** Expire the session cookie (sign-out response). */
export function buildSessionClearCookie(domain?: string): string {
  let cookie = `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  if (domain !== undefined) cookie += `; Domain=${domain}`;
  return cookie;
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
  for (const part of combined.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
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
