/**
 * The one verified identity constructor: resolves session bearers, MCP
 * grant bearers, and public callers into `ResolvedIdentity`.
 *
 * Both transports call this on every discovery and every invocation and
 * recheck from current store facts; results are never cached across
 * callers, teams, or revisions (DESIGN sections 4, 9, 10). Session expiry
 * and revocation, grant expiry and revocation, team existence, and active
 * membership are all evaluated here at the admission checkpoint. A
 * completed membership removal ends new grant admissions immediately;
 * already admitted operations may finish (their fence, not this snapshot,
 * governs them).
 *
 * Failure messages deliberately collapse missing/revoked/expired credentials
 * into one text: credential validity is not an oracle.
 */
import {
  IdentityError,
  systemClock,
  toInstant,
} from '../ports.js';
import type { Clock, IdentityStore } from '../ports.js';
import type {
  Membership,
  ResolvedIdentity,
  Team,
} from '@canlang/contracts';
import { sha256HexText } from '../sessions/tokens.js';

const CREDENTIAL_FAILED = 'Session expired or revoked.';

export interface ResolveIdentityInput {
  readonly session_token?: string;
  readonly mcp_grant_token?: string;
  /** Explicit team scope; overrides the session's recorded selection. */
  readonly team_id?: string;
}

async function resolveSessionTeam(
  store: IdentityStore,
  team_id: string | null,
  explicit: boolean,
): Promise<Team | null> {
  if (team_id === null) return null;
  const team = await store.findTeamById(team_id);
  if (team === null && explicit) {
    throw new IdentityError('not_found', 'Team not found.');
  }
  // A stale recorded hint never fails resolution; it simply selects nothing.
  return team;
}

async function activeMembership(
  store: IdentityStore,
  team: Team | null,
  user_id: string,
): Promise<Membership | null> {
  if (team === null) return null;
  const membership = await store.findMembership(team.team_id, user_id);
  if (membership === null || membership.status !== 'active') return null;
  return membership;
}

export async function resolveIdentity(
  store: IdentityStore,
  input: ResolveIdentityInput,
  opts: { clock?: Clock } = {},
): Promise<ResolvedIdentity> {
  // The admission instant always comes from the injected clock. Callers must
  // never supply it: a caller-chosen `now` would admit expired credentials.
  const clock = opts.clock ?? systemClock;
  const now = toInstant(clock.nowMs());
  const hasSession = input.session_token !== undefined;
  const hasGrant = input.mcp_grant_token !== undefined;
  if (hasSession && hasGrant) {
    throw new IdentityError('validation', 'Present at most one credential.');
  }

  if (!hasSession && !hasGrant) {
    const team =
      input.team_id === undefined
        ? null
        : await resolveSessionTeam(store, input.team_id, true);
    return { actor: null, team, membership: null, binding: { kind: 'none' }, admitted_at: now };
  }

  if (hasSession) {
    const session = await store.findSessionByTokenHash(
      await sha256HexText(input.session_token ?? ''),
    );
    if (session === null || session.revoked_at !== null || session.expires_at <= now) {
      throw new IdentityError('forbidden', CREDENTIAL_FAILED);
    }
    const user = await store.findUserById(session.user_id);
    if (user === null) {
      throw new IdentityError('forbidden', CREDENTIAL_FAILED);
    }
    const explicit = input.team_id !== undefined;
    const team = await resolveSessionTeam(
      store,
      explicit ? (input.team_id as string) : session.last_team_id,
      explicit,
    );
    return {
      actor: {
        user_id: user.user_id,
        email: user.email,
        email_verified: user.email_verified,
      },
      team,
      membership: await activeMembership(store, team, user.user_id),
      binding: { kind: 'session', session_id: session.session_id },
      admitted_at: now,
    };
  }

  const grant = await store.findMcpGrantByTokenHash(
    await sha256HexText(input.mcp_grant_token ?? ''),
  );
  if (grant === null || grant.revoked_at !== null || grant.expires_at <= now) {
    throw new IdentityError('forbidden', CREDENTIAL_FAILED);
  }
  const user = await store.findUserById(grant.user_id);
  if (user === null) {
    throw new IdentityError('forbidden', CREDENTIAL_FAILED);
  }
  if (input.team_id !== undefined && input.team_id !== grant.team_id) {
    // Deliberately distinct: the holder consented to a known team, so naming
    // the binding is actionable guidance, not a credential oracle.
    throw new IdentityError(
      'forbidden',
      'This connection is bound to a different team; re-authorize to switch.',
    );
  }
  const team = grant.team_id === null ? null : await store.findTeamById(grant.team_id);
  if (grant.team_id !== null) {
    const membership = await activeMembership(store, team, user.user_id);
    if (membership === null) {
      // Collapsed: a stolen-grant holder cannot distinguish removal from
      // expiry/revocation.
      throw new IdentityError('forbidden', CREDENTIAL_FAILED);
    }
    return {
      actor: {
        user_id: user.user_id,
        email: user.email,
        email_verified: user.email_verified,
      },
      team,
      membership,
      binding: { kind: 'mcp_grant', grant_id: grant.grant_id },
      admitted_at: now,
    };
  }
  return {
    actor: {
      user_id: user.user_id,
      email: user.email,
      email_verified: user.email_verified,
    },
    team: null,
    membership: null,
    binding: { kind: 'mcp_grant', grant_id: grant.grant_id },
    admitted_at: now,
  };
}
