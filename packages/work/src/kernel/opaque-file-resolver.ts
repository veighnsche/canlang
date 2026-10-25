/** Owning physical Work recipes. Source/Files authenticity is independently State-owned. */
import type { FrameworkFileReferenceProducer, FrameworkOpaqueCallable, FrameworkOpaqueDeclaration,
  FrameworkOpaqueDeclarationSet, FrameworkOpaqueEventInputOrigin, FrameworkOpaqueSourceRoute,
  FrameworkOpaqueValueProjection, ModelName, StoredRow } from '@canlang/contracts';
import { normalizeSchema, parseTypeId, printTypeId, type SchemaDescriptor } from '@canlang/values';
import { KernelTableError, WORK_DISPATCH_MODEL, WORK_OCCURRENCE_MODEL, WORK_SCHEDULE_MODEL, fanoutIntentRowId,
  readWorkFilePayloadOrigin, snapshotKernelJsonValue } from './tables.js';
import { WORK_HANDLER_OCCURRENCE_MODEL, handlerOccurrenceRowId } from './handler-occurrence.js';

type Data = Record<string, unknown>;
type Path = readonly (string | number)[];
const refuse = (message: string): never => { throw new KernelTableError(`Work opaque field: ${message}`); };
function object(value: unknown): Data {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return refuse('own object required.');
  return value as Data;
}
function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): Data {
  const data = object(value);
  if (required.some(key => !Object.hasOwn(data, key)) || Object.keys(data).some(key => !required.includes(key) && !optional.includes(key))) {
    return refuse('complete closed recipe required.');
  }
  return data;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || value === '') return refuse('nonempty identity required.');
  return value;
}
function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) return refuse('safe integer required.');
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) return refuse('dense own array required.');
  return value;
}
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every(key => Object.hasOwn(b, key) &&
    equal((a as Data)[key], (b as Data)[key]));
}
function same(a: unknown, b: unknown, what: string): void { if (!equal(a, b)) refuse(`${what} disagrees with original recipe.`); }
function scope(value: unknown): Data {
  const data = closed(value, ['app', 'owner', 'ownerPackage']);
  for (const member of Object.values(data)) string(member);
  return data;
}
function source(value: unknown): void {
  const data = closed(value, ['path', 'sha256', 'module']);
  for (const member of Object.values(data)) string(member);
}
function callable(value: unknown): FrameworkOpaqueCallable {
  const data = closed(value, ['source', 'callable', 'canonical', 'artifact', 'resultDeclarationId']);
  source(data.source); string(data.resultDeclarationId);
  const call = closed(data.callable, ['id', 'kind', 'module', 'export', 'member'], ['inputStyle']);
  for (const key of ['id', 'module', 'export']) string(call[key]);
  if (!['operation', 'pure', 'rule', 'handler', 'migration'].includes(string(call.kind)) ||
      Object.hasOwn(call, 'inputStyle') && call.inputStyle !== 'parameters') return refuse('unknown callable role.');
  if (array(call.member).length === 0) return refuse('empty callable route.');
  for (const member of array(call.member)) string(member);
  const canonical = closed(data.canonical, ['name', 'kind', 'inputs'], ['result']);
  const artifact = closed(data.artifact, ['name', 'kind', 'description', 'inputs'], ['result', 'rootAuthority']);
  if (artifact.rootAuthority !== undefined) {
    const root = closed(artifact.rootAuthority, ['binding', 'model'], ['createsRoot']);
    string(root.binding); string(root.model);
    if (Object.hasOwn(root, 'createsRoot') && root.createsRoot !== true) return refuse('invalid checked root creation marker.');
  }
  same(canonical.name, call.id, 'canonical callable'); same(artifact.name, call.id, 'artifact callable');
  if (!['read', 'create', 'update', 'delete', 'scenario'].includes(string(canonical.kind)) ||
      typeof artifact.description !== 'string') return refuse('invalid callable descriptor.');
  same(artifact.kind, canonical.kind, 'callable kind');
  array(canonical.inputs); array(closed(artifact.inputs, ['fields']).fields);
  return data as unknown as FrameworkOpaqueCallable;
}
function bounds(value: unknown, scheduled = false): Data {
  const data = closed(value, scheduled ? ['pageLimit', 'chunkSize'] : ['maxSources', 'maxHandlers', 'maxMembers', 'chunkSize']);
  for (const member of Object.values(data)) integer(member, 1);
  return data;
}
function cohort(value: unknown, owner: string): Data {
  const kind = object(value).kind;
  const data = closed(value, kind === 'model' ? ['kind', 'owner', 'model'] : ['kind', 'owner', 'model', 'parent']);
  if (kind !== 'model' && kind !== 'anchored-collection') return refuse('unknown cohort kind.');
  same(data.owner, owner, 'cohort owner'); string(data.model);
  if (kind === 'anchored-collection') {
    const parent = closed(data.parent, ['model', 'id']); string(parent.model); string(parent.id);
  }
  return data;
}
function routes(value: unknown, occurrenceId: string, owner: string, savedBounds: Data): FrameworkOpaqueSourceRoute[] {
  const seen = new Set<string>();
  const result = array(value).map(raw => {
    const kind = object(raw).kind;
    const route = closed(raw, kind === 'ordinary' ? ['kind', 'handler', 'occurrenceId'] :
      ['kind', 'handler', 'cohort', 'fanoutId', 'members', 'memberCount', 'firstChunkCount', 'cursor']);
    const handler = callable(route.handler);
    if (handler.callable.kind !== 'handler' || seen.has(handler.callable.id)) return refuse('duplicate or non-handler route.');
    seen.add(handler.callable.id);
    if (kind === 'ordinary') same(route.occurrenceId, handlerOccurrenceRowId(occurrenceId, handler.callable.id), 'ordinary route identity');
    else if (kind === 'fanout') {
      const cut = cohort(route.cohort, owner), members = array(route.members).map(string);
      if (members.some((member, index) => index > 0 && members[index - 1]! >= member)) return refuse('unordered or duplicate cohort members.');
      same(route.fanoutId, fanoutIntentRowId(occurrenceId, handler.callable.id, cut.kind as 'model' | 'anchored-collection'), 'fanout identity');
      same(integer(route.memberCount), members.length, 'member count');
      if (savedBounds.maxMembers !== undefined && members.length > integer(savedBounds.maxMembers, 1)) return refuse('cohort exceeds original bound.');
      const first = Math.min(members.length, integer(savedBounds.chunkSize, 1));
      same(integer(route.firstChunkCount), first, 'initial chunk');
      same(route.cursor, first === members.length ? null : `admit/v2/${first}`, 'initial cursor');
    } else return refuse('unknown route kind.');
    return route as unknown as FrameworkOpaqueSourceRoute;
  });
  if (savedBounds.maxHandlers !== undefined && result.length > integer(savedBounds.maxHandlers, 1)) return refuse('routes exceed original bound.');
  return result;
}
function physicalRoutes(value: unknown, expected: readonly FrameworkOpaqueSourceRoute[]): void {
  const projected = expected.map(route => route.kind === 'ordinary' ? {
    handler: route.handler.callable.id, kind: route.kind, occurrenceId: route.occurrenceId,
  } : { handler: route.handler.callable.id, kind: route.kind, cohort: route.cohort, fanoutId: route.fanoutId,
    members: route.members, memberCount: route.memberCount, firstChunkCount: route.firstChunkCount, cursor: route.cursor });
  same(value, projected, 'physical source routes');
}
function committedPayload(value: unknown, occurrenceId: string, owner: string): Data {
  const payload = closed(value, ['recordId', 'owner', 'version', 'occurrenceId']);
  string(payload.recordId); integer(payload.version, 1);
  same(payload.occurrenceId, occurrenceId, 'committed occurrence'); same(payload.owner, owner, 'committed owner');
  return payload;
}
function error(value: unknown): void {
  if (value === null) return;
  const data = closed(value, ['code', 'message']);
  if (typeof data.code !== 'string' || typeof data.message !== 'string') return refuse('closed receipt error required.');
}
/** Target/model correspondence for an event input. */
function checkEventTarget(
  input: Data,
  row: StoredRow,
  model: ModelName,
  targetKind: unknown,
  target: Data,
  data: Data,
): void {
  if (model === WORK_SCHEDULE_MODEL) {
    if (targetKind !== 'schedule') return refuse('schedule has foreign target.');
    same(input.sourceOccurrence, row.id, 'scheduled source');
  } else if (model === WORK_HANDLER_OCCURRENCE_MODEL) {
    if (targetKind !== 'handler') return refuse('handler has foreign target.');
    const handler = callable(target.handler);
    if (handler.callable.kind !== 'handler') return refuse('handler target required.');
    same(handler.callable.id, data.handler, 'handler target'); same(input.sourceOccurrence, data.sourceOccurrence, 'handler source');
  } else if (model === WORK_DISPATCH_MODEL) {
    if (targetKind !== 'queue-publication') return refuse('queue publication has foreign target.');
    const intent = closed(target.intent, ['intentId', 'operation', 'operationId', 'target', 'occurrenceIndex']);
    for (const key of ['intentId', 'operation', 'operationId', 'target']) string(intent[key]); integer(intent.occurrenceIndex);
    same(input.sourceOccurrence, row.id, 'queue publication source'); same(intent.intentId, row.id, 'queue publication intent');
    same(intent.operationId, data.operationId, 'queue publication operation'); same(intent.target, data.source, 'queue publication target');
    same(intent.occurrenceIndex, data.occurrenceIndex, 'queue publication ordinal');
  } else return refuse('event input on foreign row.');
}

/** Lineage correspondence for an event input. */
function checkEventLineage(input: Data, model: ModelName, lineageKind: unknown, lineage: Data, data: Data): void {
  if (lineageKind === 'schedule') {
    string(lineage.key);
    if (lineage.replaces !== null) string(lineage.replaces);
    if (model === WORK_SCHEDULE_MODEL) { same(lineage.key, data.key, 'schedule key'); same(lineage.replaces, data.replaces, 'schedule predecessor'); }
  } else if (lineageKind === 'source') same(lineage.sourceOccurrence, input.sourceOccurrence, 'source lineage');
  else return refuse('unknown event lineage.');
  if (model === WORK_SCHEDULE_MODEL && lineageKind !== 'schedule') return refuse('schedule lineage required.');
}

/** Committed-change declaration check for an event input. */
function checkCommittedChangeDeclaration(
  input: Data,
  ownerScope: Data,
  targetKind: unknown,
  declaration: Data,
  data: Data,
  physicalPayload: boolean,
): void {
  const descriptor = closed(declaration.descriptor, ['source', 'model', 'change', 'handlers']);
  same(descriptor.source, data.event, 'committed event'); string(descriptor.model);
  if (!['create', 'update', 'delete'].includes(string(descriptor.change))) return refuse('unknown committed change.');
  for (const handler of array(descriptor.handlers)) string(handler);
  if (targetKind === 'handler' && !array(descriptor.handlers).includes(data.handler)) return refuse('unmatched committed handler.');
  committedPayload(declaration.change, string(input.sourceOccurrence), string(ownerScope.owner));
  string(declaration.projectionInputsDeclarationId);
  if (physicalPayload) {
    const payload = closed(data.payload, ['id', 'version']);
    same(payload.id, object(declaration.change).recordId, 'committed projection id');
    same(payload.version, String(object(declaration.change).version), 'committed projection version');
  }
}

/** Standard-completion declaration check for an event input. */
function checkStandardCompletionDeclaration(
  input: Data,
  declaration: Data,
  data: Data,
  physicalPayload: boolean,
): void {
  same(declaration.event, data.event, 'completion event');
  for (const key of ['providerSource', 'binding', 'from', 'sourceInputsDeclarationId', 'inputsDeclarationId', 'resultDeclarationId']) string(declaration[key]);
  object(declaration.delivery);
  if (physicalPayload) {
    const payload = closed(data.payload, ['delivery_id', 'status', 'result', 'error']);
    same(input.sourceOccurrence, `standard-completion/v1/${encodeURIComponent(string(payload.delivery_id))}`, 'completion source identity');
    if (!['succeeded', 'failed', 'skipped'].includes(string(payload.status))) return refuse('nonterminal completion event.');
    error(payload.error);
    if (payload.status !== 'succeeded' && payload.result !== null || payload.status === 'succeeded' && payload.error !== null ||
        payload.status === 'failed' && payload.error === null || payload.status === 'skipped' && payload.error !== null) return refuse('inconsistent completion envelope.');
  }
}

function event(value: unknown, row: StoredRow, model: ModelName, ownerScope: Data,
  physicalPayload = true): FrameworkOpaqueEventInputOrigin {
  const input = closed(value, ['kind', 'occurrenceId', 'sourceOccurrence', 'declaration', 'lineage', 'target']);
  if (input.kind !== 'event-input') return refuse('event input recipe required.');
  same(input.occurrenceId, row.id, 'event occurrence'); string(input.sourceOccurrence);
  const targetKind = object(input.target).kind;
  const target = closed(input.target, targetKind === 'schedule' ? ['kind'] : targetKind === 'queue-publication' ? ['kind', 'intent'] : ['kind', 'handler']);
  const data = row.data as Data;
  checkEventTarget(input, row, model, targetKind, target, data);
  const lineageKind = object(input.lineage).kind;
  const lineage = closed(input.lineage, lineageKind === 'schedule' ? ['kind', 'key', 'replaces'] : ['kind', 'sourceOccurrence']);
  checkEventLineage(input, model, lineageKind, lineage, data);
  const declarationKind = object(input.declaration).kind;
  const declaration = closed(input.declaration, declarationKind === 'declared-event' ? ['kind', 'source', 'event', 'inputsDeclarationId'] :
    declarationKind === 'committed-change' ? ['kind', 'source', 'descriptor', 'change', 'projectionInputsDeclarationId'] :
      ['kind', 'source', 'event', 'providerSource', 'binding', 'from', 'sourceInputsDeclarationId', 'inputsDeclarationId', 'resultDeclarationId', 'delivery']);
  source(declaration.source);
  if (declarationKind === 'declared-event') { same(declaration.event, model === WORK_DISPATCH_MODEL ? string(data.source).slice(0, -'.publish'.length) : data.event, 'declared event'); string(declaration.inputsDeclarationId); }
  else if (declarationKind === 'committed-change') {
    checkCommittedChangeDeclaration(input, ownerScope, targetKind, declaration, data, physicalPayload);
  } else if (declarationKind === 'standard-completion') {
    checkStandardCompletionDeclaration(input, declaration, data, physicalPayload);
  } else return refuse('unknown event declaration.');
  return input as unknown as FrameworkOpaqueEventInputOrigin;
}
function eventDeclarationId(input: FrameworkOpaqueEventInputOrigin): string {
  return input.declaration.kind === 'committed-change' ? input.declaration.projectionInputsDeclarationId : input.declaration.inputsDeclarationId;
}

/** Map an artifact field tag to its exact original type id. */
function mapFieldTagType(tag: Data): string {
  const mapped: Readonly<Record<string, string>> = {
    string: 'text', integer: 'int', boolean: 'bool', decimal: 'decimal', money: 'money', datetime: 'datetime',
    duration: 'duration', user: 'user', file: 'file', date: 'date', secret: 'secret', member: 'member', json: 'json', bytes: 'bytes',
  };
  return tag.kind === 'nominal' ? string(tag.name) : tag.kind === 'other' ? string(tag.type) :
    tag.kind === 'enum' ? `enum(${array(tag.values).map(string).join(',')})` : mapped[string(tag.kind)] ?? refuse('schema field lacks an exact original type.');
}

/** Apply the retained default marker from an original default block. */
function applyRetainedDefault(expected: Data, original: Data): void {
  const value = closed(original.default, ['kind'], ['value', 'path', 'init']);
  if (value.kind === 'literal') {
    if (!Object.hasOwn(value, 'value')) return refuse('literal default value absent.');
    expected.default = value.value;
  } else if (value.kind === 'server') expected.server = true;
  else if (value.kind === 'derived') expected.derived = true;
  else return refuse('retained schema default has no literal/static owning representation.');
}

/** Reconstruct Values' retained field controls from the exact original declaration. */
function schemaFieldDescriptor(artifact: unknown, canonical?: unknown): Data {
  const original = object(artifact), checked = canonical === undefined ? undefined : object(canonical);
  let type: string;
  if (typeof original.type === 'string') type = original.type;
  else if (typeof original.valueType === 'string' || typeof checked?.valueType === 'string') type = string(original.valueType ?? checked?.valueType);
  else type = mapFieldTagType(object(original.field));
  let parsed = parseTypeId(type);
  if (original.array !== undefined && !parsed.array) {
    type += object(original.array).required === true ? '[]!' : '[]'; parsed = parseTypeId(type);
  }
  if (original.nullable === true && !parsed.nullable) type += '?';
  const expected: Data = { type: printTypeId(parseTypeId(type)) };
  for (const key of ['trim', 'min', 'max', 'format', 'distinctBy', 'excludedIds']) {
    if (Object.hasOwn(original, key)) expected[key] = original[key];
    else if (checked !== undefined && Object.hasOwn(checked, key)) expected[key] = checked[key];
  }
  if (Object.hasOwn(original, 'default')) applyRetainedDefault(expected, original);
  return expected;
}

interface OpaqueResolveContext {
  readonly row: StoredRow;
  readonly data: Data;
  readonly origin: Data;
  readonly ownerScope: Data;
  readonly set: FrameworkOpaqueDeclarationSet;
  readonly binding: NonNullable<ReturnType<typeof readWorkFilePayloadOrigin>>;
  readonly valueDefaults: ReadonlyMap<string, Data>;
  readonly valueDefaultKey: (contract: string, field: string) => string;
  readonly values: FrameworkOpaqueValueProjection[];
  readonly declaration: (id: string, kinds: readonly string[]) => FrameworkOpaqueDeclaration;
  readonly projectInputs: (path: Path, id: string) => void;
  readonly projectResult: (path: Path, id: string, payload: unknown, failed: boolean) => void;
}

/** Capture the own raw value-default table; never Values' normalized defaults. */
function captureValueDefaults(set: FrameworkOpaqueDeclarationSet): Map<string, Data> {
  const valueDefaults = new Map<string, Data>();
  const valueDefaultKey = (contract: string, field: string): string => JSON.stringify([contract, field]);
  for (const raw of array(set.valueDefaults)) {
    const captured = closed(raw, ['contract', 'field', 'value']);
    const contract = string(captured.contract), field = string(captured.field);
    const owners = set.valueTypes.contracts.filter(candidate => candidate.name === contract);
    if (owners.length !== 1 || owners[0]!.fields.filter(candidate => candidate.name === field).length !== 1 ||
        set.canonicalModels.some(candidate => candidate.name === contract)) return refuse('unknown or ambiguous original value default owner.');
    const key = valueDefaultKey(contract, field);
    if (valueDefaults.has(key)) return refuse('duplicate original value default pair.');
    valueDefaults.set(key, captured);
  }
  return valueDefaults;
}

/** SEND-guard branch of opaque resolution. */
function resolveSourceGuard(ctx: OpaqueResolveContext): void {
  const { row, data, origin, declaration, projectInputs } = ctx;
  const declared = closed(origin, ['kind', 'intent', 'declaration', 'inputsDeclarationId']);
  if (declared.kind !== 'send-guard') return refuse('original SEND guard recipe required.');
  const intent = closed(declared.intent, ['intentId', 'operation', 'operationId', 'target', 'occurrenceIndex', 'dispatchGuard']);
  string(intent.operation); same(intent.intentId, row.id, 'original guard intent');
  same(intent.intentId, data.intentId, 'guard dispatch identity');
  same(intent.operationId, data.operationId, 'guard original operation');
  same(intent.target, data.source, 'guard original target');
  same(intent.occurrenceIndex, data.occurrenceIndex, 'guard original ordinal');
  const guard = closed(data.sourceGuard, ['rule', 'source', 'owner', 'node', 'inputs']);
  const original = closed(declared.declaration, ['rule', 'source', 'owner', 'node', 'binding', 'target', 'inputs'], ['evaluation']);
  if (Object.hasOwn(original, 'evaluation') && original.evaluation !== 'source') return refuse('unknown original SEND evaluation phase.');
  same(intent.dispatchGuard, original.rule, 'retained intent guard');
  same(guard.rule, original.rule, 'physical source guard');
  same(guard.source, original.source, 'guard source'); same(guard.owner, original.owner, 'guard owner');
  same(guard.node, original.node, 'guard occurrence'); same(original.target, intent.target, 'guard target');
  same(original.owner, intent.operation, 'guard owning callable');
  const selected = declaration(string(declared.inputsDeclarationId), ['inputs']);
  same(selected.source, { kind: 'send-guard', ...original }, 'complete original guard declaration');
  if (selected.profile.kind !== 'inputs') return refuse('complete original guard inputs required.');
  same(selected.profile.artifact.map(input => ({ name: input.name, type: input.valueType })), original.inputs, 'original guard lexical profile');
  same(Object.keys(object(guard.inputs)), array(original.inputs).map(input => object(input).name), 'complete lexical input order');
  projectInputs(['inputs'], selected.id);
}

/** Queue-payload branch of opaque resolution. */
function resolveQueuePayload(ctx: OpaqueResolveContext, model: ModelName): void {
  const { row, data, origin, ownerScope, projectInputs } = ctx;
  if (!string(data.source).endsWith('.publish')) return refuse('queue publication requires its original publish target.');
  const input = event(origin, row, model, ownerScope);
  if (input.declaration.kind !== 'declared-event') return refuse('queue publication requires its declared event.');
  projectInputs([], eventDeclarationId(input));
}

/** Schedule/handler-occurrence payload branch of opaque resolution. */
function resolveSchedulePayload(ctx: OpaqueResolveContext, model: ModelName): void {
  const { row, data, origin, ownerScope, projectInputs } = ctx;
  same(ownerScope, { app: data.scopeApp, owner: data.scopeOwner, ownerPackage: data.scopeOwnerPackage }, 'input row scope');
  const input = event(origin, row, model, ownerScope);
  projectInputs([], eventDeclarationId(input));
}

/** Handler-result branch of opaque resolution. */
function resolveHandlerResult(ctx: OpaqueResolveContext): void {
  const { row, data, origin, ownerScope, projectResult } = ctx;
  closed(origin, ['kind', 'occurrenceId', 'operationId', 'handler', 'event']);
  same(origin.occurrenceId, row.id, 'handler result occurrence'); string(origin.operationId);
  const handler = callable(origin.handler);
  if (handler.callable.kind !== 'handler') return refuse('handler result callable required.');
  // Result rows retain event origin controls, never another physical event payload.
  const eventInput = object(origin.event), handlerRow = { ...row, data: {
    occurrenceId: row.id, sourceOccurrence: eventInput.sourceOccurrence, handler: handler.callable.id,
    event: object(eventInput.declaration).event ?? object(object(eventInput.declaration).descriptor).source,
    scopeApp: ownerScope.app, scopeOwner: ownerScope.owner, scopeOwnerPackage: ownerScope.ownerPackage,
  } } as StoredRow;
  event(origin.event, handlerRow, WORK_HANDLER_OCCURRENCE_MODEL, ownerScope, false);
  same(object(object(origin.event).target).handler, handler, 'result original handler');
  same(row.id, handlerOccurrenceRowId(string(eventInput.sourceOccurrence), handler.callable.id), 'handler result identity');
  projectResult([], handler.resultDeclarationId, data.result, data.status === 'failed');
}

/** Direct keyed due delivery has a schedule row, without an intermediate
 * handler-occurrence row. Keep that physical distinction in its result recipe. */
function resolveScheduledHandlerResult(ctx: OpaqueResolveContext): void {
  const { row, data, origin, ownerScope, declaration, projectResult } = ctx;
  closed(origin, ['kind', 'occurrenceId', 'operationId', 'handler', 'event', 'terminal']);
  same(origin.occurrenceId, row.id, 'direct due result occurrence'); string(origin.operationId);
  const handler = callable(origin.handler);
  if (handler.callable.kind !== 'handler' || handler.canonical.kind !== 'scenario') return refuse('direct due handler required.');
  const eventInput = object(origin.event), lineage = object(eventInput.lineage);
  const sourceRow = { ...row, data: { occurrenceId: row.id, key: lineage.key, replaces: lineage.replaces,
    event: object(eventInput.declaration).event, scopeApp: ownerScope.app,
    scopeOwner: ownerScope.owner, scopeOwnerPackage: ownerScope.ownerPackage } } as StoredRow;
  event(origin.event, sourceRow, WORK_SCHEDULE_MODEL, ownerScope, false);
  if (object(eventInput.target).kind !== 'schedule' || object(eventInput.declaration).kind !== 'declared-event') {
    return refuse('direct due requires its original scheduled declared event.');
  }
  const eventInputs = declaration(string(object(eventInput.declaration).inputsDeclarationId), ['inputs']);
  if (eventInputs.profile.kind !== 'inputs') return refuse('direct due event inputs required.');
  same(handler.source, object(eventInput.declaration).source, 'direct due owning source');
  same(handler.canonical.inputs, eventInputs.profile.canonical, 'direct due handler inputs');
  same(handler.artifact.inputs.fields, eventInputs.profile.artifact, 'direct due authored inputs');
  const terminal = closed(origin.terminal, ['status', 'result', 'code', 'message']);
  same({ status: data.status, result: data.result, code: data.code, message: data.message }, terminal,
    'direct due physical terminal');
  if (terminal.result !== null || !['completed', 'failed'].includes(string(terminal.status))) {
    return refuse('direct due void terminal required.');
  }
  if (declaration(handler.resultDeclarationId, ['void']).profile.kind !== 'void') return refuse('direct due void result declaration required.');
  projectResult([], handler.resultDeclarationId, data.result, data.status === 'failed');
}

/** Scheduled-cohorts/routes branch of source routing. */
function resolveScheduledRoutes(ctx: OpaqueResolveContext, recipe: Data, kind: unknown): void {
  const { row, data, ownerScope } = ctx;
  closed(recipe, ['kind', 'event', 'bounds', 'routes']);
  const eventInput = object(recipe.event), lineage = object(eventInput.lineage);
  const routeRow = { ...row, data: { occurrenceId: row.id, key: lineage.key, replaces: lineage.replaces,
    event: object(eventInput.declaration).event ?? object(object(eventInput.declaration).descriptor).source,
    scopeApp: ownerScope.app, scopeOwner: ownerScope.owner, scopeOwnerPackage: ownerScope.ownerPackage } } as StoredRow;
  event(recipe.event, routeRow, WORK_SCHEDULE_MODEL, ownerScope, false);
  const savedBounds = bounds(recipe.bounds, true), admitted = routes(recipe.routes, row.id, string(ownerScope.owner), savedBounds);
  if (kind === 'scheduled-cohorts' && admitted.some(route => route.kind !== 'fanout')) return refuse('cohort-only source has ordinary route.');
  const result = closed(data.result, kind === 'scheduled-cohorts' ? ['fanouts', 'bounds'] : ['fanouts', 'bounds', 'handlers']);
  same(result.bounds, savedBounds, 'scheduled source bounds');
  same(result.fanouts, admitted.filter(route => route.kind === 'fanout').map(route => ({ handler: route.handler.callable.id,
    fanoutId: (route as Extract<FrameworkOpaqueSourceRoute, { kind: 'fanout' }>).fanoutId })), 'scheduled fanout summaries');
  if (kind === 'scheduled-routes') same(result.handlers, admitted.filter(route => route.kind === 'ordinary').map(route => ({
    handler: route.handler.callable.id, occurrenceId: (route as Extract<FrameworkOpaqueSourceRoute, { kind: 'ordinary' }>).occurrenceId })), 'scheduled handler summaries');
}

/** Committed-model branch of source routing. */
function resolveCommittedModel(ctx: OpaqueResolveContext, recipe: Data): void {
  const { row, data, origin, ownerScope } = ctx;
  closed(recipe, ['kind', 'source', 'descriptor', 'change', 'payload', 'context', 'bounds', 'routes']); source(recipe.source);
  const descriptor = closed(recipe.descriptor, ['source', 'model', 'change', 'handlers']);
  const change = closed(recipe.change, ['model', 'recordId', 'version', 'kind']);
  const mapped: Readonly<Record<string, string>> = { created: 'create', updated: 'update', deleted: 'delete' };
  const changeKind = mapped[string(change.kind)];
  if (changeKind === undefined) return refuse('unknown committed change kind.');
  same(descriptor.model, change.model, 'committed descriptor model'); same(descriptor.change, changeKind, 'committed descriptor change');
  same(descriptor.source, `${string(change.model)}.${string(change.kind)}`, 'committed descriptor source');
  const payload = committedPayload(recipe.payload, row.id, string(ownerScope.owner));
  same(payload.recordId, change.recordId, 'committed change id'); same(payload.version, change.version, 'committed change version');
  const attribution = closed(recipe.context, ['kind', 'app', 'operation', 'operationId', 'source', 'now', 'actor', 'team'], ['trustedSource']);
  same(attribution.app, ownerScope.app, 'committed attribution app');
  same(attribution.team === null ? attribution.app : closed(attribution.team, ['teamId', 'timezone']).teamId, ownerScope.owner, 'committed attribution owner');
  if (attribution.actor !== null) {
    const actor = closed(attribution.actor, ['userId'], ['email', 'emailVerified']); string(actor.userId);
    if (actor.email !== undefined && typeof actor.email !== 'string' || actor.emailVerified !== undefined && typeof actor.emailVerified !== 'boolean') return refuse('invalid original principal controls.');
  }
  if (attribution.team !== null) string(object(attribution.team).timezone);
  if (attribution.trustedSource !== undefined) string(attribution.trustedSource);
  for (const key of ['kind', 'operation', 'operationId', 'source']) string(attribution[key]); integer(attribution.now);
  const savedBounds = bounds(recipe.bounds), admitted = routes(recipe.routes, row.id, string(ownerScope.owner), savedBounds);
  same(descriptor.handlers, admitted.map(route => route.handler.callable.id), 'committed declared handlers');
  const result = closed(data.result, ['kind', 'change', 'event', 'payload', 'context', 'revision', 'scope', 'bounds', 'handlers']);
  same(result.kind, 'committed-model-source', 'committed source kind'); same(result.change, change, 'saved committed change');
  same(result.event, descriptor.source, 'saved committed event'); same(result.payload, payload, 'saved committed payload');
  same(result.context, attribution, 'saved attribution'); same(result.revision, origin.revision, 'saved source revision');
  same(result.scope, ownerScope, 'saved source scope'); same(result.bounds, savedBounds, 'saved source bounds'); physicalRoutes(result.handlers, admitted);
}

/** An authored EMIT retains its original typed event, owner and complete route cut. */
function resolveDeclaredEvent(ctx: OpaqueResolveContext, recipe: Data): void {
  const { row, data, origin, ownerScope, declaration, projectInputs } = ctx;
  closed(recipe, ['kind', 'declaration', 'payload', 'context', 'bounds', 'routes']);
  const declared = closed(recipe.declaration, ['kind', 'source', 'event', 'inputsDeclarationId']);
  if (declared.kind !== 'declared-event') return refuse('declared event source requires its original event declaration.');
  source(declared.source); string(declared.event); string(declared.inputsDeclarationId);
  const inputs = declaration(string(declared.inputsDeclarationId), ['inputs']);
  same(inputs.source, { kind: 'event', source: declared.source, event: declared.event }, 'declared event input source');
  const payload = object(recipe.payload);
  const attribution = closed(recipe.context,
    ['kind', 'app', 'operation', 'operationId', 'source', 'now', 'actor', 'team'], ['trustedSource']);
  same(attribution.app, ownerScope.app, 'declared attribution app');
  same(attribution.team === null ? attribution.app : closed(attribution.team, ['teamId', 'timezone']).teamId,
    ownerScope.owner, 'declared attribution owner');
  if (attribution.actor !== null) {
    const actor = closed(attribution.actor, ['userId'], ['email', 'emailVerified']); string(actor.userId);
    if (actor.email !== undefined && typeof actor.email !== 'string' ||
        actor.emailVerified !== undefined && typeof actor.emailVerified !== 'boolean') {
      return refuse('invalid declared source principal controls.');
    }
  }
  if (attribution.team !== null) string(object(attribution.team).timezone);
  if (attribution.trustedSource !== undefined) string(attribution.trustedSource);
  for (const key of ['kind', 'operation', 'operationId', 'source']) string(attribution[key]);
  same(integer(attribution.now), row.created, 'declared source admission time');
  const savedBounds = bounds(recipe.bounds);
  const admitted = routes(recipe.routes, row.id, string(ownerScope.owner), savedBounds);
  const result = closed(data.result,
    ['kind', 'event', 'payload', 'context', 'revision', 'scope', 'bounds', 'handlers']);
  same(result.kind, 'declared-event-source', 'declared source kind');
  same(result.event, declared.event, 'saved declared event');
  same(result.payload, payload, 'saved declared payload');
  same(result.context, attribution, 'saved declared attribution');
  same(result.revision, origin.revision, 'saved declared source revision');
  same(result.scope, ownerScope, 'saved declared source scope');
  same(result.bounds, savedBounds, 'saved declared source bounds');
  physicalRoutes(result.handlers, admitted);
  projectInputs(['payload'], string(declared.inputsDeclarationId));
}

/** Queued-routes branch of source routing. */
function resolveQueuedRoutes(ctx: OpaqueResolveContext, recipe: Data): void {
  const { row, data, origin, ownerScope, declaration, projectInputs } = ctx;
  closed(recipe, ['kind', 'declaration', 'originalIntent', 'originalCommit', 'routes'], ['guard']);
  const declared = closed(recipe.declaration, ['kind', 'source', 'event', 'inputsDeclarationId']);
  if (declared.kind !== 'declared-event') return refuse('queue requires its original typed event declaration.');
  source(declared.source); string(declared.event); string(declared.inputsDeclarationId);
  const input = declaration(string(declared.inputsDeclarationId), ['inputs']);
  same(input.source, { kind: 'event', source: declared.source, event: declared.event }, 'queue original event');
  const result = closed(data.result, ['kind', 'event', 'scope', 'payload', 'origin', 'handlers']);
  same(result.kind, 'queue-source', 'queue source kind'); same(result.event, declared.event, 'queue event');
  same(result.scope, ownerScope, 'queue owner scope');
  const original = closed(result.origin, ['intent', 'originalCommit', 'dispatch']);
  const intent = closed(original.intent, ['intentId', 'operation', 'operationId', 'target', 'arguments', 'occurrenceIndex'], ['dispatchGuard', 'handlerContract']);
  for (const key of ['intentId', 'operation', 'operationId', 'target']) string(intent[key]);
  integer(intent.occurrenceIndex);
  same(Object.fromEntries(['intentId', 'operation', 'operationId', 'target', 'occurrenceIndex'].map(key => [key, intent[key]])),
    closed(recipe.originalIntent, ['intentId', 'operation', 'operationId', 'target', 'occurrenceIndex']), 'queue original intent');
  same(intent.target, `${declared.event}.publish`, 'queue publish source');
  same(row.id, `queue/v1/${encodeURIComponent(string(intent.intentId))}`, 'queue occurrence identity');
  const request = closed(intent.arguments, ['binding', 'from', 'arguments']);
  same(request.binding, declared.event, 'queue request binding'); same(request.from, declared.event, 'queue request origin');
  same(result.payload, request.arguments, 'queue immutable payload');
  const stamp = closed(original.originalCommit, ['revision', 'createdAt']);
  integer(stamp.revision, 1); integer(stamp.createdAt); same(stamp, recipe.originalCommit, 'queue publication stamp');
  if (integer(stamp.revision, 1) >= integer(origin.revision, 1) || integer(stamp.createdAt) > row.created) return refuse('queue source chronology disagrees.');
  const dispatch = closed(original.dispatch, ['operationId', 'source', 'occurrenceIndex', 'originOccurrence', 'created', 'createdBy'], ['sourceGuard', 'filePayloadOrigin', 'queuePayload', 'queuePayloadOrigin']);
  same(dispatch.source, intent.target, 'queue dispatch source'); same(dispatch.occurrenceIndex, intent.occurrenceIndex, 'queue dispatch ordinal');
  string(dispatch.operationId); string(dispatch.createdBy); integer(dispatch.created);
  if (dispatch.originOccurrence !== null) string(dispatch.originOccurrence);
  if (integer(dispatch.created) > integer(stamp.createdAt)) return refuse('queue dispatch chronology disagrees.');
  if (recipe.guard !== undefined) {
    const guardOrigin = closed(recipe.guard, ['kind', 'intent', 'declaration', 'inputsDeclarationId']);
    same(guardOrigin.kind, 'send-guard', 'queue lexical origin');
    const sourceGuard = closed(dispatch.sourceGuard, ['rule', 'source', 'owner', 'node', 'inputs']);
    same(closed(guardOrigin.intent, ['intentId', 'operation', 'operationId', 'target', 'occurrenceIndex', 'dispatchGuard']),
      { ...recipe.originalIntent as Data, dispatchGuard: intent.dispatchGuard }, 'queue guarded intent');
    const header = readWorkFilePayloadOrigin({ filePayloadOrigin: dispatch.filePayloadOrigin },
      { id: string(intent.intentId) as StoredRow['id'], created: integer(dispatch.created), createdBy: string(dispatch.createdBy) }, WORK_DISPATCH_MODEL, 'sourceGuard', 'deferred-input');
    if (header === undefined) return refuse('queue lexical header absent.');
    same(header.origin, recipe.guard, 'queue retained guard recipe'); same(header.scope, ownerScope, 'queue guard scope');
    const guardDeclaration = declaration(string(guardOrigin.inputsDeclarationId), ['inputs']);
    same(guardDeclaration.source, { kind: 'send-guard', ...object(guardOrigin.declaration) }, 'queue original lexical declaration');
    const controls = object(guardOrigin.declaration);
    for (const key of ['rule', 'source', 'owner', 'node']) same(sourceGuard[key], controls[key], 'queue lexical control');
    projectInputs(['origin', 'dispatch', 'sourceGuard', 'inputs'], string(guardOrigin.inputsDeclarationId));
  } else if (dispatch.sourceGuard !== undefined || dispatch.filePayloadOrigin !== undefined || intent.dispatchGuard !== undefined) return refuse('queue source omitted its original guard.');
  if (dispatch.queuePayloadOrigin !== undefined || dispatch.queuePayload !== undefined) {
    const header = readWorkFilePayloadOrigin({ queuePayloadOrigin: dispatch.queuePayloadOrigin },
      { id: string(intent.intentId) as StoredRow['id'], created: integer(dispatch.created), createdBy: string(dispatch.createdBy) }, WORK_DISPATCH_MODEL, 'queuePayload', 'deferred-input', 'queuePayloadOrigin');
    if (header?.origin.kind !== 'event-input' || header.origin.target.kind !== 'queue-publication') return refuse('queue publication header absent.');
    same(header.origin.target.intent, recipe.originalIntent, 'queue publication original intent'); same(header.origin.declaration, recipe.declaration, 'queue publication original event');
    same(header.scope, ownerScope, 'queue publication owner'); same(dispatch.queuePayload, result.payload, 'queue publication payload');
    projectInputs(['origin', 'dispatch', 'queuePayload'], string(declared.inputsDeclarationId));
  }
  const admitted = routes(recipe.routes, row.id, string(ownerScope.owner), { maxHandlers: 200 });
  if (admitted.some(route => route.kind !== 'ordinary')) return refuse('queue cannot adopt a fanout route.');
  physicalRoutes(result.handlers, admitted);
  projectInputs(['payload'], string(declared.inputsDeclarationId));
  projectInputs(['origin', 'intent', 'arguments', 'arguments'], string(declared.inputsDeclarationId));
}

/** Source-routing branch of opaque resolution. */
function resolveSourceRouting(ctx: OpaqueResolveContext): void {
  const { row, data, origin } = ctx;
  closed(origin, ['kind', 'occurrenceId', 'revision', 'recipe']);
  same(origin.occurrenceId, row.id, 'source routing occurrence');
  if (data.status !== 'completed' || data.code !== null || data.message !== null) return refuse('source routing receipt must be completed.');
  const recipe = object(origin.recipe), kind = recipe.kind;
  integer(origin.revision, kind === 'declared-event' ? 0 : 1);
  if (kind === 'scheduled-cohorts' || kind === 'scheduled-routes') resolveScheduledRoutes(ctx, recipe, kind);
  else if (kind === 'committed-model') resolveCommittedModel(ctx, recipe);
  else if (kind === 'declared-event') resolveDeclaredEvent(ctx, recipe);
  else if (kind === 'queued-routes') resolveQueuedRoutes(ctx, recipe);
  else return refuse('unknown source-routing recipe.');
}

/** Delivery intent/request/stamp/dispatch checks for a completion source. */
function resolveCompletionIntent(ctx: OpaqueResolveContext, declared: Data, original: Data): {
  intent: Data; stamp: Data; dispatch: Data; dispatchKind: unknown;
} {
  const { row, origin, ownerScope, projectInputs } = ctx;
  const intent = closed(original.intent, ['intentId', 'operation', 'operationId', 'target', 'arguments', 'occurrenceIndex'], ['dispatchGuard', 'handlerContract']);
  for (const key of ['intentId', 'operation', 'operationId', 'target']) string(intent[key]);
  for (const key of ['dispatchGuard', 'handlerContract']) if (Object.hasOwn(intent, key)) string(intent[key]);
  const picked = Object.fromEntries(['intentId', 'operation', 'operationId', 'target', 'occurrenceIndex'].map(key => [key, intent[key]]));
  same(picked, closed(origin.originalIntent, ['intentId', 'operation', 'operationId', 'target', 'occurrenceIndex']), 'original delivery intent');
  same(row.id, `standard-completion/v1/${encodeURIComponent(string(intent.intentId))}`, 'completion source identity');
  same(intent.target, declared.providerSource, 'completion provider source'); integer(intent.occurrenceIndex);
  const request = closed(intent.arguments, ['binding', 'from', 'arguments']);
  same(request.binding, declared.binding, 'original provider binding'); same(request.from, declared.from, 'original provider origin');
  object(request.arguments); projectInputs(['origin', 'intent', 'arguments', 'arguments'], string(declared.sourceInputsDeclarationId));
  const stamp = closed(original.originalCommit, ['revision', 'createdAt']); integer(stamp.revision, 1); integer(stamp.createdAt);
  same(stamp, origin.originalCommit, 'original publication stamp');
  const dispatch = object(origin.dispatch), dispatchKind = dispatch.kind;
  closed(dispatch, dispatchKind === 'generation' ? ['kind', 'operationId', 'source', 'occurrenceIndex', 'originOccurrence', 'created', 'actor', 'correlation'] :
    ['kind', 'operationId', 'source', 'occurrenceIndex', 'originOccurrence', 'created', 'actor']);
  if (dispatchKind !== 'capability' && dispatchKind !== 'generation') return refuse('unknown completion dispatch.');
  const physicalDispatch = { ...dispatch }; delete physicalDispatch.kind;
  same(original.dispatch, physicalDispatch, 'original physical dispatch'); same(dispatch.source, intent.target, 'dispatch source');
  same(dispatch.occurrenceIndex, intent.occurrenceIndex, 'dispatch index'); integer(dispatch.created); string(dispatch.actor); string(dispatch.operationId);
  if (dispatch.originOccurrence !== null) string(dispatch.originOccurrence);
  if (dispatchKind === 'generation') {
    const correlation = closed(dispatch.correlation, ['requestSource', 'requestRevision', 'requestBinding', 'requestFrom', 'requestApp', 'requestOwner']);
    for (const member of Object.values(correlation)) string(member);
    same(correlation.requestBinding, declared.binding, 'generation binding'); same(correlation.requestFrom, declared.from, 'generation origin');
    same(correlation.requestApp, ownerScope.app, 'generation app'); same(correlation.requestOwner, ownerScope.owner, 'generation owner');
  }
  return { intent, stamp, dispatch, dispatchKind };
}

/** Terminal envelope plus chronology checks for a completion source. */
function resolveCompletionTerminal(
  ctx: OpaqueResolveContext,
  result: Data,
  intent: Data,
  stamp: Data,
  dispatch: Data,
): Data {
  const { row, origin } = ctx;
  const terminal = closed(result.terminal, ['revision', 'status', 'result', 'error']);
  same({ revision: terminal.revision, status: terminal.status, error: terminal.error }, closed(origin.terminal, ['revision', 'status', 'error']), 'original terminal');
  const payload = closed(result.payload, ['delivery_id', 'status', 'result', 'error']);
  same(payload, { delivery_id: intent.intentId, status: terminal.status, result: terminal.result, error: terminal.error }, 'duplicate completion envelope');
  if (!['succeeded', 'failed', 'skipped'].includes(string(terminal.status))) return refuse('nonterminal source receipt.'); error(terminal.error);
  if (terminal.status !== 'succeeded' && terminal.result !== null || terminal.status === 'succeeded' && terminal.error !== null ||
      terminal.status === 'failed' && terminal.error === null || terminal.status === 'skipped' && terminal.error !== null) return refuse('inconsistent terminal source.');
  same(result.revision, origin.revision, 'completion source revision');
  if (integer(terminal.revision, 1) < integer(stamp.revision, 1) || integer(result.revision, 1) < integer(terminal.revision, 1) ||
      integer(dispatch.created) > integer(stamp.createdAt) || integer(stamp.createdAt) > row.created) return refuse('original chronology mismatch.');
  return terminal;
}

/** Completion definition/bounds/routes/declaration checks. */
function resolveCompletionDefinition(
  ctx: OpaqueResolveContext,
  declared: Data,
  result: Data,
): { definition: Data; schema: Data; savedBounds: Data } {
  const { row, origin, ownerScope, set, declaration } = ctx;
  const definition = closed(result.definition, ['scope', 'declaration', 'schema', 'modelNames', 'bounds']);
  same(definition.scope, ownerScope, 'completion scope'); const savedBounds = bounds(origin.bounds);
  same(definition.bounds, savedBounds, 'completion bounds');
  const admitted = routes(origin.routes, row.id, string(ownerScope.owner), savedBounds); physicalRoutes(result.handlers, admitted);
  const physicalDeclaration = closed(definition.declaration, ['source', 'event', 'binding', 'from', 'resultType', 'handlers']);
  same(physicalDeclaration.source, declared.providerSource, 'saved provider'); same(physicalDeclaration.event, declared.event, 'saved event');
  same(physicalDeclaration.binding, declared.binding, 'saved binding'); same(physicalDeclaration.from, declared.from, 'saved origin');
  const resultDeclaration = declaration(string(declared.resultDeclarationId), ['result', 'provider-result', 'void']);
  if (resultDeclaration.profile.kind === 'void') same(physicalDeclaration.resultType, null, 'explicit void source');
  else if (resultDeclaration.profile.kind === 'provider-result') same(physicalDeclaration.resultType,
    resultDeclaration.profile.canonical.name, 'original declared result type');
  else if (resultDeclaration.profile.kind === 'result') same(physicalDeclaration.resultType,
    resultDeclaration.profile.canonical.type, 'original declared result type');
  else return refuse('original completion result declaration required.');
  same(physicalDeclaration.handlers, admitted.map(route => route.kind === 'ordinary' ? { handler: route.handler.callable.id } :
    { handler: route.handler.callable.id, cohort: route.cohort }), 'saved source handlers');
  const modelNames = array(definition.modelNames).map(string);
  if (new Set(modelNames).size !== modelNames.length) return refuse('duplicate schema model names.');
  same(modelNames, set.canonicalModels.map(model => model.name), 'original complete model order');
  const schema = closed(definition.schema, [], ['contracts', 'enums', 'aliases', 'operations']);
  return { definition, schema, savedBounds };
}

/** Schema enums/aliases plus original enum/alias correspondence. */
function resolveCompletionSchemas(ctx: OpaqueResolveContext, schema: Data): void {
  const { set } = ctx;
  for (const raw of Object.values(schema.enums === undefined ? {} : object(schema.enums))) {
    const enumeration = closed(raw, ['cases']);
    for (const member of array(enumeration.cases)) string(member);
  }
  for (const raw of Object.values(schema.aliases === undefined ? {} : object(schema.aliases))) {
    const alias = closed(raw, ['type', 'min', 'max'], ['format']);
    if (alias.type !== 'text' || alias.format !== undefined && alias.format !== 'name') return refuse('unknown bounded alias.');
    integer(alias.min); integer(alias.max);
  }
  normalizeSchema(schema as SchemaDescriptor);
  const expectedEnums = Object.fromEntries((set.valueTypes.enums ?? []).map(value => [value.name, { cases: value.cases }]));
  const expectedAliases = Object.fromEntries((set.valueTypes.aliases ?? []).map(value => [value.name, {
    type: value.type, min: value.min, max: value.max, ...(value.format === undefined ? {} : { format: value.format }),
  }]));
  same(schema.enums ?? {}, expectedEnums, 'original enum schema'); same(schema.aliases ?? {}, expectedAliases, 'original alias schema');
}

/** One retained operation schema with its owning input profile. */
function resolveCompletionOperation(
  ctx: OpaqueResolveContext,
  operation: string,
  raw: unknown,
): void {
  const { set, declaration, values } = ctx;
  const operationSchema = closed(raw, ['inputs'], ['mutation']);
  if (operationSchema.mutation !== undefined && typeof operationSchema.mutation !== 'boolean') return refuse('invalid schema operation mutation control.');
  const matches = set.declarations.filter(candidate => candidate.profile.kind === 'inputs' &&
    (candidate.source.kind === 'event' ? candidate.source.event === operation : candidate.source.kind === 'callable' ?
      candidate.source.callable.id === operation : candidate.source.kind === 'delivery' &&
      `${candidate.source.context.canonical.capability}.${candidate.source.context.canonical.operation}` === operation));
  const selected = matches[0];
  // Several authored SEND consumers can retain the same original provider
  // input declaration. Their labels differ, but authority and type/default
  // facts must agree in full before one declaration can project the schema.
  if (selected === undefined || matches.some(candidate =>
    !equal(candidate.source, selected.source) || !equal(candidate.profile, selected.profile))) {
    return refuse('schema operation lacks one original owning input profile.');
  }
  if (selected.profile.kind !== 'inputs') return refuse('schema input profile required.');
  same(Object.keys(object(operationSchema.inputs)), selected.profile.artifact.map(input => input.name), 'original schema input order');
  for (const [input, rawField] of Object.entries(object(operationSchema.inputs))) {
    const schemaField = closed(rawField, ['type'], ['min', 'max', 'format', 'distinctBy', 'excludedIds', 'default', 'trim', 'server', 'derived']);
    const original = selected.profile.artifact.find(candidate => candidate.name === input);
    const canonical = selected.profile.canonical.find(candidate => candidate.name === input);
    if (original === undefined || canonical === undefined) return refuse('unknown original schema input.');
    same(schemaField, schemaFieldDescriptor(original, canonical), 'original input type/default/constraints');
    if (!Object.hasOwn(schemaField, 'default')) continue;
    values.push({ path: ['definition', 'schema', 'operations', operation, 'inputs', input, 'default'], kind: 'default',
      owner: { kind: 'input', declarationId: selected.id, input } });
  }
}

/** One retained contract schema with its owning model/value definition. */
function resolveCompletionContract(
  ctx: OpaqueResolveContext,
  name: string,
  raw: unknown,
  retainedValueDefaults: Set<string>,
): void {
  const { set, valueDefaults, valueDefaultKey, values } = ctx;
  const contract = closed(raw, ['fields']);
  const model = set.canonicalModels.find(candidate => candidate.name === name);
  const modelArtifact = set.artifactModels.find(candidate => candidate.name === name);
  const value = set.valueTypes.contracts.find(candidate => candidate.name === name);
  if ((model === undefined) === (value === undefined) || model !== undefined && modelArtifact === undefined) return refuse('schema contract lacks one original owning definition.');
  same(Object.keys(object(contract.fields)), modelArtifact !== undefined ? modelArtifact.fields.map(field => field.name) : value!.fields.map(field => field.name), 'original schema field order');
  for (const [fieldName, rawField] of Object.entries(object(contract.fields))) {
    const schemaField = closed(rawField, ['type'], ['min', 'max', 'format', 'distinctBy', 'excludedIds', 'default', 'trim', 'server', 'derived']);
    const original = modelArtifact !== undefined ? modelArtifact.fields.find(candidate => candidate.name === fieldName) : value!.fields.find(candidate => candidate.name === fieldName);
    if (original === undefined) return refuse('unknown original schema field.');
    const expected = schemaFieldDescriptor(original, model?.fields[fieldName]);
    const key = valueDefaultKey(name, fieldName);
    const captured = model === undefined ? valueDefaults.get(key) : undefined;
    if (captured !== undefined) expected.default = captured.value;
    same(schemaField, expected, 'original field type/default/constraints');
    if (!Object.hasOwn(schemaField, 'default')) continue;
    if (model === undefined) {
      if (captured === undefined) return refuse('missing original raw value default capture.');
      retainedValueDefaults.add(key);
    }
    if (model !== undefined ? !Object.hasOwn(model.fields, fieldName) : !value!.fields.some(candidate => candidate.name === fieldName)) return refuse('unknown default field owner.');
    values.push({ path: ['definition', 'schema', 'contracts', name, 'fields', fieldName, 'default'], kind: 'default',
      owner: model !== undefined ? { kind: 'model-field', model: model.name, field: fieldName } :
        { kind: 'value-field', contract: name, field: fieldName } });
  }
}

/** Standard-completion branch of opaque resolution. */
function resolveStandardCompletion(ctx: OpaqueResolveContext): void {
  const { row, data, origin, valueDefaults, projectInputs, projectResult } = ctx;
  closed(origin, ['kind', 'occurrenceId', 'declaration', 'originalIntent', 'originalCommit', 'dispatch', 'terminal', 'revision', 'bounds', 'routes']);
  same(origin.occurrenceId, row.id, 'completion occurrence');
  if (data.status !== 'completed' || data.code !== null || data.message !== null) return refuse('completion source receipt must be completed.');
  const declared = closed(origin.declaration, ['kind', 'source', 'event', 'providerSource', 'binding', 'from',
    'sourceInputsDeclarationId', 'inputsDeclarationId', 'resultDeclarationId', 'delivery']);
  if (declared.kind !== 'standard-completion') return refuse('standard completion declaration required.'); source(declared.source);
  for (const key of ['event', 'providerSource', 'binding', 'from', 'sourceInputsDeclarationId', 'inputsDeclarationId', 'resultDeclarationId']) string(declared[key]);
  object(declared.delivery);
  const result = closed(data.result, ['kind', 'definition', 'origin', 'terminal', 'event', 'payload', 'revision', 'handlers']);
  same(result.kind, 'standard-completion-source', 'completion source kind'); same(result.event, declared.event, 'completion event');
  const original = closed(result.origin, ['intent', 'originalCommit', 'dispatch']);
  const { intent, stamp, dispatch } = resolveCompletionIntent(ctx, declared, original);
  const terminal = resolveCompletionTerminal(ctx, result, intent, stamp, dispatch);
  const { schema } = resolveCompletionDefinition(ctx, declared, result);
  resolveCompletionSchemas(ctx, schema);
  // Every physically retained authored default receives its actual owning type.
  for (const [operation, raw] of Object.entries(schema.operations === undefined ? {} : object(schema.operations))) {
    resolveCompletionOperation(ctx, operation, raw);
  }
  const retainedValueDefaults = new Set<string>();
  for (const [name, raw] of Object.entries(schema.contracts === undefined ? {} : object(schema.contracts))) {
    resolveCompletionContract(ctx, name, raw, retainedValueDefaults);
  }
  if (retainedValueDefaults.size !== valueDefaults.size) return refuse('retained schema omits an original captured value default.');
  projectResult(['terminal', 'result'], string(declared.resultDeclarationId), terminal.result, terminal.status !== 'succeeded');
  projectInputs(['payload'], string(declared.inputsDeclarationId));
}

/** Exact-slot gate for opaque resolution. */
function assertOpaqueSlot(model: ModelName, field: string): void {
  if (model === WORK_DISPATCH_MODEL ? field !== 'sourceGuard' && field !== 'queuePayload' && field !== 'sendInputs' : model === WORK_OCCURRENCE_MODEL ? field !== 'result' :
      (model !== WORK_SCHEDULE_MODEL && model !== WORK_HANDLER_OCCURRENCE_MODEL) || field !== 'payload') return refuse('unknown exact opaque slot.');
}

/** Synchronous data-only owning resolution; no store read, observations or grant. */
export const resolveWorkOpaqueField: NonNullable<FrameworkFileReferenceProducer['resolveOpaqueField']> = (model, suppliedRow, field, suppliedContext) => {
  const snapshot = snapshotKernelJsonValue({ row: suppliedRow, context: suppliedContext }, 'Work opaque resolution');
  const row = snapshot.row, context = snapshot.context;
  assertOpaqueSlot(model, field);
  const binding = readWorkFilePayloadOrigin(row.data, row, model, field as 'result' | 'payload' | 'sourceGuard' | 'queuePayload' | 'sendInputs',
    field === 'result' ? 'retained-result' : 'deferred-input', field === 'queuePayload' ? 'queuePayloadOrigin' : field === 'sendInputs' ? 'sendInputsOrigin' : 'filePayloadOrigin');
  if (binding === undefined) return refuse('original payload binding required, including empty/null values.');
  same(context.binding, binding, 'supplied persisted binding');
  const sets = context.installed.inventory.opaqueDeclarationSets;
  const matching = sets?.filter(set => set.id === binding.declarationSetId) ?? [];
  if (matching.length !== 1) return refuse('one retained original declaration set required.');
  const set: FrameworkOpaqueDeclarationSet = matching[0]!;
  same(set.inventory, binding.inventory, 'original declaration inventory');
  // This is the captured own raw table, never Values' normalized defaults.
  const valueDefaults = captureValueDefaults(set);
  const valueDefaultKey = (contract: string, field: string): string => JSON.stringify([contract, field]);
  const values: FrameworkOpaqueValueProjection[] = [];
  const declaration = (id: string, kinds: readonly string[]): FrameworkOpaqueDeclaration => {
    const matches = set.declarations.filter(candidate => candidate.id === id && kinds.includes(candidate.profile.kind));
    if (matches.length !== 1) return refuse('one original declaration profile required.');
    return matches[0]!;
  };
  const projectInputs = (path: Path, id: string): void => { declaration(id, ['inputs']); values.push({ path, kind: 'inputs', declarationId: id }); };
  const projectResult = (path: Path, id: string, payload: unknown, failed: boolean): void => {
    const selected = declaration(id, ['result', 'provider-result', 'void']);
    const absent = selected.profile.kind === 'void' || failed && payload === null;
    if (selected.profile.kind === 'void' && payload !== null) return refuse('explicit void carries a result.');
    values.push({ path, kind: 'result', declarationId: id, presence: absent ? 'no-result' : 'value' });
  };
  const data = row.data as Data, origin = object(binding.origin), ownerScope = scope(binding.scope);
  const ctx: OpaqueResolveContext = { row, data, origin, ownerScope, set, binding, valueDefaults, valueDefaultKey, values, declaration, projectInputs, projectResult };
  if (model === WORK_DISPATCH_MODEL && field === 'sendInputs') {
    closed(origin, ['kind', 'caller', 'intent', 'request', 'inputsDeclarationId']);
    if (origin.kind !== 'send-input') return refuse('original SEND input recipe required.');
    const intent = closed(origin.intent, ['intentId', 'operation', 'operationId', 'target', 'occurrenceIndex']);
    const caller = callable(origin.caller), request = closed(origin.request, ['binding', 'from']);
    same(intent.intentId, row.id, 'SEND input intent'); same(intent.intentId, data.intentId, 'SEND dispatch identity');
    same(intent.operationId, data.operationId, 'SEND input operation'); same(intent.target, data.source, 'SEND input target');
    same(intent.occurrenceIndex, data.occurrenceIndex, 'SEND input ordinal'); same(intent.operation, caller.callable.id, 'SEND input caller');
    string(intent.operationId); integer(intent.occurrenceIndex); string(request.binding); string(request.from);
    const selected = declaration(string(origin.inputsDeclarationId), ['inputs']);
    if (selected.source.kind !== 'delivery' || selected.source.context.kind !== 'capability') return refuse('original SEND provider inputs required.');
    same(selected.source.source, caller.source, 'SEND input source');
    same(intent.target, `${selected.source.context.canonical.capability}.${selected.source.context.canonical.operation}`, 'SEND provider target');
    projectInputs([], string(origin.inputsDeclarationId));
  } else if (model === WORK_DISPATCH_MODEL && field === 'sourceGuard') {
    resolveSourceGuard(ctx);
  } else if (model === WORK_DISPATCH_MODEL && field === 'queuePayload') {
    resolveQueuePayload(ctx, model);
  } else if (model !== WORK_OCCURRENCE_MODEL) {
    resolveSchedulePayload(ctx, model);
  } else if (origin.kind === 'handler-result') {
    resolveHandlerResult(ctx);
  } else if (origin.kind === 'scheduled-handler-result') {
    resolveScheduledHandlerResult(ctx);
  } else if (origin.kind === 'source-routing') {
    resolveSourceRouting(ctx);
  } else if (origin.kind === 'standard-completion') {
    resolveStandardCompletion(ctx);
  } else return refuse('foreign recipe for actual Work slot.');
  return snapshotKernelJsonValue({ binding, values }, 'Work opaque projections');
};
