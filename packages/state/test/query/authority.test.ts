/**
 * Lane 03 S4 authority tests (worker B): owner-authority reads return full
 * pre-projection rows, honor the archived flag, and report the fence
 * revision. Memory StoragePort + local membership double.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { queryAggregate, queryRecords } from '../../src/query/index.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import {
  FIXED_NOW,
  asModel,
  aggregateInput,
  grant,
  modelPolicy,
  ownerInput,
  policyTable,
  secret,
  seedRows,
  seedStandardTeam,
  viewerInput,
} from './fixtures.js';

const MODEL = asModel('Acme.Invoice');

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
  return { store, std, call };
}

describe('authority', () => {
  it('reads full rows with where on denied fields', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { title: 'A', total: 50, note: 'denied-a' } },
      { id: 'rec-2', data: { title: 'B', total: 150, note: 'denied-b' } },
    ]);
    const owned = await queryRecords(
      ownerInput({ ...s.call, caller: s.std.owner, where: { op: 'gt', field: 'total', value: 100 } }),
    );
    assert.equal(owned.rows.length, 1);
    assert.deepEqual(owned.rows[0]!.data, { title: 'B', total: 150, note: 'denied-b' });
  });

  it('reads secret paths with where on secrets', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { title: 'A', token: secret() } },
    ]);
    const owned = await queryRecords(
      ownerInput({
        ...s.call,
        caller: s.std.owner,
        where: { op: 'not_null', field: 'token' },
      }),
    );
    assert.equal(owned.rows.length, 1);
    assert.deepEqual(owned.rows[0]!.data, { title: 'A', token: { kind: 'secret' } });
  });

  it('honors the archived flag', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, [
      { id: 'rec-live', created: FIXED_NOW, data: { title: 'Live' } },
      { id: 'rec-archived', created: FIXED_NOW + 1, archivedAt: FIXED_NOW, data: { title: 'Old' } },
    ]);
    const excluded = await queryRecords(ownerInput({ ...s.call, caller: s.std.owner }));
    assert.deepEqual(
      excluded.rows.map((row) => row.id),
      ['rec-live'],
    );
    const included = await queryRecords(
      ownerInput({ ...s.call, caller: s.std.owner, archived: 'include' }),
    );
    assert.deepEqual(
      included.rows.map((row) => row.id),
      ['rec-live', 'rec-archived'],
    );
  });

  it('reports the store revision on viewer, owner, and aggregate reads', async () => {
    const s = await setup();
    await seedRows(s.store, MODEL, [{ id: 'rec-1', data: { title: 'A', total: 7 } }]);
    const revision = await s.store.readRevision();
    const viewed = await queryRecords(viewerInput({ ...s.call, caller: s.std.alice }));
    assert.equal(viewed.revision, revision);
    const owned = await queryRecords(ownerInput({ ...s.call, caller: s.std.owner }));
    assert.equal(owned.revision, revision);
    const counted = await queryAggregate(
      aggregateInput({ ...s.call, caller: s.std.alice, spec: { op: 'count' } }),
    );
    assert.equal(counted.revision, revision);

    await seedRows(s.store, MODEL, [{ id: 'rec-2', data: { title: 'B', total: 8 } }]);
    const next = await s.store.readRevision();
    assert.ok((next as number) > (revision as number));
    const again = await queryRecords(viewerInput({ ...s.call, caller: s.std.alice }));
    assert.equal(again.revision, next);
  });

  it('evaluation-style reads see pre-projection values', async () => {
    const s = await setup();
    const seeded = {
      title: 'A',
      total: 42,
      note: 'denied',
      token: secret(),
      nested: { status: 'open', handle: 'h-9' },
    };
    await seedRows(s.store, MODEL, [{ id: 'rec-1', data: seeded }]);
    const owned = await queryRecords(ownerInput({ ...s.call, caller: s.std.owner }));
    assert.equal(owned.rows.length, 1);
    assert.deepEqual(owned.rows[0]!.data, {
      title: 'A',
      total: 42,
      note: 'denied',
      token: { kind: 'secret' },
      nested: { status: 'open', handle: 'h-9' },
    });
  });
});
