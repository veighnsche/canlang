/** A File census follows owning value declarations, never reference authority. */
import type { ArtifactModel, ArtifactModelField, CanonicalFieldDef, CanonicalModelDescriptor, CanonicalValueTypes, CanTypeId, ModelName } from '@canlang/contracts';
import { assertSafeBlobKey } from '@canlang/files/ports';
import { encodeValue, normalizeValueTypes, parseTypeId, printTypeBase, printTypeId, validateValue,
  type NormalizedSchema, type NormalizedType } from '@canlang/values';
import { StateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { modelFieldConstraintSchema } from '../mutation/models.js';
import { copyScenarioFileData, scenarioFileField } from '../invocation/scenario-file-assignment.js';
import { stableStringify } from '../invocation/replay.js';

export interface FileReferenceProfile {
  readonly type: CanTypeId;
  readonly fileBearing: boolean;
  readonly array: boolean;
  readonly nullable: boolean;
}
export interface FileReferenceOccurrence {
  readonly ref: string;
  /** Relative to the complete owning field. Union payloads include "value". */
  readonly path: readonly (string | number)[];
}
export interface FileReferenceProfileBound {
  readonly artifactModels: ReadonlyMap<ModelName, ArtifactModel>;
  readonly canonicalModels: readonly CanonicalModelDescriptor[];
  readonly valueSchema?: NormalizedSchema;
  readonly valueTypes?: CanonicalValueTypes;
}
const invalid = (message: string): never => { throw new StateError('validation', `File reference profile: ${message}`); };
const MAX_NODES = 20_000, MAX_DEPTH = 32;
type Constraint = ReturnType<typeof modelFieldConstraintSchema>;
const profiles = new WeakMap<FileReferenceProfile, {
  readonly schema: NormalizedSchema;
  readonly constraint: Constraint;
}>();
// Pure declaration preparation only. No File/source/Identity verdict is reused.
// Fingerprinting below proves the complete normalized graph immutable before
// its result can be retained. Mutable caller inventories take the fresh path.
const schemaFingerprints = new WeakMap<NormalizedSchema, string>();
const normalizedInventories = new WeakMap<CanonicalValueTypes, Map<string, NormalizedSchema>>();
function immutableInventory(value: unknown, active = new Set<object>(), budget = { nodes: 0 }, depth = 0): boolean {
  if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) return false;
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value) || active.has(value) ||
      ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value))) return false;
  active.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || property === undefined || !('value' in property) || !property.enumerable ||
        !immutableInventory(property.value, active, budget, depth + 1)) return false;
  }
  active.delete(value); return true;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid('own object metadata required.');
  return value as Record<string, unknown>;
}
function parsed(type: unknown): NormalizedType {
  if (typeof type !== 'string') return invalid('owning canonical valueType required.');
  const result = parseTypeId(type);
  if (printTypeId(result) !== type) return invalid('canonical valueType required.');
  return result;
}

/** Keep Values' immutable normalized objects, including exact bigint bounds.
 * The tagged fingerprint also checks own data before any schema traversal. */
interface FingerprintBudget { nodes: number; readonly active: Set<object>; }

function fingerprintScalar(value: unknown): unknown[] | undefined {
  if (value === null) return ['null'];
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') return [typeof value, String(value)];
  if (typeof value === 'number' && Number.isFinite(value)) return ['number', String(value)];
  return undefined;
}

function fingerprintMember(
  value: object,
  key: string | symbol,
  array: boolean,
  length: number,
  budget: FingerprintBudget,
  depth: number,
  members: unknown[],
): void {
  if (array && key === 'length') return;
  const member = Object.getOwnPropertyDescriptor(value, key);
  if (typeof key !== 'string' || member === undefined || !('value' in member) || !member.enumerable ||
      array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length)) return invalid('own schema data required.');
  members.push([key, fingerprintValue(member.value, depth + 1, budget)]);
}

function fingerprintValue(value: unknown, depth: number, budget: FingerprintBudget): unknown {
  if (++budget.nodes > MAX_NODES || depth > MAX_DEPTH) return invalid('schema exceeds its finite budget.');
  const scalar = fingerprintScalar(value);
  if (scalar !== undefined) return scalar;
  if (typeof value !== 'object' || value === null || budget.active.has(value) || !Object.isFrozen(value) ||
      ![Object.prototype, null, Array.prototype].includes(Object.getPrototypeOf(value))) {
    return invalid('immutable own normalized schema required.');
  }
  budget.active.add(value);
  const array = Array.isArray(value), keys = Reflect.ownKeys(value);
  if (array && keys.length !== value.length + 1) return invalid('dense schema arrays required.');
  const members: unknown[] = [];
  for (const key of keys) {
    fingerprintMember(value, key, array, array ? value.length : 0, budget, depth, members);
  }
  if (!array) members.sort((a, b) => (a as [string])[0].localeCompare((b as [string])[0]));
  budget.active.delete(value);
  return [array ? 'array' : 'object', members];
}

function schemaFingerprint(schema: NormalizedSchema): string {
  const existing = schemaFingerprints.get(schema); if (existing !== undefined) return existing;
  const fingerprint = JSON.stringify(fingerprintValue(schema, 0, { nodes: 0, active: new Set<object>() }));
  if (schema.kind !== 'normalized-schema' || schema.contracts === undefined || schema.enums === undefined || schema.operations === undefined) {
    return invalid('complete normalized Values schema required.');
  }
  schemaFingerprints.set(schema, fingerprint);
  return fingerprint;
}

const scalarTags: Readonly<Record<string, string>> = Object.freeze({
  integer: 'int', decimal: 'decimal', money: 'money', datetime: 'datetime', boolean: 'bool',
  date: 'date', duration: 'duration', file: 'file', user: 'user', member: 'member', json: 'json', secret: 'secret',
});

function checkSameLoadInventory(
  canonicalModels: readonly CanonicalModelDescriptor[],
  bound: FileReferenceProfileBound,
): Set<string> {
  const names = new Set<string>();
  for (const declaration of canonicalModels) {
    const type = parsed(declaration.name);
    if (type.base.kind !== 'nominal' || type.array || type.nullable || names.has(declaration.name) ||
        bound.artifactModels.get(declaration.name)?.name !== declaration.name) return invalid('exact same-load model inventory required.');
    names.add(declaration.name);
  }
  if (names.size !== bound.artifactModels.size) return invalid('complete same-load model inventory required.');
  return names;
}

function loadNormalizedInventory(
  bound: FileReferenceProfileBound,
  names: ReadonlySet<string>,
): NormalizedSchema | undefined {
  if (bound.valueTypes === undefined) return undefined;
  const cohort = JSON.stringify([...names]), prepared = normalizedInventories.get(bound.valueTypes);
  const cached = prepared?.get(cohort);
  if (cached !== undefined) return cached;
  const normalized = normalizeValueTypes(copyScenarioFileData(bound.valueTypes), [...names]).valueSchema;
  if (immutableInventory(bound.valueTypes)) {
    const entries = prepared ?? new Map<string, NormalizedSchema>();
    entries.set(cohort, normalized); normalizedInventories.set(bound.valueTypes, entries);
  }
  return normalized;
}

/** Shared same-load inventories; schema data does not establish source authority. */
function boundValueSchema(bound: FileReferenceProfileBound): {
  readonly canonicalModels: readonly CanonicalModelDescriptor[];
  readonly names: ReadonlySet<string>;
  readonly schema: NormalizedSchema;
} {
  const canonicalModels = copyScenarioFileData(bound.canonicalModels) as readonly CanonicalModelDescriptor[];
  const names = checkSameLoadInventory(canonicalModels, bound);
  const normalized = loadNormalizedInventory(bound, names);
  const schema = bound.valueSchema ?? normalized ?? normalizeValueTypes({ contracts: [] }, [...names]).valueSchema;
  const fingerprint = schemaFingerprint(schema);
  if (normalized !== undefined && schemaFingerprint(normalized) !== fingerprint) return invalid('loaded Values inventories disagree.');
  for (const name of names) {
    if (Object.hasOwn(schema.contracts, name) || Object.hasOwn(schema.enums, name) ||
        schema.aliases !== undefined && Object.hasOwn(schema.aliases, name)) return invalid('model and value namespaces overlap.');
  }
  return { canonicalModels, names, schema };
}

/** Constraint ownership is checked by the calling declaration consumer. */
type DeclaredConstraint = Pick<CanonicalFieldDef, 'valueType' | 'trim' | 'min' | 'max'>;
function declaredProfile(schema: NormalizedSchema, names: ReadonlySet<string>, type: CanTypeId,
  constraint?: DeclaredConstraint): FileReferenceProfile {
  const root = parsed(type);
  let nodes = 0;
  const active = new Set<string>();
  const inspect = (ast: NormalizedType, depth: number): boolean => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return invalid('type closure exceeds its finite budget.');
    const base = ast.base;
    if (base.kind === 'file') return true;
    if (base.kind === 'union') {
      let bearing = false;
      for (const arm of base.arms) bearing = inspect(parsed(arm), depth + 1) || bearing;
      return bearing;
    }
    if (base.kind !== 'nominal') return false;
    const name = base.path, contract = Object.hasOwn(schema.contracts, name) ? schema.contracts[name] : undefined;
    const enumeration = Object.hasOwn(schema.enums, name);
    const alias = schema.aliases !== undefined && Object.hasOwn(schema.aliases, name) ? schema.aliases[name] : undefined;
    if (Number(contract !== undefined) + Number(enumeration) + Number(alias !== undefined) + Number(names.has(name)) !== 1) return invalid('nominal requires one actual owning declaration.');
    if (names.has(name) || enumeration) return false;
    // Values permits recursive declarations. Every reachable field is still
    // inspected on its first active path; finite stored data is checked below.
    if (active.has(name)) return false;
    active.add(name);
    let bearing = false;
    if (alias !== undefined) bearing = inspect(parsed(alias.typeId), depth + 1);
    else if (contract !== undefined) for (const nested of Object.values(contract.fields)) bearing = inspect(parsed(nested.typeId), depth + 1) || bearing;
    active.delete(name);
    return bearing;
  };
  const fileBearing = inspect(root, 0);
  const savedConstraint = constraint === undefined ? undefined : object(copyScenarioFileData(constraint)) as DeclaredConstraint;
  if (savedConstraint !== undefined && Object.hasOwn(savedConstraint, 'valueType') &&
      savedConstraint.valueType !== type) return invalid('receiving constraint type disagrees with its declaration.');
  const receiving = savedConstraint === undefined ? undefined : modelFieldConstraintSchema({
    ...savedConstraint, valueType: type,
  }, schema);
  const profile = Object.freeze({ type, fileBearing, array: root.array, nullable: root.nullable });
  profiles.set(profile, { schema, constraint: receiving });
  return profile;
}

/** Bind an original declaration type whose source/canonical/artifact ownership
 * the caller already checked. This internal helper grants only finite typed
 * traversal, never origin, admission or reference authority. No model field is
 * invented to represent a scenario input, result or default. */
export function bindDeclaredFileReferenceProfile(bound: FileReferenceProfileBound, type: CanTypeId,
  constraint?: DeclaredConstraint): FileReferenceProfile {
  try {
    const { names, schema } = boundValueSchema(bound);
    return declaredProfile(schema, names, type, constraint);
  } catch (error) { if (error instanceof StateError) throw error; return invalid('invalid owning File census metadata or constraints.'); }
}

/** Bind one actual owning stored declaration. Unknown nominal fallback cannot
 * establish a complete census, even when Values would decode it as a model ref. */
/** The canonical spelling of an artifact field default: a server default
 * keeps only its kind canonically (the T18 init payload is censused as a
 * server init, not carried in the canonical default). Other default kinds
 * already carry their complete canonical payload. */
function canonicalDefaultSpelling(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'server') return { kind: 'server' };
  return value;
}

interface OwningFieldResolution {
  readonly names: ReadonlySet<string>;
  readonly schema: NormalizedSchema;
  readonly canonical: CanonicalFieldDef;
  readonly source: ArtifactModelField;
  readonly tag: Record<string, unknown>;
}

function resolveOwningField(
  bound: FileReferenceProfileBound,
  model: ModelName,
  field: string,
): OwningFieldResolution {
  const { canonicalModels, names, schema } = boundValueSchema(bound);
  const owners = canonicalModels.filter(candidate => candidate.name === model);
  const artifact = copyScenarioFileData(bound.artifactModels.get(model)) as ArtifactModel;
  const authored = artifact?.fields.filter(candidate => candidate.name === field) ?? [];
  if (owners.length !== 1 || artifact?.name !== model || authored.length !== 1 || !Object.hasOwn(owners[0]!.fields, field)) return invalid('exact owning field required.');
  const canonical = owners[0]!.fields[field]!, source = authored[0]!, tag = object(source.field);
  return { names, schema, canonical, source, tag };
}

function compareOwningField(canonical: CanonicalFieldDef, source: ArtifactModelField): void {
  for (const key of ['required', 'serverOnly', 'array', 'nullable', 'trim', 'min', 'max', 'default'] as const) {
    // Compare defaults in their canonical spelling: a server default keeps
    // only its kind canonically, while its artifact spelling may carry the
    // T18 init payload (censused separately as a server init).
    const sourceValue = key === 'default' ? canonicalDefaultSpelling(source[key]) : source[key];
    if (Object.hasOwn(canonical, key) !== Object.hasOwn(source, key) ||
        Object.hasOwn(canonical, key) && stableStringify(canonical[key]) !== stableStringify(sourceValue)) return invalid('owning field declarations disagree.');
  }
}

function checkDeliveryResultFields(nominal: Record<string, unknown>): void {
  const fields = nominal['fields'];
  if (Object.keys(nominal).length !== 2 || typeof nominal['name'] !== 'string' || nominal['name'] === '' ||
      !Array.isArray(fields)) return invalid('complete delivery result descriptor required.');
  const resultNames = new Set<string>();
  for (const raw of fields) {
    const leaf = object(raw);
    if (typeof leaf['name'] !== 'string' || leaf['name'] === '' || resultNames.has(leaf['name']) ||
        typeof leaf['type'] !== 'string') return invalid('complete unique delivery result fields required.');
    resultNames.add(leaf['name']); parsed(leaf['type']);
  }
}

function resolveDeliveryBase(
  tag: Record<string, unknown>,
  canonical: CanonicalFieldDef,
  schema: NormalizedSchema,
): string | undefined {
  if (tag['kind'] !== 'delivery') return undefined;
  const expected = ['kind', 'capability', 'operation', 'version', 'result', ...(Object.hasOwn(tag, 'judgment') ? ['judgment'] : [])];
  if (Object.keys(tag).length !== expected.length || expected.some(key => !Object.hasOwn(tag, key)) ||
      typeof tag['capability'] !== 'string' || tag['capability'] === '' ||
      typeof tag['operation'] !== 'string' || tag['operation'] === '' || canonical.array !== undefined ||
      canonical.delivery === undefined || stableStringify(canonical.delivery) !== stableStringify(tag)) {
    return invalid('exact owning delivery identity declaration required.');
  }
  if (Object.hasOwn(tag, 'judgment')) {
    if (tag['judgment'] !== true || tag['operation'] !== 'evaluate' || typeof tag['version'] !== 'string' ||
        stableStringify(encodeValue('int', validateValue(schema, 'int', tag['version'], 'create'))) !== stableStringify(tag['version'])) {
      return invalid('exact original Judgment delivery version required.');
    }
  } else if (!Number.isSafeInteger(tag['version']) || (tag['version'] as number) < 1) {
    return invalid('exact original delivery version required.');
  }
  checkDeliveryResultFields(object(tag['result']));
  return `delivery(${tag['capability']}.${tag['operation']})`;
}

function checkDeliveryTag(
  tag: Record<string, unknown>,
  root: NormalizedType,
  base: string,
  deliveryBase: string | undefined,
): void {
  if (root.base.kind !== 'delivery' || base !== deliveryBase || root.array) {
    return invalid('exact declared delivery reference required.');
  }
}

function checkNominalTag(tag: Record<string, unknown>, root: NormalizedType, names: ReadonlySet<string>): void {
  if (Object.keys(tag).length !== 2 || root.base.kind !== 'nominal' || tag['name'] !== root.base.path || names.has(root.base.path)) {
    return invalid('exact nominal source tag required.');
  }
}

function checkRefTag(tag: Record<string, unknown>, root: NormalizedType, names: ReadonlySet<string>): void {
  if (Object.keys(tag).length !== 2 || root.base.kind !== 'nominal' || tag['model'] !== root.base.path || !names.has(root.base.path)) {
    return invalid('exact same-load model reference tag required.');
  }
}

function checkOtherTag(tag: Record<string, unknown>, base: string): void {
  if (Object.keys(tag).length !== 2 || tag['type'] !== base) return invalid('exact other source type required.');
}

function checkEnumTag(tag: Record<string, unknown>, root: NormalizedType): void {
  if (Object.keys(tag).length !== 2 || !(root.base.kind === 'enum' || root.base.kind === 'nominal') ||
      root.base.kind === 'enum' && stableStringify(tag['values']) !== stableStringify(root.base.cases)) {
    return invalid('exact enum source tag required.');
  }
}

function checkStringTag(tag: Record<string, unknown>, root: NormalizedType, base: string): void {
  if (Object.keys(tag).length !== 1 || !(base === 'text' || root.base.kind === 'stringlike')) {
    return invalid('exact checked string source type required.');
  }
}

function checkScalarTag(tag: Record<string, unknown>, base: string, inferred: string | undefined): void {
  if (Object.keys(tag).length !== 1 || inferred === undefined || inferred !== base) {
    return invalid('known exact source type required.');
  }
}

function checkNamedEnumCases(
  tag: Record<string, unknown>,
  root: NormalizedType,
  schema: NormalizedSchema,
): void {
  if (tag['kind'] === 'enum' && root.base.kind === 'nominal' &&
      (!Object.hasOwn(schema.enums, root.base.path) || stableStringify(schema.enums[root.base.path]!.cases) !== stableStringify(tag['values']))) {
    return invalid('ordered named enum cases disagree with their owning declaration.');
  }
}

function checkFieldTag(
  tag: Record<string, unknown>,
  root: NormalizedType,
  base: string,
  names: ReadonlySet<string>,
  inferred: string | undefined,
  deliveryBase: string | undefined,
  schema: NormalizedSchema,
): void {
  switch (tag['kind']) {
    case 'delivery':
      checkDeliveryTag(tag, root, base, deliveryBase);
      break;
    case 'nominal':
      checkNominalTag(tag, root, names);
      break;
    case 'ref':
      checkRefTag(tag, root, names);
      break;
    case 'other':
      checkOtherTag(tag, base);
      break;
    case 'enum':
      checkEnumTag(tag, root);
      break;
    case 'string':
      checkStringTag(tag, root, base);
      break;
    default:
      checkScalarTag(tag, base, inferred);
  }
  checkNamedEnumCases(tag, root, schema);
}

function resolveLegacyBase(
  tag: Record<string, unknown>,
  deliveryBase: string | undefined,
  inferred: string | undefined,
): string | undefined {
  return deliveryBase ?? inferred ?? (tag['kind'] === 'string' ? 'text' :
    tag['kind'] === 'enum' && Array.isArray(tag['values']) && tag['values'].length > 0 &&
      tag['values'].every(value => typeof value === 'string' && value !== '') ? `enum(${tag['values'].join(',')})` : undefined);
}

function resolveFieldValueType(
  type: unknown,
  source: ArtifactModelField,
  canonical: CanonicalFieldDef,
  legacyBase: string | undefined,
): unknown {
  if (type === undefined && source.valueType === undefined && legacyBase !== undefined) {
    type = `${legacyBase}${canonical.array === undefined ? '' : canonical.array.required ? '[]!' : '[]'}${canonical.nullable === true ? '?' : ''}`;
  }
  if (type === undefined || source.valueType !== undefined && source.valueType !== type ||
      canonical.valueType === undefined && source.valueType !== undefined) {
    return invalid('matching owning valueType required.');
  }
  return type;
}

function checkFieldMarkers(canonical: CanonicalFieldDef): void {
  if (typeof canonical.required !== 'boolean' || typeof canonical.serverOnly !== 'boolean' ||
      Object.hasOwn(canonical, 'nullable') && typeof canonical.nullable !== 'boolean') return invalid('checked field markers required.');
  if (canonical.array !== undefined && (Object.keys(canonical.array).length !== 1 || typeof canonical.array.required !== 'boolean')) return invalid('closed array marker required.');
}

export function bindFileReferenceProfile(bound: FileReferenceProfileBound, model: ModelName, field: string): FileReferenceProfile {
  try {
    if (typeof field !== 'string' || field === '' || field.includes('.') ||
        ['id', 'version', 'created', 'updated', 'createdBy', 'updatedBy', 'archivedAt', 'parent'].includes(field)) return invalid('top-level stored field required.');
    const resolved = resolveOwningField(bound, model, field);
    const { names, schema, canonical, source, tag } = resolved;
    compareOwningField(canonical, source);
    checkFieldMarkers(canonical);
    let type: unknown = canonical.valueType;
    // Legacy uncollapsed scalar tags and actual model-ref tags already define
    // their element type. Collapsed strings/unknown tags still need a claim.
    const inferred = typeof tag['kind'] === 'string' ? scalarTags[tag['kind']] : undefined;
    const deliveryBase = resolveDeliveryBase(tag, canonical, schema);
    const legacyBase = resolveLegacyBase(tag, deliveryBase, inferred);
    type = resolveFieldValueType(type, source, canonical, legacyBase);
    const root = parsed(type), base = printTypeBase(root.base);
    if (root.array !== Object.hasOwn(canonical, 'array') || root.requiredArray !== (canonical.array?.required === true) ||
        root.nullable !== (canonical.nullable === true)) return invalid('owning type and container markers disagree.');
    checkFieldTag(tag, root, base, names, inferred, deliveryBase, schema);
    // Reuse the existing exact direct File intake where its finite profile
    // applies; required arrays use the same checked markers and Values below.
    if (root.base.kind === 'file' && !root.requiredArray && source.default?.kind !== 'derived' && source.valueType !== undefined) {
      scenarioFileField(bound, model, field);
    }
    return declaredProfile(schema, names, type as CanTypeId, canonical);
  } catch (error) { if (error instanceof StateError) throw error; return invalid('invalid owning File census metadata or constraints.'); }
}

/** Validate the WHOLE current stored value before returning any occurrence.
 * A copied profile cannot invoke this private binding, and facts grant nothing. */
export function fileReferenceOccurrences(profile: FileReferenceProfile, wire: unknown): readonly FileReferenceOccurrence[] {
  const owner = profiles.get(profile);
  if (owner === undefined) return invalid('authentic owning File census profile required.');
  try {
    const saved = copyScenarioFileData(wire);
    const decoded = validateValue(owner.schema, profile.type, saved, 'create');
    if (stableStringify(encodeValue(profile.type, decoded, undefined, owner.schema)) !== stableStringify(saved)) return invalid('whole canonical stored wire required.');
    if (owner.constraint !== undefined) {
      const checked = validateValue(owner.constraint.schema, owner.constraint.type, { value: saved }, 'create') as Readonly<Record<string, Parameters<typeof encodeValue>[1]>>;
      if (stableStringify(encodeValue(profile.type, checked['value']!, undefined, owner.schema)) !== stableStringify(saved)) return invalid('stored wire violates receiving normalization.');
    }
    const found: FileReferenceOccurrence[] = [];
    let nodes = 0;
    const visit = (ast: NormalizedType, value: unknown, path: readonly (string | number)[], depth: number): void => {
      if (++nodes > MAX_NODES || depth > MAX_DEPTH) return invalid('stored traversal exceeds its finite budget.');
      if (value === null) return;
      if (ast.array) {
        if (!Array.isArray(value)) return invalid('canonical stored array required.');
        const element = { ...ast, array: false, nullable: false, requiredArray: false };
        value.forEach((part, index) => visit(element, part, [...path, index], depth + 1));
        return;
      }
      const base = ast.base;
      if (base.kind === 'file') {
        const id = object(value)['id'];
        if (typeof id !== 'string' || id === '' || Object.keys(object(value)).length !== 1) return invalid('closed canonical File wire required.');
        assertSafeBlobKey(id);
        found.push(Object.freeze({ ref: id, path: Object.freeze([...path]) }));
      } else if (base.kind === 'union') {
        const union = object(value), arm = union['type'];
        if (typeof arm !== 'string' || !base.arms.includes(arm)) return invalid('declared union arm required.');
        visit(parsed(arm), union['value'], [...path, 'value'], depth + 1);
      } else if (base.kind === 'nominal') {
        const alias = owner.schema.aliases !== undefined && Object.hasOwn(owner.schema.aliases, base.path) ? owner.schema.aliases[base.path] : undefined;
        if (alias !== undefined) visit(parsed(alias.typeId), value, path, depth + 1);
        else if (Object.hasOwn(owner.schema.contracts, base.path)) {
          const contract = owner.schema.contracts[base.path]!, record = object(value);
          for (const [name, field] of Object.entries(contract.fields)) {
            if (Object.hasOwn(record, name)) visit(parsed(field.typeId), record[name], [...path, name], depth + 1);
          }
        }
        // Named enums and actual model references contain no authored File leaf.
      }
    };
    visit(parsed(profile.type), saved, [], 0);
    return deepFreeze(found);
  } catch (error) { if (error instanceof StateError) throw error; return invalid('stored value violates its owning File census profile.'); }
}
