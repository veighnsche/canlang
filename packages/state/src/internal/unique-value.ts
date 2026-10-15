/** Shared field-directed uniqueness for canonical user wires and legacy scalars. */
import { getUniqueGroupProfile, type InterimModelDef, type ModelTable, type InterimFieldDef } from '../mutation/models.js';
import { decodeValue, isUserRef, isRecordRef } from '@canlang/values';
import { StateError } from '../errors.js';
import type { StoredRow } from '@canlang/contracts';
import { evalPredicateForRow } from '../policy/grants.js';

export function canonicalUniqueFieldValue(value: unknown, key: string, model: string,
  field?: InterimFieldDef): string | null {
  if (value === null || value === undefined) return null;
  if (field?.array === undefined && (field?.valueType === 'user' || field?.valueType === 'user?')) {
    const invalid = (): never => { throw new StateError('validation',
      `Unique field ${JSON.stringify(key)} on model ${JSON.stringify(model)} must be a canonical user value.`); };
    if (typeof value !== 'object' || Array.isArray(value)) return invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== 'id') return invalid();
    const id = Object.getOwnPropertyDescriptor(value, 'id');
    if (id === undefined || !('value' in id) || !id.enumerable) return invalid();
    try {
      const decoded = decodeValue('user', { id: id.value });
      if (!isUserRef(decoded)) return invalid();
      return decoded.id;
    } catch { return invalid(); }
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  throw new StateError('validation',
    `Unique field ${JSON.stringify(key)} on model ${JSON.stringify(model)} must be a scalar value.`);
}

/** Conditions are table-checked local data predicates, never metadata paths. */
export function canonicalUniqueRowValue(row: Pick<StoredRow, 'data' | 'parent'>, key: string,
  def: InterimModelDef): string | null {
  const when = def.uniqueWhen?.[key];
  if (when !== undefined && !evalPredicateForRow(when, row as StoredRow)) return null;
  const group = getUniqueGroupProfile(def, key);
  if (group === undefined) {
    if (key.includes(',')) throw new StateError('validation', 'Composite unique lacks its checked table profile.');
    const value = canonicalUniqueFieldValue(row.data[key], key, def.model, def.fields[key]);
    return canonicalUniqueScopeValue(row, value, def);
  }
  const invalid = (): never => {throw new StateError('validation', `Invalid composite unique ${key} on ${def.model}.`);};
  const read = (name: string): unknown => {
    const d = Object.getOwnPropertyDescriptor(row.data, name);
    if (d === undefined || !d.enumerable || !('value' in d)) return invalid();
    return d.value;
  };
  const ref = read(group.fields[0]), role = read(group.fields[1]);
  if (group.kind === 'user-enum') {
    const id = canonicalUniqueFieldValue(ref, group.fields[0], def.model, def.fields[group.fields[0]]);
    if (id === null || typeof role !== 'string' || !group.cases.includes(role)) return invalid();
    const parent = def.containment?.parent === undefined ? null : uniqueParentScope(row, def);
    return JSON.stringify(['user-enum', parent, 'user', id, role]);
  }
  if (typeof ref !== 'object' || ref === null || Array.isArray(ref) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(ref))) return invalid();
  const keys = Reflect.ownKeys(ref);
  if (!keys.includes('id') || keys.some(key => key !== 'id' && key !== 'version')) return invalid();
  const wire: Record<string, unknown> = {};
  for (const name of keys) {
    const d = Object.getOwnPropertyDescriptor(ref, name);
    if (typeof name !== 'string' || d === undefined || !d.enumerable || !('value' in d)) return invalid();
    wire[name] = d.value;
  }
  let id: string;
  try {
    const decoded = decodeValue(group.refModel, wire);
    if (!isRecordRef(decoded) || decoded.model !== group.refModel ||
        Object.hasOwn(wire, 'version') && (decoded.version === undefined || decoded.version < 1n || decoded.version.toString() !== wire.version)) return invalid();
    id = decoded.id;
  } catch {return invalid();}
  if (typeof role !== 'string' || !group.cases.includes(role)) return invalid();
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
