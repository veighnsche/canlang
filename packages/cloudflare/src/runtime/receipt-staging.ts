/** Authored delivery assignments stage their protected receipt pair in the caller's fence. */
import { T26_PROGRESS_RELATIONS } from '@canlang/contracts';
import type { ArtifactModel, CanonicalValueTypes, DeliveryRef, JudgmentSpec, ReceiptResultContext, DomainWrite, ModelName, OutboxIntent, RecordId } from '@canlang/contracts';
import { isDeliveryRef, validateValue } from '@canlang/values';
import type { NormalizedSchema } from '@canlang/values';
import { StateError } from '@canlang/state/errors';
import type { SystemCommandContext, SystemStaging } from '@canlang/state/ports/system';
import {
  associationRowId, readAssociationRow, readReceiptRow, newAssociationRow, newReceiptRow,
  withAssociationRowData, RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL, createJudgmentReceiptContext,
} from '@canlang/state/receipt/tables';

export interface AuthoredDeliveryInput {
  readonly model: ArtifactModel;
  readonly recordId: string;
  readonly field: string;
  readonly value: DeliveryRef | null;
  /** Runtime-owned sends actually staged during this admitted invocation. */
  readonly queued: ReadonlyMap<string, OutboxIntent>;
  readonly operationId: string;
  /** Actual checked owning inventory and its loaded Values schema. */
  readonly valueTypes?: CanonicalValueTypes;
  readonly valueSchema?: NormalizedSchema;
  /** Actual owner checkpoint for the containing canonical commit. */
  readonly revision: number;
}

function refuse(): never {
  throw new StateError('validation', 'Delivery association cannot be staged.');
}

/** Readers and staged writes only: no standalone commit, transport or public lookup. */
export async function stageAuthoredDelivery(input: AuthoredDeliveryInput, ctx: SystemCommandContext): Promise<SystemStaging> {
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
    let resultContext: ReceiptResultContext | undefined = descriptor.result === undefined ? undefined
      : { source: target, declaredResult: descriptor.result };
    if (!judgment && !T26_PROGRESS_RELATIONS.some(relation => relation.target === target && relation.version === descriptor.version)) refuse();
    if (input.value === null) {
      if (field.nullable !== true) refuse();
    } else {
      if (!isDeliveryRef(input.value) || input.value.operation !== target) refuse();
      const queued = input.queued.get(input.value.id);
      if (queued === undefined || queued.intentId !== input.value.id || queued.target !== target ||
          queued.operationId !== input.operationId || queued.operation !== ctx.operation) refuse();
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
      // The admitted invocation owns this queued carrier; authored values cannot
      // substitute their own specification or a latest declaration revision.
      if (input.value === null || input.valueTypes === undefined || input.valueSchema === undefined) refuse();
      const original = input.queued.get(input.value.id)!;
      const carrier = original.arguments;
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
      const receipt = readReceiptRow(retained, resultContext).receipt;
      if (receipt.deliveryId !== current.deliveryId || receipt.revision !== current.revision) refuse();
    }
    if (input.value === null) {
      return { writes: existing === null ? [] : [{ kind: 'remove', model: RECEIPT_ASSOCIATION_MODEL as ModelName,
        id: existing.id, expectedVersion: existing.version }] };
    }
    const priorAttempt = await ctx.load(RECEIPT_MODEL as ModelName, input.value.id as RecordId);
    if (priorAttempt !== null) {
      const receipt = readReceiptRow(priorAttempt, resultContext).receipt;
      // The overlay may already contain this same staged assignment. A known
      // attempt can never be reassigned or reset to pending from a saved result.
      if (current?.deliveryId === input.value.id && current.source === target && current.revision === input.revision &&
          receipt.deliveryId === input.value.id && receipt.revision === input.revision && receipt.status === 'pending' &&
          receipt.result === null && receipt.error === null) return { writes: [] };
      refuse();
    }
    if (current?.deliveryId === input.value.id) refuse();
    const meta = { actor: ctx.actor, nowMs: ctx.now };
    const association = { recordModel: input.model.name, recordId: input.recordId, field: input.field,
      deliveryId: input.value.id, source: target, revision: input.revision };
    const associationWrite: DomainWrite = existing === null
      ? { kind: 'insert', model: RECEIPT_ASSOCIATION_MODEL as ModelName, row: newAssociationRow(association, meta) }
      : { kind: 'update', model: RECEIPT_ASSOCIATION_MODEL as ModelName, id: existing.id, expectedVersion: existing.version,
        row: withAssociationRowData(existing, association, meta) };
    return { writes: [associationWrite, { kind: 'insert', model: RECEIPT_MODEL as ModelName,
      row: newReceiptRow({ deliveryId: input.value.id, revision: input.revision, status: 'pending', result: null,
        error: null, contentRef: null, resultExpiresAtMs: null }, meta, resultContext) }] };
}
