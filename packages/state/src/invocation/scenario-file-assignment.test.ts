/** Defining State/File join over public Files SQLite storage and a checked,
 * hand-built void descriptor. This does not qualify Compiler or native-host
 * File/Set evaluation, source execution/replay, or Dev repair. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CanTypeId, FilePolicy, FinalizedFileObservation, FinalizedFileReceiver,
  Receipt, RetainedFinalizedFile, StoredRow } from '@canlang/contracts';
import { DEFAULT_FILE_POLICY, blobKeyForFile, ingestVerifiedEventBytes, observeFinalizedFile,
  readFinalizedFileObservation, recordAttachment, revalidateRetainedFinalizedFile } from '@canlang/files';
import { createSqliteFileStore } from '@canlang/files/host/sqlite';
import type { AdmittedCall } from './admission.js';
import { receiptIdentityFor } from './admission.js';
import { StateError } from '../errors.js';
import { createMemoryStorage } from '../storage/memory.js';
import { buildModelTableFromCanonical } from '../mutation/models.js';
import { buildPolicyTable } from '../policy/grants.js';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice, type GeneratedOperationDef } from './registry.js';
import { invoke, invokeRetainedReceiptOnly, type ExecutionEffects } from './invoke.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptFileProducer, observeScenarioReceiptFileAssignment,
  projectScenarioReceipt, readScenarioReceiptAssociation, selectScenarioReceiptReturn } from './scenario-receipt.js';
import { FIXED_NOW, asId, asModel, asVersion, createMemoryIdentityStore, makeBatch, makeIdentity, makeEnvelope,
  seedMember, seedRow, uuidv7 } from '../../test/invocation/fixtures.js';

const MODEL = asModel('Files.Record'), OTHER = asModel('Files.Other'), OP = 'Files.assign', APP = 'state-files-app';
const bounds = { maxWork: 1000, maxRows: 10 }, cause = { cause: 'scenario' } as const;
const retention = { unattachedHorizonMs: 60_000, retentionMs: 120_000 };
const bytes = new TextEncoder().encode('actual finalized bytes\n');
const origin = () => ({ path: 'files.can', sha256: 'c'.repeat(64), module: 'files.mjs' });
const stateError = (error: unknown) => error instanceof StateError;
let sequence = 40_000;
type FileField = 'file' | 'optionalFile' | 'files';
function artifact(): ArtifactDescriptorSlice {
  const fields = [
    { name: 'file', field: { kind: 'file' as const }, valueType: 'file' as CanTypeId, required: false, serverOnly: false },
    { name: 'optionalFile', field: { kind: 'file' as const }, valueType: 'file?' as CanTypeId, nullable: true, required: false, serverOnly: false },
    { name: 'files', field: { kind: 'file' as const }, valueType: 'file[]' as CanTypeId, array: { required: false }, max: '4', required: false, serverOnly: false },
    { name: 'visible', field: { kind: 'string' as const }, valueType: 'text' as CanTypeId, required: false, serverOnly: false },
    { name: 'secret', field: { kind: 'secret' as const }, required: false, serverOnly: true },
  ];
  return { artifact_version: 1, sources: [{ path: 'files.can', sha256: 'c'.repeat(64) }],
    modules: [{ path: 'files.mjs', js: 'export const identity="Files.assign";',
      map: { version: 3, file: 'files.mjs', sources: ['files.can'], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: 'files.mjs', export: 'identity', member: ['assign'] }],
    models: [{ name: MODEL, deleteMode: 'archive', fields }, { name: OTHER, deleteMode: 'archive', fields }],
    operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [
      { name: 'record', field: { kind: 'ref', model: MODEL, requireVersion: true }, required: true },
    ] }, result: { type: 'void' as CanTypeId, disclosure: { version: 1, source: origin(), returns: [
      { id: 'assigned', source: origin(), influences: [], dependencies: [] },
    ] } } }],
  };
}
const empty = (): ExecutionEffects => ({ result: null, writes: [], history: [], outbox: [], schedules: [],
  uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {} });

async function world(bind = true, producerApp = APP) {
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false, roles: [] });
  const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
  const receiver: FinalizedFileReceiver = { app: APP, team: member.team.team_id,
    owner: member.team.team_id, principal: member.user.user_id };
  const loaded = loadArtifactDescriptors(artifact(), { by: 'members' });
  const def = loaded.registry.get(OP) as GeneratedOperationDef; assert.ok(def);
  const table = buildModelTableFromCanonical(loaded.models, {
    refs: loaded.refs, serverInits: loaded.serverInits, nullableFields: loaded.nullableFields,
    containment: loaded.containment,
    ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }),
  });
  const row = await seedRow(store, MODEL, { data: { visible: 'entry visible', secret: 'never disclose' } });
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
    { by: 'members', fields: ['file', 'optionalFile', 'files', 'visible', 'secret'] },
  ] }]);
  return { store, memberships, identity, member, receiver, registry: loaded.registry, def, table, row,
    envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), { record: { id: row.id, version: String(row.version) } }),
    app: APP, source: 'test', clock, policy: policyTable, refs, deps, options, finalize, revalidate,
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
    const w = await world();
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
      } }), stateError);
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
