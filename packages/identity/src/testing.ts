/**
 * Test-only doubles: in-memory identity store, mail outbox, fixture seeder.
 *
 * NEVER a production binding. The memory store is single-threaded with a
 * naive revision counter that mirrors fence participation shape only; it
 * proves no concurrency semantics. Production binds `IdentityStore` to
 * lane-03 fenced D1 tables (join J2) and `MailPort` to the lane-04 mail
 * adapter. Import from tests only, never from `src/index.ts`.
 */
import type {
  EmailToken,
  InvitationId,
  McpGrant,
  McpGrantId,
  Membership,
  MembershipId,
  Session,
  SessionId,
  Team,
  TeamId,
  UserId,
} from '@canlang/contracts';
import { systemClock, toInstant, webRandom } from './ports.js';
import type {
  Clock,
  IdentityStore,
  MailPort,
  RandomSource,
  StoredUser,
  TeamInvitationRow,
} from './ports.js';

export function createMemoryIdentityStore(opts?: {
  clock?: Clock;
  random?: RandomSource;
}): IdentityStore & { revision(): number } {
  const clock = opts?.clock ?? systemClock;
  const random = opts?.random ?? webRandom;
  let revision = 0;
  const users = new Map<UserId, StoredUser>();
  const usersByEmail = new Map<string, UserId>();
  const teams = new Map<TeamId, Team>();
  const memberships = new Map<MembershipId, Membership>();
  const invitations = new Map<InvitationId, TeamInvitationRow & { invitation_id: InvitationId }>();
  const sessions = new Map<SessionId, Session>();
  const sessionsByHash = new Map<string, SessionId>();
  const emailTokens = new Map<string, EmailToken>();
  const emailTokensByHash = new Map<string, string>();
  const grants = new Map<McpGrantId, McpGrant>();
  const grantsByHash = new Map<string, McpGrantId>();

  const now = () => toInstant(clock.nowMs());
  const step = () => {
    revision += 1;
  };

  return {
    revision: () => revision,

    async createUser(input) {
      step();
      const user_id = random.randomUUID();
      const at = now();
      const row: StoredUser = {
        user_id,
        email: input.email,
        email_verified: input.email_verified,
        password_hash: input.password_hash,
        created_at: at,
        updated_at: at,
      };
      users.set(user_id, row);
      usersByEmail.set(input.email.toLowerCase(), user_id);
      return row;
    },
    async findUserByEmail(email) {
      return users.get(usersByEmail.get(email.toLowerCase()) ?? '') ?? null;
    },
    async findUserById(user_id) {
      return users.get(user_id) ?? null;
    },
    async setUserPassword(user_id, password_hash) {
      step();
      const row = users.get(user_id);
      if (row) users.set(user_id, { ...row, password_hash, updated_at: now() });
    },
    async setUserEmailVerified(user_id, verified) {
      step();
      const row = users.get(user_id);
      if (row) users.set(user_id, { ...row, email_verified: verified, updated_at: now() });
    },

    async createTeam(input) {
      step();
      const row: Team = {
        team_id: random.randomUUID(),
        timezone: input.timezone ?? 'UTC',
        created_at: now(),
      };
      teams.set(row.team_id, row);
      return row;
    },
    async findTeamById(team_id) {
      return teams.get(team_id) ?? null;
    },
    async setTeamTimezone(team_id, timezone) {
      step();
      const row = teams.get(team_id);
      if (row) teams.set(team_id, { ...row, timezone });
    },

    async createMembership(input) {
      step();
      const at = now();
      const row: Membership = {
        membership_id: random.randomUUID(),
        team_id: input.team_id,
        user_id: input.user_id,
        is_owner: input.is_owner,
        roles: input.roles,
        status: 'active',
        created_at: at,
        updated_at: at,
      };
      memberships.set(row.membership_id, row);
      return row;
    },
    async findMembership(team_id, user_id) {
      for (const row of memberships.values()) {
        if (row.team_id === team_id && row.user_id === user_id) return row;
      }
      return null;
    },
    async findMembershipById(membership_id) {
      return memberships.get(membership_id) ?? null;
    },
    async listActiveOwners(team_id) {
      return [...memberships.values()].filter(
        (row) => row.team_id === team_id && row.status === 'active' && row.is_owner,
      );
    },
    async setMembershipRoles(membership_id, roles) {
      step();
      const row = memberships.get(membership_id);
      if (row) memberships.set(membership_id, { ...row, roles, updated_at: now() });
    },
    async setMembershipOwner(membership_id, is_owner) {
      step();
      const row = memberships.get(membership_id);
      if (row) memberships.set(membership_id, { ...row, is_owner, updated_at: now() });
    },
    async removeMembership(membership_id) {
      step();
      const row = memberships.get(membership_id);
      if (row) memberships.set(membership_id, { ...row, status: 'removed', updated_at: now() });
    },
    async reactivateMembership(membership_id, input) {
      step();
      const row = memberships.get(membership_id);
      if (row) {
        memberships.set(membership_id, {
          ...row,
          status: 'active',
          is_owner: input.is_owner,
          roles: input.roles,
          updated_at: now(),
        });
      }
    },

    async createInvitation(input) {
      step();
      const invitation_id = random.randomUUID();
      invitations.set(invitation_id, {
        invitation_id,
        team_id: input.team_id,
        email: input.email,
        grants_owner: input.grants_owner,
        grants_roles: input.grants_roles,
        invited_by: input.invited_by,
        created_at: now(),
        expires_at: input.expires_at,
        accepted_at: null,
        revoked_at: null,
      });
      return { invitation_id };
    },
    async findInvitationById(invitation_id) {
      return invitations.get(invitation_id) ?? null;
    },
    async acceptInvitation(invitation_id) {
      step();
      const row = invitations.get(invitation_id);
      if (row) invitations.set(invitation_id, { ...row, accepted_at: now() });
    },
    async revokeInvitation(invitation_id) {
      step();
      const row = invitations.get(invitation_id);
      if (row) invitations.set(invitation_id, { ...row, revoked_at: now() });
    },
    async revokePendingTeamInvitationsForEmail(team_id, email) {
      step();
      const at = now();
      for (const [id, row] of invitations) {
        if (
          row.team_id === team_id &&
          row.email.toLowerCase() === email.toLowerCase() &&
          row.accepted_at === null &&
          row.revoked_at === null
        ) {
          invitations.set(id, { ...row, revoked_at: at });
        }
      }
    },

    async createSession(input) {
      step();
      const row: Session = {
        session_id: random.randomUUID(),
        user_id: input.user_id,
        token_sha256: input.token_sha256,
        created_at: now(),
        expires_at: input.expires_at,
        revoked_at: null,
        last_team_id: input.last_team_id,
      };
      sessions.set(row.session_id, row);
      sessionsByHash.set(input.token_sha256, row.session_id);
      return row;
    },
    async findSessionByTokenHash(token_sha256) {
      return sessions.get(sessionsByHash.get(token_sha256) ?? '') ?? null;
    },
    async setSessionTeam(session_id, team_id) {
      step();
      const row = sessions.get(session_id);
      if (row) sessions.set(session_id, { ...row, last_team_id: team_id });
    },
    async revokeSession(session_id) {
      step();
      const row = sessions.get(session_id);
      if (row && row.revoked_at === null) {
        sessions.set(session_id, { ...row, revoked_at: now() });
      }
    },
    async revokeUserSessions(user_id) {
      step();
      const at = now();
      for (const [id, row] of sessions) {
        if (row.user_id === user_id && row.revoked_at === null) {
          sessions.set(id, { ...row, revoked_at: at });
        }
      }
    },

    async createEmailToken(input) {
      step();
      const token_id = random.randomUUID();
      const row: EmailToken = {
        token_id,
        user_id: input.user_id,
        purpose: input.purpose,
        token_sha256: input.token_sha256,
        created_at: now(),
        expires_at: input.expires_at,
        consumed_at: null,
      };
      emailTokens.set(token_id, row);
      emailTokensByHash.set(input.token_sha256, token_id);
      return { token_id };
    },
    async findEmailTokenByHash(token_sha256) {
      return emailTokens.get(emailTokensByHash.get(token_sha256) ?? '') ?? null;
    },
    async consumeEmailToken(token_id) {
      step();
      const row = emailTokens.get(token_id);
      if (row && row.consumed_at === null) {
        emailTokens.set(token_id, { ...row, consumed_at: now() });
      }
    },
    async revokeUserEmailTokens(user_id, purpose) {
      step();
      const at = now();
      for (const [id, row] of emailTokens) {
        if (row.user_id === user_id && row.purpose === purpose && row.consumed_at === null) {
          emailTokens.set(id, { ...row, consumed_at: at });
        }
      }
    },

    async createMcpGrant(input) {
      step();
      const row: McpGrant = {
        grant_id: random.randomUUID(),
        user_id: input.user_id,
        team_id: input.team_id,
        client_id: input.client_id,
        token_sha256: input.token_sha256,
        issued_at: now(),
        expires_at: input.expires_at,
        revoked_at: null,
      };
      grants.set(row.grant_id, row);
      grantsByHash.set(input.token_sha256, row.grant_id);
      return row;
    },
    async findMcpGrantByTokenHash(token_sha256) {
      return grants.get(grantsByHash.get(token_sha256) ?? '') ?? null;
    },
    async revokeMcpGrant(grant_id) {
      step();
      const row = grants.get(grant_id);
      if (row && row.revoked_at === null) {
        grants.set(grant_id, { ...row, revoked_at: now() });
      }
    },
    async revokeUserMcpGrants(user_id) {
      step();
      const at = now();
      for (const [id, row] of grants) {
        if (row.user_id === user_id && row.revoked_at === null) {
          grants.set(id, { ...row, revoked_at: at });
        }
      }
    },
    async revokeUserTeamMcpGrants(user_id, team_id) {
      step();
      const at = now();
      for (const [id, row] of grants) {
        if (row.user_id === user_id && row.team_id === team_id && row.revoked_at === null) {
          grants.set(id, { ...row, revoked_at: at });
        }
      }
    },
  };
}

export interface CapturedMail {
  readonly to: string;
  readonly subject: string;
  readonly body_text: string;
}

export function createTestMailOutbox(): MailPort & { messages: CapturedMail[] } {
  const messages: CapturedMail[] = [];
  return {
    messages,
    async sendMail(to, subject, body_text) {
      messages.push({ to, subject, body_text });
    },
  };
}

export function createFrozenClock(startMs: number): Clock & { advance(ms: number): void } {
  let now = startMs;
  return {
    nowMs: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
