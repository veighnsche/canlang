/**
 * Request body caps, body parsers, collection-query parsing, and the
 * unauthenticated-auth rate-limit policy for HTTP dispatch (S4).
 *
 * All bounds here are lane-06 authored (DESIGN pins the mechanics, not the
 * numbers): 1 MiB JSON/form bodies, 10 auth attempts per minute per client,
 * 5 recovery mails per hour per client.
 *
 * Oversize bodies surface as `limit` (HTTP 429): a quota breach, not a
 * malformed request. Callers SHOULD surface Retry-After where a decision
 * carries one.
 */
import {
  COLLECTION_DEFAULT_LIMIT,
  COLLECTION_MAX_LIMIT,
} from '@canlang/contracts';
import type { BusinessError, CollectionRequest } from '@canlang/contracts';
import { IdentityError } from '@canlang/identity';
import type { HttpDeps } from '../ports.js';
import { buildBusinessError } from '../errors/envelope.js';
import { clientKey } from './context.js';

/** 1 MiB cap for JSON request bodies (lane-06 authored). */
export const JSON_BODY_MAX_BYTES = 1_048_576;

/** 1 MiB cap for form request bodies (lane-06 authored). */
export const FORM_BODY_MAX_BYTES = 1_048_576;

/**
 * Stream `request.body` up to `maxBytes`.
 *
 * The cap is enforced WHILE streaming so a malicious client cannot force
 * unbounded buffering: the first chunk past the cap cancels the reader and
 * throws `IdentityError('limit', 'Request body too large.')`. Authored
 * mapping: an oversize body is a quota breach (HTTP 429 via the contract
 * table), not malformed input (400). A null body reads as empty.
 */
export async function readCappedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const body = request.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new IdentityError('limit', 'Request body too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Parse a JSON request body. Empty bodies and malformed JSON throw
 * `IdentityError('validation', 'Invalid JSON body.')`; oversize bodies throw
 * the `limit` error from {@link readCappedBody}.
 */
export async function parseJsonBody(
  request: Request,
  maxBytes: number = JSON_BODY_MAX_BYTES,
): Promise<unknown> {
  const bytes = await readCappedBody(request, maxBytes);
  const text = new TextDecoder().decode(bytes);
  if (text.trim().length === 0) {
    throw new IdentityError('validation', 'Invalid JSON body.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new IdentityError('validation', 'Invalid JSON body.');
  }
}

/**
 * Parse an `application/x-www-form-urlencoded` body into a flat string map.
 * Duplicate keys: LAST wins (documented transport convention, matching the
 * `URLSearchParams` iteration order where later pairs overwrite earlier
 * ones). Oversize bodies throw the `limit` error from {@link readCappedBody}.
 */
export async function parseFormBody(
  request: Request,
  maxBytes: number = FORM_BODY_MAX_BYTES,
): Promise<Record<string, string>> {
  const bytes = await readCappedBody(request, maxBytes);
  const text = new TextDecoder().decode(bytes);
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  params.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** Outcome of {@link parseCollectionQuery}: a request or a safe error. */
export type CollectionQueryOutcome =
  | { readonly request: CollectionRequest }
  | { readonly error: BusinessError };

const FILTER_PARAM_PATTERN = /^filter\[(.+)\]$/;

/**
 * Parse collection-query params (`limit`, `cursor`, `order`, `filter[*]`)
 * into a {@link CollectionRequest}.
 *
 * - `limit`: absent -> COLLECTION_DEFAULT_LIMIT; above COLLECTION_MAX_LIMIT
 *   -> clamped; non-integer or negative -> `validation`. The first `limit`
 *   value wins when repeated.
 * - `cursor`: opaque passthrough (L3 validates).
 * - `order`: comma-split list, trimmed, empties dropped.
 * - `filter[<field>]`: string map passthrough — L3 validates field names and
 *   value shapes. Duplicate keys: last wins.
 */
export function parseCollectionQuery(url: URL): CollectionQueryOutcome {
  const params = url.searchParams;
  const limitRaw = params.get('limit');
  let limit = COLLECTION_DEFAULT_LIMIT;
  if (limitRaw !== null) {
    if (!/^-?\d+$/.test(limitRaw.trim())) {
      return { error: buildBusinessError('validation', 'Invalid limit.') };
    }
    const parsed = Number(limitRaw.trim());
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      return { error: buildBusinessError('validation', 'Invalid limit.') };
    }
    limit = Math.min(parsed, COLLECTION_MAX_LIMIT);
  }
  const cursor = params.get('cursor');
  const orderRaw = params.get('order');
  const order = orderRaw === null ? undefined : orderRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  const filters: Record<string, string> = {};
  let hasFilters = false;
  params.forEach((value, key) => {
    const match = FILTER_PARAM_PATTERN.exec(key);
    if (match?.[1] !== undefined) {
      filters[match[1]] = value;
      hasFilters = true;
    }
  });
  return {
    request: {
      limit,
      ...(cursor === null ? {} : { cursor }),
      ...(order === undefined ? {} : { order }),
      ...(hasFilters ? { filters } : {}),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Unauthenticated-auth rate-limit policy (all lane-06 authored).       */
/* ------------------------------------------------------------------ */

/** Standard auth attempts (login/register/verify) per client per window. */
export const RATE_LIMIT_AUTH = 10;
/** Standard auth window: one minute. */
export const RATE_LIMIT_WINDOW_MS = 60_000;
/** Recovery mails per client per window (stricter: sends email). */
export const RATE_LIMIT_RECOVERY = 5;
/** Recovery window: one hour. */
export const RATE_LIMIT_RECOVERY_WINDOW_MS = 3_600_000;

/**
 * Symbol-keyed Retry-After carrier on denied rate-limit errors. Symbols are
 * skipped by `JSON.stringify`, so the wire body stays the canonical
 * BusinessError while the caller can still read the throttle via
 * {@link retryAfterMsOf}.
 */
const RATE_LIMIT_RETRY_AFTER_MS = Symbol('canlang.rateLimitRetryAfterMs');

/** Read the throttle attached by {@link checkAuthRateLimit}, if any. */
export function retryAfterMsOf(error: BusinessError): number | null {
  const value = (error as unknown as Record<symbol, unknown>)[RATE_LIMIT_RETRY_AFTER_MS];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** True for the recovery routes, which use the stricter mail policy. */
function isRecoveryRoute(route: string): boolean {
  return route === '/auth/recover' || route === '/auth/recover/confirm';
}

/**
 * Fixed-window throttle for unauthenticated auth endpoints. The counter key
 * is `${route}:${clientKey(request)}` (best-effort IP key; spoofable headers
 * only feed this throttle, never identity). Recovery routes use the stricter
 * mail policy.
 *
 * Returns `null` when allowed, else a `limit` BusinessError carrying the
 * throttle under {@link retryAfterMsOf}; the caller sets the `Retry-After`
 * response header from it.
 */
export async function checkAuthRateLimit(
  deps: HttpDeps,
  route: string,
  request: Request,
): Promise<BusinessError | null> {
  const recovery = isRecoveryRoute(route);
  const decision = await deps.limiter.check(
    `${route}:${clientKey(request)}`,
    recovery ? RATE_LIMIT_RECOVERY : RATE_LIMIT_AUTH,
    recovery ? RATE_LIMIT_RECOVERY_WINDOW_MS : RATE_LIMIT_WINDOW_MS,
  );
  if (decision.allowed) return null;
  const error = buildBusinessError('limit', undefined, { retryable: true });
  (error as unknown as Record<symbol, unknown>)[RATE_LIMIT_RETRY_AFTER_MS] = decision.retryAfterMs;
  return error;
}
