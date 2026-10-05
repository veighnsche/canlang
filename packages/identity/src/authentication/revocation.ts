/**
 * Revocation entry points: sign-out, sign-out-everywhere, and grant
 * revocation. Unknown tokens revoke idempotently (no credential oracle);
 * already-revoked rows keep their original `revoked_at`.
 */
import type { Membership } from '@canlang/contracts';
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
