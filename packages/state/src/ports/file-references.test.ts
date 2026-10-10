/** Defining State current File-slot consumer using actual MemoryState,
 * Identity snapshots, canonical CRUD winner commits and SQLite Files bytes.
 * Descriptors are hand-built in one checked load; these are not Compiler,
 * native deployment or cross-store atomic deletion qualifications. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ArtifactModel, ArtifactOperation, CanTypeId, StoragePort, StoredRow } from '@canlang/contracts';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { DEFAULT_FILE_POLICY, ingestVerifiedEventBytes, readFinalizedBytes } from '@canlang/files';
import { createSqliteFileStore } from '@canlang/files/host/sqlite';
import { StateError } from '../errors.js';
import { createMemoryStorage } from '../storage/memory.js';
import { buildModelTableFromCanonical } from '../mutation/models.js';
import { generatedCrudExecute } from '../mutation/crud.js';
import { buildPolicyTable, type PolicyTable } from '../policy/grants.js';
import type { MembershipReader } from '../policy/roles.js';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from '../invocation/registry.js';
import { invoke, type ExecutionEffects } from '../invocation/invoke.js';
import { createFileReferenceConsumer } from '../index.js';
import { FIXED_NOW, asId, asModel, asVersion, makeBatch, makeEnvelope, makeIdentity, uuidv7 } from '../../test/invocation/fixtures.js';

const MODEL = asModel('Files.Record'), OTHER = asModel('Files.Other'), CHILD = asModel('Files.Child');
const APP = 'current-file-slots', bytes = new TextEncoder().encode('genuine SQLite finalized bytes\n');
let sequence = 100_000;
const stateError = (error: unknown) => error instanceof StateError;
function artifact(): ArtifactDescriptorSlice {
  const fields: ArtifactModel['fields'] = [
    { name: 'file', field: { kind: 'file' }, valueType: 'file' as CanTypeId, required: true, serverOnly: false },
    { name: 'optionalFile', field: { kind: 'file' }, valueType: 'file?' as CanTypeId, nullable: true, required: false, serverOnly: false },
    { name: 'files', field: { kind: 'file' }, valueType: 'file[]' as CanTypeId, array: { required: false }, max: 4, required: false, serverOnly: false },
    { name: 'optionalFiles', field: { kind: 'file' }, valueType: 'file[]?' as CanTypeId,
      nullable: true, array: { required: false }, max: 4, required: false, serverOnly: false },
    { name: 'reviewer', field: { kind: 'user' }, valueType: 'user' as CanTypeId, required: true, serverOnly: false },
    { name: 'label', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: true, serverOnly: false },
  ];
  const models: ArtifactModel[] = [
    { name: MODEL, deleteMode: 'remove', fields }, { name: OTHER, deleteMode: 'remove', fields },
    { name: CHILD, parent: MODEL, deleteMode: 'archive', fields },
  ];
  const operations: ArtifactOperation[] = models.flatMap(model => {
    const inputs = fields.map(({ name, field, valueType, nullable, array, min, max, required }) => ({ name,
      field: field.kind === 'ref' ? { ...field, requireVersion: true } : field,
      ...(valueType === undefined ? {} : { valueType }), ...(nullable === undefined ? {} : { nullable }),
      ...(array === undefined ? {} : { array }), ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }), required }));
    const record = { name: 'record', field: { kind: 'ref' as const, model: model.name, requireVersion: true }, required: true };
    return [
      { name: `${model.name}.read`, kind: 'read' as const, description: '', inputs: { fields: [] } },
      { name: `${model.name}.create`, kind: 'create' as const, description: '', inputs: { fields: [
        ...(model.parent === undefined ? [] : [{ name: 'parent', field: { kind: 'ref' as const, model: model.parent,
          requireVersion: true }, required: true }]), ...inputs,
      ] } },
      { name: `${model.name}.update`, kind: 'update' as const, description: '', inputs: { fields: [record,
        ...inputs.map(input => ({ ...input, required: false })),
      ] } },
      { name: `${model.name}.delete`, kind: 'delete' as const, description: '', inputs: { fields: [record] } },
    ];
  });
  return { artifact_version: 1, models, operations };
}
type PolicyOptions = { fields?: string[]; secret?: string[]; hiddenParent?: boolean; privateOther?: boolean };
function policies(loaded: ReturnType<typeof loadArtifactDescriptors>, options: PolicyOptions = {}): PolicyTable {
  return buildPolicyTable([MODEL, OTHER, CHILD].map(model => ({ model, secretFields: options.secret ?? [],
    grants: options.hiddenParent && model === MODEL || options.privateOther && model === OTHER ? [] : [{
      by: { and: ['members' as const, { roleSubject: { role: 'Files.reader', person: { model, field: 'reviewer' } } }] },
      fields: options.fields ?? ['file', 'optionalFile', 'files', 'optionalFiles', 'reviewer', 'label'],
    }],
  })), loaded.models);
}
async function world(t: TestContext) {
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const callerMembership = await memberships.createMembership({ team_id: team.team_id, user_id: 'file-caller', is_owner: false, roles: [] });
  const subject = await memberships.createMembership({ team_id: team.team_id, user_id: 'file-reviewer', is_owner: false,
    roles: [{ role: 'Files.reader', granted_at: callerMembership.created_at, granted_by: callerMembership.user_id }] });
  const identity = makeIdentity({ userId: callerMembership.user_id, team, membership: callerMembership });
  const scope = { app: APP, team: team.team_id, owner: team.team_id };
  const caller = { ...scope, principal: callerMembership.user_id };
  const slice = artifact(), loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields, containment: loaded.containment,
    ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }) });
  const policy = policies(loaded), clock = { nowMs: () => FIXED_NOW };
  const directory = mkdtempSync(join(tmpdir(), 'can-state-current-file-'));
  const physical = createSqliteFileStore(join(directory, 'files.sqlite'));
  t.after(() => { physical.close(); rmSync(directory, { recursive: true, force: true }); });
  const finalize = () => {
    const result = physical.transaction(() => ingestVerifiedEventBytes({ clock, files: physical.files, blobs: physical.blobs,
      intents: physical.intents, fileIds: { nextFileId: () => randomUUID() } }, {
      provenance: { kind: 'event', source: 'deployment.mail', adapter: 'deployment.mail', occurrenceId: randomUUID(),
        fieldPath: 'attachments', itemIndex: 0 }, receiver: caller, claimedType: 'text/plain', bytes, policy: DEFAULT_FILE_POLICY,
    }));
    assert.equal(result.status, 'finalized'); if (result.status !== 'finalized') throw new Error('Files finalization failed');
    return result.file.id;
  };
  const refs = [finalize(), finalize()] as const;
  const registry = loaded.registry;
  const execute = generatedCrudExecute({ table, store, ownerBounds: { maxRows: 30, maxWork: 1000 } });
  const common = { registry, store, memberships, identity, app: APP, source: 'test', clock };
  const input = (ref = refs[0]) => ({ file: { id: ref }, optionalFile: null, files: [], optionalFiles: null,
    reviewer: { id: subject.user_id }, label: 'visible' });
  const create = async (model = MODEL, data: Record<string, unknown> = input(), parent?: StoredRow) => {
    const result = await invoke({ ...common, envelope: makeEnvelope(`${model}.create`, uuidv7(FIXED_NOW, ++sequence),
      { ...data, ...(parent === undefined ? {} : { parent: { id: parent.id, version: String(parent.version) } }) }), execute });
    assert.equal(result.status, 'committed'); const row = result.result as StoredRow;
    assert.ok(row); assert.deepEqual(await store.load(model, row.id), row); return row;
  };
  const update = async (model: typeof MODEL, id: StoredRow['id'], patch: Record<string, unknown>) => {
    const row = await store.load(model, id); assert.ok(row);
    const result = await invoke({ ...common, envelope: makeEnvelope(`${model}.update`, uuidv7(FIXED_NOW, ++sequence),
      { record: { id, version: String(row.version) }, ...patch }), execute });
    assert.equal(result.status, 'committed'); return result.result as StoredRow;
  };
  const remove = async (model: typeof MODEL, id: StoredRow['id']) => {
    const row = await store.load(model, id); assert.ok(row);
    const result = await invoke({ ...common, envelope: makeEnvelope(`${model}.delete`, uuidv7(FIXED_NOW, ++sequence),
      { record: { id, version: String(row.version) } }), execute });
    assert.equal(result.status, 'committed');
  };
  const options = { scope, store, policy, memberships, canonicalModels: loaded.models, artifactModels: slice.models!, registry,
    maxRows: 20, maxReferences: 100 };
  const consumer = createFileReferenceConsumer(options);
  let consumptions = 0;
  const consume = async (slot: { ref: string }) => {
    consumptions++; return readFinalizedBytes({ files: physical.files, blobs: physical.blobs }, slot.ref, caller);
  };
  return { ...common, loaded, slice, table, caller, scope, callerMembership, subject, policy, options, consumer,
    physical, refs, input, create, update, remove, execute, consume, consumptions: () => consumptions };
}
type World = Awaited<ReturnType<typeof world>>;
function locator(w: World, row: StoredRow, field = 'file', ref = w.refs[0], model = MODEL) {
  return { model, recordId: row.id, field, ref };
}
async function corrupt(w: World, model: typeof MODEL, row: StoredRow, changes: Partial<StoredRow>) {
  const current = await w.store.load(model, row.id); assert.ok(current);
  await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'update', model, id: row.id,
    expectedVersion: current.version, row: { ...current, version: asVersion(current.version + 1), ...changes } }] }));
}
async function withheld(action: () => Promise<Uint8Array | null>) {
  try { assert.equal(await action(), null); }
  catch (error) { assert.ok(error instanceof StateError); assert.ok(['validation', 'conflict', 'forbidden'].includes(error.code)); }
}

test('complete current inventory preserves sharing, duplicate array slots and archived references until the actual winning removal', async t => {
  const w = await world(t);
  const first = await w.create(MODEL, { ...w.input(), optionalFile: { id: w.refs[0] },
    files: [{ id: w.refs[0] }, { id: w.refs[1] }, { id: w.refs[0] }] });
  const second = await w.create(OTHER, w.input());
  const child = await w.create(CHILD, w.input(), first); await w.remove(CHILD, child.id);
  const archived = await w.store.load(CHILD, child.id); assert.ok(archived); assert.notEqual(archived.archivedAt, null);
  const consumer = createFileReferenceConsumer({ ...w.options, policy: policies(w.loaded, { privateOther: true }) });
  const observation = await consumer.observeReferences(w.refs[0]);
  assert.equal(observation.complete, true); assert.deepEqual(observation.scope, w.scope);
  assert.equal(observation.revision, await w.store.readRevision());
  assert.deepEqual(observation.references.map(slot => [slot.model, slot.recordId, slot.field, slot.index, slot.archived]).sort(), [
    [MODEL, first.id, 'file', null, false], [MODEL, first.id, 'optionalFile', null, false],
    [MODEL, first.id, 'files', 0, false], [MODEL, first.id, 'files', 2, false],
    [OTHER, second.id, 'file', null, false], [CHILD, child.id, 'file', null, true],
  ].sort());
  assert.ok(observation.references.every(slot => slot.ref === w.refs[0]));
  assert.equal(observation.references.find(slot => slot.model === CHILD)!.rowVersion, archived.version);
  await observation.revalidate();
  await w.remove(OTHER, second.id);
  await assert.rejects(observation.revalidate(), stateError);
  const after = await consumer.observeReferences(w.refs[0]);
  assert.equal(after.references.length, 5); assert.ok(after.references.every(slot => slot.recordId !== second.id));
  await w.update(MODEL, first.id, { file: { id: w.refs[1] }, optionalFile: null, files: [{ id: w.refs[1] }] });
  await assert.rejects(after.revalidate(), stateError);
  assert.deepEqual((await consumer.observeReferences(w.refs[0])).references.map(slot => slot.recordId), [child.id]);
  const currentChild = await w.store.load(CHILD, child.id); assert.ok(currentChild);
  await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'remove', model: CHILD,
    id: child.id, expectedVersion: currentChild.version }] }));
  assert.deepEqual((await consumer.observeReferences(w.refs[0])).references, []);
  assert.equal((await consumer.observeReferences(w.refs[1])).references.length, 2);
  assert.equal(w.consumptions(), 0);
});

test('authorized scalar, nullable and duplicate array slots read genuine finalized SQLite bytes through current source authority', async t => {
  const w = await world(t);
  const row = await w.create(MODEL, { ...w.input(), optionalFile: { id: w.refs[0] },
    files: [{ id: w.refs[0] }, { id: w.refs[0] }], optionalFiles: [{ id: w.refs[0] }] });
  for (const field of ['file', 'optionalFile', 'files', 'optionalFiles']) {
    assert.deepEqual(await w.consumer.read(locator(w, row, field), w.caller, async slot => {
      assert.deepEqual(slot, { model: MODEL, recordId: row.id, rowVersion: row.version, field, ref: w.refs[0] });
      return w.consume(slot);
    }), bytes);
  }
  assert.equal(w.consumptions(), 4);
  const child = await w.create(CHILD, w.input(), row);
  assert.deepEqual(await w.consumer.read(locator(w, child, 'file', w.refs[0], CHILD), w.caller, w.consume), bytes);
  assert.equal(w.consumptions(), 5);
});

test('missing, archived, removed, foreign, partial, secret and revoked current slots never reach physical consumption', async t => {
  for (const mode of ['missing', 'removed', 'archived', 'foreign-app', 'foreign-team', 'foreign-owner', 'principal',
    'wrong-field', 'changed-ref', 'leaf', 'secret', 'revoked', 'subject', 'parent-hidden', 'read-missing'] as const) {
    const w = await world(t), parent = await w.create(), row = mode === 'archived' || mode === 'parent-hidden'
      ? await w.create(CHILD, w.input(), parent) : parent;
    const model = row === parent ? MODEL : CHILD;
    let consumer = w.consumer, caller = w.caller, requested = locator(w, row, 'file', w.refs[0], model);
    if (mode === 'missing') requested = { ...requested, recordId: asId('absent-record') };
    if (mode === 'removed' || mode === 'archived') await w.remove(model, row.id);
    if (mode === 'foreign-app') caller = { ...caller, app: 'foreign-app' };
    if (mode === 'foreign-team') caller = { ...caller, team: 'foreign-team' };
    if (mode === 'foreign-owner') caller = { ...caller, owner: 'foreign-owner' };
    if (mode === 'principal') caller = { ...caller, principal: 'unrelated-unprivileged-principal' };
    if (mode === 'wrong-field') requested = { ...requested, field: 'label' };
    if (mode === 'changed-ref') await w.update(model, row.id, { file: { id: w.refs[1] } });
    if (mode === 'leaf') consumer = createFileReferenceConsumer({ ...w.options, policy: policies(w.loaded,
      { fields: ['file.id', 'optionalFile', 'files', 'optionalFiles', 'reviewer', 'label'] }) });
    if (mode === 'secret') consumer = createFileReferenceConsumer({ ...w.options, policy: policies(w.loaded,
      { fields: ['optionalFile', 'files', 'optionalFiles', 'reviewer', 'label'], secret: ['file'] }) });
    if (mode === 'revoked') await w.memberships.removeMembership(w.callerMembership.membership_id);
    if (mode === 'subject') await w.memberships.removeMembership(w.subject.membership_id);
    if (mode === 'parent-hidden') consumer = createFileReferenceConsumer({ ...w.options, policy: policies(w.loaded, { hiddenParent: true }) });
    await withheld(() => {
      if (mode === 'read-missing') {
        const registry = new Map(w.registry); registry.delete(`${MODEL}.read`);
        consumer = createFileReferenceConsumer({ ...w.options, registry });
      }
      return consumer.read(requested, caller, w.consume);
    });
    assert.equal(w.consumptions(), 0, mode);
  }
});

test('inventory refuses overflow and malformed committed File wires instead of claiming complete absence', async t => {
  for (const mode of ['rows', 'references', 'missing-required', 'malformed', 'numeric-id', 'unknown', 'array-null', 'array-bound'] as const) {
    const w = await world(t), row = await w.create();
    let consumer = w.consumer;
    if (mode === 'rows') { await w.create(OTHER); consumer = createFileReferenceConsumer({ ...w.options, maxRows: 1 }); }
    if (mode === 'references') {
      await w.update(MODEL, row.id, { files: [{ id: w.refs[0] }, { id: w.refs[0] }] });
      consumer = createFileReferenceConsumer({ ...w.options, maxReferences: 2 });
    }
    if (!['rows', 'references'].includes(mode)) {
      const data = structuredClone(row.data) as Record<string, unknown>;
      if (mode === 'missing-required') delete data['file'];
      if (mode === 'malformed') data['file'] = w.refs[0];
      if (mode === 'numeric-id') data['file'] = { id: 7 };
      if (mode === 'unknown') data['file'] = { id: w.refs[0], receiver: w.caller };
      if (mode === 'array-null') data['files'] = [{ id: w.refs[0] }, null];
      if (mode === 'array-bound') data['files'] = Array.from({ length: 5 }, () => ({ id: w.refs[0] }));
      await corrupt(w, MODEL, row, { data });
    }
    await assert.rejects(consumer.observeReferences(w.refs[1]), stateError, mode);
    assert.equal(w.consumptions(), 0);
  }
});

test('only winning State changes alter current slots; rejected staged replacements and replay preserve the committed inventory', async t => {
  const w = await world(t), row = await w.create();
  const before = await w.consumer.observeReferences(w.refs[0]), revision = await w.store.readRevision();
  const envelope = makeEnvelope(`${MODEL}.update`, uuidv7(FIXED_NOW, ++sequence), {
    record: { id: row.id, version: String(row.version) }, file: { id: w.refs[1] },
  });
  let executions = 0;
  const rejected = { ...w, envelope, execute: async (call: Parameters<typeof w.execute>[0]): Promise<ExecutionEffects> => {
    executions++; await w.execute(call); throw new StateError('rule_failed', 'Original staged replacement refused');
  } };
  await assert.rejects(invoke(rejected), stateError);
  assert.equal(executions, 1); assert.equal(await w.store.readRevision(), revision + 1);
  assert.deepEqual((await w.consumer.observeReferences(w.refs[0])).references, before.references);
  assert.deepEqual((await w.consumer.observeReferences(w.refs[1])).references, []);
  assert.deepEqual(await w.store.load(MODEL, row.id), row);
  assert.equal((await w.store.historyFor(MODEL, row.id)).length, 1);
  await assert.rejects(invoke(rejected), stateError); assert.equal(executions, 1);
  await assert.rejects(before.revalidate(), stateError);
  const changed = await w.update(MODEL, row.id, { file: { id: w.refs[1] } });
  assert.equal(changed.version, row.version + 1);
  assert.deepEqual((await w.consumer.observeReferences(w.refs[0])).references, []);
  assert.equal((await w.consumer.observeReferences(w.refs[1])).references[0]!.rowVersion, changed.version);
});

test('State revision, source lifetime and full Identity fact drift during the physical await withhold already-read bytes', async t => {
  for (const mode of ['replacement', 'removal', 'owner', 'revoked', 'full-facts', 'subject-swap'] as const) {
    const w = await world(t), row = await w.create(); let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const pending = w.consumer.read(locator(w, row), w.caller, async slot => {
      const result = await w.consume(slot); assert.deepEqual(result, bytes); entered(); await blocked; return result;
    });
    await started;
    if (mode === 'replacement') await w.update(MODEL, row.id, { file: { id: w.refs[1] } });
    if (mode === 'removal') await w.remove(MODEL, row.id);
    if (mode === 'owner') await corrupt(w, MODEL, row, { createdBy: 'another-owner' });
    if (mode === 'revoked') await w.memberships.removeMembership(w.subject.membership_id);
    if (mode === 'full-facts') await w.memberships.setMembershipRoles(w.subject.membership_id, [...w.subject.roles,
      { role: 'Files.unrelated', granted_at: w.subject.updated_at, granted_by: w.caller.principal }]);
    if (mode === 'subject-swap') await w.update(MODEL, row.id, { reviewer: { id: 'unprivileged-reviewer' } });
    release(); await withheld(() => pending); assert.equal(w.consumptions(), 1, mode);
  }
});

test('copied inventory or genuine physical finalization facts cannot authorize absent current source slots or incomplete Identity authority', async t => {
  const w = await world(t), row = await w.create();
  const original = await w.consumer.observeReferences(w.refs[0]);
  const copied = JSON.parse(JSON.stringify(original.references[0])) as (typeof original.references)[number];
  await w.remove(MODEL, row.id);
  await withheld(() => w.consumer.read({ model: copied.model, recordId: copied.recordId, field: copied.field, ref: copied.ref },
    w.caller, w.consume));
  const next = await w.create();
  await withheld(() => w.consumer.read(locator(w, next, 'file', w.refs[1]), w.caller, w.consume));
  assert.ok(w.physical.files.get(w.refs[1]), 'a genuinely finalized physical file still needs a current owning State slot');
  const singular: MembershipReader = { findMembership: w.memberships.findMembership };
  await withheld(() => createFileReferenceConsumer({ ...w.options, memberships: singular }).read(locator(w, next), w.caller, w.consume));
  assert.equal(w.consumptions(), 0);
  const empty = await w.consumer.observeReferences('absent-finalized-reference');
  assert.equal(empty.complete, true); assert.deepEqual(empty.references, []); await empty.revalidate();
});
