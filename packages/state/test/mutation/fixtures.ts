/**
 * Lane 03 S5 mutation fixtures (test worker): interim model-table builders,
 * CRUD invoke wiring over the memory store + the local membership double, and
 * seed helpers for rows/parents. Builders only: no assertions, no miniflare.
 *
 * Aligned to the implementer's actuals: `crudDefs`/`crudExecute` envelope
 * conventions, `runMutationWrites` pipeline input, `InterimModelDef` shapes.
 */
import type { Team } from '@canlang/contracts';
import type {
  AdmissionKind,
  DeleteMode,
  InvocationContext,
  ModelName,
  QueryPredicate,
  Receipt,
  RecordId,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import type { MutationEnvelope, MutationResult } from '@canlang/contracts';
import {
  buildModelTable,
  crudDefs,
  crudExecute,
  type CrudDefsOptions,
  type InterimFieldDef,
  type InterimHook,
  type InterimHookOp,
  type InterimInvariant,
  type InterimLock,
  type InterimModelDef,
  type InterimRefDef,
  type ModelTable,
} from '../../src/mutation/index.js';
import { invoke } from '../../src/invocation/invoke.js';
import type { ExecuteHandler } from '../../src/invocation/invoke.js';
import { receiptIdentityFor } from '../../src/invocation/admission.js';
import { buildContext } from '../../src/invocation/context.js';
import type { OperationRegistry } from '../../src/invocation/registry.js';
import { createTestMemoryStorage } from '../../src/storage/memory.js';
import type { MemoryStoreProbe } from '../../src/storage/memory.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  asOperation,
  asOperationId,
  captureStateError,
  createMemoryIdentityStore,
  makeBatch,
  makeEnvelope,
  makeIdentity,
  makeRow,
  seedMember,
  uuidv7,
} from '../invocation/fixtures.js';
import type {
  RowOpts,
  SeededMember,
  TestMembershipStore,
} from '../invocation/fixtures.js';

export { FIXED_NOW, asId, asModel, asOperation, captureStateError };
export type { SeededMember, TestMembershipStore };

/** Deployment app carried on every test invoke + receipt identity. */
export const APP = 'acme-app';

/* -- Interim model-table builders. -- */

export interface FieldOpts {
  readonly required?: boolean;
  readonly serverOnly?: boolean;
  readonly default?: unknown;
}

/** One interim field; absent options mean optional + caller-writable. */
export function field(opts: FieldOpts = {}): InterimFieldDef {
  const def: InterimFieldDef = {
    required: opts.required ?? false,
    serverOnly: opts.serverOnly ?? false,
  };
  return opts.default === undefined ? def : { ...def, default: opts.default };
}

export interface ModelDefOpts {
  readonly fields?: Record<string, InterimFieldDef>;
  readonly refs?: ReadonlyArray<InterimRefDef>;
  readonly uniqueKeys?: ReadonlyArray<string>;
  readonly deleteMode?: DeleteMode;
  readonly hooks?: ReadonlyArray<InterimHook>;
  readonly invariants?: ReadonlyArray<InterimInvariant>;
  readonly locks?: ReadonlyArray<InterimLock>;
}

/** One interim model def; delete mode defaults to `archive`. */
export function modelDef(model: string, opts: ModelDefOpts = {}): InterimModelDef {
  return {
    model: asModel(model),
    fields: opts.fields ?? {},
    refs: opts.refs ?? [],
    uniqueKeys: opts.uniqueKeys ?? [],
    deleteMode: opts.deleteMode ?? 'archive',
    hooks: opts.hooks ?? [],
    invariants: opts.invariants ?? [],
    locks: opts.locks ?? [],
  };
}

/** One interim reference path (`{ id }` values) targeting `model`. */
export function refDef(fieldPath: string, model: string): InterimRefDef {
  return { field: fieldPath, model: asModel(model) };
}

/** One interim hook over the given caller-intent ops. */
export function hook(
  name: string,
  ops: ReadonlyArray<InterimHookOp>,
  run: InterimHook['run'],
): InterimHook {
  return { name, ops, run };
}

/** One interim invariant over the final provisional state. */
export function invariant(name: string, check: InterimInvariant['check']): InterimInvariant {
  return { name, check };
}

/** One interim pre-state lock. */
export function lock(name: string, when: QueryPredicate): InterimLock {
  return { name, when };
}

/* -- CRUD invoke wiring. -- */

export interface MutationWorld {
  readonly store: StoragePort;
  readonly probe: MemoryStoreProbe;
  readonly memberships: TestMembershipStore;
  readonly team: Team;
  readonly alice: SeededMember;
  readonly table: ModelTable;
  readonly registry: OperationRegistry;
  readonly execute: ExecuteHandler;
}

/**
 * One isolated world: memory store + probe, membership double with one
 * member (Alice), model table, CRUD registry, and a dispatching executor.
 * CRUD defs default to member-authorized with no candidate precondition.
 */
export async function setupMutation(
  models: ReadonlyArray<InterimModelDef>,
  crudOpts: CrudDefsOptions = { by: 'members' },
): Promise<MutationWorld> {
  const { store, probe } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const team = alice.team;
  const table = buildModelTable(models);
  const registry: OperationRegistry = new Map();
  const executors = new Map<string, ExecuteHandler>();
  for (const def of models) {
    const triple = crudDefs(def.model, crudOpts);
    (registry as Map<string, unknown>).set(triple.create.name as string, triple.create);
    (registry as Map<string, unknown>).set(triple.update.name as string, triple.update);
    (registry as Map<string, unknown>).set(triple.remove.name as string, triple.remove);
    executors.set(def.model as string, crudExecute({ table, model: def.model, store }));
  }
  const execute: ExecuteHandler = (call) => {
    const name = call.def.name as string;
    const owner = name.slice(0, name.lastIndexOf('.'));
    const routed = executors.get(owner);
    if (routed === undefined) {
      throw new Error(`No CRUD executor for operation ${JSON.stringify(name)}.`);
    }
    return routed(call);
  };
  return { store, probe, memberships, team, alice, table, registry, execute };
}

/** ResolvedIdentity for a seeded member (mirrors the invoke-test helper). */
export function identityFor(member: SeededMember) {
  return makeIdentity({ membership: member.membership, email: member.user.email });
}

let opSeq = 0;

/** Fresh deterministic UUIDv7 operation id at the frozen clock. */
export function freshOperationId(): string {
  opSeq += 1;
  return uuidv7(FIXED_NOW, opSeq);
}

let recSeq = 0;

/** Fresh deterministic record id. */
export function freshRecordId(prefix = 'rec'): string {
  recSeq += 1;
  return `${prefix}-${recSeq}`;
}

export interface CrudCallOpts {
  readonly world: MutationWorld;
  readonly operation: string;
  readonly inputs: Record<string, unknown>;
  readonly operationId?: string;
  readonly member?: SeededMember;
  readonly kind?: AdmissionKind;
  readonly trustedSource?: string;
}

/** One CRUD invoke over the world (frozen clock, `test` source). */
export async function crudCall(opts: CrudCallOpts): Promise<MutationResult> {
  const member = opts.member ?? opts.world.alice;
  const envelope: MutationEnvelope = makeEnvelope(
    opts.operation,
    opts.operationId ?? freshOperationId(),
    opts.inputs,
  );
  return invoke({
    registry: opts.world.registry,
    envelope,
    identity: identityFor(member),
    app: APP,
    source: 'test',
    store: opts.world.store,
    memberships: opts.world.memberships,
    clock: { nowMs: () => FIXED_NOW },
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
    ...(opts.trustedSource !== undefined ? { trustedSource: opts.trustedSource } : {}),
    execute: opts.world.execute,
  });
}

export interface CrudResult {
  readonly out: MutationResult;
  readonly operationId: string;
}

export interface CreateOpts {
  readonly id?: string;
  readonly data?: Record<string, unknown>;
  readonly parent?: { readonly model: string; readonly id: string };
  readonly member?: SeededMember;
  readonly operationId?: string;
}

/** CRUD create call (`{ id, data, parent? }` envelope convention). */
export async function crudCreate(
  world: MutationWorld,
  model: string,
  opts: CreateOpts = {},
): Promise<CrudResult> {
  const operationId = opts.operationId ?? freshOperationId();
  const inputs: Record<string, unknown> = {
    id: opts.id ?? freshRecordId(),
    data: opts.data ?? {},
    ...(opts.parent !== undefined ? { parent: { ...opts.parent } } : {}),
  };
  const out = await crudCall({
    world,
    operation: `${model}.create`,
    inputs,
    operationId,
    ...(opts.member !== undefined ? { member: opts.member } : {}),
  });
  return { out, operationId };
}

export interface UpdateOpts {
  readonly version: number;
  readonly patch?: Record<string, unknown>;
  readonly member?: SeededMember;
  readonly operationId?: string;
}

/** CRUD update call (`{ ref, patch }` envelope convention). */
export async function crudUpdate(
  world: MutationWorld,
  model: string,
  id: string,
  opts: UpdateOpts,
): Promise<CrudResult> {
  const operationId = opts.operationId ?? freshOperationId();
  const inputs: Record<string, unknown> = {
    ref: { id, version: String(opts.version) },
    patch: opts.patch ?? {},
  };
  const out = await crudCall({
    world,
    operation: `${model}.update`,
    inputs,
    operationId,
    ...(opts.member !== undefined ? { member: opts.member } : {}),
  });
  return { out, operationId };
}

export interface RemoveOpts {
  readonly version: number;
  readonly member?: SeededMember;
  readonly operationId?: string;
}

/** CRUD remove call (`{ ref }` envelope convention; op name is `.delete`). */
export async function crudRemove(
  world: MutationWorld,
  model: string,
  id: string,
  opts: RemoveOpts,
): Promise<CrudResult> {
  const operationId = opts.operationId ?? freshOperationId();
  const inputs: Record<string, unknown> = { ref: { id, version: String(opts.version) } };
  const out = await crudCall({
    world,
    operation: `${model}.delete`,
    inputs,
    operationId,
    ...(opts.member !== undefined ? { member: opts.member } : {}),
  });
  return { out, operationId };
}

export interface ReceiptLookup {
  readonly operation: string;
  readonly operationId: string;
  readonly member?: SeededMember;
  readonly kind?: AdmissionKind;
  readonly trustedSource?: string;
}

/**
 * Read the receipt for one CRUD call: mirrors invoke's internally built
 * context (same app/identity/operation/clock) and resolves its identity.
 */
export async function readCrudReceipt(
  world: MutationWorld,
  lookup: ReceiptLookup,
): Promise<Receipt | null> {
  const member = lookup.member ?? world.alice;
  const ctx = buildContext({
    identity: identityFor(member),
    operation: asOperation(lookup.operation),
    operationId: lookup.operationId,
    app: APP,
    source: 'test',
    now: FIXED_NOW,
    ...(lookup.kind !== undefined ? { kind: lookup.kind } : {}),
    ...(lookup.trustedSource !== undefined ? { trustedSource: lookup.trustedSource } : {}),
  });
  return world.store.readReceipt(receiptIdentityFor(ctx));
}

export interface PipelineContextOpts {
  readonly operation: string;
  readonly operationId?: string;
  readonly actor?: string | null;
  readonly teamId?: string | null;
  readonly kind?: AdmissionKind;
  readonly trustedSource?: string;
  readonly now?: number;
}

/** Frozen pipeline context for direct `runMutationWrites` calls. */
export function pipelineContext(opts: PipelineContextOpts): InvocationContext {
  return {
    kind: opts.kind ?? 'user',
    app: APP,
    actor:
      opts.actor === undefined
        ? { userId: 'user-alice' }
        : opts.actor === null
          ? null
          : { userId: opts.actor },
    team:
      opts.teamId === undefined
        ? { teamId: 'team-a', timezone: 'UTC' }
        : opts.teamId === null
          ? null
          : { teamId: opts.teamId, timezone: 'UTC' },
    operation: asOperation(opts.operation),
    operationId: asOperationId(opts.operationId ?? freshOperationId()),
    source: 'test',
    now: opts.now ?? FIXED_NOW,
    ...(opts.trustedSource !== undefined ? { trustedSource: opts.trustedSource } : {}),
  };
}

/* -- Row/parent seed helpers. -- */

export interface SeedRowOpts extends RowOpts {
  readonly parent?: { readonly model: string; readonly id: string };
}

/** Insert one stored row at the current revision (optional parent linkage). */
export async function seedStoredRow(
  store: StoragePort,
  model: ModelName,
  opts: SeedRowOpts = {},
): Promise<StoredRow> {
  const { parent, ...rowOpts } = opts;
  const row: StoredRow = {
    ...makeRow(rowOpts),
    ...(parent !== undefined
      ? { parent: { model: asModel(parent.model), id: asId(parent.id) } }
      : {}),
  };
  const revision = await store.readRevision();
  await store.commit(
    makeBatch(revision as number, { writes: [{ kind: 'insert', model, row }] }),
  );
  return row;
}

/** Insert one parent row plus `count` children parented to it. */
export async function seedParentWithChildren(
  store: StoragePort,
  parentModel: ModelName,
  childModel: ModelName,
  opts: { readonly parentId?: string; readonly childIds: ReadonlyArray<string> },
): Promise<{ readonly parent: StoredRow; readonly children: StoredRow[] }> {
  const parent = await seedStoredRow(store, parentModel, { id: opts.parentId ?? 'parent-1' });
  const children: StoredRow[] = [];
  for (const id of opts.childIds) {
    children.push(
      await seedStoredRow(store, childModel, {
        id,
        parent: { model: parentModel as string, id: parent.id as string },
      }),
    );
  }
  return { parent, children };
}

/** Load a row or fail the test with a readable message. */
export async function mustLoad(
  store: StoragePort,
  model: ModelName,
  id: string,
): Promise<StoredRow> {
  const row = await store.load(model, asId(id));
  if (row === null) {
    throw new Error(`Expected stored row ${model as string}/${id}.`);
  }
  return row;
}

/** Reference value for interim `{ id }` ref fields. */
export function refValue(id: string): { readonly id: string } {
  return { id };
}
