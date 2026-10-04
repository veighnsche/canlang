/**
 * Shared per-request helpers for HTTP dispatch: identity resolution,
 * CSRF assertion, client keys, and safe error mapping.
 *
 * Identity rule: an absent session cookie resolves public; a PRESENT but
 * invalid cookie is `forbidden` — a broken credential never silently
 * degrades to public. Edge: an *undecodable* cookie value (bad percent
 * encoding) parses as absent and therefore resolves public — the downgrade
 * direction is to least privilege, and no credential material is trusted.
 * CSRF rule: every mutating route with a session
 * requires the session-bound token via the `x-csrf-token` header or the
 * `_csrf` form field (DESIGN section 9 "current CSRF"; transport mechanics
 * lane-06 authored in @canlang/identity).
 */
import type { BusinessError, ResolvedIdentity } from '@canlang/contracts';
import {
  IdentityError,
  parseSessionCookie,
  resolveIdentity,
} from '@canlang/identity';
import type { IdentityStore } from '@canlang/identity';
import { verifyCsrfToken } from '@canlang/identity';
import { CSRF_FIELD } from '@canlang/contracts';
import type { InterfacesClock } from '../ports.js';
import { buildBusinessError, fromUnknown } from '../errors/envelope.js';
import { isBusinessErrorCode } from '../errors/safe.js';

export { CSRF_FIELD };

/** Header carrying the session-bound CSRF token (mirrors identity's). */
export const CSRF_HEADER = 'x-csrf-token';

export interface RequestIdentity {
  readonly identity: ResolvedIdentity;
  /** Raw session bearer when a session cookie was presented, else null. */
  readonly sessionToken: string | null;
}

/**
 * Resolve the caller. `teamId` is an explicit scope override (e.g. `?team=`);
 * otherwise the session's recorded selection applies.
 */
export async function resolveRequestIdentity(
  store: IdentityStore,
  request: Request,
  opts: { clock?: InterfacesClock; teamId?: string } = {},
): Promise<RequestIdentity> {
  const sessionToken = parseSessionCookie(request.headers.get('cookie') ?? undefined);
  if (sessionToken === null) {
    const identity = await resolveIdentity(
      store,
      opts.teamId === undefined ? {} : { team_id: opts.teamId },
      opts.clock === undefined ? {} : { clock: opts.clock },
    );
    return { identity, sessionToken: null };
  }
  const identity = await resolveIdentity(
    store,
    opts.teamId === undefined ? { session_token: sessionToken } : { session_token: sessionToken, team_id: opts.teamId },
    opts.clock === undefined ? {} : { clock: opts.clock },
  );
  return { identity, sessionToken };
}

/**
 * Assert the session-bound CSRF token for a mutating request. Accepts the
 * header or the canonical form field. Throws IdentityError `forbidden` on
 * any mismatch; absence of a session is a caller bug (programming error).
 */
export async function assertPostCsrf(input: {
  sessionToken: string | null;
  headerValue: string | null;
  fieldValue: unknown;
}): Promise<void> {
  if (input.sessionToken === null) {
    throw new Error('assertPostCsrf requires a session token.');
  }
  const presented =
    input.headerValue ?? (typeof input.fieldValue === 'string' ? input.fieldValue : null);
  if (presented === null || !(await verifyCsrfToken(input.sessionToken, presented))) {
    throw new IdentityError('forbidden', 'Invalid or missing CSRF token.');
  }
}

/**
 * Best-effort client key for rate limiting: CF-Connecting-IP, else the
 * first X-Forwarded-For hop, else 'unknown'. Lane-06 authored; spoofable
 * headers only feed a best-effort throttle, never identity.
 */
export function clientKey(request: Request): string {
  const direct = request.headers.get('cf-connecting-ip')?.trim();
  if (direct) return direct;
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  return 'unknown';
}

/**
 * True for the throws `caughtToBusinessError` maps without hiding detail
 * (safe to answer without an incident log); false means journal first.
 */
export function isBusinessThrow(err: unknown): boolean {
  if (err instanceof IdentityError) return true;
  if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
    const code = (err as { code: unknown }).code;
    const message = (err as { message: unknown }).message;
    return isBusinessErrorCode(code) && typeof message === 'string';
  }
  return false;
}

/**
 * Map a caught throw to a safe BusinessError: IdentityError keeps its code,
 * BusinessError-shaped values pass through, everything else becomes the
 * generic internal envelope (callers must log it with an incident id).
 */
export function caughtToBusinessError(err: unknown): BusinessError {
  if (err instanceof IdentityError) {
    return buildBusinessError(err.code, err.message, err.field === undefined ? {} : { fields: [{ path: '/', code: err.code, message: err.message }] });
  }
  if (typeof err === 'object' && err !== null && 'code' in err && 'message' in err) {
    const code = (err as { code: unknown }).code;
    const message = (err as { message: unknown }).message;
    if (isBusinessErrorCode(code) && typeof message === 'string') {
      return buildBusinessError(code, message);
    }
  }
  return fromUnknown(err);
}

/** JSON response with the BusinessError body and canonical status. */
export function jsonErrorResponse(error: BusinessError, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(error), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
