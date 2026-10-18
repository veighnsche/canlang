import type { FrameworkFileReferenceField as Field, FrameworkFileReferenceModel,
  FrameworkFileReferenceProducer, ModelName, StoredRow } from '@canlang/contracts';
import { KernelTableError, WORK_DISPATCH_MODEL, WORK_OCCURRENCE_MODEL, WORK_SCHEDULE_MODEL,
  WORK_EVERY_SLOT_MODEL, WORK_SUPERSESSION_MODEL, WORK_FANOUT_INTENT_MODEL,
  WORK_FANOUT_CHECKPOINT_MODEL, WORK_FANOUT_CHILD_MODEL, everySlotRowId,
  readDispatchRow, readOccurrenceRow, readScheduleRow, readEverySlotRow,
  readSupersessionRow, readFanoutIntentRow, readFanoutCheckpointRow, readFanoutChildRow,
  type DispatchRowData, type OccurrenceRowData, type ScheduleRowData, type EverySlotRowData,
  type SupersessionRowData, type FanoutIntentRowData, type FanoutCheckpointRowData,
  type FanoutChildRowData } from './tables.js';
import { WORK_HANDLER_OCCURRENCE_MODEL, readHandlerOccurrenceRow,
  type HandlerOccurrenceRowData } from './handler-occurrence.js';
import { resolveWorkOpaqueField } from './opaque-file-resolver.js';

const string = Object.freeze({ kind: 'control', value: 'string' } as const);
const number = Object.freeze({ kind: 'control', value: 'number' } as const);
const nullableString = Object.freeze({ ...string, nullable: true } as const);
const nullableNumber = Object.freeze({ ...number, nullable: true } as const);
const optionalString = Object.freeze({ ...string, optional: true } as const);
const optionalNumber = Object.freeze({ ...number, optional: true } as const);
const strings = Object.freeze({ kind: 'control', value: 'string-array' } as const);
const deferred = Object.freeze({ kind: 'opaque', role: 'deferred-input' } as const);
const result = Object.freeze({ kind: 'opaque', role: 'retained-result' } as const);
const payloadOrigin = (payloadField: string) => Object.freeze({ kind: 'opaque', role: 'payload-origin',
  payloadField, optional: true } as const);
type Fields<T> = { readonly [K in keyof T]-?: Field };
const dispatch = {
  intentId: string, operationId: string, source: string, occurrenceIndex: number,
  originOccurrence: nullableString, state: string, attempts: number, claimId: nullableString,
  claimedAtMs: nullableNumber, guardVerdict: Object.freeze({ kind: 'control', value: 'boolean', nullable: true } as const),
  deliveryId: nullableString, errorCode: nullableString, errorMessage: nullableString,
  availableAtMs: nullableNumber, firstAttemptAtMs: nullableNumber, retryClass: nullableString,
  requestSource: optionalString, requestRevision: optionalString, requestBinding: optionalString,
  requestFrom: optionalString, requestApp: optionalString, requestOwner: optionalString,
  mailRecipientUser: optionalString, mailRecipientTeam: optionalString, mailRecipientEmail: optionalString,
  originalIntentId: optionalString, observationStartedAtMs: optionalNumber, observationDeadlineMs: optionalNumber,
  queuePayload: Object.freeze({ ...deferred, optional: true }), queuePayloadOrigin: payloadOrigin('queuePayload'),
  sourceGuard: Object.freeze({ ...deferred, optional: true }), filePayloadOrigin: payloadOrigin('sourceGuard'),
} satisfies Fields<DispatchRowData>;
const occurrence = { occurrenceId: string, status: string, result, code: nullableString,
  message: nullableString, recordedAtMs: number, filePayloadOrigin: payloadOrigin('result') } satisfies Fields<OccurrenceRowData>;
const schedule = { occurrenceId: string, key: string, scopeApp: string, scopeOwner: string,
  scopeOwnerPackage: string, at: number, event: string, payload: deferred,
  replaces: nullableString, state: string, filePayloadOrigin: payloadOrigin('payload') } satisfies Fields<ScheduleRowData>;
const every = { scopeKey: string, app: string, handler: string, scope: string,
  owner: string, slot: number } satisfies Fields<EverySlotRowData>;
const supersession = { outboxId: string, byOccurrenceId: nullableString,
  markedAtMs: number } satisfies Fields<SupersessionRowData>;
const fanoutIntent = { fanoutId: string, sourceOccurrence: string, handler: string,
  cohort: string, members: strings, memberCount: number } satisfies Fields<FanoutIntentRowData>;
const fanoutCheckpoint = { fanoutId: string, completed: strings,
  cursor: nullableString } satisfies Fields<FanoutCheckpointRowData>;
const fanoutChild = { fanoutId: string, parentOccurrence: string, handler: string,
  recordId: string, childId: string, state: string, attempts: number,
  causeKind: nullableString, causeReason: nullableString } satisfies Fields<FanoutChildRowData>;
const handler = { occurrenceId: string, sourceOccurrence: string, handler: string,
  event: string, payload: deferred, scopeApp: string, scopeOwner: string,
  scopeOwnerPackage: string, state: string, filePayloadOrigin: payloadOrigin('payload') } satisfies Fields<HandlerOccurrenceRowData>;

const models: readonly FrameworkFileReferenceModel[] = Object.freeze([
  [WORK_DISPATCH_MODEL, dispatch, 'DispatchRowData'],
  [WORK_OCCURRENCE_MODEL, occurrence, 'OccurrenceRowData'],
  [WORK_SCHEDULE_MODEL, schedule, 'ScheduleRowData'],
  [WORK_EVERY_SLOT_MODEL, every, 'EverySlotRowData'],
  [WORK_SUPERSESSION_MODEL, supersession, 'SupersessionRowData'],
  [WORK_FANOUT_INTENT_MODEL, fanoutIntent, 'FanoutIntentRowData'],
  [WORK_FANOUT_CHECKPOINT_MODEL, fanoutCheckpoint, 'FanoutCheckpointRowData'],
  [WORK_FANOUT_CHILD_MODEL, fanoutChild, 'FanoutChildRowData'],
  [WORK_HANDLER_OCCURRENCE_MODEL, handler, 'HandlerOccurrenceRowData'],
].map(([model, fields, declaration]) => Object.freeze({ model: model as ModelName,
  source: Object.freeze({ package: '@canlang/work',
    module: model === WORK_HANDLER_OCCURRENCE_MODEL ? 'kernel/handler-occurrence' : 'kernel/tables',
    export: declaration as string }),
  fields: Object.freeze(fields as Readonly<Record<string, Field>>) })));

function invalid(message: string): never { throw new KernelTableError(`Work File inventory: ${message}`); }

/** Detached bounded JSON data only; inspect descriptors before reading values. */
function copyJsonEntry(node: object, array: boolean, keys: readonly (string | symbol)[],
  child: (value: unknown, depth: number) => unknown, depth: number): unknown {
  const out: Record<string, unknown> | unknown[] = array ? [] : {};
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(node, key);
    if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor) ||
        !descriptor.enumerable || array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (node as unknown[]).length)) {
      return invalid('enumerable own data properties required.');
    }
    // StoredRow's pre-S5 parent omission/undefined means no parent.
    const member = depth === 0 && key === 'parent' && descriptor.value === undefined ? null :
      child(descriptor.value, depth + 1);
    Object.defineProperty(out, key, { value: member,
      enumerable: true, writable: true, configurable: true });
  }
  return out;
}
function copyJson(value: unknown): unknown {
  const active = new Set<object>();
  let nodes = 0;
  const copy = (node: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 32) return invalid('JSON budget exceeded.');
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return node;
    if (typeof node === 'number' && Number.isFinite(node)) return node;
    if (typeof node !== 'object' || node === null || active.has(node)) return invalid('JSON data required.');
    const array = Array.isArray(node), proto = Object.getPrototypeOf(node);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return invalid('plain own data required.');
    const keys = Reflect.ownKeys(node);
    if (array && keys.length !== node.length + 1) return invalid('dense arrays required.');
    active.add(node);
    const out = copyJsonEntry(node, array, keys, (child, childDepth) => copy(child, childDepth), depth);
    active.delete(node);
    return out;
  };
  return copy(value, 0);
}

function checkInventoryField(data: Record<string, unknown>, key: string, field: Field): void {
  if (!Object.hasOwn(data, key)) {
    if (field.kind === 'control' && field.optional === true || field.kind === 'opaque' &&
        (field.role === 'payload-origin' || field.role === 'deferred-input') && field.optional) return;
    return invalid(`missing ${key}.`);
  }
  const member = data[key];
  if (field.kind === 'opaque') return;
  if (member === null && field.nullable === true) return;
  if (field.value === 'object') {
    closed(member, field.fields);
    return;
  }
  if (field.value === 'string-array' ? !Array.isArray(member) || member.some(item => typeof item !== 'string') :
      typeof member !== field.value || field.value === 'number' && !Number.isFinite(member)) return invalid(`invalid ${key}.`);
}
function closed(value: unknown, fields: Readonly<Record<string, Field>>): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid('object required.');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !Object.hasOwn(fields, key))) return invalid('unknown field.');
  for (const [key, field] of Object.entries(fields)) {
    checkInventoryField(data, key, field);
  }
  return data;
}

function checkRowMetadata(row: Record<string, unknown>): void {
  if (row.id === '' || row.createdBy === '' || row.updatedBy === '' ||
      !Number.isInteger(row.version) || (row.version as number) < 1 ||
      (row.created as number) < 0 || (row.updated as number) < 0 ||
      row.archivedAt !== null && (row.archivedAt as number) < 0) return invalid('invalid row metadata.');
  if (row.parent !== null) closed(row.parent, { model: string, id: string });
}
function checkModelIdentity(model: ModelName, stored: StoredRow, row: Record<string, unknown>, data: Record<string, unknown>): void {
  switch (model) {
    case WORK_DISPATCH_MODEL: readDispatchRow(stored); if (row.id !== data.intentId) return invalid('dispatch identity.'); break;
    case WORK_OCCURRENCE_MODEL: readOccurrenceRow(stored); if (row.id !== data.occurrenceId) return invalid('occurrence identity.'); break;
    case WORK_SCHEDULE_MODEL: readScheduleRow(stored); if (row.id !== data.occurrenceId) return invalid('schedule identity.'); break;
    case WORK_EVERY_SLOT_MODEL: {
      const item = readEverySlotRow(stored);
      if (row.id !== everySlotRowId(item.app, item.handler, item.scope, item.owner)) return invalid('every-slot identity.');
      break;
    }
    case WORK_SUPERSESSION_MODEL: readSupersessionRow(stored); if (row.id !== data.outboxId) return invalid('supersession identity.'); break;
    case WORK_FANOUT_INTENT_MODEL: readFanoutIntentRow(stored); break;
    case WORK_FANOUT_CHECKPOINT_MODEL: readFanoutCheckpointRow(stored); break;
    case WORK_FANOUT_CHILD_MODEL: readFanoutChildRow(stored); break;
    case WORK_HANDLER_OCCURRENCE_MODEL: readHandlerOccurrenceRow(stored); break;
  }
}
/** Shape validation only: opaque positions retain their payload role and grant no File authority. */
function validateRow(model: ModelName, value: StoredRow): void {
  const declaration = models.find(candidate => candidate.model === model);
  if (declaration === undefined) return invalid('unknown exact model.');
  const copied = copyJson(value) as Record<string, unknown>;
  if (typeof copied === 'object' && copied !== null && !Object.hasOwn(copied, 'parent')) copied.parent = null;
  const row = closed(copied, { id: string, version: number, created: number, updated: number,
    createdBy: string, updatedBy: string, archivedAt: nullableNumber,
    parent: deferred, data: deferred });
  checkRowMetadata(row);
  const data = closed(row.data, declaration.fields), stored = row as unknown as StoredRow;
  checkModelIdentity(model, stored, row, data);
}

const resolveOpaqueField: NonNullable<FrameworkFileReferenceProducer['resolveOpaqueField']> = (model, value, field, context) => {
  const row = copyJson(value) as StoredRow;
  validateRow(model, row);
  return resolveWorkOpaqueField(model, row, field, context);
};
export const WORK_FILE_REFERENCE_PRODUCER: FrameworkFileReferenceProducer = Object.freeze({ models, validateRow, resolveOpaqueField });
