import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  CommitBatch, DomainWrite, ModelName, RecordId, Revision, StoragePort, StoredRow,
} from '@canlang/contracts';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { FenceConflictError, StorageConstraintError } from '../../src/storage/port.js';
import {
  FANOUT_CHECKPOINT_MODEL, FANOUT_CHILD_MODEL, FANOUT_INTENT_MODEL,
  newFanoutCheckpointRow, newFanoutChildRow, newFanoutIntentRow,
} from '../../src/fanout/tables.js';
import {
  FANOUT_NAVIGATION_MODEL, FANOUT_OWNER_SCAN_MODEL,
  fanoutNavigationChildQuery, fanoutNavigationRowId, fanoutOwnerIntentQuery,
  fanoutOwnerScanRowId, readFanoutNavigationRow, readFanoutOwnerScanRow,
  stageFanoutNavigationWrite, stageFanoutOwnerScanWrite,
} from '../../src/fanout/navigation.js';

const owner = 'owner/a';
const meta = { nowMs: 1_700_000_000_000, actor: 'navigation-test' };
const model = (name: string): ModelName => name as ModelName;
const id = (value: string): RecordId => value as RecordId;
const validation = (error: unknown): boolean => error instanceof StateError && error.code === 'validation';

function batch(expectedRevision: Revision, writes: ReadonlyArray<DomainWrite>): CommitBatch {
  return { expectedRevision, writes, history: [], receipt: null, outbox: [], schedules: [],
    uniqueClaims: [], uniqueReleases: [] };
}

async function commit(store: StoragePort, writes: ReadonlyArray<DomainWrite>): Promise<void> {
  await store.commit(batch(await store.readRevision(), writes));
}

async function world() {
  const store = createMemoryStorage();
  const intent = newFanoutIntentRow({ sourceOccurrence: 'source/a', handler: 'App.each',
    cohort: 'model', members: ['a', 'b', 'c'] }, meta);
  const otherIntent = newFanoutIntentRow({ sourceOccurrence: 'source/b', handler: 'App.each',
    cohort: 'model', members: ['a'] }, meta);
  const checkpoint = newFanoutCheckpointRow({ fanoutId: intent.id, cursor: 'admit/3' }, meta);
  const children = ['a', 'b', 'c'].map(recordId => newFanoutChildRow({ fanoutId: intent.id,
    parentOccurrence: 'source/a', handler: 'App.each', recordId,
    ...(recordId === 'a' ? { state: 'running' as const } : {}),
  }, meta));
  await commit(store, [
    ...[intent, otherIntent].map(row => ({ kind: 'insert' as const, model: model(FANOUT_INTENT_MODEL), row })),
    { kind: 'insert', model: model(FANOUT_CHECKPOINT_MODEL), row: checkpoint },
    ...children.map(row => ({ kind: 'insert' as const, model: model(FANOUT_CHILD_MODEL), row })),
  ]);
  return { store, intent, otherIntent, checkpoint, children, binding: { owner, intentRow: intent } };
}

async function navigation(store: StoragePort, intent: StoredRow): Promise<StoredRow> {
  const row = await store.load(model(FANOUT_NAVIGATION_MODEL), id(fanoutNavigationRowId(owner, intent.id)));
  assert.ok(row);
  return row;
}

describe('separate durable fanout navigation on the owning StoragePort', () => {
  it('reloads visited positions and describes only one bounded page; exhaustion wraps without completion', async () => {
    const { store, intent, otherIntent, checkpoint, children, binding } = await world();
    const firstQuery = fanoutNavigationChildQuery({ ...binding, row: null, limit: 1 });
    assert.equal(firstQuery.limit, 1);
    assert.equal(firstQuery.authority, 'owner');
    assert.deepEqual(firstQuery.order, [{ field: 'id', direction: 'asc' }]);
    const firstPage = await store.query(firstQuery);
    assert.deepEqual(firstPage.map(row => row.id), [children[0]!.id]);
    // A held running child was visited, without inventing a terminal outcome.
    await commit(store, [stageFanoutNavigationWrite({ ...binding, row: null,
      visitedChildRow: firstPage[0]!, meta }), stageFanoutOwnerScanWrite({ row: null, owner,
      visitedIntentRow: intent, meta })]);
    const loaded = await navigation(store, intent);
    assert.equal(readFanoutNavigationRow(loaded, binding).lastVisitedChildId, children[0]!.id);
    const nextQuery = fanoutNavigationChildQuery({ ...binding, row: loaded, limit: 2 });
    assert.deepEqual(nextQuery.where, { op: 'and', args: [
      { op: 'eq', field: 'fanoutId', value: intent.id },
      { op: 'gt', field: 'id', value: children[0]!.id },
    ] });
    const nextPage = await store.query(nextQuery);
    assert.deepEqual(nextPage.map(row => row.id), [children[1]!.id, children[2]!.id]);
    // Advance only the visited prefix, not the unprocessed fetched tail.
    await commit(store, [stageFanoutNavigationWrite({ ...binding, row: loaded,
      visitedChildRow: nextPage[0]!, meta })]);
    const last = await store.query(fanoutNavigationChildQuery({ ...binding,
      row: await navigation(store, intent), limit: 1 }));
    assert.deepEqual(last.map(row => row.id), [children[2]!.id]);
    await commit(store, [stageFanoutNavigationWrite({ ...binding, row: await navigation(store, intent),
      visitedChildRow: last[0]!, meta })]);
    const end = await navigation(store, intent);
    assert.deepEqual(await store.query(fanoutNavigationChildQuery({ ...binding, row: end, limit: 1 })), []);
    await commit(store, [stageFanoutNavigationWrite({ ...binding, row: end, visitedChildRow: null, meta })]);
    assert.equal(readFanoutNavigationRow(await navigation(store, intent), binding).lastVisitedChildId, null);
    assert.deepEqual(await store.load(model(FANOUT_CHECKPOINT_MODEL), checkpoint.id), checkpoint);
    for (const child of children) assert.deepEqual(await store.load(model(FANOUT_CHILD_MODEL), child.id), child);

    const scan = (await store.load(model(FANOUT_OWNER_SCAN_MODEL), id(fanoutOwnerScanRowId(owner))))!;
    assert.equal(readFanoutOwnerScanRow(scan, owner).lastVisitedIntentId, intent.id);
    const ownerQuery = fanoutOwnerIntentQuery({ row: scan, owner, limit: 1 });
    assert.deepEqual(ownerQuery.where, { op: 'gt', field: 'id', value: intent.id });
    assert.deepEqual((await store.query(ownerQuery)).map(row => row.id), [otherIntent.id]);
    await commit(store, [stageFanoutOwnerScanWrite({ row: scan, owner, visitedIntentRow: otherIntent, meta })]);
    const endScan = (await store.load(model(FANOUT_OWNER_SCAN_MODEL), scan.id))!;
    assert.deepEqual(await store.query(fanoutOwnerIntentQuery({ row: endScan, owner, limit: 1 })), []);
    await commit(store, [stageFanoutOwnerScanWrite({ row: endScan, owner, visitedIntentRow: null, meta })]);
    const resetScan = (await store.load(model(FANOUT_OWNER_SCAN_MODEL), scan.id))!;
    assert.equal(readFanoutOwnerScanRow(resetScan, owner).lastVisitedIntentId, null);
    assert.deepEqual((await store.query(fanoutOwnerIntentQuery({ row: resetScan, owner, limit: 1 }))).map(row => row.id), [intent.id]);
  });

  it('refuses stale revision and row versions atomically with co-staged owner writes', async () => {
    const { store, intent, children, binding } = await world();
    await commit(store, [stageFanoutNavigationWrite({ ...binding, row: null,
      visitedChildRow: children[0]!, meta })]);
    const stale = await navigation(store, intent);
    const revision = await store.readRevision();
    const staleWrite = stageFanoutNavigationWrite({ ...binding, row: stale, visitedChildRow: children[1]!, meta });
    assert.equal(staleWrite.kind, 'update');
    if (staleWrite.kind !== 'update') throw new Error('expected navigation update');
    assert.equal(staleWrite.expectedVersion, stale.version);
    await commit(store, [staleWrite]);
    const ownerEffect: DomainWrite = { kind: 'insert', model: model('App.effect'),
      row: { ...intent, id: id('effect'), data: { value: 'must rollback' } } };
    await assert.rejects(store.commit(batch(revision, [ownerEffect, staleWrite])), FenceConflictError);
    const currentRevision = await store.readRevision();
    await assert.rejects(store.commit(batch(currentRevision, [ownerEffect, staleWrite])),
      error => error instanceof StorageConstraintError && error.kind === 'version');
    assert.equal(await store.load(model('App.effect'), id('effect')), null);
    assert.equal(await store.readRevision(), currentRevision);
    assert.equal(readFanoutNavigationRow(await navigation(store, intent), binding).lastVisitedChildId, children[1]!.id);
  });

  it('fails closed on owner, retained identity/version, child, cursor, and limit mismatches before writes', async () => {
    const { store, intent, otherIntent, children, binding } = await world();
    const staged = stageFanoutNavigationWrite({ ...binding, row: null, visitedChildRow: children[0]!, meta });
    if (staged.kind !== 'insert') throw new Error('expected navigation insert');
    const row = staged.row;
    const check = (candidate: StoredRow, bound = binding) => () => readFanoutNavigationRow(candidate, bound);
    for (const field of ['owner', 'fanoutId', 'sourceOccurrence', 'handler', 'cohort', 'intentVersion']) {
      assert.throws(check({ ...row, data: { ...row.data, [field]: 'wrong' } }), validation);
    }
    assert.throws(check({ ...row, id: id('wrong') }), validation);
    assert.throws(check(row, { owner: 'other-owner', intentRow: intent }), validation);
    assert.throws(check(row, { owner, intentRow: otherIntent }), validation);
    assert.throws(check(row, { owner, intentRow: { ...intent, version: (intent.version + 1) as typeof intent.version } }), validation);
    assert.throws(check({ ...row, data: { ...row.data, lastVisitedChildId: 'outside' } }), validation);
    const unrelated = newFanoutChildRow({ fanoutId: otherIntent.id, parentOccurrence: 'source/b',
      handler: 'App.each', recordId: 'a' }, meta);
    for (const child of [unrelated, { ...children[0]!, id: id('wrong') },
      newFanoutChildRow({ fanoutId: intent.id, parentOccurrence: 'source/a', handler: 'App.each', recordId: 'outside' }, meta)]) {
      assert.throws(() => stageFanoutNavigationWrite({ ...binding, row: null, visitedChildRow: child, meta }), validation);
    }
    assert.throws(() => stageFanoutNavigationWrite({ ...binding, row, visitedChildRow: children[0]!, meta }), validation);
    const scan = stageFanoutOwnerScanWrite({ row: null, owner, visitedIntentRow: intent, meta });
    if (scan.kind !== 'insert') throw new Error('expected owner scan insert');
    assert.throws(() => readFanoutOwnerScanRow(scan.row, 'other-owner'), validation);
    assert.throws(() => readFanoutOwnerScanRow({ ...scan.row, data: { owner, lastVisitedIntentId: 'fanout/v1/%ZZ/h/model' } }, owner), validation);
    assert.throws(() => stageFanoutOwnerScanWrite({ row: scan.row, owner, visitedIntentRow: intent, meta }), validation);
    for (const limit of [0, -1, 1.5, Infinity]) {
      assert.throws(() => fanoutNavigationChildQuery({ ...binding, row: null, limit }), validation);
      assert.throws(() => fanoutOwnerIntentQuery({ row: null, owner, limit }), validation);
    }
    assert.equal(await store.load(model(FANOUT_NAVIGATION_MODEL), row.id), null);
    assert.equal(await store.load(model(FANOUT_OWNER_SCAN_MODEL), scan.row.id), null);
  });
});
