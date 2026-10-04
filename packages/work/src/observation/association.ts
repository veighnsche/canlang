/**
 * Delivery-association matching for `on=Target.completed` handlers.
 *
 * Compares the current association `.id` to the completion envelope's
 * `delivery_id` and retains the source/revision checks: a completion applies
 * only to the receipt of its own attempt, from the expected source, at a
 * monotone revision. Old attempts update only their own receipts — a
 * completion for a superseded attempt never matches the current association.
 *
 * The completion envelope shape is mirrored locally on purpose: this kernel
 * imports no services contract, avoiding cross-contract coupling. The S8 join
 * unifies this mirrored shape with the full completion envelope (DESIGN 8.0
 * status/result/error consistency) and validates payload shape after a match;
 * matching itself inspects only `delivery_id`/`source`/`revision` and
 * ignores any extra envelope fields.
 *
 * Adversary posture: the completion arrives from callback paths and may be
 * arbitrarily shaped. Malformed completions return a safe non-match and never
 * throw; reasons are fixed vocabulary and never interpolate adversary
 * content. The remaining parameters (current association id, expected source,
 * minimum revision) are trusted runtime values and throw loudly when
 * malformed so store/declaration bugs surface instead of silently mismatching.
 *
 * Check order (pinned by tests): shape → id → source → revision.
 */

/**
 * Minimal completion envelope shape needed for association matching. The
 * full envelope carries status/result/error as well; those are payload for
 * the S8 join, not matching keys.
 */
export interface AssociatedCompletion {
  /** Delivery association id this completion claims. */
  delivery_id: string;
  /** Canonical source identity (declaration/binding of the send). */
  source: string;
  /** Monotone completion revision. */
  revision: number;
}

/**
 * Fixed match-verdict vocabulary. Safe to log: carries no completion or
 * association content.
 */
export type AssociationMatchReason =
  | 'matched'
  | 'malformed-completion'
  | 'id-mismatch'
  | 'source-mismatch'
  | 'stale-revision';

export interface AssociationMatch {
  matched: boolean;
  reason: AssociationMatchReason;
}

function isMatchableShape(completion: unknown): completion is AssociatedCompletion {
  if (typeof completion !== 'object' || completion === null) {
    return false;
  }
  const envelope = completion as Record<string, unknown>;
  return (
    typeof envelope['delivery_id'] === 'string' &&
    (envelope['delivery_id'] as string).length > 0 &&
    typeof envelope['source'] === 'string' &&
    (envelope['source'] as string).length > 0 &&
    typeof envelope['revision'] === 'number' &&
    Number.isInteger(envelope['revision']) &&
    (envelope['revision'] as number) >= 0
  );
}

/**
 * Match one completion against the current delivery association. Never throws
 * on adversary-shaped completions; throws only on malformed trusted runtime
 * parameters.
 */
export function matchAssociatedCompletion(
  associationId: string,
  completion: unknown,
  expectedSource: string,
  minRevision: number,
): AssociationMatch {
  if (typeof associationId !== 'string') {
    throw new TypeError('matchAssociatedCompletion: associationId must be a string');
  }
  if (associationId.length === 0) {
    throw new RangeError('matchAssociatedCompletion: associationId must be non-empty');
  }
  if (typeof expectedSource !== 'string') {
    throw new TypeError('matchAssociatedCompletion: expectedSource must be a string');
  }
  if (expectedSource.length === 0) {
    throw new RangeError('matchAssociatedCompletion: expectedSource must be non-empty');
  }
  if (typeof minRevision !== 'number') {
    throw new TypeError('matchAssociatedCompletion: minRevision must be a number');
  }
  if (!Number.isInteger(minRevision) || minRevision < 0) {
    throw new RangeError('matchAssociatedCompletion: minRevision must be a non-negative integer');
  }
  if (!isMatchableShape(completion)) {
    return { matched: false, reason: 'malformed-completion' };
  }
  if (completion.delivery_id !== associationId) {
    return { matched: false, reason: 'id-mismatch' };
  }
  if (completion.source !== expectedSource) {
    return { matched: false, reason: 'source-mismatch' };
  }
  if (completion.revision < minRevision) {
    return { matched: false, reason: 'stale-revision' };
  }
  return { matched: true, reason: 'matched' };
}
