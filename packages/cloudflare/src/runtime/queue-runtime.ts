/** Durable source intake for an at-least-once broker. Work owns every retained route and terminal receipt. */
import type { ArtifactRuntimeBinding, CommitBatch, FrameworkOpaqueSourceRoute, ModelName, OccurrenceId, RecordId, Revision, StoragePort, WorkScope } from '@canlang/contracts';
import { resolveIdentity } from '@canlang/identity';
import { encodeValue, normalizeSchema, validateOperationInput } from '@canlang/values';
import { deriveOutboxIdAsync } from '@canlang/work/intent/staging';
import { handlerOccurrencePendingQuery, handlerOccurrenceRowId, readHandlerOccurrenceRow, stageHandlerOccurrence,
  type HandlerOccurrenceSelector } from '@canlang/work/kernel/handler-occurrence';
import { WORK_DISPATCH_MODEL, WORK_OCCURRENCE_MODEL, readDispatchRow, readOccurrenceRow, snapshotKernelJsonValue } from '@canlang/work/kernel/tables';
import { workOccurrencePutReceiptCommand } from '@canlang/work/kernel/occurrence-staging';
import type { SystemCommandContext } from '@canlang/state';
import { importVerifiedAssemblyModule } from './assembly-verification.js';
import { invokeRetainedHandlerOccurrenceCanonical, loadCanonicalDescriptors, revalidateQueueSourceGuard, loadCanonicalQueueStaging, type CanonicalRetainedHandlerOccurrenceOpts } from './invoke.js';
import type { ResourceEvent } from './resource-dispatch.js';

type QueueBinding = Extract<ArtifactRuntimeBinding, { kind: 'queue' }>;
export interface QueueRuntimeOptions extends Omit<CanonicalRetainedHandlerOccurrenceOpts, 'selector'> {
  readonly scope: WorkScope;
  /** Trusted actual actor composition, never taken from a broker message. */
  readonly rootAuthority?: { readonly binding: string; readonly rootId: string };
}
export interface QueueIntake {
  readonly sourceOccurrence: string;
  readonly selectors: readonly HandlerOccurrenceSelector[];
}
export interface QueueConsumption {
  readonly sourceOccurrence: string;
  readonly status: 'completed' | 'pending';
  readonly handlers: ReadonlyArray<{ readonly handler: string; readonly result: unknown }>;
}
export interface QueueRecovery {
  readonly visited: number;
  readonly completed: number;
  readonly cursor: string | null;
}
export interface QueueRuntime {
  accept(event: ResourceEvent): Promise<QueueIntake>;
  deliver(event: ResourceEvent, enqueue: (event: ResourceEvent) => Promise<void>): Promise<void>;
  consume(eventId: string): Promise<QueueConsumption>;
  recover(options?: { readonly limit?: number; readonly cursor?: string | null }): Promise<QueueRecovery>;
  reconcile(eventId: string): Promise<{ readonly kind: 'delivered'; readonly result: { readonly eventId: string } } | null>;
}
const own = (value: unknown, key: string): unknown => {
  if (typeof value !== 'object' || value === null) return undefined;
  const member = Object.getOwnPropertyDescriptor(value, key);
  if (member !== undefined && !('value' in member)) throw new Error('Queue source requires own data properties.');
  return member?.value;
};
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Queue source requires a JSON record.');
  return value as Record<string, unknown>;
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = object(value);
  if (Reflect.ownKeys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) throw new Error('Queue source has an invalid closed carrier.');
  return result;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(own(value, key))}`).join(',')}}`;
  return JSON.stringify(value);
}
function bounded(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Queue source needs a bounded nonempty identity.');
  return value;
}
export function queueSourceOccurrenceId(eventId: string): string { return `queue/v1/${encodeURIComponent(bounded(eventId))}`; }
async function identity(options: Pick<QueueRuntimeOptions, 'identities' | 'scope' | 'app'>, now: number): Promise<void> {
  if (options.scope.app !== options.app) throw new Error('Queue source scope disagrees with its deployment.');
  const current = await resolveIdentity(options.identities, options.scope.owner === 'app' || options.scope.owner === options.app
    ? {} : { team_id: options.scope.owner }, { clock: { nowMs: () => now } });
  if (current.actor !== null || (current.team?.team_id ?? (options.scope.owner === 'app' ? 'app' : options.app)) !== options.scope.owner) throw new Error('Queue source has no current verified owner.');
}
async function declaration(options: Pick<QueueRuntimeOptions, 'artifact' | 'asm' | 'app' | 'scope' | 'rootAuthority' | 'createRecordAllocator'>, binding: string): Promise<QueueBinding> {
  const entry = options.artifact.modules[0];
  if (entry === undefined) throw new Error('Queue source has no original compiled entry.');
  const module = await importVerifiedAssemblyModule(options.asm, entry.path, options.artifact);
  const definition = own(module, 'appDefinition');
  if (stable(own(definition, 'runtimeBindings')) !== stable(options.artifact.runtimeBindings)) throw new Error('Queue source inventory differs from its compiled entry.');
  const declaredApp = own(definition, 'id');
  const selected = declaredApp === options.app ? definition : own(own(definition, 'compositions'), options.app);
  const owners = own(selected, 'runtimeBindingOwners');
  const matches = options.artifact.runtimeBindings?.filter(value => value.kind === 'queue' && value.binding === binding) ?? [];
  if (matches.length !== 1 || matches[0]!.kind !== 'queue') throw new Error('Queue source does not name one declared queue.');
  const queue = matches[0] as QueueBinding;
  if (queue.binding !== `${queue.owner}.${queue.name}` || queue.owner !== options.scope.ownerPackage || !Array.isArray(owners) ||
      !owners.includes(queue.owner) || !owners.includes(options.app) || options.scope.app !== options.app ||
      !Array.isArray(queue.handlers) || queue.handlers.length > 200 || new Set(queue.handlers).size !== queue.handlers.length) throw new Error('Queue source lost its exact selected app/package/handler census.');
  for (const handler of queue.handlers) {
    const callable = options.artifact.callables.filter(value => value.kind === 'handler' && value.id === handler);
    const emitted = own(own(definition, 'operations'), handler), invocation = own(emitted, 'invocation');
    if (callable.length !== 1 || own(emitted, 'handler') !== handler || own(emitted, 'event') !== binding || own(emitted, 'read') !== false ||
        own(invocation, 'name') !== handler || own(invocation, 'kind') !== 'scenario' ||
        own(own(own(own(definition, 'events'), binding), 'inputs'), 'value') === undefined ||
        own(own(own(own(own(definition, 'events'), binding), 'inputs'), 'value'), 'type') !== queue.type ||
        own(own(definition, 'cohorts'), handler) !== undefined) throw new Error('Queue handler lost its original ordinary invocation/event declaration.');
    const root = own(invocation, 'rootAuthority');
    if (root !== undefined && (options.rootAuthority === undefined || own(root, 'binding') !== options.rootAuthority.binding ||
        own(root, 'createsRoot') === true || options.createRecordAllocator === undefined)) {
      throw new Error('Queue handler requires its actual existing root authority; cross-authority delivery is unavailable.');
    }
    await importVerifiedAssemblyModule(options.asm, callable[0]!.module, options.artifact);
  }
  return snapshotKernelJsonValue(queue, 'queue declaration');
}
async function load(store: StoragePort, model: ModelName, id: string, revision: Revision) {
  return store.cohortLoad({ model, id: id as RecordId, expectedRevision: revision });
}
async function original(options: QueueRuntimeOptions, eventId: string, binding: string, now: number, revision: Revision) {
  await identity(options, now);
  const queue = await declaration(options, binding);
  const retained = options.store.outboxGetBounded === undefined ? await options.store.outboxGet(eventId)
    : await options.store.outboxGetBounded({ intentId: eventId, expectedRevision: revision });
  if (retained === null || retained.originalCommit === undefined || retained.status === 'skipped') throw new Error('Queue source lacks its original retained outbox publication.');
  const saved = snapshotKernelJsonValue(retained, 'queue original'), stamp = saved.originalCommit!, intent = saved.intent;
  if (intent.intentId !== eventId || intent.target !== `${binding}.publish` || !Number.isSafeInteger(stamp.revision) || stamp.revision < 1 || stamp.revision > revision ||
      !Number.isSafeInteger(stamp.createdAt) || stamp.createdAt < 0 || stamp.createdAt > now) throw new Error('Queue source has invalid original publication provenance.');
  const carrier = closed(intent.arguments, ['binding', 'from', 'arguments']);
  if (carrier.binding !== binding || carrier.from !== binding) throw new Error('Queue source differs from its original intent binding.');
  const payload = snapshotKernelJsonValue(closed(carrier.arguments, ['value']), 'queue payload');
  const descriptors = await loadCanonicalDescriptors(options.asm, options.artifact, options.store);
  const declaredSchema = normalizeSchema({ operations: { [intent.target]: { inputs: { value: { type: queue.type } } } } });
  const schema = { ...declaredSchema, ...descriptors.valueSchema, operations: declaredSchema.operations };
  const decoded = validateOperationInput(schema, intent.target, payload);
  if (stable({ value: encodeValue(schema.operations[intent.target]!.inputs.value!.typeId, decoded.value!, undefined, schema) }) !== stable(payload)) throw new Error('Queue source payload is not exact declared wire data.');
  const dispatchRow = await load(options.store, WORK_DISPATCH_MODEL, eventId, revision);
  if (dispatchRow === null || dispatchRow.archivedAt !== null) throw new Error('Queue source lost its original physical Work dispatch row.');
  const dispatch = readDispatchRow(dispatchRow);
  if (dispatch.intentId !== eventId || dispatch.source !== intent.target || dispatch.occurrenceIndex !== intent.occurrenceIndex || dispatch.guardVerdict === false ||
      dispatchRow.created > stamp.createdAt || await deriveOutboxIdAsync(dispatch.operationId, dispatch.source, dispatch.occurrenceIndex) !== eventId) throw new Error('Queue source outbox/dispatch provenance disagrees.');
  if (dispatch.queuePayloadOrigin !== undefined && stable(dispatch.queuePayload) !== stable(payload)) throw new Error('Queue original publication payload differs from retained outbox arguments.');
  if (dispatch.filePayloadOrigin !== undefined) await revalidateQueueSourceGuard(options, options.scope, dispatchRow, revision);
  const origin = { intent, originalCommit: stamp, dispatch: { operationId: dispatch.operationId, source: dispatch.source,
    occurrenceIndex: dispatch.occurrenceIndex, originOccurrence: dispatch.originOccurrence, created: dispatchRow.created, createdBy: dispatchRow.createdBy,
    ...(dispatch.filePayloadOrigin === undefined ? {} : { sourceGuard: dispatch.sourceGuard, filePayloadOrigin: dispatch.filePayloadOrigin }),
    ...(dispatch.queuePayloadOrigin === undefined ? {} : { queuePayload: dispatch.queuePayload, queuePayloadOrigin: dispatch.queuePayloadOrigin }) } };
  if (await options.store.readRevision() !== revision) throw new Error('Queue source owner revision changed during its retained read.');
  return { queue, payload, origin, dispatch, dispatchRow };
}

/** A locator is never authority: re-read original intent, receipt, complete route census and current owner. */
export async function readCheckedQueueSource(options: QueueRuntimeOptions, occurrenceId: string, event: string, scope: WorkScope,
  now: number, expectedRevision?: Revision) {
  if (stable(scope) !== stable(options.scope)) throw new Error('Queue source scope differs from the selected actual owner store.');
  const revision = expectedRevision ?? await options.store.readRevision();
  const row = await load(options.store, WORK_OCCURRENCE_MODEL, occurrenceId, revision);
  if (row === null || row.archivedAt !== null) throw new Error('Queue source has no physical intake receipt.');
  const receipt = readOccurrenceRow(row), result = closed(receipt.result, ['kind', 'event', 'scope', 'payload', 'origin', 'handlers']);
  const intentId = own(own(result.origin, 'intent'), 'intentId');
  if (receipt.occurrenceId !== occurrenceId || receipt.status !== 'completed' || receipt.code !== null || receipt.message !== null || result.kind !== 'queue-source' || result.event !== event ||
      stable(result.scope) !== stable(scope) || typeof intentId !== 'string' || queueSourceOccurrenceId(intentId) !== occurrenceId) throw new Error('Queue source receipt does not match its exact retained identity/event/scope.');
  const facts = await original(options, intentId, event, now, revision);
  if (stable(facts.origin) !== stable(result.origin) || stable(facts.payload) !== stable(result.payload) || !Array.isArray(result.handlers) || result.handlers.length !== facts.queue.handlers.length) throw new Error('Queue source receipt differs from original outbox provenance, payload or handler census.');
  const handlers = result.handlers as Array<{ handler: string; occurrenceId: string; kind: 'ordinary' }>;
  const { opaque } = await loadCanonicalQueueStaging(options, scope, now);
  if (opaque !== null && facts.dispatch.queuePayloadOrigin !== undefined) await opaque.revalidateSource({ model: WORK_DISPATCH_MODEL, row: facts.dispatchRow, field: 'queuePayload', binding: facts.dispatch.queuePayloadOrigin }, revision, options.files);
  if (opaque !== null) {
    if (receipt.filePayloadOrigin?.origin.kind !== 'source-routing' || receipt.filePayloadOrigin.origin.recipe.kind !== 'queued-routes') throw new Error('Queue source lost its original typed intake header.');
    await opaque.revalidateSource({ model: WORK_OCCURRENCE_MODEL, row, field: 'result', binding: receipt.filePayloadOrigin }, revision, options.files);
  }
  for (const [index, handler] of facts.queue.handlers.entries()) {
    const route = closed(handlers[index], ['handler', 'occurrenceId', 'kind']);
    if (route.handler !== handler || route.kind !== 'ordinary' || route.occurrenceId !== handlerOccurrenceRowId(occurrenceId, handler)) throw new Error('Queue source handler census differs from its original declared order.');
    const physical = await load(options.store, 'work.handler_occurrence' as ModelName, route.occurrenceId as string, revision);
    if (physical === null || physical.archivedAt !== null) throw new Error('Queue source lost its physical handler association.');
    const retained = readHandlerOccurrenceRow(physical);
    if (retained.sourceOccurrence !== occurrenceId || retained.event !== event || retained.handler !== handler || retained.scopeApp !== scope.app ||
        retained.scopeOwner !== scope.owner || retained.scopeOwnerPackage !== scope.ownerPackage || stable(retained.payload) !== stable(facts.payload)) throw new Error('Queue source retained handler differs from original payload and owner.');
    if (opaque !== null) {
      if (retained.filePayloadOrigin?.origin.kind !== 'event-input') throw new Error('Queue handler lost its original typed input header.');
      await opaque.revalidateSource({ model: 'work.handler_occurrence' as ModelName, row: physical, field: 'payload', binding: retained.filePayloadOrigin }, revision, options.files);
    }
  }
  if (await options.store.readRevision() !== revision) throw new Error('Queue source changed during retained census validation.');
  return { receipt, result, payload: facts.payload, handlers, bounds: { maxMembers: 1, chunkSize: 1 } };
}
function context(options: QueueRuntimeOptions, now: number): SystemCommandContext {
  return { actor: `queue:${options.scope.ownerPackage}`, operation: 'queue.intake', now,
    load: options.store.load.bind(options.store), query: options.store.query.bind(options.store) };
}
export function createQueueRuntime(input: QueueRuntimeOptions): QueueRuntime {
  const options = { ...input, scope: Object.freeze(snapshotKernelJsonValue(input.scope, 'queue scope')) };
  const accept = async (raw: ResourceEvent): Promise<QueueIntake> => {
    const event = snapshotKernelJsonValue(raw, 'queue event');
    closed(event, ['eventId', 'source', 'arguments']);
    bounded(event.eventId);
    if (typeof event.source !== 'string' || !event.source.endsWith('.publish')) throw new Error('Queue source event has no declared publish target.');
    const binding = event.source.slice(0, -'.publish'.length), occurrenceId = queueSourceOccurrenceId(event.eventId);
    const revision = await options.store.readRevision(), now = options.now();
    const facts = await original(options, event.eventId, binding, now, revision);
    if (stable(facts.payload) !== stable(event.arguments)) throw new Error('Queue broker event differs from original committed arguments.');
    const selectors = facts.queue.handlers.map(handler => ({ sourceOccurrence: occurrenceId, handler, event: binding, scope: options.scope }));
    if (await load(options.store, WORK_OCCURRENCE_MODEL, occurrenceId, revision) !== null) {
      await readCheckedQueueSource(options, occurrenceId, binding, options.scope, now, revision);
      return { sourceOccurrence: occurrenceId, selectors };
    }
    if (facts.dispatch.state !== 'claimed' || facts.dispatch.claimId === null || facts.dispatch.claimedAtMs === null) {
      throw new Error('Fresh queue intake requires its actual claimed Work dispatch origin.');
    }
    const ctx = context(options, now), writes: CommitBatch['writes'][number][] = [];
    const { opaque, identity: ownerIdentity } = await loadCanonicalQueueStaging(options, options.scope, now);
    const eventDeclaration = opaque?.event(binding);
    const guardSource = facts.dispatch.filePayloadOrigin === undefined ? undefined : { model: WORK_DISPATCH_MODEL, row: facts.dispatchRow, field: 'sourceGuard' as const, binding: facts.dispatch.filePayloadOrigin };
    const retainedSource = facts.dispatch.queuePayloadOrigin === undefined ? guardSource : { model: WORK_DISPATCH_MODEL, row: facts.dispatchRow, field: 'queuePayload' as const, binding: facts.dispatch.queuePayloadOrigin };
    const routes: Array<Extract<FrameworkOpaqueSourceRoute, { kind: 'ordinary' }>> = [];
    for (const selector of selectors) {
      const source = { occurrenceId, event: binding, payload: facts.payload, scope: options.scope };
      let staged = await stageHandlerOccurrence({ source, handler: selector.handler }, ctx);
      if (staged.status !== 'ready') throw new Error('Queue intake cannot adopt an unreceipted preexisting handler route.');
      if (opaque !== null && eventDeclaration !== undefined) {
        const handler = opaque.callable(selector.handler);
        const filePayloadOrigin = await opaque.prepare({ expectedRevision: revision, model: 'work.handler_occurrence' as ModelName,
          row: staged.row, field: 'payload', scope: options.scope,
          origin: { kind: 'event-input', occurrenceId: staged.row.id as unknown as OccurrenceId, sourceOccurrence: occurrenceId as unknown as OccurrenceId,
            declaration: eventDeclaration, lineage: { kind: 'source', sourceOccurrence: occurrenceId as unknown as OccurrenceId }, target: { kind: 'handler', handler } },
          projection: { kind: 'inputs', path: [], declarationId: eventDeclaration.inputsDeclarationId }, value: facts.payload,
          identity: ownerIdentity, ...(options.files === undefined ? {} : { files: options.files }),
          ...(retainedSource === undefined ? {} : { retainedSource }) });
        staged = await stageHandlerOccurrence({ source, handler: selector.handler, filePayloadOrigin }, ctx);
        if (staged.status !== 'ready') throw new Error('Queue typed route changed during its original intake.');
        routes.push({ kind: 'ordinary', handler, occurrenceId: staged.row.id as unknown as OccurrenceId });
      }
      writes.push(...staged.effects.writes ?? []);
    }
    const result = { kind: 'queue-source', event: binding, scope: options.scope, payload: facts.payload, origin: facts.origin,
      handlers: selectors.map(selector => ({ handler: selector.handler, occurrenceId: handlerOccurrenceRowId(occurrenceId, selector.handler), kind: 'ordinary' })) };
    let staged = await workOccurrencePutReceiptCommand.stage({ occurrenceId, status: 'completed', result }, ctx);
    if (opaque !== null && eventDeclaration !== undefined) {
      const write = staged.writes?.[0];
      if (staged.writes?.length !== 1 || write?.kind !== 'insert') throw new Error('Queue source requires its exact original receipt row.');
      const { intentId, operation, operationId, target, occurrenceIndex } = facts.origin.intent;
      const guard = facts.dispatch.filePayloadOrigin?.origin;
      if (guard !== undefined && guard.kind !== 'send-guard') throw new Error('Queue retained payload origin is unavailable.');
      const additional = [{ projection: { kind: 'inputs' as const, path: ['origin', 'intent', 'arguments', 'arguments'], declarationId: eventDeclaration.inputsDeclarationId }, value: facts.payload },
        ...(guard === undefined ? [] : [{ projection: { kind: 'inputs' as const, path: ['origin', 'dispatch', 'sourceGuard', 'inputs'], declarationId: guard.inputsDeclarationId }, value: facts.dispatch.sourceGuard!.inputs, ...(guardSource === undefined ? {} : { retainedSource: guardSource }) }]),
        ...(facts.dispatch.queuePayloadOrigin === undefined ? [] : [{ projection: { kind: 'inputs' as const, path: ['origin', 'dispatch', 'queuePayload'], declarationId: eventDeclaration.inputsDeclarationId }, value: facts.payload }])];
      const filePayloadOrigin = await opaque.prepare({ expectedRevision: revision, model: WORK_OCCURRENCE_MODEL,
        row: write.row, field: 'result', scope: options.scope,
        origin: { kind: 'source-routing', occurrenceId: occurrenceId as unknown as OccurrenceId, revision: (revision + 1) as Revision,
          recipe: { kind: 'queued-routes', declaration: eventDeclaration, originalIntent: { intentId, operation, operationId, target, occurrenceIndex },
            originalCommit: facts.origin.originalCommit, ...(guard === undefined ? {} : { guard }), routes } },
        projection: { kind: 'inputs', path: ['payload'], declarationId: eventDeclaration.inputsDeclarationId }, value: facts.payload, additional,
        identity: ownerIdentity, ...(options.files === undefined ? {} : { files: options.files }),
        ...(retainedSource === undefined ? {} : { retainedSource }) });
      staged = await workOccurrencePutReceiptCommand.stage({ occurrenceId, status: 'completed', result, filePayloadOrigin }, ctx);
    }
    if (staged.writes?.length !== 1) throw new Error('Queue source receipt raced its durable intake.');
    await identity(options, now);
    await original(options, event.eventId, binding, now, revision);
    await options.store.commit({ expectedRevision: revision, writes: [...writes, ...staged.writes], history: [], receipt: null,
      outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [] });
    return { sourceOccurrence: occurrenceId, selectors };
  };
  const consume = async (eventId: string): Promise<QueueConsumption> => {
    const occurrenceId = queueSourceOccurrenceId(eventId), row = await options.store.load(WORK_OCCURRENCE_MODEL, occurrenceId as RecordId);
    if (row === null) throw new Error('Queue message has no original durable intake.');
    const event = bounded(own(readOccurrenceRow(row).result, 'event'));
    const source = await readCheckedQueueSource(options, occurrenceId, event, options.scope, options.now());
    const handlers: Array<{ handler: string; result: unknown }> = [];
    for (const route of source.handlers) handlers.push({ handler: route.handler, result: await invokeRetainedHandlerOccurrenceCanonical({ ...options,
      selector: { sourceOccurrence: occurrenceId, handler: route.handler, event, scope: options.scope } }) });
    return { sourceOccurrence: occurrenceId, handlers, status: handlers.some(route => own(route.result, 'status') === 'refused') ? 'pending' : 'completed' };
  };
  return {
    accept,
    async deliver(event, enqueue) { const captured = snapshotKernelJsonValue(event, 'queue event'); await accept(captured); await enqueue(captured); },
    consume,
    async recover({ limit = 100, cursor = null } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Queue recovery limit must be 1..100.');
      const rows = await options.store.query(handlerOccurrencePendingQuery(options.scope, { cursor, limit }));
      let visited = 0, completed = 0, last: string | null = cursor;
      for (const row of rows) {
        const route = readHandlerOccurrenceRow(row); visited++; last = row.id;
        if (route.state !== 'pending' || route.scopeApp !== options.app || route.scopeOwner !== options.scope.owner || route.scopeOwnerPackage !== options.scope.ownerPackage ||
            !options.artifact.runtimeBindings?.some(binding => binding.kind === 'queue' && binding.binding === route.event && binding.owner === options.scope.ownerPackage)) continue;
        await readCheckedQueueSource(options, route.sourceOccurrence, route.event, options.scope, options.now());
        const result = await invokeRetainedHandlerOccurrenceCanonical({ ...options, selector: { sourceOccurrence: route.sourceOccurrence,
          handler: route.handler, event: route.event, scope: options.scope } });
        if (own(result, 'status') !== 'refused') completed++;
      }
      return { visited, completed, cursor: rows.length === limit ? last : null };
    },
    async reconcile(eventId) {
      const occurrenceId = queueSourceOccurrenceId(eventId), row = await options.store.load(WORK_OCCURRENCE_MODEL, occurrenceId as RecordId);
      if (row === null) return null;
      const event = bounded(own(readOccurrenceRow(row).result, 'event'));
      await readCheckedQueueSource(options, occurrenceId, event, options.scope, options.now());
      return { kind: 'delivered', result: { eventId } };
    },
  };
}
