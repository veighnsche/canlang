/** Private finite TextMessage selection recipes; these grant no row or File authority. */
import type { ArtifactModel, CanonicalModelDescriptor, CanTypeId, ModelName, ProjectedRecord,
  ScenarioResultDisclosurePlan } from '@canlang/contracts';
import { encodeValue, parseTypeId, printTypeId, validateValue, type NormalizedSchema } from '@canlang/values';
import { StateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { modelFieldConstraintSchema } from '../mutation/models.js';
import { stableStringify } from './replay.js';
import { copyScenarioFileData, scenarioFileField, scenarioFileWireRefs,
  type ScenarioFileFieldProfile } from './scenario-file-assignment.js';

type Bound = {
  readonly plan: ScenarioResultDisclosurePlan;
  readonly artifactModels: ReadonlyMap<ModelName, ArtifactModel>;
  readonly canonicalModels: readonly CanonicalModelDescriptor[];
  readonly valueSchema?: NormalizedSchema | undefined;
};
export interface ScenarioQuerySelectionMetadata {
  readonly queryId: string; readonly type: CanTypeId;
  readonly fields: readonly { readonly name: string; readonly dependencyId: string }[];
}
export interface ScenarioQuerySelectionProfile {
  readonly queryId: string; readonly type: CanTypeId; readonly model: ModelName;
  readonly fields: readonly { readonly name: string; readonly dependencyId: string;
    readonly field: string; readonly type: CanTypeId; readonly fileProfile?: ScenarioFileFieldProfile }[];
}
const profiles = new WeakMap<ScenarioQuerySelectionProfile, { readonly schema: NormalizedSchema;
  readonly constraints: readonly (ReturnType<typeof modelFieldConstraintSchema>)[] }>();
const fail = (message: string): never => { throw new StateError('validation', `Scenario query selection: ${message}`); };
const same = (a: unknown, b: unknown): boolean => a === b || a !== undefined && b !== undefined && stableStringify(a) === stableStringify(b);
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return fail('closed selection recipe required.');
  return value as Record<string, unknown>;
}
function roleCases(type: string, schema: NormalizedSchema): readonly string[] {
  const parsed = parseTypeId(type);
  if (printTypeId(parsed) !== type || parsed.array || parsed.nullable || parsed.requiredArray) return fail('required singular role enum required.');
  if (parsed.base.kind === 'enum') return parsed.base.cases;
  if (parsed.base.kind !== 'nominal' || !Object.hasOwn(schema.enums, parsed.base.path) ||
      Object.hasOwn(schema.contracts, parsed.base.path) || Object.hasOwn(schema.aliases ?? {}, parsed.base.path)) return fail('owning role enum required.');
  return schema.enums[parsed.base.path]!.cases;
}

type SelectionQuery = NonNullable<Bound['plan']['queries']>[number];

/** Shared per-field selection scope (one TextMessage recipe). */
interface SelectionFieldScope {
  readonly bound: Bound;
  readonly query: SelectionQuery;
  readonly schema: NormalizedSchema;
  readonly contract: Record<string, { readonly typeId: string }>;
  readonly names: readonly string[];
  readonly consumers: ReadonlyArray<Bound['plan']['returns'][number]>;
  readonly artifact: ArtifactModel;
  readonly models: readonly CanonicalModelDescriptor[];
  readonly ids: Set<string>;
  readonly constraints: (ReturnType<typeof modelFieldConstraintSchema>)[];
}

/** Exact owning TextMessage array spelling for one selection recipe. */
function checkSelectionMessageType(value: Record<string, unknown>): string {
  const type = parseTypeId(value.type as string);
  if (printTypeId(type) !== value.type || type.base.kind !== 'nominal' || !type.array || type.nullable || type.requiredArray) return fail('exact owning TextMessage array required.');
  return type.base.path;
}

/** Complete owning TextMessage schema: role enum, text content, file attachments. */
function checkSelectionContract(
  schema: NormalizedSchema,
  name: string,
): Record<string, { readonly typeId: string }> {
  const contract = schema.contracts[name]!.fields as Record<string, { readonly typeId: string }>;
  if (!same(Object.keys(contract).sort(), ['attachments', 'content', 'role']) ||
      !same(roleCases(contract.role!.typeId, schema), ['system', 'user', 'assistant']) ||
      contract.content!.typeId !== 'text' || contract.attachments!.typeId !== 'file[]') return fail('complete owning TextMessage schema required.');
  return contract;
}

/** Checked query, owning TextMessage contract, model and return consumers. */
function checkSelectionHead(
  bound: Bound,
  metadata: ScenarioQuerySelectionMetadata,
): { value: Record<string, unknown>; scope: SelectionFieldScope } {
  const value = closed(copyScenarioFileData(metadata), ['queryId', 'type', 'fields']);
  const query = bound.plan.queries?.find(query => query.id === value.queryId);
  const schema = bound.valueSchema;
  if (query === undefined || schema === undefined || typeof value.type !== 'string') return fail('checked query and owning schema required.');
  const name = checkSelectionMessageType(value);
  if (!['TextMessage', 'std.TextMessage'].includes(name) || !Object.hasOwn(schema.contracts, name) ||
      Object.hasOwn(schema.enums, name) || Object.hasOwn(schema.aliases ?? {}, name) ||
      bound.artifactModels.has(name as ModelName) || bound.canonicalModels.some(model => model.name === name)) return fail('exact owning TextMessage array required.');
  const contract = checkSelectionContract(schema, name);
  const names = ['role', 'content', 'attachments'];
  if (!Array.isArray(value.fields) || value.fields.length !== names.length) return fail('complete three-field mapping required.');
  const consumers = bound.plan.returns.filter(returned => returned.influences.some(influence => influence.queryId === query.id));
  const artifact = bound.artifactModels.get(query.model);
  const models = bound.canonicalModels.filter(model => model.name === query.model);
  if (consumers.length === 0 || artifact === undefined || models.length !== 1) return fail('owning query model and return consumers required.');
  return { value, scope: { bound, query, schema, contract, names, consumers, artifact, models,
    ids: new Set<string>(), constraints: [] } };
}

/** Exact query DATA with its ordinary field dependency. */
function findSelectionDependency(
  scope: SelectionFieldScope,
  field: Record<string, unknown>,
  index: number,
): Bound['plan']['returns'][number]['dependencies'][number] {
  if (field.name !== scope.names[index] || typeof field.dependencyId !== 'string' || field.dependencyId === '' || scope.ids.has(field.dependencyId)) {
    return fail('exact ordered unique field mapping required.');
  }
  scope.ids.add(field.dependencyId);
  const dependencies = scope.consumers.map(returned => returned.dependencies.find(dependency => dependency.id === field.dependencyId));
  const dependency = dependencies[0];
  if (dependency === undefined || dependencies.some(value => !same(value, dependency)) || dependency.queryId !== scope.query.id ||
      dependency.role !== 'data' || dependency.model !== scope.query.model || !same(dependency.source, scope.query.source) ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(dependency.field) ||
      !scope.query.dependencies.some(value => value.role === 'data' && value.field === dependency.field && value.type === dependency.type && same(value.source, scope.query.source))) {
    return fail('exact query DATA and ordinary field dependency required.');
  }
  if (dependency.type !== scope.contract[field.name as string]!.typeId) return fail('selected field differs from its owning message type.');
  return dependency;
}

/** Complete owning direct field declaration with agreeing markers. */
function checkSelectionDeclaration(
  scope: SelectionFieldScope,
  dependency: Bound['plan']['returns'][number]['dependencies'][number],
): { original: ArtifactModel['fields'][number]; canonical: CanonicalModelDescriptor['fields'][string] } {
  const authored = scope.artifact.fields.filter(field => field.name === dependency.field);
  const canonical = scope.models[0]!.fields[dependency.field];
  if (authored.length !== 1 || canonical === undefined || authored[0]!.valueType !== dependency.type || canonical.valueType !== dependency.type ||
      authored[0]!.default?.kind === 'derived' || canonical.default?.kind === 'derived') return fail('complete owning direct field declaration required.');
  const original = authored[0]!;
  for (const marker of ['required', 'serverOnly', 'nullable', 'array', 'trim', 'min', 'max'] as const) {
    if (Object.hasOwn(original, marker) !== Object.hasOwn(canonical, marker) || !same(original[marker], canonical[marker])) return fail('owning field markers disagree.');
  }
  return { original, canonical };
}

/** Attachments File profile versus scalar role/content ownership. */
function resolveSelectionFileOrScalar(
  scope: SelectionFieldScope,
  field: Record<string, unknown>,
  dependency: Bound['plan']['returns'][number]['dependencies'][number],
  original: ArtifactModel['fields'][number],
): ScenarioFileFieldProfile | undefined {
  if (field.name === 'attachments') {
    if (dependency.type !== 'file[]') return fail('declared attachments File array required.');
    return scenarioFileField(scope.bound, scope.query.model, dependency.field);
  }
  if (original.array !== undefined || original.nullable === true) return fail('required singular message scalar required.');
  if (field.name === 'content') {
    if (dependency.type !== 'text' || original.field.kind !== 'string') return fail('owning content text required.');
    return undefined;
  }
  if (!same(roleCases(dependency.type, scope.schema), ['system', 'user', 'assistant']) ||
      original.field.kind !== 'enum' && original.field.kind !== 'nominal' ||
      original.field.kind === 'enum' && !same(original.field.values, ['system', 'user', 'assistant']) ||
      original.field.kind === 'nominal' && (parseTypeId(dependency.type).base.kind !== 'nominal' || original.field.name !== dependency.type ||
        scope.bound.artifactModels.has(dependency.type as ModelName))) return fail('owning message role enum required.');
  return undefined;
}

/** One ordered field in mapping order: dependency, declaration, file/scalar. */
function bindOneSelectionField(
  scope: SelectionFieldScope,
  entry: unknown,
  index: number,
): { name: string; dependencyId: string; field: string; type: CanTypeId; fileProfile?: ScenarioFileFieldProfile } {
  const field = closed(entry, ['name', 'dependencyId']);
  const dependency = findSelectionDependency(scope, field, index);
  const { original, canonical } = checkSelectionDeclaration(scope, dependency);
  const fileProfile = resolveSelectionFileOrScalar(scope, field, dependency, original);
  scope.constraints.push(modelFieldConstraintSchema(canonical, scope.schema));
  return { name: field.name as string, dependencyId: dependency.id, field: dependency.field, type: dependency.type,
    ...(fileProfile === undefined ? {} : { fileProfile }) };
}

export function bindScenarioQuerySelection(bound: Bound, metadata: ScenarioQuerySelectionMetadata): ScenarioQuerySelectionProfile {
  try {
    const { value, scope } = checkSelectionHead(bound, metadata);
    const fields = (value.fields as unknown[]).map((entry, index) => bindOneSelectionField(scope, entry, index));
    if (scope.query.dependencies.filter(dependency => dependency.role === 'data').length !== fields.length) {
      return fail('complete exact selected DATA closure required.');
    }
    const profile = deepFreeze({ queryId: scope.query.id, type: value.type as CanTypeId, model: scope.query.model, fields });
    profiles.set(profile, { schema: scope.schema, constraints: scope.constraints });
    return profile;
  } catch (error) { if (error instanceof StateError) throw error; return fail('invalid owning selection recipe.'); }
}

export function scenarioQuerySelectionWire(profile: ScenarioQuerySelectionProfile, selectedProjectedRows: readonly ProjectedRecord[]): readonly unknown[] {
  const owner = profiles.get(profile) ?? fail('authentic bound selection profile required.');
  try {
    const rows = copyScenarioFileData(selectedProjectedRows);
    if (!Array.isArray(rows) || rows.length > 200) return fail('bounded selected row array required.');
    const wire = rows.map(row => {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) return fail('actual projected row required.');
      const data = (row as ProjectedRecord).data;
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return fail('projected row data required.');
      return Object.fromEntries(profile.fields.map((field, index) => {
        if (!Object.hasOwn(data, field.field)) return fail('selected field is unavailable.');
        const value = data[field.field];
        if (field.fileProfile !== undefined) scenarioFileWireRefs(field.fileProfile, value);
        const decoded = validateValue(owner.schema, field.type, value, 'create');
        if (!same(encodeValue(field.type, decoded, undefined, owner.schema), value)) return fail('canonical owning selected field required.');
        const constraint = owner.constraints[index];
        if (constraint !== undefined) validateValue(constraint.schema, constraint.type, { value }, 'create');
        return [field.name, value];
      }));
    });
    const encoded = encodeValue(profile.type, validateValue(owner.schema, profile.type, wire, 'create'), undefined, owner.schema);
    if (!same(encoded, wire)) return fail('canonical owning selection required.');
    return deepFreeze(encoded as unknown[]);
  } catch (error) { if (error instanceof StateError) throw error; return fail('invalid owning selection wire.'); }
}
