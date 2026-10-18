/** Runtime component for genuine finalized owner changes, staged in their fence.
 * Complete checked declaration correspondence in common metadata/Compiler and
 * genuine Dev native consumption/adoption remain BLOCKED under full SEQ048.
 * An installed selector here is runtime wiring, not that source acceptance. */
import type { DomainWrite, InvocationContext, ModelName, OccurrenceId,
  RecordId, RecordVersion, StoredRow, WorkScope } from '@canlang/contracts';
import { readOwnerMutationSourceStage, type OwnerMutationSourceStager, type OwnerMutationSourceStage } from '@canlang/state';
import type { FanoutCohortSpec } from '@canlang/state/fanout/cohort';
import type { OccurrenceIdPort } from '../ports.js';
import { stageHandlerOccurrence, readHandlerOccurrenceRow } from './handler-occurrence.js';
import { KernelTableError, WORK_OCCURRENCE_MODEL, WORK_FANOUT_INTENT_MODEL, WORK_FANOUT_CHECKPOINT_MODEL,
  WORK_FANOUT_CHILD_MODEL, newOccurrenceRow, readOccurrenceRow, newFanoutIntentRow, readFanoutIntentRow,
  newFanoutCheckpointRow, readFanoutCheckpointRow, newFanoutChildRow, readFanoutChildRow } from './tables.js';

export interface CommittedModelChange {
  readonly model: ModelName;
  readonly recordId: RecordId;
  readonly version: RecordVersion;
  readonly kind: 'created' | 'updated' | 'deleted';
}
export interface CommittedModelSourceBounds {
  readonly maxSources: number;
  readonly maxHandlers: number;
  readonly maxMembers: number;
  readonly chunkSize: number;
}
/** Installed host selector. The host separately owns complete checked metadata. */
export interface CommittedModelSourceRoutes {
  readonly scope: WorkScope;
  readonly handlers: readonly { readonly handler: string; readonly cohort?: FanoutCohortSpec }[];
}

const refuse = (message: string): never => { throw new KernelTableError(`Committed model source: ${message}`); };
function identity(value: unknown, maxLength = 200): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) return refuse('bounded nonempty identity required.');
  try { encodeURIComponent(value); } catch { return refuse('valid identity encoding required.'); }
  return value;
}
function integer(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER ? value : refuse('positive finite safe bound required.');
}
function copyContainer(part: object, array: boolean, keys: readonly (string | symbol)[],
  child: (value: unknown, depth: number) => unknown, depth: number): unknown {
  const out: unknown[] | Record<string, unknown> = array ? [] : {};
  let length = 0;
  if (array) {
    const descriptor = Object.getOwnPropertyDescriptor(part, 'length');
    if (descriptor === undefined || !('value' in descriptor) || !Number.isSafeInteger(descriptor.value) ||
        descriptor.value < 0 || descriptor.value > 20_000 || keys.length !== descriptor.value + 1) return refuse('dense bounded arrays required.');
    length = descriptor.value as number;
  }
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(part, key);
    if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable ||
        array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) return refuse('own enumerable selector data required.');
    Object.defineProperty(out, key, { value: child(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return out;
}
function copyData(value: unknown): unknown {
  let nodes = 0; const active = new Set<object>();
  const copy = (part: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 32) return refuse('selector data exceeds its finite budget.');
    if (part === null || typeof part === 'string' || typeof part === 'boolean') return part;
    if (typeof part === 'number' && Number.isFinite(part)) return part;
    if (typeof part !== 'object' || active.has(part)) return refuse('own JSON selector data required.');
    const array = Array.isArray(part), prototype = Object.getPrototypeOf(part);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return refuse('own JSON selector data required.');
    active.add(part);
    const keys = Reflect.ownKeys(part);
    if (keys.length > 20_000 - nodes) return refuse('selector data exceeds its finite budget.');
    const out = copyContainer(part, array, keys, (child, childDepth) => copy(child, childDepth), depth);
    active.delete(part); return out;
  };
  try { return copy(value, 0); }
  catch (error) { if (error instanceof KernelTableError) throw error; return refuse('own JSON selector data required.'); }
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) return refuse('closed selector shape required.');
  return value as Record<string, unknown>;
}
function frozen<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function boundsOf(value: CommittedModelSourceBounds): CommittedModelSourceBounds {
  const bounds = closed(copyData(value), ['maxSources', 'maxHandlers', 'maxMembers', 'chunkSize']);
  return Object.freeze({ maxSources: integer(bounds['maxSources']), maxHandlers: integer(bounds['maxHandlers']),
    maxMembers: integer(bounds['maxMembers']), chunkSize: integer(bounds['chunkSize']) });
}
function routesOf(value: unknown, context: InvocationContext, bounds: CommittedModelSourceBounds): CommittedModelSourceRoutes {
  const routes = closed(copyData(value), ['scope', 'handlers']);
  const rawScope = closed(routes['scope'], ['app', 'owner', 'ownerPackage']);
  const scope = { app: identity(rawScope['app']), owner: identity(rawScope['owner']), ownerPackage: identity(rawScope['ownerPackage']) };
  if (scope.app !== context.app || scope.owner !== (context.team?.teamId ?? context.app)) return refuse('selector scope differs from original owner context.');
  const rawHandlers = routes['handlers'];
  if (!Array.isArray(rawHandlers) || rawHandlers.length > bounds.maxHandlers) return refuse('complete handler inventory exceeds bound.');
  const seen = new Set<string>();
  const handlers = rawHandlers.map(raw => {
    const withCohort = typeof raw === 'object' && raw !== null && Object.hasOwn(raw, 'cohort');
    const route = closed(raw, withCohort ? ['handler', 'cohort'] : ['handler']);
    const handler = identity(route['handler']);
    if (seen.has(handler)) return refuse('duplicate handler or ordinary/cohort identity.');
    seen.add(handler);
    if (!withCohort) return { handler };
    const candidate = route['cohort'];
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return refuse('closed cohort required.');
    const kind = (candidate as Record<string, unknown>)['kind'];
    const cohort = closed(candidate, kind === 'model' ? ['kind', 'owner', 'model'] : ['kind', 'owner', 'model', 'parent']);
    const owner = identity(cohort['owner']), model = identity(cohort['model']);
    if (owner !== scope.owner) return refuse('cross-owner cohort refused.');
    if (kind === 'model') return { handler, cohort: { kind, owner, model } as FanoutCohortSpec };
    if (kind !== 'anchored-collection') return refuse('unsupported cohort kind.');
    const parent = closed(cohort['parent'], ['model', 'id']);
    return { handler, cohort: { kind, owner, model, parent: { model: identity(parent['model']), id: identity(parent['id']) } } as FanoutCohortSpec };
  });
  return frozen({ scope, handlers });
}
function attribution(context: InvocationContext): unknown {
  // Optional undefined fields have no stored JSON member; retain every defined
  // original attribution fact rather than synthesizing a trusted-source identity.
  return copyData({ kind: context.kind, app: context.app, operation: context.operation,
    operationId: context.operationId, source: context.source, now: context.now,
    actor: context.actor === null ? null : { userId: context.actor.userId,
      ...(context.actor.email === undefined ? {} : { email: context.actor.email }),
      ...(context.actor.emailVerified === undefined ? {} : { emailVerified: context.actor.emailVerified }) },
    team: context.team === null ? null : { teamId: context.team.teamId, timezone: context.team.timezone },
    ...(context.trustedSource === undefined ? {} : { trustedSource: context.trustedSource }) });
}
function factoryMembers(options: unknown): Record<string, unknown> {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return refuse('own factory configuration required.');
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) return refuse('own factory configuration required.');
  const expected = ['routesForChange', 'occurrenceIds', 'bounds'];
  const keys = Reflect.ownKeys(options);
  if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) return refuse('closed factory configuration required.');
  const members: Record<string, unknown> = {};
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return refuse('own factory data members required.');
    members[key] = descriptor.value;
  }
  return members;
}
function occurrenceAllocator(port: unknown): () => OccurrenceId {
  if (typeof port !== 'object' || port === null || Array.isArray(port)) return refuse('installed occurrence allocator required.');
  // Installed class ports legitimately keep this data method on a prototype
  // (including TestOnlyCounterOccurrenceIds). Capture it once without property
  // lookup or getter execution; keep its original mutable receiver for counters.
  let owner: object | null = port;
  for (let depth = 0; owner !== null && owner !== Object.prototype && depth < 32; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'nextOccurrenceId');
    if (descriptor !== undefined) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') return refuse('allocator must expose a data method.');
      const method = descriptor.value as OccurrenceIdPort['nextOccurrenceId'];
      return () => Reflect.apply(method, port, []) as OccurrenceId;
    }
    owner = Object.getPrototypeOf(owner);
  }
  return refuse('installed allocator data method required.');
}

/** No commits, handler execution or live membership recapture occur here.
 * Invoke receipt replay skips this genuine pipeline callback entirely. */
export function createCommittedModelSourceStager(options: {
  readonly routesForChange: (change: CommittedModelChange, context: InvocationContext) => CommittedModelSourceRoutes;
  readonly occurrenceIds: OccurrenceIdPort;
  readonly bounds: CommittedModelSourceBounds;
}): OwnerMutationSourceStager {
  let config: Record<string, unknown>, nextOccurrenceId: () => OccurrenceId;
  try { config = factoryMembers(options); nextOccurrenceId = occurrenceAllocator(config['occurrenceIds']); }
  catch (error) { if (error instanceof KernelTableError) throw error; return refuse('own factory configuration and installed allocator required.'); }
  if (typeof config['routesForChange'] !== 'function') return refuse('own installed selector function required.');
  const select = config['routesForChange'] as typeof options.routesForChange;
  const bounds = boundsOf(config['bounds'] as CommittedModelSourceBounds);
  return token => {
    const stage = readOwnerMutationSourceStage(token);
    return stageSources(token, bounds, stage.changes.map(change => ({
      occurrenceId: () => nextOccurrenceId(), routes: () => select(change, stage.context),
      event: `${change.model}.${change.kind}`,
      payload: (occurrenceId: OccurrenceId, scope: WorkScope) => ({ recordId: change.recordId,
        owner: scope.owner, version: change.version, occurrenceId }),
      result: { kind: 'committed-model-source', change: { ...change } }, skipEmpty: true,
    })));
  };
}

/** Typed payloads and route declarations are captured by the installed host
 * at each authored emit. Only State's genuine finalization token can stage them. */
export interface DeclaredEventSourceInput {
  readonly occurrenceId: OccurrenceId;
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly routes: CommittedModelSourceRoutes;
}
export async function stageDeclaredEventSources(token: OwnerMutationSourceStage,
  events: readonly DeclaredEventSourceInput[], bounds: CommittedModelSourceBounds): Promise<readonly DomainWrite[]> {
  const captured = events.map(event => ({ occurrenceId: identity(event.occurrenceId) as OccurrenceId,
    event: identity(event.event), payload: frozen(copyData(event.payload)) as Readonly<Record<string, unknown>>,
    routes: frozen(copyData(event.routes)) as unknown as CommittedModelSourceRoutes }));
  return stageSources(token, boundsOf(bounds), captured.map(event => ({
    occurrenceId: () => event.occurrenceId, event: event.event, routes: () => event.routes,
    payload: () => event.payload, result: { kind: 'declared-event-source' }, skipEmpty: false,
  })));
}

interface SourceStageEntry {
  readonly occurrenceId: () => OccurrenceId; readonly routes: () => CommittedModelSourceRoutes;
  readonly event: string; readonly payload: (id: OccurrenceId, scope: WorkScope) => Readonly<Record<string, unknown>>;
  readonly result: Readonly<Record<string, unknown>>; readonly skipEmpty: boolean;
}
type SourceStage = ReturnType<typeof readOwnerMutationSourceStage>;
type SourceInserter = (model: ModelName, row: StoredRow) => Promise<void>;
async function stageOrdinaryRoute(stage: SourceStage,
  insert: SourceInserter, source: { readonly occurrenceId: OccurrenceId; readonly event: string;
    readonly payload: Readonly<Record<string, unknown>>; readonly scope: WorkScope },
  handler: string, inventory: Record<string, unknown>[]): Promise<void> {
  const ordinary = await stageHandlerOccurrence({ source, handler }, stage.framework);
  if (ordinary.status !== 'ready') return refuse('ordinary handler route is not fresh and ready.');
  readHandlerOccurrenceRow(ordinary.row);
  const effects = ordinary.effects.writes ?? [];
  if (effects.length !== 1 || effects[0]?.kind !== 'insert' || effects[0].row !== ordinary.row) return refuse('unexpected ordinary handler effects.');
  await insert(effects[0].model, ordinary.row);
  inventory.push({ handler, kind: 'ordinary', occurrenceId: ordinary.occurrence.occurrenceId });
}
async function stageCohortRoute(stage: SourceStage, bounds: CommittedModelSourceBounds,
  meta: Parameters<typeof newFanoutIntentRow>[1], insert: SourceInserter,
  occurrenceId: OccurrenceId, handler: string, cohort: FanoutCohortSpec, inventory: Record<string, unknown>[]): Promise<void> {
  if (cohort.kind === 'anchored-collection') {
    const parentModel = cohort.parent.model as ModelName, parentId = cohort.parent.id as RecordId;
    if (await stage.final.get(parentModel, parentId) === null && await stage.entry.get(parentModel, parentId) === null) return refuse('anchored cohort parent is unknowable.');
  }
  // The actual final view checks the known model and complete bounded
  // domain before applying this selection; a limit never truncates a cut.
  const rows = await stage.final.query({ model: cohort.model as ModelName, authority: 'owner', archived: 'exclude',
    order: [{ field: 'id', direction: 'asc' }], limit: stage.maxRows,
    ...(cohort.kind === 'anchored-collection' ? { parent: { model: cohort.parent.model as ModelName, id: cohort.parent.id as RecordId } } : {}) });
  if (rows.length > bounds.maxMembers) return refuse('complete cohort membership exceeds bound.');
  stage.consumeWork(rows.length);
  const members = rows.map(row => row.id as string);
  if (new Set(members).size !== members.length || members.some((id, index) => rowInvalid(id, rows[index]!, cohort, members[index - 1]))) return refuse('cohort is not a complete canonical identity selection.');
  const intentRow = newFanoutIntentRow({ sourceOccurrence: occurrenceId, handler, cohort: cohort.kind, members }, meta);
  const intent = readFanoutIntentRow(intentRow);
  const first = intent.members.slice(0, bounds.chunkSize);
  const cursor = first.length === intent.memberCount ? null : `admit/v2/${first.length}`;
  const checkpoint = newFanoutCheckpointRow({ fanoutId: intent.fanoutId, cursor }, meta);
  readFanoutCheckpointRow(checkpoint);
  await insert(WORK_FANOUT_INTENT_MODEL, intentRow);
  await insert(WORK_FANOUT_CHECKPOINT_MODEL, checkpoint);
  for (const recordId of first) {
    stage.consumeWork(1);
    const child = newFanoutChildRow({ fanoutId: intent.fanoutId, parentOccurrence: occurrenceId, handler, recordId }, meta);
    readFanoutChildRow(child); await insert(WORK_FANOUT_CHILD_MODEL, child);
  }
  inventory.push({ handler, kind: 'fanout', cohort, fanoutId: intent.fanoutId,
    members: intent.members, memberCount: intent.memberCount, firstChunkCount: first.length, cursor });
}
async function stageSources(token: OwnerMutationSourceStage, bounds: CommittedModelSourceBounds,
  entries: readonly SourceStageEntry[]): Promise<readonly DomainWrite[]> {
    const stage = readOwnerMutationSourceStage(token);
    const writes: DomainWrite[] = [], allocated = new Set<string>(), stagedRows = new Set<string>();
    const meta = { nowMs: stage.framework.now, actor: stage.framework.actor };
    let sources = 0, handlers = 0;
    const insert = async (model: ModelName, row: StoredRow): Promise<void> => {
      // Canonical constructors encode up to three 200-codeunit components;
      // the defining State framework accepts their existing compound IDs.
      identity(row.id, 6000);
      const key = `${model}\0${row.id}`;
      if (stagedRows.has(key) || await stage.framework.load(model, row.id) !== null) return refuse('preexisting or colliding framework source effect.');
      stagedRows.add(key); writes.push({ kind: 'insert', model, row });
    };
    for (const entry of entries) {
      stage.consumeWork(1);
      const routes = routesOf(entry.routes(), stage.context, bounds);
      if (entry.skipEmpty && routes.handlers.length === 0) continue;
      if (++sources > bounds.maxSources || (handlers += routes.handlers.length) > bounds.maxHandlers) return refuse('complete source/handler inventory exceeds bound.');
      const occurrenceId = identity(entry.occurrenceId()) as OccurrenceId;
      if (allocated.has(occurrenceId)) return refuse('occurrence allocator repeated a source identity.');
      allocated.add(occurrenceId);
      if (await stage.framework.load(WORK_OCCURRENCE_MODEL, occurrenceId as RecordId) !== null) return refuse('source occurrence receipt already exists.');
      const event = entry.event;
      const payload = frozen(copyData(entry.payload(occurrenceId, routes.scope))) as Readonly<Record<string, unknown>>;
      const source = frozen({ occurrenceId, event, payload: { ...payload }, scope: routes.scope });
      const inventory: Record<string, unknown>[] = [];
      for (const route of routes.handlers) {
        stage.consumeWork(1);
        if (route.cohort === undefined) {
          await stageOrdinaryRoute(stage, insert, source, route.handler, inventory);
          continue;
        }
        await stageCohortRoute(stage, bounds, meta, insert, occurrenceId, route.handler, route.cohort, inventory);
      }
      const receipt = newOccurrenceRow({ occurrenceId, status: 'completed', code: null, message: null, recordedAtMs: stage.context.now,
        result: { ...entry.result, event, payload, context: attribution(stage.context),
          revision: stage.revision, scope: routes.scope, bounds, handlers: inventory } }, meta);
      readOccurrenceRow(receipt); await insert(WORK_OCCURRENCE_MODEL, receipt);
    }
    return frozen(writes);
}
function rowInvalid(id: string, row: StoredRow, cohort: FanoutCohortSpec, previous: string | undefined): boolean {
  identity(id);
  return row.archivedAt !== null || previous !== undefined && previous >= id ||
    cohort.kind === 'anchored-collection' && (row.parent?.model !== cohort.parent.model || row.parent?.id !== cohort.parent.id);
}
