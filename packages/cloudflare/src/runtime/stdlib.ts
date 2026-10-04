/**
 * B1 interim data-plane stdlib: the c-first functions emitted
 * `async op(c, …)` handlers call. NAMED INTERIM home per coordinator R5.
 *
 * INTERIM B1 binding — handoff to L3. What L3 must formalize:
 * - Route create/set/deleteRecord/records through the state engine
 *   (`crudExecute` / `runMutationWrites` / `queryRecords`) with a real
 *   `ModelTable`, `PolicyTable`, and `InvocationContext` instead of the
 *   direct fenced `StoragePort` commits/queries below.
 * - Thread operation identity (name/id) so writes carry receipts and
 *   history entries (B1 commits `history: []`, `receipt: null`).
 * - Add grant-checked viewer reads (B1 `records()` returns full stored
 *   rows, truthfully labeled `authority: 'owner'` by default).
 * - Implement the 7 stubs (send/emit/schedule/cancel/check/delivery/
 *   secretEqual) against the effects pipeline, schedule store, and
 *   secrets bindings.
 * - Authenticate `hasRole` memberships via the L3 identity/policy join
 *   (B1 evaluates the caller-supplied `c.memberships` array as-is).
 * - Lock the L1 T4 call-shape contract (arg order, branded ids, patch
 *   semantics, error codes) and move this surface to its final home.
 * - Unite with the `@canlang/stdlib` facade (lane-03): B1 maps the
 *   emitted `@canlang/stdlib` specifier here, so only the names below
 *   resolve; every other builtin fails loud at import until the union.
 *
 * The 7 implemented functions delegate to `c.store` via the real
 * `@canlang/state` commit/query protocol (`CommitBatch`, `DomainWrite`,
 * `QuerySpec`) or evaluate pure local semantics (`require`, `hasRole`,
 * `count`); the 7 stubs throw `unsupported(<name>)` — never silent,
 * never fake data.
 */
import type {
  CommitBatch,
  ModelName,
  OrderTerm,
  QueryPredicate,
  QuerySpec,
  ReadAuthority,
  RecordId,
  RecordParent,
  RecordVersion,
  StoredRow,
} from '@canlang/contracts';
import type { HandlerContext } from './context.js';

/** Input for {@link create}: explicit id plus data (crud interim convention). */
export interface CreateInput {
  readonly id: string;
  readonly data: Record<string, unknown>;
  readonly parent?: RecordParent;
}

/** Query overrides for {@link records}; everything is optional. */
export interface RecordsQuery {
  readonly where?: QueryPredicate;
  readonly order?: ReadonlyArray<OrderTerm>;
  readonly limit?: number;
  readonly archived?: 'exclude' | 'include';
  /**
   * Read authority label. Defaults to `'owner'` (full stored rows — the
   * only truthful label until L3 adds grant-checked projection).
   */
  readonly authority?: ReadAuthority;
}

/** Empty commit tail: no history/receipt/outbox/schedules/uniques in B1. */
function commitBatch(expectedRevision: CommitBatch['expectedRevision'], writes: CommitBatch['writes']): CommitBatch {
  return {
    expectedRevision,
    writes,
    history: [],
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
  };
}

/**
 * Insert one record (version 1) via a fenced `StoragePort` commit.
 * Timestamps come from `c.clock()`; attribution from `c.caller.userId`.
 */
export async function create(
  c: HandlerContext,
  model: string,
  input: CreateInput,
): Promise<StoredRow> {
  const now = c.clock();
  const row: StoredRow = {
    id: input.id as RecordId,
    version: 1 as RecordVersion,
    created: now,
    updated: now,
    createdBy: c.caller.userId,
    updatedBy: c.caller.userId,
    archivedAt: null,
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    data: input.data,
  };
  await c.store.commit(
    commitBatch(await c.store.readRevision(), [
      { kind: 'insert', model: model as ModelName, row },
    ]),
  );
  return row;
}

/**
 * Patch one existing record via a fenced `StoragePort` commit (shallow data
 * merge, version + 1). Throws when the record does not exist; version
 * conflicts surface as the store's own fence/constraint error.
 */
export async function set(
  c: HandlerContext,
  model: string,
  id: string,
  patch: Record<string, unknown>,
): Promise<StoredRow> {
  const current = await c.store.load(model as ModelName, id as RecordId);
  if (current === null) {
    throw new Error(`set(${model}/${id}): record not found.`);
  }
  const row: StoredRow = {
    ...current,
    version: ((current.version as number) + 1) as RecordVersion,
    updated: c.clock(),
    updatedBy: c.caller.userId,
    data: { ...current.data, ...patch },
  };
  await c.store.commit(
    commitBatch(await c.store.readRevision(), [
      {
        kind: 'update',
        model: model as ModelName,
        id: id as RecordId,
        expectedVersion: current.version,
        row,
      },
    ]),
  );
  return row;
}

/**
 * Hard-remove one record via a fenced `StoragePort` commit. Throws when the
 * record does not exist. Archive-mode deletes are L3 work (delete modes
 * live in the model table B1 does not have).
 */
export async function deleteRecord(
  c: HandlerContext,
  model: string,
  id: string,
): Promise<void> {
  const current = await c.store.load(model as ModelName, id as RecordId);
  if (current === null) {
    throw new Error(`deleteRecord(${model}/${id}): record not found.`);
  }
  await c.store.commit(
    commitBatch(await c.store.readRevision(), [
      {
        kind: 'remove',
        model: model as ModelName,
        id: id as RecordId,
        expectedVersion: current.version,
      },
    ]),
  );
}

/**
 * Query stored rows via `StoragePort.query`, passing the spec through.
 * Returns full stored rows (`authority: 'owner'` default); grant-checked
 * viewer projection is L3 work through `queryRecords`.
 */
export function records(
  c: HandlerContext,
  model: string,
  query: RecordsQuery = {},
): Promise<ReadonlyArray<StoredRow>> {
  const spec: QuerySpec = {
    model: model as ModelName,
    authority: query.authority ?? 'owner',
    ...(query.where === undefined ? {} : { where: query.where }),
    ...(query.order === undefined ? {} : { order: query.order }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.archived === undefined ? {} : { archived: query.archived }),
  };
  return c.store.query(spec);
}

/** Stub helper: every unimplemented data-plane name throws loudly. */
function unsupported(name: string, reason: string): never {
  throw new Error(`unsupported(${name}): ${reason}`);
}

/** Not in B1: message dispatch needs the L3 outbox/effects pipeline. */
export function send(c: HandlerContext, ..._args: unknown[]): never {
  void c;
  return unsupported('send', 'message dispatch needs the L3 outbox/effects pipeline.');
}

/** Not in B1: domain-event emission needs the L3 effects pipeline. */
export function emit(c: HandlerContext, ..._args: unknown[]): never {
  void c;
  return unsupported('emit', 'domain-event emission needs the L3 effects pipeline.');
}

/** Not in B1: scheduled work needs the L3 schedule store + dispatcher. */
export function schedule(c: HandlerContext, ..._args: unknown[]): never {
  void c;
  return unsupported('schedule', 'scheduled work needs the L3 schedule store + dispatcher.');
}

/** Not in B1: schedule cancellation needs the L3 schedule store. */
export function cancel(c: HandlerContext, ..._args: unknown[]): never {
  void c;
  return unsupported('cancel', 'schedule cancellation needs the L3 schedule store.');
}

/** Not in B1: receipt/idempotency checks need the L3 invocation context. */
export function check(c: HandlerContext, ..._args: unknown[]): never {
  void c;
  return unsupported('check', 'receipt/idempotency checks need the L3 invocation context.');
}

/** Not in B1: delivery status needs the L3 outbox dispatcher. */
export function delivery(c: HandlerContext, ..._args: unknown[]): never {
  void c;
  return unsupported('delivery', 'delivery status needs the L3 outbox dispatcher.');
}

/**
 * Guard assertion, emitted as `require as check`. Throws `Error(code)`
 * unless `condition` is truthy. `code` should be a `BusinessErrorCode`
 * (`'forbidden'` default); it stays a plain string here because the
 * compiler emits it verbatim and no producer owns the guard contract yet.
 */
export function require(condition: unknown, code = 'forbidden'): void {
  if (condition) return;
  throw new Error(typeof code === 'string' && code !== '' ? code : 'forbidden');
}

/**
 * Role test against the context memberships. INTERIM trust root: B1
 * evaluates the caller-supplied `c.memberships` array as-is — membership
 * authentication is the L3 identity/policy join. Anonymous contexts
 * (memberships `[]`) deny every role: fail-closed by construction.
 */
export function hasRole(c: HandlerContext, role: string): boolean {
  return c.memberships.includes(role);
}

/**
 * Supplied-array count, mirroring the lane-02 `count(domain:C<T>)->int`
 * catalog entry (values `array.ts`: `BigInt(length)`, loud on non-array).
 * Interim local mirror until the facade union; record-query evaluation
 * stays lane-03's per the catalog note.
 */
export function count(domain: ReadonlyArray<unknown>): bigint {
  if (!Array.isArray(domain)) throw new Error('count: domain must be an array');
  return BigInt(domain.length);
}

/** Not in B1: constant-time secret comparison needs the L3 secrets binding. */
export function secretEqual(c: HandlerContext, ..._args: unknown[]): never {
  void c;
  return unsupported('secretEqual', 'constant-time secret comparison needs the L3 secrets binding.');
}
