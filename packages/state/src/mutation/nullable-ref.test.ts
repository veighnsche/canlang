/** Narrow checked singular-ref null controls; hand-built pipeline cases are labeled. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredRow } from '@canlang/contracts';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from '../invocation/registry.js';
import { buildModelTable, buildModelTableFromCanonical, type InterimFieldDef } from './models.js';
import { crudExecute, generatedCrudExecute } from './crud.js';
import { runMutationWrites } from './pipeline.js';
import { invoke } from '../invocation/invoke.js';
import { buildContext } from '../invocation/context.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import { FIXED_NOW, asId, asModel, asOperation, captureStateError, createMemoryIdentityStore,
  makeEnvelope, makeIdentity, seedMember, uuidv7 } from '../../test/invocation/fixtures.js';
import { crudCreate, modelDef, readCrudReceipt, seedStoredRow, setupMutation } from '../../test/mutation/fixtures.js';
import { encodeValue, normalizeSchema, validateValue } from '@canlang/values';
import type { CanValue } from '@canlang/contracts/values';

const ACCOUNT = 'Null.Account', JOB = 'Null.Job';
let sequence = 9000;
const nextId = () => uuidv7(FIXED_NOW, ++sequence);
function slice(): ArtifactDescriptorSlice {
  const account = { name: 'account', field: { kind: 'ref' as const, model: ACCOUNT, requireVersion: true }, required: false, nullable: true };
  return { artifact_version: 1, models: [
    { name: ACCOUNT, fields: [], deleteMode: 'archive' },
    { name: JOB, fields: [{ name: 'account', field: { kind: 'ref', model: ACCOUNT }, required: false, serverOnly: false, nullable: true }], deleteMode: 'archive' },
  ], operations: [
    { name: `${ACCOUNT}.create`, kind: 'create', description: '', inputs: { fields: [] } },
    { name: `${JOB}.create`, kind: 'create', description: '', inputs: { fields: [account] } },
    { name: `${JOB}.update`, kind: 'update', description: '', inputs: { fields: [
      { name: 'record', field: { kind: 'ref', model: JOB, requireVersion: true }, required: true }, account,
    ] } },
  ] };
}
async function setup() {
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ membership: member.membership });
  const loaded = loadArtifactDescriptors(slice(), { by: 'members' });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, nullableFields: loaded.nullableFields });
  const args = { app: 'nullable-test', source: 'test', store, memberships, identity,
    clock: { nowMs: () => FIXED_NOW }, registry: loaded.registry, execute: generatedCrudExecute({ table, store }) };
  const call = (operation: string, inputs: Record<string, unknown>, id = nextId()) =>
    invoke({ ...args, envelope: makeEnvelope(operation, id, inputs) });
  return { store, identity, call };
}
const ref = (row: StoredRow) => ({ id: row.id, version: String(row.version) });

describe('nullable singular refs through loaded generated CRUD', () => {
  it('fills omitted null, accepts explicit null and replays creation without another commit', async () => {
    const world = await setup();
    for (const inputs of [{}, { account: null }]) {
      const id = nextId();
      const result = await world.call(`${JOB}.create`, inputs, id);
      assert.equal(result.status, 'committed');
      const row = result.result as StoredRow;
      assert.deepEqual(row.data, { account: null });
      assert.equal(row.version, 1);
      assert.deepEqual((await world.store.load(asModel(JOB), row.id))?.data, { account: null });
      const revision = await world.store.readRevision();
      const replay = await world.call(`${JOB}.create`, inputs, id);
      assert.equal(replay.status, 'replayed');
      assert.deepEqual(replay.result, result.result);
      assert.equal(await world.store.readRevision(), revision);
    }
  });
  it('clears a current ref with one version bump; preserves update omission and stale refusal', async () => {
    const world = await setup();
    const account = (await world.call(`${ACCOUNT}.create`, {})).result as StoredRow;
    const job = (await world.call(`${JOB}.create`, { account: ref(account) })).result as StoredRow;
    const omitted = (await world.call(`${JOB}.update`, { record: ref(job) })).result as StoredRow;
    assert.deepEqual(omitted.data.account, ref(account));
    const cleared = (await world.call(`${JOB}.update`, { record: ref(omitted), account: null })).result as StoredRow;
    assert.equal(cleared.data.account, null);
    assert.equal(cleared.version, omitted.version + 1);
    const stale = await captureStateError(world.call(`${JOB}.update`, { record: ref(omitted), account: null }));
    assert.equal(stale.code, 'conflict');
    assert.deepEqual(await world.store.load(asModel(JOB), job.id), cleared);
    const restored = (await world.call(`${JOB}.update`, { record: ref(cleared), account: ref(account) })).result as StoredRow;
    assert.deepEqual(restored.data.account, ref(account));
    assert.equal(restored.version, cleared.version + 1);
    const missing = await captureStateError(world.call(`${JOB}.create`, { account: { id: 'absent', version: '1' } }));
    assert.equal(missing.code, 'not_found');
  });
});

describe('direct pipeline null boundaries (hand-built controls)', () => {
  it('requires an own top-level nullable singular field; leaves other refusals unchanged', async () => {
    const { store } = createTestMemoryStorage();
    const context = buildContext({ identity: makeIdentity(), operation: asOperation(`${JOB}.create`),
      operationId: nextId(), app: 'nullable-test', source: 'test', now: FIXED_NOW });
    const run = (field: InterimFieldDef | undefined, path = 'account', fields?: Record<string, InterimFieldDef>) => {
      const table = buildModelTable([
        modelDef(ACCOUNT),
        modelDef(JOB, { fields: fields ?? (field === undefined ? {} : { account: field }), refs: [{ field: path, model: asModel(ACCOUNT) }] }),
      ]);
      const data = path.includes('.') ? { account: { nested: null } } : { account: null };
      return runMutationWrites({ table, store, context, writes: [{ op: 'create', model: asModel(JOB), id: asId(nextId()), data }] });
    };
    const optional = { required: false, serverOnly: false };
    const accepted = await run({ ...optional, nullable: true });
    assert.equal(accepted.writes.length, 1);
    for (const field of [optional, Object.assign(Object.create({ nullable: true }) as InterimFieldDef, optional), { ...optional, nullable: false }, { ...optional, nullable: true, array: { required: false } }]) {
      const error = await captureStateError(run(field));
      assert.equal(error.code, 'validation');
      assert.match(error.message, /Invalid reference/);
    }
    const unknown = await captureStateError(run(undefined));
    assert.match(unknown.message, /Unknown field/);
    const nested = await captureStateError(run({ ...optional, nullable: true }, 'account.nested'));
    assert.match(nested.message, /Invalid reference/);
    const required = await captureStateError(run({ ...optional, nullable: true, required: true }));
    assert.equal(required.code, 'validation');
    assert.doesNotMatch(required.message, /Invalid reference/);
    const protectedField = await captureStateError(run({ ...optional, nullable: true, serverOnly: true }));
    assert.match(protectedField.message, /server-only/);
    assert.equal(await store.readRevision(), 0);
  });
});

describe('checked stored-field modifiers', () => {
  it('rejects malformed artifact bounds at descriptor load', () => {
    const artifact = slice();
    const validModels = artifact.models!.map(model => model.name === JOB ? {
      ...model, fields: [{ name: 'title', field: { kind: 'string' as const },
        required: true, serverOnly: false, valueType: 'text', trim: true, min: 1, max: 3 }],
    } : model);
    const loaded = loadArtifactDescriptors({ ...artifact, models: validModels }, { by: 'members' });
    const title = loaded.models.find(model => model.name === JOB)?.fields['title'];
    assert.equal(title?.trim, true);
    assert.equal(buildModelTableFromCanonical(loaded.models).get(asModel(JOB))?.fields['title']?.max, 3);
    for (const change of [
      { trim: 'yes' }, { min: -1 }, { min: 3, max: 2 }, { min: '1' },
    ]) {
      const models = artifact.models!.map(model => model.name === JOB ? {
        ...model, fields: [{ name: 'title', field: { kind: 'string' as const },
          required: true, serverOnly: false, valueType: 'text', ...change }],
      } : model);
      assert.throws(() => loadArtifactDescriptors({ ...artifact, models } as ArtifactDescriptorSlice,
        { by: 'members' }), /Invalid field "title"/);
    }
  });

  it('normalizes before hooks and bounds, then validates hook changes and update patches', async () => {
    const { store } = createTestMemoryStorage();
    const seen: string[] = [];
    const table = buildModelTable([modelDef(JOB, { fields: {
      title: { required: true, serverOnly: false, valueType: 'text', trim: true, min: 1, max: 3 },
    }, hooks: [{ name: 'observe', ops: ['create', 'update'], run: (candidate) => {
      seen.push(candidate.title as string);
      return candidate;
    } }] })]);
    const context = buildContext({ identity: makeIdentity(), operation: asOperation(`${JOB}.create`),
      operationId: nextId(), app: 'modifier-test', source: 'test', now: FIXED_NOW });
    const create = (title: string) => runMutationWrites({ table, store, context,
      writes: [{ op: 'create', model: asModel(JOB), id: asId(nextId()), data: { title } }] });
    const rejected = await captureStateError(create('   '));
    assert.equal(rejected.code, 'validation');
    assert.equal((await store.query({ model: asModel(JOB), authority: 'owner' })).length, 0);
    const effects = await create('  🧰  ');
    assert.deepEqual(seen, ['🧰']);
    assert.equal(effects.writes[0]?.kind, 'insert');
    if (effects.writes[0]?.kind !== 'insert') throw new Error('expected insert');
    assert.equal(effects.writes[0].row.data.title, '🧰');
    const chainedId = asId(nextId());
    const unchanged = await runMutationWrites({ table, store, context,
      writes: [
        { op: 'create', model: asModel(JOB), id: chainedId, data: { title: '  a  ' } },
        { op: 'update', model: asModel(JOB), id: chainedId, data: {} },
      ] });
    const last = unchanged.writes.at(-1);
    assert.equal(last?.kind, 'update');
    if (last?.kind !== 'update') throw new Error('expected update');
    assert.equal(last.row.data.title, 'a');
    const invalidId = asId(nextId());
    const invalidPatch = await captureStateError(runMutationWrites({ table, store, context,
      writes: [
        { op: 'create', model: asModel(JOB), id: invalidId, data: { title: 'ok' } },
        { op: 'update', model: asModel(JOB), id: invalidId, data: { title: '   ' } },
      ] }));
    assert.equal(invalidPatch.code, 'validation');
  });

  it('trims before the receiving alias codec while preserving alias and receiving bounds', async () => {
    const valueSchema = normalizeSchema({ aliases: {
      'Test.AliceName': { type: 'text', min: 1, max: 20, format: 'name' },
    } });
    const encodeField = (type: string, value: unknown) =>
      encodeValue(type, validateValue(valueSchema, type, value, 'create') as CanValue);
    assert.throws(() => encodeField('Test.AliceName', '  Alice  '),
      'direct alias validation keeps rejecting untrimmed text');

    const { store } = createTestMemoryStorage();
    const context = buildContext({ identity: makeIdentity(), operation: asOperation(`${JOB}.create`),
      operationId: nextId(), app: 'modifier-test', source: 'test', now: FIXED_NOW });
    const table = buildModelTable([modelDef(JOB, { fields: {
      title: { required: true, serverOnly: false, valueType: 'Test.AliceName', trim: true, min: 3, max: 8 },
    } })], { valueSchema });
    const create = (title: string) => runMutationWrites({ table, store, context, encodeField,
      writes: [{ op: 'create', model: asModel(JOB), id: asId(nextId()), data: { title } }] });
    const accepted = await create(' \tAlice\u2003');
    assert.equal(accepted.writes[0]?.kind, 'insert');
    if (accepted.writes[0]?.kind !== 'insert') throw new Error('expected insert');
    assert.equal(accepted.writes[0].row.data.title, 'Alice');

    const rows = await store.query({ model: asModel(JOB), authority: 'owner' });
    const revision = await store.readRevision();
    for (const title of ['  A  ', ' Alice Smith ', ' ThisNameIsTooLong ']) {
      const error = await captureStateError(create(title));
      assert.equal(error.code, 'validation');
      assert.deepEqual(await store.query({ model: asModel(JOB), authority: 'owner' }), rows);
      assert.equal(await store.readRevision(), revision);
    }
  });

  it('records normalized defaults and refuses hook-produced invalid values', async () => {
    const { store } = createTestMemoryStorage();
    const context = buildContext({ identity: makeIdentity(), operation: asOperation(`${JOB}.create`),
      operationId: nextId(), app: 'modifier-test', source: 'test', now: FIXED_NOW });
    const field = { required: false, serverOnly: false, valueType: 'text', trim: true, min: 1, max: 3 } as const;
    const accepted = buildModelTable([modelDef(JOB, { fields: { title: { ...field, default: '  ok  ' } } })]);
    const run = (table: ReturnType<typeof buildModelTable>) => runMutationWrites({ table, store, context,
      writes: [{ op: 'create', model: asModel(JOB), id: asId(nextId()), data: {} }] });
    const effects = await run(accepted);
    assert.equal(effects.writes[0]?.kind, 'insert');
    if (effects.writes[0]?.kind !== 'insert') throw new Error('expected insert');
    assert.equal(effects.writes[0].row.data.title, 'ok');
    assert.equal(effects.resolvedDefaults.title, 'ok');
    const invalid = buildModelTable([modelDef(JOB, { fields: { title: { ...field, default: 'ok' } },
      hooks: [{ name: 'invalidate', ops: ['create'], run: candidate => ({ ...candidate, title: '   ' }) }] })]);
    const rejection = await captureStateError(run(invalid));
    assert.equal(rejection.code, 'validation');
  });

  it('retains the pre-hook normalized default in committed receipts and replay', async () => {
    for (const withEncoder of [false, true]) {
      const seen: unknown[] = [];
      const world = await setupMutation([modelDef(JOB, { fields: {
        title: { required: true, serverOnly: false, valueType: 'text', trim: true, min: 1, max: 3, default: '  ok  ' },
      }, hooks: [{ name: 'adjust', ops: ['create'], run: candidate => {
        seen.push(candidate.title);
        return { ...candidate, title: '  new  ' };
      } }] })]);
      const active = { ...world, execute: crudExecute({ table: world.table, store: world.store, model: asModel(JOB),
        ...(withEncoder ? { encodeField: (_type: string, value: unknown) => value } : {}),
      }) };
      const created = await crudCreate(active, JOB, { id: 'defaulted' });
      assert.equal(created.out.status, 'committed');
      assert.equal((created.out.result as StoredRow).data.title, 'new');
      const saved = await readCrudReceipt(active, { operation: `${JOB}.create`, operationId: created.operationId });
      assert.ok(saved);
      assert.deepEqual(saved.resolvedDefaults, { title: 'ok' });
      const revision = await world.store.readRevision();
      const history = await world.store.historyFor(asModel(JOB), asId('defaulted'));
      const replay = await crudCreate(active, JOB, { id: 'defaulted', operationId: created.operationId });
      assert.equal(replay.out.status, 'replayed');
      assert.deepEqual(replay.out.result, created.out.result);
      assert.deepEqual(seen, ['ok']);
      assert.equal(await world.store.readRevision(), revision);
      assert.deepEqual(await world.store.historyFor(asModel(JOB), asId('defaulted')), history);
      assert.deepEqual(await readCrudReceipt(active, { operation: `${JOB}.create`, operationId: created.operationId }), saved);
    }
  });

  it('keeps ignored legacy fields unchanged but validates real patches and hook changes', async () => {
    for (const title of ['  ok  ', '   ']) {
      const { store } = createTestMemoryStorage();
      const fields = {
        title: { required: true, serverOnly: false, valueType: 'text', trim: true, min: 1, max: 3 },
        tags: { required: false, serverOnly: false, valueType: 'text[]', array: { required: false }, max: 1 },
        note: { required: false, serverOnly: false },
      } as const;
      const observed: unknown[] = [];
      const table = buildModelTable([modelDef(JOB, { fields,
        hooks: [{ name: 'unchanged', ops: ['update'], run: candidate => { observed.push(candidate.title); return candidate; } }],
      })]);
      await seedStoredRow(store, asModel(JOB), { id: 'legacy', data: { title, tags: ['old', 'legacy'], note: 'before' } });
      const context = buildContext({ identity: makeIdentity(), operation: asOperation(`${JOB}.update`),
        operationId: nextId(), app: 'modifier-test', source: 'test', now: FIXED_NOW });
      let reads = 0;
      const patch = { tags: undefined, note: 'after', get title() { reads += 1; return undefined; } };
      const writes = [{ op: 'update' as const, model: asModel(JOB), id: asId('legacy'), data: patch }];
      const effects = await runMutationWrites({ table, store, context, writes });
      const write = effects.writes[0];
      assert.ok(write?.kind === 'update');
      assert.deepEqual(write.row.data, { title, tags: ['old', 'legacy'], note: 'after' });
      assert.deepEqual(effects.history[0]?.after, write.row.data);
      assert.deepEqual(effects.resolvedDefaults, {});
      assert.equal(reads, 1);
      assert.deepEqual(observed, [title]);
      const invalidPatch = await captureStateError(runMutationWrites({ table, store, context,
        writes: [{ ...writes[0]!, data: { title: '   ' } }] }));
      assert.equal(invalidPatch.code, 'validation');
      const changedByHook = buildModelTable([modelDef(JOB, { fields,
        hooks: [{ name: 'change', ops: ['update'], run: candidate => ({ ...candidate, title: '  new  ', tags: ['new'] }) }],
      })]);
      const adjusted = await runMutationWrites({ table: changedByHook, store, context, writes });
      if (adjusted.writes[0]?.kind !== 'update') throw new Error('expected update');
      assert.deepEqual(adjusted.writes[0].row.data, { title: 'new', tags: ['new'], note: 'after' });
      const invalidHook = buildModelTable([modelDef(JOB, { fields,
        hooks: [{ name: 'invalid', ops: ['update'], run: candidate => ({ ...candidate, tags: ['too', 'many', 'items'] }) }],
      })]);
      const refusedHook = await captureStateError(runMutationWrites({ table: invalidHook, store, context, writes }));
      assert.equal(refusedHook.code, 'validation');
      assert.deepEqual((await store.load(asModel(JOB), asId('legacy')))?.data, { title, tags: ['old', 'legacy'], note: 'before' });
      assert.deepEqual(await store.historyFor(asModel(JOB), asId('legacy')), []);
    }
  });

  it('validates an applied machine transition before hooks (hand-built text control)', async () => {
    const { store } = createTestMemoryStorage();
    const operation = asOperation(`${JOB}.advance`);
    const machine = { initial: 'draft', states: ['draft', 'done', 'finished'], transitions: [
      { from: 'draft', to: 'done', operation }, { from: 'draft', to: 'finished', operation },
      { from: 'done', to: 'finished', operation },
    ] };
    const field = { required: false, serverOnly: false, default: 'draft', machine, valueType: 'text', max: 5 } as const;
    const seen: unknown[] = [];
    const table = buildModelTable([modelDef(JOB, { fields: { status: field }, hooks: [
      { name: 'observe', ops: ['update'], run: candidate => { seen.push(candidate.status); return candidate; } },
    ] })]);
    await seedStoredRow(store, asModel(JOB), { id: 'draft', data: { status: 'draft' } });
    const context = buildContext({ identity: makeIdentity(), operation, operationId: nextId(),
      app: 'modifier-test', source: 'test', now: FIXED_NOW });
    const run = (from: string, to: string) => runMutationWrites({ table, store, context,
      writes: [{ op: 'update', model: asModel(JOB), id: asId('draft'), transition: { field: 'status', from, to } }],
    });
    const accepted = await run('draft', 'done');
    if (accepted.writes[0]?.kind !== 'update') throw new Error('expected update');
    assert.deepEqual(accepted.writes[0].row.data, { status: 'done' });
    assert.deepEqual(seen, ['done']);
    assert.equal((await captureStateError(run('draft', 'finished'))).code, 'validation');
    assert.equal((await captureStateError(run('done', 'finished'))).code, 'rule_failed');
    assert.deepEqual(seen, ['done']);
    assert.deepEqual((await store.load(asModel(JOB), asId('draft')))?.data, { status: 'draft' });
    // Canonical enum machine fields cannot claim text-length constraints.
    assert.throws(() => buildModelTable([modelDef(JOB, { fields: { status: {
      ...field, valueType: 'enum(draft,done,finished)',
    } } })]), /Invalid constraints/);
  });

  it('loads declared text aliases and preserves NAME plus intersecting receiving bounds in real writes', async () => {
    const artifact = { artifact_version: 1, valueTypes: { contracts: [], aliases: [
      { name: 'Test.Title', type: 'text', min: 2, max: 8, format: 'name' },
      { name: '_CanModelConstraint', type: 'text', min: 1, max: 80, format: 'name' },
    ] }, models: [{ name: JOB, deleteMode: 'archive', fields: [{ name: 'title',
      field: { kind: 'nominal', name: 'Test.Title' }, valueType: 'Test.Title', required: true,
      serverOnly: false, trim: true, min: 3, max: 5,
    }] }], operations: [{ name: `${JOB}.create`, kind: 'create', description: '', inputs: {
      fields: [{ name: 'title', field: { kind: 'nominal', name: 'Test.Title' }, required: true }],
    } }] } satisfies ArtifactDescriptorSlice;
    const loaded = loadArtifactDescriptors(artifact, { by: 'members' });
    const table = buildModelTableFromCanonical(loaded.models, { valueSchema: loaded.valueSchema! });
    const { store } = createTestMemoryStorage();
    const memberships = createMemoryIdentityStore();
    const member = await seedMember(memberships, { isOwner: false });
    const identity = makeIdentity({ membership: member.membership });
    const context = buildContext({ identity, operation: asOperation(`${JOB}.create`), operationId: nextId(),
      app: 'modifier-test', source: 'test', now: FIXED_NOW });
    const run = (title: string) => runMutationWrites({ table, store, context,
      writes: [{ op: 'create', model: asModel(JOB), id: asId(nextId()), data: { title } }] });
    const padded = await run('  Alice  ');
    if (padded.writes[0]?.kind !== 'insert') throw new Error('expected insert');
    assert.equal(padded.writes[0].row.data.title, 'Alice');
    const call = (title: string) => invoke({ app: 'modifier-test', source: 'test', store, memberships, identity,
      clock: { nowMs: () => FIXED_NOW }, registry: loaded.registry, execute: generatedCrudExecute({ table, store }),
      envelope: makeEnvelope(`${JOB}.create`, nextId(), { title }),
    });
    const accepted = await call('Alice');
    assert.equal(accepted.status, 'committed');
    assert.equal((accepted.result as StoredRow).data.title, 'Alice');
    const rows = await store.query({ model: asModel(JOB), authority: 'owner' });
    const history = await store.historyFor(asModel(JOB), (accepted.result as StoredRow).id);
    for (const title of ['Bo', 'Alphabet', 'A B']) {
      assert.equal((await captureStateError(call(title))).code, 'validation');
      // Business refusals may commit rejected receipts, but never domain writes.
      assert.deepEqual(await store.query({ model: asModel(JOB), authority: 'owner' }), rows);
      assert.deepEqual(await store.historyFor(asModel(JOB), (accepted.result as StoredRow).id), history);
    }
    for (const bounds of [{ min: 9, max: 10 }, { min: 0, max: 1 }]) {
      assert.throws(() => loadArtifactDescriptors({ ...artifact, models: [{ ...artifact.models[0]!, fields: [
        { ...artifact.models[0]!.fields[0]!, ...bounds },
      ] }] }, { by: 'members' }), /Invalid field "title"/);
    }
    const wider = loadArtifactDescriptors({ ...artifact, models: [{ ...artifact.models[0]!, fields: [
      { ...artifact.models[0]!.fields[0]!, min: 0, max: 10 },
    ] }] }, { by: 'members' });
    const widerTable = buildModelTableFromCanonical(wider.models, { valueSchema: wider.valueSchema! });
    const revision = await store.readRevision();
    const error = await captureStateError(runMutationWrites({ table: widerTable, store, context,
      writes: [{ op: 'create', model: asModel(JOB), id: asId(nextId()), data: { title: 'Alphabets' } }] }));
    assert.equal(error.code, 'validation');
    assert.equal(await store.readRevision(), revision);
  });

  it('bounds nominal contract arrays without losing codec shape or colliding with schema names', async () => {
    const valueSchema = normalizeSchema({ contracts: {
      _CanModelConstraint: { fields: { value: { type: 'text' } } },
      'Test.Item': { fields: { id: { type: 'text' }, label: { type: 'text' } } },
    }, enums: { _CanModelConstraint_: { cases: ['A'] } },
    aliases: { _CanModelConstraint__: { type: 'text', min: 1, max: 3, format: 'name' } } });
    const table = buildModelTable([modelDef(JOB, { fields: {
      items: { required: false, serverOnly: false, valueType: 'Test.Item[]',
        array: { required: false }, min: 1, max: 2 },
    } })], { valueSchema });
    const { store } = createTestMemoryStorage();
    const context = buildContext({ identity: makeIdentity(), operation: asOperation(`${JOB}.create`),
      operationId: nextId(), app: 'modifier-test', source: 'test', now: FIXED_NOW });
    const run = (items: unknown[]) => runMutationWrites({ table, store, context,
      encodeField: (type, value) => encodeValue(type, validateValue(valueSchema, type, value, 'create') as CanValue),
      writes: [{ op: 'create', model: asModel(JOB), id: asId(nextId()), data: { items } }] });
    const good = await run([{ id: 'item-1', label: 'one' }]);
    if (good.writes[0]?.kind !== 'insert') throw new Error('expected insert');
    assert.deepEqual(good.writes[0].row.data.items, [{ id: 'item-1', label: 'one' }]);
    const missing = await captureStateError(run([{ id: 'item-1' }]));
    assert.equal(missing.code, 'validation');
    const tooMany = await captureStateError(run([{ id: '1', label: 'a' }, { id: '2', label: 'b' }, { id: '3', label: 'c' }]));
    assert.equal(tooMany.code, 'validation');
  });
});
