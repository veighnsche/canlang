/**
 * T25-L3 receipt join: leaf-grant and retention port binders.
 *
 * Binds the T25a port closures over record + actor + the `PolicyTable`
 * leaf grants (the declared `fields[]` dot paths are the grant source)
 * and over the receipt row's retention binding. Grant semantics follow
 * the leaf-grants contract EXACTLY:
 *
 * - field-scoped: `notification.status` grants nothing on any other
 *   field; the closure denies when the check context names a different
 *   field than the bound one;
 * - matching-union: every grant matching the record (row-independent
 *   `by` plus row-level `when`, via `matchGrants`) contributes its
 *   paths; authorization is the union;
 * - parent-subsumes-descendants: a whole-field grant (`notification`)
 *   authorizes every receipt leaf; a leaf grant authorizes exactly that
 *   leaf path;
 * - no implicit expansion: `notification.status` grants neither `id`,
 *   `result`, `error`, the whole value, nor any sibling; deeper paths
 *   (`notification.result.reference`) never expand upward into a
 *   parent-leaf grant;
 * - deny-before-presence: decisions consult only record + actor +
 *   policy, never association/receipt presence (the delivery binding in
 *   the check context is ignored);
 * - null-means-null and id-only-no-enroll are the mechanism/join's own
 *   rules (see `join.ts`); this module only decides leaves.
 *
 * Port shapes are structural mirrors of the work-side
 * `SelectedGrantPort` / `ContentPolicyPort` (lane 3 must not
 * runtime-import lane 4): identical members, identical arities, so the
 * real T25a function accepts these closures at runtime. A work-side
 * conformance pin is future work.
 */
import type { ReceiptProperty } from '@canlang/contracts';
import type { ModelName, StoredRow } from '@canlang/contracts';
import { StateError } from '../errors.js';
import {
  matchGrants,
  type ByContext,
  type PolicyTable,
} from '../policy/grants.js';
import type { MembershipReader } from '../policy/roles.js';

/**
 * Structural mirror of the work-side `SelectedGrantContext`: the
 * declared delivery field under observation plus the current delivery
 * binding (null when the field holds no association).
 */
export interface JoinGrantContext {
  readonly field: string;
  readonly deliveryId: string | null;
  readonly revision: number | null;
}

/**
 * Structural mirror of the work-side `SelectedGrantPort`: per-leaf
 * selected-receipt grant check, consulted exactly once per unique
 * selected leaf before presence branches.
 */
export interface JoinGrantPort {
  mayObserve(property: ReceiptProperty, context: JoinGrantContext): boolean;
}

/**
 * Structural mirror of the work-side `ContentPolicyPort`:
 * result-content availability at the injected time.
 */
export interface JoinContentPolicyPort {
  isResultAvailable(contentRef: string, nowMs: number): boolean;
}

/**
 * Declared delivery fields per model: the record's canonical schema
 * reduced to delivery-field membership. B3 loader-built from L1-emitted
 * T15b `delivery` field tags (`registry.deliveryFields`); generated
 * callers resolve model + field statically against the canonical schema
 * and pass them here.
 */
export type DeliveryFieldSchema = ReadonlyMap<ModelName, ReadonlySet<string>>;

/**
 * Build a delivery-field schema. Plain `Error` programmer bugs (the
 * `buildPolicyTable` precedent): empty models, duplicate models, empty
 * field names, or traversal-shaped field names. Shared builder: the
 * artifact loader is the production caller (its whole-set guard runs
 * through this validation); direct calls survive only for focused
 * unit tests of the builder itself.
 */
export function createDeliverySchema(
  entries: ReadonlyArray<readonly [string, ReadonlyArray<string>]>,
): DeliveryFieldSchema {
  const schema = new Map<ModelName, ReadonlySet<string>>();
  for (const [model, fields] of entries) {
    if (model === '') {
      throw new Error('Invalid delivery schema: empty model name.');
    }
    const key = model as ModelName;
    if (schema.has(key)) {
      throw new Error(`Duplicate delivery schema model: ${JSON.stringify(model)}.`);
    }
    const names = new Set<string>();
    for (const field of fields) {
      if (field === '' || field.includes('.') || field.includes('[') || field.includes(']')) {
        throw new Error(
          `Invalid delivery schema field on model ${JSON.stringify(model)}: ` +
            `${JSON.stringify(field)} (plain declared names only, never traversal).`,
        );
      }
      names.add(field);
    }
    schema.set(key, names);
  }
  return schema;
}

/**
 * Assert `field` is a declared delivery field on `model`. Caller errors
 * (`StateError` validation, never guesses): unknown models and
 * non-delivery fields — including record relationships such as
 * `service` and dotted cross-model traversals — are rejected, never
 * resolved.
 */
export function assertDeliveryField(
  schema: DeliveryFieldSchema,
  model: ModelName,
  field: string,
): void {
  const declared = schema.get(model);
  if (declared === undefined) {
    throw new StateError(
      'validation',
      `Receipt join: unknown model ${JSON.stringify(model as string)}.`,
    );
  }
  if (!declared.has(field)) {
    throw new StateError(
      'validation',
      `Receipt join: ${JSON.stringify(field)} is not a declared delivery field ` +
        `on model ${JSON.stringify(model as string)}.`,
    );
  }
}

/** Caller identity for leaf-grant resolution; nulls mean unauthenticated. */
export interface JoinCaller {
  readonly actorUserId: string | null;
  readonly teamId: string | null;
}

/**
 * Resolve the union of granted dot paths for one owning record: the
 * caller's membership is resolved once, then `matchGrants` evaluates
 * each grant's row-independent `by` plus its row-level `when` against
 * the CURRENT stored row. A model with no policy entry grants nothing
 * (deny, never error — the engine precedent).
 */
export async function resolveLeafGrantPaths(input: {
  readonly policy: PolicyTable;
  readonly model: ModelName;
  readonly caller: JoinCaller;
  readonly memberships: MembershipReader;
  readonly row: StoredRow;
}): Promise<ReadonlySet<string>> {
  const found = input.policy.get(input.model);
  if (found === undefined) {
    return new Set();
  }
  const membership =
    input.caller.actorUserId !== null && input.caller.teamId !== null
      ? await input.memberships.findMembership(input.caller.teamId, input.caller.actorUserId)
      : null;
  const byCtx: ByContext = {
    actorUserId: input.caller.actorUserId,
    teamId: input.caller.teamId,
    membership,
    memberships: input.memberships,
  };
  const matched = await matchGrants(found, byCtx, input.row);
  const paths = new Set<string>();
  for (const grant of matched) {
    for (const field of grant.fields) {
      paths.add(field);
    }
  }
  return paths;
}

/**
 * Bind the field-scoped leaf-grant closure over pre-resolved paths.
 * `property` on the bound `field` is granted iff some matching path is
 * exactly `field` (the whole-field grant subsumes every leaf) or
 * exactly `field.property` (the leaf grant covers only that leaf). The
 * delivery binding in the check context is ignored: presence never
 * feeds a decision (deny-before-presence), and a context naming any
 * other field is denied (field scope is exact).
 */
export function createSelectedGrants(input: {
  readonly field: string;
  readonly paths: ReadonlySet<string>;
}): JoinGrantPort {
  const { field, paths } = input;
  return {
    mayObserve(property: ReceiptProperty, context: JoinGrantContext): boolean {
      if (context.field !== field) {
        return false;
      }
      return paths.has(field) || paths.has(`${field}.${property}`);
    },
  };
}

/**
 * Bind the result-retention closure over one receipt row's retention
 * binding. Available iff the consulted ref is the bound content ref
 * (fail closed on mismatch) and the retained result has not expired:
 * a null expiry is retained with the summary (always available), and
 * the expiry instant itself already counts as expired
 * (`nowMs < resultExpiresAtMs` discloses).
 */
export function createRetentionContentPolicy(input: {
  readonly contentRef: string | null;
  readonly resultExpiresAtMs: number | null;
}): JoinContentPolicyPort {
  const { contentRef, resultExpiresAtMs } = input;
  return {
    isResultAvailable(contentRefSeen: string, nowMs: number): boolean {
      if (contentRef === null || contentRefSeen !== contentRef) {
        return false;
      }
      return resultExpiresAtMs === null || nowMs < resultExpiresAtMs;
    },
  };
}
