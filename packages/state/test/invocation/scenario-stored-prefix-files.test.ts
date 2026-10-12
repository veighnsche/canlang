/** Stored typed transcript prefix with genuine receiving Files; no native/app claim. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId, FinalizedFileObservation, FinalizedFileReceiver, ModelName, Receipt, RetainedFinalizedFile, StoredRow } from '@canlang/contracts';
import { finalizeProviderOutput, observeFinalizedFile } from '@canlang/files/finalize';
import { DEFAULT_FILE_POLICY, blobKeyForFile, revalidateRetainedFinalizedFile } from '@canlang/files';
import { TestOnlyCounterFileIds, TestOnlyCounterIntentIds, TestOnlyManualClock,
  TestOnlyMemoryBlobStore, TestOnlyMemoryFinalizedStore, TestOnlyMemoryIntentStore } from '@canlang/files/ports';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { loadArtifactDescriptors, isGeneratedOperationDef, type ArtifactDescriptorSlice } from '../../src/invocation/registry.js';
import { invoke, invokeRetainedReceiptOnly } from '../../src/invocation/invoke.js';
import type { AdmittedCall } from '../../src/invocation/admission.js';
import { buildModelTableFromCanonical } from '../../src/mutation/models.js';
import { buildPolicyTable } from '../../src/policy/grants.js';
import type { ViewerSourceReadPolicy } from '../../src/query/source-policy.js';
import { beginScenarioReceiptMutation, observeScenarioReceiptDependency, bindScenarioReceiptReferenceProducer,
  bindScenarioReceiptFileProducer, selectScenarioReceiptReturn, readScenarioReceiptAssociation,
  projectScenarioReceipt } from '../../src/invocation/scenario-receipt.js';
import { asModel, FIXED_NOW, makeBatch, makeEnvelope, makeIdentity, createMemoryIdentityStore,
  seedMember, seedRow, makeRow, updateRow, uuidv7 } from './fixtures.js';

const CONVERSATION = asModel('PrefixFiles.Conversation'), BRANCH = asModel('PrefixFiles.Branch');
const OP = 'PrefixFiles.countPrefix', APP = 'stored-prefix-files', TYPE = 'std.TextMessage[]' as CanTypeId;
const source = { path: 'prefix-files.can', sha256: 'c'.repeat(64), module: 'prefix-files.mjs' };
const retention = { unattachedHorizonMs: 60_000, retentionMs: 120_000 };
let sequence = 103_000;
const refuses = (error: unknown) => error instanceof StateError;
const message = (refs: readonly string[] = []) => ({ role: 'user', content: 'Original text', attachments: refs.map(id => ({ id })) });

async function world(options: { empty?: boolean; noProducer?: boolean; grant?: 'id' | 'subfield' } = {}) {
  const slice: ArtifactDescriptorSlice = { artifact_version: 1, sources: [{ path: source.path, sha256: source.sha256 }],
    modules: [{ path: source.module, js: 'export const identity="PrefixFiles.countPrefix";', map: {
      version: 3, file: source.module, sources: [source.path], sourcesContent: [null], names: [], mappings: '',
    } }], callables: [{ id: OP, kind: 'operation', module: source.module, export: 'identity', member: ['countPrefix'] }],
    valueTypes: { contracts: [{ name: 'std.TextMessage', fields: [
      { name: 'role', type: 'enum(system,user,assistant)' as CanTypeId },
      { name: 'content', type: 'text' as CanTypeId }, { name: 'attachments', type: 'file[]' as CanTypeId },
    ] }] }, models: [
      { name: CONVERSATION, deleteMode: 'archive', fields: [{ name: 'title', field: { kind: 'string' }, required: true, serverOnly: false }] },
      { name: BRANCH, parent: CONVERSATION, deleteMode: 'archive', fields: [
        { name: 'prefix', field: { kind: 'nominal', name: 'std.TextMessage' }, valueType: TYPE,
          array: { required: false }, max: 120, required: false, serverOnly: false },
        { name: 'state', field: { kind: 'string' }, required: true, serverOnly: false },
      ] },
    ], operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [] }, result: {
      type: 'int' as CanTypeId, disclosure: { version: 1, source, returns: [{ id: 'count', source,
        influences: [], dependencies: [{ id: 'prefix', source, role: 'data', model: BRANCH, field: 'prefix', type: TYPE }] }],
      },
    } }] };
  const loaded = loadArtifactDescriptors(slice, { by: 'members' });
  const def = loaded.registry.get(OP); assert.ok(def && isGeneratedOperationDef(def));
  const store = createMemoryStorage(), memberships = createMemoryIdentityStore();
  const member = await seedMember(memberships, { isOwner: false });
  const identity = makeIdentity({ membership: member.membership });
  const receiver: FinalizedFileReceiver = { app: APP, team: member.team.team_id, owner: member.team.team_id, principal: member.user.user_id };
  const clock = new TestOnlyManualClock(FIXED_NOW), blobs = new TestOnlyMemoryBlobStore(), files = new TestOnlyMemoryFinalizedStore();
  const intents = new TestOnlyMemoryIntentStore(), fileIds = new TestOnlyCounterFileIds();
  const upload = { clock, blobs, intents, intentIds: new TestOnlyCounterIntentIds(), policy: DEFAULT_FILE_POLICY,
    intentTtlMs: 60_000, urlBase: 'https://prefix-files.invalid' };
  const finalize = { clock, blobs, intents, files, fileIds };
  let delivery = 0;
  const finish = (receiving = receiver) => {
    const result = finalizeProviderOutput(upload, finalize, { receiver: receiving,
      binding: { adapter: 'prefix-test', deliveryId: `delivery-${++delivery}`, resultPath: 'attachment' }, operation: 'PrefixFiles.receive',
      field: '/attachment', args: {}, name: 'prefix.txt', claimedType: 'text/plain', bytes: new TextEncoder().encode(`bytes-${delivery}`) });
    assert.equal(result.status, 'finalized'); if (result.status !== 'finalized') throw new Error('File finalization failed');
    return result.file.id;
  };
  const refs = [finish(), finish()] as const;
  const observe = (id: string, receiving = receiver) => {
    const observation = observeFinalizedFile(finalize, id, receiving, { policy: DEFAULT_FILE_POLICY, retention });
    assert.ok(observation); return observation;
  };
  let beforeRevalidate: (() => Promise<void> | void) | undefined, revalidations = 0;
  const revalidate = async (retained: RetainedFinalizedFile, receiving: FinalizedFileReceiver) => {
    revalidations++; await beforeRevalidate?.();
    return revalidateRetainedFinalizedFile(finalize, retained, receiving, { policy: DEFAULT_FILE_POLICY, retention });
  };
  if (!options.noProducer) bindScenarioReceiptFileProducer(def, { source, app: APP, revalidate });
  const access = { prefix: true, ancestor: true };
  const fields = options.grant === 'id' ? ['id', 'state'] : options.grant === 'subfield' ? ['prefix.attachments', 'state'] : ['prefix', 'state'];
  const policy = buildPolicyTable([], loaded.models);
  const readPolicies = new Map<ModelName, ViewerSourceReadPolicy>([
    [BRANCH, { parent: CONVERSATION, fields: ['prefix', 'state'], secretFields: [], grants: [{ fields,
      read: async ({ context }) => access.prefix && context.membership?.status === 'active' }] }],
    [CONVERSATION, { fields: ['title'], secretFields: [], grants: [{ fields: ['title'],
      read: async ({ context }) => access.ancestor && context.membership?.status === 'active' }] }],
  ]);
  bindScenarioReceiptReferenceProducer(def, { source, app: APP, policy, readPolicies });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, containment: loaded.containment,
    nullableFields: loaded.nullableFields, ...(loaded.valueSchema === undefined ? {} : { valueSchema: loaded.valueSchema }) });
  const parent = await seedRow(store, CONVERSATION, { id: 'conversation', data: { title: 'Conversation' } });
  const prefix = options.empty ? [] : [message([refs[1], refs[0], refs[1]]), message()];
  const branch: StoredRow = { ...makeRow({ id: 'branch', data: { prefix, state: 'open' } }), parent: { model: CONVERSATION, id: parent.id } };
  await store.commit(makeBatch(await store.readRevision(), { writes: [{ kind: 'insert', model: BRANCH, row: branch }] }));
  let receipt: Receipt | undefined, executions = 0;
  const request = { store, memberships, identity, registry: loaded.registry, policy, readPolicies, app: APP,
    source: 'component', clock: { nowMs: () => FIXED_NOW }, envelope: makeEnvelope(OP, uuidv7(FIXED_NOW, ++sequence), {}),
    observeCommittedReceipt: (value: Receipt) => { receipt = value; } };
  const run = async (options: { facts?: readonly FinalizedFileObservation[]; omitFacts?: boolean; afterCapture?: () => Promise<void> | void } = {}) => invoke({ ...request,
    execute: async (call: AdmittedCall) => {
      executions++;
      const session = await beginScenarioReceiptMutation(call, store, { table, bounds: { maxRows: 10, maxWork: 1000 } });
      const row = await session.read(BRANCH, branch.id); assert.ok(row);
      await observeScenarioReceiptDependency(call, store, { dependencyId: 'prefix', model: BRANCH, row, field: 'prefix',
        ...(options.omitFacts ? {} : { files: options.facts ?? (prefix.length === 0 ? [] : [observe(refs[1]), observe(refs[0])]) }) });
      await session.stage({ op: 'update', model: BRANCH, id: branch.id, data: { state: 'counted' } }, { cause: 'scenario' });
      await options.afterCapture?.();
      selectScenarioReceiptReturn(call, store, 'count');
      return { ...await session.finalize(), result: String(prefix.length), outbox: [] };
    },
  });
  return { ...request, slice, branch, prefix, refs, receiver, observe, finish, blobs, access, run,
    setBeforeRevalidate: (hook?: () => Promise<void> | void) => { beforeRevalidate = hook; },
    receipt: () => { assert.ok(receipt); return receipt; }, executions: () => executions, revalidations: () => revalidations };
}

test('typed prefix retains ordered duplicate attachments with distinct authentic physical census and effect-free replay', async () => {
  const w = await world(); assert.equal((await w.run()).status, 'committed');
  const receipt = w.receipt(), association = readScenarioReceiptAssociation(receipt); assert.ok(association);
  const saved = association.observations.find(observation => observation.dependencyId === 'prefix'); assert.ok(saved);
  assert.deepEqual(saved.row.data.prefix, w.prefix); assert.equal(saved.files?.length, 2);
  assert.deepEqual(saved.files?.map(file => file.ref), [w.refs[1], w.refs[0]]);
  assert.equal((await projectScenarioReceipt({ ...w, receipt })).result, '2');
  const before = { revision: await w.store.readRevision(), history: await w.store.historyFor(BRANCH, w.branch.id), row: await w.store.load(BRANCH, w.branch.id) };
  assert.equal((await invokeRetainedReceiptOnly({ ...w, execute: async () => { throw new Error('Replay executed'); } })).status, 'replayed');
  assert.deepEqual({ revision: await w.store.readRevision(), history: await w.store.historyFor(BRANCH, w.branch.id), row: await w.store.load(BRANCH, w.branch.id) }, before);
  assert.equal(w.executions(), 1); assert.equal(before.history.length, 1);
});

test('declared empty prefix requires a receiving producer and explicit empty Files observations', async () => {
  const valid = await world({ empty: true }); assert.equal((await valid.run()).status, 'committed');
  const saved = readScenarioReceiptAssociation(valid.receipt())!.observations[0]!;
  assert.deepEqual(saved.row.data.prefix, []); assert.deepEqual(saved.files, []);
  assert.equal((await projectScenarioReceipt({ ...valid, receipt: valid.receipt() })).result, '0');
  const absent = await world({ empty: true, noProducer: true }); await assert.rejects(absent.run(), refuses);
  const omitted = await world({ empty: true }); await assert.rejects(omitted.run({ omitFacts: true }), refuses);
});

test('copied, missing, extra and foreign receiving observations cannot certify the stored prefix', async () => {
  for (const mode of ['copied', 'missing', 'extra', 'foreign'] as const) {
    const w = await world();
    const first = w.observe(w.refs[1]), second = w.observe(w.refs[0]);
    const facts = mode === 'copied' ? [structuredClone(first), second]
      : mode === 'missing' ? [first]
      : mode === 'extra' ? [first, second, w.observe(w.finish())]
      : [first, w.observe(w.finish({ ...w.receiver, principal: 'foreign' }), { ...w.receiver, principal: 'foreign' })];
    await assert.rejects(w.run({ facts }), refuses);
    assert.deepEqual(await w.store.load(BRANCH, w.branch.id), w.branch);
    assert.deepEqual(await w.store.historyFor(BRANCH, w.branch.id), []);
  }
});

test('whole prefix permission cannot be replaced by id-only or subfield grants, including empty prefix', async () => {
  for (const empty of [false, true]) for (const grant of ['id', 'subfield'] as const) {
    const w = await world({ empty, grant }); await assert.rejects(w.run(), refuses);
    assert.deepEqual(await w.store.load(BRANCH, w.branch.id), w.branch);
  }
});

test('late source/ancestor/Identity/physical Files loss rolls back every owning prefix effect', async () => {
  for (const mode of ['source', 'ancestor', 'identity', 'bytes'] as const) {
    const w = await world();
    await assert.rejects(w.run({ afterCapture: async () => {
      if (mode === 'source') w.access.prefix = false;
      if (mode === 'ancestor') w.access.ancestor = false;
      if (mode === 'identity') await w.memberships.removeMembership(w.identity.membership!.membership_id);
      if (mode === 'bytes') w.blobs.remove(blobKeyForFile(w.refs[0]));
    } }), refuses);
    assert.deepEqual(await w.store.load(BRANCH, w.branch.id), w.branch);
    assert.deepEqual(await w.store.historyFor(BRANCH, w.branch.id), []);
    assert.deepEqual(await w.store.outboxPending(), []);
  }
});

test('saved prefix count is withheld under current wholefield/ancestor/Identity/physical loss without body replay', async () => {
  for (const mode of ['source', 'ancestor', 'identity', 'bytes'] as const) {
    const w = await world(); assert.equal((await w.run()).status, 'committed');
    if (mode === 'source') w.access.prefix = false;
    if (mode === 'ancestor') w.access.ancestor = false;
    if (mode === 'identity') await w.memberships.removeMembership(w.identity.membership!.membership_id);
    if (mode === 'bytes') w.blobs.remove(blobKeyForFile(w.refs[0]));
    const before = { revision: await w.store.readRevision(), history: await w.store.historyFor(BRANCH, w.branch.id) };
    assert.deepEqual(await projectScenarioReceipt({ ...w, receipt: w.receipt() }), { result: null, records: [] });
    assert.deepEqual({ revision: await w.store.readRevision(), history: await w.store.historyFor(BRANCH, w.branch.id) }, before);
    assert.equal(w.executions(), 1);
  }
});

test('later valid prefix does not substitute current messages or Files for original saved count/evidence', async () => {
  const w = await world(); assert.equal((await w.run()).status, 'committed'); const receipt = w.receipt();
  const current = await w.store.load(BRANCH, w.branch.id); assert.ok(current);
  const later = [message([w.finish()])];
  await updateRow(w.store, BRANCH, current, { data: { ...current.data, prefix: later } });
  assert.equal((await projectScenarioReceipt({ ...w, receipt })).result, '2');
  assert.deepEqual(readScenarioReceiptAssociation(receipt)!.observations[0]!.row.data.prefix, w.prefix);
  w.blobs.remove(blobKeyForFile(w.refs[0]));
  assert.deepEqual(await projectScenarioReceipt({ ...w, receipt }), { result: null, records: [] });
  assert.equal(w.executions(), 1);
});

test('physical loss during awaited receiving revalidation cannot escape capture', async () => {
  const w = await world(); let removed = false;
  w.setBeforeRevalidate(() => { if (!removed) { removed = true; w.blobs.remove(blobKeyForFile(w.refs[0])); } });
  await assert.rejects(w.run(), refuses); assert.equal(removed, true);
  assert.deepEqual(await w.store.load(BRANCH, w.branch.id), w.branch);
  assert.deepEqual(await w.store.historyFor(BRANCH, w.branch.id), []);
});

test('saved empty protected prefix withholds when a genuine current same-nominal declaration removes File leaves', async () => {
  const w = await world({ empty: true }); assert.equal((await w.run()).status, 'committed');
  const receipt = w.receipt(), saved = readScenarioReceiptAssociation(receipt)!.observations[0]!;
  assert.deepEqual(saved.row.data.prefix, []); assert.deepEqual(saved.files, []);
  const currentSlice = structuredClone(w.slice);
  assert.ok(currentSlice.valueTypes!.contracts.some(contract => contract.name === 'std.TextMessage'));
  currentSlice.valueTypes = { ...currentSlice.valueTypes!, contracts: currentSlice.valueTypes!.contracts.map(contract =>
    contract.name === 'std.TextMessage' ? { ...contract, fields: contract.fields.filter(field => field.name !== 'attachments') } : contract) };
  const current = loadArtifactDescriptors(currentSlice, { by: 'members' });
  // The current File-free stored contract needs no protected File/reference
  // producer. Its empty wire remains structurally valid but cannot replace
  // the original protected declaration and receiving evidence.
  const before = { revision: await w.store.readRevision(), row: await w.store.load(BRANCH, w.branch.id),
    history: await w.store.historyFor(BRANCH, w.branch.id) };
  assert.deepEqual(await projectScenarioReceipt({ ...w, registry: current.registry, receipt }), { result: null, records: [] });
  assert.deepEqual({ revision: await w.store.readRevision(), row: await w.store.load(BRANCH, w.branch.id),
    history: await w.store.historyFor(BRANCH, w.branch.id) }, before);
  assert.equal(w.executions(), 1);
});
