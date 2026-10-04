/**
 * Revocation entry points: sign-out, sign-out-everywhere, and grant
 * revocation. Unknown tokens revoke idempotently (no credential oracle);
 * already-revoked rows keep their original `revoked_at`.
 */
import type { IdentityStore } from '../ports.js';
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
