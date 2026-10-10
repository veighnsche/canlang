/** State owner controls using genuine invoke/Values and checked descriptors.
 * These do not qualify Compiler source or the Dev native producer. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, ClosedInputs, InvocationRef, StoredRow } from '@canlang/contracts';
import { makeInvocation, makeRecordRef } from '@canlang/values';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { buildModelTable } from '../../src/mutation/models.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { invoke, type ExecutionEffects } from '../../src/invocation/invoke.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import type { OwnerMutationSession } from '../../src/mutation/pipeline.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptCallProducer, invokeScenarioReceiptCall,
  selectScenarioReceiptReturn } from '../../src/invocation/scenario-receipt.js';
import { FIXED_NOW, asModel, createMemoryIdentityStore, makeBatch, makeEnvelope, makeIdentity,
  makeRow, seedMember, seedRow, uuidv7 } from './fixtures.js';
import { field, modelDef } from '../mutation/fixtures.js';

const MODEL = asModel('RefArrays.Task'), ROOT = 'RefArrays.root', CHILD = 'RefArrays.child';
const APP = 'owner-ref-array-app', bounds = { maxRows: 10, maxWork: 1000 }, cause = { cause: 'scenario' } as const;
const source = () => ({ path: 'refs.can', sha256: 'a'.repeat(64), module: 'refs.mjs' });
let sequence = 130_000;
type Options = { nullable?: boolean; min?: number; max?: number; versioned?: boolean; parent?: boolean };
function artifact(options: Options): ArtifactDescriptorSlice {
  const disclosure = (id: string) => ({ version: 1 as const, source: source(), returns: [
    { id, source: source(), influences: [], dependencies: [] },
  ] });
  return { artifact_version: 1, sources: [{ path: 'refs.can', sha256: 'a'.repeat(64) }],
    modules: [{ path: 'refs.mjs', js: 'export const identity="RefArrays.root";', map: {
      version: 3, file: 'refs.mjs', sources: ['refs.can'], sourcesContent: [null], names: [], mappings: '',
    } }],
    callables: [ROOT, CHILD].map(id => ({ id, kind: 'operation' as const,
      module: 'refs.mjs', export: 'identity', member: [id.split('.').at(-1)!] })),
    models: [{ name: MODEL, deleteMode: 'archive', fields: [
      { name: 'done', field: { kind: 'boolean' }, required: true, serverOnly: false },
    ] }],
    operations: [
      { name: ROOT, kind: 'scenario', description: '', inputs: { fields: [] },
        result: { type: 'void' as CanTypeId, disclosure: disclosure('root-return') } },
      { name: CHILD, kind: 'scenario', description: '', inputs: { fields: [
        { name: 'targets', field: { kind: 'ref', model: MODEL, requireVersion: options.versioned ?? true },
          required: true, array: { required: false }, nullable: options.nullable ?? false,
          min: options.min ?? 0, max: options.max ?? 4 },
        { name: 'one', field: { kind: 'ref', model: MODEL, requireVersion: options.versioned ?? true },
          required: false, nullable: true },
      ] }, result: { type: 'void' as CanTypeId, disclosure: disclosure('child-return') } },
    ],
  };
}
async function world(options: Options = {}) {
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
  const loaded = loadArtifactDescriptors(artifact(options), { by: 'members' });
  const parent = loaded.registry.get(ROOT), child = loaded.registry.get(CHILD);
  assert.ok(parent && isGeneratedOperationDef(parent)); assert.ok(child && isGeneratedOperationDef(child));
  const first = await seedRow(store, MODEL, { id: 'task-a', data: { done: false } });
  const second: StoredRow = { ...makeRow({ id: 'task-b', data: { done: false } }),
    ...(options.parent ? { parent: { model: asModel('Imported.Parent'), id: first.id } } : {}) };
  await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: MODEL, row: second }] }));
  const table = buildModelTable([modelDef(MODEL, { fields: { done: field({ required: true }) } })]);
  const policy = buildPolicyTable([{ model: MODEL, secretFields: [], grants: [{ by: 'members', fields: ['done'] }] }]);
  return { store, memberships, identity, parent, child, table, policy, rows: [first, second] as const,
    registry: loaded.registry, app: APP, source: 'test', clock: { nowMs: () => FIXED_NOW },
    envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), {}) };
}
type World = Awaited<ReturnType<typeof world>>;
type Frame = { call: AdmittedCall; session: Pick<OwnerMutationSession, 'read' | 'stage' | 'views'> };
function bind(w: World, execute: (frame: Frame) => Promise<void>) {
  let executions = 0;
  bindScenarioReceiptCallProducer(w.parent, { source: source(), app: APP, registry: w.registry,
    sites: (['operation', 'invocation'] as const).map(kind => ({ id: kind, source: source(), kind,
      targets: [{ operation: CHILD, interface: w.child.descriptor }], resultType: 'void' as CanTypeId })),
    prepare: (_def, inputs) => inputs as ClosedInputs,
    execute: async frame => {
      executions++; await execute(frame); selectScenarioReceiptReturn(frame.call, w.store, 'child-return'); return null;
    },
  });
  return { get executions() { return executions; } };
}
const wire = (row: StoredRow, version: number | null = row.version) => ({ id: row.id,
  ...(version === null ? {} : { version: String(version) }) });
const decoded = (row: StoredRow, version: number | null = row.version) =>
  makeRecordRef(MODEL, row.id, version === null ? undefined : BigInt(version));
async function finish(w: World, call: AdmittedCall, session: OwnerMutationSession): Promise<ExecutionEffects> {
  selectScenarioReceiptReturn(call, w.store, 'root-return'); return { ...await session.finalize(), result: null, outbox: [] };
}
async function callChild(w: World, call: AdmittedCall, mode: 'operation' | 'invocation', inputs: Record<string, unknown>) {
  return invokeScenarioReceiptCall(call, w.store, { site: mode,
    target: mode === 'operation' ? CHILD : makeInvocation(CHILD, inputs as never),
    inputs: mode === 'operation' ? inputs : {} });
}
async function snapshot(w: World) {
  return { revision: await w.store.readRevision(), rows: await Promise.all(w.rows.map(row => w.store.load(MODEL, row.id))),
    histories: await Promise.all(w.rows.map(row => w.store.historyFor(MODEL, row.id))), outbox: await w.store.outboxPending() };
}
async function assertRollback(w: World, before: Awaited<ReturnType<typeof snapshot>>) {
  // Invoke retains the terminal failure receipt; only that commit advances
  // the revision. The provisional owner writes/history/outbox remain absent.
  const after = await snapshot(w);
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual({ ...after, revision: before.revision }, before);
}

for (const mode of ['operation', 'invocation'] as const) {
  test(`${mode}: ordered repeated refs retain original versions and exact current staged rows`, async () => {
    const w = await world({ min: 3, max: 3, parent: true });
    let saved: AdmittedCall | undefined;
    bind(w, async frame => {
      saved = frame.call;
      assert.deepEqual(frame.call.recordRefs.map(ref => [ref.param, ref.id, ref.expectedVersion, ref.row.version]), [
        ['targets/0', w.rows[1].id, 1, 1], ['targets/1', w.rows[0].id, 2, 2], ['targets/2', w.rows[1].id, 1, 1],
      ]);
      assert.equal(frame.call.recordRefs[1]!.row.data['done'], true);
      assert.deepEqual(frame.call.inputs['targets'], [wire(w.rows[1]), wire(w.rows[0], 2), wire(w.rows[1])]);
      assert.ok(frame.call.checkpoint!.dependencies.some(dep => dep.kind === 'imported-parent' &&
        dep.model === 'Imported.Parent' && dep.id === w.rows[0].id));
      assert.ok(frame.call.checkpoint!.dependencies.some(dep => dep.kind === 'record' && dep.id === w.rows[0].id && dep.version === 2));
      await frame.session.stage({ op: 'update', model: MODEL, id: w.rows[1].id, data: { done: true } }, cause);
    });
    const args = mode === 'operation' ? [wire(w.rows[1]), wire(w.rows[0], 2), wire(w.rows[1])]
      : [decoded(w.rows[1]), decoded(w.rows[0], 2), decoded(w.rows[1])];
    assert.equal((await invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      await session.stage({ op: 'update', model: MODEL, id: w.rows[0].id, data: { done: true } }, cause);
      await callChild(w, call, mode, { targets: args }); return finish(w, call, session);
    } })).status, 'committed');
    assert.ok(saved); assert.equal(saved.recordRefs.length, 3);
    assert.equal((await w.store.load(MODEL, w.rows[0].id))!.version, 2);
    assert.equal((await w.store.load(MODEL, w.rows[1].id))!.data['done'], true);
    if (mode === 'invocation') assert.equal((args[1] as { version: bigint }).version, 2n);
  });

  for (const value of [null, []] as const) {
    test(`${mode}: ${value === null ? 'nullable' : 'empty'} ref array and nullable singular admit at owning bounds`, async () => {
      const w = await world({ nullable: true, max: 0 });
      bind(w, async frame => { assert.deepEqual(frame.call.inputs, { targets: value, one: null });
        assert.equal(frame.call.recordRefs.length, 0); });
      assert.equal((await invoke({ ...w, execute: async call => {
        const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
        await callChild(w, call, mode, { targets: value, one: null }); return finish(w, call, session);
      } })).status, 'committed');
    });
  }

  test(`${mode}: unversioned array and singular preserve null expected versions and current checkpoints`, async () => {
    const w = await world({ versioned: false });
    bind(w, async frame => {
      assert.deepEqual(frame.call.recordRefs.map(ref => [ref.param, ref.expectedVersion, ref.row.version]),
        [['targets/0', null, 2], ['one', null, 1]]);
      assert.equal(frame.call.recordRefs[0]!.row.data['done'], true);
      assert.ok(frame.call.checkpoint!.dependencies.some(dep => dep.kind === 'record' && dep.id === w.rows[0].id && dep.version === 2));
    });
    assert.equal((await invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      await session.stage({ op: 'update', model: MODEL, id: w.rows[0].id, data: { done: true } }, cause);
      await callChild(w, call, mode, { targets: [mode === 'operation' ? wire(w.rows[0], null) : decoded(w.rows[0], null)],
        one: mode === 'operation' ? wire(w.rows[1], null) : decoded(w.rows[1], null) });
      return finish(w, call, session);
    } })).status, 'committed');
  });

  for (const failure of ['missing-version', 'stale-version', 'missing-row', 'min', 'max', 'nonnull'] as const) {
    test(`${mode}: ${failure} refuses before child effects and rolls back staged owner writes`, async () => {
      const w = await world({ min: failure === 'min' ? 3 : 0, max: failure === 'max' ? 1 : 4 });
      const before = await snapshot(w), producer = bind(w, async () => { assert.fail('invalid refs must not execute child'); });
      let args: unknown = mode === 'operation' ? [wire(w.rows[1]), wire(w.rows[0], 2)] : [decoded(w.rows[1]), decoded(w.rows[0], 2)];
      if (failure === 'missing-version') (args as unknown[])[1] = mode === 'operation' ? wire(w.rows[0], null) : decoded(w.rows[0], null);
      if (failure === 'stale-version') (args as unknown[])[1] = mode === 'operation' ? wire(w.rows[0]) : decoded(w.rows[0]);
      if (failure === 'missing-row') (args as unknown[])[1] = mode === 'operation' ? { id: 'missing', version: '1' } : makeRecordRef(MODEL, 'missing', 1n);
      if (failure === 'nonnull') args = null;
      await assert.rejects(invoke({ ...w, execute: async call => {
        const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
        await session.stage({ op: 'update', model: MODEL, id: w.rows[0].id, data: { done: true } }, cause);
        await callChild(w, call, mode, { targets: args }); return finish(w, call, session);
      } }), error => {
        assert.ok(error instanceof StateError);
        if (failure === 'missing-version') assert.deepEqual(error.fields?.map(field => [field.path, field.code]), [['/targets/1', 'version_required']]);
        else if (failure === 'stale-version') { assert.equal(error.code, 'conflict'); assert.match(error.conflict!.message, /\/targets\/1/); }
        else if (failure === 'missing-row') assert.equal(error.code, 'not_found');
        else assert.equal(error.code, 'validation');
        return true;
      });
      assert.equal(producer.executions, 0); await assertRollback(w, before);
    });
  }
}

test('frozen invocation copies ordered array args and preserves versions against later caller edits', async () => {
  const w = await world(); const refs = [decoded(w.rows[1]), decoded(w.rows[0]), decoded(w.rows[1])];
  const target = makeInvocation(CHILD, { targets: refs }); refs.reverse(); refs.pop();
  assert.ok(Object.isFrozen(target.args['targets']));
  bind(w, async frame => { assert.deepEqual(frame.call.recordRefs.map(ref => ref.id), [w.rows[1].id, w.rows[0].id, w.rows[1].id]); });
  assert.equal((await invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await invokeScenarioReceiptCall(call, w.store, { site: 'invocation', target, inputs: {} }); return finish(w, call, session);
  } })).status, 'committed');
});

for (const [name, element] of [
  ['bare-id', 'task-a'], ['copied-wire', { id: 'task-a', version: 1n }],
  ['wrong-model', makeRecordRef('Other.Task', 'task-a', 1n)],
  ['unknown-shape', { kind: 'ref', model: MODEL, id: 'task-a', version: 1n, extra: true }],
  ['wrong-version-type', { kind: 'ref', model: MODEL, id: 'task-a', version: '1' }],
  ['zero-version', makeRecordRef(MODEL, 'task-a', 0n)],
  ['oversized-version', makeRecordRef(MODEL, 'task-a', 1000000000000000n)],
] as const) {
  test(`frozen invocation ${name} refuses nominal element before owning array bounds`, async () => {
    const w = await world({ max: 0 }), before = await snapshot(w);
    const producer = bind(w, async () => { assert.fail('malformed frozen refs must not execute'); });
    // A copied carrier is transport data, never evidence of ref provenance.
    const target = Object.freeze({ kind: 'invocation', target: CHILD,
      args: Object.freeze({ targets: Object.freeze([element]) }) }) as unknown as InvocationRef;
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      await session.stage({ op: 'update', model: MODEL, id: w.rows[0].id, data: { done: true } }, cause);
      await invokeScenarioReceiptCall(call, w.store, { site: 'invocation', target, inputs: {} }); return finish(w, call, session);
    } }), error => { assert.ok(error instanceof StateError); assert.equal(error.code, 'validation');
      assert.equal(error.fields, undefined); return true; });
    assert.equal(producer.executions, 0); await assertRollback(w, before);
  });
}

test('frozen invocation sparse arrays refuse before owner child admission', async () => {
  const w = await world(), before = await snapshot(w); bind(w, async () => { assert.fail('sparse refs must not execute'); });
  const refs = new Array(2); refs[1] = decoded(w.rows[0]);
  const target = { kind: 'invocation', target: CHILD, args: { targets: refs } } as unknown as InvocationRef;
  await assert.rejects(invoke({ ...w, execute: async call => {
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    await invokeScenarioReceiptCall(call, w.store, { site: 'invocation', target, inputs: {} }); return finish(w, call, session);
  } }), error => error instanceof StateError && /sparse/.test(error.message));
  await assertRollback(w, before);
});
