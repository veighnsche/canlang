/**
 * Lane 03 S4: authorized record query and aggregate engine.
 *
 * Viewers see only rows matching at least one grant, with `data` projected
 * along the union of their matching grants' paths; owners read full stored
 * rows. Every read scans unbounded from storage (correctness over streaming),
 * filters and sorts in memory, fails on limit overflow instead of truncating,
 * and reports the pre-scan fence revision.
 */

import type { AggregateOp, AggregateResult, AggregateSpec, AuthorityRowsResult, AuthorizedRecordsResult, CanonicalModelDescriptor, ModelName, OrderTerm, ProjectedRecord, QueryPredicate, QuerySpec, ReadAuthority, RecordId, RecordParent, Revision, StoredRow } from '@canlang/contracts';
import { compareInstant, decodeValue, isDatetime, SchemaError, ValueError, type DatetimeValue } from '@canlang/values';
import type { StoragePort } from '../storage/port.js';
import { StateError } from '../errors.js';
import type { FenceScope } from '../invocation/admission.js';
import { byDependsOnRow, evaluateBy, type ByPredicate, type MembershipReader } from '../policy/roles.js';
import { observeRowGrantAuthority } from '../policy/membership-facts.js';
import { captureInstalledSourceOwnerRows, type InstalledSourceOwnerRows, evaluateInstalledReadPredicate, executeUnboundReadPredicate, hasInstalledSourceQueryPredicate, type InstalledSourceQueryPredicate } from '../receipt/read-policy-membership.js';
import { deepFreeze } from '../internal/own-data.js';
import { captureSourceReadPolicies, projectInstalledSourceRowAndAncestors, type InstalledSourceRowDecision, type ViewerSourceReadPolicy } from './source-policy.js';
import { assertDerivedBoolPlacement, collectPredicateFields, evalPredicateForRow, isEqualOrUnder, isMetadataPath, isReferenceIdentity, isSecretValue, resolveRowPath, validatePredicateShape, withPolicyRow, type ByContext, type InterimGrant, type InterimModelPolicy, type PolicyTable } from '../policy/grants.js';
import { DEFAULT_ORDER, type TypedOrderType, typedOrderTypes, decodeTypedOrder, compareRowsForOrder } from "./order.js";
export { orderSourceReadRecords } from "./order.js";


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
  readonly archived?: 'exclude' | 'include';
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

/** Archive mode changes the candidate domain, never current viewer grants. */
export function queryArchiveMode(value: unknown): 'exclude' | 'include' {
  if (value === undefined) return 'exclude';
  if (value !== 'exclude' && value !== 'include') throw new StateError('validation', 'Archive selection must be include or exclude.');
  return value;
}

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

/** Closed leaf names for one page-predicate combinator or comparison. */
function pagePredicateFields(predicate: QueryPredicate): ReadonlyArray<string> {
  if (predicate.op === 'derived_bool' &&
    (predicate as { readonly expansion?: unknown }).expansion === 'overdue') {
    return ['op', 'field', 'value', 'expansion', 'source', 'time'];
  }
  return predicate.op === 'and' || predicate.op === 'or' ? ['op', 'args'] :
    predicate.op === 'not' ? ['op', 'arg'] : predicate.op === 'between' ? ['op', 'field', 'lo', 'hi'] :
    predicate.op === 'is_null' || predicate.op === 'not_null' ? ['op', 'field'] :
    predicate.op === 'derived_bool' ? ['op', 'field', 'value', 'expansion', 'source'] : ['op', 'field', 'value'];
}

/**
 * Guarded derived-bool evaluation for one viewer row (REVIEW 151).
 * The sealed expansion admits exactly `unassigned` (over the owned
 * stored `assignee`) and `overdue` (over the owned stored `state`
 * and nullable `due`, compared against the host-substituted trusted
 * instant) of the exact `desk.Ticket` model; every other model
 * refuses. All of the following must hold before either branch
 * evaluates, otherwise the whole read refuses (fail closed — a
 * missing grant is never classified as null): the row's matched
 * grants include every backing field, no backing field is a secret
 * (projection would have stripped it), and every backing field is
 * actually present in the projected row (not just named in grant
 * text). Only then are the stored values read.
 */
function evalDerivedBoolForViewerRow(
  predicate: Extract<QueryPredicate, { readonly op: 'derived_bool' }>,
  grants: ReadonlyArray<Pick<InterimGrant, 'fields'>>,
  row: StoredRow,
  projected: ProjectedRecord,
  model: string,
  secrets: ReadonlyArray<string>,
): boolean {
  if (model !== 'desk.Ticket') {
    throw new StateError('forbidden', 'Derived-bool predicates are bound to the exact desk.Ticket page plan.');
  }
  if ((predicate.field !== 'unassigned' && predicate.field !== 'overdue') ||
    typeof predicate.value !== 'boolean' || predicate.expansion !== predicate.field) {
    throw new StateError('validation', 'Invalid derived-bool predicate shape.');
  }
  if (predicate.field === 'unassigned') {
    if (predicate.time !== undefined) {
      throw new StateError('validation', 'Invalid derived-bool time carrier.');
    }
    if (secrets.includes('assignee')) {
      throw new StateError('forbidden', 'Derived filter backing field must not be secret.');
    }
    const covered = grants.some(grant => grant.fields.includes('assignee'));
    if (!covered || !Object.hasOwn(projected.data, 'assignee')) {
      throw new StateError('forbidden', 'Derived filter needs the backing field grant for every evaluated row.');
    }
    const assigned = row.data['assignee'] !== null && row.data['assignee'] !== undefined;
    return predicate.value ? !assigned : assigned;
  }
  // `overdue`: state != resolved AND due != null AND due < time.
  // The false branch is the exact negation (resolved states and
  // null dues are not overdue). `time` is the genuine DatetimeValue
  // the Cloudflare host substituted for the page-query-now sentinel
  // after the receipt gate; the sentinel itself, numbers, strings,
  // and forged objects refuse here before any row comparison.
  if (!isDatetime(predicate.time)) {
    throw new StateError('validation', 'Overdue filter needs its trusted host instant.');
  }
  for (const backing of ['state', 'due'] as const) {
    if (secrets.includes(backing)) {
      throw new StateError('forbidden', 'Derived filter backing field must not be secret.');
    }
    const covered = grants.some(grant => grant.fields.includes(backing));
    if (!covered || !Object.hasOwn(projected.data, backing)) {
      throw new StateError('forbidden', 'Derived filter needs the backing field grant for every evaluated row.');
    }
  }
  const state = row.data['state'];
  const due = row.data['due'];
  // Stored values are model-typed (`state` an enum string). `due`
  // persists as the canonical datetime wire (RFC 3339 UTC millis,
  // exactly what production SQL adapters stringify); in-process
  // native DatetimeValues are accepted too. Anything else —
  // including an arbitrary string — is a corrupt row and refuses,
  // never silently classified into either branch.
  if (typeof state !== 'string') {
    throw new StateError('validation', 'Overdue filter needs its stored enum state.');
  }
  if (due === null || due === undefined) {
    return predicate.value ? false : true;
  }
  let dated: DatetimeValue;
  if (isDatetime(due)) {
    dated = due;
  } else if (typeof due === 'string') {
    try {
      dated = decodeValue('datetime', due) as DatetimeValue;
    } catch (error) {
      if (!(error instanceof SchemaError) && !(error instanceof ValueError)) throw error;
      throw new StateError('validation', `Overdue filter needs its stored datetime wire: ${error.message}.`);
    }
    if (!isDatetime(dated)) {
      throw new StateError('validation', 'Overdue filter needs its stored datetime wire.');
    }
  } else {
    throw new StateError('validation', 'Overdue filter needs its stored nullable datetime due.');
  }
  const overdue = state !== 'resolved' && compareInstant(dated, predicate.time) < 0;
  return predicate.value ? overdue : !overdue;
}

/**
 * Whether a predicate AST contains a sealed derived-bool expansion
 * in any position.
 */
function containsDerivedBool(node: QueryPredicate): boolean {
  if (node.op === 'derived_bool') return true;
  if (node.op === 'and' || node.op === 'or') return node.args.some(containsDerivedBool);
  if (node.op === 'not') return containsDerivedBool(node.arg);
  return false;
}

/**
 * Viewer `where` evaluation with sealed derived-bool support. With
 * no derived_bool present the evaluation is exactly the previous
 * projected-row path. Otherwise the derived expansion must sit as a
 * bare top-level predicate or a direct conjunct of a top-level
 * `and` (the UI query-adapter shape); any nested position refuses.
 * Each derived conjunct evaluates under the row's grant coverage;
 * every other conjunct evaluates on the projected row as before.
 */
function matchViewerWhereWithDerived(
  where: QueryPredicate,
  projected: ProjectedRecord,
  row: StoredRow,
  grants: ReadonlyArray<Pick<InterimGrant, 'fields'>>,
  intFields: ReadonlySet<string> | undefined,
  implicitParent: boolean,
  model: string,
  secrets: ReadonlyArray<string>,
): boolean {
  if (!containsDerivedBool(where)) {
    return evalPredicateForRow(where, projected, intFields, implicitParent);
  }
  const conjuncts = where.op === 'derived_bool' ? [where] :
    where.op === 'and' ? where.args : null;
  if (conjuncts === null) {
    throw new StateError('validation', 'Derived-bool predicates require a top-level conjunction.');
  }
  for (const arg of conjuncts) {
    if (arg.op === 'derived_bool') {
      if (!evalDerivedBoolForViewerRow(arg, grants, row, projected, model, secrets)) return false;
      continue;
    }
    if (containsDerivedBool(arg)) {
      throw new StateError('validation', 'Derived-bool predicates require a top-level conjunction.');
    }
    if (!evalPredicateForRow(arg, projected, intFields, implicitParent)) return false;
  }
  return true;
}

/** Finite scalar operand: primitives pass through, references travel as ids. */
function pagePredicateScalar(value: unknown): string | number | boolean | ViewerPageTuple {
  if (typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))) return value;
  // Reference identities travel as opaque target ids (DESIGN 977), never
  // enum spellings; the tuple carries no directory access (DESIGN 1027).
  if (isReferenceIdentity(value)) return ['ref', value.id];
  throw new StateError('validation', 'Page predicates require finite scalar operands.');
}

/** Validate with the existing AST evaluator, then copy only its closed leaves. */
export function viewerPagePredicateTuple(predicate: QueryPredicate): ViewerPageTuple {
  if (typeof predicate !== 'object' || predicate === null || Array.isArray(predicate)) {
    throw new StateError('validation', 'Page predicates require the supported data-only AST.');
  }
  const fields = pagePredicateFields(predicate);
  if (Object.keys(predicate).length !== fields.length || fields.some(field => !Object.hasOwn(predicate, field))) {
    throw new StateError('validation', 'Invalid page predicate shape.');
  }
  if ((predicate.op === 'and' || predicate.op === 'or') && !Array.isArray(predicate.args)) {
    throw new StateError('validation', 'Page predicate combinators require AST arrays.');
  }
  switch (predicate.op) {
    case 'and': case 'or': {
      const args: ViewerPageTuple[] = [];
      for (const arg of predicate.args) args.push(viewerPagePredicateTuple(arg));
      return [predicate.op, args];
    }
    case 'not': return [predicate.op, viewerPagePredicateTuple(predicate.arg)];
    case 'is_null': case 'not_null':
      validatePredicateShape(predicate); return [predicate.op, predicate.field];
    case 'derived_bool': {
      // REVIEW 150: exact key-count branch (five for `unassigned`,
      // six for `overdue` with its trusted instant) with a distinct
      // canonical tuple shape carrying the sealed expansion and
      // source tuple. Shape validation is not authorization: row
      // evaluation still requires the guarded viewer matcher with
      // backing-field grant coverage, and census membership plus
      // page-plan binding are verified by the Cloudflare gate before
      // State admission. The overdue instant travels as a safe-int
      // millisecond number so the page binding digest covers the
      // exact trusted time (cursor continuity without a fresh clock).
      validatePredicateShape(predicate);
      if ((predicate.field !== 'unassigned' && predicate.field !== 'overdue') ||
        typeof predicate.value !== 'boolean' || predicate.expansion !== predicate.field) {
        throw new StateError('validation', 'Invalid derived-bool predicate shape.');
      }
      const source = predicate.source;
      const head = [predicate.op, predicate.field, predicate.value, predicate.expansion,
        source.path, source.sha256, source.module, source.node.start, source.node.end] as const;
      if (predicate.field === 'unassigned') return [...head];
      if (!isDatetime(predicate.time)) {
        throw new StateError('validation', 'Overdue filter needs its trusted host instant.');
      }
      const ms = predicate.time.ms;
      if (typeof ms !== 'bigint') {
        throw new StateError('validation', 'Overdue filter needs its trusted host instant.');
      }
      const msNumber = Number(ms);
      if (!Number.isSafeInteger(msNumber)) {
        throw new StateError('validation', 'Overdue filter needs its trusted host instant.');
      }
      return [...head, msNumber];
    }
    case 'between':
      validatePredicateShape(predicate); return [predicate.op, predicate.field, pagePredicateScalar(predicate.lo), pagePredicateScalar(predicate.hi)];
    default:
      validatePredicateShape(predicate); return [predicate.op, predicate.field, pagePredicateScalar(predicate.value)];
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
  /** Trusted owner capability may narrow a scan to one contained child domain. */
  readonly parent?: RecordParent;
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
  implicitParent = false,
): void {
  if (typeof path !== 'string') {
    throw new StateError('validation', 'Query field paths must be strings.');
  }
  if (isMetadataPath(path) || path === 'parent' && implicitParent) {
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
/** Shared min/max accumulation (one aggregate call). */
interface MinMaxTrack {
  bestNum: number | null;
  bestStr: string | null;
  bestMoney: { minor: number | bigint; value: unknown } | null;
  moneyCurrency: string;
  moneyMinorKind: 'number' | 'bigint' | null;
}

function mixedMinMaxError(op: 'min' | 'max', field: string): StateError {
  return new StateError(
    'validation',
    `Cannot compute ${op} over mixed value types on ${JSON.stringify(field)}.`,
  );
}

function sawMinMaxOther(track: MinMaxTrack): boolean {
  return track.bestNum !== null || track.bestStr !== null || track.bestMoney !== null;
}

/** One numeric candidate for the running min/max. */
function trackMinMaxNumber(track: MinMaxTrack, op: 'min' | 'max', field: string, value: number): void {
  if (track.bestStr !== null || track.bestMoney !== null) {
    throw mixedMinMaxError(op, field);
  }
  track.bestNum = track.bestNum === null ? value : op === 'min' ? Math.min(track.bestNum, value) : Math.max(track.bestNum, value);
}

/** One text candidate for the running min/max. */
function trackMinMaxString(track: MinMaxTrack, op: 'min' | 'max', field: string, value: string): void {
  if (sawMinMaxOther(track) && track.bestStr === null) {
    throw mixedMinMaxError(op, field);
  }
  if (track.bestStr === null || (op === 'min' ? value < track.bestStr : value > track.bestStr)) {
    track.bestStr = value;
  }
}

/** One money candidate: currency, minor units and running extremum. */
function trackMinMaxMoney(track: MinMaxTrack, op: 'min' | 'max', field: string, value: unknown): void {
  if (sawMinMaxOther(track) && track.bestMoney === null) {
    throw mixedMinMaxError(op, field);
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
  if (track.bestMoney !== null && track.moneyCurrency !== currency) {
    throw new StateError(
      'validation',
      `Cannot compute ${op} over money in mixed currencies on ${JSON.stringify(field)}.`,
    );
  }
  const kind = typeof minor === 'bigint' ? 'bigint' : 'number';
  if (track.moneyMinorKind !== null && track.moneyMinorKind !== kind) {
    throw new StateError(
      'validation',
      `Cannot compute ${op} over money with mixed minor-unit types on ${JSON.stringify(field)}.`,
    );
  }
  track.moneyCurrency = currency;
  track.moneyMinorKind = kind;
  if (track.bestMoney === null) {
    track.bestMoney = { minor, value };
  } else {
    const better =
      op === 'min'
        ? (minor as number | bigint) < track.bestMoney.minor
        : (minor as number | bigint) > track.bestMoney.minor;
    if (better) {
      track.bestMoney = { minor, value };
    }
  }
}

function minMaxValues(op: 'min' | 'max', field: string, values: ReadonlyArray<unknown>): unknown {
  const track: MinMaxTrack = { bestNum: null, bestStr: null, bestMoney: null, moneyCurrency: '', moneyMinorKind: null };
  for (const value of values) {
    if (typeof value === 'number') {
      trackMinMaxNumber(track, op, field, value);
    } else if (typeof value === 'string') {
      trackMinMaxString(track, op, field, value);
    } else if (isMoneyShaped(value)) {
      trackMinMaxMoney(track, op, field, value);
    } else {
      throw new StateError(
        'validation',
        `Cannot compute ${op} over non-numeric values on ${JSON.stringify(field)}.`,
      );
    }
  }
  if (track.bestNum !== null) {
    return track.bestNum;
  }
  if (track.bestStr !== null) {
    return track.bestStr;
  }
  if (track.bestMoney !== null) {
    return track.bestMoney.value;
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

/** Shared authorized-query run state (one revision-fenced scan). */
interface AuthorizedQueryRun {
  readonly input: BaseQueryInput;
  readonly eventual: boolean;
  readonly predicate: ViewerRecordsInput['predicate'];
  readonly page: { readonly parent?: RecordParent; readonly revision?: Revision;
    readonly parentPolicies?: ReadonlyMap<ModelName, ViewerPageParentPolicy>; readonly readBy?: ByPredicate;
    readonly membershipPredicate?: InstalledSourceQueryPredicate } | undefined;
  readonly observation: QueryObservation | undefined;
  readonly extraViewerPaths: ReadonlyArray<string> | undefined;
  readonly archived: 'exclude' | 'include';
  readonly sourceReads: ReadonlyMap<ModelName, ViewerSourceReadPolicy> | undefined;
  readonly selectedRead: ViewerSourceReadPolicy | undefined;
  readonly order: ReadonlyArray<OrderTerm>;
  readonly numericTypes: { readonly types: ReadonlyMap<string, TypedOrderType>; readonly arrays: ReadonlyArray<string> };
  readonly decisionIntFields: ReadonlySet<string> | undefined;
  readonly coherentPredicate: boolean;
  readonly revision: Revision;
  readonly modelDescriptorMismatch: boolean;
  readonly implicitParent: boolean;
  readonly sourceRows: Map<string, StoredRow>;
  readonly parentRows: Map<string, StoredRow | null>;
  policy: InterimModelPolicy | null;
  secrets: ReadonlyArray<string>;
  grantByOk: ReadonlyArray<boolean>;
  pageAuthority: AuthorizedSet['pageAuthority'];
  rowContext: ByContext | undefined;
  byContext: ByContext | undefined;
  parentDecisions: readonly ViewerPageParentDecision[];
  originalRows: readonly StoredRow[] | undefined;
  scanned: readonly StoredRow[] | undefined;
  rowAuthority: readonly { allowed: readonly boolean[]; grants: readonly Pick<InterimGrant, 'fields'>[];
    record?: ProjectedRecord | null; decisions?: readonly InstalledSourceRowDecision[] }[] | undefined;
  revalidateRowAuthority: (() => Promise<void>) | undefined;
  predicateMatches: readonly boolean[] | undefined;
}

/** Policy-declared parent chain: one membership/grant read per ancestor. */
async function walkQueryParentPolicies(
  run: AuthorizedQueryRun,
  current: ByContext,
  decisions: ViewerPageParentDecision[],
  visited: Set<ModelName>,
  selected: RecordParent | null,
): Promise<readonly ViewerPageParentDecision[]> {
  while (selected !== null && run.page?.parentPolicies !== undefined) {
    if (visited.has(selected.model)) throw new StateError('validation', 'Invalid cyclic page parent scope.');
    visited.add(selected.model);
    const declaration = run.page.parentPolicies.get(selected.model);
    if (declaration === undefined) throw new StateError('validation', 'Parent scope requires a checked generated model read.');
    if (!(await evaluateBy(declaration.by, current))) throw new StateError('not_found', 'Parent record not found.');
    const identity = JSON.stringify([selected.model, selected.id]);
    // The coherent replay evaluates policy only, over the original rows.
    if (!run.parentRows.has(identity)) run.parentRows.set(identity, await run.input.store.load(selected.model, selected.id));
    const row = run.parentRows.get(identity)!;
    if (row === null) throw new StateError('not_found', 'Parent record not found.');
    const parentPolicy = run.input.policy.get(selected.model);
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
}

/** Enrolled parent decisions for one authorization context. */
async function evaluateQueryParents(run: AuthorizedQueryRun, current: ByContext): Promise<readonly ViewerPageParentDecision[]> {
  if (run.sourceReads !== undefined && run.page?.parent !== undefined) {
    const selected = run.page.parent, key = `${selected.model}\0${selected.id}`;
    if (!run.sourceRows.has(key)) {
      const row = await run.input.store.cohortLoad({ model: selected.model, id: selected.id, expectedRevision: run.revision });
      if (row === null) throw new StateError('not_found', 'Parent record not found.');
      if (row.id !== selected.id) throw new StateError('validation', 'Parent row identity mismatch.');
      run.sourceRows.set(key, row);
    }
    const projected = await projectInstalledSourceRowAndAncestors({ model: selected.model, row: run.sourceRows.get(key)!,
      readPolicies: run.sourceReads, policy: run.input.policy, context: current, revision: run.revision, fence: run.input.fence,
      store: run.input.store, rows: run.sourceRows,
      ...(run.observation?.ownerRows === undefined ? {} : { ownerRows: run.observation.ownerRows }) });
    if (projected.record === null) throw new StateError('not_found', 'Parent record not found.');
    return projected.decisions.map(decision => ({ model: decision.model, allowed: decision.allowed,
      projection: JSON.stringify(decision.projection) }));
  }
  const decisions: ViewerPageParentDecision[] = [];
  const selected = run.page?.parent ?? null;
  const visited = new Set<ModelName>();
  return walkQueryParentPolicies(run, current, decisions, visited, selected);
}

/** Viewer grant preparation: fail closed on every viewer path, then allow. */
async function prepareQueryViewer(run: AuthorizedQueryRun, current: ByContext, secrets: ReadonlyArray<string>): Promise<boolean[]> {
  let grantedFields: string[] = [];
  if (run.sourceReads !== undefined && (run.selectedRead === undefined || 'grants' in run.selectedRead)) {
    grantedFields = run.selectedRead === undefined ? [] : run.selectedRead.grants.flatMap(grant => [...grant.fields]);
    if (run.input.where !== undefined) for (const path of collectPredicateFields(run.input.where)) checkViewerPath(path, grantedFields, secrets, run.implicitParent);
    for (const term of run.order) checkViewerPath(term.field, grantedFields, secrets, run.implicitParent);
    for (const path of run.extraViewerPaths ?? []) checkViewerPath(path, grantedFields, secrets, run.implicitParent);
    return [];
  }
  const allowed = run.policy === null ? [] : await viewerGrantAuthority(run.policy, current);
  grantedFields = run.policy === null ? [] : run.policy.grants.flatMap((grant, index) =>
    allowed[index] || byDependsOnRow(grant.by) ? [...grant.fields] : []);
  if (run.input.where !== undefined) for (const path of collectPredicateFields(run.input.where)) checkViewerPath(path, grantedFields, secrets, run.implicitParent);
  for (const term of run.order) checkViewerPath(term.field, grantedFields, secrets, run.implicitParent);
  for (const path of run.extraViewerPaths ?? []) checkViewerPath(path, grantedFields, secrets, run.implicitParent);
  return allowed;
}

/** One row's authority: installed-source projection or legacy grant path. */
async function projectAuthorizedQueryRow(
  run: AuthorizedQueryRun,
  row: StoredRow,
  current: ByContext,
  cached: readonly boolean[],
  selectedPolicy: InterimModelPolicy | null,
): Promise<{ allowed: readonly boolean[]; grants: readonly Pick<InterimGrant, 'fields'>[];
  record?: ProjectedRecord | null; decisions?: readonly InstalledSourceRowDecision[] }> {
  if (run.sourceReads !== undefined) {
    run.sourceRows.set(`${run.input.model}\0${row.id}`, row);
    return projectInstalledSourceRowAndAncestors({ model: run.input.model, row, readPolicies: run.sourceReads,
      policy: run.input.policy, context: current, revision: run.revision, fence: run.input.fence, store: run.input.store, rows: run.sourceRows, archived: run.archived,
      ...(run.observation?.ownerRows === undefined ? {} : { ownerRows: run.observation.ownerRows }) });
  }
  return selectedPolicy === null ? { allowed: [], grants: [] } :
    viewerRowAuthority(selectedPolicy, current, cached, row);
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
  // Fence revision FIRST: every row below is read at or after this checkpoint.
  const head = await readAuthorizedQueryRevision(input, eventual, predicate, page);
  const run: AuthorizedQueryRun = {
    input, eventual, predicate, page, observation, extraViewerPaths,
    ...head,
    implicitParent: queryImplicitParent(input, head.selectedRead, page),
    sourceRows: new Map<string, StoredRow>(),
    parentRows: new Map<string, StoredRow | null>(),
    policy: null, secrets: [], grantByOk: [], pageAuthority: undefined,
    rowContext: undefined, byContext: undefined, parentDecisions: [],
    originalRows: undefined, scanned: undefined, rowAuthority: undefined,
    revalidateRowAuthority: undefined, predicateMatches: undefined,
  };

  // Viewer authorization: resolve the caller membership once, evaluate each
  // grant's row-independent `by` once, then fail closed on every viewer path
  // (where, order, aggregate field) before touching storage rows.
  await authorizeAuthorizedQueryRun(run);

  // Unbounded scan: storage applies model/archived/order only. `where` stays
  // in memory (grant visibility first), and `limit` is never pushed down —
  // overflow must error, never truncate.
  await scanAuthorizedQueryRows(run);

  // Visibility (viewer: >=1 matching grant) then `where`, both in memory.
  // Viewers project BEFORE where: a row visible via grant B evaluates
  // predicates over its own projected values only, so A-only paths read as
  // missing (never match comparisons) instead of leaking stored values.
  const matched = await matchAuthorizedQueryRows(run);

  // One engine ordering over the effective order plus the id tiebreak, so
  // results are identical regardless of backend scan order.
  const numeric = decodeTypedOrder(matched, run.numericTypes.types);
  matched.sort((left, right) => compareRowsForOrder(left, right, run.order, numeric));
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

  if (run.revalidateRowAuthority !== undefined) {
    await run.revalidateRowAuthority();
    if (await input.store.readRevision() !== run.revision) throw new StateError('conflict', 'Row grant read moved beyond its original State revision.');
  }
  return { revision: run.revision, rows, ...(run.pageAuthority === undefined ? {} : { pageAuthority: run.pageAuthority }) };
}

/** Validated caller input with the fenced pre-scan revision. */
async function readAuthorizedQueryRevision(
  input: BaseQueryInput,
  eventual: boolean,
  predicate: ViewerRecordsInput['predicate'],
  page: AuthorizedQueryRun['page'],
): Promise<Omit<AuthorizedQueryRun, 'input' | 'eventual' | 'predicate' | 'page' | 'observation' | 'extraViewerPaths' |
  'implicitParent' | 'sourceRows' | 'parentRows' | 'policy' | 'secrets' | 'grantByOk' | 'pageAuthority' |
  'rowContext' | 'byContext' | 'parentDecisions' | 'originalRows' | 'scanned' | 'rowAuthority' |
  'revalidateRowAuthority' | 'predicateMatches'>> {
  const archived = queryArchiveMode(input.archived);
  const suppliedReads = (input as ViewerRecordsInput).sourceReadPolicies;
  if (suppliedReads !== undefined && (input.authority !== 'viewer' || eventual)) {
    throw new StateError('validation', 'Installed source policies require a current viewer query.');
  }
  const sourceReads = suppliedReads === undefined ? undefined : captureSourceReadPolicies(suppliedReads);
  const selectedRead = sourceReads?.get(input.model);
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 0)) {
    throw new StateError('validation', `Invalid query limit: ${JSON.stringify(input.limit)}.`);
  }
  const ownerParent = input.authority === 'owner' ? (input as OwnerRecordsInput).parent : undefined;
  if (ownerParent !== undefined && (typeof ownerParent !== 'object' || ownerParent === null ||
      Object.keys(ownerParent).length !== 2 || typeof ownerParent.model !== 'string' || ownerParent.model === '' ||
      typeof ownerParent.id !== 'string' || ownerParent.id === '')) {
    throw new StateError('validation', 'Owner query parent requires one exact model and record identity.');
  }
  const coherentPredicate = predicate !== undefined && hasInstalledSourceQueryPredicate(page?.membershipPredicate ?? predicate);
  const order = checkAuthorizedQueryOrder(input);
  if (input.where !== undefined) {
    validatePredicateShape(input.where);
    // Derived-bool placement is enforced before any async read or
    // scan: the per-row matcher cannot refuse on an empty domain,
    // and unsupported or/not nesting must never silently match
    // nothing. Every query path (direct, paged, owner) funnels here.
    assertDerivedBoolPlacement(input.where);
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
  const revision = await readQueryFenceRevision(input, page);
  enrollQueryFence(input, eventual, revision);
  return { archived, sourceReads, selectedRead, order, numericTypes, decisionIntFields,
    coherentPredicate, revision, modelDescriptorMismatch };
}

/** Caller order terms: valid directions with string field paths. */
function checkAuthorizedQueryOrder(input: BaseQueryInput): ReadonlyArray<OrderTerm> {
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
  return order;
}

/** Pre-scan revision with the pagination restart check. */
async function readQueryFenceRevision(input: BaseQueryInput, page: AuthorizedQueryRun['page']): Promise<Revision> {
  const revision = await input.store.readRevision();
  if (page?.revision !== undefined && page.revision !== revision) {
    throw new StateError('conflict', 'Collection changed; restart pagination.');
  }
  return revision;
}

/** T32b owner-checkpoint join: conflicts move, then enrolls the model read. */
function enrollQueryFence(input: BaseQueryInput, eventual: boolean, revision: Revision): void {
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
}

/** Implicit parent scope: undeclared parents read through the selected grant. */
function queryImplicitParent(
  input: BaseQueryInput,
  selectedRead: ViewerSourceReadPolicy | undefined,
  page: AuthorizedQueryRun['page'],
): boolean {
  return !Object.hasOwn(input.modelDescriptor?.fields ?? {}, 'parent') &&
    !(selectedRead !== undefined && 'fields' in selectedRead && selectedRead.fields.includes('parent')) &&
    (selectedRead?.parent !== undefined || page?.parentPolicies?.get(input.model)?.parent !== undefined);
}

/** Caller membership once, enrolled, with its authority context. */
async function readQueryCallerContext(input: BaseQueryInput, eventual: boolean): Promise<ByContext> {
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
  return {
    actorUserId: input.context.actorUserId,
    teamId: input.context.teamId,
    membership,
    memberships: input.memberships,
  };
}

/** Viewer authorization: membership once, row-independent grants, then paths. */
async function authorizeAuthorizedQueryRun(run: AuthorizedQueryRun): Promise<void> {
  const { input, page } = run;
  if (input.authority !== 'viewer') return;
  const byCtx = await readQueryCallerContext(input, run.eventual);
  run.byContext = byCtx;
  const found = input.policy.get(input.model);
  if (found !== undefined) { run.policy = found; run.secrets = found.secretFields; }
  if (run.selectedRead !== undefined && 'grants' in run.selectedRead) run.secrets = run.selectedRead.secretFields;
  const parentDependsOnRow = [...(page?.parentPolicies?.keys() ?? [])].some(model =>
    input.policy.get(model)?.grants.some(grant => byDependsOnRow(grant.by)));
  if (run.sourceReads !== undefined || run.policy?.grants.some(grant => byDependsOnRow(grant.by)) || parentDependsOnRow || run.coherentPredicate) {
    run.rowContext = byCtx;
  } else {
    run.parentDecisions = await evaluateQueryParents(run, byCtx);
    run.grantByOk = await prepareQueryViewer(run, byCtx, run.secrets);
  }
  if (page !== undefined && run.rowContext === undefined) run.pageAuthority = {
    policy: run.policy, byContext: byCtx, allowed: run.grantByOk, parents: run.parentDecisions,
    evaluateParents: (current: ByContext) => evaluateQueryParents(run, current),
  };
}

/** Coherent source-predicate matches over projected rows in domain order. */
async function matchCoherentPredicateRows(
  run: AuthorizedQueryRun,
  current: ByContext,
  observedRows: readonly StoredRow[],
  rows: { allowed: readonly boolean[]; grants: readonly Pick<InterimGrant, 'fields'>[];
    record?: ProjectedRecord | null; decisions?: readonly InstalledSourceRowDecision[] }[],
  matches: boolean[],
): Promise<void> {
  const { input } = run;
  for (const [index, row] of observedRows.entries()) {
    const authority = rows[index]!;
    const projected = 'record' in authority ? authority.record :
      authority.grants.length === 0 ? null : projectRow(row, authority.grants, run.secrets);
    if (projected === null) { matches.push(false); continue; }
    if (input.where !== undefined && !matchViewerWhereWithDerived(input.where, projected, row,
      authority.grants, run.decisionIntFields, run.implicitParent, input.model, run.secrets)) {
      matches.push(false); continue;
    }
    const detached = cleanCopy(projected) as ProjectedRecord;
    retainQuerySourcePresence(detached, input.model, run.revision, Object.keys(row.data));
    // The source predicate sees only projected fields. Its membership
    // reads join this complete domain's coherent authority observation.
    matches.push(await evaluateInstalledReadPredicate(run.predicate!, detached, {
      context: current, row: { ...row, data: cleanCopy(projected.data) as StoredRow['data'] }, revision: run.revision, fence: input.fence,
      sourcePresence: Object.freeze(Object.keys(row.data)),
    }, input.store));
    if (await input.store.readRevision() !== run.revision) {
      throw new StateError('conflict', 'Source predicate moved beyond its original State revision.');
    }
  }
}

/** Row-grant observation for one authority context: parents, rows, matches. */
async function observeQueryRowAuthority(
  run: AuthorizedQueryRun,
  current: ByContext,
  selectedPolicy: InterimModelPolicy | null,
  spec: QuerySpec,
): Promise<{ cached: readonly boolean[]; rows: { allowed: readonly boolean[]; grants: readonly Pick<InterimGrant, 'fields'>[];
  record?: ProjectedRecord | null; decisions?: readonly InstalledSourceRowDecision[] }[]; parents: readonly ViewerPageParentDecision[]; matches: boolean[] }> {
  const { input, page, observation } = run;
  if (page?.readBy !== undefined && !(await evaluateBy(page.readBy, current))) {
    throw new StateError('forbidden', 'This operation is not permitted for the caller.');
  }
  const parents = await evaluateQueryParents(run, current);
  const cached = await prepareQueryViewer(run, current, run.secrets);
  const observedRows = run.originalRows ??= observation?.domain === undefined ? await input.store.query(spec) : [...observation.domain];
  if (page !== undefined && observedRows.length > VIEWER_PAGE_MAX_CANDIDATES) throw new StateError('limit', 'Collection exceeds the page candidate budget; narrow the collection scope.');
  const rows: { allowed: readonly boolean[]; grants: readonly Pick<InterimGrant, 'fields'>[];
    record?: ProjectedRecord | null; decisions?: readonly InstalledSourceRowDecision[] }[] = [];
  const matches: boolean[] = [];
  for (const row of observedRows) rows.push(await projectAuthorizedQueryRow(run, row, current, cached, selectedPolicy));
  if (run.coherentPredicate) await matchCoherentPredicateRows(run, current, observedRows, rows, matches);
  return { cached, rows, parents, matches };
}

/** Row-grant booleans after the observed scan (installed or legacy path). */
function computeRowGrantByOk(
  run: AuthorizedQueryRun,
  selectedPolicy: InterimModelPolicy | null,
  cached: readonly boolean[],
  rows: readonly { allowed: readonly boolean[] }[],
): ReadonlyArray<boolean> {
  if (run.sourceReads === undefined) {
    return selectedPolicy?.grants.map((grant, index) => byDependsOnRow(grant.by)
      ? rows.some(row => row.allowed[index] === true) : cached[index] === true) ?? [];
  }
  return (run.selectedRead !== undefined && 'grants' in run.selectedRead ? run.selectedRead.grants : selectedPolicy?.grants ?? [])
    .map((_, index) => rows.some(row => row.allowed[index] === true));
}

/** Unbounded scan with row-grant discovery at the fenced revision. */
async function scanAuthorizedQueryRows(run: AuthorizedQueryRun): Promise<void> {
  const { input, page, observation } = run;
  if (run.modelDescriptorMismatch) {
    throw new StateError('validation', 'Query model descriptor does not match the selected model.');
  }
  for (const field of run.numericTypes.arrays) {
    throw new StateError('validation', `Query order field ${JSON.stringify(field)} requires a singular numeric declaration.`);
  }
  const spec: QuerySpec = {
    model: input.model,
    authority: input.authority,
    order: toStorageOrder(run.order),
    archived: run.archived,
    ...(input.authority !== 'owner' || (input as OwnerRecordsInput).parent === undefined ? {} : {
      parent: (input as OwnerRecordsInput).parent,
    }),
    ...(page === undefined ? {} : {
      limit: VIEWER_PAGE_MAX_CANDIDATES + 1,
      ...(page.parent === undefined ? {} : { parent: page.parent }),
    }),
  };
  if (run.rowContext !== undefined) {
    const selectedPolicy = run.policy;
    const authority = await observeRowGrantAuthority(run.rowContext,
      current => observeQueryRowAuthority(run, current, selectedPolicy, spec));
    run.scanned = run.originalRows!;
    run.rowAuthority = authority.value.rows;
    run.revalidateRowAuthority = authority.revalidate;
    if (run.coherentPredicate) run.predicateMatches = authority.value.matches;
    if (await input.store.readRevision() !== run.revision) throw new StateError('conflict', 'Row grant discovery moved beyond its original State revision.');
    run.grantByOk = computeRowGrantByOk(run, selectedPolicy, authority.value.cached, authority.value.rows);
    if (page !== undefined) run.pageAuthority = { policy: run.policy, byContext: run.rowContext, allowed: run.grantByOk,
      parents: authority.value.parents, revalidate: authority.revalidate };
  } else {
    run.scanned = observation?.domain === undefined ? await input.store.query(spec) : [...observation.domain];
  }
  if (page !== undefined && run.scanned.length > VIEWER_PAGE_MAX_CANDIDATES) {
    throw new StateError('limit', 'Collection exceeds the page candidate budget; narrow the collection scope.');
  }
}

/** Generated-source verdict for one projected row: predicate or observation. */
async function checkViewerRowPredicate(
  run: AuthorizedQueryRun,
  projected: ProjectedRecord,
  row: StoredRow,
  presence: ReadonlyArray<string>,
  index: number,
): Promise<boolean> {
  const { input, observation } = run;
  // Copy metadata (including parent) and nested projected data again:
  // callback mutation must never alter the matched or output rows.
  const detached = cleanCopy(projected) as ProjectedRecord;
  retainQuerySourcePresence(detached, input.model, run.revision, presence);
  const accepted = observation === undefined
    ? run.coherentPredicate ? run.predicateMatches![index]! : await executeUnboundReadPredicate(run.predicate!, detached)
    : await observation.predicate(detached, row);
  if (typeof accepted !== 'boolean') {
    throw new StateError('validation', 'Generated-source query predicate must return a boolean.');
  }
  return accepted;
}

/** One viewer row in scan order: grants, where, predicate, selection. */
async function matchOneViewerRow(
  run: AuthorizedQueryRun,
  row: StoredRow,
  index: number,
  matched: StoredRow[],
): Promise<void> {
  const { input, observation } = run;
  const matching = run.rowAuthority?.[index]?.grants ?? (run.policy === null ? [] :
    (await viewerRowAuthority(run.policy, run.byContext!, run.grantByOk, row)).grants);
  const projected = run.sourceReads !== undefined ? run.rowAuthority![index]!.record ?? null :
    matching.length === 0 ? null : projectRow(row, matching, run.secrets);
  if (projected === null) {
    return;
  }
  const presence = Object.freeze(Object.keys(row.data));
  const candidateIndex = observation?.candidates.length;
  const candidate = observation === undefined ? undefined : {
    row, record: cleanCopy(projected) as ProjectedRecord, matched: false,
  };
  if (candidate !== undefined) {
    retainQuerySourcePresence(candidate.record, input.model, run.revision, presence);
    observation!.candidates.push(candidate);
  }
  if (input.where !== undefined && !matchViewerWhereWithDerived(input.where, projected, row,
    matching, run.decisionIntFields, run.implicitParent, input.model, run.secrets)) {
    return;
  }
  if (run.predicate !== undefined || observation !== undefined) {
    if (!await checkViewerRowPredicate(run, projected, row, presence, index)) return;
  }
  const selected = { ...row, data: projected.data };
  retainQuerySourcePresence(selected, input.model, run.revision, presence);
  matched.push(selected);
  if (candidate !== undefined) {
    candidate.matched = true;
    observation!.indices.set(selected, candidateIndex!);
  }
}

/** Visibility then `where`, both in memory: owner rows or viewer projection. */
async function matchAuthorizedQueryRows(run: AuthorizedQueryRun): Promise<StoredRow[]> {
  const { input } = run;
  const matched: StoredRow[] = [];
  if (input.authority === 'owner') {
    for (const row of run.scanned!) {
      const parent = (input as OwnerRecordsInput).parent;
      if (parent !== undefined && (row.parent?.model !== parent.model || row.parent.id !== parent.id)) {
        throw new StateError('validation', 'Owner query returned a row outside its checked parent domain.');
      }
      if (input.where !== undefined && !evalPredicateForRow(input.where, row, run.decisionIntFields, run.implicitParent)) {
        continue;
      }
      matched.push(row);
    }
    return matched;
  }
  for (const [index, row] of run.scanned!.entries()) {
    await matchOneViewerRow(run, row, index, matched);
  }
  return matched;
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
  const selection = clonePageSelection(input);
  const archived = queryArchiveMode(selection.archived);
  const search = selection.search;
  viewerPageSearchTuple(search, input.modelDescriptor);
  const limit = selection.limit ?? VIEWER_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > VIEWER_PAGE_MAX_LIMIT) {
    throw new StateError('validation', 'Page limit must be between 1 and 100.');
  }
  if (selection.where !== undefined) viewerPagePredicateTuple(selection.where);
  const order = viewerPageOrder(selection.order);
  const requestedSearch = search?.query.toLowerCase() ?? '';
  const predicate = makePagePredicate(input, search, requestedSearch);
  const position = checkPageContinuation(selection);
  const set = await runAuthorizedQuery({
    ...input, order, archived,
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
  const { page, captured } = assembleViewerPage(set, position, limit, selection);
  const result = transform === undefined ? page : await transform(structuredClone(page), [...captured.allowed], structuredClone(captured.parents));
  // The admitted page owner finishes its outer caller checks before invoking
  // this same retained observation. Direct page queries finish here.
  const revalidate = (): Promise<void> => revalidatePageAuthority(input, set.revision, captured);
  if (retainFinalAuthority === undefined) await revalidate();
  else retainFinalAuthority(revalidate);
  return result;
}

/** Sliced page window with its continuation over the authorized set. */
function assembleViewerPage(
  set: AuthorizedSet,
  position: ViewerPageSelection['continuation'],
  limit: number,
  selection: ViewerPageSelection,
): { page: ViewerPageRecordsResult; captured: NonNullable<AuthorizedSet['pageAuthority']> } {
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
  return { page, captured: set.pageAuthority! };
}

/** Detached data-only page selection: authority, shape and count request. */
function clonePageSelection(input: ViewerPageQueryInput): ViewerPageSelection {
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
  if (Object.keys(selection).some(key => !['where', 'order', 'search', 'includeCount', 'limit', 'parent', 'continuation', 'archived'].includes(key))) {
    throw new StateError('validation', 'Unknown page selection field.');
  }
  if (selection.includeCount !== undefined && selection.includeCount !== true) {
    throw new StateError('validation', 'Invalid page count request.');
  }
  return selection;
}

/** Search/generated predicate for one page: match text, then caller checks. */
function makePagePredicate(
  input: ViewerPageQueryInput,
  search: ViewerPageSelection['search'],
  requestedSearch: string,
): ((record: Readonly<ProjectedRecord>, observation?: Parameters<InstalledSourceQueryPredicate>[1]) => Promise<boolean>) | undefined {
  if (search === undefined && input.generatedPredicate === undefined) return undefined;
  return async (record: Readonly<ProjectedRecord>, observation?: Parameters<InstalledSourceQueryPredicate>[1]): Promise<boolean> => {
    if (search !== undefined && requestedSearch !== '' &&
        !search.fields.some(field => {
          const value = record.data[field];
          return typeof value === 'string' && value.toLowerCase().includes(requestedSearch);
        })) return false;
    if (input.generatedPredicate === undefined) return true;
    if (observation === undefined) return executeUnboundReadPredicate(input.generatedPredicate, record);
    return evaluateInstalledReadPredicate(input.generatedPredicate, record, observation, input.store);
  };
}

/** Continuation position for one page selection. */
function checkPagePosition(position: ViewerPageSelection['continuation']): void {
  if (position !== undefined && (typeof position !== 'object' || position === null || Array.isArray(position) ||
      !Number.isSafeInteger(position.revision) || position.revision < 0 ||
      typeof position.after !== 'string' || position.after === '' ||
      Object.keys(position).some(key => key !== 'revision' && key !== 'after'))) {
    throw new StateError('validation', 'Invalid page continuation position.');
  }
}

/** Continuation position and admitted parent for one page selection. */
function checkPageContinuation(selection: ViewerPageSelection): ViewerPageSelection['continuation'] {
  checkPagePosition(selection.continuation);
  if (selection.parent !== undefined && (typeof selection.parent !== 'object' || selection.parent === null || Array.isArray(selection.parent) ||
      typeof selection.parent.model !== 'string' || selection.parent.model === '' ||
      typeof selection.parent.id !== 'string' || selection.parent.id === '' || Object.keys(selection.parent).length !== 2 ||
      !Object.hasOwn(selection.parent, 'model') || !Object.hasOwn(selection.parent, 'id'))) {
    throw new StateError('validation', 'Invalid admitted page parent.');
  }
  return selection.continuation;
}

/** Final page authority: revision fences around retained parent/grant reads. */
async function revalidatePageAuthority(
  input: ViewerPageQueryInput,
  revision: Revision,
  captured: NonNullable<AuthorizedSet['pageAuthority']>,
): Promise<void> {
  if (await input.store.readRevision() !== revision) {
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
  if (await input.store.readRevision() !== revision) {
    throw new StateError('conflict', 'Collection changed during the page read; restart pagination.');
  }
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
