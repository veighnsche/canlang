/** Declaration correspondence only. These bindings grant no read authority. */
import type { ArtifactModel, CanonicalFieldDef, CanonicalModelDescriptor, CanTypeId, ModelName, ScenarioResultDisclosurePlan } from '@canlang/contracts';
import { parseTypeId, printTypeId } from '@canlang/values';
import { StateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { copyScenarioFileData } from './scenario-file-assignment.js';
import { stableStringify } from './replay.js';

type Dependency = ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number];
export interface ScenarioNarrowedFieldBinding {
  readonly data: Dependency;
  readonly control: Dependency;
  readonly controls: readonly Dependency[];
  readonly declarationType: CanTypeId;
  readonly kind: 'reference' | 'text';
  readonly target?: ModelName;
}
type Bound = { readonly plans: readonly ScenarioResultDisclosurePlan[];
  readonly artifactModels: ReadonlyMap<ModelName, ArtifactModel>;
  readonly canonicalModels: readonly CanonicalModelDescriptor[] };
const authentic = new WeakSet<ScenarioNarrowedFieldBinding>();
const fail = (message: string): never => { throw new StateError('validation', `Scenario narrowed field: ${message}`); };
const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

/** Reference DATA retains every common required CONTROL, falling back to the
 * unique nullable CONTROL used by legacy reference and text DATA. A required
 * reference CONTROL authenticates its own nullable declaration narrowing. */
/** Shared per-dependency narrowing scope (one disclosure plan). */
interface NarrowedBindScope {
  readonly plans: readonly ScenarioResultDisclosurePlan[];
  readonly artifacts: ReadonlyMap<ModelName, ArtifactModel>;
  readonly canonical: readonly CanonicalModelDescriptor[];
  readonly result: Map<string, ScenarioNarrowedFieldBinding>;
}

type NarrowedReturn = ScenarioResultDisclosurePlan['returns'][number];
type NarrowedOwning = ArtifactModel['fields'][number];

/** Candidate owning declaration; null skips already-corresponding dependencies. */
function findNarrowedCandidates(
  scope: NarrowedBindScope,
  dependency: Dependency,
): { artifact: ArtifactModel | undefined; declarations: CanonicalModelDescriptor[];
  fields: NarrowedOwning[] | undefined; field: NarrowedOwning | undefined; checked: CanonicalFieldDef | undefined } | null {
  if (dependency.role !== 'data' && dependency.role !== 'control' ||
      dependency.role === 'data' && (dependency.field === 'id' || dependency.field === 'parent')) return null;
  const artifact = scope.artifacts.get(dependency.model);
  const declarations = scope.canonical.filter(model => model.name === dependency.model);
  const fields = artifact?.fields.filter(field => field.name === dependency.field) as NarrowedOwning[] | undefined;
  const field = fields?.[0], checked = declarations[0]?.fields[dependency.field];
  if (checked?.valueType === dependency.type || field?.valueType === dependency.type ||
      field?.valueType === undefined && checked?.valueType === undefined) return null;
  return { artifact, declarations, fields, field, checked };
}

/** Exact owning direct field identity (names, counts, defined pair). */
function checkNarrowedExactField(
  dependency: Dependency,
  artifact: ArtifactModel | undefined,
  declarations: readonly CanonicalModelDescriptor[],
  fields: readonly NarrowedOwning[] | undefined,
  field: NarrowedOwning | undefined,
  checked: CanonicalFieldDef | undefined,
): void {
  if (dependency.queryId !== undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(dependency.field) ||
      ['id', 'parent', 'version', 'created', 'updated', 'createdBy', 'updatedBy', 'archivedAt'].includes(dependency.field) ||
      artifact?.name !== dependency.model || declarations.length !== 1 || fields?.length !== 1 || checked === undefined || field === undefined) {
    return fail('exact owning direct field required.');
  }
}

/** Exact nullable stored declaration shape (copied owning field). */
function checkNarrowedOwningShape(field: NarrowedOwning, checked: CanonicalFieldDef): NarrowedOwning {
  const owning = copyScenarioFileData(field) as NarrowedOwning;
  if (owning.valueType === undefined || owning.valueType !== checked.valueType || owning.nullable !== true || checked.nullable !== true ||
      owning.array !== undefined || checked.array !== undefined || owning.machine !== undefined || checked.machine !== undefined ||
      checked.delivery !== undefined || owning.default?.kind === 'derived' || checked.default?.kind === 'derived') return fail('exact nullable stored declaration required.');
  return owning;
}

/** Owning declaration lookup; null skips already-corresponding dependencies. */
function findNarrowedDeclaration(
  scope: NarrowedBindScope,
  dependency: Dependency,
): { owning: NarrowedOwning; checked: CanonicalFieldDef } | null {
  const found = findNarrowedCandidates(scope, dependency);
  if (found === null) return null;
  checkNarrowedExactField(dependency, found.artifact, found.declarations, found.fields, found.field, found.checked);
  const owning = checkNarrowedOwningShape(found.field as NarrowedOwning, found.checked as CanonicalFieldDef);
  return { owning, checked: found.checked as CanonicalFieldDef };
}

/** Marker agreement plus required singular same-base narrowing proof. */
function checkNarrowedNarrowing(owning: NarrowedOwning, checked: CanonicalFieldDef, dependency: Dependency): void {
  for (const marker of ['required', 'serverOnly', 'nullable', 'array', 'trim', 'min', 'max'] as const) {
    if (Object.hasOwn(owning, marker) !== Object.hasOwn(checked, marker) ||
        Object.hasOwn(owning, marker) && !same(owning[marker], checked[marker])) return fail('owning declaration markers disagree.');
  }
  const declared = parseTypeId(owning.valueType as string), narrowed = parseTypeId(dependency.type);
  if (printTypeId(declared) !== owning.valueType || printTypeId(narrowed) !== dependency.type || !declared.nullable ||
      declared.array || declared.requiredArray || narrowed.nullable || narrowed.array || narrowed.requiredArray ||
      owning.valueType !== `${dependency.type}?`) return fail('required singular same-base narrowing required.');
}

/** Text versus genuine same-load model-reference narrowing. */
function resolveNarrowedKind(
  scope: NarrowedBindScope,
  dependency: Dependency,
  owning: NarrowedOwning,
): { kind: ScenarioNarrowedFieldBinding['kind']; target: ModelName | undefined } {
  const narrowed = parseTypeId(dependency.type);
  if (dependency.type === 'text' && owning.field.kind === 'string') return { kind: 'text', target: undefined };
  if (narrowed.base.kind === 'nominal' && owning.field.kind === 'ref' && owning.field.model === narrowed.base.path) {
    const target = narrowed.base.path as ModelName;
    if (scope.artifacts.get(target)?.name !== target || scope.canonical.filter(model => model.name === target).length !== 1) {
      return fail('genuine same-load target model required.');
    }
    return { kind: 'reference', target };
  }
  return fail('only nullable text and genuine model references may narrow.');
}

/** CONTROL correspondence for one DATA (or self for CONTROL) dependency. */
function resolveNarrowedControls(
  scope: NarrowedBindScope,
  returned: NarrowedReturn,
  dependency: Dependency,
  kind: ScenarioNarrowedFieldBinding['kind'],
  owning: NarrowedOwning,
): Dependency[] {
  if (dependency.role === 'control') {
    if (kind !== 'reference') return fail('only genuine model-reference CONTROL may narrow.');
    return [dependency];
  }
  let controls: Dependency[] = [];
  if (kind === 'reference') {
    const uses = scope.plans.flatMap(plan => plan.returns.filter(value => value.dependencies.some(value => value.id === dependency.id)));
    for (const use of uses) {
      const occurrences = use.dependencies.filter(value => value.id === dependency.id);
      if (occurrences.length !== 1 || !same(occurrences[0], dependency)) return fail('DATA occurrence has inconsistent return correspondence.');
    }
    const required = (value: NarrowedReturn) => value.dependencies.filter(control => control.role === 'control' && control.queryId === undefined &&
      control.model === dependency.model && control.field === dependency.field && control.type === dependency.type && same(control.source, dependency.source));
    controls = required(uses[0]!).filter(control => uses.every(use => {
      const matches = use.dependencies.filter(value => value.id === control.id);
      return matches.length === 1 && same(matches[0], control);
    })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (controls.some(control => control.id === dependency.id) || new Set(controls.map(control => control.id)).size !== controls.length) {
      return fail('distinct required CONTROL occurrences required.');
    }
  }
  if (controls.length === 0) {
    controls = returned.dependencies.filter(control => control.role === 'control' && control.queryId === undefined &&
      control.model === dependency.model && control.field === dependency.field && control.type === owning.valueType && same(control.source, dependency.source));
    if (controls.length !== 1 || controls[0]!.id === dependency.id) return fail('unique exact nullable CONTROL counterpart required.');
  }
  return controls;
}

/** One dependency in return order: declare, narrow, bind controls. */
function bindOneNarrowedDependency(scope: NarrowedBindScope, returned: NarrowedReturn, dependency: Dependency): void {
  const found = findNarrowedDeclaration(scope, dependency);
  if (found === null) return;
  checkNarrowedNarrowing(found.owning, found.checked, dependency);
  const { kind, target } = resolveNarrowedKind(scope, dependency, found.owning);
  const controls = resolveNarrowedControls(scope, returned, dependency, kind, found.owning);
  const binding = deepFreeze({ data: dependency, control: controls[0]!, controls, declarationType: found.owning.valueType as CanTypeId, kind,
    ...(target === undefined ? {} : { target }) });
  const previous = scope.result.get(dependency.id);
  if (previous !== undefined && !same(previous, binding)) return fail('narrowed occurrence has inconsistent return correspondence.');
  if (previous === undefined) { authentic.add(binding); scope.result.set(dependency.id, binding); }
}

export function bindScenarioNarrowedFields(bound: Bound): ReadonlyMap<string, ScenarioNarrowedFieldBinding> {
  try {
    // One scope across the ordered copy set: every copy stays within its own
    // installed-plan budget, so per-copy detachment never exceeds the finite
    // copier while cross-copy correspondence still resolves in one census.
    const plans = bound.plans.map(raw => copyScenarioFileData(raw) as ScenarioResultDisclosurePlan);
    const canonical = copyScenarioFileData(bound.canonicalModels) as readonly CanonicalModelDescriptor[];
    if (!(bound.artifactModels instanceof Map) || Object.getPrototypeOf(bound.artifactModels) !== Map.prototype || Reflect.ownKeys(bound.artifactModels).length !== 0) return fail('own model inventory map required.');
    const artifacts = new Map<ModelName, ArtifactModel>();
    for (const [name, value] of Map.prototype.entries.call(bound.artifactModels) as Iterable<[ModelName, ArtifactModel]>) artifacts.set(name, copyScenarioFileData(value) as ArtifactModel);
    const result = new Map<string, ScenarioNarrowedFieldBinding>();
    const scope = { plans, artifacts, canonical, result };
    for (const plan of plans) for (const returned of plan.returns) for (const dependency of returned.dependencies) {
      bindOneNarrowedDependency(scope, returned, dependency);
    }
    return result;
  } catch (error) { if (error instanceof StateError) throw error; return fail('invalid owning declaration data.'); }
}

/** A copied binding cannot supply runtime correspondence. */
export function scenarioNarrowedFieldControl(binding: ScenarioNarrowedFieldBinding): Dependency {
  if (!authentic.has(binding)) return fail('authentic private binding required.');
  if (binding.controls.length !== 1) return fail('plural CONTROL correspondence required.');
  return binding.control;
}

export function scenarioNarrowedFieldControls(binding: ScenarioNarrowedFieldBinding): readonly Dependency[] {
  if (!authentic.has(binding)) return fail('authentic private binding required.');
  return binding.controls;
}
