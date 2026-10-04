/**
 * Team selection on a browser session (DESIGN section 4: default teams
 * support includes team selection; section 9: context switching rechecks
 * access and clears prior-context data).
 *
 * Selection records a hint on the session row; every admission re-resolves
 * team existence and active membership from current facts, so the hint
 * alone never grants anything. Clearing the selection returns the session
 * to app-only context for non-team apps. Both functions take the raw
 * session bearer and hash it internally, like `resolveIdentity`.
 */
import { IdentityError, systemClock, toInstant } from '../ports.js';
import type { Clock, IdentityStore } from '../ports.js';
import type { Session } from '@canlang/contracts';
import { sha256HexText } from '../sessions/tokens.js';

async function liveSession(
  store: IdentityStore,
  session_token: string,
  now: string,
): Promise<Session> {
  const session = await store.findSessionByTokenHash(await sha256HexText(session_token));
  if (session === null || session.revoked_at !== null || session.expires_at <= now) {
    throw new IdentityError('forbidden', 'Session expired or revoked.');
  }
  return session;
}

export async function selectTeam(
  store: IdentityStore,
  input: { session_token: string; team_id: string },
  opts: { clock?: Clock } = {},
): Promise<{ team_id: string }> {
  const clock = opts.clock ?? systemClock;
  const session = await liveSession(store, input.session_token, toInstant(clock.nowMs()));
  const team = await store.findTeamById(input.team_id);
  if (team === null) {
    throw new IdentityError('not_found', 'Team not found.');
  }
  const membership = await store.findMembership(input.team_id, session.user_id);
  if (membership === null || membership.status !== 'active') {
    throw new IdentityError('forbidden', 'Not a member of this team.');
  }
  await store.setSessionTeam(session.session_id, input.team_id);
  return { team_id: input.team_id };
}

export async function clearTeamSelection(
  store: IdentityStore,
  input: { session_token: string },
  opts: { clock?: Clock } = {},
): Promise<{ cleared: true }> {
  const clock = opts.clock ?? systemClock;
  const session = await liveSession(store, input.session_token, toInstant(clock.nowMs()));
  await store.setSessionTeam(session.session_id, null);
  return { cleared: true };
}
