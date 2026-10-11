/** Shared field-directed uniqueness for canonical user wires and legacy scalars. */
import type { InterimFieldDef } from '../mutation/models.js';
import { decodeValue, isUserRef } from '@canlang/values';
import { StateError } from '../errors.js';

export function canonicalUniqueFieldValue(value: unknown, key: string, model: string,
  field?: InterimFieldDef): string | null {
  if (value === null || value === undefined) return null;
  if (field?.array === undefined && (field?.valueType === 'user' || field?.valueType === 'user?')) {
    const invalid = (): never => { throw new StateError('validation',
      `Unique field ${JSON.stringify(key)} on model ${JSON.stringify(model)} must be a canonical user value.`); };
    if (typeof value !== 'object' || Array.isArray(value)) return invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== 'id') return invalid();
    const id = Object.getOwnPropertyDescriptor(value, 'id');
    if (id === undefined || !('value' in id) || !id.enumerable) return invalid();
    try {
      const decoded = decodeValue('user', { id: id.value });
      if (!isUserRef(decoded)) return invalid();
      return decoded.id;
    } catch { return invalid(); }
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  throw new StateError('validation',
    `Unique field ${JSON.stringify(key)} on model ${JSON.stringify(model)} must be a scalar value.`);
}
