/**
 * Shared storage conformance suite for lane 03 slice S2.
 *
 * This module is NOT a test file itself (no `.test.ts` suffix): backend
 * suites call `storageConformance()` with a setup callback that builds the
 * backend under test. Every subtest resets first, so fixed fixture ids are
 * safe and also prove the backend's reset truly clears all tables.
 *
 * Aligned to worker A's `src/storage/*` actuals: batches carry camelCase
 * `uniqueClaims`/`uniqueReleases` (see `BatchParts`); S2 stores no parent
 * linkage, so the parent subtest characterizes scoped-returns-empty.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  CommitBatch,
  DomainWrite,
  HistoryEntry,
  ModelName,
  OperationId,
  OperationName,
  OutboxIntent,
  QuerySpec,
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
 * S2 stores no parent linkage (parent_* columns stay NULL; StoredRow carries
 * no parent yet), so parent-scoped queries match nothing. This helper keeps
 * the intended linkage visible in fixture data for the slice that stores it.
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

    it('query applies the parent scope (S2 stores no parent linkage yet)', async () => {
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
      // S2 adapters filter on parent_model/parent_id, which stay NULL because
      // StoredRow carries no parent yet: a scoped query matches nothing while
      // the unscoped query returns everything. Positive parent/child scoping
      // becomes testable once a later slice stores the linkage.
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
  });
}
