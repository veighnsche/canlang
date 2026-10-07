import { stateCatalog } from '../../src/catalog.js';
import { validateTransition, stageNextChunk, validateStaged } from '../../src/migration/index.js';
import { makeInstalled, makeTransition } from '../migration/fixtures.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactModel, FieldMachine, ModelName, RecordId } from '@canlang/contracts';
import { runMutationWrites, type MutationWrite } from '../../src/mutation/pipeline.js';
import { buildModelTable, buildModelTableFromCanonical } from '../../src/mutation/models.js';
import { createTestMemoryStorage } from '../../src/storage/memory.js';
import { loadArtifactDescriptors } from '../../src/invocation/registry.js';
import { validateMappedRow } from '../../src/migration/mapper.js';
import { invoke, type ExecuteHandler } from '../../src/invocation/invoke.js';
import type { InterimOperationDef } from '../../src/invocation/registry.js';
import { transition } from '../../src/effects/transition.js';
import { captureStateError, seedRow, asOperation, makeEnvelope, FIXED_NOW } from '../invocation/fixtures.js';
import { hook, modelDef, pipelineContext, setupMutation, crudCreate, crudUpdate, identityFor, freshOperationId, APP } from './fixtures.js';

const MODEL = 'Expense' as ModelName;
const ID = 'expense-1' as RecordId;
const OP = 'Expenses.review';
const machine: FieldMachine = {
  initial: 'draft', states: ['draft', 'submitted', 'approved'],
  transitions: [
    { from: 'draft', to: 'submitted', operation: OP },
    { from: 'submitted', to: 'approved', operation: OP },
  ],
};
const status = { required: false, serverOnly: false, default: 'draft', machine };
function table(hooks: ReturnType<typeof hook>[] = []) {
  return buildModelTable([modelDef(MODEL, { fields: { status, note: { required: false, serverOnly: false } }, hooks })]);
}
async function world(state = 'draft') {
  const { store } = createTestMemoryStorage();
  await seedRow(store, MODEL, { id: ID, data: { status: state } });
  return store;
}
const edge = (from: string, to: string): MutationWrite => ({
  op: 'update', model: MODEL, id: ID, transition: { field: 'status', from, to },
});
async function rejected(writes: MutationWrite[], code: string, state = 'draft', operation = OP) {
  const store = await world(state);
  const before = await store.load(MODEL, ID);
  const error = await captureStateError(runMutationWrites({ table: table(), writes, context: pipelineContext({ operation }), store }));
  assert.equal(error.code, code);
  assert.deepEqual(await store.load(MODEL, ID), before);
}

describe('flat field machines', () => {
  it('evaluates sequential edges against provisional states and preserves history', async () => {
    const store = await world();
    const result = await runMutationWrites({ table: table(), writes: [edge('draft', 'submitted'), edge('submitted', 'approved')], context: pipelineContext({ operation: OP }), store });
    const final = result.writes.at(-1);
    assert.ok(final?.kind === 'update');
    assert.equal(final.row.data['status'], 'approved');
    assert.equal(final.row.version, 3);
    assert.equal(result.history.length, 2);
    assert.equal((await store.load(MODEL, ID))?.data['status'], 'draft');
  });
  it('rejects source mismatch without committing preceding successful effects', async () => {
    await rejected([edge('draft', 'submitted'), edge('draft', 'submitted')], 'rule_failed');
  });
  it('checks edge operation identity separately from endpoints', async () => {
    await rejected([edge('draft', 'submitted')], 'validation', 'draft', 'Expenses.other');
    await rejected([edge('draft', 'approved')], 'validation');
  });
  it('rejects plain set and CRUD-shaped patches, including same-value writes', async () => {
    for (const value of ['draft', 'approved']) {
      await rejected([{ op: 'update', model: MODEL, id: ID, data: { status: value } }], 'validation');
    }
    await rejected([{ ...edge('draft', 'submitted'), data: { status: 'approved' } }], 'validation');
    await rejected([{ ...edge('draft', 'submitted'), data: { status: undefined } }], 'validation');
  });
  it('production create owns initial default and rejects supplied snapshots', async () => {
    const { store } = createTestMemoryStorage();
    const result = await runMutationWrites({ table: table(), writes: [{ op: 'create', model: MODEL, id: ID }], context: pipelineContext({ operation: OP }), store });
    const first = result.writes[0];
    assert.ok(first?.kind === 'insert');
    assert.equal(first.row.data['status'], 'draft');
    const error = await captureStateError(runMutationWrites({ table: table(), writes: [{ op: 'create', model: MODEL, id: ID, data: { status: 'approved' } }], context: pipelineContext({ operation: OP }), store }));
    assert.equal(error.code, 'validation');
  });
  it('rejects transitions on create, remove, unknown fields and malformed metadata', async () => {
    await rejected([{ ...edge('draft', 'submitted'), op: 'create' }], 'validation');
    await rejected([{ ...edge('draft', 'submitted'), op: 'remove' }], 'validation');
    await rejected([{ ...edge('draft', 'submitted'), transition: { field: 'note', from: 'draft', to: 'submitted' } }], 'validation');
    await rejected([{ ...edge('draft', 'submitted'), transition: null as unknown as MutationWrite['transition'] } as MutationWrite], 'validation');
  });
  it('rejects each hook rewrite before a later hook can restore it', async () => {
    let secondRan = false;
    const hooks = [hook('rewrite', ['update'], async (candidate) => ({ ...candidate, status: 'approved' })), hook('restore', ['update'], async (candidate) => { secondRan = true; return { ...candidate, status: 'draft' }; })];
    const error = await captureStateError(runMutationWrites({ table: table(hooks), writes: [{ op: 'update', model: MODEL, id: ID, data: { note: 'changed' } }], context: pipelineContext({ operation: OP }), store: await world() }));
    assert.equal(error.code, 'validation');
    assert.equal(secondRan, false);
  });
  it('rejects creation hooks and archive hooks changing the protected field', async () => {
    const hooks = [hook('rewrite', ['create', 'remove'], async (candidate) => ({ ...candidate, status: 'approved' }))];
    for (const op of ['create', 'remove'] as const) {
      const store = op === 'create' ? createTestMemoryStorage().store : await world();
      const error = await captureStateError(runMutationWrites({ table: table(hooks), writes: [{ op, model: MODEL, id: ID }], context: pipelineContext({ operation: OP }), store }));
      assert.equal(error.code, 'validation');
    }
  });
  it('hook-staged secondary patches and forged transitions cannot bypass machines', async () => {
    const driver = 'Driver' as ModelName;
    for (const staged of [
      { op: 'update' as const, model: MODEL, id: ID, data: { status: 'approved' } },
      { op: 'update' as const, model: MODEL, id: ID, transition: { field: 'status', from: 'draft', to: 'submitted' } },
    ]) {
      const driverHook = hook('stage', ['create'], async (candidate, ctx) => { ctx.stage(staged); return candidate; });
      const models = buildModelTable([
        modelDef(MODEL, { fields: { status } }),
        modelDef(driver, { fields: {}, hooks: [driverHook] }),
      ]);
      const error = await captureStateError(runMutationWrites({ table: models, writes: [{ op: 'create', model: driver, id: 'driver-1' as RecordId }], context: pipelineContext({ operation: OP }), store: await world() }));
      assert.equal(error.code, 'validation');
    }
  });
  it('rejects incompatible stored snapshots instead of resetting them', async () => {
    await rejected([{ op: 'update', model: MODEL, id: ID, data: { note: 'changed' } }], 'validation', 'unknown');
  });
  it('migration accepts valid snapshots but rejects unknown, null or missing state', () => {
    const def = table().get(MODEL)!;
    validateMappedRow({ status: 'approved', note: null }, def);
    for (const value of ['unknown', null, undefined]) {
      assert.throws(() => validateMappedRow({ status: value, note: null }, def), /declared state|uninitialized/);
    }
  });
  it('migration validation rejects incompatible retained rows before activation', async () => {
    for (const state of ['approved', 'unknown']) {
      const store = await world(state);
      const oldModels = buildModelTable([modelDef(MODEL, { fields: { status: { required: false, serverOnly: false }, note: { required: false, serverOnly: false } } })]);
      const desiredModels = table();
      const plan = validateTransition(makeInstalled(), makeTransition(), oldModels, desiredModels);
      await stageNextChunk({ store, plan, mappers: new Map(), oldModels, desiredModels, chunkSize: 10 });
      const check = () => validateStaged({ store, plan, desiredModels, oldModels, oldLocks: new Map() });
      if (state === 'approved') {
        assert.equal((await check()).phase, 'staged');
      } else {
        const error = await captureStateError(check);
        assert.equal(error.code, 'validation');
        assert.match(error.message, /retained machine field/);
        assert.equal((await store.readMigrationProgress(plan.migrationId))?.phase, 'staging');
      }
      assert.equal((await store.load(MODEL, ID))?.data['status'], state);
    }
  });
  it('advertises the independently gated machine capability', () => {
    assert.equal(stateCatalog().capabilities['state.machines'], 1);
  });
  it('validates machine metadata on model construction', () => {
    assert.throws(() => buildModelTable([modelDef(MODEL, { fields: { status: { ...status, default: 'approved' } } })]), /initial default/);
    assert.throws(() => buildModelTable([modelDef(MODEL, { fields: { status: { ...status, machine: { ...machine, states: ['draft', 'draft'] } } } })]), /distinct/);
  });
  it('keeps metadata through artifact intake and rejects nonenum/default drift', () => {
    const model: ArtifactModel = { name: MODEL, fields: [{ name: 'status', field: { kind: 'enum', values: [...machine.states] }, required: false, serverOnly: false, default: { kind: 'literal', value: 'draft' }, machine }], deleteMode: 'archive' };
    const artifact = { artifact_version: 1 as const, operations: [], models: [model] };
    const loaded = loadArtifactDescriptors(artifact, { by: { role: 'members' } });
    const built = buildModelTableFromCanonical(loaded.models);
    assert.deepEqual(built.get(MODEL)?.fields['status']?.machine, machine);
    const field = model.fields[0]!;
    assert.throws(() => loadArtifactDescriptors({ ...artifact, models: [{ ...model, fields: [{ ...field, nullable: true }] }] }, { by: { role: 'members' } }), /nonnullable enum/);
    assert.throws(() => loadArtifactDescriptors({ ...artifact, models: [{ ...model, fields: [{ ...field, field: { kind: 'string' } }] }] }, { by: { role: 'members' } }), /nonnullable enum/);
  });
  it('actual CRUD initialization is default-owned and update bypass rejects', async () => {
    const setup = await setupMutation([modelDef(MODEL, { fields: { status } })]);
    await crudCreate(setup, MODEL, { id: ID });
    assert.equal((await setup.store.load(MODEL, ID))?.data['status'], 'draft');
    const error = await captureStateError(crudUpdate(setup, MODEL, ID, { version: 1, patch: { status: 'approved' } }));
    assert.equal(error.code, 'validation');
    assert.equal((await setup.store.load(MODEL, ID))?.data['status'], 'draft');
  });
  it('canonical invocation commits once and replay skips transition execution', async () => {
    const setup = await setupMutation([modelDef(MODEL, { fields: { status } })]);
    await crudCreate(setup, MODEL, { id: ID });
    const def: InterimOperationDef = { name: asOperation(OP), kind: 'scenario', by: 'members', inputs: {} };
    const registry = new Map(setup.registry);
    registry.set(OP, def);
    let executions = 0;
    const execute: ExecuteHandler = async (call) => {
      executions += 1;
      const result = await runMutationWrites({ table: setup.table, writes: [edge('draft', 'submitted')], context: call.context, store: setup.store });
      return { writes: [...result.writes], history: [...result.history], uniqueClaims: [...result.uniqueClaims], uniqueReleases: [...result.uniqueReleases], resolvedDefaults: { ...result.resolvedDefaults }, outbox: [], schedules: [], result: 'submitted' };
    };
    const args = {
      registry, envelope: makeEnvelope(OP, freshOperationId(), {}),
      identity: identityFor(setup.alice), app: APP, source: 'test', store: setup.store,
      memberships: setup.memberships, clock: { nowMs: () => FIXED_NOW }, execute,
    };
    const first = await invoke(args);
    const replay = await invoke(args);
    assert.equal(first.status, 'committed');
    assert.equal(replay.status, 'replayed');
    assert.equal(executions, 1);
    assert.equal((await setup.store.load(MODEL, ID))?.data['status'], 'submitted');
    assert.equal((await setup.store.load(MODEL, ID))?.version, 2);
  });
  it('producer requires canonical staging and carries explicit transition metadata', async () => {
    await assert.rejects(transition({}, MODEL, ID, 'status', 'draft', 'submitted'), /canonical/);
    const store = await world();
    const row = await transition({ canonical: { stageWrite: async (write) => {
      assert.deepEqual(write.transition, { field: 'status', from: 'draft', to: 'submitted' });
      const result = await runMutationWrites({ table: table(), writes: [{ ...write, model: MODEL, id: ID }], context: pipelineContext({ operation: OP }), store });
      const last = result.writes.at(-1);
      return last?.kind === 'update' ? last.row : null;
    } } }, MODEL, ID, 'status', 'draft', 'submitted');
    assert.equal(row.data['status'], 'submitted');
  });
});
