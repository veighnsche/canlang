/**
 * MCP grant issuance (lane 06, S5).
 *
 * A grant binds one OAuth/MCP client connection to one verified user and
 * one team, per DESIGN section 10. The raw Bearer token is returned once
 * to the consenting caller; the store keeps only its SHA-256 hash, exactly
 * like session tokens. Resolution and revocation reuse the verified
 * `resolveIdentity` constructor plus the `mcp-grant` audience, so MCP
 * callers share the same principal model as browser sessions.
 */
import type { McpGrant, TeamId, UserId } from '@canlang/contracts';
import type { Clock, IdentityStore, RandomSource } from '../ports.js';
import { IdentityError, systemClock, toInstant, webRandom } from '../ports.js';
import { createOpaqueToken } from '../sessions/tokens.js';

/** Default grant lifetime: 30 days. Revocation ends it early. */
export const MCP_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface IssueMcpGrantInput {
  readonly user_id: UserId;
  /** Null only for app-only context in a non-team app. */
  readonly team_id: TeamId | null;
  readonly client_id: string;
}

export interface IssuedMcpGrant {
  /** Presented Bearer value. Shown once; never stored or logged. */
  readonly token: string;
  readonly grant: McpGrant;
}

/**
 * Issue a grant for an already-authenticated user. The caller must have
 * verified the session (consent endpoint, S7); this function mints and
 * persists, it does not authenticate.
 */
export async function issueMcpGrant(
  store: IdentityStore,
  input: IssueMcpGrantInput,
  opts: {
    clock?: Clock;
    random?: RandomSource;
    ttlMs?: number;
  } = {},
): Promise<IssuedMcpGrant> {
  if (input.client_id.trim() === '') {
    throw new IdentityError('validation', 'client_id is required.');
  }
  const clock = opts.clock ?? systemClock;
  const { token, token_sha256 } = await createOpaqueToken(opts.random ?? webRandom);
  const grant = await store.createMcpGrant({
    user_id: input.user_id,
    team_id: input.team_id,
    client_id: input.client_id,
    token_sha256,
    expires_at: toInstant(clock.nowMs() + (opts.ttlMs ?? MCP_GRANT_TTL_MS)),
  });
  return { token, grant };
}
