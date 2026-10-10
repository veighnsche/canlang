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
import { DEFAULT_FILE_POLICY, ingestVerifiedEventBytes, readCurrentFinalizedBytes } from '@canlang/files';
import { blobKeyForFile } from '@canlang/files/finalize';
import { createSqliteFileStore } from '@canlang/files/host/sqlite';
import { StateError } from '../errors.js';
import { createMemoryStorage } from '../storage/memory.js';
import { buildModelTable, buildModelTableFromCanonical } from '../mutation/models.js';
import { generatedCrudExecute } from '../mutation/crud.js';
import { buildPolicyTable, type PolicyTable } from '../policy/grants.js';
import type { MembershipReader } from '../policy/roles.js';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice } from '../invocation/registry.js';
import { invoke, type ExecutionEffects } from '../invocation/invoke.js';
import { createFileReferenceConsumer } from '../index.js';
import { FIXED_NOW, asId, asModel, asVersion, makeBatch, makeEnvelope, makeIdentity, uuidv7 } from '../../test/invocation/fixtures.js';

const MODEL = asModel('Files.Record'), OTHER = asModel('Files.Other'), CHILD = asModel('Files.Child');
const RETENTION = { unattachedHorizonMs: 60_000, retentionMs: 120_000 };
const APP = 'current-file-slots', bytes = new TextEncoder().encode('genuine SQLite finalized bytes\n');
let sequence = 100_000;
const stateError = (error: unknown) => error instanceof StateError;
function artifact(): ArtifactDescriptorSlice {
  const fields: Array<Omit<ArtifactModel['fields'][number], 'field' | 'min' | 'max'> & {
    field: { kind: 'file' | 'user' | 'string' }; min?: number; max?: number;
  }> = [
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
      field,
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
const PACKET = 'Files.Packet', DETAIL = 'Files.Detail';
const NOMINAL_GRANTS = ['file', 'optionalFile', 'files', 'optionalFiles', 'reviewer', 'label',
  'payload', 'packets', 'nullablePayload'];
function nominalArtifact(): ArtifactDescriptorSlice {
  const slice = artifact();
  slice.valueTypes = { contracts: [
    { name: DETAIL, fields: [{ name: 'attachment', type: 'file?' }, { name: 'note', type: 'text', max: 20 }] },
    { name: PACKET, fields: [
      { name: 'attachments', type: 'file[]', max: 3 }, { name: 'optional', type: 'file?' },
      { name: 'detail', type: `${DETAIL}?` }, { name: 'choice', type: `file|${DETAIL}` },
      { name: 'related', type: `${OTHER}?` }, { name: 'label', type: 'text', max: 20 },
    ] },
  ] };
  const fields: Array<Omit<ArtifactModel['fields'][number], 'field' | 'min' | 'max'> & {
    field: { kind: 'nominal'; name: string }; min?: number; max?: number;
  }> = [
    { name: 'payload', field: { kind: 'nominal', name: PACKET }, valueType: PACKET as CanTypeId,
      required: true, serverOnly: false },
    { name: 'packets', field: { kind: 'nominal', name: PACKET }, valueType: `${PACKET}[]!` as CanTypeId,
      array: { required: true }, min: 1, max: 2, required: true, serverOnly: false },
    { name: 'nullablePayload', field: { kind: 'nominal', name: PACKET }, valueType: `${PACKET}?` as CanTypeId,
      nullable: true, required: false, serverOnly: false },
  ];
  for (const model of slice.models!) model.fields = [...model.fields, ...fields];
  for (const operation of slice.operations!) {
    if (operation.kind !== 'create' && operation.kind !== 'update') continue;
    operation.inputs.fields.push(...fields.map(({ name, field, valueType, nullable, array, min, max, required }) => ({
      name, field, valueType: valueType!, required: operation.kind === 'create' && required,
      ...(nullable === undefined ? {} : { nullable }), ...(array === undefined ? {} : { array }),
      ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }),
    })));
  }
  return slice;
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
async function world(t: TestContext, slice = artifact()) {
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore({ clock: createFrozenClock(FIXED_NOW) });
  const team = await memberships.createTeam({ timezone: 'UTC' });
  const callerMembership = await memberships.createMembership({ team_id: team.team_id, user_id: 'file-caller', is_owner: false, roles: [] });
  const subject = await memberships.createMembership({ team_id: team.team_id, user_id: 'file-reviewer', is_owner: false,
    roles: [{ role: 'Files.reader', granted_at: callerMembership.created_at, granted_by: callerMembership.user_id }] });
  const identity = makeIdentity({ userId: callerMembership.user_id, team, membership: callerMembership });
  const scope = { app: APP, team: team.team_id, owner: team.team_id };
  const caller = { ...scope, principal: callerMembership.user_id };
  const loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields, containment: loaded.containment,
    ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }) });
  const policy = policies(loaded), clock = createFrozenClock(FIXED_NOW);
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
    ...(loaded.valueTypes === undefined ? {} : { valueTypes: loaded.valueTypes }),
    maxRows: 20, maxReferences: 100 };
  const consumer = createFileReferenceConsumer(options);
  let consumptions = 0;
  const consume = async (slot: { ref: string }) => {
    consumptions++; return physical.transaction(() => readCurrentFinalizedBytes(
      { clock, files: physical.files, blobs: physical.blobs }, slot.ref, caller, { policy: DEFAULT_FILE_POLICY, retention: RETENTION }));
  };
  return { ...common, loaded, slice, table, caller, scope, callerMembership, subject, policy, options, consumer,
    physical, refs, input, create, update, remove, execute, consume, consumptions: () => consumptions };
}
type World = Awaited<ReturnType<typeof world>>;
function packet(w: World, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return { attachments: [], optional: null, detail: null, choice: { type: 'file', value: { id: w.refs[1] } },
    related: null, label: 'packet', ...patch };
}
function packetInput(w: World, payload = packet(w), packets = [packet(w)]): Record<string, unknown> {
  return { ...w.input(w.refs[1]), payload, packets, nullablePayload: null };
}
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
    'wrong-field', 'changed-ref', 'leaf', 'false-whole-grant', 'secret', 'revoked', 'subject', 'parent-hidden', 'read-missing'] as const) {
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
    if (mode === 'false-whole-grant') consumer = createFileReferenceConsumer({ ...w.options,
      policy: buildPolicyTable([{ model: MODEL, secretFields: [], grants: [
        { by: 'members', fields: ['file'], when: { op: 'eq', field: 'label', value: 'blocked' } },
        { by: 'members', fields: ['file.id', 'label'] },
      ] }], w.loaded.models) });
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

test('complete File inventory requires exact owning declarations and refuses bound schema drift or missing loaded valueTypes', async t => {
  for (const mode of ['field-disagreement', 'observation-schema', 'read-schema', 'missing-valueTypes'] as const) {
    const w = await world(t), row = await w.create();
    const canonicalModels = structuredClone(w.loaded.models), artifactModels = structuredClone(w.slice.models!);
    if (mode === 'field-disagreement') {
      artifactModels.find(model => model.name === MODEL)!.fields.find(field => field.name === 'file')!.field = { kind: 'string' };
      await assert.rejects(async () => createFileReferenceConsumer({ ...w.options, canonicalModels, artifactModels })
        .observeReferences(w.refs[1]), stateError);
    } else if (mode === 'missing-valueTypes') {
      const nominal = await world(t, nominalArtifact());
      await nominal.create(MODEL, packetInput(nominal, packet(nominal, {
        attachments: [{ id: nominal.refs[0] }],
      })));
      assert.ok(nominal.loaded.valueTypes);
      const { valueTypes: omitted, ...options } = nominal.options; assert.ok(omitted);
      for (const ref of [nominal.refs[0], 'absent-embedded-reference']) {
        await assert.rejects(async () => createFileReferenceConsumer(options).observeReferences(ref), stateError);
      }
      assert.equal(nominal.consumptions(), 0);
    } else {
      const consumer = createFileReferenceConsumer({ ...w.options, canonicalModels, artifactModels });
      const revision = await w.store.readRevision();
      const changeBoundSchema = () => {
        Object.assign(canonicalModels.find(model => model.name === MODEL)!.fields['files']!, { max: 3 });
        Object.assign(artifactModels.find(model => model.name === MODEL)!.fields.find(field => field.name === 'files')!, { max: 3 });
      };
      if (mode === 'observation-schema') {
        const observation = await consumer.observeReferences(w.refs[0]);
        assert.equal(observation.complete, true); changeBoundSchema();
        await assert.rejects(observation.revalidate(), stateError);
        await assert.rejects(consumer.observeReferences(w.refs[1]), stateError);
      } else {
        let enter!: () => void, release!: () => void;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const pending = consumer.read(locator(w, row), w.caller, async slot => {
          const physical = await w.consume(slot); assert.deepEqual(physical, bytes); enter(); await blocked; return physical;
        });
        await entered; changeBoundSchema(); release(); await withheld(() => pending);
      }
      assert.equal(await w.store.readRevision(), revision);
    }
    assert.equal(w.consumptions(), mode === 'read-schema' ? 1 : 0, mode);
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
  for (const mode of ['replacement', 'removal', 'owner', 'revoked', 'full-facts', 'subject-swap',
    'read-removal', 'policy-removal', 'policy-replacement', 'parent-removal', 'parent-owner'] as const) {
    const w = await world(t), parent = await w.create();
    const row = mode.startsWith('parent-') ? await w.create(CHILD, w.input(), parent) : parent;
    const model = row === parent ? MODEL : CHILD;
    const registry = new Map(w.registry), policy = new Map(w.policy);
    const consumer = mode === 'read-removal' || mode.startsWith('policy-')
      ? createFileReferenceConsumer({ ...w.options, registry, policy }) : w.consumer;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const pending = consumer.read(locator(w, row, 'file', w.refs[0], model), w.caller, async slot => {
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
    if (mode === 'read-removal') registry.delete(`${MODEL}.read`);
    if (mode === 'policy-removal') policy.delete(MODEL);
    if (mode === 'policy-replacement') policy.set(MODEL, policies(w.loaded, {
      fields: ['optionalFile', 'files', 'optionalFiles', 'reviewer', 'label'],
    }).get(MODEL)!);
    if (mode === 'parent-removal') await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [
      { kind: 'remove', model: MODEL, id: parent.id, expectedVersion: parent.version },
    ] }));
    if (mode === 'parent-owner') await corrupt(w, MODEL, parent, { createdBy: 'another-parent-owner' });
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


test('the current State slot consumes only the genuine currently valid physical byte snapshot', async t => {
  for (const mode of ['valid', 'missing', 'corrupt', 'expiry', 'policy', 'foreign-receiver'] as const) {
    const w = await world(t), row = await w.create(), revision = await w.store.readRevision();
    const original = w.physical.files.get(w.refs[0]); assert.ok(original);
    if (mode === 'missing') w.physical.blobs.remove(blobKeyForFile(w.refs[0]));
    if (mode === 'corrupt') w.physical.blobs.write(blobKeyForFile(w.refs[0]), new Uint8Array(bytes.length).fill(1));
    if (mode === 'expiry') w.clock.advance(RETENTION.unattachedHorizonMs);
    const result = await w.consumer.read(locator(w, row), w.caller, mode === 'policy' || mode === 'foreign-receiver'
      ? slot => w.physical.transaction(() => readCurrentFinalizedBytes({ clock: w.clock,
        files: w.physical.files, blobs: w.physical.blobs }, slot.ref,
        mode === 'foreign-receiver' ? { ...w.caller, principal: 'another-physical-receiver' } : w.caller,
        { policy: mode === 'policy' ? { ...DEFAULT_FILE_POLICY, maxBytes: 1 } : DEFAULT_FILE_POLICY, retention: RETENTION }))
      : w.consume);
    if (mode === 'valid') assert.deepEqual(result, bytes); else assert.equal(result, null, mode);
    assert.equal(await w.store.readRevision(), revision);
    assert.deepEqual(await w.store.load(MODEL, row.id), row);
    assert.deepEqual(w.physical.files.get(w.refs[0]), original);
  }
});

test('same-load contract census follows duplicate, nullable and selected union paths across genuine CRUD winners, rejected replay and archived retention', async t => {
  const w = await world(t, nominalArtifact()), target = await w.create(OTHER, packetInput(w));
  const payload = packet(w, { attachments: [{ id: w.refs[0] }, { id: w.refs[0] }],
    detail: { attachment: { id: w.refs[0] }, note: 'nested' },
    choice: { type: DETAIL, value: { attachment: { id: w.refs[0] }, note: 'selected' } },
    related: { id: target.id, version: String(target.version) } });
  const first = await w.create(MODEL, packetInput(w, payload, [packet(w, {
    attachments: [{ id: w.refs[0] }], optional: { id: w.refs[0] },
    choice: { type: 'file', value: { id: w.refs[0] } },
  })]));
  const shared = packet(w, { attachments: [{ id: w.refs[0] }] });
  const second = await w.create(MODEL, packetInput(w, shared));
  const child = await w.create(CHILD, packetInput(w, shared), first); await w.remove(CHILD, child.id);
  const archived = await w.store.load(CHILD, child.id); assert.ok(archived); assert.notEqual(archived.archivedAt, null);
  const before = await w.consumer.observeReferences(w.refs[0]);
  assert.equal(before.complete, true); assert.deepEqual(before.scope, w.scope);
  const slots = before.references.map(slot => [slot.recordId, slot.field, slot.index, slot.path, slot.archived]);
  const expected = [
    [first.id, 'payload', null, ['attachments', 0], false],
    [first.id, 'payload', null, ['attachments', 1], false],
    [first.id, 'payload', null, ['detail', 'attachment'], false],
    [first.id, 'payload', null, ['choice', 'value', 'attachment'], false],
    [first.id, 'packets', 0, [0, 'attachments', 0], false],
    [first.id, 'packets', 0, [0, 'optional'], false],
    [first.id, 'packets', 0, [0, 'choice', 'value'], false],
    [second.id, 'payload', null, ['attachments', 0], false],
    [child.id, 'payload', null, ['attachments', 0], true],
  ];
  const order = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));
  assert.deepEqual(slots.sort(order), expected.sort(order));
  assert.ok(before.references.every(slot => Object.isFrozen(slot.path)));
  assert.equal(before.references.find(slot => slot.recordId === child.id)!.rowVersion, archived.version);
  const direct = (await w.consumer.observeReferences(w.refs[1])).references.filter(slot => slot.field === 'file');
  assert.ok(direct.length > 0); assert.ok(direct.every(slot => slot.index === null && slot.path.length === 0));
  await before.revalidate();
  const envelope = makeEnvelope(`${MODEL}.update`, uuidv7(FIXED_NOW, ++sequence), {
    record: { id: first.id, version: String(first.version) }, payload: packet(w), packets: [packet(w)],
  });
  let executions = 0;
  const rejected = { ...w, envelope, execute: async (call: Parameters<typeof w.execute>[0]): Promise<ExecutionEffects> => {
    executions++; await w.execute(call); throw new StateError('rule_failed', 'Original staged nested replacement refused');
  } };
  await assert.rejects(invoke(rejected), stateError);
  assert.deepEqual(await w.store.load(MODEL, first.id), first);
  assert.deepEqual((await w.consumer.observeReferences(w.refs[0])).references, before.references);
  await assert.rejects(invoke(rejected), stateError); assert.equal(executions, 1);
  await assert.rejects(before.revalidate(), stateError);
  const changed = await w.update(MODEL, first.id, { payload: packet(w), packets: [packet(w)] });
  assert.equal(changed.version, first.version + 1);
  assert.ok((await w.consumer.observeReferences(w.refs[0])).references.every(slot => slot.recordId !== first.id));
  await w.remove(MODEL, second.id);
  assert.deepEqual((await w.consumer.observeReferences(w.refs[0])).references.map(slot => slot.recordId), [child.id]);
  await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'remove', model: CHILD,
    id: child.id, expectedVersion: archived.version }] }));
  const absent = await w.consumer.observeReferences(w.refs[0]);
  assert.equal(absent.complete, true); assert.deepEqual(absent.references, []); await absent.revalidate();
  assert.deepEqual(await w.store.load(OTHER, target.id), target);
  assert.equal(w.consumptions(), 0);
});

test('embedded Files require the whole nominal field and current loaded schema while model reference targets remain denied and unloaded', async t => {
  for (const mode of ['whole', 'leaf', 'secret', 'revoked', 'await-revocation', 'observation-schema', 'read-schema'] as const) {
    const w = await world(t, nominalArtifact()), target = await w.create(OTHER, packetInput(w));
    const row = await w.create(MODEL, packetInput(w, packet(w, { attachments: [{ id: w.refs[0] }],
      related: { id: target.id, version: String(target.version) } })));
    let targetLoads = 0;
    const store: StoragePort = { ...w.store, load: async (model, id) => {
      if (model === OTHER) targetLoads++; return w.store.load(model, id);
    } };
    const valueTypes = structuredClone(w.loaded.valueTypes!);
    const fields = mode === 'leaf' ? NOMINAL_GRANTS.filter(field => field !== 'payload').concat('payload.attachments.id')
      : mode === 'secret' ? NOMINAL_GRANTS.filter(field => field !== 'payload') : NOMINAL_GRANTS;
    const consumer = createFileReferenceConsumer({ ...w.options, store, valueTypes,
      policy: policies(w.loaded, { fields, secret: mode === 'secret' ? ['payload'] : [], privateOther: true }) });
    if (mode === 'revoked') await w.memberships.removeMembership(w.subject.membership_id);
    const drift = () => Object.assign(valueTypes.contracts.find(contract => contract.name === DETAIL)!
      .fields.find(field => field.name === 'note')!, { max: 19 });
    if (mode === 'whole') {
      assert.deepEqual(await consumer.read(locator(w, row, 'payload'), w.caller, w.consume), bytes);
      assert.equal(targetLoads, 0);
      await withheld(() => consumer.read(locator(w, target, 'file', w.refs[1], OTHER), w.caller, w.consume));
    } else if (mode === 'observation-schema') {
      const observed = await consumer.observeReferences(w.refs[0]); assert.equal(observed.complete, true);
      const revision = await w.store.readRevision(); drift();
      await assert.rejects(observed.revalidate(), stateError);
      await assert.rejects(consumer.observeReferences('absent-embedded-reference'), stateError);
      assert.equal(await w.store.readRevision(), revision);
      await withheld(() => consumer.read(locator(w, row, 'payload'), w.caller, w.consume));
    } else if (mode === 'read-schema' || mode === 'await-revocation') {
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const pending = consumer.read(locator(w, row, 'payload'), w.caller, async slot => {
        const result = await w.consume(slot); assert.deepEqual(result, bytes); enter(); await blocked; return result;
      });
      await entered;
      if (mode === 'read-schema') drift(); else await w.memberships.removeMembership(w.subject.membership_id);
      release(); await withheld(() => pending);
    } else await withheld(() => consumer.read(locator(w, row, 'payload'), w.caller, w.consume));
    assert.equal(targetLoads, mode === 'whole' ? 1 : 0, mode);
    assert.equal(w.consumptions(), ['whole', 'read-schema', 'await-revocation'].includes(mode) ? 1 : 0, mode);
  }
});

test('malformed, unknown or overbound committed contract wires refuse complete absence and embedded consumption', async t => {
  for (const mode of ['file-wire', 'file-extra', 'contract-extra', 'missing-choice', 'attachments-bound',
    'required-packets-empty', 'packets-bound', 'nullable-wire', 'union-arm', 'union-extra', 'model-wire'] as const) {
    const w = await world(t, nominalArtifact()), row = await w.create(MODEL, packetInput(w, packet(w, {
      attachments: [{ id: w.refs[0] }],
    })));
    const data = structuredClone(row.data) as Record<string, unknown>, payload = data['payload'] as Record<string, unknown>;
    if (mode === 'file-wire') payload['attachments'] = [{ id: 7 }];
    if (mode === 'file-extra') payload['attachments'] = [{ id: w.refs[0], receiver: w.caller }];
    if (mode === 'contract-extra') payload['unknown'] = { id: w.refs[0] };
    if (mode === 'missing-choice') delete payload['choice'];
    if (mode === 'attachments-bound') payload['attachments'] = Array.from({ length: 4 }, () => ({ id: w.refs[0] }));
    if (mode === 'required-packets-empty') data['packets'] = [];
    if (mode === 'packets-bound') data['packets'] = [packet(w), packet(w), packet(w)];
    if (mode === 'nullable-wire') data['nullablePayload'] = 'not-a-contract';
    if (mode === 'union-arm') payload['choice'] = { type: OTHER, value: { id: 'wrong-union-model' } };
    if (mode === 'union-extra') payload['choice'] = { type: 'file', value: { id: w.refs[0] }, copiedAuthority: true };
    if (mode === 'model-wire') payload['related'] = { id: 'unloaded-model-reference', version: '01' };
    await corrupt(w, MODEL, row, { data });
    const consumer = createFileReferenceConsumer({ ...w.options, policy: policies(w.loaded, { fields: NOMINAL_GRANTS }) });
    for (const ref of [w.refs[0], 'absent-embedded-reference']) {
      await assert.rejects(consumer.observeReferences(ref), stateError, mode);
    }
    const field = mode === 'required-packets-empty' || mode === 'packets-bound' ? 'packets'
      : mode === 'nullable-wire' ? 'nullablePayload' : 'payload';
    await withheld(() => consumer.read(locator(w, row, field, 'absent-embedded-reference'), w.caller, w.consume));
    assert.equal(w.consumptions(), 0, mode);
  }
});

test('a different active current State reader is authorized independently of the genuine finalized physical receiver', async t => {
  const w = await world(t), row = await w.create();
  const second = await w.memberships.createMembership({ team_id: w.caller.team, user_id: 'second-current-reader',
    is_owner: false, roles: [] });
  const caller = { ...w.caller, principal: second.user_id };
  assert.deepEqual(await w.consumer.read(locator(w, row), caller, w.consume), bytes);
  assert.equal(w.consumptions(), 1);
  let currentReceiverAttempts = 0;
  assert.equal(await w.consumer.read(locator(w, row), caller, slot => {
    currentReceiverAttempts++;
    return w.physical.transaction(() => readCurrentFinalizedBytes({ clock: w.clock,
      files: w.physical.files, blobs: w.physical.blobs }, slot.ref, caller,
      { policy: DEFAULT_FILE_POLICY, retention: RETENTION }));
  }), null);
  assert.equal(currentReceiverAttempts, 1);
  await w.memberships.removeMembership(second.membership_id);
  await withheld(() => w.consumer.read(locator(w, row), caller, w.consume));
  assert.equal(w.consumptions(), 1);
  assert.deepEqual(await w.store.load(MODEL, row.id), row);
});

test('required direct File arrays and finite recursive owning contracts retain exact current occurrence paths and refuse incomplete census', async t => {
  {
    const slice = artifact();
    for (const model of slice.models!) Object.assign(model.fields.find(field => field.name === 'files')!, {
      valueType: 'file[]!' as CanTypeId, array: { required: true }, required: true, min: 1, max: 4,
    });
    for (const operation of slice.operations!) {
      if (operation.kind !== 'create' && operation.kind !== 'update') continue;
      Object.assign(operation.inputs.fields.find(field => field.name === 'files')!, {
        valueType: 'file[]!' as CanTypeId, array: { required: true }, required: operation.kind === 'create', min: 1, max: 4,
      });
    }
    const w = await world(t, slice);
    const row = await w.create(MODEL, { ...w.input(w.refs[1]), files: [{ id: w.refs[0] }, { id: w.refs[0] }] });
    const observed = await w.consumer.observeReferences(w.refs[0]); assert.equal(observed.complete, true);
    assert.deepEqual(observed.references.map(slot => [slot.recordId, slot.field, slot.index, slot.path]), [
      [row.id, 'files', 0, [0]], [row.id, 'files', 1, [1]],
    ]);
    assert.deepEqual(await w.consumer.read(locator(w, row, 'files'), w.caller, w.consume), bytes);
    await assert.rejects(invoke({ ...w, execute: w.execute,
      envelope: makeEnvelope(`${MODEL}.update`, uuidv7(FIXED_NOW, ++sequence), {
        record: { id: row.id, version: String(row.version) }, files: [],
      }) }));
    assert.deepEqual(await w.store.load(MODEL, row.id), row);
    const replacement = await w.update(MODEL, row.id, { files: [{ id: w.refs[1] }] });
    const absent = await w.consumer.observeReferences(w.refs[0]); assert.equal(absent.complete, true);
    assert.deepEqual(absent.references, []); await absent.revalidate();
    await corrupt(w, MODEL, replacement, { data: { ...replacement.data, files: [] } });
    await assert.rejects(w.consumer.observeReferences('absent-required-array-reference'), stateError);
    await withheld(() => w.consumer.read(locator(w, replacement, 'files', 'absent-required-array-reference'), w.caller, w.consume));
    assert.equal(w.consumptions(), 1);
  }
  {
    const NODE = 'Files.Node', slice = nominalArtifact(), valueTypes = slice.valueTypes!;
    slice.valueTypes = { ...valueTypes, contracts: [...valueTypes.contracts.map(contract => contract.name === PACKET
      ? { ...contract, fields: [...contract.fields, { name: 'node', type: `${NODE}?` }] } : contract),
      { name: NODE, fields: [{ name: 'attachment', type: 'file?' }, { name: 'next', type: `${NODE}?` }] },
    ] };
    const w = await world(t, slice);
    const emptyPacket = packet(w, { node: null });
    const target = await w.create(OTHER, { ...packetInput(w, emptyPacket, [emptyPacket]), file: { id: w.refs[0] } });
    const payload = packet(w, { node: { attachment: { id: w.refs[0] }, next: {
      attachment: null, next: { attachment: { id: w.refs[0] }, next: null },
    } }, related: { id: target.id, version: String(target.version) } });
    const row = await w.create(MODEL, packetInput(w, payload, [emptyPacket]));
    const observed = await w.consumer.observeReferences(w.refs[0]); assert.equal(observed.complete, true);
    assert.deepEqual(observed.references.filter(slot => slot.recordId === row.id)
      .map(slot => [slot.field, slot.index, slot.path]), [
      ['payload', null, ['node', 'attachment']], ['payload', null, ['node', 'next', 'next', 'attachment']],
    ]);
    assert.deepEqual(observed.references.filter(slot => slot.recordId === target.id)
      .map(slot => [slot.field, slot.path]), [['file', []]]);
    let targetLoads = 0;
    const store: StoragePort = { ...w.store, load: async (model, id) => {
      if (model === OTHER) targetLoads++; return w.store.load(model, id);
    } };
    const consumer = createFileReferenceConsumer({ ...w.options, store,
      policy: policies(w.loaded, { fields: NOMINAL_GRANTS, privateOther: true }) });
    assert.deepEqual(await consumer.read(locator(w, row, 'payload'), w.caller, w.consume), bytes);
    assert.equal(targetLoads, 0);
    const bounded = createFileReferenceConsumer({ ...w.options, maxReferences: 2 });
    await assert.rejects(bounded.observeReferences('absent-recursive-reference'), stateError);
    const data = structuredClone(row.data) as Record<string, unknown>;
    const currentPayload = data['payload'] as Record<string, unknown>, node = currentPayload['node'] as Record<string, unknown>;
    const middle = node['next'] as Record<string, unknown>, tail = middle['next'] as Record<string, unknown>;
    tail['attachment'] = { id: w.refs[0], copiedAuthority: true };
    await corrupt(w, MODEL, row, { data });
    await assert.rejects(w.consumer.observeReferences('absent-recursive-reference'), stateError);
    await withheld(() => consumer.read(locator(w, row, 'payload', 'absent-recursive-reference'), w.caller, w.consume));
    assert.equal(targetLoads, 0); assert.equal(w.consumptions(), 1);
  }
});

test('a declared derived File materialized by the actual mutation hook winner remains in the complete current census', async t => {
  const slice = artifact(), model = slice.models!.find(model => model.name === MODEL)!;
  model.fields = [...model.fields, { name: 'derivedFile', field: { kind: 'file' }, valueType: 'file' as CanTypeId,
    required: false, serverOnly: true, default: { kind: 'derived' } }];
  const w = await world(t, slice), ordinary = await w.create(MODEL, w.input(w.refs[1]));
  assert.equal(Object.hasOwn(ordinary.data, 'derivedFile'), false);
  const empty = await w.consumer.observeReferences(w.refs[0]);
  assert.equal(empty.complete, true); assert.deepEqual(empty.references, []); await empty.revalidate();
  let hooks = 0;
  const table = buildModelTable([...w.table.values()].map(definition => definition.model === MODEL ? {
    ...definition, hooks: [...definition.hooks, { name: 'materialize-derived-file', ops: ['create'] as const,
      run: (candidate: Record<string, unknown>) => { hooks++; return { ...candidate, derivedFile: { id: w.refs[0] } }; },
    }],
  } : definition));
  const execute = generatedCrudExecute({ table, store: w.store });
  const injected = makeEnvelope(`${MODEL}.create`, uuidv7(FIXED_NOW, ++sequence), {
    ...w.input(w.refs[1]), derivedFile: { id: w.refs[0] },
  });
  await assert.rejects(invoke({ ...w, execute, envelope: injected })); assert.equal(hooks, 0);
  const result = await invoke({ ...w, execute, envelope: makeEnvelope(`${MODEL}.create`, uuidv7(FIXED_NOW, ++sequence),
    w.input(w.refs[1])) });
  assert.equal(result.status, 'committed'); assert.equal(hooks, 1);
  const row = result.result as StoredRow; assert.deepEqual(await w.store.load(MODEL, row.id), row);
  assert.deepEqual(row.data['derivedFile'], { id: w.refs[0] });
  const observed = await w.consumer.observeReferences(w.refs[0]); assert.equal(observed.complete, true);
  assert.deepEqual(observed.references.map(slot => [slot.model, slot.recordId, slot.rowVersion, slot.field, slot.index, slot.path]),
    [[MODEL, row.id, row.version, 'derivedFile', null, []]]);
  await observed.revalidate();
  const consumer = createFileReferenceConsumer({ ...w.options,
    policy: policies(w.loaded, { fields: ['file', 'optionalFile', 'files', 'optionalFiles', 'reviewer', 'label', 'derivedFile'] }) });
  assert.deepEqual(await consumer.read(locator(w, row, 'derivedFile'), w.caller, w.consume), bytes);
  assert.equal(w.consumptions(), 1);
});
