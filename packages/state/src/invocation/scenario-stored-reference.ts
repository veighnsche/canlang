/** Stored reference wires are detached evidence, never reference grants. */
import type { ArtifactModel, CanonicalModelDescriptor, CanTypeId, ModelName, StoredRow } from '@canlang/contracts';
import { encodeValue, normalizeValueTypes, parseTypeId, printTypeId, validateValue, type NormalizedSchema } from '@canlang/values';
import { StateError } from '../errors.js';
import { modelFieldConstraintSchema } from '../mutation/models.js';
import { stableStringify } from './replay.js';

const invalid = (message: string): never => { throw new StateError('validation', `Saved scenario reference: ${message}`); };

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid('own data object required.');
  return value as Record<string, unknown>;
}
function own(value: unknown, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object(value), key);
  if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) return invalid('own enumerable data member required.');
  return descriptor.value;
}

/** Shared finite-copy budget (one top-level detach). */
interface StoredReferenceBudget {
  nodes: number;
  readonly active: Set<object>;
}

/** One entry in descriptor order: dense-array or own-enumerable-object member. */
function copyStoredReferenceEntries(
  out: unknown[] | Record<string, unknown>,
  part: object,
  keys: readonly (string | symbol)[],
  array: boolean,
  length: number,
  depth: number,
  budget: StoredReferenceBudget,
): void {
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(part, key);
    if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable ||
        array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) return invalid('own enumerable JSON data required.');
    Object.defineProperty(out, key, { value: copyStoredReferencePart(descriptor.value, depth + 1, budget), enumerable: true, writable: true, configurable: true });
  }
}

/** Dense finite array length for one detached node. */
function storedReferenceArrayLength(part: object, keys: readonly (string | symbol)[]): number {
  const descriptor = Object.getOwnPropertyDescriptor(part, 'length');
  if (descriptor === undefined || !('value' in descriptor) || !Number.isSafeInteger(descriptor.value) ||
      descriptor.value < 0 || descriptor.value > 20_000 || keys.length !== descriptor.value + 1) {
    return invalid('dense finite array required.');
  }
  return descriptor.value as number;
}

/** One detached node: primitives pass through, plain objects/arrays recurse. */
function copyStoredReferencePart(part: unknown, depth: number, budget: StoredReferenceBudget): unknown {
  if (++budget.nodes > 20_000 || depth > 32) return invalid('data exceeds its finite budget.');
  if (part === null || typeof part === 'string' || typeof part === 'boolean') return part;
  if (typeof part === 'number' && Number.isFinite(part)) return part;
  if (typeof part !== 'object' || part === null || budget.active.has(part)) return invalid('own JSON data required.');
  const array = Array.isArray(part);
  if (array) {
    if (Object.getPrototypeOf(part) !== Array.prototype) return invalid('own JSON data required.');
  } else object(part);
  budget.active.add(part);
  const keys = Reflect.ownKeys(part);
  if (keys.length > 20_000 - budget.nodes) return invalid('data exceeds its finite budget.');
  const out: unknown[] | Record<string, unknown> = array ? [] : {};
  const length = array ? storedReferenceArrayLength(part, keys) : 0;
  copyStoredReferenceEntries(out, part, keys, array, length, depth, budget);
  budget.active.delete(part);
  return out;
}

/** Only the selected declaration or stored value enters this finite traversal. */
function data(value: unknown): unknown {
  try { return copyStoredReferencePart(value, 0, { nodes: 0, active: new Set<object>() }); }
  catch (error) { if (error instanceof StateError) throw error; return invalid('own JSON data required.'); }
}

export interface StoredReferenceFieldProfile {
  readonly type: CanTypeId;
  readonly field: string;
  readonly kind: 'field' | 'parent';
  readonly target: ModelName;
  readonly array: boolean;
  readonly nullable: boolean;
}
type Bound = { readonly artifactModels: ReadonlyMap<ModelName, ArtifactModel>;
  readonly canonicalModels: readonly CanonicalModelDescriptor[]; readonly valueSchema: NormalizedSchema | undefined };
const profiles = new WeakMap<StoredReferenceFieldProfile, { readonly schema: NormalizedSchema;
  readonly constraint: ReturnType<typeof modelFieldConstraintSchema> }>();

function modelType(type: unknown): CanTypeId {
  if (typeof type !== 'string') return invalid('canonical model type required.');
  const parsed = parseTypeId(type);
  if (parsed.base.kind !== 'nominal' || printTypeId(parsed) !== type) return invalid('canonical model type required.');
  return type as CanTypeId;
}

/** Model identity comes from both same-load declaration inventories, never a codec fallback. */
function declarations(bound: Bound): Map<ModelName, CanonicalModelDescriptor> {
  const models = new Map<ModelName, CanonicalModelDescriptor>();
  if (!Array.isArray(bound.canonicalModels) || bound.canonicalModels.length > 20_000) return invalid('finite owning model inventory required.');
  for (let index = 0; index < bound.canonicalModels.length; index++) {
    const member = Object.getOwnPropertyDescriptor(bound.canonicalModels, String(index));
    if (member === undefined || !('value' in member)) return invalid('own model inventory required.');
    const candidate = member.value as CanonicalModelDescriptor;
    const name = modelType(own(candidate, 'name'));
    const parsed = parseTypeId(name);
    if (parsed.array || parsed.nullable || models.has(name as ModelName) ||
        own(bound.artifactModels.get(name as ModelName), 'name') !== name) return invalid('exact same-load model declarations required.');
    models.set(name as ModelName, candidate);
  }
  return models;
}

/** Type head: checked model reference, owning/target declarations, value schema. */
function checkStoredReferenceHead(
  bound: Bound,
  model: ModelName,
  field: string,
  type: unknown,
): { checked: CanTypeId; target: ModelName; models: Map<ModelName, CanonicalModelDescriptor>; schema: NormalizedSchema } {
  const checked = modelType(type), parsed = parseTypeId(checked);
  if (parsed.base.kind !== 'nominal') return invalid('model reference required.');
  if (typeof field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ||
      ['id', 'version', 'created', 'updated', 'createdBy', 'updatedBy', 'archivedAt'].includes(field)) return invalid('top-level stored reference field required.');
  const models = declarations(bound), target = parsed.base.path as ModelName;
  if (!models.has(model) || !models.has(target)) return invalid('owning and target model declarations required.');
  const schema = bound.valueSchema ?? normalizeValueTypes({ contracts: [] }, [...models.keys()]).valueSchema;
  for (const name of models.keys()) {
    if (Object.hasOwn(schema.contracts, name) || Object.hasOwn(schema.enums, name) ||
        schema.aliases !== undefined && Object.hasOwn(schema.aliases, name)) return invalid('model and value declaration namespaces overlap.');
  }
  return { checked, target, models, schema };
}

/** Detached owning field inventories for one stored reference. */
function detachStoredReferenceFields(
  bound: Bound,
  models: Map<ModelName, CanonicalModelDescriptor>,
  model: ModelName,
  field: string,
): { canonicalFields: Record<string, unknown>; authored: unknown[]; artifactModel: Record<string, unknown> } {
  const canonicalModel = object(data(models.get(model)));
  const artifactModel = object(data(bound.artifactModels.get(model)));
  const canonicalFields = object(canonicalModel['fields']);
  const authoredFields = artifactModel['fields'];
  if (!Array.isArray(authoredFields)) return invalid('owning field inventory required.');
  const authored = authoredFields.filter(candidate => object(candidate)['name'] === field);
  return { canonicalFields, authored, artifactModel };
}

/** Declared parent containment (unshadowed, scopeless, exact). */
function checkStoredReferenceParent(
  artifactModel: Record<string, unknown>,
  canonicalFields: Record<string, unknown>,
  candidates: readonly unknown[],
  field: string,
  checked: CanTypeId,
  array: boolean,
  nullable: boolean,
): void {
  if (array || nullable || artifactModel['parent'] !== checked || Object.hasOwn(artifactModel, 'scope') ||
      candidates.length !== 0 || Object.hasOwn(canonicalFields, field)) return invalid('unshadowed declared parent containment required.');
}

/** Reference tag with matching non-derived value type on both descriptors. */
function checkStoredReferenceTag(
  authored: Record<string, unknown>,
  canonical: Record<string, unknown>,
  target: ModelName,
  checked: CanTypeId,
): void {
  const tag = object(authored['field']);
  if (Object.keys(tag).length !== 2 || tag['kind'] !== 'ref' || tag['model'] !== target ||
      authored['valueType'] !== checked || canonical['valueType'] !== checked ||
      Object.hasOwn(canonical, 'machine') || Object.hasOwn(canonical, 'delivery') || Object.hasOwn(authored, 'machine') ||
      (Object.hasOwn(canonical, 'default') && object(canonical['default'])['kind'] === 'derived') ||
      (Object.hasOwn(authored, 'default') && object(authored['default'])['kind'] === 'derived')) return invalid('exact stored reference declaration required.');
}

/** Stored field declaration agreement plus its owning constraint. */
function checkStoredReferenceField(
  canonicalFields: Record<string, unknown>,
  candidates: readonly unknown[],
  field: string,
  checked: CanTypeId,
  target: ModelName,
  array: boolean,
  nullable: boolean,
  requiredArray: boolean,
  schema: NormalizedSchema,
): ReturnType<typeof modelFieldConstraintSchema> {
  if (candidates.length !== 1 || !Object.hasOwn(canonicalFields, field)) return invalid('exact owning stored field required.');
  const authored = object(candidates[0]), canonical = object(canonicalFields[field]);
  checkStoredReferenceTag(authored, canonical, target, checked);
  if (typeof canonical['required'] !== 'boolean' || typeof canonical['serverOnly'] !== 'boolean' ||
      array !== Object.hasOwn(canonical, 'array') || array !== Object.hasOwn(authored, 'array') ||
      nullable !== (canonical['nullable'] === true) || nullable !== (authored['nullable'] === true)) return invalid('reference type disagrees with owning markers.');
  if (Object.hasOwn(canonical, 'nullable') && typeof canonical['nullable'] !== 'boolean') return invalid('checked nullable marker required.');
  if (array) {
    const marker = object(canonical['array']);
    if (Object.keys(marker).length !== 1 || typeof marker['required'] !== 'boolean' ||
        requiredArray !== marker['required']) return invalid('checked required-array marker required.');
  }
  for (const key of ['required', 'serverOnly', 'array', 'nullable', 'trim', 'min', 'max'] as const) {
    if (Object.hasOwn(canonical, key) !== Object.hasOwn(authored, key) ||
        Object.hasOwn(canonical, key) && stableStringify(canonical[key]) !== stableStringify(authored[key])) return invalid('owning reference declarations disagree.');
  }
  return modelFieldConstraintSchema(canonical as unknown as CanonicalModelDescriptor['fields'][string], schema);
}

export function storedReferenceField(bound: Bound, model: ModelName, field: string, type: unknown): StoredReferenceFieldProfile {
  try {
    const head = checkStoredReferenceHead(bound, model, field, type);
    const parsed = parseTypeId(head.checked);
    const detached = detachStoredReferenceFields(bound, head.models, model, field);
    let constraint: ReturnType<typeof modelFieldConstraintSchema> = undefined;
    const kind = field === 'parent' ? 'parent' : 'field';
    if (kind === 'parent') {
      checkStoredReferenceParent(detached.artifactModel, detached.canonicalFields, detached.authored, field, head.checked, parsed.array, parsed.nullable);
    } else {
      constraint = checkStoredReferenceField(detached.canonicalFields, detached.authored, field, head.checked,
        head.target, parsed.array, parsed.nullable, parsed.requiredArray, head.schema);
    }
    const profile = Object.freeze({ type: head.checked, field, kind, target: head.target, array: parsed.array, nullable: parsed.nullable });
    profiles.set(profile, { schema: head.schema, constraint });
    return profile;
  } catch (error) { if (error instanceof StateError) throw error; return invalid('invalid owning reference profile or constraints.'); }
}

/** A profile copy cannot select data; only the privately bound declaration can. */
export function storedReferenceWire(profile: StoredReferenceFieldProfile, row: StoredRow): unknown {
  const owner = profiles.get(profile);
  if (owner === undefined) return invalid('authentic owning reference profile required.');
  try {
    let saved: unknown;
    if (profile.kind === 'parent') {
      const parent = object(data(own(row, 'parent')));
      if (Object.keys(parent).length !== 2 || parent['model'] !== profile.target ||
          typeof parent['id'] !== 'string' || parent['id'].length === 0) return invalid('exact declared stored parent linkage required.');
      saved = { id: parent['id'] };
    } else saved = data(own(own(row, 'data'), profile.field));
    const decoded = validateValue(owner.schema, profile.type, saved, 'create');
    if (stableStringify(encodeValue(profile.type, decoded)) !== stableStringify(saved)) return invalid('complete canonical stored reference wire required.');
    if (owner.constraint !== undefined) {
      const checked = validateValue(owner.constraint.schema, owner.constraint.type, { value: saved }, 'create') as Readonly<Record<string, Parameters<typeof encodeValue>[1]>>;
      if (stableStringify(encodeValue(profile.type, checked['value']!)) !== stableStringify(saved)) return invalid('stored reference violates receiving normalization.');
    }
    return saved;
  } catch (error) { if (error instanceof StateError) throw error; return invalid('stored reference violates its owning Values schema or constraints.'); }
}
