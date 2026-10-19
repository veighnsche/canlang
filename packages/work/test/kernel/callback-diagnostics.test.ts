import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GenerationCallbackDiagnosticRequest, GenerationCallbackOrigin, ModelName, RecordId, StoragePort } from '@canlang/contracts';
import type { SystemCommandContext, SystemStaging } from '@canlang/state';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { FenceConflictError } from '@canlang/state/storage/port';
import { makeBatch, makeReceipt, updateRow } from '@canlang/state/testing/invocation/fixtures';
import { readGenerationCallbackDiagnostics } from '../../src/kernel/callback-diagnostics.js';
import { workDispatchStageCommand } from '../../src/kernel/dispatch-staging.js';
import { stageDueSchedule, workSchedulePutCommand } from '../../src/kernel/schedule-staging.js';
import { stageHandlerOccurrence, stageHandlerOccurrenceTerminal, handlerOccurrenceRowId,
  WORK_HANDLER_OCCURRENCE_MODEL } from '../../src/kernel/handler-occurrence.js';
import { workOccurrencePutReceiptCommand } from '../../src/kernel/occurrence-staging.js';
import { WORK_OCCURRENCE_MODEL, WORK_SCHEDULE_MODEL, type OccurrenceRowData } from '../../src/kernel/tables.js';

const scope = { app: 'chat', owner: 'team', ownerPackage: 'CanChat' };
const origin: GenerationCallbackOrigin = { source: 'std.TextGenerationV1.generate', sourceRevision: '1',
  binding: 'CanChat.LLM', from: 'local-text', scope, event: 'CanChat.LLM.generate.progressed', handlers: ['CanChat.reply_progressed'] };
const event = 'CanChat.LLM.generate.progressed';
const deliveryId = 'original-delivery';
const failed = { status: 'failed' as const, result: null, code: 'require-false',
  message: 'handler requirement rejected the occurrence', recordedAtMs: 100 };
function context(store: StoragePort): SystemCommandContext {
  return { actor: 'owner-host', now: 100, operation: 'CanChat.ask', load: store.load, query: store.query };
}
async function commit(store: StoragePort, effects: SystemStaging) {
  await store.commit(makeBatch(await store.readRevision(), effects));
}
async function fixture(source: GenerationCallbackOrigin['source'] = origin.source) {
  const store = createMemoryStorage(), ctx = context(store);
  const chosen: GenerationCallbackOrigin = source === origin.source ? origin : { ...origin, source,
    binding: 'CanChat.Images', from: 'local-images', event: 'CanChat.Images.submit.progressed' };
  const effects = await workDispatchStageCommand.stage({ operationId: 'original-operation', intents: [{
    intentId: deliveryId, operation: 'CanChat.ask', originOperationId: 'original-operation', source,
    occurrenceIndex: 0, originOccurrence: null, guard: null, guardVerdict: null,
    request: { binding: chosen.binding, from: chosen.from, arguments: { value: { source: 'request-source', revision: '1' } } },
    correlation: { requestSource: 'request-source', requestRevision: '1', requestBinding: chosen.binding,
      requestFrom: chosen.from, requestApp: scope.app, requestOwner: scope.owner },
  }] }, ctx);
  await store.commit(makeBatch(await store.readRevision(), { ...effects, receipt: makeReceipt({ app: scope.app,
    owner: scope.owner, operation: 'CanChat.ask', operationId: 'original-operation', createdAt: 100, committedRevision: 1 }) }));
  const request = async (): Promise<GenerationCallbackDiagnosticRequest> => ({ origin: chosen, deliveryId,
    expectedRevision: await store.readRevision() });
  return { store, chosen, request };
}
async function schedule(store: StoragePort, id: string, changes: Record<string, unknown> = {}) {
  const input = { key: id, occurrenceId: id, scope, at: 100, event, payload: { delivery_id: deliveryId }, ...changes };
  await commit(store, await workSchedulePutCommand.stage(input, context(store)));
  return input;
}
async function routed(store: StoragePort, id: string, chosen = origin) {
  const scheduleInput = await schedule(store, id, { event: chosen.event });
  const ctx = context(store), due = await stageDueSchedule(scheduleInput, ctx);
  assert.equal(due.status, 'ready'); if (due.status !== 'ready') throw Error('due');
  const handler = chosen.handlers[0]!;
  const route = await stageHandlerOccurrence({ source: { occurrenceId: id, event: chosen.event,
    payload: { delivery_id: deliveryId }, scope }, handler }, ctx);
  assert.equal(route.status, 'ready'); if (route.status !== 'ready') throw Error('route');
  const source = await workOccurrencePutReceiptCommand.stage({ occurrenceId: id, status: 'completed',
    result: { fanouts: [], bounds: { pageLimit: 100, chunkSize: 100 }, handlers: [{ handler, occurrenceId: route.occurrence.occurrenceId }] } }, ctx);
  await commit(store, { writes: [...due.effects.writes ?? [], ...route.effects.writes ?? [], ...source.writes ?? []],
    schedules: due.effects.schedules ?? [] });
  return { sourceOccurrence: id, handler, event: chosen.event, scope };
}
async function terminal(store: StoragePort, selector: Awaited<ReturnType<typeof routed>>, receipt: Omit<OccurrenceRowData, 'occurrenceId'> = failed) {
  const staged = await stageHandlerOccurrenceTerminal({ ...selector, expectedVersion: 1, receipt }, context(store));
  assert.equal(staged.status, 'ready'); if (staged.status !== 'ready') throw Error('terminal');
  await commit(store, staged.effects);
}
async function change(store: StoragePort, model: ModelName, id: string, patch: Record<string, unknown>) {
  const row = await store.load(model, id as RecordId); assert.ok(row);
  await updateRow(store, model, row, { data: { ...row.data, ...patch } });
}

test('genuine text/image stages disclose only immutable safe historical refusal, with zero read effects', async () => {
  for (const source of ['std.TextGenerationV1.generate', 'std.ImagesV1.submit'] as const) {
    const w = await fixture(source), selector = await routed(w.store, 'notice/1', w.chosen);
    await terminal(w.store, selector);
    const before = await w.store.readRevision(), retained = await w.store.outboxGet(deliveryId);
    const result = await readGenerationCallbackDiagnostics(await w.request(), w.store);
    assert.deepEqual(result, { outcome: 'complete', snapshotAttribution: 'unsupported', failures: [{ deliveryId,
      sourceOccurrence: 'notice/1', occurrenceId: handlerOccurrenceRowId('notice/1', selector.handler),
      handler: selector.handler, event: w.chosen.event, recordedAtMs: 100, code: failed.code, message: failed.message }] });
    assert.equal(await w.store.readRevision(), before);
    assert.deepEqual(await w.store.outboxGet(deliveryId), retained);
    const replay = await stageHandlerOccurrenceTerminal({ ...selector, expectedVersion: 1,
      receipt: { status: 'completed', result: null, code: null, message: null, recordedAtMs: 200 } }, context(w.store));
    assert.equal(replay.status, 'replayed');
    assert.deepEqual(await readGenerationCallbackDiagnostics(await w.request(), w.store), result);
  }
});

test('pending unsourced and pending routed callbacks are not failures', async () => {
  const w = await fixture(); await schedule(w.store, 'notice/1'); await routed(w.store, 'notice/2');
  assert.deepEqual(await readGenerationCallbackDiagnostics(await w.request(), w.store),
    { outcome: 'complete', failures: [], snapshotAttribution: 'unsupported' });
});

test('completed callback results are checked but never disclosed', async () => {
  const w = await fixture(), selector = await routed(w.store, 'notice/1');
  await terminal(w.store, selector, { status: 'completed', result: { private: 'business result' },
    code: null, message: null, recordedAtMs: 100 });
  assert.deepEqual(await readGenerationCallbackDiagnostics(await w.request(), w.store),
    { outcome: 'complete', failures: [], snapshotAttribution: 'unsupported' });
});

test('foreign origin and matching foreign scope/event/handler evidence refuse correspondence', async () => {
  const w = await fixture();
  for (const patch of [{ from: 'foreign' }, { sourceRevision: '2' }, { scope: { ...scope, owner: 'foreign' } }]) {
    const request = await w.request();
    assert.deepEqual(await readGenerationCallbackDiagnostics({ ...request, origin: { ...request.origin, ...patch } }, w.store),
      { outcome: 'unsupported', reason: 'origin-correspondence' });
  }
  for (const patch of [{ scopeOwner: 'foreign' }, { event: 'CanChat.Other.progressed' }]) {
    const x = await fixture(); await schedule(x.store, 'notice/1');
    await change(x.store, WORK_SCHEDULE_MODEL, 'notice/1', patch);
    assert.deepEqual(await readGenerationCallbackDiagnostics(await x.request(), x.store), { outcome: 'unsupported', reason: 'occurrence-correspondence' });
  }
  const x = await fixture(); const selector = await routed(x.store, 'notice/1');
  await change(x.store, WORK_HANDLER_OCCURRENCE_MODEL, handlerOccurrenceRowId('notice/1', selector.handler), { handler: 'CanChat.other' });
  assert.deepEqual(await readGenerationCallbackDiagnostics(await x.request(), x.store), { outcome: 'unsupported', reason: 'occurrence-correspondence' });
});

test('missing source membership, missing terminal and unsafe diagnostics refuse instead of empty success', async () => {
  for (const mode of ['source', 'terminal', 'unsafe'] as const) {
    const w = await fixture(), selector = await routed(w.store, 'notice/1'); await terminal(w.store, selector);
    const id = handlerOccurrenceRowId('notice/1', selector.handler);
    if (mode === 'source') await change(w.store, WORK_OCCURRENCE_MODEL, 'notice/1', {
      result: { fanouts: [], bounds: { pageLimit: 100, chunkSize: 100 }, handlers: [] } });
    if (mode === 'unsafe') await change(w.store, WORK_OCCURRENCE_MODEL, id, { message: 'private prompt or file' });
    const store = mode === 'terminal' ? { ...w.store, cohortLoad: async (input: Parameters<StoragePort['cohortLoad']>[0]) =>
      input.model === WORK_OCCURRENCE_MODEL && input.id === id ? null : w.store.cohortLoad(input) } : w.store;
    assert.deepEqual(await readGenerationCallbackDiagnostics(await w.request(), store), { outcome: 'unsupported', reason: 'occurrence-correspondence' });
  }
});

test('whole-model overflow and aggregate amplification refuse; no raw fallback', async () => {
  const w = await fixture(), effects: SystemStaging[] = [];
  for (let i = 0; i < 1001; i++) {
    const id = `unrelated/${String(i).padStart(4, '0')}`;
    effects.push(await workSchedulePutCommand.stage({ key: id, occurrenceId: id, scope, at: 100,
      event: 'CanChat.other', payload: { unrelated: 'x'.repeat(2100) } }, context(w.store)));
  }
  await commit(w.store, { writes: effects.flatMap(item => item.writes ?? []), schedules: effects.flatMap(item => item.schedules ?? []) });
  assert.deepEqual(await readGenerationCallbackDiagnostics(await w.request(), w.store), { outcome: 'unsupported', reason: 'bound-exceeded' });
  const x = await fixture();
  for (const missing of ['cohortIdentityPage', 'outboxGetBounded'] as const) {
    let rawReads = 0;
    const result = await readGenerationCallbackDiagnostics(await x.request(), { ...x.store,
      [missing]: undefined, outboxGet: async () => { rawReads++; throw Error('raw fallback forbidden'); } } as unknown as StoragePort);
    assert.deepEqual(result, { outcome: 'unsupported', reason: 'store-profile' });
    assert.equal(rawReads, 0); assert.equal(Object.isFrozen(result), true);
  }
});

test('captured request survives caller mutation; original revision movement throws', async () => {
  const w = await fixture(), request = await w.request();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
  const reader = readGenerationCallbackDiagnostics(request, { ...w.store, cohortLoad: async input => {
    await held; return w.store.cohortLoad(input); } });
  (request.origin.scope as { owner: string }).owner = 'changed-after-capture'; release();
  assert.equal((await reader).outcome, 'complete');
  // Restore the shared fixture declaration after the deliberate mutation.
  (request.origin.scope as { owner: string }).owner = scope.owner = 'team';
  const next = await w.request(); let moved = false;
  await assert.rejects(readGenerationCallbackDiagnostics(next, { ...w.store, outboxGetBounded: async input => {
    const result = await w.store.outboxGetBounded!.call(w.store, input); if (!moved) { moved = true; await w.store.commit(makeBatch(await w.store.readRevision())); }
    return result;
  } }), FenceConflictError);
});
