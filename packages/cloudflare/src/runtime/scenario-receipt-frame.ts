/** Private framework bridge. Only actual State invoke can open a lifetime.
 * Generated source receives only observer/selection facades, never this constructor.
 */
import type { CanValue, ModelName, ScenarioReceiptIntrinsicDependency, StoragePort, StoredRow } from '@canlang/contracts';
import type { AdmittedCall } from '@canlang/state/invocation';
import { observeScenarioReceiptDependency as observeStateDependency,
  observeScenarioReceiptIntrinsic as observeStateIntrinsic,
  selectScenarioReceiptReturn as selectStateReturn } from '@canlang/state/invocation';
import { isGeneratedOperationDef } from '@canlang/state/invocation/registry';
import { assertScenarioReceiptExecution } from '@canlang/state/invocation/invoke';
import { StateError } from '@canlang/state/errors';
import type { HandlerContext } from './context.js';
import { encodeValue } from '@canlang/values';
import { bindNativeScenarioReceiptRow, captureNativeScenarioReceiptRow,
  bindNativeScenarioReceiptReference, captureNativeScenarioReceiptReference } from './native-records.js';

interface Frame {
  readonly call: AdmittedCall;
  readonly store: StoragePort;
  readonly owner: object;
  readonly failure: (error: unknown) => void;
  readonly intrinsics: ReadonlyMap<string, ScenarioReceiptIntrinsicDependency>;
  active: boolean;
  pending: number;
  failed: boolean;
  error: unknown;
}
const frames = new WeakMap<HandlerContext, Frame>();
const framedCalls = new WeakSet<AdmittedCall>();
function refuse(text: string): never { throw new StateError('validation', text); }
function fail(frame: Frame, error: unknown): never {
  // Marker failures are terminal for this exact attempt. Attribution alone
  // cannot prevent a handler catching an error and returning success later.
  if (!frame.failed) {
    frame.failed = true;
    frame.error = error;
    frame.failure(error);
  }
  throw frame.error;
}
function checked(c: HandlerContext): Frame {
  // No context property is read. An unbound/foreign context cannot identify
  // an intended caller frame, and must never poison an unrelated attempt.
  const frame = frames.get(c);
  if (frame === undefined) return refuse('Scenario receipt helper requires its active framework context.');
  if (frame.failed) throw frame.error;
  if (!frame.active) return fail(frame, new StateError('validation', 'Scenario receipt helper requires its active framework context.'));
  try { assertScenarioReceiptExecution(frame.call, frame.store); }
  catch (error) { return fail(frame, error); }
  return frame;
}
export interface ScenarioReceiptFrame {
  bind(view: object, model: string, current: () => StoredRow | null | undefined): void;
  bindAdmittedReference(view: object, reference: object): void;
  assertCompleted(): void;
  close(): void;
}
/** Called inside the actual mutation execute callback, with its registered
 * receiptStore. Neither c.store nor a staged overlay can substitute for it.
 */
export function openScenarioReceiptFrame(c: HandlerContext, call: AdmittedCall,
  store: StoragePort, failure: (error: unknown) => void): ScenarioReceiptFrame {
  assertScenarioReceiptExecution(call, store);
  if (frames.has(c) || framedCalls.has(call)) return refuse('Scenario receipt context or admitted attempt cannot be rebound.');
  const intrinsics = new Map(isGeneratedOperationDef(call.def)
    ? call.def.descriptor.result?.disclosure?.returns.flatMap(entry =>
      (entry.intrinsics ?? []).map(dependency => [dependency.id, dependency] as const)) : []);
  const frame: Frame = { call, store, failure, intrinsics, owner: Object.freeze({}), active: true, pending: 0, failed: false, error: undefined };
  frames.set(c, frame);
  framedCalls.add(call);
  return Object.freeze({
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
    assertCompleted() {
      checked(c);
      if (frame.pending !== 0) return fail(frame, new StateError('validation', 'Scenario dependency observations must be awaited before completion.'));
    },
    close() { frame.active = false; },
  });
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

/** Compiler selects only the actually evaluated return after its observations. */
export function selectScenarioReceiptReturn(c: HandlerContext, returnId: string): void {
  const frame = checked(c);
  try {
    if (frame.pending !== 0) return fail(frame, new StateError('validation', 'Scenario observations must complete before return selection.'));
    selectStateReturn(frame.call, frame.store, returnId);
  } catch (error) { fail(frame, error); }
}
