/**
 * Lane 03 S7 migration fixtures (engine worker): installed-snapshot and
 * transition builders, interim old/desired model tables around the DESIGN
 * §11.2 Todo illustration, live-row/outbox seed helpers over the memory
 * store, and staging/activation drivers. Builders only: no assertions.
 *
 * Reuses the invocation/mutation fixture builders read-only; nothing here
 * invents engine or storage APIs.
 */
import type {
  InstalledSnapshot,
  MigrationDirective,
  MigrationTransition,
  ModelName,
  OutboxIntent,
  RecordId,
  Revision,
  StoragePort,
  StoredRow,
  WorkInventoryItem,
} from '../../../contracts/src/state.js';
import type { ClockPort } from '../../src/invocation/context.js';
import type { InterimLock, InterimModelDef, ModelTable } from '../../src/mutation/index.js';
import { buildModelTable } from '../../src/mutation/index.js';
import { validateTransition, type ValidatedMigrationPlan } from '../../src/migration/index.js';
import { createTestMemoryStorage, type MemoryStoreProbe } from '../../src/storage/memory.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  asOperation,
  asOperationId,
  asRevision,
  asVersion,
  captureStateError,
  makeBatch,
  makeRow,
  type RowOpts,
} from '../invocation/fixtures.js';
import { field, modelDef } from '../mutation/fixtures.js';

export { FIXED_NOW, asId, asModel, asOperation, asRevision, asVersion, captureStateError };
export { field, modelDef, makeBatch, makeRow };
export type { MemoryStoreProbe, ModelTable, RowOpts };

/** Migration world: isolated memory store plus its probe. */
export interface MigrationWorld {
  readonly store: StoragePort;
  readonly probe: MemoryStoreProbe;
}

/** One isolated world per test (fresh store at revision 0). */
export function setupMigrationWorld(): MigrationWorld {
  const { store, probe } = createTestMemoryStorage();
  return { store, probe };
}

/** Frozen engine clock pinned at FIXED_NOW. */
export function fixedClock(): ClockPort {
  return { nowMs: () => FIXED_NOW };
}

/* -- Snapshot + transition builders. -- */

export interface InstalledOpts {
  readonly owner?: string;
  readonly snapshotId?: string;
  readonly digest?: string;
  readonly installedRevision?: number;
  readonly installedAt?: number;
}

/** Installed predecessor snapshot (`acme/snap-1` by default). */
export function makeInstalled(opts: InstalledOpts = {}): InstalledSnapshot {
  return {
    owner: opts.owner ?? 'acme',
    snapshotId: opts.snapshotId ?? 'snap-1',
    digest: opts.digest ?? 'digest-1',
    installedRevision: asRevision(opts.installedRevision ?? 0),
    installedAt: opts.installedAt ?? FIXED_NOW,
  };
}

export interface TransitionOpts {
  readonly migrationId?: string;
  readonly owner?: string;
  readonly fromSnapshotId?: string;
  readonly fromDigest?: string;
  readonly toSnapshotId?: string;
  readonly toDigest?: string;
  readonly bodyDigest?: string;
  readonly directives?: ReadonlyArray<MigrationDirective>;
}

/** Per-owner transition matching `makeInstalled` by default. */
export function makeTransition(opts: TransitionOpts = {}): MigrationTransition {
  return {
    migrationId: opts.migrationId ?? 'mig-1',
    owner: opts.owner ?? 'acme',
    fromSnapshotId: opts.fromSnapshotId ?? 'snap-1',
    fromDigest: opts.fromDigest ?? 'digest-1',
    toSnapshotId: opts.toSnapshotId ?? 'snap-2',
    toDigest: opts.toDigest ?? 'digest-2',
    bodyDigest: opts.bodyDigest ?? 'body-1',
    directives: opts.directives ?? [],
  };
}

/* -- Interim model tables (DESIGN §11.2 Todo illustration). -- */

export const TODO_MODEL = 'acme.Todo';
export const TASK_MODEL = 'acme.Task';
export const LEGACY_MODEL = 'acme.Legacy';

/** Old Todo: label/done/legacy (see the DESIGN §11.2 illustration). */
export function oldTodoDef(): InterimModelDef {
  return modelDef(TODO_MODEL, {
    fields: {
      label: field({ required: true }),
      done: field({ required: true }),
      legacy: field(),
    },
  });
}

/** Desired Todo: title/done/priority (label renamed, legacy dropped). */
export function desiredTodoDef(): InterimModelDef {
  return modelDef(TODO_MODEL, {
    fields: {
      title: field({ required: true }),
      done: field({ required: true }),
      priority: field({ required: true }),
    },
  });
}

/** Old/desired tables for the Todo rename/backfill/drop illustration. */
export function todoTables(): { readonly oldModels: ModelTable; readonly desiredModels: ModelTable } {
  return {
    oldModels: buildModelTable([oldTodoDef()]),
    desiredModels: buildModelTable([desiredTodoDef()]),
  };
}

/** Directives for the Todo illustration: rename label, backfill, drop legacy. */
export function todoDirectives(): MigrationDirective[] {
  return [
    { kind: 'renameField', model: TODO_MODEL, from: 'label', to: 'title' },
    { kind: 'backfill', model: TODO_MODEL },
    { kind: 'dropField', model: TODO_MODEL, field: 'legacy' },
  ];
}

/** One validated Todo plan (installed `acme/snap-1` by default). */
export function todoPlan(installed: InstalledSnapshot | null = makeInstalled()): ValidatedMigrationPlan {
  const { oldModels, desiredModels } = todoTables();
  return validateTransition(installed, makeTransition({ directives: todoDirectives() }), oldModels, desiredModels);
}

/** Old-lock set builder from `{model, locks}` entries. */
export function oldLocks(
  entries: ReadonlyArray<{ readonly model: string; readonly locks: ReadonlyArray<InterimLock> }>,
): ReadonlyMap<ModelName, ReadonlyArray<InterimLock>> {
  const map = new Map<ModelName, ReadonlyArray<InterimLock>>();
  for (const entry of entries) {
    map.set(asModel(entry.model), entry.locks);
  }
  return map;
}

/* -- Live seed helpers (direct fenced commits, no engine). -- */

export interface SeedRowOpts extends RowOpts {
  readonly id: string;
  readonly data?: Record<string, unknown>;
}

/** Insert live rows under one model at the store's current revisions. */
export async function seedLive(
  store: StoragePort,
  model: string,
  rows: ReadonlyArray<SeedRowOpts>,
): Promise<StoredRow[]> {
  const stored: StoredRow[] = [];
  for (const opts of rows) {
    const row = makeRow({ ...opts, id: opts.id, data: opts.data ?? {} });
    const revision = await store.readRevision();
    await store.commit(
      makeBatch(revision as number, {
        writes: [{ kind: 'insert', model: asModel(model), row }],
      }),
    );
    stored.push(row);
  }
  return stored;
}

export interface SeedOutboxOpts {
  readonly intentId: string;
  readonly operation?: string;
  readonly target?: string;
}

/** Stage pending outbox intents (direct commit; dispatch stays open here). */
export async function seedOutbox(
  store: StoragePort,
  intents: ReadonlyArray<SeedOutboxOpts>,
): Promise<OutboxIntent[]> {
  const staged: OutboxIntent[] = intents.map((intent, index) => ({
    intentId: intent.intentId,
    operation: asOperation(intent.operation ?? 'acme.worker'),
    operationId: asOperationId(`0193${String(index).padStart(28, '0')}`),
    target: intent.target ?? 'worker',
    arguments: {},
    occurrenceIndex: index,
  }));
  const revision = await store.readRevision();
  await store.commit(makeBatch(revision as number, { outbox: staged }));
  return staged;
}

/** One inventoried work item (undispatched by default). */
export function inventoryItem(
  intentId: string,
  handlerContract: string,
  state: WorkInventoryItem['state'] = 'undispatched',
): WorkInventoryItem {
  return { intentId, handlerContract, state };
}

/** Assert a value is a Revision brand (test-side readability helper). */
export function revisionOf(value: Revision): number {
  return value as number;
}

/** Assert a value is a RecordId brand (test-side readability helper). */
export function idOf(value: RecordId): string {
  return value as string;
}
