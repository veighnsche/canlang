/**
 * Lane 03 S4: interim engine-local model policy table for authorized queries.
 *
 * INTERIM — marked for outright replacement when L1 compiles policy
 * descriptors. Until then, programs hand-build `InterimModelPolicy` values and
 * the query engine enforces them. Build-time mistakes (duplicate models,
 * malformed paths, grants over secrets) throw plain `Error`s as programmer
 * bugs; malformed caller queries raise `StateError` validation instead.
 *
 * Predicate evaluation lives here (pure, no store) so the query engine can
 * import it without a dependency cycle.
 */

import { deepFreeze } from '../internal/own-data.js';
import { observeRowGrantAuthority } from './membership-facts.js';
import type {
  ModelName,
  CanonicalModelDescriptor,
  QueryPredicate,
  StoredRow,
} from '@canlang/contracts';
import type { Membership } from '@canlang/contracts';
import { StateError } from '../errors.js';
import { compareInt, decodeValue, SchemaError, ValueError } from '@canlang/values';
import {
  byDependsOnRow,
  evaluateBy,
  validateByPredicate,
  type ByPredicate,
  type MembershipReader,
} from './roles.js';
import { bindPolicyRowContext, registerPolicyRowFields } from './row-subject.js';

/**
 * One interim visibility grant: rows are visible to callers satisfying `by`
 * (and, when present, the row-level `when` match). Each `fields` entry is a
 * dot path into `data`; a granted path projects its whole subtree.
 */
export interface InterimGrant {
  readonly by: ByPredicate;
  readonly fields: ReadonlyArray<string>;
  readonly when?: QueryPredicate;
}

/**
 * Interim per-model policy: secret subtrees plus visibility grants. A secret
 * path marks a `SecretValue`-kind or declared-secret subtree that projection,
 * viewer predicates, and viewer aggregates must never expose.
 */
export interface InterimModelPolicy {
  readonly model: ModelName;
  readonly secretFields: ReadonlyArray<string>;
  readonly grants: ReadonlyArray<InterimGrant>;
}

/** Validated, frozen policy table keyed by model. */
export type PolicyTable = ReadonlyMap<ModelName, InterimModelPolicy>;

/** Caller authorization facts for `by` evaluation (resolved once per query). */
export interface ByContext {
  readonly actorUserId: string | null;
  readonly teamId: string | null;
  readonly membership: Membership | null;
  readonly memberships: MembershipReader;
}

/** Row metadata names, resolved from the row envelope rather than `data`. */
const METADATA_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'version',
  'created',
  'updated',
  'createdBy',
  'updatedBy',
  'archivedAt',
]);

/** True when the path addresses row metadata (first segment is reserved). */
export function isMetadataPath(path: string): boolean {
  const head = path.split('.')[0];
  return head !== undefined && METADATA_FIELDS.has(head);
}

/** True when `path` equals `base` or sits strictly under it. */
export function isEqualOrUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}.`);
}

/** Build-time dot-path check: non-empty with no empty segments. */
function checkDotPath(path: string, what: string): void {
  if (path === '' || path.split('.').some((segment) => segment === '')) {
    throw new Error(`Invalid ${what} dot path: ${JSON.stringify(path)}`);
  }
}

/**
 * Validate and freeze interim model policies into a lookup table.
 *
 * Throws plain `Error` on programmer bugs: empty model names, duplicate
 * models, malformed dot paths, empty path entries, malformed `by` shapes,
 * malformed `when` shapes, any grant field equal to or under a secret path
 * (fail fast; a grant above a secret is allowed and the secret subtree is
 * carved out of every projection instead), or any `when` row-match touching
 * a secret path (a viewer-observable visibility oracle bit). Row role subjects
 * require a matching canonical owning singular user/user? field declaration.
 */
export function buildPolicyTable(
  models: ReadonlyArray<InterimModelPolicy>,
  declarations: readonly CanonicalModelDescriptor[] = [],
): PolicyTable {
  const table = new Map<ModelName, InterimModelPolicy>();
  for (const policy of models) {
    const model = policy.model as string;
    if (model === '') {
      throw new Error('Invalid model policy: empty model name');
    }
    if (table.has(policy.model)) {
      throw new Error(`Duplicate model policy: ${JSON.stringify(model)}`);
    }
    for (const secret of policy.secretFields) {
      checkDotPath(secret, 'secretFields');
    }
    const rowFields = new Map<string, 'user' | 'user?'>();
    const grants = policy.grants.map((grant) => {
      validateByPredicate(grant.by, `grant by on model ${JSON.stringify(model)}`);
      validateRowSubjects(grant.by, policy, declarations, rowFields);
      for (const field of grant.fields) {
        checkDotPath(field, 'grant fields');
        for (const secret of policy.secretFields) {
          if (isEqualOrUnder(field, secret)) {
            throw new Error(
              `Grant field ${JSON.stringify(field)} is secret on model ` +
                `${JSON.stringify(model)} (secret: ${JSON.stringify(secret)})`,
            );
          }
        }
      }
      if (grant.when !== undefined) {
        try {
          validatePredicateShape(grant.when);
        } catch (error) {
          throw new Error(
            `Invalid grant when on model ${JSON.stringify(model)}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        for (const path of collectPredicateFields(grant.when)) {
          for (const secret of policy.secretFields) {
            if (isEqualOrUnder(path, secret)) {
              throw new Error(
                `Grant when path ${JSON.stringify(path)} is secret on model ` +
                  `${JSON.stringify(model)} (secret: ${JSON.stringify(secret)})`,
              );
            }
          }
        }
      }
      let by: ByPredicate;
      let when: QueryPredicate | undefined;
      try {
        by = structuredClone(grant.by);
        when = grant.when === undefined ? undefined : structuredClone(grant.when);
      } catch {
        // Unserializable extras (functions, symbols) fail here as plain
        // programmer errors, never as DataCloneError at query time.
        throw new Error(
          `Invalid grant on model ${JSON.stringify(model)}: policy ASTs must be serializable data.`,
        );
      }
      return Object.freeze({
        by: deepFreeze(by),
        fields: Object.freeze([...grant.fields]),
        ...(when !== undefined ? { when: deepFreeze(when) } : {}),
      }) as InterimGrant;
    });
    const frozen = Object.freeze({
      model: policy.model,
      secretFields: Object.freeze([...policy.secretFields]),
      grants: Object.freeze(grants),
    }) as InterimModelPolicy;
    registerPolicyRowFields(frozen, rowFields);
    table.set(policy.model, frozen);
  }
  return table;
}

/** Own data descriptors prevent declaration or subject accessors from becoming authority. */
function ownDeclarationData(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!('value' in descriptor)) throw new Error('Invalid row role subject: canonical declarations must be own data.');
  return descriptor.value;
}

function validateRoleSubjectPerson(
  by: Extract<ByPredicate, { roleSubject: { role: string; person: unknown } }>,
  policy: InterimModelPolicy,
  declarations: readonly CanonicalModelDescriptor[],
  fields: Map<string, 'user' | 'user?'>,
): void {
  const person = by.roleSubject.person;
  if (typeof person === 'string') return;
  if (person.model !== policy.model || isMetadataPath(person.field) || person.field === 'parent') {
    throw new Error('Invalid row role subject: field must belong to the owning model data.');
  }
  for (const secret of policy.secretFields) {
    if (isEqualOrUnder(person.field, secret) || isEqualOrUnder(secret, person.field)) {
      throw new Error('Invalid row role subject: secret fields cannot determine viewer grants.');
    }
  }
  const owners = declarations.filter((declaration) => ownDeclarationData(declaration, 'name') === policy.model);
  const field = owners.length === 1 ? ownDeclarationData(ownDeclarationData(owners[0], 'fields'), person.field) : undefined;
  const type = ownDeclarationData(field, 'valueType');
  const nullable = ownDeclarationData(field, 'nullable');
  if ((type !== 'user' && type !== 'user?') || ownDeclarationData(field, 'array') !== undefined ||
    (nullable !== undefined && nullable !== (type === 'user?')) ||
    typeof ownDeclarationData(field, 'required') !== 'boolean' ||
    typeof ownDeclarationData(field, 'serverOnly') !== 'boolean') {
    throw new Error('Invalid row role subject: matching canonical singular user/user? declaration required.');
  }
  fields.set(person.field, type);
}

function validateRowSubjects(
  by: ByPredicate,
  policy: InterimModelPolicy,
  declarations: readonly CanonicalModelDescriptor[],
  fields: Map<string, 'user' | 'user?'>,
): void {
  if (typeof by === 'string' || 'role' in by) return;
  if ('and' in by || 'or' in by) {
    for (const term of 'and' in by ? by.and : by.or) validateRowSubjects(term, policy, declarations, fields);
    return;
  }
  if ('not' in by) return validateRowSubjects(by.not, policy, declarations, fields);
  return validateRoleSubjectPerson(by, policy, declarations, fields);
}

/** Attach a row using only the field inventory retained by its validated owning policy. */
export function withPolicyRow(policy: InterimModelPolicy, byCtx: ByContext, row: StoredRow): ByContext {
  return bindPolicyRowContext(policy, byCtx, row);
}

/**
 * Resolve a dot path against a stored row. Metadata names resolve to the row
 * envelope; everything else traverses `row.data` through plain objects only
 * (arrays are opaque leaves, so indexed paths never resolve). Unknown or
 * untraversable paths yield `undefined` (missing); an explicit `null` leaf is
 * returned as `null`.
 */
function resolveParentHead(row: StoredRow, segments: readonly string[], implicitParent: boolean): unknown {
  // An authored stored field keeps its ordinary data/grant semantics.
  // Only the exact implicit identity may consume the containing envelope.
  return Object.hasOwn(row.data, 'parent') ? row.data.parent :
    implicitParent && segments.length === 1 ? row.parent ?? null : undefined;
}

function resolveRowHead(row: StoredRow, head: string, segments: readonly string[], implicitParent: boolean): unknown {
  switch (head) {
    case 'id':
      return row.id;
    case 'version':
      return row.version;
    case 'created':
      return row.created;
    case 'updated':
      return row.updated;
    case 'createdBy':
      return row.createdBy;
    case 'updatedBy':
      return row.updatedBy;
    case 'archivedAt':
      return row.archivedAt;
    case 'parent':
      return resolveParentHead(row, segments, implicitParent);
    default: {
      const data = row.data as Readonly<Record<string, unknown>>;
      return Object.hasOwn(data, head) ? data[head] : undefined;
    }
  }
}

function traverseRowSegments(current: unknown, segments: readonly string[]): unknown {
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    const obj = current as Readonly<Record<string, unknown>>;
    if (!Object.hasOwn(obj, segment)) {
      return undefined;
    }
    current = obj[segment];
  }
  return current;
}

export function resolveRowPath(row: StoredRow, path: string, implicitParent = false): unknown {
  const segments = path.split('.');
  const head = segments[0];
  if (head === undefined || head === '') {
    return undefined;
  }
  return traverseRowSegments(resolveRowHead(row, head, segments, implicitParent), segments.slice(1));
}

/** True for server-only secret-kind values, which must never be projected. */
export function isSecretValue(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Readonly<Record<string, unknown>>)['kind'] === 'secret'
  );
}

/** Nullish check covering both missing (`undefined`) and JSON `null`. */
function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

/**
 * Validate one comparison operand (INTERIM until L2 exact-equality join).
 * Only number/string/boolean operands are accepted, plus a typed opaque
 * reference identity (`{id}`) for `eq`/`ne` on user/member/model reference
 * fields (DESIGN 977); anything else is a caller error, never a silent
 * mismatch — rich values must not silently misorder.
 */
function checkComparisonOperand(op: string, field: string, value: unknown): void {
  const kind = typeof value;
  if (kind === 'number' || kind === 'string' || kind === 'boolean') {
    return;
  }
  if ((op === 'eq' || op === 'ne') && isReferenceIdentity(value)) {
    return;
  }
  if (value === null || value === undefined) {
    throw new StateError(
      'validation',
      `Predicate ${op} on ${JSON.stringify(field)} needs is_null/not_null for null checks.`,
    );
  }
  throw new StateError(
    'validation',
    `Predicate ${op} on ${JSON.stringify(field)} rejected: non-scalar comparison operands must be number, string, boolean, or a reference identity for eq/ne.`,
  );
}

/** Validate `between` bounds: numbers or strings, both the same type. */
function checkBetweenBounds(field: string, lo: unknown, hi: unknown): void {
  const loKind = typeof lo;
  const hiKind = typeof hi;
  const ok =
    (loKind === 'number' && hiKind === 'number') ||
    (loKind === 'string' && hiKind === 'string');
  if (!ok) {
    throw new StateError(
      'validation',
      `Predicate between on ${JSON.stringify(field)} needs number or string bounds of one type.`,
    );
  }
}

/** Leaf predicates need a non-empty string field path. */
function checkPredicateField(op: string, field: unknown): void {
  if (typeof field !== 'string' || field === '') {
    throw new StateError('validation', `Predicate ${op} needs a non-empty string field path.`);
  }
}

/**
 * Eagerly validate predicate operand shapes (no row needed) so malformed
 * queries fail deterministically even when no rows are evaluated. Mirrors the
 * storage adapters, which compile predicates before scanning.
 */
export function validatePredicateShape(predicate: QueryPredicate): void {
  switch (predicate.op) {
    case 'and':
    case 'or':
      for (const arg of predicate.args) {
        validatePredicateShape(arg);
      }
      return;
    case 'not':
      validatePredicateShape(predicate.arg);
      return;
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      checkPredicateField(predicate.op, predicate.field);
      checkComparisonOperand(predicate.op, predicate.field, predicate.value);
      return;
    case 'between':
      checkPredicateField(predicate.op, predicate.field);
      checkBetweenBounds(predicate.field, predicate.lo, predicate.hi);
      return;
    case 'is_null':
    case 'not_null':
      checkPredicateField(predicate.op, predicate.field);
      return;
    default: {
      // Unknown ops are caller errors (StateError), never programmer crashes:
      // S4 callers hand-build `where` until L1 compiles it. Build-time `when`
      // validation wraps this in a plain Error (see buildPolicyTable).
      const op = (predicate as QueryPredicate).op;
      throw new StateError('validation', `Unknown query predicate: ${JSON.stringify(op)}.`);
    }
  }
}

/** Collect every `field` referenced by a predicate AST. */
export function collectPredicateFields(predicate: QueryPredicate): string[] {
  const fields: string[] = [];
  const visit = (node: QueryPredicate): void => {
    switch (node.op) {
      case 'and':
      case 'or':
        for (const arg of node.args) {
          visit(arg);
        }
        return;
      case 'not':
        visit(node.arg);
        return;
      case 'eq':
      case 'ne':
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte':
      case 'between':
      case 'is_null':
      case 'not_null':
        fields.push(node.field);
        return;
      default: {
        const op = (node as QueryPredicate).op;
        throw new StateError('validation', `Unknown query predicate: ${JSON.stringify(op)}.`);
      }
    }
  };
  visit(predicate);
  return fields;
}

/**
 * Typed opaque identity for user/member/model reference equality (DESIGN 977:
 * `eq`, `ne`, using typed opaque identity and authorized lookup). A plain
 * object with an own enumerable non-empty string `id`; extra keys are ignored,
 * mirroring reference equality elsewhere. Never an enum spelling: no case
 * inventory applies, and unknown or inaccessible references simply match
 * nothing (DESIGN 1027 grants no directory/target access).
 */
export function isReferenceIdentity(value: unknown): value is { readonly id: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const property = Object.getOwnPropertyDescriptor(value, 'id');
  return (
    property !== undefined &&
    property.enumerable === true &&
    'value' in property &&
    typeof property.value === 'string' &&
    property.value !== ''
  );
}

/**
 * Compare two typed opaque identities by target id. Returns 0 for equal ids,
 * nonzero otherwise, or null when either side is not an identity — fail
 * closed, never coercing across shapes. Null rows never match non-null
 * comparisons, including `ne` (DESIGN 1023); the caller enforces that.
 */
export function compareReferenceIds(left: unknown, right: unknown): number | null {
  if (!isReferenceIdentity(left) || !isReferenceIdentity(right)) {
    return null;
  }
  return left.id === right.id ? 0 : -1;
}

/**
 * Compare two same-type scalars. Booleans order as 1/0, mirroring storage.
 * Reference identities compare by opaque target id (never enum spellings).
 * Returns null when the pair is not an ordered same-type scalar pair.
 */
function compareScalars(left: unknown, right: unknown): number | null {
  if (typeof left === 'number' && typeof right === 'number') {
    if (Number.isNaN(left) || Number.isNaN(right)) {
      return null;
    }
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    const a = left ? 1 : 0;
    const b = right ? 1 : 0;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (isReferenceIdentity(left) || isReferenceIdentity(right)) {
    return compareReferenceIds(left, right);
  }
  return null;
}

/**
 * Canonical int-wire comparison for declared `int` fields (REVIEW-10
 * typed-int filter fix): stored ints are int64 decimal strings, so the
 * same-type `compareScalars` above fails closed on JSON-number predicate
 * values and misorders string pairs (`'10' < '2'` lexicographically).
 * Values owns the exact numeric comparison — both sides decode through
 * the canonical int wire and compare as bigints, with no `Number`
 * routing (beyond-safe-integer exact). Anything undecodable is a
 * non-match (null), never an error: the same fail-closed outcome that
 * mismatched types already produce.
 */
function compareIntWire(actual: unknown, expected: unknown): number | null {
  try {
    return compareInt(
      decodeValue('int', actual) as bigint,
      decodeValue('int', expected) as bigint,
    );
  } catch (error) {
    if (error instanceof SchemaError || error instanceof ValueError) {
      return null;
    }
    throw error;
  }
}

/**
 * True when `field` names a declared `int` data field eligible for
 * canonical int-wire comparison: a top-level declared name (never row
 * metadata, which the descriptor does not declare, and never a dotted
 * path into a nested value).
 */
function isIntWireField(field: string, intFields: ReadonlySet<string> | undefined): boolean {
  return (
    intFields !== undefined &&
    !isMetadataPath(field) &&
    !field.includes('.') &&
    intFields.has(field)
  );
}

/**
 * Evaluate a predicate against one stored row (two-valued: a row either
 * matches or it does not). Comparisons against null/missing field values are
 * false for all six operators (matching SQL three-valued filtering, where
 * NULL comparisons never match, including under `ne`); scalar type mismatches
 * are likewise false, never errors. Rich or non-scalar operands are caller
 * errors per `checkComparisonOperand`.
 *
 * The optional `intFields` names the query model's declared top-level
 * `int` data fields (from the checked owning descriptor, never request
 * input). Comparisons on those fields decode both sides through the
 * canonical int wire and compare numerically; every other field keeps the
 * exact same-type semantics below. Omitted, evaluation is byte-identical
 * to the legacy behavior on all inputs.
 */
type ComparisonOp = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';


/**
 * Comparison/between evaluation keeps HEAD's exact property-read order:
 * the predicate flows in whole and `op`/`field`/`value` (`lo`/`hi`) are
 * re-read at HEAD's sites — field validation precedes the first value
 * read, and the row getter sits between the repeated reads. Eagerly
 * decomposing the predicate into arguments would hoist the value getters
 * above the field check.
 */
function evalComparisonPredicate(
  predicate: Extract<QueryPredicate, { readonly op: ComparisonOp }>,
  row: StoredRow,
  intFields: ReadonlySet<string> | undefined,
  implicitParent: boolean,
): boolean {
  checkPredicateField(predicate.op, predicate.field);
  checkComparisonOperand(predicate.op, predicate.field, predicate.value);
  const actual = resolveRowPath(row, predicate.field, implicitParent);
  if (isNullish(actual)) {
    return false;
  }
  const compared = isIntWireField(predicate.field, intFields)
    ? compareIntWire(actual, predicate.value)
    : compareScalars(actual, predicate.value);
  if (compared === null) {
    return false;
  }
  // HEAD re-reads the op for the final dispatch: a getter that turns bogus
  // after the earlier reads falls through to the trailing unknown-predicate
  // throw (which reads op again), never to an undefined return.
  switch (predicate.op) {
    case 'eq': return compared === 0;
    case 'ne': return compared !== 0;
    case 'lt': return compared === -1;
    case 'lte': return compared <= 0;
    case 'gt': return compared > 0;
    case 'gte': return compared >= 0;
  }
  const op = predicate.op;
  throw new StateError('validation', `Unknown query predicate: ${JSON.stringify(op)}.`);
}

function evalBetweenPredicate(
  predicate: Extract<QueryPredicate, { readonly op: 'between' }>,
  row: StoredRow,
  intFields: ReadonlySet<string> | undefined,
  implicitParent: boolean,
): boolean {
  checkPredicateField(predicate.op, predicate.field);
  checkBetweenBounds(predicate.field, predicate.lo, predicate.hi);
  const actual = resolveRowPath(row, predicate.field, implicitParent);
  if (isNullish(actual)) {
    return false;
  }
  if (isIntWireField(predicate.field, intFields)) {
    const low = compareIntWire(actual, predicate.lo);
    const high = compareIntWire(actual, predicate.hi);
    return low !== null && high !== null && low >= 0 && high <= 0;
  }
  const low = compareScalars(actual, predicate.lo);
  const high = compareScalars(actual, predicate.hi);
  return low !== null && high !== null && low >= 0 && high <= 0;
}

export function evalPredicateForRow(
  predicate: QueryPredicate,
  row: StoredRow,
  intFields?: ReadonlySet<string>,
  implicitParent = false,
): boolean {
  switch (predicate.op) {
    case 'and':
      for (const arg of predicate.args) {
        if (!evalPredicateForRow(arg, row, intFields, implicitParent)) {
          return false;
        }
      }
      return true;
    case 'or':
      for (const arg of predicate.args) {
        if (evalPredicateForRow(arg, row, intFields, implicitParent)) {
          return true;
        }
      }
      return false;
    case 'not':
      return !evalPredicateForRow(predicate.arg, row, intFields, implicitParent);
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return evalComparisonPredicate(predicate, row, intFields, implicitParent);
    case 'between':
      return evalBetweenPredicate(predicate, row, intFields, implicitParent);
    case 'is_null':
      checkPredicateField(predicate.op, predicate.field);
      return isNullish(resolveRowPath(row, predicate.field, implicitParent));
    case 'not_null':
      checkPredicateField(predicate.op, predicate.field);
      return !isNullish(resolveRowPath(row, predicate.field, implicitParent));
    default: {
      const op = (predicate as QueryPredicate).op;
      throw new StateError('validation', `Unknown query predicate: ${JSON.stringify(op)}.`);
    }
  }
  const op = (predicate as QueryPredicate).op;
  throw new StateError('validation', `Unknown query predicate: ${JSON.stringify(op)}.`);
}

/**
 * Return the grants matching one row: each grant's `by` must hold for the
 * caller and its optional `when` must match the stored row. `by` predicates
 * may depend on an owning user field; engines may cache only row-independent
 * outcomes per query. This helper evaluates both for direct use.
 */
export async function matchGrants(
  policy: InterimModelPolicy,
  byCtx: ByContext,
  row: StoredRow,
): Promise<InterimGrant[]> {
  const authority = await observeMatchingGrants(policy, byCtx, row);
  await authority.revalidate?.();
  return authority.grants;
}

/** Internal disclosure join: retain the original full facts through async reads. */
export async function observeMatchingGrants(
  policy: InterimModelPolicy,
  byCtx: ByContext,
  row: StoredRow,
): Promise<{ readonly grants: InterimGrant[]; readonly revalidate?: () => Promise<void> }> {
  const evaluate = async (current: ByContext) => {
    const matched: InterimGrant[] = [];
    const rowCtx = withPolicyRow(policy, current, row);
    for (const grant of policy.grants) {
      if (!(await evaluateBy(grant.by, rowCtx))) continue;
      if (grant.when !== undefined && !evalPredicateForRow(grant.when, row)) continue;
      matched.push(grant);
    }
    return matched;
  };
  if (!policy.grants.some(grant => byDependsOnRow(grant.by))) return { grants: await evaluate(byCtx) };
  const authority = await observeRowGrantAuthority(byCtx, evaluate);
  return { grants: authority.value, revalidate: authority.revalidate };
}
