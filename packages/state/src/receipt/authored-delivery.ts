/** Pure authored-delivery staging uses reader ports and returns writes for the caller's fence; it grants no public mutation authority. */
import { T26_PROGRESS_RELATIONS } from '@canlang/contracts';
import type { ArtifactModel, CanonicalValueTypes, DeliveryRef, JudgmentSpec, ReceiptResultContext, FrameworkFilePayloadOrigin, DomainWrite, ModelName, OutboxIntent, RecordId } from '@canlang/contracts';
import { isDeliveryRef, validateValue } from '@canlang/values';
import type { NormalizedSchema } from '@canlang/values';
import { StateError } from '../errors.js';
import { jsonClone } from '../internal/json.js';
import { deepFreeze } from '../internal/own-data.js';
import { STAGING_MAX_ID_LENGTH } from '../effects/staging.js';
import type { SystemCommandContext, SystemStaging } from '../ports/system.js';
import {
  associationRowId, readAssociationRow, readReceiptRow, newAssociationRow, newReceiptRow,
  withAssociationRowData, RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL, createJudgmentReceiptContext,
} from './tables.js';

export interface AuthoredSkippedDelivery {
  readonly deliveryId: string;
  readonly operationId: string;
  readonly operation: string;
  readonly target: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface AuthoredDeliveryInput {
  readonly model: ArtifactModel;
  readonly recordId: string;
  readonly field: string;
  readonly value: DeliveryRef | null;
  /** Runtime-owned sends actually staged during this admitted invocation. */
  readonly queued: ReadonlyMap<string, OutboxIntent>;
  /** Runtime-owned conditional sends which actually evaluated to skipped. */
  readonly skipped?: ReadonlyMap<string, AuthoredSkippedDelivery>;
  readonly operationId: string;
  /** Actual checked owning inventory and its loaded Values schema. */
  readonly valueTypes?: CanonicalValueTypes;
  readonly valueSchema?: NormalizedSchema;
  /** Actual owner checkpoint for the containing canonical commit. */
  readonly revision: number;
  /** Already source-bound original evidence. This staging DTO grants no authority. */
  readonly filePayloadOrigin?: FrameworkFilePayloadOrigin;
}

/** Both arguments are detached own JSON from the receipt reader. */
function sameOriginal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameOriginal(left[key], right[key]));
}

function refuse(): never {
  throw new StateError('validation', 'Delivery association cannot be staged.');
}

/** Readers and staged writes only: no standalone commit, transport or public lookup. */
export async function stageAuthoredDelivery(input: AuthoredDeliveryInput, ctx: SystemCommandContext): Promise<SystemStaging> {
    const originProperty = Object.getOwnPropertyDescriptor(input, 'filePayloadOrigin');
    if (originProperty === undefined ? 'filePayloadOrigin' in input :
        !Object.hasOwn(originProperty, 'value') || !originProperty.enumerable) refuse();
    // Retain the validated declaration and assignment before any reader yields.
    input = { ...input, model: deepFreeze(jsonClone(input.model, 'Delivery model')),
      value: input.value === null ? null : deepFreeze(jsonClone(input.value, 'Delivery reference')),
      ...(input.valueTypes === undefined ? {} : { valueTypes: deepFreeze(jsonClone(input.valueTypes, 'Delivery value types')) }) };
    ctx = { ...ctx };
    if (typeof input.model.name !== 'string' || input.model.name === '' || typeof input.recordId !== 'string' || input.recordId === '' ||
        typeof input.field !== 'string' || input.field === '' || typeof input.operationId !== 'string' || input.operationId === '' ||
        !Number.isSafeInteger(input.revision) || input.revision < 0) refuse();
    const fields = input.model.fields.filter(field => field.name === input.field);
    if (fields.length !== 1) refuse();
    const field = fields[0]!;
    if (typeof field.required !== 'boolean' || typeof field.serverOnly !== 'boolean' ||
        field.array !== undefined || field.field.kind !== 'delivery' ||
        (field.nullable !== undefined && field.nullable !== true)) refuse();
    const descriptor = field.field;
    const target = `${descriptor.capability}.${descriptor.operation}`;
    const judgment = 'judgment' in descriptor && descriptor.judgment === true;
    let selected: OutboxIntent | AuthoredSkippedDelivery | undefined;
    let queued: OutboxIntent | undefined;
    let status: 'pending' | 'skipped' = 'pending';
    let resultContext: ReceiptResultContext | undefined = descriptor.result === undefined ? undefined
      : { source: target, declaredResult: descriptor.result };
    if (!judgment && !T26_PROGRESS_RELATIONS.some(relation => relation.target === target && relation.version === descriptor.version)) refuse();
    if (input.value === null) {
      if (field.nullable !== true) refuse();
    } else {
      if (!isDeliveryRef(input.value) || input.value.operation !== target) refuse();
      if (input.value.id.length > STAGING_MAX_ID_LENGTH || input.operationId.length > STAGING_MAX_ID_LENGTH) refuse();
      const actualQueued = input.queued.get(input.value.id), actualSkipped = input.skipped?.get(input.value.id);
      if ((actualQueued === undefined) === (actualSkipped === undefined)) refuse();
      if (actualQueued !== undefined) {
        queued = deepFreeze(jsonClone(actualQueued, 'Queued delivery')); selected = queued;
        if (queued.intentId !== input.value.id) refuse();
      } else {
        if (typeof actualSkipped !== 'object' || actualSkipped === null || Array.isArray(actualSkipped) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(actualSkipped))) refuse();
        selected = deepFreeze(jsonClone(actualSkipped!, 'Skipped delivery')); status = 'skipped';
        if (Reflect.ownKeys(selected).length !== 5 || !Object.hasOwn(selected, 'deliveryId') ||
            (selected as AuthoredSkippedDelivery).deliveryId !== input.value.id ||
            typeof selected.arguments !== 'object' || selected.arguments === null || Array.isArray(selected.arguments)) refuse();
      }
      if (selected.target !== target || selected.operationId !== input.operationId || selected.operation !== ctx.operation) refuse();
    }
    // Snapshot the original pending receipt before the first reader can yield.
    // Complete source closure and genuine File observations remain census checks.
    if (originProperty !== undefined && (input.value === null || status === 'skipped')) refuse();
    const meta = { actor: ctx.actor, nowMs: ctx.now };
    const pendingReceipt = input.value === null || originProperty === undefined ? null : newReceiptRow({ deliveryId: input.value.id,
      revision: input.revision, status: 'pending', result: null, error: null, contentRef: null, resultExpiresAtMs: null,
      ...(originProperty === undefined ? {} : { filePayloadOrigin: originProperty.value as FrameworkFilePayloadOrigin }) }, meta, resultContext);
    const originalBinding = pendingReceipt === null ? undefined : readReceiptRow(pendingReceipt, resultContext).filePayloadOrigin;
    if (originalBinding !== undefined) {
      const origin = originalBinding.origin;
      if (origin.kind !== 'delivery-result' || input.value === null) refuse();
      if (queued === undefined || origin.intent.intentId !== queued.intentId || origin.intent.operation !== queued.operation ||
          origin.intent.operationId !== queued.operationId || origin.intent.target !== queued.target ||
          origin.intent.occurrenceIndex !== queued.occurrenceIndex || origin.caller.callable.id !== ctx.operation ||
          origin.association.model !== input.model.name || origin.association.recordId !== input.recordId ||
          origin.association.field !== input.field) refuse();
    }
    const associationId = associationRowId(input.model.name, input.recordId, input.field);
    const existing = await ctx.load(RECEIPT_ASSOCIATION_MODEL as ModelName, associationId as RecordId);
    const current = existing === null ? null : readAssociationRow(existing);
    // Acknowledged original carriers are not exposed by the current reader port;
    // do not validate replacement/clear against a different new specification.
    if (judgment && current !== null &&
        (input.value === null || current.deliveryId !== input.value.id)) refuse();
    if (judgment && input.value === null) return { writes: [] };
    if (judgment) {
      // The admitted invocation owns this selected carrier; authored values cannot
      // substitute their own specification or a latest declaration revision.
      if (input.value === null || input.valueTypes === undefined || input.valueSchema === undefined) refuse();
      const carrier = selected!.arguments;
      if (typeof carrier !== 'object' || carrier === null || Array.isArray(carrier)) refuse();
      const frozen = (carrier as Record<string, unknown>)['judgment'];
      if (typeof frozen !== 'object' || frozen === null || Array.isArray(frozen)) refuse();
      const specification = validateValue(input.valueSchema, 'std.JudgmentSpec',
        (frozen as Record<string, unknown>)['specification'], 'create') as unknown as JudgmentSpec;
      if (!('judgment' in descriptor) || descriptor.judgment !== true) refuse();
      resultContext = createJudgmentReceiptContext(descriptor, specification, input.valueTypes);
    }
    if (current !== null) {
      if (existing!.id !== associationId || existing!.data.recordModel !== input.model.name || current.locator.recordId !== input.recordId ||
          current.locator.field !== input.field || current.source !== target || current.revision > input.revision) refuse();
      const retained = await ctx.load(RECEIPT_MODEL as ModelName, current.deliveryId as RecordId);
      if (retained === null) refuse();
      const stored = readReceiptRow(retained, resultContext);
      const original = stored.filePayloadOrigin?.origin;
      if (original !== undefined && (original.kind !== 'delivery-result' ||
          original.association.model !== input.model.name || original.association.recordId !== input.recordId ||
          original.association.field !== input.field || original.intent.target !== current.source)) refuse();
      const receipt = stored.receipt;
      if (retained.id !== current.deliveryId || receipt.deliveryId !== current.deliveryId || receipt.revision !== current.revision) refuse();
    }
    if (input.value === null) {
      return { writes: existing === null ? [] : [{ kind: 'remove', model: RECEIPT_ASSOCIATION_MODEL as ModelName,
        id: existing.id, expectedVersion: existing.version }] };
    }
    const priorAttempt = await ctx.load(RECEIPT_MODEL as ModelName, input.value.id as RecordId);
    if (priorAttempt !== null) {
      const stored = readReceiptRow(priorAttempt, resultContext);
      if (originalBinding !== undefined && !sameOriginal(originalBinding, stored.filePayloadOrigin)) refuse();
      const receipt = stored.receipt;
      // The overlay may already contain this same staged assignment. A known
      // attempt can never be reassigned or reset to pending from a saved result.
      if (current?.deliveryId === input.value.id && current.source === target && current.revision === input.revision &&
          priorAttempt.id === input.value.id && receipt.deliveryId === input.value.id && receipt.revision === input.revision && receipt.status === status &&
          receipt.result === null && receipt.error === null && stored.contentRef === null && stored.resultExpiresAtMs === null &&
          (status !== 'skipped' || stored.filePayloadOrigin === undefined)) return { writes: [] };
      refuse();
    }
    if (current?.deliveryId === input.value.id) refuse();
    const association = { recordModel: input.model.name, recordId: input.recordId, field: input.field,
      deliveryId: input.value.id, source: target, revision: input.revision };
    const associationWrite: DomainWrite = existing === null
      ? { kind: 'insert', model: RECEIPT_ASSOCIATION_MODEL as ModelName, row: newAssociationRow(association, meta) }
      : { kind: 'update', model: RECEIPT_ASSOCIATION_MODEL as ModelName, id: existing.id, expectedVersion: existing.version,
        row: withAssociationRowData(existing, association, meta) };
    return { writes: [associationWrite, { kind: 'insert', model: RECEIPT_MODEL as ModelName,
      row: pendingReceipt ?? newReceiptRow({ deliveryId: input.value.id, revision: input.revision,
        status, result: null, error: null, contentRef: null, resultExpiresAtMs: null },
        { actor: ctx.actor, nowMs: ctx.now }, resultContext) }] };
}
