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
  RecordId,
  RecordParent,
  Revision,
  StoredRow,
} from '@canlang/contracts';
import {
  compareInt, compareDecimal, compareMoney, compareDate, compareInstant, decodeValue, SchemaError, ValueError,
  type Decimal, type MoneyValue, type DateValue, type DatetimeValue,
} from '@canlang/values';
import type { StoragePort } from '../storage/port.js';
import { StateError } from '../errors.js';
import type { FenceScope } from '../invocation/admission.js';
import { byDependsOnRow, evaluateBy, type ByPredicate, type MembershipReader } from '../policy/roles.js';
import { observeRowGrantAuthority } from '../policy/membership-facts.js';
import { captureInstalledSourceOwnerRows, type InstalledSourceOwnerRows, evaluateInstalledReadPredicate, executeUnboundReadPredicate, hasInstalledSourceQueryPredicate, type InstalledSourceQueryPredicate } from '../receipt/read-policy-membership.js';
import { deepFreeze } from '../internal/own-data.js';
import { captureSourceReadPolicies, projectInstalledSourceRowAndAncestors,
  type InstalledSourceRowDecision, type ViewerSourceReadPolicy } from './source-policy.js';
import {
  collectPredicateFields,
  evalPredicateForRow,
  isEqualOrUnder,
  isMetadataPath,
  isReferenceIdentity,
  isSecretValue,
  resolveRowPath,
  validatePredicateShape,
  withPolicyRow,
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
  /** Checked installed ordinary read declarations; State owns their row and ancestor observations. */
  readonly sourceReadPolicies?: ReadonlyMap<ModelName, ViewerSourceReadPolicy>;
  /**
   * Trusted internal generated-source wiring only, never JSON/user input.
   * Receives a detached snapshot after per-row grant projection and AST
   * where, before sorting/limit. Source conversion belongs to the owning caller. Checked source predicates
   * receive a State-issued second observation and join current authority
   * revalidation; this hook grants no capability.
   */
  readonly predicate?: InstalledSourceQueryPredicate;
}

/** Internal owner-stage observation; this is not a public read capability. */
export interface ObservedQueryCandidate {
  readonly row: StoredRow;
  readonly record: ProjectedRecord;
  readonly matched: boolean;
}

export interface ObservedQueryResult extends AuthorizedRecordsResult {
  readonly candidates: readonly ObservedQueryCandidate[];
  readonly selectedIndices: readonly number[];
}

type ObservedQueryPredicate = (
  projected: Readonly<ProjectedRecord>, original: StoredRow,
) => boolean | Promise<boolean>;

interface QueryObservation {
  readonly domain?: readonly StoredRow[];
  readonly ownerRows?: InstalledSourceOwnerRows;
  readonly predicate: ObservedQueryPredicate;
  readonly candidates: ObservedQueryCandidate[];
  readonly indices: Map<StoredRow, number>;
}

/** Finite viewer collection mode; the host admits a supplied parent first. */
export interface ViewerPageSelection {
  readonly where?: QueryPredicate;
  readonly order?: ReadonlyArray<OrderTerm>;
  /** Source-declared fields, request-local text; evaluated after grant projection. */
  readonly search?: { readonly fields: readonly string[]; readonly query: string };
  readonly includeCount?: true;
  readonly limit?: number;
  readonly parent?: RecordParent;
  readonly continuation?: ViewerPagePosition;
}

export interface ViewerPagePosition {
  readonly revision: Revision;
  /** Last returned visible row, never a raw offset or hidden sort value. */
  readonly after: RecordId;
}

export interface ViewerPageRecordsResult {
  readonly records: ProjectedRecord[];
  readonly revision: Revision;
  readonly continuation: ViewerPagePosition | null;
  /** Matched authorized rows before page slicing, only when requested. */
  readonly totalCount?: number;
}

export interface ViewerPageQueryInput extends Omit<ViewerRecordsInput, 'predicate' | 'limit' | 'where' | 'order' | 'archived'> {
  readonly selection?: ViewerPageSelection;
  /** Trusted generated-source closure; never admitted from a request body. */
  readonly generatedPredicate?: InstalledSourceQueryPredicate;
}

/** Internal checked containment inventory; never selection/request authority. */
export interface ViewerPageParentPolicy {
  readonly by: ByPredicate;
  readonly parent?: ModelName;
}
interface ViewerPageParentDecision {
  readonly model: ModelName;
  readonly allowed: ReadonlyArray<boolean>;
  readonly projection: string;
}

/** Materialized candidate cap only; adapters can still scan/sort more rows. */
export const VIEWER_PAGE_MAX_CANDIDATES = 1000;
export const VIEWER_PAGE_DEFAULT_LIMIT = 25;
export const VIEWER_PAGE_MAX_LIMIT = 100;

/** Data-only canonical identity vocabulary; State constructs every tuple. */
export type ViewerPageTuple = readonly (string | number | boolean | null | ViewerPageTuple)[];

/** Validate the source-owned search fields before using them in query identity or execution. */
export function viewerPageSearchTuple(
  search: ViewerPageSelection['search'],
  modelDescriptor: CanonicalModelDescriptor | undefined,
): ViewerPageTuple | null {
  if (search === undefined) return null;
  if (typeof search !== 'object' || search === null || Array.isArray(search) ||
      Object.keys(search).length !== 2 || !Object.hasOwn(search, 'fields') || !Object.hasOwn(search, 'query') ||
      !Array.isArray(search.fields) || search.fields.length === 0 || search.fields.length > 8 ||
      Object.keys(search.fields).length !== search.fields.length ||
      typeof search.query !== 'string' || search.query.length > 200 || /[\u0000-\u001f\u007f]/u.test(search.query) ||
      new Set(search.fields).size !== search.fields.length ||
      search.fields.some(field => typeof field !== 'string' || field === '' || field.includes('.') ||
        !modelDescriptor?.fields[field] ||
        !['text', 'email', 'url', 'locale', 'timezone', 'currency'].includes(modelDescriptor.fields[field]?.valueType ?? ''))) {
    throw new StateError('validation', 'Invalid page search fields or query.');
  }
  return ['search', [...search.fields], search.query];
}

/** Validate with the existing AST evaluator, then copy only its closed leaves. */
export function viewerPagePredicateTuple(predicate: QueryPredicate): ViewerPageTuple {
  if (typeof predicate !== 'object' || predicate === null || Array.isArray(predicate)) {
    throw new StateError('validation', 'Page predicates require the supported data-only AST.');
  }
  const fields = predicate.op === 'and' || predicate.op === 'or' ? ['op', 'args'] :
    predicate.op === 'not' ? ['op', 'arg'] : predicate.op === 'between' ? ['op', 'field', 'lo', 'hi'] :
    predicate.op === 'is_null' || predicate.op === 'not_null' ? ['op', 'field'] : ['op', 'field', 'value'];
  if (Object.keys(predicate).length !== fields.length || fields.some(field => !Object.hasOwn(predicate, field))) {
    throw new StateError('validation', 'Invalid page predicate shape.');
  }
  if ((predicate.op === 'and' || predicate.op === 'or') && !Array.isArray(predicate.args)) {
    throw new StateError('validation', 'Page predicate combinators require AST arrays.');
  }
  const scalar = (value: unknown): string | number | boolean | ViewerPageTuple => {
    if (typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))) return value;
    // Reference identities travel as opaque target ids (DESIGN 977), never
    // enum spellings; the tuple carries no directory access (DESIGN 1027).
    if (isReferenceIdentity(value)) return ['ref', value.id];
    throw new StateError('validation', 'Page predicates require finite scalar operands.');
  };
  switch (predicate.op) {
    case 'and': case 'or': {
      const args: ViewerPageTuple[] = [];
      for (const arg of predicate.args) args.push(viewerPagePredicateTuple(arg));
      return [predicate.op, args];
    }
    case 'not': return [predicate.op, viewerPagePredicateTuple(predicate.arg)];
    case 'is_null': case 'not_null':
      validatePredicateShape(predicate); return [predicate.op, predicate.field];
    case 'between':
      validatePredicateShape(predicate); return [predicate.op, predicate.field, scalar(predicate.lo), scalar(predicate.hi)];
    default:
      validatePredicateShape(predicate); return [predicate.op, predicate.field, scalar(predicate.value)];
  }
}

export function viewerPageOrder(order?: ReadonlyArray<OrderTerm>): ReadonlyArray<OrderTerm> {
  const effective = order ?? DEFAULT_ORDER;
  if (!Array.isArray(effective)) throw new StateError('validation', 'Page order requires an array of terms.');
  const copied: OrderTerm[] = [];
  for (const term of effective) {
    if (typeof term !== 'object' || term === null || Array.isArray(term) || Object.keys(term).length !== 2 ||
        typeof term.field !== 'string' || term.field === '' ||
        (term.direction !== 'asc' && term.direction !== 'desc')) {
      throw new StateError('validation', 'Invalid page order term.');
    }
    copied.push({ field: term.field, direction: term.direction });
  }
  return copied;
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
  grants: ReadonlyArray<Pick<InterimGrant, 'fields'>>,
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

/** Internal field union shared by installed source readers; this issues no read authority. */
export function projectSourceRowFields(row: StoredRow,
  grants: ReadonlyArray<Pick<InterimGrant, 'fields'>>, secrets: ReadonlyArray<string>): ProjectedRecord {
  return projectRow(row, grants, secrets);
}

/** Only row-independent predicates enter the existing query-level cache. */
async function viewerGrantAuthority(policy: InterimModelPolicy, context: ByContext): Promise<boolean[]> {
  const allowed: boolean[] = [];
  for (const grant of policy.grants) allowed.push(byDependsOnRow(grant.by) ? false : await evaluateBy(grant.by, context));
  return allowed;
}
async function viewerRowAuthority(policy: InterimModelPolicy, context: ByContext,
  cached: readonly boolean[], row: StoredRow): Promise<{ allowed: boolean[]; grants: InterimGrant[] }> {
  const bound = withPolicyRow(policy, context, row), allowed: boolean[] = [];
  for (const [index, grant] of policy.grants.entries()) {
    allowed.push(byDependsOnRow(grant.by) ? await evaluateBy(grant.by, bound) : cached[index] === true);
  }
  return { allowed, grants: policy.grants.filter((grant, index) => allowed[index] === true &&
    (grant.when === undefined || evalPredicateForRow(grant.when, row))) };
}
async function currentViewerAuthority(policy: InterimModelPolicy, context: ByContext, row: StoredRow) {
  const evaluate = async (current: ByContext) => viewerRowAuthority(policy, current,
    await viewerGrantAuthority(policy, current), row);
  if (!policy.grants.some(grant => byDependsOnRow(grant.by))) return { value: await evaluate(context), revalidate: undefined };
  return observeRowGrantAuthority(context, evaluate);
}

/** Authorize against the live row; copy only the original saved row's values. */
export async function projectSavedRecordForViewer(input: {
  readonly policy: InterimModelPolicy | undefined;
  readonly context: ByContext;
  readonly current: StoredRow;
  readonly saved: StoredRow;
  readonly originalSecretFields: ReadonlyArray<string>;
  /** Internal caller already observes all row-selected subjects coherently. */
  readonly coherentContext?: true;
}): Promise<ProjectedRecord | null> {
  if (input.policy === undefined) return null;
  const authority = input.coherentContext === true
    ? { value: await viewerRowAuthority(input.policy, input.context, await viewerGrantAuthority(input.policy, input.context), input.current), revalidate: undefined }
    : await currentViewerAuthority(input.policy, input.context, input.current);
  const projected = authority.value.grants.length === 0 ? null : projectRow(input.saved, authority.value.grants,
    [...input.originalSecretFields, ...input.policy.secretFields]);
  await authority.revalidate?.();
  return projected;
}

/** One current authority observation for all data images in an owning audit read. */
export async function prepareViewerHistoryProjection(input: {
  readonly policy: InterimModelPolicy | undefined;
  readonly context: ByContext;
  readonly current: StoredRow;
  /** The owning reader observes caller, row and parent facts together. */
  readonly coherentContext?: true;
}): Promise<{
  readonly allowed: readonly boolean[];
  project(data: Readonly<Record<string, unknown>> | null,
    originalSecretFields: readonly string[]): Readonly<Record<string, unknown>> | null;
  revalidate(): Promise<void>;
} | null> {
  const { policy, context, current } = input;
  if (policy === undefined) return null;
  const authority = input.coherentContext === true
    ? { value: await viewerRowAuthority(policy, context, await viewerGrantAuthority(policy, context), current), revalidate: undefined }
    : await currentViewerAuthority(policy, context, current);
  if (authority.value.grants.length === 0) return null;
  return Object.freeze({
    allowed: Object.freeze([...authority.value.allowed]),
    project(data: Readonly<Record<string, unknown>> | null,
      originalSecretFields: readonly string[]): Readonly<Record<string, unknown>> | null {
      if (data === null) return null;
      // The current envelope is only a path-resolution root. Metadata grants
      // remain excluded by projectRow; no invented historical metadata escapes.
      return deepFreeze(projectRow({ ...current, data }, authority.value.grants,
        [...originalSecretFields, ...policy.secretFields]).data);
    },
    async revalidate(): Promise<void> { await authority.revalidate?.(); },
  });
}

type TypedOrderType = 'int' | 'decimal' | 'money' | 'date' | 'datetime';
type TypedOrderValue = bigint | Decimal | MoneyValue | DateValue | DatetimeValue | null | undefined;
interface TypedOrderField {
  readonly type: TypedOrderType;
  readonly values: ReadonlyMap<StoredRow, TypedOrderValue>;
}

/** Select only declared numeric and temporal scalar fields; containers have no scalar ordering. */
function typedOrderTypes(
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

/**
 * Declared top-level `int` data fields (REVIEW-10 typed-int filter fix):
 * their stored wire is an int64 decimal string, so owner-path predicate
 * comparisons on these fields decode through the canonical int wire and
 * compare numerically. Derived only from the checked owning descriptor
 * (never request input); array fields stay out, like the order types.
 */
function intWireFields(
  descriptor: CanonicalModelDescriptor | undefined,
  model: ModelName,
): ReadonlySet<string> | undefined {
  if (descriptor === undefined || descriptor.name !== model) return undefined;
  const fields = new Set<string>();
  for (const [name, field] of Object.entries(descriptor.fields)) {
    if (field.array !== undefined || name.includes('.')) continue;
    if (field.valueType?.replace(/\?$/, '') === 'int') fields.add(name);
  }
  return fields;
}

/** Decode projected values once, including singleton results; keep existing null/missing order. */
function decodeTypedOrder(
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
function compareRowsForOrder(
  left: StoredRow,
  right: StoredRow,
  terms: ReadonlyArray<OrderTerm>,
  numeric: ReadonlyMap<string, TypedOrderField>,
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
        compared = compareTypedOrder(field.type, a as TypedOrderValue, b as TypedOrderValue);
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
  readonly pageAuthority?: {
    readonly policy: InterimModelPolicy | null;
    readonly byContext: ByContext;
    readonly allowed: ReadonlyArray<boolean>;
    readonly revalidate?: () => Promise<void>;
    readonly parents: readonly ViewerPageParentDecision[];
    readonly evaluateParents?: (context: ByContext) => Promise<readonly ViewerPageParentDecision[]>;
  };
}

/** Same-snapshot field names stay private to exact issued viewer records. */
const querySourcePresence = new WeakMap<object, Readonly<{
  model: ModelName; revision: Revision; id: RecordId; version: number; fields: readonly string[];
}>>();

function retainQuerySourcePresence(record: ProjectedRecord | StoredRow, model: ModelName,
  revision: Revision, fields: readonly string[]): void {
  querySourcePresence.set(record, Object.freeze({ model, revision, id: record.id,
    version: record.version, fields: Object.freeze([...fields]) }));
}

/** Copies and edited identity tuples cannot borrow an original query's presence. */
export function queryRecordSourcePresence(record: unknown, model: ModelName,
  revision: Revision): readonly string[] | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  const captured = querySourcePresence.get(record);
  if (captured === undefined || captured.model !== model || captured.revision !== revision) return undefined;
  const id = Object.getOwnPropertyDescriptor(record, 'id');
  const version = Object.getOwnPropertyDescriptor(record, 'version');
  if (id === undefined || !('value' in id) || id.value !== captured.id ||
      version === undefined || !('value' in version) || version.value !== captured.version) return undefined;
  return captured.fields;
}

/** Reinterpret a projected-shaped row as its viewer record. */
function toProjectedRecord(row: StoredRow): ProjectedRecord {
  const record: ProjectedRecord = {
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
  const presence = querySourcePresence.get(row);
  if (presence !== undefined && queryRecordSourcePresence(row, presence.model, presence.revision) !== undefined) {
    retainQuerySourcePresence(record, presence.model, presence.revision, presence.fields);
  }
  return record;
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
  page?: { readonly parent?: RecordParent; readonly revision?: Revision;
    readonly parentPolicies?: ReadonlyMap<ModelName, ViewerPageParentPolicy>; readonly readBy?: ByPredicate;
    readonly membershipPredicate?: InstalledSourceQueryPredicate },
  observation?: QueryObservation,
): Promise<AuthorizedSet> {
  // Capture installed declaration metadata before the first storage/Identity await.
  const suppliedReads = (input as ViewerRecordsInput).sourceReadPolicies;
  if (suppliedReads !== undefined && (input.authority !== 'viewer' || eventual)) {
    throw new StateError('validation', 'Installed source policies require a current viewer query.');
  }
  const sourceReads = suppliedReads === undefined ? undefined : captureSourceReadPolicies(suppliedReads);
  const selectedRead = sourceReads?.get(input.model);
  const sourceRows = new Map<string, StoredRow>();
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 0)) {
    throw new StateError('validation', `Invalid query limit: ${JSON.stringify(input.limit)}.`);
  }
  const coherentPredicate = predicate !== undefined && hasInstalledSourceQueryPredicate(page?.membershipPredicate ?? predicate);
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
  const numericTypes = typedOrderTypes(input.modelDescriptor, input.model, order);
  const decisionIntFields = intWireFields(input.modelDescriptor, input.model);

  if (eventual && input.fence !== undefined) {
    throw new StateError(
      'validation',
      'Eventual reads cannot enroll in a fence; they are display-only.',
    );
  }

  // Fence revision FIRST: every row below is read at or after this checkpoint.
  const revision = await input.store.readRevision();
  if (page?.revision !== undefined && page.revision !== revision) {
    throw new StateError('conflict', 'Collection changed; restart pagination.');
  }

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
  let pageAuthority: AuthorizedSet['pageAuthority'];
  let rowContext: ByContext | undefined;
  let byContext: ByContext | undefined;
  let parentDecisions: readonly ViewerPageParentDecision[] = [];
  const parentRows = new Map<string, StoredRow | null>();
  const evaluateParents = async (current: ByContext): Promise<readonly ViewerPageParentDecision[]> => {
    if (sourceReads !== undefined && page?.parent !== undefined) {
      const selected = page.parent, key = `${selected.model}\0${selected.id}`;
      if (!sourceRows.has(key)) {
        const row = await input.store.cohortLoad({ model: selected.model, id: selected.id, expectedRevision: revision });
        if (row === null) throw new StateError('not_found', 'Parent record not found.');
        if (row.id !== selected.id) throw new StateError('validation', 'Parent row identity mismatch.');
        sourceRows.set(key, row);
      }
      const projected = await projectInstalledSourceRowAndAncestors({ model: selected.model, row: sourceRows.get(key)!,
        readPolicies: sourceReads, policy: input.policy, context: current, revision, fence: input.fence,
        store: input.store, rows: sourceRows,
        ...(observation?.ownerRows === undefined ? {} : { ownerRows: observation.ownerRows }) });
      if (projected.record === null) throw new StateError('not_found', 'Parent record not found.');
      return projected.decisions.map(decision => ({ model: decision.model, allowed: decision.allowed,
        projection: JSON.stringify(decision.projection) }));
    }
    const decisions: ViewerPageParentDecision[] = [];
    let selected = page?.parent ?? null;
    const visited = new Set<ModelName>();
    while (selected !== null && page?.parentPolicies !== undefined) {
      if (visited.has(selected.model)) throw new StateError('validation', 'Invalid cyclic page parent scope.');
      visited.add(selected.model);
      const declaration = page.parentPolicies.get(selected.model);
      if (declaration === undefined) throw new StateError('validation', 'Parent scope requires a checked generated model read.');
      if (!(await evaluateBy(declaration.by, current))) throw new StateError('not_found', 'Parent record not found.');
      const identity = JSON.stringify([selected.model, selected.id]);
      // The coherent replay evaluates policy only, over the original rows.
      if (!parentRows.has(identity)) parentRows.set(identity, await input.store.load(selected.model, selected.id));
      const row = parentRows.get(identity)!;
      if (row === null) throw new StateError('not_found', 'Parent record not found.');
      const parentPolicy = input.policy.get(selected.model);
      const authority = await projectCurrentRecordForViewerPolicy({ policy: parentPolicy, context: current, row });
      if (authority.record === null || row.archivedAt !== null) throw new StateError('not_found', 'Parent record not found.');
      const ancestor = row.parent ?? null;
      if ((declaration.parent === undefined && ancestor !== null) ||
          (declaration.parent !== undefined && (ancestor === null || ancestor.model !== declaration.parent))) {
        throw new StateError('not_found', 'Parent record not found.');
      }
      decisions.push({ model: selected.model, allowed: authority.allowed,
        projection: JSON.stringify(authority.record) });
      selected = ancestor;
    }
    return decisions;
  };
  const prepareViewer = async (current: ByContext): Promise<boolean[]> => {
    if (sourceReads !== undefined && (selectedRead === undefined || 'grants' in selectedRead)) {
      grantedFields = selectedRead === undefined ? [] : selectedRead.grants.flatMap(grant => [...grant.fields]);
      if (input.where !== undefined) for (const path of collectPredicateFields(input.where)) checkViewerPath(path, grantedFields, secrets);
      for (const term of order) checkViewerPath(term.field, grantedFields, secrets);
      for (const path of extraViewerPaths ?? []) checkViewerPath(path, grantedFields, secrets);
      return [];
    }
    const allowed = policy === null ? [] : await viewerGrantAuthority(policy, current);
    grantedFields = policy === null ? [] : policy.grants.flatMap((grant, index) =>
      allowed[index] || byDependsOnRow(grant.by) ? [...grant.fields] : []);
    if (input.where !== undefined) for (const path of collectPredicateFields(input.where)) checkViewerPath(path, grantedFields, secrets);
    for (const term of order) checkViewerPath(term.field, grantedFields, secrets);
    for (const path of extraViewerPaths ?? []) checkViewerPath(path, grantedFields, secrets);
    return allowed;
  };
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
    byContext = byCtx;
    const found = input.policy.get(input.model);
    if (found !== undefined) { policy = found; secrets = found.secretFields; }
    if (selectedRead !== undefined && 'grants' in selectedRead) secrets = selectedRead.secretFields;
    const parentDependsOnRow = [...(page?.parentPolicies?.keys() ?? [])].some(model =>
      input.policy.get(model)?.grants.some(grant => byDependsOnRow(grant.by)));
    if (sourceReads !== undefined || policy?.grants.some(grant => byDependsOnRow(grant.by)) || parentDependsOnRow || coherentPredicate) rowContext = byCtx;
    else {
      parentDecisions = await evaluateParents(byCtx);
      grantByOk = await prepareViewer(byCtx);
    }
    if (page !== undefined && rowContext === undefined) pageAuthority = {
      policy, byContext: byCtx, allowed: grantByOk, parents: parentDecisions, evaluateParents,
    };
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
    ...(page === undefined ? {} : {
      limit: VIEWER_PAGE_MAX_CANDIDATES + 1,
      ...(page.parent === undefined ? {} : { parent: page.parent }),
    }),
  };
  let scanned: readonly StoredRow[];
  let rowAuthority: readonly { allowed: readonly boolean[]; grants: readonly Pick<InterimGrant, 'fields'>[];
    record?: ProjectedRecord | null; decisions?: readonly InstalledSourceRowDecision[] }[] | undefined;
  let revalidateRowAuthority: (() => Promise<void>) | undefined;
  let predicateMatches: readonly boolean[] | undefined;
  if (rowContext !== undefined) {
    const selectedPolicy = policy; let originalRows: readonly StoredRow[] | undefined;
    const authority = await observeRowGrantAuthority(rowContext, async current => {
      if (page?.readBy !== undefined && !(await evaluateBy(page.readBy, current))) {
        throw new StateError('forbidden', 'This operation is not permitted for the caller.');
      }
      const parents = await evaluateParents(current);
      const cached = await prepareViewer(current);
      const observedRows = originalRows ??= observation?.domain === undefined ? await input.store.query(spec) : [...observation.domain];
      if (page !== undefined && observedRows.length > VIEWER_PAGE_MAX_CANDIDATES) throw new StateError('limit', 'Collection exceeds the page candidate budget; narrow the collection scope.');
      const rows = [], matches: boolean[] = [];
      for (const row of observedRows) {
        if (sourceReads !== undefined) {
          sourceRows.set(`${input.model}\0${row.id}`, row);
          rows.push(await projectInstalledSourceRowAndAncestors({ model: input.model, row, readPolicies: sourceReads,
            policy: input.policy, context: current, revision, fence: input.fence, store: input.store, rows: sourceRows,
            ...(observation?.ownerRows === undefined ? {} : { ownerRows: observation.ownerRows }) }));
        } else rows.push(selectedPolicy === null ? { allowed: [], grants: [] } :
          await viewerRowAuthority(selectedPolicy, current, cached, row));
      }
      if (coherentPredicate) for (const [index, row] of observedRows.entries()) {
        const authority = rows[index]!;
        const projected = 'record' in authority ? authority.record :
          authority.grants.length === 0 ? null : projectRow(row, authority.grants, secrets);
        if (projected === null) { matches.push(false); continue; }
        if (input.where !== undefined && !evalPredicateForRow(input.where, projected)) {
          matches.push(false); continue;
        }
        const detached = cleanCopy(projected) as ProjectedRecord;
        retainQuerySourcePresence(detached, input.model, revision, Object.keys(row.data));
        // The source predicate sees only projected fields. Its membership
        // reads join this complete domain's coherent authority observation.
        matches.push(await evaluateInstalledReadPredicate(predicate!, detached, {
          context: current, row: { ...row, data: cleanCopy(projected.data) as StoredRow['data'] }, revision, fence: input.fence,
          sourcePresence: Object.freeze(Object.keys(row.data)),
        }, input.store));
        if (await input.store.readRevision() !== revision) {
          throw new StateError('conflict', 'Source predicate moved beyond its original State revision.');
        }
      }
      return { cached, rows, parents, matches };
    });
    scanned = originalRows!; rowAuthority = authority.value.rows; revalidateRowAuthority = authority.revalidate;
    if (coherentPredicate) predicateMatches = authority.value.matches;
    if (await input.store.readRevision() !== revision) throw new StateError('conflict', 'Row grant discovery moved beyond its original State revision.');
    grantByOk = sourceReads === undefined ? selectedPolicy?.grants.map((grant, index) => byDependsOnRow(grant.by)
      ? rowAuthority!.some(row => row.allowed[index] === true) : authority.value.cached[index] === true) ?? [] :
      (selectedRead !== undefined && 'grants' in selectedRead ? selectedRead.grants : selectedPolicy?.grants ?? [])
        .map((_, index) => rowAuthority!.some(row => row.allowed[index] === true));
    if (page !== undefined) pageAuthority = { policy, byContext: rowContext, allowed: grantByOk,
      parents: authority.value.parents, revalidate: authority.revalidate };
  } else scanned = observation?.domain === undefined ? await input.store.query(spec) : [...observation.domain];
  if (page !== undefined && scanned.length > VIEWER_PAGE_MAX_CANDIDATES) {
    throw new StateError('limit', 'Collection exceeds the page candidate budget; narrow the collection scope.');
  }

  // Visibility (viewer: >=1 matching grant) then `where`, both in memory.
  // Viewers project BEFORE where: a row visible via grant B evaluates
  // predicates over its own projected values only, so A-only paths read as
  // missing (never match comparisons) instead of leaking stored values.
  const matched: StoredRow[] = [];
  if (input.authority === 'owner') {
    for (const row of scanned) {
      if (input.where !== undefined && !evalPredicateForRow(input.where, row, decisionIntFields)) {
        continue;
      }
      matched.push(row);
    }
  } else {
    for (const [index, row] of scanned.entries()) {
      const matching = rowAuthority?.[index]?.grants ?? (policy === null ? [] :
        (await viewerRowAuthority(policy, byContext!, grantByOk, row)).grants);
      const projected = sourceReads !== undefined ? rowAuthority![index]!.record ?? null :
        matching.length === 0 ? null : projectRow(row, matching, secrets);
      if (projected === null) {
        continue;
      }
      const presence = Object.freeze(Object.keys(row.data));
      const candidateIndex = observation?.candidates.length;
      const candidate = observation === undefined ? undefined : {
        row, record: cleanCopy(projected) as ProjectedRecord, matched: false,
      };
      if (candidate !== undefined) {
        retainQuerySourcePresence(candidate.record, input.model, revision, presence);
        observation!.candidates.push(candidate);
      }
      if (input.where !== undefined && !evalPredicateForRow(input.where, projected)) {
        continue;
      }
      if (predicate !== undefined || observation !== undefined) {
        // Copy metadata (including parent) and nested projected data again:
        // callback mutation must never alter the matched or output rows.
        const detached = cleanCopy(projected) as ProjectedRecord;
        retainQuerySourcePresence(detached, input.model, revision, presence);
        const accepted = observation === undefined
          ? coherentPredicate ? predicateMatches![index]! : await executeUnboundReadPredicate(predicate!, detached)
          : await observation.predicate(detached, row);
        if (typeof accepted !== 'boolean') {
          throw new StateError('validation', 'Generated-source query predicate must return a boolean.');
        }
        if (!accepted) continue;
      }
      const selected = { ...row, data: projected.data };
      retainQuerySourcePresence(selected, input.model, revision, presence);
      matched.push(selected);
      if (candidate !== undefined) {
        candidate.matched = true;
        observation!.indices.set(selected, candidateIndex!);
      }
    }
  }

  // One engine ordering over the effective order plus the id tiebreak, so
  // results are identical regardless of backend scan order.
  const numeric = decodeTypedOrder(matched, numericTypes.types);
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

  if (revalidateRowAuthority !== undefined) {
    await revalidateRowAuthority();
    if (await input.store.readRevision() !== revision) throw new StateError('conflict', 'Row grant read moved beyond its original State revision.');
  }
  return { revision, rows, ...(pageAuthority === undefined ? {} : { pageAuthority }) };
}

/** Internal policy-only projection for a caller that owns the complete authority observation. */
export async function projectCurrentRecordForViewerPolicy(input: {
  readonly policy: InterimModelPolicy | undefined;
  readonly context: ByContext;
  readonly row: StoredRow;
}): Promise<{ readonly record: ProjectedRecord | null; readonly allowed: ReadonlyArray<boolean> }> {
  if (input.policy === undefined) return { record: null, allowed: [] };
  const { grants, allowed } = await viewerRowAuthority(input.policy, input.context,
    await viewerGrantAuthority(input.policy, input.context), input.row);
  return { record: grants.length === 0 ? null : projectRow(input.row, grants, input.policy.secretFields), allowed };
}

/** Current-row projection for admitted parent loads, using the same grants. */
export async function projectCurrentRecordForViewer(input: {
  readonly policy: InterimModelPolicy | undefined;
  readonly context: ByContext;
  readonly row: StoredRow;
}): Promise<{ readonly record: ProjectedRecord | null; readonly allowed: ReadonlyArray<boolean> }> {
  const evaluate = (context: ByContext) => projectCurrentRecordForViewerPolicy({ ...input, context });
  if (!input.policy?.grants.some(grant => byDependsOnRow(grant.by))) return evaluate(input.context);
  const authority = await observeRowGrantAuthority(input.context, evaluate);
  await authority.revalidate();
  return authority.value;
}

/** The transform finishes before current grant and revision checks. */
export function queryRecordsPage(input: ViewerPageQueryInput): Promise<ViewerPageRecordsResult>;
export function queryRecordsPage<Result>(input: ViewerPageQueryInput,
  transform: (page: Readonly<ViewerPageRecordsResult>, grantDecisions: ReadonlyArray<boolean>) => Result | Promise<Result>): Promise<Result>;
export async function queryRecordsPage(input: ViewerPageQueryInput,
  transform?: (page: Readonly<ViewerPageRecordsResult>, grantDecisions: ReadonlyArray<boolean>) => unknown | Promise<unknown>): Promise<unknown> {
  return runPageQuery(input, transform);
}

/** Private State containment join: parent and child policy discovery share one observation. */
export function queryRecordsPageWithParentPolicies<Result>(input: ViewerPageQueryInput,
  parentPolicies: ReadonlyMap<ModelName, ViewerPageParentPolicy>, readBy: ByPredicate,
  transform: (page: Readonly<ViewerPageRecordsResult>, grantDecisions: ReadonlyArray<boolean>,
    parents: readonly ViewerPageParentDecision[]) => Result | Promise<Result>,
  retainFinalAuthority: (revalidate: () => Promise<void>) => void): Promise<Result> {
  return runPageQuery(input, transform, parentPolicies, retainFinalAuthority, readBy) as Promise<Result>;
}

async function runPageQuery(input: ViewerPageQueryInput,
  transform?: (page: Readonly<ViewerPageRecordsResult>, grantDecisions: ReadonlyArray<boolean>,
    parents: readonly ViewerPageParentDecision[]) => unknown | Promise<unknown>,
  parentPolicies?: ReadonlyMap<ModelName, ViewerPageParentPolicy>,
  retainFinalAuthority?: (revalidate: () => Promise<void>) => void, readBy?: ByPredicate): Promise<unknown> {
  if (input.authority !== 'viewer' || 'predicate' in input || 'archived' in input ||
      (input.generatedPredicate !== undefined && typeof input.generatedPredicate !== 'function')) {
    throw new StateError('validation', 'Pages require current viewer authority without caller predicates or archive overrides.');
  }
  let selection: ViewerPageSelection;
  try { selection = structuredClone(input.selection === undefined ? {} : input.selection); }
  catch { throw new StateError('validation', 'Page selection must be a data-only AST.'); }
  if (typeof selection !== 'object' || selection === null || Array.isArray(selection)) {
    throw new StateError('validation', 'Invalid page selection.');
  }
  if (Object.keys(selection).some(key => !['where', 'order', 'search', 'includeCount', 'limit', 'parent', 'continuation'].includes(key))) {
    throw new StateError('validation', 'Unknown page selection field.');
  }
  if (selection.includeCount !== undefined && selection.includeCount !== true) {
    throw new StateError('validation', 'Invalid page count request.');
  }
  const search = selection.search;
  viewerPageSearchTuple(search, input.modelDescriptor);
  const limit = selection.limit ?? VIEWER_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > VIEWER_PAGE_MAX_LIMIT) {
    throw new StateError('validation', 'Page limit must be between 1 and 100.');
  }
  if (selection.where !== undefined) viewerPagePredicateTuple(selection.where);
  const order = viewerPageOrder(selection.order);
  const requestedSearch = search?.query.toLowerCase() ?? '';
  const predicate = search === undefined && input.generatedPredicate === undefined ? undefined :
    async (record: Readonly<ProjectedRecord>, observation?: Parameters<InstalledSourceQueryPredicate>[1]): Promise<boolean> => {
      if (search !== undefined && requestedSearch !== '' &&
          !search.fields.some(field => {
            const value = record.data[field];
            return typeof value === 'string' && value.toLowerCase().includes(requestedSearch);
          })) return false;
      if (input.generatedPredicate === undefined) return true;
      if (observation === undefined) return executeUnboundReadPredicate(input.generatedPredicate, record);
      return evaluateInstalledReadPredicate(input.generatedPredicate, record, observation, input.store);
    };
  const position = selection.continuation;
  if (position !== undefined && (typeof position !== 'object' || position === null || Array.isArray(position) ||
      !Number.isSafeInteger(position.revision) || position.revision < 0 ||
      typeof position.after !== 'string' || position.after === '' ||
      Object.keys(position).some(key => key !== 'revision' && key !== 'after'))) {
    throw new StateError('validation', 'Invalid page continuation position.');
  }
  if (selection.parent !== undefined && (typeof selection.parent !== 'object' || selection.parent === null || Array.isArray(selection.parent) ||
      typeof selection.parent.model !== 'string' || selection.parent.model === '' ||
      typeof selection.parent.id !== 'string' || selection.parent.id === '' || Object.keys(selection.parent).length !== 2 ||
      !Object.hasOwn(selection.parent, 'model') || !Object.hasOwn(selection.parent, 'id'))) {
    throw new StateError('validation', 'Invalid admitted page parent.');
  }
  const set = await runAuthorizedQuery({
    ...input, order, archived: 'exclude',
    ...(selection.where === undefined ? {} : { where: selection.where }),
  }, search?.fields, false, predicate, {
    ...(selection.parent === undefined ? {} : { parent: selection.parent }),
    ...(position === undefined ? {} : { revision: position.revision }),
    ...(parentPolicies === undefined ? {} : { parentPolicies }),
    ...(readBy === undefined ? {} : { readBy }),
    ...(input.generatedPredicate === undefined ? {} : { membershipPredicate: input.generatedPredicate }),
  });
  if (position !== undefined && position.revision !== set.revision) {
    throw new StateError('conflict', 'Collection changed; restart pagination.');
  }
  const previous = position === undefined ? -1 : set.rows.findIndex(row => row.id === position.after);
  if (position !== undefined && previous === -1) {
    throw new StateError('conflict', 'Page position is no longer visible; restart pagination.');
  }
  const records = set.rows.slice(previous + 1, previous + 1 + limit).map(toProjectedRecord);
  const last = records.at(-1);
  const page: ViewerPageRecordsResult = {
    records, revision: set.revision,
    continuation: previous + 1 + records.length < set.rows.length && last !== undefined
      ? { revision: set.revision, after: last.id } : null,
    ...(selection.includeCount === true ? { totalCount: set.rows.length } : {}),
  };
  const captured = set.pageAuthority!;
  const result = transform === undefined ? page : await transform(structuredClone(page), [...captured.allowed], structuredClone(captured.parents));
  // The admitted page owner finishes its outer caller checks before invoking
  // this same retained observation. Direct page queries finish here.
  const revalidate = async (): Promise<void> => {
    if (await input.store.readRevision() !== set.revision) {
      throw new StateError('conflict', 'Collection changed during the page read; restart pagination.');
    }
    if (captured.revalidate !== undefined) await captured.revalidate();
    else {
      const membership = input.context.actorUserId !== null && input.context.teamId !== null
        ? await input.memberships.findMembership(input.context.teamId, input.context.actorUserId) : null;
      const context = { ...captured.byContext, membership };
      let parents: readonly ViewerPageParentDecision[];
      try { parents = await captured.evaluateParents!(context); }
      catch (error) {
        if (error instanceof StateError && error.code === 'not_found') {
          throw new StateError('forbidden', 'Parent read authority changed during the page read.');
        }
        throw error;
      }
      if (JSON.stringify(parents) !== JSON.stringify(captured.parents)) {
        throw new StateError('forbidden', 'Parent read authority changed during the page read.');
      }
      const live = captured.policy === null ? [] : await viewerGrantAuthority(captured.policy, context);
      if (JSON.stringify(live) !== JSON.stringify(captured.allowed)) {
        throw new StateError('forbidden', 'Collection read authority changed during the page read.');
      }
    }
    if (await input.store.readRevision() !== set.revision) {
      throw new StateError('conflict', 'Collection changed during the page read; restart pagination.');
    }
  };
  if (retainFinalAuthority === undefined) await revalidate();
  else retainFinalAuthority(revalidate);
  return result;
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

/**
 * Trusted internal finite-domain route. The caller supplies the complete
 * bounded store domain and owns lifetime and final authority revalidation.
 * Original rows are the actual scan objects; indices correlate the one
 * predicate execution with the engine's final order, including empty sets.
 */
export async function queryRecordsObserved(
  input: Omit<ViewerRecordsInput, 'predicate'>,
  predicate: ObservedQueryPredicate,
  requiredFields: readonly string[] = [],
  domain?: readonly StoredRow[],
  ownerRows?: InstalledSourceOwnerRows,
): Promise<ObservedQueryResult> {
  if (input.authority !== 'viewer' || typeof predicate !== 'function' ||
      (input as ViewerRecordsInput).predicate !== undefined) {
    throw new StateError('validation', 'Observed queries require a current viewer query and a trusted host predicate.');
  }
  const observation: QueryObservation = { predicate, candidates: [], indices: new Map(),
    ...(domain === undefined ? {} : { domain: Object.freeze([...domain]) }),
    ...(ownerRows === undefined ? {} : { ownerRows: captureInstalledSourceOwnerRows(ownerRows) }) };
  const set = await runAuthorizedQuery(input, requiredFields, false, undefined, undefined, observation);
  return {
    records: set.rows.map(toProjectedRecord), revision: set.revision,
    candidates: observation.candidates,
    selectedIndices: set.rows.map(row => observation.indices.get(row)!),
  };
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
