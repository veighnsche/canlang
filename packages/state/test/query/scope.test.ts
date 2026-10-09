/**
 * Lane 03 S4 scope tests (worker B): archived filtering, stable default
 * ordering, limit overflow (never truncation), grant coverage of where/order
 * paths, and the authority bypass. Memory StoragePort + local membership
 * double.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { OrderTerm, RecordId } from '@canlang/contracts';
import { queryRecords, queryRecordsPage } from '../../src/query/index.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { captureStateError } from '../invocation/fixtures.js';
import {
  FIXED_NOW,
  asModel,
  grant,
  modelPolicy,
  ownerInput,
  policyTable,
  seedRows,
  seedStandardTeam,
  viewerInput,
} from './fixtures.js';

const MODEL = asModel('Acme.Task');

async function setup() {
  const store = createMemoryStorage();
  const std = await seedStandardTeam();
  const policy = policyTable(modelPolicy(MODEL, { grants: [grant('members', ['title'])] }));
  const call = {
    store,
    memberships: std.memberships,
    policy,
    model: MODEL,
    scope: std.team,
  };
  return { store, std, policy, call };
}

type Setup = Awaited<ReturnType<typeof setup>>;

describe('scope', () => {
  it('pages the projected visible set with a terminal step and preserves ordinary overflow', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, [
      { id: 'a', data: { title: 'First', secret: 'hidden' } },
      { id: 'b', data: { title: 'Second', secret: 'hidden' } },
      { id: 'c', archivedAt: FIXED_NOW, data: { title: 'Archived' } },
    ]);
    const input = viewerInput({ ...s.call, caller: s.std.alice });
    const first = await queryRecordsPage({ ...input, selection: { limit: 1 } });
    assert.deepEqual(first.records.map(row => row.data), [{ title: 'First' }]);
    assert.deepEqual(first.continuation, { revision: first.revision, after: 'a' });
    const last = await queryRecordsPage({ ...input, selection: { limit: 1, continuation: first.continuation! } });
    assert.deepEqual(last.records.map(row => row.id), ['b']);
    assert.equal(last.continuation, null);
    const overflow = await captureStateError(queryRecords({ ...input, limit: 1 }));
    assert.equal(overflow.code, 'validation');
    const invisiblePosition = await captureStateError(queryRecordsPage({ ...input,
      selection: { continuation: { revision: first.revision, after: 'c' as RecordId } },
    }));
    assert.equal(invisiblePosition.code, 'conflict');
    await seedRows(s.store, MODEL, [{ id: 'd', data: { title: 'New' } }]);
    assert.equal((await captureStateError(queryRecordsPage({ ...input,
      selection: { continuation: first.continuation! },
    }))).code, 'conflict');
  });

  it('caps materialized candidates before projection/filtering and refuses partial scans', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, Array.from({ length: 1001 }, (_, index) => ({
      id: String(index).padStart(4, '0'), data: { title: String(index) },
    })));
    let observedLimit: number | undefined;
    let pushedWhere = false;
    const store = { ...s.store, query: async (spec: Parameters<typeof s.store.query>[0]) => {
      observedLimit = spec.limit;
      pushedWhere = Object.hasOwn(spec, 'where');
      return s.store.query(spec);
    } };
    const error = await captureStateError(queryRecordsPage({
      ...viewerInput({ ...s.call, caller: s.std.alice }), store,
      selection: { where: { op: 'eq', field: 'title', value: '0' }, limit: 1 },
    }));
    assert.equal(error.code, 'limit');
    assert.equal(observedLimit, 1001);
    assert.equal(pushedWhere, false);
    assert.doesNotMatch(error.message, /1001/);
  });

  it('page-only finite operands and page size checks leave ordinary AST behavior unchanged', async () => {
    const s = await setup();
    const input = viewerInput({ ...s.call, caller: s.std.alice });
    for (const value of [NaN, Infinity, -Infinity]) {
      assert.equal((await captureStateError(queryRecordsPage({ ...input,
        selection: { where: { op: 'eq', field: 'created', value } },
      }))).code, 'validation');
    }
    for (const limit of [0, 101, 1.5]) {
      assert.equal((await captureStateError(queryRecordsPage({ ...input, selection: { limit } }))).code, 'validation');
    }
    assert.equal((await captureStateError(queryRecordsPage({ ...input,
      selection: { order: new Array<OrderTerm>(1) },
    }))).code, 'validation');
    const defaultPage = await queryRecordsPage(input);
    assert.deepEqual(defaultPage.records, []);
    assert.equal(defaultPage.continuation, null);
  });
  it('excludes archived rows by default', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, [
      { id: 'rec-live', data: { title: 'Live' } },
      { id: 'rec-archived', archivedAt: FIXED_NOW, data: { title: 'Old' } },
    ]);
    const seen = await queryRecords(viewerInput({ ...s.call, caller: s.std.alice }));
    assert.deepEqual(
      seen.records.map((record) => record.id),
      ['rec-live'],
    );
  });

  it('archived=include returns archived rows too', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, [
      { id: 'rec-live', created: FIXED_NOW, data: { title: 'Live' } },
      { id: 'rec-archived', created: FIXED_NOW + 1, archivedAt: FIXED_NOW, data: { title: 'Old' } },
    ]);
    const seen = await queryRecords(
      viewerInput({ ...s.call, caller: s.std.alice, archived: 'include' }),
    );
    assert.deepEqual(
      seen.records.map((record) => record.id),
      ['rec-live', 'rec-archived'],
    );
    assert.equal(seen.records[1]!.archivedAt, FIXED_NOW);
  });

  it('orders by created ascending by default', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, [
      { id: 'rec-c', created: FIXED_NOW + 2, data: { title: 'C' } },
      { id: 'rec-a', created: FIXED_NOW, data: { title: 'A' } },
      { id: 'rec-b', created: FIXED_NOW + 1, data: { title: 'B' } },
    ]);
    const seen = await queryRecords(viewerInput({ ...s.call, caller: s.std.alice }));
    assert.deepEqual(
      seen.records.map((record) => record.id),
      ['rec-a', 'rec-b', 'rec-c'],
    );
  });

  it('breaks created ties by id for stable ordering', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, [
      { id: 'rec-3', created: FIXED_NOW, data: { title: 'C' } },
      { id: 'rec-1', created: FIXED_NOW, data: { title: 'A' } },
      { id: 'rec-2', created: FIXED_NOW, data: { title: 'B' } },
    ]);
    const seen = await queryRecords(viewerInput({ ...s.call, caller: s.std.alice }));
    assert.deepEqual(
      seen.records.map((record) => record.id),
      ['rec-1', 'rec-2', 'rec-3'],
    );
  });

  it('passes a limit that exactly covers the matched set', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { title: 'A' } },
      { id: 'rec-2', data: { title: 'B' } },
    ]);
    const seen = await queryRecords(viewerInput({ ...s.call, caller: s.std.alice, limit: 2 }));
    assert.equal(seen.records.length, 2);
  });

  it('fails over-limit queries instead of truncating', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { title: 'A' } },
      { id: 'rec-2', data: { title: 'B' } },
    ]);
    const failure = await captureStateError(
      queryRecords(viewerInput({ ...s.call, caller: s.std.alice, limit: 1 })),
    );
    assert.equal(failure.code, 'validation');
  });

  it('rejects invalid limits', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, [{ id: 'rec-1', data: { title: 'A' } }]);
    for (const limit of [-1, 1.5]) {
      const failure = await captureStateError(
        queryRecords(viewerInput({ ...s.call, caller: s.std.alice, limit })),
      );
      assert.equal(failure.code, 'validation');
    }
  });

  it('rejects where/order on ungranted data paths', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, [{ id: 'rec-1', data: { title: 'A', amount: 5 } }]);
    const whereFailure = await captureStateError(
      queryRecords(
        viewerInput({
          ...s.call,
          caller: s.std.alice,
          where: { op: 'eq', field: 'amount', value: 5 },
        }),
      ),
    );
    assert.equal(whereFailure.code, 'validation');
    const orderFailure = await captureStateError(
      queryRecords(
        viewerInput({
          ...s.call,
          caller: s.std.alice,
          order: [{ field: 'amount', direction: 'desc' }],
        }),
      ),
    );
    assert.equal(orderFailure.code, 'validation');
  });

  it('allows where/order on id and metadata', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', created: FIXED_NOW, data: { title: 'A' } },
      { id: 'rec-2', created: FIXED_NOW + 1, data: { title: 'B' } },
    ]);
    const byId = await queryRecords(
      viewerInput({
        ...s.call,
        caller: s.std.alice,
        where: { op: 'eq', field: 'id', value: 'rec-2' },
      }),
    );
    assert.deepEqual(
      byId.records.map((record) => record.id),
      ['rec-2'],
    );
    const byCreated = await queryRecords(
      viewerInput({
        ...s.call,
        caller: s.std.alice,
        order: [{ field: 'created', direction: 'desc' }],
      }),
    );
    assert.deepEqual(
      byCreated.records.map((record) => record.id),
      ['rec-2', 'rec-1'],
    );
  });

  it('authority queries bypass grant-coverage checks', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { title: 'A', amount: 5 } },
      { id: 'rec-2', data: { title: 'B', amount: 9 } },
    ]);
    const owned = await queryRecords(
      ownerInput({
        ...s.call,
        caller: s.std.owner,
        where: { op: 'gt', field: 'amount', value: 6 },
        order: [{ field: 'amount', direction: 'desc' }],
      }),
    );
    assert.deepEqual(
      owned.rows.map((row) => row.id),
      ['rec-2'],
    );
    assert.deepEqual(owned.rows[0]!.data, { title: 'B', amount: 9 });
  });

  it('an unknown predicate op is a validation StateError, not a crash', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, [{ id: 'rec-1', data: { title: 'A' } }]);
    const failure = await captureStateError(
      queryRecords(
        viewerInput({
          ...s.call,
          caller: s.std.alice,
          where: { op: 'bogus' as 'eq', field: 'title', value: 'A' },
        }),
      ),
    );
    assert.equal(failure.code, 'validation');
  });

  it('a non-string where field is validation on both authorities, not a crash', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, [{ id: 'rec-1', data: { title: 'A' } }]);
    const bad = { op: 'eq' as const, field: 5 as unknown as string, value: 'A' };
    const viewerFailure = await captureStateError(
      queryRecords(viewerInput({ ...s.call, caller: s.std.alice, where: bad })),
    );
    assert.equal(viewerFailure.code, 'validation');
    const ownerFailure = await captureStateError(
      queryRecords(ownerInput({ ...s.call, caller: s.std.owner, where: bad })),
    );
    assert.equal(ownerFailure.code, 'validation');
  });
});
