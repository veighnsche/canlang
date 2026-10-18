/** Finite stored-bool ANY correspondence. No declaration grants row authority. */
import type { ArtifactModel, CanonicalModelDescriptor, ModelName, ScenarioReceiptQueryObservation,
  ScenarioReceiptQueryPlan, ScenarioResultDisclosurePlan } from '@canlang/contracts';
import { parseTypeId, type NormalizedSchema } from '@canlang/values';
import { StateError } from '../errors.js';
import { deepFreeze } from '../internal/own-data.js';
import { copyScenarioFileData } from './scenario-file-assignment.js';
import { stableStringify } from './replay.js';
import { checkScenarioReceiptMembershipSites, type ScenarioReceiptMembershipSite } from './scenario-membership-plan.js';

export interface ScenarioQueryAnyDirectCall {
  readonly owner: string; readonly stage: string;
  readonly siteIndex: number; readonly callIndex: number;
  readonly source: ScenarioReceiptQueryPlan['source'];
  readonly node: { readonly start: number; readonly end: number };
  readonly target: { readonly kind: string; readonly id: string; readonly overload: number };
  readonly arguments: readonly { readonly type: string;
    readonly node: { readonly start: number; readonly end: number } }[];
  readonly slots: readonly number[]; readonly chain: readonly unknown[];
}
export type ScenarioQueryAnyMetadata = { readonly queryId: string; readonly dependencyId: string } |
  { readonly kind: 'predicate'; readonly queryId: string; readonly dependencyIds: readonly string[];
    readonly sourceCall?: { readonly siteIndex: number; readonly callIndex: number };
    readonly direct?: boolean; readonly call?: ScenarioQueryAnyDirectCall };
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
  readonly parentModel?: ModelName; readonly parameter?: string;
}
export type ScenarioQueryAnyProfile = StoredBoolAnyProfile | PredicateAnyProfile;
type Bound = { readonly valueSchema?: NormalizedSchema | undefined; readonly plan: ScenarioResultDisclosurePlan;
  readonly artifactModels: ReadonlyMap<ModelName, ArtifactModel>;
  readonly canonicalModels: readonly CanonicalModelDescriptor[] };
/** Data-only validation input. Actual query installation obtains these facts
 * only from State's already-bound private owner membership producer. */
export interface ScenarioPredicateAnySources {
  readonly owner: string; readonly source: ScenarioReceiptQueryPlan['source'];
  readonly sites: readonly ScenarioReceiptMembershipSite[];
}
const profiles = new WeakSet<ScenarioQueryAnyProfile>();
const fail = (message: string): never => { throw new StateError('validation', `Scenario query ANY: ${message}`); };
const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key))) return fail('closed owning metadata required.');
  return value as Record<string, unknown>;
}

type QueryAnyQuery = NonNullable<ScenarioResultDisclosurePlan['queries']>[number];
type QueryAnyControl = QueryAnyQuery['dependencies'][number];
/** Stored-bool queries carry their exact admitted-reference parent edge. */
type AdmittedParentQuery = QueryAnyQuery & { readonly parent: NonNullable<QueryAnyQuery['parent']> & {
  readonly origin: Extract<NonNullable<QueryAnyQuery['parent']>['origin'], { readonly kind: 'admitted-reference' }> } };

/** Exact unbounded admitted-parent domain with its one stored bool CONTROL. */
function checkQueryAnyDomain(
  plan: ScenarioResultDisclosurePlan,
  input: Record<string, unknown>,
): { query: AdmittedParentQuery; control: QueryAnyControl } {
  const queries = plan.queries?.filter(query => query.id === input.queryId);
  const query = queries?.[0];
  if (queries?.length !== 1 || query === undefined || query.dependencies.length !== 1 || query.order.length !== 0 ||
      query.limit !== null || query.archived !== 'exclude' || query.parent?.origin.kind !== 'admitted-reference' ||
      !same(query.source, plan.source) || !same(query.parent.source, query.source) || !query.parent.origin.parameter) return fail('exact unbounded admitted-parent domain required.');
  const control = query.dependencies[0]!;
  checkQueryAnyControl(query as AdmittedParentQuery, control, input);
  return { query: query as AdmittedParentQuery, control };
}

/** One direct stored bool CONTROL against its owning occurrence identity. */
function checkQueryAnyControl(
  query: AdmittedParentQuery,
  control: QueryAnyControl,
  input: Record<string, unknown>,
): void {
  if (control.id !== input.dependencyId || control.role !== 'control' || control.type !== 'bool' ||
      !same(control.source, query.source) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(control.field) ||
      ['id', 'parent', 'version', 'created', 'updated', 'createdBy', 'updatedBy', 'archivedAt'].includes(control.field)) return fail('one direct stored bool CONTROL required.');
}

/** Exact owning nonnullable stored boolean declaration with agreeing markers. */
function checkQueryAnyBoolDeclaration(bound: Bound, query: AdmittedParentQuery, control: QueryAnyControl): void {
  if (!(bound.artifactModels instanceof Map) || Object.getPrototypeOf(bound.artifactModels) !== Map.prototype || Reflect.ownKeys(bound.artifactModels).length !== 0) return fail('own model inventory required.');
  const model = copyScenarioFileData(Map.prototype.get.call(bound.artifactModels, query.model)) as ArtifactModel;
  const parent = copyScenarioFileData(Map.prototype.get.call(bound.artifactModels, query.parent.model)) as ArtifactModel;
  const canonical = copyScenarioFileData(bound.canonicalModels) as readonly CanonicalModelDescriptor[];
  const found = findQueryAnyBoolField(query, control, model, parent, canonical);
  checkQueryAnyBoolKind(found.field, found.checked);
  for (const marker of ['required', 'serverOnly', 'nullable', 'array', 'trim', 'min', 'max'] as const) {
    if (Object.hasOwn(found.field, marker) !== Object.hasOwn(found.checked, marker) || Object.hasOwn(found.field, marker) && !same(found.field[marker], found.checked[marker])) return fail('owning field markers disagree.');
  }
}

/** Owning boolean field pair: detached artifact field and canonical check. */
function findQueryAnyBoolField(
  query: AdmittedParentQuery,
  control: QueryAnyControl,
  model: ArtifactModel,
  parent: ArtifactModel,
  canonical: readonly CanonicalModelDescriptor[],
): { field: ArtifactModel['fields'][number]; checked: CanonicalModelDescriptor['fields'][string] } {
  const owners = canonical.filter(value => value.name === query.model), parents = canonical.filter(value => value.name === query.parent!.model);
  const fields = model.fields.filter(field => field.name === control.field), field = fields[0], checked = owners[0]?.fields[control.field];
  if (model.name !== query.model || model.parent !== query.parent.model || parent.name !== query.parent.model ||
      owners.length !== 1 || parents.length !== 1 || fields.length !== 1 || field === undefined || checked === undefined) {
    return fail('exact owning nonnullable stored boolean declaration required.');
  }
  return { field, checked };
}

/** Nonnullable stored boolean kind with static required markers. */
function checkQueryAnyBoolKind(
  field: ArtifactModel['fields'][number],
  checked: CanonicalModelDescriptor['fields'][string],
): void {
  if (field.field.kind !== 'boolean' || field.valueType !== 'bool' || checked.valueType !== 'bool' ||
      typeof field.required !== 'boolean' || typeof checked.required !== 'boolean' || field.nullable === true || checked.nullable === true ||
      field.array !== undefined || checked.array !== undefined || field.machine !== undefined || checked.machine !== undefined ||
      checked.delivery !== undefined || field.default?.kind === 'derived' || checked.default?.kind === 'derived') return fail('exact owning nonnullable stored boolean declaration required.');
}

/** Root additionally checks the admitted parameter's required versioned input.
 * Compiler/Dev owns exact builtin/lambda/getter source correspondence. */
export function bindScenarioQueryAny(bound: Bound, metadata: Extract<ScenarioQueryAnyMetadata, { dependencyId: string }>, sources?: ScenarioPredicateAnySources): StoredBoolAnyProfile;
export function bindScenarioQueryAny(bound: Bound, metadata: Extract<ScenarioQueryAnyMetadata, { kind: 'predicate' }>, sources?: ScenarioPredicateAnySources): PredicateAnyProfile;
export function bindScenarioQueryAny(bound: Bound, metadata: ScenarioQueryAnyMetadata, sources?: ScenarioPredicateAnySources): ScenarioQueryAnyProfile;
export function bindScenarioQueryAny(bound: Bound, metadata: ScenarioQueryAnyMetadata, sources?: ScenarioPredicateAnySources): ScenarioQueryAnyProfile {
  try {
    const copied = copyScenarioFileData(metadata) as ScenarioQueryAnyMetadata;
    if ('kind' in copied && copied.kind === 'predicate') return bindPredicateAny(bound, copied, sources);
    const input = closed(copied, ['queryId', 'dependencyId']);
    if (typeof input.queryId !== 'string' || !input.queryId || typeof input.dependencyId !== 'string' || !input.dependencyId) return fail('owning occurrence identities required.');
    const plan = copyScenarioFileData(bound.plan) as ScenarioResultDisclosurePlan;
    const { query, control } = checkQueryAnyDomain(plan, input);
    checkQueryAnyBoolDeclaration(bound, query, control);
    const consumers = plan.returns.filter(returned => returned.influences.some(influence => influence.queryId === query.id));
    if (consumers.length === 0 || plan.returns.some(returned => returned.projection?.queryId === query.id) ||
        consumers.some(returned => returned.dependencies.some(dependency => dependency.queryId === query.id && dependency.role === 'data'))) return fail('actual CONTROL query influence without projection required.');
    const profile = deepFreeze({ queryId: query.id, dependencyId: control.id, model: query.model, field: control.field,
      source: query.source, parentModel: query.parent.model, parameter: query.parent.origin.parameter, query });
    profiles.add(profile); return profile;
  } catch (error) { if (error instanceof StateError) throw error; return fail('invalid owning plan.'); }
}

/** The installed producer, not this transport profile, authenticates the
 * executable source/capture. Imported helper chains additionally require the actual private owner
 * census; executable Query/Lambda correspondence remains with that producer. */
type PredicateAnyQuery = NonNullable<Bound['plan']['queries']>[number];

/** Predicate census head: query, parent edge and owning call association. */
function checkPredicateAnyHead(
  bound: Bound,
  metadata: Extract<ScenarioQueryAnyMetadata, { kind: 'predicate' }>,
  sources?: ScenarioPredicateAnySources,
): { query: PredicateAnyQuery; navigated: boolean;
  parentOrigin: NonNullable<PredicateAnyQuery['parent']>['origin'] | undefined;
  ownerRequire: boolean } {
  const input = closed(copyScenarioFileData(metadata), ['kind', 'queryId', 'dependencyIds',
    ...(Object.hasOwn(metadata, 'sourceCall') ? ['sourceCall'] : []),
    ...(Object.hasOwn(metadata, 'direct') ? ['direct'] : []),
    ...(Object.hasOwn(metadata, 'call') ? ['call'] : [])]);
  if (input.kind !== 'predicate' || typeof input.queryId !== 'string' || !input.queryId ||
      !Array.isArray(input.dependencyIds) || input.dependencyIds.length === 0) return fail('exact predicate CONTROL census required.');
  const query = bound.plan.queries?.find(query => query.id === input.queryId);
  if (query === undefined || query.order.length !== 0 || query.limit !== null ||
      query.archived !== 'exclude' ||
      !same(input.dependencyIds, query.dependencies.map(dependency => dependency.id))) return fail('exact predicate query and ordered CONTROL census required.');
  const navigated = query.parent !== undefined;
  const parentOrigin = navigated ? query.parent!.origin : undefined;
  if (parentOrigin !== undefined && (parentOrigin.kind !== 'admitted-reference' || !parentOrigin.parameter ||
      !same(query.parent!.source, query.source))) return fail('navigated predicate requires its exact admitted parent edge.');
  const ownerRequire = checkPredicateAnyAssociation(bound, query, input, sources, navigated);
  return { query, navigated, parentOrigin, ownerRequire };
}

/** Owning call association: helper census, direct record, or legacy root. */
function checkPredicateAnyAssociation(
  bound: Bound,
  query: PredicateAnyQuery,
  input: Record<string, unknown>,
  sources: ScenarioPredicateAnySources | undefined,
  navigated: boolean,
): boolean {
  const ownerRequire = Object.hasOwn(input, 'sourceCall');
  const direct = Object.hasOwn(input, 'direct') && (input as { direct?: unknown }).direct === true;
  const hasCall = Object.hasOwn(input, 'call');
  // A navigated predicate never inherits the legacy root-only
  // no-sourceCall allowance: it requires its exact owning call
  // association (helper census or gate-verified direct record).
  const associated = ownerRequire && (sources !== undefined || (direct && hasCall));
  if (ownerRequire && sources !== undefined) checkPredicateSourceCall(bound, query, input.sourceCall, sources);
  else if (direct) {
    // A direct leading-any guard carries no helper owner census. Its exact
    // checked call record is verified by the query-producer gate against
    // the installed owner/source before this bind; presence of both the
    // source-call selector and the record is still required here, and every
    // query-level seal below applies unchanged.
    if (!ownerRequire || !hasCall) return fail('direct predicate requires its exact checked owner call.');
  } else if (ownerRequire) return fail('actual owner source-call indices required.');
  else if (!same(query.source, bound.plan.source)) return fail('imported predicate requires its actual owner source-call association.');
  if (navigated && !associated) return fail('navigated predicate requires its exact owning call association.');
  return ownerRequire;
}

/** Declared query model (plus navigated parent) for one predicate. */
function findPredicateAnyModels(
  bound: Bound,
  query: PredicateAnyQuery,
  navigated: boolean,
): { model: ArtifactModel; canonical: CanonicalModelDescriptor } {
  const model = bound.artifactModels.get(query.model), canonical = bound.canonicalModels.find(model => model.name === query.model);
  if (model === undefined || canonical === undefined) return fail('declared query model required.');
  if (!navigated && model.parent !== undefined) return fail('declared root query model required.');
  if (navigated) {
    const parent = bound.artifactModels.get(query.parent!.model),
      canonicalParent = bound.canonicalModels.find(model => model.name === query.parent!.model);
    if (parent === undefined || canonicalParent === undefined || model.parent !== query.parent!.model ||
        parent.name !== query.parent!.model) return fail('declared navigated parent model required.');
  }
  return { model, canonical };
}

/** Declared type for one predicate field, honoring native User/enum tags. */
function resolvePredicateDeclaredType(
  field: ArtifactModel['fields'][number] | undefined,
): { nativeUser: boolean; nativeEnum: string | undefined; declaredType: unknown } {
  // The existing compiler User tag is already exact; its redundant valueType
  // claim may be absent. Registry still supplies the exact canonical type.
  const nativeUser = field !== undefined && field.field.kind === 'user' && Reflect.ownKeys(field.field).length === 1 &&
    field.array === undefined && field.nullable !== true;
  // Inline enum descriptors carry exact values without a redundant
  // valueType claim, mirroring the nativeUser precedent above; the exact
  // `enum(a,b)` spelling must equal the checked dependency type.
  const enumValues = field !== undefined && field.field.kind === 'enum' &&
    Array.isArray((field.field as { values?: unknown }).values) ?
    (field.field as { values: unknown[] }).values : undefined;
  const nativeEnum = enumValues !== undefined && enumValues.length !== 0 &&
    enumValues.every(value => typeof value === 'string') ?
    `enum(${(enumValues as string[]).join(',')})` : undefined;
  const declaredType = field !== undefined && !Object.hasOwn(field, 'valueType') &&
    (nativeUser ? 'user' : nativeEnum) ? (nativeUser ? 'user' : nativeEnum as string) : field?.valueType;
  return { nativeUser, nativeEnum, declaredType };
}

/** One predicate CONTROL dependency in query order: declaration, kind, markers. */
function checkOnePredicateAnyDependency(
  bound: Bound,
  model: ArtifactModel,
  canonical: CanonicalModelDescriptor,
  query: PredicateAnyQuery,
  dependency: PredicateAnyQuery['dependencies'][number],
): void {
  const fields = model.fields.filter(field => field.name === dependency.field);
  const field = fields[0] === undefined ? undefined : copyScenarioFileData(fields[0]) as typeof fields[0];
  const checked = canonical.fields[dependency.field];
  const { nativeUser, nativeEnum, declaredType } = resolvePredicateDeclaredType(field);
  if (dependency.role !== 'control' || !same(dependency.source, query.source) || fields.length !== 1 ||
      field === undefined || checked === undefined || declaredType !== dependency.type || (checked.valueType ?? nativeEnum) !== dependency.type ||
      dependency.type === 'user' && !nativeUser ||
      field.default?.kind === 'derived' || checked.default?.kind === 'derived') return fail('exact stored CONTROL field declaration required.');
  checkPredicateAnyFieldKind(bound, dependency, parseTypeId(dependency.type));
  for (const marker of ['required', 'serverOnly', 'nullable', 'array', 'trim', 'min', 'max'] as const) {
    if (Object.hasOwn(field, marker) !== Object.hasOwn(checked, marker) || Object.hasOwn(field, marker) && !same(field[marker], checked[marker])) return fail('owning predicate field markers disagree.');
  }
}

/** Predicate CONTROL kind: bool, User, declared Model reference or enum. */
function checkPredicateAnyFieldKind(
  bound: Bound,
  dependency: PredicateAnyQuery['dependencies'][number],
  type: ReturnType<typeof parseTypeId>,
): void {
  const modelReference = type.base.kind === 'nominal' && bound.artifactModels.has(type.base.path as ModelName) &&
    bound.valueSchema !== undefined && !Object.hasOwn(bound.valueSchema.contracts, type.base.path) &&
    !Object.hasOwn(bound.valueSchema.enums, type.base.path) && !Object.hasOwn(bound.valueSchema.aliases ?? {}, type.base.path);
  // Nominal model-field enums carry their exact case list in the type id;
  // declaration string equality above already pins the precise cases.
  const fieldEnum = type.base.kind === 'enum' && Array.isArray(type.base.cases) &&
    type.base.cases.length !== 0 && type.base.cases.every(name => typeof name === 'string');
  if (type.nullable || type.requiredArray || !(dependency.type === 'bool' || dependency.type === 'user' || modelReference || fieldEnum)) return fail('predicate requires bool, User, declared Model reference or exact enum CONTROL fields.');
}

function bindPredicateAny(bound: Bound, metadata: Extract<ScenarioQueryAnyMetadata, { kind: 'predicate' }>,
  sources?: ScenarioPredicateAnySources): PredicateAnyProfile {
  const head = checkPredicateAnyHead(bound, metadata, sources);
  const { query, navigated, parentOrigin, ownerRequire } = head;
  const { model, canonical } = findPredicateAnyModels(bound, query, navigated);
  for (const dependency of query.dependencies) {
    checkOnePredicateAnyDependency(bound, model, canonical, query, dependency);
  }
  const consumers = bound.plan.returns.filter(returned => returned.influences.some(influence => influence.queryId === query.id));
  // A verified owning Require consumes execution authority independently of
  // result disclosure. Legacy metadata still requires an actual return consumer.
  if (consumers.length === 0 && !ownerRequire || bound.plan.returns.some(returned => returned.projection?.queryId === query.id) ||
      consumers.some(returned => returned.dependencies.some(dependency => dependency.queryId === query.id && dependency.role === 'data'))) return fail('predicate requires actual CONTROL influence without projection.');
  const profile = deepFreeze({ kind: 'predicate' as const, queryId: query.id, dependencyIds: [...metadata.dependencyIds],
    model: query.model, source: query.source, query: copyScenarioFileData(query) as ScenarioReceiptQueryPlan,
    ...(parentOrigin !== undefined && parentOrigin.kind === 'admitted-reference' ?
      { parentModel: query.parent!.model, parameter: parentOrigin.parameter } : {}) });
  profiles.add(profile); return profile;
}

/** Source grammar is checked against the already authenticated owner census.
 * Query/Lambda node -> queryId correspondence remains Compiler/CF's private
 * callback attestation; the query plan has no source-node intervals. */
/** Owning Require collection call with its helper source and argument slots. */
function checkPredicateSourceCallSeal(
  bound: Bound,
  query: ScenarioReceiptQueryPlan,
  actual: ScenarioPredicateAnySources,
  site: ScenarioReceiptMembershipSite,
  call: ScenarioReceiptMembershipSite['calls'][number],
): void {
  if (site.owner !== actual.owner ||
      !same(site.source, actual.source) || !['leading-require', 'body-require'].includes(site.stage) ||
      actual.source.path !== bound.plan.source.path || actual.source.sha256 !== bound.plan.source.sha256 ||
      call.target.kind !== 'builtin' || call.target.id !== 'any' || call.target.overload !== 0 ||
      call.source.path !== query.source.path || call.source.sha256 !== query.source.sha256 ||
      query.source.module !== bound.plan.source.module || call.arguments.length !== 2 || call.slots.length !== 2 ||
      call.slots[0] === null || call.slots[1] === null || call.defaults.length !== 0) return fail('exact owning Require collection call and helper source required.');
}

/** Original Model domain, predicate slots and the helper caller chain. */
function checkPredicateSourceCallChain(
  query: ScenarioReceiptQueryPlan,
  site: ScenarioReceiptMembershipSite,
  call: ScenarioReceiptMembershipSite['calls'][number],
): void {
  const domain = call.arguments[call.slots[0]!], predicate = call.arguments[call.slots[1]!];
  const inside = (node: { readonly start: number; readonly end: number }) => node.start >= call.node.start && node.end <= call.node.end;
  if (domain?.type !== `${query.model}[]` || predicate?.type !== 'bool' || !inside(domain.node) || !inside(predicate.node) ||
      (call.chain.length !== 0 && !same(call.chain[0]!.source, site.source))) return fail('original Model domain, predicate slots and outer helper chain required.');
  // A direct leading-any guard carries no helper chain; its domain and
  // predicate slots above already pin the admitted collection call.
  for (const [index, frame] of call.chain.entries()) {
    if (!site.calls.some(parent => parent.target.kind === 'derive' && parent.target.name === frame.derive &&
        same(parent.source, frame.source) && same(parent.node, frame.node) && same(parent.chain, call.chain.slice(0, index)))) return fail('helper chain must retain each actual caller derive occurrence.');
  }
}

function checkPredicateSourceCall(bound: Bound, query: ScenarioReceiptQueryPlan, selector: unknown,
  sources: ScenarioPredicateAnySources | undefined): void {
  const selected = closed(selector, ['siteIndex', 'callIndex']);
  if (!Number.isSafeInteger(selected.siteIndex) || (selected.siteIndex as number) < 0 ||
      !Number.isSafeInteger(selected.callIndex) || (selected.callIndex as number) < 0 || sources === undefined) return fail('actual owner source-call indices required.');
  const actual = closed(copyScenarioFileData(sources), ['owner', 'source', 'sites']) as unknown as ScenarioPredicateAnySources;
  const sites = checkScenarioReceiptMembershipSites(actual.sites), site = sites[selected.siteIndex as number];
  const call = site?.calls[selected.callIndex as number];
  if (site === undefined || call === undefined) return fail('exact owning Require collection call and helper source required.');
  checkPredicateSourceCallSeal(bound, query, actual, site, call);
  checkPredicateSourceCallChain(query, site, call);
}

/** Verify a direct leading-any guard's exact checked call record against
 * the installed owner/source producer. The `direct` bit never exempts
 * this check: owner, LeadingRequire stage, builtin `any`, source/model
 * argument slots, empty chain and bounded indices are each sealed. The
 * query producer gate runs this before the predicate bind; the bind still
 * requires the source-call selector and the record to be present. */
/** Installed owner, LeadingRequire stage, checked indices and owning source. */
function checkDirectPredicateRecord(
  owner: string,
  planSource: ScenarioReceiptQueryPlan['source'],
  query: ScenarioReceiptQueryPlan,
  selector: unknown,
  call: unknown,
): { record: ScenarioQueryAnyDirectCall; node: Record<string, unknown> } {
  if (typeof owner !== 'string' || owner === '') return fail('direct predicate requires its exact installed owner.');
  const selected = closed(selector, ['siteIndex', 'callIndex']);
  if (!Number.isSafeInteger(selected.siteIndex) || (selected.siteIndex as number) < 0 ||
      !Number.isSafeInteger(selected.callIndex) || (selected.callIndex as number) < 0) return fail('direct predicate requires its exact checked call indices.');
  const record = closed(call, ['owner', 'stage', 'siteIndex', 'callIndex', 'source', 'node', 'target', 'arguments', 'slots', 'chain']) as unknown as ScenarioQueryAnyDirectCall;
  if (record.owner !== owner || record.stage !== 'leading-require') return fail('direct predicate requires its exact LeadingRequire owner call.');
  if (!Number.isSafeInteger(record.siteIndex) || (record.siteIndex as number) < 0 ||
      !Number.isSafeInteger(record.callIndex) || (record.callIndex as number) < 0 ||
      (selected.siteIndex as number) !== (record.siteIndex as number) ||
      (selected.callIndex as number) !== (record.callIndex as number)) return fail('direct predicate requires its exact checked call indices.');
  if (!same(record.source, planSource) || !same(record.source, query.source) ||
      query.source.module !== planSource.module) return fail('direct predicate requires its exact owning query source.');
  return { record, node: checkDirectPredicateNode(record) };
}

/** Exact call interval with the builtin collection-call target seal. */
function checkDirectPredicateNode(record: ScenarioQueryAnyDirectCall): Record<string, unknown> {
  const node = closed(record.node, ['start', 'end']);
  if (!Number.isSafeInteger(node.start) || !Number.isSafeInteger(node.end) ||
      (node.start as number) < 0 || (node.end as number) <= (node.start as number)) return fail('direct predicate requires its exact call interval.');
  const target = closed(record.target, ['kind', 'id', 'overload']);
  if (target.kind !== 'builtin' || target.id !== 'any' || target.overload !== 0) return fail('direct predicate requires its exact builtin collection call.');
  return node;
}

/** Exact source/model argument slots with empty chain and bounded intervals. */
function checkDirectPredicateSlots(
  query: ScenarioReceiptQueryPlan,
  record: ScenarioQueryAnyDirectCall,
  node: Record<string, unknown>,
): void {
  if (!Array.isArray(record.arguments) || record.arguments.length !== 2 ||
      !Array.isArray(record.slots) || record.slots.length !== 2 ||
      (record.slots as readonly unknown[])[0] !== 0 || (record.slots as readonly unknown[])[1] !== 1 ||
      !Array.isArray(record.chain) || record.chain.length !== 0) return fail('direct predicate requires its exact source/model argument slots and empty chain.');
  const [domainRaw, predicateRaw] = record.arguments;
  const domain = closed(domainRaw, ['type', 'node']), predicate = closed(predicateRaw, ['type', 'node']);
  const domainNode = closed(domain.node, ['start', 'end']), predicateNode = closed(predicate.node, ['start', 'end']);
  const inside = (span: Record<string, unknown>) => Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) &&
    (span.start as number) >= 0 && (span.end as number) > (span.start as number) &&
    (span.start as number) >= (node.start as number) && (span.end as number) <= (node.end as number);
  if (domain.type !== `${query.model}[]` || predicate.type !== 'bool' ||
      !inside(domainNode) || !inside(predicateNode)) return fail('direct predicate requires its exact Model domain and predicate slots.');
}

export function checkDirectPredicateCall(owner: string, planSource: ScenarioReceiptQueryPlan['source'],
  query: ScenarioReceiptQueryPlan, selector: unknown, call: unknown): void {
  const { record, node } = checkDirectPredicateRecord(owner, planSource, query, selector, call);
  checkDirectPredicateSlots(query, record, node);
}

/** Validate the retained lazy prefix; suffix rows were not predicate reads.
 * General row/lifetime/parent structural checks remain with receipt parsing. */
type SavedAnyCandidate = ScenarioReceiptQueryObservation['candidates'][number];

/** Exact saved ANY domain: identity, revision, parent and bounded selection. */
function checkSavedAnyDomain(profile: ScenarioQueryAnyProfile, saved: ScenarioReceiptQueryObservation): void {
  if (saved.queryId !== profile.queryId || !Number.isSafeInteger(saved.revision) || saved.revision < 0 ||
      (profile.kind === 'predicate' && profile.parentModel === undefined ? saved.parent !== undefined :
        saved.parent?.model !== profile.parentModel) || !Array.isArray(saved.candidates) || !Array.isArray(saved.selectedIndices) ||
      saved.selectedIndices.length > 1) return fail('exact saved ANY domain required.');
}

/** Saved ANY parent correspondence: true when the census must refuse. */
function savedAnyCandidateParentInvalid(
  profile: ScenarioQueryAnyProfile,
  saved: ScenarioReceiptQueryObservation,
  candidate: SavedAnyCandidate,
): boolean {
  if (profile.kind === 'predicate' && profile.parentModel === undefined) return candidate.row.parent != null;
  const rowParent = candidate.row.parent;
  return rowParent?.model !== profile.parentModel || rowParent!.id !== saved.parent!.row.id;
}

/** Genuine contained candidate census with default created/id order. */
function checkSavedAnyCandidateShape(
  profile: ScenarioQueryAnyProfile,
  saved: ScenarioReceiptQueryObservation,
  candidate: SavedAnyCandidate,
  index: number,
  identities: Set<string>,
): void {
  if (typeof candidate.row.id !== 'string' || identities.has(candidate.row.id) || !Number.isSafeInteger(candidate.row.created) ||
      candidate.row.archivedAt !== null || savedAnyCandidateParentInvalid(profile, saved, candidate) ||
      typeof candidate.matched !== 'boolean' || !Array.isArray(candidate.dependencies)) return fail('complete genuine contained candidate census required.');
  identities.add(candidate.row.id);
  const previous = saved.candidates[index - 1];
  if (previous !== undefined && (previous.row.created > candidate.row.created ||
      previous.row.created === candidate.row.created && previous.row.id >= candidate.row.id)) return fail('default created/id candidate order required.');
}

/** Visited verdict: predicate CONTROL closure or exact bool marker. */
function checkSavedAnyVerdict(profile: ScenarioQueryAnyProfile, candidate: SavedAnyCandidate): void {
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
}

export function checkSavedScenarioQueryAny(profile: ScenarioQueryAnyProfile, observation: ScenarioReceiptQueryObservation): boolean {
  if (!profiles.has(profile)) return fail('authentic private ANY profile required.');
  try {
    const saved = copyScenarioFileData(observation) as ScenarioReceiptQueryObservation;
    checkSavedAnyDomain(profile, saved);
    const identities = new Set<string>(); let firstTrue = -1;
    for (let index = 0; index < saved.candidates.length; index++) {
      const candidate = saved.candidates[index]!;
      checkSavedAnyCandidateShape(profile, saved, candidate, index, identities);
      if (firstTrue >= 0) {
        if (candidate.matched || candidate.dependencies.length !== 0) return fail('ANY suffix must be unvisited.');
        continue;
      }
      checkSavedAnyVerdict(profile, candidate);
      if (candidate.matched) firstTrue = index;
    }
    if (!same(saved.selectedIndices, firstTrue < 0 ? [] : [firstTrue])) return fail('ANY selects exactly its first true verdict.');
    return firstTrue >= 0;
  } catch (error) { if (error instanceof StateError) throw error; return fail('invalid saved lazy prefix.'); }
}
