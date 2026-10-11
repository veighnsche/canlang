/** Source list predicates use the current projected candidate and State-issued authority. */
import assert from 'node:assert/strict';
import type { ModelName } from '@canlang/contracts';
import { test } from 'node:test';
import { makeUserRef } from '@canlang/values';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { queryRecords, queryRecordsPage } from '../../src/query/engine.js';
import { bindReadPolicyMembershipProducer, evaluateReadPolicyMembership,
  type InstalledSourceQueryPredicate } from '../../src/receipt/read-policy-membership.js';
import type { ViewerGenerationCallbackReadObservation } from '../../src/receipt/callback-diagnostics.js';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { asModel, FIXED_NOW, grant, modelPolicy, policyTable, seedRows } from './fixtures.js';
import { asId, makeBatch, makeRow } from '../invocation/fixtures.js';
import { projectCurrentRecordForViewerSourcePolicies, type ViewerSourceReadPolicy } from '../../src/query/source-policy.js';

const MODEL = asModel('Creative.Run'), TEAM = 'creative-team';
async function setup() {
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  await memberships.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: false, roles: [] });
  const subject = await memberships.createMembership({ team_id: TEAM, user_id: 'author', is_owner: false, roles: [] });
  const store = createMemoryStorage();
  await seedRows(store, MODEL, [
    { id: 'a', data: { author: 'author', title: 'accepted', private_prompt: 'SECRET' } },
    { id: 'b', data: { author: 'absent', title: 'rejected', private_prompt: 'SECRET' } },
    { id: 'c', data: { author: 'author', title: 'skipped', private_prompt: 'SECRET' } },
  ]);
  const input = { authority: 'viewer' as const, model: MODEL, store, memberships,
    modelDescriptor: { name: MODEL, deleteMode: 'archive' as const, fields: {
      author: { valueType: 'text', required: true, serverOnly: false },
      title: { valueType: 'text', required: true, serverOnly: false },
      private_prompt: { valueType: 'text', required: true, serverOnly: false },
    } },
    context: { actorUserId: 'caller', teamId: TEAM },
    policy: policyTable(modelPolicy(MODEL, { grants: [grant('members', ['author', 'title'])] })) };
  return { input, memberships, subject, store };
}
function nativePredicate(body: (record: Parameters<InstalledSourceQueryPredicate>[0],
  observation: ViewerGenerationCallbackReadObservation,
  member: (person: string, observation?: ViewerGenerationCallbackReadObservation) => Promise<boolean>) => Promise<boolean>,
  original?: InstalledSourceQueryPredicate) {
  const source = { path: 'creative.can', sha256: 'a'.repeat(64), module: 'creative.mjs' };
  const rule = 'Creative.App.Creative203', team = Object.freeze({ teamId: TEAM, timezone: 'UTC' });
  const frames = new WeakMap<object, { person: ReturnType<typeof makeUserRef>; team: typeof team }>();
  let handles: ReturnType<typeof bindReadPolicyMembershipProducer>, captures = 0;
  const predicate: InstalledSourceQueryPredicate = original ?? (async (record, observation) => {
    assert.ok(observation);
    return body(record, observation, async (person, current = observation) => {
      frames.set(current, { person: makeUserRef(person), team });
      return evaluateReadPolicyMembership(current, { site: handles[0]! });
    });
  });
  handles = bindReadPolicyMembershipProducer(predicate, { source, rule, team: () => team,
    sites: [{ version: 1, source, owner: rule, node: { start: 10, end: 30 },
      statement: { start: 9, end: 31 }, stage: 'read-predicate', position: [], calls: [{ source,
        node: { start: 11, end: 29 }, target: { kind: 'builtin', id: 'active_member', overload: 0 },
        arguments: [{ node: { start: 12, end: 13 }, type: 'user' }, { node: { start: 14, end: 15 }, type: 'Team' }],
        slots: [0, 1], defaults: [], chain: [],
      }] }], capture: observation => {
        captures++; const pair = frames.get(observation); frames.delete(observation);
        if (pair === undefined) throw new StateError('validation', 'No actual native evaluated pair.');
        return pair;
      } });
  return { predicate, handles, get captures() { return captures; } };
}
const refuses = (error: unknown) => error instanceof StateError;

test('actual unbound ordinary and page source execution prevents later membership binding without rerunning source', async () => {
  for (const page of [false, true]) {
    const s = await setup(); let calls = 0;
    const predicate: InstalledSourceQueryPredicate = () => { calls++; return true; };
    if (page) await queryRecordsPage({ ...s.input, generatedPredicate: predicate });
    else await queryRecords({ ...s.input, predicate });
    assert.equal(calls, 3, 'accepted unbound source executes once per visible candidate');
    assert.throws(() => nativePredicate(async () => true, predicate), refuses);
    assert.equal(calls, 3);
  }
});

test('source can_view predicate sees projected fields, consumes true and false candidates in order and skips AST misses', async () => {
  const s = await setup(), seen: string[] = [];
  const native = nativePredicate(async (record, observation, member) => {
    seen.push(record.id);
    assert.equal(Object.hasOwn(record.data, 'private_prompt'), false);
    assert.equal(Object.hasOwn(observation.row.data, 'private_prompt'), false);
    assert.notEqual(observation.context.memberships, s.memberships);
    return member(record.data.author as string);
  });
  const result = await queryRecords({ ...s.input, predicate: native.predicate,
    where: { op: 'ne', field: 'title', value: 'skipped' }, order: [{ field: 'title', direction: 'desc' }] });
  assert.deepEqual(result.records.map(row => row.id), ['a']);
  assert.deepEqual(seen, ['b', 'a', 'b', 'a'], 'retain the original ordered scan for both coherent evaluations');
  assert.equal(native.captures, 4, 'complete multi-subject snapshot replays with fresh captures');
});

test('page search preserves original predicate identity and final transform revocation refuses without source rerun', async () => {
  const s = await setup(); let calls = 0, transforms = 0;
  const native = nativePredicate(async (record, _observation, member) => { calls++; return member(record.data.author as string); });
  await assert.rejects(queryRecordsPage({ ...s.input, generatedPredicate: native.predicate,
    selection: { search: { fields: ['title'], query: 'accepted' } } }, async page => {
      transforms++; assert.deepEqual(page.records.map(row => row.id), ['a']);
      await s.memberships.removeMembership(s.subject.membership_id); return page;
    }), refuses);
  assert.equal(calls, 2); assert.equal(transforms, 1);
});

test('source predicate membership rejects copied and closed observations and Identity movement during source awaits', async () => {
  for (const mode of ['copied', 'closed', 'revoked', 'state'] as const) {
    const s = await setup(); let saved: ViewerGenerationCallbackReadObservation | undefined;
    const native = nativePredicate(async (record, observation, member) => {
      saved = observation;
      if (mode === 'copied') {
        try { await member(record.data.author as string, { ...observation }); } catch (error) { assert.ok(refuses(error)); }
        return true;
      }
      const value = await member(record.data.author as string);
      if (mode === 'revoked') await s.memberships.removeMembership(s.subject.membership_id);
      if (mode === 'state') await seedRows(s.store, MODEL, [{ id: 'new', data: { author: 'author', title: 'new' } }]);
      return value;
    });
    const read = () => queryRecords({ ...s.input, predicate: native.predicate,
      where: { op: 'eq', field: 'title', value: 'accepted' } });
    if (mode === 'closed') {
      assert.deepEqual((await read()).records.map(row => row.id), ['a']); assert.ok(saved);
      await assert.rejects(evaluateReadPolicyMembership(saved, { site: native.handles[0]! }), refuses);
    } else await assert.rejects(read(), refuses);
  }
});


test('denied candidate documents never reach a bound source membership predicate', async () => {
  const s = await setup();
  const native = nativePredicate(async () => assert.fail('unreadable candidate reached source'));
  const result = await queryRecords({ ...s.input, predicate: native.predicate,
    policy: policyTable(modelPolicy(MODEL, { grants: [grant('owner', ['author', 'title'])] })) });
  assert.deepEqual(result.records, []); assert.equal(native.captures, 0);
});

test('installed source grants and bound list membership predicates share one coherent projected query/page domain', async () => {
  for (const route of ['records', 'page-revoked'] as const) {
    const s = await setup(), grants: ViewerGenerationCallbackReadObservation[] = [],
      candidates: ViewerGenerationCallbackReadObservation[] = [], seen: string[] = [];
    const sourceReadPolicies = new Map([[MODEL, {
      fields: ['author', 'title', 'private_prompt'], secretFields: ['private_prompt'],
      grants: [{ fields: ['author', 'title'], read: async (observation: ViewerGenerationCallbackReadObservation) => {
        grants.push(observation); assert.notEqual(observation.context.memberships, s.memberships);
        const author = await observation.context.memberships.findMembership(TEAM, observation.row.data.author as string);
        if (author?.status === 'active') return true;
        const caller = await observation.context.memberships.findMembership(TEAM, 'caller');
        return caller?.status === 'active';
      } }],
    }]]);
    const native = nativePredicate(async (record, observation, member) => {
      candidates.push(observation); seen.push(record.id);
      assert.deepEqual(Object.keys(record.data).sort(), ['author', 'title']);
      assert.equal(Object.hasOwn(observation.row.data, 'private_prompt'), false);
      return member(record.data.author as string);
    });
    const where = { op: 'ne' as const, field: 'title', value: 'skipped' };
    if (route === 'records') {
      const result = await queryRecords({ ...s.input, policy: new Map(), sourceReadPolicies,
        where, predicate: native.predicate });
      assert.deepEqual(result.records.map(row => row.id), ['a']);
    } else {
      let transforms = 0;
      await assert.rejects(queryRecordsPage({ ...s.input, policy: new Map(), sourceReadPolicies,
        selection: { where }, generatedPredicate: native.predicate }, async page => {
        transforms++; assert.deepEqual(page.records.map(row => row.id), ['a']);
        await s.memberships.removeMembership(s.subject.membership_id); return page;
      }), refuses);
      assert.equal(transforms, 1);
    }
    assert.deepEqual(seen, ['a', 'b', 'a', 'b'], route);
    assert.equal(native.captures, 4);
    assert.equal(grants.length, 6, 'ordinary grants and false/AST-skipped candidates retain the complete scanned domain');
    assert.equal(new Set(grants).size, 6, 'source grants receive fresh observations during coherent replay');
    assert.equal(new Set(candidates).size, 4, 'bound source predicate captures reopen for each actual decision');
  }
});


/** Literal current-row navigation adapters exercise State's shared observation,
 * not checked emitted-source correspondence or native acceptance. */
async function navigationFixture() {
  const s = await setup(), PARENT = asModel('Creative.Project'), ROOT = asModel('Creative.Space');
  const owner = await s.memberships.createMembership({ team_id: TEAM, user_id: 'parent-owner', is_owner: false, roles: [] });
  const reader = await s.memberships.createMembership({ team_id: TEAM, user_id: 'root-reader', is_owner: false, roles: [] });
  const root = makeRow({ id: 'space', data: { reviewer: 'root-reader', title: 'Space', secret: 'ROOT SECRET' } });
  const parent = { ...makeRow({ id: 'project', data: { owner: 'parent-owner', title: 'Project',
    settings: { label: 'visible', token: 'TOKEN' }, private_note: 'PARENT SECRET' } }), parent: { model: ROOT, id: root.id } };
  const children = await Promise.all(['a', 'b', 'c'].map(id => s.store.load(MODEL, asId(id))));
  await s.store.commit(makeBatch(await s.store.readRevision(), { writes: [
    { kind: 'insert', model: ROOT, row: root }, { kind: 'insert', model: PARENT, row: parent },
    ...children.map(row => { assert.ok(row); return { kind: 'update' as const, model: MODEL, id: row.id,
      expectedVersion: row.version, row: { ...row, version: (row.version + 1) as typeof row.version,
        parent: { model: PARENT, id: parent.id } } }; }),
  ] }));
  const source = { path: 'creative.can', sha256: 'a'.repeat(64), module: 'creative.mjs' };
  const rule = 'Creative.Project.read0', team = Object.freeze({ teamId: TEAM, timezone: 'UTC' });
  const frames = new WeakMap<object, ReturnType<typeof makeUserRef>>(), ordered: string[] = [];
  let handles: ReturnType<typeof bindReadPolicyMembershipProducer>;
  const parentRead = async (observation: Readonly<ViewerGenerationCallbackReadObservation>) => {
    ordered.push('parent:0'); frames.set(observation, makeUserRef(observation.row.data.owner as string));
    return evaluateReadPolicyMembership(observation, { site: handles[0]! });
  };
  handles = bindReadPolicyMembershipProducer(parentRead, { source, rule, team: () => team,
    sites: [{ version: 1, source, owner: rule, node: { start: 40, end: 60 }, statement: { start: 39, end: 61 },
      stage: 'read-policy', position: [], calls: [{ source, node: { start: 41, end: 59 },
        target: { kind: 'builtin', id: 'active_member', overload: 0 },
        arguments: [{ node: { start: 42, end: 43 }, type: 'user' }, { node: { start: 44, end: 45 }, type: 'Team' }],
        slots: [0, 1], defaults: [], chain: [],
      }] }], capture: observation => {
        const person = frames.get(observation); frames.delete(observation); assert.ok(person); return { person, team };
      } });
  const reads = new Map<ModelName, ViewerSourceReadPolicy>([
    [PARENT, { parent: ROOT, fields: ['owner', 'title', 'settings', 'private_note'], secretFields: ['settings.token', 'private_note'], grants: [
      { fields: ['title'], read: parentRead },
      { fields: ['owner', 'settings'], read: async ({ context }) => { ordered.push('parent:1'); return context.membership?.status === 'active'; } },
    ] }],
    [ROOT, { fields: ['reviewer', 'title', 'secret'], secretFields: ['secret'], grants: [
      { fields: ['title'], read: async ({ context, row }) => { ordered.push('root:0');
        return (await context.memberships.findMembership(TEAM, row.data.reviewer as string))?.status === 'active'; } },
    ] }],
  ]);
  const snapshots: string[][] = [];
  const memberships = { ...s.memberships, findMembershipsSnapshot: async (teamId: string, users: readonly string[]) => {
    snapshots.push([...users]); return s.memberships.findMembershipsSnapshot(teamId, users);
  } };
  return { ...s, input: { ...s.input, memberships }, PARENT, ROOT, owner, reader, reads, ordered, snapshots };
}

test('ordinary and page WHERE parent navigation shares candidate and complete ordered multi-subject source authority', async () => {
  for (const page of [false, true]) {
    const s = await navigationFixture(), seen: string[] = [];
    const native = nativePredicate(async (record, observation, member) => {
      seen.push(record.id); assert.equal(record.id, 'a'); assert.deepEqual(record.data, { author: 'author', title: 'accepted' });
      assert.deepEqual(observation.row.data, record.data); assert.ok(record.parent);
      const parent = await projectCurrentRecordForViewerSourcePolicies({ model: record.parent.model, id: record.parent.id,
        readPolicies: s.reads, policy: s.input.policy, context: observation.context, memberships: observation.context.memberships,
        store: s.store, ...(observation.fence === undefined ? {} : { fence: observation.fence }), observation }, async (result, allowed) => {
        assert.deepEqual(allowed, [true, true]); assert.equal(result.revision, observation.revision);
        assert.deepEqual(result.record?.data, { title: 'Project', owner: 'parent-owner', settings: { label: 'visible' } });
        assert.equal(result.record?.parent?.model, s.ROOT); return result;
      });
      return parent.record !== null && await member(record.data.author as string);
    });
    const where = { op: 'eq' as const, field: 'title', value: 'accepted' };
    const result = page ? await queryRecordsPage({ ...s.input, selection: { where }, generatedPredicate: native.predicate })
      : await queryRecords({ ...s.input, where, predicate: native.predicate });
    assert.deepEqual(result.records.map(row => row.id), ['a']); assert.deepEqual(seen, ['a', 'a']);
    assert.deepEqual(s.ordered, ['parent:0', 'parent:1', 'root:0', 'parent:0', 'parent:1', 'root:0']);
    assert.equal(native.captures, 2); assert.ok(s.snapshots.length >= 2);
    for (const users of s.snapshots) assert.deepEqual(users, ['caller', 'parent-owner', 'root-reader', 'author']);
  }
});

test('ordinary navigation transform and final page transform revocation refuse the shared WHERE subject set', async () => {
  for (const page of [false, true]) {
    const s = await navigationFixture(); let transforms = 0;
    const native = nativePredicate(async (record, observation, member) => {
      assert.ok(record.parent);
      const own = await member(record.data.author as string);
      const parent = await projectCurrentRecordForViewerSourcePolicies({ model: record.parent.model, id: record.parent.id,
        readPolicies: s.reads, policy: s.input.policy, context: observation.context, memberships: observation.context.memberships,
        store: s.store, ...(observation.fence === undefined ? {} : { fence: observation.fence }), observation }, async result => {
        assert.ok(result.record);
        if (!page && transforms++ === 0) await s.memberships.removeMembership(s.reader.membership_id);
        return result;
      });
      return own && parent.record !== null;
    });
    const where = { op: 'eq' as const, field: 'title', value: 'accepted' };
    if (page) await assert.rejects(queryRecordsPage({ ...s.input, selection: { where }, generatedPredicate: native.predicate }, async result => {
      transforms++; assert.equal(result.records.length, 1); await s.memberships.removeMembership(s.owner.membership_id); return result;
    }), refuses);
    else await assert.rejects(queryRecords({ ...s.input, where, predicate: native.predicate }), refuses);
    assert.equal(transforms, 1);
  }
});
