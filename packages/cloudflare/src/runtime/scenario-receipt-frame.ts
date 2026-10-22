/** Private framework bridge. Only actual State invoke can open a lifetime.
 * Generated source receives only observer/selection/call facades, never this constructor.
 */
import type { CanTypeId, CanValue, FinalizedFileObservation, InvocationRef, ModelName, ScenarioReceiptIntrinsicDependency, ScenarioReceiptQueryPlan, ScenarioResultDisclosurePlan, ProjectedRecord, StoragePort, StoredRow } from '@canlang/contracts';
import type { AdmittedCall, ScenarioReceiptAnyPredicate, ScenarioReceiptSendGuard } from '@canlang/state/invocation';
import { executeScenarioReceiptAny as executeStateAny } from '@canlang/state';
import { executeScenarioReceiptPurchaseAll as executeStatePurchaseAll,
  observeScenarioReceiptDependency as observeStateDependency,
  observeScenarioReceiptIntrinsic as observeStateIntrinsic,
  selectScenarioReceiptReturn as selectStateReturn,
  executeScenarioReceiptQuery as executeStateQuery,
  selectScenarioReceiptQueryFirstRow as selectStateQueryFirstRow,
  readScenarioReceiptQueryParentRow as readStateQueryParentRow,
  bindScenarioReceiptQueryCount as bindStateQueryCount,
  observeScenarioReceiptQueryDependency as observeStateQueryDependency,
  bindScenarioReceiptQueryResult as bindStateQueryResult,
  bindScenarioReceiptQuerySelection as bindStateQuerySelection,
  bindScenarioReceiptModelResult as bindStateModelResult,
  assertScenarioReceiptCallExecution, stableStringify } from '@canlang/state/invocation';
import { isGeneratedOperationDef, type GeneratedOperationDef } from '@canlang/state/invocation/registry';
import { StateError } from '@canlang/state/errors';
import type { HandlerContext } from './context.js';
import { encodeValue, parseTypeId } from '@canlang/values';
import { bindNativeScenarioReceiptRow, captureNativeScenarioReceiptRow,
  bindNativeScenarioReceiptReference, captureNativeScenarioReceiptReference, nativeRecordReference } from './native-records.js';

type QuerySelectionMetadata = NonNullable<Parameters<typeof import('@canlang/state/invocation').bindScenarioReceiptQueryProducer>[1]['selections']>[number];
interface NativeQueryProducer {
  /** The verified module recognizes this exact source closure and native c. */
  readonly authenticateAnyPredicate?: (queryId: string, predicate: Function) => boolean;
  readonly record: (model: string, record: ProjectedRecord, read: (field: string) => void, current: () => ProjectedRecord) => Readonly<Record<string, unknown>>;
  readonly encode: (value: unknown) => unknown;
  readonly selections?: readonly QuerySelectionMetadata[];
  readonly encodeSelection?: (type: CanTypeId, value: unknown) => unknown;
  readonly observeSelectionFiles?: (input: { readonly dependencyId: string; readonly model: string;
    readonly field: string; readonly wire: unknown }, healthy: () => void) => Promise<readonly FinalizedFileObservation[]>;
  /** Trusted receipt host binds only State's genuine selected owner row. */
  readonly mutableRecord?: (model: string, row: StoredRow, mode?: 'query-parent') => Record<string, unknown> | Promise<Record<string, unknown>>;
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
export type ScenarioReceiptDependencyObserver = (input: {
  readonly dependencyId: string; readonly model: string; readonly row: StoredRow; readonly field: string;
}, healthy: () => void) => Promise<readonly FinalizedFileObservation[] | undefined>;
/** Private host promotion of the original checked stored-reference occurrence. */
export type ScenarioReceiptStoredReferencePromotion = (reference: unknown, sourceDependencyId: string,
  scalarLeafDependencyId: string, healthy: () => void,
  captureSource: (view: object, model: string, field: string, wire: unknown) => StoredRow) => Promise<Record<string, unknown>>;
/** Separate nullable source bridge; the original getter view survives even for null. */
export type ScenarioReceiptNullableStoredReferencePromotion = (sourceView: object, reference: unknown,
  sourceDependencyId: string, scalarLeafDependencyId: string, healthy: () => void,
  captureSource: (view: object, model: string, field: string, wire: unknown) => StoredRow) => Promise<Record<string, unknown> | null>;
interface NullableStoredReferenceGetter {
  readonly sourceView: object;
  readonly model: string;
  readonly field: string;
  readonly row: StoredRow;
  readonly wire: unknown;
  readonly evaluated: unknown;
  markedDependencyId?: string;
  completedSourceControlId?: string;
  narrowedDataDependencyId?: string;
  consumed: boolean;
}
interface Frame extends QueryFrame {
  readonly kind: 'receipt';
  capturedAny: { readonly queryId: string; readonly predicate: ScenarioReceiptAnyPredicate } | null;
  readonly selectionChecks: Array<() => void>;
  readonly promoteStoredReference?: ScenarioReceiptStoredReferencePromotion;
  readonly promoteNullableStoredReference?: ScenarioReceiptNullableStoredReferencePromotion;
  readonly nullableStoredReferenceGetters: WeakMap<object, Map<string, NullableStoredReferenceGetter>>;
  activeQueryCandidate: object | null;
  readonly queryParents: WeakMap<object, { readonly candidate: object; readonly view: NativeQueryView;
    readonly model: string; readonly dependencyId: string }>;
  readonly observeDependency?: ScenarioReceiptDependencyObserver;
  readonly call: AdmittedCall;
  readonly store: StoragePort;
  readonly owner: object;
  readonly intrinsics: ReadonlyMap<string, ScenarioReceiptIntrinsicDependency>;
  readonly eventSource?: ScenarioReceiptSendGuard['eventSource'];
  readonly sourceViews: WeakMap<object, object>;
  readonly observedFields: WeakMap<object, Map<string, { readonly model: string; readonly wire: unknown; readonly dependencyId: string;
    readonly nullableGetter?: NullableStoredReferenceGetter }>>;
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
  captureAnyPredicate(queryId: string): ScenarioReceiptAnyPredicate;
  bind(view: object, model: string, current: () => StoredRow | null | undefined): void;
  bindNullableStoredReferenceGetter(view: object, model: string, field: string, row: StoredRow,
    wire: unknown, evaluated: unknown): void;
  bindNavigationReference(reference: object, view: object, model: string): void;
  bindAdmittedReference(view: object, reference: object): void;
  prepareReference(view: unknown, model: string): { readonly id: string; readonly version: string };
  assertObservedReference(view: object, model: string, field: string, wire: unknown): void;
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
  queryProducer?: NativeQueryProducer, observeDependency?: ScenarioReceiptDependencyObserver,
  promoteStoredReference?: ScenarioReceiptStoredReferencePromotion,
  promoteNullableStoredReference?: ScenarioReceiptNullableStoredReferencePromotion,
  eventSource?: ScenarioReceiptSendGuard['eventSource']): ScenarioReceiptFrame {
  assertScenarioReceiptCallExecution(call, store);
  if (frames.has(c) || readFrames.has(c) || framedCalls.has(call)) return refuse('Scenario receipt context or admitted attempt cannot be rebound.');
  const intrinsics = new Map(isGeneratedOperationDef(call.def)
    ? call.def.descriptor.result?.disclosure?.returns.flatMap(entry =>
      (entry.intrinsics ?? []).map(dependency => [dependency.id, dependency] as const)) : []);
  const frame: Frame = { kind: 'receipt', call, store, failure, intrinsics, selectionChecks: [], capturedAny: null,
    ...(eventSource === undefined ? {} : { eventSource }),
    ...(promoteStoredReference === undefined ? {} : { promoteStoredReference }),
    ...(promoteNullableStoredReference === undefined ? {} : { promoteNullableStoredReference }),
    nullableStoredReferenceGetters: new WeakMap(),
    ...(observeDependency === undefined ? {} : { observeDependency }), ...(invokeCall === undefined ? {} : { invokeCall }),
    ...(queryProducer === undefined ? {} : { queryProducer }), queryViews: new WeakMap(), queryArrays: new WeakMap(), queryResults: new WeakMap(),
    owner: Object.freeze({}), activeQueryCandidate: null, queryParents: new WeakMap(), sourceViews: new WeakMap(), observedFields: new WeakMap(), active: true, pending: 0, failed: false, error: undefined };
  frames.set(c, frame);
  framedCalls.add(call);
  return Object.freeze({
    captureAnyPredicate(queryId: string) {
      checked(c);
      try {
        const captured = frame.capturedAny;
        if (frame.pending !== 1 || captured === null || captured.queryId !== queryId) {
          return refuse('Predicate ANY requires its once-only active native source capture.');
        }
        frame.capturedAny = null;
        return captured.predicate;
      } catch (error) { return fail(frame, error); }
    },
    bindNullableStoredReferenceGetter(view: object, model: string, field: string, row: StoredRow,
      wire: unknown, evaluated: unknown) {
      // Recording an actual host getter grants no authority. Its successful
      // State marker and subsequent bridge must join this exact event later.
      if (frame.failed) throw frame.error;
      if (!frame.active) return fail(frame, new StateError('validation', 'Nullable getter requires its active native frame.'));
      try {
        const sourceView = frame.sourceViews.get(view) ?? view;
        if (captureNativeScenarioReceiptRow(sourceView, frame.owner, model) !== row ||
            !Object.hasOwn(row.data, field) || row.data[field] !== wire) {
          return refuse('Nullable getter requires its original current owner row and declared wire.');
        }
        let fields = frame.nullableStoredReferenceGetters.get(sourceView);
        if (fields === undefined) { fields = new Map(); frame.nullableStoredReferenceGetters.set(sourceView, fields); }
        fields.set(field, { sourceView, model, field, row, wire, evaluated, consumed: false });
      } catch (error) { return fail(frame, error); }
    },
    assertObservedReference(view: object, model: string, field: string, wire: unknown) {
      checked(c);
      const observed = frame.observedFields.get(frame.sourceViews.get(view) ?? view)?.get(field);
      if (observed?.model !== model || stableStringify(observed.wire) !== stableStringify(wire)) {
        return fail(frame, new StateError('validation', 'Stored reference requires its successful original source-field observation.'));
      }
    },
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
    bindNavigationReference(reference: object, view: object, model: string) {
      checked(c);
      try {
        // Only successful lazy navigation supplies its genuine underlying
        // receipt-bound view. A public identity alone cannot issue this alias.
        const original = captureNativeScenarioReceiptRow(view, frame.owner, model);
        const identity = nativeRecordReference(reference);
        if (identity?.model !== model || identity.id !== original.id || frame.sourceViews.has(reference)) {
          return refuse('Scenario navigation requires its exact resolved owner view.');
        }
        bindNativeScenarioReceiptRow(reference, frame.owner, model,
          () => captureNativeScenarioReceiptRow(view, frame.owner, model));
        frame.sourceViews.set(reference, view);
      } catch (error) { fail(frame, error); }
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
      if (frame.pending !== 0 || frame.capturedAny !== null) return fail(frame, new StateError('validation', 'Scenario dependency observations must be awaited before completion.'));
      try { for (const validate of frame.selectionChecks) validate(); }
      catch (error) { return fail(frame, error); }
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
    const sourceView = typeof nativeRow === 'object' && nativeRow !== null
      ? frame.sourceViews.get(nativeRow) ?? nativeRow : undefined;
    const nullableGetter = sourceView === undefined ? undefined : frame.nullableStoredReferenceGetters.get(sourceView)?.get(field);
    const parent = sourceView === undefined ? undefined : frame.queryParents.get(sourceView);
    const dependency = resultPlan(frame)?.returns.flatMap(entry => entry.dependencies)
      .find(entry => entry.id === dependencyId);
    // A supplied admitted parent is a different original occurrence from the
    // candidate-issued parent. Its checked query link alone selects the slot;
    // only this call's exact admitted row can use the nested observation port.
    const linkedCandidate = parent === undefined && dependency?.queryId !== undefined
      ? frame.activeQueryCandidate : null;
    const linkedView = linkedCandidate === null ? undefined : frame.queryViews.get(linkedCandidate);
    let nativeSourceRow: StoredRow | undefined;
    let admittedReference: AdmittedCall['recordRefs'][number] | undefined;
    const healthy = () => {
      checked(c);
      if (parent === undefined && dependency?.queryId !== undefined &&
          (linkedCandidate === null || linkedView === undefined || frame.activeQueryCandidate !== linkedCandidate ||
            linkedView.query.active !== linkedCandidate || linkedView.query.bound || linkedView.query.result !== undefined ||
            linkedView.reads.length !== 0 || frame.pending !== 2 || dependency.queryId !== linkedView.query.plan.id ||
            dependency.role !== 'control' || dependency.model !== model || dependency.field !== field || field !== 'parent' ||
            stableStringify(dependency.source) !== stableStringify(linkedView.query.plan.source))) {
        return refuse('Supplied parent observation requires its exact checked active query occurrence.');
      }
      if (nativeSourceRow !== undefined && captureNativeScenarioReceiptRow(nativeRow, frame.owner, model) !== nativeSourceRow) {
        return refuse('Supplied parent observation changed its original admitted native binding.');
      }
      if (admittedReference !== undefined && captureNativeScenarioReceiptReference(sourceView, frame.owner,
          admittedReference.param) !== admittedReference) {
        return refuse('Supplied parent observation changed its original parameter admission.');
      }
      if (parent !== undefined && (parent.view.query.active !== parent.candidate || parent.view.query.bound ||
          parent.view.reads.length !== 0 || frame.pending !== 2 || parent.model !== model || parent.dependencyId !== dependencyId || field !== 'parent')) {
        return refuse('Query parent observation crossed its original candidate and ordinary dependency.');
      }
    };
    if (frame.pending !== (parent === undefined && linkedView === undefined ? 0 : 1)) {
      return fail(frame, new StateError('validation', 'Scenario dependency observations must run sequentially.'));
    }
    frame.pending += 1;
    try {
      healthy();
      let row = captureNativeScenarioReceiptRow(nativeRow, frame.owner, model);
      // A later DATA occurrence may use the same once-evaluated Let after its
      // original CONTROL promotion has fully succeeded. State still validates
      // every required CONTROL, source row, owner stage and current authority.
      const retainedPromotionData = nullableGetter !== undefined && nullableGetter.consumed &&
        nullableGetter.markedDependencyId !== undefined &&
        nullableGetter.completedSourceControlId === nullableGetter.markedDependencyId &&
        nullableGetter.narrowedDataDependencyId === undefined &&
        dependency?.role === 'data' && dependency.model === model && dependency.field === field;
      if (nullableGetter !== undefined && (nullableGetter.model !== model || nullableGetter.field !== field ||
          nullableGetter.row !== row || !retainedPromotionData &&
          (nullableGetter.consumed || nullableGetter.markedDependencyId !== undefined))) {
        return refuse('Nullable source marker requires its original unmarked getter event.');
      }
      if (parent === undefined && dependency?.queryId !== undefined) {
        // Parameter admission and mutable owner reads deliberately have different
        // pointers. Only the existing private original-parameter binding joins
        // them; identity/version coincidence cannot substitute for that binding.
        admittedReference = frame.call.recordRefs.find(reference => {
          if (reference.model !== model || reference.id !== row.id) return false;
          try { return captureNativeScenarioReceiptReference(sourceView, frame.owner, reference.param) === reference; }
          catch { return false; }
        });
        if (admittedReference === undefined ||
            stableStringify(row.parent ?? null) !== stableStringify(admittedReference.row.parent ?? null)) {
          return refuse('Supplied query parent requires its original admitted parameter and evaluated parent.');
        }
        nativeSourceRow = row;
        // State receives its exact admission pointer and independently reloads
        // current owner lifetime, parent wire and complete source authority.
        row = admittedReference.row;
      }
      const files = frame.observeDependency === undefined ? undefined
        : await frame.observeDependency({ dependencyId, model, row, field }, healthy);
      healthy();
      await observeStateDependency(frame.call, frame.store,
        { dependencyId, model: model as ModelName, row, field, ...(files === undefined ? {} : { files }) });
      healthy();
      if (nullableGetter !== undefined) {
        if (frame.nullableStoredReferenceGetters.get(sourceView!)?.get(field) !== nullableGetter ||
            captureNativeScenarioReceiptRow(sourceView, frame.owner, model) !== nullableGetter.row) {
          return refuse('Nullable source getter changed during its original marker.');
        }
        if (retainedPromotionData) nullableGetter.narrowedDataDependencyId = dependencyId;
        else nullableGetter.markedDependencyId = dependencyId;
      }
      // This private cache records only actual successful State observation.
      // Native hydration must match the exact evaluated field's canonical wire;
      // owning grants, Identity, source lifetime and final guards stay in State.
      let fields = frame.observedFields.get(sourceView!);
      if (fields === undefined) { fields = new Map(); frame.observedFields.set(sourceView!, fields); }
      fields.set(field, Object.freeze({ model, dependencyId, ...(nullableGetter === undefined ? {} : { nullableGetter }), wire: field === 'parent'
        ? row.parent === null || row.parent === undefined ? null : { id: row.parent.id }
        : field === 'id' ? row.id : row.data[field] }));
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
        const parameter = dependency.parameter === 'eventTerm'
          ? frame.eventSource?.modelField.name ?? refuse('Event version requires its installed declared source field.')
          : dependency.parameter;
        const reference = captureNativeScenarioReceiptReference(nativeReference, frame.owner, parameter);
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

/** Resolve the actual active candidate's parent for its original ordinary
 * parent dependency. Generated source never receives State slots or raw rows. */
export function readScenarioReceiptQueryParent(c: HandlerContext, nativeCandidate: unknown,
  dependencyId: string): Promise<Record<string, unknown>> {
  const operation = (async () => {
    const frame = checked(c);
    if (frame.pending !== 1) return fail(frame, new StateError('validation', 'Query parent requires its sequential active predicate.'));
    frame.pending += 1;
    try {
      const view = typeof nativeCandidate === 'object' && nativeCandidate !== null
        ? frame.queryViews.get(nativeCandidate) : undefined;
      const dependency = resultPlan(frame)?.returns.flatMap(entry => entry.dependencies)
        .find(entry => entry.id === dependencyId && entry.field === 'parent');
      const healthy = () => {
        checked(c);
        if (view === undefined || dependency === undefined || view.query.active !== nativeCandidate || view.query.bound ||
            view.query.result !== undefined || view.reads.length !== 0 || frame.pending !== 2 ||
            !view.query.plan.dependencies.some(entry => entry.field === 'parent' && entry.role === 'control' &&
              entry.type === dependency.model && view.dependencies.has(entry.id))) {
          return refuse('Query parent requires its original active candidate and completed parent marker.');
        }
      };
      healthy();
      if (frame.queryProducer?.mutableRecord === undefined) return refuse('Query parent requires its owning native mutable binder.');
      const row = await readStateQueryParentRow(frame.call, frame.store, { slot: view!.slot, dependencyId });
      healthy();
      const model = dependency!.model;
      const parent = await frame.queryProducer.mutableRecord(model, row, 'query-parent');
      healthy();
      if (captureNativeScenarioReceiptRow(parent, frame.owner, model) !== row) {
        return refuse('Query parent binder lost its exact State-issued owning row.');
      }
      frame.queryParents.set(parent, { candidate: nativeCandidate as object, view: view!, model, dependencyId });
      return parent;
    } catch (error) { return fail(frame, error); }
    finally { frame.pending -= 1; }
  })();
  void operation.catch(() => {});
  return operation;
}

/** Compiler emits only its checked original required reference
 * occurrence; it then evaluates and observes the scalar separately. */
export function readScenarioReceiptStoredReference(c: HandlerContext, originalReference: unknown,
  sourceDependencyId: string, scalarLeafDependencyId: string): Promise<Record<string, unknown>> {
  const operation = (async () => {
    const frame = checked(c);
    if (frame.pending !== 0 || frame.activeQueryCandidate !== null) {
      return fail(frame, new StateError('validation', 'Stored reference promotion requires its sequential ordinary source occurrence.'));
    }
    frame.pending += 1;
    try {
      const returned = resultPlan(frame)?.returns.find(entry =>
        entry.dependencies.some(dep => dep.id === sourceDependencyId) &&
        entry.dependencies.some(dep => dep.id === scalarLeafDependencyId));
      const source = returned?.dependencies.find(dep => dep.id === sourceDependencyId);
      const leaf = returned?.dependencies.find(dep => dep.id === scalarLeafDependencyId);
      if (source === undefined || leaf === undefined || source.id === leaf.id || source.type !== leaf.model ||
          source.queryId !== undefined || leaf.queryId !== undefined ||
          stableStringify(source.source) !== stableStringify(leaf.source) ||
          stableStringify(source.source) !== stableStringify(resultPlan(frame)!.source) ||
          frame.promoteStoredReference === undefined) {
        return refuse('Stored reference promotion requires its checked reference/scalar pair and installed private producer.');
      }
      const healthy = () => {
        checked(c);
        if (frame.pending !== 1 || frame.activeQueryCandidate !== null) {
          return refuse('Stored reference promotion crossed its original ordinary execution.');
        }
      };
      let sourceView: object | undefined, originalSource: StoredRow | undefined;
      const captureSource = (view: object, model: string, field: string, wire: unknown): StoredRow => {
        healthy();
        if (model !== source.model || field !== source.field) return refuse('Stored reference origin differs from its checked source field.');
        const observed = frame.observedFields.get(frame.sourceViews.get(view) ?? view)?.get(field);
        if (observed?.dependencyId !== source.id || observed.model !== model || stableStringify(observed.wire) !== stableStringify(wire)) {
          return refuse('Stored reference promotion requires its successful original field observation.');
        }
        // The original getter may belong to an admitted input or another
        // genuine owner-issued row, including the completed first selection.
        // State still joins this exact row to its observed source and stage.
        const row = captureNativeScenarioReceiptRow(view, frame.owner, model);
        if (sourceView !== undefined && (sourceView !== view || originalSource !== row)) {
          return refuse('Stored reference source changed during promotion.');
        }
        sourceView = view; originalSource = row; return row;
      };
      const value = await frame.promoteStoredReference(originalReference, source.id, leaf.id, healthy, captureSource);
      healthy();
      if (sourceView === undefined || originalSource === undefined ||
          captureNativeScenarioReceiptRow(sourceView, frame.owner, source.model) !== originalSource) {
        return refuse('Stored reference promotion lost its original current source binding.');
      }
      captureNativeScenarioReceiptRow(value, frame.owner, leaf.model);
      return value;
    } catch (error) { return fail(frame, error); }
    finally { frame.pending -= 1; }
  })();
  void operation.catch(() => {}); return operation;
}

/** Separate nullable bridge over one original getter and successful source marker. */
export function readScenarioReceiptNullableStoredReference(c: HandlerContext, originalSourceView: unknown,
  originalReference: unknown, sourceDependencyId: string,
  scalarLeafDependencyId: string): Promise<Record<string, unknown> | null> {
  const operation = (async () => {
    const frame = checked(c);
    if (frame.pending !== 0 || frame.activeQueryCandidate !== null) {
      return fail(frame, new StateError('validation', 'Nullable promotion requires its sequential ordinary source occurrence.'));
    }
    frame.pending += 1;
    try {
      const sourceView = typeof originalSourceView === 'object' && originalSourceView !== null
        ? frame.sourceViews.get(originalSourceView) ?? originalSourceView : undefined;
      const returned = resultPlan(frame)?.returns.find(entry =>
        entry.dependencies.some(dep => dep.id === sourceDependencyId) &&
        entry.dependencies.some(dep => dep.id === scalarLeafDependencyId));
      const source = returned?.dependencies.find(dep => dep.id === sourceDependencyId);
      const leaf = returned?.dependencies.find(dep => dep.id === scalarLeafDependencyId);
      const getter = sourceView === undefined || source === undefined ? undefined
        : frame.nullableStoredReferenceGetters.get(sourceView)?.get(source.field);
      const observed = sourceView === undefined || source === undefined ? undefined
        : frame.observedFields.get(sourceView)?.get(source.field);
      if (sourceView === undefined || source === undefined || leaf === undefined || source.id === leaf.id ||
          source.queryId !== undefined || leaf.queryId !== undefined ||
          stableStringify(source.source) !== stableStringify(leaf.source) ||
          stableStringify(source.source) !== stableStringify(resultPlan(frame)!.source) ||
          getter === undefined || getter.consumed || getter.sourceView !== sourceView || getter.model !== source.model ||
          getter.evaluated !== originalReference || getter.markedDependencyId !== source.id ||
          observed === undefined || observed.nullableGetter !== getter || observed.dependencyId !== source.id || observed.model !== source.model ||
          stableStringify(observed.wire) !== stableStringify(getter.wire) || frame.promoteNullableStoredReference === undefined) {
        return refuse('Nullable promotion requires its original getter, exact successful marker and installed source bridge.');
      }
      const type = parseTypeId(source.type);
      if (type.base.kind !== 'nominal' || type.base.path !== leaf.model || type.array || type.requiredArray) {
        return refuse('Nullable promotion requires its original singular model source and scalar pair.');
      }
      const admitted = frame.call.recordRefs.find(reference => {
        if (reference.model !== source.model) return false;
        try { return captureNativeScenarioReceiptReference(sourceView, frame.owner, reference.param) === reference; }
        catch { return false; }
      });
      if (admitted === undefined) return refuse('Nullable source must retain its original admitted native parameter.');
      getter.consumed = true;
      const healthy = () => {
        checked(c);
        if (frame.pending !== 1 || frame.activeQueryCandidate !== null ||
            frame.nullableStoredReferenceGetters.get(sourceView)?.get(source.field) !== getter ||
            frame.observedFields.get(sourceView)?.get(source.field)?.nullableGetter !== getter ||
            captureNativeScenarioReceiptRow(sourceView, frame.owner, source.model) !== getter.row ||
            captureNativeScenarioReceiptReference(sourceView, frame.owner, admitted.param) !== admitted) {
          return refuse('Nullable promotion crossed its original getter, source row or frame.');
        }
      };
      const captureSource = (view: object, model: string, field: string, wire: unknown): StoredRow => {
        healthy();
        if (view !== sourceView || model !== source.model || field !== source.field ||
            stableStringify(wire) !== stableStringify(getter.wire)) {
          return refuse('Nullable promotion differs from its actual original source getter.');
        }
        return getter.row;
      };
      healthy();
      const value = await frame.promoteNullableStoredReference(sourceView, originalReference, source.id, leaf.id, healthy, captureSource);
      healthy();
      if (value === null) {
        if (originalReference !== null) return refuse('A nonnull original getter cannot become nullable absence.');
        if (source.role === 'control') getter.completedSourceControlId = source.id;
        return null;
      }
      if (originalReference === null) return refuse('An original null getter cannot issue a target view.');
      captureNativeScenarioReceiptRow(value, frame.owner, leaf.model);
      if (source.role === 'control') getter.completedSourceControlId = source.id;
      return value;
    } catch (error) { return fail(frame, error); }
    finally { frame.pending -= 1; }
  })();
  void operation.catch(() => {}); return operation;
}

/** Awaited original first(Query) facade. The originating context and exact
 * issued query array alone locate State's private handle; generic first(array)
 * remains pure. Compiler owns selecting this helper for its checked occurrence. */
export function firstQuery(c: HandlerContext, value: unknown, firstMarker?: Parameters<typeof selectStateQueryFirstRow>[2]['first']): Promise<Record<string, unknown> | null> {
  const operation = (async () => {
    const frame = checked(c);
    if (frame.pending !== 0) return fail(frame, new StateError('validation', 'First query selection must follow its completed original query.'));
    frame.pending += 1;
    try {
      const selected = typeof value === 'object' && value !== null ? frame.queryArrays.get(value) : undefined;
      const query = selected?.query, result = query?.receiptResult;
      if (query === undefined || result === undefined || query.result !== result || query.bound || query.active !== null ||
          frame.queryProducer?.mutableRecord === undefined) {
        return refuse('First query selection requires its exact original receipt query array and owning mutable binder.');
      }
      query.bound = true;
      // This literal handle stays private; no selected projection, copied
      // row or later owner read can substitute for the defining selection.
      const row = await selectStateQueryFirstRow(frame.call, frame.store, { query: result.query, ...(firstMarker === undefined ? {} : { first: firstMarker }) });
      checked(c);
      const first = result.rows[0];
      if (row === null) {
        if (first !== undefined) return refuse('First query null differs from its original matched selection.');
        return null;
      }
      if (first === undefined || row.id !== first.record.id || row.version !== first.record.version) {
        return refuse('First query owner row differs from its original sorted matched selection.');
      }
      // The trusted host registers the genuine row before preparing its
      // existing parent navigation. No projection or later load substitutes.
      const view = await frame.queryProducer.mutableRecord(query.plan.model, row);
      checked(c);
      return view;
    } catch (error) { return fail(frame, error); }
    finally { frame.pending -= 1; }
  })();
  void operation.catch(() => {});
  return operation;
}

/** Original count(Query) consumes State's handle once and retains Can int.
 * Ordinary count(array) remains the synchronous Values helper. */
export function countQuery(c: HandlerContext, value: unknown): Promise<bigint> {
  const operation = (async () => {
    const frame = checked(c);
    if (frame.pending !== 0) return fail(frame, new StateError('validation', 'Query count must follow its completed original query.'));
    frame.pending += 1;
    try {
      const selected = typeof value === 'object' && value !== null ? frame.queryArrays.get(value) : undefined;
      const query = selected?.query, result = query?.receiptResult;
      if (query === undefined || result === undefined || query.result !== result || query.bound || query.active !== null) {
        return refuse('Query count requires its exact original receipt query array.');
      }
      query.bound = true;
      const count = await bindStateQueryCount(frame.call, frame.store, { query: result.query });
      checked(c);
      if (count !== BigInt(result.count)) return refuse('Query count differs from its original matched selection.');
      return count;
    } catch (error) { return fail(frame, error); }
    finally { frame.pending -= 1; }
  })();
  void operation.catch(() => {});
  return operation;
}

/** One checked source occurrence enters State's complete current-policy domain.
 * Only native views escape; actual query handles and candidate slots stay private. */
export function executeScenarioReceiptQuery(c: HandlerContext, queryId: string,
  predicate: (record: Readonly<Record<string, unknown>>) => boolean | Promise<boolean>): Promise<readonly Readonly<Record<string, unknown>>[]> {
  return executeNativeScenarioQuery(c, queryId, predicate, 'query');
}

/** Only the active native frame can invoke the checked post-write decision. */
export async function evaluateScenarioReceiptPurchaseAll(c: HandlerContext, original: unknown): Promise<boolean> {
  const frame = checked(c);
  if (frame.pending !== 0) return fail(frame, new StateError('validation', 'Purchase ALL requires sequential owner execution.'));
  frame.pending++;
  try { return await executeStatePurchaseAll(frame.call, frame.store, original); }
  catch (error) { return fail(frame, error); }
  finally { frame.pending--; }
}

/** Original stored-bool ANY uses State's whole-domain-first lazy receiver.
 * Active candidate/slot and getter markers stay in the existing private frame. */
export function executeScenarioReceiptAny(c: HandlerContext, queryId: string,
  predicate: (record: Readonly<Record<string, unknown>>) => boolean | Promise<boolean>): Promise<boolean> {
  return executeNativeScenarioQuery(c, queryId, predicate, 'any');
}

function executeNativeScenarioQuery(c: HandlerContext, queryId: string,
  predicate: (record: Readonly<Record<string, unknown>>) => boolean | Promise<boolean>, mode: 'query'): Promise<readonly Readonly<Record<string, unknown>>[]>;
function executeNativeScenarioQuery(c: HandlerContext, queryId: string,
  predicate: (record: Readonly<Record<string, unknown>>) => boolean | Promise<boolean>, mode: 'any'): Promise<boolean>;
function executeNativeScenarioQuery(c: HandlerContext, queryId: string,
  predicate: (record: Readonly<Record<string, unknown>>) => boolean | Promise<boolean>,
  mode: 'query' | 'any'): Promise<readonly Readonly<Record<string, unknown>>[] | boolean> {
  const operation = (async () => {
    const frame = checkedQuery(c);
    if (frame.pending !== 0) return fail(frame, new StateError('validation', 'Scenario queries must run sequentially.'));
    frame.pending += 1;
    try {
      const plan = resultPlan(frame)?.queries?.find(query => query.id === queryId);
      if (plan === undefined || frame.queryProducer === undefined || typeof predicate !== 'function') {
        return refuse('Scenario query requires its checked occurrence and installed native producer.');
      }
      if (mode === 'any' && frame.kind !== 'receipt') return refuse('Stored-bool ANY requires its original mutation receipt frame.');
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
            if (query.bound || query.active === view && frame.pending !== 1 || !plan.dependencies.some(dep => dep.field === field) ||
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
        if (frame.kind === 'receipt') frame.activeQueryCandidate = view;
        try {
          const accepted = await predicate(view);
          checkedQuery(c);
          if (frame.pending !== 1) return refuse('Query predicate must await its original parent navigation and observation.');
          if (typeof accepted !== 'boolean') return refuse('Query predicate requires its actual boolean.');
          if (reads.length !== 0) return refuse('Query predicate omitted an actual field read marker.');
          return accepted;
        } finally {
          query.active = null;
          if (frame.kind === 'receipt') frame.activeQueryCandidate = null;
        }
      };
      let result: NonNullable<NativeQueryExecution['result']>;
      if (frame.kind === 'receipt') {
        if (mode === 'any') {
          const authenticated = frame.queryProducer.authenticateAnyPredicate?.(queryId, predicate) ?? false;
          if (authenticated) {
            if (frame.capturedAny !== null) return refuse('Predicate ANY source capture cannot overlap.');
            frame.capturedAny = { queryId, predicate: candidate };
          }
          try {
            const accepted = await executeStateAny(frame.call, frame.store, { queryId, predicate: candidate });
            checkedQuery(c);
            if (frame.capturedAny !== null) return refuse('State must consume the original predicate ANY source capture.');
            return accepted;
          } finally {
            frame.capturedAny = null;
            // Predicate views have no lifetime after their lazy receiver.
            query.bound = true;
          }
        }
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

/** The intermediate eager array consumes its exact original completed query.
 * Source supplies evaluated messages, never slots, receiving facts or row IDs. */
export function bindScenarioReceiptQuerySelection<T extends readonly unknown[]>(c: HandlerContext,
  nativeRows: unknown, messages: T): Promise<T> {
  const operation = (async () => {
    const frame = checked(c);
    if (frame.pending !== 0 || frame.activeQueryCandidate !== null) {
      return fail(frame, new StateError('validation', 'Message selection must follow its completed original query.'));
    }
    frame.pending += 1;
    try {
      const issued = typeof nativeRows === 'object' && nativeRows !== null ? frame.queryArrays.get(nativeRows) : undefined;
      const query = issued?.query, result = query?.receiptResult, producer = frame.queryProducer;
      const metadata = producer?.selections?.find(selection => selection.queryId === query?.plan.id);
      if (issued === undefined || query === undefined || result === undefined || query.result !== result || query.bound ||
          query.active !== null || metadata === undefined || !['TextMessage[]', 'std.TextMessage[]'].includes(metadata.type) ||
          producer?.encodeSelection === undefined || producer.observeSelectionFiles === undefined ||
          !Array.isArray(messages) || messages.length !== result.rows.length || issued.views.length !== result.rows.length) {
        return refuse('Message selection requires its exact receipt query array, owning recipe and receiving producer.');
      }
      for (const [index, view] of issued.views.entries()) {
        const binding = frame.queryViews.get(view);
        if (binding?.query !== query || binding.slot !== result.rows[index]!.slot || binding.reads.length !== 0 ||
            query.plan.dependencies.some(dependency => dependency.role === 'data' && !binding.dependencies.has(dependency.id))) {
          return refuse('Message selection omitted its original eager selected DATA observations.');
        }
      }
      // Capture the complete original eager value before the first await. No
      // selected native getter is evaluated again during physical capture.
      const encode = () => {
        if (Object.getPrototypeOf(messages) !== Array.prototype || Reflect.ownKeys(messages).length !== messages.length + 1) {
          return refuse('Message selection requires its dense own eager array.');
        }
        const native = Array.from({ length: messages.length }, (_, index) => {
          const element = Object.getOwnPropertyDescriptor(messages, String(index));
          if (element === undefined || !('value' in element) || !element.enumerable || typeof element.value !== 'object' ||
              element.value === null || Array.isArray(element.value) ||
              ![Object.prototype, null].includes(Object.getPrototypeOf(element.value))) return refuse('Message selection requires original own contract values.');
          const fields: Record<string, unknown> = Object.create(null);
          if (Reflect.ownKeys(element.value).length !== metadata.fields.length) return refuse('Message selection requires its complete owning fields.');
          for (const field of metadata.fields) {
            const descriptor = Object.getOwnPropertyDescriptor(element.value, field.name);
            if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return refuse('Message selection requires own evaluated fields.');
            fields[field.name] = descriptor.value;
          }
          return fields;
        });
        return producer.encodeSelection!(metadata.type, native);
      };
      const wire = encode(), fingerprint = stableStringify(wire);
      const healthy = () => {
        checked(c);
        if (frame.pending !== 1 || frame.activeQueryCandidate !== null || query.active !== null || query.result !== result ||
            query.receiptResult !== result || frame.queryArrays.get(nativeRows as object) !== issued || !query.bound ||
            stableStringify(encode()) !== fingerprint) return refuse('Message selection crossed its original query/value lifetime.');
      };
      query.bound = true;
      const attachment = metadata.fields.find(field => field.name === 'attachments');
      const dependency = attachment === undefined ? undefined :
        resultPlan(frame)?.returns.flatMap(returned => returned.dependencies).find(dependency => dependency.id === attachment?.dependencyId);
      if (dependency === undefined || dependency.queryId !== query.plan.id || dependency.role !== 'data' ||
          dependency.model !== query.plan.model || dependency.type !== 'file[]') return refuse('Message selection lacks its owning attachment DATA occurrence.');
      const rows = [] as Array<{ readonly slot: typeof result.rows[number]['slot']; readonly files: readonly FinalizedFileObservation[] }>;
      for (const row of result.rows) {
        healthy();
        if (!Object.hasOwn(row.record.data, dependency.field)) return refuse('Selected attachment field is unavailable.');
        const files = await producer.observeSelectionFiles({ dependencyId: dependency.id, model: dependency.model,
          field: dependency.field, wire: row.record.data[dependency.field] }, healthy);
        healthy(); rows.push(Object.freeze({ slot: row.slot, files }));
      }
      healthy();
      const captured = await bindStateQuerySelection(frame.call, frame.store, { query: result.query, wire, rows: Object.freeze(rows) });
      healthy();
      if (stableStringify(captured) !== fingerprint) return refuse('State selected wire differs from the original eager messages.');
      frame.selectionChecks.push(() => {
        checked(c);
        if (stableStringify(encode()) !== fingerprint) return refuse('Selected messages changed after their original eager binding.');
      });
      return messages;
    } catch (error) { return fail(frame, error); }
    finally { frame.pending -= 1; }
  })();
  void operation.catch(() => {});
  return operation;
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

/** Existing-frame model leaf: only the host-bound native view can supply the
 * original current-stage StoredRow. Preserve State's private result identity. */
export async function bindScenarioReceiptModelResult(c: HandlerContext, returnId: string,
  value: unknown): Promise<Readonly<{ id: import('@canlang/contracts').RecordId }>> {
  const frame = checked(c);
  let acquired = false;
  try {
    const type = isGeneratedOperationDef(frame.call.def) ? frame.call.def.descriptor.result?.type : undefined;
    if (type === undefined || frame.pending !== 0) return refuse('Model return requires its checked singular type and awaited observations.');
    const parsed = parseTypeId(type);
    if (parsed.base.kind !== 'nominal' || parsed.array || parsed.nullable) return refuse('Model return requires its declared singular model.');
    const row = captureNativeScenarioReceiptRow(value, frame.owner, parsed.base.path);
    frame.pending++; acquired = true;
    const wire = await bindStateModelResult(frame.call, frame.store, { returnId, row });
    checked(c);
    frame.queryResults.set(wire, () => wire);
    return wire;
  } catch (error) { return fail(frame, error); }
  finally { if (acquired) frame.pending--; }
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
