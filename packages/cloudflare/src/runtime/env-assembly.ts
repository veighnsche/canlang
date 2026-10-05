/**
 * P-C production McpDeps constructor: worker `env` -> `AssemblyDeps`.
 *
 * The deploy join's identity/state seam: builds the production
 * `StoragePort` from the `env.DB` D1 binding plus the D1-backed
 * `IdentityStore`, running every idempotent ensure step the serving
 * path needs. P-A's worker entry dynamic-imports `buildProductionDeps`
 * and feeds the result into `assembleWorker`.
 *
 * PRODUCER LOADING (worker boundary): this package declares neither
 * `@canlang/state` nor `@canlang/identity` as a runtime dependency, so
 * every cross-package producer loads via DYNAMIC import through
 * non-literal specifiers (tsc-blind, `tests/integration/b2-d1-fence`
 * precedent). Static shape validation fails loud naming the missing
 * producer — never a silent half-constructed deps object.
 *
 * DEPLOY-JOIN SEAM (P-B, loud): the state-D1, identity, and worker
 * sibling specifiers below resolve inside the checkout; the deploy
 * bundler must inline/scope those modules into the worker bundle (the
 * same treatment M2 gives the MCP bundle). If a specifier stops
 * resolving, construction throws naming the exact seam.
 *
 * DDL OWNERSHIP (loud): `INTERIM_DDL` application is UNOWNED — verified
 * by reading the tree: `src/deploy/*` only renders `d1_databases`
 * bindings, `upgrade/apply.ts` has no live backend, and `assembly.ts`
 * only *declares* the statements ("the deploy/migrate packet applies
 * them") with no applier. The equivalent minimal ensure step therefore
 * runs HERE (`applyInterimDdl`), idempotently, alongside the state
 * engine schema (`ensureSchema`) and the identity schema
 * (`ensureIdentitySchema`). When the D1 owner lands a real migrate
 * step, that step supersedes `applyInterimDdl` (same statements,
 * same idempotent shape) — until then this constructor is the only
 * applier and says so.
 *
 * Types mirror `packages/identity/src/ports.ts` VERBATIM (same rule as
 * `runtime/mcp-registry.ts`): `@canlang/identity` is not a runtime
 * dependency, so the `IdentityStore` shape is restated here and proven
 * mutually assignable with the real interface by static assertions in
 * `test/mcpd-env-assembly.test.ts` (both directions compile, or the
 * file fails the root check).
 *
 * Worker-safe: type-only `@canlang/contracts` import, no `node:`
 * builtins, no I/O beyond the injected D1 binding.
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
  Session,
  SessionId,
  StoragePort,
  Team,
  TeamId,
  UserId,
} from "@canlang/contracts";

/* ------------------------------------------------------------------ */
/* Verbatim mirrors of `packages/identity/src/ports.ts`.               */
/* ------------------------------------------------------------------ */

/** Mirror of `StoredUser` (`ports.ts:56`). */
export interface StoredUser {
  readonly user_id: UserId;
  readonly email: string;
  readonly email_verified: boolean;
  readonly password_hash: string;
  readonly created_at: InstantString;
  readonly updated_at: InstantString;
}

/** Mirror of `TeamInvitationRow` (`ports.ts:213`). */
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

/**
 * Mirror of `IdentityStore` (`ports.ts:95`). See the header: restated
 * verbatim because the worker boundary forbids even a type import from
 * an undeclared package; mutual assignability with the real interface
 * is proven statically in `test/mcpd-env-assembly.test.ts`.
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
    roles: Membership["roles"];
  }): Promise<Membership>;
  findMembership(team_id: TeamId, user_id: UserId): Promise<Membership | null>;
  findMembershipById(membership_id: MembershipId): Promise<Membership | null>;
  listUserMemberships(user_id: UserId): Promise<readonly Membership[]>;
  listActiveOwners(team_id: TeamId): Promise<readonly Membership[]>;
  setMembershipRoles(membership_id: MembershipId, roles: Membership["roles"]): Promise<void>;
  setMembershipOwner(membership_id: MembershipId, is_owner: boolean): Promise<void>;
  removeMembership(membership_id: MembershipId): Promise<void>;
  reactivateMembership(
    membership_id: MembershipId,
    input: { is_owner: boolean; roles: Membership["roles"] },
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
  findInvitationById(
    invitation_id: InvitationId,
  ): Promise<(TeamInvitationRow & { invitation_id: InvitationId }) | null>;
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

  // -- email tokens --
  createEmailToken(input: {
    user_id: UserId;
    purpose: EmailToken["purpose"];
    token_sha256: string;
    expires_at: InstantString;
  }): Promise<{ token_id: string }>;
  findEmailTokenByHash(token_sha256: string): Promise<EmailToken | null>;
  consumeEmailToken(token_id: string): Promise<void>;
  revokeUserEmailTokens(user_id: UserId, purpose: EmailToken["purpose"]): Promise<void>;

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
/* ------------------------------------------------------------------ */
/* Producer loading (dynamic, validated, loud).                        */
/* ------------------------------------------------------------------ */

/**
 * State D1 producer. Relative dist path (not a bare specifier):
 * `@canlang/state` has no package link or exports map in this
 * workspace, so only the relative checkout path resolves — in vitest
 * from `src/`, in node from `dist/` (same `../../../` shape), and in
 * the worker via the P-B bundler seam (see header).
 */
const STATE_D1_SPECIFIER = "../../../state/dist/state/src/storage/d1.js";

/** Identity package root (resolves via the workspace link + exports map). */
const IDENTITY_SPECIFIER = "@canlang/identity";

/** Worker sibling holding `INTERIM_DDL` (dist-adjacent, assembly precedent). */
const ASSEMBLY_SPECIFIER = "../worker/assembly.js";

/** Structural view of the state D1 module (b2 precedent: mirrors only). */
interface StateD1Producer {
  ensureSchema(db: unknown): Promise<void>;
  createD1Storage(db: unknown): StoragePort;
}

/** Structural view of the identity D1 exports. */
interface IdentityD1Producer {
  ensureIdentitySchema(db: unknown): Promise<void>;
  createD1IdentityStore(db: unknown): IdentityStore;
}

/** Minimal D1 binding surface this constructor touches. */
interface D1Binding {
  prepare(sql: string): unknown;
  exec(sql: string): Promise<unknown>;
  batch(statements: unknown[]): Promise<unknown[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isD1Binding(value: unknown): value is D1Binding {
  return (
    isRecord(value) &&
    typeof value["prepare"] === "function" &&
    typeof value["exec"] === "function" &&
    typeof value["batch"] === "function"
  );
}

async function loadStateD1(): Promise<StateD1Producer> {
  let mod: unknown;
  try {
    mod = await import(STATE_D1_SPECIFIER);
  } catch {
    throw new Error(
      `mcp-deploy: state D1 producer is not assembled (${STATE_D1_SPECIFIER}); ` +
        `build @canlang/state dist (root build) or stage the P-B vendor seam — refusing to serve without storage`,
    );
  }
  if (
    !isRecord(mod) ||
    typeof mod["ensureSchema"] !== "function" ||
    typeof mod["createD1Storage"] !== "function"
  ) {
    throw new Error(
      `mcp-deploy: state D1 module loaded but lacks ensureSchema/createD1Storage (stale dist?)`,
    );
  }
  return mod as unknown as StateD1Producer;
}

async function loadIdentityD1(): Promise<IdentityD1Producer> {
  let mod: unknown;
  try {
    mod = await import(IDENTITY_SPECIFIER);
  } catch {
    throw new Error(
      `mcp-deploy: identity producer is not assembled (${IDENTITY_SPECIFIER}); ` +
        `build @canlang/identity dist (root build) or stage the P-B vendor seam — refusing to serve without identity`,
    );
  }
  if (
    !isRecord(mod) ||
    typeof mod["ensureIdentitySchema"] !== "function" ||
    typeof mod["createD1IdentityStore"] !== "function"
  ) {
    throw new Error(
      `mcp-deploy: identity module loaded but lacks ensureIdentitySchema/createD1IdentityStore (stale dist?)`,
    );
  }
  return mod as unknown as IdentityD1Producer;
}

/**
 * The INTERIM demo-model DDL (`assembly.ts` `INTERIM_DDL`). Loaded from
 * the worker sibling — never restated here, so the statements cannot
 * skew between the declarer and this applier.
 */
async function loadInterimDdl(): Promise<readonly string[]> {
  let mod: unknown;
  try {
    mod = await import(ASSEMBLY_SPECIFIER);
  } catch {
    throw new Error(
      `mcp-deploy: worker sibling ${ASSEMBLY_SPECIFIER} (INTERIM_DDL declarer) is not assembled; ` +
        `the interim demo tables cannot be ensured — refusing to serve a half-migrated database`,
    );
  }
  const ddl: unknown = isRecord(mod) ? mod["INTERIM_DDL"] : undefined;
  if (
    !Array.isArray(ddl) ||
    ddl.length === 0 ||
    !ddl.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    throw new Error(
      `mcp-deploy: worker sibling ${ASSEMBLY_SPECIFIER} has no non-empty INTERIM_DDL string array (stale assembly?)`,
    );
  }
  return ddl as readonly string[];
}

/* ------------------------------------------------------------------ */
/* Constructor (PINNED contract: P-A dynamic-imports this shape).       */
/* ------------------------------------------------------------------ */

/**
 * Build the production serving deps from the worker environment.
 *
 * - `store`: `createD1Storage(env.DB)` after `ensureSchema` (state
 *   engine tables: records, fence log, outbox).
 * - `identityStore`: the D1-backed `IdentityStore` after
 *   `ensureIdentitySchema` (identity_* tables).
 * - INTERIM demo tables (`todo`, `note`): applied HERE because DDL
 *   application is unowned elsewhere (see header) — idempotent
 *   `IF NOT EXISTS`, safe to re-run.
 *
 * Every ensure step is idempotent, so P-A may construct once per
 * isolate (preferred) or per request (correct, wasteful). A missing
 * or misshapen `env.DB` throws naming `env.DB` (P-A gates this as
 * 500 `missing-binding`); a missing producer throws naming the exact
 * unmet seam. Nothing here ever returns a half-constructed deps
 * object: any failure rejects before the return.
 */
export async function buildProductionDeps(
  env: Record<string, unknown>,
): Promise<{ store: StoragePort; identityStore: IdentityStore }> {
  const db: unknown = env["DB"];
  if (!isD1Binding(db)) {
    // Self-identifying (module + function): P-A's worker main surfaces
    // this text in its 500 `deploy-join-missing` envelope, and names the
    // join from these tokens.
    throw new Error(
      "mcp-deploy: buildProductionDeps (../runtime/env-assembly.js) requires env.DB " +
        "(a D1 database binding with prepare/exec/batch); bind a D1 database as DB or the worker cannot serve",
    );
  }
  const state = await loadStateD1();
  const identity = await loadIdentityD1();
  await state.ensureSchema(db);
  await identity.ensureIdentitySchema(db);
  // DDL ownership (loud): unowned elsewhere, applied here. See header.
  const interimDdl = await loadInterimDdl();
  for (const statement of interimDdl) {
    await db.exec(statement);
  }
  return {
    store: state.createD1Storage(db),
    identityStore: identity.createD1IdentityStore(db),
  };
}
