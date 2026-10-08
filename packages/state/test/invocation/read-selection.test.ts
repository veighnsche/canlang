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
    order: [{ field: 'score', direction: 'desc' }],
  } as unknown as ReadSelection;
  const served = await world.reader({ ...world.args, selection });
  assert.deepEqual(served.records.map((record) => record.data), [{ title: 'Second', score: 20 }]);
  assert.equal(world.scans.length, 1);
  assert.equal(world.scans[0]!.model, model);
  assert.equal(world.scans[0]!.authority, 'viewer');
  assert.equal(world.scans[0]!.archived, 'exclude');
});


test('trusted sync and async source predicates run on visible AST matches before limit', async () => {
  const world = await setup();
  for (const asynchronous of [false, true]) {
    const visited: string[] = [];
    const accept = (record: Parameters<NonNullable<ReadSelection['predicate']>>[0]) => {
      visited.push(record.id);
      assert.equal(Object.hasOwn(record.data, 'note'), false);
      return record.data['score'] === 20;
    };
    const served = await world.reader({ ...world.args, selection: {
      where: { op: 'gte', field: 'score', value: 20 }, limit: 1,
      predicate: asynchronous ? async (record) => accept(record) : accept,
    } });
    assert.deepEqual(visited, ['b']);
    assert.deepEqual(served.records.map((record) => record.id), ['b']);
    assert.equal(served.revision, 1);
  }
  const overflow = await captureStateError(world.reader({ ...world.args,
    selection: { predicate: () => true, limit: 1 },
  }));
  assert.match(overflow.message, /over the limit/);
  assert.equal(world.scans.length, 3);
  for (const scan of world.scans) {
    assert.equal(Object.hasOwn(scan, 'predicate'), false);
    assert.equal(Object.hasOwn(scan, 'limit'), false);
  }
});

test('trusted source predicate shape and boolean results fail closed', async () => {
  const world = await setup();
  for (const predicate of [null, {}, 'function']) {
    const error = await captureStateError(world.reader({ ...world.args,
      selection: { predicate } as unknown as ReadSelection,
    }));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /trusted host function/);
  }
  assert.equal(world.scans.length, 0);
  for (const predicate of [() => 1, async () => 'true', () => undefined]) {
    const error = await captureStateError(world.reader({ ...world.args,
      selection: { predicate } as unknown as ReadSelection,
    }));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /return a boolean/);
  }
});


test('bound read forwards exact authorized ordering and fails rather than truncating at the limit', async () => {
  const world = await setup();
  const order: NonNullable<ReadSelection['order']> = [{ field: 'score', direction: 'desc' }];
  const served = await world.reader({ ...world.args, selection: { order, limit: 2 } });
  assert.deepEqual(served.records.map((record) => record.id), ['b', 'a']);
  assert.deepEqual(world.scans[0]!.order, order);
  const overflow = await captureStateError(world.reader({ ...world.args, selection: { order, limit: 1 } }));
  assert.match(overflow.message, /over the limit/);
  assert.equal(world.scans.length, 2);
  assert.equal(Object.hasOwn(world.scans[1]!, 'limit'), false);
  const denied = await captureStateError(world.reader({ ...world.args,
    selection: { order: [{ field: 'note', direction: 'desc' }] },
  }));
  assert.equal(denied.code, 'validation');
  assert.match(denied.message, /not granted/);
  const malformed = await captureStateError(world.reader({ ...world.args,
    selection: { order: ['score'] } as unknown as ReadSelection,
  }));
  assert.equal(malformed.code, 'validation');
  assert.match(malformed.message, /Invalid order direction/);
  assert.equal(world.scans.length, 2);
  const selection: ReadSelection = { get order(): never { throw new Error('order evaluated before admission'); } };
  const closed = await captureStateError(world.reader({ ...world.args,
    envelope: { operation, inputs: { bogus: true } }, selection,
  }));
  assert.deepEqual(fieldPaths(closed), ['/bogus']);
});
