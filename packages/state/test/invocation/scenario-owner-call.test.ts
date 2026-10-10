/** Defining same-owner call controls. Hand-built checked descriptors exercise
 * State's boundary; they do not qualify Compiler or the original Workbench.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ClosedInputs, Receipt, StoredRow } from '@canlang/contracts';
import { makeInvocation, makeRecordRef } from '@canlang/values';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { buildModelTable, type InterimHook, type InterimInvariant } from '../../src/mutation/models.js';
import type { OwnerMutationSession } from '../../src/mutation/pipeline.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { invoke, type ExecutionEffects } from '../../src/invocation/invoke.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptCallProducer, invokeScenarioReceiptCall,
  selectScenarioReceiptReturn, observeScenarioReceiptDependency, readScenarioReceiptAssociation, observeScenarioReceiptIntrinsic, projectScenarioReceipt, observeScenarioInputComputedDefault } from '../../src/invocation/scenario-receipt.js';
import { FIXED_NOW, asModel, createMemoryIdentityStore, makeBatch, makeEnvelope, makeIdentity,
  seedMember, seedRow, uuidv7 } from './fixtures.js';
import { field, modelDef, hook, invariant } from '../mutation/fixtures.js';

const MODEL = asModel('Calls.Task'), ROOT = 'Calls.approve', UPDATE = `${MODEL}.update`, COMPLETE = 'Calls.complete';
const APP = 'owner-call-app', bounds = { maxRows: 10, maxWork: 1000 }, cause = { cause: 'scenario' } as const;
let sequence = 70_000;
const source = () => ({ path: 'calls.can', sha256: 'd'.repeat(64), module: 'calls.mjs' });
function artifact(scalarChild = false, childIntrinsic = false): ArtifactDescriptorSlice {
  const disclosure = (id: string) => ({ version: 1 as const, source: source(), returns: [
    { id, source: source(), influences: [], dependencies: [] },
  ] });
  return { artifact_version: 1, sources: [{ path: 'calls.can', sha256: 'd'.repeat(64) }],
    modules: [{ path: 'calls.mjs', js: 'export const identity="Calls.approve";', map: {
      version: 3, file: 'calls.mjs', sources: ['calls.can'], sourcesContent: [null], names: [], mappings: '',
    } }],
    callables: [ROOT, COMPLETE].map(id => ({ id, kind: 'operation' as const,
      module: 'calls.mjs', export: 'identity', member: [id.split('.').at(-1)!] })),
    models: [{ name: MODEL, deleteMode: 'archive', fields: [
      { name: 'key', field: { kind: 'string' }, required: true, serverOnly: false },
      { name: 'done', field: { kind: 'boolean' }, required: false, serverOnly: false },
      { name: 'approved', field: { kind: 'boolean' }, required: false, serverOnly: false },
    ] }],
    operations: [
      { name: ROOT, kind: 'scenario', description: '', inputs: { fields: [] },
        result: { type: 'void' as CanTypeId, disclosure: disclosure('root-return') } },
      { name: UPDATE, kind: 'update', description: '', inputs: { fields: [
        { name: 'record', field: { kind: 'ref', model: MODEL, requireVersion: true }, required: true },
        { name: 'key', field: { kind: 'string' }, required: false },
        { name: 'done', field: { kind: 'boolean' }, required: false },
      ] } },
      { name: COMPLETE, kind: 'scenario', description: '', inputs: { fields: [
        { name: 'task', field: { kind: 'ref', model: MODEL, requireVersion: true }, required: true },
      ] }, result: { type: (scalarChild ? 'text' : 'void') as CanTypeId, disclosure: scalarChild ? {
        version: 1, source: source(), returns: [{ id: 'complete-return', source: source(), influences: [], dependencies: [
          { id: 'child-key', source: source(), role: 'data', model: MODEL, field: 'key', type: 'text' as CanTypeId },
        ], ...(childIntrinsic ? { intrinsics: [{ id: 'child-version', source: source(), role: 'data' as const,
          kind: 'admitted-reference-version' as const, parameter: 'task', model: MODEL, type: 'int' as CanTypeId }] } : {}) }],
      } : disclosure('complete-return') } },
    ],
  };
}
const stateError = (error: unknown) => error instanceof StateError;
const empty = (): ExecutionEffects => ({ result: null, writes: [], history: [], outbox: [], schedules: [],
  uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {} });
async function world(scalarChild = false, childRole = false, childIntrinsic = false) {
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false, roles: childRole ? ['Calls.worker'] : [] });
  const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
  const loaded = loadArtifactDescriptors(artifact(scalarChild, childIntrinsic), { by: def =>
    childRole && def.name === COMPLETE ? { role: 'Calls.worker' } : 'members' });
  const table = buildModelTable([modelDef(MODEL, { fields: {
    key: field({ required: true }), done: field({ default: false }), approved: field({ default: false }),
  }, uniqueKeys: ['key'] })]);
  const seed = await seedRow(store, MODEL, { data: { key: 'original', done: false, approved: false } });
  const row = await store.load(MODEL, seed.id); assert.ok(row);
  await store.commit(makeBatch(await store.readRevision(), { uniqueClaims: [
    { model: MODEL, recordId: row.id, keyName: 'key', keyValue: 'original' },
  ] }));
  const policy = buildPolicyTable([{ model: MODEL, secretFields: [], grants: [{ by: 'members', fields: ['key','done','approved'] }] }]);
  const parent = loaded.registry.get(ROOT), update = loaded.registry.get(UPDATE), complete = loaded.registry.get(COMPLETE);
  assert.ok(parent && isGeneratedOperationDef(parent)); assert.ok(update && isGeneratedOperationDef(update));
  assert.ok(complete && isGeneratedOperationDef(complete));
  return { store, memberships, member, identity, table, row, policy, parent, update, complete,
    registry: loaded.registry, app: APP, source: 'test', clock: { nowMs: () => FIXED_NOW },
    envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), {}) };
}
type World = Awaited<ReturnType<typeof world>>;
function bind(w: World, execute?: (frame: { call: AdmittedCall; session: Pick<OwnerMutationSession, 'read' | 'stage' | 'views'> }) => Promise<unknown>) {
  let executions = 0, saved: AdmittedCall | undefined;
  bindScenarioReceiptCallProducer(w.parent, { source: source(), app: APP, registry: w.registry,
    sites: [
      { id: 'update-site', source: source(), kind: 'invocation', targets: [
        { operation: UPDATE, interface: w.update.descriptor },
      ], resultType: null },
      { id: 'complete-site', source: source(), kind: 'operation', targets: [
        { operation: COMPLETE, interface: w.complete.descriptor },
      ], resultType: w.complete.descriptor.result!.type },
    ],
    prepare: (_def, inputs) => inputs as ClosedInputs,
    execute: async frame => {
      executions++; saved = frame.call;
      if (execute) return execute(frame);
      assert.equal(frame.call.def.name, COMPLETE);
      assert.equal(frame.call.context.actor?.userId, w.identity.actor?.user_id);
      await frame.session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { done: true } }, cause);
      selectScenarioReceiptReturn(frame.call, w.store, 'complete-return');
      return null;
    },
  });
  return { get executions() { return executions; }, get saved() { return saved; } };
}
function target(w: World, version = BigInt(w.row.version)) {
  return makeInvocation(UPDATE, { record: makeRecordRef(MODEL, w.row.id, version), key: 'reviewed' });
}
async function domain(w: World) { return { row: await w.store.load(MODEL, w.row.id),
  history: await w.store.historyFor(MODEL, w.row.id), outbox: await w.store.outboxPending() }; }
async function finish(call: AdmittedCall, w: World, session: OwnerMutationSession): Promise<ExecutionEffects> {
  selectScenarioReceiptReturn(call, w.store, 'root-return');
  return { ...await session.finalize(), result: null, outbox: [] };
}

test('reviewed CRUD and native calls share one owner commit, net history and exact replay', async () => {
  const w = await world(), producer = bind(w), reviewed = target(w); let receipt: Receipt | undefined, roots = 0, commits = 0;
  assert.equal(w.row.version, 1);
  const originalCommit = w.store.commit;
  w.store.commit = async batch => { commits++; return originalCommit(batch); };
  const input = { ...w, execute: async (call: AdmittedCall) => {
    roots++;
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const result = await invokeScenarioReceiptCall(call, w.store, { site: 'update-site', target: reviewed, inputs: {} });
    assert.ok(result); assert.equal((result as { data: Record<string, unknown> }).data['key'], 'reviewed');
    await invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE,
      inputs: { task: { id: w.row.id, version: String((result as { version: number }).version) } } });
    assert.equal((reviewed.args['record'] as { version: bigint }).version, 1n);
    assert.ok(Object.isFrozen(reviewed)); assert.ok(Object.isFrozen(reviewed.args['record']));
    await session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { approved: true } }, cause);
    const output = await finish(call, w, session);
    assert.equal(output.writes.length, 1); assert.equal(output.history.length, 1);
    assert.deepEqual(output.history[0]!.before, w.row.data);
    assert.deepEqual(output.history[0]!.after, { key: 'reviewed', done: true, approved: true });
    assert.deepEqual(output.uniqueClaims, [{ model: MODEL, recordId: w.row.id, keyName: 'key', keyValue: 'reviewed' }]);
    assert.deepEqual(output.uniqueReleases, [{ model: MODEL, keyName: 'key', keyValue: 'original' }]);
    assert.deepEqual(output.resolvedDefaults, {});
    return output;
  }, observeCommittedReceipt: (value: Receipt) => { receipt = value; } };
  assert.equal((await invoke(input)).status, 'committed'); assert.ok(receipt);
  assert.equal(commits, 1); assert.equal(roots, 1); assert.equal(producer.executions, 1);
  const before = await domain(w), revision = await w.store.readRevision(), retained = receipt;
  assert.equal(before.row!.version, w.row.version + 1);
  assert.equal((await invoke(input)).status, 'replayed');
  assert.deepEqual(receipt, retained); assert.equal(roots, 1); assert.equal(producer.executions, 1); assert.equal(commits, 1);
  assert.deepEqual(await domain(w), before); assert.equal(await w.store.readRevision(), revision);
  assert.ok(producer.saved);
  assert.throws(() => selectScenarioReceiptReturn(producer.saved!, w.store, 'complete-return'), stateError);
});

test('a real post-call require failure rolls back child effects and approval', async () => {
  const w = await world(); bind(w); const before = await domain(w), revision = await w.store.readRevision();
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await invokeScenarioReceiptCall(call, w.store, { site: 'update-site', target: target(w), inputs: {} });
    await session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { approved: true } }, cause);
    const current = await session.read(MODEL, w.row.id); assert.equal(current!.data['key'], 'reviewed');
    throw new StateError('rule_failed', 'reviewed target violates the parent workflow');
  } }), stateError);
  assert.deepEqual(await domain(w), before); assert.equal(await w.store.readRevision(), revision + 1);
});

test('wrong target, stale reviewed ref, argument override, copied root and foreign store refuse and poison caught failures', async () => {
  for (const mode of ['target', 'version', 'override', 'copy', 'store', 'caller'] as const) {
    const w = await world(); bind(w); const before = await domain(w);
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      if (mode === 'caller') call.context = { ...call.context, actor: null };
      await assert.rejects(invokeScenarioReceiptCall(mode === 'copy' ? { ...call } : call,
        mode === 'store' ? { ...w.store } : w.store, { site: 'update-site',
          target: mode === 'target' ? makeInvocation(COMPLETE, {}) : target(w, mode === 'version' ? 0n : BigInt(w.row.version)),
          inputs: mode === 'override' ? { key: 'unreviewed' } : {},
        }), stateError);
      await assert.rejects(session.finalize(), stateError);
      return empty();
    } }), stateError);
    assert.deepEqual(await domain(w), before);
  }
});

test('current child authority is checked again after parent admission', async () => {
  const w = await world(); bind(w); const before = await domain(w);
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await w.memberships.removeMembership(w.member.membership.membership_id);
    await assert.rejects(invokeScenarioReceiptCall(call, w.store, { site: 'update-site', target: target(w), inputs: {} }), stateError);
    await assert.rejects(session.finalize(), stateError); return empty();
  } }), stateError);
  assert.deepEqual(await domain(w), before);
});

test('binder refuses a foreign checked source before a target can execute', async () => {
  const w = await world();
  assert.throws(() => bindScenarioReceiptCallProducer(w.parent, {
    source: { ...source(), sha256: 'e'.repeat(64) }, app: APP, registry: w.registry,
    sites: [{ id: 'foreign', source: source(), kind: 'operation', targets: [
      { operation: COMPLETE, interface: w.complete.descriptor },
    ], resultType: 'void' as CanTypeId }], prepare: (_def, inputs) => inputs as ClosedInputs,
    execute: async () => null,
  }), stateError);
});

test('concurrent child calls refuse and the caught child exception cannot finalize', async () => {
  const w = await world(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  bind(w, async frame => { entered(); await gate;
    selectScenarioReceiptReturn(frame.call, w.store, 'complete-return'); return null; });
  const before = await domain(w);
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const first = invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE,
      inputs: { task: { id: w.row.id, version: String(w.row.version) } } });
    await ready;
    try { await assert.rejects(invokeScenarioReceiptCall(call, w.store, { site: 'update-site', target: target(w), inputs: {} }), stateError); }
    finally { release(); }
    await Promise.allSettled([first]);
    await assert.rejects(session.finalize(), stateError); return empty();
  } }), stateError);
  assert.deepEqual(await domain(w), before);
});


test('a caught native child failure after a staged mutation remains terminal for the root', async () => {
  const w = await world();
  bind(w, async frame => {
    await frame.session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { done: true } }, cause);
    throw new StateError('rule_failed', 'current target guard failed');
  });
  const before = await domain(w);
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await assert.rejects(invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE,
      inputs: { task: { id: w.row.id, version: String(w.row.version) } } }), stateError);
    await assert.rejects(session.finalize(), stateError); return empty();
  } }), stateError);
  assert.deepEqual(await domain(w), before);
});


test('a checked scalar child captures its actual current row and retains the complete child result closure', async () => {
  const w = await world(true); let receipt: Receipt | undefined;
  const producer = bind(w, async frame => {
    const row = await frame.session.read(MODEL, w.row.id); assert.ok(row);
    await observeScenarioReceiptDependency(frame.call, w.store, {
      dependencyId: 'child-key', model: MODEL, row, field: 'key',
    });
    selectScenarioReceiptReturn(frame.call, w.store, 'complete-return');
    return row.data['key'];
  });
  const result = await invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const updated = await invokeScenarioReceiptCall(call, w.store, { site: 'update-site', target: target(w), inputs: {} });
    const answer = await invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE,
      inputs: { task: { id: w.row.id, version: String((updated as { version: number }).version) } } });
    assert.equal(answer, 'reviewed');
    return finish(call, w, session);
  }, observeCommittedReceipt: value => { receipt = value; } });
  assert.equal(result.status, 'committed'); assert.equal(producer.executions, 1); assert.ok(receipt);
  const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
  const child = association.calls!.find(call => call.target === COMPLETE); assert.ok(child);
  assert.equal(child.result, 'reviewed'); assert.equal(child.scenario!.resultType, 'text');
  assert.equal(child.scenario!.returnId, 'complete-return');
  assert.equal(child.scenario!.observations.length, 1);
  assert.equal(child.scenario!.observations[0]!.dependencyId, 'child-key');
  assert.equal(child.scenario!.observations[0]!.row.data['key'], 'reviewed');
  assert.equal(child.scenario!.observations[0]!.row.version, w.row.version + 1);
  assert.ok(producer.saved);
  await assert.rejects(observeScenarioReceiptDependency(producer.saved!, w.store, {
    dependencyId: 'child-key', model: MODEL, row: child.scenario!.observations[0]!.row, field: 'key',
  }), stateError);
});

test('reusing an original frozen invocation after a child stage moves its version refuses stale admission', async () => {
  const w = await world(); bind(w); const reviewed = target(w), before = await domain(w);
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await invokeScenarioReceiptCall(call, w.store, { site: 'update-site', target: reviewed, inputs: {} });
    assert.equal((reviewed.args['record'] as { version: bigint }).version, 1n);
    await assert.rejects(invokeScenarioReceiptCall(call, w.store, {
      site: 'update-site', target: reviewed, inputs: {},
    }), stateError);
    await assert.rejects(session.finalize(), stateError); return empty();
  } }), stateError);
  assert.deepEqual(await domain(w), before);
});


test('child role revoked after a successful call prevents the owner commit while parent membership stays active', async () => {
  const w = await world(false, true); bind(w); const before = await domain(w); let committed: Receipt | undefined;
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE,
      inputs: { task: { id: w.row.id, version: String(w.row.version) } } });
    await w.memberships.createMembership({ team_id: w.member.team.team_id, user_id: w.member.user.user_id,
      is_owner: false, roles: [] });
    const current = await w.memberships.findMembership(w.member.team.team_id, w.member.user.user_id);
    assert.equal(current!.status, 'active'); assert.deepEqual(current!.roles, []);
    await session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { approved: true } }, cause);
    return finish(call, w, session);
  }, observeCommittedReceipt: value => { committed = value; } }), stateError);
  assert.equal(committed, undefined); assert.deepEqual(await domain(w), before);
});

test('a trusted actor-null root cannot invoke a member-authorized child', async () => {
  const w = await world(); bind(w); const before = await domain(w);
  await assert.rejects(invoke({ ...w, kind: 'trusted', trustedSource: 'Calls.reviewed-handler', execute: async call => {
    assert.equal(call.context.actor, null);
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await assert.rejects(invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE,
      inputs: { task: { id: w.row.id, version: String(w.row.version) } } }), stateError);
    await assert.rejects(session.finalize(), stateError); return empty();
  } }), stateError);
  assert.deepEqual(await domain(w), before);
});

test('a frozen invocation refuses a non-overlapping authored argument rather than extending its reviewed inputs', async () => {
  const w = await world(); bind(w); const before = await domain(w), reviewed = target(w);
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await assert.rejects(invokeScenarioReceiptCall(call, w.store, {
      site: 'update-site', target: reviewed, inputs: { done: true },
    }), stateError);
    assert.equal(Object.hasOwn(reviewed.args, 'done'), false);
    await assert.rejects(session.finalize(), stateError); return empty();
  } }), stateError);
  assert.deepEqual(await domain(w), before);
});

test('child reference-version intrinsic retains its exact admitted staged row and current projection checks child closure', async () => {
  const w = await world(true, true, true); let receipt: Receipt | undefined;
  bind(w, async frame => {
    const row = await frame.session.read(MODEL, w.row.id); assert.ok(row);
    await observeScenarioReceiptDependency(frame.call, w.store, {
      dependencyId: 'child-key', model: MODEL, row, field: 'key',
    });
    const reference = frame.call.recordRefs[0]; assert.ok(reference);
    assert.equal(reference.row.version, w.row.version + 1);
    await observeScenarioReceiptIntrinsic(frame.call, w.store, { dependencyId: 'child-version',
      kind: 'admitted-reference-version', reference, wire: String(reference.row.version) });
    selectScenarioReceiptReturn(frame.call, w.store, 'complete-return'); return row.data['key'];
  });
  await invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const updated = await invokeScenarioReceiptCall(call, w.store, { site: 'update-site', target: target(w), inputs: {} });
    assert.equal(await invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE,
      inputs: { task: { id: w.row.id, version: String((updated as { version: number }).version) } } }), 'reviewed');
    return finish(call, w, session);
  }, observeCommittedReceipt: value => { receipt = value; } });
  assert.ok(receipt);
  const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
  const child = association.calls!.find(value => value.target === COMPLETE)!;
  const original = child.scenario!.intrinsics![0]!;
  assert.equal(original.kind, 'admitted-reference-version'); assert.equal(original.wire, '2');
  if (original.kind !== 'admitted-reference-version') throw new Error('expected actual child reference version');
  assert.equal(original.row.version, 2); assert.equal(original.row.data['key'], 'reviewed');
  const visible = await projectScenarioReceipt({ ...w, receipt });
  assert.equal(visible.records.length, 1);
  const hiddenPolicy = buildPolicyTable([{ model: MODEL, secretFields: [],
    grants: [{ by: 'members', fields: ['done', 'approved'] }] }]);
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt, policy: hiddenPolicy }), { result: null, records: [] });
  await w.memberships.createMembership({ team_id: w.member.team.team_id, user_id: w.member.user.user_id,
    is_owner: false, roles: [] });
  assert.equal((await w.memberships.findMembership(w.member.team.team_id, w.member.user.user_id))!.status, 'active');
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
});


const CREATE = `${MODEL}.create`;
async function createWorld(options: { hooks?: readonly InterimHook[]; finalInvariant?: boolean; scalarInput?: boolean } = {}) {
  const base = await world(), slice = artifact();
  slice.models![0]!.fields.push({ name: 'stamped', field: { kind: 'boolean' }, required: false, serverOnly: true });
  for (const entry of slice.models![0]!.fields) if (entry.name === 'done' || entry.name === 'approved') {
    entry.default = { kind: 'literal', value: false };
  }
  slice.operations!.push({ name: CREATE, kind: 'create', description: '', inputs: { fields: [
    { name: 'key', field: { kind: 'string' }, required: true },
    { name: 'done', field: { kind: 'boolean' }, required: false },
  ] } });
  if (options.scalarInput) slice.operations!.find(op => op.name === COMPLETE)!.inputs.fields.push({
    name: 'enabled', field: { kind: 'boolean' }, required: true,
  });
  const loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const parent = loaded.registry.get(ROOT), update = loaded.registry.get(UPDATE), complete = loaded.registry.get(COMPLETE);
  const create = loaded.registry.get(CREATE);
  assert.ok(parent && isGeneratedOperationDef(parent)); assert.ok(update && isGeneratedOperationDef(update));
  assert.ok(complete && isGeneratedOperationDef(complete)); assert.ok(create && isGeneratedOperationDef(create));
  const table = buildModelTable([modelDef(MODEL, { fields: {
    key: field({ required: true }), done: field({ default: false }), approved: field({ default: false }),
    stamped: field({ serverOnly: true }),
  }, uniqueKeys: ['key'], hooks: options.hooks ?? [], invariants: options.finalInvariant ? [
    invariant('parent approval must remain false', view => {
      if (view.get(MODEL, base.row.id)?.data['approved'] === true) {
        throw new StateError('rule_failed', 'Final parent approval violates the owner invariant.');
      }
    }),
  ] : [] })]);
  return { ...base, parent, update, complete, create, table, registry: loaded.registry };
}
type CreateWorld = Awaited<ReturnType<typeof createWorld>>;
function bindCreates(w: CreateWorld) {
  let executions = 0;
  bindScenarioReceiptCallProducer(w.parent, { source: source(), app: APP, registry: w.registry, sites: [
    { id: 'create-site', source: source(), kind: 'operation', targets: [
      { operation: CREATE, interface: w.create.descriptor },
    ], resultType: null },
    { id: 'complete-site', source: source(), kind: 'operation', targets: [
      { operation: COMPLETE, interface: w.complete.descriptor },
    ], resultType: 'void' as CanTypeId },
  ], prepare: (_def, inputs) => inputs as ClosedInputs,
  execute: async frame => {
    executions++;
    await frame.session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { done: true } }, cause);
    selectScenarioReceiptReturn(frame.call, w.store, 'complete-return'); return null;
  } });
  return { get executions() { return executions; } };
}
async function createTwo(call: AdmittedCall, w: CreateWorld) {
  const first = await invokeScenarioReceiptCall(call, w.store, { site: 'create-site', target: CREATE, inputs: { key: 'first' } }) as StoredRow;
  const second = await invokeScenarioReceiptCall(call, w.store, { site: 'create-site', target: CREATE, inputs: { key: 'second' } }) as StoredRow;
  assert.notEqual(first.id, second.id);
  assert.equal(first.id, `${w.envelope.operation_id}/call/1`);
  assert.equal(second.id, `${w.envelope.operation_id}/call/2`);
  return [first, second] as const;
}

test('two child CRUD creates have distinct stable identities, defaults, one owner receipt and duplicate-free replay', async () => {
  const w = await createWorld(), producer = bindCreates(w); let receipt: Receipt | undefined;
  let roots = 0, commits = 0; const commit = w.store.commit;
  w.store.commit = async batch => { commits++; return commit(batch); };
  let created: readonly [StoredRow, StoredRow] | undefined;
  const input = { ...w, execute: async (call: AdmittedCall) => {
    roots++; const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    created = await createTwo(call, w);
    for (const row of created) { assert.equal(row.version, 1); assert.equal(row.data['done'], false); assert.equal(row.data['approved'], false); }
    await session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { approved: true } }, cause);
    const output = await finish(call, w, session);
    assert.equal(output.writes.length, 3); assert.equal(output.history.length, 3);
    assert.deepEqual(output.resolvedDefaults, {
      [`0:${MODEL}.done`]: false, [`0:${MODEL}.approved`]: false,
      [`1:${MODEL}.done`]: false, [`1:${MODEL}.approved`]: false,
    });
    for (const row of created) {
      const entry = output.history.find(value => value.recordId === row.id)!;
      assert.equal(entry.operation, CREATE); assert.equal(entry.operationId, w.envelope.operation_id);
      assert.equal(entry.change, 'create'); assert.equal(entry.before, null);
    }
    return output;
  }, observeCommittedReceipt: (value: Receipt) => { receipt = value; } };
  assert.equal((await invoke(input)).status, 'committed'); assert.ok(receipt); assert.ok(created);
  assert.equal(commits, 1); assert.equal(producer.executions, 0);
  const stored = await Promise.all(created.map(row => w.store.load(MODEL, row.id)));
  assert.deepEqual(stored, created);
  assert.equal((await w.store.query({ model: MODEL, authority: 'owner', limit: 10 })).length, 3);
  const before = await domain(w), revision = await w.store.readRevision(), retained = receipt;
  assert.equal((await invoke(input)).status, 'replayed'); assert.equal(roots, 1); assert.equal(commits, 1);
  assert.deepEqual(receipt, retained); assert.deepEqual(await domain(w), before);
  assert.deepEqual(await Promise.all(created.map(row => w.store.load(MODEL, row.id))), stored);
  assert.equal(await w.store.readRevision(), revision);
  assert.equal((await w.store.query({ model: MODEL, authority: 'owner', limit: 10 })).length, 3);
  assert.equal(readScenarioReceiptAssociation(receipt)!.calls!.length, 2);
});

test('child CRUD alone activates real hooks with authored candidate values and child operation attribution', async () => {
  const seen: { op: string; before: unknown; actor: string; key: unknown; done: unknown }[] = [];
  const stamp = hook('child create stamp', ['create', 'update'], (candidate, ctx) => {
    seen.push({ op: ctx.op, before: ctx.before, actor: ctx.actor, key: candidate['key'], done: candidate['done'] });
    return { ...candidate, stamped: true };
  });
  const w = await createWorld({ hooks: [stamp] }); bindCreates(w);
  await invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const row = await invokeScenarioReceiptCall(call, w.store, {
      site: 'create-site', target: CREATE, inputs: { key: 'authored', done: true },
    }) as StoredRow;
    assert.deepEqual(seen, [{ op: 'create', before: null, actor: w.member.user.user_id, key: 'authored', done: true }]);
    assert.equal(row.data['stamped'], true);
    await invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE,
      inputs: { task: { id: w.row.id, version: String(w.row.version) } } });
    await session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { approved: true } }, cause);
    assert.equal(seen.length, 1);
    const output = await finish(call, w, session);
    const childHistory = output.history.find(entry => entry.recordId === row.id)!;
    assert.equal(childHistory.operation, CREATE); assert.equal(childHistory.operationId, w.envelope.operation_id);
    assert.equal(childHistory.after!['stamped'], true);
    return output;
  } });
  assert.equal(seen.length, 1);
});

test('a genuine final owner invariant rolls back both created children and the later parent mutation', async () => {
  const w = await createWorld({ finalInvariant: true }); bindCreates(w); const before = await domain(w);
  let created: readonly [StoredRow, StoredRow] | undefined;
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    created = await createTwo(call, w);
    await session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { approved: true } }, cause);
    return finish(call, w, session);
  } }), error => error instanceof StateError && error.code === 'rule_failed');
  assert.ok(created); assert.deepEqual(await domain(w), before);
  for (const row of created) { assert.equal(await w.store.load(MODEL, row.id), null); assert.deepEqual(await w.store.historyFor(MODEL, row.id), []); }
});

test('a static child refuses a wrong scalar authored input before native execution', async () => {
  const w = await createWorld({ scalarInput: true }), producer = bindCreates(w), before = await domain(w);
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await assert.rejects(invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE,
      inputs: { task: { id: w.row.id, version: String(w.row.version) }, enabled: 'true' } }), stateError);
    await assert.rejects(session.finalize(), stateError); return empty();
  } }), stateError);
  assert.equal(producer.executions, 0); assert.deepEqual(await domain(w), before);
});

test('a caught copied actual child facade refusal poisons its enclosing owner', async () => {
  const w = await world(), before = await domain(w);
  bind(w, async frame => {
    await assert.rejects(invokeScenarioReceiptCall({ ...frame.call }, w.store, {
      site: 'update-site', target: target(w), inputs: {},
    }), stateError);
    selectScenarioReceiptReturn(frame.call, w.store, 'complete-return'); return null;
  });
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await assert.rejects(invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE,
      inputs: { task: { id: w.row.id, version: String(w.row.version) } } }), stateError);
    await assert.rejects(session.finalize(), stateError); return empty();
  } }), stateError);
  assert.deepEqual(await domain(w), before);
});


test('a caught copied actual child return observer poisons the enclosing transaction', async () => {
  const w = await world(), before = await domain(w); let refused = false;
  bind(w, async frame => {
    await frame.session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { done: true } }, cause);
    assert.throws(() => selectScenarioReceiptReturn({ ...frame.call }, w.store, 'complete-return'), stateError);
    refused = true;
    return null;
  });
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await assert.rejects(invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE,
      inputs: { task: { id: w.row.id, version: String(w.row.version) } } }), stateError);
    await assert.rejects(session.finalize(), stateError); return empty();
  } }), stateError);
  assert.equal(refused, true); assert.deepEqual(await domain(w), before);
});

async function rootComputedWorld() {
  const base = await world(), slice = artifact();
  slice.callables!.find(callable => callable.id === ROOT)!.inputStyle = 'parameters';
  slice.operations!.find(operation => operation.name === ROOT)!.inputs.fields.push({
    name: 'root_flag', field: { kind: 'boolean' }, valueType: 'bool' as CanTypeId,
    required: false, computedDefault: true,
  });
  const loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const parent = loaded.registry.get(ROOT), update = loaded.registry.get(UPDATE), complete = loaded.registry.get(COMPLETE);
  assert.ok(parent && isGeneratedOperationDef(parent)); assert.ok(update && isGeneratedOperationDef(update));
  assert.ok(complete && isGeneratedOperationDef(complete));
  return { ...base, parent, update, complete, registry: loaded.registry };
}

test('a child cannot contribute a computed default belonging to an eligible omitted root parameter', async () => {
  // This control checks State slot eligibility only; the generated expression
  // and native default observer remain their owning producer's qualification.
  const control = await rootComputedWorld();
  assert.equal((await invoke({ ...control, execute: async call => {
    assert.equal(Object.hasOwn(call.inputs, 'root_flag'), false);
    const session = await beginScenarioReceiptMutation(call, control.store, { table: control.table, bounds });
    observeScenarioInputComputedDefault(call, control.store, { name: 'root_flag', wire: true });
    const output = await finish(call, control, session);
    assert.deepEqual(output.resolvedDefaults, { root_flag: true }); return output;
  } })).status, 'committed');
  const w = await rootComputedWorld(), before = await domain(w); let refused = false;
  bind(w, async frame => {
    assert.equal(frame.call.def.name, COMPLETE);
    assert.throws(() => observeScenarioInputComputedDefault(frame.call, w.store, {
      name: 'root_flag', wire: true,
    }), stateError);
    refused = true; return null;
  });
  await assert.rejects(invoke({ ...w, execute: async call => {
    assert.equal(Object.hasOwn(call.inputs, 'root_flag'), false);
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await assert.rejects(invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE,
      inputs: { task: { id: w.row.id, version: String(w.row.version) } } }), stateError);
    await assert.rejects(session.finalize(), stateError); return empty();
  } }), stateError);
  assert.equal(refused, true); assert.deepEqual(await domain(w), before);
});

/** A finite rendezvous keeps overlap intentional without a hanging test. */
function boundedPairBarrier() {
  let arrived = 0, release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return async () => {
    if (++arrived === 2) release();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([ready, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Two independent native executions did not overlap.')), 5000);
    })]); } finally { if (timer !== undefined) clearTimeout(timer); }
  };
}

test('overlapping roots sharing one binder resolve private native references through exact parent pointers', async () => {
  const first = await world(), independent = await world();
  // Equal public context and operation identity in independent physical stores
  // make a context-keyed or global-current-execution adapter insufficient.
  const second = { ...independent, parent: first.parent, update: first.update, complete: first.complete,
    registry: first.registry, envelope: { ...first.envelope, inputs: {} } };
  const roots = new WeakMap<AdmittedCall, { world: World; issued: object; label: string }>();
  const gate = boundedPairBarrier(); let nativeExecutions = 0, rootExecutions = 0;
  let foreign: object | undefined;
  const resolve = (parent: AdmittedCall, value: unknown) => {
    const state = roots.get(parent);
    if (state === undefined || value !== state.issued) throw new StateError('forbidden', 'Foreign native protected reference.');
    return state;
  };
  bindScenarioReceiptCallProducer(first.parent, { source: source(), app: APP, registry: first.registry,
    sites: [{ id: 'complete-site', source: source(), kind: 'operation', targets: [
      { operation: COMPLETE, interface: first.complete.descriptor },
    ], resultType: 'void' as CanTypeId }],
    prepare: (_def, inputs, parent) => {
      const state = resolve(parent, inputs['task']);
      assert.throws(() => resolve({ ...parent }, inputs['task']), stateError);
      return { task: { id: state.world.row.id, version: String(state.world.row.version) } };
    },
    execute: async frame => {
      const state = roots.get(frame.parent);
      if (state === undefined) throw new StateError('forbidden', 'Native caller lifetime is unavailable.');
      nativeExecutions++; await gate();
      await frame.session.stage({ op: 'update', model: MODEL, id: state.world.row.id,
        data: { key: state.label, done: true } }, cause);
      selectScenarioReceiptReturn(frame.call, state.world.store, 'complete-return'); return null;
    },
  });
  const input = (w: World, label: string, supplied?: object) => ({ ...w, execute: async (call: AdmittedCall) => {
    rootExecutions++;
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const row = await session.read(MODEL, w.row.id); assert.ok(row);
    const issued = Object.freeze({ nativeReference: row });
    roots.set(call, { world: w, issued, label }); if (label === 'second') foreign = issued;
    await invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE,
      inputs: { task: supplied ?? issued } });
    return finish(call, w, session);
  } });
  const a = input(first, 'first'), b = input(second, 'second');
  const outcomes = await Promise.all([invoke(a), invoke(b)]);
  assert.deepEqual(outcomes.map(value => value.status), ['committed', 'committed']);
  assert.equal((await first.store.load(MODEL, first.row.id))!.data['key'], 'first');
  assert.equal((await second.store.load(MODEL, second.row.id))!.data['key'], 'second');
  assert.equal(rootExecutions, 2); assert.equal(nativeExecutions, 2);
  assert.deepEqual((await Promise.all([invoke(a), invoke(b)])).map(value => value.status), ['replayed', 'replayed']);
  assert.equal(rootExecutions, 2); assert.equal(nativeExecutions, 2);
  assert.ok(foreign); const before = await domain(first);
  await assert.rejects(invoke({ ...input(first, 'third', foreign),
    envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), {}) }), stateError);
  assert.equal(nativeExecutions, 2); assert.deepEqual(await domain(first), before);
});

test('a nested genuine call resolves its immediate child parent pointer and preserves the one owner rollback boundary', async () => {
  for (const rollback of [false, true]) {
    const w = await world(), before = await domain(w);
    const lifetimes = new WeakMap<AdmittedCall, { world: World; issued: object; root: AdmittedCall }>();
    let nestedParent: AdmittedCall | undefined, nativeExecutions = 0;
    bindScenarioReceiptCallProducer(w.complete, { source: source(), app: APP, registry: w.registry,
      sites: [{ id: 'nested-update', source: source(), kind: 'operation', targets: [
        { operation: UPDATE, interface: w.update.descriptor },
      ], resultType: null }],
      prepare: (_def, inputs, parent) => {
        const state = lifetimes.get(parent);
        if (state === undefined || parent === state.root || inputs['record'] !== state.issued) {
          throw new StateError('forbidden', 'Immediate native child lifetime required.');
        }
        nestedParent = parent;
        return { record: { id: state.world.row.id, version: String(state.world.row.version) }, key: 'nested' };
      }, execute: async () => { throw new Error('CRUD must use the genuine State stage.'); },
    });
    bindScenarioReceiptCallProducer(w.parent, { source: source(), app: APP, registry: w.registry,
      sites: [{ id: 'complete-site', source: source(), kind: 'operation', targets: [
        { operation: COMPLETE, interface: w.complete.descriptor },
      ], resultType: 'void' as CanTypeId }],
      prepare: (_def, inputs, parent) => {
        const state = lifetimes.get(parent);
        if (state === undefined || state.root !== parent || inputs['task'] !== state.issued) {
          throw new StateError('forbidden', 'Exact native root lifetime required.');
        }
        return { task: { id: state.world.row.id, version: String(state.world.row.version) } };
      },
      execute: async frame => {
        const root = lifetimes.get(frame.parent);
        if (root === undefined || root.root !== frame.parent) throw new StateError('forbidden', 'Root lifetime unavailable.');
        nativeExecutions++;
        const row = await frame.session.read(MODEL, root.world.row.id); assert.ok(row);
        const issued = Object.freeze({ nativeChildReference: row });
        lifetimes.set(frame.call, { world: root.world, issued, root: root.root });
        const updated = await invokeScenarioReceiptCall(frame.call, root.world.store, {
          site: 'nested-update', target: UPDATE, inputs: { record: issued },
        }) as StoredRow;
        assert.equal(nestedParent, frame.call); assert.notEqual(nestedParent, frame.parent);
        assert.equal(updated.data['key'], 'nested');
        selectScenarioReceiptReturn(frame.call, root.world.store, 'complete-return'); return null;
      },
    });
    let roots = 0;
    const input = { ...w, execute: async (call: AdmittedCall) => {
      roots++;
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      const row = await session.read(MODEL, w.row.id); assert.ok(row);
      const issued = Object.freeze({ nativeRootReference: row });
      lifetimes.set(call, { world: w, issued, root: call });
      await invokeScenarioReceiptCall(call, w.store, { site: 'complete-site', target: COMPLETE, inputs: { task: issued } });
      await session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { approved: true } }, cause);
      if (rollback) throw new StateError('rule_failed', 'Post-nested workflow requirement failed.');
      const output = await finish(call, w, session);
      assert.equal(output.writes.length, 1); assert.equal(output.history.length, 1); return output;
    } };
    if (rollback) {
      await assert.rejects(invoke(input), stateError); assert.deepEqual(await domain(w), before);
    } else {
      assert.equal((await invoke(input)).status, 'committed');
      assert.deepEqual((await w.store.load(MODEL, w.row.id))!.data, { key: 'nested', done: false, approved: true });
      assert.equal((await invoke(input)).status, 'replayed');
    }
    assert.equal(roots, 1); assert.equal(nativeExecutions, 1);
  }
});
