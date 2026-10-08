import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelName, QuerySpec, StoragePort } from '@canlang/contracts';
import { invokeRead, type ReadSelection } from '../../src/invocation/invoke.js';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { createReadInvoker } from '../../src/ports/transact.js';
import { createTestMemoryStorage } from '../../src/storage/memory.js';
import { grant, modelPolicy, policyTable, seedRows } from '../query/fixtures.js';
import { captureStateError, createMemoryIdentityStore, fieldPaths, makeIdentity, seedMember } from './fixtures.js';

const model = 'Example.Doc' as ModelName;
const operation = `${model}.read`;

function slice(): ArtifactDescriptorSlice {
  return {
    artifact_version: 1,
    models: [{ name: model, fields: [], deleteMode: 'archive' }],
    operations: [{ name: operation, kind: 'read', description: '', inputs: { fields: [] } }],
  };
}

async function setup() {
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  await seedRows(store, model, [
    { id: 'a', data: { title: 'First', score: 10, note: 'private-a' } },
    { id: 'b', data: { title: 'Second', score: 20, note: 'private-b' } },
    { id: 'c', archivedAt: 1, data: { title: 'Archived', score: 30, note: 'private-c' } },
  ]);
  const scans: QuerySpec[] = [];
  const observed: StoragePort = { ...store, query: async (spec) => {
    scans.push(spec);
    return store.query(spec);
  } };
  const registry = loadArtifactDescriptors(slice(), { by: 'members' }).registry;
  const policy = policyTable(modelPolicy(model, { grants: [grant('members', ['title', 'score'])] }));
  const identity = makeIdentity({ membership: alice.membership, email: alice.user.email });
  const dependencies = { registry, policy, store: observed, memberships };
  const args = { envelope: { operation, inputs: {} }, identity };
  return { ...dependencies, alice, scans, args, reader: createReadInvoker(dependencies) };
}

test('bound read selection filters projected records in one scan and preserves the fence revision', async () => {
  const world = await setup();
  const served = await world.reader({ ...world.args,
    selection: { where: { op: 'gte', field: 'score', value: 20 }, limit: 1 },
  });
  assert.deepEqual(served.records.map((record) => record.data), [{ title: 'Second', score: 20 }]);
  assert.equal(served.revision, 1);
  assert.equal(world.scans.length, 1);
  assert.equal(world.scans[0]!.authority, 'viewer');
  assert.equal(world.scans[0]!.archived, 'exclude');
  // The owning query engine filters after visibility and never truncates storage scans.
  assert.equal(Object.hasOwn(world.scans[0]!, 'where'), false);
  assert.equal(Object.hasOwn(world.scans[0]!, 'limit'), false);
});

test('absent selection keeps the existing whole visible model result', async () => {
  const world = await setup();
  const bound = await world.reader(world.args);
  const direct = await invokeRead({ ...world, ...world.args });
  assert.deepEqual(bound, direct);
  assert.deepEqual(bound.records.map((record) => record.data), [
    { title: 'First', score: 10 }, { title: 'Second', score: 20 },
  ]);
  assert.equal(world.scans.length, 2);
});

test('query engine owns limit overflow, malformed predicates and viewer field restrictions', async () => {
  const world = await setup();
  const invalidLimit = await captureStateError(world.reader({ ...world.args, selection: { limit: -1 } }));
  assert.match(invalidLimit.message, /Invalid query limit/);
  const invalidPredicate = await captureStateError(world.reader({ ...world.args,
    selection: { where: { op: 'unsupported' } } as unknown as ReadSelection,
  }));
  assert.match(invalidPredicate.message, /Unknown query predicate/);
  const privateField = await captureStateError(world.reader({ ...world.args,
    selection: { where: { op: 'eq', field: 'note', value: 'private-b' } },
  }));
  assert.equal(privateField.code, 'validation');
  assert.equal(world.scans.length, 0);
  const overflow = await captureStateError(world.reader({ ...world.args, selection: { limit: 1 } }));
  assert.equal(overflow.code, 'validation');
  assert.match(overflow.message, /over the limit/);
  assert.equal(world.scans.length, 1);
});

test('routing, live membership and closed-input failures precede reading selection fields', async () => {
  const world = await setup();
  const selection: ReadSelection = { get where(): never { throw new Error('selection evaluated before admission'); } };
  const closed = await captureStateError(world.reader({ ...world.args,
    envelope: { operation, inputs: { bogus: true } }, selection,
  }));
  assert.equal(closed.code, 'validation');
  assert.deepEqual(fieldPaths(closed), ['/bogus']);
  await world.memberships.removeMembership(world.alice.membership.membership_id);
  const denied = await captureStateError(world.reader({ ...world.args,
    envelope: { operation, inputs: { bogus: true } }, selection,
  }));
  assert.equal(denied.code, 'forbidden');
  const unknown = await captureStateError(world.reader({ ...world.args,
    envelope: { operation: 'Example.Missing.read', inputs: { bogus: true } }, selection,
  }));
  assert.equal(unknown.code, 'validation');
  assert.match(unknown.message, /Unknown operation/);
  assert.equal(world.scans.length, 0);
});

test('descriptor read inputs still validate closed shape and then refuse unsupported serving', async () => {
  const world = await setup();
  const raw = slice();
  raw.operations![0]!.inputs.fields.push({ name: 'q', field: { kind: 'string' }, required: false });
  const reader = createReadInvoker({ ...world, registry: loadArtifactDescriptors(raw, { by: 'members' }).registry });
  const selection: ReadSelection = { get where(): never { throw new Error('selection evaluated before descriptor refusal'); } };
  const closed = await captureStateError(reader({ ...world.args,
    envelope: { operation, inputs: { bogus: true } }, selection,
  }));
  assert.deepEqual(fieldPaths(closed), ['/bogus']);
  const unsupported = await captureStateError(reader({ ...world.args, selection }));
  assert.equal(unsupported.code, 'validation');
  assert.match(unsupported.message, /T04b carries filter inputs/);
  assert.equal(world.scans.length, 0);
});

test('selection cannot override viewer authority, bound dependencies, archive mode or fences', async () => {
  const world = await setup();
  const selection = {
    where: { op: 'gte', field: 'score', value: 20 }, limit: 1,
    authority: 'owner', model: 'Example.Other', archived: 'include',
    context: { actorUserId: null, teamId: null }, memberships: null,
    store: { query() { throw new Error('forged store used'); } },
    fence: { join() { throw new Error('forged fence used'); } },
    order: [{ field: 'note', direction: 'desc' }],
  } as unknown as ReadSelection;
  const served = await world.reader({ ...world.args, selection });
  assert.deepEqual(served.records.map((record) => record.data), [{ title: 'Second', score: 20 }]);
  assert.equal(world.scans.length, 1);
  assert.equal(world.scans[0]!.model, model);
  assert.equal(world.scans[0]!.authority, 'viewer');
  assert.equal(world.scans[0]!.archived, 'exclude');
});
