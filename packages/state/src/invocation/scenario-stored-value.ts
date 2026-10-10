/** Whole stored nominal values remain JSON evidence, never reference authority. */
import type { ArtifactModel, CanonicalModelDescriptor, CanTypeId, ModelName } from '@canlang/contracts';
import { encodeValue, parseTypeId, printTypeId, validateValue, type NormalizedSchema } from '@canlang/values';
import { StateError } from '../errors.js';
import { modelFieldConstraintSchema } from '../mutation/models.js';
import { stableStringify } from './replay.js';

const invalid = (message: string): never => { throw new StateError('validation', `Saved scenario nominal: ${message}`); };

/** Closed own JSON data, detached before Values traverses any member. */
function data(value: unknown): unknown {
  let nodes = 0;
  const active = new Set<object>();
  const copy = (part: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 32) return invalid('data exceeds its finite budget.');
    if (part === null || typeof part === 'string' || typeof part === 'boolean') return part;
    if (typeof part === 'number' && Number.isFinite(part)) return part;
    if (typeof part !== 'object' || part === null || active.has(part)) return invalid('own JSON data required.');
    const array = Array.isArray(part), prototype = Object.getPrototypeOf(part);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid('own JSON data required.');
    active.add(part);
    const keys = Reflect.ownKeys(part);
    if (keys.length > 20_000 - nodes) return invalid('data exceeds its finite budget.');
    const out: unknown[] | Record<string, unknown> = array ? [] : {};
    let length = 0;
    if (array) {
      const descriptor = Object.getOwnPropertyDescriptor(part, 'length');
      if (descriptor === undefined || !('value' in descriptor) || !Number.isSafeInteger(descriptor.value) ||
          descriptor.value < 0 || descriptor.value > 20_000 || keys.length !== descriptor.value + 1) return invalid('dense finite arrays required.');
      length = descriptor.value as number;
    }
    for (const key of keys) {
      if (array && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(part, key);
      if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable ||
          array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) return invalid('own enumerable data required.');
      Object.defineProperty(out, key, { value: copy(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    active.delete(part); return out;
  };
  try { return copy(value, 0); }
  catch (error) { if (error instanceof StateError) throw error; return invalid('own JSON data required.'); }
}

export function storedNominalType(type: unknown): CanTypeId {
  if (typeof type !== 'string') return invalid('canonical nominal type required.');
  try {
    const parsed = parseTypeId(type);
    if (parsed.base.kind !== 'nominal' || printTypeId(parsed) !== type) return invalid('canonical nominal type required.');
    return type as CanTypeId;
  } catch (error) { if (error instanceof StateError) throw error; return invalid('canonical nominal type required.'); }
}

/** Schema-less persistence checks establish syntax only, never declarations or grants. */
export function savedNominalWire(type: unknown, wire: unknown): void {
  nominalShape(storedNominalType(type), data(wire));
}
function nominalShape(type: CanTypeId, saved: unknown): void {
  const parsed = parseTypeId(type);
  if (saved === null) { if (!parsed.nullable) return invalid('nonnullable contract value required.'); return; }
  const contractObject = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid('whole contract object required.');
  };
  if (parsed.array) {
    if (!Array.isArray(saved)) return invalid('whole contract array required.');
    saved.forEach(contractObject);
  } else contractObject(saved);
}

export interface StoredNominalFieldProfile {
  readonly type: CanTypeId;
  readonly array: boolean;
  readonly nullable: boolean;
}
type Bound = { readonly artifactModels: ReadonlyMap<ModelName, ArtifactModel>;
  readonly canonicalModels: readonly CanonicalModelDescriptor[]; readonly valueSchema: NormalizedSchema | undefined };
const profiles = new WeakMap<StoredNominalFieldProfile, { readonly schema: NormalizedSchema;
  readonly constraint: ReturnType<typeof modelFieldConstraintSchema> }>();

/** Unknown nominals cannot acquire model identity through Values' ref fallback. */
function checkSchemaClosure(schema: NormalizedSchema, root: string, bound: Bound): void {
  const visited = new Set<string>(); let nodes = 0;
  const models = new Set(bound.canonicalModels.map(model => model.name as string));
  const inspect = (type: string, depth: number): void => {
    if (++nodes > 20_000 || depth > 32) return invalid('schema exceeds its finite budget.');
    const parsed = parseTypeId(type);
    if (printTypeId(parsed) !== type) return invalid('canonical nested type required.');
    const base = parsed.base;
    if (base.kind === 'nominal') {
      const name = base.path;
      const isContract = Object.hasOwn(schema.contracts, name);
      const isEnum = Object.hasOwn(schema.enums, name);
      const isAlias = schema.aliases !== undefined && Object.hasOwn(schema.aliases, name);
      const declarations = Number(isContract) + Number(isEnum) + Number(isAlias);
      const artifact = bound.artifactModels.get(name as ModelName);
      if (declarations > 1 || declarations > 0 && (models.has(name) || bound.artifactModels.has(name as ModelName))) {
        return invalid('nominal declaration namespaces overlap.');
      }
      if (visited.has(name)) return;
      visited.add(name);
      const contract = isContract ? schema.contracts[name] : undefined;
      if (contract !== undefined) { for (const field of Object.values(contract.fields)) inspect(field.typeId, depth + 1); return; }
      if (isEnum) return;
      const alias = isAlias ? schema.aliases![name] : undefined;
      if (alias !== undefined) { inspect(alias.typeId, depth + 1); return; }
      if (!models.has(name) || artifact?.name !== name) return invalid('nested nominal lacks its same-load owning declaration.');
      return;
    }
    if (!['scalar', 'stringlike', 'enum', 'user'].includes(base.kind)) return invalid('nested protected or unsupported value requires its defining join.');
  };
  inspect(root, 0);
}

export function storedNominalField(bound: Bound, model: ModelName, field: string, type: unknown): StoredNominalFieldProfile {
  const nominal = storedNominalType(type), parsed = parseTypeId(nominal);
  if (parsed.base.kind !== 'nominal') return invalid('nominal field required.');
  if (typeof field !== 'string' || field.length === 0 || field.includes('.') ||
      ['id', 'version', 'created', 'updated', 'createdBy', 'updatedBy', 'archivedAt', 'parent'].includes(field)) return invalid('top-level stored field required.');
  const schema = bound.valueSchema;
  if (schema === undefined || !Object.hasOwn(schema.contracts, parsed.base.path)) return invalid('same-load owning contract schema required.');
  const models = bound.canonicalModels.filter(candidate => candidate.name === model);
  const artifact = bound.artifactModels.get(model);
  const fields = artifact?.fields.filter(candidate => candidate.name === field) ?? [];
  if (models.length !== 1 || artifact?.name !== model || fields.length !== 1 || !Object.hasOwn(models[0]!.fields, field)) return invalid('exact owning stored declaration required.');
  const canonical = data(models[0]!.fields[field]) as CanonicalModelDescriptor['fields'][string];
  const authored = data(fields[0]) as ArtifactModel['fields'][number];
  if (typeof canonical !== 'object' || canonical === null || Array.isArray(canonical) ||
      typeof authored !== 'object' || authored === null || Array.isArray(authored)) return invalid('owning descriptors required.');
  if (authored.field?.kind !== 'nominal' || authored.field.name !== parsed.base.path || canonical.valueType !== nominal || authored.valueType !== nominal ||
      canonical.default?.kind === 'derived' || authored.default?.kind === 'derived') return invalid('exact stored contract declaration required.');
  try {
    if (parsed.array !== Object.hasOwn(canonical, 'array') || parsed.array !== Object.hasOwn(authored, 'array') ||
        parsed.nullable !== (canonical.nullable === true) || parsed.nullable !== (authored.nullable === true) ||
        parsed.requiredArray !== (canonical.array?.required === true) ||
        typeof canonical.required !== 'boolean' || typeof canonical.serverOnly !== 'boolean') return invalid('contract type disagrees with owning markers.');
    if (canonical.array !== undefined && (Object.keys(canonical.array).length !== 1 || typeof canonical.array.required !== 'boolean')) return invalid('checked array marker required.');
    if (Object.hasOwn(canonical, 'nullable') && typeof canonical.nullable !== 'boolean') return invalid('checked nullable marker required.');
    for (const key of ['required', 'serverOnly', 'array', 'nullable', 'trim', 'min', 'max'] as const) {
      if (Object.hasOwn(canonical, key) !== Object.hasOwn(authored, key) ||
          Object.hasOwn(canonical, key) && stableStringify(canonical[key]) !== stableStringify(authored[key])) return invalid('owning declarations disagree.');
    }
    checkSchemaClosure(schema, nominal, bound);
    const constraint = modelFieldConstraintSchema(canonical, schema);
    const profile = Object.freeze({ type: nominal, array: parsed.array, nullable: parsed.nullable });
    profiles.set(profile, { schema, constraint }); return profile;
  } catch (error) { if (error instanceof StateError) throw error; return invalid('invalid owning contract profile or constraints.'); }
}

export function storedNominalWire(profile: StoredNominalFieldProfile, wire: unknown): void {
  const owner = profiles.get(profile);
  if (owner === undefined) return invalid('authentic owning contract profile required.');
  const saved = data(wire);
  nominalShape(profile.type, saved);
  try {
    const decoded = validateValue(owner.schema, profile.type, saved, 'create');
    if (stableStringify(encodeValue(profile.type, decoded)) !== stableStringify(saved)) return invalid('complete canonical stored contract wire required.');
    if (owner.constraint !== undefined) {
      const checked = validateValue(owner.constraint.schema, owner.constraint.type, { value: saved }, 'create') as Readonly<Record<string, Parameters<typeof encodeValue>[1]>>;
      if (stableStringify(encodeValue(profile.type, checked['value']!)) !== stableStringify(saved)) return invalid('stored contract violates receiving normalization.');
    }
  } catch (error) { if (error instanceof StateError) throw error; return invalid('stored contract violates its owning Values schema or constraints.'); }
}
