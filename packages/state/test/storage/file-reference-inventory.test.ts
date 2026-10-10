import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DomainWrite, ModelName, RecordVersion, StoredRow } from '@canlang/contracts';
import { STATE_FILE_REFERENCE_PRODUCER as producer } from '../../src/storage/index.js';
import { RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL, newAssociationRow, newReceiptRow } from '../../src/receipt/tables.js';
import { FANOUT_NAVIGATION_MODEL, FANOUT_OWNER_SCAN_MODEL,
  stageFanoutNavigationWrite, stageFanoutOwnerScanWrite } from '../../src/fanout/navigation.js';
import { newFanoutIntentRow, newFanoutChildRow, fanoutChildRowId } from '../../src/fanout/tables.js';

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
  it('covers genuine owning rows with frozen named declarations and opaque retained receipt fields', () => {
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
    assert.deepEqual(fields.error, { kind: 'opaque', role: 'retained-result' });
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
