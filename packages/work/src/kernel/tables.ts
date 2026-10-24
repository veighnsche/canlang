/**
 * Lane-04-owned kernel tables (S9b): occurrence/dispatch lifecycle rows
 * written through registered system commands.
 *
 * L3's commit-record tables carry no occurrence/claim lineage (verified
 * against S6: `OutboxIntent` has no origin or claim columns; stage
 * contexts expose domain `load`/`query` only), so the dispatcher owns
 * five narrow tables as `StoredRow` data payloads:
 *
 * - `work.dispatch` (id = intent id): claim lifecycle per staged intent,
 *   mirroring `OutboxItem` + `DispatchClaim` + retry availability.
 * - `work.occurrence` (id = occurrence id): execution receipts, mirroring
 *   `OccurrenceReceipt` put-if-absent.
 * - `work.schedule` (id = occurrence id): keyed schedule lineage, mirroring
 *   `ScheduledOccurrence` with the scope flattened for querying.
 * - `work.every_slot` (id = app/handler/scope/owner tuple): last
 *   admitted `every` slot per fanout scope, backing `admitEveryTick`
 *   coalescing durably. `admitEveryTick` scopes its `previousSlots`
 *   map per (app, handler) call, so the durable id qualifies the
 *   scope key with both; the `scopeKey` field keeps the map key.
 * - `work.supersession` (id = outbox id): superseded delivery intents,
 *   mirroring `SupersessionPort`.
 *
 * Query notes (verified against the memory adapter): data fields address
 * flat by bare name (`FIELD_NAME`, camelCase allowed); nested paths are
 * NOT addressable, hence the flattened scope/claim/error fields. The
 * store ignores `QuerySpec.authority`; commands pass `'owner'` for the
 * privileged path. Stages always re-filter query results exactly.
 *
 * Producers must insert the `work.dispatch` row in the same fenced batch
 * that stages each `OutboxIntent` (see the S9b L3 handoff): linkage is
 * not derivable lane-04-side. Until that write lands, dispatch rows do
 * not exist and claims refuse `not_found` — never invented.
 */
import type {
  FrameworkFilePayloadOrigin,
  ModelName,
  QuerySpec,
  RecordId,
  RecordVersion,
  StoredRow,
} from '@canlang/contracts';
import { decodeValue, encodeValue } from '@canlang/values';
import type {
  ClaimId,
  FanoutChildId,
  FanoutChildState,
  FanoutCohortKind,
  FanoutFailedReason,
  FanoutId,
  FanoutSkippedReason,
  OccurrenceId,
  OutboxId,
  OutboxItemState,
  RecurringScope,
  RetryClass,
  ScheduledOccurrenceState,
  WorkScope,
} from '@canlang/contracts';

/** Fail-closed table errors; stages throw these as plain Errors. */
export class KernelTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KernelTableError';
  }
}

type TableErrorFactory = (message: string) => Error;
const tableError: TableErrorFactory = message => new KernelTableError(message);

/** Lane-04-owned table models (branded casts, mirroring L3 usage). */
export const WORK_DISPATCH_MODEL = 'work.dispatch' as ModelName;
export const WORK_OCCURRENCE_MODEL = 'work.occurrence' as ModelName;
export const WORK_SCHEDULE_MODEL = 'work.schedule' as ModelName;
export const WORK_EVERY_SLOT_MODEL = 'work.every_slot' as ModelName;
export const WORK_SUPERSESSION_MODEL = 'work.supersession' as ModelName;

/** Closed generation targets sharing the existing dispatch lifecycle. */
export interface DispatchGenerationTargetProfile {
  readonly family: 'images' | 'text';
  readonly role: 'original' | 'control';
  readonly originalSource: 'std.ImagesV1.submit' | 'std.TextGenerationV1.generate';
  readonly resultName: 'ImageRun' | 'TextRun';
}
const IMAGE_ORIGINAL_PROFILE: DispatchGenerationTargetProfile = Object.freeze({
  family: 'images', role: 'original', originalSource: 'std.ImagesV1.submit', resultName: 'ImageRun',
});
const IMAGE_CONTROL_PROFILE: DispatchGenerationTargetProfile = Object.freeze({ ...IMAGE_ORIGINAL_PROFILE, role: 'control' });
const TEXT_ORIGINAL_PROFILE: DispatchGenerationTargetProfile = Object.freeze({
  family: 'text', role: 'original', originalSource: 'std.TextGenerationV1.generate', resultName: 'TextRun',
});
const TEXT_CONTROL_PROFILE: DispatchGenerationTargetProfile = Object.freeze({ ...TEXT_ORIGINAL_PROFILE, role: 'control' });

/** Exact membership only; neighboring or future capabilities require their defining join. */
export function dispatchGenerationTargetProfile(source: string): DispatchGenerationTargetProfile | null {
  switch (source) {
    case 'std.ImagesV1.submit': return IMAGE_ORIGINAL_PROFILE;
    case 'std.ImagesV1.cancel': case 'std.ImagesV1.reconcile': return IMAGE_CONTROL_PROFILE;
    case 'std.TextGenerationV1.generate': return TEXT_ORIGINAL_PROFILE;
    case 'std.TextGenerationV1.cancel': case 'std.TextGenerationV1.reconcile': return TEXT_CONTROL_PROFILE;
    default: return null;
  }
}

/** Checked generation business identity; Images names remain compatible exports. All fields are flat and immutable. */
export interface DispatchImageCorrelation {
  readonly requestSource: string;
  readonly requestRevision: string;
  readonly requestBinding: string;
  readonly requestFrom: string;
  readonly requestApp: string;
  readonly requestOwner: string;
}
export const DISPATCH_IMAGE_CORRELATION_FIELDS = [
  'requestSource', 'requestRevision', 'requestBinding', 'requestFrom', 'requestApp', 'requestOwner',
] as const;

/** Legacy rows omit the entire correlation; partial or noncanonical metadata is never usable. */
export function readDispatchImageCorrelation(value: object): DispatchImageCorrelation | null {
  const data = value as Readonly<Record<string, unknown>>;
  const present = DISPATCH_IMAGE_CORRELATION_FIELDS.filter(field => Object.hasOwn(data, field));
  if (present.length === 0) return null;
  if (present.length !== DISPATCH_IMAGE_CORRELATION_FIELDS.length || present.some(field => {
    const descriptor = Object.getOwnPropertyDescriptor(data, field);
    return descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string' || descriptor.value === '';
  })) {
    throw new KernelTableError('Incomplete or invalid original generation correlation.');
  }
  try {
    const revision = decodeValue('int', data.requestRevision);
    if (typeof revision !== 'bigint' || revision < 0n || encodeValue('int', revision) !== data.requestRevision) {
      throw new Error('Noncanonical revision.');
    }
  } catch { throw new KernelTableError('Original generation correlation requires a canonical nonnegative revision.'); }
  return Object.freeze(Object.fromEntries(DISPATCH_IMAGE_CORRELATION_FIELDS.map(field => [field, data[field]]))) as unknown as DispatchImageCorrelation;
}

/** Immutable original generation and independent observation window for one control. */
export interface DispatchImageControlPin {
  readonly originalIntentId: string;
  readonly observationStartedAtMs: number;
  readonly observationDeadlineMs: number;
}
const IMAGE_CONTROL_PIN_FIELDS = ['originalIntentId', 'observationStartedAtMs', 'observationDeadlineMs'] as const;

/** Legacy/unpinned controls omit all fields; partial or renewed pins are unusable. */
export function readDispatchImageControlPin(value: object): DispatchImageControlPin | null {
  const data = value as Readonly<Record<string, unknown>>;
  const present = IMAGE_CONTROL_PIN_FIELDS.filter(field => Object.hasOwn(data, field));
  if (present.length === 0) return null;
  if (present.length !== IMAGE_CONTROL_PIN_FIELDS.length || present.some(field => {
    const descriptor = Object.getOwnPropertyDescriptor(data, field);
    return descriptor === undefined || !('value' in descriptor);
  })) throw new KernelTableError('Incomplete original generation control pin.');
  const originalIntentId = data['originalIntentId'], startedAt = data['observationStartedAtMs'], deadline = data['observationDeadlineMs'];
  if (typeof originalIntentId !== 'string' || originalIntentId === '' ||
      typeof startedAt !== 'number' || !Number.isSafeInteger(startedAt) || startedAt < 0 ||
      typeof deadline !== 'number' || !Number.isSafeInteger(deadline) || deadline <= startedAt ||
      deadline - startedAt > 2_147_483_647) {
    throw new KernelTableError('Original generation control pin requires an exact identity and finite supported window.');
  }
  return Object.freeze({ originalIntentId, observationStartedAtMs: startedAt, observationDeadlineMs: deadline });
}

/** Private immutable provider recipient. Never part of delivery results or source values. */
export interface DispatchMailRecipientPin {
  readonly mailRecipientUser: string;
  readonly mailRecipientTeam: string;
  readonly mailRecipientEmail: string;
}
export function readDispatchMailRecipientPin(value: object): DispatchMailRecipientPin | null {
  const data = value as Readonly<Record<string, unknown>>;
  const keys = ['mailRecipientUser', 'mailRecipientTeam', 'mailRecipientEmail'] as const;
  if (!keys.some(key => Object.hasOwn(data, key))) return null;
  if (keys.some(key => {
    const entry = Object.getOwnPropertyDescriptor(data, key);
    return entry === undefined || !('value' in entry) || typeof entry.value !== 'string' || entry.value === '';
  })) throw new KernelTableError('Invalid private mail recipient pin.');
  try { decodeValue('email', data['mailRecipientEmail']); }
  catch { throw new KernelTableError('Invalid private mail recipient pin.'); }
  return Object.freeze({ mailRecipientUser: data['mailRecipientUser'] as string,
    mailRecipientTeam: data['mailRecipientTeam'] as string, mailRecipientEmail: data['mailRecipientEmail'] as string });
}

/** Source correspondence retained as data; shape never grants execution authority. */
export interface DispatchSourceGuard {
  readonly rule: string;
  readonly source: { readonly path: string; readonly sha256: string; readonly module: string };
  readonly owner: string;
  readonly node: { readonly start: number; readonly end: number };
  readonly inputs: Readonly<Record<string, unknown>>;
}

/** Own bounded encoded JSON. No accessors, inherited payloads or mutable aliases. */
export function readDispatchSourceGuard(data: Readonly<Record<string, unknown>>): DispatchSourceGuard | null {
  const property = Object.getOwnPropertyDescriptor(data, 'sourceGuard');
  if (property === undefined) {
    if (Reflect.has(data, 'sourceGuard')) throw new KernelTableError('work.dispatch.sourceGuard must be own data.');
    return null;
  }
  if (!('value' in property) || !property.enumerable) throw new KernelTableError('work.dispatch.sourceGuard must be own data.');
  const fail = (): never => { throw new KernelTableError('work.dispatch.sourceGuard requires bounded closed own JSON data.'); };
  const record = (value: unknown, keys?: readonly string[]): Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
    if (keys !== undefined && (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)))) return fail();
    return value as Record<string, unknown>;
  };
  const text = (value: unknown): string => typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : fail();
  const guard = record(snapshotKernelJsonValue(property.value, 'work.dispatch.sourceGuard'), ['rule', 'source', 'owner', 'node', 'inputs']);
  text(guard.rule); text(guard.owner);
  const source = record(guard.source, ['path', 'sha256', 'module']);
  text(source.path); text(source.module);
  if (typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) return fail();
  const node = record(guard.node, ['start', 'end']);
  if (!Number.isSafeInteger(node.start) || !Number.isSafeInteger(node.end) ||
      (node.start as number) < 0 || (node.end as number) <= (node.start as number)) return fail();
  record(guard.inputs);
  return guard as unknown as DispatchSourceGuard;
}

/** Scalar lifecycle projection used by recovery planning; no provenance authority. */
export interface DispatchLifecycleRowData {
  readonly intentId: OutboxId;
  readonly operationId: string;
  readonly source: string;
  readonly occurrenceIndex: number;
  readonly originOccurrence: OccurrenceId | null;
  readonly state: OutboxItemState;
  /** Completed provider attempts so far. */
  readonly attempts: number;
  readonly claimId: ClaimId | null;
  /** UTC epoch ms when the current claim was taken, if any. */
  readonly claimedAtMs: number | null;
  /** Last guard verdict; false pins the item undispatched (skipped). */
  readonly guardVerdict: boolean | null;
  readonly deliveryId: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /** Retry availability (`computeBackoff` notBeforeMs), if deferred. */
  readonly availableAtMs: number | null;
  /** First provider-attempt start (claim time), for horizon checks. */
  readonly firstAttemptAtMs: number | null;
  /**
   * Failure classification from `record-attempt`, mirroring
   * `classifyFailure`. Only `failed` rows carry one; `requeue` retries
   * transient failures and refuses terminal (or unclassified) ones, so
   * a sweeper can never resurrect a terminal business failure.
   */
  readonly retryClass: RetryClass | null;
}

/** Complete dispatch data; authoritative reads retain all original metadata checks. */
export interface DispatchRowData extends DispatchLifecycleRowData, Partial<DispatchImageCorrelation>, Partial<DispatchImageControlPin>, Partial<DispatchMailRecipientPin> {
  readonly sendInputs?: Readonly<Record<string, unknown>>;
  readonly sendInputsOrigin?: FrameworkFilePayloadOrigin;
  readonly queuePayload?: Readonly<Record<string, unknown>>;
  readonly queuePayloadOrigin?: FrameworkFilePayloadOrigin;
  readonly sourceGuard?: DispatchSourceGuard;
  readonly filePayloadOrigin?: FrameworkFilePayloadOrigin;
}

/** Execution receipt per admitted occurrence. */
export interface OccurrenceRowData {
  readonly occurrenceId: OccurrenceId;
  readonly status: 'completed' | 'failed';
  readonly result: unknown;
  readonly filePayloadOrigin?: FrameworkFilePayloadOrigin;
  readonly code: string | null;
  readonly message: string | null;
  readonly recordedAtMs: number;
}

/** Keyed schedule lineage entry. Scope flattened for querying. */
export interface ScheduleRowData {
  readonly occurrenceId: OccurrenceId;
  readonly key: string;
  readonly scopeApp: string;
  readonly scopeOwner: string;
  readonly scopeOwnerPackage: string;
  readonly at: number;
  readonly event: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly filePayloadOrigin?: FrameworkFilePayloadOrigin;
  /**
   * Previous lineage head this entry observed, if any. Occurrence ids
   * are opaque (`OccurrenceIdPort` promises no ordering), so the head
   * resolves through this backward link — never by id comparison.
   */
  readonly replaces: OccurrenceId | null;
  readonly state: ScheduledOccurrenceState;
}

/** Last admitted `every` slot per fanout scope key. */
export interface EverySlotRowData {
  readonly scopeKey: string;
  readonly app: string;
  readonly handler: string;
  readonly scope: RecurringScope;
  readonly owner: string;
  /** UTC epoch slot in seconds. */
  readonly slot: number;
}

/** Superseded delivery intent with its marking provenance. */
export interface SupersessionRowData {
  readonly outboxId: OutboxId;
  /** Occurrence whose transition marked this id, if known. */
  readonly byOccurrenceId: OccurrenceId | null;
  readonly markedAtMs: number;
}

const OUTBOX_STATES: ReadonlySet<string> = new Set([
  'pending',
  'claimed',
  'delivered',
  'failed',
  'uncertain',
  'dead',
]);

const SCHEDULE_STATES: ReadonlySet<string> = new Set([
  'pending',
  'admitted',
  'superseded',
  'cancelled',
]);

function checkRecord(value: unknown, what: string, fail: TableErrorFactory = tableError): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fail(`${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function checkString(
  record: Record<string, unknown>,
  field: string,
  what: string,
  fail: TableErrorFactory = tableError,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value === '') {
    throw fail(`${what}.${field} must be a non-empty string.`);
  }
  return value;
}

function checkNullableString(
  record: Record<string, unknown>,
  field: string,
  what: string,
  fail: TableErrorFactory = tableError,
): string | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw fail(`${what}.${field} must be a string or null.`);
  }
  return value;
}

function checkCount(
  record: Record<string, unknown>,
  field: string,
  what: string,
  fail: TableErrorFactory = tableError,
): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw fail(`${what}.${field} must be an integer >= 0.`);
  }
  return value;
}

function checkInstant(
  record: Record<string, unknown>,
  field: string,
  what: string,
): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new KernelTableError(`${what}.${field} must be finite epoch ms >= 0.`);
  }
  return value;
}

function checkNullableInstant(
  record: Record<string, unknown>,
  field: string,
  what: string,
  fail: TableErrorFactory = tableError,
): number | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw fail(`${what}.${field} must be finite epoch ms or null.`);
  }
  return value;
}

/** Deep JSON-safety: row data must survive the store JSON round-trip. */
function checkJsonSafe(value: unknown, what: string): void {
  const seen = new Set<object>();
  const visit = (node: unknown, path: string): void => {
    if (node === null) return;
    switch (typeof node) {
      case 'string':
      case 'boolean':
        return;
      case 'number':
        if (!Number.isFinite(node)) {
          throw new KernelTableError(`${what}${path} must be finite JSON.`);
        }
        return;
      case 'undefined':
      case 'function':
      case 'symbol':
      case 'bigint':
        throw new KernelTableError(`${what}${path} is not JSON-safe.`);
      case 'object': {
        if (seen.has(node)) {
          throw new KernelTableError(`${what}${path} is cyclic.`);
        }
        seen.add(node);
        if (Array.isArray(node)) {
          node.forEach((entry, index) => visit(entry, `${path}[${index}]`));
          return;
        }
        for (const [key, entry] of Object.entries(node)) {
          visit(entry, `${path}.${key}`);
        }
        return;
      }
    }
  };
  visit(value, '');
}

const checkSnapshotArrayShape = (node: unknown[], keys: readonly (string | symbol)[], what: string): void => {
  if (keys.length !== node.length || keys.some((key, index) => key !== String(index))) {
    throw new KernelTableError(`${what} must contain dense JSON arrays.`);
  }
};
const readSnapshotEntry = (node: object, key: string | symbol, what: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(node, key);
  if (typeof key !== 'string' || descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new KernelTableError(`${what} must contain own JSON data properties.`);
  }
  return descriptor.value;
};
/** Detached immutable JSON facts. Accessors, custom objects and lossy JSON refuse. */
export function snapshotKernelJsonValue<T>(value: T, what: string): T {
  const ancestors = new Set<object>();
  let remaining = 100_000;
  const visit = (node: unknown, depth = 0): unknown => {
    if (--remaining < 0 || depth > 128) throw new KernelTableError(`${what} exceeds the JSON snapshot bound.`);
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return node;
    if (typeof node === 'number' && Number.isFinite(node)) return node;
    if (typeof node !== 'object' || node === null || ancestors.has(node)) {
      throw new KernelTableError(`${what} must be acyclic JSON-safe data.`);
    }
    const array = Array.isArray(node);
    const prototype = Object.getPrototypeOf(node);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new KernelTableError(`${what} must contain plain JSON objects.`);
    }
    ancestors.add(node);
    const copy: Record<string, unknown> | unknown[] = array ? [] : {};
    const keys = Reflect.ownKeys(node).filter(key => !(array && key === 'length'));
    if (keys.length > remaining) throw new KernelTableError(`${what} exceeds the JSON snapshot bound.`);
    if (array) checkSnapshotArrayShape(node, keys, what);
    for (const key of keys) {
      Object.defineProperty(copy, key, { value: visit(readSnapshotEntry(node, key, what), depth + 1), enumerable: true });
    }
    ancestors.delete(node);
    return Object.freeze(copy);
  };
  return visit(value) as T;
}

/** Capture an optional original binding without touching accessor properties. */
export function snapshotWorkFilePayloadOrigin(data: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (!Object.hasOwn(data, 'filePayloadOrigin')) return Object.freeze({});
  const descriptor = Object.getOwnPropertyDescriptor(data, 'filePayloadOrigin');
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    throw new KernelTableError('filePayloadOrigin must be an own JSON data property.');
  }
  return snapshotKernelJsonValue({ filePayloadOrigin: descriptor.value }, 'filePayloadOrigin');
}

function closedOriginRecord(value: unknown, fields: readonly string[], what: string): Record<string, unknown> {
  const record = checkRecord(value, what);
  if (Object.keys(record).length !== fields.length || fields.some(field => !Object.hasOwn(record, field))) {
    throw new KernelTableError(`${what} requires its complete closed header.`);
  }
  return record;
}

/** Header/lifetime checks only. These persisted facts authenticate no source or File. */
export function readWorkFilePayloadOrigin(
  data: Readonly<Record<string, unknown>>,
  row: Pick<StoredRow, 'id' | 'created' | 'createdBy'>,
  model: ModelName,
  field: 'payload' | 'result' | 'sourceGuard' | 'queuePayload' | 'sendInputs',
  role: 'retained-result' | 'deferred-input',
  headerField: 'filePayloadOrigin' | 'queuePayloadOrigin' | 'sendInputsOrigin' = 'filePayloadOrigin',
): FrameworkFilePayloadOrigin | undefined {
  if (!Object.hasOwn(data, headerField)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(data, headerField);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) throw new KernelTableError('filePayloadOrigin must be own JSON data.');
  const value = snapshotKernelJsonValue(descriptor.value, 'filePayloadOrigin');
  const origin = closedOriginRecord(value, ['version', 'inventory', 'declarationSetId', 'slot', 'scope', 'origin', 'files'], 'filePayloadOrigin');
  if (origin['version'] !== 1) throw new KernelTableError('filePayloadOrigin.version must be 1.');
  const inventory = closedOriginRecord(origin['inventory'], ['owner', 'snapshotId', 'digest'], 'filePayloadOrigin.inventory');
  for (const key of ['owner', 'snapshotId', 'digest']) checkString(inventory, key, 'filePayloadOrigin.inventory');
  checkString(origin, 'declarationSetId', 'filePayloadOrigin');
  const slot = closedOriginRecord(origin['slot'], ['model', 'id', 'created', 'createdBy', 'field', 'role'], 'filePayloadOrigin.slot');
  for (const key of ['model', 'id', 'createdBy', 'field', 'role']) checkString(slot, key, 'filePayloadOrigin.slot');
  checkInstant(slot, 'created', 'filePayloadOrigin.slot');
  if (slot['model'] !== model || slot['id'] !== row.id || slot['created'] !== row.created ||
      slot['createdBy'] !== row.createdBy || slot['field'] !== field || slot['role'] !== role) {
    throw new KernelTableError('filePayloadOrigin disagrees with its owning row lifetime/slot.');
  }
  const scope = closedOriginRecord(origin['scope'], ['app', 'owner', 'ownerPackage'], 'filePayloadOrigin.scope');
  for (const key of ['app', 'owner', 'ownerPackage']) checkString(scope, key, 'filePayloadOrigin.scope');
  const recipe = checkRecord(origin['origin'], 'filePayloadOrigin.origin');
  if (!['delivery-result', 'event-input', 'handler-result', 'scheduled-handler-result', 'source-routing', 'standard-completion', 'send-guard', 'send-input'].includes(checkString(recipe, 'kind', 'filePayloadOrigin.origin'))) {
    throw new KernelTableError('filePayloadOrigin.origin has an unknown kind.');
  }
  checkOriginFiles(origin);
  return value as FrameworkFilePayloadOrigin;
}
function checkOriginFiles(origin: Record<string, unknown>): void {
  if (!Array.isArray(origin['files'])) throw new KernelTableError('filePayloadOrigin.files must be an array.');
  for (const entry of origin['files']) {
    const fact = closedOriginRecord(entry, ['path', 'file'], 'filePayloadOrigin.files entry');
    if (!Array.isArray(fact['path']) || fact['path'].some(part =>
      typeof part !== 'string' && (typeof part !== 'number' || !Number.isSafeInteger(part) || part < 0))) {
      throw new KernelTableError('filePayloadOrigin.files path must contain strings or array indices.');
    }
    checkRecord(fact['file'], 'filePayloadOrigin.files file');
  }
}

/** Supplied metadata must agree on replay; omission preserves legacy replay behavior. */
export function requireWorkFilePayloadOriginReplay(
  supplied: FrameworkFilePayloadOrigin | undefined,
  retained: FrameworkFilePayloadOrigin | undefined,
): void {
  const equal = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a).sort(), other = Object.keys(b).sort();
    return keys.length === other.length && keys.every((key, index) => key === other[index] &&
      equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  };
  if (supplied !== undefined && !equal(supplied, retained)) {
    throw new KernelTableError('Supplied filePayloadOrigin disagrees with the retained original.');
  }
}

function checkSourceGuardOrigin(row: StoredRow, data: Record<string, unknown>,
  sourceGuard: DispatchSourceGuard, filePayloadOrigin: FrameworkFilePayloadOrigin): void {
  const origin = filePayloadOrigin.origin;
  if (origin.kind !== 'send-guard') throw new KernelTableError('work.dispatch requires its original send-guard origin.');
  closedOriginRecord(origin, ['kind', 'intent', 'declaration', 'inputsDeclarationId'], 'send-guard origin');
  closedOriginRecord(origin.intent, ['intentId', 'operation', 'operationId', 'target', 'occurrenceIndex', 'dispatchGuard'], 'send-guard intent');
  closedOriginRecord(origin.declaration, ['rule', 'source', 'owner', 'node', 'binding', 'target', 'inputs',
    ...(Object.hasOwn(origin.declaration, 'evaluation') ? ['evaluation'] : [])], 'send-guard declaration');
  const declaration = origin.declaration, intent = origin.intent;
  if (Object.hasOwn(declaration, 'evaluation') && declaration.evaluation !== 'source') {
    throw new KernelTableError('send-guard evaluation phase differs from its original declaration.');
  }
  closedOriginRecord(declaration.source, ['path', 'sha256', 'module'], 'send-guard source');
  closedOriginRecord(declaration.node, ['start', 'end'], 'send-guard node');
  if (!guardIntentAgrees(row, data, intent, declaration, sourceGuard) ||
      !guardBindingAgrees(origin, declaration, sourceGuard)) {
    throw new KernelTableError('work.dispatch sourceGuard differs from its original physical intent/declaration.');
  }
}
type SendGuardOrigin = Extract<FrameworkFilePayloadOrigin['origin'], { kind: 'send-guard' }>;
function guardIntentAgrees(row: StoredRow, data: Record<string, unknown>,
  intent: SendGuardOrigin['intent'],
  declaration: SendGuardOrigin['declaration'], sourceGuard: DispatchSourceGuard): boolean {
  return !(intent.intentId !== row.id || intent.intentId !== data['intentId'] || intent.operationId !== data['operationId'] ||
    intent.target !== data['source'] || intent.occurrenceIndex !== data['occurrenceIndex'] ||
    intent.dispatchGuard !== sourceGuard.rule || declaration.rule !== sourceGuard.rule ||
    intent.operation !== declaration.owner || declaration.owner !== sourceGuard.owner || declaration.target !== intent.target);
}
function guardBindingAgrees(origin: SendGuardOrigin,
  declaration: SendGuardOrigin['declaration'], sourceGuard: DispatchSourceGuard): boolean {
  return !(typeof declaration.binding !== 'string' || declaration.binding === '' ||
    typeof origin.inputsDeclarationId !== 'string' || origin.inputsDeclarationId === '' ||
    declaration.source.path !== sourceGuard.source.path || declaration.source.sha256 !== sourceGuard.source.sha256 ||
    declaration.source.module !== sourceGuard.source.module ||
    declaration.node.start !== sourceGuard.node.start || declaration.node.end !== sourceGuard.node.end ||
    !Array.isArray(declaration.inputs) || declaration.inputs.length !== Object.keys(sourceGuard.inputs).length ||
    declaration.inputs.some((input, index) => input.name !== Object.keys(sourceGuard.inputs)[index]));
}
function checkSendInputOrigin(row: StoredRow, data: Record<string, unknown>, header: FrameworkFilePayloadOrigin): void {
  const origin = header.origin;
  if (origin.kind !== 'send-input' || origin.intent.intentId !== row.id || origin.intent.intentId !== data['intentId'] ||
      origin.intent.operationId !== data['operationId'] || origin.intent.target !== data['source'] ||
      origin.intent.occurrenceIndex !== data['occurrenceIndex'] || origin.caller.callable.id !== origin.intent.operation ||
      typeof origin.request.binding !== 'string' || origin.request.binding === '' ||
      typeof origin.request.from !== 'string' || origin.request.from === '' ||
      typeof origin.inputsDeclarationId !== 'string' || origin.inputsDeclarationId === '') {
    throw new KernelTableError('work.dispatch SEND inputs lost their original caller/intent.');
  }
}
function checkQueuePublicationOrigin(row: StoredRow, data: Record<string, unknown>,
  queuePayloadOrigin: FrameworkFilePayloadOrigin): void {
  const origin = queuePayloadOrigin.origin;
  if (origin.kind !== 'event-input' || origin.target.kind !== 'queue-publication' || origin.declaration.kind !== 'declared-event' ||
      origin.occurrenceId !== row.id || origin.sourceOccurrence !== row.id || origin.lineage.kind !== 'source' || origin.lineage.sourceOccurrence !== row.id ||
      origin.target.intent.intentId !== row.id || origin.target.intent.operationId !== data['operationId'] ||
      origin.target.intent.target !== data['source'] || origin.target.intent.occurrenceIndex !== data['occurrenceIndex'] ||
      origin.target.intent.target !== `${origin.declaration.event}.publish`) throw new KernelTableError('work.dispatch queue publication lost its original event/intent.');
}
function checkDispatchVerdict(guardVerdict: unknown, fail: TableErrorFactory = tableError): boolean | null {
  if (guardVerdict !== null && typeof guardVerdict !== 'boolean') {
    throw fail('work.dispatch.guardVerdict must be boolean or null.');
  }
  return guardVerdict;
}
function checkDispatchRetryClass(retryClass: unknown, fail: TableErrorFactory = tableError): void {
  if (retryClass !== null && retryClass !== 'transient' && retryClass !== 'terminal') {
    throw fail(
      'work.dispatch.retryClass must be transient, terminal or null.',
    );
  }
}
function checkControlPin(row: StoredRow, data: Record<string, unknown>,
  correlation: DispatchImageCorrelation | null, controlPin: DispatchImageControlPin | null): void {
  if (controlPin !== null && (correlation === null ||
      (typeof data['source'] !== 'string' || dispatchGenerationTargetProfile(data['source'])?.role !== 'control') ||
      controlPin.originalIntentId === row.id || controlPin.observationStartedAtMs !== row.created)) {
    throw new KernelTableError('Original generation control pin disagrees with its retained control row.');
  }
}
/** Validate only the lifecycle header; full metadata must run before tail fields. */
function readDispatchLifecyclePrefix(row: StoredRow, fail: TableErrorFactory = tableError) {
  const data = checkRecord(row.data, 'work.dispatch data', fail);
  const state = checkString(data, 'state', 'work.dispatch', fail);
  if (!OUTBOX_STATES.has(state)) {
    throw fail(`work.dispatch.state is unknown: ${JSON.stringify(state)}.`);
  }
  const guardVerdict = checkDispatchVerdict(data['guardVerdict'], fail);
  const retryClass = data['retryClass'];
  checkDispatchRetryClass(retryClass, fail);
  return { data, state: state as OutboxItemState, guardVerdict, retryClass: retryClass as RetryClass | null };
}

function projectDispatchLifecycle(
  prefix: ReturnType<typeof readDispatchLifecyclePrefix>, fail: TableErrorFactory = tableError,
): DispatchLifecycleRowData {
  const { data, state, guardVerdict, retryClass } = prefix;
  return {
    intentId: checkString(data, 'intentId', 'work.dispatch', fail),
    operationId: checkString(data, 'operationId', 'work.dispatch', fail),
    source: checkString(data, 'source', 'work.dispatch', fail),
    occurrenceIndex: checkCount(data, 'occurrenceIndex', 'work.dispatch', fail),
    originOccurrence: checkNullableString(data, 'originOccurrence', 'work.dispatch', fail),
    state: state as OutboxItemState,
    attempts: checkCount(data, 'attempts', 'work.dispatch', fail),
    claimId: checkNullableString(data, 'claimId', 'work.dispatch', fail),
    claimedAtMs: checkNullableInstant(data, 'claimedAtMs', 'work.dispatch', fail),
    guardVerdict,
    deliveryId: checkNullableString(data, 'deliveryId', 'work.dispatch', fail),
    errorCode: checkNullableString(data, 'errorCode', 'work.dispatch', fail),
    errorMessage: checkNullableString(data, 'errorMessage', 'work.dispatch', fail),
    availableAtMs: checkNullableInstant(data, 'availableAtMs', 'work.dispatch', fail),
    firstAttemptAtMs: checkNullableInstant(data, 'firstAttemptAtMs', 'work.dispatch', fail),
    retryClass: retryClass as RetryClass | null,
  };
}

/**
 * Historical/current lifecycle projection. Optional metadata is deliberately
 * outside this read's domain; authoritative claim/reconcile must readDispatchRow.
 * Validation errors use the supplied factory; caller-thrown values are not caught.
 */
export function readDispatchLifecycleRow(row: StoredRow, fail: TableErrorFactory = tableError): DispatchLifecycleRowData {
  return projectDispatchLifecycle(readDispatchLifecyclePrefix(row, fail), fail);
}

/** Read one dispatch row's data, failing closed on any shape drift. */
export function readDispatchRow(row: StoredRow): DispatchRowData {
  const prefix = readDispatchLifecyclePrefix(row);
  const { data } = prefix;
  const sourceGuard = readDispatchSourceGuard(data);
  const filePayloadOrigin = readWorkFilePayloadOrigin(data, row, WORK_DISPATCH_MODEL, 'sourceGuard', 'deferred-input');
  if ((sourceGuard === null) !== (filePayloadOrigin === undefined)) {
    throw new KernelTableError('work.dispatch sourceGuard and its original payload header must be present together.');
  }
  if (sourceGuard !== null && filePayloadOrigin !== undefined) {
    checkSourceGuardOrigin(row, data, sourceGuard, filePayloadOrigin);
  }
  const sendInputsOrigin = readWorkFilePayloadOrigin(data, row, WORK_DISPATCH_MODEL, 'sendInputs', 'deferred-input', 'sendInputsOrigin');
  const sendInputs = Object.hasOwn(data, 'sendInputs') ? snapshotKernelJsonValue(checkRecord(data['sendInputs'], 'work.dispatch.sendInputs'), 'work.dispatch.sendInputs') : undefined;
  if ((sendInputs === undefined) !== (sendInputsOrigin === undefined)) throw new KernelTableError('work.dispatch SEND inputs and original header must be present together.');
  if (sendInputsOrigin !== undefined) checkSendInputOrigin(row, data, sendInputsOrigin);
  const queuePayloadOrigin = readWorkFilePayloadOrigin(data, row, WORK_DISPATCH_MODEL, 'queuePayload', 'deferred-input', 'queuePayloadOrigin');
  const queuePayload = Object.hasOwn(data, 'queuePayload') ? snapshotKernelJsonValue(checkRecord(data['queuePayload'], 'work.dispatch.queuePayload'), 'work.dispatch.queuePayload') : undefined;
  if ((queuePayload === undefined) !== (queuePayloadOrigin === undefined)) throw new KernelTableError('work.dispatch queue payload and original header must be present together.');
  if (queuePayloadOrigin !== undefined) {
    checkQueuePublicationOrigin(row, data, queuePayloadOrigin);
  }
  const correlation = readDispatchImageCorrelation(data);
  const mailPin = readDispatchMailRecipientPin(data);
  if (mailPin !== null && data['source'] !== 'std.EmailV1.send_user') throw new KernelTableError('Private mail pin requires its original user send.');
  const controlPin = readDispatchImageControlPin(data);
  checkControlPin(row, data, correlation, controlPin);
  return {
    ...(correlation ?? {}),
    ...(controlPin ?? {}),
    ...(mailPin ?? {}),
    ...(sourceGuard === null ? {} : { sourceGuard }),
    ...(filePayloadOrigin === undefined ? {} : { filePayloadOrigin }),
    ...(sendInputs === undefined ? {} : { sendInputs, sendInputsOrigin: sendInputsOrigin! }),
    ...(queuePayload === undefined ? {} : { queuePayload, queuePayloadOrigin: queuePayloadOrigin! }),
    ...projectDispatchLifecycle(prefix),
  };
}

/** Read one occurrence row's data, failing closed on any shape drift. */
export function readOccurrenceRow(row: StoredRow): OccurrenceRowData {
  const data = checkRecord(row.data, 'work.occurrence data');
  const status = data['status'];
  if (status !== 'completed' && status !== 'failed') {
    throw new KernelTableError(
      `work.occurrence.status must be completed or failed, got ${JSON.stringify(status)}.`,
    );
  }
  const filePayloadOrigin = readWorkFilePayloadOrigin(data, row, WORK_OCCURRENCE_MODEL, 'result', 'retained-result');
  return {
    ...(filePayloadOrigin === undefined ? {} : { filePayloadOrigin }),
    occurrenceId: checkString(data, 'occurrenceId', 'work.occurrence'),
    status,
    result: structuredClone(snapshotKernelJsonValue(data['result'] ?? null, 'work.occurrence.result')),
    code: checkNullableString(data, 'code', 'work.occurrence'),
    message: checkNullableString(data, 'message', 'work.occurrence'),
    recordedAtMs: checkInstant(data, 'recordedAtMs', 'work.occurrence'),
  };
}

/** Read one schedule row's data, failing closed on any shape drift. */
export function readScheduleRow(row: StoredRow): ScheduleRowData {
  const data = checkRecord(row.data, 'work.schedule data');
  const state = checkString(data, 'state', 'work.schedule');
  if (!SCHEDULE_STATES.has(state)) {
    throw new KernelTableError(`work.schedule.state is unknown: ${JSON.stringify(state)}.`);
  }
  const filePayloadOrigin = readWorkFilePayloadOrigin(data, row, WORK_SCHEDULE_MODEL, 'payload', 'deferred-input');
  return {
    ...(filePayloadOrigin === undefined ? {} : { filePayloadOrigin }),
    occurrenceId: checkString(data, 'occurrenceId', 'work.schedule'),
    key: checkString(data, 'key', 'work.schedule'),
    scopeApp: checkString(data, 'scopeApp', 'work.schedule'),
    scopeOwner: checkString(data, 'scopeOwner', 'work.schedule'),
    scopeOwnerPackage: checkString(data, 'scopeOwnerPackage', 'work.schedule'),
    at: checkInstant(data, 'at', 'work.schedule'),
    event: checkString(data, 'event', 'work.schedule'),
    payload: structuredClone(snapshotKernelJsonValue(checkRecord(data['payload'], 'work.schedule.payload'), 'work.schedule.payload')),
    replaces: checkNullableString(data, 'replaces', 'work.schedule') as OccurrenceId | null,
    state: state as ScheduledOccurrenceState,
  };
}

/* -- W02.5 matching ordinary row helpers: work-direction leaf facade. -- */

/**
 * LAYERING: these ten helpers NEVER re-state row mechanics. All row
 * mechanics live in the contracts-only shared leaf
 * (`@canlang/work-kernel/rows`, invoked with the explicit 'work'
 * direction, including work JSON-safety-before-clone). Genuine leaf
 * failures are *constructed* as the owning `KernelTableError` at the
 * exact failure site via `WORK_ERRORS`; the leaf never catches caller
 * exceptions, so caller getters/proxies throwing any value — including
 * a retained genuine leaf error or a publicly constructed
 * `RowsKernelError` — propagate untouched with identity. No ambient
 * error context.
 */
const WORK_ERRORS: RowsErrorFactory = {
  kernelError: (message: string): KernelTableError => new KernelTableError(message),
};

/** Rebuild the contract scope from a schedule row's flat fields. */
export function scheduleRowScope(row: ScheduleRowData, kernel: WorkKernel = tsWorkKernel): WorkScope {
  return kernel.rows.scheduleRowScope(row);
}

/** Read one every-slot row's data, failing closed on any shape drift. */
export function readEverySlotRow(row: StoredRow, kernel: WorkKernel = tsWorkKernel): EverySlotRowData {
  return kernel.rows.readEverySlotRow(row, WORK_ERRORS);
}

/** Read one supersession row's data, failing closed on any shape drift. */
export function readSupersessionRow(row: StoredRow, kernel: WorkKernel = tsWorkKernel): SupersessionRowData {
  return kernel.rows.readSupersessionRow(row, WORK_ERRORS);
}

export interface NewRowMeta {
  /** UTC epoch ms for created/updated. */
  readonly nowMs: number;
  /** Actor identity for createdBy/updatedBy. */
  readonly actor: string;
}

function newRow(
  id: string,
  data: Readonly<Record<string, unknown>>,
  meta: NewRowMeta,
  what: string,
): StoredRow {
  if (!Number.isFinite(meta.nowMs) || meta.nowMs < 0) {
    throw new KernelTableError(`${what}: nowMs must be finite epoch ms >= 0.`);
  }
  if (typeof meta.actor !== 'string' || meta.actor === '') {
    throw new KernelTableError(`${what}: actor must be a non-empty string.`);
  }
  checkJsonSafe(data, `${what} data`);
  return {
    id: id as RecordId,
    version: 1 as RecordVersion,
    created: meta.nowMs,
    updated: meta.nowMs,
    createdBy: meta.actor,
    updatedBy: meta.actor,
    archivedAt: null,
    parent: null,
    // Deep clone: staged rows must not alias caller-owned nested data.
    data: structuredClone(data),
  };
}

/**
 * Replacement row for a conditional update: version + 1 with fresh
 * updated metadata. Callers stage it with `expectedVersion: row.version`.
 */
export function withRowData(
  row: StoredRow,
  data: Readonly<Record<string, unknown>>,
  meta: NewRowMeta,
  what: string,
  kernel: WorkKernel = tsWorkKernel,
): StoredRow {
  return kernel.rows.withRowData(row, data, meta, what, WORK_ERRORS);
}

/** Producer-side insert: the pending dispatch row for one staged intent. */
export function newDispatchRow(
  input: Pick<
    DispatchRowData,
    'intentId' | 'operationId' | 'source' | 'occurrenceIndex' | 'originOccurrence'
  > & Partial<DispatchImageCorrelation> & { readonly sourceGuard?: DispatchSourceGuard; readonly filePayloadOrigin?: FrameworkFilePayloadOrigin; readonly queuePayload?: Readonly<Record<string, unknown>>; readonly queuePayloadOrigin?: FrameworkFilePayloadOrigin; readonly sendInputs?: Readonly<Record<string, unknown>>; readonly sendInputsOrigin?: FrameworkFilePayloadOrigin },
  meta: NewRowMeta,
): StoredRow {
  const correlation = readDispatchImageCorrelation(input as unknown as Readonly<Record<string, unknown>>);
  const sourceGuard = readDispatchSourceGuard(input as unknown as Readonly<Record<string, unknown>>);
  const data: DispatchRowData = {
    ...input,
    ...(sourceGuard === null ? {} : { sourceGuard }),
    ...(correlation ?? {}),
    state: 'pending',
    attempts: 0,
    claimId: null,
    claimedAtMs: null,
    guardVerdict: null,
    deliveryId: null,
    errorCode: null,
    errorMessage: null,
    availableAtMs: null,
    firstAttemptAtMs: null,
    retryClass: null,
  };
  return newRow(input.intentId, data as unknown as Record<string, unknown>, meta, 'work.dispatch');
}

/** Put-if-absent occurrence receipt row. */
export function newOccurrenceRow(
  input: OccurrenceRowData,
  meta: NewRowMeta,
): StoredRow {
  readWorkFilePayloadOrigin(input as unknown as Readonly<Record<string, unknown>>,
    { id: input.occurrenceId as RecordId, created: meta.nowMs, createdBy: meta.actor },
    WORK_OCCURRENCE_MODEL, 'result', 'retained-result');
  const row = newRow(
    input.occurrenceId,
    input as unknown as Record<string, unknown>,
    meta,
    'work.occurrence',
  );
  readWorkFilePayloadOrigin(row.data, row, WORK_OCCURRENCE_MODEL, 'result', 'retained-result');
  return row;
}

/** Keyed schedule lineage row (id = occurrence id; key is looked up). */
export function newScheduleRow(
  input: ScheduleRowData,
  meta: NewRowMeta,
): StoredRow {
  readWorkFilePayloadOrigin(input as unknown as Readonly<Record<string, unknown>>,
    { id: input.occurrenceId as RecordId, created: meta.nowMs, createdBy: meta.actor },
    WORK_SCHEDULE_MODEL, 'payload', 'deferred-input');
  const row = newRow(
    input.occurrenceId,
    input as unknown as Record<string, unknown>,
    meta,
    'work.schedule',
  );
  readWorkFilePayloadOrigin(row.data, row, WORK_SCHEDULE_MODEL, 'payload', 'deferred-input');
  return row;
}

/**
 * Durable every-slot tracker id. Qualified by app and handler because
 * `admitEveryTick` coalesces per (app, handler, scope, owner): two
 * handlers sharing a team owner must never share one tracker row.
 * Components are encoded so `/` separators stay unambiguous.
 */
export function everySlotRowId(
  app: string,
  handler: string,
  scope: RecurringScope,
  owner: string,
  kernel: WorkKernel = tsWorkKernel,
): string {
  return kernel.rows.everySlotRowId(app, handler, scope, owner);
}

/** Every-slot tracker row (id = app/handler/scope/owner tuple). */
export function newEverySlotRow(
  input: EverySlotRowData,
  meta: NewRowMeta,
  kernel: WorkKernel = tsWorkKernel,
): StoredRow {
  return kernel.rows.newEverySlotRow(input, meta, WORK_ERRORS);
}

/** Supersession mark row (id = outbox id). */
export function newSupersessionRow(
  input: SupersessionRowData,
  meta: NewRowMeta,
  kernel: WorkKernel = tsWorkKernel,
): StoredRow {
  return kernel.rows.newSupersessionRow(input, meta, WORK_ERRORS);
}

/**
 * Dispatch rows stamped with one origin occurrence. Stages re-filter
 * exactly; the predicate only narrows the scan.
 */
export function dispatchByOriginQuery(originOccurrence: OccurrenceId, kernel: WorkKernel = tsWorkKernel): QuerySpec {
  return kernel.rows.dispatchByOriginQuery(originOccurrence);
}

/** Dispatch rows in one lifecycle state. Stages re-filter exactly. */
export function dispatchByStateQuery(state: OutboxItemState, kernel: WorkKernel = tsWorkKernel): QuerySpec {
  return kernel.rows.dispatchByStateQuery(state);
}

/** Bounded recovery state window; ids are the canonical intent row keys. */
export function dispatchRecoveryPageQuery(state: 'claimed' | 'uncertain', limit: number,
  after: string | null, kernel: WorkKernel = tsWorkKernel): QuerySpec {
  return { ...dispatchByStateQuery(state, kernel),
    where: {op: 'and', args: [{op: 'eq', field: 'state', value: state},
      ...(after === null ? [] : [{op: 'gt' as const, field: 'id', value: after}])]},
    order: [{field: 'id', direction: 'asc'}], limit,
  };
}

/**
 * Schedule rows under one key within one scope. Key-global L3 rows may
 * collide across scopes (open handoff); the flat scope fields disjoin
 * here and stages re-filter exactly.
 */
export function scheduleByKeyQuery(scope: WorkScope, key: string, kernel: WorkKernel = tsWorkKernel): QuerySpec {
  return kernel.rows.scheduleByKeyQuery(scope, key);
}

/* -- T34-F2 durable fanout tables: work-direction leaf facade. -- */

/**
 * Adopted T33-A durable per-child fanout rows, stored as `StoredRow`
 * data payloads on three narrow lane-04-owned tables (models below).
 *
 * LAYERING: this section NEVER re-states row mechanics. All fanout row
 * mechanics live in the contracts-only shared leaf
 * (`@canlang/work-kernel/rows`, invoked with the explicit 'work'
 * direction, including work JSON-safety-before-clone); this facade only
 * supplies the owning `KernelTableError` factory so genuine leaf
 * failures keep `instanceof` and messages working. Caller-thrown
 * values propagate untouched.
 *
 * Identity/commit rules (unchanged): the deterministic cutoff+cohort id
 * keeps insert-once per source-occurrence/handler/cohort; the frozen
 * member set is the complete sorted canonical identity set committed
 * in the intent row (Q4: no proven-equivalent substitute); checkpoints
 * advance by conditional update; retries reuse child rows (F5 join owns
 * that atomicity).
 */
import {
  dispatchByOriginQuery as leafDispatchByOriginQuery,
  dispatchByStateQuery as leafDispatchByStateQuery,
  everySlotRowId as leafEverySlotRowId,
  newEverySlotRow as leafNewEverySlotRow,
  newSupersessionRow as leafNewSupersessionRow,
  readEverySlotRow as leafReadEverySlotRow,
  readSupersessionRow as leafReadSupersessionRow,
  scheduleByKeyQuery as leafScheduleByKeyQuery,
  scheduleRowScope as leafScheduleRowScope,
  withRowData as leafWithRowData,
  checkFanoutIdentitySet as leafCheckFanoutIdentitySet,
  fanoutCheckpointRowId as leafFanoutCheckpointRowId,
  fanoutChildIdOf as leafFanoutChildIdOf,
  fanoutChildPageQuery as leafFanoutChildPageQuery,
  fanoutChildPageResult as leafFanoutChildPageResult,
  fanoutChildRowId as leafFanoutChildRowId,
  fanoutIntentRowId as leafFanoutIntentRowId,
  newFanoutCheckpointRow as leafNewFanoutCheckpointRow,
  newFanoutChildRow as leafNewFanoutChildRow,
  newFanoutIntentRow as leafNewFanoutIntentRow,
  nextFanoutCheckpointData as leafNextFanoutCheckpointData,
  readFanoutCheckpointRow as leafReadFanoutCheckpointRow,
  readFanoutChildRow as leafReadFanoutChildRow,
  readFanoutIntentRow as leafReadFanoutIntentRow,
  type RowsErrorFactory,
} from '@canlang/work-kernel/rows';
import { tsWorkKernel } from '@canlang/work-kernel';
import type { WorkKernel } from '@canlang/work-kernel';

/** Lane-04-owned fanout table models (branded casts, mirroring F2 usage). */
export const WORK_FANOUT_INTENT_MODEL = 'work.fanout_intent' as ModelName;
export const WORK_FANOUT_CHECKPOINT_MODEL = 'work.fanout_checkpoint' as ModelName;
export const WORK_FANOUT_CHILD_MODEL = 'work.fanout_child' as ModelName;

/** Row metadata stamp for staged fanout rows. */
export interface FanoutRowMeta {
  /** UTC epoch ms for created/updated. */
  readonly nowMs: number;
  /** Actor identity for createdBy/updatedBy. */
  readonly actor: string;
}

/** Committed fanout intent data: cutoff + cohort + frozen members. */
export interface FanoutIntentRowData {
  readonly fanoutId: FanoutId;
  readonly sourceOccurrence: OccurrenceId;
  readonly handler: string;
  readonly cohort: FanoutCohortKind;
  /** Frozen canonical admitted record identities in sorted canonical order. */
  readonly members: ReadonlyArray<string>;
  /** Flat duplicate of `members.length` for querying. */
  readonly memberCount: number;
}

/** Durable fanout checkpoint data: completed-child set plus cursor. */
export interface FanoutCheckpointRowData {
  readonly fanoutId: FanoutId;
  /** Completed record ids in sorted canonical order (deduped set). */
  readonly completed: ReadonlyArray<string>;
  /**
   * Opaque enumeration cursor; null only when enumeration is fully
   * admitted. A non-null cursor means resume, never silent truncation.
   */
  readonly cursor: string | null;
}

/** Per-child row data. Cause fields are flat: null until terminal. */
export interface FanoutChildRowData {
  readonly fanoutId: FanoutId;
  readonly parentOccurrence: OccurrenceId;
  readonly handler: string;
  readonly recordId: string;
  readonly childId: string;
  readonly state: 'pending' | 'running' | 'completed' | 'skipped' | 'failed';
  /** Committed child attempts so far. */
  readonly attempts: number;
  readonly causeKind: 'completed' | 'skipped' | 'failed' | null;
  readonly causeReason: string | null;
}

/**
 * Validate one frozen identity set: an array of non-empty canonical
 * record ids, deduped, returned in sorted canonical order. Duplicates
 * fail closed (a frozen set with a duplicate is store disagreement,
 * never silently deduped at commit).
 */
export function checkFanoutIdentitySet(
  value: unknown,
  what: string,
  kernel: WorkKernel = tsWorkKernel,
): ReadonlyArray<string> {
  return kernel.rows.checkFanoutIdentitySet(value, what, 'work', WORK_ERRORS);
}

/**
 * Deterministic fanout intent row id under FanoutCutoff + cohort —
 * collision is the insert-once rule that keeps the frozen set
 * unredefinable (see section header).
 */
export function fanoutIntentRowId(
  sourceOccurrence: OccurrenceId,
  handler: string,
  cohort: FanoutCohortKind,
  kernel: WorkKernel = tsWorkKernel,
): FanoutId {
  return kernel.rows.fanoutIntentRowId(sourceOccurrence, handler, cohort, 'work', WORK_ERRORS);
}

/** Checkpoint row id: exactly one checkpoint row per fanout id. */
export function fanoutCheckpointRowId(fanoutId: FanoutId, kernel: WorkKernel = tsWorkKernel): string {
  return kernel.rows.fanoutCheckpointRowId(fanoutId, 'work', WORK_ERRORS);
}

/**
 * Per-child row id: the full FanoutChildId (parent occurrence + handler
 * + record). Same parent+record under different handlers yields
 * different ids; the same triple always yields the same id, so retries
 * reuse the row and duplicate deliveries replay. Byte-identical to F2.
 */
export function fanoutChildRowId(
  parentOccurrence: string,
  handler: string,
  recordId: string,
  kernel: WorkKernel = tsWorkKernel,
): string {
  return kernel.rows.fanoutChildRowId(parentOccurrence, handler, recordId, 'work', WORK_ERRORS);
}

/** Producer-side insert: the committed fanout intent row. */
export function newFanoutIntentRow(
  input: {
    readonly sourceOccurrence: OccurrenceId;
    readonly handler: string;
    readonly cohort: FanoutCohortKind;
    readonly members: ReadonlyArray<string>;
  },
  meta: FanoutRowMeta,
  kernel: WorkKernel = tsWorkKernel,
): StoredRow {
  return kernel.rows.newFanoutIntentRow(input, meta, 'work', WORK_ERRORS);
}

/** Producer-side insert: the checkpoint row (explicit completed + cursor). */
export function newFanoutCheckpointRow(
  input: {
    readonly fanoutId: FanoutId;
    readonly completed?: ReadonlyArray<string>;
    readonly cursor?: string | null;
  },
  meta: FanoutRowMeta,
  kernel: WorkKernel = tsWorkKernel,
): StoredRow {
  return kernel.rows.newFanoutCheckpointRow(input, meta, 'work', WORK_ERRORS);
}

/**
 * Pure checkpoint advance: unions newly completed record ids into the
 * completed set (deduped, sorted canonical order) and carries the next
 * cursor. Re-adding an already-completed identity is an idempotent
 * no-op for crash-recovery replay.
 */
export function nextFanoutCheckpointData(
  current: FanoutCheckpointRowData,
  addCompleted: ReadonlyArray<string>,
  cursor: string | null,
  kernel: WorkKernel = tsWorkKernel,
): FanoutCheckpointRowData {
  return kernel.rows.nextFanoutCheckpointData(current, addCompleted, cursor, 'work', WORK_ERRORS);
}

/** Producer-side insert: one admitted child row (default pending, zero attempts). */
export function newFanoutChildRow(
  input: {
    readonly fanoutId: FanoutId;
    readonly parentOccurrence: OccurrenceId;
    readonly handler: string;
    readonly recordId: string;
    readonly state?: 'pending' | 'running' | 'completed' | 'skipped' | 'failed';
    readonly attempts?: number;
    readonly causeKind?: 'completed' | 'skipped' | 'failed' | null;
    readonly causeReason?: FanoutSkippedReason | FanoutFailedReason | null;
  },
  meta: FanoutRowMeta,
  kernel: WorkKernel = tsWorkKernel,
): StoredRow {
  return kernel.rows.newFanoutChildRow(input, meta, 'work', WORK_ERRORS);
}

/** Read one fanout intent row's data, failing closed on any shape drift. */
export function readFanoutIntentRow(row: StoredRow, kernel: WorkKernel = tsWorkKernel): FanoutIntentRowData {
  return kernel.rows.readFanoutIntentRow(row, 'work', WORK_ERRORS);
}

/** Read one fanout checkpoint row's data, failing closed on any shape drift. */
export function readFanoutCheckpointRow(row: StoredRow, kernel: WorkKernel = tsWorkKernel): FanoutCheckpointRowData {
  return kernel.rows.readFanoutCheckpointRow(row, 'work', WORK_ERRORS);
}

/** Read one fanout child row's data, failing closed on any shape drift. */
export function readFanoutChildRow(row: StoredRow, kernel: WorkKernel = tsWorkKernel): FanoutChildRowData {
  return kernel.rows.readFanoutChildRow(row, 'work', WORK_ERRORS);
}

/** Rebuild the contract child identity from a child row's flat fields. */
export function fanoutChildIdOf(row: FanoutChildRowData, kernel: WorkKernel = tsWorkKernel): FanoutChildId {
  return kernel.rows.fanoutChildIdOf(row);
}

/**
 * Bounded id-sorted child page query for one fanout. `cursor` is the
 * last-seen child row id (exclusive lower bound); `limit` bounds one
 * transport round-trip only (chunk size is not cohort size — §C9).
 */
export function fanoutChildPageQuery(
  fanoutId: FanoutId,
  opts: { readonly cursor: string | null; readonly limit: number },
  kernel: WorkKernel = tsWorkKernel,
): QuerySpec {
  return kernel.rows.fanoutChildPageQuery(fanoutId, opts, 'work', WORK_ERRORS);
}

/** One bounded child page: rows plus the honest resume signal. */
export interface FanoutChildPage {
  /** Id-sorted rows of this page (at most the requested limit). */
  readonly rows: ReadonlyArray<StoredRow>;
  /**
   * True only when the store returned fewer rows than the limit. False
   * means the caller MUST resume with `cursor` — never silent
   * truncation, never a complete label.
   * An exact-multiple cohort ends with one full page at done:false
   * followed by an empty page at done:true; the empty page is the
   * honest completion signal, not a reason to guess away a round-trip.
   */
  readonly done: boolean;
  /** Resume cursor (last row id) when done:false; null when done:true. */
  readonly cursor: string | null;
}

/** Fold one store page into the resume signal. Fails closed on over-return. */
export function fanoutChildPageResult(
  rows: ReadonlyArray<StoredRow>,
  limit: number,
  kernel: WorkKernel = tsWorkKernel,
): FanoutChildPage {
  return kernel.rows.fanoutChildPageResult(rows, limit, 'work', WORK_ERRORS);
}
