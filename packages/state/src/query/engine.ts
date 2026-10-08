/**
 * Lane 03 S4: authorized record query and aggregate engine.
 *
 * Viewers see only rows matching at least one grant, with `data` projected
 * along the union of their matching grants' paths; owners read full stored
 * rows. Every read scans unbounded from storage (correctness over streaming),
 * filters and sorts in memory, fails on limit overflow instead of truncating,
 * and reports the pre-scan fence revision.
 */

import type {
  AggregateOp,
  AggregateResult,
  AggregateSpec,
  AuthorityRowsResult,
  AuthorizedRecordsResult,
  CanonicalModelDescriptor,
  ModelName,
  OrderTerm,
  ProjectedRecord,
  QueryPredicate,
  QuerySpec,
  ReadAuthority,
  Revision,
  StoredRow,
} from '@canlang/contracts';
import {
  compareInt, compareDecimal, compareMoney, decodeValue, SchemaError, ValueError,
  type Decimal, type MoneyValue,
} from '@canlang/values';
import type { StoragePort } from '../storage/port.js';
import { StateError } from '../errors.js';
import type { FenceScope } from '../invocation/admission.js';
import { evaluateBy, type MembershipReader } from '../policy/roles.js';
import {
  collectPredicateFields,
  evalPredicateForRow,
  isEqualOrUnder,
  isMetadataPath,
  isSecretValue,
  resolveRowPath,
  validatePredicateShape,
  type ByContext,
  type InterimGrant,
  type InterimModelPolicy,
  type PolicyTable,
} from '../policy/grants.js';

/** Caller identity for viewer authorization; nulls mean unauthenticated. */
export interface QueryCallerContext {
  readonly actorUserId: string | null;
  readonly teamId: string | null;
}

/** Shared authorized-query input: viewer and owner differ by `authority`. */
export interface BaseQueryInput {
  readonly policy: PolicyTable;
  readonly model: ModelName;
  /** Checked owning declaration from trusted host wiring; never selection/JSON input. */
  readonly modelDescriptor?: CanonicalModelDescriptor;
  readonly where?: QueryPredicate;
  readonly order?: ReadonlyArray<OrderTerm>;
  readonly limit?: number;
  readonly archived?: 'exclude' | 'include';
  readonly authority: ReadAuthority;
  readonly context: QueryCallerContext;
  readonly memberships: MembershipReader;
  readonly store: StoragePort;
  /**
   * T32b: the operation's enrollment scope. When present, the query joins
   * the scope's owner checkpoint (conflicting when the checkpoint already
   * moved) and enrolls its membership + model reads; when absent, the
   * query still reports the pre-scan fence revision, and the
   * database-wide revision assertion at commit covers the read. There is
   * no `eventual` member here by design: eventual reads serve ONLY
   * through `queryEventualRecords`, whose marked wrapper can never feed
   * authorization.
   */
  readonly fence?: FenceScope;
}

/** Viewer query input: grant-checked, projected records. */
export interface ViewerRecordsInput extends BaseQueryInput {
  readonly authority: 'viewer';
  /**
   * Trusted internal generated-source wiring only, never JSON/user input.
   * Receives a detached snapshot after per-row grant projection and AST
   * where, before sorting/limit. Source conversion and final authority
   * rechecks belong to the owning caller; this hook grants no capability.
   */
  readonly predicate?: (record: Readonly<ProjectedRecord>) => boolean | Promise<boolean>;
}

/** Owner query input: full stored rows, no projection. */
export interface OwnerRecordsInput extends BaseQueryInput {
  readonly authority: 'owner';
}

/** Record query input, narrowed by authority via the `queryRecords` overloads. */
export type QueryRecordsInput = ViewerRecordsInput | OwnerRecordsInput;

/** Aggregate input: a record query plus the aggregate to compute. */
export interface QueryAggregateInput extends BaseQueryInput {
  readonly spec: AggregateSpec;
}

/** Aggregate outcome: the computed result at a fence revision. */
export interface AggregateQueryResult {
  readonly result: AggregateResult;
  readonly revision: Revision;
}

/** Default scan/sort order when the caller passes no explicit order. */
const DEFAULT_ORDER: ReadonlyArray<OrderTerm> = [{ field: 'created', direction: 'asc' }];

/**
 * Engine metadata names that map to real storage columns. Storage names the
 * archive column `archived_at`; `createdBy`/`updatedBy` have no storage
 * mapping and always sort in memory.
 */
const STORAGE_COLUMNS: ReadonlyMap<string, string> = new Map([
  ['id', 'id'],
  ['version', 'version'],
  ['created', 'created'],
  ['updated', 'updated'],
  ['archivedAt', 'archived_at'],
]);

/** Single-segment data fields are the only other storage-safe order terms. */
const STORAGE_DATA_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Map the effective order to storage terms. Fully storage-safe orders pass
 * through; anything nested or unmapped falls back to the default scan order
 * and the engine sort below still applies the caller's order uniformly.
 */
function toStorageOrder(order: ReadonlyArray<OrderTerm>): ReadonlyArray<OrderTerm> {
  const mapped: OrderTerm[] = [];
  for (const term of order) {
    const column = STORAGE_COLUMNS.get(term.field);
    if (column !== undefined) {
      mapped.push({ field: column, direction: term.direction });
    } else if (STORAGE_DATA_FIELD.test(term.field)) {
      mapped.push(term);
    } else {
      return DEFAULT_ORDER;
    }
  }
  return mapped;
}

/**
 * Fail-closed viewer path check: metadata is always usable; data paths need
 * coverage by at least one by-satisfied grant and must never touch a secret
 * subtree (predicate evaluation on secrets would leak oracle bits).
 */
function checkViewerPath(
  path: string,
  grantedFields: ReadonlyArray<string>,
  secrets: ReadonlyArray<string>,
): void {
  if (typeof path !== 'string') {
    throw new StateError('validation', 'Query field paths must be strings.');
  }
  if (isMetadataPath(path)) {
    return;
  }
  for (const secret of secrets) {
    if (isEqualOrUnder(path, secret)) {
      throw new StateError(
        'validation',
        `Query path ${JSON.stringify(path)} is secret and cannot be used.`,
      );
    }
  }
  for (const granted of grantedFields) {
    if (isEqualOrUnder(path, granted)) {
      return;
    }
  }
  throw new StateError(
    'validation',
    `Query path ${JSON.stringify(path)} is not granted to this caller.`,
  );
}

/** Prototype-safe property definition for projected objects. */
function safeSet(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Sentinel marking a value (or subtree root) withheld from projection. */
const OMIT: unique symbol = Symbol('omit');

/**
 * Deep-copy a projected subtree, omitting secret-kind values anywhere inside.
 * Object keys are dropped; secret elements inside arrays are filtered out so
 * no leak reads as null.
 */
function cleanCopy(value: unknown): unknown {
  if (isSecretValue(value)) {
    return OMIT;
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const element of value) {
      const cleaned = cleanCopy(element);
      if (cleaned !== OMIT) {
        out.push(cleaned);
      }
    }
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const cleaned = cleanCopy(entry);
      if (cleaned !== OMIT) {
        safeSet(out, key, cleaned);
      }
    }
    return out;
  }
  return value;
}

/** Set a copy at a dot-path inside the projected object, creating parents. */
function setProjectedPath(
  root: Record<string, unknown>,
  segments: ReadonlyArray<string>,
  value: unknown,
): void {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const next = Object.hasOwn(current, segment) ? current[segment] : undefined;
    if (next === undefined) {
      const fresh: Record<string, unknown> = {};
      safeSet(current, segment, fresh);
      current = fresh;
    } else if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
      current = next as Record<string, unknown>;
    } else {
      return;
    }
  }
  const leaf = segments[segments.length - 1];
  if (leaf === undefined || Object.hasOwn(current, leaf)) {
    return;
  }
  safeSet(current, leaf, value);
}

/**
 * Delete a dot-path from the projected value when present. Arrays are
 * transparent: a declared secret under an array path is carved out of every
 * element, so parent-granted arrays cannot leak secret leaves.
 */
function deleteProjectedPath(node: unknown, segments: ReadonlyArray<string>): void {
  const head = segments[0];
  if (head === undefined) {
    return;
  }
  if (Array.isArray(node)) {
    for (const element of node) {
      deleteProjectedPath(element, segments);
    }
    return;
  }
  if (typeof node !== 'object' || node === null) {
    return;
  }
  const record = node as Record<string, unknown>;
  if (!Object.hasOwn(record, head)) {
    return;
  }
  if (segments.length === 1) {
    delete record[head];
    return;
  }
  deleteProjectedPath(record[head], segments.slice(1));
}

/**
 * Project one visible row: full metadata plus the partial `data` subtree
 * along the union of the row's matching grants. Secret subtrees are carved
 * out even when granted via a parent path, and secret-kind values are dropped
 * by `cleanCopy` even when their path was granted.
 */
function projectRow(
  row: StoredRow,
  grants: ReadonlyArray<InterimGrant>,
  secrets: ReadonlyArray<string>,
): ProjectedRecord {
  const data: Record<string, unknown> = {};
  // Widest paths first: setProjectedPath never overwrites an existing node,
  // so a narrower path projected first would shadow a wider grant's siblings
  // (e.g. `a.b` before `a` would drop `a.c`). Depth-ascending order keeps the
  // union complete regardless of grant order.
  const paths: string[] = [];
  for (const grant of grants) {
    paths.push(...grant.fields);
  }
  paths.sort((a, b) => a.split('.').length - b.split('.').length);
  for (const path of paths) {
    if (isMetadataPath(path)) {
      continue;
    }
    let hidden = false;
    for (const secret of secrets) {
      if (isEqualOrUnder(path, secret)) {
        hidden = true;
        break;
      }
    }
    if (hidden) {
      continue;
    }
    const value = resolveRowPath(row, path);
    if (value === undefined) {
      continue;
    }
    const cleaned = cleanCopy(value);
    if (cleaned === OMIT) {
      continue;
    }
    setProjectedPath(data, path.split('.'), cleaned);
  }
  for (const secret of secrets) {
    deleteProjectedPath(data, secret.split('.'));
  }
  return {
    id: row.id,
    version: row.version,
    created: row.created,
    updated: row.updated,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    archivedAt: row.archivedAt,
    // S5: parent passes through unprojected (linkage, not domain data).
    parent: row.parent ?? null,
    data,
  };
}

/** Shared actor and row matching for viewer queries and saved-row disclosure. */
async function viewerGrantAuthority(policy: InterimModelPolicy, context: ByContext): Promise<boolean[]> {
  const allowed: boolean[] = [];
  for (const grant of policy.grants) allowed.push(await evaluateBy(grant.by, context));
  return allowed;
}

function matchingViewerGrants(
  grants: ReadonlyArray<InterimGrant>, allowed: ReadonlyArray<boolean>, row: StoredRow,
): InterimGrant[] {
  return grants.filter((grant, index) => allowed[index] === true &&
    (grant.when === undefined || evalPredicateForRow(grant.when, row)));
}

/** Authorize against the live row; copy only the original saved row's values. */
export async function projectSavedRecordForViewer(input: {
  readonly policy: InterimModelPolicy | undefined;
  readonly context: ByContext;
  readonly current: StoredRow;
  readonly saved: StoredRow;
  readonly originalSecretFields: ReadonlyArray<string>;
}): Promise<ProjectedRecord | null> {
  if (input.policy === undefined) return null;
  const allowed = await viewerGrantAuthority(input.policy, input.context);
  const grants = matchingViewerGrants(input.policy.grants, allowed, input.current);
  return grants.length === 0 ? null : projectRow(input.saved, grants,
    [...input.originalSecretFields, ...input.policy.secretFields]);
}

type NumericOrderType = 'int' | 'decimal' | 'money';
type NumericOrderValue = bigint | Decimal | MoneyValue | null | undefined;
interface NumericOrderField {
  readonly type: NumericOrderType;
  readonly values: ReadonlyMap<StoredRow, NumericOrderValue>;
}

/** Select only declared numeric scalar fields; containers have no scalar ordering. */
function numericOrderTypes(
  descriptor: CanonicalModelDescriptor | undefined,
  model: ModelName,
  terms: ReadonlyArray<OrderTerm>,
): { readonly types: ReadonlyMap<string, NumericOrderType>; readonly arrays: ReadonlyArray<string> } {
  const types = new Map<string, NumericOrderType>();
  const arrays: string[] = [];
  if (descriptor === undefined || descriptor.name !== model) return { types, arrays };
  for (const term of terms) {
    if (isMetadataPath(term.field) || !Object.hasOwn(descriptor.fields, term.field)) continue;
    const field = descriptor.fields[term.field]!;
    const type = field.valueType;
    if (type === undefined || !/^(int|decimal|money)(\[\])?\??$/.test(type)) continue;
    if (field.array !== undefined || type.includes('[]')) {
      arrays.push(term.field);
      continue;
    }
    types.set(term.field, type.replace(/\?$/, '') as NumericOrderType);
  }
  return { types, arrays };
}

/** Decode projected values once, including singleton results; keep existing null/missing order. */
function decodeNumericOrder(
  rows: ReadonlyArray<StoredRow>,
  types: ReadonlyMap<string, NumericOrderType>,
): ReadonlyMap<string, NumericOrderField> {
  const fields = new Map<string, NumericOrderField>();
  for (const [field, type] of types) {
    const values = new Map<StoredRow, NumericOrderValue>();
    for (const row of rows) {
      const wire = resolveRowPath(row, field);
      try {
        values.set(row, wire === null || wire === undefined ? wire :
          decodeValue(type, wire) as NumericOrderValue);
      } catch (error) {
        if (!(error instanceof SchemaError) && !(error instanceof ValueError)) throw error;
        throw new StateError('validation', `Query order field ${JSON.stringify(field)} has an invalid ${type} wire value: ${error.message}.`);
      }
    }
    fields.set(field, { type, values });
  }
  return fields;
}

/** Values owns exact numeric comparison and incompatible money currency refusal. */
function compareNumericOrder(type: NumericOrderType, a: NumericOrderValue, b: NumericOrderValue): number {
  switch (type) {
    case 'int': return compareInt(a as bigint, b as bigint);
    case 'decimal': return compareDecimal(a as Decimal, b as Decimal);
    case 'money': return compareMoney(a as MoneyValue, b as MoneyValue);
  }
}

/**
 * Values compares declared numeric fields; all other fields retain storage
 * semantics (NULLs first in ASC, numbers before strings, booleans as 1/0).
 * The engine reapplies the caller's terms and an id ASC tiebreak uniformly,
 * independently of the backend's scan order.
 */
function compareRowsForOrder(
  left: StoredRow,
  right: StoredRow,
  terms: ReadonlyArray<OrderTerm>,
  numeric: ReadonlyMap<string, NumericOrderField>,
): number {
  for (const term of terms) {
    const field = numeric.get(term.field);
    const rawA = field === undefined ? resolveRowPath(left, term.field) : field.values.get(left);
    const rawB = field === undefined ? resolveRowPath(right, term.field) : field.values.get(right);
    const a = typeof rawA === 'boolean' ? (rawA ? 1 : 0) : rawA;
    const b = typeof rawB === 'boolean' ? (rawB ? 1 : 0) : rawB;
    const aNull = a === null || a === undefined;
    const bNull = b === null || b === undefined;
    let compared: number;
    if (aNull || bNull) {
      compared = aNull && bNull ? 0 : aNull ? -1 : 1;
    } else if (field !== undefined) {
      try {
        compared = compareNumericOrder(field.type, a as NumericOrderValue, b as NumericOrderValue);
      } catch (error) {
        if (!(error instanceof ValueError)) throw error;
        throw new StateError('validation', `Query order field ${JSON.stringify(term.field)} cannot be compared: ${error.message}.`);
      }
    } else if (typeof a === 'number' && typeof b === 'number') {
      compared = a === b ? 0 : a < b ? -1 : 1;
    } else if (typeof a === 'string' && typeof b === 'string') {
      compared = a === b ? 0 : a < b ? -1 : 1;
    } else if (typeof a === typeof b) {
      compared = 0;
    } else {
      const rankA = typeof a === 'number' ? 0 : typeof a === 'string' ? 1 : 2;
      const rankB = typeof b === 'number' ? 0 : typeof b === 'string' ? 1 : 2;
      compared = rankA < rankB ? -1 : 1;
    }
    if (compared !== 0) {
      return term.direction === 'desc' ? -compared : compared;
    }
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? -1 : 1;
}

/** True for stored money-shaped values (currency/minor checked by callers). */
function isMoneyShaped(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Readonly<Record<string, unknown>>)['kind'] === 'money'
  );
}

/**
 * Sum usable values: all numbers, or all money in one currency and one
 * minor-unit type. An empty set sums to 0 (the domain is unknowable with no
 * values, so the number-domain empty rule applies).
 */
function sumValues(field: string, values: ReadonlyArray<unknown>): unknown {
  let sawNumber = false;
  let numericTotal = 0;
  let sawMoney = false;
  let moneyNumTotal = 0;
  let moneyBigTotal = 0n;
  let moneyCurrency = '';
  let moneyMinorKind: 'number' | 'bigint' | null = null;
  for (const value of values) {
    if (typeof value === 'number') {
      if (sawMoney) {
        throw new StateError(
          'validation',
          `Cannot sum mixed numbers and money on ${JSON.stringify(field)}.`,
        );
      }
      sawNumber = true;
      numericTotal += value;
      continue;
    }
    if (isMoneyShaped(value)) {
      if (sawNumber) {
        throw new StateError(
          'validation',
          `Cannot sum mixed numbers and money on ${JSON.stringify(field)}.`,
        );
      }
      const record = value as Readonly<Record<string, unknown>>;
      const currency = record['currency'];
      const minor = record['minor'];
      if (typeof currency !== 'string' || currency === '') {
        throw new StateError(
          'validation',
          `Cannot sum money with no currency on ${JSON.stringify(field)}.`,
        );
      }
      if (typeof minor !== 'number' && typeof minor !== 'bigint') {
        throw new StateError(
          'validation',
          `Cannot sum money with unsupported minor units on ${JSON.stringify(field)}.`,
        );
      }
      if (sawMoney && moneyCurrency !== currency) {
        throw new StateError(
          'validation',
          `Cannot sum money in mixed currencies on ${JSON.stringify(field)}.`,
        );
      }
      const kind = typeof minor === 'bigint' ? 'bigint' : 'number';
      if (moneyMinorKind !== null && moneyMinorKind !== kind) {
        throw new StateError(
          'validation',
          `Cannot sum money with mixed minor-unit types on ${JSON.stringify(field)}.`,
        );
      }
      sawMoney = true;
      moneyCurrency = currency;
      moneyMinorKind = kind;
      if (kind === 'bigint') {
        moneyBigTotal += minor as bigint;
      } else {
        moneyNumTotal += minor as number;
      }
      continue;
    }
    throw new StateError(
      'validation',
      `Cannot sum non-numeric values on ${JSON.stringify(field)}.`,
    );
  }
  if (sawMoney) {
    return {
      kind: 'money',
      minor: moneyMinorKind === 'bigint' ? moneyBigTotal : moneyNumTotal,
      currency: moneyCurrency,
    };
  }
  return numericTotal;
}

/** Average usable values: numbers only, never empty, never money. */
function avgValues(field: string, values: ReadonlyArray<unknown>): number {
  let total = 0;
  let count = 0;
  for (const value of values) {
    if (isMoneyShaped(value)) {
      throw new StateError(
        'validation',
        `Cannot average money on ${JSON.stringify(field)}: no fractional minor units.`,
      );
    }
    if (typeof value !== 'number') {
      throw new StateError(
        'validation',
        `Cannot average non-numeric values on ${JSON.stringify(field)}.`,
      );
    }
    total += value;
    count += 1;
  }
  if (count === 0) {
    throw new StateError(
      'validation',
      `Cannot average an empty set on ${JSON.stringify(field)}.`,
    );
  }
  return total / count;
}

/**
 * Min/max usable values: all numbers, all strings, or all money in one
 * currency and one minor-unit type — never empty or mixed. Money compares by
 * minor units and returns the winning input value unchanged.
 */
function minMaxValues(op: 'min' | 'max', field: string, values: ReadonlyArray<unknown>): unknown {
  const mixed = (): StateError =>
    new StateError(
      'validation',
      `Cannot compute ${op} over mixed value types on ${JSON.stringify(field)}.`,
    );
  let bestNum: number | null = null;
  let bestStr: string | null = null;
  let bestMoney: { minor: number | bigint; value: unknown } | null = null;
  let moneyCurrency = '';
  let moneyMinorKind: 'number' | 'bigint' | null = null;
  const sawOther = (): boolean => bestNum !== null || bestStr !== null || bestMoney !== null;
  for (const value of values) {
    if (typeof value === 'number') {
      if (bestStr !== null || bestMoney !== null) {
        throw mixed();
      }
      bestNum = bestNum === null ? value : op === 'min' ? Math.min(bestNum, value) : Math.max(bestNum, value);
    } else if (typeof value === 'string') {
      if (sawOther() && bestStr === null) {
        throw mixed();
      }
      if (bestStr === null || (op === 'min' ? value < bestStr : value > bestStr)) {
        bestStr = value;
      }
    } else if (isMoneyShaped(value)) {
      if (sawOther() && bestMoney === null) {
        throw mixed();
      }
      const record = value as Readonly<Record<string, unknown>>;
      const currency = record['currency'];
      const minor = record['minor'];
      if (typeof currency !== 'string' || currency === '') {
        throw new StateError(
          'validation',
          `Cannot compute ${op} over money with no currency on ${JSON.stringify(field)}.`,
        );
      }
      if (typeof minor !== 'number' && typeof minor !== 'bigint') {
        throw new StateError(
          'validation',
          `Cannot compute ${op} over money with unsupported minor units on ${JSON.stringify(field)}.`,
        );
      }
      if (bestMoney !== null && moneyCurrency !== currency) {
        throw new StateError(
          'validation',
          `Cannot compute ${op} over money in mixed currencies on ${JSON.stringify(field)}.`,
        );
      }
      const kind = typeof minor === 'bigint' ? 'bigint' : 'number';
      if (moneyMinorKind !== null && moneyMinorKind !== kind) {
        throw new StateError(
          'validation',
          `Cannot compute ${op} over money with mixed minor-unit types on ${JSON.stringify(field)}.`,
        );
      }
      moneyCurrency = currency;
      moneyMinorKind = kind;
      if (bestMoney === null) {
        bestMoney = { minor, value };
      } else {
        const better =
          op === 'min'
            ? (minor as number | bigint) < bestMoney.minor
            : (minor as number | bigint) > bestMoney.minor;
        if (better) {
          bestMoney = { minor, value };
        }
      }
    } else {
      throw new StateError(
        'validation',
        `Cannot compute ${op} over non-numeric values on ${JSON.stringify(field)}.`,
      );
    }
  }
  if (bestNum !== null) {
    return bestNum;
  }
  if (bestStr !== null) {
    return bestStr;
  }
  if (bestMoney !== null) {
    return bestMoney.value;
  }
  throw new StateError('validation', `Cannot compute ${op} over an empty set on ${JSON.stringify(field)}.`);
}

/**
 * Post-visibility, post-where, sorted matched set. Viewer rows are already
 * projected (data holds only the row's matching grants), so downstream
 * filtering, sorting, and aggregation observe exactly what the caller may
 * see; owner rows are full stored rows.
 */
interface AuthorizedSet {
  readonly revision: Revision;
  readonly rows: StoredRow[];
}

/** Reinterpret a projected-shaped row as its viewer record. */
function toProjectedRecord(row: StoredRow): ProjectedRecord {
  return {
    id: row.id,
    version: row.version,
    created: row.created,
    updated: row.updated,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    archivedAt: row.archivedAt,
    // S5: parent passes through (`undefined` reads as null for pre-S5 rows).
    parent: row.parent ?? null,
    data: row.data,
  };
}

/** Reject host callbacks outside the finite viewer-record route. */
function checkViewerPredicate(
  input: BaseQueryInput,
  allowed: boolean,
): ViewerRecordsInput['predicate'] {
  const predicate = (input as ViewerRecordsInput).predicate;
  if (predicate === undefined) return undefined;
  if (!allowed || input.authority !== 'viewer') {
    throw new StateError('validation', 'Generated-source predicates require a current viewer record query.');
  }
  if (typeof predicate !== 'function') {
    throw new StateError('validation', 'Generated-source query predicate must be a trusted host function.');
  }
  return predicate;
}

/**
 * Shared record/aggregate pipeline: validate caller input, fence the
 * revision, resolve viewer authorization, scan unbounded, match and project
 * in memory (viewers project BEFORE where/sort so cross-grant values cannot
 * leak through predicates or aggregates), sort, then fail on limit overflow
 * (never truncate).
 */
async function runAuthorizedQuery(
  input: BaseQueryInput,
  extraViewerPaths?: ReadonlyArray<string>,
  // T32b: internal eventual flag — set ONLY by `queryEventualRecords`.
  // Eventual reads enroll nothing; their marked wrapper (not this flag)
  // is what authorization boundaries refuse.
  eventual = false,
  predicate?: ViewerRecordsInput['predicate'],
): Promise<AuthorizedSet> {
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 0)) {
    throw new StateError('validation', `Invalid query limit: ${JSON.stringify(input.limit)}.`);
  }
  const order = input.order ?? DEFAULT_ORDER;
  for (const term of order) {
    if (term.direction !== 'asc' && term.direction !== 'desc') {
      throw new StateError(
        'validation',
        `Invalid order direction: ${JSON.stringify(term.direction)}.`,
      );
    }
    if (typeof term.field !== 'string') {
      throw new StateError('validation', 'Order terms need a string field path.');
    }
  }
  if (input.where !== undefined) {
    validatePredicateShape(input.where);
  }
  // Copy only the selected scalar type claims before any asynchronous reads.
  const modelDescriptorMismatch = input.modelDescriptor !== undefined && input.modelDescriptor.name !== input.model;
  const numericTypes = numericOrderTypes(input.modelDescriptor, input.model, order);

  if (eventual && input.fence !== undefined) {
    throw new StateError(
      'validation',
      'Eventual reads cannot enroll in a fence; they are display-only.',
    );
  }

  // Fence revision FIRST: every row below is read at or after this checkpoint.
  const revision = await input.store.readRevision();

  // T32b: join the operation's owner checkpoint. A read whose checkpoint
  // already moved cannot enroll — it conflicts rather than silently
  // reading at a newer revision than the operation's other reads.
  if (input.fence !== undefined && input.fence.revision !== revision) {
    throw new StateError(
      'conflict',
      `Fence checkpoint moved before this read (enrolled at revision ${input.fence.revision}, ` +
        `now at ${revision}); re-fence the operation.`,
    );
  }
  if (input.fence !== undefined && !eventual) {
    input.fence.enroll({ kind: 'query', model: input.model, authority: input.authority });
  }

  // Viewer authorization: resolve the caller membership once, evaluate each
  // grant's row-independent `by` once, then fail closed on every viewer path
  // (where, order, aggregate field) before touching storage rows.
  let policy: InterimModelPolicy | null = null;
  let secrets: ReadonlyArray<string> = [];
  let grantByOk: ReadonlyArray<boolean> = [];
  let grantedFields: string[] = [];
  if (input.authority === 'viewer') {
    const membership =
      input.context.actorUserId !== null && input.context.teamId !== null
        ? await input.memberships.findMembership(input.context.teamId, input.context.actorUserId)
        : null;
    if (
      input.fence !== undefined &&
      !eventual &&
      input.context.actorUserId !== null &&
      input.context.teamId !== null
    ) {
      input.fence.enroll({
        kind: 'membership',
        teamId: input.context.teamId,
        userId: input.context.actorUserId,
      });
    }
    const byCtx: ByContext = {
      actorUserId: input.context.actorUserId,
      teamId: input.context.teamId,
      membership,
      memberships: input.memberships,
    };
    const found = input.policy.get(input.model);
    if (found !== undefined) {
      policy = found;
      secrets = found.secretFields;
      const byOk = await viewerGrantAuthority(found, byCtx);
      const covered: string[] = [];
      for (const [index, grant] of found.grants.entries()) {
        if (byOk[index]) covered.push(...grant.fields);
      }
      grantByOk = byOk;
      grantedFields = covered;
    }
    if (input.where !== undefined) {
      for (const path of collectPredicateFields(input.where)) {
        checkViewerPath(path, grantedFields, secrets);
      }
    }
    for (const term of order) {
      checkViewerPath(term.field, grantedFields, secrets);
    }
    for (const path of extraViewerPaths ?? []) {
      checkViewerPath(path, grantedFields, secrets);
    }
  }

  // Unbounded scan: storage applies model/archived/order only. `where` stays
  // in memory (grant visibility first), and `limit` is never pushed down —
  // overflow must error, never truncate.
  if (modelDescriptorMismatch) {
    throw new StateError('validation', 'Query model descriptor does not match the selected model.');
  }
  for (const field of numericTypes.arrays) {
    throw new StateError('validation', `Query order field ${JSON.stringify(field)} requires a singular numeric declaration.`);
  }
  const spec: QuerySpec = {
    model: input.model,
    authority: input.authority,
    order: toStorageOrder(order),
    ...(input.archived !== undefined ? { archived: input.archived } : {}),
  };
  const scanned = await input.store.query(spec);

  // Visibility (viewer: >=1 matching grant) then `where`, both in memory.
  // Viewers project BEFORE where: a row visible via grant B evaluates
  // predicates over its own projected values only, so A-only paths read as
  // missing (never match comparisons) instead of leaking stored values.
  const matched: StoredRow[] = [];
  if (input.authority === 'owner') {
    for (const row of scanned) {
      if (input.where !== undefined && !evalPredicateForRow(input.where, row)) {
        continue;
      }
      matched.push(row);
    }
  } else {
    const grants: ReadonlyArray<InterimGrant> = policy === null ? [] : policy.grants;
    for (const row of scanned) {
      const matching = matchingViewerGrants(grants, grantByOk, row);
      if (matching.length === 0) {
        continue;
      }
      const projected = projectRow(row, matching, secrets);
      if (input.where !== undefined && !evalPredicateForRow(input.where, projected)) {
        continue;
      }
      if (predicate !== undefined) {
        // Copy metadata (including parent) and nested projected data again:
        // callback mutation must never alter the matched or output rows.
        const accepted = await predicate(cleanCopy(projected) as ProjectedRecord);
        if (typeof accepted !== 'boolean') {
          throw new StateError('validation', 'Generated-source query predicate must return a boolean.');
        }
        if (!accepted) continue;
      }
      matched.push({ ...row, data: projected.data });
    }
  }

  // One engine ordering over the effective order plus the id tiebreak, so
  // results are identical regardless of backend scan order.
  const numeric = decodeNumericOrder(matched, numericTypes.types);
  matched.sort((left, right) => compareRowsForOrder(left, right, order, numeric));
  const rows = matched;

  // Limit overflow fails (never truncates). Code choice: `validation` per the
  // S4 spec preference. The `limit` code was considered but its DESIGN §10
  // meaning (quota/rate vs. result-cap overflow) is unconfirmed in this
  // worktree, so the preferred `validation` stands; note if a code is missing.
  if (input.limit !== undefined && rows.length > input.limit) {
    throw new StateError(
      'validation',
      `Query matched ${rows.length} rows, over the limit of ${input.limit}. Narrow the query instead of truncating.`,
    );
  }

  return { revision, rows };
}

/**
 * Read authorized records: viewers get projected records, owners get full
 * stored rows. Both report the pre-scan fence revision.
 *
 * TRUST BOUNDARY: `authority: 'owner'` performs no membership check — the
 * engine treats authority as a caller-supplied capability. Owner queries must
 * only be issued through admitted paths (canonical admission gates who may
 * claim owner authority); never expose this input directly to callers.
 */
export function queryRecords(input: ViewerRecordsInput): Promise<AuthorizedRecordsResult>;
export function queryRecords(input: OwnerRecordsInput): Promise<AuthorityRowsResult>;
export function queryRecords(
  input: QueryRecordsInput,
): Promise<AuthorizedRecordsResult | AuthorityRowsResult>;
export async function queryRecords(
  input: QueryRecordsInput,
): Promise<AuthorizedRecordsResult | AuthorityRowsResult> {
  const predicate = checkViewerPredicate(input, true);
  const set = await runAuthorizedQuery(input, undefined, false, predicate);
  if (input.authority === 'owner') {
    return { rows: set.rows, revision: set.revision };
  }
  return { records: set.rows.map(toProjectedRecord), revision: set.revision };
}

/** Validate the aggregate request shape (field presence, known op). */
function checkAggregateSpec(spec: AggregateSpec): void {
  const ops: ReadonlyArray<AggregateOp> = ['count', 'sum', 'avg', 'min', 'max'];
  if (!ops.includes(spec.op)) {
    throw new StateError('validation', `Unknown aggregate op: ${JSON.stringify(spec.op)}.`);
  }
  if (spec.op === 'count') {
    if (spec.field !== undefined) {
      throw new StateError('validation', 'Aggregate count takes no field.');
    }
    return;
  }
  if (typeof spec.field !== 'string' || spec.field === '') {
    throw new StateError('validation', `Aggregate ${spec.op} needs a field.`);
  }
}

/**
 * Compute an aggregate over the authorized matched set. The overflow check
 * applies first (a set limit still bounds aggregates); the aggregate itself
 * then runs over the full matched set, since a truncated aggregate would be a
 * wrong number. Null/missing field values are skipped; an all-skipped set
 * follows the empty-domain rules.
 */
export async function queryAggregate(input: QueryAggregateInput): Promise<AggregateQueryResult> {
  checkViewerPredicate(input, false);
  checkAggregateSpec(input.spec);
  const extraViewerPaths =
    input.spec.op === 'count' || input.spec.field === undefined ? [] : [input.spec.field];
  const set = await runAuthorizedQuery(input, extraViewerPaths);
  if (input.spec.op === 'count') {
    return { result: { op: input.spec.op, value: set.rows.length }, revision: set.revision };
  }
  const field = input.spec.field;
  if (typeof field !== 'string') {
    throw new StateError('validation', `Aggregate ${input.spec.op} needs a field.`);
  }
  const values: unknown[] = [];
  for (const row of set.rows) {
    const value = resolveRowPath(row, field);
    if (value === null || value === undefined) {
      continue;
    }
    values.push(value);
  }
  const value =
    input.spec.op === 'sum'
      ? sumValues(field, values)
      : input.spec.op === 'avg'
        ? avgValues(field, values)
        : minMaxValues(input.spec.op, field, values);
  return { result: { op: input.spec.op, value }, revision: set.revision };
}

/* -- T32b display-only eventual reads (adopted Alternative A). -- */

/**
 * A display-only, stale-tolerant read result. Eventual reads pin nothing,
 * enroll nothing, and keep the reread/stale-marking contract (the inner
 * result still reports its fence revision, so callers can reread and mark
 * stale). The `eventual: true` marker plus this distinct wrapper shape
 * bar the result from authorization and spends: `requireAuthorizingRead`
 * (invocation/admission.ts) refuses it at every authorization boundary,
 * including the fenced commit's offered readings.
 */
export interface EventualRecordsResult {
  readonly eventual: true;
  readonly result: AuthorizedRecordsResult | AuthorityRowsResult;
}

/**
 * Serve one display-only eventual read: same authorized pipeline as
 * `queryRecords` (viewer projection, secret carving, limit overflow),
 * enrolled in NO fence. Cross-owner browsing, pickers, and progress
 * views serve here; anything that authorizes or spends serves through
 * `queryRecords` at the operation's checkpoint instead.
 */
export function queryEventualRecords(
  input: ViewerRecordsInput,
): Promise<EventualRecordsResult & { result: AuthorizedRecordsResult }>;
export function queryEventualRecords(
  input: OwnerRecordsInput,
): Promise<EventualRecordsResult & { result: AuthorityRowsResult }>;
export function queryEventualRecords(
  input: QueryRecordsInput,
): Promise<EventualRecordsResult & { result: AuthorizedRecordsResult | AuthorityRowsResult }>;
export async function queryEventualRecords(
  input: QueryRecordsInput,
): Promise<EventualRecordsResult & { result: AuthorizedRecordsResult | AuthorityRowsResult }> {
  checkViewerPredicate(input, false);
  if (input.fence !== undefined) {
    throw new StateError(
      'validation',
      'Eventual reads cannot enroll in a fence; they are display-only.',
    );
  }
  const set = await runAuthorizedQuery(input, undefined, true);
  if (input.authority === 'owner') {
    return { eventual: true, result: { rows: set.rows, revision: set.revision } };
  }
  return { eventual: true, result: { records: set.rows.map(toProjectedRecord), revision: set.revision } };
}
