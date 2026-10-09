/**
 * Production D1-backed `IdentityStore` (MCP deploy packet P-C).
 *
 * The first production binding of `IdentityStore` (`../ports.ts`): every
 * account/session/membership/grant fact lives in `identity_*` D1 tables
 * (same database as the state `records` tables, disjoint names). The MCP
 * server resolves grant Bearers through this store on every discovery
 * and every call; the production grant route mints through it.
 *
 * WORKERD-SAFE: no `node:` imports, no I/O beyond the injected database,
 * randomness via the injected `RandomSource` (default WebCrypto),
 * timestamps via the injected `Clock`. SQL is portable SQLite (D1's
 * dialect): single-line statements, `?` placeholders, no `RETURNING`
 * (created rows are constructed from inputs, exactly like the memory
 * store, so reads never depend on write-return shapes).
 *
 * FENCE LIMITATION (loud): each method is ONE statement (atomic), but
 * multi-step feature operations (last-owner guards, recovery cascades,
 * re-admission races) are check-then-act across calls WITHOUT the
 * lane-03 revision fence (`ports.ts` join J2). The UNIQUE constraints
 * below (email, token hashes, one (team, user) row) make the dangerous
 * collisions fail loud instead of duplicating; the J2 fence join makes
 * the guards atomic. The MCP path this packet serves rechecks current
 * facts per call, which is exactly what the unfenced store guarantees.
 *
 * Schema ownership: `ensureIdentitySchema` creates every table/index
 * idempotently (`IF NOT EXISTS`, safe to re-run). The deploy constructor
 * (`@canlang/cloudflare` `runtime/env-assembly.ts`) runs it; tests run
 * it directly. Tables are `identity_*`-prefixed so they never collide
 * with the state engine's `records`/`fence_log`/outbox tables.
 */
import type {
  AuthCode,
  EmailToken,
  InvitationId,
  McpGrant,
  Membership,
  MembershipId,
  OAuthClient,
  OAuthClientId,
  PreSessionToken,
  Session,
  SessionId,
  Team,
  TeamId,
  UserId,
} from '@canlang/contracts';
import type {
  Clock,
  IdentityStore,
  RandomSource,
  StoredUser,
  TeamInvitationRow,
} from '../ports.js';
import { systemClock, toInstant, webRandom } from '../ports.js';

/* ------------------------------------------------------------------ */
/* Minimal D1 surface. No `@cloudflare/workers-types` import: this     */
/* package must stay dependency-light and workerd-safe, so the store   */
/* depends only on the statements it issues. A real `D1Database`       */
/* satisfies this interface structurally (proven by the cloudflare     */
/* suite, which passes a miniflare D1 binding straight in).            */
/* ------------------------------------------------------------------ */

/**
 * Bound statement: exactly the terminals the store uses. `first` carries
 * the real `D1PreparedStatement` overloads verbatim so a genuine D1
 * binding satisfies this interface structurally with no adapter.
 */
export interface IdentityD1BoundStatement {
  first<T = unknown>(column: string): Promise<T | null>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ readonly results: readonly T[] }>;
  run<T = Record<string, unknown>>(): Promise<unknown>;
}

/** Prepared statement: bind-only (the store never interpolates values). */
export interface IdentityD1Statement {
  bind(...values: unknown[]): IdentityD1BoundStatement;
}

/** Database handle: prepare for queries, exec for idempotent DDL. */
export interface IdentityD1Database {
  prepare(sql: string): IdentityD1Statement;
  exec(sql: string): Promise<unknown>;
}

/* ------------------------------------------------------------------ */
/* Schema. One single-line statement per entry, no trailing semicolon  */
/* (the proven `db.exec` shape). UNIQUE constraints fail loud on the   */
/* collisions the memory store cannot express.                         */
/* ------------------------------------------------------------------ */

const IDENTITY_USERS_DDL =
  'CREATE TABLE IF NOT EXISTS identity_users (user_id TEXT PRIMARY KEY, email TEXT NOT NULL, email_lc TEXT NOT NULL UNIQUE, email_verified INTEGER NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)';

const IDENTITY_TEAMS_DDL =
  'CREATE TABLE IF NOT EXISTS identity_teams (team_id TEXT PRIMARY KEY, timezone TEXT NOT NULL, created_at TEXT NOT NULL)';

const IDENTITY_MEMBERSHIPS_DDL =
  'CREATE TABLE IF NOT EXISTS identity_memberships (membership_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, user_id TEXT NOT NULL, is_owner INTEGER NOT NULL, roles TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(team_id, user_id))';

const IDENTITY_INVITATIONS_DDL =
  'CREATE TABLE IF NOT EXISTS identity_invitations (invitation_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, email TEXT NOT NULL, email_lc TEXT NOT NULL, grants_owner INTEGER NOT NULL, grants_roles TEXT NOT NULL, invited_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, accepted_at TEXT NULL, revoked_at TEXT NULL)';

const IDENTITY_SESSIONS_DDL =
  'CREATE TABLE IF NOT EXISTS identity_sessions (session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_sha256 TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT NULL, last_team_id TEXT NULL)';

const IDENTITY_EMAIL_TOKENS_DDL =
  'CREATE TABLE IF NOT EXISTS identity_email_tokens (token_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purpose TEXT NOT NULL, token_sha256 TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT NULL)';

const IDENTITY_PRESESSION_TOKENS_DDL =
  'CREATE TABLE IF NOT EXISTS identity_presession_tokens (token_id TEXT PRIMARY KEY, token_sha256 TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)';

const IDENTITY_MCP_GRANTS_DDL =
  'CREATE TABLE IF NOT EXISTS identity_mcp_grants (grant_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, team_id TEXT NULL, client_id TEXT NOT NULL, token_sha256 TEXT NOT NULL UNIQUE, issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT NULL)';

const IDENTITY_OAUTH_CLIENTS_DDL =
  'CREATE TABLE IF NOT EXISTS identity_oauth_clients (client_id TEXT PRIMARY KEY, client_name TEXT NOT NULL, redirect_uris TEXT NOT NULL, registered_at TEXT NOT NULL)';

const IDENTITY_AUTH_CODES_DDL =
  'CREATE TABLE IF NOT EXISTS identity_auth_codes (code_sha256 TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, team_id TEXT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT NULL)';

const IDENTITY_INDEXES: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS identity_memberships_user ON identity_memberships (user_id)',
  'CREATE INDEX IF NOT EXISTS identity_memberships_team ON identity_memberships (team_id)',
  'CREATE INDEX IF NOT EXISTS identity_invitations_team_email ON identity_invitations (team_id, email_lc)',
  'CREATE INDEX IF NOT EXISTS identity_sessions_user ON identity_sessions (user_id)',
  'CREATE INDEX IF NOT EXISTS identity_email_tokens_user ON identity_email_tokens (user_id)',
  'CREATE INDEX IF NOT EXISTS identity_mcp_grants_user ON identity_mcp_grants (user_id)',
];

/** Every identity DDL statement, in creation order (tables first, then indexes). */
export const IDENTITY_DDL: readonly string[] = [
  IDENTITY_USERS_DDL,
  IDENTITY_TEAMS_DDL,
  IDENTITY_MEMBERSHIPS_DDL,
  IDENTITY_INVITATIONS_DDL,
  IDENTITY_SESSIONS_DDL,
  IDENTITY_PRESESSION_TOKENS_DDL,
  IDENTITY_EMAIL_TOKENS_DDL,
  IDENTITY_MCP_GRANTS_DDL,
  IDENTITY_OAUTH_CLIENTS_DDL,
  IDENTITY_AUTH_CODES_DDL,
  ...IDENTITY_INDEXES,
];

/** Run each schema statement sequentially; idempotent, safe to re-run. */
export async function ensureIdentitySchema(db: IdentityD1Database): Promise<void> {
  for (const statement of IDENTITY_DDL) {
    await db.exec(statement);
  }
}

/* ------------------------------------------------------------------ */
/* Row shapes (snake_case columns as D1 returns them) + mappers.       */
/* ------------------------------------------------------------------ */

interface UserRow {
  readonly user_id: string;
  readonly email: string;
  readonly email_verified: number;
  readonly password_hash: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const USER_COLUMNS =
  'user_id, email, email_verified, password_hash, created_at, updated_at';

function toStoredUser(row: UserRow): StoredUser {
  return {
    user_id: row.user_id as UserId,
    email: row.email,
    email_verified: row.email_verified === 1,
    password_hash: row.password_hash,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

interface TeamRow {
  readonly team_id: string;
  readonly timezone: string;
  readonly created_at: string;
}

const TEAM_COLUMNS = 'team_id, timezone, created_at';

function toTeam(row: TeamRow): Team {
  return { team_id: row.team_id as TeamId, timezone: row.timezone, created_at: row.created_at };
}

interface MembershipRow {
  readonly membership_id: string;
  readonly team_id: string;
  readonly user_id: string;
  readonly is_owner: number;
  readonly roles: string;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const MEMBERSHIP_COLUMNS =
  'membership_id, team_id, user_id, is_owner, roles, status, created_at, updated_at';

function toMembership(row: MembershipRow): Membership {
  if (row.status !== 'active' && row.status !== 'removed') {
    throw new Error(
      `identity-d1: membership ${JSON.stringify(row.membership_id)} has corrupt status ${JSON.stringify(row.status)}`,
    );
  }
  let roles: Membership['roles'];
  try {
    roles = JSON.parse(row.roles) as Membership['roles'];
  } catch {
    throw new Error(
      `identity-d1: membership ${JSON.stringify(row.membership_id)} has corrupt roles JSON`,
    );
  }
  return {
    membership_id: row.membership_id as MembershipId,
    team_id: row.team_id as TeamId,
    user_id: row.user_id as UserId,
    is_owner: row.is_owner === 1,
    roles,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

interface InvitationRow {
  readonly invitation_id: string;
  readonly team_id: string;
  readonly email: string;
  readonly grants_owner: number;
  readonly grants_roles: string;
  readonly invited_by: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly accepted_at: string | null;
  readonly revoked_at: string | null;
}

const INVITATION_COLUMNS =
  'invitation_id, team_id, email, grants_owner, grants_roles, invited_by, created_at, expires_at, accepted_at, revoked_at';

function toInvitation(row: InvitationRow): TeamInvitationRow & { invitation_id: InvitationId } {
  let grants_roles: readonly string[];
  try {
    grants_roles = JSON.parse(row.grants_roles) as readonly string[];
  } catch {
    throw new Error(
      `identity-d1: invitation ${JSON.stringify(row.invitation_id)} has corrupt grants_roles JSON`,
    );
  }
  return {
    invitation_id: row.invitation_id as InvitationId,
    team_id: row.team_id as TeamId,
    email: row.email,
    grants_owner: row.grants_owner === 1,
    grants_roles,
    invited_by: row.invited_by as UserId,
    created_at: row.created_at,
    expires_at: row.expires_at,
    accepted_at: row.accepted_at,
    revoked_at: row.revoked_at,
  };
}

interface SessionRow {
  readonly session_id: string;
  readonly user_id: string;
  readonly token_sha256: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly revoked_at: string | null;
  readonly last_team_id: string | null;
}

const SESSION_COLUMNS =
  'session_id, user_id, token_sha256, created_at, expires_at, revoked_at, last_team_id';

function toSession(row: SessionRow): Session {
  return {
    session_id: row.session_id as SessionId,
    user_id: row.user_id as UserId,
    token_sha256: row.token_sha256,
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    last_team_id: row.last_team_id === null ? null : (row.last_team_id as TeamId),
  };
}

interface PreSessionTokenRow {
  readonly token_id: string;
  readonly token_sha256: string;
  readonly created_at: string;
  readonly expires_at: string;
}

const PRESESSION_TOKEN_COLUMNS = 'token_id, token_sha256, created_at, expires_at';

function toPreSessionToken(row: PreSessionTokenRow): PreSessionToken {
  return {
    token_id: row.token_id,
    token_sha256: row.token_sha256,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

interface EmailTokenRow {
  readonly token_id: string;
  readonly user_id: string;
  readonly purpose: string;
  readonly token_sha256: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
}

const EMAIL_TOKEN_COLUMNS =
  'token_id, user_id, purpose, token_sha256, created_at, expires_at, consumed_at';

function toEmailToken(row: EmailTokenRow): EmailToken {
  if (row.purpose !== 'verify_email' && row.purpose !== 'recover_account' && row.purpose !== 'accept_invitation') {
    throw new Error(
      `identity-d1: email token ${JSON.stringify(row.token_id)} has corrupt purpose ${JSON.stringify(row.purpose)}`,
    );
  }
  return {
    token_id: row.token_id,
    user_id: row.user_id as UserId,
    purpose: row.purpose,
    token_sha256: row.token_sha256,
    created_at: row.created_at,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
  };
}

interface McpGrantRow {
  readonly grant_id: string;
  readonly user_id: string;
  readonly team_id: string | null;
  readonly client_id: string;
  readonly token_sha256: string;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly revoked_at: string | null;
}

const MCP_GRANT_COLUMNS =
  'grant_id, user_id, team_id, client_id, token_sha256, issued_at, expires_at, revoked_at';

function toMcpGrant(row: McpGrantRow): McpGrant {
  return {
    grant_id: row.grant_id,
    user_id: row.user_id as UserId,
    team_id: row.team_id === null ? null : (row.team_id as TeamId),
    client_id: row.client_id,
    token_sha256: row.token_sha256,
    issued_at: row.issued_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
  };
}

interface OAuthClientRow {
  readonly client_id: string;
  readonly client_name: string;
  readonly redirect_uris: string;
  readonly registered_at: string;
}

const OAUTH_CLIENT_COLUMNS = 'client_id, client_name, redirect_uris, registered_at';

function toOAuthClient(row: OAuthClientRow): OAuthClient {
  let redirect_uris: readonly string[];
  try {
    redirect_uris = JSON.parse(row.redirect_uris) as readonly string[];
  } catch {
    throw new Error(
      `identity-d1: oauth client ${JSON.stringify(row.client_id)} has corrupt redirect_uris JSON`,
    );
  }
  return {
    client_id: row.client_id as OAuthClientId,
    client_name: row.client_name,
    redirect_uris,
    registered_at: row.registered_at,
  };
}

interface AuthCodeRow {
  readonly code_sha256: string;
  readonly client_id: string;
  readonly user_id: string;
  readonly team_id: string | null;
  readonly redirect_uri: string;
  readonly code_challenge: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly consumed_at: string | null;
}

const AUTH_CODE_COLUMNS =
  'code_sha256, client_id, user_id, team_id, redirect_uri, code_challenge, created_at, expires_at, consumed_at';

function toAuthCode(row: AuthCodeRow): AuthCode {
  return {
    code_sha256: row.code_sha256,
    client_id: row.client_id as OAuthClientId,
    user_id: row.user_id as UserId,
    team_id: row.team_id === null ? null : (row.team_id as TeamId),
    redirect_uri: row.redirect_uri,
    code_challenge: row.code_challenge,
    created_at: row.created_at,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
  };
}

/* ------------------------------------------------------------------ */
/* Store.                                                              */
/* ------------------------------------------------------------------ */

/**
 * Production `IdentityStore` over D1. Call `ensureIdentitySchema(db)` once
 * before first use (the deploy constructor does; re-runs are safe).
 *
 * ID minting mirrors the memory store exactly (UUIDv7-capable `randomUUID`
 * for row ids, `client_<16 hex>` for OAuth clients) so fixtures and
 * production mint indistinguishable identifiers.
 */
export function createD1IdentityStore(
  db: IdentityD1Database,
  opts: {
    clock?: Clock;
    random?: RandomSource;
  } = {},
): IdentityStore {
  const clock = opts.clock ?? systemClock;
  const random = opts.random ?? webRandom;
  const now = () => toInstant(clock.nowMs());

  return {
    async createUser(input) {
      const user_id = random.randomUUID();
      const at = now();
      await db
        .prepare(
          'INSERT INTO identity_users (user_id, email, email_lc, email_verified, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          user_id,
          input.email,
          input.email.toLowerCase(),
          input.email_verified ? 1 : 0,
          input.password_hash,
          at,
          at,
        )
        .run();
      return {
        user_id,
        email: input.email,
        email_verified: input.email_verified,
        password_hash: input.password_hash,
        created_at: at,
        updated_at: at,
      };
    },
    async findUserByEmail(email) {
      const row = await db
        .prepare(`SELECT ${USER_COLUMNS} FROM identity_users WHERE email_lc = ?`)
        .bind(email.toLowerCase())
        .first<UserRow>();
      return row === null ? null : toStoredUser(row);
    },
    async findUserById(user_id) {
      const row = await db
        .prepare(`SELECT ${USER_COLUMNS} FROM identity_users WHERE user_id = ?`)
        .bind(user_id)
        .first<UserRow>();
      return row === null ? null : toStoredUser(row);
    },
    async setUserPassword(user_id, password_hash) {
      await db
        .prepare('UPDATE identity_users SET password_hash = ?, updated_at = ? WHERE user_id = ?')
        .bind(password_hash, now(), user_id)
        .run();
    },
    async setUserEmailVerified(user_id, verified) {
      await db
        .prepare('UPDATE identity_users SET email_verified = ?, updated_at = ? WHERE user_id = ?')
        .bind(verified ? 1 : 0, now(), user_id)
        .run();
    },

    async createTeam(input) {
      const row: Team = {
        team_id: random.randomUUID(),
        timezone: input.timezone ?? 'UTC',
        created_at: now(),
      };
      await db
        .prepare('INSERT INTO identity_teams (team_id, timezone, created_at) VALUES (?, ?, ?)')
        .bind(row.team_id, row.timezone, row.created_at)
        .run();
      return row;
    },
    async findTeamById(team_id) {
      const row = await db
        .prepare(`SELECT ${TEAM_COLUMNS} FROM identity_teams WHERE team_id = ?`)
        .bind(team_id)
        .first<TeamRow>();
      return row === null ? null : toTeam(row);
    },
    async setTeamTimezone(team_id, timezone) {
      await db
        .prepare('UPDATE identity_teams SET timezone = ? WHERE team_id = ?')
        .bind(timezone, team_id)
        .run();
    },

    async createMembership(input) {
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
      await db
        .prepare(
          'INSERT INTO identity_memberships (membership_id, team_id, user_id, is_owner, roles, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          row.membership_id,
          row.team_id,
          row.user_id,
          row.is_owner ? 1 : 0,
          JSON.stringify([...row.roles]),
          row.status,
          row.created_at,
          row.updated_at,
        )
        .run();
      return row;
    },
    async findMembership(team_id, user_id) {
      const row = await db
        .prepare(`SELECT ${MEMBERSHIP_COLUMNS} FROM identity_memberships WHERE team_id = ? AND user_id = ?`)
        .bind(team_id, user_id)
        .first<MembershipRow>();
      return row === null ? null : toMembership(row);
    },
    async findMembershipById(membership_id) {
      const row = await db
        .prepare(`SELECT ${MEMBERSHIP_COLUMNS} FROM identity_memberships WHERE membership_id = ?`)
        .bind(membership_id)
        .first<MembershipRow>();
      return row === null ? null : toMembership(row);
    },
    async listUserMemberships(user_id) {
      const result = await db
        .prepare(`SELECT ${MEMBERSHIP_COLUMNS} FROM identity_memberships WHERE user_id = ?`)
        .bind(user_id)
        .all<MembershipRow>();
      return result.results.map(toMembership);
    },
    async listActiveUserTeamsPage(user_id, after) {
      const result = await db.prepare(
        `SELECT t.team_id, t.timezone FROM identity_memberships AS m INNER JOIN identity_teams AS t ON t.team_id = m.team_id WHERE m.user_id = ? AND m.status = 'active' AND (? IS NULL OR t.team_id > ?) ORDER BY t.team_id ASC LIMIT 101`,
      ).bind(user_id, after, after).all<Pick<Team, 'team_id' | 'timezone'>>();
      return result.results;
    },
    async listActiveOwners(team_id) {
      const result = await db
        .prepare(
          `SELECT ${MEMBERSHIP_COLUMNS} FROM identity_memberships WHERE team_id = ? AND status = 'active' AND is_owner = 1`,
        )
        .bind(team_id)
        .all<MembershipRow>();
      return result.results.map(toMembership);
    },
    async setMembershipRoles(membership_id, roles) {
      await db
        .prepare('UPDATE identity_memberships SET roles = ?, updated_at = ? WHERE membership_id = ?')
        .bind(JSON.stringify([...roles]), now(), membership_id)
        .run();
    },
    async setMembershipOwner(membership_id, is_owner) {
      await db
        .prepare('UPDATE identity_memberships SET is_owner = ?, updated_at = ? WHERE membership_id = ?')
        .bind(is_owner ? 1 : 0, now(), membership_id)
        .run();
    },
    async removeMembership(membership_id) {
      await db
        .prepare("UPDATE identity_memberships SET status = 'removed', updated_at = ? WHERE membership_id = ?")
        .bind(now(), membership_id)
        .run();
    },
    async reactivateMembership(membership_id, input) {
      await db
        .prepare(
          "UPDATE identity_memberships SET status = 'active', is_owner = ?, roles = ?, updated_at = ? WHERE membership_id = ?",
        )
        .bind(input.is_owner ? 1 : 0, JSON.stringify([...input.roles]), now(), membership_id)
        .run();
    },

    async createInvitation(input) {
      const invitation_id = random.randomUUID();
      await db
        .prepare(
          'INSERT INTO identity_invitations (invitation_id, team_id, email, email_lc, grants_owner, grants_roles, invited_by, created_at, expires_at, accepted_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)',
        )
        .bind(
          invitation_id,
          input.team_id,
          input.email,
          input.email.toLowerCase(),
          input.grants_owner ? 1 : 0,
          JSON.stringify([...input.grants_roles]),
          input.invited_by,
          now(),
          input.expires_at,
        )
        .run();
      return { invitation_id };
    },
    async findInvitationById(invitation_id) {
      const row = await db
        .prepare(`SELECT ${INVITATION_COLUMNS} FROM identity_invitations WHERE invitation_id = ?`)
        .bind(invitation_id)
        .first<InvitationRow>();
      return row === null ? null : toInvitation(row);
    },
    async acceptInvitation(invitation_id) {
      await db
        .prepare('UPDATE identity_invitations SET accepted_at = ? WHERE invitation_id = ?')
        .bind(now(), invitation_id)
        .run();
    },
    async revokeInvitation(invitation_id) {
      await db
        .prepare('UPDATE identity_invitations SET revoked_at = ? WHERE invitation_id = ?')
        .bind(now(), invitation_id)
        .run();
    },
    async revokePendingTeamInvitationsForEmail(team_id, email) {
      await db
        .prepare(
          'UPDATE identity_invitations SET revoked_at = ? WHERE team_id = ? AND email_lc = ? AND accepted_at IS NULL AND revoked_at IS NULL',
        )
        .bind(now(), team_id, email.toLowerCase())
        .run();
    },

    async createSession(input) {
      const row: Session = {
        session_id: random.randomUUID(),
        user_id: input.user_id,
        token_sha256: input.token_sha256,
        created_at: now(),
        expires_at: input.expires_at,
        revoked_at: null,
        last_team_id: input.last_team_id,
      };
      await db
        .prepare(
          'INSERT INTO identity_sessions (session_id, user_id, token_sha256, created_at, expires_at, revoked_at, last_team_id) VALUES (?, ?, ?, ?, ?, NULL, ?)',
        )
        .bind(
          row.session_id,
          row.user_id,
          row.token_sha256,
          row.created_at,
          row.expires_at,
          row.last_team_id,
        )
        .run();
      return row;
    },
    async findSessionByTokenHash(token_sha256) {
      const row = await db
        .prepare(`SELECT ${SESSION_COLUMNS} FROM identity_sessions WHERE token_sha256 = ?`)
        .bind(token_sha256)
        .first<SessionRow>();
      return row === null ? null : toSession(row);
    },
    async setSessionTeam(session_id, team_id) {
      await db
        .prepare('UPDATE identity_sessions SET last_team_id = ? WHERE session_id = ?')
        .bind(team_id, session_id)
        .run();
    },
    async revokeSession(session_id) {
      await db
        .prepare('UPDATE identity_sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL')
        .bind(now(), session_id)
        .run();
    },
    async revokeUserSessions(user_id) {
      await db
        .prepare('UPDATE identity_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .bind(now(), user_id)
        .run();
    },

    async createPreSessionToken(input) {
      const token_id = random.randomUUID();
      await db
        .prepare(
          'INSERT INTO identity_presession_tokens (token_id, token_sha256, created_at, expires_at) VALUES (?, ?, ?, ?)',
        )
        .bind(token_id, input.token_sha256, now(), input.expires_at)
        .run();
      return { token_id };
    },
    async findPreSessionTokenByHash(token_sha256) {
      const row = await db
        .prepare(`SELECT ${PRESESSION_TOKEN_COLUMNS} FROM identity_presession_tokens WHERE token_sha256 = ?`)
        .bind(token_sha256)
        .first<PreSessionTokenRow>();
      return row === null ? null : toPreSessionToken(row);
    },
    async deletePreSessionToken(token_id) {
      await db
        .prepare('DELETE FROM identity_presession_tokens WHERE token_id = ?')
        .bind(token_id)
        .run();
    },

    async createEmailToken(input) {
      const token_id = random.randomUUID();
      await db
        .prepare(
          'INSERT INTO identity_email_tokens (token_id, user_id, purpose, token_sha256, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
        )
        .bind(token_id, input.user_id, input.purpose, input.token_sha256, now(), input.expires_at)
        .run();
      return { token_id };
    },
    async findEmailTokenByHash(token_sha256) {
      const row = await db
        .prepare(`SELECT ${EMAIL_TOKEN_COLUMNS} FROM identity_email_tokens WHERE token_sha256 = ?`)
        .bind(token_sha256)
        .first<EmailTokenRow>();
      return row === null ? null : toEmailToken(row);
    },
    async consumeEmailToken(token_id) {
      await db
        .prepare('UPDATE identity_email_tokens SET consumed_at = ? WHERE token_id = ? AND consumed_at IS NULL')
        .bind(now(), token_id)
        .run();
    },
    async revokeUserEmailTokens(user_id, purpose) {
      await db
        .prepare(
          'UPDATE identity_email_tokens SET consumed_at = ? WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL',
        )
        .bind(now(), user_id, purpose)
        .run();
    },

    async createMcpGrant(input) {
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
      await db
        .prepare(
          'INSERT INTO identity_mcp_grants (grant_id, user_id, team_id, client_id, token_sha256, issued_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
        )
        .bind(
          row.grant_id,
          row.user_id,
          row.team_id,
          row.client_id,
          row.token_sha256,
          row.issued_at,
          row.expires_at,
        )
        .run();
      return row;
    },
    async findMcpGrantByTokenHash(token_sha256) {
      const row = await db
        .prepare(`SELECT ${MCP_GRANT_COLUMNS} FROM identity_mcp_grants WHERE token_sha256 = ?`)
        .bind(token_sha256)
        .first<McpGrantRow>();
      return row === null ? null : toMcpGrant(row);
    },
    async revokeMcpGrant(grant_id) {
      await db
        .prepare('UPDATE identity_mcp_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL')
        .bind(now(), grant_id)
        .run();
    },
    async revokeUserMcpGrants(user_id) {
      await db
        .prepare('UPDATE identity_mcp_grants SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .bind(now(), user_id)
        .run();
    },
    async revokeUserTeamMcpGrants(user_id, team_id) {
      await db
        .prepare(
          'UPDATE identity_mcp_grants SET revoked_at = ? WHERE user_id = ? AND team_id = ? AND revoked_at IS NULL',
        )
        .bind(now(), user_id, team_id)
        .run();
    },

    async createOAuthClient(input) {
      // Same unguessability bar as the memory store: public identifier,
      // still minted unscannable (16 hex chars).
      const hex = [...random.randomBytes(8)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const row: OAuthClient = {
        client_id: `client_${hex}`,
        client_name: input.client_name,
        redirect_uris: [...input.redirect_uris],
        registered_at: now(),
      };
      await db
        .prepare(
          'INSERT INTO identity_oauth_clients (client_id, client_name, redirect_uris, registered_at) VALUES (?, ?, ?, ?)',
        )
        .bind(row.client_id, row.client_name, JSON.stringify([...row.redirect_uris]), row.registered_at)
        .run();
      return row;
    },
    async findOAuthClient(client_id) {
      const row = await db
        .prepare(`SELECT ${OAUTH_CLIENT_COLUMNS} FROM identity_oauth_clients WHERE client_id = ?`)
        .bind(client_id)
        .first<OAuthClientRow>();
      return row === null ? null : toOAuthClient(row);
    },
    async createAuthCode(input) {
      const row: AuthCode = {
        code_sha256: input.code_sha256,
        client_id: input.client_id,
        user_id: input.user_id,
        team_id: input.team_id,
        redirect_uri: input.redirect_uri,
        code_challenge: input.code_challenge,
        created_at: now(),
        expires_at: input.expires_at,
        consumed_at: null,
      };
      await db
        .prepare(
          'INSERT INTO identity_auth_codes (code_sha256, client_id, user_id, team_id, redirect_uri, code_challenge, created_at, expires_at, consumed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
        )
        .bind(
          row.code_sha256,
          row.client_id,
          row.user_id,
          row.team_id,
          row.redirect_uri,
          row.code_challenge,
          row.created_at,
          row.expires_at,
        )
        .run();
      return row;
    },
    async findAuthCodeByHash(code_sha256) {
      const row = await db
        .prepare(`SELECT ${AUTH_CODE_COLUMNS} FROM identity_auth_codes WHERE code_sha256 = ?`)
        .bind(code_sha256)
        .first<AuthCodeRow>();
      return row === null ? null : toAuthCode(row);
    },
    async consumeAuthCode(code_sha256) {
      const result: unknown = await db
        .prepare('UPDATE identity_auth_codes SET consumed_at = ? WHERE code_sha256 = ? AND consumed_at IS NULL')
        .bind(now(), code_sha256)
        .run();
      const meta: unknown = typeof result === 'object' && result !== null && !Array.isArray(result) &&
        Object.hasOwn(result, 'meta') ? (result as Record<string, unknown>).meta : undefined;
      const changes: unknown = typeof meta === 'object' && meta !== null && !Array.isArray(meta) &&
        Object.hasOwn(meta, 'changes') ? (meta as Record<string, unknown>).changes : undefined;
      if (changes !== 0 && changes !== 1) {
        throw new Error('Identity D1 auth code consumption needs definitive meta.changes of 0 or 1.');
      }
      return changes === 1 ? 'consumed' : 'unavailable';
    },
  };
}
