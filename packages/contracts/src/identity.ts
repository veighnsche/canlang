/**
 * Identity contracts: authenticated principals, sessions, teams, membership.
 *
 * Lane 06 producer file. Types and pinned wire facts only; no execution
 * engine, storage, or cryptography. DESIGN.md section 4 is the normative
 * source; comments cite the exact rule each shape implements.
 *
 * Until L7 assembles the @canlang/contracts workspace package (lane-06
 * join J1), consumers inside this lane import this file by relative path
 * from test-only code. Production packages must switch to the workspace
 * import at J1 and never vendor a copy of these shapes.
 */

/** Contract version. Bump only with a breaking shape change + owner handoff. */
export const IDENTITY_CONTRACT_VERSION = 1;

/** Opaque, unguessable identifiers. Never sequential; never reused. */
export type UserId = string;
export type TeamId = string;
export type MembershipId = string;
export type SessionId = string;
export type InvitationId = string;
export type RecoveryTokenId = string;
/** One issued MCP authorization grant binding a connection to user+team. */
export type McpGrantId = string;

/**
 * Package-qualified role identity, e.g. "TeamTasks.reviewer".
 * Equal names in different packages do not merge (DESIGN section 4).
 */
export type PackageQualifiedRole = string;

/** RFC 3339 UTC instant string, e.g. "2026-10-04T15:00:00.000Z". */
export type InstantString = string;

/**
 * Read-only admission facts for the authenticated caller only
 * (DESIGN section 4: `actor.email`, `actor.email_verified`).
 * Request inputs cannot override these; other user references never expose
 * them, and there is no global email directory.
 */
export interface AuthenticatedActor {
  readonly user_id: UserId;
  readonly email: string;
  readonly email_verified: boolean;
}

/**
 * The operation caller. Null for unauthenticated public requests
 * (DESIGN section 4: "`actor` is null for unauthenticated public requests").
 */
export type Actor = AuthenticatedActor | null;

/** Actor predicates available in source (DESIGN section 4). */
export type ActorPredicate =
  | 'members'
  | 'owner'
  | 'authenticated'
  | 'public'
  | { readonly role: PackageQualifiedRole };

/** One explicit package-qualified role assignment on a membership. */
export interface RoleGrant {
  readonly role: PackageQualifiedRole;
  readonly granted_at: InstantString;
  readonly granted_by: UserId;
}

/**
 * Membership lifecycle state. Removal is terminal for admission: a completed
 * removal prevents new admissions while an already admitted operation may
 * finish (DESIGN section 4). Historic references stay readable where record
 * policies permit; new assignments require active status.
 */
export type MembershipStatus = 'active' | 'removed';

export interface Membership {
  readonly membership_id: MembershipId;
  readonly team_id: TeamId;
  readonly user_id: UserId;
  /** Built-in owner flag. A team owner does not automatically hold every
   * declared role (DESIGN section 4). */
  readonly is_owner: boolean;
  readonly roles: readonly RoleGrant[];
  readonly status: MembershipStatus;
  readonly created_at: InstantString;
  readonly updated_at: InstantString;
}

/**
 * Team context. Default teams support adds owner-managed membership,
 * expiring verified-email invitations, roles, team selection, and a team
 * timezone that is UTC until configured (DESIGN section 4). No source setup
 * line is needed; deployment provisions the first owner.
 */
export interface Team {
  readonly team_id: TeamId;
  /** IANA timezone name, "UTC" until configured. */
  readonly timezone: string;
  readonly created_at: InstantString;
}

/**
 * Stored invitation. Acceptance verifies the addressed email and cannot
 * grant a role beyond the stored invitation (DESIGN section 4).
 */
export interface TeamInvitation {
  readonly invitation_id: InvitationId;
  readonly team_id: TeamId;
  /** Addressed email; acceptance must verify ownership of this address. */
  readonly email: string;
  /** Stored grant ceiling: owner flag and/or declared roles. */
  readonly grants_owner: boolean;
  readonly grants_roles: readonly PackageQualifiedRole[];
  readonly invited_by: UserId;
  readonly created_at: InstantString;
  readonly expires_at: InstantString;
  readonly accepted_at: InstantString | null;
  readonly revoked_at: InstantString | null;
}

/**
 * Browser session facts. Sessions are opaque server-side records; the
 * bearer token is presented via Secure/HttpOnly/SameSite cookie and hashes
 * to `token_sha256` (lane-06 transport rule; DESIGN pins sessions as part
 * of the default auth primitive without fixing the token encoding).
 */
export interface Session {
  readonly session_id: SessionId;
  readonly user_id: UserId;
  /** Hex SHA-256 of the presented bearer token. The raw token is never stored. */
  readonly token_sha256: string;
  readonly created_at: InstantString;
  readonly expires_at: InstantString;
  /** Set on sign-out, revocation, or recovery; a revoked session admits nothing. */
  readonly revoked_at: InstantString | null;
  /** Last selected team, if any. Selection is rechecked on every admission. */
  readonly last_team_id: TeamId | null;
}

/**
 * Expiring single-purpose email token: verification, recovery, or invitation
 * acceptance link backing. Only the hash is stored; raw values travel only
 * inside the addressed email.
 */
export interface EmailToken {
  readonly token_id: RecoveryTokenId;
  readonly user_id: UserId;
  readonly purpose: 'verify_email' | 'recover_account' | 'accept_invitation';
  readonly token_sha256: string;
  readonly created_at: InstantString;
  readonly expires_at: InstantString;
  readonly consumed_at: InstantString | null;
}

/**
 * MCP authorization grant. OAuth consent binds a connection to one app user
 * and one team, or app-only context for a non-team app. Tokens carry the
 * correct audience and cannot impersonate a source; browser sessions and MCP
 * grants resolve the same principal model (DESIGN section 10).
 */
export interface McpGrant {
  readonly grant_id: McpGrantId;
  readonly user_id: UserId;
  /** Null only for app-only context in a non-team app. */
  readonly team_id: TeamId | null;
  readonly client_id: string;
  /** Hex SHA-256 of the presented grant bearer token. Added in S2; the raw
   * token is never stored, mirroring `Session.token_sha256`. */
  readonly token_sha256: string;
  readonly issued_at: InstantString;
  readonly expires_at: InstantString;
  readonly revoked_at: InstantString | null;
}

/** How the current call proved its identity. */
export type IdentityBinding =
  | { readonly kind: 'session'; readonly session_id: SessionId }
  | { readonly kind: 'mcp_grant'; readonly grant_id: McpGrantId }
  | { readonly kind: 'none' };

/**
 * The verified identity constructor output: the single authenticated context
 * both HTTP and MCP transports resolve before invoking anything. Grants are
 * evaluated from these current facts on every admission; neither transport
 * caches another caller/team's result (DESIGN sections 4, 9, 10).
 */
export interface ResolvedIdentity {
  readonly actor: Actor;
  /**
   * Resolved only when the target scope needs a team. Public record routes
   * resolve it from the record; team routes require selection; non-team app
   * contexts leave it null.
   */
  readonly team: Team | null;
  /** The actor's membership in the resolved team, or null when no team or
   * no membership (e.g. public caller, external user, app-only grant). */
  readonly membership: Membership | null;
  readonly binding: IdentityBinding;
  /** Admission checkpoint: facts are current as of this instant. */
  readonly admitted_at: InstantString;
}

/**
 * Fixed schemas of the owner-authorized team management tools. With default
 * teams support these are business tools (system.team.invite/.remove/.role)
 * with the same generated UI rules and mutation envelopes; their fixed
 * schemas come from this teams primitive (DESIGN section 10).
 */
export interface SystemTeamInviteInput {
  readonly email: string;
  /** Package-qualified role or "owner". */
  readonly role: string;
}

export interface SystemTeamRemoveInput {
  readonly member: UserId;
}

export interface SystemTeamRoleInput {
  readonly member: UserId;
  readonly role: string;
}

export const SYSTEM_TEAM_TOOL_NAMES = [
  'system.team.invite',
  'system.team.remove',
  'system.team.role',
] as const;

export type SystemTeamToolName = (typeof SYSTEM_TEAM_TOOL_NAMES)[number];
