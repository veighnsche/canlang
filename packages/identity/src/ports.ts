/**
 * Identity store/mail/clock ports.
 *
 * The identity package commits all account/session/membership facts through
 * `IdentityStore`. Production binds it to fenced D1 tables owned by lane 03
 * (join J2): membership/session mutations participate in the owner revision
 * fence, never in a side database. `testing.ts` holds the test-only
 * in-memory implementation; it is never a production binding.
 */
import type {
  AuthCode,
  EmailToken,
  InstantString,
  InvitationId,
  McpGrant,
  McpGrantId,
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
import type { BusinessErrorCode } from '@canlang/contracts';

/** Clock port. Production uses the system clock; tests inject frozen time. */
export interface Clock {
  nowMs(): number;
}

export const systemClock: Clock = { nowMs: () => Date.now() };

export function toInstant(ms: number): InstantString {
  return new Date(ms).toISOString();
}

/** Randomness port. Defaults to WebCrypto; never node:crypto (workerd). */
export interface RandomSource {
  randomBytes(length: number): Uint8Array;
  randomUUID(): string;
}

export const webRandom: RandomSource = {
  randomBytes: (length: number) => globalThis.crypto.getRandomValues(new Uint8Array(length)),
  randomUUID: () => globalThis.crypto.randomUUID(),
};

/**
 * Stored account row. `password_hash` never leaves the store layer: feature
 * code verifies through `accounts/passwords` and never reads this field
 * into results, logs, or errors.
 */
export interface StoredUser {
  readonly user_id: UserId;
  readonly email: string;
  readonly email_verified: boolean;
  readonly password_hash: string;
  readonly created_at: InstantString;
  readonly updated_at: InstantString;
}

/** Identity failure. Carries a wire business code + safe message so both
 * transports render identical meaning (mapping owned by this lane). */
export class IdentityError extends Error {
  readonly code: BusinessErrorCode;
  readonly field?: string;

  constructor(code: BusinessErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

/** Outbound mail port. Production binds the lane-04 mail adapter
 * (std.EmailV1 shape); tests capture into an outbox array. Bodies are
 * escaped plain text; raw tokens travel only inside addressed mail. */
export interface MailPort {
  sendMail(to: string, subject: string, body_text: string): Promise<void>;
}

/**
 * Constrained system-command surface for identity facts. No raw SQL, no
 * second role store, no account enumeration beyond the exact lookups below.
 * Feature code is check-then-act across these calls; production atomicity
 * (last-owner guards, recovery cascades, re-admission) comes from the
 * lane-03 revision fence executing each feature operation's steps as one
 * batch (join J2). The memory double is single-threaded and proves no
 * concurrency semantics.
 */
export interface IdentityStore {
  // -- users --
  createUser(input: {
    email: string;
    password_hash: string;
    email_verified: boolean;
  }): Promise<StoredUser>;
  findUserByEmail(email: string): Promise<StoredUser | null>;
  findUserById(user_id: UserId): Promise<StoredUser | null>;
  setUserPassword(user_id: UserId, password_hash: string): Promise<void>;
  setUserEmailVerified(user_id: UserId, verified: boolean): Promise<void>;

  // -- teams --
  createTeam(input: { timezone?: string }): Promise<Team>;
  findTeamById(team_id: TeamId): Promise<Team | null>;
  setTeamTimezone(team_id: TeamId, timezone: string): Promise<void>;

  // -- memberships --
  createMembership(input: {
    team_id: TeamId;
    user_id: UserId;
    is_owner: boolean;
    roles: Membership['roles'];
  }): Promise<Membership>;
  findMembership(team_id: TeamId, user_id: UserId): Promise<Membership | null>;
  findMembershipById(membership_id: MembershipId): Promise<Membership | null>;
  /** All memberships (any status) for one user; backs the team switcher. */
  listUserMemberships(user_id: UserId): Promise<readonly Membership[]>;
  /** Active owners only; backs the last-owner removal/demotion guard. */
  listActiveOwners(team_id: TeamId): Promise<readonly Membership[]>;
  setMembershipRoles(
    membership_id: MembershipId,
    roles: Membership['roles'],
  ): Promise<void>;
  setMembershipOwner(membership_id: MembershipId, is_owner: boolean): Promise<void>;
  removeMembership(membership_id: MembershipId): Promise<void>;
  /**
   * Re-admit a removed membership with a fresh grant ceiling (re-invitation
   * acceptance). Exactly one row per (team, user) ever exists; production
   * enforces UNIQUE(team_id, user_id) so concurrent re-admissions collide
   * instead of duplicating.
   */
  reactivateMembership(
    membership_id: MembershipId,
    input: { is_owner: boolean; roles: Membership['roles'] },
  ): Promise<void>;

  // -- invitations --
  createInvitation(input: {
    team_id: TeamId;
    email: string;
    grants_owner: boolean;
    grants_roles: readonly string[];
    invited_by: UserId;
    expires_at: InstantString;
  }): Promise<{ invitation_id: InvitationId }>;
  findInvitationById(invitation_id: InvitationId): Promise<
    (TeamInvitationRow & { invitation_id: InvitationId }) | null
  >;
  acceptInvitation(invitation_id: InvitationId): Promise<void>;
  revokeInvitation(invitation_id: InvitationId): Promise<void>;
  revokePendingTeamInvitationsForEmail(team_id: TeamId, email: string): Promise<void>;

  // -- sessions --
  createSession(input: {
    user_id: UserId;
    token_sha256: string;
    expires_at: InstantString;
    last_team_id: TeamId | null;
  }): Promise<Session>;
  findSessionByTokenHash(token_sha256: string): Promise<Session | null>;
  setSessionTeam(session_id: SessionId, team_id: TeamId | null): Promise<void>;
  revokeSession(session_id: SessionId): Promise<void>;
  revokeUserSessions(user_id: UserId): Promise<void>;

  // -- pre-session tokens (anonymous login-CSRF guard; hard-deleted on use) --
  createPreSessionToken(input: {
    token_sha256: string;
    expires_at: InstantString;
  }): Promise<{ token_id: string }>;
  findPreSessionTokenByHash(token_sha256: string): Promise<PreSessionToken | null>;
  deletePreSessionToken(token_id: string): Promise<void>;

  // -- email tokens --
  createEmailToken(input: {
    user_id: UserId;
    purpose: EmailToken['purpose'];
    token_sha256: string;
    expires_at: InstantString;
  }): Promise<{ token_id: string }>;
  findEmailTokenByHash(token_sha256: string): Promise<EmailToken | null>;
  consumeEmailToken(token_id: string): Promise<void>;
  revokeUserEmailTokens(user_id: UserId, purpose: EmailToken['purpose']): Promise<void>;

  // -- MCP grants --
  createMcpGrant(input: {
    user_id: UserId;
    team_id: TeamId | null;
    client_id: string;
    token_sha256: string;
    expires_at: InstantString;
  }): Promise<McpGrant>;
  findMcpGrantByTokenHash(token_sha256: string): Promise<McpGrant | null>;
  revokeMcpGrant(grant_id: McpGrantId): Promise<void>;
  revokeUserMcpGrants(user_id: UserId): Promise<void>;
  revokeUserTeamMcpGrants(user_id: UserId, team_id: TeamId): Promise<void>;

  // -- OAuth public clients + authorization codes (S7) --
  createOAuthClient(input: {
    client_name: string;
    redirect_uris: readonly string[];
  }): Promise<OAuthClient>;
  findOAuthClient(client_id: OAuthClientId): Promise<OAuthClient | null>;
  createAuthCode(input: {
    client_id: OAuthClientId;
    user_id: UserId;
    team_id: TeamId | null;
    redirect_uri: string;
    code_challenge: string;
    code_sha256: string;
    expires_at: InstantString;
  }): Promise<AuthCode>;
  findAuthCodeByHash(code_sha256: string): Promise<AuthCode | null>;
  consumeAuthCode(code_sha256: string): Promise<void>;
}

/** Invitation row as stored (invitation_id carried alongside). */
export interface TeamInvitationRow {
  readonly team_id: TeamId;
  readonly email: string;
  readonly grants_owner: boolean;
  readonly grants_roles: readonly string[];
  readonly invited_by: UserId;
  readonly created_at: InstantString;
  readonly expires_at: InstantString;
  readonly accepted_at: InstantString | null;
  readonly revoked_at: InstantString | null;
}
