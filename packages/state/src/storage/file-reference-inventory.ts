import type { FrameworkFileReferenceField as Field, FrameworkFileReferenceModel,
  FrameworkFileReferenceProducer, ModelName, StoredRow } from '@canlang/contracts';
import { StateError } from '../errors.js';
import { RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL, readAssociationRow, readReceiptRow,
  type AssociationRowData, type ReceiptRowData } from '../receipt/tables.js';
import { FANOUT_NAVIGATION_MODEL, FANOUT_OWNER_SCAN_MODEL, fanoutNavigationRowId,
  readFanoutOwnerScanRow, type FanoutNavigationData, type FanoutOwnerScanData } from '../fanout/navigation.js';
import { fanoutIntentRowId, fanoutChildRowId } from '../fanout/tables.js';

const string = Object.freeze({ kind: 'control', value: 'string' } as const);
const number = Object.freeze({ kind: 'control', value: 'number' } as const);
const nullableString = Object.freeze({ ...string, nullable: true } as const);
const nullableNumber = Object.freeze({ ...number, nullable: true } as const);
const result = Object.freeze({ kind: 'opaque', role: 'retained-result' } as const);
const deferred = Object.freeze({ kind: 'opaque', role: 'deferred-input' } as const);
type Fields<T> = { readonly [K in keyof T]-?: Field };
const association = { recordModel: string, recordId: string, field: string,
  deliveryId: string, source: string, revision: number } satisfies Fields<AssociationRowData>;
const receipt = { deliveryId: string, revision: number, status: string, result,
  error: result, contentRef: nullableString, resultExpiresAtMs: nullableNumber } satisfies Fields<ReceiptRowData>;
const navigation = { owner: string, fanoutId: string, sourceOccurrence: string,
  handler: string, cohort: string, intentVersion: number,
  lastVisitedChildId: nullableString } satisfies Fields<FanoutNavigationData>;
const ownerScan = { owner: string, lastVisitedIntentId: nullableString } satisfies Fields<FanoutOwnerScanData>;

const models: readonly FrameworkFileReferenceModel[] = Object.freeze([
  [RECEIPT_ASSOCIATION_MODEL, association, 'receipt/tables', 'AssociationRowData'],
  [RECEIPT_MODEL, receipt, 'receipt/tables', 'ReceiptRowData'],
  [FANOUT_NAVIGATION_MODEL, navigation, 'fanout/navigation', 'FanoutNavigationData'],
  [FANOUT_OWNER_SCAN_MODEL, ownerScan, 'fanout/navigation', 'FanoutOwnerScanData'],
].map(([model, fields, module, declaration]) => Object.freeze({ model: model as ModelName,
  source: Object.freeze({ package: '@canlang/state', module: module as string, export: declaration as string }),
  fields: Object.freeze(fields as Readonly<Record<string, Field>>) })));

function invalid(message: string): never { throw new StateError('validation', `State File inventory: ${message}`); }

/** Detached bounded JSON data only; inspect descriptors before reading values. */
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
    const out: Record<string, unknown> | unknown[] = array ? [] : {};
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor) ||
          !descriptor.enumerable || array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= node.length)) {
        return invalid('enumerable own data properties required.');
      }
      // StoredRow's pre-S5 parent omission/undefined means no parent.
      const member = depth === 0 && key === 'parent' && descriptor.value === undefined ? null :
        copy(descriptor.value, depth + 1);
      Object.defineProperty(out, key, { value: member,
        enumerable: true, writable: true, configurable: true });
    }
    active.delete(node);
    return out;
  };
  return copy(value, 0);
}

function closed(value: unknown, fields: Readonly<Record<string, Field>>): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid('object required.');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !Object.hasOwn(fields, key))) return invalid('unknown field.');
  for (const [key, field] of Object.entries(fields)) {
    if (!Object.hasOwn(data, key)) {
      if (field.kind === 'control' && field.optional === true) continue;
      return invalid(`missing ${key}.`);
    }
    const member = data[key];
    if (field.kind === 'opaque') continue;
    if (member === null && field.nullable === true) continue;
    if (field.value === 'string-array' ? !Array.isArray(member) || member.some(item => typeof item !== 'string') :
        typeof member !== field.value || field.value === 'number' && !Number.isFinite(member)) return invalid(`invalid ${key}.`);
  }
  return data;
}

/** Intrinsic shape only: membership and retained intent authority require the actual owning join. */
function validateNavigation(row: StoredRow): void {
  const data = row.data as unknown as FanoutNavigationData;
  if (row.archivedAt !== null || row.parent !== null ||
      !Number.isSafeInteger(row.version) || !Number.isSafeInteger(data.intentVersion) || data.intentVersion < 1 ||
      data.owner === '' || data.sourceOccurrence === '' || data.handler === '' ||
      (data.cohort !== 'model' && data.cohort !== 'anchored-collection') ||
      data.fanoutId !== fanoutIntentRowId(data.sourceOccurrence, data.handler, data.cohort) ||
      row.id !== fanoutNavigationRowId(data.owner, data.fanoutId)) return invalid('navigation identity.');
  if (data.lastVisitedChildId !== null) {
    try {
      const parts = data.lastVisitedChildId.split('/');
      if (parts.length !== 5 || data.lastVisitedChildId !== fanoutChildRowId(
        data.sourceOccurrence, data.handler, decodeURIComponent(parts[4]!))) return invalid('navigation child position.');
    } catch { return invalid('navigation child position.'); }
  }
}

/** Shape validation grants no File-free proof, payload closure, owner, or cross-row authority. */
function validateRow(model: ModelName, value: StoredRow): void {
  const declaration = models.find(candidate => candidate.model === model);
  if (declaration === undefined) return invalid('unknown exact model.');
  const copied = copyJson(value) as Record<string, unknown>;
  if (typeof copied === 'object' && copied !== null && !Object.hasOwn(copied, 'parent')) copied.parent = null;
  const row = closed(copied, { id: string, version: number, created: number, updated: number,
    createdBy: string, updatedBy: string, archivedAt: nullableNumber, parent: deferred, data: deferred });
  if (row.id === '' || row.createdBy === '' || row.updatedBy === '' ||
      !Number.isInteger(row.version) || (row.version as number) < 1 ||
      (row.created as number) < 0 || (row.updated as number) < 0 ||
      row.archivedAt !== null && (row.archivedAt as number) < 0) return invalid('invalid row metadata.');
  if (row.parent !== null) closed(row.parent, { model: string, id: string });
  const data = closed(row.data, declaration.fields), stored = row as unknown as StoredRow;
  switch (model) {
    case RECEIPT_ASSOCIATION_MODEL: readAssociationRow(stored); break;
    case RECEIPT_MODEL: readReceiptRow(stored); break;
    case FANOUT_NAVIGATION_MODEL: validateNavigation(stored); break;
    case FANOUT_OWNER_SCAN_MODEL: readFanoutOwnerScanRow(stored, data.owner as string); break;
  }
}

export const STATE_FILE_REFERENCE_PRODUCER: FrameworkFileReferenceProducer = Object.freeze({ models, validateRow });
