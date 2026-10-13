/** Defining State protected stored File[] child CALL over genuine Files SQLite
 * observations. Hand-built checked descriptors do not qualify Compiler,
 * native execution, source replay, or provider delivery. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CanTypeId, ClosedInputs, FinalizedFileObservation, FinalizedFileReceiver, Receipt,
  RetainedFinalizedFile, StoredRow, ModelName } from '@canlang/contracts';
import { DEFAULT_FILE_POLICY, blobKeyForFile, ingestVerifiedEventBytes, observeFinalizedFile,
  revalidateRetainedFinalizedFile } from '@canlang/files';
import { createSqliteFileStore } from '@canlang/files/host/sqlite';
import { StateError } from '../errors.js';
import { createMemoryStorage } from '../storage/memory.js';
import { buildModelTableFromCanonical } from '../mutation/models.js';
import { buildPolicyTable } from '../policy/grants.js';
import type { ViewerSourceReadPolicy } from '../query/source-policy.js';
import { receiptIdentityFor, type AdmittedCall } from './admission.js';
import { loadArtifactDescriptors, type ArtifactDescriptorSlice, type GeneratedOperationDef } from './registry.js';
import { invoke, invokeRetainedReceiptOnly, type ExecutionEffects } from './invoke.js';
import { beginScenarioReceiptMutation, bindScenarioReceiptReferenceProducer, bindScenarioReceiptFileProducer,
  bindScenarioReceiptCallProducer, observeScenarioReceiptDependency, invokeScenarioReceiptCall,
  selectScenarioReceiptReturn, readScenarioReceiptAssociation, projectScenarioReceipt } from './scenario-receipt.js';
import { FIXED_NOW, asModel, asVersion, createMemoryIdentityStore, makeBatch, makeEnvelope, makeIdentity,
  seedMember, seedRow, makeRow, uuidv7 } from '../../test/invocation/fixtures.js';

const TURN = asModel('Chat.Turn'), THREAD = asModel('Chat.Thread');
const ROOT = 'Chat.review', CHILD = 'Chat.consume', MIDDLE = 'Chat.forward', APP = 'stored-file-call-app';
const bounds = { maxWork: 1000, maxRows: 10 }, cause = { cause: 'scenario' } as const;
const retention = { unattachedHorizonMs: 60_000, retentionMs: 120_000 };
const bytes = new TextEncoder().encode('genuine stored attachment\n');
const stateError = (error: unknown) => error instanceof StateError;
let sequence = 100_000;
const origin = (digest = 'a'.repeat(64)) => ({ path: 'stored-file-call.can', sha256: digest, module: 'stored-file-call.mjs' });
function artifact(digest = 'a'.repeat(64)): ArtifactDescriptorSlice {
  const disclosure = (dependency: boolean) => ({ version: 1 as const, source: origin(digest), returns: [{
    id: 'count', source: origin(digest), influences: [], dependencies: dependency ? [{ id: 'turn-files',
      source: origin(digest), role: 'data' as const, model: TURN, field: 'attachments', type: 'file[]' as CanTypeId }] : [],
  }] });
  return { artifact_version: 1, sources: [{ path: origin().path, sha256: digest }], modules: [{ path: origin().module,
    js: 'export const identity="Chat.review";', map: { version: 3, file: origin().module,
      sources: [origin().path], sourcesContent: [null], names: [], mappings: '' } }],
    callables: [ROOT, CHILD, MIDDLE].map(id => ({ id, kind: 'operation' as const, module: origin().module,
      export: 'identity', member: [id.split('.')[1]!] })),
    models: [{ name: THREAD, deleteMode: 'archive', fields: [{ name: 'title', field: { kind: 'string' },
      valueType: 'text' as CanTypeId, required: false, serverOnly: false }] },
    { name: TURN, parent: THREAD, deleteMode: 'archive', fields: [
      { name: 'attachments', field: { kind: 'file' }, valueType: 'file[]' as CanTypeId,
        array: { required: false }, required: false, serverOnly: false },
      { name: 'state', field: { kind: 'string' }, valueType: 'text' as CanTypeId, required: false, serverOnly: false },
    ] }],
    operations: [ROOT, CHILD, MIDDLE].map(name => ({ name, kind: 'scenario' as const, description: '',
      inputs: { fields: name === CHILD ? [{ name: 'attachments', field: { kind: 'file' as const },
        valueType: 'file[]' as CanTypeId, array: { required: false }, required: false,
        default: { kind: 'literal' as const, value: [] } }] : [] },
      result: { type: 'int' as CanTypeId, disclosure: disclosure(name !== CHILD) } })),
  };
}
const empty = (): ExecutionEffects => ({ result: null, writes: [], history: [], outbox: [], schedules: [],
  uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {} });
type Options = { wire?: 'empty' | 'absent' | 'null'; denial?: 'field' | 'ancestor' | 'subfield';
  prepare?: 'absent' | 'null' | 'different'; site?: 'undeclared-slot' | 'undeclared-site'; nested?: boolean; noChildWrite?: boolean; copiedChild?: boolean };
async function world(options: Options = {}, slice = artifact()) {
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false, roles: [] });
  const identity = makeIdentity({ userId: member.user.user_id, team: member.team, membership: member.membership });
  const receiver: FinalizedFileReceiver = { app: APP, team: member.team.team_id,
    owner: member.team.team_id, principal: member.user.user_id };
  const dir = mkdtempSync(join(tmpdir(), 'can-stored-file-call-'));
  const path = join(dir, 'files.sqlite'); let physical = createSqliteFileStore(path), now = FIXED_NOW;
  const clock = { nowMs: () => now }, deps = () => ({ clock, files: physical.files, blobs: physical.blobs });
  const finalize = (receiving = receiver) => {
    const result = ingestVerifiedEventBytes({ ...deps(), intents: physical.intents,
      fileIds: { nextFileId: () => randomUUID() } }, { provenance: { kind: 'event', source: 'mail', adapter: 'mail',
      occurrenceId: randomUUID(), fieldPath: 'attachments', itemIndex: 0 }, receiver: receiving,
      claimedType: 'text/plain', bytes, policy: DEFAULT_FILE_POLICY });
    assert.equal(result.status, 'finalized'); if (result.status !== 'finalized') throw new Error('Files finalization failed');
    return result.file.id;
  };
  const refs = [finalize(), finalize()] as const;
  const observe = (ref: string, receiving = receiver) => {
    const value = observeFinalizedFile(deps(), ref, receiving, { policy: DEFAULT_FILE_POLICY, retention });
    assert.ok(value); return value;
  };
  const loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields, containment: loaded.containment,
    ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }) });
  const policyFor = (denial?: Options['denial']) => buildPolicyTable([
    { model: THREAD, secretFields: [], grants: denial === 'ancestor' ? [] : [{ by: 'members', fields: ['title'] }] },
    { model: TURN, secretFields: [], grants: [{ by: 'members', fields: denial === 'field' ? ['state'] : denial === 'subfield' ? ['attachments.id', 'state'] : ['attachments', 'state'] }] },
  ], loaded.models);
  const policy = policyFor(options.denial), def = loaded.registry.get(ROOT) as GeneratedOperationDef;
  const child = loaded.registry.get(CHILD) as GeneratedOperationDef, middle = loaded.registry.get(MIDDLE) as GeneratedOperationDef;
  let beforeRevalidate: (() => void | Promise<void>) | undefined, executions = 0, preparations = 0;
  const revalidate = async (saved: RetainedFinalizedFile, receiving: FinalizedFileReceiver) => {
    await beforeRevalidate?.(); return revalidateRetainedFinalizedFile(deps(), saved, receiving, { policy: DEFAULT_FILE_POLICY, retention });
  };
  let currentDenial = options.denial;
  const fields = ['attachments', 'state'];
  const sourceReads = new Map<ModelName, ViewerSourceReadPolicy>([
    [TURN, { parent: THREAD, fields, secretFields: [], grants: [{ fields: options.denial === 'field' ? ['state'] : options.denial === 'subfield' ? ['attachments.id', 'state'] : fields, read: async () => currentDenial !== 'field' }] }],
    [THREAD, { fields: ['title'], secretFields: [], grants: [{ fields: ['title'], read: async () => currentDenial !== 'ancestor' }] }],
  ]);
  for (const operation of [def, child, middle]) {
    if (operation !== child) bindScenarioReceiptReferenceProducer(operation, { source: origin(), app: APP, policy, readPolicies: sourceReads });
    bindScenarioReceiptFileProducer(operation, { source: origin(), app: APP, revalidate });
  }
  const thread = await seedRow(store, THREAD, { data: { title: 'Thread' } });
  const wire = options.wire === 'empty' ? [] : options.wire === 'null' ? null
    : [{ id: refs[1] }, { id: refs[0] }, { id: refs[1] }];
  const row: StoredRow = { ...makeRow({ data: { state: 'open', ...(options.wire === 'absent' ? {} : { attachments: wire }) } }),
    parent: { model: THREAD, id: thread.id } };
  await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: TURN, row }] }));
  const capture = async (call: AdmittedCall, sourceRow: StoredRow, files?: readonly FinalizedFileObservation[]) => {
    await observeScenarioReceiptDependency(call, store, { dependencyId: 'turn-files', model: TURN,
      row: sourceRow, field: 'attachments', files: files ?? (Array.isArray(sourceRow.data['attachments'])
        && sourceRow.data['attachments'].length !== 0 ? [observe(refs[1]), observe(refs[0])] : []) });
  };
  const install = (owner: GeneratedOperationDef, target: GeneratedOperationDef) => bindScenarioReceiptCallProducer(owner, {
    source: origin(), app: APP, registry: loaded.registry, sites: [{ id: 'consume-files', source: origin(),
      kind: 'operation', resultType: 'int' as CanTypeId, targets: [{ operation: target.name, interface: target.descriptor }],
      ...(target === child && options.site !== 'undeclared-slot' ? { fileInputs: [{ name: 'attachments', dependencyId: 'turn-files' }] } : {}) }],
    prepare: (_def, inputs) => {
      preparations++;
      return (options.prepare === 'absent' ? {} : options.prepare === 'null' ? { attachments: null }
        : options.prepare === 'different' ? { attachments: [] } : structuredClone(inputs)) as ClosedInputs;
    },
    execute: async frame => {
      executions++;
      if (target === middle) {
        const source = await frame.session.read(TURN, row.id); assert.ok(source);
        await capture(frame.call, source);
        const value = await invokeScenarioReceiptCall(frame.call, store,
          { site: 'consume-files', target: CHILD, inputs: { attachments: source.data['attachments'] } });
        selectScenarioReceiptReturn(frame.call, store, 'count'); return value;
      }
      assert.deepEqual(frame.call.inputs['attachments'], wire);
      if (options.copiedChild) {
        const source = await frame.session.read(TURN, row.id); assert.ok(source);
        await assert.rejects(capture({ ...frame.call }, source), stateError);
      }
      if (!options.noChildWrite) await frame.session.stage({ op: 'update', model: TURN, id: row.id, data: { state: 'consumed' } }, cause);
      selectScenarioReceiptReturn(frame.call, store, 'count');
      return String((frame.call.inputs['attachments'] as unknown[]).length);
    },
  });
  if (options.nested) { install(middle, child); install(def, middle); } else install(def, child);
  return { store, memberships, member, identity, receiver, refs, row, thread, table, def, registry: loaded.registry,
    app: APP, source: 'test', policy, policyFor, clock, observe, finalize, capture,
    envelope: makeEnvelope(ROOT, uuidv7(FIXED_NOW, ++sequence), {}), options,
    counts: () => ({ executions, preparations }), physical: () => physical,
    setDenial: (value: Options['denial']) => { currentDenial = value; },
    setNow: (value: number) => { now = value; }, setBeforeRevalidate: (value: typeof beforeRevalidate) => { beforeRevalidate = value; },
    reopen: () => { physical.close(); physical = createSqliteFileStore(path); },
    close: () => { physical.close(); rmSync(dir, { recursive: true, force: true }); } };
}
type World = Awaited<ReturnType<typeof world>>;
async function domain(w: World) { return { row: await w.store.load(TURN, w.row.id),
  history: await w.store.historyFor(TURN, w.row.id), outbox: await w.store.outboxPending() }; }
async function save(w: World, after?: () => void | Promise<void>) {
  let receipt: Receipt | undefined, admitted: AdmittedCall | undefined;
  const result = await invoke({ ...w, execute: async call => {
    admitted = call;
    const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
    const row = await session.read(TURN, w.row.id); assert.ok(row); await w.capture(call, row);
    const value = await invokeScenarioReceiptCall(call, w.store, { site: w.options.site === 'undeclared-site' ? 'unknown' : 'consume-files',
      target: w.options.nested ? MIDDLE : CHILD, inputs: w.options.nested ? {} : { attachments: row.data['attachments'] } });
    selectScenarioReceiptReturn(call, w.store, 'count'); const effects = await session.finalize(); await after?.();
    return { ...effects, result: value, outbox: [] };
  }, observeCommittedReceipt: value => { receipt = value; } });
  assert.equal(result.status, 'committed'); assert.ok(receipt); assert.ok(admitted); return { receipt, admitted, result };
}
async function update(w: World, model: typeof TURN, row: StoredRow, changes: Partial<StoredRow>) {
  const current = await w.store.load(model, row.id); assert.ok(current);
  await w.store.commit(makeBatch(await w.store.readRevision(), { writes: [{ kind: 'update', model, id: row.id,
    expectedVersion: current.version, row: { ...current, version: asVersion(current.version + 1), ...changes } }] }));
}

test('stored File[] child CALL retains genuine distinct facts and ordered duplicate/empty wire through saved replay', async () => {
  for (const options of [{}, { wire: 'empty' }, { nested: true }] as Options[]) {
    const w = await world(options);
    try {
      const { receipt, admitted, result } = await save(w); assert.equal(result.result, options.wire === 'empty' ? '0' : '3');
      const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
      assert.deepEqual(association.observations[0]!.row.data['attachments'], w.row.data['attachments']);
      const files = association.observations[0]!.files; assert.ok(files);
      assert.deepEqual(files.map(file => file.ref), options.wire === 'empty' ? [] : [w.refs[1], w.refs[0]]);
      for (const file of files) { assert.deepEqual(file.receiver, w.receiver); assert.equal(file.sizeBytes, bytes.byteLength); assert.ok(file.bytesDigest); }
      assert.equal(association.calls!.length, options.nested ? 2 : 1);
      const persisted = await w.store.readReceipt(receiptIdentityFor(admitted.context)); assert.deepEqual(persisted, receipt);
      const saved = JSON.parse(JSON.stringify(persisted)) as Receipt; w.reopen();
      assert.deepEqual(readScenarioReceiptAssociation(saved), association);
      assert.equal((await projectScenarioReceipt({ ...w, receipt: saved })).result, result.result);
      const before = await domain(w), revision = await w.store.readRevision(), counts = w.counts(); let executed = 0;
      assert.equal((await invokeRetainedReceiptOnly({ ...w, execute: async () => { executed++; return empty(); } })).status, 'replayed');
      assert.equal(executed, 0); assert.deepEqual(w.counts(), counts); assert.deepEqual(await domain(w), before);
      assert.equal(await w.store.readRevision(), revision); assert.equal(before.history.length, 1);
    } finally { w.close(); }
  }
});

test('stored File[] capture requires genuine current owner rows and complete receiving physical observations', async () => {
  for (const mode of ['copy-row', 'foreign-row', 'stale-row', 'copy-file', 'foreign-file', 'missing-file', 'extra-file', 'expired-file'] as const) {
    const w = await world();
    try {
      const before = await domain(w);
      await assert.rejects(invoke({ ...w, execute: async call => {
        const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
        const row = await session.read(TURN, w.row.id); assert.ok(row);
        if (mode === 'stale-row') await session.stage({ op: 'update', model: TURN, id: row.id, data: { state: 'staged' } }, cause);
        const foreign = { ...w.receiver, principal: 'different-principal' };
        const files = [w.observe(w.refs[1]), w.observe(w.refs[0])];
        if (mode === 'copy-file') files[0] = { ...files[0]! };
        if (mode === 'foreign-file') files[0] = w.observe(w.finalize(foreign), foreign);
        if (mode === 'missing-file') files.pop();
        if (mode === 'extra-file') files.push(w.observe(w.finalize()));
        if (mode === 'expired-file') w.setNow(FIXED_NOW + retention.unattachedHorizonMs);
        await assert.rejects(w.capture(call, mode === 'copy-row' ? { ...row } : mode === 'foreign-row' ? w.row : row, files), stateError);
        await assert.rejects(session.finalize(), stateError); return empty();
      } }), stateError, mode);
      assert.deepEqual(await domain(w), before); assert.equal(w.counts().executions, 0);
    } finally { w.close(); }
  }
});

test('stored File[] denies whole-field/ancestor permissions, absent/null slots and undeclared protected sites', async () => {
  for (const options of [{ denial: 'field' }, { denial: 'ancestor' }, { denial: 'subfield' }, { denial: 'subfield', wire: 'empty' }, { wire: 'absent' }, { wire: 'null' },
    { prepare: 'absent' }, { prepare: 'null' }, { prepare: 'different' }, { site: 'undeclared-slot' }, { site: 'undeclared-site' }] as Options[]) {
    const w = await world(options);
    try { const before = await domain(w); await assert.rejects(save(w), stateError, JSON.stringify(options));
      assert.deepEqual(await domain(w), before); assert.equal(w.counts().executions, 0); }
    finally { w.close(); }
  }
});

test('missing capture and caught child denial poison all staged owner effects', async () => {
  const w = await world();
  try {
    const before = await domain(w);
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      const row = await session.read(TURN, w.row.id); assert.ok(row);
      await session.stage({ op: 'update', model: TURN, id: row.id, data: { state: 'must rollback' } }, cause);
      await assert.rejects(invokeScenarioReceiptCall(call, w.store,
        { site: 'consume-files', target: CHILD, inputs: { attachments: row.data['attachments'] } }), stateError);
      await assert.rejects(session.finalize(), stateError); return empty();
    } }), stateError);
    assert.deepEqual(await domain(w), before); assert.equal(w.counts().executions, 0);
  } finally { w.close(); }
});

test('physical, Identity and lifetime drift after child execution refuse the outer commit', async () => {
  for (const mode of ['bytes', 'identity', 'lifetime'] as const) {
    const w = await world();
    try {
      const before = await domain(w);
      await assert.rejects(save(w, async () => {
        if (mode === 'bytes') w.physical().blobs.remove(blobKeyForFile(w.refs[0]));
        if (mode === 'identity') await w.memberships.removeMembership(w.member.membership.membership_id);
        if (mode === 'lifetime') w.setNow(FIXED_NOW + retention.unattachedHorizonMs);
      }), stateError);
      assert.equal(w.counts().executions, 1); assert.deepEqual(await domain(w), before);
    } finally { w.close(); }
  }
});

test('post-call require failure rolls back the genuine child mutation', async () => {
  const w = await world();
  try {
    const before = await domain(w);
    await assert.rejects(invoke({ ...w, execute: async call => {
      const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
      const row = await session.read(TURN, w.row.id); assert.ok(row); await w.capture(call, row);
      const result = await invokeScenarioReceiptCall(call, w.store,
        { site: 'consume-files', target: CHILD, inputs: { attachments: row.data['attachments'] } });
      assert.equal(result, '3');
      throw new StateError('rule_failed', 'post-call requirement refuses consumed attachments');
    } }), stateError);
    assert.equal(w.counts().executions, 1); assert.deepEqual(await domain(w), before);
  } finally { w.close(); }
});

test('saved protected child result rechecks declaration, whole-field/ancestor, source and physical authority', async () => {
  for (const mode of ['field', 'ancestor', 'missing', 'null', 'parent', 'archive-parent', 'bytes', 'lifetime', 'declaration'] as const) {
    const w = await world();
    try {
      const { receipt } = await save(w); let policy = w.policy, registry = w.registry;
      if (mode === 'field' || mode === 'ancestor') w.setDenial(mode);
      if (mode === 'missing' || mode === 'null') {
        const current = await w.store.load(TURN, w.row.id); assert.ok(current);
        const data = { ...current.data }; if (mode === 'missing') delete data['attachments']; else data['attachments'] = null;
        await update(w, TURN, w.row, { data });
      }
      if (mode === 'parent') await update(w, TURN, w.row, { parent: { model: THREAD, id: 'another-thread' as StoredRow['id'] } });
      if (mode === 'archive-parent') await update(w, THREAD, w.thread, { archivedAt: FIXED_NOW + 1 });
      if (mode === 'bytes') w.physical().blobs.remove(blobKeyForFile(w.refs[0]));
      if (mode === 'lifetime') w.setNow(FIXED_NOW + retention.unattachedHorizonMs);
      if (mode === 'declaration') registry = loadArtifactDescriptors(artifact('b'.repeat(64)), { by: 'members' }).registry;
      const before = await domain(w), revision = await w.store.readRevision(), counts = w.counts();
      assert.equal((await projectScenarioReceipt({ ...w, policy, registry, receipt: JSON.parse(JSON.stringify(receipt)) as Receipt })).result, null, mode);
      assert.deepEqual(w.counts(), counts); assert.deepEqual(await domain(w), before); assert.equal(await w.store.readRevision(), revision);
    } finally { w.close(); }
  }
});

test('saved protected child result withholds after physical await revokes Identity', async () => {
  const w = await world();
  try {
    const { receipt } = await save(w); let checks = 0;
    w.setBeforeRevalidate(async () => { checks++; await w.memberships.removeMembership(w.member.membership.membership_id); });
    const counts = w.counts(), before = await domain(w);
    assert.equal((await projectScenarioReceipt({ ...w, receipt })).result, null);
    assert.ok(checks > 0); assert.deepEqual(w.counts(), counts); assert.deepEqual(await domain(w), before);
  } finally { w.close(); }
});


test('a copied child and consumed same-stage File capture poison the shared owner', async () => {
  for (const mode of ['copied-child', 'reuse'] as const) {
    const w = await world({ copiedChild: mode === 'copied-child', noChildWrite: mode === 'reuse' });
    try {
      const before = await domain(w);
      await assert.rejects(invoke({ ...w, execute: async call => {
        const session = await beginScenarioReceiptMutation(call, w.store, { table: w.table, bounds });
        const row = await session.read(TURN, w.row.id); assert.ok(row); await w.capture(call, row);
        const input = { site: 'consume-files', target: CHILD, inputs: { attachments: row.data['attachments'] } };
        if (mode === 'copied-child') await assert.rejects(invokeScenarioReceiptCall(call, w.store, input), stateError);
        else {
          assert.equal(await invokeScenarioReceiptCall(call, w.store, input), '3');
          await assert.rejects(invokeScenarioReceiptCall(call, w.store, input), stateError);
        }
        await assert.rejects(session.finalize(), stateError); return empty();
      } }), stateError);
      assert.equal(w.counts().executions, 1); assert.deepEqual(await domain(w), before);
    } finally { w.close(); }
  }
});

test('stored File CALL refuses unsupported target slots at owning loader or binding', () => {
  for (const profile of ['scalar', 'nullable', 'required-array', 'delivery'] as const) {
    const slice = artifact(), field = slice.operations![1]!.inputs!.fields[0]!;
    Reflect.deleteProperty(field, 'default');
    if (profile === 'scalar') { Object.assign(field, { valueType: 'file' }); Reflect.deleteProperty(field, 'array'); }
    if (profile === 'nullable') Object.assign(field, { valueType: 'file[]?', nullable: true });
    if (profile === 'required-array') Object.assign(field, { valueType: 'file[]!', array: { required: true } });
    if (profile === 'delivery') {
      Object.assign(field, { field: { kind: 'delivery', capability: 'std.ImagesV1', operation: 'submit', version: 1,
        result: { name: 'ImagesSubmit', fields: [] } } });
      Reflect.deleteProperty(field, 'valueType'); Reflect.deleteProperty(field, 'array');
      // T04b §10.1 (ratified): delivery is an admittable kind; unsupported
      // target slots refuse at the owning loader's T13 fence instead.
      assert.throws(() => loadArtifactDescriptors(slice, { by: 'members' }), /not declared for std\.ImagesV1\.submit/);
      continue;
    }
    const loaded = loadArtifactDescriptors(slice, { by: 'members' });
    const root = loaded.registry.get(ROOT) as GeneratedOperationDef, child = loaded.registry.get(CHILD) as GeneratedOperationDef;
    assert.throws(() => bindScenarioReceiptCallProducer(root, { source: origin(), app: APP, registry: loaded.registry,
      sites: [{ id: 'consume-files', source: origin(), kind: 'operation', resultType: 'int' as CanTypeId,
        targets: [{ operation: CHILD, interface: child.descriptor }], fileInputs: [{ name: 'attachments', dependencyId: 'turn-files' }] }],
      prepare: (_def, inputs) => inputs as ClosedInputs, execute: async () => '0',
    }), stateError, profile);
  }
});
