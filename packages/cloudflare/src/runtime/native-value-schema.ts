/** Private host adapter for Values' demanded reference encoder callback.
 * This checks a genuine native identity against its owning typed occurrence;
 * State still owns admission, row authority, effects and lifetime checks. */
import type { CanValue, RecordRef, CanonicalValueTypes, CompileArtifact } from '@canlang/contracts';
import { isRecordRef, parseTypeId, printTypeId, type NormalizedSchema } from '@canlang/values';
import { nativeRecordReference } from './native-records.js';

/** A native identity mismatch must never fall back to decoding it as wire. */
export class NativeValueReferenceError extends Error {
  constructor() {
    super('Native reference requires its exact declared model and original typed value occurrence.');
    this.name = 'NativeValueReferenceError';
  }
}

export function nativeValueReferenceEncoder(rootType: string, schema: NormalizedSchema | undefined, originalValue: unknown,
  requireNativeModels = false):
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
    let reference = nativeRecordReference(value);
    if (reference === undefined && requireNativeModels && typeof value === 'object' && value !== null
        && [Object.prototype, null].includes(Object.getPrototypeOf(value))
        && Object.values(Object.getOwnPropertyDescriptors(value)).every(member => 'value' in member)
        && isRecordRef(value)) reference = value;
    if (reference === undefined && !requireNativeModels) return undefined;
    if (!Array.isArray(path) || path.length > 64) return refuse();
    let type: ReturnType<typeof parseTypeId>;
    try { type = parseTypeId(rootType); if (printTypeId(type) !== rootType) return refuse(); } catch { return refuse(); }
    const segment = (position: number): string | number | undefined => {
      const member = Object.getOwnPropertyDescriptor(path, String(position));
      if (member === undefined) return undefined;
      if (!('value' in member) || !member.enumerable || typeof member.value !== 'string' && typeof member.value !== 'number') return refuse();
      return member.value;
    };
    const nonModel = (): undefined => reference === undefined ? undefined : refuse();
    const arraySlot = (type: ReturnType<typeof parseTypeId>, current: unknown, position: number): RecordRef | undefined => {
      if (position === path.length) return nonModel();
      const index = segment(position);
      if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 ||
          !Array.isArray(current) || index >= current.length) return refuse();
      return slot({ ...type, array: false, requiredArray: false, nullable: false }, own(current, index), position + 1);
    };
    const contractSlot = (fields: NormalizedSchema['contracts'][string]['fields'], current: unknown,
      position: number): RecordRef | undefined => {
      if (position === path.length) return nonModel();
      const key = segment(position);
      if (typeof key !== 'string' || !Object.hasOwn(fields, key)) return refuse();
      return slot(fields[key]!.type, own(current, key), position + 1);
    };
    const nominalSlot = (name: string, current: unknown, position: number): RecordRef | undefined => {
      const alias = schema?.aliases !== undefined && Object.hasOwn(schema.aliases, name) ? schema.aliases[name] : undefined;
      if (alias !== undefined) return slot(alias.type, current, position);
      const contract = schema !== undefined && Object.hasOwn(schema.contracts, name) ? schema.contracts[name] : undefined;
      if (contract !== undefined) return contractSlot(contract.fields, current, position);
      if (schema !== undefined && Object.hasOwn(schema.enums, name)) return nonModel();
      if (value === null && reference === undefined) return undefined;
      if (position !== path.length || current !== value || reference === undefined || reference.model !== name) return refuse();
      return reference;
    };
    const unionSlot = (arms: readonly string[], current: unknown, position: number): RecordRef | undefined => {
      if (position === path.length) return nonModel();
      if (segment(position) !== 'value') return refuse();
      const arm = own(current, 'type');
      if (typeof arm !== 'string' || !arms.includes(arm)) return refuse();
      let type: ReturnType<typeof parseTypeId>;
      try { type = parseTypeId(arm); } catch { return refuse(); }
      return slot(type, own(current, 'value'), position + 1);
    };
    let steps = 0;
    function slot(type: ReturnType<typeof parseTypeId>, current: unknown, position: number): RecordRef | undefined {
      if (++steps > 128) return refuse();
      if (type.array) return arraySlot(type, current, position);
      if (type.base.kind === 'nominal') return nominalSlot(type.base.path, current, position);
      if (type.base.kind === 'union') return unionSlot(type.base.arms, current, position);
      return nonModel();
    }
    return slot(type, originalValue, 0);
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
