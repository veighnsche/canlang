import type { StateErrorCode } from '@canlang/contracts';
import type { BusinessError, ConflictCurrent, FieldError } from '@canlang/contracts';
import { FenceConflictError, StorageConstraintError } from './storage/port.js';

/**
 * Safe business rejection. `message` must never carry confidential values;
 * guard-failure details stay generic (`rule_failed`) per DESIGN §4.
 */
export class StateError extends Error {
  readonly code: StateErrorCode;
  readonly details: unknown;
  readonly retryable?: boolean;
  readonly fields?: FieldError[];
  /**
   * B2 (Q3): L3-carried conflict currents. Present ONLY on `conflict`
   * denials with a carried row (admission stale-ref, commit version
   * race); absent on every other code and on row-less conflicts
   * (fence-moved, receipt-reuse). Rendered onto the wire by
   * `toBusinessError` (unlike `details`, which never renders).
   */
  readonly conflict?: ConflictCurrent;

  constructor(
    code: StateErrorCode,
    message: string,
    details?: unknown,
    opts?: { retryable?: boolean; fields?: FieldError[]; conflict?: ConflictCurrent },
  ) {
    super(message);
    this.name = 'StateError';
    this.code = code;
    this.details = details ?? null;
    if (opts?.retryable !== undefined) this.retryable = opts.retryable;
    if (opts?.fields !== undefined) this.fields = opts.fields;
    if (opts?.conflict !== undefined) this.conflict = opts.conflict;
  }
}

export function isStateError(error: unknown): error is StateError {
  return error instanceof StateError;
}

/** Build the generic guard-failure rejection (no confidential values). */
export function ruleFailed(message = 'Business rule rejected this operation.'): StateError {
  return new StateError('rule_failed', message);
}

/**
 * Map a storage-layer failure to a stable business error. Unknown storage
 * constraint kinds rethrow the original (bugs are never masked as business
 * errors), and non-storage values pass through untouched (hence the
 * `unknown` overload: passthrough is honest, not a StateError claim).
 */
export function storageToStateError(
  error: FenceConflictError | StorageConstraintError,
): StateError;
export function storageToStateError(error: unknown): unknown;
export function storageToStateError(error: unknown): unknown {
  if (error instanceof FenceConflictError) {
    return new StateError('busy', 'Write contention; retry the identical envelope.', null, {
      retryable: true,
    });
  }
  if (error instanceof StorageConstraintError) {
    if (error.kind === 'reference') {
      return new StateError('validation', 'Invalid reference.');
    }
    if (error.kind === 'unique' || error.kind === 'version' || error.kind === 'receipt_reuse') {
      const message =
        error.kind === 'version'
          ? 'Stale record version.'
          : error.kind === 'receipt_reuse'
            ? 'Conflicting reuse of this operation identity.'
            : 'Conflicting write.';
      // B2 (Q3): commit-race version conflicts carry metadata-only
      // currents (the adapter compared against this stored row); values
      // stay `{}` by pin — re-reading there would be TOCTOU-indicative.
      // Missing-row versions, uniques, and receipt-reuse carry nothing.
      const row = error.kind === 'version' ? error.conflictRow : undefined;
      if (row === undefined) {
        return new StateError('conflict', message);
      }
      return new StateError('conflict', message, null, {
        conflict: {
          message:
            `Record ${JSON.stringify(row.model)} ${JSON.stringify(row.id)} changed during ` +
            `commit (stored version ${row.version}).`,
          current: {
            model: row.model,
            id: row.id,
            version: row.version,
            updated: new Date(row.updated).toISOString(),
            updatedBy: row.updatedBy,
            values: {},
          },
        },
      });
    }
    throw error;
  }
  return error;
}

/** Render a business rejection in the shared wire error shape. */
export function toBusinessError(error: StateError, operationId?: string): BusinessError {
  return {
    code: error.code,
    message: error.message,
    ...(operationId !== undefined ? { operation_id: operationId } : {}),
    ...(error.fields !== undefined ? { fields: error.fields } : {}),
    ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
    // B2 (Q3): carried currents render through; absent everywhere else.
    ...(error.conflict !== undefined ? { conflict: error.conflict } : {}),
  };
}
