/** Internal retained Work evidence only. This reader grants no viewer authority. */
import type { GenerationCallbackDiagnosticRequest, GenerationCallbackDiagnosticResult,
  GenerationCallbackFailure, ModelName, RecordId, StoragePort, StoredRow } from '@canlang/contracts';
import { FenceConflictError } from '@canlang/state/storage/port';
import { WORK_DISPATCH_MODEL, WORK_SCHEDULE_MODEL, WORK_OCCURRENCE_MODEL,
  readDispatchRow, readDispatchImageCorrelation, readScheduleRow, readOccurrenceRow } from './tables.js';
import { WORK_HANDLER_OCCURRENCE_MODEL, handlerOccurrenceRowId, readHandlerOccurrenceRow } from './handler-occurrence.js';

class Refusal extends Error {
  constructor(readonly reason: Extract<GenerationCallbackDiagnosticResult, { outcome: 'unsupported' }>['reason']) { super(reason); }
}
const refuse = (reason: Refusal['reason']): never => { throw new Refusal(reason); };
const unsupported = (reason: Refusal['reason']): GenerationCallbackDiagnosticResult =>
  Object.freeze({ outcome: 'unsupported' as const, reason });
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return refuse('occurrence-correspondence');
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = object(value), own = Object.keys(row);
  if (own.length !== keys.length || own.some(key => !keys.includes(key))) return refuse('occurrence-correspondence');
  return row;
}
/** One expanded representation budget for the entire read, including unrelated rows. */
class Budget {
  nodes = 0; text = 0;
  capture(value: unknown, depth = 0, active = new Set<object>()): unknown {
    if (++this.nodes > 20_000 || depth > 32) return refuse('bound-exceeded');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') { this.add(value.length); return value; }
    if (typeof value !== 'object' || value === null || active.has(value)) return refuse('occurrence-correspondence');
    const array = Array.isArray(value);
    if (!array) object(value);
    else {
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      if (Object.getPrototypeOf(value) !== Array.prototype || length === undefined || !('value' in length) ||
          !Number.isSafeInteger(length.value) || length.value < 0) return refuse('occurrence-correspondence');
      if (length.value > 20_000 - this.nodes) return refuse('bound-exceeded');
    }
    active.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length > 20_001 - this.nodes) return refuse('bound-exceeded');
    if (array && (keys.length !== (value as unknown[]).length + 1 || keys.some(key =>
      key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= (value as unknown[]).length)))) return refuse('occurrence-correspondence');
    const result: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') return refuse('occurrence-correspondence');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable || descriptor.value === undefined) return refuse('occurrence-correspondence');
      this.add(key.length);
      Object.defineProperty(result, key, { value: this.capture(descriptor.value, depth + 1, active), enumerable: true });
    }
    active.delete(value);
    return Object.freeze(result);
  }
  add(units: number): void { if ((this.text += units) > 2_000_000) refuse('bound-exceeded'); }
}
function identity(value: unknown, maximum = 200): asserts value is string {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/.test(value)) return refuse('origin-correspondence');
  if (value.length > maximum) refuse('bound-exceeded');
  try { encodeURIComponent(value); } catch { refuse('origin-correspondence'); }
}
function ascending(a: string, b: string, order: StoragePort['cohortIdOrder']): boolean {
  if (order === 'utf16') return a < b;
  const encoder = new TextEncoder(), aa = encoder.encode(a), bb = encoder.encode(b);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i]! < bb[i]!;
  return aa.length < bb.length;
}

export async function readGenerationCallbackDiagnostics(original: GenerationCallbackDiagnosticRequest,
  store: StoragePort): Promise<GenerationCallbackDiagnosticResult> {
  const budget = new Budget();
  let phase: Refusal['reason'] = 'origin-correspondence';
  try {
    const request = budget.capture(original) as GenerationCallbackDiagnosticRequest;
    exact(request, ['origin', 'deliveryId', 'expectedRevision']);
    exact(request.origin, ['source', 'sourceRevision', 'binding', 'from', 'scope', 'event', 'handlers']);
    exact(request.origin.scope, ['app', 'owner', 'ownerPackage']);
    const { origin, deliveryId, expectedRevision } = request;
    if (Array.isArray(origin.handlers) && origin.handlers.length > 100) return refuse('bound-exceeded');
    identity(deliveryId, 128);
    for (const value of [origin.binding, origin.from, origin.scope.app, origin.scope.owner, origin.scope.ownerPackage]) identity(value);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
        !['std.ImagesV1.submit', 'std.TextGenerationV1.generate'].includes(origin.source) ||
        !origin.binding.startsWith(`${origin.scope.ownerPackage}.`) ||
        origin.event !== `${origin.binding}.${origin.source === 'std.ImagesV1.submit' ? 'submit' : 'generate'}.progressed` ||
        !/^(0|[1-9][0-9]*)$/.test(origin.sourceRevision) || !Array.isArray(origin.handlers) || origin.handlers.length === 0 ||
        new Set(origin.handlers).size !== origin.handlers.length) return refuse('origin-correspondence');
    for (const handler of origin.handlers) { identity(handler); if (!handler.startsWith(`${origin.scope.ownerPackage}.`)) refuse('origin-correspondence'); }
    if (typeof store.cohortIdentityPage !== 'function' || typeof store.cohortLoad !== 'function' ||
        typeof store.outboxGetBounded !== 'function' || !['utf16', 'utf8-binary'].includes(store.cohortIdOrder)) return refuse('store-profile');
    const fence = async () => { const actual = await store.readRevision(); if (actual !== expectedRevision) throw new FenceConflictError(expectedRevision, actual); };
    const load = async (model: ModelName, id: string): Promise<StoredRow | null> => {
      const row = await store.cohortLoad({ model, id: id as RecordId, expectedRevision });
      if (row === null) return null;
      const captured = budget.capture(row) as StoredRow;
      if (captured.id !== id) refuse('occurrence-correspondence');
      return captured;
    };
    await fence();
    const dispatchRow = await load(WORK_DISPATCH_MODEL, deliveryId);
    if (dispatchRow === null) return refuse('origin-correspondence');
    const dispatch = readDispatchRow(dispatchRow), correlation = readDispatchImageCorrelation(dispatchRow.data);
    await fence();
    const rawOutbox = await store.outboxGetBounded.call(store, { intentId: deliveryId, expectedRevision });
    await fence();
    if (rawOutbox === null) return refuse('origin-correspondence');
    const retained = budget.capture(rawOutbox) as typeof rawOutbox, intent = retained.intent, stamp = retained.originalCommit;
    const carrier = exact(intent.arguments, ['binding', 'from', 'arguments']);
    const args = exact(carrier.arguments, ['value']), value = object(args.value);
    if (correlation === null || stamp === undefined || !Number.isSafeInteger(stamp.revision) || stamp.revision < 1 ||
        stamp.revision > expectedRevision || !Number.isSafeInteger(stamp.createdAt) || stamp.createdAt !== dispatchRow.created ||
        intent.intentId !== deliveryId || dispatch.intentId !== deliveryId || dispatch.source !== origin.source || intent.target !== origin.source ||
        intent.operationId !== dispatch.operationId || intent.occurrenceIndex !== dispatch.occurrenceIndex ||
        correlation.requestRevision !== origin.sourceRevision || correlation.requestBinding !== origin.binding ||
        correlation.requestFrom !== origin.from || correlation.requestApp !== origin.scope.app || correlation.requestOwner !== origin.scope.owner ||
        carrier.binding !== origin.binding || carrier.from !== origin.from || value.source !== correlation.requestSource || value.revision !== origin.sourceRevision) return refuse('origin-correspondence');
    phase = 'occurrence-correspondence';
    const failures: GenerationCallbackFailure[] = [];
    let after: RecordId | null = null, visited = 0;
    while (true) {
      const limit = visited === 1000 ? 1 : Math.min(100, 1000 - visited);
      const ids = await store.cohortIdentityPage({ model: WORK_SCHEDULE_MODEL, after, limit, expectedRevision });
      budget.capture(ids);
      if (ids.length > limit) return refuse('bound-exceeded');
      if (visited === 1000 && ids.length !== 0) return refuse('bound-exceeded');
      if (ids.length === 0) break;
      for (const id of ids) {
        identity(id);
        if (after !== null && !ascending(after, id, store.cohortIdOrder)) return refuse('occurrence-correspondence');
        after = id; visited++;
        const row = await load(WORK_SCHEDULE_MODEL, id);
        if (row === null) return refuse('occurrence-correspondence');
        // Unrelated notifications remain counted, but are not decoded as callbacks.
        const data = object(row.data), payload = data.payload;
        const candidate = data.scopeApp === origin.scope.app && data.scopeOwner === origin.scope.owner &&
          data.scopeOwnerPackage === origin.scope.ownerPackage && data.event === origin.event;
        if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
          if (candidate) return refuse('occurrence-correspondence');
          continue;
        }
        const payloadId = (payload as Record<string, unknown>).delivery_id;
        if (payloadId !== deliveryId) {
          if (candidate && (typeof payloadId !== 'string' || payloadId === '')) return refuse('occurrence-correspondence');
          continue;
        }
        const schedule = readScheduleRow(row);
        exact(schedule.payload, ['delivery_id']);
        if (schedule.occurrenceId !== id || schedule.key !== id || schedule.replaces !== null ||
            schedule.scopeApp !== origin.scope.app || schedule.scopeOwner !== origin.scope.owner ||
            schedule.scopeOwnerPackage !== origin.scope.ownerPackage || schedule.event !== origin.event) return refuse('occurrence-correspondence');
        const sourceRow = await load(WORK_OCCURRENCE_MODEL, id);
        if (schedule.state !== 'admitted') {
          if (sourceRow !== null || !['pending', 'superseded', 'cancelled'].includes(schedule.state)) return refuse('occurrence-correspondence');
          continue;
        }
        if (sourceRow === null) return refuse('occurrence-correspondence');
        const source = readOccurrenceRow(sourceRow), result = exact(source.result, ['fanouts', 'bounds', 'handlers']);
        const bounds = exact(result.bounds, ['pageLimit', 'chunkSize']);
        if (source.occurrenceId !== id || source.status !== 'completed' || source.code !== null || source.message !== null ||
            !Array.isArray(result.fanouts) || result.fanouts.length !== 0 || !Array.isArray(result.handlers) ||
            result.handlers.length !== origin.handlers.length || !Number.isSafeInteger(bounds.pageLimit) || Number(bounds.pageLimit) < 1 ||
            !Number.isSafeInteger(bounds.chunkSize) || Number(bounds.chunkSize) < 1) return refuse('occurrence-correspondence');
        const seen = new Set<string>();
        for (const entry of result.handlers) {
          const route = exact(entry, ['handler', 'occurrenceId']);
          if (typeof route.handler !== 'string' || !origin.handlers.includes(route.handler) || seen.has(route.handler)) return refuse('occurrence-correspondence');
          seen.add(route.handler);
          const routeId = handlerOccurrenceRowId(id, route.handler);
          if (route.occurrenceId !== routeId) return refuse('occurrence-correspondence');
          const handlerRow = await load(WORK_HANDLER_OCCURRENCE_MODEL, routeId);
          if (handlerRow === null) return refuse('occurrence-correspondence');
          const handler = readHandlerOccurrenceRow(handlerRow);
          exact(handler.payload, ['delivery_id']);
          if (handler.sourceOccurrence !== id || handler.handler !== route.handler || handler.event !== schedule.event ||
              handler.payload.delivery_id !== deliveryId || handler.scopeApp !== schedule.scopeApp || handler.scopeOwner !== schedule.scopeOwner ||
              handler.scopeOwnerPackage !== schedule.scopeOwnerPackage) return refuse('occurrence-correspondence');
          const terminalRow = await load(WORK_OCCURRENCE_MODEL, routeId);
          if (handler.state === 'pending') { if (terminalRow !== null) return refuse('occurrence-correspondence'); continue; }
          if (terminalRow === null) return refuse('occurrence-correspondence');
          const terminal = readOccurrenceRow(terminalRow);
          if (terminal.occurrenceId !== routeId || terminal.status !== handler.state) return refuse('occurrence-correspondence');
          if (terminal.status === 'completed') { if (terminal.code !== null || terminal.message !== null) return refuse('occurrence-correspondence'); continue; }
          if (terminal.code !== 'require-false' || terminal.message !== 'handler requirement rejected the occurrence' || terminal.result !== null) return refuse('occurrence-correspondence');
          const failure: GenerationCallbackFailure = { deliveryId, sourceOccurrence: id, occurrenceId: routeId,
            handler: route.handler, event: origin.event, recordedAtMs: terminal.recordedAtMs,
            code: 'require-false', message: 'handler requirement rejected the occurrence' };
          budget.capture(failure); failures.push(Object.freeze(failure));
        }
      }
    }
    await fence();
    const result = { outcome: 'complete' as const, failures: Object.freeze(failures), snapshotAttribution: 'unsupported' as const };
    budget.capture(result);
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof FenceConflictError) throw error;
    if (error instanceof Refusal) return unsupported(
      phase === 'origin-correspondence' && error.reason === 'occurrence-correspondence' ? phase : error.reason);
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'limit') return unsupported('bound-exceeded');
    return unsupported(phase);
  }
}
