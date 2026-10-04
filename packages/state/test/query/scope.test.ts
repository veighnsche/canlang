/**
 * Lane 03 S4 scope tests (worker B): archived filtering, stable default
 * ordering, limit overflow (never truncation), grant coverage of where/order
 * paths, and the authority bypass. Memory StoragePort + local membership
 * double.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { queryRecords } from '../../src/query/index.js';
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
});
