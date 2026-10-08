/** Identity for framework-created native views, without business-field tags. */
import type { CanValue } from '@canlang/contracts';
import { makeRecordRef, same } from '@canlang/values';

const identities = new WeakMap<object, CanValue>();

/** Only owning runtime conversion calls this; a copied view has no identity. */
export function bindNativeRecord(view: object, model: string, id: string, version: number): void {
  identities.set(view, makeRecordRef(model, id, BigInt(version)));
}

export function sameNativeReference(left: CanValue, right: CanValue): boolean {
  const reference = (value: CanValue) => typeof value === 'object' && value !== null
    ? identities.get(value) ?? value : value;
  return same(reference(left), reference(right));
}
