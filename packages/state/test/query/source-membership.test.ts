/** Source list predicates use the current projected candidate and State-issued authority. */
import assert from 'node:assert/strict';
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
