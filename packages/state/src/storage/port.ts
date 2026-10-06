/**
 * Lane 03 S2: storage-level port and error classes.
 *
 * `FenceConflictError` and `StorageConstraintError` are storage-level signals.
 * Mapping them to stable `StateError` codes happens in a later slice; adapters
 * construct these directly from SQL failures.
 */

import type { MigrationFailureLeg, Revision } from '../../../contracts/src/state.js';

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
  /**
   * B2 (Q3): the stored row behind a `version` mismatch (commit-race
   * currents). Set ONLY when the adapter compared against a loaded
   * stored row; missing-row mismatches leave it absent (no row). The
   * error mapper renders metadata-only currents from it — never values
   * (re-reading or value-mapping there would be TOCTOU-indicative).
   */
  readonly conflictRow?: VersionConflictRow;

  constructor(kind: StorageConstraintKind, detail: string, conflictRow?: VersionConflictRow) {
    super(`${kind}: ${detail}`);
    this.name = 'StorageConstraintError';
    this.kind = kind;
    this.detail = detail;
    if (conflictRow !== undefined) this.conflictRow = conflictRow;
  }
}

/**
 * B2 (Q3): stored-row identity behind a version mismatch. Epoch-millis
 * `updated` plus the winning writer; the mapper renders the
 * millis-pinned RFC 3339 instant. Field values are deliberately NOT
 * carried here (commit-race currents are metadata-only by pin).
 */
export interface VersionConflictRow {
  readonly model: string;
  readonly id: string;
  readonly version: number;
  readonly updated: number;
  readonly updatedBy: string;
}

/**
 * B3: shared shape check for the recovery intakes (all three adapters run
 * it before fencing). Returns the checked id/leg, or throws a plain
 * `Error` programmer bug — engine inputs are statically shaped, so a
 * malformed one is never a data failure.
 */
export function checkRecoveryInput(
  migrationId: unknown,
  leg?: unknown,
): { readonly migrationId: string; readonly leg?: MigrationFailureLeg } {
  if (typeof migrationId !== 'string' || migrationId === '') {
    throw new Error('migration recovery input needs a non-empty migrationId.');
  }
  if (leg === undefined) {
    return { migrationId };
  }
  if (leg !== 'staging' && leg !== 'activation') {
    throw new Error(`migration recovery leg must be staging or activation.`);
  }
  return { migrationId, leg };
}
