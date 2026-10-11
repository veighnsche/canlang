/** Generated CRUD saved-row receiver using genuine source-ruled Budget grants.
 * Memory State scope only; native host join and original app remain separate. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryIdentityStore, createFrozenClock } from '@canlang/identity/testing';
import type { Receipt, ModelName, StoredRow } from '@canlang/contracts';
import { loadArtifactDescriptors } from '../../src/invocation/registry.js';
import { invoke, projectGeneratedCrudReceipt } from '../../src/invocation/invoke.js';
import { buildModelTableFromCanonical } from '../../src/mutation/models.js';
import { generatedCrudExecute } from '../../src/mutation/crud.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import type { ViewerSourceReadPolicy } from '../../src/query/source-policy.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { asId, asModel, asVersion, FIXED_NOW,
  makeIdentity, makeRow, makeBatch, makeEnvelope, uuidv7 } from './fixtures.js';

const PARENT = asModel('CrudSource.Workspace'), BUDGET = asModel('CrudSource.Budget'), APP = 'generated-crud-source-policy';
let sequence = 110_000;
const operationId = () => uuidv7(FIXED_NOW, ++sequence);
async function world() {
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const user = await memberships.createUser({ email: 'crud-source-member@example.test', password_hash: 'test-only-hash', email_verified: true });
  const membership = await memberships.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
  const member = { team, user, membership };
  const readerUser = await memberships.createUser({ email: 'crud-source-reader@example.test', password_hash: 'test-only-hash', email_verified: true });
  const readerMembership = await memberships.createMembership({ team_id: team.team_id, user_id: readerUser.user_id, is_owner: false, roles: [] });
  const reader = { team, user: readerUser, membership: readerMembership };
  const identity = makeIdentity({ membership: member.membership, team, userId: user.user_id, email: user.email });
  const loaded = loadArtifactDescriptors({ artifact_version: 1, models: [
    { name: PARENT, deleteMode: 'remove', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] },
    { name: BUDGET, parent: PARENT, deleteMode: 'remove', uniqueKeys: ['account'], fields: [
      { name: 'account', field: { kind: 'user' }, required: true, serverOnly: false },
      { name: 'held', field: { kind: 'integer' }, required: true, serverOnly: false },
      { name: 'note', field: { kind: 'string' }, required: true, serverOnly: false },
      { name: 'later_secret', field: { kind: 'string' }, required: true, serverOnly: false },
      { name: 'original_secret', field: { kind: 'secret' }, required: false, serverOnly: true, default: { kind: 'server', init: 'random_secret' } },
    ] },
  ], operations: [
    { name: `${BUDGET}.create`, kind: 'create', description: '', inputs: { fields: [
      { name: 'parent', field: { kind: 'ref', model: PARENT, requireVersion: true }, required: true },
      { name: 'account', field: { kind: 'user' }, required: true },
      { name: 'held', field: { kind: 'integer' }, required: true },
      { name: 'note', field: { kind: 'string' }, required: true },
      { name: 'later_secret', field: { kind: 'string' }, required: true },
    ] } },
    { name: `${BUDGET}.update`, kind: 'update', description: '', inputs: { fields: [
      { name: 'record', field: { kind: 'ref', model: BUDGET, requireVersion: true }, required: true },
      { name: 'account', field: { kind: 'user' }, required: false },
      { name: 'held', field: { kind: 'integer' }, required: false },
      { name: 'note', field: { kind: 'string' }, required: false },
      { name: 'later_secret', field: { kind: 'string' }, required: false },
    ] } },
    { name: `${BUDGET}.delete`, kind: 'delete', description: '', inputs: { fields: [
      { name: 'record', field: { kind: 'ref', model: BUDGET, requireVersion: true }, required: true },
    ] } },
  ] }, { by: 'members' });
  assert.equal(loaded.models.find(model => model.name === BUDGET)!.fields.account!.valueType, 'user');
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields, containment: loaded.containment });
  await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: PARENT,
    row: makeRow({ id: 'workspace', data: { title: 'Workspace' } }) }] }));
  const access = { budget: true, parent: true };
  const policy = buildPolicyTable([{ model: PARENT, secretFields: [], grants: [{ by: 'members', fields: ['title'] }] }]);
  const sourceReadPolicies: Map<ModelName, ViewerSourceReadPolicy> = new Map([
    [BUDGET, { parent: PARENT, fields: ['account', 'held', 'note', 'later_secret', 'original_secret'], secretFields: ['later_secret'], grants: [{
      fields: ['id', 'account', 'held', 'note', 'original_secret'], read: async ({ context, row }) => access.budget &&
        (row.data.account as { id: string }).id === context.actorUserId && context.membership?.status === 'active' &&
        (await context.memberships.findMembership(member.team.team_id, reader.user.user_id))?.status === 'active',
    }] }],
    [PARENT, { fields: ['title'], secretFields: [], grants: [{ fields: ['id', 'title'], read: async ({ context }) =>
      access.parent && context.membership?.status === 'active' }] }],
  ]);
  let executions = 0; const receipts: Receipt[] = [];
  const crud = generatedCrudExecute({ table, store, secretFields: new Map([...loaded.secretFields].map(([model, fields]) => [model, [...fields]])) });
  const input = { registry: loaded.registry, store, memberships, identity, app: APP, source: 'test', clock: { nowMs: () => FIXED_NOW },
    execute: async (call: Parameters<typeof crud>[0]) => { executions++; return crud(call); },
    observeCommittedReceipt: (receipt: Receipt) => { receipts.push(receipt); } };
  const envelope = makeEnvelope(`${BUDGET}.create`, operationId(), { parent: { id: 'workspace', version: '1' },
    account: { id: member.user.user_id }, held: '5', note: 'Saved original', later_secret: 'Current-secret saved value' });
  const result = await invoke({ ...input, envelope }); assert.equal(result.status, 'committed'); assert.equal(receipts.length, 1);
  const saved = result.result as StoredRow; assert.ok(typeof saved.data.original_secret === 'string');
  return { ...input, policy, sourceReadPolicies, access, member, reader, table, models: loaded.models, receipts, saved, envelope,
    executions: () => executions, receipt: receipts[0]! };
}

test('source-owned account create/update disclose original saved values and metadata with no static Budget grant or replay execution', async () => {
  const w = await world(); assert.equal(w.policy.has(BUDGET), false);
  const create = await projectGeneratedCrudReceipt(w);
  assert.equal(create.result, null); assert.equal(create.records.length, 1);
  assert.deepEqual(create.records[0]!.data, { account: { id: w.member.user.user_id }, held: '5', note: 'Saved original' });
  assert.equal(create.records[0]!.version, w.saved.version); assert.equal(create.records[0]!.updated, w.saved.updated);
  const updateEnvelope = makeEnvelope(`${BUDGET}.update`, operationId(), { record: { id: w.saved.id, version: '1' }, held: '9', note: 'Saved update' });
  const updated = await invoke({ ...w, envelope: updateEnvelope }); assert.equal(updated.status, 'committed');
  const updateReceipt = w.receipts.at(-1)!;
  const current = await w.store.load(BUDGET, w.saved.id); assert.ok(current);
  await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'update', model: BUDGET, id: current.id,
    expectedVersion: current.version, row: { ...current, version: asVersion(current.version + 1), updated: FIXED_NOW + 1000,
      data: { ...current.data, held: '20', note: 'Current later value' } } }] }));
  assert.deepEqual((await projectGeneratedCrudReceipt(w)).records[0]!.data, create.records[0]!.data);
  const projectedUpdate = await projectGeneratedCrudReceipt({ ...w, receipt: updateReceipt });
  assert.equal(projectedUpdate.records[0]!.data.note, 'Saved update'); assert.equal(projectedUpdate.records[0]!.data.held, '9');
  assert.equal(projectedUpdate.records[0]!.version, 2); assert.equal(projectedUpdate.records[0]!.updated, FIXED_NOW);
  const executions = w.executions(), revision = await w.store.readRevision();
  assert.equal((await invoke({ ...w, envelope: w.envelope })).status, 'replayed');
  assert.equal((await invoke({ ...w, envelope: updateEnvelope })).status, 'replayed');
  assert.equal(w.executions(), executions); assert.equal(await w.store.readRevision(), revision);
});

test('foreign account, current source grant, full ancestor and tracked Identity loss mask saved Budget rows', async () => {
  for (const loss of ['account', 'source', 'ancestor', 'membership', 'parent-lifetime'] as const) {
    const w = await world(); assert.equal((await projectGeneratedCrudReceipt(w)).records.length, 1);
    if (loss === 'source') w.access.budget = false;
    else if (loss === 'ancestor') w.access.parent = false;
    else if (loss === 'membership') await w.memberships.removeMembership(w.reader.membership.membership_id);
    else {
      const model = loss === 'account' ? BUDGET : PARENT, id = loss === 'account' ? w.saved.id : asId('workspace');
      const row = await w.store.load(model, id); assert.ok(row);
      await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'update', model, id,
        expectedVersion: row.version, row: { ...row, version: asVersion(row.version + 1),
          ...(loss === 'account' ? { data: { ...row.data, account: { id: w.reader.user.user_id } } } : { archivedAt: FIXED_NOW }) } }] }));
    }
    assert.deepEqual(await projectGeneratedCrudReceipt(w), { result: null, records: [] });
    const executions = w.executions(); assert.equal((await invoke({ ...w, envelope: w.envelope })).status, 'replayed'); assert.equal(w.executions(), executions);
  }
});

test('original secret and current secret exclusions remain closed even when source grants include the saved original secret', async () => {
  const w = await world(), projected = await projectGeneratedCrudReceipt(w);
  assert.equal(Object.hasOwn(projected.records[0]!.data, 'original_secret'), false);
  assert.equal(Object.hasOwn(projected.records[0]!.data, 'later_secret'), false);
  assert.ok(typeof w.saved.data.original_secret === 'string'); assert.equal(w.saved.data.later_secret, 'Current-secret saved value');
});

test('genuine physical removal null association and earlier saved create both disclose no target records', async () => {
  const w = await world();
  const result = await invoke({ ...w, envelope: makeEnvelope(`${BUDGET}.delete`, operationId(), { record: { id: w.saved.id, version: '1' } }) });
  assert.equal(result.status, 'committed'); assert.equal(result.result, null);
  const removal = w.receipts.at(-1)!;
  assert.equal(await w.store.load(BUDGET, w.saved.id), null);
  assert.deepEqual(await projectGeneratedCrudReceipt({ ...w, receipt: removal }), { result: null, records: [] });
  assert.deepEqual(await projectGeneratedCrudReceipt(w), { result: null, records: [] });
});


test('a genuine committed foreign-account row does not acquire saved disclosure from membership or its generated association', async () => {
  const w = await world();
  const foreign = await invoke({ ...w, envelope: makeEnvelope(`${BUDGET}.create`, operationId(), {
    parent: { id: 'workspace', version: '1' }, account: { id: w.reader.user.user_id }, held: '7', note: 'Foreign account', later_secret: 'Secret',
  }) });
  assert.equal(foreign.status, 'committed');
  const receipt = w.receipts.at(-1)!;
  assert.deepEqual(await projectGeneratedCrudReceipt({ ...w, receipt }), { result: null, records: [] });
});

test('by-only target source authority uses the current static WHERE mask on saved fields and cannot escape denied or missing ancestors', async () => {
  const w = await world(), row = await w.store.load(BUDGET, w.saved.id); assert.ok(row);
  await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'update', model: BUDGET, id: row.id,
    expectedVersion: row.version, row: { ...row, version: asVersion(row.version + 1),
      data: { ...row.data, note: 'Current allowed', held: '20' } } }] }));
  const policy = buildPolicyTable([
    { model: PARENT, secretFields: [], grants: [{ by: 'members', fields: ['title'] }] },
    { model: BUDGET, secretFields: ['held', 'later_secret'], grants: [{ by: 'members', fields: ['account', 'note', 'original_secret'],
      when: { op: 'eq', field: 'note', value: 'Current allowed' } }] },
  ]);
  const reads: Map<ModelName, ViewerSourceReadPolicy> = new Map(w.sourceReadPolicies);
  reads.set(BUDGET, { by: 'members', parent: PARENT });
  const request = { ...w, policy, sourceReadPolicies: reads };
  const projected = await projectGeneratedCrudReceipt(request);
  assert.equal(projected.records.length, 1);
  assert.deepEqual(projected.records[0]!.data, { account: { id: w.member.user.user_id }, note: 'Saved original' });
  assert.equal(projected.records[0]!.version, w.saved.version);
  w.access.parent = false;
  assert.deepEqual(await projectGeneratedCrudReceipt(request), { result: null, records: [] });
  w.access.parent = true;
  const missing = new Map(reads); missing.delete(PARENT);
  assert.deepEqual(await projectGeneratedCrudReceipt({ ...request, sourceReadPolicies: missing }), { result: null, records: [] });
  const denied = new Map(reads); denied.set(BUDGET, { by: { role: 'CrudSource.unavailable' }, parent: PARENT });
  assert.deepEqual(await projectGeneratedCrudReceipt({ ...request, sourceReadPolicies: denied }), { result: null, records: [] });
  const deniedWhere = buildPolicyTable([{ model: BUDGET, secretFields: [], grants: [{ by: 'members', fields: ['account', 'note'],
    when: { op: 'eq', field: 'note', value: 'Saved original' } }] }]);
  assert.deepEqual(await projectGeneratedCrudReceipt({ ...request, policy: deniedWhere }), { result: null, records: [] });
});


test('by-only source with a current related-user role uses one coherent caller/subject authority while preserving original saved account and metadata', async () => {
  const w = await world();
  await w.memberships.setMembershipRoles(w.reader.membership.membership_id, [{ role: 'CrudSource.reader',
    granted_at: new Date(FIXED_NOW).toISOString(), granted_by: w.member.user.user_id }]);
  const changed = await invoke({ ...w, envelope: makeEnvelope(`${BUDGET}.update`, operationId(), {
    record: { id: w.saved.id, version: '1' }, account: { id: w.reader.user.user_id },
  }) });
  assert.equal(changed.status, 'committed');
  const policy = buildPolicyTable([
    { model: PARENT, secretFields: [], grants: [{ by: 'members', fields: ['title'] }] },
    { model: BUDGET, secretFields: ['held', 'later_secret'], grants: [{
      by: { roleSubject: { role: 'CrudSource.reader', person: { model: BUDGET, field: 'account' } } },
      fields: ['account', 'note', 'original_secret'],
    }] },
  ], w.models);
  const sourceReadPolicies: Map<ModelName, ViewerSourceReadPolicy> = new Map(w.sourceReadPolicies);
  sourceReadPolicies.set(BUDGET, { by: 'members', parent: PARENT });
  const request = { ...w, policy, sourceReadPolicies };
  const projected = await projectGeneratedCrudReceipt(request);
  assert.equal(projected.records.length, 1);
  assert.deepEqual(projected.records[0]!.data, { account: { id: w.member.user.user_id }, note: 'Saved original' });
  assert.equal(projected.records[0]!.version, w.saved.version); assert.equal(projected.records[0]!.created, w.saved.created);
  assert.equal(projected.records[0]!.createdBy, w.member.user.user_id); assert.equal(projected.records[0]!.updated, w.saved.updated);
  assert.deepEqual((await w.store.load(BUDGET, w.saved.id))!.data.account, { id: w.reader.user.user_id });
  await w.memberships.setMembershipRoles(w.reader.membership.membership_id, []);
  assert.deepEqual(await projectGeneratedCrudReceipt(request), { result: null, records: [] });
});
