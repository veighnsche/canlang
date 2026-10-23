/** Shared typed record ordering, after the caller performs policy and field checks. */
import type { CanonicalModelDescriptor, ModelName, OrderTerm, ProjectedRecord, StoredRow } from '@canlang/contracts';
import { compareInt, compareDecimal, compareMoney, compareDate, compareInstant, decodeValue, SchemaError, ValueError, type Decimal, type MoneyValue, type DateValue, type DatetimeValue } from '@canlang/values';
import { StateError } from '../errors.js';
import { isMetadataPath, resolveRowPath } from '../policy/grants.js';
/** Default scan/sort order when the caller passes no explicit order. */
export const DEFAULT_ORDER: ReadonlyArray<OrderTerm> = [{ field: 'created', direction: 'asc' }];

export type TypedOrderType = 'int' | 'decimal' | 'money' | 'date' | 'datetime';
type TypedOrderValue = bigint | Decimal | MoneyValue | DateValue | DatetimeValue | null | undefined;
interface TypedOrderField {
  readonly type: TypedOrderType;
  readonly values: ReadonlyMap<StoredRow, TypedOrderValue>;
}

/** Select only declared numeric and temporal scalar fields; containers have no scalar ordering. */
export function typedOrderTypes(
  descriptor: CanonicalModelDescriptor | undefined,
  model: ModelName,
  terms: ReadonlyArray<OrderTerm>,
): { readonly types: ReadonlyMap<string, TypedOrderType>; readonly arrays: ReadonlyArray<string> } {
  const types = new Map<string, TypedOrderType>();
  const arrays: string[] = [];
  if (descriptor === undefined || descriptor.name !== model) return { types, arrays };
  for (const term of terms) {
    if (isMetadataPath(term.field) || !Object.hasOwn(descriptor.fields, term.field)) continue;
    const field = descriptor.fields[term.field]!;
    const type = field.valueType;
    if (type === undefined || !/^(int|decimal|money|date|datetime)(\[\])?\??$/.test(type)) continue;
    if (field.array !== undefined || type.includes('[]')) {
      arrays.push(term.field);
      continue;
    }
    types.set(term.field, type.replace(/\?$/, '') as TypedOrderType);
  }
  return { types, arrays };
}

/** Decode projected values once, including singleton results; keep existing null/missing order. */
export function decodeTypedOrder(
  rows: ReadonlyArray<StoredRow>,
  types: ReadonlyMap<string, TypedOrderType>,
): ReadonlyMap<string, TypedOrderField> {
  const fields = new Map<string, TypedOrderField>();
  for (const [field, type] of types) {
    const values = new Map<StoredRow, TypedOrderValue>();
    for (const row of rows) {
      const wire = resolveRowPath(row, field);
      try {
        values.set(row, wire === null || wire === undefined ? wire :
          decodeValue(type, wire) as TypedOrderValue);
      } catch (error) {
        if (!(error instanceof SchemaError) && !(error instanceof ValueError)) throw error;
        throw new StateError('validation', `Query order field ${JSON.stringify(field)} has an invalid ${type} wire value: ${error.message}.`);
      }
    }
    fields.set(field, { type, values });
  }
  return fields;
}

/** Values owns exact numeric/temporal comparison and incompatible money currency refusal. */
function compareTypedOrder(type: TypedOrderType, a: TypedOrderValue, b: TypedOrderValue): number {
  switch (type) {
    case 'int': return compareInt(a as bigint, b as bigint);
    case 'decimal': return compareDecimal(a as Decimal, b as Decimal);
    case 'money': return compareMoney(a as MoneyValue, b as MoneyValue);
    case 'date': return compareDate(a as DateValue, b as DateValue);
    case 'datetime': return compareInstant(a as DatetimeValue, b as DatetimeValue);
  }
}

/**
 * Values compares declared numeric/temporal fields; all other fields retain storage
 * semantics (NULLs first in ASC, numbers before strings, booleans as 1/0).
 * The engine reapplies the caller's terms and an id ASC tiebreak uniformly,
 * independently of the backend's scan order.
 */
/** Typed, numeric, textual or ranked comparison for one non-null pair. */
function compareOrderValues(
  field: TypedOrderField | undefined,
  termField: string,
  a: unknown,
  b: unknown,
): number {
  if (field !== undefined) {
    try {
      return compareTypedOrder(field.type, a as TypedOrderValue, b as TypedOrderValue);
    } catch (error) {
      if (!(error instanceof ValueError)) throw error;
      throw new StateError('validation', `Query order field ${JSON.stringify(termField)} cannot be compared: ${error.message}.`);
    }
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  if (typeof a === typeof b) {
    return 0;
  }
  const rankA = typeof a === 'number' ? 0 : typeof a === 'string' ? 1 : 2;
  const rankB = typeof b === 'number' ? 0 : typeof b === 'string' ? 1 : 2;
  return rankA < rankB ? -1 : 1;
}

/** One order term: nulls first, then the typed comparison with direction. */
function compareOneOrderTerm(
  left: StoredRow,
  right: StoredRow,
  term: OrderTerm,
  numeric: ReadonlyMap<string, TypedOrderField>,
): number {
  const field = numeric.get(term.field);
  const rawA = field === undefined ? resolveRowPath(left, term.field) : field.values.get(left);
  const rawB = field === undefined ? resolveRowPath(right, term.field) : field.values.get(right);
  const a = typeof rawA === 'boolean' ? (rawA ? 1 : 0) : rawA;
  const b = typeof rawB === 'boolean' ? (rawB ? 1 : 0) : rawB;
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  const compared = aNull || bNull ? (aNull && bNull ? 0 : aNull ? -1 : 1) : compareOrderValues(field, term.field, a, b);
  return term.direction === 'desc' ? -compared : compared;
}

export function compareRowsForOrder(
  left: StoredRow,
  right: StoredRow,
  terms: ReadonlyArray<OrderTerm>,
  numeric: ReadonlyMap<string, TypedOrderField>,
): number {
  for (const term of terms) {
    const compared = compareOneOrderTerm(left, right, term, numeric);
    if (compared !== 0) {
      return compared;
    }
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

/** Private native source consumer, after its original where and lazy field
 * checks. Reuse the engine's exact typed order and id tie break. */
export function orderSourceReadRecords(records: readonly ProjectedRecord[], model: CanonicalModelDescriptor,
  order: readonly OrderTerm[] = DEFAULT_ORDER): readonly ProjectedRecord[] {
  if (order.some(term => typeof term.field !== 'string' || !['asc', 'desc'].includes(term.direction))) {
    throw new StateError('validation', 'Source query requires its checked field order.');
  }
  const types = typedOrderTypes(model, model.name, order);
  if (types.arrays.length !== 0) throw new StateError('validation', 'Source query order requires singular fields.');
  const rows = [...records];
  const numeric = decodeTypedOrder(rows, types.types);
  rows.sort((left, right) => compareRowsForOrder(left, right, order, numeric));
  return Object.freeze(rows);
}
