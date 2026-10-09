/**
 * P-C production McpDeps constructor: worker `env` -> `AssemblyDeps`.
 *
 * The deploy join's identity/state seam: builds the production
 * `StoragePort` from the `env.DB` D1 binding plus the D1-backed
 * `IdentityStore`, running every idempotent ensure step the serving
 * path needs. P-A's worker entry dynamic-imports `buildProductionDeps`
 * and feeds the result into `assembleWorker`.
 *
 * PRODUCER LOADING (worker boundary): state and identity are declared
 * runtime dependencies, loaded through their installed package exports.
 * Dynamic loading preserves the assembly boundary; shape validation
 * fails loud naming a missing or incompatible producer.
 *
 * DEPLOY-JOIN SEAM (P-B, loud): the state-D1 and identity specifiers
 * below resolve through owning packages; the deploy bundler stages
 * those installed modules into the Worker bundle (the same treatment
 * M2 gives the MCP bundle). If a specifier stops resolving,
 * construction throws naming the exact seam.
 *
 * DDL OWNERSHIP (T17b: interim DDL RETIRED): the hand-written demo
 * `INTERIM_DDL` (`todo`, `note`) and its applier are deleted with the
 * `assembly.ts` declaration. The engine stores every model in its
 * generic `records` table created by `ensureSchema` (below) — the
 * per-model tables were never the engine's shape and nothing reads
 * them. When the D1 owner lands a real migrate step, that step owns
 * schema outright; there is no interim DDL left to supersede.
 *
 * The structural IdentityStore view mirrors the owning identity API
 * (same rule as `runtime/mcp-registry.ts`) and is proven
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
  PreSessionToken,
  Session,
  SessionId,
  StoragePort,
  Team,
  TeamId,
  UserId,
} from "@canlang/contracts";
import type { D1Database } from '@cloudflare/workers-types';
import type { HttpAuthConfiguration } from '../worker/assembly.js';
import type { PagePreferenceStore } from '@canlang/interfaces';
import { createD1AuthRateLimiter } from './auth-rate-limiter.js';
import { createD1PagePreferenceStore, ensurePagePreferencesSchema } from './page-preferences.js';

/** Trusted host assignment; never populated from request inputs. */
export interface StateTeamBinding {
  readonly owner: string;
  readonly db: D1Database;
  readonly initializeFresh?: true;
}

function unavailableGlobalStore(): StoragePort {
  const refuse = async (): Promise<never> => {
    throw new Error('owner-storage: selected team State requires its owner boundary; global storage is unavailable');
  };
  return Object.freeze({ readRevision: refuse, load: refuse, query: refuse, commit: refuse,
    readReceipt: refuse, outboxPending: refuse, outboxGet: refuse, scheduleGet: refuse, schedulesDue: refuse,
    historyFor: refuse, readInstalledSnapshot: refuse, readMigrationProgress: refuse,
    readStagedRows: refuse, stageMigrationRows: refuse, publishMigrationChunk: refuse,
    flipInstalledSnapshot: refuse, readMigrationOutcomes: refuse, recordMigrationFailure: refuse, discardStagedRows: refuse,
    readMigrationFailure: refuse });
}

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
  consumeAuthCode(code_sha256: string): Promise<'consumed' | 'unavailable'>;
}
/* ------------------------------------------------------------------ */
/* Producer loading (dynamic, validated, loud).                        */
/* ------------------------------------------------------------------ */

/**
 * State D1 producer, resolved through its declared installed export
 * and rewritten to the owning vendor module in the Worker bundle.
 */
const STATE_D1_SPECIFIER = "@canlang/state/storage/d1";

/** Identity package root (resolves via the workspace link + exports map). */
const IDENTITY_SPECIFIER = "@canlang/identity";

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
 *
 * T17b: the INTERIM demo-table step is retired with `INTERIM_DDL`
 * (see header) — the two idempotent engine ensures above are the
 * whole constructor.
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
): Promise<{ store: StoragePort; identityStore: IdentityStore; preferences: PagePreferenceStore; stateTeam?: StateTeamBinding; auth?: HttpAuthConfiguration }> {
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
  // Optional for non-auth consumers; auth serving requires explicit trusted host configuration.
  let origin: URL | undefined;
  if (Object.hasOwn(env, 'CAN_AUTH_ORIGIN')) {
    const value = env['CAN_AUTH_ORIGIN'];
    try {
      if (typeof value !== 'string') throw new Error();
      origin = new URL(value);
      if (origin.origin !== value || !['http:', 'https:'].includes(origin.protocol)) throw new Error();
    } catch {
      throw new Error('auth-configuration: CAN_AUTH_ORIGIN must be a canonical absolute http(s) origin without path, query or credentials');
    }
  }
  const selectedOwner = env['CAN_STATE_OWNER'];
  if (selectedOwner === undefined && (env['STATE_DB'] !== undefined || env['CAN_STATE_INITIALIZE_FRESH'] !== undefined)) {
    throw new Error('owner-storage: STATE_DB/fresh assignment requires explicit CAN_STATE_OWNER');
  }
  if (selectedOwner !== undefined) {
    if (typeof selectedOwner !== 'string' || selectedOwner === '' || selectedOwner === 'app') {
      throw new Error('owner-storage: CAN_STATE_OWNER must be a concrete Identity team ID');
    }
    const stateDb = env['STATE_DB'];
    if (!isD1Binding(stateDb) || stateDb === db) {
      throw new Error('owner-storage: selected team requires a separate actual STATE_DB D1 binding');
    }
    const fresh = env['CAN_STATE_INITIALIZE_FRESH'];
    if (fresh !== undefined && fresh !== true && fresh !== 'true') {
      throw new Error('owner-storage: CAN_STATE_INITIALIZE_FRESH requires explicit true authorization');
    }
    const identity = await loadIdentityD1();
    await identity.ensureIdentitySchema(db);
    await ensurePagePreferencesSchema(db as D1Database);
    const auth = origin === undefined ? undefined : { origin: origin.origin, secureCookies: origin.protocol === 'https:',
      limiter: await createD1AuthRateLimiter(db as unknown as D1Database, { scope: origin.origin, clock: { nowMs: Date.now } }) };
    return { ...(auth === undefined ? {} : { auth }), store: unavailableGlobalStore(), identityStore: identity.createD1IdentityStore(db),
      preferences: createD1PagePreferenceStore(db as D1Database),
      stateTeam: { owner: selectedOwner, db: stateDb as unknown as D1Database,
        ...(fresh === undefined ? {} : { initializeFresh: true }) } };
  }
  const state = await loadStateD1();
  const identity = await loadIdentityD1();
  await state.ensureSchema(db);
  await identity.ensureIdentitySchema(db);
  await ensurePagePreferencesSchema(db as D1Database);
  const auth = origin === undefined ? undefined : { origin: origin.origin, secureCookies: origin.protocol === 'https:',
    limiter: await createD1AuthRateLimiter(db as unknown as D1Database, { scope: origin.origin, clock: { nowMs: Date.now } }) };
  return {
    ...(auth === undefined ? {} : { auth }),
    store: state.createD1Storage(db),
    identityStore: identity.createD1IdentityStore(db),
    preferences: createD1PagePreferenceStore(db as D1Database),
  };
}
