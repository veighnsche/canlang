/**
 * B1 interim data-plane stdlib: the c-first functions emitted
 * `async op(c, …)` handlers call. NAMED INTERIM home per coordinator R5.
 *
 * T17b migration (this file): `create`/`set`/`deleteRecord`/`records`
 * route through the canonical engine via the context's canonical scope
 * (`c.canonical`, installed by the scenario seam in `./invoke.js`) —
 * admission happened once for the scenario; each write stages through
 * the canonical mutation pipeline (`runMutationWrites`: real
 * `ModelTable`, provisional map, uniques, history) into the scenario
 * effects, and the ONE fenced commit carries the scenario operation
 * identity into history entries and the receipt. `records()` serves
 * through `invokeRead` (admission + viewer grant projection by the
 * engine, over the staged overlay so handler reads see handler writes).
 * The direct fenced `StoragePort` commits/queries are RETIRED: without
 * a scope every data-plane call fails loud (there is no serving path
 * outside canonical execution anymore).
 *
 * Error contract for handler authors: pipeline failures surface as the
 * engine's `StateError`s (`validation`/`not_found`/`conflict`/
 * `rule_failed`) WITH their codes — catch them by `error.code` to
 * branch or recover, or let them propagate: the seam attributes
 * uncaught engine failures message-exactly, so they receipt with
 * their TRUE codes (parity with the CRUD path). Do NOT rethrow
 * shaped `{ code, message }` objects to preserve codes — handler
 * failures stringify at the invoke boundary, so a shaped object
 * would arrive as `"[object Object]"` and destroy its own message.
 * Anything the handler throws itself becomes `rule_failed` with its
 * message (the assembly's established unexpected-failure rule).
 * Unservable `records()` shapes (`where`/`order`/`limit`, `archived:
 * 'include'`, `authority: 'owner'`) refuse LOUD with `validation`
 * (T04a carries no filter vocabulary; T04b does) instead of
 * mis-serving.
 *
 * REMAINING B1 handoff (still open after T17b):
 * - Implement the 7 stubs (send/emit/schedule/cancel/check/delivery/
 *   secretEqual) against the effects pipeline, schedule store, and
 *   secrets bindings.
 * - Authenticate `hasRole` memberships via the L3 identity/policy join
 *   (B1 evaluates the caller-supplied `c.memberships` array as-is).
 * - Lock the L1 T4 call-shape contract (arg order, branded ids, patch
 *   semantics, error codes) and move this surface to its final home.
 * - Unite with the `@canlang/stdlib` facade (lane-03): B1 maps the
 *   emitted `@canlang/stdlib` specifier here, so only the names below
 *   resolve; every other builtin fails loud at import until the union.
 *
 * `require`, `hasRole`, and `count` keep their B1 local semantics
 * byte-identically; the 7 stubs throw `unsupported(<name>)` — never
 * silent, never fake data.
 */
import type {
  CanValue,
  JudgmentSpec,
  OrderTerm,
  PresentationContext,
  PageGenerationCallbackDiagnosticsObserver,
  ProjectedRecord,
  QueryPredicate,
  ReadAuthority,
  RecordParent,
  StoredRow,
} from '@canlang/contracts';
import type { CanonicalEffectsScope, HandlerContext, NativeSendWhen } from './context.js';
import { app_url as appUrlProducer, equalValue as equalValueProducer, compareScalar, ValueError } from '@canlang/values';
import { StateError } from '@canlang/state/errors';
import type { NormalizedSchema } from '@canlang/values';
import { nativeRecordReference, sameNativeReference } from './native-records.js';
import { hasRole as stateCallerRole, type HandlerRoleContext } from '@canlang/state/effects/guards';
import { nativeReadSubjectRole } from './native-membership.js';

// Private generated markers resolve only framework-bound scenario lifetimes.
export { observeScenarioReceiptDependency, observeScenarioReceiptIntrinsic, selectScenarioReceiptReturn, invokeScenarioReceiptCall,
  executeScenarioReceiptQuery, executeScenarioReceiptAny, readScenarioReceiptQueryParent, readScenarioReceiptStoredReference, readScenarioReceiptNullableStoredReference, firstQuery, countQuery, observeScenarioReceiptQueryDependency, bindScenarioReceiptQueryResult, bindScenarioReceiptQuerySelection, bindScenarioReceiptModelResult } from './scenario-receipt-frame.js';

// Generated pure helpers retain their Values producer identity.
export {
  ValueError, int64, datetime, compareInstant, addDuration, subtractDuration, overlaps, abs, all, any, at, sum, min, max, join, trim, starts_with, compareScalar, choose, concat, flatten, group, format,
  parseDecimal, addDecimal, compareDecimal, multiplyDecimal, money, addMoney, subtractMoney, negateMoney, multiplyMoney, compareMoney, equalMoney,
  divideDurationMs, remainderDuration, multiplyDuration, durationBetween, first,
  date, add_days, add_months, date_year, local_date, local_instant, compareDate, dates, weekday, decodeValue, encodeValue, normalizeSchema, makeMessageDescriptor,
} from '@canlang/values';
export const same = sameNativeReference;
export { active_member } from './native-membership.js';
export { nativeReadBoolean, nativeReadReference } from './native-read-boolean.js';
export { nativeScenarioRequire, nativeScenarioEventDecision, nativeScenarioTermDecision,
  nativeScenarioLeaveRequestDecision, nativeScenarioLeaveDecideDecision,
  nativeScenarioReferRejectDecision, nativeScenarioMemberRetryDecision,
  nativeScenarioInvoiceOverdueDecision, nativeScenarioRentMovementRefundDecision,
  nativeScenarioInvoiceCollectDecision, nativeScenarioRentNoticeDecision,
  withLeaveDecideAllowance } from './native-scenario-require.js';
export { delivery } from '@canlang/state/effects/delivery';

/** Whole historical callback observation through the installed current viewer scope. */
export function generationCallbackDiagnostics(
  c: Pick<PresentationContext, 'canonical'>,
  locator: Parameters<PageGenerationCallbackDiagnosticsObserver>[0],
): ReturnType<PageGenerationCallbackDiagnosticsObserver> {
  const canonical = c.canonical;
  const observe = canonical?.observeGenerationCallbackDiagnostics;
  if (typeof observe !== 'function') {
    throw new Error('Generation callback diagnostics require the installed viewer scope.');
  }
  return observe.call(canonical, locator);
}

/** Pure app link construction from explicit host configuration; grants no access. */
export function app_url(c: Pick<PresentationContext, 'deploymentBase'>, path: string): string {
  if (c.deploymentBase === undefined) {
    throw new ValueError('invalid-construction', 'app_url requires a trusted deployment base');
  }
  return appUrlProducer(path, c.deploymentBase);
}

/** Lowered static source constant: no provider call, storage read or additional authority. */
export function judgmentSpecification(c: HandlerContext, qualifiedName: string, options?: unknown): JudgmentSpec {
  if (typeof c.judgmentSpecification !== 'function') {
    throw new Error('Judgment specification requires the pinned compiled source resolver.');
  }
  return c.judgmentSpecification(qualifiedName, options);
}

/** Pure checked equality, with compatibility for earlier c-first artifacts. */
export function equalValue(typeId: string, a: CanValue, b: CanValue, reserved?: undefined, schema?: NormalizedSchema): boolean;
export function equalValue(c: HandlerContext, typeId: string, a: CanValue, b: CanValue, reserved?: undefined, schema?: NormalizedSchema): boolean;
export function equalValue(typeOrContext: string | HandlerContext, typeOrA: string | CanValue, aOrB: CanValue,
  bOrReserved?: CanValue, reservedOrSchema?: NormalizedSchema, schema?: NormalizedSchema): boolean {
  return typeof typeOrContext === 'string'
    ? equalValueProducer(typeOrContext, typeOrA as CanValue, aOrB, nativeRecordReference, reservedOrSchema)
    : equalValueProducer(typeOrA as string, aOrB, bOrReserved as CanValue, nativeRecordReference, schema);
}

/** Input for {@link create}: explicit id plus data (crud interim convention). */
export interface CreateInput {
  readonly id: string;
  readonly data: Record<string, unknown>;
  readonly parent?: RecordParent;
}

/** Query overrides for {@link records}; everything is optional. */
export interface RecordsQuery {
  /** Compiler-stamped query site; the host checks it against the bound source census. */
  readonly authoritySource?: Readonly<{ readonly id: string }>;
  readonly ownerDecisionSource?: Readonly<{ readonly id: string }>;
  readonly parent?: unknown;
  readonly where?: QueryPredicate;
  readonly order?: ReadonlyArray<OrderTerm> | {
    readonly by: (row: ProjectedRecord | Record<string, unknown>) => unknown | Promise<unknown>;
    readonly compare: (left: unknown, right: unknown) => number;
    readonly direction: 'asc' | 'desc';
  };
  readonly limit?: number;
  readonly archived?: 'exclude' | 'include';
  /**
   * Read authority label. T17b: served through `invokeRead`, which is
   * viewer-only in the core scope (the engine projects by grants; the
   * owner bypass stays engine-internal — T32 owns authority fences). An
   * absent label serves viewer; an explicit `'owner'` refuses LOUD.
   */
  readonly authority?: ReadAuthority;
}

/**
 * T17b: require the canonical scope. The direct-commit paths are retired,
 * so a missing scope is a loud programmer error naming the retirement —
 * never a silent direct commit and never fake data.
 */
function requireScope(c: HandlerContext, name: string): CanonicalEffectsScope {
  const scope: unknown = c.canonical;
  if (scope === undefined || scope === null) {
    throw new Error(
      `t17: stdlib ${name}() needs a canonical execution scope; direct data-plane ` +
        `commits were retired in T17 (no serving path runs outside canonical execution)`,
    );
  }
  return scope as CanonicalEffectsScope;
}

/** T17b: handler-arg wire check (wiring bugs fail fast; the engine validates the domain). */
function requireModelId(model: unknown, id: unknown, name: string): { model: string; id: string } {
  if (typeof model !== 'string' || model === '') {
    throw new Error(`t17: stdlib ${name}() needs a non-empty string model.`);
  }
  if (typeof id !== 'string' || id === '') {
    throw new Error(`t17: stdlib ${name}() needs a non-empty string record id.`);
  }
  return { model, id };
}

/**
 * Insert one record via the canonical mutation pipeline. The write stages
 * into the scenario effects (version 1, timestamps from the frozen
 * admission clock, attribution from the admitted caller) and commits once
 * with the scenario receipt — history carries the scenario operation
 * identity. Domain failures (`validation` on unknown model/field,
 * missing required, bad parent; `validation` on duplicate id) surface as
 * the engine's `StateError`s (see the file header for the catch contract).
 */
export function create(c: HandlerContext, model: string, input: CreateInput): Promise<StoredRow>;
export function create(c: HandlerContext, model: string, data: Record<string, unknown>, options?: unknown): Promise<Record<string, unknown>>;
export async function create(
  c: HandlerContext,
  model: string,
  input: CreateInput | Record<string, unknown>,
  options?: unknown,
): Promise<StoredRow | Record<string, unknown>> {
  const scope = requireScope(c, 'create');
  if (options !== undefined) throw new Error('unsupported(create): candidate predicates are not wired to generated helpers.');
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('create() needs a data object.');
  }
  if (!Object.hasOwn(input, 'id')) {
    if (scope.createRecord === undefined) throw new Error('create() needs generated record bindings.');
    return scope.createRecord(model, input as Record<string, unknown>);
  }
  const legacy = input as CreateInput;
  const target = requireModelId(model, legacy.id, 'create');
  if (typeof legacy.data !== 'object' || legacy.data === null || Array.isArray(legacy.data)) {
    throw new Error('t17: stdlib create() needs a data object.');
  }
  const staged = await scope.stageWrite({
    op: 'create',
    model: target.model,
    id: target.id,
    ...(legacy.parent === undefined ? {} : { parent: legacy.parent }),
    data: legacy.data,
  });
  if (staged === null) {
    throw new Error('t17: stdlib create() staged no row (seam wiring bug).');
  }
  return staged;
}

/**
 * Patch one existing record via the canonical mutation pipeline (shallow
 * data merge, version + 1, read-your-write over staged + stored rows).
 * Throws the engine's `not_found` when the record does not exist.
 * Concurrent scenarios converge through the revision fence + retry (the
 * loser re-executes against the winner's rows); nothing is silently
 * overwritten.
 */
export function set(c: HandlerContext, model: string, id: string, patch: Record<string, unknown>): Promise<StoredRow>;
export function set(c: HandlerContext, record: Record<string, unknown>, patch: Record<string, unknown>, options?: unknown): Promise<Record<string, unknown>>;
export async function set(
  c: HandlerContext,
  model: string | Record<string, unknown>,
  id: string | Record<string, unknown>,
  patch?: unknown,
): Promise<StoredRow | Record<string, unknown>> {
  const scope = requireScope(c, 'set');
  if (typeof model === 'object' && model !== null && !Array.isArray(model)) {
    if (patch !== undefined) throw new Error('unsupported(set): candidate predicates are not wired to generated helpers.');
    if (typeof id !== 'object' || id === null || Array.isArray(id)) throw new Error('set() needs a changes object.');
    if (scope.setRecord === undefined) throw new Error('set() needs generated record bindings.');
    return scope.setRecord(model, id);
  }
  const target = requireModelId(model, id, 'set');
  const staged = await scope.stageWrite({
    op: 'update',
    model: target.model,
    id: target.id,
    data: patch as Record<string, unknown>,
  });
  if (staged === null) {
    throw new Error('t17: stdlib set() staged no row (seam wiring bug).');
  }
  return staged;
}

/**
 * Delete one record via the canonical mutation pipeline, honoring the
 * model table's delete mode (`archive` stamps `archivedAt` and keeps the
 * row; `remove` hard-removes it; `none` refuses). Throws the engine's
 * `not_found` when the record does not exist.
 */
export function deleteRecord(c: HandlerContext, model: string, id: string): Promise<void>;
export function deleteRecord(c: HandlerContext, record: Record<string, unknown>, options: { mode: 'archive' | 'remove' }): Promise<void>;
export async function deleteRecord(
  c: HandlerContext,
  model: string | Record<string, unknown>,
  id: string | { mode: 'archive' | 'remove' },
): Promise<void> {
  const scope = requireScope(c, 'deleteRecord');
  if (typeof model === 'object' && model !== null && !Array.isArray(model)) {
    if (typeof id !== 'object' || id === null || (id.mode !== 'archive' && id.mode !== 'remove')) {
      throw new Error('deleteRecord() needs the declared delete mode.');
    }
    if (scope.deleteRecord === undefined) throw new Error('deleteRecord() needs generated record bindings.');
    return scope.deleteRecord(model, id.mode);
  }
  const target = requireModelId(model, id, 'deleteRecord');
  await scope.stageWrite({ op: 'remove', model: target.model, id: target.id });
}

/**
 * Serve one whole-model viewer read through `invokeRead` (admission +
 * engine grant projection, over the staged overlay so handler reads see
 * handler writes). Checked source handlers receive flat native record
 * fields; legacy handlers retain projected wire envelopes. Both use only
 * granted fields (denied leaves omitted, never null). Unservable shapes refuse LOUD with `validation`:
 * `where`/`order`/`limit` (T04a carries no filter vocabulary — T04b
 * does; the engine fails limit overflow instead of truncating, so a
 * client slice would mis-serve), `archived: 'include'` (reads exclude),
 * and `authority: 'owner'` (engine-internal bypass).
 */
type RecordsOrder = Exclude<RecordsQuery['order'], ReadonlyArray<OrderTerm> | undefined>;

function checkRecordsOrder(query: RecordsQuery): RecordsOrder | undefined {
  const order = query.order !== undefined && !Array.isArray(query.order)
    ? query.order as RecordsOrder : undefined;
  if (order !== undefined && (order === null || typeof order !== 'object' || typeof order.by !== 'function' || typeof order.compare !== 'function' ||
      !['asc', 'desc'].includes(order.direction) || Object.keys(order).some(key => !['by', 'compare', 'direction'].includes(key)))) {
    throw new StateError('validation', 'Expression query order requires its typed key and comparator.');
  }
  return order;
}

function coerceRecordsLimit(query: RecordsQuery): unknown {
  const rawLimit: unknown = query.limit;
  return typeof rawLimit === 'bigint' && rawLimit >= 0n && rawLimit <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(rawLimit) : rawLimit;
}

function buildRecordsSelection(query: RecordsQuery, order: RecordsOrder | undefined): Record<string, unknown> {
  return {
    ...(query.authoritySource === undefined ? {} : { authoritySource: query.authoritySource }),
    ...(query.ownerDecisionSource === undefined ? {} : { ownerDecisionSource: query.ownerDecisionSource }),
    ...(query.parent === undefined ? {} : { parent: query.parent }),
    ...(query.where === undefined ? {} : { where: query.where }),
    ...(query.order === undefined || order !== undefined ? {} : { order: query.order as ReadonlyArray<OrderTerm> }),
    ...(query.limit === undefined || order !== undefined ? {} : { limit: query.limit }),
    ...(query.archived === undefined ? {} : { archived: query.archived }),
    ...(query.authority === undefined ? {} : { authority: query.authority }),
  };
}

interface KeyedRow {
  row: ProjectedRecord | Record<string, unknown>;
  key: unknown;
}

function compareKeyed(order: RecordsOrder, left: KeyedRow, right: KeyedRow): number {
  const a = left.key, b = right.key;
  const compared = a == null ? b == null ? 0 : -1 : b == null ? 1 : order.compare(a, b);
  if (!Number.isFinite(compared)) throw new StateError('validation', 'Expression query comparator returned an invalid result.');
  return compared === 0 ? compareScalar(left.row.id as string, right.row.id as string)
    : order.direction === 'desc' ? -compared : compared;
}

async function applyExpressionOrder(
  rows: ReadonlyArray<ProjectedRecord | Record<string, unknown>>,
  order: RecordsOrder,
  limit: unknown,
): Promise<ReadonlyArray<ProjectedRecord | Record<string, unknown>>> {
  // Permissions, complete-domain bounds and row observers belong to the same
  // canonical read. Evaluate each key once, in that issued order, before sort
  // and projection. A key failure stops later keys and all projection.
  const keyed = [];
  for (const row of rows) keyed.push({ row, key: await order.by(row) });
  keyed.sort((left, right) => compareKeyed(order, left, right));
  if (limit !== undefined && rows.length > (limit as number)) throw new StateError('validation',
    `Query matched ${rows.length} rows, over the limit of ${limit}. Narrow the query instead of truncating.`);
  return keyed.map(entry => entry.row);
}

export async function records(
  c: HandlerContext,
  model: string,
  query: RecordsQuery = {},
): Promise<ReadonlyArray<ProjectedRecord | Record<string, unknown>>> {
  const scope = requireScope(c, 'records');
  if (typeof model !== 'string' || model === '') {
    throw new Error('t17: stdlib records() needs a non-empty string model.');
  }
  const order = checkRecordsOrder(query);
  const limit = coerceRecordsLimit(query);
  if (order !== undefined && limit !== undefined && (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0)) {
    throw new StateError('validation', 'Expression query limit requires a non-negative safe integer.');
  }
  const selection = buildRecordsSelection(query, order);
  const rows = await (scope.readRecords === undefined
    ? scope.readModel(model, selection)
    : scope.readRecords(model, selection));
  if (order === undefined) return rows;
  return applyExpressionOrder(rows, order, limit);
}

/** Stub helper: every unimplemented data-plane name throws loudly. */
function unsupported(name: string, reason: string): never {
  throw new Error(`unsupported(${name}): ${reason}`);
}

/** Bound sends stage in the admitted scenario's single canonical commit. */
function checkSendWhen(options: { readonly binding?: string; readonly when?: NativeSendWhen }): NativeSendWhen | undefined {
  const whenProperty = Object.getOwnPropertyDescriptor(options, 'when');
  if (!('when' in options)) return undefined;
  const value: unknown = whenProperty !== undefined && 'value' in whenProperty ? whenProperty.value : undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== 2 ||
      ['rule', 'inputs'].some(key => {
        const property = Object.getOwnPropertyDescriptor(value, key);
        return property === undefined || !('value' in property) || !property.enumerable;
      })) {
    return unsupported('send', 'dispatch guards require their original emitted rule and lexical inputs.');
  }
  const rule: unknown = Object.getOwnPropertyDescriptor(value, 'rule')!.value;
  const inputs: unknown = Object.getOwnPropertyDescriptor(value, 'inputs')!.value;
  if (typeof rule !== 'string' || rule === '' || rule.length > 4096 || typeof inputs !== 'object' ||
      inputs === null || Array.isArray(inputs) || ![Object.prototype, null].includes(Object.getPrototypeOf(inputs))) {
    return unsupported('send', 'dispatch guards require their original emitted rule and lexical inputs.');
  }
  return Object.freeze({ rule, inputs: inputs as Readonly<Record<string, unknown>> });
}

export async function send(
  c: HandlerContext,
  operation: string,
  request: unknown,
  options: { readonly binding?: string; readonly when?: NativeSendWhen } = {},
) {
  const when = checkSendWhen(options);
  if (c.canonical === undefined || c.sendDeferred === undefined) {
    return unsupported('send', 'bound send staging requires canonical execution.');
  }
  if (typeof options.binding !== 'string' || options.binding === '') {
    throw new Error('send requires its checked logical capability binding.');
  }
  return when === undefined ? c.sendDeferred(operation, request, options.binding)
    : c.sendDeferred(operation, request, options.binding, when);
}

/** Typed events are frozen now and persisted with their source commit.
 * Their handlers execute later through Work, never inline in this operation. */
export async function emit(c: HandlerContext, event: string, payload: unknown): Promise<void> {
  if (c.canonical === undefined || c.emitDeferred === undefined) {
    return unsupported('emit', 'domain-event emission requires canonical source staging.');
  }
  await c.emitDeferred(event, payload);
}

/** Keyed schedules join the admitted scenario's canonical commit. */
export async function schedule(
  c: HandlerContext, key: string, at: import('@canlang/contracts').DatetimeValue,
  event: string, payload: unknown, options: { readonly ownerPackage?: string } = {},
): Promise<void> {
  if (c.canonical === undefined || c.scheduleDeferred === undefined) {
    return unsupported('schedule', 'keyed schedule staging requires canonical execution.');
  }
  if (typeof key !== 'string' || key === '' || typeof options.ownerPackage !== 'string' || options.ownerPackage === '') {
    throw new Error('schedule requires its text key and checked lexical owner package.');
  }
  await c.scheduleDeferred(key, at, event, payload, options.ownerPackage);
}

/** Cancellation uses the same checked package and admitted owner scope. */
export async function cancel(
  c: HandlerContext, key: string, options: { readonly ownerPackage?: string } = {},
): Promise<void> {
  if (c.canonical === undefined || c.cancelDeferred === undefined) {
    return unsupported('cancel', 'keyed cancellation staging requires canonical execution.');
  }
  if (typeof key !== 'string' || key === '' || typeof options.ownerPackage !== 'string' || options.ownerPackage === '') {
    throw new Error('cancel requires its text key and checked lexical owner package.');
  }
  await c.cancelDeferred(key, options.ownerPackage);
}

/** Not in B1: receipt/idempotency checks need the L3 invocation context. */
export function check(c: HandlerContext, ..._args: unknown[]): never {
  void c;
  return unsupported('check', 'receipt/idempotency checks need the L3 invocation context.');
}

// Compatibility bindings share the state-owned synchronous handler guards.
export { require } from '@canlang/state/effects/guards';
export function hasRole(c: HandlerRoleContext, role: string): boolean;
export function hasRole(c: HandlerContext, role: string, subject: unknown): Promise<boolean>;
export function hasRole(c: HandlerRoleContext | HandlerContext, role: string, subject?: unknown): boolean | Promise<boolean> {
  return arguments.length < 3 ? stateCallerRole(c, role) : nativeReadSubjectRole(c as HandlerContext, role, subject);
}

/**
 * Supplied-array count, mirroring the lane-02 `count(domain:C<T>)->int`
 * catalog entry (values `array.ts`: `BigInt(length)`, loud on non-array).
 * Interim local mirror until the facade union; record-query evaluation
 * stays lane-03's per the catalog note.
 */
export function count(domain: ReadonlyArray<unknown>): bigint {
  if (!Array.isArray(domain)) throw new Error('count: domain must be an array');
  return BigInt(domain.length);
}

/** Not in B1: constant-time secret comparison needs the L3 secrets binding. */
export function secretEqual(c: HandlerContext, ..._args: unknown[]): never {
  void c;
  return unsupported('secretEqual', 'constant-time secret comparison needs the L3 secrets binding.');
}

// Generated runtime modules share the state-owned lifecycle producer.
export { transition } from '@canlang/state/effects/transition';
