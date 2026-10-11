import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OutboxIntent, RetainedOutboxIntent, Revision } from '@canlang/contracts';
import { StateError } from '../../src/errors.js';
import { FenceConflictError } from '../../src/storage/port.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { captureBoundedOutbox, captureBoundedOutboxRequest, compileBoundedOutbox,
  toBoundedRetainedOutbox, toRetainedOutboxIntent, type BoundedRetainedOutboxRow,
  type RetainedOutboxRow } from '../../src/storage/sqlite-codecs.js';
import { asOperation, asOperationId, FIXED_NOW, makeBatch, makeReceipt } from '../invocation/fixtures.js';

const intent = (arguments_: Record<string, unknown> = { binding: 'CanChat.LLM', value: { text: 'original' } }): OutboxIntent => ({
  intentId: 'delivery', operation: asOperation('CanChat.ask'), operationId: asOperationId('original-operation'),
  target: 'std.TextGenerationV1.generate', arguments: arguments_, occurrenceIndex: 0,
  dispatchGuard: 'original-guard', handlerContract: 'original-contract',
});
const raw = (overrides: Partial<BoundedRetainedOutboxRow> = {}): BoundedRetainedOutboxRow => ({
  intent_id: 'delivery', operation: 'CanChat.ask', operation_id: 'original-operation', target: 'std.TextGenerationV1.generate',
  arguments: '{"binding":"CanChat.LLM","value":{"text":"original"}}', occurrence_index: 0,
  dispatch_guard: 'original-guard', handler_contract: 'original-contract', status: 'pending', committed_revision: 1,
  created_at: FIXED_NOW, ...overrides,
});
const limit = (error: unknown) => error instanceof StateError && error.code === 'limit' && error.retryable === false;
const validation = (error: unknown) => error instanceof StateError && error.code === 'validation';

test('Memory bounded read preserves original stamp and ack status with detached arguments and no effects', async () => {
  const store = createMemoryStorage(), original = intent();
  await store.commit(makeBatch(await store.readRevision(), { outbox: [original],
    receipt: makeReceipt({ createdAt: FIXED_NOW, committedRevision: 1 }) }));
  assert.ok(store.outboxGetBounded);
  const revision = await store.readRevision(), request = { intentId: original.intentId, expectedRevision: revision };
  const pending = store.outboxGetBounded(request);
  request.intentId = 'mutated'; request.expectedRevision = 999 as Revision;
  const result = await pending;
  assert.deepEqual(result, { intent: original, status: 'pending', originalCommit: { revision, createdAt: FIXED_NOW } });
  assert.notEqual(result?.intent.arguments, original.arguments);
  (result!.intent.arguments.value as { text: string }).text = 'changed returned copy';
  assert.deepEqual(await store.outboxGetBounded({ intentId: original.intentId, expectedRevision: revision }),
    await store.outboxGet(original.intentId));
  assert.equal(await store.readRevision(), revision);
  await store.commit({ ...makeBatch(revision), outboxAck: [original.intentId] });
  const acknowledgedRevision = await store.readRevision();
  assert.deepEqual(await store.outboxGetBounded({ intentId: original.intentId, expectedRevision: acknowledgedRevision }),
    { intent: original, status: 'dispatched', originalCommit: { revision, createdAt: FIXED_NOW } });
  await assert.rejects(store.outboxGetBounded({ intentId: 'missing', expectedRevision: revision }), FenceConflictError);
  assert.equal(await store.outboxGetBounded({ intentId: 'missing', expectedRevision: acknowledgedRevision }), null);
});

test('bounded codecs preserve ordinary shape, nullable optional columns and honest legacy stamp omission', () => {
  for (const row of [raw(), raw({ status: 'dispatched' }), raw({ committed_revision: null,
    dispatch_guard: null, handler_contract: null })]) {
    assert.deepEqual(toBoundedRetainedOutbox(row), toRetainedOutboxIntent(row as RetainedOutboxRow));
  }
  const legacy: RetainedOutboxIntent = { intent: intent(), status: 'dispatched' };
  assert.deepEqual(captureBoundedOutbox(legacy), legacy);
  assert.equal(Object.hasOwn(captureBoundedOutbox(legacy), 'originalCommit'), false);
});

test('complete SQLite carrier, scalar metadata, node/depth/text and aggregate raw bytes refuse before JSON.parse', () => {
  const rows = [
    raw({ arguments: null }),
    raw({ operation: 'x'.repeat(2_000_001) }),
    raw({ arguments: JSON.stringify({ text: 'x'.repeat(2_000_001) }) }),
    raw({ arguments: `[${Array(20_000).fill('null').join(',')}]` }),
    raw({ arguments: `${'['.repeat(31)}0${']'.repeat(31)}` }),
    raw({ arguments: '{"value":0}' + ' '.repeat(12_000_000), handler_contract: 'x'.repeat(700_000) }),
  ];
  const parse = JSON.parse;
  let calls = 0;
  JSON.parse = () => { calls++; throw new Error('Resource refusal must precede decoder allocation'); };
  try {
    for (const row of rows) assert.throws(() => toBoundedRetainedOutbox(row), limit);
    assert.equal(calls, 0);
  } finally { JSON.parse = parse; }
});

test('Memory bounds its stored original before copy and direct capture rejects own-data drift', async () => {
  const store = createMemoryStorage();
  await store.commit(makeBatch(await store.readRevision(), { outbox: [intent({ value: 'x'.repeat(2_000_001) })] }));
  assert.ok(store.outboxGetBounded);
  const revision = await store.readRevision(), parse = JSON.parse;
  let calls = 0;
  JSON.parse = () => { calls++; throw new Error('No unbounded deep clone'); };
  try {
    await assert.rejects(store.outboxGetBounded({ intentId: 'delivery', expectedRevision: revision }), limit);
    assert.equal(calls, 0);
  } finally { JSON.parse = parse; }
  assert.equal(await store.readRevision(), revision);
  const accessor = { intent: intent(), status: 'pending' } as RetainedOutboxIntent;
  Object.defineProperty(accessor.intent.arguments, 'private', { enumerable: true, get() { throw new Error('must not invoke'); } });
  assert.throws(() => captureBoundedOutbox(accessor), validation);
});

test('request capture preserves original identity/fence and enforces component bounds without invoking accessors', async () => {
  const input = { intentId: 'original', expectedRevision: 0 as Revision }, captured = captureBoundedOutboxRequest(input);
  input.intentId = 'changed'; input.expectedRevision = 7 as Revision;
  assert.deepEqual(captured, { intentId: 'original', expectedRevision: 0 }); assert.ok(Object.isFrozen(captured));
  const store = createMemoryStorage(); assert.ok(store.outboxGetBounded);
  assert.equal(await store.outboxGetBounded({ intentId: 'x'.repeat(200), expectedRevision: 0 as Revision }), null);
  await assert.rejects(store.outboxGetBounded({ intentId: 'x'.repeat(201), expectedRevision: 0 as Revision }), limit);
  for (const intentId of ['', 'control\u0000', '\ud800']) {
    await assert.rejects(store.outboxGetBounded({ intentId, expectedRevision: 0 as Revision }), validation);
  }
  await assert.rejects(store.outboxGetBounded({ intentId: 'valid', expectedRevision: -1 as Revision }), validation);
  await assert.rejects(store.outboxGetBounded({ get intentId(): string { throw new Error('must not invoke'); }, expectedRevision: 0 as Revision }), validation);
  assert.equal(await store.readRevision(), 0);
  const sql = compileBoundedOutbox(captured);
  assert.deepEqual(sql.bindings, ['original']);
  assert.match(sql.sql, /CASE WHEN/); assert.match(sql.sql, /12640000/);
  for (const column of ['arguments', 'status', 'committed_revision', 'created_at', 'handler_contract']) {
    assert.ok(sql.sql.includes(`AS ${column}`));
  }
});
