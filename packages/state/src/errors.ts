import type { StateErrorCode } from '../../contracts/src/state.js';

/**
 * Safe business rejection. `message` must never carry confidential values;
 * guard-failure details stay generic (`rule_failed`) per DESIGN §4.
 */
export class StateError extends Error {
  readonly code: StateErrorCode;
  readonly details: unknown;

  constructor(code: StateErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'StateError';
    this.code = code;
    this.details = details ?? null;
  }
}

export function isStateError(error: unknown): error is StateError {
  return error instanceof StateError;
}

/** Build the generic guard-failure rejection (no confidential values). */
export function ruleFailed(message = 'Business rule rejected this operation.'): StateError {
  return new StateError('rule_failed', message);
}
