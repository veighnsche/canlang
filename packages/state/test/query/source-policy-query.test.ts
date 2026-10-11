/** Actual State query/page source policies; no generated/native qualification claim. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelName, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { queryRecords, queryRecordsPage } from '../../src/query/engine.js';
import type { ViewerGenerationCallbackSourceReadPolicy, ViewerSourceReadPolicy } from '../../src/query/source-policy.js';
import { StateError } from '../../src/errors.js';
import { FenceConflictError } from '../../src/storage/port.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { makeBatch, makeRow, asId } from '../invocation/fixtures.js';
import { asModel, FIXED_NOW, seedRows } from './fixtures.js';

const MODEL = asModel('Creative.Run'), PARENT = asModel('Creative.Project'), ROOT = asModel('Creative.Space');
const TEAM = 'source-query-team';
type SourcePolicy = ViewerGenerationCallbackSourceReadPolicy;
const refuses = (error: unknown) => error instanceof StateError;
const policy = (fields: readonly string[], read: SourcePolicy['grants'][number]['read'], parent?: ModelName): SourcePolicy => ({
  fields, secretFields: [], grants: [{ fields, read }], ...(parent === undefined ? {} : { parent }),
});
async function setup(parents = false, empty = false) {
  const memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const caller = await memberships.createMembership({ team_id: TEAM, user_id: 'caller', is_owner: false, roles: [] });
  const author = await memberships.createMembership({ team_id: TEAM, user_id: 'author', is_owner: false, roles: [] });
  const store = createMemoryStorage();
  const rows: { model: ModelName; row: StoredRow }[] = [];
  if (parents) {
    rows.push({ model: ROOT, row: makeRow({ id: 'space', data: { title: 'Space' } }) });
    rows.push({ model: PARENT, row: { ...makeRow({ id: 'project', data: { title: 'Project' } }),
      parent: { model: ROOT, id: asId('space') } } });
  }
  if (!empty) for (const [id, title, subject] of [['a', 'Alpha', 'author'], ['b', 'Beta', 'absent']] as const) {
    rows.push({ model: MODEL, row: { ...makeRow({ id, data: { title, author: subject, score: id === 'a' ? '5' : '9',
      settings: { label: title, token: 'SECRET' }, private_prompt: 'PRIVATE' } }),
      ...(parents ? { parent: { model: PARENT, id: asId('project') } } : {}) } });
  }
  if (rows.length) await store.commit(makeBatch(await store.readRevision(), { writes: rows.map(({ model, row }) => ({ kind: 'insert' as const, model, row })) }));
  const current = policy(['title', 'author', 'score', 'settings', 'private_prompt'], async () => true, parents ? PARENT : undefined);
  const ancestor = policy(['title'], async () => true, ROOT), root = policy(['title'], async () => true);
  const reads = new Map<ModelName, ViewerSourceReadPolicy>([[MODEL, current], [PARENT, ancestor], [ROOT, root]]);
  const input = { authority: 'viewer' as const, model: MODEL, store, memberships,
    context: { actorUserId: 'caller', teamId: TEAM }, policy: new Map(), sourceReadPolicies: reads,
    modelDescriptor: { name: MODEL, deleteMode: 'archive' as const, fields: {
      title: { valueType: 'text', required: true, serverOnly: false }, author: { valueType: 'text', required: true, serverOnly: false },
      score: { valueType: 'int', required: true, serverOnly: false }, settings: { valueType: 'json', required: true, serverOnly: false },
      private_prompt: { valueType: 'text', required: true, serverOnly: false },
    } } };
  return { store, memberships, caller, author, reads, current, ancestor, root, input };
}

test('source query grants execute in declaration order, union matching fields and carve typed secrets per row', async () => {
  const s = await setup(), seen: string[] = [];
  s.reads.set(MODEL, { fields: s.current.fields, secretFields: ['settings.token'], grants: [
    { fields: ['title'], read: async ({ row }) => { seen.push(`${row.id}:0`); return true; } },
    { fields: ['score', 'settings'], read: async ({ row }) => { seen.push(`${row.id}:1`); return row.data.author === 'author'; } },
    { fields: ['author'], read: async ({ row }) => { seen.push(`${row.id}:2`); return false; } },
  ] });
  const result = await queryRecords(s.input);
  assert.deepEqual(result.records.map(row => row.data), [
    { title: 'Alpha', score: '5', settings: { label: 'Alpha' } }, { title: 'Beta' },
  ]);
  assert.deepEqual(seen, ['a:0', 'a:1', 'a:2', 'b:0', 'b:1', 'b:2']);
});

test('source conditional selectors project before WHERE and once-only unbound source filtering', async () => {
  const s = await setup(), calls: string[] = [];
  s.reads.set(MODEL, { fields: s.current.fields, secretFields: [], grants: [
    { fields: ['title'], read: async () => true },
    { fields: ['score'], read: async ({ row }) => row.data.author === 'author' },
  ] });
  const result = await queryRecords({ ...s.input, where: { op: 'eq', field: 'score', value: '5' }, predicate: row => {
    calls.push(row.id); assert.deepEqual(row.data, { title: 'Alpha', score: '5' }); return true;
  } });
  assert.deepEqual(result.records.map(row => row.id), ['a']); assert.deepEqual(calls, ['a']);
  assert.deepEqual((await queryRecords({ ...s.input, where: { op: 'eq', field: 'score', value: '9' } })).records, []);
});

test('unreadable real source ancestors hide query candidates without invoking their source filter', async () => {
  for (const hidden of [PARENT, ROOT]) {
    const s = await setup(true); s.reads.set(hidden, policy(['title'], async () => false, hidden === PARENT ? ROOT : undefined));
    const result = await queryRecords({ ...s.input, predicate: () => assert.fail('hidden ancestor candidate reached filter') });
    assert.deepEqual(result.records, []);
  }
});

test('source page checks the selected parent and full ancestor chain even for an empty collection', async () => {
  for (const empty of [false, true]) for (const hidden of [undefined, PARENT, ROOT]) {
    const s = await setup(true, empty);
    if (hidden !== undefined) s.reads.set(hidden, policy(['title'], async () => false, hidden === PARENT ? ROOT : undefined));
    const read = () => queryRecordsPage({ ...s.input, selection: { parent: { model: PARENT, id: asId('project') } } });
    if (hidden !== undefined) await assert.rejects(read(), refuses);
    else assert.equal((await read()).records.length, empty ? 0 : 2);
  }
});

test('source grants use complete coherent current Identity and final page transform revocation refuses disclosure', async () => {
  const s = await setup(), observed: string[] = [];
  s.reads.set(MODEL, policy(['title', 'author'], async ({ context, row }) => {
    observed.push(row.id); assert.notEqual(context.memberships, s.memberships);
    const member = await context.memberships.findMembership(TEAM, row.data.author as string);
    return member?.status === 'active';
  }));
  let filters = 0, transforms = 0;
  await assert.rejects(queryRecordsPage({ ...s.input, generatedPredicate: row => {
    filters++; assert.deepEqual(row.data, { title: 'Alpha', author: 'author' }); return true;
  } }, async page => {
    transforms++; assert.equal(page.records.length, 1);
    await s.memberships.removeMembership(s.author.membership_id); return page;
  }), refuses);
  assert.deepEqual(observed, ['a', 'b', 'a', 'b']);
  assert.equal(filters, 1); assert.equal(transforms, 1);
});

test('source predicate awaits cannot disclose through Identity or State movement and malformed verdicts', async () => {
  for (const mode of ['identity', 'state', 'boolean'] as const) {
    const s = await setup();
    s.reads.set(MODEL, policy(['title'], async ({ context }) => {
      if (mode === 'boolean') return 'true' as unknown as boolean;
      await context.memberships.findMembership(TEAM, 'caller');
      if (mode === 'identity') await s.memberships.removeMembership(s.caller.membership_id);
      else await seedRows(s.store, MODEL, [{ id: 'new', data: { title: 'New' } }]);
      return true;
    }));
    await assert.rejects(queryRecords(s.input), mode === 'state'
      ? (error: unknown) => error instanceof FenceConflictError : refuses);
  }
});

test('source query forbidden paths fail before candidate scan', async () => {
  for (const route of ['where', 'order'] as const) {
    const s = await setup(); s.reads.set(MODEL, policy(['title'], async () => true));
    // Declaration inventory is broader than the legal grant selector domain.
    s.reads.set(MODEL, { ...s.reads.get(MODEL) as SourcePolicy, fields: s.current.fields });
    let scans = 0;
    const store = { ...s.store, query: async (...args: Parameters<typeof s.store.query>) => { scans++; return s.store.query(...args); } };
    await assert.rejects(queryRecords({ ...s.input, store, ...(route === 'where'
      ? { where: { op: 'eq' as const, field: 'private_prompt', value: 'PRIVATE' } }
      : { order: [{ field: 'private_prompt', direction: 'asc' as const }] }) }), refuses);
    assert.equal(scans, 0);
  }
});

test('source query retains existing filter call order, stable sorting and limit overflow', async () => {
  const s = await setup(), calls: string[] = [];
  s.reads.set(MODEL, policy(['title'], async () => true));
  const input = { ...s.input, order: [{ field: 'title', direction: 'desc' as const }], predicate: (row: { readonly id: string }) => {
    calls.push(row.id); return true;
  } };
  assert.deepEqual((await queryRecords(input)).records.map(row => row.id), ['b', 'a']);
  assert.deepEqual(calls, ['b', 'a']); calls.length = 0;
  await assert.rejects(queryRecords({ ...input, limit: 1 }), refuses); assert.deepEqual(calls, ['b', 'a']);
});
