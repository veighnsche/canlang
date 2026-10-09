/** Identity for framework-created native views, without business-field tags. */
import type { CanValue, RecordRef } from '@canlang/contracts';
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
