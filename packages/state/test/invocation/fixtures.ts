/**
 * Lane 03 S3 invocation/admission fixtures (worker B; membership double made
 * local by the coordinator after L6 migrated its testing helper to workspace
 * imports that the standalone state build cannot resolve).
 *
 * Builders only: no assertions, no miniflare. Every builder is deterministic:
 * the local membership double mints sequential ids, so `seedMember` returns
 * the allocated rows and tests align their identities/inputs with those ids.
 * Shapes come from the identity CONTRACT (stable); the L6 store remains the
 * production `MembershipReader`, integrated at the B1 join.
 *
 * Single adjustment point for worker A's actuals: the `InterimOperationDef`
 * type import below (location + required members). Everything else imports
 * only contracts types and the existing `StateError`.
 */
import assert from 'node:assert/strict';
import type {
  AuthenticatedActor,
  IdentityBinding,
  Membership,
  MembershipId,
  MembershipStatus,
  ResolvedIdentity,
  RoleGrant,
  Team,
  TeamId,
  UserId,
} from '../../../contracts/src/identity.js';
import type { MutationEnvelope } from '../../../contracts/src/wire.js';
import type {
  CommitBatch,
  DomainWrite,
  HistoryEntry,
  ModelName,
  OperationId,
  OperationName,
  OutboxIntent,
  Receipt,
  ReceiptIdentity,
  RecordId,
  RecordVersion,
  Revision,
  ScheduleOp,
  StoragePort,
  StoredRow,
  UniqueClaim,
  UniqueRelease,
} from '../../../contracts/src/state.js';
// Aligned to worker A's actuals: interim defs live in `invocation/registry.js`.
import type { InterimOperationDef } from '../../src/invocation/registry.js';
import { StateError } from '../../src/errors.js';

/**
 * TEST-ONLY local membership double. Implements the `MembershipReader` port
 * (`findMembership`) that admission consumes, plus the minimal seeding
 * surface the tests need. Production binds the port to the L6 identity
 * store; this double never leaves the test tree.
 */
export interface FixtureUser {
  readonly user_id: UserId;
  readonly email: string;
}

export interface TestMembershipStore {
  findMembership(teamId: string, userId: string): Promise<Membership | null>;
  findMembershipById(membershipId: string): Promise<Membership | null>;
  findTeamById(teamId: string): Promise<Team | null>;
  findUserById(userId: string): Promise<FixtureUser | null>;
  createTeam(timezone?: string): Promise<Team>;
  createUser(email: string): Promise<FixtureUser>;
  createMembership(input: {
    team_id: TeamId;
    user_id: UserId;
    is_owner: boolean;
    roles: Membership['roles'];
  }): Promise<Membership>;
  removeMembership(membershipId: string): Promise<void>;
}

export function createMemoryIdentityStore(): TestMembershipStore {
  let seq = 0;
  const users = new Map<string, FixtureUser>();
  const teams = new Map<string, Team>();
  const memberships = new Map<string, Membership>();
  const stamp = (): string => new Date(FIXED_NOW).toISOString();
  const key = (teamId: string, userId: string): string => `${teamId}\0${userId}`;
  const index = new Map<string, string>();
  return {
    findMembership: async (teamId, userId) =>
      memberships.get(index.get(key(teamId, userId)) ?? '') ?? null,
    findMembershipById: async (membershipId) => memberships.get(membershipId) ?? null,
    findTeamById: async (teamId) => teams.get(teamId) ?? null,
    findUserById: async (userId) => users.get(userId) ?? null,
    createTeam: async (timezone = 'UTC') => {
      seq += 1;
      const team: Team = { team_id: `team-${seq}`, timezone, created_at: stamp() };
      teams.set(team.team_id, team);
      return team;
    },
    createUser: async (email) => {
      seq += 1;
      const user: FixtureUser = { user_id: `user-${seq}`, email };
      users.set(user.user_id, user);
      return user;
    },
    createMembership: async (input) => {
      seq += 1;
      const membership: Membership = {
        membership_id: `membership-${seq}` as MembershipId,
        team_id: input.team_id,
        user_id: input.user_id,
        is_owner: input.is_owner,
        roles: [...input.roles],
        status: 'active',
        created_at: stamp(),
        updated_at: stamp(),
      };
      memberships.set(membership.membership_id, membership);
      index.set(key(input.team_id, input.user_id), membership.membership_id);
      return membership;
    },
    removeMembership: async (membershipId) => {
      const current = memberships.get(membershipId) ?? null;
      if (current === null) return;
      memberships.set(membershipId, { ...current, status: 'removed', updated_at: stamp() });
    },
  };
}

/** Frozen test clock: 2026-10-04T00:00:00.000Z. */
export const FIXED_NOW = 1_791_072_000_000;

/** DESIGN §7 runtime defaults restated for boundary tests (24h age, 5m future). */
export const MAX_OPERATION_ID_AGE_MS = 24 * 60 * 60 * 1000;
export const OPERATION_ID_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Deterministic UUIDv7 with the given millisecond timestamp and fixed random
 * nibbles (`seq` selects distinct deterministic tails, default 0).
 */
export function uuidv7(ms: number, seq = 0): string {
  const ts = Math.floor(ms);
  if (!Number.isInteger(ts) || ts < 0 || ts > 0xffffffffffff) {
    throw new Error(`uuidv7 timestamp out of 48-bit range: ${ms}`);
  }
  if (!Number.isInteger(seq) || seq < 0 || seq > 0xffffffffffff) {
    throw new Error(`uuidv7 seq out of 48-bit range: ${seq}`);
  }
  const hex = ts.toString(16).padStart(12, '0');
  const tail = seq.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7aaa-8bbb-${tail}`;
}

/* Brand helpers (allowed casts for tests). */
export const asModel = (s: string): ModelName => s as ModelName;
export const asId = (s: string): RecordId => s as RecordId;
export const asVersion = (n: number): RecordVersion => n as RecordVersion;
export const asRevision = (n: number): Revision => n as Revision;
export const asOperation = (s: string): OperationName => s as OperationName;
export const asOperationId = (s: string): OperationId => s as OperationId;

export interface MakeIdentityOpts {
  readonly actor?: AuthenticatedActor | null;
  readonly userId?: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly team?: Team | null;
  readonly teamId?: string;
  readonly timezone?: string;
  readonly membership?: Membership | null;
  readonly isOwner?: boolean;
  readonly roles?: ReadonlyArray<RoleGrant>;
  readonly binding?: IdentityBinding;
  readonly admittedAt?: string;
}

/**
 * ResolvedIdentity with an authenticated `user-alice` actor on `team-a` by
 * default. Explicit `actor`/`team`/`membership` (including null) win as a
 * whole; otherwise actor/team ids derive from `userId`/`teamId`, falling back
 * to the ids of a supplied `membership` so tests align with seeded L6 rows.
 */
export function makeIdentity(opts: MakeIdentityOpts = {}): ResolvedIdentity {
  const membershipOpt = opts.membership;
  const actor: AuthenticatedActor | null =
    opts.actor !== undefined
      ? opts.actor
      : {
          user_id: opts.userId ?? membershipOpt?.user_id ?? 'user-alice',
          email: opts.email ?? 'alice@example.test',
          email_verified: opts.emailVerified ?? true,
        };
  const team: Team | null =
    opts.team !== undefined
      ? opts.team
      : {
          team_id: opts.teamId ?? membershipOpt?.team_id ?? 'team-a',
          timezone: opts.timezone ?? 'UTC',
          created_at: new Date(FIXED_NOW).toISOString(),
        };
  const membership: Membership | null =
    membershipOpt !== undefined
      ? membershipOpt
      : actor !== null && team !== null
        ? {
            membership_id: 'membership-default',
            team_id: team.team_id,
            user_id: actor.user_id,
            is_owner: opts.isOwner ?? false,
            roles: opts.roles ?? [],
            status: 'active',
            created_at: new Date(FIXED_NOW).toISOString(),
            updated_at: new Date(FIXED_NOW).toISOString(),
          }
        : null;
  return {
    actor,
    team,
    membership,
    binding: opts.binding ?? { kind: 'session', session_id: 'session-default' },
    admitted_at: opts.admittedAt ?? new Date(FIXED_NOW).toISOString(),
  };
}

export function makeEnvelope(
  operation: string,
  operationId: string,
  inputs: Record<string, unknown> = {},
): MutationEnvelope {
  return { operation, operation_id: operationId, inputs };
}

/** Interim scenario def: `Acme.approve` gated by members with no inputs. */
export function makeDef(overrides: Partial<InterimOperationDef> = {}): InterimOperationDef {
  const defaults: InterimOperationDef = {
    name: asOperation('Acme.approve'),
    kind: 'scenario',
    by: 'members',
    inputs: {},
  };
  return { ...defaults, ...overrides };
}

export interface SeedMemberOpts {
  /** Reuse this team when it exists; otherwise a team is created. */
  readonly teamId?: string;
  /** Reuse this user when it exists; otherwise a user is created. */
  readonly userId?: string;
  readonly email?: string;
  readonly isOwner: boolean;
  /** Plain role names become grants stamped at FIXED_NOW. */
  readonly roles?: ReadonlyArray<RoleGrant | string>;
  readonly status?: MembershipStatus;
}

export interface SeededMember {
  readonly user: FixtureUser;
  readonly team: Team;
  readonly membership: Membership;
}

let seedCounter = 0;

/**
 * Seed one membership through the local test double's
 * createUser/createTeam/createMembership (+ removeMembership for
 * `status: 'removed'`). Returns the allocated rows with their real ids.
 */
export async function seedMember(
  store: TestMembershipStore,
  opts: SeedMemberOpts,
): Promise<SeededMember> {
  seedCounter += 1;
  const n = seedCounter;
  let team: Team | null =
    opts.teamId === undefined ? null : await store.findTeamById(opts.teamId);
  if (team === null) {
    team = await store.createTeam('UTC');
  }
  let user: FixtureUser | null =
    opts.userId === undefined ? null : await store.findUserById(opts.userId);
  if (user === null) {
    user = await store.createUser(opts.email ?? `s3member-${n}@example.test`);
  }
  const granter = user.user_id;
  const roles: RoleGrant[] = (opts.roles ?? []).map((role) =>
    typeof role === 'string'
      ? { role, granted_at: new Date(FIXED_NOW).toISOString(), granted_by: granter }
      : role,
  );
  let membership = await store.createMembership({
    team_id: team.team_id,
    user_id: user.user_id,
    is_owner: opts.isOwner,
    roles,
  });
  if ((opts.status ?? 'active') === 'removed') {
    await store.removeMembership(membership.membership_id);
    const reread = await store.findMembershipById(membership.membership_id);
    if (reread === null) {
      throw new Error('seedMember: membership vanished after removeMembership');
    }
    membership = reread;
  }
  return { user, team, membership };
}

/**
 * Await a promise (or run a thunk) that is expected to reject/throw; fail the
 * test if it succeeds, so passing tests always prove enforcement happened.
 */
export async function captureFailure(
  run: Promise<unknown> | (() => unknown),
): Promise<unknown> {
  try {
    await (typeof run === 'function' ? run() : run);
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({
    message: 'expected rejection, but the call succeeded',
  });
}

/** Like `captureFailure`, but require the rejection to be a `StateError`. */
export async function captureStateError(
  run: Promise<unknown> | (() => unknown),
): Promise<StateError> {
  const error = await captureFailure(run);
  assert.ok(
    error instanceof StateError,
    `expected StateError, got ${error?.constructor?.name ?? typeof error}`,
  );
  return error;
}

/** Field paths carried on a validation `StateError.fields`, if any. */
export function fieldPaths(error: StateError): ReadonlyArray<string> {
  return (error.fields ?? []).map((field) => field.path);
}

/* -- Local minimal storage builders (never import from test/storage). -- */

export interface RowOpts {
  readonly id?: string;
  readonly version?: number;
  readonly created?: number;
  readonly updated?: number;
  readonly createdBy?: string;
  readonly updatedBy?: string;
  readonly archivedAt?: number | null;
  readonly data?: Record<string, unknown>;
}

export function makeRow(opts: RowOpts = {}): StoredRow {
  return {
    id: asId(opts.id ?? 'rec-1'),
    version: asVersion(opts.version ?? 1),
    created: opts.created ?? FIXED_NOW,
    updated: opts.updated ?? FIXED_NOW,
    createdBy: opts.createdBy ?? 'user-alice',
    updatedBy: opts.updatedBy ?? 'user-alice',
    archivedAt: opts.archivedAt ?? null,
    data: opts.data ?? {},
  };
}

export interface BatchParts {
  readonly writes?: ReadonlyArray<DomainWrite>;
  readonly history?: ReadonlyArray<HistoryEntry>;
  readonly receipt?: Receipt | null;
  readonly outbox?: ReadonlyArray<OutboxIntent>;
  readonly schedules?: ReadonlyArray<ScheduleOp>;
  readonly uniqueClaims?: ReadonlyArray<UniqueClaim>;
  readonly uniqueReleases?: ReadonlyArray<UniqueRelease>;
}

export function makeBatch(expectedRevision: number, parts: BatchParts = {}): CommitBatch {
  return {
    expectedRevision: asRevision(expectedRevision),
    writes: parts.writes ?? [],
    history: parts.history ?? [],
    receipt: parts.receipt ?? null,
    outbox: parts.outbox ?? [],
    schedules: parts.schedules ?? [],
    uniqueClaims: parts.uniqueClaims ?? [],
    uniqueReleases: parts.uniqueReleases ?? [],
  };
}

/** Insert one row at the store's current revision; return the stored row. */
export async function seedRow(
  store: StoragePort,
  model: ModelName,
  opts: RowOpts = {},
): Promise<StoredRow> {
  const row = makeRow(opts);
  const revision = await store.readRevision();
  await store.commit(makeBatch(revision as number, { writes: [{ kind: 'insert', model, row }] }));
  return row;
}

/** Apply one version bump (+ optional patch) on top of `current`. */
export async function updateRow(
  store: StoragePort,
  model: ModelName,
  current: StoredRow,
  patch: Partial<StoredRow> = {},
): Promise<StoredRow> {
  const revision = await store.readRevision();
  const next: StoredRow = {
    ...current,
    version: asVersion((current.version as number) + 1),
    updated: FIXED_NOW,
    ...patch,
  };
  await store.commit(
    makeBatch(revision as number, {
      writes: [{ kind: 'update', model, id: current.id, expectedVersion: current.version, row: next }],
    }),
  );
  return next;
}

export interface ReceiptOpts {
  readonly app?: string;
  readonly owner?: string;
  readonly principal?: string;
  readonly operation?: string;
  readonly operationId?: string;
  readonly inputHash?: string;
  readonly resolvedDefaults?: Record<string, unknown>;
  readonly outcome?: Receipt['outcome'];
  readonly committedRevision?: number;
  readonly createdAt?: number;
}

export function makeReceiptIdentity(opts: ReceiptOpts = {}): ReceiptIdentity {
  return {
    app: opts.app ?? 'acme-app',
    owner: opts.owner ?? 'team-a',
    principal: opts.principal ?? 'user-alice',
    operation: asOperation(opts.operation ?? 'Acme.approve'),
    operationId: asOperationId(opts.operationId ?? 'op-1'),
  };
}

export function makeReceipt(opts: ReceiptOpts = {}): Receipt {
  return {
    identity: makeReceiptIdentity(opts),
    inputHash: opts.inputHash ?? 'hash-1',
    resolvedDefaults: opts.resolvedDefaults ?? {},
    outcome: opts.outcome ?? {
      status: 'committed',
      result: { ok: true },
      recordVersions: [],
    },
    committedRevision: asRevision(opts.committedRevision ?? 1),
    createdAt: opts.createdAt ?? FIXED_NOW,
  };
}

/** Commit a batch carrying only `receipt` at the current revision. */
export async function seedReceipt(store: StoragePort, receipt: Receipt): Promise<Revision> {
  const revision = await store.readRevision();
  const result = await store.commit(makeBatch(revision as number, { receipt }));
  return result.revision;
}
