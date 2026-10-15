/** Private host adapter for Values' demanded reference encoder callback.
 * This checks a genuine native identity against its owning typed occurrence;
 * State still owns admission, row authority, effects and lifetime checks. */
import type { CanValue, RecordRef, CanonicalValueTypes, CompileArtifact } from '@canlang/contracts';
import { parseTypeId, printTypeId, type NormalizedSchema } from '@canlang/values';
import { nativeRecordReference } from './native-records.js';

/** A native identity mismatch must never fall back to decoding it as wire. */
export class NativeValueReferenceError extends Error {
  constructor() {
    super('Native reference requires its exact declared model and original typed value occurrence.');
    this.name = 'NativeValueReferenceError';
  }
}

export function nativeValueReferenceEncoder(rootType: string, schema: NormalizedSchema | undefined, originalValue: unknown):
  (value: CanValue, path: ReadonlyArray<string | number>) => RecordRef | undefined {
  const refuse = (): never => { throw new NativeValueReferenceError(); };
  const own = (container: unknown, key: string | number): unknown => {
    if (typeof container !== 'object' || container === null ||
        nativeRecordReference(container) !== undefined ||
        (Array.isArray(container) ? Object.getPrototypeOf(container) !== Array.prototype
          : ![Object.prototype, null].includes(Object.getPrototypeOf(container)))) return refuse();
    const member = Object.getOwnPropertyDescriptor(container, key);
    if (member === undefined || !('value' in member) || !member.enumerable) return refuse();
    return member.value;
  };
  return (value, path) => {
    const reference = nativeRecordReference(value);
    if (reference === undefined) return undefined;
    if (!Array.isArray(path) || path.length > 64) return refuse();
    let current = originalValue, type: ReturnType<typeof parseTypeId>;
    try { type = parseTypeId(rootType); if (printTypeId(type) !== rootType) return refuse(); } catch { return refuse(); }
    const segment = (position: number): string | number | undefined => {
      const member = Object.getOwnPropertyDescriptor(path, String(position));
      if (member === undefined) return undefined;
      if (!('value' in member) || !member.enumerable || typeof member.value !== 'string' && typeof member.value !== 'number') return refuse();
      return member.value;
    };
    let position = 0, steps = 0;
    while (++steps <= 128) {
      if (type.array) {
        const index = segment(position);
        if (position === path.length || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 ||
            !Array.isArray(current) || index >= current.length) return refuse();
        current = own(current, index); position++;
        type = { ...type, array: false, requiredArray: false, nullable: false };
        continue;
      }
      if (type.base.kind === 'nominal') {
        const name = type.base.path;
        const alias = schema?.aliases !== undefined && Object.hasOwn(schema.aliases, name) ? schema.aliases[name] : undefined;
        if (alias !== undefined) { type = alias.type; continue; }
        const contract = schema !== undefined && Object.hasOwn(schema.contracts, name) ? schema.contracts[name] : undefined;
        if (contract !== undefined) {
          const key = segment(position);
          if (position === path.length || typeof key !== 'string' || !Object.hasOwn(contract.fields, key)) return refuse();
          current = own(current, key); position++;
          type = contract.fields[key]!.type;
          continue;
        }
        if (position !== path.length || current !== value ||
            schema !== undefined && Object.hasOwn(schema.enums, name) || reference.model !== name) return refuse();
        return reference;
      }
      if (type.base.kind === 'union') {
        if (segment(position) !== 'value') return refuse();
        const arm = own(current, 'type');
        if (typeof arm !== 'string' || !type.base.arms.includes(arm)) return refuse();
        current = own(current, 'value'); position++;
        try { type = parseTypeId(arm); } catch { return refuse(); }
        continue;
      }
      return refuse(); // scalar, JSON, enum and protected values prove no Model slot
    }
    return refuse();
  };
}


/** The compiler omits the nominal inventory only for an original empty declaration set. */
export function checkedNativeValueTypes(artifact: CompileArtifact, originalDefinition: unknown,
  loaded: CanonicalValueTypes | undefined): CanonicalValueTypes {
  if (loaded !== undefined) return loaded;
  const empty = (key: string, required: boolean): boolean => {
    if (typeof originalDefinition !== 'object' || originalDefinition === null) return false;
    const descriptor = Object.getOwnPropertyDescriptor(originalDefinition, key);
    if (descriptor === undefined) return !required;
    if (!('value' in descriptor) || descriptor.value === null || typeof descriptor.value !== 'object' || Array.isArray(descriptor.value)) return false;
    const prototype = Object.getPrototypeOf(descriptor.value);
    return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(descriptor.value).length === 0;
  };
  if (artifact.valueTypes !== undefined || artifact.models === undefined || !empty('contracts', true) || !empty('enums', false) || !empty('aliases', false)) {
    throw new Error('Original nominal value declarations are missing from the canonical inventory.');
  }
  return Object.freeze({ contracts: Object.freeze([]) });
}
