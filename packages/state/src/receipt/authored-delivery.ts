/** Pure authored-delivery staging uses reader ports and returns writes for the caller's fence; it grants no public mutation authority. */
import { T26_PROGRESS_RELATIONS } from '@canlang/contracts';
import type { ArtifactDeliveryDescriptor, ArtifactJudgmentDeliveryDescriptor, ArtifactModel, BoundCapabilityRequest, FrameworkOpaqueSendGuardDeclaration, CanonicalValueTypes, DeliveryRef, JudgmentSpec, ReceiptResultContext, FrameworkFilePayloadOrigin, DomainWrite, ModelName, OutboxIntent, RecordId, StoredRow } from '@canlang/contracts';
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
  /** Original source SEND evidence; these three members are present together. */
  readonly occurrenceIndex?: number;
  readonly request?: BoundCapabilityRequest;
  readonly guard?: FrameworkOpaqueSendGuardDeclaration;
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

function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length ||
      keys.some(key => { const member = Object.getOwnPropertyDescriptor(value, key);
        return member === undefined || !('value' in member) || !member.enumerable; })) refuse();
}
function originalText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value);
}
function sourceSkipped(entry: AuthoredSkippedDelivery): boolean {
  return Object.hasOwn(entry, 'occurrenceIndex');
}
function checkSkippedRequest(entry: AuthoredSkippedDelivery, request: BoundCapabilityRequest): void {
  closed(request, ['binding', 'from', 'arguments']);
  if (!originalText(request.binding) || !originalText(request.from) || typeof request.arguments !== 'object' ||
      request.arguments === null || Array.isArray(request.arguments) || !sameOriginal(entry.arguments, request.arguments)) refuse();
}

function checkSkippedInputs(inputs: FrameworkOpaqueSendGuardDeclaration['inputs']): void {
  if (!Array.isArray(inputs) || inputs.length > 200) refuse();
  const names = new Set<string>();
  for (const slot of inputs) {
    closed(slot, ['name', 'type']);
    if (!originalText(slot.name) || !originalText(slot.type) || names.has(slot.name)) refuse();
    names.add(slot.name);
  }
}

function checkSkippedGuard(
  entry: AuthoredSkippedDelivery,
  request: BoundCapabilityRequest,
  guard: FrameworkOpaqueSendGuardDeclaration,
): void {
  closed(guard, ['rule', 'source', 'owner', 'node', 'binding', 'target', 'inputs']);
  closed(guard.source, ['path', 'sha256', 'module']); closed(guard.node, ['start', 'end']);
  if (!originalText(guard.rule) || guard.owner !== entry.operation || guard.target !== entry.target || guard.binding !== request.binding ||
      !originalText(guard.source.path) || !originalText(guard.source.module) || typeof guard.source.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(guard.source.sha256) || !Number.isSafeInteger(guard.node.start) || (guard.node.start as number) < 0 ||
      !Number.isSafeInteger(guard.node.end) || (guard.node.end as number) <= (guard.node.start as number)) refuse();
  checkSkippedInputs(guard.inputs);
}

function checkSkipped(entry: AuthoredSkippedDelivery): void {
  const supplied = ['occurrenceIndex', 'request', 'guard'].filter(key => Object.hasOwn(entry, key));
  closed(entry, ['deliveryId', 'operationId', 'operation', 'target', 'arguments', ...(supplied.length === 0 ? [] : ['occurrenceIndex', 'request', 'guard'])]);
  if (supplied.length === 0) return;
  const request = entry.request, guard = entry.guard;
  if (!Number.isSafeInteger(entry.occurrenceIndex) || entry.occurrenceIndex! < 0) refuse();
  checkSkippedRequest(entry, request as BoundCapabilityRequest);
  checkSkippedGuard(entry, request as BoundCapabilityRequest, guard as FrameworkOpaqueSendGuardDeclaration);
}

interface StagingHead {
  readonly input: AuthoredDeliveryInput;
  readonly ctx: SystemCommandContext;
  readonly originProperty: PropertyDescriptor | undefined;
  readonly field: StagingDeliveryField;
  readonly target: string;
  readonly judgment: boolean;
  readonly resultContext: ReceiptResultContext | undefined;
}

function freezeStagingInput(input: AuthoredDeliveryInput): AuthoredDeliveryInput {
  // Retain the validated declaration and assignment before any reader yields.
  return { ...input, model: deepFreeze(jsonClone(input.model, 'Delivery model')),
    value: input.value === null ? null : deepFreeze(jsonClone(input.value, 'Delivery reference')),
    ...(input.valueTypes === undefined ? {} : { valueTypes: deepFreeze(jsonClone(input.valueTypes, 'Delivery value types')) }) };
}

type StagingDeliveryField = Omit<ArtifactModel['fields'][number], 'field'> & {
  readonly field: ArtifactDeliveryDescriptor | ArtifactJudgmentDeliveryDescriptor;
};

function findStagingField(input: AuthoredDeliveryInput): StagingDeliveryField {
  const fields = input.model.fields.filter(field => field.name === input.field);
  if (fields.length !== 1) refuse();
  const field = fields[0]!;
  if (typeof field.required !== 'boolean' || typeof field.serverOnly !== 'boolean' ||
      field.array !== undefined || field.field.kind !== 'delivery' ||
      (field.nullable !== undefined && typeof field.nullable !== 'boolean')) refuse();
  return field as StagingDeliveryField;
}

function prepareStagingHead(input: AuthoredDeliveryInput, ctx: SystemCommandContext): StagingHead {
  const originProperty = Object.getOwnPropertyDescriptor(input, 'filePayloadOrigin');
  if (originProperty === undefined ? 'filePayloadOrigin' in input :
      !Object.hasOwn(originProperty, 'value') || !originProperty.enumerable) refuse();
  input = freezeStagingInput(input);
  ctx = { ...ctx };
  if (typeof input.model.name !== 'string' || input.model.name === '' || typeof input.recordId !== 'string' || input.recordId === '' ||
      typeof input.field !== 'string' || input.field === '' || typeof input.operationId !== 'string' || input.operationId === '' ||
      !Number.isSafeInteger(input.revision) || input.revision < 0) refuse();
  const field = findStagingField(input);
  const descriptor = field.field;
  const target = `${descriptor.capability}.${descriptor.operation}`;
  const judgment = 'judgment' in descriptor && descriptor.judgment === true;
  const resultContext: ReceiptResultContext | undefined = descriptor.result === undefined ? undefined
    : { source: target, declaredResult: descriptor.result };
  if (!judgment && !T26_PROGRESS_RELATIONS.some(relation => relation.target === target && relation.version === descriptor.version)) refuse();
  return { input, ctx, originProperty, field, target, judgment, resultContext };
}

interface StagedSelection {
  readonly selected: OutboxIntent | AuthoredSkippedDelivery | undefined;
  readonly queued: OutboxIntent | undefined;
  readonly status: 'pending' | 'skipped';
}

function selectStagedDelivery(
  input: AuthoredDeliveryInput,
  target: string,
  operation: string,
  fieldNullable: unknown,
): StagedSelection {
  let selected: OutboxIntent | AuthoredSkippedDelivery | undefined;
  let queued: OutboxIntent | undefined;
  let status: 'pending' | 'skipped' = 'pending';
  if (input.value === null) {
    if (fieldNullable !== true) refuse();
  } else {
    if (!isDeliveryRef(input.value) || input.value.operation !== target) refuse();
    if (input.value.id.length > STAGING_MAX_ID_LENGTH || input.operationId.length > STAGING_MAX_ID_LENGTH) refuse();
    const staged = selectStagedCarrier(input, input.value);
    if (staged.kind === 'queued') {
      queued = staged.carrier;
      selected = staged.carrier;
    } else {
      status = 'skipped';
      selected = staged.carrier;
    }
    if (selected.target !== target || selected.operationId !== input.operationId || selected.operation !== operation) refuse();
  }
  return { selected, queued, status };
}

type StagedCarrier =
  | { readonly kind: 'queued'; readonly carrier: OutboxIntent }
  | { readonly kind: 'skipped'; readonly carrier: AuthoredSkippedDelivery };

function resolveQueuedSelection(value: DeliveryRef, actualQueued: OutboxIntent): OutboxIntent {
  const queued = deepFreeze(jsonClone(actualQueued, 'Queued delivery'));
  if (queued.intentId !== value.id) refuse();
  return queued;
}

function resolveSkippedSelection(actualSkipped: AuthoredSkippedDelivery | undefined, value: DeliveryRef): AuthoredSkippedDelivery {
  // HEAD captures the skipped carrier once at the selection site; a second
  // map read could observe a different carrier, so the capture is passed in.
  if (typeof actualSkipped !== 'object' || actualSkipped === null || Array.isArray(actualSkipped) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(actualSkipped))) refuse();
  const selected = deepFreeze(jsonClone(actualSkipped!, 'Skipped delivery'));
  checkSkipped(selected as AuthoredSkippedDelivery);
  if (!Object.hasOwn(selected, 'deliveryId') ||
      (selected as AuthoredSkippedDelivery).deliveryId !== value.id ||
      typeof selected.arguments !== 'object' || selected.arguments === null || Array.isArray(selected.arguments)) refuse();
  return selected as AuthoredSkippedDelivery;
}

function selectStagedCarrier(
  input: AuthoredDeliveryInput,
  value: DeliveryRef,
): StagedCarrier {
  const actualQueued = input.queued.get(value.id), actualSkipped = input.skipped?.get(value.id);
  if ((actualQueued === undefined) === (actualSkipped === undefined)) refuse();
  if (actualQueued !== undefined) {
    return { kind: 'queued', carrier: resolveQueuedSelection(value, actualQueued) };
  }
  return { kind: 'skipped', carrier: resolveSkippedSelection(actualSkipped, value) };
}

function checkPendingOrigin(
  origin: Extract<FrameworkFilePayloadOrigin['origin'], { kind: 'delivery-result' }>,
  queued: OutboxIntent,
): void {
  const request = queued.arguments;
  closed(request, ['binding', 'from', 'arguments']);
  if (origin.intent.intentId !== queued.intentId || origin.intent.operation !== queued.operation ||
      origin.intent.operationId !== queued.operationId || origin.intent.target !== queued.target ||
      origin.intent.occurrenceIndex !== queued.occurrenceIndex || origin.request.binding !== request.binding ||
      origin.request.from !== request.from) refuse();
}

function checkSkippedOrigin(
  origin: Extract<FrameworkFilePayloadOrigin['origin'], { kind: 'delivery-skipped' }>,
  skipped: AuthoredSkippedDelivery,
): void {
  if (!sourceSkipped(skipped) || skipped.request === undefined || skipped.guard === undefined ||
      origin.send.operation !== skipped.operation || origin.send.operationId !== skipped.operationId ||
      origin.send.target !== skipped.target || origin.send.occurrenceIndex !== skipped.occurrenceIndex ||
      origin.request.binding !== skipped.request.binding || origin.request.from !== skipped.request.from ||
      !sameOriginal(origin.guard, skipped.guard)) refuse();
}

function checkSelectedOrigin(
  input: AuthoredDeliveryInput,
  operation: string,
  status: 'pending' | 'skipped',
  queued: OutboxIntent | undefined,
  selected: OutboxIntent | AuthoredSkippedDelivery | undefined,
  origin: FrameworkFilePayloadOrigin['origin'],
): void {
  if (input.value === null || (origin.kind !== 'delivery-result' && origin.kind !== 'delivery-skipped') ||
      origin.deliveryId !== input.value.id || origin.caller.callable.id !== operation ||
      origin.association.model !== input.model.name || origin.association.recordId !== input.recordId ||
      origin.association.field !== input.field) refuse();
  if (status === 'pending') {
    if (origin.kind !== 'delivery-result' || queued === undefined) refuse();
    checkPendingOrigin(origin, queued);
  } else {
    if (origin.kind !== 'delivery-skipped') refuse();
    checkSkippedOrigin(origin, selected as AuthoredSkippedDelivery);
  }
}

function resolveJudgmentContext(
  input: AuthoredDeliveryInput,
  descriptor: ArtifactDeliveryDescriptor | ArtifactJudgmentDeliveryDescriptor,
  selected: OutboxIntent | AuthoredSkippedDelivery | undefined,
): ReceiptResultContext {
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
  return createJudgmentReceiptContext(descriptor, specification, input.valueTypes);
}

type JoinCurrent = NonNullable<ReturnType<typeof readAssociationRow>>;

async function checkCurrentAssociation(
  ctx: SystemCommandContext,
  existing: StoredRow,
  current: JoinCurrent,
  input: AuthoredDeliveryInput,
  target: string,
  resultContext: ReceiptResultContext | undefined,
): Promise<void> {
  if (existing.id !== associationRowId(input.model.name, input.recordId, input.field) ||
      existing.data.recordModel !== input.model.name || current.locator.recordId !== input.recordId ||
      current.locator.field !== input.field || current.source !== target || current.revision > input.revision) refuse();
  const retained = await ctx.load(RECEIPT_MODEL as ModelName, current.deliveryId as RecordId);
  if (retained === null) refuse();
  checkStoredReceiptAgreement(readReceiptRow(retained, resultContext), retained, current, input);
}

function checkStoredReceiptAgreement(
  stored: ReturnType<typeof readReceiptRow>,
  retained: StoredRow,
  current: JoinCurrent,
  input: AuthoredDeliveryInput,
): void {
  const original = stored.filePayloadOrigin?.origin;
  if (original !== undefined && ((original.kind !== 'delivery-result' && original.kind !== 'delivery-skipped') ||
      original.association.model !== input.model.name || original.association.recordId !== input.recordId ||
      original.association.field !== input.field ||
      (original.kind === 'delivery-skipped' ? original.send.target : original.intent.target) !== current.source ||
      // A queued lifetime can be skipped at its genuine preclaim fence.
      // Its original delivery-result provenance remains unchanged; only
      // a source-false receipt specifically requires delivery-skipped.
      original.kind === 'delivery-skipped' && stored.receipt.status !== 'skipped')) refuse();
  const receipt = stored.receipt;
  if (retained.id !== current.deliveryId || receipt.deliveryId !== current.deliveryId || receipt.revision !== current.revision) refuse();
}

interface AttemptCheck {
  readonly input: AuthoredDeliveryInput;
  readonly operation: string;
  readonly target: string;
  readonly status: 'pending' | 'skipped';
  readonly queued: OutboxIntent | undefined;
  readonly selected: OutboxIntent | AuthoredSkippedDelivery | undefined;
  readonly current: JoinCurrent | null;
  readonly originalBinding: FrameworkFilePayloadOrigin | undefined;
  readonly resultContext: ReceiptResultContext | undefined;
}

async function checkPriorAttempt(ctx: SystemCommandContext, check: AttemptCheck): Promise<boolean> {
  const { input, target, status } = check;
  const priorAttempt = await ctx.load(RECEIPT_MODEL as ModelName, input.value!.id as RecordId);
  if (priorAttempt === null) return false;
  const stored = readReceiptRow(priorAttempt, check.resultContext);
  if (check.originalBinding !== undefined && !sameOriginal(check.originalBinding, stored.filePayloadOrigin)) refuse();
  if (stored.filePayloadOrigin !== undefined) {
    checkSelectedOrigin(input, check.operation, status, check.queued, check.selected, stored.filePayloadOrigin.origin);
  }
  const receipt = stored.receipt;
  // The overlay may already contain this same staged assignment. A known
  // attempt can never be reassigned or reset to pending from a saved result.
  if (check.current?.deliveryId === input.value!.id && check.current.source === target && check.current.revision === input.revision &&
      priorAttempt.id === input.value!.id && receipt.deliveryId === input.value!.id && receipt.revision === input.revision && receipt.status === status &&
      receipt.result === null && receipt.error === null && stored.contentRef === null && stored.resultExpiresAtMs === null) return true;
  return refuse();
}

interface PendingSnapshot {
  readonly pendingReceipt: StoredRow | null;
  readonly originalBinding: FrameworkFilePayloadOrigin | undefined;
}

function snapshotPendingReceipt(
  input: AuthoredDeliveryInput,
  originProperty: PropertyDescriptor | undefined,
  status: 'pending' | 'skipped',
  selected: OutboxIntent | AuthoredSkippedDelivery | undefined,
  meta: Parameters<typeof newReceiptRow>[1],
  resultContext: ReceiptResultContext | undefined,
): PendingSnapshot {
  // Snapshot the original receipt at its actual phase before the first reader can yield.
  // Complete source closure and genuine File observations remain census checks.
  if (originProperty !== undefined && (input.value === null ||
      status === 'skipped' && !sourceSkipped(selected as AuthoredSkippedDelivery))) refuse();
  const pendingReceipt = input.value === null || originProperty === undefined ? null : newReceiptRow({ deliveryId: input.value.id,
    revision: input.revision, status, result: null, error: null, contentRef: null, resultExpiresAtMs: null,
    ...(originProperty === undefined ? {} : { filePayloadOrigin: originProperty.value as FrameworkFilePayloadOrigin }) }, meta, resultContext);
  return { pendingReceipt,
    originalBinding: pendingReceipt === null ? undefined : readReceiptRow(pendingReceipt, resultContext).filePayloadOrigin };
}

function buildStagingWrites(
  input: AuthoredDeliveryInput,
  value: DeliveryRef,
  existing: StoredRow | null,
  target: string,
  status: 'pending' | 'skipped',
  meta: Parameters<typeof newReceiptRow>[1],
  resultContext: ReceiptResultContext | undefined,
  pendingReceipt: StoredRow | null,
): SystemStaging {
  const association = { recordModel: input.model.name, recordId: input.recordId, field: input.field,
    deliveryId: value.id, source: target, revision: input.revision };
  const associationWrite: DomainWrite = existing === null
    ? { kind: 'insert', model: RECEIPT_ASSOCIATION_MODEL as ModelName, row: newAssociationRow(association, meta) }
    : { kind: 'update', model: RECEIPT_ASSOCIATION_MODEL as ModelName, id: existing.id, expectedVersion: existing.version,
      row: withAssociationRowData(existing, association, meta) };
  return { writes: [associationWrite, { kind: 'insert', model: RECEIPT_MODEL as ModelName,
    row: pendingReceipt ?? newReceiptRow({ deliveryId: value.id, revision: input.revision,
      status, result: null, error: null, contentRef: null, resultExpiresAtMs: null },
      { actor: meta.actor, nowMs: meta.nowMs }, resultContext) }] };
}

/** Readers and staged writes only: no standalone commit, transport or public lookup. */
export async function stageAuthoredDelivery(input: AuthoredDeliveryInput, ctx: SystemCommandContext): Promise<SystemStaging> {
    const head = prepareStagingHead(input, ctx);
    input = head.input; ctx = head.ctx;
    const { originProperty, field, target, judgment } = head;
    const descriptor = field.field;
    let resultContext = head.resultContext;
    const { selected, queued, status } = selectStagedDelivery(input, target, ctx.operation, field.nullable);
    const meta = { actor: ctx.actor, nowMs: ctx.now };
    const { pendingReceipt, originalBinding } =
      snapshotPendingReceipt(input, originProperty, status, selected, meta, resultContext);
    const checkOrigin = (origin: FrameworkFilePayloadOrigin['origin']): void =>
      checkSelectedOrigin(input, ctx.operation, status, queued, selected, origin);
    if (originalBinding !== undefined) checkOrigin(originalBinding.origin);
    const associationId = associationRowId(input.model.name, input.recordId, input.field);
    const existing = await ctx.load(RECEIPT_ASSOCIATION_MODEL as ModelName, associationId as RecordId);
    const current = existing === null ? null : readAssociationRow(existing);
    // Acknowledged original carriers are not exposed by the current reader port;
    // do not validate replacement/clear against a different new specification.
    if (judgment && current !== null &&
        (input.value === null || current.deliveryId !== input.value.id)) refuse();
    if (judgment && input.value === null) return { writes: [] };
    if (judgment) {
      resultContext = resolveJudgmentContext(input, descriptor, selected);
    }
    if (current !== null) {
      await checkCurrentAssociation(ctx, existing!, current, input, target, resultContext);
    }
    if (input.value === null) {
      return { writes: existing === null ? [] : [{ kind: 'remove', model: RECEIPT_ASSOCIATION_MODEL as ModelName,
        id: existing.id, expectedVersion: existing.version }] };
    }
    const alreadyStaged = await checkPriorAttempt(ctx, { input, operation: ctx.operation, target, status, queued, selected,
      current, originalBinding, resultContext });
    if (alreadyStaged) return { writes: [] };
    if (current?.deliveryId === input.value.id) refuse();
    return buildStagingWrites(input, input.value, existing, target, status, meta, resultContext, pendingReceipt);
}
