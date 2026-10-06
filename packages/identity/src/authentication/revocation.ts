/**
 * Revocation entry points: sign-out, sign-out-everywhere, and grant
 * revocation. Unknown tokens revoke idempotently (no credential oracle);
 * already-revoked rows keep their original `revoked_at`.
 */
import type { McpGrant, Membership, Session } from '@canlang/contracts';
import { IdentityError, type IdentityStore } from '../ports.js';
import { sha256HexText } from '../sessions/tokens.js';

export async function revokeSessionByToken(
  store: IdentityStore,
  input: { token: string },
): Promise<{ revoked: true }> {
  const session = await store.findSessionByTokenHash(await sha256HexText(input.token));
  if (session !== null) {
    await store.revokeSession(session.session_id);
  }
  return { revoked: true };
}

export async function signOutEverywhere(
  store: IdentityStore,
  input: { user_id: string },
): Promise<{ revoked: true }> {
  await store.revokeUserSessions(input.user_id);
  await store.revokeUserMcpGrants(input.user_id);
  return { revoked: true };
}

export async function revokeMcpGrantByToken(
  store: IdentityStore,
  input: { token: string },
): Promise<{ revoked: true }> {
  const grant = await store.findMcpGrantByTokenHash(await sha256HexText(input.token));
  if (grant !== null) {
    await store.revokeMcpGrant(grant.grant_id);
  }
  return { revoked: true };
}

/* -- T32b commit-time authority liveness (adopted Alternative A). -- */

/**
 * True exactly when the LIVE membership row authorizes: present and
 * active. Anything else — removed, missing — carries no authority.
 */
export function isAuthorityLive(live: Membership | null): live is Membership {
  return live !== null && live.status === 'active';
}

/**
 * True when the commit must void for lost authority. The live row wins
 * UNCONDITIONALLY: a live active row clears even a removed checkpoint
 * snapshot (re-granted mid-flight), and a removed/missing live row voids
 * even an active checkpoint snapshot (revoked mid-flight). The checkpoint
 * snapshot is a parameter only to name the comparison point — it is never
 * trusted, and neither are caller claims. Fail closed throughout: no live
 * authority reads as revoked, whether the row was removed mid-flight or
 * never existed.
 */
export function authorityWasRevoked(
  checkpoint: Membership | null,
  live: Membership | null,
): boolean {
  void checkpoint;
  return !isAuthorityLive(live);
}

/**
 * T32b commit-time authority check: re-read the caller's membership from
 * CURRENT store facts and require it live. A revocation landing between
 * the operation's checkpoint and its commit voids the commit — the
 * already-admitted operation does NOT finish when its authority is gone.
 *
 * Scope choice (L291 NARROWER reading): revoked authority voids in-flight
 * commits, matching the proven Grant deactivate-then-deny immediacy
 * (removal ends new decisions immediately; the fence extends that
 * immediacy to commits). Still open: revocation racing an ALREADY-FENCED
 * commit batch — the storage-atomicity question for the durable fence
 * proof, not decided here.
 */
export async function assertAuthorityLive(
  store: Pick<IdentityStore, 'findMembership'>,
  input: { teamId: string; userId: string },
): Promise<Membership> {
  const live = await store.findMembership(input.teamId, input.userId);
  if (!isAuthorityLive(live)) {
    throw new IdentityError('forbidden', 'Authority revoked; the operation cannot commit.');
  }
  return live;
}

/* -- B4 commit-time credential liveness (mid-flight revocation fence). -- */

/**
 * True exactly when the LIVE credential row still admits: present,
 * unrevoked, and unexpired. Mirrors the admission rule in context.ts
 * (`resolveIdentity` rejects null, revoked, or `expires_at <= now`):
 * the boundary is exclusive — a credential expiring exactly at `now`
 * is already dead. Callers pass the CURRENT instant, never the
 * admission instant: re-checking against `admitted_at` would admit a
 * credential that expired mid-flight.
 */
export function isCredentialLive(
  row: Pick<Session, 'revoked_at' | 'expires_at'> | Pick<McpGrant, 'revoked_at' | 'expires_at'> | null,
  now: string,
): boolean {
  return row !== null && row.revoked_at === null && row.expires_at > now;
}

/**
 * B4 commit-time credential check: re-read the presented credential
 * from CURRENT store facts and require it live. A revocation (or
 * expiry) landing between admission and commit voids the in-flight
 * commit — the already-admitted operation does NOT finish on a dead
 * credential. Fail closed throughout: unknown hashes read as revoked.
 *
 * The failure message is deliberately identical to the admission
 * failure (`context.ts`): a mid-flight death must not oracle whether
 * the credential died at admission or after it.
 */
export async function assertCredentialLive(
  store: Pick<IdentityStore, 'findSessionByTokenHash' | 'findMcpGrantByTokenHash'>,
  input: { kind: 'session' | 'mcp_grant'; tokenHash: string; now: string },
): Promise<void> {
  const row =
    input.kind === 'session'
      ? await store.findSessionByTokenHash(input.tokenHash)
      : await store.findMcpGrantByTokenHash(input.tokenHash);
  if (!isCredentialLive(row, input.now)) {
    throw new IdentityError('forbidden', 'Session expired or revoked.');
  }
}
