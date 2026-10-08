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
  OrderTerm,
  ProjectedRecord,
  QueryPredicate,
  ReadAuthority,
  RecordParent,
  StoredRow,
} from '@canlang/contracts';
import type { CanonicalEffectsScope, HandlerContext } from './context.js';
import { equalValue as equalValueProducer } from '@canlang/values';
import { sameNativeReference } from './native-records.js';

// Generated pure helpers retain their Values producer identity.
export {
  int64, datetime, compareInstant, addDuration, all, sum, join, trim, compareScalar,
  parseDecimal, addDecimal, compareDecimal, money, addMoney, compareMoney,
  date, add_days, compareDate,
} from '@canlang/values';
export const same = sameNativeReference;
export { delivery } from '@canlang/state/effects/delivery';

/** Pure checked equality, with compatibility for earlier c-first artifacts. */
export function equalValue(typeId: string, a: CanValue, b: CanValue): boolean;
export function equalValue(c: HandlerContext, typeId: string, a: CanValue, b: CanValue): boolean;
export function equalValue(typeOrContext: string | HandlerContext, typeOrA: string | CanValue, aOrB: CanValue, b?: CanValue): boolean {
  return typeof typeOrContext === 'string'
    ? equalValueProducer(typeOrContext, typeOrA as CanValue, aOrB)
    : equalValueProducer(typeOrA as string, aOrB, b as CanValue);
}

/** Input for {@link create}: explicit id plus data (crud interim convention). */
export interface CreateInput {
  readonly id: string;
  readonly data: Record<string, unknown>;
  readonly parent?: RecordParent;
}

/** Query overrides for {@link records}; everything is optional. */
export interface RecordsQuery {
  readonly parent?: unknown;
  readonly where?: QueryPredicate;
  readonly order?: ReadonlyArray<OrderTerm>;
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
export async function records(
  c: HandlerContext,
  model: string,
  query: RecordsQuery = {},
): Promise<ReadonlyArray<ProjectedRecord | Record<string, unknown>>> {
  const scope = requireScope(c, 'records');
  if (typeof model !== 'string' || model === '') {
    throw new Error('t17: stdlib records() needs a non-empty string model.');
  }
  const selection = {
    ...(query.parent === undefined ? {} : { parent: query.parent }),
    ...(query.where === undefined ? {} : { where: query.where }),
    ...(query.order === undefined ? {} : { order: query.order }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.archived === undefined ? {} : { archived: query.archived }),
    ...(query.authority === undefined ? {} : { authority: query.authority }),
  };
  return scope.readRecords === undefined
    ? scope.readModel(model, selection)
    : scope.readRecords(model, selection);
}

/** Stub helper: every unimplemented data-plane name throws loudly. */
function unsupported(name: string, reason: string): never {
  throw new Error(`unsupported(${name}): ${reason}`);
}

/** Bound sends stage in the admitted scenario's single canonical commit. */
export async function send(
  c: HandlerContext,
  operation: string,
  request: unknown,
  options: { readonly binding?: string; readonly when?: () => boolean | Promise<boolean> } = {},
) {
  if (options.when !== undefined) {
    return unsupported('send', 'dispatch guards require current-state dispatch qualification.');
  }
  if (c.canonical === undefined || c.sendDeferred === undefined) {
    return unsupported('send', 'bound send staging requires canonical execution.');
  }
  if (typeof options.binding !== 'string' || options.binding === '') {
    throw new Error('send requires its checked logical capability binding.');
  }
  return c.sendDeferred(operation, request, options.binding);
}

/** Not in B1: domain-event emission needs the L3 effects pipeline. */
export function emit(c: HandlerContext, ..._args: unknown[]): never {
  void c;
  return unsupported('emit', 'domain-event emission needs the L3 effects pipeline.');
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
export { require, hasRole } from '@canlang/state/effects/guards';

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
