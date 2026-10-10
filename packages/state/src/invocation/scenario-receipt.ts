/** Saved scenario disclosure. Compiler supplies the complete checked return
 * closure; the native host reports only actually evaluated private bindings.
 * Capture is available only during invoke, never from a request envelope.
 * This version supports scalar Values profiles, declared scalar fields and
 * explicitly checked admitted intrinsics (operation id/primitive input/original ref version).
 * Changed File fields require genuine live capture and current physical checks.
 * Owning stored contracts support whole-field dependencies. Nominal/model/
 * container/File results, Delivery, query influence and absent-reference claims
 * require their defining joins. Empty field observations prove none of
 * those facts. Every site is scoped by its checked source return/digest/module.
 */
import type { ArtifactModel, BoundCapabilityRequest, CanonicalInputDef, CanonicalModelDescriptor, CanonicalOperationDescriptor, CanonicalValueTypes, CanTypeId, ClosedInputs, DeliveryRef, DomainWrite, InvocationRef, ModelName, OutboxIntent, ProjectedRecord, RecordId,
  Receipt, FinalizedFileObservation, FinalizedFileReceiver, RetainedFinalizedFile, ScenarioReceiptFileAssignment, ScenarioReceiptAssociation, ScenarioReceiptIntrinsicDependency, ScenarioReceiptQueryPlan, ScenarioReceiptQueryObservation, ScenarioResultDisclosurePlan, StoragePort, StoredRow } from '@canlang/contracts';
import { decodeValue, encodeValue, parseTypeId, printTypeId, validateValue, isUserRef, type UserRef, type NormalizedSchema } from '@canlang/values';
import { StateError } from '../errors.js';
import { deepFreeze, getDataPath } from '../internal/own-data.js';
import { buildPolicyTable, evalPredicateForRow, type ByContext, type PolicyTable } from '../policy/grants.js';
import { evaluateBy, type MembershipReader } from '../policy/roles.js';
import { checkedMembershipFact, checkedAuthoritySnapshot, observeRowGrantAuthority } from '../policy/membership-facts.js';
import { queryRecordsObserved, projectSavedRecordForViewer, projectCurrentRecordForViewerPolicy } from '../query/engine.js';
import { MAX_MEMBERSHIP_SNAPSHOT_USERS, type Membership, type MembershipSnapshot, type ResolvedIdentity } from '@canlang/contracts';
import { admitOwnerStageCall, type AdmittedCall } from './admission.js';
import { assertScenarioReceiptExecution, scenarioReceiptMemberships, type ExecutionEffects } from './invoke.js';
import { beginOwnerMutation, type OwnerMutationInput, type OwnerMutationReadView,
  type OwnerMutationSession, type MutationWritesResult } from '../mutation/pipeline.js';
import { ownerMutationBusinessWrites } from '../mutation/source-finalization.js';
import type { GeneratedOperationDef, OperationRegistry } from './registry.js';
import { stableStringify, hashInputs } from './replay.js';
import type { SystemCommandContext, SystemStaging } from '../ports/system.js';
import { stageAuthoredDelivery } from '../receipt/authored-delivery.js';
import { RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL } from '../receipt/tables.js';
import { stageGeneratedCrudOwnerCall } from '../mutation/crud.js';
import { isGeneratedOperationDef } from './registry.js';
import { checkQueries, checkQueryProjection, disclosureType, checkQueryInventory, projectReadQueryProjectionWire, queryProjectionWire, checkSavedQueries, savedQueriesReadable } from './scenario-query-plan.js';
import { checkScenarioReceiptMembershipSites, type ScenarioReceiptMembershipSite } from './scenario-membership-plan.js';
export type { ScenarioReceiptMembershipSite } from './scenario-membership-plan.js';
import { readLiveScenarioFile, checkRetainedScenarioFile, scenarioFileField, scenarioFileWireRefs } from './scenario-file-assignment.js';
import { storedNominalType, storedNominalField, storedNominalWire, savedNominalWire, type StoredNominalFieldProfile } from './scenario-stored-value.js';
import { storedReferenceField, storedReferenceWire, type StoredReferenceFieldProfile } from './scenario-stored-reference.js';

const MAX_ITEMS = 200;
const invalid = (message: string): never => { throw new StateError('validation', `Saved scenario: ${message}`); };

/** Own JSON data only: no accessors, prototypes, aliasing, cycles or unbounded trees. */
function dataCopy<T>(value: T, decodedValues = false): T {
  let nodes = 0;
  const seen = new Set<object>();
  const copy = (part: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 32) return invalid('data exceeds its finite budget.');
    if (part === null || typeof part === 'string' || typeof part === 'boolean') return part;
    if (decodedValues && typeof part === 'bigint') return part;
    if (typeof part === 'number' && Number.isFinite(part)) return part;
    if (typeof part !== 'object' || part === null || seen.has(part) ||
        (Array.isArray(part) ? Object.getPrototypeOf(part) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(part)))) {
      return invalid('own JSON data is required.');
    }
    seen.add(part);
    const out: unknown[] | Record<string, unknown> = Array.isArray(part) ? [] : {};
    for (const key of Reflect.ownKeys(part)) {
      if (Array.isArray(part) && key === 'length') continue;
      const member = Object.getOwnPropertyDescriptor(part, key);
      if (typeof key !== 'string' || member === undefined || !('value' in member) || !member.enumerable ||
          (Array.isArray(part) && !/^(0|[1-9]\d*)$/.test(key))) return invalid('own enumerable data is required.');
      Object.defineProperty(out, key, { value: copy(member.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    if (Array.isArray(part) && Object.keys(out).length !== part.length) return invalid('sparse arrays are unsupported.');
    seen.delete(part); return out;
  };
  return copy(value, 0) as T;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
        const member = Object.getOwnPropertyDescriptor(value, key);
        return member === undefined || !('value' in member) || !member.enumerable;
      })) return invalid('closed own data shape required.');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : invalid('nonempty identity required.');
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) && value.length <= MAX_ITEMS ? value : invalid('bounded array required.');
}
function paths(value: unknown): string[] {
  const fields = list(value).map(text);
  if (new Set(fields).size !== fields.length || fields.some(field => field.split('.').some(part => part === ''))) {
    return invalid('unique field paths required.');
  }
  return fields;
}
function scalarType(type: unknown): CanTypeId {
  if (typeof type !== 'string') return invalid('declared scalar type required.');
  if (type === 'void') return type as CanTypeId;
  try {
    const parsed = parseTypeId(type);
    if (printTypeId(parsed) !== type || parsed.requiredArray ||
        !(parsed.base.kind === 'enum' || /^(int|datetime|text|bool|decimal|money|date|duration|user)(\[\])?\??$/.test(type))) {
      return invalid(`unsupported disclosure type ${JSON.stringify(type)}; defining composite/lifetime join required.`);
    }
  } catch (error) {
    if (error instanceof StateError) throw error;
    return invalid('invalid scalar type.');
  }
  return type as CanTypeId;
}
/** Only dependency sites may name an owning stored contract. Results,
 * intrinsics, query influence and changed-record inventories stay scalar. */
function dependencyType(type: unknown): CanTypeId {
  try { return scalarType(type); }
  catch { return storedNominalType(type); }
}
function savedDependencyWire(type: CanTypeId, wire: unknown): void {
  try { scalarType(type); }
  catch { savedNominalWire(type, wire); return; }
  scalarWire(type, wire);
}
function dependencyObservedWire(dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number], row: StoredRow): unknown {
  // Only a nominal, singular parent dependency reads containment metadata.
  // The privately bound profile still proves the actual declaration later.
  const type = parseTypeId(dependency.type);
  if (dependency.field === 'parent' && type.base.kind === 'nominal' && !type.array && !type.nullable) {
    const parent = object(row.parent, ['model', 'id']);
    if (parent['model'] !== type.base.path) return invalid('saved parent differs from its declared containment.');
    return { id: text(parent['id']) };
  }
  return getDataPath(row.data, dependency.field);
}
function scalarWire(type: CanTypeId, value: unknown): void {
  if (type === 'void') { if (value !== null) invalid('void receipt result must be null.'); return; }
  try { decodeValue(type, value); } catch { invalid(`invalid saved ${type} wire value.`); }
}
function origin(value: unknown): void {
  const source = object(value, ['path', 'sha256', 'module']);
  text(source['path']); text(source['module']);
  if (typeof source['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(source['sha256'])) return invalid('exact source digest required.');
}

/** Loader checker; callers cannot turn this data into a bound generated def. */
export function checkScenarioResultDisclosurePlan(value: unknown): ScenarioResultDisclosurePlan {
  const plan = object(dataCopy(value), ['version', 'source', 'returns', ...(typeof value === 'object' && value !== null && Object.hasOwn(value, 'queries') ? ['queries'] : [])]);
  if (plan['version'] !== 1) return invalid('unsupported dependency plan version.');
  origin(plan['source']);
  const queries = checkQueries(plan['queries'] ?? []);
  const returns = list(plan['returns']);
  if (returns.length === 0) return invalid('at least one checked return path required.');
  const ids = new Set<string>(); const dependencies = new Map<string, string>();
  for (const entry of returns) {
    const returned = object(entry, ['id', 'source', 'dependencies', 'influences',
      ...(typeof entry === 'object' && entry !== null && Object.hasOwn(entry, 'intrinsics') ? ['intrinsics'] : []),
      ...(typeof entry === 'object' && entry !== null && Object.hasOwn(entry, 'projection') ? ['projection'] : [])]); const id = text(returned['id']);
    origin(returned['source']);
    if (ids.has(id)) return invalid('duplicate return identity.'); ids.add(id);
    const influences = list(returned['influences']);
    for (const item of influences) {
      const influence = object(item, ['id', 'kind', ...(typeof item === 'object' && item !== null && Object.hasOwn(item, 'queryId') ? ['queryId'] : [])]); text(influence['id']);
      if (!['query-existence', 'query-cardinality', 'query-membership', 'query-order', 'absent-reference'].includes(text(influence['kind']))) {
        return invalid('unknown return influence.');
      }
    }
    checkQueryProjection(returned, queries);
    const local = new Set<string>();
    for (const item of list(returned['dependencies'])) {
      const dependency = object(item, ['id', 'source', 'role', 'model', 'field', 'type']);
      origin(dependency['source']);
      const depId = text(dependency['id']); text(dependency['model']);
      if (dependency['role'] !== 'data' && dependency['role'] !== 'control') return invalid('unknown dependency role.');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text(dependency['field']))) return invalid('only declared direct stored fields are supported.');
      dependencyType(dependency['type']);
      const encoded = stableStringify(dependency);
      if (local.has(depId) || (dependencies.has(depId) && dependencies.get(depId) !== encoded)) return invalid('dependency identity drifts.');
      local.add(depId); dependencies.set(depId, encoded);
    }
    for (const item of list(Object.hasOwn(returned, 'intrinsics') ? returned['intrinsics'] : [])) {
      const kind = (item as Record<string, unknown>)?.['kind'];
      const dependency = object(item, ['id', 'source', 'role', 'type', 'kind',
        ...(kind === 'admitted-reference-version' ? ['parameter', 'model'] : kind === 'admitted-input' ? ['parameter'] : [])]);
      origin(dependency['source']); const depId = text(dependency['id']);
      if (dependency['role'] !== 'data' && dependency['role'] !== 'control') return invalid('unknown intrinsic role.');
      if (kind === 'operation-id') {
        if (dependency['type'] !== 'text') return invalid('operation identity requires text wire.');
      } else if (kind === 'admitted-input') {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text(dependency['parameter'])) || !primitiveInputType(dependency['type'])) {
          return invalid('admitted input requires a direct parameter and supported primitive type.');
        }
      } else if (kind === 'admitted-reference-version') {
        text(dependency['model']);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text(dependency['parameter'])) || dependency['type'] !== 'int') {
          return invalid('original reference version requires a direct parameter and int wire.');
        }
      } else return invalid('unsupported intrinsic dependency.');
      const encoded = stableStringify(dependency);
      if (local.has(depId) || (dependencies.has(depId) && dependencies.get(depId) !== encoded)) return invalid('dependency identity drifts.');
      local.add(depId); dependencies.set(depId, encoded);
    }
  }
  if (dependencies.size > MAX_ITEMS) return invalid('dependency closure exceeds its finite budget.');
  return deepFreeze(plan as unknown as ScenarioResultDisclosurePlan);
}

interface ModelInventory {
  readonly fields: ReadonlyMap<string, CanTypeId | null>;
  readonly secrets: readonly string[];
  readonly withheld: readonly string[];
}
interface BoundPlan {
  readonly plan: ScenarioResultDisclosurePlan; readonly type: CanTypeId; readonly models: ReadonlyMap<ModelName, ModelInventory>;
  readonly inputs: readonly CanonicalInputDef[];
  readonly arrays: GeneratedOperationDef['inputArrays']; readonly nullableRefs: NonNullable<GeneratedOperationDef['inputNullableRefs']>;
  readonly valueSchema: NormalizedSchema | undefined; readonly parameterStyle: boolean;
  readonly artifactModels: ReadonlyMap<ModelName, ArtifactModel>; readonly valueTypes: CanonicalValueTypes | undefined;
  readonly canonicalModels: readonly CanonicalModelDescriptor[];
  readonly nominalDependencies: ReadonlyMap<string, { readonly dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number];
    readonly profile: StoredNominalFieldProfile }>;
  readonly referenceDependencies: ReadonlyMap<string, { readonly dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number];
    readonly profile: StoredReferenceFieldProfile }>;
}
const boundPlans = new WeakMap<GeneratedOperationDef, BoundPlan>();
const invokedPlans = new WeakSet<GeneratedOperationDef>();

/** Literal installed Files adapter, bound by the checked owning loader. Saved
 * facts grant no access; every physical check consumes the current receiver. */
export interface ScenarioReceiptFileProducer {
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly app: string;
  readonly revalidate: (retained: RetainedFinalizedFile, receiver: FinalizedFileReceiver) => boolean | Promise<boolean>;
}
export interface ScenarioReceiptFileAssignmentLocator {
  readonly model: ModelName;
  readonly recordId: RecordId;
  readonly field: string;
}
export interface ScenarioReceiptFileAssignmentInput extends ScenarioReceiptFileAssignmentLocator {
  readonly observation: FinalizedFileObservation;
}
const fileProducers = new WeakMap<GeneratedOperationDef, ScenarioReceiptFileProducer>();
export function bindScenarioReceiptFileProducer(def: GeneratedOperationDef, producer: ScenarioReceiptFileProducer): void {
  const bound = boundPlans.get(def);
  if (bound === undefined || invokedPlans.has(def) || fileProducers.has(def)) return invalid('File producer requires one checked source binding before execution.');
  const own = object(producer, ['source', 'app', 'revalidate']);
  const source = dataCopy(own['source']); origin(source);
  if (typeof own['revalidate'] !== 'function' || stableStringify(source) !== stableStringify(bound.plan.source)) {
    return invalid('File producer differs from its owning checked callable.');
  }
  fileProducers.set(def, Object.freeze({ source: deepFreeze(source) as ScenarioResultDisclosurePlan['source'],
    app: text(own['app']), revalidate: own['revalidate'] as ScenarioReceiptFileProducer['revalidate'] }));
}
function fileLocatorKey(locator: ScenarioReceiptFileAssignmentLocator): string {
  return stableStringify([locator.model, locator.recordId, locator.field]);
}
function fileReceiver(app: string, actor: string | null, team: string | null): FinalizedFileReceiver {
  if (actor === null) return invalid('File receiving identity requires an admitted actor.');
  return Object.freeze({ app, team: team ?? actor, owner: team ?? actor, principal: actor });
}
/** Consume the genuine opaque observation synchronously while the exact root
 * invocation is active. Neither copied calls nor native File values attest it. */
export function observeScenarioReceiptFileAssignment(call: AdmittedCall, store: StoragePort,
  input: ScenarioReceiptFileAssignmentInput): void {
  let state: Capture | undefined;
  try {
    state = capture(call, store);
    assertScenarioReceiptExecution(call, store);
    if (activeCalls.has(call) || state.pending !== 0) return invalid('File capture requires the actual active root call.');
    const own = object(input, ['model', 'recordId', 'field', 'observation']);
    const locator = { model: text(own['model']) as ModelName, recordId: text(own['recordId']) as RecordId, field: text(own['field']) };
    scenarioFileField(state.bound, locator.model, locator.field);
    const producer = fileProducers.get(call.def as GeneratedOperationDef);
    if (producer === undefined || producer.app !== call.context.app) return invalid('matching installed File producer required.');
    const receiver = fileReceiver(producer.app, call.context.actor?.userId ?? null, call.context.team?.teamId ?? null);
    const file = readLiveScenarioFile(own['observation'], receiver);
    if (file === null) return invalid('genuine live receiving File observation required.');
    const key = fileLocatorKey(locator);
    if (state.files.length >= MAX_ITEMS || state.files.some(entry => fileLocatorKey(entry) === key && entry.file.ref === file.ref)) {
      return invalid('duplicate or unbounded File capture.');
    }
    state.files.push(Object.freeze({ ...locator, file }));
  } catch (error) {
    if (state !== undefined) state.poisoned = true;
    const owner = membershipOwner(call); if (owner !== undefined) owner.capture.poisoned = true;
    throw error;
  }
}

export interface ScenarioReceiptCallSite {
  readonly id: string;
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly kind: 'operation' | 'invocation';
  readonly targets: readonly { readonly operation: string; readonly interface: CanonicalOperationDescriptor }[];
  /** null preserves an owning target's opaque/undeclared result fact. */
  readonly resultType: CanTypeId | null;
}
export interface ScenarioReceiptCallFrame {
  /** Exact invoking root or active child; private native lifetimes key on it. */
  readonly parent: AdmittedCall;
  readonly call: AdmittedCall;
  readonly session: Pick<OwnerMutationSession, 'views' | 'read' | 'stage'>;
  /** Genuine native guards join the same outer commit, even for void callees. */
  readonly guard: (value: NonNullable<ExecutionEffects['guards']>[number]) => void;
}
/** Exact source/callable verification belongs to Dev's owning loader. This
 * binder checks transport correspondence and binds literal native adapters
 * once; neither request metadata nor adapter shape attests executable bytes.
 * prepare preserves native protected references while converting actual
 * authored inputs to canonical wire. InvocationRef bound args are encoded by
 * State from the selected checked target schema and cannot be overridden. */
export interface ScenarioReceiptCallProducer {
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly app: string;
  readonly registry: OperationRegistry;
  readonly sites: readonly ScenarioReceiptCallSite[];
  readonly prepare: (def: GeneratedOperationDef, inputs: Readonly<Record<string, unknown>>, parent: AdmittedCall) => ClosedInputs | Promise<ClosedInputs>;
  readonly execute: (frame: ScenarioReceiptCallFrame) => Promise<unknown>;
}
interface BoundCalls {
  readonly producer: ScenarioReceiptCallProducer;
  readonly sites: readonly ScenarioReceiptCallSite[];
  readonly targets: ReadonlyMap<string, GeneratedOperationDef>;
}
const callProducers = new WeakMap<GeneratedOperationDef, BoundCalls>();
const activeCalls = new WeakMap<AdmittedCall, { readonly owner: ReceiptOwnerSession }>();
const retainedCallGuards = new WeakMap<AdmittedCall, readonly NonNullable<ExecutionEffects['guards']>[number][]>();

/** Definition-bound identities, never request frames or execution authority. */
export type ScenarioReceiptMembershipHandle = Readonly<object>;
export interface ScenarioReceiptMembershipProducer {
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly app: string;
  readonly sites: readonly ScenarioReceiptMembershipSite[];
  /** Dev's literal installed adapter consumes the actual privately staged
   * evaluated native argument pair once. It maps the actual native Team to
   * this call's exact verified Team pointer; a public id claim cannot do so. */
  readonly capture: (call: AdmittedCall, site: ScenarioReceiptMembershipSite, callIndex: number) => {
    readonly person: UserRef; readonly team: NonNullable<AdmittedCall['context']['team']>;
  };
}
interface BoundMemberships {
  readonly source: ScenarioResultDisclosurePlan['source']; readonly app: string;
  readonly capture: ScenarioReceiptMembershipProducer['capture'];
  readonly sites: readonly ScenarioReceiptMembershipSite[];
}
const membershipProducers = new WeakMap<GeneratedOperationDef, BoundMemberships>();
const membershipHandles = new WeakMap<ScenarioReceiptMembershipHandle, {
  readonly def: GeneratedOperationDef; readonly bound: BoundMemberships;
  readonly site: ScenarioReceiptMembershipSite; readonly callIndex: number;
}>();

/** Internal sibling-component loader join; intentionally absent from barrels.
 * It cannot register a definition or grant an active execution. */
export function assertScenarioReceiptMembershipSource(def: GeneratedOperationDef,
  source: ScenarioResultDisclosurePlan['source']): void {
  const bound = boundPlans.get(def);
  if (bound === undefined || invokedPlans.has(def)) return invalid('membership source requires its actual checked definition before execution.');
  const actual = dataCopy(source); origin(actual);
  if (stableStringify(actual) !== stableStringify(bound.plan.source)) return invalid('membership source differs from its owning checked callable.');
}
/** Bind once before execution at the existing verified source/callable loader
 * boundary. Transport validation is not JavaScript attestation. Handles are
 * returned in recipe/call order for exact active_member occurrences only. */
export function bindScenarioReceiptMembershipProducer(def: GeneratedOperationDef,
  producer: ScenarioReceiptMembershipProducer): readonly ScenarioReceiptMembershipHandle[] {
  if (membershipProducers.has(def)) return invalid('membership producer requires one checked source binding before execution.');
  object(producer, ['source', 'app', 'sites', 'capture']);
  if (typeof producer.capture !== 'function') return invalid('literal loader membership capture required.');
  const source = dataCopy(producer.source); origin(source); text(producer.app);
  assertScenarioReceiptMembershipSource(def, source);
  const sites = checkScenarioReceiptMembershipSites(producer.sites);
  if (sites.some(site => site.owner !== def.name || stableStringify(site.source) !== stableStringify(source))) return invalid('membership recipe differs from its canonical owning source/callable.');
  const bound: BoundMemberships = Object.freeze({ source: deepFreeze(source), app: producer.app, sites, capture: producer.capture });
  const handles: ScenarioReceiptMembershipHandle[] = [];
  for (const site of sites) site.calls.forEach((call, callIndex) => {
    if (call.target.kind !== 'builtin' || call.target.id !== 'active_member') return;
    const handle = Object.freeze({}); membershipHandles.set(handle, { def, bound, site, callIndex }); handles.push(handle);
  });
  if (handles.length === 0) return invalid('membership producer requires its exact checked active_member occurrence.');
  membershipProducers.set(def, bound);
  return Object.freeze(handles);
}

function membershipOwner(call: AdmittedCall): ReceiptOwnerSession | undefined {
  const context = typeof call === 'object' && call !== null ? Object.getOwnPropertyDescriptor(call, 'context') : undefined;
  return ownerSessions.get(call) ?? (context !== undefined && 'value' in context && typeof context.value === 'object' &&
    context.value !== null ? ownerContexts.get(context.value) : undefined);
}
/** Internal observer join shared with the separate genuine dispatch lifetime.
 * Intentionally absent from public barrels; this grants no execution frame. */
export async function readScenarioCurrentMembership(reader: MembershipReader, team: string, person: string): Promise<boolean> {
  const found = checkedMembershipFact(await reader.findMembership(team, person), team, person);
  if (found === null) return false;
  // Preserve this execution observer's existing separate enrollment budget.
  list(found.roles);
  return found.status === 'active';
}

/** Evaluate at the authored expression point, using only Dev's actual capture
 * and Invoke's private Identity reader. Positive and negative decisions join
 * the mandatory outer guard ledger; source callbacks never run at commit.
 * This component does not supply saved return/query membership closure. */
export async function evaluateScenarioReceiptMembership(call: AdmittedCall, store: StoragePort,
  input: { readonly site: ScenarioReceiptMembershipHandle }): Promise<boolean> {
  let owner = membershipOwner(call), state: Capture | undefined; let acquired = false;
  try {
    state = capture(call, store); owner = ownerSessions.get(call);
    object(input, ['site']);
    const issued = membershipHandles.get(input.site);
    if (owner === undefined || owner.session === null || issued === undefined || issued.def !== call.def ||
        membershipProducers.get(issued.def) !== issued.bound || issued.bound.app !== call.context.app ||
        stableStringify(issued.bound.source) !== stableStringify(state.bound.plan.source) ||
        issued.site.stage === 'send-dispatch') return invalid('membership requires its actual bound active owner call/source/app, never a dispatch lifetime.');
    ownerHealthy(owner);
    if (owner.executingCall !== call || state.returnId !== null || state.pending !== 0 || owner.capture.pending !== 0 ||
        issued.site.stage === 'leading-require' && owner.stage !== 0 || owner.callGuards.length >= MAX_ITEMS) return invalid('membership capture is concurrent, completed, stale or outside its authored stage.');
    const query = state.queries.find(value => value.call === call && value.owner === owner && value.stage === owner!.stage && value.activeSlot !== null) ?? null;
    if (owner.busy && query === null || !owner.busy && query !== null) return invalid('membership query capture requires its actual active candidate slot.');
    const stage = owner.stage, slot = query?.activeSlot ?? null;
    state.pending += 1; acquired = true;
    // Synchronous literal capture consumes the native evaluated arguments once,
    // before any read can yield. Freeze only the validated scalar identity.
    const values = issued.bound.capture(call, issued.site, issued.callIndex);
    object(values, ['person', 'team']);
    const person = object(values.person, ['kind', 'id']);
    if (!isUserRef(values.person) || person['kind'] !== 'user' || !Object.isFrozen(values.person) ||
        values.team !== call.context.team || values.team === null ||
        values.team !== owner.call.context.team && (values.team.teamId !== owner.call.context.team?.teamId ||
          stableStringify(dataCopy(values.team)) !== stableStringify(dataCopy(owner.call.context.team)))) return invalid('membership capture requires its owning Values user and exact verified current Team pointer.');
    const teamId = text(values.team.teamId), userId = text(values.person.id), reader = scenarioReceiptMemberships(owner.call, store);
    const healthy = () => {
      capture(call, store); ownerHealthy(owner!);
      if (owner!.executingCall !== call || owner!.stage !== stage || query !== null &&
          (query.activeSlot !== slot || query.complete) || state!.pending !== 1) return invalid('membership read crossed its exact active call/query stage.');
    };
    if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Membership observation moved beyond its admitted revision.');
    healthy();
    const observed = await readScenarioCurrentMembership(reader, teamId, userId); healthy();
    if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Membership read moved beyond its admitted revision.');
    healthy();
    owner.callGuards.push(Object.freeze({ name: `membership:${call.def.name}:${stage}:${owner.callGuards.length}`, evaluate: async () => {
      if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Membership checkpoint moved before outer commit.');
      const live = await readScenarioCurrentMembership(reader, teamId, userId);
      if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Membership recheck moved beyond the outer checkpoint.');
      return live === observed;
    } }));
    return observed;
  } catch (error) { if (state !== undefined) state.poisoned = true; if (owner !== undefined) owner.capture.poisoned = true; throw error; }
  finally { if (acquired) state!.pending -= 1; }
}
/** Invoke consumes this private ledger independently of the root's trusted
 * admission bypass. Neither executor effects nor request data can omit it. */
export async function revalidateScenarioReceiptCalls(call: AdmittedCall): Promise<void> {
  for (const guard of retainedCallGuards.get(call) ?? []) {
    if (!await guard.evaluate()) throw new StateError('forbidden', `Child guard ${JSON.stringify(guard.name)} no longer holds at commit.`);
  }
}

/** Native adapters bind only this literal live State-issued call. This
 * assertion cannot create a child or reactivate a completed call. */
export function assertScenarioReceiptCallExecution(call: AdmittedCall, store: StoragePort): void {
  const child = activeCalls.get(call);
  if (child === undefined) { assertScenarioReceiptExecution(call, store); return; }
  ownerHealthy(child.owner);
  if (child.owner.store !== store || child.owner.executingCall !== call || !Object.isFrozen(call)) return invalid('child capture requires its actual active owner frame.');
}

function callResultType(def: GeneratedOperationDef): CanTypeId | null {
  return def.descriptor.result?.type ?? null;
}
export function bindScenarioReceiptCallProducer(def: GeneratedOperationDef, producer: ScenarioReceiptCallProducer): void {
  const bound = boundPlans.get(def);
  if (bound === undefined || callProducers.has(def) || invokedPlans.has(def)) return invalid('call producer requires one checked source binding before execution.');
  if (typeof producer !== 'object' || producer === null || Array.isArray(producer) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(producer)) ||
      Reflect.ownKeys(producer).length !== 6 || ['source', 'app', 'registry', 'sites', 'prepare', 'execute'].some(key => {
        const member = Object.getOwnPropertyDescriptor(producer, key);
        return member === undefined || !('value' in member) || !member.enumerable;
      }) || typeof producer.prepare !== 'function' || typeof producer.execute !== 'function') return invalid('own closed loader call producer required.');
  const source = dataCopy(producer.source); origin(source); text(producer.app);
  if (stableStringify(source) !== stableStringify(bound.plan.source)) return invalid('call producer source differs from its checked parent.');
  const sites = list(dataCopy(producer.sites)) as unknown as ScenarioReceiptCallSite[];
  const names = new Set<string>(), targets = new Map<string, GeneratedOperationDef>();
  for (const site of sites) {
    object(site, ['id', 'source', 'kind', 'targets', 'resultType']); origin(site.source); text(site.id);
    if (stableStringify(site.source) !== stableStringify(bound.plan.source)) return invalid('call occurrence differs from its owning checked source.');
    if (names.has(site.id) || !['operation', 'invocation'].includes(site.kind)) return invalid('unique checked call occurrence and operand kind required.');
    names.add(site.id);
    const alternatives = list(site.targets), local = new Set<string>();
    if (alternatives.length === 0 || site.kind === 'operation' && alternatives.length !== 1) return invalid('static call or finite invocation target inventory required.');
    for (const value of alternatives) {
      const target = object(value, ['operation', 'interface']); const name = text(target['operation']);
      const callee = producer.registry.get(name);
      if (callee === undefined || !isGeneratedOperationDef(callee) || callee.name !== name || local.has(name) ||
          stableStringify(dataCopy(callee.descriptor)) !== stableStringify(target['interface']) ||
          callResultType(callee) !== site.resultType) return invalid('call target or result disagrees with its checked owning interface.');
      local.add(name); targets.set(name, callee);
    }
  }
  callProducers.set(def, { producer: Object.freeze({ ...producer, source: deepFreeze(source), app: producer.app }),
    sites: deepFreeze(sites), targets });
}

function retainedCallScenario(call: AdmittedCall, result: unknown): Omit<ScenarioReceiptAssociation, 'changed' | 'calls'> {
  const state = captures.get(call), bound = boundPlans.get(call.def as GeneratedOperationDef);
  if (bound === undefined || state?.poisoned || state?.pending !== 0) return invalid('child omitted its complete checked result closure.');
  const returnId = state?.returnId ?? (bound.type === 'void' && bound.plan.returns.length === 1 &&
    bound.plan.returns[0]!.dependencies.length === 0 && (bound.plan.returns[0]!.intrinsics?.length ?? 0) === 0 ? bound.plan.returns[0]!.id : null);
  const returned = bound.plan.returns.find(entry => entry.id === returnId);
  if (returned === undefined) return invalid('child omitted its actual selected return.');
  resultWire(bound, result);
  requireQueryResult(state, returned, result);
  const observations = (state?.observations ?? []).filter(entry => returned.dependencies.some(dep => dep.id === entry.dependencyId));
  const intrinsics = (state?.intrinsics ?? []).filter(entry => returned.intrinsics?.some(dep => dep.id === entry.dependencyId));
  if (returned.dependencies.some(dep => !observations.some(entry => entry.dependencyId === dep.id)) ||
      returned.intrinsics?.some(dep => !intrinsics.some(entry => entry.dependencyId === dep.id))) return invalid('child result dependency was not evaluated/captured.');
  return deepFreeze(dataCopy({ kind: 'scenario-result/v1' as const, plan: bound.plan, resultType: bound.type, returnId: returned.id,
    observations: observations.map(({ stored: _stored, ownerSession: _ownerSession, ...entry }) => entry),
    ...(returned.intrinsics === undefined ? {} : { intrinsics }),
    ...queryAssociations(state, returned) }));
}

/** Canonical same-owner call. Only the genuine active parent execution can
 * open this finite child lifetime. Admission, all staged effects and every
 * child guard share the unchanged outer fence and one finalization/receipt.
 * The owning read/query and protected File/Delivery profiles still require
 * their defining producers; no independent invoke supplies those joins. */
export async function invokeScenarioReceiptCall(call: AdmittedCall, store: StoragePort, input: {
  readonly site: string; readonly target: string | InvocationRef; readonly inputs: Readonly<Record<string, unknown>>;
}): Promise<unknown> {
  const contextMember = typeof call === 'object' && call !== null ? Object.getOwnPropertyDescriptor(call, 'context') : undefined;
  let owner = ownerSessions.get(call) ?? (contextMember !== undefined && 'value' in contextMember &&
    typeof contextMember.value === 'object' && contextMember.value !== null ? ownerContexts.get(contextMember.value) : undefined);
  let child: AdmittedCall | undefined;
  try {
    capture(call, store); owner = ownerSessions.get(call);
    if (owner === undefined || owner.session === null) return invalid('call requires the actual existing owner transaction.');
    ownerHealthy(owner);
    if (owner.busy || owner.executingCall !== call || owner.capture.pending !== 0 || captures.get(call)?.pending !== 0 || ++owner.callCount > MAX_ITEMS || owner.callDepth >= 16) return invalid('concurrent or unbounded child calls are forbidden.');
    const bound = callProducers.get(call.def as GeneratedOperationDef);
    if (bound === undefined || bound.producer.app !== call.context.app) return invalid('no loader-verified call producer for this source/app.');
    const report = object(input, ['site', 'target', 'inputs']);
    if (typeof input.inputs !== 'object' || input.inputs === null || Array.isArray(input.inputs)) return invalid('own authored input object required.');
    object(input.inputs, Object.keys(input.inputs));
    const site = bound.sites.find(value => value.id === report['site']);
    if (site === undefined) return invalid('unknown checked call occurrence.');
    const operand = site.kind === 'operation' ? text(input.target) : object(deepFreeze(dataCopy(input.target, true)), ['kind', 'target', 'args']);
    if (typeof operand !== 'string' && operand['kind'] !== 'invocation') return invalid('actual InvocationRef operand required.');
    const target = typeof operand === 'string' ? operand : text(operand['target']);
    const alternative = site.targets.find(value => value.operation === target), def = bound.targets.get(target);
    if (alternative === undefined || def === undefined || stableStringify(dataCopy(def.descriptor)) !== stableStringify(alternative.interface)) return invalid('actual target is outside its unchanged checked interface/allowlist.');
    if (def.kind === 'read' && !boundPlans.get(def)?.plan.returns.every(entry => entry.projection !== undefined)) return invalid('read/query call requires its defining checked query projection.');
    if ((def.kind === 'scenario' || def.kind === 'read') && !boundPlans.has(def)) return invalid('callee requires its complete checked source result closure.');
    const context = deepFreeze(dataCopy({ ...owner.call.context, operation: def.name, source: site.source.path }));
    // A copied child never becomes active; its genuine context still locates
    // the owner to latch a caught attempt as a terminal transaction failure.
    ownerContexts.set(context, owner);
    const memberships = scenarioReceiptMemberships(owner.call, store);
    const current: AdmittedCall = { context, def, inputs: {}, recordRefs: [], inputHash: '', revision: owner.call.revision, replay: null };
    child = current; owner.executingCall = current; owner.callDepth += 1;
    const underlying = owner.session;
    const healthy = () => { ownerHealthy(owner!); if (owner!.executingCall !== current || activeCalls.get(current)?.owner !== owner) return invalid('child frame is closed or superseded.'); };
    const issue = (model: ModelName, row: StoredRow | null) => {
      if (row !== null) ownerRows.set(row, { session: owner!, stage: owner!.stage, model });
      return row;
    };
    const view = (side: OwnerMutationReadView, issued: boolean): OwnerMutationReadView => Object.freeze<OwnerMutationReadView>({
      get: (model, id) => ownerOperation(owner!, async () => {
        const row = await side.get(model, id); return issued ? issue(model, row) : row;
      }, current),
      query: spec => ownerOperation(owner!, async () => {
        const rows = await side.query(deepFreeze(dataCopy(spec)));
        if (issued) for (const row of rows) issue(spec.model, row);
        return rows;
      }, current),
    });
    if (site.kind === 'invocation' && Object.keys(dataCopy(input.inputs)).length !== 0) return invalid('invocation calls require empty authored inputs and complete frozen arguments.');
    const prepared = site.kind === 'invocation' ? {} : dataCopy(await bound.producer.prepare(def, input.inputs, call));
    ownerHealthy(owner);
    if (owner.executingCall !== current) return invalid('call preparation crossed a child lifetime.');
    if (typeof prepared !== 'object' || prepared === null || Array.isArray(prepared)) return invalid('canonical authored input object required.');
    if (typeof operand !== 'string') {
      const args = operand['args'];
      if (typeof args !== 'object' || args === null || Array.isArray(args)) return invalid('canonical invocation arguments required.');
      for (const [name, value] of Object.entries(args)) {
        if (Object.hasOwn(prepared, name)) return invalid('authored inputs cannot replace frozen invocation arguments.');
        const field = def.descriptor.inputs.find(field => field.name === name);
        if (field === undefined) return invalid('invocation argument is absent from its selected target schema.');
        let wire: unknown;
        if (field.kind === 'ref') {
          const encodeRef = (element: unknown, path: string) => {
            const hasVersion = typeof element === 'object' && element !== null && Object.hasOwn(element, 'version');
            const ref = object(element, ['kind', 'model', 'id', ...(hasVersion ? ['version'] : [])]);
            if (ref['kind'] !== 'ref' || ref['model'] !== field.model) return invalid(`invocation reference ${path} disagrees with its selected target.`);
            if (hasVersion && (typeof ref['version'] !== 'bigint' || !/^[1-9][0-9]{0,14}$/.test(String(ref['version'])))) {
              return invalid(`invocation reference ${path} requires its original expected version.`);
            }
            return { id: text(ref['id']), ...(hasVersion ? { version: String(ref['version']) } : {}) };
          };
          // Encode nominal identity before generic admission applies the owning
          // container's nullable/length rules. Preserve every authored slot.
          wire = value === null ? null : Object.hasOwn(def.inputArrays, name) && Array.isArray(value)
            ? value.map((element, index) => encodeRef(element, `${name}/${index}`))
            : encodeRef(value, name);
        } else {
          const type = field.kind === 'delivery' ? undefined : field.valueType ??
            ({ string: 'text', integer: 'int', boolean: 'bool', decimal: 'decimal', money: 'money', datetime: 'datetime', duration: 'duration', user: 'user',
              enum: field.kind === 'enum' ? `enum(${field.enumValues?.join(',')})` : undefined } as Record<string, string | undefined>)[field.kind];
          if (type === undefined) return invalid('invocation argument lacks its checked owning value type.');
          wire = encodeValue(type, value as never);
        }
        Object.defineProperty(prepared, name, { value: wire, enumerable: true, configurable: true, writable: true });
      }
    }
    const admitted = await ownerOperation(owner, () => admitOwnerStageCall({ def, inputs: prepared,
      context, read: underlying.views.final, memberships, revision: current.revision,
      owner: owner!.call.checkpoint!.owner, modelNames: new Set(owner!.capture.bound.artifactModels.keys()),
      ...(owner!.capture.bound.valueSchema === undefined ? {} : { valueSchema: owner!.capture.bound.valueSchema }) }), current);
    current.inputs = deepFreeze(dataCopy(admitted.inputs));
    current.recordRefs = Object.freeze(admitted.recordRefs.map(ref => Object.freeze({ ...ref, row: issue(ref.model, ref.row)! })));
    current.checkpoint = deepFreeze(dataCopy(admitted.checkpoint!)); current.inputHash = await hashInputs(prepared);
    Object.freeze(current); activeCalls.set(current, { owner }); ownerSessions.set(current, owner);
    const final = view(underlying.views.final, true), entry = view(underlying.views.entry, false);
    const session = Object.freeze<Pick<OwnerMutationSession, 'views' | 'read' | 'stage'>>({
      views: Object.freeze({ context, maxRows: underlying.views.maxRows, entry, final,
        consumeWork: (amount?: number) => { try { healthy(); if (owner!.busy) return invalid('concurrent child work is forbidden.'); underlying.views.consumeWork(amount); }
          catch (error) { owner!.capture.poisoned = true; throw error; } } }),
      read: final.get,
      stage: (writes, options) => ownerOperation(owner!, async () => {
        healthy();
        if (def.kind === 'read') return invalid('read child cannot stage effects.');
        if (Reflect.ownKeys(options).some(key => !['cause', 'input'].includes(String(key))) ||
            def.kind === 'scenario' && options.cause !== 'scenario' ||
            def.kind !== 'scenario' && (options.cause !== 'crud' || options.input !== current.inputs)) return invalid('child staging requires its genuine operation cause and admitted inputs.');
        await underlying.stage(writes, { ...options, context }); owner!.stage += 1;
      }, current),
    });
    const guard = (value: NonNullable<ExecutionEffects['guards']>[number]) => {
      try {
        healthy(); object(value, ['name', 'evaluate']);
        const name = Object.getOwnPropertyDescriptor(value, 'name')!, evaluate = Object.getOwnPropertyDescriptor(value, 'evaluate')!;
        if (!('value' in name) || !('value' in evaluate) || typeof evaluate.value !== 'function' || owner!.callGuards.length >= MAX_ITEMS) return invalid('bounded own child guard required.');
        owner!.callGuards.push(Object.freeze({ name: text(name.value), evaluate: evaluate.value }));
      } catch (error) { owner!.capture.poisoned = true; throw error; }
    };
    if (def.kind === 'scenario' || def.kind === 'read') capture(current, store);
    const raw = def.kind === 'scenario' || def.kind === 'read' ? await bound.producer.execute(Object.freeze({ parent: call, call: current, session, guard }))
      : await stageGeneratedCrudOwnerCall({ table: owner.options.table, store }, session as OwnerMutationSession, current,
        def.kind === 'create' ? `${owner.call.context.operationId}/call/${owner.callCount}` as RecordId : undefined);
    healthy();
    const result = dataCopy(raw);
    const scenario = def.kind === 'scenario' || def.kind === 'read' ? retainedCallScenario(current, result) : undefined;
    const references = current.recordRefs.map(ref => ({ model: ref.model, row: ref.row,
      secretFields: [...(owner!.capture.bound.models.get(ref.model)?.secrets ?? [])] }));
    owner.calls.push(deepFreeze(dataCopy({ site: site.id, caller: call.def.name, target, targetInterface: stableStringify(alternative.interface),
      references, result, ...(scenario === undefined ? {} : { scenario }) })));
    if (owner.callGuards.length >= MAX_ITEMS) return invalid('child commit guard budget exceeded.');
    owner.callGuards.push(Object.freeze({ name: `call:${owner.callCount}:${target}`, evaluate: async () => {
      if (stableStringify(dataCopy(def.descriptor)) !== stableStringify(alternative.interface)) return false;
      if (await store.readRevision() !== current.revision) throw new StateError('conflict', 'Child call checkpoint moved before the outer commit.');
      const actorUserId = context.actor?.userId ?? null, teamId = context.team?.teamId ?? null;
      const membership = actorUserId !== null && teamId !== null ? await memberships.findMembership(teamId, actorUserId) : null;
      if (!await evaluateBy(def.by, { actorUserId, teamId, membership, memberships })) throw new StateError('forbidden', 'Child target authority no longer holds at commit.');
      if (await store.readRevision() !== current.revision) throw new StateError('conflict', 'Child call authority read moved beyond its outer checkpoint.');
      return true;
    } }));
    return result;
  } catch (error) { if (owner !== undefined) owner.capture.poisoned = true; throw error; }
  finally {
    if (owner !== undefined && child !== undefined) {
      const captured = captures.get(child);
      if (captured?.poisoned || captured !== undefined && captured.pending !== 0 || owner.executingCall !== child) owner.capture.poisoned = true;
      activeCalls.delete(child); ownerSessions.delete(child); captures.delete(child);
      owner.executingCall = call; owner.callDepth -= 1;
    }
  }
}

/** Registry-owned registration after exact artifact source/callable checking. */
export function bindScenarioReceiptPlan(def: GeneratedOperationDef, models: readonly ArtifactModel[],
  defaults: { readonly parameterStyle: boolean; readonly valueSchema?: NormalizedSchema; readonly valueTypes?: CanonicalValueTypes;
    readonly canonicalModels: readonly CanonicalModelDescriptor[] }): void {
  const claim = def.descriptor.result?.disclosure;
  if (claim === undefined) return;
  if (def.kind !== 'scenario' && def.kind !== 'read') return invalid('dependency plans require a scenario or checked read.');
  const plan = checkScenarioResultDisclosurePlan(claim); const type = disclosureType(def.descriptor.result!.type, plan);
  if (def.kind === 'read' && !plan.returns.every(entry => entry.projection !== undefined)) return invalid('read requires its defining query projection.');
  const inventory = new Map<ModelName, ModelInventory>();
  for (const model of models) {
    const fields = new Map<string, CanTypeId | null>(); const secrets: string[] = []; const withheld: string[] = [];
    for (const field of model.fields) {
      const tag = field.field;
      const base = ({ string: 'text', integer: 'int', decimal: 'decimal', money: 'money', datetime: 'datetime',
        boolean: 'bool', date: 'date', duration: 'duration', user: 'user' } as Record<string, string>)[tag.kind];
      let fieldType: CanTypeId | null = null;
      if (tag.kind === 'secret') secrets.push(field.name);
      if (base !== undefined || tag.kind === 'enum') {
        const canonical = field.valueType ?? `${base ?? `enum(${tag.kind === 'enum' ? tag.values.join(',') : ''})`}${field.array === undefined ? '' : '[]'}${field.nullable === true ? '?' : ''}`;
        try { fieldType = scalarType(canonical); } catch { /* Explicitly withheld unsupported field profile. */ }
      }
      if (fieldType === null) withheld.push(field.name);
      fields.set(field.name, fieldType);
    }
    inventory.set(model.name as ModelName, { fields, secrets: Object.freeze(secrets), withheld: Object.freeze(withheld) });
  }
  const artifactModels = new Map(models.map(model => [model.name as ModelName, deepFreeze(dataCopy(model))]));
  const canonicalModels = Object.freeze(defaults.canonicalModels.map(model => deepFreeze(dataCopy(model))));
  const nominalDependencies = new Map<string, { readonly dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number];
    readonly profile: StoredNominalFieldProfile }>();
  const referenceDependencies = new Map<string, { readonly dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number];
    readonly profile: StoredReferenceFieldProfile }>();
  for (const returned of plan.returns) for (const dep of returned.dependencies) {
    let scalar = true;
    try { scalarType(dep.type); } catch { scalar = false; }
    if (scalar) {
      if (inventory.get(dep.model)?.fields.get(dep.field) !== dep.type) return invalid('dependency disagrees with declared model field/type inventory.');
    } else if (dep.field === 'parent' || artifactModels.get(dep.model)?.fields.some(field => field.name === dep.field && field.field.kind === 'ref')) {
      if (!referenceDependencies.has(dep.id)) referenceDependencies.set(dep.id, Object.freeze({ dependency: dep,
        profile: storedReferenceField({ artifactModels, canonicalModels, valueSchema: defaults.valueSchema }, dep.model, dep.field, dep.type) }));
    } else if (!nominalDependencies.has(dep.id)) {
      const profile = storedNominalField({ artifactModels, canonicalModels, valueSchema: defaults.valueSchema }, dep.model, dep.field, dep.type);
      nominalDependencies.set(dep.id, Object.freeze({ dependency: dep, profile }));
    }
  }
  for (const returned of plan.returns) for (const dep of returned.intrinsics ?? []) {
    if (dep.kind === 'admitted-reference-version' && (!inventory.has(dep.model) || !versionedReferenceInput(def, dep))) {
      return invalid('original version requires its declared required singular versioned reference input.');
    }
    if (dep.kind === 'admitted-input' && !primitiveInput(def, dep)) return invalid('intrinsic input disagrees with its required singular primitive declaration.');
  }
  checkQueryInventory(plan, type, models, defaults.valueSchema);
  boundPlans.set(def, { plan, type, models: inventory, inputs: deepFreeze(dataCopy(def.descriptor.inputs)),
    arrays: deepFreeze(dataCopy(def.inputArrays)), nullableRefs: deepFreeze(dataCopy(def.inputNullableRefs ?? {})),
    valueSchema: defaults.valueSchema, parameterStyle: defaults.parameterStyle,
    artifactModels, canonicalModels, nominalDependencies, referenceDependencies,
    valueTypes: defaults.valueTypes === undefined ? undefined : deepFreeze(dataCopy(defaults.valueTypes)) });
}

/** Dev's verified loader binds these literal installed exports, never request
 * callbacks. State validates and freezes transport correspondence; it does not
 * attest JavaScript bytes from the shape of this port (as with model policies).
 * Work's original carrier proves its producer, not this invocation's lifetime.
 */
export interface ScenarioReceiptFrameworkProducer {
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly app: string;
  readonly bindings: readonly { readonly binding: string; readonly from: string;
    readonly targets: readonly { readonly source: string; readonly correlation: 'value' | 'arguments' | null }[] }[];
  readonly stage: (input: ScenarioReceiptSendProducerInput, context: SystemCommandContext) => Promise<ScenarioReceiptSendStaging>;
  readonly read: (value: unknown, input: ScenarioReceiptSendProducerInput, context: SystemCommandContext) => ScenarioReceiptSendStaging | null;
}
export interface ScenarioReceiptSendProducerInput {
  readonly operationId: string; readonly source: string; readonly occurrenceIndex: number;
  readonly request: BoundCapabilityRequest; readonly originOccurrence: null;
  readonly correlation?: { readonly requestSource: string; readonly requestRevision: string;
    readonly requestBinding: string; readonly requestFrom: string; readonly requestApp: string; readonly requestOwner: string };
}
export interface ScenarioReceiptSendStaging { readonly effects: SystemStaging; readonly delivery: DeliveryRef }
const frameworkProducers = new WeakMap<GeneratedOperationDef, ScenarioReceiptFrameworkProducer>();
export function bindScenarioReceiptFrameworkProducer(def: GeneratedOperationDef, producer: ScenarioReceiptFrameworkProducer): void {
  const bound = boundPlans.get(def);
  if (bound === undefined || frameworkProducers.has(def) || invokedPlans.has(def)) return invalid('framework producer requires one checked source binding before execution.');
  if (typeof producer !== 'object' || producer === null || Array.isArray(producer) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(producer)) ||
      Reflect.ownKeys(producer).length !== 5 || ['source', 'app', 'bindings', 'stage', 'read'].some(key => {
        const member = Object.getOwnPropertyDescriptor(producer, key);
        return member === undefined || !('value' in member) || !member.enumerable;
      }) || typeof producer.stage !== 'function' || typeof producer.read !== 'function') return invalid('own closed loader producer required.');
  const metadata = dataCopy({ source: producer.source, app: producer.app, bindings: producer.bindings });
  origin(metadata.source); text(metadata.app);
  if (stableStringify(metadata.source) !== stableStringify(bound.plan.source)) return invalid('framework producer source differs from its checked plan.');
  const names = new Set<string>();
  for (const value of list(metadata.bindings)) {
    const binding = object(value, ['binding', 'from', 'targets']); const name = text(binding['binding']); text(binding['from']);
    if (names.has(name)) return invalid('duplicate framework binding.'); names.add(name);
    const targets = new Set<string>();
    for (const value of list(binding['targets'])) {
      const target = object(value, ['source', 'correlation']); const source = text(target['source']);
      if (targets.has(source) || ![null, 'value', 'arguments'].includes(target['correlation'] as null | string)) return invalid('invalid framework target inventory.');
      targets.add(source);
    }
  }
  frameworkProducers.set(def, Object.freeze({ ...deepFreeze(metadata), stage: producer.stage, read: producer.read }));
}

function primitiveInputType(type: unknown): type is CanTypeId {
  return typeof type === 'string' && /^(text|bool|int|date|datetime|decimal|money|duration|user)$/.test(type);
}

function primitiveInput(def: GeneratedOperationDef, dependency: ScenarioReceiptIntrinsicDependency): boolean {
  if (dependency.kind !== 'admitted-input') return false;
  const input = def.descriptor.inputs.find(field => field.name === dependency.parameter);
  if (input === undefined || input.kind === 'ref' || input.kind === 'nominal' || input.kind === 'delivery' ||
      !input.required || input.default !== undefined || input.computedDefault === true ||
      def.inputArrays[dependency.parameter] !== undefined) return false;
  const types: Partial<Record<typeof input.kind, string>> = { string: 'text', boolean: 'bool', integer: 'int',
    datetime: 'datetime', decimal: 'decimal', money: 'money', duration: 'duration', user: 'user' };
  // A collapsed legacy string tag proves neither text nor nullability.
  // Artifact intake derives unambiguous builtin associations, while canonical
  // producers must supply the exact owning checked type for this new claim.
  const base = types[input.kind], type = input.valueType;
  return base !== undefined && primitiveInputType(type) && type === dependency.type &&
    (type === base || input.kind === 'string' && type === 'date');
}

function versionedReferenceInput(def: GeneratedOperationDef, dependency: ScenarioReceiptIntrinsicDependency): boolean {
  if (dependency.kind !== 'admitted-reference-version') return false;
  const input = def.descriptor.inputs.find(field => field.name === dependency.parameter);
  return input?.kind === 'ref' && input.model === dependency.model && input.required && input.versioned &&
    def.inputArrays[dependency.parameter] === undefined && def.inputNullableRefs?.[dependency.parameter] !== true;
}

type IntrinsicObservation = NonNullable<ScenarioReceiptAssociation['intrinsics']>[number];

/** Installed current viewer policy for checked stored reference influence.
 * Source field capture confers no authority over any referenced record. */
export interface ScenarioReceiptReferenceProducer {
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly app: string;
  readonly policy: PolicyTable;
}
const referenceProducers = new WeakMap<GeneratedOperationDef, ScenarioReceiptReferenceProducer>();
export function bindScenarioReceiptReferenceProducer(def: GeneratedOperationDef, producer: ScenarioReceiptReferenceProducer): void {
  const bound = boundPlans.get(def);
  if (bound === undefined || bound.referenceDependencies.size === 0 || invokedPlans.has(def) || referenceProducers.has(def)) {
    return invalid('reference producer requires one checked source binding before execution.');
  }
  object(producer, ['source', 'app', 'policy']); origin(producer.source); text(producer.app);
  if (stableStringify(dataCopy(producer.source)) !== stableStringify(bound.plan.source) || !(producer.policy instanceof Map)) {
    return invalid('reference producer differs from its checked source/policy.');
  }
  const policy = buildPolicyTable([...producer.policy].map(([model, value]) => {
    const copied = dataCopy(value);
    if (copied.model !== model) return invalid('reference policy model differs from its owning key.');
    return copied;
  }), bound.canonicalModels);
  if ([...bound.referenceDependencies.values()].some(value => !policy.has(value.dependency.model))) {
    return invalid('reference source model requires its actual viewer policy.');
  }
  referenceProducers.set(def, Object.freeze({ source: bound.plan.source, app: producer.app, policy }));
}

/** Loader-only policy wiring, bound to the same checked source and app. */
export interface ScenarioReceiptQueryProducer {
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly app: string;
  readonly policy: PolicyTable;
}
const queryProducers = new WeakMap<GeneratedOperationDef, ScenarioReceiptQueryProducer>();
export function bindScenarioReceiptQueryProducer(def: GeneratedOperationDef, producer: ScenarioReceiptQueryProducer): void {
  const bound = boundPlans.get(def);
  if (bound === undefined || !bound.plan.queries?.length || invokedPlans.has(def) || queryProducers.has(def)) return invalid('query producer requires one checked source binding before execution.');
  object(producer, ['source', 'app', 'policy']); origin(producer.source); text(producer.app);
  if (stableStringify(dataCopy(producer.source)) !== stableStringify(bound.plan.source) || !(producer.policy instanceof Map)) return invalid('query producer differs from its checked source/policy.');
  const policies = [...producer.policy].map(([model, value]) => {
    const copied = dataCopy(value);
    if (copied.model !== model) return invalid('query policy model differs from its owning key.');
    return copied;
  });
  // A detached policy must be validated anew against the registry's real
  // canonical declarations so its private row field bindings survive copying.
  const policy = buildPolicyTable(policies, bound.canonicalModels);
  if (bound.plan.queries.some(query => !policy.has(query.model))) return invalid('query model requires its actual viewer policy.');
  queryProducers.set(def, Object.freeze({ source: bound.plan.source, app: producer.app, policy }));
}
/** Opaque identities are usable only in their original active call/query. */
export type ScenarioReceiptQuerySlot = Readonly<object>;
export type ScenarioReceiptQueryHandle = Readonly<object>;
export interface ScenarioReceiptQueryResult {
  readonly query: ScenarioReceiptQueryHandle;
  readonly rows: readonly { readonly slot: ScenarioReceiptQuerySlot; readonly record: ProjectedRecord }[];
  readonly count: number;
}
interface QueryExecution {
  readonly call: AdmittedCall; readonly owner: ReceiptOwnerSession; readonly stage: number;
  readonly plan: ScenarioReceiptQueryPlan; readonly handle: ScenarioReceiptQueryHandle;
  readonly candidates: { readonly row: StoredRow; readonly record: ProjectedRecord;
    readonly slot: ScenarioReceiptQuerySlot; readonly dependencies: Set<string>;
    readonly reads: Map<string, number>; readonly markers: Map<string, number>;
    pendingRead: string | null; matched: boolean }[];
  selectedIndices: readonly number[];
  activeSlot: ScenarioReceiptQuerySlot | null;
  complete: boolean;
}
const queryHandles = new WeakMap<ScenarioReceiptQueryHandle, QueryExecution>();
const querySlots = new WeakMap<ScenarioReceiptQuerySlot, { execution: QueryExecution; index: number }>();

/** Source sees read-tracking getters only while its original predicate is live.
 * The saved snapshot and selected result always retain the private plain row. */
function queryPredicateRecord(execution: QueryExecution, index: number, store: StoragePort): ProjectedRecord {
  const candidate = execution.candidates[index]!, data: Record<string, unknown> = {};
  for (const field of Object.keys(candidate.record.data)) Object.defineProperty(data, field, {
    enumerable: true, get: () => {
      try {
        const state = capture(execution.call, store), owner = execution.owner;
        ownerHealthy(owner);
        if (owner.executingCall !== execution.call || owner.stage !== execution.stage ||
            execution.activeSlot !== candidate.slot || !owner.busy || state.pending !== 0 || state.returnId !== null) {
          return invalid('query field read requires its original active predicate candidate.');
        }
        if (candidate.pendingRead !== null) return invalid('query field read omitted its immediate source marker.');
        if (!execution.plan.dependencies.some(dep => dep.role === 'control' && dep.field === field)) return invalid('query predicate read is outside its checked control closure.');
        candidate.pendingRead = field;
        candidate.reads.set(field, (candidate.reads.get(field) ?? 0) + 1);
        return candidate.record.data[field];
      } catch (error) { execution.owner.capture.poisoned = true; throw error; }
    },
  });
  return Object.freeze({ ...candidate.record, data: Object.freeze(data) });
}
function resultWire(bound: BoundPlan, result: unknown): void {
  if (!bound.plan.returns.some(entry => entry.projection !== undefined)) { scalarWire(bound.type, result); return; }
  if (bound.valueSchema === undefined) return invalid('query result requires its owning loaded Values schema.');
  try {
    const canonical = encodeValue(bound.type, validateValue(bound.valueSchema, bound.type, result, 'create'));
    if (stableStringify(canonical) !== stableStringify(result)) return invalid('query result is not canonical owning Values wire.');
  } catch (error) { if (error instanceof StateError) throw error; return invalid('query result disagrees with its owning Values schema.'); }
}
/** Receipt-free conversion for an actual owning checked read definition. This
 * validates the entire result with its bound Values schema but grants no read
 * authority and creates no owner frame, receipt or persistence. */
export function projectReadScenarioQueryResult(def: GeneratedOperationDef, queryId: string,
  returnId: string, selected: readonly ProjectedRecord[]): unknown[] {
  if (!isGeneratedOperationDef(def) || def.kind !== 'read') return invalid('actual generated checked read required.');
  const bound = boundPlans.get(def) ?? invalid('read requires its actual bound checked result plan.');
  const query = bound.plan.queries?.find(query => query.id === queryId)
    ?? invalid('read query must name its bound checked query.');
  const returned = bound.plan.returns.find(returned => returned.id === returnId);
  if (returned?.projection === undefined || returned.projection.queryId !== query.id)
    return invalid('read return must name its bound checked query projection.');
  const wire = projectReadQueryProjectionWire(returned.projection, query, selected);
  resultWire(bound, wire);
  return wire;
}

function requireQueryResult(state: Capture | undefined, returned: ScenarioResultDisclosurePlan['returns'][number], result: unknown): void {
  if (returned.projection === undefined) return;
  if (state === undefined || state.queryResult === undefined || stableStringify(state.queryResult) !== stableStringify(result) ||
      !state.queries.some(query => query.complete && query.plan.id === returned.projection!.queryId)) return invalid('query return requires its actual issued ordered result binding, including empty.');
}
function queryAssociations(state: Capture, returned: ScenarioResultDisclosurePlan['returns'][number]): { queries?: readonly ScenarioReceiptQueryObservation[] } {
  if (returned.projection === undefined) return {};
  const query = state.queries.find(value => value.plan.id === returned.projection!.queryId)!;
  const secrets = state.bound.models.get(query.plan.model)!.secrets;
  const observations = { queries: [{ queryId: query.plan.id, revision: query.call.revision,
    candidates: query.candidates.map(candidate => ({ row: candidate.row, record: candidate.record, matched: candidate.matched,
      secretFields: [...secrets], dependencies: [...candidate.dependencies] })), selectedIndices: [...query.selectedIndices] }] };
  checkSavedQueries(state.bound.plan, returned, observations.queries, state.queryResult, state.bound.valueSchema);
  return observations;
}

interface Capture {
  readonly bound: BoundPlan;
  returnId: string | null;
  poisoned: boolean;
  pending: number;
  readonly observations: Array<ScenarioReceiptAssociation['observations'][number] & {
    readonly stored: boolean; readonly ownerSession: boolean;
  }>;
  readonly intrinsics: IntrinsicObservation[];
  readonly queries: QueryExecution[];
  queryResult: unknown | undefined;
  readonly files: Array<ScenarioReceiptFileAssignmentLocator & { readonly file: RetainedFinalizedFile }>;
}
const captures = new WeakMap<AdmittedCall, Capture>();
const captureContexts = new WeakMap<object, Capture>();
/** Invoke initializes the private capture before source execution so a caught
 * first copied-call attempt cannot silently become a clean void receipt. */
export function beginScenarioReceiptExecution(call: AdmittedCall, store: StoragePort): void {
  if (boundPlans.has(call.def as GeneratedOperationDef)) capture(call, store);
}
function capture(call: AdmittedCall, store: StoragePort): Capture {
  try {
    assertScenarioReceiptCallExecution(call, store);
    const owner = ownerSessions.get(call);
    if (owner !== undefined && owner.executingCall !== call) return invalid('capture cannot cross a pending child call.');
    const bound = boundPlans.get(call.def as GeneratedOperationDef);
    if (bound === undefined) return invalid('no loader-verified source dependency plan.');
    invokedPlans.add(call.def as GeneratedOperationDef);
    let value = captures.get(call);
    if (value === undefined) { value = { bound, returnId: null, poisoned: false, pending: 0, observations: [], intrinsics: [], queries: [], queryResult: undefined, files: [] }; captures.set(call, value); captureContexts.set(call.context, value); }
    if (value.poisoned) return invalid('capture is poisoned.');
    return value;
  } catch (error) {
    const state = captures.get(call); if (state !== undefined) state.poisoned = true;
    const context = typeof call === 'object' && call !== null ? Object.getOwnPropertyDescriptor(call, 'context') : undefined;
    if (context !== undefined && 'value' in context && typeof context.value === 'object' && context.value !== null) {
      const original = captureContexts.get(context.value); if (original !== undefined) original.poisoned = true;
    }
    const owner = ownerSessions.get(call) ?? (context !== undefined && 'value' in context &&
      typeof context.value === 'object' && context.value !== null ? ownerContexts.get(context.value) : undefined);
    if (owner !== undefined) owner.capture.poisoned = true;
    throw error;
  }
}

export type ScenarioReceiptMutationInput = Omit<OwnerMutationInput, 'context' | 'store' | 'trigger' | 'gateArchivedTargets'>;
export interface ScenarioReceiptMutationEffects extends MutationWritesResult { readonly outbox?: OutboxIntent[] }
export interface ScenarioReceiptMutationSession extends OwnerMutationSession { finalize(): Promise<ScenarioReceiptMutationEffects> }
interface FrameworkRow { readonly model: ModelName; readonly before: StoredRow | null; current: StoredRow | null; recreated: boolean }
interface FrameworkLedger {
  readonly producer: ScenarioReceiptFrameworkProducer;
  readonly rows: Map<string, FrameworkRow>;
  readonly queued: Map<string, OutboxIntent>;
  ordinal: number;
}
interface ReceiptOwnerSession {
  readonly call: AdmittedCall;
  readonly store: StoragePort;
  readonly capture: Capture;
  stage: number;
  busy: boolean;
  closed: boolean;
  finalized: MutationWritesResult | null;
  commitEffects: ScenarioReceiptMutationEffects | null;
  readonly framework: FrameworkLedger | null;
  consumeWork: ((amount?: number) => void) | null;
  readonly maxRows: number;
  readonly inputDefaults: Record<string, unknown>;
  readonly computedDefaults: readonly CanonicalInputDef[];
  computedIndex: number;
  session: OwnerMutationSession | null;
  readonly options: ScenarioReceiptMutationInput;
  executingCall: AdmittedCall;
  callCount: number;
  callDepth: number;
  readonly calls: NonNullable<ScenarioReceiptAssociation['calls']>[number][];
  readonly callGuards: NonNullable<ExecutionEffects['guards']>[number][];
}
const ownerSessions = new WeakMap<AdmittedCall, ReceiptOwnerSession>();
const ownerContexts = new WeakMap<object, ReceiptOwnerSession>();
const ownerRows = new WeakMap<StoredRow, {
  readonly session: ReceiptOwnerSession; readonly stage: number; readonly model: ModelName;
}>();

const DISPATCH_MODEL = 'work.dispatch' as ModelName;
const receiptModels = [RECEIPT_MODEL, RECEIPT_ASSOCIATION_MODEL] as readonly string[];
function frameworkKey(model: ModelName, id: RecordId): string { return `${model}\0${id}`; }
function frameworkOwner(call: AdmittedCall, store: StoragePort): ReceiptOwnerSession {
  const owner = ownerSessions.get(call);
  try {
    capture(call, store);
    if (owner === undefined || owner.store !== store || owner.framework === null) return invalid('framework stage requires its actual bound owner session.');
    if (owner.call !== call) return invalid('child framework effects require their own defining source binding join.');
    ownerHealthy(owner); return owner;
  } catch (error) {
    if (owner !== undefined) owner.capture.poisoned = true;
    const state = captures.get(call); if (state !== undefined) state.poisoned = true;
    throw error;
  }
}
function frameworkContext(owner: ReceiptOwnerSession, models: readonly string[]): { context: SystemCommandContext; close(): void } {
  let live = true; let reading = false;
  const healthy = () => {
    ownerHealthy(owner);
    if (!live || !owner.busy) return invalid('framework reader is outside its actual producer stage.');
  };
  const context: SystemCommandContext = Object.freeze({
    actor: owner.call.context.actor?.userId ?? owner.call.context.trustedSource ?? 'anonymous',
    now: owner.call.context.now, operation: owner.call.context.operation,
    load: async (model: ModelName, id: RecordId) => {
      try {
        healthy();
        if (reading || typeof model !== 'string' || !models.includes(model) || typeof id !== 'string' || id === '' ||
            owner.capture.bound.models.has(model)) return invalid('framework reader requires its producer-owned model and record identity.');
        reading = true; owner.consumeWork!(1);
        const ledger = owner.framework!, key = frameworkKey(model, id);
        let row = ledger.rows.get(key);
        if (row === undefined) {
          if (ledger.rows.size >= owner.maxRows) return invalid('framework reads exceed the owner row budget.');
          const loaded = await owner.store.load(model, id); healthy();
          const revision = await owner.store.readRevision(); healthy();
          if (revision !== owner.call.revision) throw new StateError('conflict', 'Framework read moved beyond its admitted revision.');
          const before = loaded === null ? null : deepFreeze(checkedRow(dataCopy(loaded)));
          if (before !== null && before.id !== id) return invalid('framework stored row identity differs from its read.');
          row = { model, before, current: before, recreated: false }; ledger.rows.set(key, row);
        }
        return row.current;
      } catch (error) { owner.capture.poisoned = true; throw error; }
      finally { reading = false; }
    },
    // Neither genuine producer uses query. A broader producer must supply its
    // defining finite query/lifetime join before this reader can authorize it.
    query: async () => { owner.capture.poisoned = true; return invalid('framework producer query is unsupported.'); },
  });
  return { context, close: () => { live = false; if (reading) owner.capture.poisoned = true; } };
}

async function appendFrameworkWrites(owner: ReceiptOwnerSession, effects: SystemStaging,
  context: SystemCommandContext, send?: ScenarioReceiptSendProducerInput): Promise<void> {
  const copied = dataCopy(effects);
  const allowed = send === undefined ? ['writes'] : ['writes', 'outbox', 'result'];
  if (typeof copied !== 'object' || copied === null || Array.isArray(copied) ||
      Object.keys(copied).some(key => !allowed.includes(key))) return invalid('framework producer emitted unrelated effects.');
  for (const value of list(copied.writes ?? [])) {
    const write = value as DomainWrite;
    if (write.kind !== 'insert' && write.kind !== 'update' && write.kind !== 'remove') return invalid('unknown framework write.');
    const model = text(write.model) as ModelName;
    if (owner.capture.bound.models.has(model) || (send === undefined ? !receiptModels.includes(model) : model !== DISPATCH_MODEL)) {
      return invalid('framework write is outside its genuine producer inventory.');
    }
    const id = text(write.kind === 'insert' ? write.row.id : write.id) as RecordId;
    await context.load(model, id);
    const row = owner.framework!.rows.get(frameworkKey(model, id))!;
    owner.consumeWork!(1);
    if (write.kind === 'insert') {
      if (row.current !== null) return invalid('framework insert duplicates a current identity.');
      const next = checkedRow(write.row);
      if (next.id !== id || next.version !== 1) return invalid('framework insert lacks its original row identity/version.');
      if (row.before !== null) row.recreated = true;
      row.current = deepFreeze(next);
    } else {
      if (row.current === null || write.expectedVersion !== row.current.version) return invalid('framework write differs from its current staged version.');
      if (write.kind === 'remove') row.current = null;
      else {
        const next = checkedRow(write.row);
        if (next.id !== id || next.version !== row.current.version + 1) return invalid('framework replacement lacks its next staged version.');
        row.current = deepFreeze(next);
      }
    }
  }
  for (const value of list(copied.outbox ?? [])) {
    const intent = value as OutboxIntent;
    if (send === undefined || intent.operationId !== send.operationId || intent.operation !== context.operation ||
        intent.target !== send.source || stableStringify(intent.arguments) !== stableStringify(send.request) ||
        owner.framework!.queued.has(text(intent.intentId))) return invalid('framework outbox differs from its actual checked send.');
    if (owner.framework!.queued.size >= MAX_ITEMS) return invalid('framework outbox budget exceeded.');
    owner.framework!.queued.set(intent.intentId, deepFreeze(intent));
  }
}

/** Allocate and stage at the actual source Send evaluation point. Only the
 * once-bound installed producer can contribute framework effects. */
export async function stageScenarioReceiptSend(call: AdmittedCall, store: StoragePort,
  report: { readonly source: string; readonly request: BoundCapabilityRequest }): Promise<DeliveryRef> {
  const owner = frameworkOwner(call, store);
  return ownerOperation(owner, async () => {
    const received = object(dataCopy(report), ['source', 'request']);
    const source = text(received['source']);
    const request = object(received['request'], ['binding', 'from', 'arguments',
      ...(typeof received['request'] === 'object' && received['request'] !== null &&
        Object.hasOwn(received['request'], 'judgment') ? ['judgment'] : [])]) as unknown as BoundCapabilityRequest;
    const ledger = owner.framework!, producer = ledger.producer;
    const binding = producer.bindings.find(value => value.binding === request.binding);
    const target = binding?.targets.find(value => value.source === source);
    if (producer.app !== call.context.app || binding === undefined || target === undefined || request.from !== binding.from ||
        typeof request.arguments !== 'object' || request.arguments === null || Array.isArray(request.arguments)) return invalid('send differs from its owning app/binding/target route.');
    if (ledger.ordinal >= MAX_ITEMS) return invalid('send occurrence budget exceeded.');
    let correlation: ScenarioReceiptSendProducerInput['correlation'];
    if (target.correlation !== null) {
      const value = target.correlation === 'value' ? request.arguments['value'] : request.arguments;
      if (call.checkpoint === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) return invalid('generation send requires its original owner checkpoint and request correlation.');
      const args = value as Record<string, unknown>;
      correlation = { requestSource: text(args['source']), requestRevision: text(args['revision']), requestBinding: binding.binding,
        requestFrom: binding.from, requestApp: call.context.app, requestOwner: call.checkpoint.owner };
    }
    const input = deepFreeze({ operationId: call.context.operationId, source, occurrenceIndex: ledger.ordinal++, request,
      originOccurrence: null, ...(correlation === undefined ? {} : { correlation }) });
    const reader = frameworkContext(owner, [DISPATCH_MODEL]);
    try {
      const original = await producer.stage(input, reader.context); ownerHealthy(owner);
      const sealed = producer.read(original, input, reader.context); ownerHealthy(owner);
      if (sealed === null) return invalid('send lacks its genuine original one-shot Work carrier.');
      await appendFrameworkWrites(owner, sealed.effects, reader.context, input);
      if (sealed.delivery.operation !== source || !owner.framework!.queued.has(sealed.delivery.id)) return invalid('send delivery lacks its actual queued intent.');
      return sealed.delivery;
    } finally { reader.close(); }
  });
}

/** Associate only the current row issued by this real owner session. No host
 * record locator, queued-intent map, model descriptor or write DTO is trusted. */
export async function stageScenarioReceiptDelivery(call: AdmittedCall, store: StoragePort,
  report: { readonly model: ModelName; readonly row: StoredRow; readonly field: string }): Promise<void> {
  const owner = frameworkOwner(call, store);
  return ownerOperation(owner, async () => {
    if (typeof report !== 'object' || report === null || Array.isArray(report) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(report)) || Reflect.ownKeys(report).length !== 3 ||
        ['model', 'row', 'field'].some(key => {
          const member = Object.getOwnPropertyDescriptor(report, key);
          return member === undefined || !('value' in member) || !member.enumerable;
        })) return invalid('own closed delivery assignment required.');
    const issued = ownerRows.get(report.row);
    if (issued?.session !== owner || issued.stage !== owner.stage || issued.model !== report.model) return invalid('delivery requires this session current-stage row.');
    const model = owner.capture.bound.artifactModels.get(report.model), field = model?.fields.find(value => value.name === report.field);
    if (model === undefined || field?.field.kind !== 'delivery' || !Object.hasOwn(report.row.data, report.field) ||
        call.checkpoint === undefined) return invalid('delivery requires its owning declared field and checkpoint.');
    const value = decodeValue(`delivery(${field.field.capability}.${field.field.operation})${field.nullable === true ? '?' : ''}`,
      report.row.data[report.field]) as DeliveryRef | null;
    const reader = frameworkContext(owner, receiptModels);
    try {
      const effects = await stageAuthoredDelivery({ model, recordId: report.row.id, field: report.field, value,
        queued: owner.framework!.queued, operationId: call.context.operationId, revision: call.checkpoint.revision + 1,
        ...(owner.capture.bound.valueTypes === undefined ? {} : { valueTypes: owner.capture.bound.valueTypes }),
        ...(owner.capture.bound.valueSchema === undefined ? {} : { valueSchema: owner.capture.bound.valueSchema }) }, reader.context);
      ownerHealthy(owner); await appendFrameworkWrites(owner, effects, reader.context);
    } finally { reader.close(); }
  });
}

function frameworkNetWrites(ledger: FrameworkLedger): DomainWrite[] {
  const writes: DomainWrite[] = [];
  for (const { model, before, current, recreated } of ledger.rows.values()) {
    if (before === current) continue;
    if (before !== null && (current === null || recreated)) writes.push({ kind: 'remove', model, id: before.id, expectedVersion: before.version });
    if (current === null) continue;
    if (before === null || recreated) writes.push({ kind: 'insert', model, row: current });
    else writes.push({ kind: 'update', model, id: before.id, expectedVersion: before.version, row: current });
  }
  return writes;
}

function inputDefaultWire(bound: BoundPlan, field: CanonicalInputDef, wire: unknown): unknown {
  const saved = dataCopy(wire);
  if (field.kind === 'delivery' || field.kind === 'ref') return invalid('value default requires its owning declared type.');
  if (field.kind === 'enum' && field.valueType === undefined) {
    if (typeof saved !== 'string' || !field.enumValues?.includes(saved)) return invalid('computed enum default is outside its declared cases.');
    return saved;
  }
  if (field.valueType === undefined) return invalid('input default lacks its owning value type.');
  try {
    const value = bound.valueSchema === undefined ? decodeValue(field.valueType, saved)
      : validateValue(bound.valueSchema, field.valueType, saved, 'create');
    return dataCopy(encodeValue(field.valueType, value));
  } catch { return invalid('input default disagrees with its owning Values type/schema.'); }
}

function inputDefaultSlots(call: AdmittedCall, bound: BoundPlan): {
  inputDefaults: Record<string, unknown>; computedDefaults: readonly CanonicalInputDef[];
} {
  const inputDefaults: Record<string, unknown> = {};
  const computedDefaults: CanonicalInputDef[] = [];
  if (bound.parameterStyle) for (const field of bound.inputs) {
    // Default-eligible omissions survive admission. Defaultless ordinary
    // arrays filled by admission never become native default contributions.
    if (Object.hasOwn(call.inputs, field.name) || field.kind === 'delivery') continue;
    if (field.computedDefault === true) computedDefaults.push(field);
    else if (field.kind !== 'ref' && field.valueType !== undefined) {
      if (field.default?.kind === 'literal') Object.defineProperty(inputDefaults, field.name, {
        value: inputDefaultWire(bound, field, field.default.value), enumerable: true });
      else if (field.valueType.endsWith('?')) Object.defineProperty(inputDefaults, field.name, { value: null, enumerable: true });
    }
  }
  return { inputDefaults, computedDefaults: Object.freeze(computedDefaults) };
}

/** Called only by the actual verified generated default observer. State owns
 * omitted slots/type/order/lifetime, while Dev owns expression execution and
 * private native reference identity. A bulk map or type/module claim cannot
 * contribute defaults. This API does not itself attest computed arithmetic.
 */
export function observeScenarioInputComputedDefault(call: AdmittedCall, store: StoragePort,
  report: { readonly name: string; readonly wire: unknown }): void {
  const owner = ownerSessions.get(call);
  try {
    capture(call, store);
    if (owner === undefined || owner.store !== store || owner.call !== call) return invalid('computed default requires its actual admitted root owner session; child attribution requires its defining join.');
    ownerHealthy(owner);
    if (owner.busy || owner.capture.pending !== 0) return invalid('computed default cannot overlap an owner operation.');
    const observed = object(dataCopy(report), ['name', 'wire']);
    const field = owner.computedDefaults[owner.computedIndex];
    if (field === undefined || observed['name'] !== field.name) return invalid('computed defaults require every omitted slot exactly once in declaration order.');
    let wire: unknown;
    if (field.kind === 'ref') {
      if (Object.hasOwn(owner.capture.bound.arrays, field.name) || Object.hasOwn(owner.capture.bound.nullableRefs, field.name)) {
        return invalid('computed reference requires a singular nonnullable owning slot.');
      }
      const candidate = object(observed['wire'], ['id', 'version']);
      const index = owner.capture.bound.inputs.indexOf(field);
      const seed = call.recordRefs.find(ref => {
        const seedIndex = owner.capture.bound.inputs.findIndex(input => input.name === ref.param);
        const input = owner.capture.bound.inputs[seedIndex];
        return seedIndex >= 0 && seedIndex < index && input?.kind === 'ref' && input.model === field.model &&
          ref.model === field.model && !Object.hasOwn(owner.capture.bound.arrays, input.name) &&
          !Object.hasOwn(owner.capture.bound.nullableRefs, input.name) && candidate['id'] === ref.row.id &&
          candidate['version'] === String(ref.row.version);
      });
      if (seed === undefined) return invalid('computed reference requires an earlier admitted singular nonnullable same-model seed.');
      try { wire = dataCopy(encodeValue(field.model, decodeValue(field.model, candidate))); }
      catch { return invalid('invalid computed reference wire.'); }
    } else wire = inputDefaultWire(owner.capture.bound, field, observed['wire']);
    Object.defineProperty(owner.inputDefaults, field.name, { value: deepFreeze(wire), enumerable: true });
    owner.computedIndex += 1;
  } catch (error) {
    if (owner !== undefined) owner.capture.poisoned = true;
    const state = captures.get(call); if (state !== undefined) state.poisoned = true;
    throw error;
  }
}

function finalizedDefaults(owner: ReceiptOwnerSession, modelDefaults: Record<string, unknown>): Record<string, unknown> {
  if (owner.computedIndex !== owner.computedDefaults.length) return invalid('generated handler omitted a required computed-default contribution.');
  const union: Record<string, unknown> = dataCopy(modelDefaults);
  for (const [name, value] of Object.entries(owner.inputDefaults)) {
    if (Object.hasOwn(union, name)) return invalid('input and model default identities collide.');
    Object.defineProperty(union, name, { value: dataCopy(value), enumerable: true });
  }
  return union;
}

function ownerHealthy(owner: ReceiptOwnerSession): void {
  assertScenarioReceiptExecution(owner.call, owner.store);
  if (owner.closed || owner.finalized !== null || owner.capture.poisoned) return invalid('owner session is closed, finalized or poisoned.');
}
async function ownerOperation<T>(owner: ReceiptOwnerSession, execute: () => Promise<T>, caller = owner.call): Promise<T> {
  let acquired = false;
  try {
    ownerHealthy(owner);
    if (owner.busy || owner.capture.pending !== 0 || (captures.get(caller)?.pending ?? 0) !== 0 || owner.executingCall !== caller) return invalid('concurrent owner session operations are forbidden.');
    owner.busy = true; acquired = true;
    const result = await execute();
    ownerHealthy(owner);
    const revision = await owner.store.readRevision();
    ownerHealthy(owner);
    if (revision !== owner.call.revision) throw new StateError('conflict', 'Scenario owner session moved beyond its admitted revision.');
    return result;
  } catch (error) { owner.capture.poisoned = true; throw error; }
  finally { if (acquired) owner.busy = false; }
}

/** Positive producer for one real admitted scenario execution. The physical
 * store, context and trigger come from Invoke; no overlay or proof token is
 * accepted. Only this session's current-stage immutable reads can establish
 * intermediate provenance. Its actual finalized effects must reach Invoke.
 */
export async function beginScenarioReceiptMutation(call: AdmittedCall, store: StoragePort,
  input: ScenarioReceiptMutationInput): Promise<ScenarioReceiptMutationSession> {
  const state = capture(call, store);
  try {
    if (ownerSessions.has(call) || state.pending !== 0 || state.observations.length !== 0 || state.intrinsics.length !== 0 || state.returnId !== null) return invalid('one owner session must begin before scenario observations/return completion.');
    if (typeof input !== 'object' || input === null || Array.isArray(input) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
        Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['table', 'bounds', 'policies', 'encodeField', 'stageSources'].includes(key) ||
          !('value' in Object.getOwnPropertyDescriptor(input, key)!))) return invalid('owner session accepts only its defining mutation options.');
    if (typeof input.bounds !== 'object' || input.bounds === null || Array.isArray(input.bounds)) return invalid('owner session requires finite bounds.');
    const bounds = object(dataCopy(input.bounds), ['maxWork', 'maxRows']);
    if (!Number.isSafeInteger(bounds['maxRows']) || (bounds['maxRows'] as number) < 1 ||
        (bounds['maxRows'] as number) > MAX_ITEMS) return invalid('owner row bound exceeds the saved disclosure budget.');
    const producer = frameworkProducers.get(call.def as GeneratedOperationDef);
    if (producer !== undefined && (producer.app !== call.context.app ||
        [DISPATCH_MODEL, ...receiptModels].some(model => state.bound.models.has(model as ModelName)))) return invalid('framework owner inventory collides with its app or business models.');
    const owner: ReceiptOwnerSession = { call, store, capture: state, stage: 0, busy: false, closed: false, finalized: null,
      commitEffects: null, consumeWork: null, maxRows: bounds['maxRows'] as number,
      framework: producer === undefined ? null : { producer, rows: new Map(), queued: new Map(), ordinal: 0 },
      ...inputDefaultSlots(call, state.bound), computedIndex: 0,
      session: null, options: input, executingCall: call, callCount: 0, callDepth: 0, calls: [], callGuards: [] };
    ownerSessions.set(call, owner);
    ownerContexts.set(call.context, owner);
    const session = await ownerOperation(owner, () => beginOwnerMutation({ ...input, context: call.context, store,
      trigger: { revision: call.revision, owner: call.checkpoint?.owner ?? call.context.team?.teamId ?? call.context.app },
      gateArchivedTargets: true }));
    owner.consumeWork = session.views.consumeWork;
    owner.session = session;
    const issue = (model: ModelName, row: StoredRow | null): StoredRow | null => {
      if (row !== null) ownerRows.set(row, { session: owner, stage: owner.stage, model });
      return row;
    };
    const view = (source: OwnerMutationReadView, current: boolean): OwnerMutationReadView => Object.freeze<OwnerMutationReadView>({
      get: (model, id) => ownerOperation(owner, async () => {
        const row = await source.get(model, id);
        return current ? issue(model, row) : row;
      }),
      // Query influence remains unsupported by disclosure v1. Individual
      // current rows still come from the real bounded owner read.
      query: spec => ownerOperation(owner, async () => {
        const selection = deepFreeze(dataCopy(spec));
        const rows = await source.query(selection);
        if (current) for (const row of rows) issue(selection.model, row);
        return rows;
      }),
    });
    const final = view(session.views.final, true);
    const views = Object.freeze({ context: session.views.context, maxRows: session.views.maxRows,
      entry: view(session.views.entry, false), final,
      consumeWork: (amount?: number) => {
        try {
          ownerHealthy(owner);
          if (owner.busy || state.pending !== 0) return invalid('concurrent owner session operations are forbidden.');
          session.views.consumeWork(amount);
        } catch (error) { state.poisoned = true; throw error; }
      },
    });
    return Object.freeze<ScenarioReceiptMutationSession>({ views, read: final.get,
      stage: (writes, options) => ownerOperation(owner, async () => {
        if (options?.cause !== 'scenario') return invalid('receipt owner staging requires the actual scenario cause.');
        await session.stage(writes, options);
        owner.stage += 1;
      }),
      finalize: async () => {
        try {
          if (owner.computedIndex !== owner.computedDefaults.length) return invalid('generated handler omitted a required computed-default contribution.');
          const result = await ownerOperation(owner, () => session.finalize());
          const businessWrites = ownerMutationBusinessWrites(result);
          if (businessWrites.length > MAX_ITEMS) return invalid('changed snapshot budget exceeded.');
          // The actual seal must not alias mutable output from the ordinary
          // model pipeline; both consumer and retention receive this copy.
          const finalized = deepFreeze(dataCopy({ ...result, writes: [...businessWrites],
            resolvedDefaults: finalizedDefaults(owner, result.resolvedDefaults) }));
          owner.finalized = finalized;
          // Disclosure names business changes only. Source/framework effects
          // still reach Invoke together under this exact original fence.
          const commitEffects = owner.framework === null && businessWrites === result.writes ? finalized :
            deepFreeze(dataCopy({ ...finalized,
              writes: [...result.writes, ...(owner.framework === null ? [] : frameworkNetWrites(owner.framework))],
              ...(owner.framework === null ? {} : { outbox: [...owner.framework.queued.values()] }) }));
          owner.commitEffects = commitEffects;
          return commitEffects;
        } catch (error) { state.poisoned = true; throw error; }
      },
    });
  } catch (error) { state.poisoned = true; throw error; }
}

/** Invoke closes carriers even when the executor throws or returns early. */
export function closeScenarioReceiptExecution(call: AdmittedCall): void {
  const owner = ownerSessions.get(call);
  if (owner !== undefined) {
    owner.closed = true;
    if (owner.busy || owner.executingCall !== call || owner.finalized === null) owner.capture.poisoned = true;
  }
  const state = captures.get(call);
  if (state !== undefined && state.pending !== 0) state.poisoned = true;
}

/** Snapshot the claimed scenario's own effects once while execution is live.
 * Receipt correspondence and the eventual commit consume this same immutable
 * carrier. Guard evaluators remain callbacks; their identity/name are captured
 * without evaluating accessors or retaining mutable effect arrays.
 */
export function snapshotScenarioReceiptEffects(call: AdmittedCall, effects: ExecutionEffects): ExecutionEffects {
  if (!boundPlans.has(call.def as GeneratedOperationDef)) return effects;
  const required = ['writes', 'history', 'outbox', 'schedules', 'uniqueClaims', 'uniqueReleases', 'resolvedDefaults', 'result'];
  const allowed = [...required, 'generatedCrud', 'guards', 'readings', 'fileAssignments'];
  const snapshot: Record<string, unknown> = {};
  if (typeof effects !== 'object' || effects === null || Array.isArray(effects) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(effects)) ||
      required.some(key => !Object.hasOwn(effects, key))) return invalid('own complete execution effects required.');
  for (const key of Reflect.ownKeys(effects)) {
    const member = Object.getOwnPropertyDescriptor(effects, key)!;
    if (typeof key !== 'string' || !allowed.includes(key) || !('value' in member) || !member.enumerable) {
      return invalid('execution effects require own enumerable data and cannot supply a scenario association.');
    }
    if (member.value === undefined && !required.includes(key) && key !== 'fileAssignments') continue;
    if (key === 'fileAssignments') {
      snapshot[key] = list(dataCopy(member.value)).map(entry => {
        const locator = object(entry, ['model', 'recordId', 'field']);
        return { model: text(locator['model']) as ModelName, recordId: text(locator['recordId']) as RecordId, field: text(locator['field']) };
      });
    } else if (key === 'guards') {
      const guards = list(member.value);
      if (Reflect.ownKeys(guards).length !== guards.length + 1) return invalid('own dense guard array required.');
      snapshot[key] = Array.from({ length: guards.length }, (_, index) => {
        const entry = Object.getOwnPropertyDescriptor(guards, String(index));
        if (entry === undefined || !('value' in entry) || !entry.enumerable) return invalid('guard array cannot contain accessors or holes.');
        const value: unknown = entry.value;
        if (typeof value !== 'object' || value === null || Array.isArray(value) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
            Reflect.ownKeys(value).length !== 2 || !Object.hasOwn(value, 'name') || !Object.hasOwn(value, 'evaluate')) {
          return invalid('own closed guard carrier required.');
        }
        const name = Object.getOwnPropertyDescriptor(value, 'name')!, evaluate = Object.getOwnPropertyDescriptor(value, 'evaluate')!;
        if (!('value' in name) || !('value' in evaluate) || !name.enumerable || !evaluate.enumerable ||
            typeof evaluate.value !== 'function') return invalid('guard callbacks cannot be accessors.');
        return Object.freeze({ name: text(name.value), evaluate: evaluate.value as () => boolean | Promise<boolean> });
      });
    } else snapshot[key] = dataCopy(member.value);
  }
  const fileAssignments = matchScenarioFileAssignments(call, snapshot as unknown as ExecutionEffects);
  if (fileAssignments.length !== 0) {
    const producer = fileProducers.get(call.def as GeneratedOperationDef)!;
    const receiver = fileReceiver(producer.app, call.context.actor?.userId ?? null, call.context.team?.teamId ?? null);
    snapshot['guards'] = [...((snapshot['guards'] as NonNullable<ExecutionEffects['guards']> | undefined) ?? []),
      ...fileAssignments.map(assignment => Object.freeze({ name: `File ${fileLocatorKey(assignment)} ${assignment.file.ref}`,
        evaluate: async () => (await producer.revalidate(assignment.file, receiver)) === true }))];
  }
  const owner = ownerSessions.get(call);
  if (owner !== undefined && owner.callGuards.length !== 0) retainedCallGuards.set(call, Object.freeze([...owner.callGuards]));
  return deepFreeze(snapshot) as unknown as ExecutionEffects;
}

/** Match every captured ref to one final owning field. Null/empty locators
 * establish a checked field profile without inventing a Files observation. */
function matchScenarioFileAssignments(call: AdmittedCall, effects: ExecutionEffects): readonly ScenarioReceiptFileAssignment[] {
  const state = captures.get(call), bound = boundPlans.get(call.def as GeneratedOperationDef)!;
  const locators = list(effects.fileAssignments ?? []);
  if (state?.poisoned) return invalid('File capture is poisoned.');
  const seen = new Set<string>(); const matched = new Set<object>(); const files: ScenarioReceiptFileAssignment[] = [];
  for (const raw of locators) {
    const own = object(raw, ['model', 'recordId', 'field']);
    const locator = { model: text(own['model']) as ModelName, recordId: text(own['recordId']) as RecordId, field: text(own['field']) };
    const key = fileLocatorKey(locator);
    if (seen.has(key)) return invalid('duplicate File assignment locator.'); seen.add(key);
    const producer = fileProducers.get(call.def as GeneratedOperationDef);
    if (producer === undefined || producer.app !== call.context.app) return invalid('File assignments require their installed owning producer.');
    const receiver = fileReceiver(producer.app, call.context.actor?.userId ?? null, call.context.team?.teamId ?? null);
    const profile = scenarioFileField(bound, locator.model, locator.field);
    const writes = effects.writes.filter(write => write.model === locator.model &&
      (write.kind === 'insert' ? write.row.id : write.id) === locator.recordId);
    if (writes.length !== 1) return invalid('File assignment requires its final net owning write.');
    const write = writes[0]!;
    if (write.kind === 'remove') return invalid('removed File assignment.');
    const row = checkedRow(write.row);
    if (row.id !== locator.recordId || row.version !== (write.kind === 'insert' ? 1 : write.expectedVersion + 1) || !Object.hasOwn(row.data, locator.field)) return invalid('File assignment differs from its final row.');
    const refs = new Set(scenarioFileWireRefs(profile, row.data[locator.field]));
    for (const ref of refs) {
      const captured = state?.files.filter(entry => fileLocatorKey(entry) === key && entry.file.ref === ref) ?? [];
      if (captured.length !== 1 || stableStringify(captured[0]!.file.receiver) !== stableStringify(receiver)) return invalid('final File ref omitted its genuine receiving capture.');
      matched.add(captured[0]!);
      files.push({ ...locator, rowVersion: row.version, file: captured[0]!.file });
    }
  }
  if ((state?.files ?? []).some(entry => !matched.has(entry)) || files.length > MAX_ITEMS) return invalid('orphan or unbounded File capture.');
  return Object.freeze(files);
}

function queryModelDescriptor(bound: BoundPlan, query: ScenarioReceiptQueryPlan) {
  const model = bound.artifactModels.get(query.model)!;
  return { name: query.model, deleteMode: model.deleteMode,
    fields: Object.fromEntries(model.fields.map(field => {
      const type = field.valueType ?? ({ integer: 'int', decimal: 'decimal', money: 'money', datetime: 'datetime', string: 'text', boolean: 'bool', date: 'date', duration: 'duration', user: 'user' } as Record<string,string>)[field.field.kind];
      return [field.name, { required: field.required, serverOnly: field.serverOnly,
        ...(type === undefined ? {} : { valueType: type }), ...(field.array === undefined ? {} : { array: field.array }) }];
    })) };
}
/** Runs the real viewer engine over this transaction's complete bounded owner
 * stage. Native source runs once, sequentially; handles preserve original rows. */
export async function executeScenarioReceiptQuery(call: AdmittedCall, store: StoragePort, input: {
  readonly queryId: string;
  readonly predicate: (candidate: { readonly slot: ScenarioReceiptQuerySlot; readonly record: ProjectedRecord }) => boolean | Promise<boolean>;
}): Promise<ScenarioReceiptQueryResult> {
  const state = capture(call, store), owner = ownerSessions.get(call);
  try {
    object(input, ['queryId', 'predicate']);
    if (owner === undefined || owner.session === null || state.returnId !== null || typeof input.predicate !== 'function') return invalid('query requires the actual active owner call and source predicate.');
    const plan = state.bound.plan.queries?.find(query => query.id === input.queryId);
    const producer = queryProducers.get(call.def as GeneratedOperationDef);
    if (plan === undefined || producer === undefined || producer.app !== call.context.app || state.queries.some(query => query.plan.id === plan.id)) return invalid('one actual execution per checked query occurrence required.');
    const execution: QueryExecution = { call, owner, stage: owner.stage, plan, handle: Object.freeze({}), candidates: [],
      selectedIndices: [], activeSlot: null, complete: false };
    queryHandles.set(execution.handle, execution); state.queries.push(execution);
    const memberships = scenarioReceiptMemberships(owner.call, store);
    const context = { actorUserId: call.context.actor?.userId ?? null, teamId: call.context.team?.teamId ?? null };
    return await ownerOperation(owner, async () => {
      const domain = await owner.session!.views.final.query({ model: plan.model, authority: 'owner',
        limit: owner.maxRows, archived: plan.archived });
      for (const row of domain) ownerRows.set(row, { session: owner, stage: owner.stage, model: plan.model });
      const adapter = { ...store, readRevision: () => store.readRevision(), query: async () => domain };
      const base = { model: plan.model, modelDescriptor: queryModelDescriptor(state.bound, plan), authority: 'viewer' as const,
        policy: producer.policy, context, memberships, store: adapter, archived: plan.archived,
        ...(plan.order.length === 0 ? {} : { order: plan.order }), ...(plan.limit === null ? {} : { limit: plan.limit }) };
      const requiredFields = [...new Set(plan.dependencies.filter(dep => dep.role === 'control').map(dep => dep.field))];
      const observed = await queryRecordsObserved(base, async (record, row) => {
        ownerHealthy(owner);
        if (owner.executingCall !== call || owner.stage !== execution.stage) return invalid('query predicate crossed its original owner stage.');
        const slot = Object.freeze({});
        const candidate = { row, record: deepFreeze(dataCopy(record)), slot, dependencies: new Set<string>(),
          reads: new Map<string, number>(), markers: new Map<string, number>(), pendingRead: null as string | null, matched: false };
        querySlots.set(slot, { execution, index: execution.candidates.length }); execution.candidates.push(candidate);
        execution.activeSlot = slot;
        try {
          const accepted = await input.predicate(Object.freeze({ slot, record: queryPredicateRecord(execution, execution.candidates.length - 1, store) }));
          capture(call, store); ownerHealthy(owner);
          if (typeof accepted !== 'boolean') return invalid('query predicate requires an actual boolean.');
          if (candidate.pendingRead !== null || [...candidate.reads].some(([field, count]) => candidate.markers.get(field) !== count)) return invalid('query predicate omitted an executed control source marker.');
          candidate.matched = accepted; return accepted;
        } finally { execution.activeSlot = null; }
      }, requiredFields);
      if (observed.candidates.length !== execution.candidates.length || observed.candidates.some((candidate, index) =>
        candidate.row !== execution.candidates[index]!.row || candidate.matched !== execution.candidates[index]!.matched)) return invalid('actual query engine lost original candidate correspondence.');
      execution.selectedIndices = Object.freeze([...observed.selectedIndices]); execution.complete = true;
      // Engine order is independent of authored predicate reads. Attribute its
      // selected-row fields without inventing source reads or markers.
      for (const index of execution.selectedIndices) for (const dependency of plan.dependencies) {
        if (dependency.role === 'control' && plan.order.some(term => term.field === dependency.field)) execution.candidates[index]!.dependencies.add(dependency.id);
      }
      // Recheck the same full domain and current grants without rerunning source.
      // Later own writes never substitute for this original intermediate stage.
      if (owner.callGuards.length >= MAX_ITEMS) return invalid('query commit guard budget exceeded.');
      owner.callGuards.push(Object.freeze({ name: `query:${call.def.name}:${plan.id}`, evaluate: async () => {
        if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Query checkpoint moved before outer commit.');
        const guardInput = { ...base }; delete guardInput.limit;
        const current = await queryRecordsObserved(guardInput, () => true, requiredFields);
        const original = observed.candidates.map(candidate => candidate.record).sort((a, b) =>
          current.records.findIndex(row => row.id === a.id) - current.records.findIndex(row => row.id === b.id));
        if (stableStringify(current.records) !== stableStringify(original)) throw new StateError('forbidden', 'Original query domain or field authority changed before commit.');
        if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Query authority read moved beyond outer checkpoint.');
        return true;
      } }));
      return Object.freeze({ query: execution.handle, rows: Object.freeze(execution.selectedIndices.map(index => {
        const candidate = execution.candidates[index]!; return Object.freeze({ slot: candidate.slot, record: candidate.record });
      })), count: execution.selectedIndices.length });
    }, call);
  } catch (error) { state.poisoned = true; if (owner !== undefined) owner.capture.poisoned = true; throw error; }
}
/** Reports an immediate actual native protected-field read from this candidate. */
export function observeScenarioReceiptQueryDependency(call: AdmittedCall, store: StoragePort, input: {
  readonly slot: ScenarioReceiptQuerySlot; readonly dependencyId: string;
}): void {
  const state = capture(call, store), owner = ownerSessions.get(call);
  try {
    object(input, ['slot', 'dependencyId']);
    const issued = querySlots.get(input.slot), query = issued?.execution;
    if (query === undefined || query.call !== call || query.owner !== owner || query.stage !== owner?.stage ||
        query.activeSlot !== input.slot || !owner.busy || state.pending !== 0 || state.returnId !== null) return invalid('query field observation requires its actual active candidate slot.');
    const dependency = query.plan.dependencies.find(dep => dep.id === input.dependencyId), candidate = query.candidates[issued!.index]!;
    if (dependency === undefined || dependency.role !== 'control' || !Object.hasOwn(candidate.record.data, dependency.field) ||
        candidate.pendingRead !== dependency.field) return invalid('query source marker must match its immediate actual control field read.');
    candidate.pendingRead = null;
    candidate.markers.set(dependency.field, (candidate.markers.get(dependency.field) ?? 0) + 1);
    candidate.dependencies.add(dependency.id);
  } catch (error) {
    state.poisoned = true; if (owner !== undefined) owner.capture.poisoned = true;
    const issued = querySlots.get(input?.slot); if (issued !== undefined) issued.execution.owner.capture.poisoned = true;
    throw error;
  }
}
/** Binds the actual authored Fact construction through its private native slots.
 * Schema/wire alone cannot establish selected membership, order or emptiness. */
export function bindScenarioReceiptQueryResult(call: AdmittedCall, store: StoragePort, input: {
  readonly query: ScenarioReceiptQueryHandle; readonly returnId: string; readonly wire: unknown;
  readonly rows: readonly ScenarioReceiptQuerySlot[];
}): void {
  const state = capture(call, store), owner = ownerSessions.get(call);
  try {
    object(input, ['query', 'returnId', 'wire', 'rows']);
    const execution = queryHandles.get(input.query), returned = state.bound.plan.returns.find(value => value.id === input.returnId);
    if (owner === undefined || owner.busy || execution === undefined || execution.call !== call || execution.owner !== owner ||
        !execution.complete || state.returnId !== null || state.queryResult !== undefined || returned?.projection?.queryId !== execution.plan.id) return invalid('result requires its actual completed query and selected return.');
    const rows = list(input.rows);
    if (rows.length !== execution.selectedIndices.length || rows.some((slot, index) => slot !== execution.candidates[execution.selectedIndices[index]!]!.slot)) return invalid('result rows differ from actual ordered query membership.');
    for (const index of execution.selectedIndices) {
      const candidate = execution.candidates[index]!;
      for (const field of returned.projection.fields) if (field.kind === 'field') {
        for (const dependency of execution.plan.dependencies) if (dependency.role === 'data' && dependency.field === field.field) candidate.dependencies.add(dependency.id);
      }
      if (execution.plan.dependencies.some(dep => dep.role === 'data' && !candidate.dependencies.has(dep.id))) return invalid('result omitted its checked selected-row data attribution.');
    }
    const expected = queryProjectionWire(returned.projection, execution.plan, execution.candidates, execution.selectedIndices);
    resultWire(state.bound, expected); resultWire(state.bound, input.wire);
    if (stableStringify(expected) !== stableStringify(dataCopy(input.wire))) return invalid('actual result differs from original selected Task reference/version/fields.');
    state.queryResult = deepFreeze(dataCopy(input.wire));
  } catch (error) {
    state.poisoned = true; if (owner !== undefined) owner.capture.poisoned = true;
    const issued = queryHandles.get(input?.query); if (issued !== undefined) issued.owner.capture.poisoned = true;
    throw error;
  }
}

function sourceReferenceProjection(profile: StoredReferenceFieldProfile, record: ProjectedRecord | null): unknown {
  if (record === null) return undefined;
  if (profile.kind === 'parent') return record.parent?.model === profile.target ? { id: record.parent.id } : undefined;
  const field = Object.getOwnPropertyDescriptor(record.data, profile.field);
  return field !== undefined && 'value' in field && field.enumerable ? field.value : undefined;
}
function wholeReferenceGrant(policy: NonNullable<ReturnType<PolicyTable['get']>>, allowed: readonly boolean[],
  row: StoredRow, profile: StoredReferenceFieldProfile): boolean {
  // Parent is existing unprojected containment metadata on a visible row.
  // Stored reference fields need their whole field, never an id-only subgrant.
  return policy.grants.some((grant, index) => allowed[index] === true &&
    (grant.when === undefined || evalPredicateForRow(grant.when, row)) &&
    (profile.kind === 'parent' || grant.fields.includes(profile.field)));
}

/** Current origin authority is observed before native promotion. The exact
 * facts survive child awaits and join Invoke's mandatory private guard ledger;
 * target admission remains independent and no target row is loaded here. */
async function observeReferenceAuthority(call: AdmittedCall, store: StoragePort, owner: ReceiptOwnerSession,
  state: Capture, dependencyId: string, row: StoredRow, profile: StoredReferenceFieldProfile, model: ModelName): Promise<() => Promise<void>> {
  const producer = referenceProducers.get(call.def as GeneratedOperationDef);
  if (producer === undefined || producer.app !== call.context.app || owner.session === null ||
      stableStringify(producer.source) !== stableStringify(state.bound.plan.source)) return invalid('matching installed reference source policy required.');
  const policy = producer.policy.get(model);
  if (policy === undefined || owner.callGuards.length >= MAX_ITEMS) return invalid('source reference policy or guard budget is unavailable.');
  const stage = owner.stage, reader = scenarioReceiptMemberships(owner.call, store);
  const actorUserId = call.context.actor?.userId ?? null, teamId = call.context.team?.teamId ?? null;
  let capturing = true;
  const healthy = () => {
    if (!capturing) return;
    capture(call, store); ownerHealthy(owner);
    if (owner.executingCall !== call || owner.stage !== stage || !owner.busy || state.pending !== 1 || state.returnId !== null) {
      return invalid('source reference authority crossed its original call or owner stage.');
    }
  };
  const facts = new Map<string, Membership | null>();
  const factKey = (team: string, user: string) => stableStringify([team, user]);
  const recordFact = (team: string, user: string, value: unknown): Membership | null => {
    if (team !== teamId) return invalid('source reference authority crossed its actual Team.');
    const fact = checkedMembershipFact(value, team, user), key = factKey(team, user);
    if (facts.has(key) && stableStringify(facts.get(key)) !== stableStringify(fact)) {
      throw new StateError('forbidden', 'Source reference Identity facts changed.');
    }
    if (!facts.has(key) && facts.size >= MAX_MEMBERSHIP_SNAPSHOT_USERS) return invalid('source reference subject budget exceeded.');
    facts.set(key, fact); return fact;
  };
  const snapshot = Object.getOwnPropertyDescriptor(reader, 'findMembershipsSnapshot');
  const memberships: MembershipReader = {
    findMembership: async (team, user) => {
      healthy(); const value = await reader.findMembership(team, user); healthy(); return recordFact(team, user, value);
    },
    ...(snapshot !== undefined && 'value' in snapshot && typeof snapshot.value === 'function' ? {
      findMembershipsSnapshot: async (team: string, users: readonly string[]): Promise<MembershipSnapshot> => {
        healthy(); const value = await snapshot.value.call(reader, team, users); healthy();
        const checked = checkedAuthoritySnapshot(value, team, users);
        for (const user of users) recordFact(team, user, checked.get(factKey(team, user)));
        return value;
      },
    } : {}),
  };
  const member = actorUserId === null || teamId === null ? null : await memberships.findMembership(teamId, actorUserId);
  healthy();
  const context: ByContext = { actorUserId, teamId, membership: member, memberships };
  const originalWire = storedReferenceWire(profile, row);
  const authority = await observeRowGrantAuthority(context, async observed => {
    const value = await projectCurrentRecordForViewerPolicy({ policy, context: observed, row }); healthy();
    return { record: value.record, whole: wholeReferenceGrant(policy, value.allowed, row, profile) };
  });
  healthy();
  const projected = sourceReferenceProjection(profile, authority.value.record);
  if (!authority.value.whole || projected === undefined || stableStringify(projected) !== stableStringify(originalWire)) {
    throw new StateError('forbidden', 'Current source reference field authority is unavailable.');
  }
  await authority.revalidate(); healthy();
  if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Source reference authority moved beyond its admitted revision.');
  healthy(); capturing = false;
  const observedFacts = new Map(facts);
  const fixedContext: ByContext = { actorUserId, teamId, membership: member, memberships: {
    findMembership: async (team, user) => {
      const key = factKey(team, user);
      if (!observedFacts.has(key)) throw new StateError('forbidden', 'Source reference grant requested an unobserved subject.');
      return observedFacts.get(key)!;
    },
  } };
  owner.callGuards.push(Object.freeze({ name: `reference:${call.def.name}:${dependencyId}:${stage}:${owner.callGuards.length}`, evaluate: async () => {
    if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Source reference checkpoint moved before commit.');
    const write = owner.finalized?.writes.find(candidate => candidate.model === model &&
      (candidate.kind === 'insert' ? candidate.row.id : candidate.id) === row.id);
    const current = write === undefined ? await store.load(model, row.id) : write.kind === 'remove' ? null : write.row;
    if (current === null || current.archivedAt !== null || current.version < row.version || current.created !== row.created ||
        current.createdBy !== row.createdBy || stableStringify(current.parent ?? null) !== stableStringify(row.parent ?? null)) {
      throw new StateError('forbidden', 'Source reference row lifetime changed before commit.');
    }
    const currentWire = storedReferenceWire(profile, current);
    const value = await projectCurrentRecordForViewerPolicy({ policy, context: fixedContext, row: current });
    const projected = sourceReferenceProjection(profile, value.record);
    if (!wholeReferenceGrant(policy, value.allowed, current, profile) || projected === undefined ||
        stableStringify(projected) !== stableStringify(currentWire)) {
      throw new StateError('forbidden', 'Source reference field authority changed before commit.');
    }
    await authority.revalidate();
    if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Source reference authority recheck moved beyond the original fence.');
    return true;
  } }));
  return authority.revalidate;
}

/** Native host supplies its actual protected binding. For a receipt owner
 * session it must preserve the exact issued row, including its stage. Copies,
 * host overlays and final-row coincidence cannot establish intermediate proof.
 */
export async function observeScenarioReceiptDependency(call: AdmittedCall, store: StoragePort, input: {
  readonly dependencyId: string; readonly model: ModelName; readonly row: StoredRow; readonly field: string;
}): Promise<void> {
  let state: Capture;
  try { state = capture(call, store); }
  catch (error) {
    const carrier = typeof input === 'object' && input !== null ? Object.getOwnPropertyDescriptor(input, 'row') : undefined;
    if (carrier !== undefined && 'value' in carrier) {
      const issuing = ownerRows.get(carrier.value as StoredRow);
      if (issuing !== undefined) issuing.session.capture.poisoned = true;
    }
    throw error;
  }
  const owner = ownerSessions.get(call);
  let acquired = false;
  try {
    if (state.pending !== 0) return invalid('concurrent observations are forbidden.');
    if (state.returnId !== null) return invalid('observation cannot follow the selected return.');
    const observed = dataCopy(input);
    object(observed, ['dependencyId', 'model', 'row', 'field']);
    const dependency = state.bound.plan.returns.flatMap(entry => entry.dependencies).find(dep => dep.id === observed.dependencyId);
    if (dependency === undefined || dependency.model !== observed.model || dependency.field !== observed.field) return invalid('native observation disagrees with its checked dependency.');
    if (state.observations.length + state.intrinsics.length >= MAX_ITEMS) return invalid('observation budget exceeded.');
    const row = checkedRow(observed.row);
    const nominal = state.bound.nominalDependencies.get(dependency.id);
    const reference = state.bound.referenceDependencies.get(dependency.id);
    if (reference !== undefined) storedReferenceWire(reference.profile, row);
    else if (nominal === undefined) scalarWire(dependency.type, getDataPath(row.data, dependency.field));
    else storedNominalWire(nominal.profile, getDataPath(row.data, dependency.field));
    if (row.archivedAt !== null) return invalid('cannot observe an archived row.');
    if (owner !== undefined) {
      ownerHealthy(owner);
      const issued = ownerRows.get(input.row);
      if (owner.busy || issued?.session !== owner || issued.stage !== owner.stage || issued.model !== observed.model) {
        return invalid('observation requires the actual current-stage owner row.');
      }
      owner.busy = true;
    }
    state.pending += 1; acquired = true;
    let referenceRevalidate: (() => Promise<void>) | undefined;
    if (reference !== undefined) {
      if (owner === undefined) return invalid('source reference capture requires its actual current-stage owner session.');
      referenceRevalidate = await observeReferenceAuthority(call, store, owner, state, dependency.id, row, reference.profile, observed.model);
    }
    const current = await store.load(observed.model, row.id);
    capture(call, store);
    const revision = await store.readRevision();
    capture(call, store);
    if (state.returnId !== null) return invalid('observation must complete before return selection.');
    if (revision !== call.revision) throw new StateError('conflict', 'Scenario observation moved beyond its admitted revision.');
    await referenceRevalidate?.(); capture(call, store);
    if (referenceRevalidate !== undefined) {
      ownerHealthy(owner!);
      if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Source reference final observation moved beyond its admitted revision.');
      capture(call, store); ownerHealthy(owner!);
    }
    const secrets = state.bound.models.get(observed.model)!.secrets;
    if (secrets.length > MAX_ITEMS) return invalid('original secrecy inventory exceeds its finite budget.');
    state.observations.push({ dependencyId: dependency.id, model: observed.model, row,
      secretFields: [...secrets],
      stored: current !== null && stableStringify(current) === stableStringify(row), ownerSession: owner !== undefined });
  } catch (error) { state.poisoned = true; throw error; }
  finally { if (acquired) { state.pending -= 1; if (owner !== undefined) owner.busy = false; } }
}

export type ScenarioReceiptIntrinsicInput = {
  readonly dependencyId: string; readonly kind: 'operation-id'; readonly wire: string;
} | {
  readonly dependencyId: string; readonly kind: 'admitted-input'; readonly wire: unknown;
} | {
  readonly dependencyId: string; readonly kind: 'admitted-reference-version'; readonly wire: string;
  /** Exact original admitted slot, selected only after the host checks its
   * private native binding. Copies and current-stage rows are not this slot. */
  readonly reference: AdmittedCall['recordRefs'][number];
};

/** Host reports an actually evaluated checked intrinsic site. State derives
 * identity/version from its protected admission and checks the host's encoded
 * value. This does not attest native evaluation: the verified generated host
 * must check its actual operation/ref binding before calling this producer.
 */
export async function observeScenarioReceiptIntrinsic(call: AdmittedCall, store: StoragePort,
  input: ScenarioReceiptIntrinsicInput): Promise<void> {
  const state = capture(call, store); const owner = ownerSessions.get(call);
  let acquired = false;
  try {
    if (state.pending !== 0 || owner?.busy === true) return invalid('concurrent observations are forbidden.');
    if (state.returnId !== null) return invalid('observation cannot follow the selected return.');
    if (owner !== undefined) ownerHealthy(owner);
    const observed = dataCopy(input);
    const kind = typeof observed === 'object' && observed !== null ? observed.kind : undefined;
    object(observed, ['dependencyId', 'kind', 'wire',
      ...(kind === 'admitted-reference-version' ? ['reference'] : [])]);
    const dependency = state.bound.plan.returns.flatMap(entry => entry.intrinsics ?? [])
      .find(dep => dep.id === observed.dependencyId);
    if (dependency === undefined || dependency.kind !== observed.kind) return invalid('native intrinsic disagrees with its checked dependency.');
    if (state.observations.length + state.intrinsics.length >= MAX_ITEMS) return invalid('observation budget exceeded.');
    let observation: IntrinsicObservation;
    if (dependency.kind === 'operation-id') {
      if (observed.wire !== call.context.operationId) return invalid('intrinsic identity differs from the admitted operation.');
      observation = { dependencyId: dependency.id, kind: dependency.kind, wire: call.context.operationId };
    } else if (dependency.kind === 'admitted-input') {
      const member = Object.getOwnPropertyDescriptor(call.inputs, dependency.parameter);
      if (member === undefined || !('value' in member) || !member.enumerable) return invalid('intrinsic input must be an own supplied admitted slot.');
      const wire = dataCopy(member.value); scalarWire(dependency.type, wire);
      if (stableStringify(wire) !== stableStringify(observed.wire) ||
          stableStringify(encodeValue(dependency.type, decodeValue(dependency.type, wire))) !== stableStringify(wire)) {
        return invalid('intrinsic input differs from its original canonical admitted wire.');
      }
      observation = { dependencyId: dependency.id, kind: dependency.kind, wire };
    } else {
      const member = Object.getOwnPropertyDescriptor(input, 'reference');
      const reference = call.recordRefs.find(ref => ref.param === dependency.parameter);
      if (member === undefined || !('value' in member) || reference === undefined || member.value !== reference ||
          reference.model !== dependency.model || reference.id !== reference.row.id ||
          reference.expectedVersion !== reference.row.version || observed.wire !== String(reference.row.version)) {
        return invalid('intrinsic version requires its exact original admitted reference and wire.');
      }
      const row = checkedRow(dataCopy(reference.row));
      if (row.archivedAt !== null) return invalid('cannot observe an archived reference.');
      const secrets = state.bound.models.get(reference.model)!.secrets;
      if (secrets.length > MAX_ITEMS) return invalid('original secrecy inventory exceeds its finite budget.');
      observation = { dependencyId: dependency.id, kind: dependency.kind, wire: String(row.version),
        model: reference.model, row, secretFields: [...secrets] };
    }
    if (owner !== undefined) owner.busy = true;
    state.pending += 1; acquired = true;
    if (observation.kind === 'admitted-reference-version') {
      if (activeCalls.has(call)) {
        const reference = call.recordRefs.find(ref => ref.param === (dependency.kind === 'admitted-reference-version' ? dependency.parameter : ''))!;
        const issued = ownerRows.get(reference.row);
        if (owner === undefined || issued?.session !== owner || issued.model !== observation.model || issued.stage > owner.stage) {
          return invalid('child original reference requires its privately admitted owner-stage row.');
        }
      } else {
        const current = await store.load(observation.model, observation.row.id);
        capture(call, store);
        if (current === null || stableStringify(dataCopy(current)) !== stableStringify(observation.row)) {
          return invalid('original admitted reference moved before intrinsic capture.');
        }
      }
    }
    const revision = await store.readRevision(); capture(call, store);
    if (revision !== call.revision) throw new StateError('conflict', 'Scenario intrinsic moved beyond its admitted revision.');
    scalarWire(dependency.type, observation.wire);
    state.intrinsics.push(observation);
  } catch (error) { state.poisoned = true; throw error; }
  finally { if (acquired) { state.pending -= 1; if (owner !== undefined) owner.busy = false; } }
}

/** The emitted selected return path determines required reads; unrelated private
 * decision-only reads do not become dependencies of literal/input results.
 */
export function selectScenarioReceiptReturn(call: AdmittedCall, store: StoragePort, returnId: string): void {
  const state = capture(call, store);
  try {
    if (state.pending !== 0 || ownerSessions.get(call)?.busy === true) { state.poisoned = true; return invalid('return selection cannot precede pending owner reads/observations.'); }
    const returned = state.bound.plan.returns.find(entry => entry.id === returnId);
    if (state.returnId !== null || returned === undefined) return invalid('one actual checked return path required.');
    if (returned.dependencies.some(dep => !state.observations.some(entry => entry.dependencyId === dep.id)) ||
        returned.intrinsics?.some(dep => !state.intrinsics.some(entry => entry.dependencyId === dep.id))) {
      return invalid('required observations must complete before selecting the actual return.');
    }
    requireQueryResult(state, returned, state.queryResult);
    state.returnId = returnId;
  } catch (error) { state.poisoned = true; throw error; }
}

function checkedRow(value: unknown): StoredRow {
  const row = value as StoredRow;
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      typeof row.id !== 'string' || row.id === '' || !Number.isSafeInteger(row.version) || row.version < 1 ||
      !Number.isFinite(row.created) || !Number.isFinite(row.updated) || typeof row.createdBy !== 'string' || typeof row.updatedBy !== 'string' ||
      (row.archivedAt !== null && !Number.isFinite(row.archivedAt)) ||
      typeof row.data !== 'object' || row.data === null || Array.isArray(row.data) ||
      (row.parent !== undefined && row.parent !== null &&
        (typeof row.parent.model !== 'string' || typeof row.parent.id !== 'string'))) return invalid('invalid saved row snapshot.');
  return row;
}

/** Invoke alone calls this after execution; no executor-supplied association is accepted. */
export function retainScenarioReceipt(call: AdmittedCall, effects: ExecutionEffects): ScenarioReceiptAssociation | undefined {
  let state = captures.get(call);
  const owner = ownerSessions.get(call); ownerSessions.delete(call);
  if (owner !== undefined) {
    if (!owner.closed || owner.finalized === null || owner.commitEffects === null || owner.capture.poisoned || owner.capture.pending !== 0) {
      return invalid('owner session must finalize successfully inside its actual execution.');
    }
    for (const key of ['writes', 'history', 'uniqueClaims', 'uniqueReleases', 'resolvedDefaults'] as const) {
      if (stableStringify(dataCopy(effects[key])) !== stableStringify(owner.commitEffects[key])) {
        return invalid(`executor ${key} differ from the actual finalized owner effects.`);
      }
    }
    if (owner.framework !== null && stableStringify(dataCopy(effects.outbox)) !== stableStringify(owner.commitEffects.outbox)) {
      return invalid('executor outbox differs from its actual finalized framework effects.');
    }
    // Duplicate schedule keys use last-operation-wins semantics. An extra
    // cancel/replacement on an owned key would override actual owner effects.
    const keys = new Set(owner.finalized.schedules.map(schedule => schedule.key));
    const owned = effects.schedules.filter(schedule => keys.has(schedule.key));
    if (stableStringify(owned) !== stableStringify(owner.finalized.schedules)) return invalid('executor omitted, changed or overrode an owned schedule.');
  }
  const files = boundPlans.has(call.def as GeneratedOperationDef) ? matchScenarioFileAssignments(call, effects) : [];
  captures.delete(call);
  const writes = owner?.finalized?.writes ?? effects.writes, result = effects.result;
  const bound = boundPlans.get(call.def as GeneratedOperationDef);
  if (bound === undefined) return undefined;
  // One checked empty path permits the ordinary implicit void return. Its
  // success receipt carries no business result and still saves changed rows.
  if (bound.type === 'void' && bound.plan.returns.length === 1 && bound.plan.returns[0]!.dependencies.length === 0 &&
      (bound.plan.returns[0]!.intrinsics?.length ?? 0) === 0) {
    state ??= { bound, returnId: null, poisoned: false, pending: 0, observations: [], intrinsics: [], queries: [], queryResult: undefined, files: [] };
    state.returnId ??= bound.plan.returns[0]!.id;
  }
  if (state === undefined || state.returnId === null) return invalid('checked scenario omitted its actual return capture.');
  if (state.poisoned || state.pending !== 0) return invalid('capture is poisoned or unfinished.');
  resultWire(bound, dataCopy(result));
  const returned = bound.plan.returns.find(entry => entry.id === state.returnId)!;
  requireQueryResult(state, returned, result);
  const required = new Set(returned.dependencies.map(dep => dep.id));
  const observed = state.observations.filter(entry => required.has(entry.dependencyId));
  if (returned.dependencies.some(dep => !observed.some(entry => entry.dependencyId === dep.id))) return invalid('required return dependency was not evaluated/captured.');
  const intrinsicIds = new Set(returned.intrinsics?.map(dep => dep.id));
  const intrinsics = state.intrinsics.filter(entry => intrinsicIds.has(entry.dependencyId));
  if (returned.intrinsics?.some(dep => !intrinsics.some(entry => entry.dependencyId === dep.id))) return invalid('required intrinsic was not evaluated/captured.');
  if (writes.length > MAX_ITEMS) return invalid('changed snapshot budget exceeded.');
  const changed: ScenarioReceiptAssociation['changed'][number][] = [];
  const identities = new Set<string>();
  for (const write of writes) {
    const id = write.kind === 'insert' ? write.row.id : write.id; const key = `${write.model}/${id}`;
    if (identities.has(key)) return invalid('only final net writes can establish changed snapshots.'); identities.add(key);
    if (write.kind === 'remove') continue;
    const model = bound.models.get(write.model);
    if (model === undefined) return invalid('changed row has no defining model inventory.');
    if (model.fields.size > MAX_ITEMS) return invalid('original field inventory exceeds its finite budget.');
    const row = checkedRow(dataCopy(write.row));
    if (row.id !== id) return invalid('changed snapshot identity disagrees with its net write.');
    const assigned = (effects.fileAssignments ?? []).filter(raw => (raw as ScenarioReceiptFileAssignmentLocator).model === write.model &&
      (raw as ScenarioReceiptFileAssignmentLocator).recordId === row.id) as readonly ScenarioReceiptFileAssignmentLocator[];
    const assignedFields = new Set(assigned.map(locator => locator.field));
    changed.push({ model: write.model, row, secretFields: [...model.secrets],
      withheldFields: [...new Set([...model.withheld.filter(field => !assignedFields.has(field)), ...Object.keys(row.data).filter(field => !model.fields.has(field))])],
      fieldTypes: { ...Object.fromEntries(model.fields), ...Object.fromEntries(assigned.map(locator =>
        [locator.field, scenarioFileField(bound, write.model, locator.field).type])) } });
  }
  for (const entry of observed) if (!entry.stored && !entry.ownerSession && !changed.some(change => change.model === entry.model &&
      stableStringify(change.row) === stableStringify(entry.row))) {
    return invalid('provisional read is not the final committed own-row snapshot; owner-session join required.');
  }
  return deepFreeze(dataCopy({ kind: 'scenario-result/v1' as const, plan: bound.plan, resultType: bound.type,
    returnId: state.returnId, observations: observed.map(({ stored: _stored, ownerSession: _ownerSession, ...entry }) => entry),
    ...(Object.hasOwn(effects, 'fileAssignments') ? { fileAssignments: files } : {}),
    ...(owner === undefined || owner.calls.length === 0 ? {} : { calls: owner.calls }),
    ...(returned.intrinsics === undefined ? {} : { intrinsics }), ...queryAssociations(state, returned), changed }));
}

/** Saved type association closes nullable/array wire shapes before any current
 * declaration or physical Files authority is consulted. */
function savedFileRefs(type: CanTypeId, wire: unknown): readonly string[] {
  if (!/^file(\[\])?\??$/.test(type)) return invalid('saved owning File type required.');
  if (wire === null) return type.endsWith('?') ? [] : invalid('nonnullable saved File field.');
  const values = type.includes('[]') ? list(wire) : [wire];
  return values.map(value => text(object(value, ['id'])['id']));
}

/** Legacy receipts are unassociated; malformed recognized metadata refuses. */
export function readScenarioReceiptAssociation(receipt: Receipt): ScenarioReceiptAssociation | null {
  receipt = dataCopy(receipt);
  if (!Object.hasOwn(receipt.outcome, 'scenario')) return null;
  if (receipt.outcome.status !== 'committed') return invalid('association requires a committed outcome.');
  const scenario = dataCopy(receipt.outcome.scenario);
  const value = object(scenario, ['kind', 'plan', 'resultType', 'returnId', 'observations', 'changed',
    ...(typeof scenario === 'object' && scenario !== null && Object.hasOwn(scenario, 'fileAssignments') ? ['fileAssignments'] : []),
    ...(typeof scenario === 'object' && scenario !== null && Object.hasOwn(scenario, 'calls') ? ['calls'] : []),
    ...(typeof scenario === 'object' && scenario !== null && Object.hasOwn(scenario, 'intrinsics') ? ['intrinsics'] : []),
    ...(typeof scenario === 'object' && scenario !== null && Object.hasOwn(scenario, 'queries') ? ['queries'] : [])]);
  if (value['kind'] !== 'scenario-result/v1') return invalid('unknown association version.');
  const plan = checkScenarioResultDisclosurePlan(value['plan']); const resultType = disclosureType(value['resultType'], plan);
  const returned = plan.returns.find(entry => entry.id === value['returnId']);
  if (returned === undefined) return invalid('unknown selected return path.');
  if (returned.projection === undefined) { scalarWire(resultType, receipt.outcome.result); checkSavedQueries(plan, returned, value['queries'], receipt.outcome.result); }
  else checkSavedQueries(plan, returned, value['queries'], receipt.outcome.result);
  const observations = list(value['observations']);
  for (const entry of observations) {
    const observation = object(entry, ['dependencyId', 'model', 'row', 'secretFields']);
    const dependency = returned.dependencies.find(dep => dep.id === observation['dependencyId']);
    if (dependency === undefined || dependency.model !== observation['model']) return invalid('foreign saved dependency.');
    const row = checkedRow(observation['row']); savedDependencyWire(dependency.type, dependencyObservedWire(dependency, row)); paths(observation['secretFields']);
  }
  if (returned.dependencies.some(dep => !observations.some(entry => (entry as Record<string, unknown>)['dependencyId'] === dep.id))) return invalid('missing saved dependency.');
  const intrinsics = list(Object.hasOwn(value, 'intrinsics') ? value['intrinsics'] : []);
  if (observations.length + intrinsics.length > MAX_ITEMS) return invalid('observation budget exceeded.');
  for (const entry of intrinsics) {
    const kind = (entry as Record<string, unknown>)?.['kind'];
    const observation = object(entry, ['dependencyId', 'kind', 'wire',
      ...(kind === 'admitted-reference-version' ? ['model', 'row', 'secretFields'] : [])]);
    const dependency = returned.intrinsics?.find(dep => dep.id === observation['dependencyId']);
    if (dependency === undefined || dependency.kind !== kind) return invalid('foreign saved intrinsic.');
    scalarWire(dependency.type, observation['wire']);
    if (kind === 'operation-id') {
      if (observation['wire'] !== receipt.identity.operationId) return invalid('saved intrinsic identity differs from its receipt.');
    } else if (kind === 'admitted-input') {
      if (stableStringify(encodeValue(dependency.type, decodeValue(dependency.type, observation['wire']))) !==
          stableStringify(observation['wire'])) return invalid('invalid saved canonical input wire.');
    } else {
      const row = checkedRow(observation['row']); paths(observation['secretFields']);
      if (dependency.kind !== 'admitted-reference-version' || dependency.model !== observation['model'] ||
          row.archivedAt !== null || observation['wire'] !== String(row.version)) return invalid('invalid saved original reference version.');
    }
  }
  if (returned.intrinsics?.some(dep => !intrinsics.some(entry => (entry as Record<string, unknown>)['dependencyId'] === dep.id))) {
    return invalid('missing saved intrinsic.');
  }
  const changed = list(value['changed']); const identities = new Set<string>(); let fileFieldCount = 0;
  for (const entry of changed) {
    const change = object(entry, ['model', 'row', 'secretFields', 'withheldFields', 'fieldTypes']); text(change['model']);
    const row = checkedRow(change['row']); paths(change['secretFields']); paths(change['withheldFields']);
    const types = change['fieldTypes'];
    if (typeof types !== 'object' || types === null || Array.isArray(types) || Object.keys(types).length > MAX_ITEMS) return invalid('bounded original field inventory required.');
    for (const [field, type] of Object.entries(types)) {
      if (typeof type === 'string' && /^file(\[\])?\??$/.test(type)) {
        if (++fileFieldCount > MAX_ITEMS) return invalid('saved File field budget exceeded.');
        if (!Object.hasOwn(value, 'fileAssignments') || !Object.hasOwn(row.data, field) ||
            (change['withheldFields'] as string[]).includes(field)) return invalid('saved File field omitted its checked assignment closure.');
        savedFileRefs(type as CanTypeId, row.data[field]);
      } else if (type !== null) scalarType(type);
    }
    const key = `${change['model']}/${row.id}`;
    if (identities.has(key) || !receipt.outcome.recordVersions.some(version => version.model === change['model'] &&
        version.id === row.id && version.version === row.version)) return invalid('changed snapshot disagrees with committed identities.');
    identities.add(key);
  }
  if (changed.length !== receipt.outcome.recordVersions.length) return invalid('incomplete committed changed snapshots.');
  const assignments = list(value['fileAssignments'] ?? []); const assignmentKeys = new Set<string>();
  for (const raw of assignments) {
    const assignment = object(raw, ['model', 'recordId', 'rowVersion', 'field', 'file']);
    const model = text(assignment['model']), id = text(assignment['recordId']), field = text(assignment['field']);
    const file = checkRetainedScenarioFile(assignment['file']);
    const change = changed.find(entry => (entry as Record<string, unknown>)['model'] === model &&
      ((entry as Record<string, unknown>)['row'] as StoredRow).id === id) as ScenarioReceiptAssociation['changed'][number] | undefined;
    const type = change?.fieldTypes[field];
    if (change === undefined || assignment['rowVersion'] !== change.row.version || typeof type !== 'string' ||
        !/^file(\[\])?\??$/.test(type) || !savedFileRefs(type as CanTypeId, change.row.data[field]).includes(file.ref)) {
      return invalid('saved File assignment differs from its committed owning field.');
    }
    const expected = fileReceiver(receipt.identity.app, receipt.identity.principal === 'public' ? null : receipt.identity.principal,
      file.receiver.team === receipt.identity.principal && receipt.identity.owner === 'app' ? null : receipt.identity.owner);
    if (stableStringify(file.receiver) !== stableStringify(expected)) return invalid('saved File receiver differs from its receipt.');
    const key = stableStringify([model, id, field, file.ref]);
    if (assignmentKeys.has(key)) return invalid('duplicate saved File assignment.'); assignmentKeys.add(key);
  }
  for (const raw of changed) {
    const change = raw as ScenarioReceiptAssociation['changed'][number];
    for (const [field, type] of Object.entries(change.fieldTypes)) if (typeof type === 'string' && /^file(\[\])?\??$/.test(type)) {
      for (const ref of new Set(savedFileRefs(type as CanTypeId, change.row.data[field]))) {
        if (!assignmentKeys.has(stableStringify([change.model, change.row.id, field, ref]))) return invalid('incomplete saved File assignment closure.');
      }
    }
  }
  for (const entry of list(value['calls'] ?? [])) {
    const saved = object(entry, ['site', 'caller', 'target', 'targetInterface', 'references', 'result',
      ...(typeof entry === 'object' && entry !== null && Object.hasOwn(entry, 'scenario') ? ['scenario'] : [])]);
    text(saved['site']); text(saved['caller']); text(saved['target']); text(saved['targetInterface']);
    for (const reference of list(saved['references'])) {
      const ref = object(reference, ['model', 'row', 'secretFields']); text(ref['model']); checkedRow(ref['row']); paths(ref['secretFields']);
    }
    if (saved['scenario'] !== undefined) {
      const child = object(saved['scenario'], ['kind', 'plan', 'resultType', 'returnId', 'observations',
        ...(Object.hasOwn(saved['scenario'] as object, 'intrinsics') ? ['intrinsics'] : []),
        ...(Object.hasOwn(saved['scenario'] as object, 'queries') ? ['queries'] : [])]);
      readScenarioReceiptAssociation({ ...receipt, identity: { ...receipt.identity, operation: saved['target'] as Receipt['identity']['operation'] },
        outcome: { status: 'committed', result: saved['result'], recordVersions: [],
          scenario: { ...child, changed: [] } as unknown as ScenarioReceiptAssociation } });
    }
  }
  return deepFreeze(value as unknown as ScenarioReceiptAssociation);
}

export interface ProjectScenarioReceiptInput {
  readonly receipt: Receipt; readonly registry: OperationRegistry; readonly policy: PolicyTable;
  readonly app: string; readonly identity: ResolvedIdentity; readonly store: StoragePort; readonly memberships: MembershipReader;
}

/** Current authority masks saved values, without re-execution or substitution.
 * Missing required influence access withholds result and changed records. This
 * version has no field-level influence map; readable changes cannot launder
 * private data/control. Unknown current inventory fails closed.
 */
export async function projectScenarioReceipt(input: ProjectScenarioReceiptInput): Promise<{
  readonly result: unknown; readonly records: readonly ProjectedRecord[];
}> {
  const receipt = dataCopy(input.receipt); const association = readScenarioReceiptAssociation(receipt);
  if (association === null) return invalid('no supported saved scenario association.');
  const actorUserId = input.identity.actor?.user_id ?? null, teamId = input.identity.team?.team_id ?? null;
  if (receipt.identity.app !== input.app || receipt.identity.owner !== (teamId ?? 'app') ||
      receipt.identity.principal !== (actorUserId ?? 'public')) throw new StateError('forbidden', 'Saved scenario scope does not match the caller.');
  const def = input.registry.get(receipt.identity.operation); const currentBound = boundPlans.get(def as GeneratedOperationDef);
  if (def === undefined || def.name !== receipt.identity.operation || currentBound === undefined) return invalid('current checked scenario inventory required.');
  const fileProducer = fileProducers.get(def as GeneratedOperationDef);
  const receiver = actorUserId === null ? null : fileReceiver(input.app, actorUserId, teamId);
  const fileFields = association.changed.flatMap(change => Object.entries(change.fieldTypes)
    .filter(([, type]) => typeof type === 'string' && /^file(\[\])?\??$/.test(type))
    .map(([field, type]) => ({ change, field, type: type as CanTypeId,
      assignments: (association.fileAssignments ?? []).filter(assignment => assignment.model === change.model &&
        assignment.recordId === change.row.id && assignment.field === field) })));
  const readableFileFields = async (change: ScenarioReceiptAssociation['changed'][number], current: StoredRow | null): Promise<string[]> => {
    if (fileProducer === undefined || fileProducer.app !== input.app || receiver === null || current === null ||
        current.id !== change.row.id || current.version < change.row.version || current.archivedAt !== null ||
        current.created !== change.row.created || current.createdBy !== change.row.createdBy ||
        (current.parent?.model ?? null) !== (change.row.parent?.model ?? null) ||
        (current.parent?.id ?? null) !== (change.row.parent?.id ?? null)) return [];
    const readable: string[] = [];
    for (const entry of fileFields.filter(entry => entry.change === change)) {
      try {
        const profile = scenarioFileField(currentBound, change.model, entry.field);
        if (profile.type !== entry.type || !Object.hasOwn(current.data, entry.field) ||
            stableStringify(current.data[entry.field]) !== stableStringify(change.row.data[entry.field])) continue;
        scenarioFileWireRefs(profile, current.data[entry.field]);
        let valid = true;
        for (const assignment of entry.assignments) {
          if (stableStringify(assignment.file.receiver) !== stableStringify(receiver) ||
              (await fileProducer.revalidate(assignment.file, receiver)) !== true) { valid = false; break; }
        }
        if (valid) readable.push(entry.field);
      } catch { /* Current declaration drift or failed physical checks withhold this field. */ }
    }
    return readable;
  };
  const projectedChanges = new WeakMap<ProjectedRecord, ScenarioReceiptAssociation['changed'][number]>();
  const finalFileProjection = async (projection: { readonly result: unknown; readonly records: readonly ProjectedRecord[] }) => {
    if (fileFields.length === 0) return projection;
    // Complete every State row read before the final external physical checks.
    const pending: Array<{ readonly record: ProjectedRecord; readonly changed: ScenarioReceiptAssociation['changed'][number] | undefined; readonly current: StoredRow | null }> = [];
    for (const record of projection.records) {
      const changed = projectedChanges.get(record);
      pending.push({ record, changed, current: changed === undefined ? null : await input.store.load(changed.model, changed.row.id) });
    }
    const records: ProjectedRecord[] = [];
    for (const { record, changed, current } of pending) {
      if (changed === undefined) { records.push(record); continue; }
      const fields = await readableFileFields(changed, current);
      const data = { ...record.data };
      for (const entry of fileFields.filter(entry => entry.change === changed)) if (!fields.includes(entry.field)) delete data[entry.field];
      records.push({ ...record, data });
    }
    return { result: projection.result, records };
  };
  const revision = await input.store.readRevision();
  const retained = await input.store.readReceipt(receipt.identity);
  if (retained === null || stableStringify(dataCopy(retained)) !== stableStringify(receipt)) return invalid('exact retained receipt required.');
  const authorityFacts = new Map<string, { teamId: string; userId: string; snapshot: string }>();
  let authorityDrift = false;
  let coherentFacts: ReadonlyMap<string, Membership | null> | undefined;
  let unseenAuthority = false;
  const owningSnapshot = Object.getOwnPropertyDescriptor(input.memberships, 'findMembershipsSnapshot');
  const memberships: MembershipReader = {
    ...(owningSnapshot !== undefined && 'value' in owningSnapshot && typeof owningSnapshot.value === 'function' ? {
      findMembershipsSnapshot: async (team: string, users: readonly string[]): Promise<MembershipSnapshot> => {
        if (coherentFacts === undefined) return owningSnapshot.value.call(input.memberships, team, users);
        return { team_id: team, entries: users.map(user => {
          const key = stableStringify([team, user]);
          if (!coherentFacts!.has(key)) {
            unseenAuthority = true;
            throw new StateError('forbidden', 'Nested row grant requested authority absent from the coherent snapshot.');
          }
          return { user_id: user, membership: coherentFacts!.get(key)! };
        }) };
      },
    } : {}),
    async findMembership(team, user) {
      if (coherentFacts !== undefined) {
        const key = stableStringify([team, user]);
        if (!coherentFacts.has(key)) {
          unseenAuthority = true;
          throw new StateError('forbidden', 'Saved scenario authority was absent from the coherent snapshot.');
        }
        return coherentFacts.get(key)!;
      }
      const current = await input.memberships.findMembership(team, user);
      const key = stableStringify([team, user]), snapshot = stableStringify(dataCopy(current));
      const previous = authorityFacts.get(key);
      if (previous !== undefined && previous.snapshot !== snapshot) authorityDrift = true;
      if (previous === undefined) {
        if (authorityFacts.size >= MAX_ITEMS) return invalid('authority observation budget exceeded.');
        authorityFacts.set(key, { teamId: team, userId: user, snapshot });
      }
      return current;
    },
  };
  const membership = () => actorUserId !== null && teamId !== null
    ? memberships.findMembership(teamId, actorUserId) : Promise.resolve(null);
  const live = await membership(); const membershipSnapshot = stableStringify(dataCopy(live));
  const withheld = { result: null, records: [] } as const;
  const project = async (member: Awaited<ReturnType<typeof membership>>) => {
    const context = { actorUserId, teamId, membership: member, memberships };
    if (!await evaluateBy(def.by, context)) return withheld;
    const currentSavedRow = async (model: ModelName, saved: StoredRow) => {
      const current = await input.store.load(model, saved.id); const inventory = currentBound.models.get(model);
      if (inventory === undefined || current === null || current.archivedAt !== null || current.version < saved.version ||
          current.created !== saved.created || current.createdBy !== saved.createdBy ||
          (current.parent?.model ?? null) !== (saved.parent?.model ?? null) ||
          (current.parent?.id ?? null) !== (saved.parent?.id ?? null)) return null;
      return current;
    };
    const savedProjection = async (model: ModelName, saved: StoredRow, originalSecrets: readonly string[], blocked: readonly string[], queryFields: readonly string[] = [], fileFields: readonly string[] = [],
      nominal?: { readonly field: string; readonly profile: StoredNominalFieldProfile },
      reference?: { readonly field: string; readonly profile: StoredReferenceFieldProfile }) => {
      const current = await currentSavedRow(model, saved); const inventory = currentBound.models.get(model);
      if (current === null || inventory === undefined) return null;
      if (nominal !== undefined) {
        const field = Object.getOwnPropertyDescriptor(current.data, nominal.field);
        if (field === undefined || !('value' in field) || !field.enumerable) return null;
        try {
          storedNominalWire(nominal.profile, getDataPath(saved.data, nominal.field));
          storedNominalWire(nominal.profile, field.value);
        } catch { return null; }
      }
      if (reference !== undefined) {
        let currentWire: unknown;
        try { storedReferenceWire(reference.profile, saved); currentWire = storedReferenceWire(reference.profile, current); }
        catch { return null; }
        const policy = input.policy.get(model);
        if (policy === undefined) return null;
        const authority = await projectCurrentRecordForViewerPolicy({ policy, context, row: current });
        const projected = sourceReferenceProjection(reference.profile, authority.record);
        if (!wholeReferenceGrant(policy, authority.allowed, current, reference.profile) || projected === undefined ||
            stableStringify(projected) !== stableStringify(currentWire)) return null;
      }
      return projectSavedRecordForViewer({ policy: input.policy.get(model), context, current, saved,
        originalSecretFields: [...originalSecrets, ...blocked, ...inventory.secrets, ...inventory.withheld.filter(field => !queryFields.includes(field) && !fileFields.includes(field) && field !== nominal?.field && field !== reference?.field)] });
    };
    const dependencyProjection = async (bound: BoundPlan,
      dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number],
      observation: ScenarioReceiptAssociation['observations'][number]) => {
      const reference = bound.referenceDependencies.get(dependency.id);
      if (reference !== undefined) {
        if (stableStringify(reference.dependency) !== stableStringify(dependency)) return null;
        return savedProjection(observation.model, observation.row, observation.secretFields, [], [], [], undefined,
          { field: dependency.field, profile: reference.profile });
      }
      const nominal = bound.nominalDependencies.get(dependency.id);
      if (nominal === undefined) {
        const projection = await savedProjection(observation.model, observation.row, observation.secretFields, []);
        return bound.models.get(observation.model)?.fields.get(dependency.field) === dependency.type ? projection : null;
      }
      if (stableStringify(nominal.dependency) !== stableStringify(dependency)) return null;
      // This exact dependency field alone may pass the internal authority
      // projection. Changed records and embedded reference identities gain no
      // disclosure or dereference grant from an owning stored contract.
      return savedProjection(observation.model, observation.row, observation.secretFields, [], [], [],
        { field: dependency.field, profile: nominal.profile });
    };
    const dependencyReadable = (bound: BoundPlan,
      dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number],
      observation: ScenarioReceiptAssociation['observations'][number], projection: ProjectedRecord | null): boolean => {
      if (projection === null) return false;
      const reference = bound.referenceDependencies.get(dependency.id);
      if (reference !== undefined) {
        const wire = sourceReferenceProjection(reference.profile, projection);
        return wire !== undefined && stableStringify(wire) === stableStringify(storedReferenceWire(reference.profile, observation.row));
      }
      return Object.hasOwn(projection.data, dependency.field) &&
        stableStringify(projection.data[dependency.field]) === stableStringify(observation.row.data[dependency.field]);
    };
    const queryAuthority = async (bound: BoundPlan, saved: { readonly plan: ScenarioResultDisclosurePlan;
      readonly returnId: string; readonly queries?: readonly ScenarioReceiptQueryObservation[] }) => {
      const returned = saved.plan.returns.find(entry => entry.id === saved.returnId);
      if (returned?.projection === undefined) return true;
      const plan = bound.plan.queries?.find(query => query.id === returned.projection!.queryId);
      const observed = saved.queries?.find(query => query.queryId === plan?.id);
      if (plan === undefined || observed === undefined) return false;
      try {
        const currentRows: StoredRow[] = [];
        for (const candidate of observed.candidates) {
          const current = await currentSavedRow(plan.model, candidate.row);
          if (current === null) return false;
          currentRows.push(current);
        }
        await queryRecordsObserved({ model: plan.model, modelDescriptor: queryModelDescriptor(bound, plan), authority: 'viewer',
          policy: input.policy, context: { actorUserId, teamId }, memberships,
          store: { ...input.store, readRevision: () => input.store.readRevision(), query: async () => currentRows },
          archived: plan.archived, ...(plan.order.length === 0 ? {} : { order: plan.order }) }, () => true,
        [...new Set(plan.dependencies.filter(dep => dep.role === 'control').map(dep => dep.field))]);
        return true;
      } catch (error) { if (error instanceof StateError) return false; throw error; }
    };
    let dependenciesReadable = true;
    for (const saved of association.calls ?? []) {
      const caller = input.registry.get(saved.caller), target = input.registry.get(saved.target);
      const calls = caller === undefined ? undefined : callProducers.get(caller as GeneratedOperationDef);
      const site = calls?.sites.find(site => site.id === saved.site);
      const alternative = site?.targets.find(target => target.operation === saved.target);
      if (target === undefined || !isGeneratedOperationDef(target) || alternative === undefined ||
          stableStringify(target.descriptor) !== saved.targetInterface || stableStringify(alternative.interface) !== saved.targetInterface ||
          !await evaluateBy(target.by, context)) { dependenciesReadable = false; continue; }
      for (const ref of saved.references) {
        if (await savedProjection(ref.model, ref.row, ref.secretFields, []) === null) dependenciesReadable = false;
      }
      const child = saved.scenario, current = boundPlans.get(target);
      if (child === undefined) continue;
      if (current === undefined || stableStringify(current.plan) !== stableStringify(child.plan) || current.type !== child.resultType) {
        dependenciesReadable = false; continue;
      }
      const returned = child.plan.returns.find(entry => entry.id === child.returnId)!;
      if (!await queryAuthority(current, child) || !await savedQueriesReadable(current, child, saved.result, (model, row, secrets, blocked) =>
        savedProjection(model, row, secrets, blocked, current.plan.queries?.filter(query => query.model === model).flatMap(query => query.dependencies.map(dep => dep.field)) ?? []))) dependenciesReadable = false;
      for (const observed of child.observations) {
        const dependency = returned.dependencies.find(dep => dep.id === observed.dependencyId)!;
        const projection = await dependencyProjection(current, dependency, observed);
        if (!dependencyReadable(current, dependency, observed, projection)) dependenciesReadable = false;
      }
      for (const observed of child.intrinsics ?? []) {
        const dependency = returned.intrinsics!.find(dep => dep.id === observed.dependencyId)!;
        if (observed.kind === 'operation-id') continue;
        if (observed.kind === 'admitted-input') { if (!primitiveInput(target, dependency)) dependenciesReadable = false; continue; }
        const projection = await savedProjection(observed.model, observed.row, observed.secretFields, []);
        if (!versionedReferenceInput(target, dependency) || projection === null || String(projection.version) !== observed.wire) dependenciesReadable = false;
      }
    }
    const returned = association.plan.returns.find(entry => entry.id === association.returnId)!;
    if (!await queryAuthority(currentBound, association) ||
        !await savedQueriesReadable(currentBound, association, receipt.outcome.status === 'committed' ? receipt.outcome.result : null, (model, row, secrets, blocked) =>
          savedProjection(model, row, secrets, blocked, currentBound.plan.queries?.filter(query => query.model === model).flatMap(query => query.dependencies.map(dep => dep.field)) ?? []))) dependenciesReadable = false;
    for (const observation of association.observations) {
      const dependency = returned.dependencies.find(dep => dep.id === observation.dependencyId)!;
      const projection = await dependencyProjection(currentBound, dependency, observation);
      if (!dependencyReadable(currentBound, dependency, observation, projection)) dependenciesReadable = false;
    }
    for (const observation of association.intrinsics ?? []) {
      const dependency = returned.intrinsics!.find(dep => dep.id === observation.dependencyId)!;
      // Operation id belongs to this exact retained invocation and current
      // operation authority above; it does not confer business-row access.
      if (observation.kind === 'operation-id') continue;
      if (observation.kind === 'admitted-input') {
        if (!primitiveInput(def as GeneratedOperationDef, dependency)) dependenciesReadable = false;
        continue;
      }
      if (!versionedReferenceInput(def as GeneratedOperationDef, dependency)) { dependenciesReadable = false; continue; }
      const projection = await savedProjection(observation.model, observation.row, observation.secretFields, []);
      if (projection === null || String(projection.version) !== observation.wire) dependenciesReadable = false;
    }
    const records: ProjectedRecord[] = [];
    for (const changed of association.changed) {
      const fields = currentBound.models.get(changed.model)?.fields;
      const files = fileFields.some(entry => entry.change === changed)
        ? await readableFileFields(changed, await currentSavedRow(changed.model, changed.row)) : [];
      const drifted = Object.keys(changed.row.data).filter(field => !files.includes(field) &&
        (!Object.hasOwn(changed.fieldTypes, field) || fields?.get(field) !== changed.fieldTypes[field]));
      const record = await savedProjection(changed.model, changed.row, changed.secretFields, [...changed.withheldFields, ...drifted], [], files);
      if (record !== null && dependenciesReadable) { projectedChanges.set(record, changed); records.push(record); }
    }
    return { result: dependenciesReadable && association.resultType === currentBound.type && receipt.outcome.status === 'committed'
      ? dataCopy(receipt.outcome.result) : null, records };
  };
  const first = await project(live);
  if (authorityFacts.size > 1) {
    // Discovery never authorizes this conjunction. One installed statement-time
    // snapshot must contain every same-Team fact; never chunk or replay source.
    const snapshotMethod = Object.getOwnPropertyDescriptor(input.memberships, 'findMembershipsSnapshot');
    if (snapshotMethod === undefined || !('value' in snapshotMethod) || typeof snapshotMethod.value !== 'function' ||
        teamId === null || authorityFacts.size > MAX_MEMBERSHIP_SNAPSHOT_USERS || authorityDrift ||
        [...authorityFacts.values()].some(fact => fact.teamId !== teamId) ||
        await input.store.readRevision() !== revision) return withheld;
    const readSnapshot = snapshotMethod.value as NonNullable<MembershipReader['findMembershipsSnapshot']>;
    const users = Object.freeze([...authorityFacts.values()].map(fact => fact.userId));
    const observed = checkedAuthoritySnapshot(await readSnapshot.call(input.memberships, teamId, users), teamId, users);
    if (await input.store.readRevision() !== revision || [...authorityFacts].some(([key, fact]) =>
      stableStringify(observed.get(key)) !== fact.snapshot)) return withheld;
    coherentFacts = observed;
    const coherentCaller = actorUserId === null ? null : observed.get(stableStringify([teamId, actorUserId]));
    if (coherentCaller === undefined) return withheld;
    let projected: Awaited<ReturnType<typeof project>>;
    try { projected = await project(coherentCaller); }
    catch (error) { if (unseenAuthority) return withheld; throw error; }
    if (unseenAuthority || stableStringify(projected) !== stableStringify(first) ||
        await input.store.readRevision() !== revision) return withheld;
    const final = checkedAuthoritySnapshot(await readSnapshot.call(input.memberships, teamId, users), teamId, users);
    if (users.some(user => { const key = stableStringify([teamId, user]);
      return stableStringify(final.get(key)) !== stableStringify(observed.get(key)); }) ||
        await input.store.readRevision() !== revision) return withheld;
    // The last owning physical read is followed by one retained Identity
    // statement-time check and State fence. Separate stores do not promise
    // atomic or return-time authority; source/discovery is never replayed.
    const finalProjection = await finalFileProjection(projected);
    if (fileFields.length !== 0) {
      const postPhysical = checkedAuthoritySnapshot(await readSnapshot.call(input.memberships, teamId, users), teamId, users);
      if (users.some(user => { const key = stableStringify([teamId, user]);
        return stableStringify(postPhysical.get(key)) !== stableStringify(observed.get(key)); })) return withheld;
    }
    if (await input.store.readRevision() !== revision) return withheld;
    return finalProjection;
  }
  if (await input.store.readRevision() !== revision) return withheld;
  const secondMembership = await membership();
  if (stableStringify(dataCopy(secondMembership)) !== membershipSnapshot ||
      stableStringify(await project(secondMembership)) !== stableStringify(first) || await input.store.readRevision() !== revision) return withheld;
  // Identity storage has its own lifetime: a State revision cannot fence a
  // caller or subject-role revocation during the final projection's reads.
  for (const fact of authorityFacts.values()) {
    if (stableStringify(dataCopy(await input.memberships.findMembership(fact.teamId, fact.userId))) !== fact.snapshot) return withheld;
  }
  if (authorityDrift) return withheld;
  const finalProjection = await finalFileProjection(first);
  // Cover an Identity mutation during the awaited last physical read using
  // the same retained full facts, without another physical/source pass.
  // This finite check does not promise cross-store atomicity or return-time access.
  if (fileFields.length !== 0) for (const fact of authorityFacts.values()) {
    if (stableStringify(dataCopy(await input.memberships.findMembership(fact.teamId, fact.userId))) !== fact.snapshot) return withheld;
  }
  if (await input.store.readRevision() !== revision) return withheld;
  return finalProjection;
}
