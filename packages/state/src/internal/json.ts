/**
 * Lane 03 S6: shared JSON clone/probe helpers.
 *
 * Moved out of the S5 mutation pipeline so fenced outbox/schedule staging
 * shares the identical fail-closed semantics: uncloneable values (functions,
 * symbols) and unserializable values (bigints, circular refs) are caller
 * `validation` errors, never DataCloneError/TypeError crashes.
 */

import { StateError } from '../errors.js';

/**
 * Clone a value into engine-owned state. Clone failures are caller errors:
 * the value was never JSON data.
 */
export function jsonClone<T>(value: T, what: string): T {
  try {
    return structuredClone(value);
  } catch {
    throw new StateError('validation', `${what} must be JSON data.`);
  }
}

/**
 * Probe that a value survives JSON encoding. Cloneable-but-unserializable
 * values (bigints, circular refs) crash commit-time encoding with a raw
 * TypeError; reject them as caller validation instead.
 */
export function checkJsonSafe(value: unknown, what: string): void {
  try {
    JSON.stringify(value);
  } catch {
    throw new StateError('validation', `${what} holds non-JSON values.`);
  }
}
