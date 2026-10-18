import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ArtifactModel, CanTypeId, DomainWrite, FrameworkFilePayloadOrigin, FrameworkOpaqueDeclarationSet, FrameworkOpaqueValueDefault, InstalledFileReferenceInventory, ModelName, OutboxIntent, RecordVersion, RetainedFinalizedFile, StoredRow, WireValue } from '@canlang/contracts';
import { DELIVERY_RESULT_LEAVES } from '@canlang/contracts';
import { normalizeValueTypes } from '@canlang/values';
import { bindOpaqueFileDeclarations, resolveOpaqueFileProjection } from '../../src/storage/opaque-file-declarations.js';
import { STATE_FILE_REFERENCE_PRODUCER as producer } from '../../src/storage/index.js';
import { RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL, assertReceiptJoin, newAssociationRow, newReceiptRow, readReceiptRow, withReceiptRowData } from '../../src/receipt/tables.js';
import { FANOUT_NAVIGATION_MODEL, FANOUT_OWNER_SCAN_MODEL,
  stageFanoutNavigationWrite, stageFanoutOwnerScanWrite } from '../../src/fanout/navigation.js';
import { newFanoutIntentRow, newFanoutChildRow, fanoutChildRowId } from '../../src/fanout/tables.js';

import { stageAuthoredDelivery } from '../../src/receipt/authored-delivery.js';
import { createTestMemoryStorage } from '../../src/storage/memory.js';
import { asId, asModel, asOperation, asRevision, makeBatch } from '../invocation/fixtures.js';
import { finalizeProviderOutput, observeFinalizedFile, readFinalizedFileObservation } from '@canlang/files/finalize';
import { DEFAULT_FILE_POLICY } from '@canlang/files/upload';
import { TestOnlyCounterFileIds, TestOnlyCounterIntentIds, TestOnlyManualClock,
  TestOnlyMemoryBlobStore, TestOnlyMemoryFinalizedStore, TestOnlyMemoryIntentStore } from '@canlang/files/ports';


const meta = { nowMs: 100, actor: 'inventory-test' };
const validate = (model: string, row: StoredRow) => producer.validateRow(model as ModelName, row);
const stagedRow = (write: DomainWrite): StoredRow => {
  assert.notEqual(write.kind, 'remove');
  return (write as Extract<DomainWrite, { kind: 'insert' | 'update' }>).row;
};
function rows() {
  const association = newAssociationRow({ recordModel: 'App.Record', recordId: 'record/a', field: 'send',
    deliveryId: 'delivery/a', source: 'App.send', revision: 0 }, meta);
  const receipt = newReceiptRow({ deliveryId: 'delivery/a', revision: 0, status: 'succeeded',
    result: { nested: [{ file: 'opaque payload remains unchecked' }] }, error: null,
    contentRef: null, resultExpiresAtMs: null }, meta);
  const intent = newFanoutIntentRow({ sourceOccurrence: 'source/a', handler: 'App.each',
    cohort: 'model', members: ['record/a'] }, meta);
  const child = newFanoutChildRow({ fanoutId: intent.id, parentOccurrence: 'source/a',
    handler: 'App.each', recordId: 'record/a' }, meta);
  const navigation = stagedRow(stageFanoutNavigationWrite({ owner: 'owner/a', intentRow: intent,
    row: null, visitedChildRow: child, meta }));
  const scan = stagedRow(stageFanoutOwnerScanWrite({ owner: 'owner/a', row: null,
    visitedIntentRow: intent, meta }));
  return { association, receipt, navigation, scan };
}
const edited = (row: StoredRow, data: Record<string, unknown>): StoredRow => ({ ...row, data: { ...row.data, ...data } });

describe('State owning File inventory shape (never a File-free proof)', () => {
  it('covers genuine owning rows with frozen named declarations and opaque result and closed nullable owning receipt error', () => {
    const { association, receipt, navigation, scan } = rows();
    for (const [model, row] of [[RECEIPT_ASSOCIATION_MODEL, association], [RECEIPT_MODEL, receipt],
      [FANOUT_NAVIGATION_MODEL, navigation], [FANOUT_OWNER_SCAN_MODEL, scan]] as const) validate(model, row);
    assert.equal(Object.isFrozen(producer), true);
    assert.equal(Object.isFrozen(producer.models), true);
    assert.deepEqual(producer.models.map(model => model.source), [
      { package: '@canlang/state', module: 'receipt/tables', export: 'AssociationRowData' },
      { package: '@canlang/state', module: 'receipt/tables', export: 'ReceiptRowData' },
      { package: '@canlang/state', module: 'fanout/navigation', export: 'FanoutNavigationData' },
      { package: '@canlang/state', module: 'fanout/navigation', export: 'FanoutOwnerScanData' },
    ]);
    for (const model of producer.models) {
      assert.ok(Object.isFrozen(model) && Object.isFrozen(model.source) && Object.isFrozen(model.fields));
    }
    const fields = producer.models.find(model => model.model === RECEIPT_MODEL)!.fields;
    assert.deepEqual(fields.result, { kind: 'opaque', role: 'retained-result' });
    assert.deepEqual(fields.filePayloadOrigin, { kind: 'opaque', role: 'payload-origin', payloadField: 'result', optional: true });
    assert.deepEqual(fields.error, { kind: 'control', value: 'object', nullable: true,
      fields: { code: { kind: 'control', value: 'string' }, message: { kind: 'control', value: 'string' } } });
    assert.ok(Object.isFrozen(fields.error) && fields.error.kind === 'control' && fields.error.value === 'object' && Object.isFrozen(fields.error.fields));
    validate(RECEIPT_MODEL, newReceiptRow({ deliveryId: 'failed', revision: 1, status: 'failed',
      result: null, error: { code: 'error', message: 'detail' }, contentRef: 'retained/a',
      resultExpiresAtMs: 200 }, meta));
  });

  it('refuses unknown models, collisions with foreign shapes, closed-field drift and owning identity corruption', () => {
    const { association, receipt, navigation, scan } = rows();
    assert.throws(() => validate('work.receipt.extra', receipt));
    assert.throws(() => validate(RECEIPT_MODEL, association));
    assert.throws(() => validate(RECEIPT_ASSOCIATION_MODEL, receipt));
    assert.throws(() => validate(RECEIPT_ASSOCIATION_MODEL, edited(association, { injected: 'extra' })));
    assert.throws(() => validate(RECEIPT_MODEL, { ...receipt, id: association.id }));
    assert.throws(() => validate(RECEIPT_MODEL, edited(receipt, { status: 'pending' })));
    assert.throws(() => validate(RECEIPT_MODEL, edited(receipt, { resultExpiresAtMs: -1 })));
    const failed = newReceiptRow({ deliveryId: 'closed-error', revision: 1, status: 'failed', result: null,
      error: { code: 'error', message: 'detail' }, contentRef: null, resultExpiresAtMs: null }, meta);
    for (const error of [ 'text', [], {}, { code: 'error' }, { message: 'detail' },
      { code: 'error', message: 1 }, { code: 'error', message: { id: 'file-like' } },
      { code: 'error', message: 'detail', extra: 'field' } ]) assert.throws(() => validate(RECEIPT_MODEL, edited(failed, { error })));
    let errorReads = 0;
    const accessor = { code: 'error' };
    Object.defineProperty(accessor, 'message', { enumerable: true, get() { errorReads++; return 'detail'; } });
    assert.throws(() => validate(RECEIPT_MODEL, edited(failed, { error: accessor })));
    assert.equal(errorReads, 0);
    assert.throws(() => validate(RECEIPT_MODEL, { ...receipt, unexpected: true } as StoredRow));
    assert.throws(() => validate(FANOUT_NAVIGATION_MODEL, scan));
    assert.throws(() => validate(FANOUT_NAVIGATION_MODEL, edited(navigation, { cohort: 'other' })));
    assert.throws(() => validate(FANOUT_NAVIGATION_MODEL, edited(navigation, { intentVersion: 0 })));
    assert.throws(() => validate(FANOUT_NAVIGATION_MODEL, edited(navigation, { fanoutId: 'foreign' })));
    assert.throws(() => validate(FANOUT_NAVIGATION_MODEL, edited(navigation, {
      lastVisitedChildId: fanoutChildRowId('other', 'App.each', 'record/a') })));
    assert.throws(() => validate(FANOUT_NAVIGATION_MODEL, edited(navigation, {
      lastVisitedChildId: 'fanout-child/v1/source%2fa/App.each/record%2Fa' })));
    assert.throws(() => validate(FANOUT_OWNER_SCAN_MODEL, edited(scan, { lastVisitedIntentId: 'foreign' })));
    assert.throws(() => validate(FANOUT_OWNER_SCAN_MODEL, edited(scan, { owner: 'other' })));
    // Intrinsic validation cannot prove retained membership or an exact retained intent version.
    validate(FANOUT_NAVIGATION_MODEL, edited(navigation, { intentVersion: 42,
      lastVisitedChildId: fanoutChildRowId('source/a', 'App.each', 'not-retained') }));
    validate(RECEIPT_MODEL, { ...receipt, archivedAt: 200 });
  });

  it('detaches bounded own JSON without invoking accessors and refuses malformed envelopes', () => {
    const { receipt, navigation } = rows();
    let reads = 0;
    const data = { ...receipt.data };
    Object.defineProperty(data, 'result', { enumerable: true, get() { reads++; return null; } });
    assert.throws(() => validate(RECEIPT_MODEL, { ...receipt, data }));
    assert.equal(reads, 0);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const result of [cyclic, new Date(), [undefined], Array(1), NaN,
      Object.assign([], { extra: 'foreign' }), { [Symbol('hidden')]: true }]) {
      assert.throws(() => validate(RECEIPT_MODEL, edited(receipt, { result })));
    }
    let deep: unknown = null;
    for (let index = 0; index < 35; index++) deep = { child: deep };
    assert.throws(() => validate(RECEIPT_MODEL, edited(receipt, { result: deep })));
    assert.throws(() => validate(RECEIPT_MODEL, edited(receipt, { result: Array(20_001).fill(null) })));
    assert.throws(() => validate(RECEIPT_MODEL, { ...receipt, version: 0 as RecordVersion }));
    assert.throws(() => validate(RECEIPT_MODEL, { ...receipt, parent: { model: 'App.Record', id: 'a', extra: true } } as unknown as StoredRow));
    assert.throws(() => validate(FANOUT_NAVIGATION_MODEL, { ...navigation, archivedAt: 200 }));
    const omitted = { ...receipt }; delete (omitted as { parent?: unknown }).parent;
    validate(RECEIPT_MODEL, omitted);
  });
});

// These structural fixtures exercise nongrant persistence only. They neither
// install a declaration set nor authenticate a source or native File admission.

const deliveryTarget = 'std.EmailV1.send';
const deliveryDescriptor = { kind: 'delivery' as const, capability: 'std.EmailV1', operation: 'send', version: 1,
  result: { name: 'EmailSend', fields: [] } };
const boundModel: ArtifactModel = { name: 'App.Record', deleteMode: 'none', fields: [
  { name: 'send', field: deliveryDescriptor, nullable: true, required: false, serverOnly: false },
] };
const queuedIntent: OutboxIntent = { intentId: 'delivery/a', operation: asOperation('App.send'),
  operationId: 'operation/a' as OutboxIntent['operationId'], target: deliveryTarget,
  arguments: { binding: 'email', from: 'app', arguments: {} }, occurrenceIndex: 0 };
function receiptBinding(files: FrameworkFilePayloadOrigin['files'] = []): FrameworkFilePayloadOrigin {
  const caller = { name: asOperation('App.send'), kind: 'scenario' as const,
    result: { type: 'void' as CanTypeId } };
  return { version: 1, inventory: { owner: 'App', snapshotId: 'snapshot/original', digest: 'digest/original' },
    declarationSetId: 'declarations/original',
    slot: { model: asModel(RECEIPT_MODEL), id: asId('delivery/a'), created: meta.nowMs, createdBy: meta.actor,
      field: 'result', role: 'retained-result' },
    scope: { app: 'app', ownerPackage: 'App', owner: 'owner/a' },
    origin: { kind: 'delivery-result', deliveryId: 'delivery/a', intent: { intentId: queuedIntent.intentId,
      operation: queuedIntent.operation, operationId: queuedIntent.operationId, target: queuedIntent.target,
      occurrenceIndex: queuedIntent.occurrenceIndex }, request: { binding: 'email', from: 'app' },
      caller: { source: { path: 'app.can', sha256: '0'.repeat(64), module: 'app.js' },
        callable: { id: 'App.send', kind: 'operation', module: 'app.js', export: 'send', member: ['send'] },
        canonical: { ...caller, inputs: [] }, artifact: { ...caller, description: '', inputs: { fields: [] } },
        resultDeclarationId: 'caller/void' },
      association: { model: asModel('App.Record'), recordId: asId('record/a'), field: 'send' },
      declaration: { kind: 'capability', canonical: deliveryDescriptor, artifact: deliveryDescriptor },
      resultDeclarationId: 'email/result' }, files };
}
const pendingData = () => ({ deliveryId: 'delivery/a', revision: 0, status: 'pending' as const, result: null,
  error: null, contentRef: null, resultExpiresAtMs: null });
const boundAssociation = () => newAssociationRow({ recordModel: 'App.Record', recordId: 'record/a', field: 'send',
  deliveryId: 'delivery/a', source: deliveryTarget, revision: 0 }, meta);

function genuineReceiptFile(): { facts: RetainedFinalizedFile; clock: TestOnlyManualClock; observe: () => unknown } {
  const clock = new TestOnlyManualClock(meta.nowMs), blobs = new TestOnlyMemoryBlobStore();
  const intents = new TestOnlyMemoryIntentStore(), files = new TestOnlyMemoryFinalizedStore();
  const receiver = { app: 'app', team: 'team/a', owner: 'owner/a', principal: 'recipient/a' };
  const upload = { clock, blobs, intents, intentIds: new TestOnlyCounterIntentIds(), policy: DEFAULT_FILE_POLICY,
    intentTtlMs: 60_000, urlBase: 'https://example.test' };
  const finalize = { clock, blobs, intents, files, fileIds: new TestOnlyCounterFileIds() };
  const result = finalizeProviderOutput(upload, finalize, { receiver,
    binding: { adapter: 'email', deliveryId: 'delivery/a', resultPath: 'attachment' }, operation: deliveryTarget,
    field: '/attachment', args: {}, name: 'receipt.txt', claimedType: 'text/plain', bytes: new TextEncoder().encode('receipt') });
  assert.equal(result.status, 'finalized');
  if (result.status !== 'finalized') throw new Error('File fixture did not finalize');
  const observe = () => observeFinalizedFile(finalize, result.file.id, receiver,
    { policy: DEFAULT_FILE_POLICY, retention: { unattachedHorizonMs: 1_000, retentionMs: 2_000 } });
  const facts = readFinalizedFileObservation(observe());
  assert.ok(facts);
  return { facts, clock, observe };
}

describe('receipt original opaque-origin persistence (nongrant compatibility)', () => {
  it('detaches the input and reader metadata, keeps it outside the public receipt, and refuses hostile own JSON', () => {
    const original = receiptBinding();
    const row = newReceiptRow({ ...pendingData(), filePayloadOrigin: original }, meta);
    (original.inventory as { snapshotId: string }).snapshotId = 'mutated';
    const read = readReceiptRow(row);
    assert.equal(read.filePayloadOrigin!.inventory.snapshotId, 'snapshot/original');
    assert.equal(Object.hasOwn(read.receipt, 'filePayloadOrigin'), false);
    (read.filePayloadOrigin!.scope as { owner: string }).owner = 'mutated reader';
    assert.equal(readReceiptRow(row).filePayloadOrigin!.scope.owner, 'owner/a');
    let reads = 0;
    const accessor = receiptBinding();
    Object.defineProperty(accessor, 'scope', { enumerable: true, get() { reads++; return {}; } });
    assert.throws(() => newReceiptRow({ ...pendingData(), filePayloadOrigin: accessor }, meta));
    assert.equal(reads, 0);
    for (const origin of [null, undefined, { ...receiptBinding(), extra: true },
      { ...receiptBinding(), files: Array(1) }, { ...receiptBinding(), scope: new Date() },
      { ...receiptBinding(), scope: { app: 'app', owner: 'a', ownerPackage: 'App', [Symbol('extra')]: true } }]) {
      assert.throws(() => newReceiptRow({ ...pendingData(), filePayloadOrigin: origin as FrameworkFilePayloadOrigin }, meta));
    }
    const inherited = Object.create({ filePayloadOrigin: receiptBinding() }) as object;
    Object.assign(inherited, pendingData());
    assert.throws(() => newReceiptRow(inherited as ReturnType<typeof pendingData>, meta));
  });

  it('preserves original genuine facts through progress, JSON replay, expiry, and current association removal', async () => {
    const observed = genuineReceiptFile();
    const original = receiptBinding([{ path: ['attachment'], file: observed.facts }]);
    const birth = newReceiptRow({ ...pendingData(), filePayloadOrigin: receiptBinding() }, meta);
    const progress = withReceiptRowData(birth, { ...pendingData(), revision: 1, status: 'succeeded',
      result: { attachment: { id: observed.facts.ref } }, contentRef: 'content/a', resultExpiresAtMs: 1_100,
      filePayloadOrigin: original },
      { nowMs: 200, actor: 'progress/actor' });
    const { store } = createTestMemoryStorage();
    await store.commit(makeBatch(0, { writes: [ { kind: 'insert', model: asModel(RECEIPT_MODEL), row: birth } ] }));
    await store.commit(makeBatch(1, { writes: [ { kind: 'update', model: asModel(RECEIPT_MODEL), id: birth.id,
      expectedVersion: birth.version, row: progress } ] }));
    const replay = await store.load(asModel(RECEIPT_MODEL), asId('delivery/a'));
    assert.ok(replay);
    assert.deepEqual(readReceiptRow(replay).filePayloadOrigin, original);
    observed.clock.setNowMs(2_100);
    assert.equal(observed.observe(), null);
    const expired = withReceiptRowData(replay, { ...pendingData(), revision: 2, status: 'succeeded', result: null },
      { nowMs: 2_100, actor: 'expiry/actor' });
    assert.deepEqual(readReceiptRow(expired).filePayloadOrigin, original);
    const association = boundAssociation();
    const removed = await stageAuthoredDelivery({ model: boundModel, recordId: 'record/a', field: 'send', value: null,
      queued: new Map(), operationId: 'operation/clear', revision: 2 }, { actor: meta.actor, now: 2_100,
      operation: 'App.send', load: async model => model === RECEIPT_ASSOCIATION_MODEL ?
        { ...association, data: { ...association.data, revision: 2 } } : expired, query: store.query });
    assert.equal(removed.writes!.length, 1);
    assert.equal(removed.writes![0]!.kind, 'remove');
    assert.deepEqual(readReceiptRow(expired).filePayloadOrigin, original);
  });

  it('refuses copied lifetimes, replacement source bindings and renewed File horizons, while preserving explicit original facts', () => {
    const observed = genuineReceiptFile(), original = receiptBinding([{ path: ['attachment'], file: observed.facts }]);
    const birth = newReceiptRow({ ...pendingData(), filePayloadOrigin: original }, meta);
    assert.throws(() => newReceiptRow({ ...pendingData(), deliveryId: 'delivery/other', filePayloadOrigin: original }, meta));
    assert.throws(() => newReceiptRow({ ...pendingData(), filePayloadOrigin: original }, { ...meta, nowMs: 101 }));
    for (const changed of [ { ...original, declarationSetId: 'different' },
      { ...original, inventory: { ...original.inventory, digest: 'current' } },
      { ...original, scope: { ...original.scope, owner: 'other' } },
      { ...original, origin: { ...original.origin, caller: { ...(original.origin as Extract<FrameworkFilePayloadOrigin['origin'],
        { kind: 'delivery-result' }>).caller, source: { path: 'different.can', sha256: '1'.repeat(64), module: 'app.js' } } } } ]) {
      assert.throws(() => withReceiptRowData(birth, { ...pendingData(), revision: 1,
        filePayloadOrigin: changed as FrameworkFilePayloadOrigin }, { ...meta, nowMs: 200 }));
    }
    const renewed = structuredClone(original);
    (renewed.files[0]!.file.retention as { retentionMs: number }).retentionMs++;
    assert.throws(() => withReceiptRowData(birth, { ...pendingData(), revision: 1, filePayloadOrigin: renewed }, meta));
    const codec = JSON.parse(JSON.stringify(original)) as FrameworkFilePayloadOrigin;
    const progress = withReceiptRowData(birth, { ...pendingData(), revision: 1, status: 'succeeded',
      result: { attachment: { id: observed.facts.ref } }, filePayloadOrigin: codec }, meta);
    assert.deepEqual(readReceiptRow(progress).filePayloadOrigin, original);
    assert.throws(() => withReceiptRowData(newReceiptRow(pendingData(), meta),
      { ...pendingData(), revision: 1, filePayloadOrigin: original }, meta));
    const mismatch = withReceiptRowData(progress, { ...pendingData(), revision: 2, status: 'succeeded',
      result: { different: true } }, meta);
    assert.deepEqual(readReceiptRow(mismatch).filePayloadOrigin, original);
    // Persistence keeps the evidence; complete census must refuse the changed typed correspondence.
  });

  it('retains legacy pending, failed, skipped and genuinely null/void receipt semantics', () => {
    for (const status of ['pending', 'failed', 'skipped', 'succeeded'] as const) {
      const data = { ...pendingData(), status, error: status === 'failed' ? { code: 'failed', message: 'detail' } : null };
      const bound = readReceiptRow(newReceiptRow({ ...data, filePayloadOrigin: receiptBinding() }, meta));
      const legacy = readReceiptRow(newReceiptRow(data, meta));
      assert.deepEqual(bound.receipt, legacy.receipt);
      assert.equal(bound.receipt.result, null);
      assert.equal(Object.hasOwn(legacy, 'filePayloadOrigin'), false);
    }
  });

  it('snapshots new authored metadata before awaiting readers and checks actual queued and association identities', async () => {
    const { store } = createTestMemoryStorage();
    let release!: () => void;
    const pause = new Promise<void>(resolve => { release = resolve; });
    const original = receiptBinding();
    const input = { model: boundModel, recordId: 'record/a', field: 'send',
      value: { kind: 'delivery' as const, id: 'delivery/a', operation: deliveryTarget }, queued: new Map([[queuedIntent.intentId, queuedIntent]]),
      operationId: queuedIntent.operationId, revision: 0, filePayloadOrigin: original };
    const context = { actor: meta.actor, now: meta.nowMs, operation: 'App.send',
      load: async () => { await pause; return null; }, query: store.query };
    const staging = stageAuthoredDelivery(input, context);
    (original.inventory as { snapshotId: string }).snapshotId = 'mutated during await';
    release();
    const staged = await staging;
    const receipt = stagedRow(staged.writes![1]!);
    assert.equal(readReceiptRow(receipt).filePayloadOrigin!.inventory.snapshotId, 'snapshot/original');
    assertReceiptJoin(makeBatch(0, { writes: staged.writes! }));
    const alien = receiptBinding();
    Object.assign(alien.origin, { association: { model: asModel('App.Record'), recordId: asId('other'), field: 'send' } });
    await assert.rejects(stageAuthoredDelivery({ ...input, filePayloadOrigin: alien }, context));
    const queuedMismatch = receiptBinding();
    const originalIntent = (queuedMismatch.origin as Extract<FrameworkFilePayloadOrigin['origin'], { kind: 'delivery-result' }>).intent;
    Object.assign(queuedMismatch.origin, { intent: { ...originalIntent, occurrenceIndex: 1 } });
    await assert.rejects(stageAuthoredDelivery({ ...input, filePayloadOrigin: queuedMismatch }, context));
    await assert.rejects(stageAuthoredDelivery({ ...input, filePayloadOrigin: receiptBinding() }, { ...context, now: 101 }));
    const association = boundAssociation();
    const wrongAssociation = { ...association, id: asId('receipt-assoc/v1/App.Record/other/send'),
      data: { ...association.data, recordId: 'other' } };
    assert.throws(() => assertReceiptJoin(makeBatch(0, { writes: [
      { kind: 'insert', model: asModel(RECEIPT_ASSOCIATION_MODEL), row: wrongAssociation },
      { kind: 'insert', model: asModel(RECEIPT_MODEL), row: receipt },
    ] })));
  });
});

/** Only the pure owning resolver is exercised here. These DTOs are deliberately
 * not installed: actual source/profile admission and guarded census are separate
 * qualification, and accepting a projection supplies no native File authority. */
function resolverInstalled(binding: FrameworkFilePayloadOrigin, providerVoid = false): InstalledFileReferenceInventory {
  assert.equal(binding.origin.kind, 'delivery-result');
  if (binding.origin.kind !== 'delivery-result') throw new Error('wrong fixture');
  const origin = binding.origin;
  const originalSnapshot = { ...binding.inventory, installedRevision: asRevision(0), installedAt: meta.nowMs };
  const set: FrameworkOpaqueDeclarationSet = { id: binding.declarationSetId, inventory: binding.inventory,
    snapshot: originalSnapshot, sources: [], valueTypes: { contracts: [] }, originalContracts: {}, valueDefaults: [],
    canonicalModels: [{ name: origin.association.model, deleteMode: 'none', fields: {
      [origin.association.field]: { required: false, serverOnly: false, nullable: true, delivery: origin.declaration.canonical },
    } }],
    artifactModels: [{ name: origin.association.model, deleteMode: 'none', fields: [
      { name: origin.association.field, required: false, serverOnly: false, nullable: true, field: origin.declaration.artifact },
    ] }],
    declarations: [
      { id: origin.resultDeclarationId,
        source: { kind: 'delivery', source: origin.caller.source, context: origin.declaration },
        profile: providerVoid ? { kind: 'void', canonical: { type: 'void' }, artifact: { type: 'void' } } :
          { kind: 'provider-result', canonical: origin.declaration.canonical.result, artifact: origin.declaration.artifact.result } },
      { id: origin.caller.resultDeclarationId,
        source: { kind: 'callable', source: origin.caller.source, callable: origin.caller.callable },
        profile: { kind: 'void', canonical: { type: 'void' }, artifact: { type: 'void' } } },
    ] };
  return { authority: { app: binding.scope.app, stateOwner: binding.inventory.owner,
    stateStoreId: 'structural/state', fileStoreId: 'structural/files',
    receiver: { app: binding.scope.app, team: 'team/a', owner: binding.scope.owner } },
    snapshot: { owner: binding.inventory.owner, snapshotId: 'snapshot/current', digest: 'digest/current',
      installedRevision: asRevision(5), installedAt: 500 },
    inventory: { owner: binding.inventory.owner, snapshotId: 'snapshot/current', digest: 'digest/current',
      canonicalModels: set.canonicalModels, artifactModels: set.artifactModels, valueTypes: set.valueTypes,
      frameworkModels: producer.models, opaqueDeclarationSets: [set] } };
}
function resolveReceipt(row: StoredRow, installed: InstalledFileReferenceInventory, binding: FrameworkFilePayloadOrigin) {
  return producer.resolveOpaqueField!(asModel(RECEIPT_MODEL), row, 'result', { installed, binding });
}

function generationProfileFixture(source = 'business/a', revision = '0') {
  const binding = receiptBinding();
  assert.equal(binding.origin.kind, 'delivery-result');
  if (binding.origin.kind !== 'delivery-result') throw new Error('wrong fixture');
  const descriptor = { kind: 'delivery' as const, capability: 'std.TextGenerationV1', operation: 'generate', version: 1,
    result: { name: 'TextRun', fields: DELIVERY_RESULT_LEAVES.TextRun!.map(leaf => ({ ...leaf })) } };
  const request = { source, revision };
  if (source !== 'business/a') {
    Object.assign(binding.slot, { id: asId('delivery/b') });
    Object.assign(binding.origin, { deliveryId: 'delivery/b', intent: { ...binding.origin.intent,
      intentId: 'delivery/b', operationId: 'operation/b' } });
  }
  Object.assign(binding.origin, { intent: { ...binding.origin.intent, target: 'std.TextGenerationV1.generate' },
    declaration: { kind: 'generation', canonical: descriptor, artifact: descriptor, request }, resultDeclarationId: 'text/result' });
  const installed = resolverInstalled(binding);
  const set = installed.inventory.opaqueDeclarationSets![0]!;
  Object.assign(set, { sources: [{ path: binding.origin.caller.source.path, sha256: binding.origin.caller.source.sha256 }],
    valueTypes: structuredClone(normalizeValueTypes({ contracts: [descriptor.result] }).valueTypes),
    originalContracts: { TextRun: { fields: Object.fromEntries(descriptor.result.fields.map(field =>
      [field.name, { type: field.type }])) } } });
  Object.assign(set, { declarations: [...set.declarations, { id: 'caller/inputs',
    source: { kind: 'callable', source: binding.origin.caller.source, callable: binding.origin.caller.callable },
    profile: { kind: 'inputs', canonical: binding.origin.caller.canonical.inputs, artifact: binding.origin.caller.artifact.inputs.fields } }] });
  Object.assign(set.declarations[0]!.source, { context: { kind: 'generation-profile', canonical: descriptor, artifact: descriptor } });
  Object.assign(installed.inventory, { valueTypes: set.valueTypes });
  const context = { source: 'std.TextGenerationV1.generate', declaredResult: descriptor.result, request };
  const result = (state: 'queued' | 'unknown') => ({ source, revision, sequence: '0', state,
    content: '', used_tokens: null, detail: null });
  return { binding, installed, set, context, result };
}

describe('State receipt owning opaque resolver (structural, not install/census qualification)', () => {
  it('keeps legacy shape validation compatible but requires the exact original header for projection', () => {
    const legacy = newReceiptRow(pendingData(), meta), binding = receiptBinding();
    const installed = resolverInstalled(binding);
    validate(RECEIPT_MODEL, legacy);
    assert.throws(() => resolveReceipt(legacy, installed, binding));
    const row = newReceiptRow({ ...pendingData(), filePayloadOrigin: binding }, meta);
    validate(RECEIPT_MODEL, row);
    const projection = resolveReceipt(row, installed, binding);
    assert.deepEqual(projection.values, [{ path: [], kind: 'result', declarationId: 'email/result', presence: 'no-result' }]);
    assert.notEqual(projection.binding, row.data.filePayloadOrigin);
    assert.notEqual(projection.binding, binding);
    assert.throws(() => producer.resolveOpaqueField!(asModel(RECEIPT_MODEL), row, 'filePayloadOrigin', { installed, binding }));
    assert.throws(() => producer.resolveOpaqueField!(asModel(RECEIPT_ASSOCIATION_MODEL), row, 'result', { installed, binding }));
  });

  it('uses original historical provider declarations and actual null/value phase semantics', () => {
    const binding = receiptBinding(), installed = resolverInstalled(binding);
    for (const status of ['pending', 'failed', 'skipped', 'unknown'] as const) {
      const row = newReceiptRow({ ...pendingData(), status, filePayloadOrigin: binding,
        error: status === 'failed' ? { code: 'failed', message: 'detail' } : null }, meta);
      assert.deepEqual(resolveReceipt(row, installed, binding).values,
        [{ path: [], kind: 'result', declarationId: 'email/result', presence: 'no-result' }]);
    }
    const result = newReceiptRow({ ...pendingData(), status: 'succeeded', result: {}, filePayloadOrigin: binding }, meta);
    assert.deepEqual(resolveReceipt(result, installed, binding).values,
      [{ path: [], kind: 'result', declarationId: 'email/result', presence: 'value' }]);
    const missing = newReceiptRow({ ...pendingData(), status: 'succeeded', filePayloadOrigin: binding }, meta);
    assert.throws(() => resolveReceipt(missing, installed, binding));
    const absent = structuredClone(installed);
    delete (absent.inventory as { opaqueDeclarationSets?: unknown }).opaqueDeclarationSets;
    assert.throws(() => resolveReceipt(result, absent, binding));
    const noOriginal = structuredClone(installed);
    Object.assign(noOriginal.inventory.opaqueDeclarationSets![0]!, { id: 'current/declarations' });
    assert.throws(() => resolveReceipt(result, noOriginal, binding));
    // The ABI carries explicit void profiles; genuine source admission must
    // independently prove that the provider declaration actually declares void.
    assert.deepEqual(resolveReceipt(missing, resolverInstalled(binding, true), binding).values,
      [{ path: [], kind: 'result', declarationId: 'email/result', presence: 'no-result' }]);
  });

  it('selects typed value projection for actual original TextRun pending and unknown snapshots', () => {
    const binding = receiptBinding();
    const origin = binding.origin as Extract<FrameworkFilePayloadOrigin['origin'], { kind: 'delivery-result' }>;
    const descriptor = { kind: 'delivery' as const, capability: 'std.TextGenerationV1', operation: 'generate', version: 1,
      result: { name: 'TextRun', fields: DELIVERY_RESULT_LEAVES.TextRun!.map(leaf => ({ ...leaf })) } };
    const request = { source: 'business/a', revision: '0' };
    Object.assign(origin, { intent: { ...origin.intent, target: 'std.TextGenerationV1.generate' },
      declaration: { kind: 'generation', canonical: descriptor, artifact: descriptor, request }, resultDeclarationId: 'text/result' });
    const installed = resolverInstalled(binding);
    for (const [status, state] of [['pending', 'queued'], ['unknown', 'unknown']] as const) {
      const row = newReceiptRow({ ...pendingData(), status,
        result: { source: 'business/a', revision: '0', sequence: '0', state, content: '', used_tokens: null, detail: null },
        filePayloadOrigin: binding }, meta, { source: 'std.TextGenerationV1.generate', declaredResult: descriptor.result, request });
      validate(RECEIPT_MODEL, row);
      assert.deepEqual(resolveReceipt(row, installed, binding).values,
        [{ path: [], kind: 'result', declarationId: 'text/result', presence: 'value' }]);
      assert.throws(() => resolveReceipt(edited(row, { result: { ...row.data.result as object, source: 'business/other' } }), installed, binding));
    }
  });

  it('resolves independently bound Generation requests against one genuinely installed static TextRun profile', async () => {
    const first = generationProfileFixture();
    const { store } = createTestMemoryStorage(first.installed.authority, [producer]);
    await store.installFileReferenceInventory({ expectedRevision: await store.readRevision(), ...first.installed });
    const installed = await store.readFileReferenceInventory(first.binding.inventory.owner);
    assert.ok(installed);
    const bound = bindOpaqueFileDeclarations(installed.inventory.opaqueDeclarationSets!, () => {}).get(first.set.id)!;
    for (const fixture of [first, generationProfileFixture('business/b', '7')]) {
      for (const [status, state] of [['pending', 'queued'], ['unknown', 'unknown']] as const) {
        const row = newReceiptRow({ ...pendingData(), deliveryId: fixture.binding.slot.id, status, result: fixture.result(state), filePayloadOrigin: fixture.binding }, meta, fixture.context);
        validate(RECEIPT_MODEL, row);
        const resolved = resolveReceipt(row, installed, fixture.binding);
        assert.deepEqual(resolved.binding, fixture.binding);
        assert.deepEqual(resolved.values, [{ path: [], kind: 'result', declarationId: 'text/result', presence: 'value' }]);
        assert.deepEqual(resolveOpaqueFileProjection(bound, resolved.values[0]!, row.data.result, resolved.binding), []);
        assert.throws(() => resolveOpaqueFileProjection(bound, resolved.values[0]!, row.data.result));
        for (const change of [{ source: 'business/foreign' }, { revision: '8' }, { revision: '00' },
          { state: 'invented' }, { detail: { file: { id: 'foreign-file' } } }, { extra: true }]) {
          const result = { ...row.data.result as object, ...change };
          assert.throws(() => resolveReceipt(edited(row, { result }), installed, fixture.binding));
          assert.throws(() => resolveOpaqueFileProjection(bound, resolved.values[0]!, result, resolved.binding));
        }
      }
      for (const status of ['pending', 'unknown', 'skipped'] as const) {
        const row = newReceiptRow({ ...pendingData(), deliveryId: fixture.binding.slot.id, status, filePayloadOrigin: fixture.binding }, meta, fixture.context);
        const resolved = resolveReceipt(row, installed, fixture.binding);
        assert.deepEqual(resolved.values, [{ path: [], kind: 'result', declarationId: 'text/result', presence: 'no-result' }]);
        assert.deepEqual(resolveOpaqueFileProjection(bound, resolved.values[0]!, null, resolved.binding), []);
        // Static ownership still requires the original header before a null shortcut.
        assert.throws(() => resolveOpaqueFileProjection(bound, resolved.values[0]!, null));
      }
    }
  });

  it('refuses Generation profile/runtime substitution and malformed original request identities', () => {
    const fixture = generationProfileFixture();
    const { binding, installed, set } = fixture;
    const bound = bindOpaqueFileDeclarations([set], () => {}).get(set.id)!;
    const row = newReceiptRow({ ...pendingData(), result: fixture.result('queued'), filePayloadOrigin: binding }, meta, fixture.context);
    const projection = { path: [], kind: 'result' as const, declarationId: 'text/result', presence: 'value' as const };
    const alterations: Array<(changed: FrameworkFilePayloadOrigin) => void> = [
      changed => Object.assign(changed.origin, { resultDeclarationId: 'foreign/result' }),
      changed => Object.assign(changed.inventory, { snapshotId: 'foreign/snapshot' }),
      changed => {
        if (changed.origin.kind === 'delivery-result') Object.assign(changed.origin.caller.source, { sha256: '1'.repeat(64) });
      },
      changed => {
        if (changed.origin.kind === 'delivery-result') Object.assign(changed.origin.declaration, { kind: 'generation-profile' });
      },
      changed => {
        if (changed.origin.kind === 'delivery-result') Object.assign(changed.origin.declaration, { request: { source: 'business/a', revision: '-1' } });
      },
      changed => {
        if (changed.origin.kind === 'delivery-result') Object.assign(changed.origin.declaration, { request: { source: 'business/a', revision: '00' } });
      },
      changed => {
        if (changed.origin.kind === 'delivery-result') Object.assign(changed.origin.declaration, { request: { source: '', revision: '0' } });
      },
      changed => {
        if (changed.origin.kind === 'delivery-result') Object.assign(changed.origin.declaration, { canonical: { ...changed.origin.declaration.canonical, version: 2 } });
      },
    ];
    for (const alter of alterations) {
      const changed = structuredClone(binding); alter(changed);
      assert.throws(() => resolveReceipt(row, installed, changed));
      assert.throws(() => resolveReceipt(edited(row, { filePayloadOrigin: changed }), installed, changed));
      assert.throws(() => resolveOpaqueFileProjection(bound, projection, row.data.result, changed));
      assert.throws(() => resolveOpaqueFileProjection(bound, { ...projection, presence: 'no-result' }, null, changed));
    }
    for (const alter of [
      (changed: FrameworkFilePayloadOrigin) => Object.assign(changed.slot, { id: asId('foreign/delivery') }),
      (changed: FrameworkFilePayloadOrigin) => Object.assign(changed.scope, { owner: 'foreign/owner' }),
      (changed: FrameworkFilePayloadOrigin) => {
        if (changed.origin.kind === 'delivery-result') Object.assign(changed.origin.request, { binding: 'foreign-binding' });
      },
      (changed: FrameworkFilePayloadOrigin) => {
        if (changed.origin.kind === 'delivery-result') Object.assign(changed.origin.request, { from: 'foreign-from' });
      },
    ]) {
      const changed = structuredClone(binding); alter(changed);
      assert.throws(() => resolveReceipt(row, installed, changed));
    }
    assert.throws(() => resolveOpaqueFileProjection(bound, { ...projection, declarationId: 'caller/void' }, row.data.result, binding));
    const runtimeInstalled = structuredClone(set);
    if (binding.origin.kind === 'delivery-result') Object.assign(runtimeInstalled.declarations[0]!.source, { context: binding.origin.declaration });
    const runtimeBound = bindOpaqueFileDeclarations([runtimeInstalled], () => {}).get(set.id)!;
    const other = generationProfileFixture('business/b', '7');
    assert.throws(() => resolveOpaqueFileProjection(runtimeBound, projection, other.result('queued'), other.binding));
    let reads = 0;
    const accessor = structuredClone(binding);
    Object.defineProperty(accessor, 'scope', { enumerable: true, get() { reads++; return binding.scope; } });
    assert.throws(() => resolveOpaqueFileProjection(bound, projection, row.data.result, accessor));
    assert.equal(reads, 0);
  });

  it('refuses lifetime, scope, intent, provider, caller and association drift without current-schema substitution', () => {
    const binding = receiptBinding(), installed = resolverInstalled(binding);
    const row = newReceiptRow({ ...pendingData(), filePayloadOrigin: binding }, meta);
    assert.throws(() => resolveReceipt({ ...row, created: row.created + 1 }, installed, binding));
    assert.throws(() => resolveReceipt({ ...row, createdBy: 'different' }, installed, binding));
    const other = receiptBinding();
    Object.assign(other.scope, { owner: 'other' });
    assert.throws(() => resolveReceipt(row, installed, other));
    assert.throws(() => resolveReceipt(edited(row, { filePayloadOrigin: other }), installed, other));
    const intent = receiptBinding();
    Object.assign((intent.origin as Extract<FrameworkFilePayloadOrigin['origin'], { kind: 'delivery-result' }>).intent,
      { intentId: 'delivery/other' });
    assert.throws(() => resolveReceipt(edited(row, { filePayloadOrigin: intent }), installed, intent));
    for (const alter of [
      (set: FrameworkOpaqueDeclarationSet) => Object.assign(set.declarations[0]!, { id: 'other/result' }),
      (set: FrameworkOpaqueDeclarationSet) => Object.assign(set.declarations[0]!.source, { context: { kind: 'capability',
        canonical: { ...deliveryDescriptor, version: 2 }, artifact: deliveryDescriptor } }),
      (set: FrameworkOpaqueDeclarationSet) => Object.assign(set.declarations[1]!.source, { source: { path: 'other.can', sha256: '1'.repeat(64), module: 'other.js' } }),
      (set: FrameworkOpaqueDeclarationSet) => Object.assign(set.canonicalModels[0]!.fields.send!, { delivery: { ...deliveryDescriptor, version: 2 } }),
      (set: FrameworkOpaqueDeclarationSet) => Object.assign(set.artifactModels[0]!.fields[0]!, { field: { kind: 'string' } }),
    ]) {
      const changed = structuredClone(installed);
      alter(changed.inventory.opaqueDeclarationSets![0]!);
      assert.throws(() => resolveReceipt(row, changed, binding));
    }
    let reads = 0;
    const getter = { installed, binding };
    Object.defineProperty(getter, 'binding', { enumerable: true, get() { reads++; return binding; } });
    assert.throws(() => producer.resolveOpaqueField!(asModel(RECEIPT_MODEL), row, 'result', getter));
    assert.equal(reads, 0);
    assert.throws(() => resolveReceipt(row, Object.assign(structuredClone(installed), { then() {} }), binding));
    assert.throws(() => resolveReceipt(edited(row, { result: Promise.resolve(null) }), installed, binding));
  });
});

/** Admission of complete original contract declarations only. Empty source,
 * model and callable inventories here qualify no source or File authority. */
function originalContractSet() {
  const originalContracts = {
    'App.Packet': { fields: {
      optional: { type: 'text?', default: null },
      optional_file: { type: 'file?', default: null },
      enabled: { type: 'bool', default: false },
      label: { type: 'text', default: '' },
      attachments: { type: 'file[]', max: 4, default: [] },
      trimmed: { type: 'text', trim: true, default: ' padded ' },
      required: { type: 'text' },
    } },
    'App.Unused': { fields: { note: { type: 'text' } } },
  };
  const contracts = Object.entries(originalContracts).map(([name, contract]) => ({ name,
    fields: Object.entries(contract.fields).map(([field, descriptor]) => {
      const { default: _default, ...shape } = descriptor as { type: string; default?: WireValue };
      return { name: field, ...shape };
    }) }));
  const valueDefaults: FrameworkOpaqueValueDefault[] = Object.entries(originalContracts).flatMap(([contract, original]) =>
    Object.entries(original.fields).filter(([, field]) => Object.hasOwn(field, 'default'))
      .map(([field, descriptor]) => ({ contract, field, value: structuredClone((descriptor as unknown as { default: WireValue }).default) })));
  const inventory = { owner: 'App', snapshotId: 'original', digest: 'original-digest' };
  return { id: 'original/contracts', inventory,
    snapshot: { ...inventory, installedRevision: asRevision(0), installedAt: 100 },
    sources: [], canonicalModels: [], artifactModels: [], declarations: [],
    valueTypes: structuredClone(normalizeValueTypes({ contracts }).valueTypes), originalContracts, valueDefaults } satisfies FrameworkOpaqueDeclarationSet;
}

describe('complete original opaque contract admission (no source qualification)', () => {
  const admit = (set: FrameworkOpaqueDeclarationSet) => bindOpaqueFileDeclarations([set], () => {});
  it('admits an owning static Generation profile and refuses malformed or unknown provider contracts', () => {
    const { set } = generationProfileFixture();
    assert.equal(admit(set).size, 1);
    for (const alter of [
      (changed: FrameworkOpaqueDeclarationSet) => {
        const entry = changed.declarations[0]!;
        if (entry.source.kind === 'delivery') Object.assign(entry.source.context.canonical.result,
          { name: 'UninstalledGenerationResult', fields: [] });
      },
      (changed: FrameworkOpaqueDeclarationSet) => {
        const entry = changed.declarations[0]!;
        if (entry.source.kind === 'delivery') Object.assign(entry.source.context.canonical.result, { fields: [] });
      },
      (changed: FrameworkOpaqueDeclarationSet) => Object.assign(changed.declarations[0]!.source, { context: {
        kind: 'generation-profile', canonical: deliveryDescriptor, artifact: deliveryDescriptor, request: { source: 'invented', revision: '0' } } }),
    ]) {
      const changed = structuredClone(set); alter(changed);
      assert.throws(() => admit(changed));
    }
  });
  it('retains null, false, empty defaults, raw trim literals and fields without defaults, including unused contracts', () => {
    const set = originalContractSet();
    const bound = admit(set).get(set.id)!;
    assert.deepEqual(bound.declarationSet.originalContracts, set.originalContracts);
    assert.deepEqual(bound.declarationSet.valueDefaults, set.valueDefaults);
    assert.equal(Object.hasOwn(bound.declarationSet.originalContracts, 'App.Unused'), true);
    assert.equal(set.valueDefaults.some(item => item.field === 'required' || item.contract === 'App.Unused'), false);
    assert.equal(set.valueDefaults.find(item => item.field === 'trimmed')!.value, ' padded ');
  });

  it('admits the compiler exported visibility marker on original contracts', () => {
    const set = originalContractSet();
    Object.assign(set.originalContracts['App.Packet'], { exported: true });
    const bound = admit(set).get(set.id)!;
    assert.deepEqual(bound.declarationSet.originalContracts, set.originalContracts);
    for (const exported of ['true', 1, null]) {
      const changed = structuredClone(set);
      Object.assign(changed.originalContracts['App.Packet'], { exported });
      assert.throws(() => admit(changed));
    }
  });

  it('admits the compiler caption wire on original contracts', () => {
    for (const label of ['Packet', { text: 'Packet', nl: 'Pakket' }]) {
      const set = originalContractSet();
      Object.assign(set.originalContracts['App.Packet'], { label });
      const bound = admit(set).get(set.id)!;
      assert.deepEqual(bound.declarationSet.originalContracts, set.originalContracts);
    }
    for (const label of [['Packet'], 7, null]) {
      const set = originalContractSet();
      Object.assign(set.originalContracts['App.Packet'], { label });
      assert.throws(() => admit(set));
    }
  });

  it('admits the compiler caption wire on original contract fields', () => {
    for (const label of ['Label', { text: 'Label', nl: 'Etiket' }]) {
      const set = originalContractSet();
      Object.assign(set.originalContracts['App.Packet'].fields.required, { label });
      const bound = admit(set).get(set.id)!;
      assert.deepEqual(bound.declarationSet.originalContracts, set.originalContracts);
    }
    for (const label of [['Label'], 7]) {
      const set = originalContractSet();
      Object.assign(set.originalContracts['App.Packet'].fields.required, { label });
      assert.throws(() => admit(set));
    }
  });

  it('admits canonical int64 wire text for array and text length bounds while retaining the raw map', () => {
    const set = originalContractSet();
    Object.assign(set.originalContracts['App.Packet'].fields.attachments, { max: '4' });
    Object.assign(set.originalContracts['App.Packet'].fields.label, { min: '0', max: '4' });
    Object.assign(set.valueTypes.contracts[0]!.fields.find(field => field.name === 'label')!, { min: 0, max: 4 });
    const bound = admit(set).get(set.id)!;
    assert.deepEqual(bound.declarationSet.originalContracts, set.originalContracts);
    for (const max of ['04', '4.0', 'invalid', '9007199254740992', '5']) {
      const changed = structuredClone(set);
      Object.assign(changed.originalContracts['App.Packet'].fields.attachments, { max });
      assert.throws(() => admit(changed));
    }
  });

  it('admits native own nullable and array wrappers without changing original contracts or defaults', () => {
    const set = originalContractSet();
    Object.assign(set.originalContracts['App.Packet'].fields.optional, { type: 'text', nullable: true });
    Object.assign(set.originalContracts['App.Packet'].fields.optional_file, { type: 'file', nullable: true });
    Object.assign(set.originalContracts['App.Packet'].fields.enabled, { array: false, nullable: false });
    Object.assign(set.originalContracts['App.Packet'].fields.attachments, { type: 'file', array: true, min: '0', max: '4' });
    Object.assign(set.valueTypes.contracts[0]!.fields.find(field => field.name === 'attachments')!, { min: 0 });
    const before = structuredClone(set);
    const bound = admit(set).get(set.id)!;
    assert.deepEqual(set, before);
    assert.deepEqual(bound.declarationSet.originalContracts, before.originalContracts);
    assert.deepEqual(bound.declarationSet.valueDefaults, before.valueDefaults);
    for (const change of [
      (changed: typeof set) => Object.assign(changed.originalContracts['App.Packet'].fields.optional, { nullable: false }),
      (changed: typeof set) => Object.assign(changed.originalContracts['App.Packet'].fields.optional, { nullable: 'true' }),
      (changed: typeof set) => Object.assign(changed.originalContracts['App.Packet'].fields.optional, { type: 'text?' }),
      (changed: typeof set) => Object.assign(changed.originalContracts['App.Packet'].fields.optional, { type: 'text?', nullable: false }),
      (changed: typeof set) => Object.assign(changed.originalContracts['App.Packet'].fields.attachments, { array: false }),
      (changed: typeof set) => Object.assign(changed.originalContracts['App.Packet'].fields.attachments, { array: 1 }),
      (changed: typeof set) => Object.assign(changed.originalContracts['App.Packet'].fields.attachments, { type: 'file[]' }),
      (changed: typeof set) => Object.assign(changed.originalContracts['App.Packet'].fields.attachments, { type: 'file[]', array: false }),
      (changed: typeof set) => Object.assign(changed.originalContracts['App.Packet'].fields.attachments, { type: 'file?' }),
      (changed: typeof set) => Object.assign(changed.originalContracts['App.Packet'].fields.optional_file, { type: 'file[]!', nullable: true }),
      (changed: typeof set) => Object.assign(changed.originalContracts['App.Packet'].fields.optional_file, { extra: true }),
      (changed: typeof set) => Object.assign(changed.originalContracts['App.Packet'].fields.attachments, { max: '5' }),
      (changed: typeof set) => Object.assign(changed.originalContracts['App.Packet'].fields.optional_file, { default: 'changed' }),
      (changed: typeof set) => Object.assign(changed.valueDefaults.find(field => field.field === 'optional_file')!, { value: 'changed' }),
    ]) {
      const changed = structuredClone(set); change(changed);
      assert.throws(() => admit(changed));
    }
  });

  it('refuses incomplete or extended raw contract/field inventories and changed canonical types or constraints', () => {
    const changes: Array<(set: ReturnType<typeof originalContractSet>) => void> = [
      set => { Reflect.deleteProperty(set, 'originalContracts'); },
      set => { Reflect.deleteProperty(set.originalContracts, 'App.Unused'); },
      set => { Object.assign(set.originalContracts, { 'App.Extra': { fields: {} } }); },
      set => { Reflect.deleteProperty(set.originalContracts['App.Packet'].fields, 'required'); },
      set => { Object.assign(set.originalContracts['App.Unused'].fields, { extra: { type: 'text' } }); },
      set => { Object.assign(set.originalContracts['App.Packet'].fields.required, { type: 'bool' }); },
      set => { Object.assign(set.originalContracts['App.Packet'].fields.attachments, { max: 5 }); },
      set => { Object.assign(set.valueTypes.contracts[0]!.fields.find(field => field.name === 'required')!, { type: 'bool' }); },
      set => { Object.assign(set.valueTypes.contracts[0]!.fields.find(field => field.name === 'attachments')!, { max: 5 }); },
    ];
    for (const change of changes) {
      const set = originalContractSet(); change(set);
      assert.throws(() => admit(set));
    }
  });

  it('requires exactly every own raw literal default and rejects incompatible literals', () => {
    const changes: Array<(set: ReturnType<typeof originalContractSet>) => void> = [
      set => { Reflect.deleteProperty(set, 'valueDefaults'); },
      set => { set.valueDefaults.splice(0, 1); },
      set => { set.valueDefaults.push({ contract: 'App.Packet', field: 'required', value: '' }); },
      set => { set.valueDefaults.push({ ...set.valueDefaults[0]! }); },
      set => { Object.assign(set.valueDefaults.find(item => item.field === 'enabled')!, { value: true }); },
      set => { Object.assign(set.valueDefaults.find(item => item.field === 'trimmed')!, { value: 'padded' }); },
      set => { Reflect.deleteProperty(set.originalContracts['App.Packet'].fields.optional, 'default'); },
      set => { Object.assign(set.originalContracts['App.Packet'].fields.required, { default: '' }); },
      set => {
        Object.assign(set.originalContracts['App.Packet'].fields.enabled, { default: 'false' });
        Object.assign(set.valueDefaults.find(item => item.field === 'enabled')!, { value: 'false' });
      },
    ];
    for (const change of changes) {
      const set = originalContractSet(); change(set);
      assert.throws(() => admit(set));
    }
  });
});

it('callable void profiles retain matching disclosure metadata and refuse skew or delivery-void substitution', () => {
  const source = { path: 'void.can', sha256: 'a'.repeat(64), module: 'void.mjs' };
  const callable = { id: 'App.void', kind: 'operation' as const, module: source.module, export: 'canApp', member: ['void'] };
  const result = { type: 'void' as const, disclosure: { version: 1, source,
    returns: [{ id: 'done', source, dependencies: [], influences: [] }] } };
  const set: FrameworkOpaqueDeclarationSet = { ...originalContractSet(), sources: [{ path: source.path, sha256: source.sha256 }],
    declarations: [{ id: 'caller/void', source: { kind: 'callable', source, callable },
      profile: { kind: 'void', canonical: result, artifact: structuredClone(result) } }] };
  assert.equal(bindOpaqueFileDeclarations([set], () => {}).size, 1);
  const skew = structuredClone(set);
  const profile = skew.declarations[0]!.profile;
  if (profile.kind !== 'void') throw new Error('expected genuine caller void profile');
  Object.assign(profile.artifact, { disclosure: { ...result.disclosure, returns: [] } });
  assert.throws(() => bindOpaqueFileDeclarations([skew], () => {}));
  const provider = { ...set, declarations: [{ id: 'provider/void',
    source: { kind: 'delivery' as const, source, context: { kind: 'capability' as const,
      canonical: deliveryDescriptor, artifact: deliveryDescriptor } },
    profile: { kind: 'void' as const, canonical: result, artifact: structuredClone(result) } }] };
  assert.throws(() => bindOpaqueFileDeclarations([provider], () => {}), 'caller void does not define provider R');
});
