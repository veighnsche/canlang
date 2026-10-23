/**
 * Identity store/mail/clock ports.
 *
 * The identity package commits all account/session/membership facts through
 * `IdentityStore`. Production uses global Identity D1 tables; team State may
 * use a separate database. The broader mutation fence join J2 is proposed,
 * not implemented by this port. `testing.ts` holds the test-only memory store.
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
  MembershipSnapshot,
  OAuthClient,
  OAuthClientId,
  PreSessionToken,
  Session,
  SessionId,
  Team,
  TeamId,
  UserId,
  VerifiedTeamsMemberRemovedEnvelope,
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

/** Outbound account mail port, explicitly bound by the host. Fulfilment
 * acknowledges this port, not inbox delivery. A provider adapter must inspect
 * its completion and reject unknown/failed outcomes rather than erase them
 * into void. Bodies are plain text; raw tokens stay in addressed mail. */
export interface MailPort {
  sendMail(to: string, subject: string, body_text: string): Promise<void>;
}

/** Original technical outcome of one durable role command, never current authority. */
export interface MemberRoleMutationReceipt {
  readonly namespace: string;
  readonly operation: 'system.team.role';
  readonly operationId: string;
  readonly requestDigest: string;
  readonly membership: Membership;
}

export interface InvitationMutationInput {
  readonly namespace: string;
  readonly operationId: string;
  readonly team_id: string;
  readonly email: string;
  readonly role: string;
  readonly invited_by: string;
}

/** Saved creation facts only; neither the receipt nor its offer is current authority. */
export interface InvitationMutationReceipt {
  readonly namespace: string;
  readonly operation: 'system.team.invite';
  readonly operationId: string;
  readonly requestDigest: string;
  readonly invitation: TeamInvitationRow & { readonly invitation_id: InvitationId };
}

/** Unknown is terminal for automatic delivery: MailPort cannot reconcile it. */
export type InvitationMailState = 'pending' | 'unknown' | 'acknowledged' | 'cancelled';
export interface InvitationMailClaim {
  readonly state: InvitationMailState;
  readonly attempt?: { readonly token: string; readonly to: string; readonly subject: string; readonly body_text: string };
}

/**
 * Constrained system-command surface for identity facts. No raw SQL, no
 * second role store, no account enumeration beyond the exact lookups below.
 * Recovery, invitation acceptance and occurrence-backed removal/role changes use bounded atomic commands.
 * Other check-then-act mutations have no shared transaction fence.
 * The bounded membership snapshot supplies one read observation only. The
 * memory double is single-threaded and proves no native concurrency semantics.
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
  /** One coherent same-team read, never composed from singular reads. Rejects
   * empty/over-bound/sparse/accessor requests or corrupt/skewed results;
   * preserves every requested position, including duplicates and absence.
   * See MembershipSnapshot for the downstream authority obligations. */
  findMembershipsSnapshot(team_id: TeamId, user_ids: readonly UserId[]):
    Promise<MembershipSnapshot>;
  findMembershipById(membership_id: MembershipId): Promise<Membership | null>;
  /** All memberships (any status) for one user; includes removed history. */
  listUserMemberships(user_id: UserId): Promise<readonly Membership[]>;
  /** Active memberships joined to live teams, ascending team_id after the
   * exclusive cursor. At most 101 projections: 100 displayed plus lookahead.
   * Filtering, ordering and bounding happen in the owning store query. */
  listActiveUserTeamsPage(user_id: UserId, after: TeamId | null):
    Promise<readonly Pick<Team, 'team_id' | 'timezone'>[]>;
  /** Active owners only; backs the last-owner removal/demotion guard. */
  listActiveOwners(team_id: TeamId): Promise<readonly Membership[]>;
  setMembershipRoles(
    membership_id: MembershipId,
    roles: Membership['roles'],
  ): Promise<void>;
  /** Atomically decide current owner/target/last-owner policy, apply a role
   * delta and retain its original result. Exact replay never changes current
   * membership, including after removal/re-admission. The host must authenticate
   * the current caller and bind namespace before invoking this technical port. */
  changeMemberRoleWithReceipt?(input: {
    readonly namespace: string; readonly operationId: string; readonly team_id: string;
    readonly member_user_id: string; readonly granted_by: string; readonly role: string;
  }): Promise<MemberRoleMutationReceipt>;
  /** Read the retained original result for the exact request, or null. Never
   * executes an unseen occurrence or supplies current owner/role authority. */
  readMemberRoleMutationReceipt?(input: Parameters<NonNullable<IdentityStore['changeMemberRoleWithReceipt']>>[0]):
    Promise<MemberRoleMutationReceipt | null>;
  /** D1's conditional write refuses demotion/removal of the last active owner;
   * promotion, inactive/nonowner updates and missing-row no-ops remain supported.
   * This does not make the surrounding feature admission/cascades atomic. */
  setMembershipOwner(membership_id: MembershipId, is_owner: boolean): Promise<void>;
  removeMembership(membership_id: MembershipId): Promise<void>;
  /** Atomic original removal and cascades; exact replay returns the saved technical outcome only.
   * Trusted host authentication/namespace binding is required. Replay performs no new work,
   * including after re-admission; receiving handler admission remains independent. */
  removeMemberWithOccurrence?(input: {
    readonly team_id: string; readonly member_user_id: string; readonly removed_by: string;
    readonly namespace: string; readonly operationId: string;
  }): Promise<VerifiedTeamsMemberRemovedEnvelope>;
  /** Read only the retained original outcome for these exact five arguments.
   * Absence returns null; same-key argument skew refuses. Never retries a command,
   * removes membership, cascades or mints source/event facts. Retained facts grant
   * no current authority; trusted source/ingress binding remains independent. */
  readMemberRemovalOccurrence?(input: Parameters<NonNullable<IdentityStore['removeMemberWithOccurrence']>>[0]):
    Promise<VerifiedTeamsMemberRemovedEnvelope | null>;
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
  /** Original invitation and immutable mail intent share one transaction.
   * Hosts must authenticate/bind namespace; replay creates no new offer/mail. */
  createInvitationWithReceipt?(input: InvitationMutationInput, config: { readonly inviteBaseUrl: string }):
    Promise<InvitationMutationReceipt>;
  readInvitationMutationReceipt?(input: InvitationMutationInput): Promise<InvitationMutationReceipt | null>;
  /** A pending winner becomes unknown durably before its one attempt is
   * returned. No lease/reset exists; retries of unknown never return an attempt. */
  claimInvitationMail?(input: InvitationMutationInput): Promise<InvitationMailClaim>;
  acknowledgeInvitationMail?(input: InvitationMutationInput, token: string): Promise<InvitationMailState>;
  readInvitationMailState?(input: InvitationMutationInput): Promise<InvitationMailState | null>;
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
  /** Atomically recheck a live invitation and its verified addressed account,
   * admit/reactivate the unique membership with exactly its stored ceiling,
   * and consume the invitation. Store-owned time is read at command admission.
   * Null means no effects. Lost/malformed acknowledgement remains uncertain;
   * never fall back to separate mutations or infer success from later rows.
   * Unsupported stores omit this command. */
  acceptInvitationWithMembership?(input: {
    readonly invitation_id: InvitationId;
    readonly user_id: UserId;
  }): Promise<Membership | null>;
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
  /** Atomically remove one hashed token, returning its original expiry only to the winner.
   * Expired tokens are removed too; the public flow checks the returned expiry. */
  consumePreSessionTokenByHash(token_sha256: string): Promise<{ readonly expires_at: InstantString } | null>;

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
  /** Atomically recheck one live recovery proof, rotate its account password,
   * revoke all account sessions/grants/recovery tokens, and consume that proof.
   * Store-owned time is read at command admission, after password hashing.
   * Null means no effects. A rejected/lost acknowledgement may be uncertain;
   * callers must not fall back to separate mutations. Unsupported stores omit it. */
  recoverAccountWithToken?(input: {
    readonly token_id: string;
    readonly user_id: UserId;
    readonly password_hash: string;
  }): Promise<{ readonly user_id: UserId } | null>;

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
  consumeAuthCode(code_sha256: string): Promise<'consumed' | 'unavailable'>;
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
