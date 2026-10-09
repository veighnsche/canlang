/**
 * Shared storage conformance suite for lane 03 slice S2.
 *
 * This module is NOT a test file itself (no `.test.ts` suffix): backend
 * suites call `storageConformance()` with a setup callback that builds the
 * backend under test. Every subtest resets first, so fixed fixture ids are
 * safe and also prove the backend's reset truly clears all tables.
 *
 * Aligned to worker A's `src/storage/*` actuals: batches carry camelCase
 * `uniqueClaims`/`uniqueReleases` (see `BatchParts`); S5 stores parent
 * linkage, so the parent subtests cover positive scoping plus the
 * NULL-linkage scoped-returns-empty case.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  CommitBatch,
  DomainWrite,
  HistoryEntry,
  InstalledSnapshot,
  MigrationDrop,
  MigrationOutcome,
  MigrationPhase,
  MigrationProgress,
  ModelName,
  OperationId,
  OperationName,
  OutboxIntent,
  QuerySpec,
  Receipt,
  ReceiptIdentity,
  RecordId,
  RecordParent,
  RecordVersion,
  Revision,
  ScheduleOp,
  StagedRow,
  StagedRowCursor,
  StoragePort,
  StoredRow,
  UniqueClaim,
  UniqueRelease,
} from '@canlang/contracts';
// Single adjustment point for worker A's actual error/class locations.
import { FenceConflictError, StorageConstraintError } from '../../src/storage/port.js';

export { FenceConflictError, StorageConstraintError };

/* Brand helpers (allowed casts for tests). */
export const asModel = (s: string): ModelName => s as ModelName;
export const asId = (s: string): RecordId => s as RecordId;
export const asVersion = (n: number): RecordVersion => n as RecordVersion;
export const asRevision = (n: number): Revision => n as Revision;
export const asOperation = (s: string): OperationName => s as OperationName;
export const asOperationId = (s: string): OperationId => s as OperationId;

let nextSeq = 0;
export function freshId(prefix: string): string {
  nextSeq += 1;
  return `${prefix}-${nextSeq}`;
}

/* Fixture builders. */

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
    id: asId(opts.id ?? freshId('rec')),
    version: asVersion(opts.version ?? 1),
    created: opts.created ?? 1_700_000_000_000,
    updated: opts.updated ?? 1_700_000_000_000,
    createdBy: opts.createdBy ?? 'user-1',
    updatedBy: opts.updatedBy ?? 'user-1',
    archivedAt: opts.archivedAt ?? null,
    data: opts.data ?? {},
  };
}

export interface ReceiptOpts {
  readonly app?: string;
  readonly owner?: string;
  readonly principal?: string;
  readonly operation?: string;
  readonly operationId?: string;
  readonly inputHash?: string;
  readonly committedRevision?: number;
  readonly createdAt?: number;
}

export function makeIdentity(opts: ReceiptOpts = {}): ReceiptIdentity {
  return {
    app: opts.app ?? 'shop',
    owner: opts.owner ?? 'team-a',
    principal: opts.principal ?? 'user-1',
    operation: asOperation(opts.operation ?? 'shop.place'),
    operationId: asOperationId(opts.operationId ?? freshId('op')),
  };
}

export function makeReceipt(opts: ReceiptOpts = {}): Receipt {
  return {
    identity: makeIdentity(opts),
    inputHash: opts.inputHash ?? 'hash-1',
    resolvedDefaults: {},
    outcome: { status: 'committed', result: { ok: true }, recordVersions: [] },
    committedRevision: asRevision(opts.committedRevision ?? 1),
    createdAt: opts.createdAt ?? 1_700_000_000_100,
  };
}

export interface IntentOpts {
  readonly intentId?: string;
  readonly operation?: string;
  readonly operationId?: string;
  readonly target?: string;
  readonly occurrenceIndex?: number;
}

export function makeIntent(opts: IntentOpts = {}): OutboxIntent {
  return {
    intentId: opts.intentId ?? freshId('intent'),
    operation: asOperation(opts.operation ?? 'shop.place'),
    operationId: asOperationId(opts.operationId ?? 'op-1'),
    target: opts.target ?? 'mail.send',
    arguments: { to: 'a@example.com' },
    occurrenceIndex: opts.occurrenceIndex ?? 0,
  };
}

export interface HistoryOpts {
  readonly model?: string;
  readonly recordId?: string;
  readonly version?: number;
  readonly operation?: string;
  readonly operationId?: string;
  readonly actor?: string;
  readonly at?: number;
  readonly change?: HistoryEntry['change'];
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
}

export function makeHistory(opts: HistoryOpts = {}): HistoryEntry {
  return {
    model: asModel(opts.model ?? 'shop.Order'),
    recordId: asId(opts.recordId ?? 'ord-1'),
    version: asVersion(opts.version ?? 1),
    operation: asOperation(opts.operation ?? 'shop.place'),
    operationId: asOperationId(opts.operationId ?? 'op-1'),
    actor: opts.actor ?? 'user-1',
    at: opts.at ?? 1_700_000_000_100,
    change: opts.change ?? 'create',
    before: opts.before ?? null,
    after: opts.after ?? { total: 50 },
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

/**
 * Fixture data marker for the intended parent. S5 stores real linkage via
 * `StoredRow.parent` (parent_* columns); this helper keeps the data-level
 * marker for the NULL-linkage scoped-returns-empty subtest.
 */
export function parentLink(parentId: string): Record<string, unknown> {
  return { parent: parentId };
}

/** Unique-claim builders for the contract's UniqueClaim/UniqueRelease shapes. */
export function uniqueClaim(
  model: string,
  recordId: string,
  keyName: string,
  keyValue: string,
): UniqueClaim {
  return {
    model: asModel(model),
    keyName,
    keyValue,
    recordId: asId(recordId),
  };
}

export function uniqueRelease(model: string, keyName: string, keyValue: string): UniqueRelease {
  return { model: asModel(model), keyName, keyValue };
}

/* S7 migration fixture builders. */

export interface StagedRowOpts {
  readonly model?: string;
  readonly recordId?: string;
  readonly version?: number;
  readonly data?: Record<string, unknown>;
  readonly parent?: RecordParent | null;
  readonly converted?: boolean;
  readonly created?: number;
  readonly createdBy?: string;
  readonly archivedAt?: number | null;
}

export function makeStagedRow(opts: StagedRowOpts = {}): StagedRow {
  return {
    targetModel: asModel(opts.model ?? 'shop.Order'),
    recordId: asId(opts.recordId ?? freshId('staged')),
    version: asVersion(opts.version ?? 1),
    data: opts.data ?? { total: 50 },
    parent: opts.parent ?? null,
    converted: opts.converted ?? false,
    ...(opts.created === undefined ? {} : { created: opts.created }),
    ...(opts.createdBy === undefined ? {} : { createdBy: opts.createdBy }),
    ...(opts.archivedAt === undefined ? {} : { archivedAt: opts.archivedAt }),
  };
}

export interface ProgressOpts {
  readonly phase?: MigrationPhase;
  readonly stagedCursor?: StagedRowCursor | null;
  readonly publishCursor?: StagedRowCursor | null;
  readonly updatedRevision?: number;
}

export function makeProgress(migrationId: string, opts: ProgressOpts = {}): MigrationProgress {
  return {
    migrationId,
    phase: opts.phase ?? 'staging',
    stagedCursor: opts.stagedCursor ?? null,
    publishCursor: opts.publishCursor ?? null,
    updatedRevision: asRevision(opts.updatedRevision ?? 1),
  };
}

export interface SnapshotOpts {
  readonly snapshotId?: string;
  readonly digest?: string;
  readonly installedRevision?: number;
  readonly installedAt?: number;
}

export function makeSnapshot(owner: string, opts: SnapshotOpts = {}): InstalledSnapshot {
  return {
    owner,
    snapshotId: opts.snapshotId ?? 'snap-2',
    digest: opts.digest ?? 'digest-2',
    installedRevision: asRevision(opts.installedRevision ?? 1),
    installedAt: opts.installedAt ?? 1_700_000_000_500,
  };
}

export function makeOutcome(
  migrationId: string,
  intentId: string,
  handlerContract = 'shop.oldHandler',
): MigrationOutcome {
  return { migrationId, kind: 'invalidated', intentId, handlerContract };
}

export function makeDrop(model: string, recordId: string, history?: HistoryEntry): MigrationDrop {
  const dropHistory =
    history ?? makeHistory({ model, recordId, change: 'remove', before: { n: 1 }, after: null });
  return {
    model: asModel(model),
    recordId: asId(recordId),
    version: dropHistory.version,
    history: dropHistory,
  };
}

/**
 * Backend-specific read probe for staged state that StoragePort cannot
 * read (history/outbox/schedules). Backends that can query their own
 * storage supply one; the suite skips probe-only assertions when absent
 * and still checks everything observable through the port.
 */
export interface ScheduleEntry {
  readonly key: string;
  readonly at: number;
  readonly event: OperationName;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ConformanceProbe {
  historyFor(model: ModelName, recordId: RecordId): Promise<ReadonlyArray<HistoryEntry>>;
  outboxAll(): Promise<ReadonlyArray<OutboxIntent>>;
  scheduleGet(key: string): Promise<ScheduleEntry | null>;
}

export interface ConformanceSetup {
  readonly store: StoragePort;
  readonly reset: () => Promise<void>;
  readonly probe?: ConformanceProbe;
  /** New adapter handle over the same backend; no data reset. */
  readonly reopen?: () => Promise<StoragePort>;
}

/** Await a promise that must reject; fail the test if it resolves. */
export async function captureFailure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  assert.fail('expected commit to fail, but it succeeded');
}

export function expectFenceConflict(error: unknown, expected: number, actual: number): void {
  assert.ok(
    error instanceof FenceConflictError,
    `expected FenceConflictError, got ${String(error)}`,
  );
  assert.equal(error.expected, expected);
  assert.equal(error.actual, actual);
}

function query(
  model: string,
  opts: Partial<QuerySpec> & { readonly model?: never } = {},
): QuerySpec {
  return { model: asModel(model), authority: 'viewer', ...opts };
}

function ids(rows: ReadonlyArray<StoredRow>): ReadonlyArray<string> {
  return rows.map((row) => row.id as string);
}

export function storageConformance(
  name: string,
  setup: () => Promise<ConformanceSetup>,
): void {
  describe(`storage conformance (${name})`, () => {
    it('revision starts at 0 and advances exactly one per commit', async () => {
      const { store, reset } = await setup();
      await reset();
      assert.equal(await store.readRevision(), 0);
      const first = await store.commit(
        makeBatch(0, {
          writes: [{ kind: 'insert', model: asModel('t.N'), row: makeRow({ id: 'n-1' }) }],
        }),
      );
      assert.equal(first.revision, 1);
      assert.equal(await store.readRevision(), 1);
      const second = await store.commit(
        makeBatch(1, {
          writes: [{ kind: 'insert', model: asModel('t.N'), row: makeRow({ id: 'n-2' }) }],
        }),
      );
      assert.equal(second.revision, 2);
      assert.equal(await store.readRevision(), 2);
    });

    it('insert then load round-trips metadata and data; unknown rows load null', async () => {
      const { store, reset } = await setup();
      await reset();
      const row = makeRow({
        id: 'rich-1',
        version: 1,
        created: 1_700_000_000_010,
        updated: 1_700_000_000_020,
        createdBy: 'alice',
        updatedBy: 'bob',
        data: {
          name: 'Ada',
          score: 42,
          ratio: 1.5,
          active: true,
          nick: null,
          tags: ['x', 'y'],
          addr: { city: 'AMS', zip: 1011 },
        },
      });
      await store.commit(
        makeBatch(0, { writes: [{ kind: 'insert', model: asModel('t.User'), row }] }),
      );
      const loaded = await store.load(asModel('t.User'), asId('rich-1'));
      assert.ok(loaded !== null);
      assert.equal(loaded.id, 'rich-1');
      assert.equal(loaded.version, 1);
      assert.equal(loaded.created, 1_700_000_000_010);
      assert.equal(loaded.updated, 1_700_000_000_020);
      assert.equal(loaded.createdBy, 'alice');
      assert.equal(loaded.updatedBy, 'bob');
      assert.equal(loaded.archivedAt, null);
      assert.deepEqual(loaded.data, row.data);
      assert.equal(await store.load(asModel('t.User'), asId('missing')), null);
      assert.equal(await store.load(asModel('t.Other'), asId('rich-1')), null);
    });

    it('query isolates models', async () => {
      const { store, reset } = await setup();
      await reset();
      await store.commit(
        makeBatch(0, {
          writes: [
            { kind: 'insert', model: asModel('t.Team'), row: makeRow({ id: 'team-a' }) },
            { kind: 'insert', model: asModel('t.Team'), row: makeRow({ id: 'team-b' }) },
            { kind: 'insert', model: asModel('t.Task'), row: makeRow({ id: 'team-a' }) },
          ],
        }),
      );
      assert.deepEqual(ids(await store.query(query('t.Team'))), ['team-a', 'team-b']);
      assert.deepEqual(ids(await store.query(query('t.Task'))), ['team-a']);
    });

    it('query parent scope matches nothing when rows carry no linkage', async () => {
      const { store, reset } = await setup();
      await reset();
      await store.commit(
        makeBatch(0, {
          writes: [
            { kind: 'insert', model: asModel('t.Team'), row: makeRow({ id: 'team-a' }) },
            { kind: 'insert', model: asModel('t.Team'), row: makeRow({ id: 'team-b' }) },
            {
              kind: 'insert',
              model: asModel('t.Task'),
              row: makeRow({ id: 'task-1', data: { ...parentLink('team-a'), n: 1 } }),
            },
            {
              kind: 'insert',
              model: asModel('t.Task'),
              row: makeRow({ id: 'task-2', data: { ...parentLink('team-a'), n: 2 } }),
            },
            {
              kind: 'insert',
              model: asModel('t.Task'),
              row: makeRow({ id: 'task-3', data: { ...parentLink('team-b'), n: 3 } }),
            },
          ],
        }),
      );
      // Adapters filter on parent_model/parent_id: rows stored without
      // linkage (NULL) match no scope, while the unscoped query returns
      // everything. Positive parent/child scoping is covered by the S5
      // parent subtests below.
      const inA = await store.query(
        query('t.Task', { parent: { model: asModel('t.Team'), id: asId('team-a') } }),
      );
      assert.deepEqual(ids(inA), []);
      const unscoped = await store.query(query('t.Task'));
      assert.deepEqual(ids(unscoped), ['task-1', 'task-2', 'task-3']);
    });

    it('query where supports eq/and/or/not/between/is_null', async () => {
      const { store, reset } = await setup();
      await reset();
      await store.commit(
        makeBatch(0, {
          writes: [
            {
              kind: 'insert',
              model: asModel('t.Task'),
              row: makeRow({
                id: 'task-1',
                created: 1_700_000_000_001,
                data: { status: 'open', score: 10, tag: 'x' },
              }),
            },
            {
              kind: 'insert',
              model: asModel('t.Task'),
              row: makeRow({
                id: 'task-2',
                created: 1_700_000_000_002,
                data: { status: 'done', score: 20 },
              }),
            },
            {
              kind: 'insert',
              model: asModel('t.Task'),
              row: makeRow({
                id: 'task-3',
                created: 1_700_000_000_003,
                data: { status: 'open', score: 30, tag: 'y' },
              }),
            },
          ],
        }),
      );
      const run = async (where: QuerySpec['where']): Promise<ReadonlyArray<string>> =>
        ids(await store.query(query('t.Task', where === undefined ? {} : { where })));
      assert.deepEqual(await run({ op: 'eq', field: 'status', value: 'open' }), [
        'task-1',
        'task-3',
      ]);
      assert.deepEqual(
        await run({
          op: 'and',
          args: [
            { op: 'eq', field: 'status', value: 'open' },
            { op: 'gt', field: 'score', value: 15 },
          ],
        }),
        ['task-3'],
      );
      assert.deepEqual(
        await run({
          op: 'or',
          args: [
            { op: 'eq', field: 'status', value: 'done' },
            { op: 'eq', field: 'score', value: 10 },
          ],
        }),
        ['task-1', 'task-2'],
      );
      assert.deepEqual(
        await run({ op: 'not', arg: { op: 'eq', field: 'status', value: 'open' } }),
        ['task-2'],
      );
      assert.deepEqual(await run({ op: 'between', field: 'score', lo: 15, hi: 25 }), ['task-2']);
      assert.deepEqual(await run({ op: 'is_null', field: 'tag' }), ['task-2']);
      assert.deepEqual(await run({ op: 'ne', field: 'status', value: 'open' }), ['task-2']);
      assert.deepEqual(await run({ op: 'gte', field: 'score', value: 20 }), ['task-2', 'task-3']);
      assert.deepEqual(await run({ op: 'lt', field: 'score', value: 20 }), ['task-1']);
    });

    it('query honors explicit order with id tie-break, default order, and exact limit', async () => {
      const { store, reset } = await setup();
      await reset();
      await store.commit(
        makeBatch(0, {
          writes: [
            {
              kind: 'insert',
              model: asModel('t.Item'),
              row: makeRow({ id: 'item-c', created: 3_000, data: { score: 5 } }),
            },
            {
              kind: 'insert',
              model: asModel('t.Item'),
              row: makeRow({ id: 'item-a', created: 1_000, data: { score: 10 } }),
            },
            {
              kind: 'insert',
              model: asModel('t.Item'),
              row: makeRow({ id: 'item-b', created: 2_000, data: { score: 10 } }),
            },
          ],
        }),
      );
      assert.deepEqual(ids(await store.query(query('t.Item'))), ['item-a', 'item-b', 'item-c']);
      assert.deepEqual(
        ids(
          await store.query(
            query('t.Item', { order: [{ field: 'score', direction: 'asc' }] }),
          ),
        ),
        ['item-c', 'item-a', 'item-b'],
      );
      assert.deepEqual(
        ids(
          await store.query(
            query('t.Item', { order: [{ field: 'score', direction: 'desc' }] }),
          ),
        ),
        ['item-a', 'item-b', 'item-c'],
      );
      assert.deepEqual(ids(await store.query(query('t.Item', { limit: 2 }))), [
        'item-a',
        'item-b',
      ]);
      assert.deepEqual(ids(await store.query(query('t.Item', { limit: 1 }))), ['item-a']);
    });

    it('query excludes archived rows by default and includes them on request', async () => {
      const { store, reset } = await setup();
      await reset();
      await store.commit(
        makeBatch(0, {
          writes: [
            {
              kind: 'insert',
              model: asModel('t.Item'),
              row: makeRow({ id: 'item-1', created: 1_000 }),
            },
            {
              kind: 'insert',
              model: asModel('t.Item'),
              row: makeRow({ id: 'item-2', created: 2_000 }),
            },
          ],
        }),
      );
      const archived = makeRow({ id: 'item-2', version: 2, created: 2_000, archivedAt: 9_000 });
      await store.commit(
        makeBatch(1, {
          writes: [
            {
              kind: 'update',
              model: asModel('t.Item'),
              id: asId('item-2'),
              expectedVersion: asVersion(1),
              row: archived,
            },
          ],
        }),
      );
      assert.deepEqual(ids(await store.query(query('t.Item'))), ['item-1']);
      assert.deepEqual(ids(await store.query(query('t.Item', { archived: 'include' }))), [
        'item-1',
        'item-2',
      ]);
      const loaded = await store.load(asModel('t.Item'), asId('item-2'));
      assert.ok(loaded !== null);
      assert.equal(loaded.archivedAt, 9_000);
    });

    it('commit persists history, receipt, outbox intents and schedules atomically', async () => {
      const { store, reset, probe } = await setup();
      await reset();
      const receipt = makeReceipt({ operationId: 'op-stage-1', committedRevision: 1 });
      const intent = makeIntent({ intentId: 'intent-1', operationId: 'op-stage-1' });
      const entry = makeHistory({
        model: 'shop.Order',
        recordId: 'ord-1',
        version: 1,
        operationId: 'op-stage-1',
      });
      const result = await store.commit(
        makeBatch(0, {
          writes: [
            {
              kind: 'insert',
              model: asModel('shop.Order'),
              row: makeRow({ id: 'ord-1', data: { total: 50 } }),
            },
          ],
          history: [entry],
          receipt,
          outbox: [intent],
          schedules: [
            {
              op: 'replace',
              key: 'pickup-1',
              at: 1_700_000_010_000,
              event: asOperation('shop.pickupDue'),
              payload: { order: 'ord-1' },
            },
          ],
        }),
      );
      assert.equal(result.revision, 1);
      assert.deepEqual(await store.readReceipt(receipt.identity), receipt);
      assert.equal(await store.readReceipt(makeIdentity({ operationId: 'op-unknown' })), null);
      if (probe !== undefined) {
        assert.deepEqual(await probe.historyFor(asModel('shop.Order'), asId('ord-1')), [entry]);
        assert.deepEqual(await probe.outboxAll(), [intent]);
        assert.deepEqual(await probe.scheduleGet('pickup-1'), {
          key: 'pickup-1',
          at: 1_700_000_010_000,
          event: 'shop.pickupDue',
          payload: { order: 'ord-1' },
        });
      }
      const cancelled = await store.commit(
        makeBatch(1, { schedules: [{ op: 'cancel', key: 'pickup-1' }] }),
      );
      assert.equal(cancelled.revision, 2);
      if (probe !== undefined) {
        assert.equal(await probe.scheduleGet('pickup-1'), null);
      }
    });

    it('update changes data and version; remove deletes the row', async () => {
      const { store, reset } = await setup();
      await reset();
      await store.commit(
        makeBatch(0, {
          writes: [
            {
              kind: 'insert',
              model: asModel('t.Doc'),
              row: makeRow({ id: 'doc-1', data: { n: 1 } }),
            },
          ],
        }),
      );
      const staleUpdate = await captureFailure(
        store.commit(
          makeBatch(1, {
            writes: [
              {
                kind: 'update',
                model: asModel('t.Doc'),
                id: asId('doc-1'),
                expectedVersion: asVersion(99),
                row: makeRow({ id: 'doc-1', version: 100, data: { n: 2 } }),
              },
            ],
          }),
        ),
      );
      assert.ok(
        staleUpdate instanceof StorageConstraintError && staleUpdate.kind === 'version',
        `expected StorageConstraintError kind 'version', got ${String(staleUpdate)}`,
      );
      assert.equal(await store.readRevision(), 1);
      assert.deepEqual((await store.load(asModel('t.Doc'), asId('doc-1')))?.data, { n: 1 });
      const missingUpdate = await captureFailure(
        store.commit(
          makeBatch(1, {
            writes: [
              {
                kind: 'update',
                model: asModel('t.Doc'),
                id: asId('doc-missing'),
                expectedVersion: asVersion(1),
                row: makeRow({ id: 'doc-missing', version: 2, data: { n: 2 } }),
              },
            ],
          }),
        ),
      );
      assert.ok(
        missingUpdate instanceof StorageConstraintError && missingUpdate.kind === 'version',
        `expected StorageConstraintError kind 'version', got ${String(missingUpdate)}`,
      );
      assert.equal(await store.readRevision(), 1);
      await store.commit(
        makeBatch(1, {
          writes: [
            {
              kind: 'update',
              model: asModel('t.Doc'),
              id: asId('doc-1'),
              expectedVersion: asVersion(1),
              row: makeRow({ id: 'doc-1', version: 2, data: { n: 2 } }),
            },
          ],
        }),
      );
      const updated = await store.load(asModel('t.Doc'), asId('doc-1'));
      assert.ok(updated !== null);
      assert.equal(updated.version, 2);
      assert.deepEqual(updated.data, { n: 2 });
      const staleRemove = await captureFailure(
        store.commit(
          makeBatch(2, {
            writes: [
              {
                kind: 'remove',
                model: asModel('t.Doc'),
                id: asId('doc-1'),
                expectedVersion: asVersion(1),
              },
            ],
          }),
        ),
      );
      assert.ok(
        staleRemove instanceof StorageConstraintError && staleRemove.kind === 'version',
        `expected StorageConstraintError kind 'version', got ${String(staleRemove)}`,
      );
      assert.equal(await store.readRevision(), 2);
      assert.ok((await store.load(asModel('t.Doc'), asId('doc-1'))) !== null);
      await store.commit(
        makeBatch(2, {
          writes: [
            {
              kind: 'remove',
              model: asModel('t.Doc'),
              id: asId('doc-1'),
              expectedVersion: asVersion(2),
            },
          ],
        }),
      );
      assert.equal(await store.load(asModel('t.Doc'), asId('doc-1')), null);
      assert.deepEqual(ids(await store.query(query('t.Doc'))), []);
    });

    it('a second unique claim for a different record fails and persists nothing', async () => {
      const { store, reset, probe } = await setup();
      await reset();
      await store.commit(
        makeBatch(0, {
          writes: [
            {
              kind: 'insert',
              model: asModel('t.User'),
              row: makeRow({ id: 'uni-a', data: { email: 'a@example.com' } }),
            },
          ],
          receipt: makeReceipt({ operationId: 'op-uni-1', committedRevision: 1 }),
          uniqueClaims: [uniqueClaim('t.User', 'uni-a', 'email', 'a@example.com')],
        }),
      );
      assert.equal(await store.readRevision(), 1);
      const failedReceipt = makeReceipt({ operationId: 'op-uni-2', committedRevision: 2 });
      const failedIntent = makeIntent({ intentId: 'intent-uni-2', operationId: 'op-uni-2' });
      const failed = await captureFailure(
        store.commit(
          makeBatch(1, {
            writes: [
              {
                kind: 'insert',
                model: asModel('t.User'),
                row: makeRow({ id: 'uni-b', data: { email: 'a@example.com' } }),
              },
            ],
            history: [
              makeHistory({ model: 't.User', recordId: 'uni-b', operationId: 'op-uni-2' }),
            ],
            receipt: failedReceipt,
            outbox: [failedIntent],
            schedules: [
              {
                op: 'replace',
                key: 'uni-key-2',
                at: 1_700_000_010_000,
                event: asOperation('t.due'),
                payload: {},
              },
            ],
            uniqueClaims: [uniqueClaim('t.User', 'uni-b', 'email', 'a@example.com')],
          }),
        ),
      );
      assert.ok(
        failed instanceof StorageConstraintError && failed.kind === 'unique',
        `expected StorageConstraintError kind 'unique', got ${String(failed)}`,
      );
      assert.equal(await store.readRevision(), 1);
      assert.equal(await store.load(asModel('t.User'), asId('uni-b')), null);
      assert.equal(await store.readReceipt(failedReceipt.identity), null);
      assert.ok((await store.load(asModel('t.User'), asId('uni-a'))) !== null);
      if (probe !== undefined) {
        assert.deepEqual(await probe.historyFor(asModel('t.User'), asId('uni-b')), []);
        assert.deepEqual(await probe.outboxAll(), []);
        assert.equal(await probe.scheduleGet('uni-key-2'), null);
      }
      // A release in the same batch frees the key for a different record.
      await store.commit(
        makeBatch(1, {
          writes: [
            {
              kind: 'insert',
              model: asModel('t.User'),
              row: makeRow({ id: 'uni-c', data: { email: 'a@example.com' } }),
            },
          ],
          uniqueReleases: [uniqueRelease('t.User', 'email', 'a@example.com')],
          uniqueClaims: [uniqueClaim('t.User', 'uni-c', 'email', 'a@example.com')],
        }),
      );
      assert.equal(await store.readRevision(), 2);
      assert.ok((await store.load(asModel('t.User'), asId('uni-c'))) !== null);
      const reclaimed = await captureFailure(
        store.commit(
          makeBatch(2, {
            writes: [
              {
                kind: 'insert',
                model: asModel('t.User'),
                row: makeRow({ id: 'uni-d', data: { email: 'a@example.com' } }),
              },
            ],
            uniqueClaims: [uniqueClaim('t.User', 'uni-d', 'email', 'a@example.com')],
          }),
        ),
      );
      assert.ok(
        reclaimed instanceof StorageConstraintError && reclaimed.kind === 'unique',
        `expected StorageConstraintError kind 'unique', got ${String(reclaimed)}`,
      );
      assert.equal(await store.readRevision(), 2);
    });

    it('inserting over a stored record fails atomically', async () => {
      const { store, reset } = await setup();
      await reset();
      await store.commit(
        makeBatch(0, {
          writes: [
            {
              kind: 'insert',
              model: asModel('t.Doc'),
              row: makeRow({ id: 'dup-1', data: { n: 1 } }),
            },
          ],
        }),
      );
      const againstStored = await captureFailure(
        store.commit(
          makeBatch(1, {
            writes: [
              {
                kind: 'insert',
                model: asModel('t.Doc'),
                row: makeRow({ id: 'dup-1', data: { n: 9 } }),
              },
            ],
            receipt: makeReceipt({ operationId: 'op-dup-1', committedRevision: 2 }),
          }),
        ),
      );
      assert.ok(
        againstStored instanceof StorageConstraintError,
        `expected StorageConstraintError, got ${String(againstStored)}`,
      );
      assert.equal(await store.readRevision(), 1);
      assert.deepEqual((await store.load(asModel('t.Doc'), asId('dup-1')))?.data, { n: 1 });
      assert.equal(
        await store.readReceipt(makeIdentity({ operationId: 'op-dup-1' })),
        null,
      );
    });

    it('receipt identity reuse fails atomically', async () => {
      const { store, reset } = await setup();
      await reset();
      const receipt = makeReceipt({ operationId: 'op-reuse-1', committedRevision: 1 });
      await store.commit(
        makeBatch(0, {
          writes: [
            {
              kind: 'insert',
              model: asModel('t.Doc'),
              row: makeRow({ id: 'reuse-a', data: { n: 1 } }),
            },
          ],
          receipt,
        }),
      );
      const reused = await captureFailure(
        store.commit(
          makeBatch(1, {
            writes: [
              {
                kind: 'insert',
                model: asModel('t.Doc'),
                row: makeRow({ id: 'reuse-b', data: { n: 2 } }),
              },
            ],
            receipt,
          }),
        ),
      );
      assert.ok(
        reused instanceof StorageConstraintError && reused.kind === 'receipt_reuse',
        `expected StorageConstraintError kind 'receipt_reuse', got ${String(reused)}`,
      );
      assert.equal(await store.readRevision(), 1);
      assert.equal(await store.load(asModel('t.Doc'), asId('reuse-b')), null);
      assert.deepEqual(await store.readReceipt(receipt.identity), receipt);
    });

    it('stale fence commits fail with expected/actual and persist nothing', async () => {
      const { store, reset, probe } = await setup();
      await reset();
      const base = await store.readRevision();
      assert.equal(base, 0);
      const winnerReceipt = makeReceipt({ operationId: 'op-fence-1', committedRevision: 1 });
      const winnerIntent = makeIntent({ intentId: 'intent-fence-1', operationId: 'op-fence-1' });
      await store.commit(
        makeBatch(base as number, {
          writes: [
            {
              kind: 'insert',
              model: asModel('t.Doc'),
              row: makeRow({ id: 'fence-a', data: { n: 1 } }),
            },
          ],
          history: [makeHistory({ model: 't.Doc', recordId: 'fence-a' })],
          receipt: winnerReceipt,
          outbox: [winnerIntent],
          schedules: [
            {
              op: 'replace',
              key: 'fence-key-1',
              at: 1_700_000_010_000,
              event: asOperation('t.due'),
              payload: { n: 1 },
            },
          ],
        }),
      );
      assert.equal(await store.readRevision(), 1);
      const loserReceipt = makeReceipt({ operationId: 'op-fence-2', committedRevision: 1 });
      const loserIntent = makeIntent({ intentId: 'intent-fence-2', operationId: 'op-fence-2' });
      const loser = await captureFailure(
        store.commit(
          makeBatch(base as number, {
            writes: [
              {
                kind: 'insert',
                model: asModel('t.Doc'),
                row: makeRow({ id: 'fence-b', data: { n: 2 } }),
              },
            ],
            history: [makeHistory({ model: 't.Doc', recordId: 'fence-b' })],
            receipt: loserReceipt,
            outbox: [loserIntent],
            schedules: [
              {
                op: 'replace',
                key: 'fence-key-2',
                at: 1_700_000_010_000,
                event: asOperation('t.due'),
                payload: { n: 2 },
              },
            ],
          }),
        ),
      );
      expectFenceConflict(loser, 0, 1);
      assert.equal(await store.readRevision(), 1);
      assert.equal(await store.load(asModel('t.Doc'), asId('fence-b')), null);
      assert.equal(await store.readReceipt(loserReceipt.identity), null);
      assert.ok((await store.load(asModel('t.Doc'), asId('fence-a'))) !== null);
      assert.deepEqual(await store.readReceipt(winnerReceipt.identity), winnerReceipt);
      if (probe !== undefined) {
        assert.deepEqual(await probe.historyFor(asModel('t.Doc'), asId('fence-b')), []);
        assert.deepEqual(
          (await probe.outboxAll()).map((intent) => intent.intentId),
          ['intent-fence-1'],
        );
        assert.ok((await probe.scheduleGet('fence-key-1')) !== null);
        assert.equal(await probe.scheduleGet('fence-key-2'), null);
      }
    });

    it('a future expected revision fails without applying anything', async () => {
      // The fence INSERT proves `expected + 1` is fresh; it cannot see a
      // future `expected` skipping ahead, so adapters reject those up front.
      // Accepting one would break revision density and let later stale
      // commits move the fence backward.
      const { store, reset } = await setup();
      await reset();
      const failed = await captureFailure(
        store.commit(
          makeBatch(5, {
            writes: [
              {
                kind: 'insert',
                model: asModel('t.Doc'),
                row: makeRow({ id: 'future-1', data: { n: 1 } }),
              },
            ],
          }),
        ),
      );
      expectFenceConflict(failed, 5, 0);
      assert.equal(await store.readRevision(), 0);
      assert.equal(await store.load(asModel('t.Doc'), asId('future-1')), null);
      // The store still accepts the honest next revision afterwards.
      await store.commit(
        makeBatch(0, {
          writes: [
            {
              kind: 'insert',
              model: asModel('t.Doc'),
              row: makeRow({ id: 'future-1', data: { n: 1 } }),
            },
          ],
        }),
      );
      assert.equal(await store.readRevision(), 1);
    });

    it('same-batch multi-touch writes apply in order with SQL semantics', async () => {
      const { store, reset } = await setup();
      await reset();
      await store.commit(
        makeBatch(0, {
          writes: [
            {
              kind: 'insert',
              model: asModel('t.Doc'),
              row: makeRow({ id: 'mt-1', data: { n: 1 } }),
            },
            {
              kind: 'insert',
              model: asModel('t.Doc'),
              row: makeRow({ id: 'mt-2', data: { n: 1 } }),
            },
            {
              kind: 'insert',
              model: asModel('t.Doc'),
              row: makeRow({ id: 'mt-3', data: { n: 1 } }),
            },
            {
              kind: 'insert',
              model: asModel('t.Doc'),
              row: makeRow({ id: 'mt-4', data: { n: 1 } }),
            },
          ],
        }),
      );
      // remove+insert resurrects with the new row; update+remove leaves the
      // row absent; update+update applies in order with the last write
      // winning. (insert+remove of a brand-new row is unrepresentable: every
      // remove/update carries an expectedVersion validated against
      // pre-batch state, so removes always reference pre-existing rows.)
      await store.commit(
        makeBatch(1, {
          writes: [
            { kind: 'remove', model: asModel('t.Doc'), id: asId('mt-1'), expectedVersion: asVersion(1) },
            {
              kind: 'insert',
              model: asModel('t.Doc'),
              row: makeRow({ id: 'mt-1', version: 1, data: { n: 2 } }),
            },
            {
              kind: 'update',
              model: asModel('t.Doc'),
              id: asId('mt-2'),
              expectedVersion: asVersion(1),
              row: makeRow({ id: 'mt-2', version: 2, data: { n: 2 } }),
            },
            {
              kind: 'update',
              model: asModel('t.Doc'),
              id: asId('mt-2'),
              expectedVersion: asVersion(1),
              row: makeRow({ id: 'mt-2', version: 3, data: { n: 3 } }),
            },
            { kind: 'remove', model: asModel('t.Doc'), id: asId('mt-2'), expectedVersion: asVersion(1) },
            {
              kind: 'update',
              model: asModel('t.Doc'),
              id: asId('mt-4'),
              expectedVersion: asVersion(1),
              row: makeRow({ id: 'mt-4', version: 2, data: { n: 2 } }),
            },
            {
              kind: 'update',
              model: asModel('t.Doc'),
              id: asId('mt-4'),
              expectedVersion: asVersion(1),
              row: makeRow({ id: 'mt-4', version: 3, data: { n: 3 } }),
            },
          ],
        }),
      );
      assert.deepEqual((await store.load(asModel('t.Doc'), asId('mt-1')))?.data, { n: 2 });
      assert.equal(await store.load(asModel('t.Doc'), asId('mt-2')), null);
      const mt4 = await store.load(asModel('t.Doc'), asId('mt-4'));
      assert.ok(mt4 !== null);
      assert.equal(mt4.version, 3);
      assert.deepEqual(mt4.data, { n: 3 });
      // remove+update: the update's version pre-check passes against
      // pre-batch state, but the row was removed earlier in the same batch,
      // so SQL's UPDATE hits 0 rows and the row stays absent.
      await store.commit(
        makeBatch(2, {
          writes: [
            { kind: 'remove', model: asModel('t.Doc'), id: asId('mt-3'), expectedVersion: asVersion(1) },
            {
              kind: 'update',
              model: asModel('t.Doc'),
              id: asId('mt-3'),
              expectedVersion: asVersion(1),
              row: makeRow({ id: 'mt-3', version: 2, data: { n: 2 } }),
            },
          ],
        }),
      );
      assert.equal(await store.load(asModel('t.Doc'), asId('mt-3')), null);
      assert.equal(await store.readRevision(), 3);
    });

    it('same-batch duplicate inserts fail and persist nothing', async () => {
      const { store, reset, probe } = await setup();
      await reset();
      const failed = await captureFailure(
        store.commit(
          makeBatch(0, {
            writes: [
              {
                kind: 'insert',
                model: asModel('t.Doc'),
                row: makeRow({ id: 'dup-2', data: { n: 1 } }),
              },
              {
                kind: 'insert',
                model: asModel('t.Doc'),
                row: makeRow({ id: 'dup-2', data: { n: 2 } }),
              },
            ],
            history: [makeHistory({ model: 't.Doc', recordId: 'dup-2' })],
            receipt: makeReceipt({ operationId: 'op-dup-2', committedRevision: 1 }),
          }),
        ),
      );
      assert.ok(
        failed instanceof StorageConstraintError,
        `expected StorageConstraintError, got ${String(failed)}`,
      );
      assert.equal(await store.readRevision(), 0);
      assert.equal(await store.load(asModel('t.Doc'), asId('dup-2')), null);
      assert.equal(
        await store.readReceipt(makeIdentity({ operationId: 'op-dup-2' })),
        null,
      );
      if (probe !== undefined) {
        assert.deepEqual(await probe.historyFor(asModel('t.Doc'), asId('dup-2')), []);
      }
    });

    it('same-batch duplicate outbox intents fail and persist nothing', async () => {
      const { store, reset, probe } = await setup();
      await reset();
      const failed = await captureFailure(
        store.commit(
          makeBatch(0, {
            writes: [
              {
                kind: 'insert',
                model: asModel('t.Doc'),
                row: makeRow({ id: 'ob-1', data: { n: 1 } }),
              },
            ],
            outbox: [
              makeIntent({ intentId: 'intent-dup-1', operationId: 'op-ob-1' }),
              makeIntent({ intentId: 'intent-dup-1', operationId: 'op-ob-1' }),
            ],
          }),
        ),
      );
      assert.ok(
        failed instanceof StorageConstraintError,
        `expected StorageConstraintError, got ${String(failed)}`,
      );
      // S6: duplicate intent ids are `unique` on every backend (D1/DO match the
      // outbox table name in the SQLite UNIQUE message), mapping to `conflict`.
      assert.equal(failed.kind, 'unique');
      assert.equal(await store.readRevision(), 0);
      assert.equal(await store.load(asModel('t.Doc'), asId('ob-1')), null);
      if (probe !== undefined) {
        assert.deepEqual(await probe.outboxAll(), []);
      }
    });

    it('query where supports boolean predicates and null between bounds', async () => {
      const { store, reset } = await setup();
      await reset();
      await store.commit(
        makeBatch(0, {
          writes: [
            {
              kind: 'insert',
              model: asModel('t.Task'),
              row: makeRow({
                id: 'bool-1',
                created: 1_700_000_000_001,
                data: { done: true, score: 10 },
              }),
            },
            {
              kind: 'insert',
              model: asModel('t.Task'),
              row: makeRow({
                id: 'bool-2',
                created: 1_700_000_000_002,
                data: { done: false, score: 30 },
              }),
            },
            {
              kind: 'insert',
              model: asModel('t.Task'),
              row: makeRow({
                id: 'bool-3',
                created: 1_700_000_000_003,
                data: { score: 50 },
              }),
            },
          ],
        }),
      );
      const run = async (where: QuerySpec['where']): Promise<ReadonlyArray<string>> =>
        ids(await store.query(query('t.Task', where === undefined ? {} : { where })));
      assert.deepEqual(await run({ op: 'eq', field: 'done', value: true }), ['bool-1']);
      assert.deepEqual(await run({ op: 'eq', field: 'done', value: false }), ['bool-2']);
      assert.deepEqual(await run({ op: 'ne', field: 'done', value: true }), ['bool-2']);
      assert.deepEqual(await run({ op: 'is_null', field: 'done' }), ['bool-3']);
      // A NULL between bound never matches: (x >= NULL) is NULL, and
      // NULL AND TRUE is NULL. But NOT BETWEEN with a NULL bound matches
      // rows where the other side is FALSE (FALSE AND NULL is FALSE).
      assert.deepEqual(await run({ op: 'between', field: 'score', lo: null, hi: 25 }), []);
      assert.deepEqual(
        await run({ op: 'not', arg: { op: 'between', field: 'score', lo: null, hi: 25 } }),
        ['bool-2', 'bool-3'],
      );
    });

    it('insert with parent persists linkage; load shows parent', async () => {
      const { store, reset } = await setup();
      await reset();
      await store.commit(
        makeBatch(0, {
          writes: [
            { kind: 'insert', model: asModel('t.Team'), row: makeRow({ id: 'team-a' }) },
            {
              kind: 'insert',
              model: asModel('t.Task'),
              row: {
                ...makeRow({ id: 'task-1', data: { n: 1 } }),
                parent: { model: asModel('t.Team'), id: asId('team-a') },
              },
            },
          ],
        }),
      );
      const loaded = await store.load(asModel('t.Task'), asId('task-1'));
      assert.ok(loaded !== null);
      assert.deepEqual(loaded.parent ?? null, { model: 't.Team', id: 'team-a' });
      // The parent row itself carries no linkage.
      const parent = await store.load(asModel('t.Team'), asId('team-a'));
      assert.ok(parent !== null);
      assert.equal(parent.parent ?? null, null);
    });

    it('parent-scoped query matches only children of the scoped parent', async () => {
      const { store, reset } = await setup();
      await reset();
      const childOf = (team: string): { model: ModelName; id: RecordId } => ({
        model: asModel('t.Team'),
        id: asId(team),
      });
      await store.commit(
        makeBatch(0, {
          writes: [
            { kind: 'insert', model: asModel('t.Team'), row: makeRow({ id: 'team-a' }) },
            { kind: 'insert', model: asModel('t.Team'), row: makeRow({ id: 'team-b' }) },
            {
              kind: 'insert',
              model: asModel('t.Task'),
              row: { ...makeRow({ id: 'task-1' }), parent: childOf('team-a') },
            },
            {
              kind: 'insert',
              model: asModel('t.Task'),
              row: { ...makeRow({ id: 'task-2' }), parent: childOf('team-a') },
            },
            {
              kind: 'insert',
              model: asModel('t.Task'),
              row: { ...makeRow({ id: 'task-3' }), parent: childOf('team-b') },
            },
            { kind: 'insert', model: asModel('t.Task'), row: makeRow({ id: 'task-4' }) },
          ],
        }),
      );
      const inA = await store.query(
        query('t.Task', { parent: { model: asModel('t.Team'), id: asId('team-a') } }),
      );
      assert.deepEqual(ids(inA), ['task-1', 'task-2']);
      // Scoped rows carry their linkage (strict: every backend reads an
      // explicit object here, never undefined).
      assert.deepEqual(
        inA.map((row) => row.parent),
        [childOf('team-a'), childOf('team-a')],
      );
      const inB = await store.query(
        query('t.Task', { parent: { model: asModel('t.Team'), id: asId('team-b') } }),
      );
      assert.deepEqual(ids(inB), ['task-3']);
      // NULL-parent rows never match a scope; the unscoped query sees all four.
      const unscoped = await store.query(query('t.Task'));
      assert.deepEqual(ids(unscoped), ['task-1', 'task-2', 'task-3', 'task-4']);
      // Parentless rows read back explicit null on every backend (strict:
      // memory normalizes on write; SQL reads NULL as null).
      assert.equal(unscoped.find((row) => row.id === 'task-4')?.parent, null);
    });

    it('update carries parent; rows without parent read back null', async () => {
      const { store, reset } = await setup();
      await reset();
      await store.commit(
        makeBatch(0, {
          writes: [
            { kind: 'insert', model: asModel('t.Team'), row: makeRow({ id: 'team-a' }) },
            { kind: 'insert', model: asModel('t.Team'), row: makeRow({ id: 'team-b' }) },
            {
              kind: 'insert',
              model: asModel('t.Task'),
              row: {
                ...makeRow({ id: 'task-1', data: { n: 1 } }),
                parent: { model: asModel('t.Team'), id: asId('team-a') },
              },
            },
            {
              kind: 'insert',
              model: asModel('t.Task'),
              row: makeRow({ id: 'task-2', data: { n: 1 } }),
            },
          ],
        }),
      );
      // `makeRow` leaves `parent` undefined; every backend reads that as null.
      assert.equal(
        (await store.load(asModel('t.Task'), asId('task-2')))?.parent ?? null,
        null,
      );
      await store.commit(
        makeBatch(1, {
          writes: [
            {
              kind: 'update',
              model: asModel('t.Task'),
              id: asId('task-1'),
              expectedVersion: asVersion(1),
              row: {
                ...makeRow({ id: 'task-1', version: 2, data: { n: 2 } }),
                parent: { model: asModel('t.Team'), id: asId('team-a') },
              },
            },
            {
              kind: 'update',
              model: asModel('t.Task'),
              id: asId('task-2'),
              expectedVersion: asVersion(1),
              row: makeRow({ id: 'task-2', version: 2, data: { n: 2 } }),
            },
          ],
        }),
      );
      const carried = await store.load(asModel('t.Task'), asId('task-1'));
      assert.ok(carried !== null);
      assert.equal(carried.version, 2);
      assert.deepEqual(carried.data, { n: 2 });
      assert.deepEqual(carried.parent ?? null, { model: 't.Team', id: 'team-a' });
      // The storage layer persists whatever parent the row carries (the
      // mutation engine keeps it immutable by carrying `before.parent`).
      await store.commit(
        makeBatch(2, {
          writes: [
            {
              kind: 'update',
              model: asModel('t.Task'),
              id: asId('task-1'),
              expectedVersion: asVersion(2),
              row: {
                ...makeRow({ id: 'task-1', version: 3, data: { n: 3 } }),
                parent: { model: asModel('t.Team'), id: asId('team-b') },
              },
            },
          ],
        }),
      );
      assert.deepEqual((await store.load(asModel('t.Task'), asId('task-1')))?.parent ?? null, {
        model: 't.Team',
        id: 'team-b',
      });
      assert.equal(
        (await store.load(asModel('t.Task'), asId('task-2')))?.parent ?? null,
        null,
      );
    });

    it('outbox ack removes the intent from pending; unknown and repeated acks are a no-op', async () => {
      const { store, reset } = await setup();
      await reset();
      await store.commit(
        makeBatch(0, {
          outbox: [
            makeIntent({ intentId: 'ack-a', operationId: 'op-ack' }),
            makeIntent({ intentId: 'ack-b', operationId: 'op-ack' }),
          ],
        }),
      );
      assert.deepEqual(
        (await store.outboxPending()).map((intent) => intent.intentId),
        ['ack-a', 'ack-b'],
      );
      const acked = await store.commit({ ...makeBatch(1), outboxAck: ['ack-a'] });
      assert.equal(acked.revision, 2);
      assert.deepEqual(
        (await store.outboxPending()).map((intent) => intent.intentId),
        ['ack-b'],
      );
      // Unknown ids and already-dispatched ids are an idempotent no-op.
      const noop = await store.commit({
        ...makeBatch(2),
        outboxAck: ['ack-unknown', 'ack-a'],
      });
      assert.equal(noop.revision, 3);
      assert.deepEqual(
        (await store.outboxPending()).map((intent) => intent.intentId),
        ['ack-b'],
      );
    });

    it('outboxGet retains the exact original carrier before and after ack and adapter reopen', async () => {
      const { store, reset, reopen } = await setup();
      await reset();
      const intent = {
        ...makeIntent({ intentId: 'retained-exact', operationId: 'op-retained', occurrenceIndex: 3 }),
        dispatchGuard: 'allowed',
        handlerContract: 'shop.original-handler',
        arguments: { principal: { userId: 'original-user' }, payload: { values: [1, 2] } },
      };
      const original = structuredClone(intent);
      const sibling = makeIntent({ intentId: 'retained-sibling', operationId: 'op-retained' });
      assert.equal(await store.outboxGet(intent.intentId), null);
      await store.commit(makeBatch(0, { outbox: [intent, sibling] }));
      // Input aliases cannot alter the committed original carrier.
      intent.arguments.principal.userId = 'changed-input';
      intent.arguments.payload.values.push(9);
      assert.deepEqual(await store.outboxGet(original.intentId), { intent: original, status: 'pending' });
      assert.equal(await store.outboxGet("retained-exact' OR 1=1 --"), null);
      assert.equal(await store.outboxGet('retained-unknown'), null);
      const read = await store.outboxGet(original.intentId);
      assert.ok(read !== null);
      const mutable = read as unknown as { intent: typeof intent; status: string };
      mutable.intent.arguments.principal.userId = 'changed-output';
      mutable.intent.arguments.payload.values.push(8);
      mutable.intent.target = 'changed-target';
      mutable.status = 'skipped';
      assert.deepEqual(await store.outboxGet(original.intentId), { intent: original, status: 'pending' });
      await store.commit({ ...makeBatch(1), outboxAck: [original.intentId] });
      assert.deepEqual(await store.outboxGet(original.intentId), { intent: original, status: 'dispatched' });
      assert.deepEqual(await store.outboxGet(sibling.intentId), { intent: sibling, status: 'pending' });
      assert.deepEqual(await store.outboxPending(), [sibling]);
      const retained = await store.outboxGet(original.intentId);
      assert.ok(retained !== null);
      (retained.intent.arguments as typeof intent.arguments).payload.values.push(7);
      if (reopen !== undefined) {
        const reopened = await reopen();
        assert.deepEqual(await reopened.outboxGet(original.intentId), { intent: original, status: 'dispatched' });
        assert.deepEqual(await reopened.outboxGet(sibling.intentId), { intent: sibling, status: 'pending' });
        assert.equal(await reopened.outboxGet('retained-unknown'), null);
      }
      assert.deepEqual(await store.outboxGet(original.intentId), { intent: original, status: 'dispatched' });
      assert.equal(await store.readRevision(), 2);
    });

    it('acking an id staged in the same batch marks it dispatched', async () => {
      const { store, reset } = await setup();
      await reset();
      await store.commit({
        ...makeBatch(0, {
          outbox: [
            makeIntent({ intentId: 'sb-keep', operationId: 'op-sb-ack' }),
            makeIntent({ intentId: 'sb-ack', operationId: 'op-sb-ack' }),
          ],
        }),
        outboxAck: ['sb-ack'],
      });
      assert.deepEqual(
        (await store.outboxPending()).map((intent) => intent.intentId),
        ['sb-keep'],
      );
      assert.equal(await store.readRevision(), 1);
    });

    it('outboxPending returns full intents ordered by creation then id', async () => {
      const { store, reset } = await setup();
      await reset();
      const first = makeIntent({
        intentId: 'ob-m2',
        operationId: 'op-ob-1',
        occurrenceIndex: 2,
      });
      const second = makeIntent({
        intentId: 'ob-m1',
        operationId: 'op-ob-1',
        occurrenceIndex: 1,
      });
      const guarded = {
        ...makeIntent({ intentId: 'ob-a0', operationId: 'op-ob-2', target: 'sms.send' }),
        dispatchGuard: 'weekday',
      };
      await store.commit(
        makeBatch(0, {
          receipt: makeReceipt({
            operationId: 'op-ob-1',
            committedRevision: 1,
            createdAt: 1_700_000_000_100,
          }),
          outbox: [first, second],
        }),
      );
      await store.commit(
        makeBatch(1, {
          receipt: makeReceipt({
            operationId: 'op-ob-2',
            committedRevision: 2,
            createdAt: 1_700_000_000_600,
          }),
          outbox: [guarded],
        }),
      );
      // Same-batch ties break by intent id; the later batch sorts after both.
      assert.deepEqual(await store.outboxPending(), [second, first, guarded]);
    });

    it('scheduleGet hits on replace, tracks updates, and misses after cancel', async () => {
      const { store, reset } = await setup();
      await reset();
      assert.equal(await store.scheduleGet('sched-missing'), null);
      await store.commit(
        makeBatch(0, {
          schedules: [
            {
              op: 'replace',
              key: 'sched-1',
              at: 1_700_000_010_000,
              event: asOperation('shop.pickupDue'),
              payload: { order: 'ord-1' },
            },
          ],
        }),
      );
      assert.deepEqual(await store.scheduleGet('sched-1'), {
        key: 'sched-1',
        at: 1_700_000_010_000,
        event: 'shop.pickupDue',
        payload: { order: 'ord-1' },
      });
      await store.commit(
        makeBatch(1, {
          schedules: [
            {
              op: 'replace',
              key: 'sched-1',
              at: 1_700_000_020_000,
              event: asOperation('shop.pickupLate'),
              payload: {},
            },
          ],
        }),
      );
      assert.deepEqual(await store.scheduleGet('sched-1'), {
        key: 'sched-1',
        at: 1_700_000_020_000,
        event: 'shop.pickupLate',
        payload: {},
      });
      await store.commit(makeBatch(2, { schedules: [{ op: 'cancel', key: 'sched-1' }] }));
      assert.equal(await store.scheduleGet('sched-1'), null);
      assert.equal(await store.scheduleGet('sched-missing'), null);
    });

    it('schedulesDue filters by now, orders by time then key, and caps at limit', async () => {
      const { store, reset } = await setup();
      await reset();
      await store.commit(
        makeBatch(0, {
          schedules: [
            { op: 'replace', key: 'due-b', at: 2_000, event: asOperation('t.due'), payload: {} },
            {
              op: 'replace',
              key: 'due-a',
              at: 1_000,
              event: asOperation('t.due'),
              payload: { n: 1 },
            },
            { op: 'replace', key: 'due-c', at: 2_000, event: asOperation('t.due'), payload: {} },
            {
              op: 'replace',
              key: 'future',
              at: 9_999_999_999_999,
              event: asOperation('t.due'),
              payload: {},
            },
          ],
        }),
      );
      const due = await store.schedulesDue(2_000, 10);
      assert.deepEqual(
        due.map((entry) => [entry.key, entry.at]),
        [
          ['due-a', 1_000],
          ['due-b', 2_000],
          ['due-c', 2_000],
        ],
      );
      assert.deepEqual(
        (await store.schedulesDue(2_000, 2)).map((entry) => entry.key),
        ['due-a', 'due-b'],
      );
      assert.deepEqual(await store.schedulesDue(999, 10), []);
      // Boundary `at <= now` is inclusive; payloads round-trip.
      assert.deepEqual(due[0]?.payload, { n: 1 });
    });

    it('schedulesDue rejects a bad limit with a plain Error', async () => {
      const { store, reset } = await setup();
      await reset();
      for (const limit of [0, -1, 1.5, Number.NaN]) {
        const failed = await captureFailure(store.schedulesDue(1_700_000_000_000, limit));
        if (!(failed instanceof Error)) {
          assert.fail(`expected Error for limit ${String(limit)}, got ${String(failed)}`);
        }
        assert.match(failed.message, /Invalid schedules limit/);
        assert.equal(failed.constructor, Error);
      }
      assert.equal(await store.readRevision(), 0);
    });

    it('historyFor returns one record history ordered by version ascending', async () => {
      const { store, reset } = await setup();
      await reset();
      const created = makeHistory({
        model: 'shop.Order',
        recordId: 'ord-h',
        version: 1,
        operationId: 'op-h-1',
        change: 'create',
        before: null,
        after: { total: 50 },
      });
      const updated = makeHistory({
        model: 'shop.Order',
        recordId: 'ord-h',
        version: 2,
        operationId: 'op-h-2',
        change: 'update',
        before: { total: 50 },
        after: { total: 60 },
      });
      const archived = makeHistory({
        model: 'shop.Order',
        recordId: 'ord-h',
        version: 3,
        operationId: 'op-h-3',
        change: 'archive',
        before: { total: 60 },
        after: { total: 60 },
      });
      const other = makeHistory({
        model: 'shop.Order',
        recordId: 'ord-other',
        version: 1,
        operationId: 'op-h-1',
        change: 'create',
      });
      // Committed out of version order: the reader sorts, never assumes insert order.
      await store.commit(makeBatch(0, { history: [updated, other] }));
      await store.commit(makeBatch(1, { history: [archived, created] }));
      assert.deepEqual(await store.historyFor(asModel('shop.Order'), asId('ord-h')), [
        created,
        updated,
        archived,
      ]);
      assert.deepEqual(await store.historyFor(asModel('shop.Order'), asId('ord-other')), [other]);
      assert.deepEqual(await store.historyFor(asModel('shop.Order'), asId('ord-missing')), []);
    });

    it('same-batch duplicate schedule keys apply in order, last op wins', async () => {
      const { store, reset } = await setup();
      await reset();
      // S6 review: pins adapter apply order on every backend (D1 batch()
      // statement order, DO sequential exec, memory sequential loop).
      await store.commit(
        makeBatch(0, {
          schedules: [
            {
              op: 'replace',
              key: 'dup-rr',
              at: 1_000,
              event: asOperation('t.due'),
              payload: { v: 1 },
            },
            {
              op: 'replace',
              key: 'dup-rr',
              at: 2_000,
              event: asOperation('t.due'),
              payload: { v: 2 },
            },
            { op: 'replace', key: 'dup-rc', at: 1_000, event: asOperation('t.due'), payload: {} },
            { op: 'cancel', key: 'dup-rc' },
            { op: 'cancel', key: 'dup-cr' },
            { op: 'replace', key: 'dup-cr', at: 3_000, event: asOperation('t.due'), payload: {} },
          ],
        }),
      );
      assert.deepEqual((await store.scheduleGet('dup-rr'))?.at, 2_000);
      assert.deepEqual((await store.scheduleGet('dup-rr'))?.payload, { v: 2 });
      assert.equal(await store.scheduleGet('dup-rc'), null);
      assert.deepEqual((await store.scheduleGet('dup-cr'))?.at, 3_000);
    });

    it('readers return deep copies isolated from stored state', async () => {
      const { store, reset } = await setup();
      await reset();
      await store.commit(
        makeBatch(0, {
          outbox: [makeIntent({ intentId: 'dc-i', operationId: 'op-dc' })],
          schedules: [
            { op: 'replace', key: 'dc-k', at: 1_000, event: asOperation('t.due'), payload: { n: 1 } },
          ],
          history: [makeHistory({ model: 't.Doc', recordId: 'dc-r', version: 1, after: { n: 1 } })],
        }),
      );
      const pending = await store.outboxPending();
      assert.equal(pending.length, 1);
      const pendingArgs = pending[0]?.arguments as Record<string, unknown>;
      pendingArgs['to'] = 'mutated@example.com';
      pendingArgs['added'] = true;
      const sched = await store.scheduleGet('dc-k');
      assert.ok(sched !== null);
      (sched.payload as Record<string, unknown>)['n'] = 999;
      const due = await store.schedulesDue(9_999_999_999_999, 10);
      assert.equal(due.length, 1);
      (due[0]?.payload as Record<string, unknown>)['n'] = 999;
      const hist = await store.historyFor(asModel('t.Doc'), asId('dc-r'));
      assert.equal(hist.length, 1);
      (hist[0]?.after as Record<string, unknown>)['n'] = 999;
      // Re-reads observe pristine state on every backend.
      assert.deepEqual((await store.outboxPending())[0]?.arguments, { to: 'a@example.com' });
      assert.deepEqual((await store.scheduleGet('dc-k'))?.payload, { n: 1 });
      assert.deepEqual((await store.schedulesDue(9_999_999_999_999, 10))[0]?.payload, { n: 1 });
      assert.deepEqual((await store.historyFor(asModel('t.Doc'), asId('dc-r')))[0]?.after, {
        n: 1,
      });
    });

    it('historyFor orders duplicate versions by insertion sequence', async () => {
      const { store, reset } = await setup();
      await reset();
      // Duplicate versions are reachable only via direct unstaged commits
      // (the pipeline assigns unique versions); the (version, seq) order
      // keeps the reader total and deterministic on every backend.
      const first = makeHistory({
        model: 't.Doc',
        recordId: 'dv-r',
        version: 1,
        operationId: 'op-dv-1',
        after: { n: 1 },
      });
      const second = makeHistory({
        model: 't.Doc',
        recordId: 'dv-r',
        version: 1,
        operationId: 'op-dv-2',
        after: { n: 2 },
      });
      await store.commit(makeBatch(0, { history: [first, second] }));
      assert.deepEqual(await store.historyFor(asModel('t.Doc'), asId('dv-r')), [first, second]);
    });

    it('S7: fresh owner reads null snapshot/progress and empty staged rows/outcomes', async () => {
      const { store, reset } = await setup();
      await reset();
      // Fresh migration ids/owners per test: the D1/DO harnesses reset only
      // the S2-S6 tables plus the fence, so S7 rows must not collide across
      // tests. (Memory gets a fresh store per test regardless.)
      const migrationId = freshId('mig-fresh');
      const owner = freshId('owner-fresh');
      assert.equal(await store.readInstalledSnapshot(owner), null);
      assert.equal(await store.readMigrationProgress(migrationId), null);
      assert.deepEqual(await store.readStagedRows(migrationId, null, 10), []);
      assert.deepEqual(await store.readMigrationOutcomes(migrationId), []);
    });

    it('S7: stage chunk persists rows + progress atomically; fence loss stages nothing', async () => {
      const { store, reset } = await setup();
      await reset();
      const migrationId = freshId('mig-stage');
      const rows = [
        makeStagedRow({ model: 'shop.Order', recordId: 'ord-1', version: 1 }),
        makeStagedRow({
          model: 'shop.Order',
          recordId: 'ord-2',
          version: 2,
          data: { total: 60 },
          converted: true,
          parent: { model: asModel('shop.Customer'), id: asId('cust-1') },
        }),
      ];
      const progress = makeProgress(migrationId, {
        phase: 'staging',
        stagedCursor: { model: 'shop.Order', recordId: 'ord-2' },
        updatedRevision: 1,
      });
      const staged = await store.stageMigrationRows({ expectedRevision: asRevision(0), migrationId, rows, progress });
      assert.equal(staged.revision, 1);
      assert.deepEqual(await store.readStagedRows(migrationId, null, 10), rows);
      assert.deepEqual(await store.readMigrationProgress(migrationId), progress);
      // Fence loss stages nothing: no rows, no progress, revision unchanged.
      const failedId = freshId('mig-stage-fail');
      const failed = await captureFailure(
        store.stageMigrationRows({
          expectedRevision: asRevision(0),
          migrationId: failedId,
          rows: [makeStagedRow({ recordId: 'lost-1' })],
          progress: makeProgress(failedId),
        }),
      );
      expectFenceConflict(failed, 0, 1);
      assert.deepEqual(await store.readStagedRows(failedId, null, 10), []);
      assert.equal(await store.readMigrationProgress(failedId), null);
      assert.equal(await store.readRevision(), 1);
      // Staged reads are deep copies isolated from stored state.
      const reread = await store.readStagedRows(migrationId, null, 10);
      (reread[0]?.data as Record<string, unknown>)['total'] = 999;
      const progressRead = await store.readMigrationProgress(migrationId);
      assert.ok(progressRead !== null);
      (progressRead as unknown as { phase: string }).phase = 'active';
      assert.deepEqual(await store.readStagedRows(migrationId, null, 10), rows);
      assert.deepEqual(await store.readMigrationProgress(migrationId), progress);
    });

    it('S7: restaging the same rows is idempotent and overwrites data', async () => {
      const { store, reset } = await setup();
      await reset();
      const migrationId = freshId('mig-restage');
      const row = makeStagedRow({ model: 'shop.Order', recordId: 'ord-r', data: { n: 1 } });
      await store.stageMigrationRows({
        expectedRevision: asRevision(0),
        migrationId,
        rows: [row],
        progress: makeProgress(migrationId, { updatedRevision: 1 }),
      });
      // Exact restage: same content, new revision.
      await store.stageMigrationRows({
        expectedRevision: asRevision(1),
        migrationId,
        rows: [row],
        progress: makeProgress(migrationId, { updatedRevision: 2 }),
      });
      assert.deepEqual(await store.readStagedRows(migrationId, null, 10), [row]);
      // Restage with new content overwrites by (migration, model, id) key.
      const updated = makeStagedRow({
        model: 'shop.Order',
        recordId: 'ord-r',
        version: 2,
        data: { n: 2 },
        converted: true,
      });
      await store.stageMigrationRows({
        expectedRevision: asRevision(2),
        migrationId,
        rows: [updated],
        progress: makeProgress(migrationId, { phase: 'staged', updatedRevision: 3 }),
      });
      assert.deepEqual(await store.readStagedRows(migrationId, null, 10), [updated]);
      assert.equal(await store.readRevision(), 3);
    });

    it('S7: readStagedRows pages by cursor in (model, id) order with limit', async () => {
      const { store, reset } = await setup();
      await reset();
      const migrationId = freshId('mig-page');
      // Staged out of order: the reader sorts, never assumes insert order.
      const staged = [
        makeStagedRow({ model: 'b.Model', recordId: 'r-2' }),
        makeStagedRow({ model: 'a.Model', recordId: 'r-9' }),
        makeStagedRow({ model: 'a.Model', recordId: 'r-1' }),
      ];
      await store.stageMigrationRows({
        expectedRevision: asRevision(0),
        migrationId,
        rows: staged,
        progress: makeProgress(migrationId),
      });
      const ordered = [staged[2], staged[1], staged[0]] as StagedRow[];
      assert.deepEqual(await store.readStagedRows(migrationId, null, 10), ordered);
      assert.deepEqual(await store.readStagedRows(migrationId, null, 2), ordered.slice(0, 2));
      assert.deepEqual(
        await store.readStagedRows(migrationId, { model: 'a.Model', recordId: 'r-1' }, 10),
        ordered.slice(1),
      );
      assert.deepEqual(
        await store.readStagedRows(migrationId, { model: 'a.Model', recordId: 'r-9' }, 10),
        ordered.slice(2),
      );
      // Cursor past the end reads empty; other migrations are isolated.
      assert.deepEqual(
        await store.readStagedRows(migrationId, { model: 'b.Model', recordId: 'r-2' }, 10),
        [],
      );
      assert.deepEqual(await store.readStagedRows(freshId('mig-other'), null, 10), []);
    });

    it('S7: readStagedRows rejects a bad limit with a plain Error', async () => {
      const { store, reset } = await setup();
      await reset();
      const migrationId = freshId('mig-badlimit');
      for (const limit of [0, -1, 1.5, Number.NaN]) {
        const failed = await captureFailure(store.readStagedRows(migrationId, null, limit));
        if (!(failed instanceof Error)) {
          assert.fail(`expected Error for limit ${String(limit)}, got ${String(failed)}`);
        }
        assert.match(failed.message, /Invalid staged rows limit/);
        assert.equal(failed.constructor, Error);
      }
      assert.equal(await store.readRevision(), 0);
    });

    it('S7: publish applies records + history + drops + progress atomically', async () => {
      const { store, reset } = await setup();
      await reset();
      const migrationId = freshId('mig-publish');
      await store.commit(
        makeBatch(0, {
          writes: [
            {
              kind: 'insert',
              model: asModel('shop.Order'),
              row: makeRow({
                id: 'keep-1',
                version: 1,
                created: 1_000,
                updated: 1_000,
                createdBy: 'alice',
                updatedBy: 'alice',
                data: { n: 1 },
              }),
            },
            {
              kind: 'insert',
              model: asModel('shop.Order'),
              row: makeRow({ id: 'drop-1', version: 1, data: { n: 1 } }),
            },
            {
              kind: 'insert',
              model: asModel('shop.Order'),
              row: makeRow({
                id: 'arch-1',
                version: 1,
                createdBy: 'bob',
                updatedBy: 'bob',
                archivedAt: 1_500,
                data: { n: 1 },
              }),
            },
          ],
        }),
      );
      const keepHist = makeHistory({
        model: 'shop.Order',
        recordId: 'keep-1',
        version: 2,
        operationId: 'op-mig-1',
        actor: 'migration:snap-2',
        at: 2_000,
        change: 'update',
        before: { n: 1 },
        after: { n: 2 },
      });
      const newHist = makeHistory({
        model: 'shop.Order',
        recordId: 'new-1',
        version: 1,
        operationId: 'op-mig-1',
        actor: 'migration:snap-2',
        at: 3_000,
        change: 'create',
        before: null,
        after: { fresh: true },
      });
      const dropHist = makeHistory({
        model: 'shop.Order',
        recordId: 'drop-1',
        version: 1,
        operationId: 'op-mig-1',
        actor: 'migration:snap-2',
        at: 2_000,
        change: 'remove',
        before: { n: 1 },
        after: null,
      });
      const progress = makeProgress(migrationId, {
        phase: 'publishing',
        stagedCursor: { model: 'shop.Order', recordId: 'keep-1' },
        updatedRevision: 2,
      });
      const published = await store.publishMigrationChunk({
        expectedRevision: asRevision(1),
        migrationId,
        rows: [
          makeStagedRow({
            model: 'shop.Order',
            recordId: 'keep-1',
            version: 2,
            data: { n: 2 },
            converted: true,
          }),
          makeStagedRow({ model: 'shop.Order', recordId: 'new-1', data: { fresh: true } }),
          // Name-only over an archived row, with no history entry.
          makeStagedRow({ model: 'shop.Order', recordId: 'arch-1', data: { n: 9 } }),
          // No live predecessor and no history: metadata falls back to 0/''.
          makeStagedRow({ model: 'shop.Order', recordId: 'orphan-1', data: { x: 1 } }),
        ],
        history: [keepHist, newHist],
        drops: [makeDrop('shop.Order', 'drop-1', dropHist)],
        progress,
      });
      assert.equal(published.revision, 2);
      // Converted row: version/data from staging, updated/* from history,
      // created/* carried over from the live predecessor.
      const keep = await store.load(asModel('shop.Order'), asId('keep-1'));
      assert.ok(keep !== null);
      assert.equal(keep.version, 2);
      assert.deepEqual(keep.data, { n: 2 });
      assert.equal(keep.created, 1_000);
      assert.equal(keep.createdBy, 'alice');
      assert.equal(keep.updated, 2_000);
      assert.equal(keep.updatedBy, 'migration:snap-2');
      assert.equal(keep.archivedAt, null);
      // New row: history supplies created/* when no live row exists.
      const fresh = await store.load(asModel('shop.Order'), asId('new-1'));
      assert.ok(fresh !== null);
      assert.equal(fresh.version, 1);
      assert.deepEqual(fresh.data, { fresh: true });
      assert.equal(fresh.created, 3_000);
      assert.equal(fresh.updated, 3_000);
      assert.equal(fresh.createdBy, 'migration:snap-2');
      assert.equal(fresh.updatedBy, 'migration:snap-2');
      // Archived row keeps its archivedAt: publish never unarchives.
      const arch = await store.load(asModel('shop.Order'), asId('arch-1'));
      assert.ok(arch !== null);
      assert.deepEqual(arch.data, { n: 9 });
      assert.equal(arch.archivedAt, 1_500);
      assert.equal(arch.createdBy, 'bob');
      // Fallback row pins the 0/'' metadata contract gap (the chunk carries
      // no clock/actor of its own).
      const orphan = await store.load(asModel('shop.Order'), asId('orphan-1'));
      assert.ok(orphan !== null);
      assert.equal(orphan.created, 0);
      assert.equal(orphan.updated, 0);
      assert.equal(orphan.createdBy, '');
      assert.equal(orphan.updatedBy, '');
      assert.equal(orphan.archivedAt, null);
      // Drop disposed the live row and recorded its history.
      assert.equal(await store.load(asModel('shop.Order'), asId('drop-1')), null);
      assert.deepEqual(await store.historyFor(asModel('shop.Order'), asId('keep-1')), [keepHist]);
      assert.deepEqual(await store.historyFor(asModel('shop.Order'), asId('new-1')), [newHist]);
      assert.deepEqual(await store.historyFor(asModel('shop.Order'), asId('drop-1')), [dropHist]);
      assert.deepEqual(await store.historyFor(asModel('shop.Order'), asId('orphan-1')), []);
      assert.deepEqual(await store.readMigrationProgress(migrationId), progress);
    });

    it('S7: publish moves unique claims and preserves staged creation metadata', async () => {
      const { store, reset } = await setup();
      await reset();
      const migrationId = freshId('mig-claims');
      await store.commit(
        makeBatch(0, {
          writes: [
            {
              kind: 'insert',
              model: asModel('shop.Legacy'),
              row: makeRow({ id: 'ren-1', version: 1, data: { sku: 'ABC' } }),
            },
          ],
          uniqueClaims: [uniqueClaim('shop.Legacy', 'ren-1', 'sku', 'ABC')],
        }),
      );
      // The engine copies creation metadata from the live before-row into
      // staging so the rename target preserves it.
      const before = await store.load(asModel('shop.Legacy'), asId('ren-1'));
      assert.ok(before !== null);
      await store.stageMigrationRows({
        expectedRevision: asRevision(1),
        migrationId,
        rows: [
          makeStagedRow({
            model: 'shop.Item',
            recordId: 'ren-1',
            version: 2,
            data: { sku: 'ABC' },
            converted: true,
            created: before.created,
            createdBy: before.createdBy,
            archivedAt: before.archivedAt,
          }),
        ],
        progress: makeProgress(migrationId, { phase: 'staging', updatedRevision: 2 }),
      });
      // Staged metadata round-trips through storage, not just the engine.
      const staged = await store.readStagedRows(migrationId, null, 10);
      assert.equal(staged.length, 1);
      assert.equal(staged[0]?.created, before.created);
      assert.equal(staged[0]?.createdBy, before.createdBy);
      const renHist = makeHistory({
        model: 'shop.Item',
        recordId: 'ren-1',
        version: 2,
        operationId: 'op-mig-claims',
        change: 'update',
        before: { sku: 'ABC' },
        after: { sku: 'ABC' },
      });
      await store.publishMigrationChunk({
        expectedRevision: asRevision(2),
        migrationId,
        rows: [...staged],
        history: [renHist],
        drops: [
          makeDrop(
            'shop.Legacy',
            'ren-1',
            makeHistory({
              model: 'shop.Legacy',
              recordId: 'ren-1',
              version: 1,
              operationId: 'op-mig-claims',
              change: 'remove',
              before: { sku: 'ABC' },
              after: null,
            }),
          ),
        ],
        uniqueReleases: [{ model: asModel('shop.Legacy'), keyName: 'sku', keyValue: 'ABC' }],
        uniqueClaims: [uniqueClaim('shop.Item', 'ren-1', 'sku', 'ABC')],
        progress: makeProgress(migrationId, { phase: 'publishing', updatedRevision: 3 }),
      });
      const live = await store.load(asModel('shop.Item'), asId('ren-1'));
      assert.ok(live !== null);
      assert.equal(live.created, before.created);
      assert.equal(live.createdBy, before.createdBy);
      assert.equal(live.archivedAt, before.archivedAt);
      assert.equal(await store.load(asModel('shop.Legacy'), asId('ren-1')), null);
      // The key moved models atomically: the new model holds it, the old
      // model is free. Claims are observable only through commit behavior.
      const held = await captureFailure(
        store.commit(
          makeBatch(3, {
            writes: [
              {
                kind: 'insert',
                model: asModel('shop.Item'),
                row: makeRow({ id: 'ren-2', data: { sku: 'ABC' } }),
              },
            ],
            uniqueClaims: [uniqueClaim('shop.Item', 'ren-2', 'sku', 'ABC')],
          }),
        ),
      );
      assert.ok(
        held instanceof StorageConstraintError && held.kind === 'unique',
        `expected unique conflict on the moved key, got ${String(held)}`,
      );
      await store.commit(
        makeBatch(3, {
          writes: [
            {
              kind: 'insert',
              model: asModel('shop.Legacy'),
              row: makeRow({ id: 'ren-3', data: { sku: 'ABC' } }),
            },
          ],
          uniqueClaims: [uniqueClaim('shop.Legacy', 'ren-3', 'sku', 'ABC')],
        }),
      );
      assert.equal(await store.readRevision(), 4);
    });

    it('S7: publish fence loss applies nothing', async () => {
      const { store, reset } = await setup();
      await reset();
      const migrationId = freshId('mig-pubfail');
      const live = makeRow({ id: 'live-1', data: { n: 1 } });
      await store.commit(
        makeBatch(0, {
          writes: [{ kind: 'insert', model: asModel('shop.Order'), row: live }],
        }),
      );
      const failed = await captureFailure(
        store.publishMigrationChunk({
          expectedRevision: asRevision(0),
          migrationId,
          rows: [makeStagedRow({ model: 'shop.Order', recordId: 'live-1', version: 2 })],
          history: [makeHistory({ model: 'shop.Order', recordId: 'live-1', version: 2 })],
          drops: [],
          progress: makeProgress(migrationId, { phase: 'publishing' }),
        }),
      );
      expectFenceConflict(failed, 0, 1);
      const reread = await store.load(asModel('shop.Order'), asId('live-1'));
      assert.ok(reread !== null);
      assert.equal(reread.version, 1);
      assert.deepEqual(reread.data, { n: 1 });
      assert.deepEqual(await store.historyFor(asModel('shop.Order'), asId('live-1')), []);
      assert.equal(await store.readMigrationProgress(migrationId), null);
      assert.equal(await store.readRevision(), 1);
    });

    it('S7: flip installs pointer, skips intents, records outcomes, marks active', async () => {
      const { store, reset, reopen } = await setup();
      await reset();
      const migrationId = freshId('mig-flip');
      const owner = freshId('owner-flip');
      const skip1 = `skip-1-${migrationId}`;
      const skip2 = `skip-2-${migrationId}`;
      const keep = `keep-1-${migrationId}`;
      const skippedIntent = { ...makeIntent({ intentId: skip1 }), handlerContract: 'shop.oldHandler' };
      await store.commit(
        makeBatch(0, {
          outbox: [
            skippedIntent,
            makeIntent({ intentId: skip2 }),
            makeIntent({ intentId: keep }),
          ],
        }),
      );
      await store.commit({ ...makeBatch(1), outboxAck: [keep] });
      // Empty-rows stage is valid: progress-only advance.
      await store.stageMigrationRows({
        expectedRevision: asRevision(2),
        migrationId,
        rows: [],
        progress: makeProgress(migrationId, {
          phase: 'staged',
          stagedCursor: { model: 'shop.Order', recordId: 'ord-9' },
          updatedRevision: 3,
        }),
      });
      const snapshot = makeSnapshot(owner);
      const outcomes = [makeOutcome(migrationId, skip1), makeOutcome(migrationId, skip2)];
      const flipped = await store.flipInstalledSnapshot({
        expectedRevision: asRevision(3),
        migrationId,
        owner,
        snapshot,
        renameFromOwner: null,
        invalidatedIntentIds: [skip1, skip2, `unknown-${migrationId}`],
        outcomes,
      });
      assert.deepEqual(flipped, { revision: 4, flipped: true });
      // The flip records its ACTUAL commit revision, not the input guess —
      // the engine cannot know it pre-commit.
      assert.deepEqual(await store.readInstalledSnapshot(owner), {
        ...snapshot,
        installedRevision: flipped.revision,
      });
      // Skipped + dispatched intents all leave the pending set; the unknown
      // id was a no-op (the flip still committed).
      assert.deepEqual(await store.outboxPending(), []);
      assert.deepEqual(await store.readMigrationOutcomes(migrationId), outcomes);
      assert.deepEqual(await store.readMigrationProgress(migrationId), {
        migrationId,
        phase: 'active',
        stagedCursor: { model: 'shop.Order', recordId: 'ord-9' },
        publishCursor: null,
        updatedRevision: 4,
      });
      // Snapshot/outcome reads are deep copies isolated from stored state.
      const snapshotRead = await store.readInstalledSnapshot(owner);
      assert.ok(snapshotRead !== null);
      (snapshotRead as unknown as { digest: string }).digest = 'mutated';
      const outcomesRead = await store.readMigrationOutcomes(migrationId);
      (outcomesRead[0] as unknown as { intentId: string }).intentId = 'mutated';
      assert.deepEqual(await store.readInstalledSnapshot(owner), {
        ...snapshot,
        installedRevision: flipped.revision,
      });
      assert.deepEqual(await store.readMigrationOutcomes(migrationId), outcomes);
      assert.deepEqual(await store.outboxGet(skip1), { intent: skippedIntent, status: 'skipped' });
      assert.equal(await store.outboxGet(`unknown-${migrationId}`), null);
      // A dispatcher retry cannot rewrite a migration skip into dispatched.
      await store.commit({ ...makeBatch(4), outboxAck: [skip1, keep] });
      assert.deepEqual(await store.outboxGet(skip1), { intent: skippedIntent, status: 'skipped' });
      assert.equal((await store.outboxGet(keep))?.status, 'dispatched');
      assert.deepEqual(await store.outboxPending(), []);
      if (reopen !== undefined) {
        assert.deepEqual(await (await reopen()).outboxGet(skip1), { intent: skippedIntent, status: 'skipped' });
      }
    });

    it('S7: removal flip deletes the pointer, still skips/outcomes, idempotent', async () => {
      const { store, reset } = await setup();
      await reset();
      const migrationId = freshId('mig-rmflip');
      const owner = freshId('owner-rmflip');
      await store.commit(
        makeBatch(0, {
          outbox: [makeIntent({ intentId: `rm-skip-${migrationId}` })],
        }),
      );
      await store.flipInstalledSnapshot({
        expectedRevision: asRevision(1),
        migrationId,
        owner,
        snapshot: makeSnapshot(owner, { snapshotId: 'snap-1', digest: 'digest-1' }),
        renameFromOwner: null,
        invalidatedIntentIds: [],
        outcomes: [],
      });
      assert.ok((await store.readInstalledSnapshot(owner)) !== null);
      const outcomes = [makeOutcome(migrationId, `rm-skip-${migrationId}`)];
      const removed = await store.flipInstalledSnapshot({
        expectedRevision: asRevision(2),
        migrationId,
        owner,
        snapshot: null,
        renameFromOwner: null,
        invalidatedIntentIds: [`rm-skip-${migrationId}`],
        outcomes,
      });
      assert.deepEqual(removed, { revision: 3, flipped: true });
      assert.equal(await store.readInstalledSnapshot(owner), null);
      assert.deepEqual(await store.outboxPending(), []);
      assert.deepEqual(await store.readMigrationOutcomes(migrationId), outcomes);
      assert.deepEqual(await store.readMigrationProgress(migrationId), {
        migrationId,
        phase: 'active',
        stagedCursor: null,
        publishCursor: null,
        updatedRevision: 3,
      });
      // Removal against an absent pointer is a no-op success (idempotent).
      const rerun = await store.flipInstalledSnapshot({
        expectedRevision: asRevision(0),
        migrationId,
        owner,
        snapshot: null,
        renameFromOwner: null,
        invalidatedIntentIds: [],
        outcomes: [makeOutcome(migrationId, 'rm-late')],
      });
      assert.deepEqual(rerun, { revision: 3, flipped: false });
      assert.deepEqual(await store.readMigrationOutcomes(migrationId), outcomes);
      // Contradictory removal inputs are programmer bugs (plain Error).
      const badRename = await captureFailure(
        store.flipInstalledSnapshot({
          expectedRevision: asRevision(3),
          migrationId,
          owner,
          snapshot: null,
          renameFromOwner: owner,
          invalidatedIntentIds: [],
          outcomes: [],
        }),
      );
      assert.ok(badRename instanceof Error && badRename.constructor === Error);
      const badOwner = await captureFailure(
        store.flipInstalledSnapshot({
          expectedRevision: asRevision(3),
          migrationId,
          owner,
          snapshot: makeSnapshot('other-owner'),
          renameFromOwner: null,
          invalidatedIntentIds: [],
          outcomes: [],
        }),
      );
      assert.ok(badOwner instanceof Error && badOwner.constructor === Error);
      assert.equal(await store.readRevision(), 3);
    });

    it('S7: flip is idempotent: a second flip commits nothing', async () => {
      const { store, reset } = await setup();
      await reset();
      const migrationId = freshId('mig-idem');
      const owner = freshId('owner-idem');
      const snapshot = makeSnapshot(owner);
      const first = await store.flipInstalledSnapshot({
        expectedRevision: asRevision(0),
        migrationId,
        owner,
        snapshot,
        renameFromOwner: null,
        invalidatedIntentIds: [],
        outcomes: [makeOutcome(migrationId, 'intent-a')],
      });
      assert.deepEqual(first, { revision: 1, flipped: true });
      // Same target, even with a STALE expected revision and different
      // outcomes: activation retries must succeed without committing.
      const second = await store.flipInstalledSnapshot({
        expectedRevision: asRevision(0),
        migrationId,
        owner,
        snapshot,
        renameFromOwner: null,
        invalidatedIntentIds: [`skip-x-${migrationId}`],
        outcomes: [makeOutcome(migrationId, 'intent-b')],
      });
      assert.deepEqual(second, { revision: 1, flipped: false });
      assert.equal(await store.readRevision(), 1);
      assert.deepEqual(await store.readInstalledSnapshot(owner), {
        ...snapshot,
        installedRevision: first.revision,
      });
      assert.deepEqual(await store.readMigrationOutcomes(migrationId), [
        makeOutcome(migrationId, 'intent-a'),
      ]);
      assert.deepEqual(await store.readMigrationProgress(migrationId), {
        migrationId,
        phase: 'active',
        stagedCursor: null,
        publishCursor: null,
        updatedRevision: 1,
      });
    });

    it('S7: flip fence loss applies nothing', async () => {
      const { store, reset } = await setup();
      await reset();
      const migrationId = freshId('mig-flipfail');
      const owner = freshId('owner-flipfail');
      const skip = `skip-1-${migrationId}`;
      await store.commit(makeBatch(0, { outbox: [makeIntent({ intentId: skip })] }));
      // Installed X at revision 2; the flip below targets Y with a STALE
      // expected revision, forcing the fenced path (no early-return).
      await store.flipInstalledSnapshot({
        expectedRevision: asRevision(1),
        migrationId: freshId('mig-flipfail-seed'),
        owner,
        snapshot: makeSnapshot(owner, { snapshotId: 'snap-1', digest: 'digest-1' }),
        renameFromOwner: null,
        invalidatedIntentIds: [],
        outcomes: [],
      });
      const failed = await captureFailure(
        store.flipInstalledSnapshot({
          expectedRevision: asRevision(0),
          migrationId,
          owner,
          snapshot: makeSnapshot(owner, { snapshotId: 'snap-2', digest: 'digest-2' }),
          renameFromOwner: null,
          invalidatedIntentIds: [skip],
          outcomes: [makeOutcome(migrationId, skip)],
        }),
      );
      expectFenceConflict(failed, 0, 2);
      assert.deepEqual(await store.readInstalledSnapshot(owner), {
        ...makeSnapshot(owner, { snapshotId: 'snap-1', digest: 'digest-1' }),
        installedRevision: 2,
      });
      assert.deepEqual(
        (await store.outboxPending()).map((intent) => intent.intentId),
        [skip],
      );
      assert.deepEqual(await store.readMigrationOutcomes(migrationId), []);
      assert.equal(await store.readMigrationProgress(migrationId), null);
      assert.equal(await store.readRevision(), 2);
    });

    it('S7: flip with renameFromOwner removes the old pointer; rowless flip creates active progress', async () => {
      const { store, reset } = await setup();
      await reset();
      const oldOwner = freshId('owner-old');
      const newOwner = freshId('owner-new');
      const firstId = freshId('mig-rename-1');
      const secondId = freshId('mig-rename-2');
      await store.flipInstalledSnapshot({
        expectedRevision: asRevision(0),
        migrationId: firstId,
        owner: oldOwner,
        snapshot: makeSnapshot(oldOwner, { snapshotId: 'snap-1', digest: 'digest-1' }),
        renameFromOwner: null,
        invalidatedIntentIds: [],
        outcomes: [],
      });
      assert.ok((await store.readInstalledSnapshot(oldOwner)) !== null);
      const renamed = makeSnapshot(newOwner);
      const result = await store.flipInstalledSnapshot({
        expectedRevision: asRevision(1),
        migrationId: secondId,
        owner: newOwner,
        snapshot: renamed,
        renameFromOwner: oldOwner,
        invalidatedIntentIds: [],
        outcomes: [],
      });
      assert.deepEqual(result, { revision: 2, flipped: true });
      assert.equal(await store.readInstalledSnapshot(oldOwner), null);
      assert.deepEqual(await store.readInstalledSnapshot(newOwner), {
        ...renamed,
        installedRevision: result.revision,
      });
      // Rowless migration (never staged): flip creates active progress.
      assert.deepEqual(await store.readMigrationProgress(secondId), {
        migrationId: secondId,
        phase: 'active',
        stagedCursor: null,
        publishCursor: null,
        updatedRevision: 2,
      });
    });

    it('S7: staged rows stay invisible to live reads until publish', async () => {
      const { store, reset } = await setup();
      await reset();
      const migrationId = freshId('mig-isolation');
      const owner = freshId('owner-isolation');
      await store.commit(
        makeBatch(0, {
          writes: [
            {
              kind: 'insert',
              model: asModel('shop.Order'),
              row: makeRow({ id: 'iso-1', data: { n: 1 } }),
            },
          ],
        }),
      );
      const stagedRow = makeStagedRow({
        model: 'shop.Order',
        recordId: 'iso-1',
        version: 2,
        data: { n: 2 },
        converted: true,
      });
      await store.stageMigrationRows({
        expectedRevision: asRevision(1),
        migrationId,
        rows: [stagedRow],
        progress: makeProgress(migrationId, { updatedRevision: 2 }),
      });
      // Preparation failure leaves the installed data selected: live reads
      // still see the old row even though staging holds the new one.
      const before = await store.load(asModel('shop.Order'), asId('iso-1'));
      assert.ok(before !== null);
      assert.equal(before.version, 1);
      assert.deepEqual(before.data, { n: 1 });
      const queried = await store.query({ model: asModel('shop.Order'), authority: 'viewer' });
      assert.deepEqual(
        queried.map((row) => row.data),
        [{ n: 1 }],
      );
      const hist = makeHistory({
        model: 'shop.Order',
        recordId: 'iso-1',
        version: 2,
        actor: 'migration:snap-2',
        at: 2_000,
        change: 'update',
        before: { n: 1 },
        after: { n: 2 },
      });
      await store.publishMigrationChunk({
        expectedRevision: asRevision(2),
        migrationId,
        rows: [stagedRow],
        history: [hist],
        drops: [],
        progress: makeProgress(migrationId, { phase: 'publishing', updatedRevision: 3 }),
      });
      const after = await store.load(asModel('shop.Order'), asId('iso-1'));
      assert.ok(after !== null);
      assert.equal(after.version, 2);
      assert.deepEqual(after.data, { n: 2 });
      // Publish does not clear staging: the staged rows remain readable.
      assert.deepEqual(await store.readStagedRows(migrationId, null, 10), [stagedRow]);
      const snapshot = makeSnapshot(owner);
      const flipped = await store.flipInstalledSnapshot({
        expectedRevision: asRevision(3),
        migrationId,
        owner,
        snapshot,
        renameFromOwner: null,
        invalidatedIntentIds: [],
        outcomes: [],
      });
      assert.deepEqual(flipped, { revision: 4, flipped: true });
      assert.deepEqual(await store.readInstalledSnapshot(owner), {
        ...snapshot,
        installedRevision: flipped.revision,
      });
    });
  });
}
