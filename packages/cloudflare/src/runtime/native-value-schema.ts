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
    type StepOutcome = { done: false } | { done: true; value: RecordRef | undefined };
    const stepArray = (): StepOutcome => {
      const index = segment(position);
      if (position === path.length || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 ||
          !Array.isArray(current) || index >= current.length) return { done: true, value: refuse() };
      current = own(current, index); position++;
      type = { ...type, array: false, requiredArray: false, nullable: false };
      return { done: false };
    };
    const stepNominal = (): StepOutcome => {
      const name = type.base.kind === 'nominal' ? type.base.path : '';
      const alias = schema?.aliases !== undefined && Object.hasOwn(schema.aliases, name) ? schema.aliases[name] : undefined;
      if (alias !== undefined) { type = alias.type; return { done: false }; }
      const contract = schema !== undefined && Object.hasOwn(schema.contracts, name) ? schema.contracts[name] : undefined;
      if (contract !== undefined) {
        const key = segment(position);
        if (position === path.length || typeof key !== 'string' || !Object.hasOwn(contract.fields, key)) return { done: true, value: refuse() };
        current = own(current, key); position++;
        type = contract.fields[key]!.type;
        return { done: false };
      }
      if (position !== path.length || current !== value ||
          schema !== undefined && Object.hasOwn(schema.enums, name) || reference.model !== name) return { done: true, value: refuse() };
      return { done: true, value: reference };
    };
    const stepUnion = (): StepOutcome => {
      if (type.base.kind !== 'union') return { done: true, value: refuse() };
      if (segment(position) !== 'value') return { done: true, value: refuse() };
      const arm = own(current, 'type');
      if (typeof arm !== 'string' || !type.base.arms.includes(arm)) return { done: true, value: refuse() };
      current = own(current, 'value'); position++;
      try { type = parseTypeId(arm); } catch { return { done: true, value: refuse() }; }
      return { done: false };
    };
    let position = 0, steps = 0;
    while (++steps <= 128) {
      const outcome = type.array ? stepArray() : type.base.kind === 'nominal' ? stepNominal() :
        type.base.kind === 'union' ? stepUnion() : { done: true, value: refuse() } as StepOutcome;
      if (outcome.done) return outcome.value;
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
