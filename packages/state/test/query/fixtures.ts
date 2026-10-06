/**
 * Lane 03 S4 query/policy fixtures (worker B): deterministic row seeders,
 * value builders, and multi-user/team membership seeding over the memory
 * StoragePort + the invocation fixtures' local membership double.
 *
 * Policy-table builders align to worker A's `src/policy/grants.ts` actuals
 * and land with the test files once that API exists; nothing here invents
 * engine APIs. Builders only: no assertions, no miniflare.
 */
import type { Team } from '@canlang/contracts';
import type { MoneyValue, SecretValue } from '@canlang/contracts';
import type {
  AggregateSpec,
  ModelName,
  OrderTerm,
  QueryPredicate,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import {
  buildPolicyTable,
  type ByContext,
  type InterimGrant,
  type InterimModelPolicy,
  type PolicyTable,
} from '../../src/policy/grants.js';
import type { ByPredicate } from '../../src/policy/roles.js';
import type {
  OwnerRecordsInput,
  QueryAggregateInput,
  ViewerRecordsInput,
} from '../../src/query/index.js';
import {
  FIXED_NOW,
  asModel,
  createMemoryIdentityStore,
  makeBatch,
  makeRow,
  seedMember,
} from '../invocation/fixtures.js';
import type {
  RowOpts,
  SeededMember,
  TestMembershipStore,
} from '../invocation/fixtures.js';

export { FIXED_NOW, asModel };
export type { ByContext, InterimGrant, InterimModelPolicy, PolicyTable, SeededMember, TestMembershipStore };
export type { ByPredicate };

/** Package-qualified declared role used across the query suites. */
export const REVIEWER = 'Acme.reviewer';

/** Native money value per the values contract (`minor` is bigint). */
export function money(minor: bigint, currency: string): MoneyValue {
  return { kind: 'money', minor, currency };
}

/**
 * JSON-safe stored money the engine sums (`minor` as a number). Storage
 * serializes rows with plain JSON, which cannot carry a bigint minor, so the
 * engine accepts number minors; the strict bigint contract shape needs the
 * pending L2 wire-codec join to round-trip through a store.
 */
export interface StoredMoney {
  readonly kind: 'money';
  readonly minor: number;
  readonly currency: string;
}

export function storedMoney(minor: number, currency: string): StoredMoney {
  return { kind: 'money', minor, currency };
}

/** Opaque server-only secret value. */
export function secret(): SecretValue {
  return { kind: 'secret' };
}

/** Nested notification object with a `status` leaf plus optional siblings. */
export function notification(
  status: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { status, ...extra };
}

/**
 * Insert every row in one fenced batch at the store's current revision;
 * return the rows as written. `RowOpts` (id/version/created/data/...) comes
 * from the invocation fixtures.
 */
export async function seedRows(
  store: StoragePort,
  model: ModelName,
  rows: ReadonlyArray<RowOpts>,
): Promise<StoredRow[]> {
  const made = rows.map((opts) => makeRow(opts));
  const revision = await store.readRevision();
  await store.commit(
    makeBatch(revision as number, {
      writes: made.map((row) => ({ kind: 'insert' as const, model, row })),
    }),
  );
  return made;
}

export interface StandardTeam {
  readonly memberships: TestMembershipStore;
  readonly team: Team;
  /** Ordinary active member, no declared roles. */
  readonly alice: SeededMember;
  /** Team owner, no declared roles (owner implies no declared grant). */
  readonly owner: SeededMember;
  /** Active member holding the `Acme.reviewer` grant. */
  readonly carol: SeededMember;
  /** Membership removed; must see nothing member-gated. */
  readonly dave: SeededMember;
  /** Active member of a different team; outsider to `team`. */
  readonly outsider: SeededMember;
}

/**
 * One team with owner/member/reviewer/removed accounts plus an outsider on
 * a second team. All memberships are active except Dave's (`removed`).
 */
export async function seedStandardTeam(): Promise<StandardTeam> {
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const team = alice.team;
  const owner = await seedMember(memberships, { teamId: team.team_id, isOwner: true });
  const carol = await seedMember(memberships, {
    teamId: team.team_id,
    isOwner: false,
    roles: [REVIEWER],
  });
  const dave = await seedMember(memberships, {
    teamId: team.team_id,
    isOwner: false,
    status: 'removed',
  });
  const outsider = await seedMember(memberships, { isOwner: false });
  return { memberships, team, alice, owner, carol, dave, outsider };
}

/** One visibility grant: `by` actor predicate, dot-path `fields`, optional row `when`. */
export function grant(
  by: ByPredicate,
  fields: ReadonlyArray<string>,
  when?: QueryPredicate,
): InterimGrant {
  return when === undefined ? { by, fields: [...fields] } : { by, fields: [...fields], when };
}

export interface ModelPolicyOpts {
  readonly secretFields?: ReadonlyArray<string>;
  readonly grants: ReadonlyArray<InterimGrant>;
}

/** One interim per-model policy: secret subtrees plus visibility grants. */
export function modelPolicy(model: ModelName, opts: ModelPolicyOpts): InterimModelPolicy {
  return {
    model,
    secretFields: [...(opts.secretFields ?? [])],
    grants: [...opts.grants],
  };
}

/** Validate and freeze model policies into the engine's lookup table. */
export function policyTable(...policies: ReadonlyArray<InterimModelPolicy>): PolicyTable {
  return buildPolicyTable(policies);
}

/** Caller authorization facts for `by` evaluation from a seeded member. */
export function byContext(member: SeededMember, memberships: TestMembershipStore): ByContext {
  return {
    actorUserId: member.user.user_id,
    teamId: member.team.team_id,
    membership: member.membership,
    memberships,
  };
}

export interface EngineCallOpts {
  readonly store: StoragePort;
  readonly memberships: TestMembershipStore;
  readonly policy: PolicyTable;
  readonly model: ModelName;
  /** Team scope the query resolves memberships in (the data-owning team). */
  readonly scope: Team;
  readonly caller: SeededMember;
  readonly where?: QueryPredicate;
  readonly order?: ReadonlyArray<OrderTerm>;
  readonly limit?: number;
  readonly archived?: 'exclude' | 'include';
}

function engineBase(opts: EngineCallOpts): {
  readonly policy: PolicyTable;
  readonly model: ModelName;
  readonly context: { readonly actorUserId: string; readonly teamId: string };
  readonly memberships: TestMembershipStore;
  readonly store: StoragePort;
  readonly where?: QueryPredicate;
  readonly order?: ReadonlyArray<OrderTerm>;
  readonly limit?: number;
  readonly archived?: 'exclude' | 'include';
} {
  return {
    policy: opts.policy,
    model: opts.model,
    context: { actorUserId: opts.caller.user.user_id, teamId: opts.scope.team_id },
    memberships: opts.memberships,
    store: opts.store,
    ...(opts.where !== undefined ? { where: opts.where } : {}),
    ...(opts.order !== undefined ? { order: opts.order } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.archived !== undefined ? { archived: opts.archived } : {}),
  };
}

/** Viewer record-query input for `caller` in `scope`. */
export function viewerInput(opts: EngineCallOpts): ViewerRecordsInput {
  return { ...engineBase(opts), authority: 'viewer' };
}

/** Owner record-query input for `caller` in `scope`. */
export function ownerInput(opts: EngineCallOpts): OwnerRecordsInput {
  return { ...engineBase(opts), authority: 'owner' };
}

/** Aggregate input for `caller` in `scope` over the given spec. */
export function aggregateInput(
  opts: EngineCallOpts & { readonly spec: AggregateSpec },
): QueryAggregateInput {
  return { ...engineBase(opts), authority: 'viewer', spec: opts.spec };
}

/** Owner-mode aggregate input (bypasses grant-coverage checks). */
export function ownerAggregateInput(
  opts: EngineCallOpts & { readonly spec: AggregateSpec },
): QueryAggregateInput {
  return { ...engineBase(opts), authority: 'owner', spec: opts.spec };
}
