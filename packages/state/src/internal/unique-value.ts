/** Shared field-directed uniqueness for canonical user wires and legacy scalars. */
import { getUniqueGroupProfile, type InterimModelDef, type ModelTable, type InterimFieldDef,
  type UniqueGroupProfile } from '../mutation/models.js';
import { decodeValue, isUserRef, isRecordRef } from '@canlang/values';
import { StateError } from '../errors.js';
import type { StoredRow } from '@canlang/contracts';
import { evalPredicateForRow } from '../policy/grants.js';

function throwInvalidUniqueUser(key: string, model: string): never {
  throw new StateError('validation',
    `Unique field ${JSON.stringify(key)} on model ${JSON.stringify(model)} must be a canonical user value.`);
}

function throwInvalidCompositeUnique(key: string, model: string): never {
  throw new StateError('validation', `Invalid composite unique ${key} on ${model}.`);
}

/** Single-id canonical user wire; any other shape refuses. Non-null is a caller precondition. */
function canonicalUserFieldValue(value: {}, key: string, model: string): string {
  if (typeof value !== 'object' || Array.isArray(value)) return throwInvalidUniqueUser(key, model);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return throwInvalidUniqueUser(key, model);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== 'id') return throwInvalidUniqueUser(key, model);
  const id = Object.getOwnPropertyDescriptor(value, 'id');
  if (id === undefined || !('value' in id) || !id.enumerable) return throwInvalidUniqueUser(key, model);
  try {
    const decoded = decodeValue('user', { id: id.value });
    if (!isUserRef(decoded)) return throwInvalidUniqueUser(key, model);
    return decoded.id;
  } catch { return throwInvalidUniqueUser(key, model); }
}

export function canonicalUniqueFieldValue(value: unknown, key: string, model: string,
  field?: InterimFieldDef): string | null {
  if (value === null || value === undefined) return null;
  if (field?.array === undefined && (field?.valueType === 'user' || field?.valueType === 'user?')) {
    return canonicalUserFieldValue(value, key, model);
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  throw new StateError('validation',
    `Unique field ${JSON.stringify(key)} on model ${JSON.stringify(model)} must be a scalar value.`);
}

/** A declared singular reference claims entity identity, independent of version. */
function canonicalReferenceFieldValue(value: unknown, key: string, model: string, target: string): string | null {
  if (value === null || value === undefined) return null;
  const invalid = (): never => { throw new StateError('validation',
    `Unique field ${JSON.stringify(key)} on model ${JSON.stringify(model)} must be a canonical ${target} reference.`); };
  if (typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const keys = Reflect.ownKeys(value), wire: Record<string, unknown> = {};
  if (!keys.includes('id') || keys.some(key => key !== 'id' && key !== 'version')) return invalid();
  for (const name of keys) {
    const slot = Object.getOwnPropertyDescriptor(value, name);
    if (typeof name !== 'string' || slot === undefined || !slot.enumerable || !('value' in slot)) return invalid();
    wire[name] = slot.value;
  }
  try {
    const decoded = decodeValue(target, wire);
    if (!isRecordRef(decoded) || decoded.model !== target || Object.hasOwn(wire, 'version') &&
        (decoded.version === undefined || decoded.version < 1n || decoded.version.toString() !== wire.version)) return invalid();
    return JSON.stringify(['ref', target, decoded.id]);
  } catch { return invalid(); }
}

/** Conditions are table-checked local data predicates, never metadata paths. */
export function canonicalUniqueRowValue(row: Pick<StoredRow, 'data' | 'parent'>, key: string,
  def: InterimModelDef): string | null {
  const when = def.uniqueWhen?.[key];
  if (when !== undefined && !evalPredicateForRow(when, row as StoredRow)) return null;
  const group = getUniqueGroupProfile(def, key);
  if (group === undefined) {
    if (key.includes(',')) throw new StateError('validation', 'Composite unique lacks its checked table profile.');
    const field = def.fields[key], reference = def.refs.find(reference => reference.field === key);
    // Both the owning reference declaration and its exact singular Values
    // codec are required. A nominal Contract or structural {id} field cannot
    // borrow this identity key, and an array never becomes a singular claim.
    const typedReference = reference !== undefined && field !== undefined && field.array === undefined &&
      field.valueType === `${reference.model}${field.nullable === true ? '?' : ''}`;
    const value = typedReference
      ? canonicalReferenceFieldValue(row.data[key], key, def.model, reference.model)
      : canonicalUniqueFieldValue(row.data[key], key, def.model, field);
    return canonicalUniqueScopeValue(row, value, def);
  }
  const ref = compositeFieldValue(row.data, group.fields[0], key, def.model),
    role = compositeFieldValue(row.data, group.fields[1], key, def.model);
  if (group.kind === 'int-text') return intTextUniqueValue(ref, role, group, row, def);
  if (group.kind === 'leave-year-bucket') return leaveYearBucketUniqueValue(ref, role, row, def);
  if (group.kind === 'text-text' || group.kind === 'refer-settlement-payment-reference') {
    return textTextUniqueValue(ref, role, group, row, def);
  }
  if (group.kind === 'user-enum') return userEnumUniqueValue(ref, role, group, row, def);
  return refEnumUniqueValue(ref, role, group, row, def);
}

/** Exact ordered scalar slots, after the table owns both nonnullable codecs. */
function intTextUniqueValue(integerWire: unknown, textWire: unknown,
  group: Extract<UniqueGroupProfile, { kind: 'int-text' }>,
  row: Pick<StoredRow, 'data' | 'parent'>, def: InterimModelDef): string {
  let integer: bigint, text: string;
  try {
    integer = decodeValue('int', integerWire) as bigint;
    text = decodeValue('text', textWire) as string;
  } catch { return throwInvalidCompositeUnique(group.fields.join(','), def.model); }
  if (typeof integer !== 'bigint' || typeof text !== 'string') {
    return throwInvalidCompositeUnique(group.fields.join(','), def.model);
  }
  const parent = def.containment?.parent === undefined ? null : uniqueParentScope(row, def);
  return JSON.stringify(['int-text', parent, integer.toString(), text]);
}

function leaveYearBucketUniqueValue(yearWire: unknown, bucketWire: unknown,
  row: Pick<StoredRow, 'data' | 'parent'>, def: InterimModelDef): string {
  let year: bigint, bucket: string;
  try {
    year = decodeValue('int', yearWire) as bigint;
    bucket = decodeValue('text', bucketWire) as string;
  } catch { return throwInvalidCompositeUnique('year,bucket', def.model); }
  if (typeof bucket !== 'string') return throwInvalidCompositeUnique('year,bucket', def.model);
  return JSON.stringify(['leave-year-bucket', uniqueParentScope(row, def), year.toString(), bucket]);
}

function textTextUniqueValue(paymentWire: unknown, referenceWire: unknown,
  group: Extract<UniqueGroupProfile, { kind: 'text-text' | 'refer-settlement-payment-reference' }>,
  row: Pick<StoredRow, 'data' | 'parent'>, def: InterimModelDef): string {
  let payment: string, reference: string;
  try {
    payment = decodeValue('text', paymentWire) as string;
    reference = decodeValue('text', referenceWire) as string;
  } catch { return throwInvalidCompositeUnique(group.fields.join(','), def.model); }
  if (typeof payment !== 'string' || typeof reference !== 'string') {
    return throwInvalidCompositeUnique(group.fields.join(','), def.model);
  }
  const parent = def.containment?.parent === undefined ? null : uniqueParentScope(row, def);
  return JSON.stringify([group.kind, parent, payment, reference]);
}

/** Conditions are table-checked local data predicates, never metadata paths. */
function compositeFieldValue(data: Readonly<Record<string, unknown>>, name: string, key: string,
  model: string): unknown {
  const d = Object.getOwnPropertyDescriptor(data, name);
  if (d === undefined || !d.enumerable || !('value' in d)) return throwInvalidCompositeUnique(key, model);
  return d.value;
}

/** User-enum tuples bind one canonical user id with a declared case. */
function userEnumUniqueValue(ref: unknown, role: unknown, group: Extract<UniqueGroupProfile, { kind: 'user-enum' }>,
  row: Pick<StoredRow, 'data' | 'parent'>, def: InterimModelDef): string {
  const key = group.fields.join(',');
  const id = canonicalUniqueFieldValue(ref, group.fields[0], def.model, def.fields[group.fields[0]]);
  if (id === null || typeof role !== 'string' || !group.cases.includes(role)) {
    return throwInvalidCompositeUnique(key, def.model);
  }
  const parent = def.containment?.parent === undefined ? null : uniqueParentScope(row, def);
  return JSON.stringify(['user-enum', parent, 'user', id, role]);
}

/** Id/version-only wires copy by value; anything else refuses. */
function checkedCompositeWire(ref: object, key: string, model: string): Record<string, unknown> {
  const keys = Reflect.ownKeys(ref);
  if (!keys.includes('id') || keys.some(name => name !== 'id' && name !== 'version')) {
    return throwInvalidCompositeUnique(key, model);
  }
  const wire: Record<string, unknown> = {};
  for (const name of keys) {
    const d = Object.getOwnPropertyDescriptor(ref, name);
    if (typeof name !== 'string' || d === undefined || !d.enumerable || !('value' in d)) {
      return throwInvalidCompositeUnique(key, model);
    }
    wire[name] = d.value;
  }
  return wire;
}

/** Reference-enum tuples bind one record reference with a declared case. */
function refEnumUniqueValue(ref: unknown, role: unknown, group: Extract<UniqueGroupProfile, { kind: 'ref-enum' }>,
  row: Pick<StoredRow, 'data' | 'parent'>, def: InterimModelDef): string {
  const key = group.fields.join(',');
  if (typeof ref !== 'object' || ref === null || Array.isArray(ref) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(ref))) {
    return throwInvalidCompositeUnique(key, def.model);
  }
  const wire = checkedCompositeWire(ref, key, def.model);
  let id: string;
  try {
    const decoded = decodeValue(group.refModel, wire);
    if (!isRecordRef(decoded) || decoded.model !== group.refModel ||
        Object.hasOwn(wire, 'version') && (decoded.version === undefined || decoded.version < 1n || decoded.version.toString() !== wire.version)) {
      return throwInvalidCompositeUnique(key, def.model);
    }
    id = decoded.id;
  } catch {return throwInvalidCompositeUnique(key, def.model);}
  if (typeof role !== 'string' || !group.cases.includes(role)) {
    return throwInvalidCompositeUnique(key, def.model);
  }
  const parent = def.containment?.parent === undefined ? null : uniqueParentScope(row, def);
  // Typed JSON slots are collision-free; reference versions do not alter identity.
  return JSON.stringify(['ref-enum', parent, group.refModel, id, role]);
}

/** Shared scalar/computed claim scope; root namespaces retain their exact keys. */
export function canonicalUniqueScopeValue(row: Pick<StoredRow, 'parent'>, value: string | null,
  def: Pick<InterimModelDef, 'model' | 'containment'>): string | null {
  if (value === null || def.containment?.parent === undefined) return value;
  return JSON.stringify(['field', uniqueParentScope(row, def), value]);
}

/** Scope comes only from the declared containment and actual stored metadata. */
function uniqueParentScope(row: Pick<StoredRow, 'parent'>, def: Pick<InterimModelDef, 'model' | 'containment'>): readonly string[] {
  if (row.parent == null || row.parent.model !== def.containment?.parent ||
      typeof row.parent.id !== 'string' || row.parent.id === '') {
    throw new StateError('validation', `Unique key on ${def.model} requires its actual declared parent.`);
  }
  return [row.parent.model, row.parent.id];
}

/** Frozen migration schema identity cannot yet retain the source group census.
 * Refuse before scanning/publishing rather than silently losing tuple claims. */
export function assertMigrationUniqueSupported(...tables: readonly ModelTable[]): void {
  for (const table of tables) for (const def of table.values()) {
    if (def.uniqueGroups !== undefined && def.uniqueGroups.length !== 0 || def.uniqueKeys.some(key => key.includes(','))) {
      throw new StateError('validation', 'Composite unique migration requires a checked source group census in migration schema identity.');
    }
  }
}
