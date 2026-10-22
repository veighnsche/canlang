/** Owner-local standard completion issuer. Installed declaration wiring is not
 * Compiler projection/private admission or provider authentication. Only the
 * actual State stage can read an original retained delivery and consume it. */
import type { DomainWrite, ModelName, OccurrenceId, RecordId, ReceiptResultContext, StoredRow, WorkScope } from '@canlang/contracts';
import { readSystemCommandRetainedOutbox, systemCommandStageRevision,
  type SystemCommandContext, type SystemCommandDef, type SystemStaging } from '@canlang/state';
import type { FanoutCohortSpec } from '@canlang/state/fanout/cohort';
import { RECEIPT_MODEL, readReceiptRow, newReceiptRow, isStoredReceiptPayload } from '@canlang/state/receipt/tables';
import { encodeValue, normalizeSchema, parseTypeId, printTypeId, validateOperationInput, validateValue,
  type NormalizedSchema, type SchemaDescriptor } from '@canlang/values';
import { deriveOutboxIdAsync } from '../intent/staging.js';
import { isConsistentCompletion, isTerminalReceiptStatus } from '../receipt/index.js';
import { stageHandlerOccurrence, readHandlerOccurrenceRow, handlerOccurrenceRowId, WORK_HANDLER_OCCURRENCE_MODEL } from './handler-occurrence.js';
import { KernelTableError, WORK_DISPATCH_MODEL, WORK_OCCURRENCE_MODEL,
  WORK_FANOUT_INTENT_MODEL, WORK_FANOUT_CHECKPOINT_MODEL, WORK_FANOUT_CHILD_MODEL,
  readDispatchRow, readDispatchImageCorrelation, dispatchGenerationTargetProfile,
  newOccurrenceRow, readOccurrenceRow, newFanoutIntentRow, readFanoutIntentRow,
  newFanoutCheckpointRow, readFanoutCheckpointRow, newFanoutChildRow, readFanoutChildRow,
  fanoutIntentRowId, fanoutCheckpointRowId, fanoutChildRowId, type OccurrenceRowData, type DispatchRowData } from './tables.js';

export interface StandardCompletionDeclaration {
  readonly source: string;
  readonly event: string;
  readonly binding: string;
  readonly from: string;
  /** Original declared return, before the completion envelope adds nullability.
   * Values has no literal-null type; a void event uses json? plus this null. */
  readonly resultType: string | null;
  readonly handlers: readonly { readonly handler: string; readonly cohort?: FanoutCohortSpec }[];
}
export interface StandardCompletionSourceBounds {
  readonly maxSources: number;
  readonly maxHandlers: number;
  readonly maxMembers: number;
  readonly chunkSize: number;
}
export interface StandardCompletionSourceOptions {
  readonly scope: WorkScope;
  /** Same loaded declarations, including the source inputs and four-field event. */
  readonly schema: SchemaDescriptor;
  readonly modelNames: readonly string[];
  readonly declarations: readonly StandardCompletionDeclaration[];
  readonly bounds: StandardCompletionSourceBounds;
}
const refuse = (message: string): never => { throw new KernelTableError(`Standard completion source: ${message}`); };
function identity(value: unknown, max = 200): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return refuse('bounded identity required.');
  try { encodeURIComponent(value); } catch { return refuse('valid identity encoding required.'); }
  return value;
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER
    ? value : refuse('positive safe finite bound required.');
}
/** Snapshot before any await/Values read; accessors cannot supply source facts. */
function copySourceEntry(part: object, array: boolean, keys: readonly (string | symbol)[],
  child: (value: unknown, depth: number) => unknown, depth: number): unknown {
  const out: unknown[] | Record<string, unknown> = array ? [] : {};
  let length = 0;
  if (array) {
    const property = Object.getOwnPropertyDescriptor(part, 'length');
    if (property === undefined || !('value' in property) || !Number.isSafeInteger(property.value) || property.value < 0 ||
        property.value > 20_000 || keys.length !== property.value + 1) return refuse('dense bounded source arrays required.');
    length = property.value as number;
  }
  for (const key of keys) {
    if (array && key === 'length') continue;
    const property = Object.getOwnPropertyDescriptor(part, key);
    if (typeof key !== 'string' || property === undefined || !('value' in property) || !property.enumerable ||
        array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) return refuse('own enumerable source data required.');
    Object.defineProperty(out, key, { value: child(property.value, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return out;
}
function copyData(value: unknown): unknown {
  let nodes = 0; const active = new Set<object>();
  const copy = (part: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 32) return refuse('source data exceeds its finite budget.');
    if (part === null || typeof part === 'string' || typeof part === 'boolean' || typeof part === 'number' && Number.isFinite(part)) return part;
    if (typeof part !== 'object' || active.has(part)) return refuse('own JSON source data required.');
    const array = Array.isArray(part), prototype = Object.getPrototypeOf(part);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return refuse('own JSON source data required.');
    active.add(part);
    const keys = Reflect.ownKeys(part);
    if (keys.length > 20_000 - nodes) return refuse('source data exceeds its finite budget.');
    const out = copySourceEntry(part, array, keys, (entry, entryDepth) => copy(entry, entryDepth), depth);
    active.delete(part); return out;
  };
  try { return copy(value, 0); }
  catch (error) { if (error instanceof KernelTableError) throw error; return refuse('own JSON source data required.'); }
}
function closed(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== expected.length ||
      expected.some(key => !Object.hasOwn(value, key))) return refuse('closed source shape required.');
  return value as Record<string, unknown>;
}
function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const x = Object.keys(a), y = Object.keys(b);
  return x.length === y.length && x.every(key => Object.hasOwn(b, key) &&
    equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
function wireInputs(schema: NormalizedSchema, operation: string, wire: unknown): Record<string, unknown> {
  const definition = schema.operations[operation];
  if (definition === undefined || definition.mutation) return refuse('same-load source/event input declaration required.');
  const checked = validateOperationInput(schema, operation, wire);
  const encoded: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(definition.inputs)) {
    Object.defineProperty(encoded, name, { value: encodeValue(field.typeId, checked[name]!), enumerable: true });
  }
  if (!equal(encoded, wire)) return refuse('retained inputs must already have their declared canonical wire representation.');
  return encoded;
}
function terminalResult(schema: NormalizedSchema, declaration: StandardCompletionDeclaration, payload: Record<string, unknown>): void {
  if (payload['status'] !== 'succeeded') return;
  if (declaration.resultType === null) {
    if (payload['result'] !== null) return refuse('void completion carries a result.');
  } else {
    const checked = validateValue(schema, declaration.resultType, payload['result'], 'create');
    if (!equal(encodeValue(declaration.resultType, checked), payload['result'])) return refuse('terminal result differs from its original declared wire type.');
  }
}
function readDeclaredHandler(rawHandler: unknown, scope: WorkScope, modelNames: readonly string[],
  handlersSeen: Set<string>): { readonly handler: string; readonly cohort?: FanoutCohortSpec } {
  const hasCohort = typeof rawHandler === 'object' && rawHandler !== null && Object.hasOwn(rawHandler, 'cohort');
  const route = closed(rawHandler, hasCohort ? ['handler', 'cohort'] : ['handler']);
  const handler = identity(route['handler']);
  if (handlersSeen.has(handler)) return refuse('duplicate ordinary/cohort handler.');
  handlersSeen.add(handler);
  if (!hasCohort) return { handler };
  const candidate = route['cohort'] as Record<string, unknown>, kind = candidate?.['kind'];
  const cohort = closed(candidate, kind === 'model' ? ['kind', 'owner', 'model'] : ['kind', 'owner', 'model', 'parent']);
  const owner = identity(cohort['owner']), model = identity(cohort['model']);
  if (owner !== scope.owner || !modelNames.includes(model)) return refuse('same-owner declared cohort model required.');
  if (kind === 'model') return { handler, cohort: { kind, owner, model } as FanoutCohortSpec };
  if (kind !== 'anchored-collection') return refuse('unsupported cohort kind.');
  const parent = closed(cohort['parent'], ['model', 'id']);
  const parentModel = identity(parent['model']);
  if (!modelNames.includes(parentModel)) return refuse('same-load cohort parent model required.');
  return { handler, cohort: { kind, owner, model, parent: { model: parentModel, id: identity(parent['id']) } } as FanoutCohortSpec };
}
function checkCompletionEnvelope(completion: NormalizedSchema['operations'][string], schema: NormalizedSchema): void {
  const inputs = completion.inputs;
  closed(inputs, ['delivery_id', 'status', 'result', 'error']);
  const status = inputs['status']!.type, statusCases = status.base.kind === 'enum' ? status.base.cases :
    status.base.kind === 'nominal' ? schema.enums[status.base.path]?.cases : undefined;
  if (inputs['delivery_id']!.typeId !== 'text' || status.array || status.nullable || statusCases === undefined ||
      statusCases.length !== 4 || ['succeeded', 'failed', 'unknown', 'skipped'].some(value => !statusCases.includes(value)) ||
      !inputs['result']!.type.nullable || !inputs['error']!.type.nullable) return refuse('exact declared completion envelope required.');
}
function readSourceDeclaration(raw: unknown, scope: WorkScope, schema: NormalizedSchema,
  modelNames: readonly string[], bounds: StandardCompletionSourceBounds,
  seen: Set<string>, events: Set<string>, handlers: { count: number }): StandardCompletionDeclaration {
  const data = closed(raw, ['source', 'event', 'binding', 'from', 'resultType', 'handlers']);
  const source = identity(data['source']), event = identity(data['event']), binding = identity(data['binding']), from = identity(data['from']);
  const resultType = data['resultType'] === null ? null : identity(data['resultType']);
  if (resultType !== null && printTypeId(parseTypeId(resultType)) !== resultType) return refuse('canonical original result type required.');
  if (!/^std\.[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(source) || !event.endsWith('.completed')) return refuse('declared standard operation/completion required.');
  const key = `${source}\0${binding}\0${from}`;
  if (seen.has(key) || events.has(event)) return refuse('ambiguous source or completion declaration.');
  seen.add(key); events.add(event);
  const sourceInputs = schema.operations[source], completion = schema.operations[event];
  if (sourceInputs === undefined || sourceInputs.mutation || completion === undefined || completion.mutation) return refuse('declared source/event input schema required.');
  const inputs = completion.inputs;
  checkCompletionEnvelope(completion, schema);
  const completionResult = resultType === null ? 'json?' : resultType.endsWith('?') ? resultType : `${resultType}?`;
  if (inputs['result']!.typeId !== completionResult) return refuse('completion result differs from the original declared return.');
  if (!Array.isArray(data['handlers']) || (handlers.count += data['handlers'].length) > bounds.maxHandlers) return refuse('complete handler inventory exceeds bound.');
  const handlersSeen = new Set<string>();
  const routes = (data['handlers'] as unknown[]).map(rawHandler => readDeclaredHandler(rawHandler, scope, modelNames, handlersSeen));
  return freeze({ source, event, binding, from, resultType, handlers: routes });
}
function installed(options: StandardCompletionSourceOptions) {
  const config = closed(copyData(options), ['scope', 'schema', 'modelNames', 'declarations', 'bounds']);
  const rawScope = closed(config['scope'], ['app', 'owner', 'ownerPackage']);
  const scope: WorkScope = freeze({ app: identity(rawScope['app']), owner: identity(rawScope['owner']), ownerPackage: identity(rawScope['ownerPackage']) });
  const rawBounds = closed(config['bounds'], ['maxSources', 'maxHandlers', 'maxMembers', 'chunkSize']);
  const bounds: StandardCompletionSourceBounds = freeze({ maxSources: count(rawBounds['maxSources']), maxHandlers: count(rawBounds['maxHandlers']),
    maxMembers: count(rawBounds['maxMembers']), chunkSize: count(rawBounds['chunkSize']) });
  if (!Array.isArray(config['modelNames'])) return refuse('same-load model inventory required.');
  const modelNames = (config['modelNames'] as unknown[]).map(name => identity(name));
  if (new Set(modelNames).size !== modelNames.length) return refuse('duplicate loaded model declaration.');
  const schemaDescriptor = config['schema'] as SchemaDescriptor, schema = normalizeSchema(schemaDescriptor);
  if (!Array.isArray(config['declarations']) || config['declarations'].length > bounds.maxSources) return refuse('complete source inventory exceeds bound.');
  const seen = new Set<string>(), events = new Set<string>(), handlers = { count: 0 };
  const declarations = (config['declarations'] as unknown[]).map(raw =>
    readSourceDeclaration(raw, scope, schema, modelNames, bounds, seen, events, handlers));
  return freeze({ scope, bounds, schema, schemaDescriptor, modelNames, declarations });
}
/** Real source only; a caller supplies an identity, never a completion DTO or routes.
 * Complete routes and cohort cuts are returned for ONE original fenced commit. */
type InstalledCompletionConfig = ReturnType<typeof installed>;
type RetainedOutboxDelivery = NonNullable<Awaited<ReturnType<typeof readSystemCommandRetainedOutbox>>>;
const readRetainedDelivery = (retained: RetainedOutboxDelivery, revision: number, now: number, deliveryId: string) => {
  const original = copyData(retained) as typeof retained, intent = original.intent, stamp = original.originalCommit;
  if (!['pending', 'dispatched', 'skipped'].includes(original.status) || stamp === undefined ||
      !Number.isSafeInteger(stamp.revision) || stamp.revision < 1 || stamp.revision > revision ||
      !Number.isSafeInteger(stamp.createdAt) || stamp.createdAt < 0 || stamp.createdAt > now || intent.intentId !== deliveryId) return refuse('actual original publication stamp required.');
  return { original, intent, stamp };
};
const readDispatchCorrespondence = async (ctx: SystemCommandContext, deliveryId: string,
  intent: { readonly target: string; readonly occurrenceIndex: number }, stamp: { readonly createdAt: number }) => {
  const dispatch = await ctx.load(WORK_DISPATCH_MODEL, deliveryId as RecordId);
  if (dispatch === null) return refuse('original joined dispatch row is absent.');
  const dispatchRow = copyData(dispatch) as StoredRow, data = readDispatchRow(dispatchRow);
  if (dispatchRow.archivedAt !== null || dispatchRow.id !== deliveryId || data.intentId !== deliveryId || data.source !== intent.target ||
      data.occurrenceIndex !== intent.occurrenceIndex || dispatchRow.created > stamp.createdAt ||
      await deriveOutboxIdAsync(data.operationId, data.source, data.occurrenceIndex) !== deliveryId) return refuse('retained delivery/dispatch original correspondence is invalid.');
  return { dispatchRow, data };
};
const readGenerationContext = (config: InstalledCompletionConfig, data: DispatchRowData,
  declaration: StandardCompletionDeclaration, request: Record<string, unknown>) => {
  // Operator staging deliberately separates the L3 run key from the true
  // Work origin. Preserve both; derive only from the actual Work origin.
  const correlation = readDispatchImageCorrelation(data);
  const profile = dispatchGenerationTargetProfile(data.source);
  let resultContext: ReceiptResultContext | undefined;
  if (profile !== null) {
    const requestArgs = request['arguments'] as Record<string, unknown>, value = profile.role === 'control' ? requestArgs : requestArgs['value'];
    if (correlation === null || correlation.requestApp !== config.scope.app || correlation.requestOwner !== config.scope.owner ||
        correlation.requestBinding !== declaration.binding || correlation.requestFrom !== declaration.from ||
        typeof value !== 'object' || value === null || Array.isArray(value) ||
        (value as Record<string, unknown>)['source'] !== correlation.requestSource || (value as Record<string, unknown>)['revision'] !== correlation.requestRevision) return refuse('original declared generation correlation required.');
    const result = config.schemaDescriptor.contracts?.[profile.resultName];
    if (result === undefined || config.schema.operations[declaration.event]!.inputs['result']!.typeId !== `${profile.resultName}?`) return refuse('owning declared generation result required.');
    resultContext = { source: data.source, declaredResult: { name: profile.resultName,
      fields: Object.entries(result.fields).map(([name, field]) => ({ name, type: field.type })) },
      request: { source: correlation.requestSource, revision: correlation.requestRevision } };
  } else if (correlation !== null) return refuse('generation correlation on a foreign source.');
  return { correlation, resultContext };
};
export function createStandardCompletionSourceCommand(options: StandardCompletionSourceOptions): Omit<SystemCommandDef, 'read'> & {
  readonly read: (args: Readonly<Record<string, unknown>>, ctx: SystemCommandContext) => Promise<OccurrenceRowData>;
  readonly initializeReceipt: (args: Readonly<Record<string, unknown>>, ctx: SystemCommandContext) => Promise<SystemStaging>;
} {
  const config = installed(options);
  const originalSource = async (args: Readonly<Record<string, unknown>>, ctx: SystemCommandContext) => {
    const revision = systemCommandStageRevision(ctx);
    const input = closed(copyData(args), ['deliveryId']), deliveryId = identity(input['deliveryId'], 128);
    const retained = await readSystemCommandRetainedOutbox(ctx, deliveryId);
    if (retained === null) return refuse('original retained delivery is absent.');
    const { intent, stamp } = readRetainedDelivery(retained, revision, ctx.now, deliveryId);
    const request = closed(intent.arguments, ['binding', 'from', 'arguments']);
    const declaration = config.declarations.find(source => source.source === intent.target && source.binding === request['binding'] && source.from === request['from']);
    if (declaration === undefined) return refuse('retained delivery has no exact installed source declaration.');
    wireInputs(config.schema, declaration.source, request['arguments']);
    const { dispatchRow, data } = await readDispatchCorrespondence(ctx, deliveryId, intent, stamp);
    const { correlation, resultContext } = readGenerationContext(config, data, declaration, request);
    const sourceOccurrence = `standard-completion/v1/${encodeURIComponent(deliveryId)}` as OccurrenceId;
    const definition = { scope: config.scope, declaration, schema: config.schemaDescriptor, modelNames: config.modelNames, bounds: config.bounds };
    const origin = { intent, originalCommit: stamp, dispatch: { operationId: data.operationId, source: data.source,
      occurrenceIndex: data.occurrenceIndex, originOccurrence: data.originOccurrence, created: dispatchRow.created, actor: dispatchRow.createdBy,
      ...(correlation === null ? {} : { correlation }) } };
    return { revision, deliveryId, stamp, declaration, dispatchRow, data, resultContext, sourceOccurrence, definition, origin };
  };
interface ConsumedOriginal {
  readonly revision: number; readonly deliveryId: string;
  readonly stamp: { readonly revision: number };
  readonly declaration: StandardCompletionDeclaration;
  readonly resultContext: ReceiptResultContext | undefined;
  readonly sourceOccurrence: OccurrenceId;
  readonly definition: unknown; readonly origin: unknown;
}
const readConsumedSource = (consumed: StoredRow, original: ConsumedOriginal) => {
  const row = copyData(consumed) as StoredRow, receipt = readOccurrenceRow(row);
  const source = closed(receipt.result, ['kind', 'definition', 'origin', 'terminal', 'event', 'payload', 'revision', 'handlers']);
  if (row.archivedAt !== null || receipt.occurrenceId !== original.sourceOccurrence || receipt.status !== 'completed' ||
      receipt.code !== null || receipt.message !== null ||
      source['kind'] !== 'standard-completion-source' || source['event'] !== original.declaration.event ||
      !equal(source['definition'], original.definition) || !equal(source['origin'], original.origin)) return refuse('consumed source differs from its original declaration/delivery.');
  return { row, receipt, source };
};
const checkConsumedTerminal = (config: InstalledCompletionConfig, source: Record<string, unknown>, original: ConsumedOriginal) => {
  const payload = wireInputs(config.schema, original.declaration.event, source['payload']);
  const terminal = closed(source['terminal'], ['revision', 'status', 'result', 'error']);
  if (payload['delivery_id'] !== original.deliveryId || !isConsistentCompletion(payload['status'], payload['result'], payload['error']) ||
      !equal({ revision: terminal['revision'], status: payload['status'], result: payload['result'], error: payload['error'] }, terminal) ||
      !['succeeded', 'failed', 'skipped'].includes(payload['status'] as string) ||
      !isStoredReceiptPayload(payload['status'], payload['result'], payload['error'], original.resultContext) ||
      !Number.isSafeInteger(source['revision']) || (source['revision'] as number) < original.stamp.revision || (source['revision'] as number) > original.revision ||
      !Number.isSafeInteger(terminal['revision']) || (terminal['revision'] as number) < original.stamp.revision ||
      (terminal['revision'] as number) > (source['revision'] as number) ||
      !Array.isArray(source['handlers']) || source['handlers'].length !== original.declaration.handlers.length) return refuse('consumed terminal source is malformed.');
  terminalResult(config.schema, original.declaration, payload);
  return { payload, terminal, handlers: source['handlers'] };
};
const checkConsumedOrdinaryRoute = async (config: InstalledCompletionConfig, ctx: SystemCommandContext,
  original: ConsumedOriginal, payload: Record<string, unknown>,
  handler: string, handlers: readonly unknown[], index: number): Promise<void> => {
  const routeId = handlerOccurrenceRowId(original.sourceOccurrence, handler);
  const stored = closed(handlers[index], ['handler', 'kind', 'occurrenceId']);
  if (!equal(stored, { handler, kind: 'ordinary', occurrenceId: routeId })) return refuse('consumed ordinary inventory differs.');
  const retainedRow = await ctx.load(WORK_HANDLER_OCCURRENCE_MODEL, routeId as RecordId);
  if (retainedRow === null || retainedRow.archivedAt !== null) return refuse('consumed ordinary route is absent.');
  const ordinary = readHandlerOccurrenceRow(copyData(retainedRow) as StoredRow);
  if (ordinary.sourceOccurrence !== original.sourceOccurrence || ordinary.handler !== handler || ordinary.event !== original.declaration.event ||
      ordinary.scopeApp !== config.scope.app || ordinary.scopeOwner !== config.scope.owner || ordinary.scopeOwnerPackage !== config.scope.ownerPackage ||
      !equal(ordinary.payload, payload)) return refuse('consumed ordinary route differs.');
};
const checkConsumedCohortChild = async (ctx: SystemCommandContext, sourceOccurrence: OccurrenceId,
  handler: string, fanoutId: string, recordId: string): Promise<void> => {
  const childRow = await ctx.load(WORK_FANOUT_CHILD_MODEL, fanoutChildRowId(sourceOccurrence, handler, recordId) as RecordId);
  if (childRow === null || childRow.archivedAt !== null) return refuse('consumed initial cohort child is absent.');
  const child = readFanoutChildRow(copyData(childRow) as StoredRow);
  if (child.fanoutId !== fanoutId || child.parentOccurrence !== sourceOccurrence || child.handler !== handler || child.recordId !== recordId) return refuse('consumed initial cohort child differs.');
};
const checkConsumedCohortRoute = async (config: InstalledCompletionConfig, ctx: SystemCommandContext,
  original: ConsumedOriginal, handlers: readonly unknown[],
  handler: string, cohort: FanoutCohortSpec, index: number): Promise<void> => {
  const stored = closed(handlers[index], ['handler', 'kind', 'cohort', 'fanoutId', 'members', 'memberCount', 'firstChunkCount', 'cursor']);
  const fanoutId = fanoutIntentRowId(original.sourceOccurrence, handler, cohort.kind);
  const retainedRow = await ctx.load(WORK_FANOUT_INTENT_MODEL, fanoutId as RecordId);
  if (retainedRow === null || retainedRow.archivedAt !== null) return refuse('consumed frozen cohort is absent.');
  const fanout = readFanoutIntentRow(copyData(retainedRow) as StoredRow);
  const first = fanout.members.slice(0, config.bounds.chunkSize), cursor = first.length === fanout.memberCount ? null : `admit/v2/${first.length}`;
  if (fanout.sourceOccurrence !== original.sourceOccurrence || fanout.handler !== handler || fanout.cohort !== cohort.kind ||
      fanout.memberCount > config.bounds.maxMembers || !equal(stored, { handler, kind: 'fanout', cohort,
        fanoutId, members: fanout.members, memberCount: fanout.memberCount, firstChunkCount: first.length, cursor })) return refuse('consumed frozen cohort differs.');
  const checkpointRow = await ctx.load(WORK_FANOUT_CHECKPOINT_MODEL, fanoutCheckpointRowId(fanoutId) as RecordId);
  if (checkpointRow === null || checkpointRow.archivedAt !== null || readFanoutCheckpointRow(copyData(checkpointRow) as StoredRow).fanoutId !== fanoutId) return refuse('consumed cohort checkpoint is absent.');
  for (const recordId of first) {
    await checkConsumedCohortChild(ctx, original.sourceOccurrence, handler, fanoutId, recordId);
  }
};
  // One complete consumed validator owns both fenced replay and genuine reads.
  const readConsumed = async (consumed: StoredRow, original: ConsumedOriginal,
    ctx: SystemCommandContext): Promise<OccurrenceRowData> => {
    const { receipt, source } = readConsumedSource(consumed, original);
    const { payload, handlers } = checkConsumedTerminal(config, source, original);
    for (const [index, route] of original.declaration.handlers.entries()) {
      if (route.cohort === undefined) {
        await checkConsumedOrdinaryRoute(config, ctx, original, payload, route.handler, handlers, index);
        continue;
      }
      await checkConsumedCohortRoute(config, ctx, original, handlers, route.handler, route.cohort, index);
    }
    return freeze(receipt);
  };
  return Object.freeze({ name: 'work.standard-completion.stage',
    initializeReceipt: async (args: Readonly<Record<string, unknown>>, ctx: SystemCommandContext) => {
      const original = await originalSource(args, ctx);
      const { deliveryId, declaration, revision, origin } = original;
      if (original.resultContext !== undefined) return refuse('unassociated receipt requires the original capability carrier.');
      const existing = await ctx.load(RECEIPT_MODEL as ModelName, deliveryId as RecordId);
      const initialization = { deliveryId, event: declaration.event, revision, origin };
      if (existing !== null) {
        const receipt = readReceiptRow(existing);
        if (existing.archivedAt !== null || receipt.receipt.deliveryId !== deliveryId) return refuse('original retained receipt is unavailable.');
        return { result: { status: 'replayed', ...initialization } };
      }
      const row = newReceiptRow({ deliveryId, revision: revision + 1, status: 'pending', result: null,
        error: null, contentRef: null, resultExpiresAtMs: null }, { nowMs: ctx.now, actor: ctx.actor });
      return { writes: [{kind:'insert' as const, model: RECEIPT_MODEL as ModelName, row}],
        result: { status: 'initialized', ...initialization } };
    },
    read: async (args: Readonly<Record<string, unknown>>, ctx: SystemCommandContext): Promise<OccurrenceRowData> => {
      const original = await originalSource(args, ctx);
      const consumed = await ctx.load(WORK_OCCURRENCE_MODEL, original.sourceOccurrence as RecordId);
      // Read authority never captures a current receipt or a new cohort cut.
      if (consumed === null) return refuse('completion source has not been consumed.');
      return readConsumed(consumed, original, ctx);
    },
    stage: async (args: Readonly<Record<string, unknown>>, ctx: SystemCommandContext) => {
    const original = await originalSource(args, ctx);
    const { revision, deliveryId, stamp, declaration, dispatchRow, data, resultContext, sourceOccurrence, definition, origin } = original;
    const consumed = await ctx.load(WORK_OCCURRENCE_MODEL, sourceOccurrence as RecordId);
    if (consumed !== null) {
      const receipt = await readConsumed(consumed, original, ctx);
      const source = receipt.result as { payload: Readonly<Record<string, unknown>> };
      return { result: freeze({ status: 'replayed', sourceOccurrence, event: declaration.event, payload: source.payload }) };
    }
  type PersistedReceipt = ReturnType<typeof readReceiptRow>;
  type CompletionSource = Parameters<typeof stageHandlerOccurrence>[0]['source'];
  type CompletionInserter = (model: ModelName, effectRow: StoredRow) => Promise<void>;
  const readPersistedReceipt = async (deliveryId: string, resultContext: ReceiptResultContext | undefined,
    stampRevision: number, revision: number, dispatchCreated: number) => {
    const receiptRow = await ctx.load(RECEIPT_MODEL as ModelName, deliveryId as RecordId);
    if (receiptRow === null) return refuse('persisted delivery receipt is absent.');
    const row = copyData(receiptRow) as StoredRow;
    closed(row.data, ['deliveryId', 'revision', 'status', 'result', 'error', 'contentRef', 'resultExpiresAtMs',
      ...(Object.hasOwn(row.data, 'filePayloadOrigin') ? ['filePayloadOrigin'] : [])]);
    const receipt = readReceiptRow(row, resultContext), terminal = receipt.receipt;
    if (row.archivedAt !== null || terminal.deliveryId !== deliveryId || terminal.revision < stampRevision || terminal.revision > revision ||
        row.created < dispatchCreated || row.updated < row.created || row.updated > ctx.now) return refuse('persisted receipt has invalid original chronology.');
    return { receipt, terminal };
  };
  const buildTerminalPayload = (deliveryId: string, receipt: PersistedReceipt,
    terminal: PersistedReceipt['receipt'], now: number, guardVerdict: DispatchRowData['guardVerdict']) => {
    if (receipt.contentRef !== null || receipt.resultExpiresAtMs !== null && receipt.resultExpiresAtMs <= now) return refuse('original retained result availability is absent.');
    if (!isConsistentCompletion(terminal.status, terminal.result, terminal.error) || guardVerdict === false && terminal.status !== 'skipped') return refuse('persisted terminal receipt is inconsistent.');
    const payload = freeze(wireInputs(config.schema, declaration.event, { delivery_id: deliveryId,
      status: terminal.status, result: terminal.result, error: terminal.error }));
    terminalResult(config.schema, declaration, payload);
    return payload;
  };
  const stageOrdinaryCompletionRoute = async (source: CompletionSource, handler: string,
    insert: CompletionInserter, handlers: Record<string, unknown>[]): Promise<void> => {
    const ordinary = await stageHandlerOccurrence({ source, handler }, ctx);
    if (ordinary.status !== 'ready') return refuse('ordinary handler route is not fresh.');
    readHandlerOccurrenceRow(ordinary.row);
    const effects = ordinary.effects.writes ?? [];
    if (effects.length !== 1 || effects[0]?.kind !== 'insert' || effects[0].row !== ordinary.row) return refuse('unexpected ordinary route effects.');
    await insert(effects[0].model, ordinary.row);
    handlers.push({ handler, kind: 'ordinary', occurrenceId: ordinary.occurrence.occurrenceId });
  };
  const collectCohortIds = (members: StoredRow[], cohort: FanoutCohortSpec): string[] => members.map((member, index) => {
    const id = identity(member.id);
    if (member.archivedAt !== null || index > 0 && members[index - 1]!.id >= id ||
        cohort.kind === 'anchored-collection' && (member.parent?.model !== cohort.parent.model || member.parent.id !== cohort.parent.id)) return refuse('cohort census is not a canonical complete owner selection.');
    return id;
  });
  const stageCohortCompletionRoute = async (sourceOccurrence: OccurrenceId, handler: string, cohort: FanoutCohortSpec,
    meta: Parameters<typeof newFanoutIntentRow>[1], insert: CompletionInserter, handlers: Record<string, unknown>[]): Promise<void> => {
    if (cohort.kind === 'anchored-collection') {
      const parent = await ctx.load(cohort.parent.model as ModelName, cohort.parent.id as RecordId);
      if (parent === null || parent.archivedAt !== null || parent.id !== cohort.parent.id) return refuse('anchored cohort parent is unavailable.');
    }
    // One extra row detects overflow without truncating an accepted cut.
    const members = copyData(await ctx.query({ model: cohort.model as ModelName, authority: 'owner', archived: 'exclude',
      order: [{ field: 'id', direction: 'asc' }], limit: config.bounds.maxMembers + 1,
      ...(cohort.kind === 'anchored-collection' ? { parent: { model: cohort.parent.model as ModelName, id: cohort.parent.id as RecordId } } : {}) })) as StoredRow[];
    if (members.length > config.bounds.maxMembers) return refuse('complete cohort membership exceeds bound.');
    const ids = collectCohortIds(members, cohort);
    const intentRow = newFanoutIntentRow({ sourceOccurrence, handler, cohort: cohort.kind, members: ids }, meta);
    const fanout = readFanoutIntentRow(intentRow), first = fanout.members.slice(0, config.bounds.chunkSize);
    const cursor = first.length === fanout.memberCount ? null : `admit/v2/${first.length}`;
    const checkpoint = newFanoutCheckpointRow({ fanoutId: fanout.fanoutId, cursor }, meta);
    readFanoutCheckpointRow(checkpoint);
    await insert(WORK_FANOUT_INTENT_MODEL, intentRow); await insert(WORK_FANOUT_CHECKPOINT_MODEL, checkpoint);
    for (const recordId of first) {
      const child = newFanoutChildRow({ fanoutId: fanout.fanoutId, parentOccurrence: sourceOccurrence, handler, recordId }, meta);
      readFanoutChildRow(child); await insert(WORK_FANOUT_CHILD_MODEL, child);
    }
    handlers.push({ handler, kind: 'fanout', cohort, fanoutId: fanout.fanoutId,
      members: fanout.members, memberCount: fanout.memberCount, firstChunkCount: first.length, cursor });
  };
    const { receipt, terminal } = await readPersistedReceipt(deliveryId, resultContext, stamp.revision, revision, dispatchRow.created);
    if (!isTerminalReceiptStatus(terminal.status)) return { result: freeze({ status: 'pending', deliveryId }) };
    const payload = buildTerminalPayload(deliveryId, receipt, terminal, ctx.now, data.guardVerdict);
    const source = freeze({ occurrenceId: sourceOccurrence, event: declaration.event, payload, scope: config.scope });
    const writes: DomainWrite[] = [], keys = new Set<string>(), handlers: Record<string, unknown>[] = [];
    const meta = { nowMs: ctx.now, actor: ctx.actor };
    const insert = async (model: ModelName, effectRow: StoredRow): Promise<void> => {
      const key = `${model}\0${effectRow.id}`;
      if (keys.has(key) || await ctx.load(model, effectRow.id) !== null) return refuse('partial/preexisting or colliding source effect.');
      // Every accepted persisted row must fit the same replay read budget.
      const detached = copyData(effectRow) as StoredRow;
      keys.add(key); writes.push({ kind: 'insert', model, row: detached });
    };
    for (const route of declaration.handlers) {
      if (route.cohort === undefined) {
        await stageOrdinaryCompletionRoute(source, route.handler, insert, handlers);
        continue;
      }
      await stageCohortCompletionRoute(sourceOccurrence, route.handler, route.cohort, meta, insert, handlers);
    }
    const sourceReceipt = newOccurrenceRow({ occurrenceId: sourceOccurrence, status: 'completed', code: null, message: null,
      recordedAtMs: ctx.now, result: copyData({ kind: 'standard-completion-source', definition, origin,
        terminal: { revision: terminal.revision, status: terminal.status, result: terminal.result, error: terminal.error },
        event: declaration.event, payload, revision, handlers }) }, meta);
    readOccurrenceRow(sourceReceipt); await insert(WORK_OCCURRENCE_MODEL, sourceReceipt);
    return { writes: freeze(writes), result: freeze({ status: 'staged', sourceOccurrence, event: declaration.event, payload }) };
  } });
}
