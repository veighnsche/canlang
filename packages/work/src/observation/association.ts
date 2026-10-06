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

import type {
  AssociatedReceipt,
  ReceiptAssociation,
  ReceiptError,
  ReceiptStatus,
} from '../../../contracts/src/work.js';
import { isConsistentCompletion } from '../receipt/index.ts';

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

/* -- T25a selected-receipt locator: the runtime record/field binding. -- */

/**
 * Resolved association locator: the live owning record plus one declared
 * delivery field. The record is opaque to this kernel (never inspected,
 * never serialized); its presence as a non-null object is what proves the
 * caller holds the owning record rather than a copied text id.
 */
export interface ResolvedAssociationLocator {
  /** Live owning record under observation. */
  record: object;
  /** One declared delivery field on that record. */
  field: string;
}

const LOCATOR_KEYS: ReadonlySet<string> = new Set(['record', 'field']);

/**
 * Resolve `{record, field}` locator input into the runtime binding. The
 * shape arrives from generated code (statically resolved against the
 * record's canonical schema), so every malformation throws loudly instead
 * of resolving to a guessed lookup:
 *
 * - the locator must be exactly `{record, field}`: extra keys (a smuggled
 *   model/id/handle) are rejected, never ignored;
 * - `record` must be the non-null owning-record object: a text id is the
 *   forbidden raw-ID cast, and there is no string-ID lookup;
 * - `field` must be a plain declared delivery-field name: traversal
 *   (`a.b`, brackets) is rejected, never resolved.
 *
 * Declared-delivery-field MEMBERSHIP (is `field` really a delivery field
 * on this record's schema) is the L1/L3 join's check; this mechanism
 * rejects only misshapen locators.
 */
export function resolveAssociationLocator(locator: unknown): ResolvedAssociationLocator {
  if (typeof locator !== 'object' || locator === null || Array.isArray(locator)) {
    throw new TypeError('resolveAssociationLocator: locator must be a {record, field} object');
  }
  const input = locator as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!LOCATOR_KEYS.has(key)) {
      throw new RangeError(
        `resolveAssociationLocator: unknown locator key ${JSON.stringify(key)}`,
      );
    }
  }
  const record: unknown = input['record'];
  if (typeof record === 'string') {
    throw new TypeError(
      'resolveAssociationLocator: record must be the owning record object, never a text id',
    );
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new TypeError('resolveAssociationLocator: record must be a non-null object');
  }
  const field: unknown = input['field'];
  if (typeof field !== 'string') {
    throw new TypeError('resolveAssociationLocator: field must be a string');
  }
  if (field.length === 0) {
    throw new RangeError('resolveAssociationLocator: field must be non-empty');
  }
  if (field.includes('.') || field.includes('[') || field.includes(']')) {
    throw new RangeError('resolveAssociationLocator: field must be a plain name, never traversal');
  }
  return { record, field };
}

/* -- T25a receipt progress: stale attempts never overwrite the current association. -- */

/**
 * Full receipt-progress envelope: the completion correlation keys plus the
 * status payload. Mirrors the adapter completion shape (`delivery_id`
 * spelling included); validated as adversary input on every apply.
 */
export interface ReceiptProgress {
  /** Delivery association id this progress claims. */
  delivery_id: string;
  /** Canonical source identity (declaration/binding of the send). */
  source: string;
  /** Monotone progress revision. */
  revision: number;
  /** Completion status; `pending` is a receipt, never progress. */
  status: ReceiptStatus;
  /** Declared typed result, or null when failed/unknown/skipped. */
  result: unknown;
  /** Safe closed error, or null when not failed. */
  error: ReceiptError | null;
}

export type ReceiptProgressOutcome =
  /**
   * Progress applied: both records advance to the progress revision with
   * the progress payload. Equal-revision replays are idempotent (same
   * revision carries identical business content per the adapter contract).
   */
  | { applied: true; association: ReceiptAssociation; receipt: AssociatedReceipt }
  /**
   * Progress refused with a fixed reason; both records are untouched.
   * `id-mismatch` is the superseded attempt: old attempts update their own
   * receipts only, never the current association.
   */
  | {
      applied: false;
      reason:
        | 'malformed-completion'
        | 'id-mismatch'
        | 'source-mismatch'
        | 'stale-revision'
        | 'inconsistent-envelope';
    };

function assertAssociation(association: ReceiptAssociation, caller: string): void {
  if (typeof association.deliveryId !== 'string' || association.deliveryId.length === 0) {
    throw new RangeError(`${caller}: association.deliveryId must be a non-empty string`);
  }
  if (typeof association.source !== 'string' || association.source.length === 0) {
    throw new RangeError(`${caller}: association.source must be a non-empty string`);
  }
  if (!Number.isInteger(association.revision) || association.revision < 0) {
    throw new RangeError(`${caller}: association.revision must be a non-negative integer`);
  }
}

function assertAssociatedReceipt(receipt: AssociatedReceipt, caller: string): void {
  if (typeof receipt.deliveryId !== 'string' || receipt.deliveryId.length === 0) {
    throw new RangeError(`${caller}: receipt.deliveryId must be a non-empty string`);
  }
  if (!Number.isInteger(receipt.revision) || receipt.revision < 0) {
    throw new RangeError(`${caller}: receipt.revision must be a non-negative integer`);
  }
}

/**
 * Apply one receipt-progress envelope to the current association pair.
 * Pure: no fetch, no store write — the committing store persists the
 * returned records inside its own fence (the L3 join).
 *
 * Check order (pinned by tests): trusted store agreement (throws) →
 * correlation via `matchAssociatedCompletion` (shape → id → source →
 * revision) → envelope consistency → apply. Terminal immutability is NOT
 * checked here: T26 owns terminal receipt semantics, and this fence
 * refuses only stale, foreign or inconsistent progress.
 */
export function applyReceiptProgress(
  association: ReceiptAssociation,
  receipt: AssociatedReceipt,
  progress: unknown,
): ReceiptProgressOutcome {
  const caller = 'applyReceiptProgress';
  assertAssociation(association, caller);
  assertAssociatedReceipt(receipt, caller);
  if (association.deliveryId !== receipt.deliveryId) {
    throw new Error(
      `${caller}: receipt ${JSON.stringify(receipt.deliveryId)} does not belong to association ` +
        `${JSON.stringify(association.deliveryId)}`,
    );
  }
  if (association.revision !== receipt.revision) {
    throw new Error(
      `${caller}: association revision ${association.revision} disagrees with receipt revision ` +
        `${receipt.revision}`,
    );
  }
  const match = matchAssociatedCompletion(
    association.deliveryId,
    progress,
    association.source,
    association.revision,
  );
  if (!match.matched) {
    const reason = match.reason;
    // Unreachable: a non-match never carries the matched reason. The guard
    // narrows the fixed vocabulary for the refused outcome.
    if (reason === 'matched') throw new Error(`${caller}: non-match carried the matched reason`);
    return { applied: false, reason };
  }
  const envelope = progress as Record<string, unknown>;
  const status: unknown = envelope['status'];
  const result: unknown = envelope['result'];
  const error: unknown = envelope['error'];
  if (!isConsistentCompletion(status, result, error)) {
    return { applied: false, reason: 'inconsistent-envelope' };
  }
  const revision = (progress as AssociatedCompletion).revision;
  return {
    applied: true,
    association: { ...association, revision },
    receipt: {
      deliveryId: association.deliveryId,
      revision,
      status: status as ReceiptStatus,
      result: result === undefined ? null : result,
      error: (error === undefined ? null : error) as ReceiptError | null,
    },
  };
}
