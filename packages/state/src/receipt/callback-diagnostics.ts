/** Current-authorized historical callback refusals; provider receipts stay separate. */
import type { GenerationCallbackDiagnosticRequest, GenerationCallbackDiagnosticResult,
  GenerationCallbackOrigin, ModelName, RecordId, Revision, StoragePort, StoredRow } from '@canlang/contracts';
import { StateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { FenceConflictError } from '../storage/port.js';
import { checkedMembershipFact, observeRowGrantAuthority } from '../policy/membership-facts.js';
import { evaluateBy } from '../policy/roles.js';
import { evalPredicateForRow, withPolicyRow, type ByContext, type InterimModelPolicy } from '../policy/grants.js';
import { projectCurrentRecordForViewerPolicy, type BaseQueryInput, type ViewerPageParentPolicy } from '../query/engine.js';
import { assertDeliveryField, type DeliveryFieldSchema } from './grants.js';
import { associationRowId, readAssociationRow, RECEIPT_ASSOCIATION_MODEL } from './tables.js';

export interface ViewerGenerationCallbackDiagnosticInput extends Pick<BaseQueryInput,
  'policy' | 'context' | 'memberships' | 'store' | 'fence'> {
  readonly model: ModelName;
  readonly recordId: RecordId;
  readonly field: string;
  readonly schema: DeliveryFieldSchema;
  readonly readPolicies: ReadonlyMap<ModelName, ViewerPageParentPolicy>;
  /** Legacy engine-local origin; installed native consumers resolve after authorization. */
  readonly origin?: GenerationCallbackOrigin;
  /** Installed checked declaration + original dispatch resolver; never request data. */
  readonly resolveOrigin?: (association: Readonly<{
    model: ModelName; recordId: RecordId; field: string; deliveryId: string;
    source: GenerationCallbackOrigin['source']; expectedRevision: Revision;
  }>, store: StoragePort) => Promise<GenerationCallbackOrigin>;
  /** Legacy checked callback authority, exclusive with callbackRead. */
  readonly callbackPolicy?: InterimModelPolicy;
  /** Installed verified source predicate. Use this coherent context for all Identity
   * reads and this checkpoint/fence for relations; no ambient/precomputed grant. */
  readonly callbackRead?: (observation: Readonly<{
    context: ByContext; row: StoredRow; revision: Revision; fence: BaseQueryInput['fence'];
  }>) => Promise<boolean>;
  /** Installed real Work reader, never a request-provided callback. */
  readonly readDiagnostics: (request: GenerationCallbackDiagnosticRequest,
    store: StoragePort) => Promise<GenerationCallbackDiagnosticResult>;
}
export type ViewerGenerationCallbackDiagnosticResult = { readonly outcome: 'withheld' } |
  { readonly outcome: 'no-association'; readonly revision: Revision } |
  { readonly outcome: 'observed'; readonly revision: Revision; readonly origin: GenerationCallbackOrigin;
    readonly diagnostic: GenerationCallbackDiagnosticResult };

function invalid(): never { throw new StateError('validation', 'Unsupported callback diagnostic correspondence.'); }
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) return invalid();
  return descriptor.value;
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) invalid();
}
function text(value: unknown, limit = 200): string {
  if (typeof value !== 'string' || value === '' || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  try { encodeURIComponent(value); } catch { invalid(); }
  return value;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = own(value, 'length');
  if (typeof length !== 'number' || length > maximum || Reflect.ownKeys(value).length !== length + 1) invalid();
  for (let index = 0; index < length; index++) own(value, String(index));
  return value;
}
function captureOrigin(value: GenerationCallbackOrigin): GenerationCallbackOrigin {
  record(value); const source = own(value, 'source'), event = text(own(value, 'event'));
  if (source !== 'std.ImagesV1.submit' && source !== 'std.TextGenerationV1.generate') invalid();
  const binding = text(own(value, 'binding'));
  if (event !== `${binding}.${source === 'std.ImagesV1.submit' ? 'submit' : 'generate'}.progressed`) invalid();
  const scope = own(value, 'scope'); record(scope);
  const ownerPackage = text(own(scope, 'ownerPackage'));
  if (!binding.startsWith(`${ownerPackage}.`)) invalid();
  const handlers = array(own(value, 'handlers'), 100);
  const captured: string[] = [];
  for (let index = 0; index < handlers.length; index++) captured.push(text(own(handlers, String(index))));
  if (new Set(captured).size !== captured.length || captured.some(handler => !handler.startsWith(`${ownerPackage}.`))) invalid();
  const sourceRevision = text(own(value, 'sourceRevision'));
  if (!/^(0|[1-9][0-9]*)$/.test(sourceRevision)) invalid();
  return deepFreeze({ source, event, sourceRevision, binding,
    from: text(own(value, 'from')), scope: { app: text(own(scope, 'app')), owner: text(own(scope, 'owner')),
      ownerPackage }, handlers: captured }) as GenerationCallbackOrigin;
}
/** Strip neither unsafe fields nor unknown failures: a malformed installed reader refuses. */
function captureDiagnostic(value: GenerationCallbackDiagnosticResult,
  request: GenerationCallbackDiagnosticRequest): GenerationCallbackDiagnosticResult {
  record(value);
  if (own(value, 'outcome') === 'unsupported') {
    const reason = own(value, 'reason');
    if (Reflect.ownKeys(value).length !== 2 || !['store-profile', 'bound-exceeded',
      'origin-correspondence', 'occurrence-correspondence'].includes(reason as string)) invalid();
    return Object.freeze({ outcome: 'unsupported', reason }) as GenerationCallbackDiagnosticResult;
  }
  if (own(value, 'outcome') !== 'complete' || Reflect.ownKeys(value).length !== 3 ||
      own(value, 'snapshotAttribution') !== 'unsupported') invalid();
  const failures = array(own(value, 'failures'), 1000);
  let characters = 0; const ids = new Set<string>();
  const captured: import('@canlang/contracts').GenerationCallbackFailure[] = [];
  for (let index = 0; index < failures.length; index++) {
    const failure = own(failures, String(index)); record(failure);
    const keys = ['deliveryId', 'sourceOccurrence', 'occurrenceId', 'handler', 'event', 'recordedAtMs', 'code', 'message'];
    if (Reflect.ownKeys(failure).length !== keys.length || keys.some(key => !Object.hasOwn(failure, key))) invalid();
    const deliveryId = text(own(failure, 'deliveryId')), handler = text(own(failure, 'handler'));
    const occurrenceId = text(own(failure, 'occurrenceId'), 6000), sourceOccurrence = text(own(failure, 'sourceOccurrence'));
    const recordedAtMs = own(failure, 'recordedAtMs');
    if (deliveryId !== request.deliveryId || !request.origin.handlers.includes(handler) ||
        occurrenceId !== `handler/v1/${encodeURIComponent(sourceOccurrence)}/${encodeURIComponent(handler)}` ||
        own(failure, 'event') !== request.origin.event || own(failure, 'code') !== 'require-false' ||
        own(failure, 'message') !== 'handler requirement rejected the occurrence' ||
        typeof recordedAtMs !== 'number' || !Number.isSafeInteger(recordedAtMs) || recordedAtMs < 0 ||
        ids.has(occurrenceId)) invalid();
    ids.add(occurrenceId); characters += deliveryId.length + handler.length + occurrenceId.length + sourceOccurrence.length;
    if (characters > 2_000_000) invalid();
    captured.push({ deliveryId, handler, occurrenceId, sourceOccurrence, recordedAtMs,
      event: request.origin.event, code: 'require-false' as const,
      message: 'handler requirement rejected the occurrence' as const });
  }
  return deepFreeze({ outcome: 'complete', failures: captured, snapshotAttribution: 'unsupported' });
}

/** Deny before Work lookup; recheck actual Identity facts and State fence after all awaits. */
export async function queryGenerationCallbackDiagnosticsForViewer(
  input: ViewerGenerationCallbackDiagnosticInput): Promise<ViewerGenerationCallbackDiagnosticResult> {
  const { store, memberships, fence, readDiagnostics, resolveOrigin, callbackRead } = input;
  const model = input.model, id = text(input.recordId) as RecordId, field = text(input.field);
  assertDeliveryField(input.schema, model, field);
  const legacyOrigin = input.origin === undefined ? undefined : captureOrigin(input.origin);
  const policy = new Map(input.policy), reads = new Map(input.readPolicies);
  const callbackPolicy = input.callbackPolicy, context = Object.freeze({ ...input.context });
  if (callbackPolicy === undefined ? typeof callbackRead !== 'function' :
      callbackRead !== undefined || callbackPolicy.model !== model ||
      callbackPolicy.grants.some(grant => grant.fields.length !== 0)) invalid();
  if (resolveOrigin !== undefined && (typeof resolveOrigin !== 'function' || legacyOrigin !== undefined)) invalid();
  if (typeof store.cohortLoad !== 'function' || typeof readDiagnostics !== 'function') invalid();
  const revision = await store.readRevision();
  if (fence !== undefined && fence.revision !== revision) throw new FenceConflictError(fence.revision, revision);
  const current = await store.cohortLoad({ model, id, expectedRevision: revision });
  const membership = context.actorUserId === null || context.teamId === null ? null :
    checkedMembershipFact(await memberships.findMembership(context.teamId, context.actorUserId), context.teamId, context.actorUserId);
  if (context.actorUserId !== null && context.teamId !== null) {
    fence?.enroll({ kind: 'membership', teamId: context.teamId, userId: context.actorUserId });
  }
  const byContext: ByContext = { ...context, membership, memberships };
  const rows = new Map<ModelName, StoredRow>();
  if (current !== null) rows.set(model, current);
  let diagnostic: GenerationCallbackDiagnosticResult | undefined;
  let origin: GenerationCallbackOrigin | undefined = legacyOrigin, originAuthorized = true;
  const authority = await observeRowGrantAuthority(byContext, async coherent => {
    if (current === null || current.archivedAt !== null ||
        legacyOrigin !== undefined && context.teamId !== legacyOrigin.scope.owner) return false;
    let row = current, rowModel = model; const visited = new Set<ModelName>();
    while (true) {
      if (visited.has(rowModel) || visited.size >= 100) invalid();
      visited.add(rowModel); const read = reads.get(rowModel), rowPolicy = policy.get(rowModel);
      if (read === undefined || rowPolicy === undefined || row.archivedAt !== null) return false;
      const rowContext = withPolicyRow(rowPolicy, coherent, row);
      if (!(await evaluateBy(read.by, rowContext))) return false;
      const granted = await projectCurrentRecordForViewerPolicy({ policy: rowPolicy, context: coherent, row });
      if (granted.record === null) return false;
      if (rowModel === model) {
        let identityGranted = false;
        for (const grant of rowPolicy.grants) {
          if (grant.fields.some(path => path === field || path === `${field}.id`) &&
              await evaluateBy(grant.by, rowContext) &&
              (grant.when === undefined || evalPredicateForRow(grant.when, row))) identityGranted = true;
        }
        if (!identityGranted || rowPolicy.secretFields.some(secret => secret === field ||
            field.startsWith(`${secret}.`) || secret === `${field}.id`)) return false;
        if (row.data[field] !== null && row.data[field] !== undefined) {
          const delivery = granted.record.data[field];
          if (delivery === null || typeof delivery !== 'object' || Array.isArray(delivery) ||
              typeof (delivery as Record<string, unknown>).id !== 'string') return false;
        }
      }
      fence?.enroll({ kind: 'record', model: rowModel, id: row.id, version: row.version });
      const parent = row.parent ?? null;
      if (read.parent === undefined ? parent !== null : parent === null || parent.model !== read.parent) return false;
      if (parent === null) break;
      rowModel = parent.model;
      if (!rows.has(rowModel)) {
        const loaded = await store.cohortLoad({ model: rowModel, id: parent.id, expectedRevision: revision });
        if (loaded === null) return false;
        rows.set(rowModel, loaded);
      }
      row = rows.get(rowModel)!; if (row.id !== parent.id) return false;
    }
    if (callbackRead !== undefined) {
      const verdict = await callbackRead(Object.freeze({ context: Object.freeze({ ...coherent }),
        row: current, revision, fence }));
      if (typeof verdict !== 'boolean') invalid();
      return verdict;
    }
    const callbackContext = withPolicyRow(callbackPolicy!, coherent, current);
    for (const grant of callbackPolicy!.grants) {
      if (await evaluateBy(grant.by, callbackContext) &&
          (grant.when === undefined || evalPredicateForRow(grant.when, current))) return true;
    }
    return false;
  });
  if (authority.value) {
    fence?.enroll({ kind: 'query', model, authority: 'viewer' });
    const delivery = current!.data[field];
    if (delivery !== null && delivery !== undefined) {
      record(delivery);
      const source = own(delivery, 'operation');
      if (Reflect.ownKeys(delivery).length !== 2 ||
          source !== 'std.ImagesV1.submit' && source !== 'std.TextGenerationV1.generate') invalid();
      const deliveryId = text(own(delivery, 'id'));
      const association = await store.cohortLoad({ model: RECEIPT_ASSOCIATION_MODEL as ModelName,
        id: associationRowId(model, id, field) as RecordId, expectedRevision: revision });
      if (association === null) invalid();
      const saved = readAssociationRow(association);
      if (saved.locator.recordId !== id || saved.locator.field !== field ||
          saved.source !== source || saved.deliveryId !== deliveryId) invalid();
      if (resolveOrigin !== undefined) {
        origin = captureOrigin(await resolveOrigin(Object.freeze({ model, recordId: id, field,
          deliveryId, source, expectedRevision: revision }), store));
      }
      if (origin === undefined || origin.source !== source) invalid();
      originAuthorized = context.teamId === origin.scope.owner;
      // A resolver is asynchronous evidence too. Refuse lost authority before Work,
      // then keep the final check below for movement during the evidence read.
      await authority.revalidate();
      const resolvedRevision = await store.readRevision();
      if (resolvedRevision !== revision) throw new FenceConflictError(revision, resolvedRevision);
      if (originAuthorized) {
        const request = deepFreeze({ origin, deliveryId, expectedRevision: revision });
        diagnostic = captureDiagnostic(await readDiagnostics(request, store), request);
      }
    } else {
      // Null is observed only after authorization, and must have no dangling association.
      const association = await store.cohortLoad({ model: RECEIPT_ASSOCIATION_MODEL as ModelName,
        id: associationRowId(model, id, field) as RecordId, expectedRevision: revision });
      if (association !== null) invalid();
    }
  }
  await authority.revalidate();
  const actual = await store.readRevision();
  if (actual !== revision) throw new FenceConflictError(revision, actual);
  if (!authority.value || !originAuthorized) return Object.freeze({ outcome: 'withheld' });
  return diagnostic === undefined ? Object.freeze({ outcome: 'no-association', revision }) :
    deepFreeze({ outcome: 'observed', revision, origin: origin!, diagnostic });
}
