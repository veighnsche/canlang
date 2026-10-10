/** Private framework bridge. Only actual State invoke can open a lifetime.
 * Generated source receives only observer/selection/call facades, never this constructor.
 */
import type { CanValue, InvocationRef, ModelName, ScenarioReceiptIntrinsicDependency, ScenarioReceiptQueryPlan, ScenarioResultDisclosurePlan, ProjectedRecord, StoragePort, StoredRow } from '@canlang/contracts';
import type { AdmittedCall } from '@canlang/state/invocation';
import { observeScenarioReceiptDependency as observeStateDependency,
  observeScenarioReceiptIntrinsic as observeStateIntrinsic,
  selectScenarioReceiptReturn as selectStateReturn,
  executeScenarioReceiptQuery as executeStateQuery,
  observeScenarioReceiptQueryDependency as observeStateQueryDependency,
  bindScenarioReceiptQueryResult as bindStateQueryResult,
  assertScenarioReceiptCallExecution, stableStringify } from '@canlang/state/invocation';
import { isGeneratedOperationDef, type GeneratedOperationDef } from '@canlang/state/invocation/registry';
import { StateError } from '@canlang/state/errors';
import type { HandlerContext } from './context.js';
import { encodeValue } from '@canlang/values';
import { bindNativeScenarioReceiptRow, captureNativeScenarioReceiptRow,
  bindNativeScenarioReceiptReference, captureNativeScenarioReceiptReference, nativeRecordReference } from './native-records.js';

interface NativeQueryProducer {
  readonly record: (model: string, record: ProjectedRecord, read: (field: string) => void, current: () => ProjectedRecord) => Readonly<Record<string, unknown>>;
  readonly encode: (value: unknown) => unknown;
}
interface NativeQueryExecution {
  readonly plan: ScenarioReceiptQueryPlan;
  result?: { readonly rows: readonly { readonly slot: object; readonly record: ProjectedRecord }[] };
  receiptResult?: Awaited<ReturnType<typeof executeStateQuery>>;
  active: object | null;
  bound: boolean;
}
interface NativeQueryView {
  readonly query: NativeQueryExecution;
  readonly slot: object;
  readonly dependencies: Set<string>;
  readonly reads: string[];
}
interface QueryFrame {
  readonly failure: (error: unknown) => void;
  readonly queryProducer?: NativeQueryProducer;
  readonly queryViews: WeakMap<object, NativeQueryView>;
  readonly queryArrays: WeakMap<object, { readonly query: NativeQueryExecution; readonly views: readonly object[] }>;
  readonly queryResults: WeakMap<object, () => unknown>;
  active: boolean;
  pending: number;
  failed: boolean;
  error: unknown;
}
interface Frame extends QueryFrame {
  readonly kind: 'receipt';
  readonly call: AdmittedCall;
  readonly store: StoragePort;
  readonly owner: object;
  readonly intrinsics: ReadonlyMap<string, ScenarioReceiptIntrinsicDependency>;
  readonly invokeCall?: (site: string, target: string | InvocationRef, inputs: Readonly<Record<string, unknown>>) => Promise<unknown>;
}
interface PublicReadFrame extends QueryFrame {
  readonly kind: 'read';
  readonly plan: ScenarioResultDisclosurePlan;
  readonly queries: Set<string>;
  readonly execute: (plan: ScenarioReceiptQueryPlan, predicate: (record: ProjectedRecord) => Promise<boolean>) => Promise<readonly ProjectedRecord[]>;
  readonly project: (queryId: string, returnId: string, selected: readonly ProjectedRecord[]) => unknown;
  boundReturn: { readonly id: string; readonly value: object } | null;
  selectedReturn: string | null;
}
const frames = new WeakMap<HandlerContext, Frame>();
const readFrames = new WeakMap<HandlerContext, PublicReadFrame>();
const framedCalls = new WeakSet<AdmittedCall>();
function refuse(text: string): never { throw new StateError('validation', text); }
function fail(frame: QueryFrame, error: unknown): never {
  // Marker failures are terminal for this exact attempt. Attribution alone
  // cannot prevent a handler catching an error and returning success later.
  if (!frame.failed) {
    frame.failed = true;
    frame.error = error;
    frame.failure(error);
  }
  throw frame.error;
}
function checkedQuery(c: HandlerContext): Frame | PublicReadFrame {
  if (frames.has(c)) return checked(c);
  const frame = readFrames.get(c);
  if (frame === undefined) return refuse('Query helper requires its active framework context.');
  if (frame.failed) throw frame.error;
  if (!frame.active) return fail(frame, new StateError('validation', 'Query helper requires its active framework context.'));
  return frame;
}
function resultPlan(frame: Frame | PublicReadFrame): ScenarioResultDisclosurePlan | undefined {
  return frame.kind === 'read' ? frame.plan : isGeneratedOperationDef(frame.call.def)
    ? frame.call.def.descriptor.result?.disclosure : undefined;
}

/** The actual admitted public read callback issues this separate lifetime.
 * It contains no mutation call, receipt store, owner session or authority token. */
export function openReadScenarioQueryFrame(c: HandlerContext, def: GeneratedOperationDef,
  producer: NativeQueryProducer, execute: PublicReadFrame['execute'], project: PublicReadFrame['project'],
  failure: (error: unknown) => void): { result(value: unknown): unknown; assertCompleted(): void; close(): void } {
  const plan = def.descriptor.result?.disclosure;
  if (!isGeneratedOperationDef(def) || def.kind !== 'read' || plan === undefined ||
      (plan.queries?.length ?? 0) === 0 || plan.returns.length === 0 || plan.returns.some(returned =>
        returned.projection?.kind !== 'query-contract-array' || returned.dependencies.length !== 0 ||
        (returned.intrinsics?.length ?? 0) !== 0) || frames.has(c) || readFrames.has(c)) {
    return refuse('Public query requires its actual checked read projection and fresh context.');
  }
  const frame: PublicReadFrame = { kind: 'read', plan, failure, queryProducer: producer, execute, project,
    queryViews: new WeakMap(), queryArrays: new WeakMap(), queryResults: new WeakMap(), queries: new Set(),
    boundReturn: null, selectedReturn: null, active: true, pending: 0, failed: false, error: undefined };
  readFrames.set(c, frame);
  return Object.freeze({
    assertCompleted() {
      checkedQuery(c);
      if (frame.pending !== 0) return fail(frame, new StateError('validation', 'Public query observations must be awaited before completion.'));
    },
    result(value: unknown) {
      checkedQuery(c);
      try {
        if (frame.pending !== 0 || frame.boundReturn === null || frame.selectedReturn !== frame.boundReturn.id ||
            value !== frame.boundReturn.value) return refuse('Public query return requires its exact evaluated and selected result.');
        return frame.queryResults.get(frame.boundReturn.value)!();
      } catch (error) { return fail(frame, error); }
    },
    close() { frame.active = false; },
  });
}
function checked(c: HandlerContext): Frame {
  // No context property is read. An unbound/foreign context cannot identify
  // an intended caller frame, and must never poison an unrelated attempt.
  const frame = frames.get(c);
  if (frame === undefined) return refuse('Scenario receipt helper requires its active framework context.');
  if (frame.failed) throw frame.error;
  if (!frame.active) return fail(frame, new StateError('validation', 'Scenario receipt helper requires its active framework context.'));
  try { assertScenarioReceiptCallExecution(frame.call, frame.store); }
  catch (error) { return fail(frame, error); }
  return frame;
}
export interface ScenarioReceiptFrame {
  bind(view: object, model: string, current: () => StoredRow | null | undefined): void;
  bindAdmittedReference(view: object, reference: object): void;
  prepareReference(view: unknown, model: string): { readonly id: string; readonly version: string };
  queryResult(value: unknown): { readonly wire: unknown } | undefined;
  assertCompleted(): void;
  close(): void;
}
/** Called inside the actual mutation execute callback, with its registered
 * receiptStore. Neither c.store nor a staged overlay can substitute for it.
 */
export function openScenarioReceiptFrame(c: HandlerContext, call: AdmittedCall,
  store: StoragePort, failure: (error: unknown) => void,
  invokeCall?: (site: string, target: string | InvocationRef, inputs: Readonly<Record<string, unknown>>) => Promise<unknown>,
  queryProducer?: NativeQueryProducer): ScenarioReceiptFrame {
  assertScenarioReceiptCallExecution(call, store);
  if (frames.has(c) || readFrames.has(c) || framedCalls.has(call)) return refuse('Scenario receipt context or admitted attempt cannot be rebound.');
  const intrinsics = new Map(isGeneratedOperationDef(call.def)
    ? call.def.descriptor.result?.disclosure?.returns.flatMap(entry =>
      (entry.intrinsics ?? []).map(dependency => [dependency.id, dependency] as const)) : []);
  const frame: Frame = { kind: 'receipt', call, store, failure, intrinsics, ...(invokeCall === undefined ? {} : { invokeCall }),
    ...(queryProducer === undefined ? {} : { queryProducer }), queryViews: new WeakMap(), queryArrays: new WeakMap(), queryResults: new WeakMap(),
    owner: Object.freeze({}), active: true, pending: 0, failed: false, error: undefined };
  frames.set(c, frame);
  framedCalls.add(call);
  return Object.freeze({
    prepareReference(view: unknown, model: string) {
      // Trusted host preparation runs after State suspends this parent and
      // before child admission. This private frame pointer, never source c,
      // owns authority here; checked(c) would incorrectly require current execution.
      if (frame.failed) throw frame.error;
      if (!frame.active) return fail(frame, new StateError('validation', 'Scenario receipt helper requires its active framework context.'));
      try {
        const row = captureNativeScenarioReceiptRow(view, frame.owner, model);
        return Object.freeze({ id: row.id, version: String(row.version) });
      } catch (error) { return fail(frame, error); }
    },
    bind(view: object, model: string, current: () => StoredRow | null | undefined) {
      checked(c);
      try { bindNativeScenarioReceiptRow(view, frame.owner, model, current); }
      catch (error) { fail(frame, error); }
    },
    bindAdmittedReference(view: object, reference: object) {
      checked(c);
      try {
        const original = call.recordRefs.find(candidate => candidate === reference);
        if (original === undefined) return refuse('Scenario intrinsic requires the exact original admitted slot.');
        bindNativeScenarioReceiptReference(view, frame.owner, original);
      } catch (error) { fail(frame, error); }
    },
    queryResult(value: unknown) {
      checked(c);
      const encode = typeof value === 'object' && value !== null ? frame.queryResults.get(value) : undefined;
      if (encode === undefined) return undefined;
      try { return { wire: encode() }; }
      catch (error) { return fail(frame, error); }
    },
    assertCompleted() {
      checked(c);
      if (frame.pending !== 0) return fail(frame, new StateError('validation', 'Scenario dependency observations must be awaited before completion.'));
    },
    close() { frame.active = false; },
  });
}

/** Generated code receives only this facade. Its literal callback is installed
 * by the trusted loader and stages through the existing enclosing State owner.
 */
export function invokeScenarioReceiptCall(c: HandlerContext, site: string,
  target: string | InvocationRef, inputs: Readonly<Record<string, unknown>>): Promise<unknown> {
  const operation = (async () => {
    const frame = checked(c);
    if (frame.pending !== 0) return fail(frame, new StateError('validation', 'Scenario calls and observations must run sequentially.'));
    frame.pending += 1;
    try {
      if (frame.invokeCall === undefined) return refuse('Scenario call requires its installed framework callback.');
      const result = await frame.invokeCall(site, target, inputs);
      checked(c);
      return result;
    } catch (error) { fail(frame, error); }
    finally { frame.pending -= 1; }
  })();
  void operation.catch(() => {});
  return operation;
}

/** Compiler marker awaits this after its actual native field evaluation. The
 * bridge snapshots protected wire data once; it never rereads nativeRow[field].
 */
export function observeScenarioReceiptDependency(c: HandlerContext, model: string,
  nativeRow: unknown, field: string, dependencyId: string): Promise<void> {
  const operation = (async () => {
    const frame = checked(c);
    if (frame.pending !== 0) return fail(frame, new StateError('validation', 'Scenario dependency observations must run sequentially.'));
    frame.pending += 1;
    try {
      const row = captureNativeScenarioReceiptRow(nativeRow, frame.owner, model);
      await observeStateDependency(frame.call, frame.store,
        { dependencyId, model: model as ModelName, row, field });
      checked(c);
    } catch (error) { fail(frame, error); }
    finally { frame.pending -= 1; }
  })();
  // Keep rejection visible to awaiting callers while owning detached failure
  // handling. Completion refuses pending/failed work even if source catches
  // or neglects to await a generated marker.
  void operation.catch(() => {});
  return operation;
}

/** Checked code evaluates the original expression once before awaiting this
 * facade. Native source correspondence is owned by Compiler, while this host
 * supplies its actual Values wire and private original parameter binding.
 */
export function observeScenarioReceiptIntrinsic(c: HandlerContext, dependencyId: string,
  kind: ScenarioReceiptIntrinsicDependency['kind'], evaluated: unknown, nativeReference?: unknown): Promise<void> {
  const operation = (async () => {
    const frame = checked(c);
    if (frame.pending !== 0) return fail(frame, new StateError('validation', 'Scenario dependency observations must run sequentially.'));
    frame.pending += 1;
    try {
      const dependency = frame.intrinsics.get(dependencyId);
      if (dependency === undefined || dependency.kind !== kind) return refuse('Scenario intrinsic disagrees with its checked dependency.');
      let wire: unknown;
      try { wire = encodeValue(dependency.type, evaluated as CanValue); }
      catch { return refuse('Scenario intrinsic requires its actual typed native value.'); }
      if (dependency.kind === 'admitted-reference-version') {
        const reference = captureNativeScenarioReceiptReference(nativeReference, frame.owner, dependency.parameter);
        if (reference.model !== dependency.model || evaluated !== BigInt(reference.row.version) || typeof wire !== 'string') {
          return refuse('Scenario intrinsic version differs from its original admitted native binding.');
        }
        await observeStateIntrinsic(frame.call, frame.store, { dependencyId, kind: dependency.kind, wire, reference });
      } else if (dependency.kind === 'operation-id') {
        if (typeof wire !== 'string' || evaluated !== frame.call.context.operationId) {
          return refuse('Scenario intrinsic identity differs from its admitted framework context.');
        }
        await observeStateIntrinsic(frame.call, frame.store, { dependencyId, kind: dependency.kind, wire });
      } else {
        await observeStateIntrinsic(frame.call, frame.store, { dependencyId, kind: dependency.kind, wire });
      }
      checked(c);
    } catch (error) { fail(frame, error); }
    finally { frame.pending -= 1; }
  })();
  void operation.catch(() => {});
  return operation;
}


/** One checked source occurrence enters State's complete current-policy domain.
 * Only native views escape; actual query handles and candidate slots stay private. */
export function executeScenarioReceiptQuery(c: HandlerContext, queryId: string,
  predicate: (record: Readonly<Record<string, unknown>>) => boolean | Promise<boolean>): Promise<readonly Readonly<Record<string, unknown>>[]> {
  const operation = (async () => {
    const frame = checkedQuery(c);
    if (frame.pending !== 0) return fail(frame, new StateError('validation', 'Scenario queries must run sequentially.'));
    frame.pending += 1;
    try {
      const plan = resultPlan(frame)?.queries?.find(query => query.id === queryId);
      if (plan === undefined || frame.queryProducer === undefined || typeof predicate !== 'function') {
        return refuse('Scenario query requires its checked occurrence and installed native producer.');
      }
      if (frame.kind === 'read') {
        if (frame.selectedReturn !== null || frame.queries.has(queryId)) return refuse('Public query requires one execution of its checked occurrence before return.');
        frame.queries.add(queryId);
      }
      const query: NativeQueryExecution = { plan, active: null, bound: false };
      const issued = new Map<object, { readonly view: Readonly<Record<string, unknown>>; readonly select: (record: ProjectedRecord) => void }>();
      const candidate = async ({ slot, record }: { readonly slot: object; readonly record: ProjectedRecord }): Promise<boolean> => {
        checkedQuery(c);
        const reads: string[] = [];
        let projected = record;
        const view = frame.queryProducer!.record(plan.model, record, field => {
          try {
            checkedQuery(c);
            if (query.bound || !plan.dependencies.some(dep => dep.field === field) ||
                (query.active !== view && (frame.pending !== 0 || query.result === undefined ||
                  !query.result.rows.some(row => row.slot === slot)))) {
              return refuse('Query field read requires its checked live candidate or original selected projection.');
            }
            if (frame.kind === 'read' && reads.length !== 0) return refuse('Public query field requires its immediate source marker before another read.');
            reads.push(field);
          } catch (error) { fail(frame, error); }
        }, () => projected);
        const reference = nativeRecordReference(view);
        if (!Object.isFrozen(view) || reference?.model !== plan.model || reference.id !== record.id ||
            reference.version !== BigInt(record.version) || frame.queryViews.has(view)) {
          return refuse('Query view requires its original native projected identity.');
        }
        frame.queryViews.set(view, { query, slot, dependencies: new Set(), reads });
        issued.set(slot, { view, select: record => { projected = record; } }); query.active = view;
        try {
          const accepted = await predicate(view);
          checkedQuery(c);
          if (typeof accepted !== 'boolean') return refuse('Query predicate requires its actual boolean.');
          if (reads.length !== 0) return refuse('Query predicate omitted an actual field read marker.');
          return accepted;
        } finally { query.active = null; }
      };
      let result: NonNullable<NativeQueryExecution['result']>;
      if (frame.kind === 'receipt') {
        const receiptResult = await executeStateQuery(frame.call, frame.store, { queryId, predicate: candidate });
        query.receiptResult = receiptResult; result = receiptResult;
      } else {
        // State's viewer predicate and served selection are distinct projected
        // carriers. Match their exact identity/version/data, retaining the
        // original privately issued candidate slot and selected engine order.
        const candidates = new Map<string, { readonly slot: object; readonly record: ProjectedRecord; readonly matched: boolean }>();
        const records = await frame.execute(plan, async record => {
          if (candidates.has(record.id)) return refuse('Public query candidate identity must be unique.');
          const slot = Object.freeze({});
          const matched = await candidate({ slot, record });
          candidates.set(record.id, { slot, record, matched });
          return matched;
        });
        const selected = new Set<string>();
        result = { rows: records.map(record => {
          const original = candidates.get(record.id);
          if (original === undefined || !original.matched || selected.has(record.id) ||
              stableStringify(original.record) !== stableStringify(record)) {
            return refuse('Public query selection lost its actual projected candidate correspondence.');
          }
          selected.add(record.id);
          return Object.freeze({ slot: original.slot, record });
        }) };
      }
      checkedQuery(c); query.result = result;
      const views = Object.freeze(result.rows.map(({ slot, record }) => {
        const selected = issued.get(slot);
        if (selected === undefined) return refuse('Query selection lost its original native candidate.');
        selected.select(record);
        return selected.view;
      }));
      frame.queryArrays.set(views, { query, views });
      return views;
    } catch (error) { return fail(frame, error); }
    finally { frame.pending -= 1; }
  })();
  void operation.catch(() => {});
  return operation;
}

/** Immediate compiled field marker. Predicate observations use the live State
 * slot; projection reads retain that same slot until exact result binding. */
export function observeScenarioReceiptQueryDependency(c: HandlerContext, model: string,
  nativeRow: unknown, field: string, dependencyId: string): void {
  const frame = checkedQuery(c);
  try {
    const view = typeof nativeRow === 'object' && nativeRow !== null ? frame.queryViews.get(nativeRow) : undefined;
    const dependency = view?.query.plan.dependencies.find(entry => entry.id === dependencyId);
    if (view === undefined || dependency === undefined || view.query.plan.model !== model || dependency.field !== field || view.query.bound || view.reads[0] !== field) {
      return refuse('Query observation requires its original native candidate and checked field.');
    }
    if (view.query.active === nativeRow) {
      if (frame.pending !== 1 || dependency.role !== 'control') return refuse('Query predicate observation crossed its sequential source execution.');
      if (frame.kind === 'receipt') observeStateQueryDependency(frame.call, frame.store, { slot: view.slot, dependencyId });
    } else {
      if (frame.pending !== 0 || dependency.role !== 'data' || view.query.result === undefined ||
          !view.query.result.rows.some(row => row.slot === view.slot)) {
        return refuse('Query projection observation requires its original selected candidate.');
      }
    }
    view.reads.shift();
    view.dependencies.add(dependencyId);
  } catch (error) { fail(frame, error); }
}

/** Bind the authored nominal array, including empty, to the exact ordered query
 * array. Values/State verify wire; source never receives or supplies slot IDs. */
export function bindScenarioReceiptQueryResult(c: HandlerContext, returnId: string,
  nativeRows: unknown, value: unknown): void {
  const frame = checkedQuery(c);
  try {
    if (frame.pending !== 0 || frame.queryProducer === undefined) return refuse('Query result requires completed native execution.');
    const issued = typeof nativeRows === 'object' && nativeRows !== null ? frame.queryArrays.get(nativeRows) : undefined;
    const result = issued?.query.result;
    const returned = resultPlan(frame)?.returns.find(entry => entry.id === returnId);
    if (issued === undefined || result === undefined || issued.query.bound || returned?.projection?.queryId !== issued.query.plan.id ||
        (frame.kind === 'read' && (frame.boundReturn !== null || frame.selectedReturn !== null))) {
      return refuse('Query result requires its exact original array and checked return.');
    }
    for (const view of issued.views) {
      const binding = frame.queryViews.get(view)!;
      if (binding.reads.length !== 0 || issued.query.plan.dependencies.some(dep => dep.role === 'data' && !binding.dependencies.has(dep.id))) {
        return refuse('Query result omitted an actual selected field observation.');
      }
    }
    // Preserve evaluated fields; only native record identities need their owning
    // Values carrier before nominal encoding. Never read a candidate field again.
    if (!Array.isArray(value) || value.length !== issued.views.length) return refuse('Query result requires the complete authored nominal array.');
    const encode = () => {
      if (Reflect.ownKeys(value).length !== value.length + 1) return refuse('Query result requires a dense native array.');
      const native = Array.from({ length: value.length }, (_, index) => {
        const element = Object.getOwnPropertyDescriptor(value, String(index));
        if (element === undefined || !('value' in element)) return refuse('Query result requires own evaluated array elements.');
        const fact: unknown = element.value;
        if (typeof fact !== 'object' || fact === null || Array.isArray(fact)) return refuse('Query result requires authored contract values.');
        const fields: Record<string, unknown> = Object.create(null);
        for (const key of Reflect.ownKeys(fact)) {
          const descriptor = Object.getOwnPropertyDescriptor(fact, key)!;
          if (typeof key !== 'string' || !('value' in descriptor)) return refuse('Query result requires own evaluated contract fields.');
          fields[key] = descriptor.value as unknown;
        }
        for (const field of returned.projection!.fields) if (field.kind === 'reference') {
          const reference = nativeRecordReference(fields[field.name]);
          if (reference === undefined || fields[field.name] !== issued.views[index]) return refuse('Query Fact reference differs from its original selected view.');
          fields[field.name] = reference;
        }
        return fields;
      });
      return frame.queryProducer!.encode(native);
    };
    const wire = encode();
    if (frame.kind === 'receipt') {
      const receiptResult = issued.query.receiptResult!;
      bindStateQueryResult(frame.call, frame.store, { query: receiptResult.query, returnId, wire, rows: receiptResult.rows.map(row => row.slot) });
    } else {
      const expected = frame.project(issued.query.plan.id, returnId, result.rows.map(row => row.record));
      if (stableStringify(wire) !== stableStringify(expected)) return refuse('Public query result differs from its exact evaluated projection.');
      frame.boundReturn = { id: returnId, value };
    }
    issued.query.bound = true;
    const originalWire = stableStringify(wire);
    frame.queryResults.set(value, () => {
      const current = encode();
      if (stableStringify(current) !== originalWire) return refuse('Query result changed after its exact evaluated binding.');
      return current;
    });
  } catch (error) { fail(frame, error); }
}

/** Compiler selects only the actually evaluated return after its observations. */
export function selectScenarioReceiptReturn(c: HandlerContext, returnId: string): void {
  const frame = checkedQuery(c);
  try {
    if (frame.pending !== 0) return fail(frame, new StateError('validation', 'Scenario observations must complete before return selection.'));
    if (frame.kind === 'receipt') selectStateReturn(frame.call, frame.store, returnId);
    else {
      if (frame.selectedReturn !== null || frame.boundReturn?.id !== returnId) return refuse('Public query return requires its completed exact binding.');
      frame.selectedReturn = returnId;
    }
  } catch (error) { fail(frame, error); }
}
