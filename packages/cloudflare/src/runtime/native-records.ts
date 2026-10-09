/** Identity for framework-created native views, without business-field tags. */
import type { CanValue, RecordRef, StoredRow } from '@canlang/contracts';
import { StateError } from '@canlang/state/errors';
import { makeRecordRef, same } from '@canlang/values';

const identities = new WeakMap<object, RecordRef>();

/** Only owning runtime conversion calls this; a copied view has no identity. */
export function bindNativeRecord(view: object, model: string, id: string, version: number): void {
  identities.set(view, makeRecordRef(model, id, BigInt(version)));
}

/** Navigation preserves a genuine link's identity without inventing a version. */
export function bindNativeReference(view: object, reference: RecordRef): void {
  identities.set(view, reference);
}

/** Recover only identities installed by the owning runtime; copied views do not bind. */
export function nativeRecordReference(value: unknown): RecordRef | undefined {
  return typeof value === 'object' && value !== null ? identities.get(value) : undefined;
}

export function sameNativeReference(left: CanValue, right: CanValue): boolean {
  const reference = (value: CanValue) => nativeRecordReference(value) ?? value;
  return same(reference(left), reference(right));
}

/** Framework-only exact wire correspondence, scoped to one private attempt.
 * Identity metadata remains independent: an admitted view may see a newer
 * provisional wire version without changing its public reference metadata.
 */
const scenarioRows = new WeakMap<object, {
  readonly owner: object; readonly model: string; readonly id: string;
  readonly current: () => StoredRow | null | undefined;
}>();

export function bindNativeScenarioReceiptRow(view: object, owner: object, model: string,
  current: () => StoredRow | null | undefined): void {
  const identity = identities.get(view);
  if (!Object.isFrozen(view) || identity === undefined || identity.model !== model || scenarioRows.has(view)) {
    throw new StateError('validation', 'Scenario receipt row requires its original framework conversion.');
  }
  scenarioRows.set(view, { owner, model, id: identity.id, current });
}

/** Copy finite own JSON wire data without evaluating any accessor. The State
 * producer owns row/field/plan semantics; this only preserves transport data.
 */
function wireSnapshot(row: StoredRow): StoredRow {
  let nodes = 0;
  const seen = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 32) throw new StateError('validation', 'Scenario wire snapshot exceeds its bound.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))) return value;
    if (typeof value !== 'object' || value === null || seen.has(value) ||
        (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      throw new StateError('validation', 'Scenario wire snapshot requires own JSON data.');
    }
    seen.add(value);
    const result: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const member = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || member === undefined || !('value' in member) || !member.enumerable ||
          (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key))) {
        throw new StateError('validation', 'Scenario wire snapshot cannot contain accessors or hidden members.');
      }
      Object.defineProperty(result, key, { value: copy(member.value, depth + 1), enumerable: true });
    }
    if (Array.isArray(value) && Object.keys(result).length !== value.length) {
      throw new StateError('validation', 'Scenario wire snapshot cannot contain sparse arrays.');
    }
    seen.delete(value);
    return Object.freeze(result);
  };
  return copy(row, 0) as StoredRow;
}

export function captureNativeScenarioReceiptRow(view: unknown, owner: object, model: string): StoredRow {
  const binding = typeof view === 'object' && view !== null ? scenarioRows.get(view) : undefined;
  if (binding === undefined || binding.owner !== owner || binding.model !== model) {
    throw new StateError('validation', 'Scenario receipt row is copied, foreign, or unbound.');
  }
  const current = binding.current();
  if (current === undefined || current === null) throw new StateError('validation', 'Scenario receipt row is no longer present.');
  const snapshot = wireSnapshot(current);
  if (snapshot.id !== binding.id) throw new StateError('validation', 'Scenario receipt row resolver substituted its identity.');
  return snapshot;
}
