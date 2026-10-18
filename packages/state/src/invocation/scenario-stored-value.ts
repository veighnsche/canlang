/** Whole stored nominal values remain JSON evidence, never reference authority. */
import type { ArtifactModel, CanonicalModelDescriptor, CanTypeId, ModelName } from '@canlang/contracts';
import { encodeValue, parseTypeId, printTypeId, validateValue, type NormalizedSchema } from '@canlang/values';
import { StateError } from '../errors.js';
import { modelFieldConstraintSchema } from '../mutation/models.js';
import { stableStringify } from './replay.js';

const invalid = (message: string): never => { throw new StateError('validation', `Saved scenario nominal: ${message}`); };

/** Shared finite-copy budget (one top-level detach). */
interface StoredNominalBudget {
  nodes: number;
  readonly active: Set<object>;
}

/** One entry in descriptor order: dense-array or own-enumerable-object member. */
function copyStoredNominalEntries(
  out: unknown[] | Record<string, unknown>,
  part: object,
  keys: readonly (string | symbol)[],
  array: boolean,
  length: number,
  depth: number,
  budget: StoredNominalBudget,
): void {
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(part, key);
    if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable ||
        array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) return invalid('own enumerable data required.');
    Object.defineProperty(out, key, { value: copyStoredNominalPart(descriptor.value, depth + 1, budget), enumerable: true, writable: true, configurable: true });
  }
}

/** Dense finite array length for one detached node. */
function storedNominalArrayLength(part: object, keys: readonly (string | symbol)[]): number {
  const descriptor = Object.getOwnPropertyDescriptor(part, 'length');
  if (descriptor === undefined || !('value' in descriptor) || !Number.isSafeInteger(descriptor.value) ||
      descriptor.value < 0 || descriptor.value > 20_000 || keys.length !== descriptor.value + 1) {
    return invalid('dense finite arrays required.');
  }
  return descriptor.value as number;
}

/** One detached node: primitives pass through, plain objects/arrays recurse. */
function copyStoredNominalPart(part: unknown, depth: number, budget: StoredNominalBudget): unknown {
  if (++budget.nodes > 20_000 || depth > 32) return invalid('data exceeds its finite budget.');
  if (part === null || typeof part === 'string' || typeof part === 'boolean') return part;
  if (typeof part === 'number' && Number.isFinite(part)) return part;
  if (typeof part !== 'object' || part === null || budget.active.has(part)) return invalid('own JSON data required.');
  const array = Array.isArray(part), prototype = Object.getPrototypeOf(part);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid('own JSON data required.');
  budget.active.add(part);
  const keys = Reflect.ownKeys(part);
  if (keys.length > 20_000 - budget.nodes) return invalid('data exceeds its finite budget.');
  const out: unknown[] | Record<string, unknown> = array ? [] : {};
  const length = array ? storedNominalArrayLength(part, keys) : 0;
  copyStoredNominalEntries(out, part, keys, array, length, depth, budget);
  budget.active.delete(part); return out;
}

/** Closed own JSON data, detached before Values traverses any member. */
function data(value: unknown): unknown {
  try { return copyStoredNominalPart(value, 0, { nodes: 0, active: new Set<object>() }); }
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
  /** Declared File leaves require a separate receiving authority join, even when empty. */
  readonly hasFiles: boolean;
}
type Bound = { readonly artifactModels: ReadonlyMap<ModelName, ArtifactModel>;
  readonly canonicalModels: readonly CanonicalModelDescriptor[]; readonly valueSchema: NormalizedSchema | undefined };
const profiles = new WeakMap<StoredNominalFieldProfile, { readonly schema: NormalizedSchema;
  readonly constraint: ReturnType<typeof modelFieldConstraintSchema> }>();

/** Shared schema-closure traversal (one nominal root). */
interface SchemaClosureScope {
  readonly schema: NormalizedSchema;
  readonly models: ReadonlySet<string>;
  readonly bound: Bound;
  readonly visited: Set<string>;
  nodes: number;
  hasFiles: boolean;
  readonly protectedFiles: boolean;
}

/** One nested nominal declaration: contracts recurse, enums/aliases resolve. */
function inspectClosureNominal(
  scope: SchemaClosureScope,
  name: string,
  depth: number,
): void {
  const isContract = Object.hasOwn(scope.schema.contracts, name);
  const isEnum = Object.hasOwn(scope.schema.enums, name);
  const isAlias = scope.schema.aliases !== undefined && Object.hasOwn(scope.schema.aliases, name);
  const declarations = Number(isContract) + Number(isEnum) + Number(isAlias);
  const artifact = scope.bound.artifactModels.get(name as ModelName);
  if (declarations > 1 || declarations > 0 && (scope.models.has(name) || scope.bound.artifactModels.has(name as ModelName))) {
    return invalid('nominal declaration namespaces overlap.');
  }
  if (scope.visited.has(name)) return;
  scope.visited.add(name);
  const contract = isContract ? scope.schema.contracts[name] : undefined;
  if (contract !== undefined) { for (const field of Object.values(contract.fields)) inspectSchemaClosureType(field.typeId, depth + 1, scope); return; }
  if (isEnum) return;
  const alias = isAlias ? scope.schema.aliases![name] : undefined;
  if (alias !== undefined) { inspectSchemaClosureType(alias.typeId, depth + 1, scope); return; }
  if (!scope.models.has(name) || artifact?.name !== name) return invalid('nested nominal lacks its same-load owning declaration.');
}

/** One nested type: nominals resolve, files join, other bases stay scalar. */
function inspectSchemaClosureType(type: string, depth: number, scope: SchemaClosureScope): void {
  if (++scope.nodes > 20_000 || depth > 32) return invalid('schema exceeds its finite budget.');
  const parsed = parseTypeId(type);
  if (printTypeId(parsed) !== type) return invalid('canonical nested type required.');
  const base = parsed.base;
  if (base.kind === 'nominal') {
    inspectClosureNominal(scope, base.path, depth);
    return;
  }
  if (base.kind === 'file') {
    if (!scope.protectedFiles) return invalid('nested protected or unsupported value requires its defining join.');
    scope.hasFiles = true; return;
  }
  if (!['scalar', 'stringlike', 'enum', 'user'].includes(base.kind)) return invalid('nested protected or unsupported value requires its defining join.');
}

/** Unknown nominals cannot acquire model identity through Values' ref fallback. */
function checkSchemaClosure(schema: NormalizedSchema, root: string, bound: Bound, protectedFiles = false): boolean {
  const scope: SchemaClosureScope = {
    schema, bound, protectedFiles,
    models: new Set(bound.canonicalModels.map(model => model.name as string)),
    visited: new Set<string>(), nodes: 0, hasFiles: false,
  };
  inspectSchemaClosureType(root, 0, scope);
  return scope.hasFiles;
}

/** Owning stored declaration pair: detached canonical and authored descriptors. */
function findStoredNominalDeclaration(
  bound: Bound,
  model: ModelName,
  field: string,
  nominal: CanTypeId,
  basePath: string,
): { canonical: CanonicalModelDescriptor['fields'][string]; authored: ArtifactModel['fields'][number] } {
  const models = bound.canonicalModels.filter(candidate => candidate.name === model);
  const artifact = bound.artifactModels.get(model);
  const fields = artifact?.fields.filter(candidate => candidate.name === field) ?? [];
  if (models.length !== 1 || artifact?.name !== model || fields.length !== 1 || !Object.hasOwn(models[0]!.fields, field)) {
    return invalid('exact owning stored declaration required.');
  }
  const canonical = data(models[0]!.fields[field]) as CanonicalModelDescriptor['fields'][string];
  const authored = data(fields[0]) as ArtifactModel['fields'][number];
  if (typeof canonical !== 'object' || canonical === null || Array.isArray(canonical) ||
      typeof authored !== 'object' || authored === null || Array.isArray(authored)) return invalid('owning descriptors required.');
  checkStoredNominalDeclaration(authored, canonical, nominal, basePath);
  return { canonical, authored };
}

/** Nominal tag with matching non-derived value type on both descriptors. */
function checkStoredNominalDeclaration(
  authored: ArtifactModel['fields'][number],
  canonical: CanonicalModelDescriptor['fields'][string],
  nominal: CanTypeId,
  basePath: string,
): void {
  if (authored.field?.kind !== 'nominal' || authored.field.name !== basePath || canonical.valueType !== nominal || authored.valueType !== nominal ||
      canonical.default?.kind === 'derived' || authored.default?.kind === 'derived') return invalid('exact stored contract declaration required.');
}

/** Contract type agreement with owning markers (array, nullability, bounds). */
function checkStoredNominalMarkers(
  canonical: CanonicalModelDescriptor['fields'][string],
  authored: ArtifactModel['fields'][number],
  parsed: ReturnType<typeof parseTypeId>,
): void {
  if (parsed.array !== Object.hasOwn(canonical, 'array') || parsed.array !== Object.hasOwn(authored, 'array') ||
      parsed.nullable !== (canonical.nullable === true) || parsed.nullable !== (authored.nullable === true) ||
      parsed.requiredArray !== (canonical.array?.required === true) ||
      typeof canonical.required !== 'boolean' || typeof canonical.serverOnly !== 'boolean') return invalid('contract type disagrees with owning markers.');
  if (canonical.array !== undefined && (Object.keys(canonical.array).length !== 1 || typeof canonical.array.required !== 'boolean')) {
    return invalid('checked array marker required.');
  }
  if (Object.hasOwn(canonical, 'nullable') && typeof canonical.nullable !== 'boolean') return invalid('checked nullable marker required.');
  for (const key of ['required', 'serverOnly', 'array', 'nullable', 'trim', 'min', 'max'] as const) {
    if (Object.hasOwn(canonical, key) !== Object.hasOwn(authored, key) ||
        Object.hasOwn(canonical, key) && stableStringify(canonical[key]) !== stableStringify(authored[key])) return invalid('owning declarations disagree.');
  }
}

export function storedNominalField(bound: Bound, model: ModelName, field: string, type: unknown,
  options?: { readonly protectedFiles?: true }): StoredNominalFieldProfile {
  const nominal = storedNominalType(type), parsed = parseTypeId(nominal);
  if (parsed.base.kind !== 'nominal') return invalid('nominal field required.');
  if (typeof field !== 'string' || field.length === 0 || field.includes('.') ||
      ['id', 'version', 'created', 'updated', 'createdBy', 'updatedBy', 'archivedAt', 'parent'].includes(field)) return invalid('top-level stored field required.');
  const schema = bound.valueSchema;
  if (schema === undefined || !Object.hasOwn(schema.contracts, parsed.base.path)) return invalid('same-load owning contract schema required.');
  const found = findStoredNominalDeclaration(bound, model, field, nominal, parsed.base.path);
  const canonical = found.canonical, authored = found.authored;
  try {
    checkStoredNominalMarkers(canonical, authored, parsed);
    const hasFiles = checkSchemaClosure(schema, nominal, bound, options?.protectedFiles === true);
    const constraint = modelFieldConstraintSchema(canonical, schema);
    const profile = Object.freeze({ type: nominal, array: parsed.array, nullable: parsed.nullable, hasFiles });
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
    if (stableStringify(encodeValue(profile.type, decoded, undefined, owner.schema)) !== stableStringify(saved)) return invalid('complete canonical stored contract wire required.');
    if (owner.constraint !== undefined) {
      const checked = validateValue(owner.constraint.schema, owner.constraint.type, { value: saved }, 'create') as Readonly<Record<string, Parameters<typeof encodeValue>[1]>>;
      if (stableStringify(encodeValue(profile.type, checked['value']!, undefined, owner.schema)) !== stableStringify(saved)) return invalid('stored contract violates receiving normalization.');
    }
  } catch (error) { if (error instanceof StateError) throw error; return invalid('stored contract violates its owning Values schema or constraints.'); }
}

/** Ordered declared File wires only. This validates no bytes, receiving origin,
 * permissions or physical store, and cannot promote ordinary model references. */
export function storedNominalFileRefs(profile: StoredNominalFieldProfile, wire: unknown): readonly string[] {
  const owner = profiles.get(profile);
  if (owner === undefined) return invalid('authentic owning contract profile required.');
  const saved = data(wire);
  storedNominalWire(profile, saved);
  const refs: string[] = [];
  let nodes = 0;
  const visit = (type: string, value: unknown, depth: number): void => {
    if (++nodes > 20_000 || depth > 32) return invalid('File traversal exceeds its finite budget.');
    const parsed = parseTypeId(type);
    if (value === null) return;
    if (parsed.array) {
      if (!Array.isArray(value)) return invalid('declared File container required.');
      const element = printTypeId({ ...parsed, array: false, requiredArray: false, nullable: false });
      for (const item of value) visit(element, item, depth + 1);
      return;
    }
    if (parsed.base.kind === 'file') {
      // Values has already checked the exact canonical File wire; no raw id or
      // receipt/model/version shape is accepted by this traversal.
      refs.push((value as { id: string }).id);
      return;
    }
    if (parsed.base.kind !== 'nominal') return;
    const name = parsed.base.path, contract = owner.schema.contracts[name];
    if (contract !== undefined) {
      for (const [name, field] of Object.entries(contract.fields)) {
        if (Object.hasOwn(value as object, name)) visit(field.typeId, (value as Record<string, unknown>)[name], depth + 1);
      }
      return;
    }
    const alias = owner.schema.aliases?.[name];
    if (alias !== undefined) visit(alias.typeId, value, depth + 1);
  };
  visit(profile.type, saved, 0);
  return Object.freeze(refs);
}
