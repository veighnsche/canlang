/**
 * Lane 03 S2: storage-level port and error classes.
 *
 * `FenceConflictError` and `StorageConstraintError` are storage-level signals.
 * Mapping them to stable `StateError` codes happens in a later slice; adapters
 * construct these directly from SQL failures.
 */

import type { Revision } from '../../../contracts/src/state.js';

export type { StoragePort } from '../../../contracts/src/state.js';

/**
 * Raised when a commit batch loses the revision fence: another writer landed
 * first, so the batch was rolled back and nothing was applied. `actual` is
 * null only when the current revision could not be reread after the abort.
 */
export class FenceConflictError extends Error {
  readonly expected: Revision;
  readonly actual: Revision | null;

  constructor(expected: Revision, actual: Revision | null) {
    super(
      `Fence conflict: expected revision ${expected as number}, ` +
        `actual ${actual === null ? 'unknown' : (actual as number)}`,
    );
    this.name = 'FenceConflictError';
    this.expected = expected;
    this.actual = actual;
  }
}

/** Storage constraint kinds: unique-key, reference, version, receipt, other. */
export type StorageConstraintKind =
  | 'unique'
  | 'reference'
  | 'version'
  | 'receipt_reuse'
  | 'unknown';

/**
 * Raised when a commit batch violates a storage constraint (unique key,
 * receipt identity, or anything else the store rejected). The batch was
 * rolled back. `detail` carries the underlying store message for debugging.
 */
export class StorageConstraintError extends Error {
  readonly kind: StorageConstraintKind;
  readonly detail: string;

  constructor(kind: StorageConstraintKind, detail: string) {
    super(`${kind}: ${detail}`);
    this.name = 'StorageConstraintError';
    this.kind = kind;
    this.detail = detail;
  }
}
