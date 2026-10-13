/** Defining State/File join over public Files SQLite storage and a checked,
 * hand-built void descriptor. This does not qualify Compiler or native-host
 * File/Set evaluation, source execution/replay, or Dev repair. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ArtifactModelField, CanTypeId, FilePolicy, FinalizedFileObservation, FinalizedFileReceiver,
  ModelName, Receipt, RetainedFinalizedFile, StoredRow } from '@canlang/contracts';
import { DEFAULT_FILE_POLICY, blobKeyForFile, ingestVerifiedEventBytes, observeFinalizedFile,
  readFinalizedFileObservation, recordAttachment, revalidateRetainedFinalizedFile } from '@canlang/files';
import { createSqliteFileStore } from '@canlang/files/host/sqlite';
import { createFrozenClock, createMemoryIdentityStore as createSnapshotIdentityStore } from '@canlang/identity/testing';
import type { AdmittedCall } from './admission.js';
import { receiptIdentityFor } from './admission.js';
import { StateError } from '../errors.js';
import { createMemoryStorage } from '../storage/memory.js';
import { buildModelTableFromCanonical } from '../mutation/models.js';
import { buildPolicyTable } from '../policy/grants.js';
import type { ViewerSourceReadPolicy } from '../query/source-policy.js';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice, type GeneratedOperationDef } from './registry.js';
import { invoke, invokeRetainedReceiptOnly, type ExecutionEffects } from './invoke.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptFileProducer, observeScenarioReceiptFileAssignment,
  bindScenarioReceiptReferenceProducer, projectScenarioReceipt, readScenarioReceiptAssociation, selectScenarioReceiptReturn } from './scenario-receipt.js';
import { FIXED_NOW, asId, asModel, asVersion, createMemoryIdentityStore, makeBatch, makeIdentity, makeEnvelope,
  makeRow, seedMember, seedRow, uuidv7 } from '../../test/invocation/fixtures.js';

const MODEL = asModel('Files.Record'), OTHER = asModel('Files.Other'), OP = 'Files.assign', APP = 'state-files-app';
const PARENT = asModel('Files.Parent');
const bounds = { maxWork: 1000, maxRows: 10 }, cause = { cause: 'scenario' } as const;
const retention = { unattachedHorizonMs: 60_000, retentionMs: 120_000 };
const bytes = new TextEncoder().encode('actual finalized bytes\n');
const origin = () => ({ path: 'files.can', sha256: 'c'.repeat(64), module: 'files.mjs' });
const stateError = (error: unknown) => error instanceof StateError;
const fieldsForNominal = ['file', 'optionalFile', 'files', 'optionalFiles', 'visible', 'secret', 'prefix', 'optionalPrefix', 'request_value'];
let sequence = 40_000;
type FileField = 'file' | 'optionalFile' | 'files' | 'optionalFiles' | 'prefix' | 'optionalPrefix' | 'request_value';
function artifact(deleteMode: 'archive' | 'remove' = 'archive', nominal = false, contentMax = 100): ArtifactDescriptorSlice {
  const fields: ArtifactModelField[] = [
    { name: 'file', field: { kind: 'file' as const }, valueType: 'file' as CanTypeId, required: false, serverOnly: false },
    { name: 'optionalFile', field: { kind: 'file' as const }, valueType: 'file?' as CanTypeId, nullable: true, required: false, serverOnly: false },
    { name: 'files', field: { kind: 'file' as const }, valueType: 'file[]' as CanTypeId, array: { required: false }, max: 4, required: false, serverOnly: false },
    { name: 'optionalFiles', field: { kind: 'file' as const }, valueType: 'file[]?' as CanTypeId, nullable: true, array: { required: false }, max: 4, required: false, serverOnly: false },
    { name: 'visible', field: { kind: 'string' as const }, valueType: 'text' as CanTypeId, required: false, serverOnly: false },
    { name: 'secret', field: { kind: 'secret' as const }, required: false, serverOnly: true },
  ];
  if (nominal) fields.push(
    {name: 'prefix', field: {kind: 'nominal', name: 'std.TextMessage'}, valueType: 'std.TextMessage[]' as CanTypeId, array: {required: false}, max: 4, required: false, serverOnly: false},
    {name: 'optionalPrefix', field: {kind: 'nominal', name: 'std.TextMessage'}, valueType: 'std.TextMessage[]?' as CanTypeId, array: {required: false}, nullable: true, max: 4, required: false, serverOnly: false},
    {name: 'request_value', field: {kind: 'nominal', name: 'std.TextRequest'}, valueType: 'std.TextRequest' as CanTypeId, required: false, serverOnly: false});
  return { artifact_version: 1, sources: [{ path: 'files.can', sha256: 'c'.repeat(64) }],
    modules: [{ path: 'files.mjs', js: 'export const identity="Files.assign";',
      map: { version: 3, file: 'files.mjs', sources: ['files.can'], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: 'files.mjs', export: 'identity', member: ['assign'] }],
    ...(nominal ? {valueTypes: {contracts: [
      {name: 'std.TextMessage', fields: [{name: 'role', type: 'enum(system,user,assistant)' as CanTypeId},
        {name: 'content', type: 'text' as CanTypeId, max: contentMax}, {name: 'attachments', type: 'file[]' as CanTypeId, max: 8}]},
      {name: 'std.TextRequest', fields: [{name: 'source', type: 'text' as CanTypeId}, {name: 'revision', type: 'int' as CanTypeId, min: '1'},
        {name: 'profile', type: 'text' as CanTypeId}, {name: 'policy_revision', type: 'text' as CanTypeId},
        {name: 'messages', type: 'std.TextMessage[]' as CanTypeId, max: 120}, {name: 'max_input_tokens', type: 'int' as CanTypeId, min: '1'},
        {name: 'max_output_tokens', type: 'int' as CanTypeId, min: '1'}, {name: 'max_duration', type: 'duration' as CanTypeId}]},
    ]}} : {}),
    models: [{ name: MODEL, deleteMode, fields, ...(nominal ? {parent: PARENT} : {}) }, { name: OTHER, deleteMode: 'archive', fields },
      ...(nominal ? [{name: PARENT, deleteMode: 'archive' as const, fields: [{name: 'title', field: {kind: 'string' as const}, required: true, serverOnly: false}]}] : [])],
    operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [
      { name: 'record', field: { kind: 'ref', model: MODEL, requireVersion: true }, required: true },
    ] }, result: { type: 'void' as CanTypeId, disclosure: { version: 1, source: origin(), returns: [
      { id: 'assigned', source: origin(), influences: [], dependencies: [] },
    ] } } }],
  };
}
const empty = (): ExecutionEffects => ({ result: null, writes: [], history: [], outbox: [], schedules: [],
  uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {} });

async function world(bind = true, producerApp = APP, deleteMode: 'archive' | 'remove' = 'archive', nominal = false, contentMax = 100) {
  const store = createMemoryStorage(), fixtureMemberships = createMemoryIdentityStore();
  const sdk = nominal ? createSnapshotIdentityStore({clock: createFrozenClock(FIXED_NOW)}) : undefined;
  const memberships = sdk ?? fixtureMemberships;
  const member = sdk === undefined ? await seedMember(fixtureMemberships, { isOwner: false, roles: [] }) : await (async () => {
    const team = await sdk.createTeam({timezone: 'UTC'});
    const user = await sdk.createUser({email: 'assignment-reader@example.test', password_hash: 'unused', email_verified: true});
    const membership = await sdk.createMembership({team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: []});
    return {team, user, membership};
  })();
  const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
  const receiver: FinalizedFileReceiver = { app: APP, team: member.team.team_id,
    owner: member.team.team_id, principal: member.user.user_id };
  const loaded = loadArtifactDescriptors(artifact(deleteMode, nominal, contentMax), { by: 'members' });
  const def = loaded.registry.get(OP) as GeneratedOperationDef; assert.ok(def);
  const table = buildModelTableFromCanonical(loaded.models, {
    refs: loaded.refs, serverInits: loaded.serverInits, nullableFields: loaded.nullableFields,
    containment: loaded.containment,
    ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }),
  });
  const parent = nominal ? await seedRow(store, PARENT, {data: {title: 'Parent'}}) : undefined;
  const row = parent === undefined ? await seedRow(store, MODEL, {data: {visible: 'entry visible', secret: 'never disclose'}})
    : {...makeRow({data: {visible: 'entry visible', secret: 'never disclose'}}), parent: {model: PARENT, id: parent.id}};
  if (parent !== undefined) await store.commit(makeBatch(await store.readRevision(), {writes: [{kind: 'insert', model: MODEL, row}]}));
  const dir = mkdtempSync(join(tmpdir(), 'can-state-file-assignment-'));
  const path = join(dir, 'files.sqlite');
  let physical = createSqliteFileStore(path), now = FIXED_NOW, policy: FilePolicy = DEFAULT_FILE_POLICY;
  const clock = { nowMs: () => now };
  const deps = () => ({ clock, files: physical.files, blobs: physical.blobs });
  const options = () => ({ policy, retention });
  const finalize = (receiving = receiver) => {
    const result = ingestVerifiedEventBytes({ ...deps(), intents: physical.intents,
      fileIds: { nextFileId: () => randomUUID() } }, { provenance: {
      kind: 'event', source: 'deployment.mail', adapter: 'deployment.mail', occurrenceId: randomUUID(),
      fieldPath: 'attachments', itemIndex: 0,
    }, receiver: receiving, claimedType: 'text/plain', bytes, policy: DEFAULT_FILE_POLICY });
    assert.equal(result.status, 'finalized');
    if (result.status !== 'finalized') throw new Error('actual Files finalization failed');
    return result.file.id;
  };
  const refs = [finalize(), finalize()] as const;
  let revalidations = 0;
  let beforeRevalidate: ((saved: RetainedFinalizedFile, receiving: FinalizedFileReceiver) => void | Promise<void>) | undefined;
  const revalidate = async (saved: RetainedFinalizedFile, receiving: FinalizedFileReceiver) => {
    revalidations++;
    await beforeRevalidate?.(saved, receiving);
    return revalidateRetainedFinalizedFile(deps(), saved, receiving, options());
  };
  if (bind) bindScenarioReceiptFileProducer(def, { source: origin(), app: producerApp, revalidate });
  const policyTable = buildPolicyTable([{ model: MODEL, secretFields: ['secret'], grants: [
    { by: 'members', fields: ['file', 'optionalFile', 'files', 'optionalFiles', 'visible', ...(nominal ? ['prefix', 'optionalPrefix', 'request_value'] : [])] },
  ] }]);
  const access = {field: true, ancestor: true};
  const related = sdk === undefined ? undefined : await (async () => {
    const user = await sdk.createUser({email: 'assignment-related@example.test', password_hash: 'unused', email_verified: true});
    const membership = await sdk.createMembership({team_id: member.team.team_id, user_id: user.user_id, is_owner: false, roles: []});
    return {team: member.team, user, membership};
  })();
  let readPolicies: Map<ModelName, ViewerSourceReadPolicy> | undefined;
  if (nominal) {
    readPolicies = new Map<ModelName, ViewerSourceReadPolicy>([
      [MODEL, {parent: PARENT, fields: fieldsForNominal, secretFields: ['secret'], grants: [
        {fields: ['prefix', 'optionalPrefix', 'request_value'], read: async ({context}) => access.field &&
          context.membership?.status === 'active' && (await context.memberships.findMembership(member.team.team_id, related!.user.user_id))?.status === 'active'},
        {fields: ['visible'], read: async ({context}) => context.membership?.status === 'active' &&
          (await context.memberships.findMembership(member.team.team_id, related!.user.user_id))?.status === 'active'},
      ]}], [PARENT, {fields: ['title'], secretFields: [], grants: [{fields: ['title'], read: async ({context}) => access.ancestor && context.membership?.status === 'active'}]}],
    ]);
    bindScenarioReceiptReferenceProducer(def, {source: origin(), app: APP, policy: policyTable, readPolicies});
  }
  return { store, memberships, identity, member, receiver, registry: loaded.registry, def, table, row,
    envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), { record: { id: row.id, version: String(row.version) } }),
    app: APP, source: 'test', clock, policy: policyTable, refs, deps, options, finalize, revalidate, access, related, loaded, readPolicies,
    observe: (ref: string, receiving = receiver) => {
      const observation = observeFinalizedFile(deps(), ref, receiving, options()); assert.ok(observation); return observation;
    },
    physical: () => physical,
    setNow: (value: number) => { now = value; },
    setPolicy: (value: FilePolicy) => { policy = value; },
    setBeforeRevalidate: (value: typeof beforeRevalidate) => { beforeRevalidate = value; },
    revalidations: () => revalidations,
    reopen: () => { physical.close(); physical = createSqliteFileStore(path); },
    close: () => { physical.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
type World = Awaited<ReturnType<typeof world>>;
function locator(w: World, selected: FileField = 'file') { return { model: MODEL, recordId: w.row.id, field: selected }; }
function capture(call: AdmittedCall, w: World, selected: FileField, ref: string) {
  observeScenarioReceiptFileAssignment(call, w.store, { ...locator(w, selected), observation: w.observe(ref) });
}
async function stage(call: AdmittedCall, w: World, selected: FileField = 'file', wire: unknown = { id: w.refs[0] }) {
  const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
  await session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { [selected]: wire, visible: 'assigned visible' } }, cause);
  return session;
}
async function originalCommit(w: World, selected: FileField = 'file', wire: unknown = { id: w.refs[0] }, refs: readonly string[] = [w.refs[0]]) {
  let receipt: Receipt | undefined, admitted: AdmittedCall | undefined;
  const result = await invoke({ ...w, execute: async call => {
    admitted = call;
    const session = await stage(call, w, selected, wire);
    for (const ref of new Set(refs)) capture(call, w, selected, ref);
    selectScenarioReceiptReturn(call, w.store, 'assigned');
    return { ...await session.finalize(), result: null, outbox: [], fileAssignments: [locator(w, selected)] };
  }, observeCommittedReceipt: value => { receipt = value; } });
  assert.equal(result.status, 'committed'); assert.ok(receipt); assert.ok(admitted);
  return { receipt, admitted };
}
async function domain(w: World) { return { row: await w.store.load(MODEL, w.row.id),
  history: await w.store.historyFor(MODEL, w.row.id), outbox: await w.store.outboxPending() }; }
async function updateCurrent(w: World, change: Partial<StoredRow>, data?: Record<string, unknown>) {
  const current = await w.store.load(MODEL, w.row.id); assert.ok(current);
  await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'update', model: MODEL,
    id: current.id, expectedVersion: current.version, row: { ...current, version: asVersion(current.version + 1), ...change,
      ...(data === undefined ? {} : { data }) } }] }));
}
async function savedProjection(w: World, receipt: Receipt) { return projectScenarioReceipt({ ...w, receipt }); }

// One actual producer/ref capture for duplicate array elements; the complete
// final wire retains order and multiplicity, with State alone issuing version.
test('real owner File assignments retain scalar, nullable and ordered duplicate arrays through persisted receipt recovery', async () => {
  for (const selected of ['file', 'optionalFile', 'files'] as const) {
    const w = await world();
    try {
      const wire = selected === 'files' ? [{ id: w.refs[1] }, { id: w.refs[0] }, { id: w.refs[1] }] : { id: w.refs[0] };
      const refs = selected === 'files' ? [w.refs[1], w.refs[0]] : [w.refs[0]];
      const { receipt, admitted } = await originalCommit(w, selected, wire, refs);
      const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
      assert.equal(association.fileAssignments!.length, refs.length);
      assert.deepEqual(association.fileAssignments!.map(item => item.file.ref), refs);
      const current = await w.store.load(MODEL, w.row.id); assert.ok(current);
      assert.equal(current.version, w.row.version + 1);
      assert.equal(association.changed[0]!.row.version, current.version);
      assert.deepEqual(association.changed[0]!.row.data[selected], wire);
      assert.equal(association.changed[0]!.fieldTypes[selected], selected === 'files' ? 'file[]' : selected === 'optionalFile' ? 'file?' : 'file');
      for (const item of association.fileAssignments!) {
        assert.deepEqual({ model: item.model, recordId: item.recordId, field: item.field }, locator(w, selected));
        assert.equal(item.rowVersion, current.version);
        assert.deepEqual(item.file.receiver, w.receiver);
        assert.ok(item.file.bytesDigest); assert.equal(item.file.sizeBytes, bytes.byteLength);
      }
      const persisted = await w.store.readReceipt(receiptIdentityFor(admitted.context)); assert.deepEqual(persisted, receipt);
      const saved = JSON.parse(JSON.stringify(persisted)) as Receipt;
      assert.deepEqual(readScenarioReceiptAssociation(saved), association);
      w.reopen();
      const projected = await savedProjection(w, saved);
      assert.equal(projected.result, null); assert.equal(projected.records.length, 1);
      assert.deepEqual(projected.records[0]!.data, { visible: 'assigned visible', [selected]: wire });
      assert.equal(projected.records[0]!.version, current.version);
      const before = await domain(w), revision = await w.store.readRevision(); let executed = 0;
      const replay = await invokeRetainedReceiptOnly({ ...w, execute: async () => { executed++; return empty(); } });
      assert.equal(replay.status, 'replayed'); assert.equal(executed, 0);
      assert.deepEqual(await domain(w), before); assert.equal(await w.store.readRevision(), revision);
      assert.ok(w.revalidations() > refs.length);
    } finally { w.close(); }
  }
});

test('null and empty assignments retain exact checked closure without inventing physical facts', async () => {
  for (const selected of ['optionalFile', 'files'] as const) {
    const w = await world();
    try {
      const wire = selected === 'optionalFile' ? null : [];
      const { receipt } = await originalCommit(w, selected, wire, []);
      const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
      assert.deepEqual(association.fileAssignments, []); assert.equal(w.revalidations(), 0);
      assert.equal(association.changed[0]!.fieldTypes[selected], selected === 'optionalFile' ? 'file?' : 'file[]');
      const projected = await savedProjection(w, JSON.parse(JSON.stringify(receipt)) as Receipt);
      assert.deepEqual(projected.records[0]!.data, { visible: 'assigned visible', [selected]: wire });
    } finally { w.close(); }
  }
});

test('genuine owner net insert binds a finalized File to its issued version-one row and retained receipt', async () => {
  const w = await world();
  try {
    const original = await w.store.load(MODEL, w.row.id);
    const id = asId(`inserted-file-${++sequence}`), assignment = { model: MODEL, recordId: id, field: 'file' };
    let receipt: Receipt | undefined, admitted: AdmittedCall | undefined;
    const result = await invoke({ ...w, execute: async call => {
      admitted = call;
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      await session.stage({ op: 'create', model: MODEL, id,
        data: { file: { id: w.refs[0] }, visible: 'inserted visible' } }, cause);
      observeScenarioReceiptFileAssignment(call, w.store, { ...assignment, observation: w.observe(w.refs[0]) });
      selectScenarioReceiptReturn(call, w.store, 'assigned');
      const output = await session.finalize();
      assert.equal(output.writes.length, 1);
      assert.equal(output.writes[0]!.kind, 'insert');
      if (output.writes[0]!.kind !== 'insert') throw new Error('expected actual owner insert');
      assert.equal(output.writes[0]!.row.id, id); assert.equal(output.writes[0]!.row.version, 1);
      return { ...output, result: null, outbox: [], fileAssignments: [assignment] };
    }, observeCommittedReceipt: value => { receipt = value; } });
    assert.equal(result.status, 'committed'); assert.ok(receipt); assert.ok(admitted);
    const inserted = await w.store.load(MODEL, id); assert.ok(inserted); assert.equal(inserted.version, 1);
    const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
    assert.equal(association.changed.length, 1); assert.deepEqual(association.changed[0]!.row, inserted);
    assert.equal(association.changed[0]!.fieldTypes['file'], 'file');
    assert.equal(association.fileAssignments!.length, 1);
    assert.deepEqual(association.fileAssignments![0], { ...assignment, rowVersion: 1,
      file: readFinalizedFileObservation(w.observe(w.refs[0])) });
    const retained = await w.store.readReceipt(receiptIdentityFor(admitted.context)); assert.deepEqual(retained, receipt);
    w.reopen();
    const projected = await savedProjection(w, JSON.parse(JSON.stringify(retained)) as Receipt);
    assert.equal(projected.result, null); assert.equal(projected.records.length, 1);
    assert.equal(projected.records[0]!.id, id); assert.equal(projected.records[0]!.version, 1);
    assert.deepEqual(projected.records[0]!.data, { file: { id: w.refs[0] }, visible: 'inserted visible' });
    assert.deepEqual(await w.store.load(MODEL, w.row.id), original);
  } finally { w.close(); }
});

test('nullable bounded File arrays preserve null, empty and ordered duplicate closure through saved recovery', async () => {
  for (const mode of ['null', 'empty', 'ordered', 'over-bound'] as const) {
    const w = await world();
    try {
      const before = await domain(w);
      const wire = mode === 'null' ? null : mode === 'empty' ? [] : mode === 'over-bound'
        ? Array.from({ length: 5 }, () => ({ id: w.refs[0] }))
        : [{ id: w.refs[1] }, { id: w.refs[0] }, { id: w.refs[1] }];
      if (mode === 'over-bound') {
        await assert.rejects(originalCommit(w, 'optionalFiles', wire), stateError);
        assert.deepEqual(await domain(w), before);
        continue;
      }
      const refs = mode === 'ordered' ? [w.refs[1], w.refs[0]] : [];
      const { receipt, admitted } = await originalCommit(w, 'optionalFiles', wire, refs);
      const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
      assert.equal(association.changed[0]!.fieldTypes['optionalFiles'], 'file[]?');
      assert.deepEqual(association.changed[0]!.row.data['optionalFiles'], wire);
      assert.deepEqual(association.fileAssignments!.map(item => item.file.ref), refs);
      for (const item of association.fileAssignments!) assert.equal(item.rowVersion, w.row.version + 1);
      const retained = await w.store.readReceipt(receiptIdentityFor(admitted.context)); assert.deepEqual(retained, receipt);
      w.reopen();
      const projected = await savedProjection(w, JSON.parse(JSON.stringify(retained)) as Receipt);
      assert.deepEqual(projected.records[0]!.data, { visible: 'assigned visible', optionalFiles: wire });
      const after = await domain(w), revision = await w.store.readRevision(); let executed = 0;
      assert.equal((await invokeRetainedReceiptOnly({ ...w, execute: async () => { executed++; return empty(); } })).status, 'replayed');
      assert.equal(executed, 0); assert.deepEqual(await domain(w), after);
      assert.equal(await w.store.readRevision(), revision);
    } finally { w.close(); }
  }
});

test('only genuine active receiving observations can establish the owner File capture', async () => {
  for (const mode of ['raw', 'copy', 'json', 'foreign', 'call', 'store', 'getter', 'fact', 'duplicate'] as const) {
    const w = await world(); let getters = 0;
    try {
      const before = await domain(w);
      await assert.rejects(invoke({ ...w, execute: async call => {
        const session = await stage(call, w);
        const handle = w.observe(w.refs[0]), facts = readFinalizedFileObservation(handle); assert.ok(facts);
        const foreign = mode === 'foreign' ? { ...w.receiver, principal: 'foreign-principal' } : undefined;
        const observation: unknown = mode === 'raw' ? { id: w.refs[0] } : mode === 'copy' ? { ...handle }
          : mode === 'json' ? JSON.parse(JSON.stringify(handle)) : mode === 'fact' ? facts
          : mode === 'getter' ? Object.defineProperty({}, 'ref', { enumerable: true, get() { getters++; return w.refs[0]; } })
          : foreign === undefined ? handle : w.observe(w.finalize(foreign), foreign);
        if (mode === 'duplicate') capture(call, w, 'file', w.refs[0]);
        assert.throws(() => observeScenarioReceiptFileAssignment(mode === 'call' ? { ...call } : call,
          mode === 'store' ? { ...w.store } : w.store,
          { ...locator(w), observation: observation as FinalizedFileObservation }), stateError);
        return empty();
      } }), stateError);
      assert.equal(getters, 0); assert.deepEqual(await domain(w), before);
    } finally { w.close(); }
  }
  const w = await world();
  try {
    const { admitted } = await originalCommit(w);
    assert.throws(() => observeScenarioReceiptFileAssignment(admitted, w.store,
      { ...locator(w), observation: w.observe(w.refs[0]) }), stateError);
  } finally { w.close(); }
});

test('File locator claims require complete genuine capture and the exact finalized owner field/write', async () => {
  for (const mode of ['missing', 'orphan', 'duplicate-locator', 'orphan-locator', 'wrong-field', 'nonfile', 'foreign-model',
    'ref', 'final-write', 'removal', 'version', 'supplied-fact', 'null-orphan', 'empty-orphan'] as const) {
    const w = await world(true, APP, mode === 'removal' ? 'remove' : 'archive');
    try {
      const before = await domain(w);
      await assert.rejects(invoke({ ...w, execute: async call => {
        const selected = mode === 'null-orphan' ? 'optionalFile' : mode === 'empty-orphan' ? 'files' : 'file';
        const session = await stage(call, w, selected, mode === 'null-orphan' ? null : mode === 'empty-orphan' ? [] : { id: w.refs[0] });
        if (mode !== 'missing') capture(call, w, selected, w.refs[0]);
        if (mode === 'ref') await session.stage({ op: 'update', model: MODEL, id: w.row.id, data: { file: { id: w.refs[1] } } }, cause);
        if (mode === 'removal') await session.stage({ op: 'remove', model: MODEL, id: w.row.id }, cause);
        selectScenarioReceiptReturn(call, w.store, 'assigned');
        const output: ExecutionEffects = { ...await session.finalize(), result: null, outbox: [], fileAssignments: [locator(w, selected)] };
        if (mode === 'orphan') output.fileAssignments = [];
        if (mode === 'duplicate-locator') output.fileAssignments = [locator(w), locator(w)];
        if (mode === 'orphan-locator') output.fileAssignments = [{ ...locator(w), recordId: asId('absent-row') }];
        if (mode === 'wrong-field') output.fileAssignments = [locator(w, 'optionalFile')];
        if (mode === 'nonfile') output.fileAssignments = [{ ...locator(w), field: 'visible' }];
        if (mode === 'foreign-model') output.fileAssignments = [{ ...locator(w), model: OTHER }];
        if (mode === 'supplied-fact') output.fileAssignments = [{ ...locator(w), file: readFinalizedFileObservation(w.observe(w.refs[0])) }];
        if (mode === 'final-write') output.writes = [];
        if (mode === 'version') output.writes = output.writes.map(write => write.kind === 'remove' ? write :
          { ...write, row: { ...write.row, version: asVersion(write.row.version + 1) } });
        return output;
      } }), stateError, mode);
      assert.deepEqual(await domain(w), before);
    } finally { w.close(); }
  }
});

test('assignment transports and final wire arrays reject hidden keys, symbols, accessors and holes without invoking getters', async () => {
  for (const mode of ['locator-getter', 'locator-hidden', 'locator-symbol', 'locator-hole', 'array-getter', 'array-hidden', 'array-symbol', 'array-hole'] as const) {
    const w = await world(); let getters = 0;
    try {
      const before = await domain(w);
      await assert.rejects(invoke({ ...w, execute: async call => {
        const session = await stage(call, w, 'files', [{ id: w.refs[0] }]); capture(call, w, 'files', w.refs[0]);
        selectScenarioReceiptReturn(call, w.store, 'assigned');
        const output: ExecutionEffects = { ...await session.finalize(), result: null, outbox: [], fileAssignments: [locator(w, 'files')] };
        const malformed: unknown[] = mode.startsWith('locator') ? [locator(w, 'files')] : [{ id: w.refs[0] }];
        if (mode.endsWith('getter')) Object.defineProperty(malformed, '0', { enumerable: true,
          get() { getters++; return mode.startsWith('locator') ? locator(w, 'files') : { id: w.refs[0] }; } });
        if (mode.endsWith('hidden')) Object.defineProperty(malformed, 'hidden', { value: true });
        if (mode.endsWith('symbol')) Object.defineProperty(malformed, Symbol('unexpected'), { value: true });
        if (mode.endsWith('hole')) delete malformed[0];
        if (mode.startsWith('locator')) output.fileAssignments = malformed;
        else output.writes = output.writes.map(write => write.kind === 'remove' ? write : ({ ...write,
          row: { ...write.row, data: { ...write.row.data, files: malformed } } }));
        return output;
      } }), stateError);
      assert.equal(getters, 0); assert.deepEqual(await domain(w), before);
    } finally { w.close(); }
  }
});

test('real physical drift, expiry and revocation after live capture refuse commit without domain effects or a committed receipt', async () => {
  for (const mode of ['bytes', 'revoked', 'expiry'] as const) {
    const w = await world(); let admitted: AdmittedCall | undefined, committed = 0;
    try {
      const before = await domain(w);
      await assert.rejects(invoke({ ...w, execute: async call => {
        admitted = call;
        const session = await stage(call, w); capture(call, w, 'file', w.refs[0]);
        selectScenarioReceiptReturn(call, w.store, 'assigned');
        const output = { ...await session.finalize(), result: null, outbox: [], fileAssignments: [locator(w)] };
        if (mode === 'bytes') w.physical().blobs.write(blobKeyForFile(w.refs[0]), new TextEncoder().encode('tampered'));
        if (mode === 'revoked') { const physical = w.physical().files.get(w.refs[0]); assert.ok(physical);
          w.physical().files.put({ ...physical, state: 'expired' }); }
        if (mode === 'expiry') w.setNow(FIXED_NOW + retention.unattachedHorizonMs);
        return output;
      }, observeCommittedReceipt: () => { committed++; } }), stateError);
      assert.equal(committed, 0); assert.ok(admitted); assert.deepEqual(await domain(w), before);
      const saved = await w.store.readReceipt(receiptIdentityFor(admitted.context));
      assert.notEqual(saved?.outcome.status, 'committed');
      // A fenced rejection receipt may itself advance State's revision.
    } finally { w.close(); }
  }
});

test('saved File disclosure rechecks physical lifetime, bytes, receiving policy and exact current owning field', async () => {
  for (const mode of ['expiry', 'bytes', 'receiver', 'policy', 'replacement', 'clear', 'order', 'permission', 'archive', 'recreated'] as const) {
    const w = await world();
    try {
      const selected = mode === 'order' ? 'files' : 'optionalFile';
      const wire = mode === 'order' ? [{ id: w.refs[0] }, { id: w.refs[1] }] : { id: w.refs[0] };
      const { receipt } = await originalCommit(w, selected, wire, mode === 'order' ? w.refs : [w.refs[0]]);
      const saved = JSON.parse(JSON.stringify(receipt)) as Receipt;
      if (mode === 'expiry') w.setNow(FIXED_NOW + retention.unattachedHorizonMs);
      if (mode === 'bytes') w.physical().blobs.remove(blobKeyForFile(w.refs[0]));
      if (mode === 'receiver') { const physical = w.physical().files.get(w.refs[0]); assert.ok(physical);
        w.physical().files.put({ ...physical, owner: { ...w.receiver, principal: 'different-principal' } }); }
      if (mode === 'policy') w.setPolicy({ ...DEFAULT_FILE_POLICY, maxBytes: bytes.byteLength - 1 });
      const current = await w.store.load(MODEL, w.row.id); assert.ok(current);
      if (mode === 'replacement') await updateCurrent(w, {}, { ...current.data, [selected]: { id: w.refs[1] } });
      if (mode === 'clear') await updateCurrent(w, {}, { ...current.data, [selected]: null });
      if (mode === 'order') await updateCurrent(w, {}, { ...current.data, files: [{ id: w.refs[1] }, { id: w.refs[0] }] });
      if (mode === 'archive') await updateCurrent(w, { archivedAt: FIXED_NOW + 1 });
      if (mode === 'recreated') {
        await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'remove', model: MODEL,
          id: current.id, expectedVersion: current.version }] }));
        await seedRow(w.store, MODEL, { id: current.id, created: current.created + 1, data: { ...current.data } });
      }
      const input = mode === 'permission' ? { ...w, policy: buildPolicyTable([{ model: MODEL, secretFields: ['secret'],
        grants: [{ by: 'members', fields: ['visible'] }] }]), receipt: saved } : { ...w, receipt: saved };
      const before = await domain(w), revision = await w.store.readRevision();
      const projected = await projectScenarioReceipt(input);
      assert.equal(projected.result, null);
      if (mode === 'archive' || mode === 'recreated') assert.deepEqual(projected.records, []);
      else { assert.equal(projected.records.length, 1); assert.deepEqual(projected.records[0]!.data, { visible: 'assigned visible' }); }
      assert.deepEqual(await domain(w), before); assert.equal(await w.store.readRevision(), revision);
    } finally { w.close(); }
  }
});

test('saved disclosure never leaks File data when a final asynchronous physical check changes membership or bytes', async () => {
  for (const mode of ['membership', 'bytes'] as const) {
    const w = await world();
    try {
      const { receipt } = await originalCommit(w); let checks = 0;
      w.setBeforeRevalidate(async () => {
        checks++;
        if (checks !== 3) return;
        if (mode === 'membership') await w.memberships.removeMembership(w.member.membership.membership_id);
        else w.physical().blobs.remove(blobKeyForFile(w.refs[0]));
      });
      const projected = await savedProjection(w, receipt);
      assert.ok(checks >= 3);
      if (mode === 'membership') assert.deepEqual(projected, { result: null, records: [] });
      else assert.deepEqual(projected.records[0]!.data, { visible: 'assigned visible' });
    } finally { w.close(); }
  }
});

test('saved State association honors Files first attachment evidence beyond the original unattached clock', async () => {
  for (const mode of ['timely', 'late', 'unproven'] as const) {
    const w = await world();
    try {
      const { receipt } = await originalCommit(w);
      w.setNow(FIXED_NOW + (mode === 'late' ? retention.unattachedHorizonMs : 1));
      const attached = mode === 'unproven'
        ? recordAttachment({ files: w.physical().files }, w.refs[0], `${MODEL}/${w.row.id}/file`, w.receiver)
        : recordAttachment(w.deps(), w.refs[0], `${MODEL}/${w.row.id}/file`, w.receiver);
      assert.equal(attached.status, 'attached');
      w.setNow(FIXED_NOW + retention.unattachedHorizonMs + 1); w.reopen();
      const projected = await savedProjection(w, JSON.parse(JSON.stringify(receipt)) as Receipt);
      assert.equal(projected.records.length, 1);
      assert.deepEqual(projected.records[0]!.data, mode === 'timely'
        ? { visible: 'assigned visible', file: { id: w.refs[0] } } : { visible: 'assigned visible' });
    } finally { w.close(); }
  }
});

const message = (refs: readonly string[] = []) => ({role: 'user', content: 'Original message', attachments: refs.map(id => ({id}))});
const requestValue = (messages: readonly unknown[]) => ({source: 'original-request', revision: '1', profile: 'profile',
  policy_revision: 'policy-1', messages, max_input_tokens: '8192', max_output_tokens: '2048', max_duration: '120000'});

test('nominal prefix assignment retains ordered duplicate leaves, one genuine fact per distinct ref and owner version', async () => {
  const w = await world(true, APP, 'archive', true);
  try {
    const wire = [message([w.refs[1], w.refs[0], w.refs[1]]), message()];
    const {receipt, admitted} = await originalCommit(w, 'prefix', wire, [w.refs[1], w.refs[0]]);
    const saved = readScenarioReceiptAssociation(receipt); assert.ok(saved);
    assert.equal(saved.changed[0]!.row.version, w.row.version + 1);
    assert.equal(saved.changed[0]!.fieldTypes.prefix, 'std.TextMessage[]');
    assert.deepEqual(saved.changed[0]!.row.data.prefix, wire);
    assert.deepEqual(saved.fileAssignments!.map(entry => entry.file.ref), [w.refs[1], w.refs[0]]);
    for (const fact of saved.fileAssignments!) assert.equal(fact.rowVersion, w.row.version + 1);
    const retained = await w.store.readReceipt(receiptIdentityFor(admitted.context)); assert.deepEqual(retained, receipt);
    w.reopen(); const projected = await savedProjection(w, JSON.parse(JSON.stringify(retained)) as Receipt);
    assert.deepEqual(projected.records[0]!.data, {visible: 'assigned visible', prefix: wire});
  } finally {w.close();}
});

test('complete nominal request_value preserves every owning field and nested message File occurrence', async () => {
  const w = await world(true, APP, 'archive', true);
  try {
    const wire = requestValue([message([w.refs[0], w.refs[0]]), {...message([w.refs[1]]), role: 'assistant'}]);
    const {receipt} = await originalCommit(w, 'request_value', wire, w.refs);
    const saved = readScenarioReceiptAssociation(receipt); assert.ok(saved);
    assert.equal(saved.changed[0]!.fieldTypes.request_value, 'std.TextRequest');
    assert.deepEqual(saved.changed[0]!.row.data.request_value, wire); assert.equal(saved.fileAssignments!.length, 2);
    w.reopen(); assert.deepEqual((await savedProjection(w, receipt)).records[0]!.data.request_value, wire);
  } finally {w.close();}
});

test('private nominal assignment retains writer and row authority without granting saved field disclosure', async () => {
  const w = await world(true, APP, 'archive', true);
  try {
    w.access.field = false;
    const wire = requestValue([message([w.refs[0], w.refs[0]])]);
    const {receipt} = await originalCommit(w, 'request_value', wire, [w.refs[0]]);
    assert.deepEqual((await w.store.load(MODEL, w.row.id))!.data.request_value, wire);
    assert.equal(readScenarioReceiptAssociation(receipt)!.fileAssignments!.length, 1);
    w.reopen();
    const projected = await savedProjection(w, receipt);
    assert.deepEqual(projected.records[0]!.data, {visible: 'assigned visible'});
    const before = await domain(w); let executed = 0;
    const replay = await invokeRetainedReceiptOnly({...w, execute: async () => {executed++; return empty();}});
    assert.equal(replay.status, 'replayed'); assert.equal(executed, 0);
    assert.deepEqual(await domain(w), before);
    w.access.ancestor = false;
    assert.deepEqual((await savedProjection(w, receipt)).records, []);
  } finally {w.close();}
});

test('empty and nullable nominal assignments retain declared File census without physical facts', async () => {
  for (const [selected, wire] of [['prefix', []], ['prefix', [message()]], ['optionalPrefix', null], ['request_value', requestValue([])]] as const) {
    const w = await world(true, APP, 'archive', true);
    try {
      const {receipt} = await originalCommit(w, selected, wire, []);
      assert.deepEqual(readScenarioReceiptAssociation(receipt)!.fileAssignments, []); assert.equal(w.revalidations(), 0);
      assert.deepEqual((await savedProjection(w, receipt)).records[0]!.data[selected], wire);
      w.access.field = false;
      const denied = await savedProjection(w, receipt);
      assert.ok(denied.records.every(record => !Object.hasOwn(record.data, selected)), 'empty value still requires its whole-field source grant');
    } finally {w.close();}
  }
});

test('nominal missing, copied, foreign, duplicate and orphan receiving facts refuse atomically', async () => {
  for (const mode of ['missing', 'copied', 'foreign', 'duplicate', 'orphan'] as const) {
    const w = await world(true, APP, 'archive', true);
    try {
      const before = await domain(w);
      await assert.rejects(invoke({...w, execute: async call => {
        const session = await stage(call, w, 'prefix', [message([w.refs[0]])]);
        if (mode !== 'missing') {
          const receiver = {...w.receiver, principal: 'foreign'};
          const handle = mode === 'foreign' ? w.observe(w.finalize(receiver), receiver) : w.observe(mode === 'orphan' ? w.refs[1] : w.refs[0]);
          observeScenarioReceiptFileAssignment(call, w.store, {...locator(w, 'prefix'), observation: mode === 'copied' ? {...handle} : handle});
          if (mode === 'duplicate') capture(call, w, 'prefix', w.refs[0]);
        }
        selectScenarioReceiptReturn(call, w.store, 'assigned');
        return {...await session.finalize(), result: null, outbox: [], fileAssignments: [locator(w, 'prefix')]};
      }}), stateError, mode);
      assert.deepEqual(await domain(w), before);
    } finally {w.close();}
  }
});

test('nominal final locator model, field, target lifetime and issued version cannot drift', async () => {
  for (const mode of ['locator', 'model', 'field', 'version', 'remove'] as const) {
    const w = await world(true, APP, mode === 'remove' ? 'remove' : 'archive', true);
    try {
      const before = await domain(w);
      await assert.rejects(invoke({...w, execute: async call => {
        const session = await stage(call, w, 'prefix', [message([w.refs[0]])]); capture(call, w, 'prefix', w.refs[0]);
        if (mode === 'remove') await session.stage({op: 'remove', model: MODEL, id: w.row.id}, cause);
        selectScenarioReceiptReturn(call, w.store, 'assigned');
        const output: ExecutionEffects = {...await session.finalize(), result: null, outbox: [], fileAssignments: [locator(w, 'prefix')]};
        if (mode === 'locator') output.fileAssignments = [{...locator(w, 'prefix'), recordId: asId('absent')}];
        if (mode === 'model') output.fileAssignments = [{...locator(w, 'prefix'), model: OTHER}];
        if (mode === 'field') output.fileAssignments = [locator(w, 'optionalPrefix')];
        if (mode === 'version') output.writes = output.writes.map(write => write.kind === 'remove' ? write : {...write, row: {...write.row, version: asVersion(write.row.version + 1)}});
        return output;
      }}), stateError, mode);
      assert.deepEqual(await domain(w), before);
    } finally {w.close();}
  }
});

test('nominal assignment validates complete owning constraints and current schema drift masks the saved field', async () => {
  for (const wire of [[{...message(), role: 'unknown'}], [{...message(), content: 'x'.repeat(101)}],
    [{...message(), extra: true}], Array.from({length: 5}, () => message()), [{...message(), attachments: [{id: 'https://example.test/raw'}]}]]) {
    const w = await world(true, APP, 'archive', true);
    try {
      const before = await domain(w);
      await assert.rejects(originalCommit(w, 'prefix', wire, []), stateError);
      assert.deepEqual(await domain(w), before);
    } finally {w.close();}
  }
  const w = await world(true, APP, 'archive', true);
  try {
    const {receipt} = await originalCommit(w, 'prefix', [message([w.refs[0]])]);
    const current = loadArtifactDescriptors(artifact('archive', true, 5), {by: 'members'});
    const def = current.registry.get(OP) as GeneratedOperationDef;
    bindScenarioReceiptFileProducer(def, {source: origin(), app: APP, revalidate: w.revalidate});
    bindScenarioReceiptReferenceProducer(def, {source: origin(), app: APP, policy: w.policy, readPolicies: w.readPolicies!});
    const projected = await projectScenarioReceipt({...w, registry: current.registry, receipt});
    assert.ok(projected.records.every(record => !Object.hasOwn(record.data, 'prefix')));
  } finally {w.close();}
});

test('nominal late physical, source ancestor and related Identity changes roll back the original owner', async () => {
  for (const mode of ['physical', 'ancestor', 'related'] as const) {
    const w = await world(true, APP, 'archive', true);
    try {
      const before = await domain(w);
      await assert.rejects(invoke({...w, execute: async call => {
        const session = await stage(call, w, 'prefix', [message([w.refs[0]])]); capture(call, w, 'prefix', w.refs[0]);
        selectScenarioReceiptReturn(call, w.store, 'assigned');
        const output = {...await session.finalize(), result: null, outbox: [], fileAssignments: [locator(w, 'prefix')]};
        w.setBeforeRevalidate(async () => {
          if (mode === 'physical') w.physical().blobs.remove(blobKeyForFile(w.refs[0]));
          if (mode === 'ancestor') w.access.ancestor = false;
          if (mode === 'related') await w.memberships.removeMembership(w.related!.membership.membership_id);
        });
        return output;
      }}), stateError, mode);
      assert.deepEqual(await domain(w), before);
    } finally {w.close();}
  }
});

test('saved nominal whole-field and physical drift masks; retained replay reuses original wire without recapture', async () => {
  for (const mode of ['unchanged', 'physical', 'whole-field', 'replacement', 'ancestor', 'related'] as const) {
    const w = await world(true, APP, 'archive', true);
    try {
      const wire = [message([w.refs[1], w.refs[0], w.refs[1]])];
      const {receipt} = await originalCommit(w, 'prefix', wire, [w.refs[1], w.refs[0]]); w.reopen();
      if (mode === 'physical') w.physical().blobs.remove(blobKeyForFile(w.refs[0]));
      if (mode === 'whole-field') w.access.field = false;
      if (mode === 'ancestor') w.access.ancestor = false;
      if (mode === 'related') await w.memberships.removeMembership(w.related!.membership.membership_id);
      if (mode === 'replacement') {const row = await w.store.load(MODEL, w.row.id); assert.ok(row);
        await updateCurrent(w, {}, {...row.data, prefix: [{...wire[0]!, content: 'Changed scalar, same refs'}]});}
      const before = await domain(w), revision = await w.store.readRevision(); let executed = 0;
      const projected = await savedProjection(w, JSON.parse(JSON.stringify(receipt)) as Receipt);
      if (mode === 'unchanged') assert.deepEqual(projected.records[0]!.data.prefix, wire);
      else assert.ok(projected.records.every(record => !Object.hasOwn(record.data, 'prefix')));
      const replay = await invokeRetainedReceiptOnly({...w, execute: async () => {executed++; return empty();}});
      assert.equal(replay.status, 'replayed'); assert.equal(executed, 0);
      assert.deepEqual(await domain(w), before); assert.equal(await w.store.readRevision(), revision);
    } finally {w.close();}
  }
});

test('File producer binding is one checked source/app installation before invocation', async () => {
  const unbound = await world(false);
  try {
    assert.throws(() => bindScenarioReceiptFileProducer(unbound.def,
      { source: { ...origin(), sha256: 'd'.repeat(64) }, app: APP, revalidate: unbound.revalidate }), stateError);
    bindScenarioReceiptFileProducer(unbound.def, { source: origin(), app: APP, revalidate: unbound.revalidate });
    assert.throws(() => bindScenarioReceiptFileProducer(unbound.def,
      { source: origin(), app: APP, revalidate: unbound.revalidate }), stateError);
    await originalCommit(unbound);
    assert.throws(() => bindScenarioReceiptFileProducer(unbound.def,
      { source: origin(), app: APP, revalidate: unbound.revalidate }), stateError);
  } finally { unbound.close(); }
  for (const mode of ['missing', 'app'] as const) {
    const w = await world(mode === 'app', 'wrong-app');
    try { await assert.rejects(originalCommit(w), stateError); }
    finally { w.close(); }
  }
});
