/**
 * Lane 03 S6 read-port tests: the bound port delegates to the query engine
 * (viewer projection, owner rows, overflow, aggregates) and to the store
 * for receipt/revision reads. Thin but real: every method is exercised
 * against committed state.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReadPort, type ReadViewerRecordsArgs } from '../../src/ports/index.js';
import {
  createMemoryIdentityStore,
  makeReceipt,
  makeReceiptIdentity,
  seedReceipt,
} from '../invocation/fixtures.js';
import {
  captureStateError,
  grant,
  modelPolicy,
  policyTable,
  seedRows,
  setupReadWorld,
} from './fixtures.js';

const ROWS = [
  { id: 'doc-1', data: { title: 'First', score: 10, note: 'secret-a' } },
  { id: 'doc-2', data: { title: 'Second', score: 20, note: 'secret-b' } },
];

describe('createReadPort', () => {
  it('projects viewer records to granted leaves; denied leaves are absent', async () => {
    const world = await setupReadWorld();
    await seedRows(world.store, world.model, ROWS);
    const port = createReadPort({
      policy: policyTable(modelPolicy(world.model, { grants: [grant('members', ['title', 'score'])] })),
      store: world.store,
      memberships: world.memberships,
    });
    const out = await port.queryRecords({
      authority: 'viewer',
      model: world.model,
      context: { actorUserId: world.alice.user.user_id, teamId: world.team.team_id },
    });
    assert.equal(out.records.length, 2);
    assert.deepEqual(out.records[0]?.data, { title: 'First', score: 10 });
    assert.ok(out.records[0] !== undefined && !('note' in out.records[0].data));
    assert.equal(out.revision, 1);
  });

  it('shows a viewer with no matching grant zero rows', async () => {
    const world = await setupReadWorld();
    await seedRows(world.store, world.model, ROWS);
    const port = createReadPort({
      policy: policyTable(
        modelPolicy(world.model, { grants: [grant({ role: 'Acme.reviewer' }, ['title'])] }),
      ),
      store: world.store,
      memberships: world.memberships,
    });
    const out = await port.queryRecords({
      authority: 'viewer',
      model: world.model,
      context: { actorUserId: world.alice.user.user_id, teamId: world.team.team_id },
    });
    assert.deepEqual(out.records, []);
  });

  it('lets bound dependencies win over smuggled per-call extras', async () => {
    const world = await setupReadWorld();
    await seedRows(world.store, world.model, ROWS);
    const port = createReadPort({
      policy: policyTable(modelPolicy(world.model, { grants: [grant('members', ['title'])] })),
      store: world.store,
      memberships: world.memberships,
    });
    // Each smuggled dep would change the outcome if honored: empty policy and
    // empty memberships would show zero rows, and the throwing store would
    // explode. The cast models an untyped JS caller sneaking extras past Omit.
    const smuggled = {
      authority: 'viewer',
      model: world.model,
      context: { actorUserId: world.alice.user.user_id, teamId: world.team.team_id },
      policy: policyTable(modelPolicy(world.model, { grants: [] })),
      store: {
        query: () => {
          throw new Error('smuggled store must not be called');
        },
      },
      memberships: createMemoryIdentityStore(),
    } as unknown as ReadViewerRecordsArgs;
    const out = await port.queryRecords(smuggled);
    assert.equal(out.records.length, 2);
    assert.deepEqual(out.records[0]?.data, { title: 'First' });
  });

  it('returns full stored rows under owner authority', async () => {
    const world = await setupReadWorld();
    await seedRows(world.store, world.model, ROWS);
    const port = createReadPort({
      policy: policyTable(modelPolicy(world.model, { grants: [] })),
      store: world.store,
      memberships: world.memberships,
    });
    const out = await port.queryRecords({
      authority: 'owner',
      model: world.model,
      context: { actorUserId: world.alice.user.user_id, teamId: world.team.team_id },
    });
    assert.equal(out.rows.length, 2);
    assert.deepEqual(out.rows[0]?.data, { title: 'First', score: 10, note: 'secret-a' });
  });

  it('surfaces limit overflow instead of truncating', async () => {
    const world = await setupReadWorld();
    await seedRows(world.store, world.model, ROWS);
    const port = createReadPort({
      policy: policyTable(modelPolicy(world.model, { grants: [grant('members', ['title'])] })),
      store: world.store,
      memberships: world.memberships,
    });
    const error = await captureStateError(() =>
      port.queryRecords({
        authority: 'viewer',
        model: world.model,
        context: { actorUserId: world.alice.user.user_id, teamId: world.team.team_id },
        limit: 1,
      }),
    );
    assert.equal(error.code, 'validation');
  });

  it('passes where and order through to the engine', async () => {
    const world = await setupReadWorld();
    await seedRows(world.store, world.model, ROWS);
    const port = createReadPort({
      policy: policyTable(modelPolicy(world.model, { grants: [grant('members', ['title', 'score'])] })),
      store: world.store,
      memberships: world.memberships,
    });
    const context = { actorUserId: world.alice.user.user_id, teamId: world.team.team_id };
    const filtered = await port.queryRecords({
      authority: 'viewer',
      model: world.model,
      context,
      where: { op: 'eq', field: 'title', value: 'Second' },
    });
    assert.deepEqual(
      filtered.records.map((record) => record.id),
      ['doc-2'],
    );
    const ordered = await port.queryRecords({
      authority: 'viewer',
      model: world.model,
      context,
      order: [{ field: 'score', direction: 'desc' }],
    });
    assert.deepEqual(
      ordered.records.map((record) => record.id),
      ['doc-2', 'doc-1'],
    );
  });

  it('aggregates over the viewer-visible set', async () => {
    const world = await setupReadWorld();
    await seedRows(world.store, world.model, ROWS);
    const port = createReadPort({
      policy: policyTable(modelPolicy(world.model, { grants: [grant('members', ['title', 'score'])] })),
      store: world.store,
      memberships: world.memberships,
    });
    const context = { actorUserId: world.alice.user.user_id, teamId: world.team.team_id };
    const count = await port.queryAggregate({
      authority: 'viewer',
      model: world.model,
      context,
      spec: { op: 'count' },
    });
    assert.deepEqual(count.result, { op: 'count', value: 2 });
    const sum = await port.queryAggregate({
      authority: 'viewer',
      model: world.model,
      context,
      spec: { op: 'sum', field: 'score' },
    });
    assert.deepEqual(sum.result, { op: 'sum', value: 30 });
  });

  it('round-trips receipts and reports null on a miss', async () => {
    const world = await setupReadWorld();
    const port = createReadPort({
      policy: policyTable(modelPolicy(world.model, { grants: [] })),
      store: world.store,
      memberships: world.memberships,
    });
    const receipt = makeReceipt({ operationId: 'op-read-1', committedRevision: 1 });
    await seedReceipt(world.store, receipt);
    assert.deepEqual(await port.readReceipt(receipt.identity), receipt);
    assert.equal(await port.readReceipt(makeReceiptIdentity({ operationId: 'op-missing' })), null);
  });

  it('reads the same fence revision as the store', async () => {
    const world = await setupReadWorld();
    const port = createReadPort({
      policy: policyTable(modelPolicy(world.model, { grants: [] })),
      store: world.store,
      memberships: world.memberships,
    });
    assert.equal(await port.readRevision(), 0);
    await seedRows(world.store, world.model, ROWS.slice(0, 1));
    assert.equal(await port.readRevision(), 1);
    assert.equal(await port.readRevision(), await world.store.readRevision());
  });
});
