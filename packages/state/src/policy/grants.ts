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

import type {
  ModelName,
  QueryPredicate,
  StoredRow,
} from '../../../contracts/src/state.js';
import type { Membership } from '../../../contracts/src/identity.js';
import { StateError } from '../errors.js';
import { evaluateBy, type ByPredicate, type MembershipReader } from './roles.js';

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
 * models, malformed dot paths, empty path entries, or any grant field equal
 * to or under a secret path (fail fast; a grant above a secret is allowed and
 * the secret subtree is carved out of every projection instead).
 */
export function buildPolicyTable(models: ReadonlyArray<InterimModelPolicy>): PolicyTable {
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
    const grants = policy.grants.map((grant) => {
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
      return Object.freeze({
        by: grant.by,
        fields: Object.freeze([...grant.fields]),
        ...(grant.when !== undefined ? { when: grant.when } : {}),
      }) as InterimGrant;
    });
    table.set(
      policy.model,
      Object.freeze({
        model: policy.model,
        secretFields: Object.freeze([...policy.secretFields]),
        grants: Object.freeze(grants),
      }) as InterimModelPolicy,
    );
  }
  return table;
}

/**
 * Resolve a dot path against a stored row. Metadata names resolve to the row
 * envelope; everything else traverses `row.data` through plain objects only
 * (arrays are opaque leaves, so indexed paths never resolve). Unknown or
 * untraversable paths yield `undefined` (missing); an explicit `null` leaf is
 * returned as `null`.
 */
export function resolveRowPath(row: StoredRow, path: string): unknown {
  const segments = path.split('.');
  const head = segments[0];
  if (head === undefined || head === '') {
    return undefined;
  }
  let current: unknown;
  switch (head) {
    case 'id':
      current = row.id;
      break;
    case 'version':
      current = row.version;
      break;
    case 'created':
      current = row.created;
      break;
    case 'updated':
      current = row.updated;
      break;
    case 'createdBy':
      current = row.createdBy;
      break;
    case 'updatedBy':
      current = row.updatedBy;
      break;
    case 'archivedAt':
      current = row.archivedAt;
      break;
    default: {
      const data = row.data as Readonly<Record<string, unknown>>;
      if (!Object.hasOwn(data, head)) {
        return undefined;
      }
      current = data[head];
    }
  }
  for (const segment of segments.slice(1)) {
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
 * Only number/string/boolean operands are accepted; anything else is a caller
 * error, never a silent mismatch — rich values must not silently misorder.
 */
function checkComparisonOperand(op: string, field: string, value: unknown): void {
  const kind = typeof value;
  if (kind === 'number' || kind === 'string' || kind === 'boolean') {
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
    `Predicate ${op} on ${JSON.stringify(field)} rejected: non-scalar comparison operands must be number, string, or boolean.`,
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
      checkComparisonOperand(predicate.op, predicate.field, predicate.value);
      return;
    case 'between':
      checkBetweenBounds(predicate.field, predicate.lo, predicate.hi);
      return;
    case 'is_null':
    case 'not_null':
      return;
    default: {
      const op = (predicate as QueryPredicate).op;
      throw new Error(`Unknown query predicate: ${JSON.stringify(op)}`);
    }
  }
}

/**
 * Compare two same-type scalars. Booleans order as 1/0, mirroring storage.
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
  return null;
}

/**
 * Evaluate a predicate against one stored row (two-valued: a row either
 * matches or it does not). Comparisons against null/missing field values are
 * false for all six operators (matching SQL three-valued filtering, where
 * NULL comparisons never match, including under `ne`); scalar type mismatches
 * are likewise false, never errors. Rich or non-scalar operands are caller
 * errors per `checkComparisonOperand`.
 */
export function evalPredicateForRow(predicate: QueryPredicate, row: StoredRow): boolean {
  switch (predicate.op) {
    case 'and':
      for (const arg of predicate.args) {
        if (!evalPredicateForRow(arg, row)) {
          return false;
        }
      }
      return true;
    case 'or':
      for (const arg of predicate.args) {
        if (evalPredicateForRow(arg, row)) {
          return true;
        }
      }
      return false;
    case 'not':
      return !evalPredicateForRow(predicate.arg, row);
    case 'eq':
    case 'ne':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte': {
      checkComparisonOperand(predicate.op, predicate.field, predicate.value);
      const actual = resolveRowPath(row, predicate.field);
      if (isNullish(actual)) {
        return false;
      }
      const compared = compareScalars(actual, predicate.value);
      if (compared === null) {
        return false;
      }
      switch (predicate.op) {
        case 'eq':
          return compared === 0;
        case 'ne':
          return compared !== 0;
        case 'lt':
          return compared === -1;
        case 'lte':
          return compared <= 0;
        case 'gt':
          return compared > 0;
        case 'gte':
          return compared >= 0;
      }
      break;
    }
    case 'between': {
      checkBetweenBounds(predicate.field, predicate.lo, predicate.hi);
      const actual = resolveRowPath(row, predicate.field);
      if (isNullish(actual)) {
        return false;
      }
      const lo = compareScalars(actual, predicate.lo);
      const hi = compareScalars(actual, predicate.hi);
      return lo !== null && hi !== null && lo >= 0 && hi <= 0;
    }
    case 'is_null':
      return isNullish(resolveRowPath(row, predicate.field));
    case 'not_null':
      return !isNullish(resolveRowPath(row, predicate.field));
    default: {
      const op = (predicate as QueryPredicate).op;
      throw new Error(`Unknown query predicate: ${JSON.stringify(op)}`);
    }
  }
  const op = (predicate as QueryPredicate).op;
  throw new Error(`Unknown query predicate: ${JSON.stringify(op)}`);
}

/**
 * Return the grants matching one row: each grant's `by` must hold for the
 * caller and its optional `when` must match the stored row. `by` predicates
 * are row-independent, so engines may cache the `by` outcomes per query and
 * evaluate only `when` per row; this helper evaluates both for direct use.
 */
export async function matchGrants(
  policy: InterimModelPolicy,
  byCtx: ByContext,
  row: StoredRow,
): Promise<InterimGrant[]> {
  const matched: InterimGrant[] = [];
  for (const grant of policy.grants) {
    if (!(await evaluateBy(grant.by, byCtx))) {
      continue;
    }
    if (grant.when !== undefined && !evalPredicateForRow(grant.when, row)) {
      continue;
    }
    matched.push(grant);
  }
  return matched;
}
