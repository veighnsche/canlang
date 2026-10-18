/** Literal State consumer fixtures; these do not attest emitted native adapters. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelName } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { makeUserRef } from '@canlang/values';
import { invokeRead, invokeReadPage, type InvokeReadInput, type InvokeReadPageInput, type ViewerPageResult } from '../../src/invocation/invoke.js';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { createReadInvoker, createReadPageInvoker } from '../../src/ports/transact.js';
import { bindInstalledSourceQueryPredicate, bindReadPolicyMembershipProducer, type InstalledSourceQueryPredicate } from '../../src/receipt/read-policy-membership.js';
import type { ViewerGenerationCallbackSourceReadPolicy, ViewerSourceReadPolicy } from '../../src/query/source-policy.js';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { FIXED_NOW, asId, makeBatch, makeIdentity, makeRow } from './fixtures.js';

const MODEL = 'Creative.Run' as ModelName, PARENT = 'Creative.Project' as ModelName, TEAM = 'source-team';
const producer = { source: { path: 'creative.can', sha256: 'a'.repeat(64), module: 'creative.mjs' }, rule: 'Creative.App.filter' };
const refuses = (error: unknown) => error instanceof StateError;
type SourcePolicy = ViewerGenerationCallbackSourceReadPolicy;
function mark(read: InstalledSourceQueryPredicate): InstalledSourceQueryPredicate {
  bindInstalledSourceQueryPredicate(read, producer); return read;
}
async function setup() {
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const roles = [{ role: 'Creative.reviewer', granted_at: new Date(FIXED_NOW).toISOString(), granted_by: 'caller' }];
  const caller = await memberships.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: false, roles });
  const author = await memberships.createMembership({ team_id: TEAM, user_id: 'author', is_owner: false, roles });
  const store = createMemoryStorage();
  const parent = makeRow({ id: 'project', data: { title: 'Project' } });
  const rows = ['a', 'b'].map((id) => ({ ...makeRow({ id, data: {
    title: id === 'a' ? 'Alpha' : 'Beta', author: 'author', private_prompt: 'SECRET',
    settings: { label: id, token: 'TOKEN' },
  } }), parent: { model: PARENT, id: parent.id } }));
  await store.commit(makeBatch(await store.readRevision(), { writes: [
    { kind: 'insert', model: PARENT, row: parent }, ...rows.map(row => ({ kind: 'insert' as const, model: MODEL, row })),
  ] }));
  const raw: ArtifactDescriptorSlice = { artifact_version: 1,
    models: [{ name: MODEL, parent: PARENT, fields: [], deleteMode: 'archive' },
      { name: PARENT, fields: [], deleteMode: 'archive' }],
    operations: [MODEL, PARENT].map(name => ({ name: `${name}.read`, kind: 'read' as const, description: '', inputs: { fields: [] } })),
  };
  const loaded = loadArtifactDescriptors(raw, { by: 'members' });
  const current: SourcePolicy = { parent: PARENT, fields: ['title', 'author', 'private_prompt', 'settings'],
    secretFields: ['private_prompt', 'settings.token'], grants: [{ fields: ['title', 'author', 'settings'], read: async () => true }] };
  const parentRead: SourcePolicy = { fields: ['title'], secretFields: [], grants: [{ fields: ['title'], read: async () => true }] };
  const sourceReadPolicies = new Map<ModelName, ViewerSourceReadPolicy>([[MODEL, current], [PARENT, parentRead]]);
  const dependencies = { ...loaded, policy: new Map(), store, memberships, sourceReadPolicies };
  const args = { envelope: { operation: `${MODEL}.read`, inputs: {} }, identity: makeIdentity({ membership: caller }) };
  return { dependencies, args, memberships, caller, author, store, current, parentRead, sourceReadPolicies, parent };
}
const selection = { parent: { model: PARENT, id: asId('project') }, limit: 100 };

test('canonical factory and direct ordinary/page reads forward source child and live parent policies', async () => {
  for (const route of ['ordinary', 'page', 'direct-ordinary', 'direct-page'] as const) for (const allowed of [true, false]) {
    const s = await setup();
    s.sourceReadPolicies.set(PARENT, { ...s.parentRead, grants: [{ fields: ['title'], read: async () => allowed }] });
    const read = () => route === 'ordinary' ? createReadInvoker(s.dependencies)(s.args)
      : route === 'page' ? createReadPageInvoker(s.dependencies)({ ...s.args, selection })
      : route === 'direct-ordinary' ? invokeRead({ ...s.dependencies, ...s.args })
      : invokeReadPage({ ...s.dependencies, ...s.args, selection });
    if (!allowed && (route === 'page' || route === 'direct-page')) await assert.rejects(read(), refuses);
    else {
      const result = await read();
      assert.deepEqual(result.records.map(row => row.data), allowed
        ? [{ title: 'Alpha', author: 'author', settings: { label: 'a' } }, { title: 'Beta', author: 'author', settings: { label: 'b' } }] : []);
    }
  }
});

test('read factories detach source maps, declarations, selectors and functions at construction', async () => {
  for (const page of [false, true]) {
    const s = await setup(), reader = page ? createReadPageInvoker(s.dependencies) : createReadInvoker(s.dependencies);
    const fields = s.current.grants[0]!.fields as string[];
    fields.splice(0, fields.length, 'private_prompt');
    (s.current.grants[0] as { read: SourcePolicy['grants'][number]['read'] }).read = async () => false;
    s.sourceReadPolicies.clear();
    const result = page ? await reader({ ...s.args, selection }) : await reader(s.args);
    assert.equal(result.records.length, 2);
    assert.equal(Object.hasOwn(result.records[0]!.data, 'private_prompt'), false);
    assert.equal(result.records[0]!.data.title, 'Alpha');
  }
});

test('direct invocations capture source declarations and exact predicate before admission yields', async () => {
  for (const page of [false, true]) {
    const s = await setup(); let mutated = false, calls = 0;
    const predicate = mark(async (record, observation) => { calls++; assert.ok(observation); return record.id === 'a'; });
    const input: InvokeReadPageInput & InvokeReadInput = { ...s.dependencies, ...s.args, selection: {}, generatedPredicate: predicate };
    // The two serving inputs differ only in their internal predicate carrier.
    const ordinary: InvokeReadInput = { ...input, selection: { predicate } };
    let pageInput: InvokeReadPageInput;
    const memberships = { ...s.memberships, findMembership: async (team: string, person: string) => {
      const fact = await s.memberships.findMembership(team, person);
      if (!mutated) {
        mutated = true; s.sourceReadPolicies.clear();
        (s.current.grants[0] as { read: SourcePolicy['grants'][number]['read'] }).read = async () => false;
        (pageInput as { generatedPredicate?: InstalledSourceQueryPredicate }).generatedPredicate = () => assert.fail('replaced predicate ran');
        (ordinary.selection as { predicate?: InstalledSourceQueryPredicate }).predicate = () => assert.fail('replaced predicate ran');
      }
      return fact;
    } };
    pageInput = { ...input, memberships };
    const result = page ? await invokeReadPage(pageInput) : await invokeRead({ ...ordinary, memberships });
    assert.deepEqual(result.records.map(row => row.id), ['a']); assert.equal(calls, 2);
  }
});

test('pure and caller-role marked predicates receive State observations without membership sites', async () => {
  for (const page of [false, true]) for (const role of [false, true]) {
    const s = await setup(), seen: string[] = [];
    const predicate = mark(async (record, observation) => {
      assert.ok(observation); seen.push(record.id);
      assert.notEqual(observation.context.memberships, s.memberships);
      assert.equal(observation.context.actorUserId, 'caller'); assert.equal(observation.context.teamId, TEAM);
      assert.equal(observation.revision, await s.store.readRevision());
      assert.equal(Object.hasOwn(observation.row.data, 'private_prompt'), false);
      assert.deepEqual(observation.row.data, record.data);
      return role ? observation.context.membership?.roles.some(grant => grant.role === 'Creative.reviewer') === true : record.id === 'a';
    });
    const where = { op: 'eq' as const, field: 'title', value: 'Alpha' };
    const result = page ? await createReadPageInvoker(s.dependencies)({ ...s.args, selection: { ...selection, where }, generatedPredicate: predicate })
      : await createReadInvoker(s.dependencies)({ ...s.args, selection: { where, predicate } });
    assert.deepEqual(result.records.map(row => row.id), ['a']); assert.deepEqual(seen, ['a']);
  }
});

test('marked predicates reject tracked second-subject revocation, State movement and nonboolean verdicts', async () => {
  for (const page of [false, true]) for (const mode of ['identity', 'state', 'boolean'] as const) {
    const s = await setup(); let changed = false;
    const predicate = mark(async (record, observation) => {
      assert.ok(observation);
      const member = await observation.context.memberships.findMembership(TEAM, record.data.author as string);
      if (!changed) {
        changed = true;
        if (mode === 'identity') await s.memberships.removeMembership(s.author.membership_id);
        if (mode === 'state') await s.store.commit(makeBatch(await s.store.readRevision(), { writes: [
          { kind: 'insert', model: MODEL, row: { ...makeRow({ id: 'new', data: { title: 'New' } }), parent: { model: PARENT, id: s.parent.id } } },
        ] }));
      }
      return mode === 'boolean' ? 'true' as unknown as boolean : member?.status === 'active';
    });
    const read = () => page ? createReadPageInvoker(s.dependencies)({ ...s.args, selection, generatedPredicate: predicate })
      : createReadInvoker(s.dependencies)({ ...s.args, selection: { predicate } });
    await assert.rejects(read(), refuses);
  }
});

test('page marked role predicate revalidates its actual second subject after final transform', async () => {
  const s = await setup(); let calls = 0, transforms = 0;
  const predicate = mark(async (_record, observation) => {
    calls++; assert.ok(observation);
    const member = await observation.context.memberships.findMembership(TEAM, 'author');
    return member?.roles.some(grant => grant.role === 'Creative.reviewer') === true;
  });
  await assert.rejects(createReadPageInvoker(s.dependencies)({ ...s.args, selection, generatedPredicate: predicate }, async page => {
    transforms++; assert.equal(page.records.length, 2);
    await s.memberships.setMembershipRoles(s.author.membership_id, []); return page;
  }), refuses);
  assert.equal(calls, 4); assert.equal(transforms, 1);
});

test('source query markers are closed, once bound and refused after ordinary/page generic first use', async () => {
  for (const bad of [{ ...producer, extra: true }, { ...producer, source: { ...producer.source, extra: true } },
    { ...producer, rule: '' }, { ...producer, source: { ...producer.source, sha256: 'not-a-sha' } }]) {
    assert.throws(() => bindInstalledSourceQueryPredicate(() => true, bad), refuses);
  }
  const bound = mark(() => true); assert.throws(() => bindInstalledSourceQueryPredicate(bound, producer), refuses);
  for (const page of [false, true]) {
    const s = await setup(); let calls = 0;
    const predicate: InstalledSourceQueryPredicate = (_record, observation) => { calls++; assert.equal(observation, undefined); return true; };
    const result = page ? await createReadPageInvoker(s.dependencies)({ ...s.args, selection, generatedPredicate: predicate })
      : await createReadInvoker(s.dependencies)({ ...s.args, selection: { predicate } });
    assert.equal(result.records.length, 2); assert.equal(calls, 2);
    assert.throws(() => bindInstalledSourceQueryPredicate(predicate, producer), refuses); assert.equal(calls, 2);
  }
});

test('source page identity includes declarations, secrets, ordered selectors and parent linkage across continuation', async () => {
  const s = await setup();
  const first = await invokeReadPage({ ...s.dependencies, ...s.args, selection: { ...selection, limit: 1 } });
  assert.ok(first.continuation);
  assert.deepEqual(first.queryDefinition[8][0]![3], ['installed-source', [...s.current.fields], [...s.current.secretFields], PARENT,
    [['title', 'author', 'settings']]]);
  assert.deepEqual(first.queryDefinition[8].map(scope => scope[0]), [MODEL, PARENT]);
  for (const current of [
    { ...s.current, fields: [...s.current.fields, 'extra'] },
    { ...s.current, secretFields: ['private_prompt'] },
    { ...s.current, grants: [{ fields: ['title'], read: async () => true }] },
    { ...s.current, grants: [{ fields: ['title'], read: async () => true }, { fields: ['author'], read: async () => true }] },
  ]) {
    const reads = new Map(s.sourceReadPolicies); reads.set(MODEL, current);
    const next: ViewerPageResult = await invokeReadPage({ ...s.dependencies, sourceReadPolicies: reads, ...s.args,
      selection: { ...selection, limit: 1, continuation: first.continuation } });
    assert.equal(next.revision, first.revision); assert.notDeepEqual(next.queryDefinition[8], first.queryDefinition[8]);
  }
  const orderedGrants = [{ fields: ['title'], read: async () => true }, { fields: ['author'], read: async () => true }];
  const definitions = [];
  for (const grants of [orderedGrants, [...orderedGrants].reverse()]) {
    const reads = new Map(s.sourceReadPolicies); reads.set(MODEL, { ...s.current, grants });
    definitions.push((await invokeReadPage({ ...s.dependencies, sourceReadPolicies: reads, ...s.args, selection })).queryDefinition);
  }
  assert.notDeepEqual(definitions[0]![8], definitions[1]![8]);
  assert.deepEqual(definitions[0]![9], definitions[1]![9], 'selector ordinal identity survives identical true verdicts');
  await assert.rejects(createReadPageInvoker(s.dependencies)({ ...s.args,
    selection: { ...selection, continuation: first.continuation }, generatedPredicate: mark(() => true) }), refuses);
});


test('query marker and membership binding preserve exact source/rule and stage in both binding orders', () => {
  const team = Object.freeze({ teamId: TEAM, timezone: 'UTC' });
  function bind(read: InstalledSourceQueryPredicate, source = producer.source, rule = producer.rule,
    stage: 'read-predicate' | 'read-policy' = 'read-predicate') {
    return bindReadPolicyMembershipProducer(read, { source, rule, team: () => team,
      capture: () => ({ person: makeUserRef('author'), team }),
      sites: [{ version: 1, source, owner: rule, node: { start: 10, end: 30 },
        statement: { start: 9, end: 31 }, stage, position: [], calls: [{ source,
          node: { start: 11, end: 29 }, target: { kind: 'builtin', id: 'active_member', overload: 0 },
          arguments: [{ node: { start: 12, end: 13 }, type: 'user' }, { node: { start: 14, end: 15 }, type: 'Team' }],
          slots: [0, 1], defaults: [], chain: [],
        }] }],
    });
  }
  for (const markerFirst of [false, true]) {
    const matching: InstalledSourceQueryPredicate = () => true;
    if (markerFirst) { mark(matching); assert.equal(bind(matching).length, 1); }
    else { bind(matching); assert.doesNotThrow(() => mark(matching)); }
    for (const mismatch of ['source', 'rule', 'stage'] as const) {
      const read: InstalledSourceQueryPredicate = () => true;
      const source = mismatch === 'source' ? { ...producer.source, sha256: 'b'.repeat(64) } : producer.source;
      const rule = mismatch === 'rule' ? 'Creative.App.other' : producer.rule;
      const stage = mismatch === 'stage' ? 'read-policy' : 'read-predicate';
      if (markerFirst) { mark(read); assert.throws(() => bind(read, source, rule, stage), refuses); }
      else { bind(read, source, rule, stage); assert.throws(() => mark(read), refuses); }
    }
  }
});

test('included archived targets use current source grants while containing parents must stay live', async () => {
  const s = await setup();
  const row = (await s.store.load(MODEL, asId('a')))!;
  await s.store.commit(makeBatch(await s.store.readRevision(), { writes: [{ kind: 'update', model: MODEL,
    id: row.id, expectedVersion: row.version, row: { ...row, archivedAt: FIXED_NOW, version: 2 as typeof row.version } }] }));
  const defaultRead = await invokeRead({ ...s.dependencies, ...s.args });
  assert.deepEqual(defaultRead.records.map(row => row.id), ['b']);
  const included = await invokeReadPage({ ...s.dependencies, ...s.args, selection: { ...selection, archived: 'include' } });
  assert.deepEqual(included.records.map(row => row.id), ['a', 'b']);
  assert.equal(included.records[0]!.archivedAt, FIXED_NOW);
  assert.equal(included.records[0]!.data.private_prompt, undefined);
  s.sourceReadPolicies.set(MODEL, { ...s.current, grants: [{ fields: ['title'], read: async () => false }] });
  assert.deepEqual((await invokeReadPage({ ...s.dependencies, ...s.args,
    selection: { ...selection, archived: 'include' } })).records, []);
  s.sourceReadPolicies.set(MODEL, s.current);
  await s.store.commit(makeBatch(await s.store.readRevision(), { writes: [{ kind: 'update', model: PARENT,
    id: s.parent.id, expectedVersion: s.parent.version,
    row: { ...s.parent, archivedAt: FIXED_NOW, version: 2 as typeof s.parent.version } }] }));
  await assert.rejects(invokeReadPage({ ...s.dependencies, ...s.args,
    selection: { ...selection, archived: 'include' } }), refuses);
});
