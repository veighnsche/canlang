/**
 * Anonymous pre-session tokens: the login-CSRF guard.
 *
 * Threat: a cross-site forgery POSTs attacker credentials to `/auth/login`
 * and the response plants the attacker's session in the victim's browser
 * (session planting). The session-bound CSRF token cannot help here —
 * there is no session yet — so the login GET mints a single-use anonymous
 * token and the login POST must present it. The raw value travels only in
 * the same-origin descriptor response, which a cross-site page cannot read
 * (same-origin policy), so verification is server-enforced in every
 * browser rather than delegated to cookie handling.
 *
 * Lifecycle: `mintPreSessionToken` stores only the SHA-256 hash (opaque
 * bearer, same primitives as sessions); `consumePreSessionToken` verifies
 * then hard-deletes, so every token is good for exactly one
 * credential-checked POST — a failed login refetches the descriptor.
 * Expired rows met
 * during consume are deleted too; never-minted-presented rows linger until
 * expiry at most (bounded by the mint throttle + 10-minute TTL).
 */
import type { Clock, IdentityStore, RandomSource } from '../ports.js';
import { systemClock, toInstant, webRandom } from '../ports.js';
import { createOpaqueToken, sha256HexText } from './tokens.js';

/** Pre-session TTL: ten minutes to fill in the login form. */
export const PRESESSION_TTL_MS = 10 * 60_000;

export interface MintPreSessionOptions {
  readonly clock?: Clock;
  readonly random?: RandomSource;
  readonly ttlMs?: number;
}

/** Mint one anonymous single-use login token; the raw value goes to the
 * descriptor response only. */
export async function mintPreSessionToken(
  store: IdentityStore,
  opts: MintPreSessionOptions = {},
): Promise<{ token: string }> {
  const clock = opts.clock ?? systemClock;
  const random = opts.random ?? webRandom;
  const { token, token_sha256 } = await createOpaqueToken(random);
  await store.createPreSessionToken({
    token_sha256,
    expires_at: toInstant(clock.nowMs() + (opts.ttlMs ?? PRESESSION_TTL_MS)),
  });
  return { token };
}

export interface ConsumePreSessionOptions {
  readonly clock?: Clock;
}

/**
 * Verify a presented token, then delete it. True only for a live stored
 * token; false for missing, malformed, unknown, or expired values — with
 * no observable distinction between them. Verify-before-delete: an invalid
 * presentation burns nothing.
 */
export async function consumePreSessionToken(
  store: IdentityStore,
  presented: unknown,
  opts: ConsumePreSessionOptions = {},
): Promise<boolean> {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const clock = opts.clock ?? systemClock;
  const row = await store.findPreSessionTokenByHash(await sha256HexText(presented));
  if (row === null) return false;
  await store.deletePreSessionToken(row.token_id);
  return Date.parse(row.expires_at) > clock.nowMs();
}
