/** Internal staging controls only; these maps do not attest native or owner execution. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ArtifactModel, DomainWrite, OutboxIntent, StoredRow } from '@canlang/contracts';
import { StateError } from '../../src/errors.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { stageAuthoredDelivery, type AuthoredDeliveryInput, type AuthoredSkippedDelivery } from '../../src/receipt/authored-delivery.js';
import { associationRowId, readAssociationRow, readReceiptRow, withReceiptRowData,
  RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL } from '../../src/receipt/tables.js';
import { asId, asModel, FIXED_NOW, makeBatch } from '../invocation/fixtures.js';

const MODEL = asModel('Skipped.Record'), TARGET = 'std.ImagesV1.submit', OPERATION = 'Skipped.send', OPERATION_ID = 'business-send';
const model = (): ArtifactModel => ({ name: MODEL, deleteMode: 'remove', fields: [{ name: 'request',
  required: false, serverOnly: false, nullable: true,
  field: { kind: 'delivery', capability: 'std.ImagesV1', operation: 'submit', version: 1,
    result: { name: 'ImagesSubmit', fields: [] } } }] });
const skipped = (deliveryId = 'skipped-original'): AuthoredSkippedDelivery => ({ deliveryId,
  operationId: OPERATION_ID, operation: OPERATION, target: TARGET, arguments: { prompt: 'Image' } });
const queued = (intentId = 'pending-original'): OutboxIntent => ({ intentId, target: TARGET,
  operation: OPERATION as OutboxIntent['operation'], operationId: OPERATION_ID as OutboxIntent['operationId'],
  occurrenceIndex: 0, arguments: { prompt: 'Image' } });
const validation = (error: unknown) => error instanceof StateError && error.code === 'validation';
const row = (write: DomainWrite): StoredRow => { assert.ok(write.kind === 'insert' || write.kind === 'update'); return write.row; };
function fixture() {
  const store = createMemoryStorage();
  const context = { actor: 'caller', now: FIXED_NOW, operation: OPERATION, load: store.load, query: store.query };
  const input = (entry = skipped()): AuthoredDeliveryInput => ({ model: model(), recordId: 'record', field: 'request',
    value: { kind: 'delivery', id: entry.deliveryId, operation: TARGET }, queued: new Map(),
    skipped: new Map([[entry.deliveryId, entry]]), operationId: OPERATION_ID, revision: 0 });
  const apply = async (writes: readonly DomainWrite[]) => store.commit(makeBatch(await store.readRevision(), { writes }));
  return { store, context, input, apply };
}

test('actual skipped entry stages only its association and empty skipped receipt', async () => {
  const s = fixture(), staged = await stageAuthoredDelivery(s.input(), s.context);
  assert.equal(staged.writes!.length, 2);
  assert.deepEqual(Object.keys(staged), ['writes']);
  assert.equal(readAssociationRow(row(staged.writes![0]!)).deliveryId, 'skipped-original');
  const saved = readReceiptRow(row(staged.writes![1]!));
  assert.deepEqual(saved.receipt, { deliveryId: 'skipped-original', revision: 0, status: 'skipped', result: null, error: null });
  assert.equal(saved.contentRef, null); assert.equal(saved.resultExpiresAtMs, null);
  assert.equal(saved.filePayloadOrigin, undefined);
  await s.apply(staged.writes!);
  assert.deepEqual(await s.store.outboxPending(), []);
});

test('skipped replacement and clear retain the prior pending receipt and create no dispatch', async () => {
  const s = fixture(), original = queued();
  const pending = await stageAuthoredDelivery({ ...s.input(), value: { kind: 'delivery', id: original.intentId, operation: TARGET },
    queued: new Map([[original.intentId, original]]), skipped: new Map() }, s.context);
  await s.apply(pending.writes!);
  const retained = await s.store.load(asModel(RECEIPT_MODEL), asId(original.intentId)); assert.ok(retained);
  assert.equal(readReceiptRow(retained).receipt.status, 'pending');
  const revision = await s.store.readRevision();
  const replacement = await stageAuthoredDelivery({ ...s.input(), revision }, s.context);
  assert.equal(replacement.writes![0]!.kind, 'update');
  assert.equal(readReceiptRow(row(replacement.writes![1]!)).receipt.status, 'skipped');
  await s.apply(replacement.writes!);
  assert.deepEqual(await s.store.load(asModel(RECEIPT_MODEL), asId(original.intentId)), retained);
  const cleared = await stageAuthoredDelivery({ ...s.input(), value: null, revision: await s.store.readRevision() }, s.context);
  assert.equal(cleared.writes!.length, 1); assert.equal(cleared.writes![0]!.kind, 'remove');
  await s.apply(cleared.writes!);
  assert.ok(await s.store.load(asModel(RECEIPT_MODEL), asId('skipped-original')));
  assert.deepEqual(await s.store.load(asModel(RECEIPT_MODEL), asId(original.intentId)), retained);
  assert.deepEqual(await s.store.outboxPending(), []);
});

test('duplicate staged skipped assignment is exact, and retained attempts cannot be reset or reassigned', async () => {
  const s = fixture(), input = s.input();
  await s.apply((await stageAuthoredDelivery(input, s.context)).writes!);
  assert.deepEqual(await stageAuthoredDelivery(input, s.context), { writes: [] });
  const attempt = queued('skipped-original');
  await assert.rejects(stageAuthoredDelivery({ ...input, queued: new Map([[attempt.intentId, attempt]]), skipped: new Map() }, s.context), validation);
  await assert.rejects(stageAuthoredDelivery({ ...input, recordId: 'other-record' }, s.context), validation);
  const retained = await s.store.load(asModel(RECEIPT_MODEL), asId('skipped-original')); assert.ok(retained);
  const failed = withReceiptRowData(retained, { deliveryId: 'skipped-original', revision: 0, status: 'failed',
    result: null, error: { code: 'failed', message: 'failure' }, contentRef: null, resultExpiresAtMs: null },
    { actor: 'caller', nowMs: FIXED_NOW });
  await s.apply([{ kind: 'update', model: asModel(RECEIPT_MODEL), id: retained.id, expectedVersion: retained.version, row: failed }]);
  await assert.rejects(stageAuthoredDelivery(input, s.context), validation);
});

test('missing, forged, mismatched or ambiguous skipped entries refuse before receipt readers', async () => {
  for (const mode of ['missing', 'id', 'target', 'business-id', 'operation', 'ambiguous', 'long-id', 'file-origin'] as const) {
    const s = fixture(), entry = { ...skipped() }, input = { ...s.input(entry) };
    if (mode === 'missing') input.skipped = new Map();
    if (mode === 'id') entry.deliveryId = 'forged-id';
    if (mode === 'target') entry.target = 'std.TextGenerationV1.generate';
    if (mode === 'business-id') entry.operationId = 'other-business';
    if (mode === 'operation') entry.operation = 'Other.send';
    if (mode === 'ambiguous') { const attempt = queued('skipped-original'); input.queued = new Map([[attempt.intentId, attempt]]); }
    if (mode === 'long-id') {
      entry.deliveryId = 'x'.repeat(129); input.value = { kind: 'delivery', id: entry.deliveryId, operation: TARGET };
      input.skipped = new Map([[entry.deliveryId, entry]]);
    }
    if (mode === 'file-origin') input.filePayloadOrigin = {} as NonNullable<AuthoredDeliveryInput['filePayloadOrigin']>;
    await assert.rejects(stageAuthoredDelivery(input, { ...s.context,
      load: async () => { assert.fail('invalid skipped association must not read receipts'); },
    }), validation);
  }
});

test('skipped assignment and status detach from declaration, entry, maps and context before reader awaits', async () => {
  const s = fixture(), entry = { ...skipped(), arguments: { prompt: 'Original' } }, input = { ...s.input(entry) };
  const mutableModel = model(); input.model = mutableModel;
  const context = { ...s.context };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  context.load = async () => { await gate; return null; };
  const pending = stageAuthoredDelivery(input, context);
  entry.deliveryId = 'changed-id'; entry.target = 'changed-target'; entry.arguments.prompt = 'Changed';
  (input.skipped as Map<string, AuthoredSkippedDelivery>).clear();
  const attempt = queued('skipped-original'); (input.queued as Map<string, OutboxIntent>).set(attempt.intentId, attempt);
  input.value = { kind: 'delivery', id: 'changed-reference', operation: TARGET };
  input.recordId = 'changed-record'; input.revision = 99; input.operationId = 'changed-business';
  (mutableModel as { name: string }).name = 'Changed.Record';
  context.actor = 'changed-actor'; context.now = FIXED_NOW + 1; context.operation = 'Changed.send';
  release();
  const staged = await pending;
  assert.equal(row(staged.writes![0]!).id, associationRowId(MODEL, 'record', 'request'));
  assert.equal(readAssociationRow(row(staged.writes![0]!)).deliveryId, 'skipped-original');
  const receipt = row(staged.writes![1]!);
  assert.equal(receipt.createdBy, 'caller');
  assert.equal(readReceiptRow(receipt).receipt.status, 'skipped');
  assert.equal(readReceiptRow(receipt).receipt.revision, 0);
  assert.deepEqual(Object.keys(staged), ['writes']);
});
