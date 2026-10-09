/** Narrow checked singular-ref null controls; hand-built pipeline cases are labeled. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { encodeValue } from '@canlang/values';
import type { StoredRow } from '@canlang/contracts';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from '../invocation/registry.js';
import { buildModelTable, buildModelTableFromCanonical, type InterimFieldDef } from './models.js';
import { generatedCrudExecute } from './crud.js';
import { runMutationWrites } from './pipeline.js';
import { invoke } from '../invocation/invoke.js';
import { buildContext } from '../invocation/context.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import { FIXED_NOW, asId, asModel, asOperation, captureStateError, createMemoryIdentityStore,
  makeEnvelope, makeIdentity, seedMember, uuidv7 } from '../../test/invocation/fixtures.js';
import { modelDef, seedStoredRow } from '../../test/mutation/fixtures.js';

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
  it('updates unrelated fields without revalidating hook-cloned legacy arrays and objects', async () => {
    const { store } = createTestMemoryStorage();
    const id = asId(nextId());
    const legacy = { tags: ['a', 'b'], total: { minor: '99', currency: 'USD' }, note: 'before' };
    await seedStoredRow(store, asModel(JOB), { id, data: legacy });
    const context = buildContext({ identity: makeIdentity(), operation: asOperation(`${JOB}.update`),
      operationId: nextId(), app: 'modifier-test', source: 'test', now: FIXED_NOW });
    const fields = {
      tags: { required: false, serverOnly: false, valueType: 'text[]', array: { required: false }, max: 1 },
      total: { required: false, serverOnly: false, valueType: 'money', max: { minor: '10', currency: 'USD' } },
      note: { required: false, serverOnly: false, valueType: 'text' },
    } as const;
    for (const hooks of [[],
      [{ name: 'noop', ops: ['update' as const], run: (candidate: Record<string, unknown>) => candidate }],
      [{ name: 'clone', ops: ['update' as const], run: (candidate: Record<string, unknown>) => structuredClone(candidate) }],
    ]) {
      const table = buildModelTable([modelDef(JOB, { fields, hooks })]);
      for (const data of [{ note: 'after' }, { tags: undefined, total: undefined, note: 'after' }]) {
        const encoded: unknown[] = [];
        const result = await runMutationWrites({ table, store, context,
          writes: [{ op: 'update', model: asModel(JOB), id, data }],
          encodeField: (type, value) => { encoded.push([type, value]); return value; },
        });
        const write = result.writes[0];
        assert.ok(write?.kind === 'update');
        assert.deepEqual(write.row.data, { ...legacy, note: 'after' });
        assert.deepEqual(result.history[0]?.before, legacy);
        assert.deepEqual(result.history[0]?.after, write.row.data);
        assert.deepEqual(encoded, [['text[]', legacy.tags], ['money', legacy.total], ['text', 'after']]);
      }
      for (const data of [{ tags: legacy.tags }, { total: legacy.total }]) {
        const error = await captureStateError(runMutationWrites({ table, store, context,
          writes: [{ op: 'update', model: asModel(JOB), id, data }] }));
        assert.equal(error.code, 'validation');
        assert.match(error.message, /Invalid field "(?:tags|total)"/);
      }
    }
    assert.deepEqual((await store.load(asModel(JOB), id))?.data, legacy);
  });

  it('ignores known undefined patch values while preserving null and caller-field refusal precedence', async () => {
    const { store } = createTestMemoryStorage();
    const id = asId(nextId());
    const legacy = { title: 'legacy long title', status: 'open', secret: 'old' };
    await seedStoredRow(store, asModel(JOB), { id, data: legacy });
    const table = buildModelTable([modelDef(JOB, { fields: {
      title: { required: false, serverOnly: false, valueType: 'text?', nullable: true, min: 1, max: 3 },
      status: { required: false, serverOnly: false, default: 'open', machine: { initial: 'open', states: ['open', 'closed'], transitions: [] } },
      secret: { required: false, serverOnly: true },
    } })]);
    const context = buildContext({ identity: makeIdentity(), operation: asOperation(`${JOB}.update`),
      operationId: nextId(), app: 'modifier-test', source: 'test', now: FIXED_NOW });
    const run = (data: Record<string, unknown>) => runMutationWrites({ table, store, context,
      writes: [{ op: 'update', model: asModel(JOB), id, data }] });
    for (const data of [{}, { title: undefined }, { title: undefined, status: undefined, secret: undefined }]) {
      const result = await run(data);
      assert.ok(result.writes[0]?.kind === 'update');
      assert.deepEqual(result.writes[0].row.data, legacy);
    }
    const cleared = await run({ title: null });
    assert.ok(cleared.writes[0]?.kind === 'update');
    assert.deepEqual(cleared.writes[0].row.data, { ...legacy, title: null });
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ title: legacy.title }, /Invalid field "title"/],
      [{ title: legacy.title, unknown: undefined }, /Unknown field/],
      [{ title: legacy.title, status: 'closed' }, /Machine field/],
      [{ title: legacy.title, secret: 'new' }, /server-only/],
    ];
    for (const [data, message] of cases) {
      const error = await captureStateError(run(data));
      assert.equal(error.code, 'validation');
      assert.match(error.message, message);
    }
    assert.deepEqual((await store.load(asModel(JOB), id))?.data, legacy);
    assert.deepEqual(await store.historyFor(asModel(JOB), id), []);
  });

  it('validates actual array/object hook mutations and rolls back the complete update batch', async () => {
    const { store } = createTestMemoryStorage();
    const id = asId(nextId()), stagedId = asId(nextId());
    const legacy = { tags: ['a', 'b'], total: { minor: '99', currency: 'USD' }, note: 'before' };
    await seedStoredRow(store, asModel(JOB), { id, data: legacy });
    const context = buildContext({ identity: makeIdentity(), operation: asOperation(`${JOB}.update`),
      operationId: nextId(), app: 'modifier-test', source: 'test', now: FIXED_NOW });
    const fields = {
      tags: { required: false, serverOnly: false, valueType: 'text[]', array: { required: false }, max: 1 },
      total: { required: false, serverOnly: false, valueType: 'money', max: { minor: '10', currency: 'USD' } },
      note: { required: false, serverOnly: false, valueType: 'text' },
    } as const;
    const revision = await store.readRevision();
    for (const field of ['tags', 'total']) {
      const table = buildModelTable([modelDef(JOB, { fields, uniqueKeys: ['note'], hooks: [{
        name: 'change', ops: ['update'], run: candidate => {
          if (field === 'tags') (candidate.tags as string[]).push('c');
          else (candidate.total as { minor: string }).minor = '100';
          return candidate;
        },
      }] })]);
      const error = await captureStateError(runMutationWrites({ table, store, context, writes: [
        { op: 'create', model: asModel(JOB), id: stagedId, data: { tags: [], total: { minor: '0', currency: 'USD' }, note: 'staged' } },
        { op: 'update', model: asModel(JOB), id, data: { note: 'after' } },
      ] }));
      assert.equal(error.code, 'validation');
      assert.match(error.message, new RegExp(`Invalid field "${field}"`));
      assert.equal(await store.readRevision(), revision);
      assert.deepEqual((await store.load(asModel(JOB), id))?.data, legacy);
      assert.equal(await store.load(asModel(JOB), stagedId), null);
      assert.deepEqual(await store.historyFor(asModel(JOB), id), []);
      assert.deepEqual(await store.historyFor(asModel(JOB), stagedId), []);
    }
  });

  it('archives unchanged legacy fields without normalization and validates only remove-hook changes', async () => {
    const { store } = createTestMemoryStorage();
    const id = asId(nextId());
    const legacy = { title: '  legacy title outside current bounds  ', count: '99', tags: ['legacy', 'data'] };
    await seedStoredRow(store, asModel(JOB), { id, data: legacy });
    const context = buildContext({ identity: makeIdentity(), operation: asOperation(`${JOB}.remove`),
      operationId: nextId(), app: 'modifier-test', source: 'test', now: FIXED_NOW });
    const fields = {
      title: { required: true, serverOnly: false, valueType: 'text', trim: true, min: 1, max: 3 },
      count: { required: true, serverOnly: false, valueType: 'int', min: '0', max: '10' },
      tags: { required: false, serverOnly: false, valueType: 'text[]', array: { required: false }, max: 1 },
    } as const;
    const encoded: unknown[] = [];
    const run = (change?: string) => runMutationWrites({
      table: buildModelTable([modelDef(JOB, { fields, hooks: [{ name: 'archive-note', ops: ['remove'],
        run: candidate => change === undefined ? candidate : { ...candidate, title: change },
      }] })]), store, context, writes: [{ op: 'remove', model: asModel(JOB), id }],
      encodeField: (type, value) => {
        assert.equal(type, 'text', 'unchanged legacy int/array must bypass encoding');
        assert.notEqual(value, legacy.title, 'unchanged legacy text must bypass encoding');
        encoded.push(value);
        return value;
      },
    });
    const unchanged = await run();
    assert.deepEqual(encoded, []);
    const write = unchanged.writes[0];
    assert.ok(write?.kind === 'update');
    assert.deepEqual(write.row.data, legacy);
    assert.equal(write.row.archivedAt, FIXED_NOW);
    assert.deepEqual(unchanged.history[0]?.before, legacy);
    assert.deepEqual(unchanged.history[0]?.after, legacy);
    const changed = await run('  ok  ');
    const changedWrite = changed.writes[0];
    assert.ok(changedWrite?.kind === 'update');
    assert.deepEqual(changedWrite.row.data, { ...legacy, title: 'ok' });
    assert.deepEqual(encoded, ['  ok  ', 'ok']);
    const revision = await store.readRevision();
    const error = await captureStateError(run('   '));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /Invalid field "title"/);
    assert.deepEqual(encoded, ['  ok  ', 'ok', '   ']);
    assert.equal(await store.readRevision(), revision);
    assert.deepEqual((await store.load(asModel(JOB), id))?.data, legacy);
    assert.equal((await store.load(asModel(JOB), id))?.archivedAt, null);
    assert.deepEqual(await store.historyFor(asModel(JOB), id), []);
  });

  it('preserves constrained native ints for create/update hook arithmetic and default receipts', async () => {
    const { store } = createTestMemoryStorage();
    const seen: unknown[] = [];
    const table = buildModelTable([modelDef(JOB, { fields: {
      count: { required: true, serverOnly: false, valueType: 'int', min: '0', max: '10', default: 2n },
    }, hooks: [{ name: 'increment', ops: ['create', 'update'], run: candidate => {
      seen.push(candidate.count);
      assert.equal(typeof candidate.count, 'bigint');
      return { ...candidate, count: (candidate.count as bigint) + 1n };
    } }] })]);
    const context = buildContext({ identity: makeIdentity(), operation: asOperation(`${JOB}.create`),
      operationId: nextId(), app: 'modifier-test', source: 'test', now: FIXED_NOW });
    const id = asId(nextId());
    const encodeField = (type: Parameters<typeof encodeValue>[0], value: unknown) =>
      typeof value === 'bigint' ? encodeValue(type, value) : value;
    const created = await runMutationWrites({ table, store, context, encodeField,
      writes: [{ op: 'create', model: asModel(JOB), id, data: {} }] });
    const commit = async (effects: typeof created) => store.commit({
      expectedRevision: await store.readRevision(), writes: effects.writes, history: effects.history,
      uniqueClaims: effects.uniqueClaims, uniqueReleases: effects.uniqueReleases,
      schedules: effects.schedules, receipt: null, outbox: [],
    });
    assert.equal(created.resolvedDefaults.count, '2');
    await commit(created);
    assert.equal((await store.load(asModel(JOB), id))?.data.count, '3');
    const patch = { count: 7n };
    const updated = await runMutationWrites({ table, store, context, encodeField,
      writes: [{ op: 'update', model: asModel(JOB), id, data: patch }] });
    await commit(updated);
    assert.deepEqual(seen, [2n, 7n]);
    assert.equal(patch.count, 7n);
    assert.equal((await store.load(asModel(JOB), id))?.data.count, '8');
    assert.equal(updated.history[0]?.after?.count, '8');
    assert.deepEqual(updated.resolvedDefaults, {});
    assert.doesNotThrow(() => JSON.stringify([created, updated]));
  });

  it('retains pre-hook int bounds and rolls back hook-produced bound failures', async () => {
    const { store } = createTestMemoryStorage();
    const seen: unknown[] = [];
    const table = buildModelTable([modelDef(JOB, { fields: {
      count: { required: true, serverOnly: false, valueType: 'int', min: '0', max: '10' },
    }, uniqueKeys: ['count'], hooks: [{ name: 'increment', ops: ['create', 'update'], run: candidate => {
      seen.push(candidate.count);
      return { ...candidate, count: (candidate.count as bigint) + 1n };
    } }] })]);
    const context = buildContext({ identity: makeIdentity(), operation: asOperation(`${JOB}.create`),
      operationId: nextId(), app: 'modifier-test', source: 'test', now: FIXED_NOW });
    const first = asId(nextId()), second = asId(nextId());
    const revision = await store.readRevision();
    const run = (writes: Parameters<typeof runMutationWrites>[0]['writes']) => runMutationWrites({
      table, store, context, writes,
      encodeField: (type, value) => typeof value === 'bigint' ? encodeValue(type, value) : value,
    });
    for (const count of [-1n, 11n]) {
      const error = await captureStateError(run([{ op: 'create', model: asModel(JOB), id: first, data: { count } }]));
      assert.equal(error.code, 'validation');
      assert.match(error.message, /Invalid field "count"/);
    }
    assert.deepEqual(seen, []);
    for (const op of ['create', 'update'] as const) {
      const error = await captureStateError(run([
        { op: 'create', model: asModel(JOB), id: first, data: { count: 1n } },
        { op, model: asModel(JOB), id: op === 'create' ? second : first, data: { count: 10n } },
      ]));
      assert.equal(error.code, 'validation');
      assert.match(error.message, /Invalid field "count"/);
      assert.equal(await store.readRevision(), revision);
      for (const id of [first, second]) {
        assert.equal(await store.load(asModel(JOB), id), null);
        assert.deepEqual(await store.historyFor(asModel(JOB), id), []);
      }
    }
    assert.deepEqual(seen, [1n, 10n, 1n, 10n]);
    const recovered = await run([{ op: 'create', model: asModel(JOB), id: first, data: { count: 1n } }]);
    await store.commit({ expectedRevision: revision, writes: recovered.writes, history: recovered.history,
      uniqueClaims: recovered.uniqueClaims, uniqueReleases: recovered.uniqueReleases,
      schedules: recovered.schedules, receipt: null, outbox: [] });
    assert.equal((await store.load(asModel(JOB), first))?.data.count, '2');
  });

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
});
