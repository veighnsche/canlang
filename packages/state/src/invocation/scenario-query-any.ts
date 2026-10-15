/** Finite stored-bool ANY correspondence. No declaration grants row authority. */
import type { ArtifactModel, CanonicalModelDescriptor, ModelName, ScenarioReceiptQueryObservation,
  ScenarioReceiptQueryPlan, ScenarioResultDisclosurePlan } from '@canlang/contracts';
import { parseTypeId, type NormalizedSchema } from '@canlang/values';
import { StateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { copyScenarioFileData } from './scenario-file-assignment.js';
import { stableStringify } from './replay.js';

export type ScenarioQueryAnyMetadata = { readonly queryId: string; readonly dependencyId: string } |
  { readonly kind: 'predicate'; readonly queryId: string; readonly dependencyIds: readonly string[] };
interface StoredBoolAnyProfile {
  readonly kind?: never;
  readonly queryId: string; readonly dependencyId: string;
  readonly model: ModelName; readonly field: string;
  readonly source: ScenarioReceiptQueryPlan['source'];
  readonly parentModel: ModelName; readonly parameter: string;
  readonly query: ScenarioReceiptQueryPlan;
}
interface PredicateAnyProfile {
  readonly kind: 'predicate'; readonly queryId: string; readonly dependencyIds: readonly string[];
  readonly model: ModelName; readonly source: ScenarioReceiptQueryPlan['source']; readonly query: ScenarioReceiptQueryPlan;
}
export type ScenarioQueryAnyProfile = StoredBoolAnyProfile | PredicateAnyProfile;
type Bound = { readonly valueSchema?: NormalizedSchema | undefined; readonly plan: ScenarioResultDisclosurePlan;
  readonly artifactModels: ReadonlyMap<ModelName, ArtifactModel>;
  readonly canonicalModels: readonly CanonicalModelDescriptor[] };
const profiles = new WeakSet<ScenarioQueryAnyProfile>();
const fail = (message: string): never => { throw new StateError('validation', `Scenario query ANY: ${message}`); };
const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) return fail('closed owning metadata required.');
  return value as Record<string, unknown>;
}

/** Root additionally checks the admitted parameter's required versioned input.
 * Compiler/Dev owns exact builtin/lambda/getter source correspondence. */
export function bindScenarioQueryAny(bound: Bound, metadata: Extract<ScenarioQueryAnyMetadata, { dependencyId: string }>): StoredBoolAnyProfile;
export function bindScenarioQueryAny(bound: Bound, metadata: Extract<ScenarioQueryAnyMetadata, { kind: 'predicate' }>): PredicateAnyProfile;
export function bindScenarioQueryAny(bound: Bound, metadata: ScenarioQueryAnyMetadata): ScenarioQueryAnyProfile;
export function bindScenarioQueryAny(bound: Bound, metadata: ScenarioQueryAnyMetadata): ScenarioQueryAnyProfile {
  try {
    const copied = copyScenarioFileData(metadata) as ScenarioQueryAnyMetadata;
    if ('kind' in copied && copied.kind === 'predicate') return bindPredicateAny(bound, copied);
    const input = closed(copied, ['queryId', 'dependencyId']);
    if (typeof input.queryId !== 'string' || !input.queryId || typeof input.dependencyId !== 'string' || !input.dependencyId) return fail('owning occurrence identities required.');
    const plan = copyScenarioFileData(bound.plan) as ScenarioResultDisclosurePlan;
    const queries = plan.queries?.filter(query => query.id === input.queryId);
    const query = queries?.[0];
    if (queries?.length !== 1 || query === undefined || query.dependencies.length !== 1 || query.order.length !== 0 ||
        query.limit !== null || query.archived !== 'exclude' || query.parent?.origin.kind !== 'admitted-reference' ||
        !same(query.source, plan.source) || !same(query.parent.source, query.source) || !query.parent.origin.parameter) return fail('exact unbounded admitted-parent domain required.');
    const control = query.dependencies[0]!;
    if (control.id !== input.dependencyId || control.role !== 'control' || control.type !== 'bool' ||
        !same(control.source, query.source) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(control.field) ||
        ['id', 'parent', 'version', 'created', 'updated', 'createdBy', 'updatedBy', 'archivedAt'].includes(control.field)) return fail('one direct stored bool CONTROL required.');
    if (!(bound.artifactModels instanceof Map) || Object.getPrototypeOf(bound.artifactModels) !== Map.prototype || Reflect.ownKeys(bound.artifactModels).length !== 0) return fail('own model inventory required.');
    const model = copyScenarioFileData(Map.prototype.get.call(bound.artifactModels, query.model)) as ArtifactModel;
    const parent = copyScenarioFileData(Map.prototype.get.call(bound.artifactModels, query.parent.model)) as ArtifactModel;
    const canonical = copyScenarioFileData(bound.canonicalModels) as readonly CanonicalModelDescriptor[];
    const owners = canonical.filter(value => value.name === query.model), parents = canonical.filter(value => value.name === query.parent!.model);
    const fields = model.fields.filter(field => field.name === control.field), field = fields[0], checked = owners[0]?.fields[control.field];
    if (model.name !== query.model || model.parent !== query.parent.model || parent.name !== query.parent.model ||
        owners.length !== 1 || parents.length !== 1 || fields.length !== 1 || field === undefined || checked === undefined ||
        field.field.kind !== 'boolean' || field.valueType !== 'bool' || checked.valueType !== 'bool' ||
        typeof field.required !== 'boolean' || typeof checked.required !== 'boolean' || field.nullable === true || checked.nullable === true ||
        field.array !== undefined || checked.array !== undefined || field.machine !== undefined || checked.machine !== undefined ||
        checked.delivery !== undefined || field.default?.kind === 'derived' || checked.default?.kind === 'derived') return fail('exact owning nonnullable stored boolean declaration required.');
    for (const marker of ['required', 'serverOnly', 'nullable', 'array', 'trim', 'min', 'max'] as const) {
      if (Object.hasOwn(field, marker) !== Object.hasOwn(checked, marker) || Object.hasOwn(field, marker) && !same(field[marker], checked[marker])) return fail('owning field markers disagree.');
    }
    const consumers = plan.returns.filter(returned => returned.influences.some(influence => influence.queryId === query.id));
    if (consumers.length === 0 || plan.returns.some(returned => returned.projection?.queryId === query.id) ||
        consumers.some(returned => returned.dependencies.some(dependency => dependency.queryId === query.id && dependency.role === 'data'))) return fail('actual CONTROL query influence without projection required.');
    const profile = deepFreeze({ queryId: query.id, dependencyId: control.id, model: query.model, field: control.field,
      source: query.source, parentModel: query.parent.model, parameter: query.parent.origin.parameter, query });
    profiles.add(profile); return profile;
  } catch (error) { if (error instanceof StateError) throw error; return fail('invalid owning plan.'); }
}

/** The installed producer, not this transport profile, authenticates the
 * executable source/capture. The finite profile is a same-source root query;
 * imported helper chains need their own checked producer association. */
function bindPredicateAny(bound: Bound, metadata: Extract<ScenarioQueryAnyMetadata, { kind: 'predicate' }>): PredicateAnyProfile {
  const input = closed(copyScenarioFileData(metadata), ['kind', 'queryId', 'dependencyIds']);
  if (input.kind !== 'predicate' || typeof input.queryId !== 'string' || !input.queryId ||
      !Array.isArray(input.dependencyIds) || input.dependencyIds.length === 0) return fail('exact predicate CONTROL census required.');
  const query = bound.plan.queries?.find(query => query.id === input.queryId);
  if (query === undefined || query.parent !== undefined || query.order.length !== 0 || query.limit !== null ||
      query.archived !== 'exclude' || !same(query.source, bound.plan.source) ||
      !same(input.dependencyIds, query.dependencies.map(dependency => dependency.id))) return fail('exact same-source root predicate query required.');
  const model = bound.artifactModels.get(query.model), canonical = bound.canonicalModels.find(model => model.name === query.model);
  if (model === undefined || canonical === undefined || model.parent !== undefined) return fail('declared root query model required.');
  for (const dependency of query.dependencies) {
    const fields = model.fields.filter(field => field.name === dependency.field), field = fields[0];
    const checked = canonical.fields[dependency.field];
    if (dependency.role !== 'control' || !same(dependency.source, query.source) || fields.length !== 1 ||
        field === undefined || checked === undefined || field.valueType !== dependency.type || checked.valueType !== dependency.type ||
        field.default?.kind === 'derived' || checked.default?.kind === 'derived') return fail('exact stored CONTROL field declaration required.');
    const type = parseTypeId(dependency.type);
    const modelReference = type.base.kind === 'nominal' && bound.artifactModels.has(type.base.path as ModelName) &&
      bound.valueSchema !== undefined && !Object.hasOwn(bound.valueSchema.contracts, type.base.path) &&
      !Object.hasOwn(bound.valueSchema.enums, type.base.path) && !Object.hasOwn(bound.valueSchema.aliases ?? {}, type.base.path);
    if (type.nullable || type.requiredArray || !(dependency.type === 'bool' || dependency.type === 'user' || modelReference)) return fail('predicate requires bool, User or declared Model reference CONTROL fields.');
    for (const marker of ['required', 'serverOnly', 'nullable', 'array', 'trim', 'min', 'max'] as const) {
      if (Object.hasOwn(field, marker) !== Object.hasOwn(checked, marker) || Object.hasOwn(field, marker) && !same(field[marker], checked[marker])) return fail('owning predicate field markers disagree.');
    }
  }
  const consumers = bound.plan.returns.filter(returned => returned.influences.some(influence => influence.queryId === query.id));
  if (consumers.length === 0 || bound.plan.returns.some(returned => returned.projection?.queryId === query.id) ||
      consumers.some(returned => returned.dependencies.some(dependency => dependency.queryId === query.id && dependency.role === 'data'))) return fail('predicate requires actual CONTROL influence without projection.');
  const profile = deepFreeze({ kind: 'predicate' as const, queryId: query.id, dependencyIds: [...metadata.dependencyIds],
    model: query.model, source: query.source, query: copyScenarioFileData(query) as ScenarioReceiptQueryPlan });
  profiles.add(profile); return profile;
}

/** Validate the retained lazy prefix; suffix rows were not predicate reads.
 * General row/lifetime/parent structural checks remain with receipt parsing. */
export function checkSavedScenarioQueryAny(profile: ScenarioQueryAnyProfile, observation: ScenarioReceiptQueryObservation): boolean {
  if (!profiles.has(profile)) return fail('authentic private ANY profile required.');
  try {
    const saved = copyScenarioFileData(observation) as ScenarioReceiptQueryObservation;
    if (saved.queryId !== profile.queryId || !Number.isSafeInteger(saved.revision) || saved.revision < 0 ||
        (profile.kind === 'predicate' ? saved.parent !== undefined : saved.parent?.model !== profile.parentModel) || !Array.isArray(saved.candidates) || !Array.isArray(saved.selectedIndices) ||
        saved.selectedIndices.length > 1) return fail('exact saved ANY domain required.');
    const identities = new Set<string>(); let firstTrue = -1;
    for (let index = 0; index < saved.candidates.length; index++) {
      const candidate = saved.candidates[index]!;
      if (typeof candidate.row.id !== 'string' || identities.has(candidate.row.id) || !Number.isSafeInteger(candidate.row.created) ||
          candidate.row.archivedAt !== null || (profile.kind === 'predicate' ? candidate.row.parent != null :
          candidate.row.parent?.model !== profile.parentModel || candidate.row.parent.id !== saved.parent!.row.id) || typeof candidate.matched !== 'boolean' || !Array.isArray(candidate.dependencies)) return fail('complete genuine contained candidate census required.');
      identities.add(candidate.row.id);
      const previous = saved.candidates[index - 1];
      if (previous !== undefined && (previous.row.created > candidate.row.created ||
          previous.row.created === candidate.row.created && previous.row.id >= candidate.row.id)) return fail('default created/id candidate order required.');
      if (firstTrue >= 0) {
        if (candidate.matched || candidate.dependencies.length !== 0) return fail('ANY suffix must be unvisited.');
        continue;
      }
      if (profile.kind === 'predicate') {
        if (candidate.dependencies.length === 0 || candidate.dependencies[0] !== profile.dependencyIds[0] ||
            new Set(candidate.dependencies).size !== candidate.dependencies.length ||
            candidate.dependencies.some((id: string) => !profile.dependencyIds.includes(id))) return fail('visited predicate requires its declared first CONTROL and executed closure.');
        for (const id of candidate.dependencies) {
          const dependency = profile.query.dependencies.find(dependency => dependency.id === id)!;
          if (!Object.hasOwn(candidate.record.data, dependency.field) ||
              !same(candidate.record.data[dependency.field], candidate.row.data[dependency.field])) return fail('predicate CONTROL must retain its exact projected field.');
        }
      } else if (candidate.dependencies.length !== 1 || candidate.dependencies[0] !== profile.dependencyId ||
          typeof candidate.record.data[profile.field] !== 'boolean' || candidate.record.data[profile.field] !== candidate.row.data[profile.field] ||
          candidate.matched !== candidate.record.data[profile.field]) return fail('every visited bool verdict requires its exact CONTROL marker.');
      if (candidate.matched) firstTrue = index;
    }
    if (!same(saved.selectedIndices, firstTrue < 0 ? [] : [firstTrue])) return fail('ANY selects exactly its first true verdict.');
    return firstTrue >= 0;
  } catch (error) { if (error instanceof StateError) throw error; return fail('invalid saved lazy prefix.'); }
}
