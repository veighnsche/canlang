/** Genuine shared history production; no manually attested history snapshots. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtifactModel, ArtifactOperation, CanTypeId, ModelName, StoredRow } from '@canlang/contracts';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { invoke } from '../../src/invocation/invoke.js';
import { beginScenarioReceiptMutation, selectScenarioReceiptReturn } from '../../src/invocation/scenario-receipt.js';
import { generatedCrudExecute } from '../../src/mutation/crud.js';
import { buildModelTableFromCanonical } from '../../src/mutation/models.js';
import { beginOwnerMutation, runMutationWrites } from '../../src/mutation/pipeline.js';
import { FIXED_NOW, asId, asModel, createMemoryIdentityStore, makeEnvelope, makeIdentity,
  seedMember, uuidv7 } from '../invocation/fixtures.js';
import { pipelineContext } from './fixtures.js';

const NOTE = asModel('Audit.Note'), REMOVED = asModel('Audit.Removed'), SCENARIO = 'Audit.edit';
const source = { path: 'audit.can', sha256: 'b'.repeat(64), module: 'audit.mjs' };
let sequence = 83_000;
function artifact(): ArtifactDescriptorSlice {
  const operations: ArtifactOperation[] = [];
  for (const model of [NOTE, REMOVED]) {
    const record = { name: 'record', field: { kind: 'ref' as const, model, requireVersion: true }, required: true };
    operations.push(
      { name: `${model}.create`, kind: 'create', description: '', inputs: { fields: [
        { name: 'title', field: { kind: 'string' }, required: true },
      ] } },
      { name: `${model}.update`, kind: 'update', description: '', inputs: { fields: [record,
        { name: 'title', field: { kind: 'string' }, required: false },
      ] } },
      { name: `${model}.delete`, kind: 'delete', description: '', inputs: { fields: [record] } },
    );
  }
  operations.push({ name: SCENARIO, kind: 'scenario', description: '', inputs: { fields: [] },
    result: { type: 'void' as CanTypeId, disclosure: { version: 1, source, returns: [
      { id: 'finished', source, influences: [], dependencies: [] },
    ] } } });
  return { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: 'export const edit="Audit.edit";', map: {
      version: 3, file: source.module, sources: [source.path], sourcesContent: [null], names: [], mappings: '',
    } }], callables: [{ id: SCENARIO, kind: 'operation', module: source.module, export: 'edit', member: ['edit'] }],
    models: [NOTE, REMOVED].map((name): ArtifactModel => ({ name, deleteMode: name === NOTE ? 'archive' : 'remove', fields: [
      { name: 'title', field: { kind: 'string' }, required: true, serverOnly: false },
      { name: 'token', field: { kind: 'secret' }, required: false, serverOnly: true },
    ] })), operations };
}
async function world() {
  const original = artifact(), loaded = loadArtifactDescriptors(original, { by: 'members' });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ membership: member.membership, email: member.user.email });
  const secretFields = new Map(original.models!.map(model => [asModel(model.name),
    model.fields.filter(field => field.field.kind === 'secret').map(field => field.name)]));
  const execute = generatedCrudExecute({ table, store, secretFields });
  const common = { store, memberships, identity, app: 'audit-app', source: 'test',
    registry: loaded.registry, clock: { nowMs: () => FIXED_NOW } };
  async function crud(operation: string, inputs: Record<string, unknown>) {
    const result = await invoke({ ...common, execute,
      envelope: makeEnvelope(operation, uuidv7(FIXED_NOW, ++sequence), inputs) });
    assert.equal(result.status, 'committed');
    return result.result as StoredRow | null;
  }
  return { ...common, table, secretFields, member, crud };
}
const reference = (row: StoredRow) => ({ record: { id: row.id, version: String(row.version) } });
const projection = (row: StoredRow) => ({ created: row.created, createdBy: row.createdBy, secretFields: ['token'] });

test('canonical generated CRUD atomically captures original lifetime and secrets for create/update/archive/remove', async () => {
  const w = await world();
  for (const model of [NOTE, REMOVED]) {
    const created = await w.crud(`${model}.create`, { title: 'first' }); assert.ok(created);
    const updated = await w.crud(`${model}.update`, { ...reference(created), title: 'second' }); assert.ok(updated);
    await w.crud(`${model}.delete`, reference(updated));
    const entries = await w.store.historyFor(model, created.id);
    assert.deepEqual(entries.map(entry => entry.change), ['create', 'update', model === NOTE ? 'archive' : 'remove']);
    assert.deepEqual(entries.map(entry => entry.auditProjection), Array.from({ length: 3 }, () => projection(created)));
    assert.equal(created.createdBy, w.member.user.user_id);
    assert.equal(created.created, FIXED_NOW);
    assert.deepEqual(entries[1]!.before, { title: 'first' });
    assert.deepEqual(entries[1]!.after, { title: 'second' });
  }
});

test('source-bound scenario overrides caller inventory and preserves stage order and net creation capture', async () => {
  const w = await world(), existing = await w.crud(`${NOTE}.create`, { title: 'original' }); assert.ok(existing);
  const result = await invoke({ ...w, envelope: makeEnvelope(SCENARIO, uuidv7(FIXED_NOW, ++sequence), {}),
    execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table,
        bounds: { maxRows: 10, maxWork: 1000 }, secretFields: new Map<ModelName, readonly string[]>([[NOTE, []]]) });
      const stage = { cause: 'scenario' } as const;
      await session.stage({ op: 'update', model: NOTE, id: existing.id, data: { title: 'middle' } }, stage);
      await session.stage({ op: 'create', model: REMOVED, id: asId('scenario-created'), data: { title: 'new' } }, stage);
      await session.stage({ op: 'update', model: NOTE, id: existing.id, data: { title: 'final' } }, stage);
      await session.stage({ op: 'update', model: REMOVED, id: asId('scenario-created'), data: { title: 'net' } }, stage);
      selectScenarioReceiptReturn(call, w.store, 'finished');
      const effects = await session.finalize();
      assert.deepEqual(effects.history.map(entry => [entry.recordId, entry.change, entry.after]), [
        [existing.id, 'update', { title: 'middle' }], [existing.id, 'update', { title: 'final' }],
        ['scenario-created', 'create', { title: 'net' }],
      ]);
      assert.deepEqual(effects.history.slice(0, 2).map(entry => entry.auditProjection), [projection(existing), projection(existing)]);
      return { ...effects, result: null, outbox: [] };
    } });
  assert.equal(result.status, 'committed');
  const created = await w.store.load(REMOVED, asId('scenario-created')); assert.ok(created);
  assert.deepEqual((await w.store.historyFor(REMOVED, created.id))[0]!.auditProjection, projection(created));
  assert.deepEqual((await w.store.historyFor(NOTE, existing.id)).slice(1).map(entry => entry.operation), [SCENARIO, SCENARIO]);
});

test('complete inventory is validated and detached before owner revision read, with honest absent/model-missing capture', async () => {
  const w = await world(), paths = ['token'], map = new Map([[NOTE, paths]]);
  const readRevision = w.store.readRevision.bind(w.store);
  let reads = 0;
  w.store.readRevision = async () => { reads++; paths[0] = 'title'; map.clear(); return readRevision(); };
  const session = await beginOwnerMutation({ table: w.table, store: w.store, secretFields: map,
    context: pipelineContext({ operation: SCENARIO }), bounds: { maxRows: 10, maxWork: 1000 } });
  await session.stage({ op: 'create', model: NOTE, id: asId('detached'), data: { title: 'value' } }, { cause: 'scenario' });
  const effects = await session.finalize();
  assert.deepEqual(effects.history[0]!.auditProjection?.secretFields, ['token']);
  assert.ok(Object.isFrozen(effects.history[0]!.auditProjection?.secretFields));
  const prior = reads;
  await assert.rejects(beginOwnerMutation({ table: w.table, store: w.store,
    secretFields: new Map([[NOTE, ['token']], [REMOVED, ['bad..path']]]),
    context: pipelineContext({ operation: SCENARIO }), bounds: { maxRows: 10, maxWork: 1000 } }),
  error => error instanceof StateError && error.code === 'validation');
  assert.equal(reads, prior);
  for (const secretFields of [undefined, new Map([[REMOVED, ['token']]])]) {
    const result = await runMutationWrites({ table: w.table, store: w.store,
      context: pipelineContext({ operation: `${NOTE}.create` }),
      ...(secretFields === undefined ? {} : { secretFields }),
      writes: [{ op: 'create', model: NOTE, id: asId('unsupported'), data: { title: 'value' } }] });
    assert.equal(Object.hasOwn(result.history[0]!, 'auditProjection'), false);
  }
});
