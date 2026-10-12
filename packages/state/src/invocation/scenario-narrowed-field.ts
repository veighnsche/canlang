/** Declaration correspondence only. These bindings grant no read authority. */
import type { ArtifactModel, CanonicalModelDescriptor, CanTypeId, ModelName, ScenarioResultDisclosurePlan } from '@canlang/contracts';
import { parseTypeId, printTypeId } from '@canlang/values';
import { StateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { copyScenarioFileData } from './scenario-file-assignment.js';
import { stableStringify } from './replay.js';

type Dependency = ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number];
export interface ScenarioNarrowedFieldBinding {
  readonly data: Dependency;
  readonly control: Dependency;
  readonly declarationType: CanTypeId;
  readonly kind: 'reference' | 'text';
  readonly target?: ModelName;
}
type Bound = { readonly plan: ScenarioResultDisclosurePlan;
  readonly artifactModels: ReadonlyMap<ModelName, ArtifactModel>;
  readonly canonicalModels: readonly CanonicalModelDescriptor[] };
const authentic = new WeakSet<ScenarioNarrowedFieldBinding>();
const fail = (message: string): never => { throw new StateError('validation', `Scenario narrowed field: ${message}`); };
const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

/** Required DATA pairs with its unique nullable CONTROL. A required genuine
 * model-reference CONTROL authenticates its own nullable declaration narrowing. */
export function bindScenarioNarrowedFields(bound: Bound): ReadonlyMap<string, ScenarioNarrowedFieldBinding> {
  try {
    const plan = copyScenarioFileData(bound.plan) as ScenarioResultDisclosurePlan;
    const canonical = copyScenarioFileData(bound.canonicalModels) as readonly CanonicalModelDescriptor[];
    if (!(bound.artifactModels instanceof Map) || Object.getPrototypeOf(bound.artifactModels) !== Map.prototype || Reflect.ownKeys(bound.artifactModels).length !== 0) return fail('own model inventory map required.');
    const artifacts = new Map<ModelName, ArtifactModel>();
    for (const [name, value] of Map.prototype.entries.call(bound.artifactModels) as Iterable<[ModelName, ArtifactModel]>) artifacts.set(name, copyScenarioFileData(value) as ArtifactModel);
    const result = new Map<string, ScenarioNarrowedFieldBinding>();
    for (const returned of plan.returns) for (const dependency of returned.dependencies) {
      if (dependency.role !== 'data' && dependency.role !== 'control' ||
          dependency.role === 'data' && (dependency.field === 'id' || dependency.field === 'parent')) continue;
      const artifact = artifacts.get(dependency.model);
      const declarations = canonical.filter(model => model.name === dependency.model);
      const fields = artifact?.fields.filter(field => field.name === dependency.field);
      const field = fields?.[0], checked = declarations[0]?.fields[dependency.field];
      if (checked?.valueType === dependency.type || field?.valueType === dependency.type ||
          field?.valueType === undefined && checked?.valueType === undefined) continue;
      if (dependency.queryId !== undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(dependency.field) ||
          ['id', 'parent', 'version', 'created', 'updated', 'createdBy', 'updatedBy', 'archivedAt'].includes(dependency.field) ||
          artifact?.name !== dependency.model || declarations.length !== 1 || fields?.length !== 1 || checked === undefined || field === undefined) {
        return fail('exact owning direct field required.');
      }
      const owning = copyScenarioFileData(field) as ArtifactModel['fields'][number];
      if (owning.valueType === undefined || owning.valueType !== checked.valueType || owning.nullable !== true || checked.nullable !== true ||
          owning.array !== undefined || checked.array !== undefined || owning.machine !== undefined || checked.machine !== undefined ||
          checked.delivery !== undefined || owning.default?.kind === 'derived' || checked.default?.kind === 'derived') return fail('exact nullable stored declaration required.');
      for (const marker of ['required', 'serverOnly', 'nullable', 'array', 'trim', 'min', 'max'] as const) {
        if (Object.hasOwn(owning, marker) !== Object.hasOwn(checked, marker) ||
            Object.hasOwn(owning, marker) && !same(owning[marker], checked[marker])) return fail('owning declaration markers disagree.');
      }
      const declared = parseTypeId(owning.valueType), narrowed = parseTypeId(dependency.type);
      if (printTypeId(declared) !== owning.valueType || printTypeId(narrowed) !== dependency.type || !declared.nullable ||
          declared.array || declared.requiredArray || narrowed.nullable || narrowed.array || narrowed.requiredArray ||
          owning.valueType !== `${dependency.type}?`) return fail('required singular same-base narrowing required.');
      let kind: ScenarioNarrowedFieldBinding['kind'], target: ModelName | undefined;
      if (dependency.type === 'text' && owning.field.kind === 'string') kind = 'text';
      else if (narrowed.base.kind === 'nominal' && owning.field.kind === 'ref' && owning.field.model === narrowed.base.path) {
        target = narrowed.base.path as ModelName;
        if (artifacts.get(target)?.name !== target || canonical.filter(model => model.name === target).length !== 1) return fail('genuine same-load target model required.');
        kind = 'reference';
      } else return fail('only nullable text and genuine model references may narrow.');
      let control: Dependency;
      if (dependency.role === 'control') {
        if (kind !== 'reference') return fail('only genuine model-reference CONTROL may narrow.');
        control = dependency;
      } else {
        const controls = returned.dependencies.filter(control => control.role === 'control' && control.queryId === undefined &&
          control.model === dependency.model && control.field === dependency.field && control.type === owning.valueType && same(control.source, dependency.source));
        if (controls.length !== 1 || controls[0]!.id === dependency.id) return fail('unique exact nullable CONTROL counterpart required.');
        control = controls[0]!;
      }
      const binding = deepFreeze({ data: dependency, control, declarationType: owning.valueType, kind,
        ...(target === undefined ? {} : { target }) });
      const previous = result.get(dependency.id);
      if (previous !== undefined && !same(previous, binding)) return fail('narrowed occurrence has inconsistent return correspondence.');
      if (previous === undefined) { authentic.add(binding); result.set(dependency.id, binding); }
    }
    return result;
  } catch (error) { if (error instanceof StateError) throw error; return fail('invalid owning declaration data.'); }
}

/** A copied binding cannot supply runtime correspondence. */
export function scenarioNarrowedFieldControl(binding: ScenarioNarrowedFieldBinding): Dependency {
  if (!authentic.has(binding)) return fail('authentic private binding required.');
  return binding.control;
}
