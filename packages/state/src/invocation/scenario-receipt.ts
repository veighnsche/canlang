/** Saved scenario disclosure. Compiler supplies the complete checked return
 * closure; the native host reports only actually evaluated private bindings.
 * Capture is available only during invoke, never from a request envelope.
 * This version supports scalar Values profiles, declared scalar fields, reserved row IDs and
 * explicitly checked admitted intrinsics (operation id/primitive input/original ref version).
 * Changed File fields and stored File[] child arguments require genuine live
 * capture, exact owning occurrences and current physical checks.
 * Owning stored contracts support whole-field dependencies. Singular newly
 * created model results use actual owner rows and surviving final inserts.
 * Other nominal/container/File results, Delivery, query influence and
 * absent-reference claims require their defining joins. Empty reads prove none of
 * those facts. Every site is scoped by its checked source return/digest/module.
 */
import type { ArtifactModel, BoundCapabilityRequest, CanonicalInputDef, CanonicalModelDescriptor, CanonicalOperationDescriptor, CanonicalValueTypes, CanTypeId, ClosedInputs, DeliveryRef, DomainWrite, FrameworkFilePayloadOrigin, InvocationRef, ModelName, OutboxIntent, ProjectedRecord, RecordId,
  Receipt, FinalizedFileObservation, FinalizedFileReceiver, RetainedFinalizedFile, ScenarioReceiptFileAssignment, ScenarioReceiptAssociation, ScenarioReceiptIntrinsicDependency, ScenarioReceiptQueryPlan, ScenarioReceiptQueryObservation, ScenarioResultDisclosurePlan, StoragePort, StoredRow } from '@canlang/contracts';
import { decodeValue, encodeValue, parseTypeId, printTypeId, validateValue, makeDeliveryRef, isUserRef, type UserRef, type NormalizedSchema } from '@canlang/values';
import { StateError } from '../errors.js';
import { deepFreeze, getDataPath } from '../internal/own-data.js';
import { buildPolicyTable, evalPredicateForRow, type ByContext, type PolicyTable } from '../policy/grants.js';
import { evaluateBy, type MembershipReader } from '../policy/roles.js';
import { checkedMembershipFact, checkedAuthoritySnapshot, observeRowGrantAuthority } from '../policy/membership-facts.js';
import { queryRecordsObserved, orderSourceReadRecords, projectSavedRecordForViewer, projectCurrentRecordForViewerPolicy, projectSourceRowFields,
  type ObservedQueryResult } from '../query/engine.js';
import { captureSourceReadPolicies, projectInstalledSourceRowAndAncestors, type ViewerSourceReadPolicy } from '../query/source-policy.js';
import { MAX_MEMBERSHIP_SNAPSHOT_USERS, type Membership, type MembershipSnapshot, type ResolvedIdentity } from '@canlang/contracts';
import { admitOwnerStageCall, bindOwnerStageFileInputs, type AdmittedCall } from './admission.js';
import { assertScenarioReceiptExecution, scenarioReceiptMemberships, type ExecutionEffects } from './invoke.js';
import { beginOwnerMutation, type OwnerMutationInput, type OwnerMutationReadView,
  type OwnerMutationSession, type MutationWritesResult } from '../mutation/pipeline.js';
import { ownerMutationBusinessWrites } from '../mutation/source-finalization.js';
import type { GeneratedOperationDef, OperationRegistry } from './registry.js';
import { stableStringify, hashInputs } from './replay.js';
import type { SystemCommandContext, SystemStaging } from '../ports/system.js';
import { stageAuthoredDelivery, type AuthoredSkippedDelivery } from '../receipt/authored-delivery.js';
import { RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL, readReceiptRow } from '../receipt/tables.js';
import { stageGeneratedCrudOwnerCall } from '../mutation/crud.js';
import { generatedCallInputDeclarations, isGeneratedOperationDef } from './registry.js';
import { checkQueries, checkQueryProjection, disclosureType, checkQueryInventory, projectReadQueryProjectionWire, queryProjectionWire, checkSavedQueries, savedQueriesReadable, returnQueryIds } from './scenario-query-plan.js';
import { checkScenarioReceiptMembershipSites, type ScenarioReceiptMembershipSite } from './scenario-membership-plan.js';
export type { ScenarioReceiptMembershipSite } from './scenario-membership-plan.js';
import { readLiveScenarioFile, checkRetainedScenarioFile, scenarioFileField, scenarioFileWireRefs, type ScenarioFileFieldProfile } from './scenario-file-assignment.js';
import { storedNominalType, storedNominalField, storedNominalWire, storedNominalFileRefs, savedNominalWire, type StoredNominalFieldProfile } from './scenario-stored-value.js';
import { storedReferenceField, storedReferenceWire, type StoredReferenceFieldProfile } from './scenario-stored-reference.js';
import { bindScenarioQuerySelection, scenarioQuerySelectionWire, type ScenarioQuerySelectionMetadata, type ScenarioQuerySelectionProfile } from './scenario-query-selection.js';
import { bindScenarioQueryAny, checkDirectPredicateCall, checkSavedScenarioQueryAny, type ScenarioQueryAnyMetadata, type ScenarioQueryAnyProfile } from './scenario-query-any.js';
import { bindScenarioNarrowedFields, scenarioNarrowedFieldControls, type ScenarioNarrowedFieldBinding } from './scenario-narrowed-field.js';
import { FenceConflictError } from '../storage/port.js';
import { evaluateInstalledReadPredicate, type InstalledSourceQueryPredicate } from '../receipt/read-policy-membership.js';
import { bindFileReferenceProfile, fileReferenceOccurrences, type FileReferenceProfile } from '../ports/file-reference-profile.js';
import { bindModelLexicalSnapshotProfile, modelLexicalSnapshotOccurrences,
  type ModelLexicalSnapshotProfile } from '../ports/model-lexical-snapshot.js';

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
        !(parsed.base.kind === 'enum' || /^(int|datetime|text|email|bool|decimal|money|date|duration|currency|user)(\[\])?\??$/.test(type))) {
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
  if (type === 'file[]') return type as CanTypeId;
  try { return scalarType(type); }
  catch { return storedNominalType(type); }
}
function savedDependencyWire(type: CanTypeId, wire: unknown): void {
  if (type === 'file[]') { savedFileRefs(type, wire); return; }
  try { scalarType(type); }
  catch { savedNominalWire(type, wire); return; }
  scalarWire(type, wire);
}
function dependencyObservedWire(dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number], row: StoredRow): unknown {
  if (dependency.field === 'id' && dependency.type === 'text') return row.id;
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
      const dependency = object(item, ['id', 'source', 'role', 'model', 'field', 'type',
        ...(typeof item === 'object' && item !== null && Object.hasOwn(item, 'queryId') ? ['queryId'] : [])]);
      origin(dependency['source']);
      const depId = text(dependency['id']); text(dependency['model']);
      if (dependency['role'] !== 'data' && dependency['role'] !== 'control') return invalid('unknown dependency role.');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text(dependency['field']))) return invalid('only declared direct stored fields or reserved row metadata are supported.');
      dependencyType(dependency['type']);
      if (Object.hasOwn(dependency, 'queryId')) {
        const queryId = text(dependency['queryId']);
        const query = queries.find(query => query.id === queryId);
        if (query === undefined || !influences.some(item => (item as Record<string, unknown>)['queryId'] === queryId) ||
            stableStringify(query.source) !== stableStringify(dependency['source'])) {
          return invalid('candidate-only dependency requires its same source query consumed by this return.');
        }
      }
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
        if (!/^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*$/.test(text(dependency['parameter'])) || !primitiveInputType(dependency['type'])) {
          return invalid('admitted input requires a declared singular parameter path and supported primitive type.');
        }
      } else if (kind === 'admitted-reference-version') {
        text(dependency['model']);
        if (!/^[A-Za-z_][A-Za-z0-9_]*(\/[A-Za-z_][A-Za-z0-9_]*)*$/.test(text(dependency['parameter'])) || dependency['type'] !== 'int') {
          return invalid('original reference version requires a declared singular parameter path and int wire.');
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
/** Candidate syntax is never enough: binding also checks both owning model
 * inventories and the value namespace; saved decoding needs a committed row. */
function modelResultType(type: unknown): ModelName | undefined {
  if (typeof type !== 'string') return undefined;
  try {
    const parsed = parseTypeId(type);
    return printTypeId(parsed) === type && parsed.base.kind === 'nominal' && parsed.base.path.includes('.') &&
      !parsed.array && !parsed.nullable && !parsed.requiredArray ? type as ModelName : undefined;
  } catch { return undefined; }
}
function modelResultWire(result: unknown): RecordId {
  return text(object(result, ['id'])['id']) as RecordId;
}
interface BoundPlan {
  anyQueries: ReadonlyMap<string, ScenarioQueryAnyProfile>;
  readonly plan: ScenarioResultDisclosurePlan; readonly type: CanTypeId; readonly models: ReadonlyMap<ModelName, ModelInventory>;
  readonly resultModel: ModelName | undefined;
  readonly inputs: readonly CanonicalInputDef[];
  readonly arrays: GeneratedOperationDef['inputArrays']; readonly nullableRefs: NonNullable<GeneratedOperationDef['inputNullableRefs']>;
  readonly valueSchema: NormalizedSchema | undefined; readonly parameterStyle: boolean;
  readonly artifactModels: ReadonlyMap<ModelName, ArtifactModel>; readonly valueTypes: CanonicalValueTypes | undefined;
  readonly canonicalModels: readonly CanonicalModelDescriptor[];
  readonly idDependencies: ReadonlyMap<string, ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number]>;
  readonly namedEnumDependencies: ReadonlyMap<string, ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number]>;
  readonly narrowedDependencies: ReadonlyMap<string, ScenarioNarrowedFieldBinding>;
  readonly nominalDependencies: ReadonlyMap<string, { readonly dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number];
    readonly profile: StoredNominalFieldProfile }>;
  readonly referenceDependencies: ReadonlyMap<string, { readonly dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number];
    readonly profile: StoredReferenceFieldProfile }>;
  readonly fileDependencies: ReadonlyMap<string, { readonly dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number];
    readonly profile: ScenarioFileFieldProfile }>;
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
type AssignmentField = { readonly type: CanTypeId; readonly direct: ScenarioFileFieldProfile } |
  { readonly type: CanTypeId; readonly nominal: FileReferenceProfile };
const assignmentFields = new WeakMap<BoundPlan, Map<string, AssignmentField>>();
/** Whole owning declarations select the existing census; values cannot select a profile. */
function assignmentField(bound: BoundPlan, model: ModelName, field: string): AssignmentField {
  const key = stableStringify([model, field]);
  let fields = assignmentFields.get(bound);
  const existing = fields?.get(key); if (existing !== undefined) return existing;
  const declarations = bound.artifactModels.get(model)?.fields.filter(value => value.name === field);
  const declaration = declarations?.[0];
  if (declarations?.length !== 1 || declaration === undefined || declaration.default?.kind === 'derived') return invalid('exact stored File assignment declaration required.');
  let profile: AssignmentField;
  if (declaration.field.kind === 'file') {
    const direct = scenarioFileField(bound, model, field); profile = Object.freeze({ type: direct.type, direct });
  } else {
    if (declaration.field.kind !== 'nominal' && declaration.field.kind !== 'other') return invalid('stored File assignment requires an owning File-bearing nominal.');
    const nominal = bindFileReferenceProfile({ artifactModels: bound.artifactModels, canonicalModels: bound.canonicalModels,
      ...(bound.valueTypes === undefined ? {} : { valueTypes: bound.valueTypes }),
      ...(bound.valueSchema === undefined ? {} : { valueSchema: bound.valueSchema }) }, model, field);
    storedNominalType(nominal.type);
    if (!nominal.fileBearing) return invalid('stored assignment declaration has no File leaves.');
    profile = Object.freeze({ type: nominal.type, nominal });
  }
  if (fields === undefined) { fields = new Map(); assignmentFields.set(bound, fields); }
  fields.set(key, profile); return profile;
}
function assignmentRefs(profile: AssignmentField, wire: unknown): readonly string[] {
  return 'direct' in profile ? scenarioFileWireRefs(profile.direct, wire) : fileReferenceOccurrences(profile.nominal, wire).map(value => value.ref);
}
function hasNominalAssignments(bound: BoundPlan): boolean {
  for (const [model, declaration] of bound.artifactModels) for (const field of declaration.fields) {
    if (field.field.kind !== 'nominal' && field.field.kind !== 'other') continue;
    try { if ('nominal' in assignmentField(bound, model, field.name)) return true; }
    catch { /* A nonreceiving declaration cannot authorize assignment binding. */ }
  }
  return false;
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
    assignmentField(state.bound, locator.model, locator.field);
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
  /** Checked original stored-field occurrence for this exact static CALL slot. */
  readonly fileInputs?: readonly ({ readonly name: string; readonly dependencyId: string } |
    { readonly name: string; readonly parentParameter: string })[];
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
const sendMembershipProducers = new WeakMap<GeneratedOperationDef, BoundMemberships>();
const membershipHandles = new WeakMap<ScenarioReceiptMembershipHandle, {
  readonly def: GeneratedOperationDef; readonly bound: BoundMemberships;
  readonly site: ScenarioReceiptMembershipSite; readonly callIndex: number;
}>();

const sendMembershipHandles = new WeakMap<ScenarioReceiptMembershipHandle, { readonly def: GeneratedOperationDef; readonly bound: BoundMemberships; readonly site: ScenarioReceiptMembershipSite; readonly callIndex: number }>();

export interface ScenarioReceiptMembershipSourceAssociation {
  readonly logical: ScenarioResultDisclosurePlan['source'];
  readonly transport: ScenarioResultDisclosurePlan['source'];
}
const membershipSourceAssociations = new WeakMap<GeneratedOperationDef, ScenarioReceiptMembershipSourceAssociation>();
const membershipSourcesUsed = new WeakSet<GeneratedOperationDef>();

/** The verified native loader supplies both original logical source and its
 * actual emitted callable source. This binds that association to the genuine
 * loaded definition once; shape does not attest executable/source bytes. */
export function bindScenarioReceiptMembershipSource(def: GeneratedOperationDef,
  association: ScenarioReceiptMembershipSourceAssociation): void {
  const bound = boundPlans.get(def);
  if (bound === undefined || invokedPlans.has(def) || membershipSourcesUsed.has(def) || membershipSourceAssociations.has(def)) {
    return invalid('membership source association requires its actual checked definition once before use.');
  }
  const retained = dataCopy(association); object(retained, ['logical', 'transport']);
  origin(retained.logical); origin(retained.transport);
  if (stableStringify(retained.transport) !== stableStringify(bound.plan.source) ||
      retained.logical.path !== retained.transport.path || retained.logical.sha256 !== retained.transport.sha256) {
    return invalid('membership source association differs from its exact original source/installed callable.');
  }
  membershipSourceAssociations.set(def, deepFreeze(retained));
}
function membershipSource(def: GeneratedOperationDef, bound: BoundPlan): ScenarioResultDisclosurePlan['source'] {
  return membershipSourceAssociations.get(def)?.logical ?? bound.plan.source;
}

/** Internal sibling-component loader join; intentionally absent from barrels.
 * It cannot register a definition or grant an active execution. */
export function assertScenarioReceiptMembershipSource(def: GeneratedOperationDef,
  source: ScenarioResultDisclosurePlan['source']): void {
  const bound = boundPlans.get(def);
  if (bound === undefined || invokedPlans.has(def)) return invalid('membership source requires its actual checked definition before execution.');
  const actual = dataCopy(source); origin(actual);
  if (stableStringify(actual) !== stableStringify(membershipSource(def, bound))) return invalid('membership source differs from its owning checked callable.');
  membershipSourcesUsed.add(def);
}
/** Deferred dispatch-lifetime sibling join; intentionally absent from barrels.
 * Unlike the other producers, the dispatch producer binds at drive-fence
 * setup, which inherently follows the staging invoke. The pre-execution veto
 * therefore does not apply here; the checked-source correspondence still
 * does. The source association itself remains established once before
 * execution, so no new correspondence can be invented late. Like the
 * pre-execution assert, this grants no execution frame. */
export function assertScenarioReceiptDispatchMembershipSource(def: GeneratedOperationDef,
  source: ScenarioResultDisclosurePlan['source']): void {
  const bound = boundPlans.get(def);
  if (bound === undefined) return invalid('dispatch membership source requires its actual checked definition.');
  const actual = dataCopy(source); origin(actual);
  if (stableStringify(actual) !== stableStringify(membershipSource(def, bound))) return invalid('membership source differs from its owning checked callable.');
  membershipSourcesUsed.add(def);
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
  if (sites.some(site => site.stage === 'read-policy' || site.stage === 'read-predicate' || site.stage === 'send-dispatch')) return invalid('owner membership producer cannot bind current-read or dispatch lifetimes.');
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

/** Separate source SEND lifetime, never a deferred Work execution handle.
 * Bind after the exact framework guard inventory at the verified loader. */
export function bindScenarioReceiptSendMembershipProducer(def: GeneratedOperationDef,
  producer: ScenarioReceiptMembershipProducer): readonly ScenarioReceiptMembershipHandle[] {
  if (sendMembershipProducers.has(def)) return invalid('one checked source SEND membership binding required.');
  object(producer, ['source', 'app', 'sites', 'capture']);
  if (typeof producer.capture !== 'function') return invalid('literal source SEND argument capture required.');
  const source = dataCopy(producer.source); origin(source); text(producer.app);
  assertScenarioReceiptMembershipSource(def, source);
  const guards = frameworkProducers.get(def)?.sendGuards;
  const sites = checkScenarioReceiptMembershipSites(producer.sites);
  if (guards === undefined || sites.some(site => site.stage !== 'send-dispatch' || site.owner !== def.name ||
      stableStringify(site.source) !== stableStringify(source) || !guards.some(guard =>
        stableStringify(guard.node) === stableStringify(site.node)))) return invalid('source SEND recipe lacks its exact checked guard occurrence.');
  const bound: BoundMemberships = Object.freeze({ source: deepFreeze(source), app: producer.app, sites, capture: producer.capture });
  const handles: ScenarioReceiptMembershipHandle[] = [];
  for (const site of sites) site.calls.forEach((call, callIndex) => {
    if (call.target.kind !== 'builtin' || call.target.id !== 'active_member') return;
    const handle = Object.freeze({}); sendMembershipHandles.set(handle, { def, bound, site, callIndex }); handles.push(handle);
  });
  if (handles.length === 0) return invalid('source SEND requires its exact checked active_member occurrence.');
  sendMembershipProducers.set(def, bound);
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
  return evaluateOwnerMembership(call, store, input, false);
}

export async function evaluateScenarioReceiptSendMembership(call: AdmittedCall, store: StoragePort,
  input: { readonly site: ScenarioReceiptMembershipHandle }): Promise<boolean> {
  return evaluateOwnerMembership(call, store, input, true);
}

async function evaluateOwnerMembership(call: AdmittedCall, store: StoragePort,
  input: { readonly site: ScenarioReceiptMembershipHandle }, send: boolean): Promise<boolean> {
  let owner = membershipOwner(call), state: Capture | undefined; let acquired = false;
  try {
    state = capture(call, store); owner = ownerSessions.get(call);
    object(input, ['site']);
    const issued = (send ? sendMembershipHandles : membershipHandles).get(input.site);
    if (owner === undefined || owner.session === null || issued === undefined || issued.def !== call.def ||
        (send ? sendMembershipProducers : membershipProducers).get(issued.def) !== issued.bound || issued.bound.app !== call.context.app ||
        stableStringify(issued.bound.source) !== stableStringify(membershipSource(issued.def, state.bound)) ||
        (send ? issued.site.stage !== 'send-dispatch' : issued.site.stage === 'send-dispatch') ||
        issued.site.stage === 'read-policy' || issued.site.stage === 'read-predicate') return invalid('membership requires its actual bound source lifetime, never a current-read or deferred dispatch execution.');
    ownerHealthy(owner);
    if (owner.executingCall !== call || state.returnId !== null || state.pending !== 0 || owner.capture.pending !== 0 ||
        issued.site.stage === 'leading-require' && owner.stage !== 0 || owner.callGuards.length >= MAX_ITEMS) return invalid('membership capture is concurrent, completed, stale or outside its authored stage.');
    const activeSend = owner.activeSend;
    if (send ? activeSend === null || activeSend.call !== call || activeSend.stage !== owner.stage ||
        stableStringify(activeSend.guard.node) !== stableStringify(issued.site.node) : activeSend !== null) return invalid('membership differs from its genuine owner or source SEND occurrence.');
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
      if (owner!.executingCall !== call || owner!.stage !== stage || owner!.activeSend !== activeSend || query !== null &&
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
  for (const check of retainedStoredFileChecks.get(call) ?? []) await check();
}
const retainedStoredFileChecks = new WeakMap<AdmittedCall, readonly (() => Promise<void>)[]>();

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
    object(site, ['id', 'source', 'kind', 'targets', 'resultType', ...(Object.hasOwn(site, 'fileInputs') ? ['fileInputs'] : [])]); origin(site.source); text(site.id);
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
    const slots = new Set<string>();
    for (const raw of list(site.fileInputs ?? [])) {
      const stored = typeof raw === 'object' && raw !== null && Object.hasOwn(raw, 'dependencyId');
      const slot = object(raw, stored ? ['name', 'dependencyId'] : ['name', 'parentParameter']);
      const name = text(slot['name']);
      const callee = targets.get(site.targets[0]!.operation)!;
      const field = callee.descriptor.inputs.find(field => field.name === name);
      if (site.kind !== 'operation' || slots.has(name)) return invalid('unique source File CALL slot required.');
      if (stored) {
        const dependency = text(slot['dependencyId']);
        if (!bound.fileDependencies.has(dependency) || field?.kind !== 'file' ||
            field.valueType !== 'file[]' || callee.inputArrays[name]?.required !== false) {
          return invalid('stored File CALL slot differs from its exact source dependency and ordinary File array parameter.');
        }
      } else {
        const parent = text(slot['parentParameter']);
        const sourceField = def.descriptor.inputs.find(input => input.name === parent);
        if (field?.kind !== 'file' || field.valueType !== 'file?' || field.required !== false ||
            sourceField?.kind !== 'file' || sourceField.valueType !== 'file?' || sourceField.required !== false ||
            sourceField.default !== undefined && (sourceField.default.kind !== 'literal' || sourceField.default.value !== null) ||
            Object.hasOwn(callee.inputArrays, name) || Object.hasOwn(def.inputArrays, parent)) {
          return invalid('forwarded File CALL slot differs from its original nullable parent and child inputs.');
        }
      }
      slots.add(name);
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
  if (state.observations.some(entry => storedFileInputs.get(entry)?.used && !observations.includes(entry))) {
    return invalid('child return omitted an evaluated stored File CALL dependency.');
  }
  const intrinsics = (state?.intrinsics ?? []).filter(entry => returned.intrinsics?.some(dep => dep.id === entry.dependencyId));
  requireReturnDependencies(state, returned, observations);
  if (returned.intrinsics?.some(dep => !intrinsics.some(entry => entry.dependencyId === dep.id))) return invalid('child result intrinsic was not evaluated/captured.');
  return deepFreeze(dataCopy({ kind: 'scenario-result/v1' as const, plan: bound.plan, resultType: bound.type, returnId: returned.id,
    observations: observations.map(({ stored: _stored, ownerSession: _ownerSession, ...entry }) => entry),
    ...(returned.intrinsics === undefined ? {} : { intrinsics }),
    ...queryAssociations(state, returned) }));
}

/** Canonical same-owner call. Only the genuine active parent execution can
 * open this finite child lifetime. Admission, all staged effects and every
 * child guard share the unchanged outer fence and one finalization/receipt.
 * Stored File[] slots join the genuine parent capture to their checked site;
 * other protected File/Delivery profiles still require defining producers. */
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
    const state = captures.get(call)!;
    const fileBindings = (site.fileInputs ?? []).filter((slot): slot is { readonly name: string; readonly dependencyId: string } =>
      'dependencyId' in slot).map(slot => {
      const observed = [...state.observations].reverse().find(entry => entry.dependencyId === slot.dependencyId && entry.files !== undefined);
      const issued = observed === undefined ? undefined : storedFileInputs.get(observed);
      if (issued?.call !== call || issued.owner !== owner || issued.stage !== owner!.stage || issued.used) {
        return invalid('File CALL requires its genuine unused current-stage stored dependency.');
      }
      issued.used = true;
      return { name: slot.name, revalidate: issued.revalidate,
        wire: dependencyObservedWire(state.bound.fileDependencies.get(slot.dependencyId)!.dependency, observed!.row) };
    });
    const forwardedFiles = (site.fileInputs ?? []).filter((slot): slot is { readonly name: string; readonly parentParameter: string } =>
      'parentParameter' in slot).map(slot => {
      if (!Object.hasOwn(call.inputs, slot.parentParameter)) {
        // The original optional `file?` parameter evaluates to null when
        // omitted. A nonnull value can never be inferred from its absence.
        return { name: slot.name, wire: null };
      }
      return { name: slot.name, wire: call.inputs[slot.parentParameter] };
    });
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
          wire = encodeValue(type, value as never, undefined, state.bound.valueSchema);
        }
        Object.defineProperty(prepared, name, { value: wire, enumerable: true, configurable: true, writable: true });
      }
    }
    for (const binding of fileBindings) {
      if (!Object.hasOwn(prepared, binding.name) || stableStringify(prepared[binding.name]) !== stableStringify(binding.wire)) {
        return invalid('prepared File CALL slot differs from its captured original stored field.');
      }
      await binding.revalidate(); ownerHealthy(owner);
      if (owner.executingCall !== current) return invalid('stored File admission crossed its actual child lifetime.');
    }
    for (const binding of forwardedFiles) {
      if (!Object.hasOwn(prepared, binding.name) || stableStringify(prepared[binding.name]) !== stableStringify(binding.wire)) {
        return invalid('prepared File CALL slot differs from its original admitted parent input.');
      }
    }
    const storedFiles = fileBindings.length === 0 && forwardedFiles.length === 0 ? undefined :
      bindOwnerStageFileInputs(def, prepared, fileBindings.map(value => value.name), forwardedFiles.map(value => value.name));
    const admitted = await ownerOperation(owner, () => admitOwnerStageCall({ def, inputs: prepared,
      ...(storedFiles === undefined ? {} : { storedFiles }),
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
    const scenario = def.kind === 'scenario' || def.kind === 'read' ? retainedCallScenario(current, raw) : undefined;
    const result = dataCopy(raw);
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
  const plan = checkScenarioResultDisclosurePlan(claim), declared = def.descriptor.result!.type;
  const resultModel = modelResultType(declared);
  if (resultModel !== undefined && (def.kind !== 'scenario' ||
      models.filter(model => model.name === resultModel).length !== 1 ||
      defaults.canonicalModels.filter(model => model.name === resultModel).length !== 1 ||
      defaults.valueSchema !== undefined && (Object.hasOwn(defaults.valueSchema.contracts, resultModel) ||
        Object.hasOwn(defaults.valueSchema.enums, resultModel) || Object.hasOwn(defaults.valueSchema.aliases ?? {}, resultModel)) ||
      plan.returns.some(returned => returned.projection !== undefined))) {
    return invalid('model result requires its unique singular owning model and source profile.');
  }
  const type = resultModel === undefined ? disclosureType(declared, plan) : declared;
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
  const narrowedDependencies = bindScenarioNarrowedFields({ plan, artifactModels, canonicalModels });
  const idDependencies = new Map<string, ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number]>();
  const namedEnumDependencies = new Map<string, ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number]>();
  const nominalDependencies = new Map<string, { readonly dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number];
    readonly profile: StoredNominalFieldProfile }>();
  const referenceDependencies = new Map<string, { readonly dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number];
    readonly profile: StoredReferenceFieldProfile }>();
  const fileDependencies = new Map<string, { readonly dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number];
    readonly profile: ScenarioFileFieldProfile }>();
  for (const returned of plan.returns) for (const dep of returned.dependencies) {
    let scalar = true;
    try { scalarType(dep.type); } catch { scalar = false; }
    if (dep.field === 'id') {
      if (dep.type !== 'text' || !inventory.has(dep.model)) return invalid('row id dependency requires its owning model and reserved text metadata.');
      idDependencies.set(dep.id, dep);
    } else if (scalar) {
      if (inventory.get(dep.model)?.fields.get(dep.field) !== (narrowedDependencies.get(dep.id)?.declarationType ?? dep.type)) return invalid('dependency disagrees with declared model field/type inventory.');
    } else if (dep.type === 'file[]') {
      const profile = scenarioFileField({ artifactModels, canonicalModels }, dep.model, dep.field);
      if (profile.type !== dep.type || !profile.array || profile.nullable) return invalid('stored File dependency disagrees with its owning ordinary array declaration.');
      if (!fileDependencies.has(dep.id)) fileDependencies.set(dep.id, Object.freeze({ dependency: dep, profile }));
    } else if (dep.field === 'parent' || artifactModels.get(dep.model)?.fields.some(field => field.name === dep.field && field.field.kind === 'ref')) {
      if (!referenceDependencies.has(dep.id)) referenceDependencies.set(dep.id, Object.freeze({ dependency: dep,
        profile: storedReferenceField({ artifactModels, canonicalModels, valueSchema: defaults.valueSchema }, dep.model, dep.field,
          narrowedDependencies.get(dep.id)?.declarationType ?? dep.type) }));
    } else if (dep.queryId !== undefined && dep.role === 'data' && dep.field === 'role' &&
        (dep.type === 'TextMessage.role' || dep.type === 'std.TextMessage.role') && (() => {
      const parsed = parseTypeId(dep.type), schema = defaults.valueSchema;
      if (parsed.base.kind !== 'nominal' || parsed.array || parsed.nullable || schema === undefined ||
          !Object.hasOwn(schema.enums, parsed.base.path) || Object.hasOwn(schema.contracts, parsed.base.path) ||
          Object.hasOwn(schema.aliases ?? {}, parsed.base.path) || artifactModels.has(parsed.base.path as ModelName)) return false;
      const fields = artifactModels.get(dep.model)?.fields.filter(field => field.name === dep.field);
      const canonical = canonicalModels.find(model => model.name === dep.model)?.fields[dep.field];
      return fields?.length === 1 && fields[0]!.valueType === dep.type && canonical?.valueType === dep.type &&
        fields[0]!.array === undefined && fields[0]!.nullable !== true &&
        (fields[0]!.field.kind === 'enum' && stableStringify(fields[0]!.field.values) === stableStringify(schema.enums[parsed.base.path]!.cases) ||
          fields[0]!.field.kind === 'nominal' && fields[0]!.field.name === parsed.base.path);
    })()) {
      namedEnumDependencies.set(dep.id, dep);
    } else if (!nominalDependencies.has(dep.id)) {
      const profile = storedNominalField({ artifactModels, canonicalModels, valueSchema: defaults.valueSchema }, dep.model, dep.field, dep.type, { protectedFiles: true });
      nominalDependencies.set(dep.id, Object.freeze({ dependency: dep, profile }));
    }
  }
  for (const returned of plan.returns) for (const dep of returned.intrinsics ?? []) {
    if (dep.kind === 'admitted-reference-version' && (!inventory.has(dep.model) || !versionedReferenceInput(def, dep))) {
      return invalid('original version requires its declared required singular versioned reference input.');
    }
    if (dep.kind === 'admitted-input' && !primitiveInput(def, dep)) return invalid('intrinsic input disagrees with its required singular primitive declaration.');
  }
  // Pure-control scalar returns carry only execution-gating provenance: they
  // read no stored row, so replay needs nothing beyond the declared queries,
  // the recorded inputs and the recorded receipt, all revalidated on read.
  // Admitted intrinsics are replay-stable recorded inputs (parameter values,
  // version-pinned references, operation identity), unlike stored reads.
  // Stored CONTROL-role reads are decision reads, not data grants: they
  // execute under caller authority through the existing receipt machinery
  // (fail-closed for private rows until decision-mode lands), so a scalar
  // return bearing only control reads keeps the same profile. Anything
  // data-bearing keeps the projection-or-model-result demand.
  //
  // Void scenarios carry no result value to shape (the result wire demands
  // null), so there is nothing for a projection or model-result profile to
  // guard. Execution reads on a void path — including effect parent links,
  // bound through the reference profiles above — still execute under caller
  // authority, and the recorded queries, inputs and receipt are all
  // revalidated on replay. The projection demand below therefore applies
  // only to value-bearing returns.
  const pureControl = (returned: ScenarioResultDisclosurePlan['returns'][number]) =>
    returned.dependencies.every(dependency => dependency.role === 'control');
  if (type !== 'void' && resultModel === undefined && plan.returns.some(returned => returned.projection === undefined && returned.influences.length !== 0 && !pureControl(returned))) {
    return invalid('query influences without projection require the singular created-model result profile.');
  }
  if (resultModel === undefined && plan.queries?.some(query => query.dependencies.some(dependency => dependency.type === 'file[]'))) {
    return invalid('protected query File DATA requires its owning intermediate selected-message consumer.');
  }
  if (resultModel !== undefined && plan.queries?.some(query => query.dependencies.some(dep => dep.role === 'data' &&
      !plan.returns.filter(returned => returnQueryIds(returned).includes(query.id)).every(returned => returned.dependencies.some(ordinary =>
        ordinary.queryId === query.id && ordinary.model === query.model && ordinary.field === dep.field && ordinary.type === dep.type && ordinary.role === 'data'))))) {
    return invalid('selected model query DATA requires its complete ordinary owning dependencies.');
  }
  checkQueryInventory(plan, type, models, defaults.valueSchema);
  for (const query of plan.queries ?? []) if (query.parent?.origin.kind === 'admitted-reference' &&
      queryParentInputModel(def, query.parent.origin.parameter, query.parent.model, artifactModels) === undefined) {
    return invalid('query parent requires its declared required singular versioned reference input.');
  }
  boundPlans.set(def, { plan, type, resultModel, anyQueries: new Map(), models: inventory, inputs: deepFreeze(dataCopy(def.descriptor.inputs)),
    arrays: deepFreeze(dataCopy(def.inputArrays)), nullableRefs: deepFreeze(dataCopy(def.inputNullableRefs ?? {})),
    valueSchema: defaults.valueSchema, parameterStyle: defaults.parameterStyle,
    artifactModels, canonicalModels, idDependencies, namedEnumDependencies, narrowedDependencies, nominalDependencies, referenceDependencies, fileDependencies,
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
  readonly stage: (input: ScenarioReceiptSendProducerInput, context: SystemCommandContext, call: AdmittedCall) => Promise<ScenarioReceiptSendStaging>;
  readonly read: (value: unknown, input: ScenarioReceiptSendProducerInput, context: SystemCommandContext) => ScenarioReceiptSendStaging | null;
  readonly sendGuards?: readonly ScenarioReceiptSendGuard[];
  /** Literal verified native adapter executes the complete original predicate
   * with this actual owner read frame and detached encoded lexical inputs. */
  readonly evaluateGuard?: (frame: ScenarioReceiptSendGuardFrame) => Promise<boolean>;
  /** Installed State census adapter prepares the actual new receipt result.
   * The containing owner still checks source, association and stage lifetime. */
  readonly prepareReceiptOrigin?: (frame: ScenarioReceiptDeliveryOriginFrame) => Promise<FrameworkFilePayloadOrigin>;
}
export interface ScenarioReceiptDeliveryOriginFrame {
  readonly call: AdmittedCall;
  readonly model: ArtifactModel;
  readonly row: StoredRow;
  readonly record: StoredRow;
  readonly field: string;
  readonly value: DeliveryRef;
  /** Admitted physical revision; row.data.revision is the reserved commit. */
  readonly revision: number;
  readonly send: OutboxIntent | AuthoredSkippedDelivery;
}
export interface ScenarioReceiptSendGuard {
  readonly rule: string; readonly source: ScenarioResultDisclosurePlan['source']; readonly owner: string;
  readonly node: { readonly start: number; readonly end: number };
  readonly binding: string; readonly target: string;
  readonly inputs: readonly { readonly name: string; readonly type: CanTypeId }[];
  /** Original declared-event field proof; only a genuine due Work admission
   * can supply these two frozen lexical inputs. */
  readonly eventSource?: {
    readonly event: string; readonly handler: string;
    readonly modelField: { readonly name: string; readonly model: string;
      readonly declaration: { readonly start: number; readonly end: number };
      readonly occurrence: { readonly start: number; readonly end: number };
      readonly fields: readonly string[] };
    readonly revisionField: { readonly name: string; readonly type: 'int';
      readonly declaration: { readonly start: number; readonly end: number };
      readonly occurrence: { readonly start: number; readonly end: number } };
    readonly predicate: { readonly start: number; readonly end: number };
    /** Compiler-checked SEND recipient expression, confined to the private
     * reminder handler's exact Appointment.contact -> Contact.email path. */
    readonly recipientPath?: {
      readonly sourceDependencyId: string;
      readonly leafDependencyId: string;
      readonly sourceField: { readonly name: string; readonly model: string;
        readonly node: { readonly start: number; readonly end: number } };
      readonly leafField: { readonly name: string; readonly model: string;
        readonly node: { readonly start: number; readonly end: number } };
    };
  };
}
export interface ScenarioReceiptSendGuardFrame {
  readonly call: AdmittedCall; readonly guard: ScenarioReceiptSendGuard;
  /** Declaration-ordered canonical wires, with singular model inputs captured
   * as frozen source-projected StoredRow snapshots rather than ModelRef wires. */
  readonly inputs: Readonly<Record<string, unknown>>;
}
export interface ScenarioReceiptSourceSendGuard {
  readonly rule: string; readonly source: ScenarioResultDisclosurePlan['source']; readonly owner: string;
  readonly node: { readonly start: number; readonly end: number };
  readonly inputs: Readonly<Record<string, unknown>>;
}
export interface ScenarioReceiptSendProducerInput {
  readonly operationId: string; readonly source: string; readonly occurrenceIndex: number;
  readonly request: BoundCapabilityRequest; readonly originOccurrence: null;
  readonly sourceGuard?: ScenarioReceiptSourceSendGuard;
  readonly correlation?: { readonly requestSource: string; readonly requestRevision: string;
    readonly requestBinding: string; readonly requestFrom: string; readonly requestApp: string; readonly requestOwner: string };
}
export interface ScenarioReceiptSendStaging { readonly effects: SystemStaging; readonly delivery: DeliveryRef }
const frameworkProducers = new WeakMap<GeneratedOperationDef, ScenarioReceiptFrameworkProducer>();
const frameworkModelInputs = new WeakMap<GeneratedOperationDef, ReadonlyMap<string, ReadonlyMap<string, ModelLexicalSnapshotProfile>>>();
export function bindScenarioReceiptFrameworkProducer(def: GeneratedOperationDef, producer: ScenarioReceiptFrameworkProducer): void {
  const bound = boundPlans.get(def);
  if (bound === undefined || frameworkProducers.has(def) || invokedPlans.has(def)) return invalid('framework producer requires one checked source binding before execution.');
  if (typeof producer !== 'object' || producer === null || Array.isArray(producer) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(producer)) ||
      Reflect.ownKeys(producer).length !== (Object.hasOwn(producer, 'sendGuards') ? 7 : 5) + (Object.hasOwn(producer, 'prepareReceiptOrigin') ? 1 : 0) ||
      (Object.hasOwn(producer, 'sendGuards') !== Object.hasOwn(producer, 'evaluateGuard')) ||
      ['source', 'app', 'bindings', 'stage', 'read', ...(Object.hasOwn(producer, 'sendGuards') ? ['sendGuards', 'evaluateGuard'] : []),
        ...(Object.hasOwn(producer, 'prepareReceiptOrigin') ? ['prepareReceiptOrigin'] : [])].some(key => {
        const member = Object.getOwnPropertyDescriptor(producer, key);
        return member === undefined || !('value' in member) || !member.enumerable;
      }) || typeof producer.stage !== 'function' || typeof producer.read !== 'function') return invalid('own closed loader producer required.');
  if (Object.hasOwn(producer, 'evaluateGuard') && typeof producer.evaluateGuard !== 'function') return invalid('literal complete SEND guard adapter required.');
  if (Object.hasOwn(producer, 'prepareReceiptOrigin') && typeof producer.prepareReceiptOrigin !== 'function') return invalid('literal installed receipt census adapter required.');
  const metadata = dataCopy({ source: producer.source, app: producer.app, bindings: producer.bindings,
    ...(producer.sendGuards === undefined ? {} : { sendGuards: producer.sendGuards }) });
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
  const guardRules = new Set<string>(), guardNodes = new Set<string>();
  const modelInputs = new Map<string, ReadonlyMap<string, ModelLexicalSnapshotProfile>>();
  for (const value of list(metadata.sendGuards ?? [])) {
    const guard = object(value, ['rule', 'source', 'owner', 'node', 'binding', 'target', 'inputs',
      ...(Object.hasOwn(value as object, 'eventSource') ? ['eventSource'] : [])]);
    const rule = text(guard['rule']); origin(guard['source']);
    const node = object(guard['node'], ['start', 'end']);
    const occurrence = stableStringify(guard['node']);
    if (guard['owner'] !== def.name || stableStringify(guard['source']) !== stableStringify(bound.plan.source) ||
        !Number.isSafeInteger(node['start']) || !Number.isSafeInteger(node['end']) ||
        (node['start'] as number) < 0 || (node['end'] as number) <= (node['start'] as number) ||
        guardRules.has(rule) || guardNodes.has(occurrence)) return invalid('exact unique owning SEND guard occurrence required.');
    guardRules.add(rule); guardNodes.add(occurrence);
    const binding = metadata.bindings.find(item => item.binding === guard['binding']);
    if (binding === undefined || !binding.targets.some(item => item.source === guard['target'])) return invalid('SEND guard differs from checked binding/target.');
    const inputs = new Set<string>(), models = new Map<string, ModelLexicalSnapshotProfile>();
    const guardInputs = list(guard['inputs']);
    for (const value of guardInputs) {
      const input = object(value, ['name', 'type']), name = text(input['name']), type = text(input['type']);
      const parsed = parseTypeId(type);
      if (inputs.has(name) || printTypeId(parsed) !== type) return invalid('exact unique canonical SEND lexical type required.');
      inputs.add(name);
      // Nullable model inputs use the existing typed ModelRef/null path; a
      // StoredRow snapshot requires an actual singular nonnull owner row.
      const model = parsed.nullable ? undefined : bindModelLexicalSnapshotProfile({ artifactModels: bound.artifactModels, canonicalModels: bound.canonicalModels,
        ...(bound.valueSchema === undefined ? {} : { valueSchema: bound.valueSchema }),
        ...(bound.valueTypes === undefined ? {} : { valueTypes: bound.valueTypes }) }, type as CanTypeId);
      if (model !== undefined) models.set(name, model);
    }
    if (Object.hasOwn(guard, 'eventSource')) {
      const rawEvent = guard['eventSource'];
      const event = object(rawEvent, ['event', 'handler', 'modelField', 'revisionField', 'predicate',
        ...(typeof rawEvent === 'object' && rawEvent !== null && Object.hasOwn(rawEvent, 'recipientPath') ? ['recipientPath'] : [])]);
      const modelField = object(event['modelField'], ['name', 'model', 'declaration', 'occurrence', 'fields']);
      const revisionField = object(event['revisionField'], ['name', 'type', 'declaration', 'occurrence']);
      const interval = (value: unknown) => {
        const span = object(value, ['start', 'end']);
        return Number.isSafeInteger(span['start']) && Number.isSafeInteger(span['end']) &&
          (span['start'] as number) >= 0 && (span['end'] as number) > (span['start'] as number);
      };
      const modelName = text(modelField['model']), modelNameField = text(modelField['name']);
      const revisionName = text(revisionField['name']);
      const fields = list(modelField['fields']).map(text);
      const declaredFields = bound.artifactModels.get(modelName as ModelName)?.fields;
      const ref = def.descriptor.inputs.find(input => input.name === modelNameField);
      const revision = def.descriptor.inputs.find(input => input.name === revisionName);
      if (event['handler'] !== def.name || typeof event['event'] !== 'string' || event['event'] === '' ||
          modelNameField === revisionName || !interval(modelField['declaration']) || !interval(modelField['occurrence']) ||
          !interval(revisionField['declaration']) || !interval(revisionField['occurrence']) || !interval(event['predicate']) ||
          fields.some((field, index) => index > 0 && fields[index - 1]! >= field ||
            declaredFields?.filter(item => item.name === field && item.field.kind !== 'secret').length !== 1) ||
          stableStringify(event['predicate']) !== stableStringify(guard['node']) ||
          ref?.kind !== 'ref' || ref.model !== modelName || !ref.required ||
          Object.hasOwn(def.inputArrays, modelNameField) ||
          revision?.kind !== 'integer' || !revision.required ||
          guardInputs.length !== 2 || !inputs.has('eventTerm') || !inputs.has('eventRevision') ||
          guardInputs.some(value => {
            const input = value as { readonly name: string; readonly type: string };
            return input.name === 'eventTerm' ? input.type !== modelName : input.name !== 'eventRevision' || input.type !== 'int';
          }) ||
          !models.has('eventTerm')) return invalid('event SEND requires its exact declared private field and typed lexical census.');
      if (Object.hasOwn(event, 'recipientPath')) {
        const path = object(event['recipientPath'], ['sourceField', 'leafField', 'sourceDependencyId', 'leafDependencyId']);
        const sourceDependencyId = text(path['sourceDependencyId']), leafDependencyId = text(path['leafDependencyId']);
        const sourceField = object(path['sourceField'], ['name', 'model', 'node']);
        const leafField = object(path['leafField'], ['name', 'model', 'node']);
        const appointment = bound.artifactModels.get('appointments.Appointment' as ModelName);
        const contact = bound.artifactModels.get('customer.Contact' as ModelName);
        const link = appointment?.fields.filter(field => field.name === 'contact');
        const email = contact?.fields.filter(field => field.name === 'email');
        const checkedPair = bound.plan.returns.length > 0 && bound.plan.returns.every(returned => {
          const source = returned.dependencies.filter(dep => dep.id === sourceDependencyId);
          const leaf = returned.dependencies.filter(dep => dep.id === leafDependencyId);
          return source.length === 1 && leaf.length === 1 && source[0]!.role === 'data' && leaf[0]!.role === 'data' &&
            source[0]!.queryId === undefined && leaf[0]!.queryId === undefined &&
            source[0]!.model === 'appointments.Appointment' && source[0]!.field === 'contact' &&
            source[0]!.type === 'customer.Contact' && leaf[0]!.model === 'customer.Contact' && leaf[0]!.field === 'email' &&
            stableStringify(source[0]!.source) === stableStringify(leaf[0]!.source) &&
            stableStringify(source[0]!.source) === stableStringify(bound.plan.source) &&
            returned.dependencies.indexOf(source[0]!) < returned.dependencies.indexOf(leaf[0]!);
        });
        if (def.name !== 'appointments.remind' || event['event'] !== 'appointments.Reminder' ||
            modelName !== 'appointments.Appointment' || modelNameField !== 'appointment' || revisionName !== 'revision' ||
            sourceDependencyId === leafDependencyId || !checkedPair ||
            sourceField['model'] !== modelName || sourceField['name'] !== 'contact' ||
            leafField['model'] !== 'customer.Contact' || leafField['name'] !== 'email' ||
            !interval(sourceField['node']) || !interval(leafField['node']) ||
            (sourceField['node'] as { start: number }).start !== (leafField['node'] as { start: number }).start ||
            (sourceField['node'] as { end: number }).end >= (leafField['node'] as { end: number }).end ||
            !fields.includes('contact') || link?.length !== 1 || link[0]!.field.kind !== 'ref' ||
            link[0]!.field.model !== 'customer.Contact' || !link[0]!.required ||
            link[0]!.array !== undefined || link[0]!.nullable === true ||
            email?.length !== 1 || email[0]!.field.kind !== 'string' || email[0]!.valueType !== 'email' ||
            !email[0]!.required || email[0]!.nullable === true || email[0]!.array !== undefined) {
          return invalid('event SEND recipient requires its exact declared Appointment.contact and Contact.email expression.');
        }
      }
    }
    modelInputs.set(rule, models);
  }
  frameworkProducers.set(def, Object.freeze({ ...deepFreeze(metadata), stage: producer.stage, read: producer.read,
    ...(producer.evaluateGuard === undefined ? {} : { evaluateGuard: producer.evaluateGuard }),
    ...(producer.prepareReceiptOrigin === undefined ? {} : { prepareReceiptOrigin: producer.prepareReceiptOrigin }) }));
  frameworkModelInputs.set(def, modelInputs);
}

function primitiveInputType(type: unknown): type is CanTypeId {
  return typeof type === 'string' && /^(text|bool|int|date|datetime|decimal|money|duration|currency|user)$/.test(type);
}

/** The compiler's bounded private Work profiles use frozen Rule slot names
 * in their receipt intrinsics. At admission the handler still has the exact
 * declared event input names; no arbitrary handler gets this alias. */
function declaredEventIntrinsic(def: GeneratedOperationDef): { readonly modelField: string; readonly model: ModelName } | undefined {
  if (def.name === 'agreements.notice') return { modelField: 'term', model: 'agreements.Term' as ModelName };
  if (def.name === 'agreements.due') return { modelField: 'obligation', model: 'agreements.Obligation' as ModelName };
  if (def.name === 'appointments.remind') return { modelField: 'appointment', model: 'appointments.Appointment' as ModelName };
  return undefined;
}

function admittedEventIntrinsic(call: AdmittedCall, parameter: string): ScenarioReceiptSendGuard['eventSource'] | undefined {
  if (parameter !== 'eventTerm' && parameter !== 'eventRevision') return undefined;
  const def = call.def as GeneratedOperationDef, expected = declaredEventIntrinsic(def);
  const sources = frameworkProducers.get(def)?.sendGuards?.flatMap(guard => guard.eventSource === undefined ? [] : [guard.eventSource]) ?? [];
  const source = sources.length === 1 ? sources[0] : undefined;
  const due = dueWorkAdmissions.get(call);
  if (expected === undefined || source === undefined || source.handler !== def.name ||
      source.modelField.name !== expected.modelField || source.modelField.model !== expected.model ||
      source.revisionField.name !== 'revision' || due?.event !== source.event || due.eventPayload === undefined ||
      call.context.kind !== 'trusted' || call.context.source !== 'schedule' ||
      call.context.trustedSource !== `schedule:${source.event}`) {
    return invalid('event intrinsic requires its original due Work source and checked private handler.');
  }
  return source;
}

/** The only non-containment read admitted from a due event is the checked
 * reminder SEND recipient. Its two ordered receipt dependencies must name the
 * exact stored link and email leaf in one source/return; a same-model row or
 * free-standing Contact reference is never sufficient. */
function admittedEventRecipientDependencies(call: AdmittedCall, state: Capture): {
  readonly sourceId: string; readonly leafId: string;
} | undefined {
  if (call.def.name !== 'appointments.remind') return undefined;
  const source = admittedEventIntrinsic(call, 'eventTerm');
  if (source?.recipientPath?.sourceField.name !== 'contact' ||
      source.recipientPath.sourceField.model !== 'appointments.Appointment' ||
      source.recipientPath.leafField.name !== 'email' ||
      source.recipientPath.leafField.model !== 'customer.Contact') return undefined;
  const sourceId = source.recipientPath.sourceDependencyId, leafId = source.recipientPath.leafDependencyId;
  if (sourceId === leafId || state.bound.referenceDependencies.get(sourceId)?.profile.kind !== 'field' ||
      state.bound.plan.returns.length === 0 || !state.bound.plan.returns.every(returned => {
        const link = returned.dependencies.find(dependency => dependency.id === sourceId);
        const leaf = returned.dependencies.find(dependency => dependency.id === leafId);
        return link?.role === 'data' && leaf?.role === 'data' && link.queryId === undefined && leaf.queryId === undefined &&
          link.model === 'appointments.Appointment' && link.field === 'contact' && link.type === 'customer.Contact' &&
          leaf.model === 'customer.Contact' && leaf.field === 'email' &&
          returned.dependencies.indexOf(link) < returned.dependencies.indexOf(leaf);
      })) return undefined;
  return { sourceId, leafId };
}

/** Exact required Contract fields from the original same-load input schema.
 * A stored Model is a terminal slot: walking its fields would require a stored
 * observation rather than an admitted-input intrinsic. */
function contractInputLeaf(def: GeneratedOperationDef, parameter: string): { readonly type: string; readonly model?: string } | undefined {
  const path = parameter.split('/');
  if (path.length < 2 || path.length > 65 || path.some(segment => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment))) return undefined;
  const root = def.descriptor.inputs.find(field => field.name === path[0]);
  const declarations = generatedCallInputDeclarations(def);
  if (root?.kind !== 'nominal' || !root.required || root.default !== undefined || root.computedDefault === true ||
      root.valueType === undefined || def.inputArrays[root.name] !== undefined || declarations === undefined) return undefined;
  let type = parseTypeId(root.valueType);
  for (const segment of path.slice(1)) {
    if (type.array || type.nullable || type.requiredArray || type.base.kind !== 'nominal' ||
        declarations.modelNames.has(type.base.path) || !Object.hasOwn(declarations.valueSchema.contracts, type.base.path)) return undefined;
    const contract = declarations.valueSchema.contracts[type.base.path]!;
    const field = Object.hasOwn(contract.fields, segment) ? contract.fields[segment] : undefined;
    if (field === undefined || !field.required || field.hasDefault || field.serverOnly || field.defaultOrigin !== undefined ||
        field.type.array || field.type.nullable || field.type.requiredArray) return undefined;
    type = field.type;
  }
  if (type.base.kind === 'nominal') {
    if (declarations.modelNames.has(type.base.path)) return { type: printTypeId(type), model: type.base.path };
    const alias = declarations.valueSchema.aliases !== undefined && Object.hasOwn(declarations.valueSchema.aliases, type.base.path)
      ? declarations.valueSchema.aliases[type.base.path] : undefined;
    if (alias !== undefined && !alias.type.array && !alias.type.nullable && !alias.type.requiredArray) type = alias.type;
  }
  return { type: printTypeId(type) };
}

/** Read admitted JSON without invoking an accessor or following a prototype. */
function admittedInputWire(inputs: ClosedInputs, parameter: string): unknown {
  let value: unknown = inputs;
  for (const segment of parameter.split('/')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid('intrinsic input must be an own supplied admitted slot.');
    const member = Object.getOwnPropertyDescriptor(value, segment);
    if (member === undefined || !('value' in member) || !member.enumerable) return invalid('intrinsic input must be an own supplied admitted slot.');
    value = member.value;
  }
  return value;
}

function primitiveInput(def: GeneratedOperationDef, dependency: ScenarioReceiptIntrinsicDependency): boolean {
  if (dependency.kind !== 'admitted-input') return false;
  if (dependency.parameter === 'eventRevision') {
    if (declaredEventIntrinsic(def) === undefined || dependency.type !== 'int') return false;
    return primitiveInput(def, { ...dependency, parameter: 'revision' });
  }
  if (dependency.parameter.includes('/')) {
    const leaf = contractInputLeaf(def, dependency.parameter);
    return leaf !== undefined && leaf.model === undefined && primitiveInputType(leaf.type) && leaf.type === dependency.type;
  }
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
    (type === base || input.kind === 'string' && (type === 'date' || type === 'currency'));
}

function versionedReferenceInput(def: GeneratedOperationDef, dependency: ScenarioReceiptIntrinsicDependency): boolean {
  if (dependency.kind !== 'admitted-reference-version') return false;
  if (dependency.parameter === 'eventTerm') {
    const event = declaredEventIntrinsic(def);
    const input = def.descriptor.inputs.find(field => field.name === event?.modelField);
    return event !== undefined && dependency.model === event.model && input?.kind === 'ref' &&
      input.model === event.model && input.required && input.nullable !== true &&
      input.default === undefined && input.computedDefault !== true &&
      def.inputArrays[input.name] === undefined;
  }
  return requiredVersionedReferenceInput(def, dependency.parameter, dependency.model);
}
function requiredVersionedReferenceInput(def: GeneratedOperationDef, parameter: string, model: ModelName): boolean {
  if (parameter.includes('/')) return contractInputLeaf(def, parameter)?.model === model;
  const input = def.descriptor.inputs.find(field => field.name === parameter);
  return input?.kind === 'ref' && input.model === model && input.required && input.versioned &&
    def.inputArrays[parameter] === undefined && def.inputNullableRefs?.[parameter] !== true;
}
/** Declared required singular versioned reference input model for a parameter, if any. */
function versionedReferenceInputModel(def: GeneratedOperationDef, parameter: string): ModelName | undefined {
  if (parameter.includes('/')) return contractInputLeaf(def, parameter)?.model as ModelName | undefined;
  const input = def.descriptor.inputs.find(field => field.name === parameter);
  return input?.kind === 'ref' && input.required && input.versioned &&
    def.inputArrays[parameter] === undefined && def.inputNullableRefs?.[parameter] !== true
    ? input.model as ModelName : undefined;
}
/** Exact one-hop containment navigation for a query parent edge: the named
 * parameter is a declared required versioned reference whose model is a
 * stored child of the query parent model. Direct same-model inputs keep
 * their existing path with no hop; anything else stays refused. */
function queryParentInputModel(def: GeneratedOperationDef, parameter: string, parent: ModelName,
    artifactModels: ReadonlyMap<ModelName, ArtifactModel>): ModelName | undefined {
  const input = versionedReferenceInputModel(def, parameter);
  if (input === undefined) return undefined;
  if (input === parent) return input;
  return artifactModels.get(input)?.parent === parent ? input : undefined;
}
/** A first-query parent edge is honored only for the exact checked admitted
 * containment: the same checked source, the declared required versioned
 * parent parameter (direct same-model input, or one exact containment hop
 * off a declared child input), the model's actual containment parent, and
 * installed viewer authority over the parent. A foreign, denied or tampered
 * parent keeps the first refusal. */
function checkedFirstQueryParent(bound: BoundPlan, def: GeneratedOperationDef,
  query: NonNullable<BoundPlan['plan']['queries']>[number],
  policy: PolicyTable, readPolicies: ReadonlyMap<ModelName, ViewerSourceReadPolicy> | undefined): boolean {
  const parent = query.parent;
  if (parent === undefined) return true;
  if (parent.origin.kind !== 'admitted-reference' ||
      stableStringify(parent.source) !== stableStringify(query.source) ||
      stableStringify(parent.source) !== stableStringify(bound.plan.source) ||
      queryParentInputModel(def, parent.origin.parameter, parent.model, bound.artifactModels) === undefined ||
      bound.artifactModels.get(query.model)?.parent !== parent.model) return false;
  if (policy.has(parent.model)) return true;
  const read = readPolicies?.get(parent.model);
  return read !== undefined && 'grants' in read;
}

type IntrinsicObservation = NonNullable<ScenarioReceiptAssociation['intrinsics']>[number];

/** Installed current viewer policy for checked stored reference influence.
 * Source field capture confers no authority over any referenced record. */
export interface ScenarioReceiptReferenceProducer {
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly app: string;
  readonly policy: PolicyTable;
  /** Complete original current read declarations, captured by the same verified
   * loader. Required for newly-created model results and complete field-grant
   * projection of original SEND model lexicals and reserved row ID dependencies. Bind the framework producer
   * first when SEND lexicals are this definition's only reference consumer. */
  readonly readPolicies?: ReadonlyMap<ModelName, ViewerSourceReadPolicy>;
  /** Verified Require reads of a scalar or whole Contract from an original first selection.
   * These are execution guards, independently of the selected result closure. */
  readonly executionSites?: readonly ScenarioReceiptMembershipSite[];
  readonly executionDependencies?: readonly {
    readonly siteIndex: number; readonly queryId: string;
    readonly node: { readonly start: number; readonly end: number };
    readonly dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number];
  }[];
}
type ExecutionDependency = NonNullable<ScenarioReceiptReferenceProducer['executionDependencies']>[number];
type BoundExecutionDependency = { readonly association: ExecutionDependency; readonly profile: StoredNominalFieldProfile | undefined };
const executedDependencies = new WeakMap<Capture, Set<string>>();
const referenceProducers = new WeakMap<GeneratedOperationDef, ScenarioReceiptReferenceProducer & {
  readonly boundExecutionDependencies: ReadonlyMap<string, BoundExecutionDependency>;
}>();
export function bindScenarioReceiptReferenceProducer(def: GeneratedOperationDef, producer: ScenarioReceiptReferenceProducer): void {
  const bound = boundPlans.get(def);
  const modelInputs = frameworkModelInputs.get(def);
  if (bound === undefined || bound.referenceDependencies.size === 0 && bound.fileDependencies.size === 0 && !Object.hasOwn(producer, 'executionDependencies') &&
      ![...bound.nominalDependencies.values()].some(value => value.profile.hasFiles) && bound.idDependencies.size === 0 && bound.resultModel === undefined &&
      !bound.plan.queries?.some(query => query.parent !== undefined || query.dependencies.some(dep => dep.field === 'parent')) &&
      ![...modelInputs?.values() ?? []].some(inputs => inputs.size !== 0) && !(def.kind === 'scenario' && hasNominalAssignments(bound)) || invokedPlans.has(def) || referenceProducers.has(def)) {
    return invalid('reference producer requires one checked source binding before execution.');
  }
  object(producer, ['source', 'app', 'policy', ...(Object.hasOwn(producer, 'readPolicies') ? ['readPolicies'] : []),
    ...(Object.hasOwn(producer, 'executionDependencies') ? ['executionDependencies'] : []),
    ...(Object.hasOwn(producer, 'executionSites') ? ['executionSites'] : [])]); origin(producer.source); text(producer.app);
  if (stableStringify(dataCopy(producer.source)) !== stableStringify(bound.plan.source) || !(producer.policy instanceof Map)) {
    return invalid('reference producer differs from its checked source/policy.');
  }
  const policy = buildPolicyTable([...Map.prototype.entries.call(producer.policy)].map(([model, value]) => {
    const copied = dataCopy(value);
    if (copied.model !== model) return invalid('reference policy model differs from its owning key.');
    return copied;
  }), bound.canonicalModels);
  const readPolicies = producer.readPolicies === undefined ? undefined : captureSourceReadPolicies(producer.readPolicies);
  for (const { dependency } of bound.referenceDependencies.values()) {
    if (!readPolicies?.has(dependency.model)) {
      if (!policy.has(dependency.model)) return invalid('reference source model requires its actual viewer policy.');
      continue;
    }
    let model: ModelName | undefined = dependency.model;
    const seen = new Set<ModelName>();
    while (model !== undefined) {
      const declaration = bound.artifactModels.get(model), read = readPolicies.get(model);
      if (seen.has(model) || declaration === undefined || read === undefined || read.parent !== declaration.parent ||
          !('grants' in read) && !policy.has(model)) return invalid('reference source requires its exact complete ancestor policies.');
      seen.add(model); model = declaration.parent as ModelName | undefined;
    }
    if (!('grants' in readPolicies.get(dependency.model)!) && !policy.has(dependency.model)) {
      return invalid('reference source model requires its actual whole field policy.');
    }
  }
  if ([...bound.fileDependencies.values()].some(value => {
    const read = readPolicies?.get(value.dependency.model); return read === undefined || !('grants' in read);
  })) return invalid('stored File dependencies require their complete original source field grants.');
  for (const value of bound.nominalDependencies.values()) if (value.profile.hasFiles) {
    let model: ModelName | undefined = value.dependency.model;
    const seen = new Set<ModelName>();
    while (model !== undefined) {
      const declaration = bound.artifactModels.get(model), read = readPolicies?.get(model);
      if (seen.has(model) || declaration === undefined || read === undefined || read.parent !== declaration.parent ||
          !('grants' in read) && (!policy.has(model) || model === value.dependency.model)) {
        return invalid('protected stored contracts require their exact complete source and ancestor policies.');
      }
      seen.add(model); model = declaration.parent as ModelName | undefined;
    }
  }
  if ([...bound.idDependencies.values()].some(dependency => {
    const read = readPolicies?.get(dependency.model); return read === undefined || !('grants' in read);
  })) return invalid('row id dependencies require their complete original source field grants.');
  if (bound.resultModel !== undefined && (readPolicies === undefined || !readPolicies.has(bound.resultModel))) {
    return invalid('model result requires its installed original source read policy.');
  }
  if (bound.resultModel !== undefined && bound.plan.queries?.some(query => {
    const read = readPolicies?.get(query.model); return read === undefined || !('grants' in read);
  })) return invalid('model query influences require their complete original source field grants.');
  if (bound.plan.queries?.some(query => (query.parent !== undefined || query.dependencies.some(dep => dep.field === 'parent')) &&
      [query.model, ...(query.parent === undefined ? [] : [query.parent.model])].some(model =>
        readPolicies?.get(model) === undefined || !('grants' in readPolicies.get(model)!)))) {
    return invalid('parent query metadata requires its complete original source and ancestor grants.');
  }
  if ([...modelInputs?.values() ?? []].some(inputs => [...inputs.values()].some(model => {
    const read = readPolicies?.get(model.model); return read === undefined || !('grants' in read);
  }))) return invalid('model SEND lexical inputs require their complete original source field grants.');
  if (Object.hasOwn(producer, 'executionSites') !== Object.hasOwn(producer, 'executionDependencies') ||
      Object.hasOwn(producer, 'executionDependencies') && (!Array.isArray(producer.executionDependencies) ||
        producer.executionDependencies.length === 0 || !Array.isArray(producer.executionSites))) {
    return invalid('execution Contract dependencies require their original checked source sites.');
  }
  const sites = producer.executionSites === undefined ? [] : checkScenarioReceiptMembershipSites(producer.executionSites);
  if (producer.executionSites !== undefined) {
    const source = membershipSource(def, bound);
    assertScenarioReceiptMembershipSource(def, source);
    if (sites.some(site => site.owner !== def.name || stableStringify(site.source) !== stableStringify(source))) {
      return invalid('execution Contract sites differ from their exact canonical owner/source.');
    }
  }
  const executions = new Map<string, BoundExecutionDependency>();
  for (const raw of list(dataCopy(producer.executionDependencies ?? []))) {
    object(raw, ['siteIndex', 'queryId', 'node', 'dependency']);
    const value = raw as ExecutionDependency;
    object(value.node, ['start', 'end']);
    const dep = value.dependency;
    object(dep, ['id', 'source', 'role', 'model', 'field', 'type']);
    text(dep.id); text(dep.model); text(dep.field); origin(dep.source); text(value.queryId);
    const site = sites[value.siteIndex];
    const query = bound.plan.queries?.find(query => query.id === value.queryId);
    const seatPair = query === undefined ? undefined : countFirstSeatShape(def, bound, query.id);
    const seatFirstMark = queryProducers.get(def)?.first?.find(mark => mark.queryId === query?.id);
    const seatGuardOverlap = seatPair !== undefined && seatFirstMark?.targetConsumed === true &&
      seatFirstMark.guardConsumed === true && site?.stage === 'body-require' &&
      dep.model === seatPair.first.model &&
      dep.field === 'active' && dep.type === 'bool' && dep.role === 'control' &&
      value.node.start >= seatFirstMark.statement.end;
    if (!Number.isSafeInteger(value.siteIndex) || value.siteIndex < 0 ||
        site === undefined || site.owner !== def.name || !['leading-require', 'body-require'].includes(site.stage) ||
        stableStringify(dep.source) !== stableStringify(site.source) ||
        !Number.isSafeInteger(value.node.start) || !Number.isSafeInteger(value.node.end) ||
        value.node.start < site.node.start || value.node.end <= value.node.start || value.node.end > site.node.end ||
        dep.role !== 'control' || query === undefined || query.model !== dep.model ||
        stableStringify(query.source) !== stableStringify(bound.plan.source) ||
        executions.has(dep.id) ||
        // DESIGN442 (0411): a guard-consumed decision read keeps its execution
        // capture despite return-dep status. The compiler emits the overlap
        // only for the single guard-consumed first query of the model, and
        // the owner grant independently requires the checked mark plus the
        // same single-query scalar shape; the result path keeps its own
        // checks. Every other overlap keeps the result path exactly.
        (bound.plan.returns.some(returned => returned.dependencies.some(other => other.id === dep.id)) &&
          !((bound.plan.queries?.length ?? 0) === 1 && bound.resultModel === undefined &&
            query.dependencies.some(item => item.role === 'control' && item.field !== 'parent' && item.field === dep.field)) &&
          !seatGuardOverlap) ||
        bound.plan.queries?.some(query => query.dependencies.some(other => other.id === dep.id))) {
      return invalid('execution Contract dependency requires its exact owning Require, first query and unique occurrence.');
    }
    let profile: StoredNominalFieldProfile | undefined;
    if (/^(int|datetime|text|bool|decimal|money|date|duration|currency|user)$/.test(dep.type)) {
      if (bound.models.get(dep.model)?.fields.get(dep.field) !== scalarType(dep.type)) {
        return invalid('execution scalar dependency differs from its exact declared field type.');
      }
    } else {
      profile = storedNominalField(bound, dep.model, dep.field, dep.type);
      if (profile.array || profile.nullable || profile.hasFiles) return invalid('execution dependency requires its singular ordinary whole Contract.');
    }
    let model: ModelName | undefined = dep.model;
    const seen = new Set<ModelName>();
    while (model !== undefined) {
      const declaration = bound.artifactModels.get(model), read = readPolicies?.get(model);
      if (seen.has(model) || declaration === undefined || read === undefined || read.parent !== declaration.parent ||
          !('grants' in read) && (!policy.has(model) || model === dep.model)) {
        return invalid('execution Contract dependency requires its complete original source field grants.');
      }
      seen.add(model); model = declaration.parent as ModelName | undefined;
    }
    executions.set(dep.id, Object.freeze({ association: deepFreeze(value), profile }));
  }
  referenceProducers.set(def, Object.freeze({ source: bound.plan.source, app: producer.app, policy, boundExecutionDependencies: executions,
    ...(readPolicies === undefined ? {} : { readPolicies }) }));
}

export type ScenarioReceiptAnyPredicate = (candidate: {
  readonly slot: ScenarioReceiptQuerySlot; readonly record: ProjectedRecord;
}) => boolean | Promise<boolean>;

/** Loader-only policy wiring, bound to the same checked source and app. */
/** Original checked Let(first) occurrence; no result-disclosure edge is implied. */
export interface ScenarioReceiptQueryFirstMetadata {
  readonly queryId: string;
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly query: { readonly start: number; readonly end: number };
  readonly node: { readonly start: number; readonly end: number };
  readonly statement: { readonly start: number; readonly end: number };
  /** DESIGN442 guard-consumed mark: the confined hook slice consumes this
   * occurrence only as a decision and grants nothing. Honored only with a
   * bound execution dependency for the same query; ordinary viewer behavior
   * is unchanged everywhere else. */
  readonly guardConsumed?: true;
  /** DESIGN442 presence-consumed mark: the same confined slice whose
   * `Require` consumes only the first binding's presence (no stored-field
   * read, hence no execution dependency). Honored only for the single-query
   * decision shape with no bound execution reads for the query. */
  readonly presenceConsumed?: true;
  /** Exact void null-branch create-or-update target, independently proved by
   * the compiler; no selected field flows into values or a result. */
  readonly targetConsumed?: true;
}
/** The checked paid-seat assignment has one pre-write capacity count followed
 * by one first-selected create/reactivation target. The ordered query plan is
 * the compiler's source inventory; both occurrences retain the same admitted
 * Term parent and their exact CONTROL fields. No other void query pair gains
 * owner-domain authority from a first marker. */
function countFirstSeatShape(def: GeneratedOperationDef, bound: BoundPlan,
  firstQueryId: string): { readonly count: ScenarioReceiptQueryPlan; readonly first: ScenarioReceiptQueryPlan } | undefined {
  const queries = bound.plan.queries;
  if (def.name !== 'member_terms.assign' || bound.type !== 'void' || bound.resultModel !== undefined ||
      queries?.length !== 2 || queries[1]?.id !== firstQueryId) return undefined;
  const [count, first] = queries;
  if (count === undefined || first === undefined || count.id === first.id ||
      count.model !== 'member_terms.Seat' || first.model !== count.model ||
      count.parent?.model !== 'member_terms.Term' || count.parent.origin.kind !== 'admitted-reference' ||
      count.parent.origin.parameter !== 'term' ||
      stableStringify(count.parent) !== stableStringify(first.parent) ||
      stableStringify(count.source) !== stableStringify(bound.plan.source) ||
      stableStringify(first.source) !== stableStringify(bound.plan.source) ||
      count.archived !== 'exclude' || first.archived !== 'exclude' ||
      count.limit !== null || first.limit !== null || count.order.length !== 0 ||
      first.order.length !== 1 || first.order[0]?.field !== 'id' || first.order[0].direction !== 'asc' ||
      count.dependencies.length !== 1 || count.dependencies[0]?.role !== 'control' ||
      count.dependencies[0].field !== 'active' || count.dependencies[0].type !== 'bool' ||
      first.dependencies.length !== 1 || first.dependencies[0]?.role !== 'control' ||
      first.dependencies[0].field !== 'account' || first.dependencies[0].type !== 'user' ||
      bound.plan.returns.length === 0 ||
      !bound.plan.returns.every(returned => {
        const ids = returnQueryIds(returned);
        return ids.length === 2 && ids.includes(count.id) && ids.includes(first.id);
      }) || queryParentInputModel(def, 'term', count.parent.model, bound.artifactModels) !== count.parent.model ||
      bound.artifactModels.get(count.model)?.parent !== count.parent.model) return undefined;
  return { count, first };
}
function firstQueryNode(value: unknown): { readonly start: number; readonly end: number } {
  const node = object(value, ['start', 'end']);
  if (!Number.isSafeInteger(node.start) || !Number.isSafeInteger(node.end) ||
      (node.start as number) < 0 || (node.end as number) <= (node.start as number)) return invalid('first requires its exact source interval.');
  return { start: node.start as number, end: node.end as number };
}
export interface ScenarioReceiptQueryProducer {
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly app: string;
  readonly policy: PolicyTable;
  /** Original installed source grants, including row rules and ancestors.
   * Functions receive State's actual current observation, never a root actor fallback. */
  readonly readPolicies?: ReadonlyMap<ModelName, ViewerSourceReadPolicy>;
  readonly selections?: readonly ScenarioQuerySelectionMetadata[];
  readonly first?: readonly ScenarioReceiptQueryFirstMetadata[];
  /** Literal checked stored-bool or finite first-read predicate ANY profiles. */
  readonly any?: readonly ScenarioQueryAnyMetadata[];
  /** Verified host consumes the exact active source closure synchronously.
   * Captures include the original once-evaluated outer arguments; metadata
   * or a copied function cannot create this call/query execution lifetime. */
  readonly captureAnyPredicate?: (call: AdmittedCall, queryId: string) => ScenarioReceiptAnyPredicate;
}
const queryProducers = new WeakMap<GeneratedOperationDef, ScenarioReceiptQueryProducer>();
const querySelections = new WeakMap<GeneratedOperationDef, ReadonlyMap<string, ScenarioQuerySelectionProfile>>();
export function bindScenarioReceiptQueryProducer(def: GeneratedOperationDef, producer: ScenarioReceiptQueryProducer): void {
  const bound = boundPlans.get(def);
  if (bound === undefined || !bound.plan.queries?.length || invokedPlans.has(def) || queryProducers.has(def)) return invalid('query producer requires one checked source binding before execution.');
  object(producer, ['source', 'app', 'policy', ...(Object.hasOwn(producer, 'readPolicies') ? ['readPolicies'] : []), ...(Object.hasOwn(producer, 'selections') ? ['selections'] : []), ...(Object.hasOwn(producer, 'first') ? ['first'] : []), ...(Object.hasOwn(producer, 'any') ? ['any'] : []), ...(Object.hasOwn(producer, 'captureAnyPredicate') ? ['captureAnyPredicate'] : [])]); origin(producer.source); text(producer.app);
  if (stableStringify(dataCopy(producer.source)) !== stableStringify(bound.plan.source) || !(producer.policy instanceof Map)) return invalid('query producer differs from its checked source/policy.');
  const policies = [...producer.policy].map(([model, value]) => {
    const copied = dataCopy(value);
    if (copied.model !== model) return invalid('query policy model differs from its owning key.');
    return copied;
  });
  // A detached policy must be validated anew against the registry's real
  // canonical declarations so its private row field bindings survive copying.
  const policy = buildPolicyTable(policies, bound.canonicalModels);
  let readPolicies: ReadonlyMap<ModelName, ViewerSourceReadPolicy> | undefined;
  if (Object.hasOwn(producer, 'readPolicies')) {
    if (!(producer.readPolicies instanceof Map) || Object.getPrototypeOf(producer.readPolicies) !== Map.prototype ||
        Reflect.ownKeys(producer.readPolicies).length !== 0) return invalid('query requires its own original source policy map.');
    readPolicies = captureSourceReadPolicies(new Map(Map.prototype.entries.call(producer.readPolicies)));
    for (const query of bound.plan.queries) {
      let model: ModelName | undefined = query.model;
      const seen = new Set<ModelName>();
      while (model !== undefined) {
        const declaration = bound.artifactModels.get(model), read = readPolicies.get(model);
        if (seen.has(model) || declaration === undefined || read === undefined || read.parent !== declaration.parent ||
            !('grants' in read) && !policy.has(model)) return invalid('query source requires its exact owning model and complete ancestor policies.');
        seen.add(model); model = declaration.parent as ModelName | undefined;
      }
    }
  }
  if (bound.plan.queries.some(query => !policy.has(query.model) &&
      (readPolicies?.get(query.model) === undefined || !('grants' in readPolicies.get(query.model)!)))) return invalid('query model requires its actual viewer policy.');
  const first: ScenarioReceiptQueryFirstMetadata[] = [];
  for (const raw of list(dataCopy(producer.first ?? []))) {
    const rawObject = typeof raw === 'object' && raw !== null ? raw : undefined;
    const metadata = object(raw, ['queryId', 'source', 'query', 'node', 'statement',
      ...(rawObject !== undefined && Object.hasOwn(rawObject, 'guardConsumed') ? ['guardConsumed'] : []),
      ...(rawObject !== undefined && Object.hasOwn(rawObject, 'presenceConsumed') ? ['presenceConsumed'] : []),
      ...(rawObject !== undefined && Object.hasOwn(rawObject, 'targetConsumed') ? ['targetConsumed'] : [])]);
    const queryId = text(metadata.queryId), query = bound.plan.queries.find(query => query.id === queryId);
    origin(metadata.source);
    if (rawObject !== undefined && Object.hasOwn(rawObject, 'guardConsumed') && metadata.guardConsumed !== true ||
        rawObject !== undefined && Object.hasOwn(rawObject, 'presenceConsumed') && metadata.presenceConsumed !== true ||
        rawObject !== undefined && Object.hasOwn(rawObject, 'targetConsumed') && metadata.targetConsumed !== true ||
        metadata.targetConsumed === true && (metadata.presenceConsumed === true ||
          metadata.guardConsumed === true && countFirstSeatShape(def, bound, queryId) === undefined)) {
      return invalid('first guard mark requires its exact checked decision-consumed occurrence.');
    }
    const interval = firstQueryNode(metadata.query), node = firstQueryNode(metadata.node), statement = firstQueryNode(metadata.statement);
    const containedOrderOnlyTarget = metadata.targetConsumed === true && query?.parent !== undefined &&
      query.order.length === 1 && bound.plan.queries?.length === 1 &&
      bound.resultModel === undefined && bound.type === 'void';
    if (query === undefined || !checkedFirstQueryParent(bound, def, query, policy, readPolicies) || query.limit !== null || query.archived !== 'exclude' ||
        query.dependencies.length === 0 && !containedOrderOnlyTarget ||
        query.dependencies.some(dependency => dependency.role !== 'control' ||
          (!['bool','int','decimal','text','money','date','datetime','duration','currency','user'].includes(dependency.type) &&
            !(dependency.type.length > 0 && bound.artifactModels.get(query.model)?.fields.some(field => field.name === dependency.field &&
              typeof field.field === 'object' && field.field !== null &&
              (field.field as { kind?: unknown }).kind === 'enum' &&
              Array.isArray((field.field as { values?: unknown }).values) &&
              (field.field as { values: unknown[] }).values.length > 0)))) ||
        new Set(query.dependencies.map(dependency => dependency.id)).size !== query.dependencies.length ||
        query.order.some(order => order.field !== 'id' || order.direction !== 'asc') ||
        stableStringify(metadata.source) !== stableStringify(query.source) ||
        stableStringify(metadata.source) !== stableStringify(bound.plan.source) ||
        interval.start < node.start || interval.end > node.end || node.start < statement.start || node.end > statement.end || first.some(value => value.queryId === queryId ||
          value.node.start === node.start && value.node.end === node.end)) return invalid('first requires its unique original unscoped checked Let and call.');
    first.push({ queryId, source: query.source, query: interval, node, statement,
      ...(metadata.guardConsumed === true ? { guardConsumed: true as const } : {}),
      ...(metadata.presenceConsumed === true ? { presenceConsumed: true as const } : {}),
      ...(metadata.targetConsumed === true ? { targetConsumed: true as const } : {}) });
  }
  const selections = new Map<string, ScenarioQuerySelectionProfile>();
  for (const metadata of list(dataCopy(producer.selections ?? []))) {
    const profile = bindScenarioQuerySelection(bound, metadata as ScenarioQuerySelectionMetadata);
    if (bound.resultModel === undefined || selections.has(profile.queryId) ||
        bound.plan.queries?.find(query => query.id === profile.queryId)?.parent === undefined || readPolicies === undefined ||
        !('grants' in readPolicies.get(profile.model)!)) return invalid('selected messages require their exact contained created-model consumer and source grants.');
    selections.set(profile.queryId, profile);
  }
  if (bound.plan.queries.some(query => query.dependencies.some(dependency => dependency.role === 'data') &&
      bound.resultModel !== undefined && !selections.has(query.id))) return invalid('intermediate DATA query requires its checked selected-message recipe.');
  const anyQueries = new Map<string, ScenarioQueryAnyProfile>();
  for (const metadata of list(dataCopy(producer.any ?? []))) {
    const any = metadata as ScenarioQueryAnyMetadata;
    const owner = membershipProducers.get(def);
    // A direct leading-any guard carries no helper owner census, so it
    // cannot satisfy the membership-producer association below. Its exact
    // checked call record is verified here instead against the installed
    // owner/source producer; the `direct` bit alone authorizes nothing.
    if ('kind' in any && any.kind === 'predicate' && (any as { direct?: unknown }).direct === true) {
      const query = bound.plan.queries?.find(query => query.id === any.queryId);
      if (query === undefined) return invalid('direct predicate requires its exact checked query.');
      checkDirectPredicateCall(def.name, bound.plan.source, query, (any as { sourceCall?: unknown }).sourceCall,
        (any as { call?: unknown }).call);
    } else if ('kind' in any && any.kind === 'predicate' && any.sourceCall !== undefined &&
        (owner === undefined || owner.app !== producer.app || stableStringify(owner.source) !== stableStringify(membershipSource(def, bound)))) {
      return invalid('imported predicate query requires this definition actual bound owner source producer.');
    }
    const profile = bindScenarioQueryAny(bound, any, owner === undefined ? undefined : {
      owner: def.name, source: membershipSource(def, bound), sites: owner.sites,
    });
    // Void effect-tail workflows carry no created-model consumer; their
    // bound ANY profile is already sealed and source grants still apply.
    if ((bound.resultModel === undefined && bound.type !== 'void') || selections.has(profile.queryId) || anyQueries.has(profile.queryId) ||
        readPolicies === undefined || !('grants' in readPolicies.get(profile.model)!)) return invalid('ANY requires its contained created-model consumer and original source grants.');
    anyQueries.set(profile.queryId, profile);
  }
  const predicates = [...anyQueries.values()].some(profile => profile.kind === 'predicate');
  if (predicates && typeof producer.captureAnyPredicate !== 'function' ||
      !predicates && Object.hasOwn(producer, 'captureAnyPredicate')) return invalid('predicate ANY requires its installed source capture producer.');
  bound.anyQueries = anyQueries;
  querySelections.set(def, selections);
  queryProducers.set(def, Object.freeze({ source: bound.plan.source, app: producer.app, policy,
    ...(readPolicies === undefined ? {} : { readPolicies }),
    ...(first.length === 0 ? {} : { first: deepFreeze(first) }),
    ...(producer.captureAnyPredicate === undefined ? {} : { captureAnyPredicate: producer.captureAnyPredicate }) }));
}
function countFirstSeatProfile(def: GeneratedOperationDef, bound: BoundPlan): {
  readonly count: ScenarioReceiptQueryPlan;
  readonly first: ScenarioReceiptQueryPlan;
  readonly activeDependencyId: string;
} | undefined {
  const producer = queryProducers.get(def), mark = producer?.first?.[0];
  if (producer?.first?.length !== 1 || mark?.targetConsumed !== true || mark.guardConsumed !== true ||
      mark.presenceConsumed === true || bound.anyQueries.size !== 0 ||
      querySelections.get(def)?.size !== 0) return undefined;
  const shape = countFirstSeatShape(def, bound, mark.queryId);
  if (shape === undefined) return undefined;
  const seatRead = producer.readPolicies?.get(shape.count.model);
  const termRead = producer.readPolicies?.get(shape.count.parent!.model);
  if (seatRead === undefined || !('grants' in seatRead) ||
      termRead === undefined || !('grants' in termRead)) return undefined;
  const matching = [...referenceProducers.get(def)?.boundExecutionDependencies.values() ?? []]
    .filter(value => value.association.queryId === shape.first.id);
  const active = matching[0];
  if (matching.length !== 1 || active?.association.dependency.model !== shape.first.model ||
      active.association.dependency.field !== 'active' || active.association.dependency.type !== 'bool' ||
      active.association.dependency.role !== 'control' ||
      active.association.node.start < mark.statement.end) return undefined;
  return { ...shape, activeDependencyId: active.association.dependency.id };
}
/** Query source authority comes from its exact installed consumer. Legacy
 * reference producer behavior remains when no query-owned map supplies it. */
function querySourceProducer(def: GeneratedOperationDef, model: ModelName): ScenarioReceiptReferenceProducer | undefined {
  const query = queryProducers.get(def);
  return query?.readPolicies?.has(model) ? query : referenceProducers.get(def);
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
  readonly ownerDecision: boolean;
  readonly plan: ScenarioReceiptQueryPlan; readonly handle: ScenarioReceiptQueryHandle;
  parent?: NonNullable<ScenarioReceiptQueryObservation['parent']>;
  readonly candidates: { readonly row: StoredRow; readonly record: ProjectedRecord;
    readonly slot: ScenarioReceiptQuerySlot; readonly dependencies: Set<string>;
    readonly reads: Map<string, number>; readonly markers: Map<string, number>;
    pendingRead: string | null; matched: boolean; readonly parentRows: StoredRow[] }[];
  selectedIndices: readonly number[];
  activeSlot: ScenarioReceiptQuerySlot | null;
  complete: boolean;
  firstSelected: boolean;
  countSelected: boolean;
  anyConsumed: boolean;
  selectionConsumed: boolean;
  selectionSlot: ScenarioReceiptQuerySlot | null;
}
const queryHandles = new WeakMap<ScenarioReceiptQueryHandle, QueryExecution>();
const querySlots = new WeakMap<ScenarioReceiptQuerySlot, { execution: QueryExecution; index: number }>();

/** Source sees read-tracking getters only while its original predicate is live.
 * The saved snapshot and selected result always retain the private plain row. */
function queryPredicateRecord(execution: QueryExecution, index: number, store: StoragePort): ProjectedRecord {
  const candidate = execution.candidates[index]!, data: Record<string, unknown> = {};
  const predicate = capture(execution.call, store).bound.anyQueries.get(execution.plan.id)?.kind === 'predicate';
  const read = (field: string, value: () => unknown): unknown => {
    try {
      const state = capture(execution.call, store), owner = execution.owner;
      ownerHealthy(owner);
      if (owner.executingCall !== execution.call || owner.stage !== execution.stage ||
          execution.activeSlot !== candidate.slot || !owner.busy || state.pending !== 0 || state.returnId !== null) {
        return invalid('query field read requires its original active predicate candidate.');
      }
      if (candidate.pendingRead !== null) return invalid('query field read omitted its immediate source marker.');
      if (!execution.plan.dependencies.some(dep => dep.role === 'control' && dep.field === field)) return invalid('query predicate read is outside its checked control closure.');
      if (predicate && !Object.hasOwn(candidate.record.data, field)) {
        throw new StateError('forbidden', 'Executed predicate CONTROL field is not readable.');
      }
      const observed = value();
      candidate.pendingRead = field;
      candidate.reads.set(field, (candidate.reads.get(field) ?? 0) + 1);
      return observed;
    } catch (error) { execution.owner.capture.poisoned = true; throw error; }
  };
  const fields = predicate ? [...new Set([...Object.keys(candidate.record.data),
    ...execution.plan.dependencies.filter(dependency => dependency.role === 'control').map(dependency => dependency.field)])]
    : Object.keys(candidate.record.data);
  for (const field of fields) Object.defineProperty(data, field, {
    enumerable: true, get: () => read(field, () => candidate.record.data[field]),
  });
  const record = { ...candidate.record, data: Object.freeze(data) };
  Object.defineProperty(record, 'parent', { enumerable: true, get: () => read('parent', () => {
    const parent = candidate.row.parent;
    if (parent == null || !execution.plan.dependencies.some(dep => dep.field === 'parent' && dep.type === parent.model) ||
        stableStringify(parent) !== stableStringify(candidate.record.parent)) return invalid('query requires its actual declared owner-row parent metadata.');
    return parent;
  }) });
  return Object.freeze(record);
}
function resultWire(bound: BoundPlan, result: unknown): void {
  if (bound.resultModel !== undefined) { modelResultWire(result); return; }
  if (!bound.plan.returns.some(entry => entry.projection !== undefined)) { scalarWire(bound.type, result); return; }
  if (bound.valueSchema === undefined) return invalid('query result requires its owning loaded Values schema.');
  try {
    const canonical = encodeValue(bound.type, validateValue(bound.valueSchema, bound.type, result, 'create'), undefined, bound.valueSchema);
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
  if (state?.queries.some(query => queryProducers.get(query.call.def as GeneratedOperationDef)?.first?.some(value => value.queryId === query.plan.id) && (!query.complete || !query.firstSelected))) {
    return invalid('executed first query requires its actual completed original consumption.');
  }
  if (state?.bound.resultModel !== undefined && (state.modelResult?.returnId !== returned.id ||
      state.modelResult.wire !== result)) return invalid('model return requires its actual privately bound current-stage row and wire.');
  if (returned.projection === undefined) {
    if (returnQueryIds(returned).some(id => !state?.queries.some(query => query.plan.id === id && query.complete && (query.firstSelected || query.countSelected || query.selectionConsumed || query.anyConsumed)))) {
      return invalid('model query influence requires its actual completed first, count, ANY or selected-value consumption, including empty.');
    }
    return;
  }
  if (state === undefined || state.queryResult === undefined || stableStringify(state.queryResult) !== stableStringify(result) ||
      !state.queries.some(query => query.complete && query.plan.id === returned.projection!.queryId)) return invalid('query return requires its actual issued ordered result binding, including empty.');
}
function queryAssociations(state: Capture, returned: ScenarioResultDisclosurePlan['returns'][number]): { queries?: readonly ScenarioReceiptQueryObservation[] } {
  const ids = returnQueryIds(returned);
  if (ids.length === 0) return {};
  const observations = { queries: ids.map(id => {
    const query = state.queries.find(value => value.plan.id === id && value.complete)!;
    const secrets = state.bound.models.get(query.plan.model)!.secrets;
    return { queryId: query.plan.id, revision: query.call.revision,
      ...(query.parent === undefined ? {} : { parent: query.parent }),
      candidates: query.candidates.map(candidate => ({ row: candidate.row, record: candidate.record, matched: candidate.matched,
        secretFields: [...secrets], dependencies: [...candidate.dependencies] })), selectedIndices: [...query.selectedIndices] };
  }) };
  for (const observed of observations.queries) {
    const profile = state.bound.anyQueries.get(observed.queryId);
    if (profile !== undefined) checkSavedScenarioQueryAny(profile, observed);
  }
  checkSavedQueries(state.bound.plan, returned, observations.queries, state.bound.resultModel === undefined ? state.queryResult : state.modelResult?.wire, state.bound.valueSchema);
  return observations;
}

type DependencyObservation = ScenarioReceiptAssociation['observations'][number];
// Attribution is issued only after the ordinary observer finishes at the
// genuine active candidate. A declaration or copied row cannot manufacture it.
const queryLinkedObservations = new WeakMap<DependencyObservation, {
  readonly execution: QueryExecution; readonly slot: ScenarioReceiptQuerySlot;
}>();
const narrowedControlInputs = new WeakMap<DependencyObservation, {
  readonly call: AdmittedCall; readonly owner: ReceiptOwnerSession; readonly stage: number; readonly row: StoredRow;
}>();

function capturedNarrowedControl(call: AdmittedCall, owner: ReceiptOwnerSession | undefined, state: Capture,
  binding: ScenarioNarrowedFieldBinding, row: StoredRow): void {
  const controls = scenarioNarrowedFieldControls(binding);
  const wire = dependencyObservedWire(binding.data, row);
  if (wire === null) return invalid('required narrowed occurrence cannot observe null.');
  savedDependencyWire(binding.declarationType, wire); savedDependencyWire(binding.data.type, wire);
  // A required reference CONTROL is the actual nonnull typed read itself.
  // Its ordinary observer still verifies the genuine owner row and authority.
  if (binding.data.role === 'control') return;
  for (const control of controls) {
    const observations = state.observations.filter(observation => observation.dependencyId === control.id);
    const observation = observations[0], issued = observation === undefined ? undefined : narrowedControlInputs.get(observation);
    if (owner === undefined || observations.length !== 1 || issued?.call !== call || issued.owner !== owner ||
        issued.stage !== owner.stage || issued.row !== row || observation!.model !== binding.data.model ||
        stableStringify(observation!.row) !== stableStringify(row)) return invalid('narrowed DATA requires every genuine same-row CONTROL at the original stage.');
    if (stableStringify(wire) !== stableStringify(dependencyObservedWire(control, observation!.row))) {
      return invalid('narrowed DATA requires each original nonnull CONTROL wire.');
    }
  }
}

function savedNarrowedControls(bound: BoundPlan, observations: readonly DependencyObservation[]): boolean {
  for (const observation of observations) {
    const binding = bound.narrowedDependencies.get(observation.dependencyId);
    if (binding === undefined) continue;
    try {
      const wire = dependencyObservedWire(binding.data, observation.row);
      if (wire === null) return false;
      savedDependencyWire(binding.declarationType, wire); savedDependencyWire(binding.data.type, wire);
    } catch { return false; }
    if (binding.data.role === 'control') continue;
    for (const control of scenarioNarrowedFieldControls(binding)) {
      const prior = observations.filter(candidate => candidate.dependencyId === control.id);
      if (prior.length !== 1 || observations.indexOf(prior[0]!) >= observations.indexOf(observation) ||
          prior[0]!.model !== observation.model || stableStringify(prior[0]!.row) !== stableStringify(observation.row)) return false;
      try {
        const wire = dependencyObservedWire(binding.data, observation.row);
        if (stableStringify(wire) !== stableStringify(dependencyObservedWire(control, prior[0]!.row))) return false;
      } catch { return false; }
    }
  }
  return true;
}

function requireReturnDependencies(state: Capture, returned: ScenarioResultDisclosurePlan['returns'][number],
  observations: readonly DependencyObservation[]): void {
  for (const dependency of returned.dependencies) {
    const actual = observations.filter(observation => observation.dependencyId === dependency.id);
    if (dependency.queryId === undefined) {
      if (actual.length === 0) return invalid('required return dependency was not evaluated/captured.');
      continue;
    }
    const execution = state.queries.find(query => query.plan.id === dependency.queryId);
    // Invoke removes the active root maps before retaining its finalized
    // receipt. The original closed owner still owns this exact capture.
    const finalizedRoot = execution !== undefined && execution.owner.closed && execution.owner.finalized !== null &&
      execution.owner.call === execution.call && execution.owner.capture === state;
    if (execution === undefined || !execution.complete || execution.activeSlot !== null ||
        queryHandles.get(execution.handle) !== execution || !finalizedRoot &&
        (captures.get(execution.call) !== state || ownerSessions.get(execution.call) !== execution.owner) ||
        !returnQueryIds(returned).includes(execution.plan.id) ||
        returned.projection?.queryId !== execution.plan.id && !execution.firstSelected && !execution.countSelected && !execution.selectionConsumed && !execution.anyConsumed) {
      return invalid('candidate-only dependency requires its actual completed consumed query.');
    }
    const slots = new Set<ScenarioReceiptQuerySlot>();
    for (const observation of actual) {
      const linked = queryLinkedObservations.get(observation);
      if (linked?.execution !== execution || !execution.candidates.some(candidate => candidate.slot === linked.slot &&
          candidate.dependencies.has(dependency.id))) return invalid('ordinary observation lacks its actual candidate query association.');
      slots.add(linked.slot);
    }
    if (execution.candidates.some(candidate => candidate.dependencies.has(dependency.id) !== slots.has(candidate.slot))) {
      return invalid('query candidate omitted its completed ordinary observation.');
    }
  }
}

function checkSavedLinkedDependencies(returned: ScenarioResultDisclosurePlan['returns'][number],
  observations: readonly DependencyObservation[], queries: readonly ScenarioReceiptQueryObservation[]): void {
  for (const dependency of returned.dependencies) {
    const actual = observations.filter(observation => observation.dependencyId === dependency.id);
    if (dependency.queryId === undefined) {
      if (actual.length === 0) return invalid('missing saved dependency.');
      continue;
    }
    const query = queries.find(query => query.queryId === dependency.queryId);
    if (query === undefined || !returnQueryIds(returned).includes(query.queryId)) return invalid('missing saved candidate-only query.');
    if (dependency.role === 'data' && query.candidates.some(candidate =>
        candidate.dependencies.includes(dependency.id) !== candidate.matched)) return invalid('saved selected DATA must match every and only selected candidate.');
    const slots = query.candidates.filter(candidate => candidate.dependencies.includes(dependency.id)).length;
    if (actual.length !== slots) {
      return invalid('saved query candidates differ from their retained ordinary observations.');
    }
  }
}
// Private same-call/stage issuance for the existing ordinary reference
// observation. No JSON reference can select a contained collection.
const storedParentInputs = new WeakMap<DependencyObservation, { readonly call: AdmittedCall;
  readonly owner: ReceiptOwnerSession; readonly stage: number; readonly row: StoredRow;
  readonly revalidate: () => Promise<void> }>();
const storedFileInputs = new WeakMap<DependencyObservation, { readonly call: AdmittedCall;
  readonly owner: ReceiptOwnerSession; readonly stage: number; readonly revalidate: () => Promise<void>; used: boolean }>();
interface Capture {
  readonly bound: BoundPlan;
  returnId: string | null;
  poisoned: boolean;
  pending: number;
  readonly observations: Array<DependencyObservation & {
    readonly stored: boolean; readonly ownerSession: boolean;
  }>;
  readonly rowIdGuards: NonNullable<ExecutionEffects['guards']>[number][];
  rowIdWrites?: readonly DomainWrite[];
  readonly intrinsics: IntrinsicObservation[];
  readonly queries: QueryExecution[];
  queryResult: unknown | undefined;
  modelResult?: { readonly existing: boolean; readonly returnId: string; readonly model: ModelName; readonly row: StoredRow; readonly wire: Readonly<{ id: RecordId }> };
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
    if (value === undefined) { value = { bound, returnId: null, poisoned: false, pending: 0, observations: [], rowIdGuards: [], intrinsics: [], queries: [], queryResult: undefined, files: [] }; captures.set(call, value); captureContexts.set(call.context, value); }
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
  readonly skipped: Map<string, AuthoredSkippedDelivery>;
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
  readonly storedFileChecks: Array<() => Promise<void>>;
  readonly modelResults: Array<{ readonly existing: boolean; readonly model: ModelName; readonly row: StoredRow }>;
  activeSend: { readonly call: AdmittedCall; readonly guard: ScenarioReceiptSendGuard; readonly stage: number } | null;
}
const ownerSessions = new WeakMap<AdmittedCall, ReceiptOwnerSession>();
const ownerContexts = new WeakMap<object, ReceiptOwnerSession>();
const ownerRows = new WeakMap<StoredRow, {
  readonly session: ReceiptOwnerSession; readonly stage: number; readonly model: ModelName;
}>();
const eventRecipientRows = new WeakMap<StoredRow, {
  readonly call: AdmittedCall; readonly owner: ReceiptOwnerSession; readonly stage: number;
  readonly sourceId: string; readonly leafId: string;
}>();

const DISPATCH_MODEL = 'work.dispatch' as ModelName;
const receiptModels = [RECEIPT_MODEL, RECEIPT_ASSOCIATION_MODEL] as readonly string[];
function frameworkKey(model: ModelName, id: RecordId): string { return `${model}\0${id}`; }
function frameworkOwner(call: AdmittedCall, store: StoragePort): ReceiptOwnerSession {
  const owner = ownerSessions.get(call);
  try {
    capture(call, store);
    if (owner === undefined || owner.store !== store || owner.framework === null) return invalid('framework stage requires its actual bound owner session.');
    if (owner.call !== call) {
      // Only admitOwnerStageCall issues this frozen call through a checked
      // parent occurrence/target chain. Its own once-bound source producer
      // supplies routes and guards; the outer ledger supplies the one fence.
      const producer = frameworkProducers.get(call.def as GeneratedOperationDef);
      if (activeCalls.get(call)?.owner !== owner || owner.executingCall !== call || !Object.isFrozen(call) ||
          call.def.kind !== 'scenario' || producer === undefined || producer.app !== call.context.app ||
          [DISPATCH_MODEL, ...receiptModels].some(model => captures.get(call)!.bound.models.has(model as ModelName))) {
        return invalid('child framework stage requires its own active checked source binding.');
      }
    }
    ownerHealthy(owner); return owner;
  } catch (error) {
    if (owner !== undefined) owner.capture.poisoned = true;
    const state = captures.get(call); if (state !== undefined) state.poisoned = true;
    throw error;
  }
}
function frameworkContext(owner: ReceiptOwnerSession, models: readonly string[], call = owner.call): { context: SystemCommandContext; close(): void } {
  let live = true; let reading = false;
  const healthy = () => {
    ownerHealthy(owner);
    if (!live || !owner.busy || owner.executingCall !== call) return invalid('framework reader is outside its actual producer stage.');
    assertScenarioReceiptCallExecution(call, owner.store);
  };
  const context: SystemCommandContext = Object.freeze({
    actor: call.context.actor?.userId ?? call.context.trustedSource ?? 'anonymous',
    now: call.context.now, operation: call.context.operation,
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
        intent.dispatchGuard !== send.sourceGuard?.rule ||
        owner.framework!.queued.has(text(intent.intentId))) return invalid('framework outbox differs from its actual checked send.');
    if (owner.framework!.queued.size >= MAX_ITEMS) return invalid('framework outbox budget exceeded.');
    owner.framework!.queued.set(intent.intentId, deepFreeze(intent));
  }
}

/** Freeze actual model lexical rows through the same owning source grants.
 * Ordinary Values inputs retain their existing wire profile. Historical SEND
 * census uses the same model field declarations; reference authority does not
 * arise from the retained snapshot. */
async function captureSendLexical(call: AdmittedCall, owner: ReceiptOwnerSession, guard: ScenarioReceiptSendGuard,
  supplied: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>> {
  const state = capture(call, owner.store), stage = owner.stage, active = owner.activeSend;
  const profiles = frameworkModelInputs.get(call.def as GeneratedOperationDef)?.get(guard.rule);
  const producer = referenceProducers.get(call.def as GeneratedOperationDef);
  const inputs = object(supplied, guard.inputs.map(input => input.name)), values: Record<string, unknown> = {};
  const event = guard.eventSource, due = event === undefined ? undefined : dueWorkAdmissions.get(call);
  if (event !== undefined) {
    if (due === undefined || due.event !== event.event || event.handler !== call.def.name ||
        call !== owner.call || owner.executingCall !== call || due.eventPayload === undefined ||
        call.context.kind !== 'trusted' || call.context.source !== 'schedule' ||
        call.context.trustedSource !== `schedule:${event.event}`) {
      return invalid('event SEND requires its actual admitted due Work source and private owner call.');
    }
    const payload = object(due.eventPayload, [event.modelField.name, event.revisionField.name]);
    const sourceTerm = decodeValue(event.modelField.model, payload[event.modelField.name]) as { readonly model: string; readonly id: string };
    const admittedTerm = decodeValue(event.modelField.model,
      admittedInputWire(call.inputs, event.modelField.name)) as { readonly model: string; readonly id: string };
    const sourceRevision = decodeValue('int', payload[event.revisionField.name]);
    const admittedRevision = decodeValue('int', admittedInputWire(call.inputs, event.revisionField.name));
    const lexicalRevision = decodeValue('int', inputs['eventRevision']);
    if (sourceTerm.model !== event.modelField.model || admittedTerm.model !== event.modelField.model ||
        sourceTerm.id === '' || sourceTerm.id !== admittedTerm.id ||
        sourceRevision !== admittedRevision || sourceRevision !== lexicalRevision) {
      return invalid('event SEND lexical values differ from its retained Work payload and admitted handler inputs.');
    }
  }
  const models: Array<{ readonly name: string; readonly profile: ModelLexicalSnapshotProfile; readonly row: StoredRow;
    readonly sourcePresence: Readonly<{ readonly fields: readonly string[] }> }> = [];
  // Preserve private row identity before copying any input or yielding.
  for (const input of guard.inputs) {
    const profile = profiles?.get(input.name);
    if (profile !== undefined) {
      const actual = inputs[input.name] as StoredRow, issued = ownerRows.get(actual);
      if (issued?.session !== owner || issued.model !== profile.model || issued.stage !== stage) {
        return invalid('SEND model input requires its actual current-stage owner row.');
      }
      const row = checkedRow(dataCopy(actual));
      if (event !== undefined && input.name === 'eventTerm') {
        const payload = object(due!.eventPayload, [event.modelField.name, event.revisionField.name]);
        const ref = decodeValue(event.modelField.model, payload[event.modelField.name]) as { readonly id: string };
        if (row.id !== ref.id || row.archivedAt !== null) return invalid('event SEND model differs from its current retained source row.');
      }
      models.push({ name: input.name, profile, row, sourcePresence: deepFreeze({ fields: Object.keys(row.data) }) });
    } else {
      const wire = dataCopy(inputs[input.name]);
      const value = state.bound.valueSchema === undefined ? decodeValue(input.type, wire)
        : validateValue(state.bound.valueSchema, input.type, wire, 'create');
      if (stableStringify(encodeValue(input.type, value, undefined, state.bound.valueSchema)) !== stableStringify(wire)) return invalid('SEND lexical input is not canonical owning typed wire.');
      values[input.name] = wire;
    }
  }
  if (models.length === 0) return deepFreeze(values);
  const privateEvent = event !== undefined && models.length === 1 && models[0]!.name === 'eventTerm';
  if (owner.session === null || !privateEvent && (producer?.app !== call.context.app || producer.readPolicies === undefined) ||
      owner.busy || state.pending !== 0 || owner.callGuards.length + models.length >= MAX_ITEMS) {
    return invalid('SEND model snapshot requires its complete installed source grant and nonconcurrent owner stage.');
  }
  const reads = producer?.readPolicies;
  owner.busy = true; state.pending++;
  const healthy = () => {
    capture(call, owner.store); ownerHealthy(owner);
    if (owner.executingCall !== call || owner.stage !== stage || owner.activeSend !== active || active?.guard !== guard ||
        !owner.busy || state.pending !== 1 || state.returnId !== null) return invalid('SEND model capture crossed its actual original source stage.');
  };
  try {
    healthy();
    const reader = scenarioReceiptMemberships(owner.call, owner.store), actorUserId = call.context.actor?.userId ?? null,
      teamId = call.context.team?.teamId ?? null;
    const membership = actorUserId === null || teamId === null ? null : await reader.findMembership(teamId, actorUserId); healthy();
    const context: ByContext = { actorUserId, teamId, membership, memberships: reader };
    for (const { name, profile, row, sourcePresence } of models) {
      if (privateEvent && name === 'eventTerm') {
        const fields = event!.modelField.fields;
        const snapshot = deepFreeze({ ...row, parent: row.parent ?? null,
          data: dataCopy(Object.fromEntries(fields.filter(field => Object.hasOwn(row.data, field))
            .map(field => [field, row.data[field]]))), sourcePresence });
        modelLexicalSnapshotOccurrences(profile, snapshot);
        values[name] = snapshot;
        owner.callGuards.push(Object.freeze({ name: `send-event:${guard.rule}:${stage}`, evaluate: async () => {
          if (owner.finalized === null) return invalid('event SEND lacks actual final owner effects.');
          const final = owner.finalized;
          const write = final.writes.find(write => write.model === profile.model &&
            (write.kind === 'insert' ? write.row.id : write.id) === row.id);
          const current = write === undefined
            ? await owner.store.cohortLoad({ model: profile.model, id: row.id, expectedRevision: call.revision })
            : write.kind === 'remove' ? null : write.row;
          if (owner.finalized !== final || owner.capture.poisoned || current === null ||
              !sameModelLifetime(row, current) || stableStringify(current) !== stableStringify(row)) {
            throw new StateError('forbidden', 'event SEND source row changed before commit.');
          }
          if (await owner.store.readRevision() !== call.revision) {
            throw new StateError('conflict', 'event SEND source moved beyond its checkpoint.');
          }
          return true;
        } }));
        continue;
      }
      if (reads === undefined || producer === undefined) return invalid('SEND model lacks installed source grants.');
      const read = reads.get(profile.model);
      if (read === undefined || !('grants' in read)) return invalid('SEND model requires original ordered source field grants.');
      const policyDomains = ownerPolicyDomains(owner, healthy);
      const project = async (current: StoredRow, observed: ByContext, load: (model: ModelName, id: RecordId) => Promise<StoredRow | null>,
        assertHealthy: () => void, policyQuery = policyDomains.capture) => {
        try {
          return await projectInstalledSourceRowAndAncestors({ model: profile.model, row: current,
            readPolicies: reads, policy: producer.policy, context: observed, revision: call.revision, fence: undefined,
            store: owner.store, rows: new Map([[`${profile.model}\0${current.id}`, current]]),
            ownerRows: { read: load, assertHealthy, policyQuery } });
        } catch (error) {
          if (error instanceof FenceConflictError) throw new StateError('conflict', 'SEND model authority moved beyond its checkpoint.');
          throw error;
        }
      };
      const authority = await observeRowGrantAuthority(context, observed => project(row, observed,
        async (model, id) => { healthy(); const row = await owner.session!.views.final.get(model, id); healthy(); return row; }, healthy));
      healthy();
      if (authority.value.record === null) throw new StateError('forbidden', 'Current SEND model field authority is unavailable.');
      const snapshot = deepFreeze({ ...row, parent: row.parent ?? null, data: dataCopy(authority.value.record.data), sourcePresence });
      modelLexicalSnapshotOccurrences(profile, snapshot);
      await authority.revalidate(); healthy();
      values[name] = snapshot;
      owner.callGuards.push(Object.freeze({ name: `send-model:${guard.rule}:${name}:${stage}`, evaluate: async () => {
        if (owner.finalized === null) return invalid('SEND model snapshot lacks actual final owner effects.');
        const final = owner.finalized;
        const finalHealthy = () => {
          if (owner.finalized !== final || owner.capture.poisoned) return invalid('SEND model final owner effects changed.');
        };
        const load = async (model: ModelName, id: RecordId): Promise<StoredRow | null> => {
          finalHealthy();
          const write = final.writes.find(write => write.model === model && (write.kind === 'insert' ? write.row.id : write.id) === id);
          const current = write === undefined ? await owner.store.cohortLoad({ model, id, expectedRevision: call.revision })
            : write.kind === 'remove' ? null : write.row;
          finalHealthy(); return current;
        };
        const current = await load(profile.model, row.id);
        if (current === null || !sameModelLifetime(row, current)) throw new StateError('forbidden', 'SEND model lifetime is unavailable at commit.');
        const projected = await observeRowGrantAuthority(context, observed => project(current, observed, load, finalHealthy,
          policyDomains.retained(finalHealthy, final.writes)));
        finalHealthy();
        if (projected.value.record === null || stableStringify(projectSourceRowFields(snapshot, projected.value.grants, read.secretFields).data) !==
            stableStringify(snapshot.data)) throw new StateError('forbidden', 'Original SEND model fields are no longer readable at commit.');
        await projected.revalidate(); await authority.revalidate(); finalHealthy();
        if (await owner.store.readRevision() !== call.revision) throw new StateError('conflict', 'SEND model commit authority moved beyond its checkpoint.');
        finalHealthy(); return true;
      } }));
    }
    if (await owner.store.readRevision() !== call.revision) throw new StateError('conflict', 'SEND model capture moved beyond its checkpoint.');
    healthy(); return deepFreeze(Object.fromEntries(guard.inputs.map(input => [input.name, values[input.name]])));
  } catch (error) { state.poisoned = true; owner.capture.poisoned = true; throw error; }
  finally { state.pending--; owner.busy = false; }
}

/** Allocate and stage at the actual source Send evaluation point. Only the
 * once-bound installed producer can contribute framework effects. */
export async function stageScenarioReceiptSend(call: AdmittedCall, store: StoragePort,
  report: { readonly source: string; readonly request: BoundCapabilityRequest;
    readonly when?: { readonly rule: string; readonly inputs: Readonly<Record<string, unknown>> } }): Promise<DeliveryRef> {
  const owner = frameworkOwner(call, store);
  try {
    if (owner.busy || owner.activeSend !== null) return invalid('SEND requires its nonconcurrent original owner stage.');
    // Capture request once; model lexical provenance must be inspected before
    // generic copying can erase its private current-stage row identity.
    const received = object(report, ['source', 'request', ...(Object.hasOwn(report, 'when') ? ['when'] : [])]);
    const source = text(received['source']);
    const request = object(dataCopy(received['request']), ['binding', 'from', 'arguments',
      ...(typeof received['request'] === 'object' && received['request'] !== null &&
        Object.hasOwn(received['request'], 'judgment') ? ['judgment'] : [])]) as unknown as BoundCapabilityRequest;
    const ledger = owner.framework!, producer = owner.call === call ? ledger.producer
      : frameworkProducers.get(call.def as GeneratedOperationDef)!;
    const binding = producer.bindings.find(value => value.binding === request.binding);
    const target = binding?.targets.find(value => value.source === source);
    if (producer.app !== call.context.app || binding === undefined || target === undefined || request.from !== binding.from ||
        typeof request.arguments !== 'object' || request.arguments === null || Array.isArray(request.arguments)) return invalid('send differs from its owning app/binding/target route.');
    if (ledger.ordinal >= MAX_ITEMS) return invalid('send occurrence budget exceeded.');
    let sourceGuard: ScenarioReceiptSourceSendGuard | undefined, accepted = true;
    if (Object.hasOwn(received, 'when')) {
      const when = object(received['when'], ['rule', 'inputs']), rule = text(when['rule']);
      const guard = producer.sendGuards?.find(item => item.rule === rule);
      if (guard === undefined || guard.binding !== binding.binding || guard.target !== source ||
          producer.evaluateGuard === undefined) return invalid('SEND when lacks its exact checked owner/binding/target guard.');
      const active = Object.freeze({ call, guard, stage: owner.stage }); owner.activeSend = active;
      try {
        const lexical = await captureSendLexical(call, owner, guard, when['inputs'] as Readonly<Record<string, unknown>>);
        ownerHealthy(owner);
        sourceGuard = deepFreeze({ rule, source: guard.source, owner: guard.owner, node: guard.node, inputs: lexical });
        accepted = await producer.evaluateGuard(Object.freeze({ call, guard, inputs: lexical }));
        ownerHealthy(owner);
        if (owner.activeSend !== active || owner.stage !== active.stage || owner.busy || owner.capture.pending !== 0 ||
            typeof accepted !== 'boolean') return invalid('SEND guard crossed its original source stage or returned a malformed Bool.');
        if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'SEND guard moved beyond its admitted revision.');
        ownerHealthy(owner);
        if (owner.activeSend !== active || owner.stage !== active.stage || owner.busy || owner.capture.pending !== 0) {
          return invalid('SEND guard crossed its original source stage while checking the revision.');
        }
      } finally { owner.activeSend = null; }
    }
    return await ownerOperation(owner, async () => {
      const occurrenceIndex = ledger.ordinal++;
      if (!accepted) {
        // A genuine skipped receipt needs its own identity, never a fabricated
        // queued intent or Work dispatch identity. Invoke replay owns reuse.
        const id = `skp_${await hashInputs({ operationId: call.context.operationId, source,
          occurrenceIndex, rule: sourceGuard!.rule })}`;
        ownerHealthy(owner);
        const guard = producer.sendGuards!.find(guard => guard.rule === sourceGuard!.rule)!;
        ledger.skipped.set(id, deepFreeze({ deliveryId: id, operationId: call.context.operationId,
          operation: call.context.operation, target: source, arguments: request.arguments, occurrenceIndex, request, guard }));
        return makeDeliveryRef(id, source);
      }
      let correlation: ScenarioReceiptSendProducerInput['correlation'];
      if (target.correlation !== null) {
        const value = target.correlation === 'value' ? request.arguments['value'] : request.arguments;
        if (call.checkpoint === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) return invalid('generation send requires its original owner checkpoint and request correlation.');
        const args = value as Record<string, unknown>;
        correlation = { requestSource: text(args['source']), requestRevision: text(args['revision']), requestBinding: binding.binding,
          requestFrom: binding.from, requestApp: call.context.app, requestOwner: call.checkpoint.owner };
      }
      const input = deepFreeze({ operationId: call.context.operationId, source, occurrenceIndex, request,
        originOccurrence: null, ...(correlation === undefined ? {} : { correlation }),
        ...(sourceGuard === undefined ? {} : { sourceGuard }) });
      const reader = frameworkContext(owner, [DISPATCH_MODEL], call);
      try {
        const original = await producer.stage(input, reader.context, call); ownerHealthy(owner);
        const sealed = producer.read(original, input, reader.context); ownerHealthy(owner);
        if (sealed === null) return invalid('send lacks its genuine original one-shot Work carrier.');
        await appendFrameworkWrites(owner, sealed.effects, reader.context, input);
        if (sealed.delivery.operation !== source || !ledger.queued.has(sealed.delivery.id)) return invalid('send delivery lacks its actual queued intent.');
        return sealed.delivery;
      } finally { reader.close(); }
    }, call);
  } catch (error) { owner.capture.poisoned = true; throw error; }
}

/** Associate only the current row issued by this real owner session. No host
 * record locator, queued-intent map, model descriptor or write DTO is trusted. */
export async function stageScenarioReceiptDelivery(call: AdmittedCall, store: StoragePort,
  report: { readonly model: ModelName; readonly row: StoredRow; readonly field: string }): Promise<void> {
  const owner = frameworkOwner(call, store);
  const bound = captures.get(call)!.bound;
  const producer = owner.call === call ? owner.framework!.producer : frameworkProducers.get(call.def as GeneratedOperationDef)!;
  return ownerOperation(owner, async () => {
    if (typeof report !== 'object' || report === null || Array.isArray(report) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(report)) || Reflect.ownKeys(report).length !== 3 ||
        ['model', 'row', 'field'].some(key => {
          const member = Object.getOwnPropertyDescriptor(report, key);
          return member === undefined || !('value' in member) || !member.enumerable;
        })) return invalid('own closed delivery assignment required.');
    const record = report.row, modelName = report.model, fieldName = report.field, stage = owner.stage;
    const issued = ownerRows.get(record);
    if (issued?.session !== owner || issued.stage !== stage || issued.model !== modelName) return invalid('delivery requires this session current-stage row.');
    const model = bound.artifactModels.get(modelName), field = model?.fields.find(value => value.name === fieldName);
    if (model === undefined || field?.field.kind !== 'delivery' || !Object.hasOwn(record.data, fieldName) ||
        call.checkpoint === undefined) return invalid('delivery requires its owning declared field and checkpoint.');
    const value = decodeValue(`delivery(${field.field.capability}.${field.field.operation})${field.nullable === true ? '?' : ''}`,
      record.data[fieldName]) as DeliveryRef | null;
    const reader = frameworkContext(owner, receiptModels, call);
    const healthy = () => {
      ownerHealthy(owner);
      if (owner.executingCall !== call || owner.stage !== stage || ownerRows.get(record) !== issued ||
          !owner.busy || owner.capture.pending !== 0 || owner.activeSend !== null) return invalid('receipt origin crossed its original assignment stage.');
    };
    try {
      let effects = await stageAuthoredDelivery({ model, recordId: record.id, field: fieldName, value,
        queued: owner.framework!.queued, skipped: owner.framework!.skipped, operationId: call.context.operationId, revision: call.checkpoint.revision + 1,
        ...(bound.valueTypes === undefined ? {} : { valueTypes: bound.valueTypes }),
        ...(bound.valueSchema === undefined ? {} : { valueSchema: bound.valueSchema }) }, reader.context);
      healthy();
      const prepare = producer.prepareReceiptOrigin;
      if (prepare !== undefined && value !== null) {
        const send = owner.framework!.queued.get(value.id) ?? owner.framework!.skipped.get(value.id);
        if (send === undefined) return invalid('receipt origin requires this invocation actual SEND.');
        const writes: DomainWrite[] = [];
        for (const write of effects.writes ?? []) {
          if (write.kind !== 'insert' || write.model !== RECEIPT_MODEL || Object.hasOwn(write.row.data, 'filePayloadOrigin')) {
            writes.push(write); continue;
          }
          const row = deepFreeze(dataCopy(write.row));
          const header = deepFreeze(dataCopy(await prepare(Object.freeze({ call, model, row, record, field: fieldName,
            value, revision: call.revision, send }))));
          healthy();
          if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Receipt origin moved beyond its admitted revision.');
          healthy();
          const prepared = { ...row, data: { ...row.data, filePayloadOrigin: header } };
          const original = readReceiptRow(prepared).filePayloadOrigin!.origin;
          if (!isGeneratedOperationDef(call.def)) return invalid('receipt origin lacks its generated owning operation.');
          // New File headers retain only the result type. Legacy explicit-void
          // headers still carry their full original disclosure; their installed
          // profile determines which exact shape this comparison must use.
          const descriptor = call.def.descriptor;
          const { disclosure: _execution, ...resultDeclaration } = descriptor.result ?? {};
          const retainedResult = original.kind === 'delivery-result' || original.kind === 'delivery-skipped'
            ? original.caller.canonical.result : undefined;
          const slimResult = descriptor.result?.type !== 'void' ||
            retainedResult !== undefined && !Object.hasOwn(retainedResult, 'disclosure');
          const fileDescriptor = descriptor.result !== undefined && slimResult
            ? { ...descriptor, result: resultDeclaration } : descriptor;
          if (header.scope.app !== call.context.app || header.scope.owner !== call.checkpoint.owner ||
              (original.kind !== 'delivery-result' && original.kind !== 'delivery-skipped') ||
              original.deliveryId !== value.id || original.association.model !== modelName ||
              original.association.recordId !== record.id || original.association.field !== fieldName ||
              stableStringify(original.caller.source) !== stableStringify(bound.plan.source) ||
              stableStringify(original.caller.canonical) !== stableStringify(fileDescriptor)) return invalid('receipt origin differs from its actual source or owning assignment.');
          const actual = original.kind === 'delivery-result' ? original.intent : original.send;
          if (actual.operation !== send.operation || actual.operationId !== send.operationId || actual.target !== send.target ||
              actual.occurrenceIndex !== send.occurrenceIndex) return invalid('receipt origin differs from its actual SEND occurrence.');
          if ('intentId' in send) {
            if (original.kind !== 'delivery-result' || original.intent.intentId !== send.intentId ||
                original.request.binding !== send.arguments['binding'] || original.request.from !== send.arguments['from']) return invalid('pending receipt origin differs from its queued request.');
          } else if (original.kind !== 'delivery-skipped' || send.request === undefined || send.guard === undefined ||
              original.request.binding !== send.request.binding || original.request.from !== send.request.from ||
              stableStringify(original.guard) !== stableStringify(send.guard)) return invalid('skipped receipt origin differs from its original false SEND.');
          if (original.declaration.kind === 'generation') {
            const request = 'intentId' in send ? send.arguments as unknown as BoundCapabilityRequest : send.request!;
            const target = producer.bindings.find(binding => binding.binding === request.binding &&
              binding.from === request.from)?.targets.find(target => target.source === send.target);
            if (target === undefined || target.correlation === null) return invalid('generation receipt requires its checked original request route.');
            const value = target.correlation === 'value' ? request.arguments['value'] : request.arguments;
            if (typeof value !== 'object' || value === null || Array.isArray(value) ||
                original.declaration.request.source !== (value as Record<string, unknown>)['source'] ||
                original.declaration.request.revision !== (value as Record<string, unknown>)['revision']) {
              return invalid('generation receipt origin differs from its actual original SEND request.');
            }
          }
          writes.push({ ...write, row: prepared });
        }
        effects = { ...effects, writes };
      }
      healthy(); await appendFrameworkWrites(owner, effects, reader.context);
    } finally { reader.close(); }
  }, call);
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
    return dataCopy(encodeValue(field.valueType, value, undefined, bound.valueSchema));
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
        Reflect.ownKeys(input).some(key => typeof key !== 'string' || !['table', 'bounds', 'policies', 'encodeField', 'stageSources', 'secretFields'].includes(key) ||
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
      framework: producer === undefined ? null : { producer, rows: new Map(), queued: new Map(), skipped: new Map(), ordinal: 0 },
      ...inputDefaultSlots(call, state.bound), computedIndex: 0,
      session: null, options: input, executingCall: call, callCount: 0, callDepth: 0, calls: [], callGuards: [], storedFileChecks: [], modelResults: [], activeSend: null };
    ownerSessions.set(call, owner);
    ownerContexts.set(call.context, owner);
    const session = await ownerOperation(owner, () => beginOwnerMutation({ ...input, context: call.context, store,
      secretFields: new Map([...state.bound.models].map(([model, inventory]) => [model, inventory.secrets])),
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
    } else if (key === 'result' && boundPlans.get(call.def as GeneratedOperationDef)?.resultModel !== undefined) {
      const state = capture(call, ownerSessions.get(call)?.store ?? invalid('model result requires its actual owner.'));
      const returned = state.bound.plan.returns.find(returned => returned.id === state.returnId);
      if (returned === undefined) return invalid('model result requires its selected return before effect capture.');
      requireQueryResult(state, returned, member.value);
      // The private result is a frozen one-field canonical wire; retaining
      // this exact object closes the copy boundary without mutable aliases.
      snapshot[key] = member.value;
    } else snapshot[key] = dataCopy(member.value);
  }
  const fileAssignments = matchScenarioFileAssignments(call, snapshot as unknown as ExecutionEffects);
  const owner = ownerSessions.get(call);
  let nominalGuard: NonNullable<ExecutionEffects['guards']>[number] | undefined;
  const nominalAssignments = (snapshot['fileAssignments'] as readonly ScenarioReceiptFileAssignmentLocator[] | undefined ?? [])
    .filter(locator => 'nominal' in assignmentField(boundPlans.get(call.def as GeneratedOperationDef)!, locator.model, locator.field));
  if (nominalAssignments.length !== 0) {
    const source = referenceProducers.get(call.def as GeneratedOperationDef);
    if (owner === undefined || source?.app !== call.context.app || source.readPolicies === undefined ||
        nominalAssignments.some(locator => !source.readPolicies!.has(locator.model))) return invalid('nominal assignments require their actual owner and whole source grants.');
    const store = owner.store, memberships = scenarioReceiptMemberships(call, store);
    const actorUserId = call.context.actor?.userId ?? null, teamId = call.context.team?.teamId ?? null;
    const writes = snapshot['writes'] as readonly DomainWrite[];
    const fileProducer = fileProducers.get(call.def as GeneratedOperationDef)!;
    const receiver = fileReceiver(fileProducer.app, actorUserId, teamId);
    nominalGuard = Object.freeze({
      name: 'nominal File assignment source', evaluate: async () => {
        const healthy = () => { if (captures.get(call)?.poisoned) return invalid('nominal assignment capture is poisoned.'); };
        if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Nominal assignment authority moved beyond its checkpoint.');
        // The complete captured physical conjunction precedes the final
        // coherent source/ancestor observation, including retained rechecks.
        for (const assignment of fileAssignments) {
          if (await fileProducer.revalidate(assignment.file, receiver) !== true) return false;
          healthy();
        }
        const read = async (model: ModelName, id: RecordId): Promise<StoredRow | null> => {
          healthy(); const write = writes.find(value => value.model === model && (value.kind === 'insert' ? value.row.id : value.id) === id);
          const row = write === undefined ? await store.cohortLoad({ model, id, expectedRevision: call.revision }) : write.kind === 'remove' ? null : write.row;
          healthy(); return row;
        };
        const membership = actorUserId === null || teamId === null ? null : await memberships.findMembership(teamId, actorUserId);
        const authority = await observeRowGrantAuthority({ actorUserId, teamId, membership, memberships }, async context => {
          for (const locator of nominalAssignments) {
            const row = await read(locator.model, locator.recordId);
            if (row === null || row.archivedAt !== null) return false;
            const projected = await projectInstalledSourceRowAndAncestors({ model: locator.model, row,
              readPolicies: source.readPolicies!, policy: source.policy, context, revision: call.revision,
              fence: undefined, store, rows: new Map([[`${locator.model}\0${row.id}`, row]]), ownerRows: { read, assertHealthy: healthy } });
            // These are authentic owner-session assignment effects, not field
            // disclosure. Private writes still require current row/ancestor
            // authority; saved exposure separately requires the field grant.
            if (projected.record === null) return false;
          }
          return true;
        });
        if (!authority.value) return false;
        await authority.revalidate(); healthy();
        if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Nominal assignment final authority moved beyond its checkpoint.');
        return true;
      },
    });
  }
  if (fileAssignments.length !== 0) {
    const producer = fileProducers.get(call.def as GeneratedOperationDef)!;
    const receiver = fileReceiver(producer.app, call.context.actor?.userId ?? null, call.context.team?.teamId ?? null);
    snapshot['guards'] = [...((snapshot['guards'] as NonNullable<ExecutionEffects['guards']> | undefined) ?? []),
      ...fileAssignments.map(assignment => Object.freeze({ name: `File ${fileLocatorKey(assignment)} ${assignment.file.ref}`,
        evaluate: async () => (await producer.revalidate(assignment.file, receiver)) === true }))];
  }
  if (nominalGuard !== undefined) snapshot['guards'] = [...((snapshot['guards'] as NonNullable<ExecutionEffects['guards']> | undefined) ?? []), nominalGuard];
  const state = captures.get(call);
  if (state !== undefined && state.rowIdGuards.length !== 0) {
    if (state.rowIdWrites !== undefined) return invalid('row id effects were already captured.');
    state.rowIdWrites = deepFreeze(dataCopy(snapshot['writes'])) as readonly DomainWrite[];
  }
  const guards = [...(owner?.callGuards ?? []), ...(captures.get(call)?.rowIdGuards ?? [])];
  if (guards.length !== 0) retainedCallGuards.set(call, Object.freeze(guards));
  const finalNominalGuard = nominalGuard;
  const storedChecks = [...(owner?.storedFileChecks ?? []), ...(finalNominalGuard === undefined ? [] : [async () => {
    if (!await finalNominalGuard.evaluate()) throw new StateError('forbidden', 'Nominal File assignment final source or physical authority no longer holds.');
  }])];
  if (storedChecks.length !== 0) retainedStoredFileChecks.set(call, Object.freeze(storedChecks));
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
    const profile = assignmentField(bound, locator.model, locator.field);
    const writes = effects.writes.filter(write => write.model === locator.model &&
      (write.kind === 'insert' ? write.row.id : write.id) === locator.recordId);
    if (writes.length !== 1) return invalid('File assignment requires its final net owning write.');
    const write = writes[0]!;
    if (write.kind === 'remove') return invalid('removed File assignment.');
    const row = checkedRow(write.row);
    if (row.id !== locator.recordId || row.version !== (write.kind === 'insert' ? 1 : write.expectedVersion + 1) || !Object.hasOwn(row.data, locator.field)) return invalid('File assignment differs from its final row.');
    const refs = new Set(assignmentRefs(profile, row.data[locator.field]));
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
/** Promote only a checked stored reference whose actual source marker has
 * completed in this owner stage. Its leaf may be a scalar, reserved DATA
 * identity, or an exact required singular Model-reference field. Native owns the private getter/reference
 * binding; State owns provisional rows and immediate source/leaf authority. */
export function readScenarioReceiptStoredReferenceRow(call: AdmittedCall, store: StoragePort, input: {
  readonly sourceDependencyId: string; readonly scalarLeafDependencyId: string; readonly sourceRow: StoredRow;
}): Promise<StoredRow> {
  return readObservedStoredReferenceRow(call, store, input, false) as Promise<StoredRow>;
}
/** Original nullable presence retains null as absence, never as a denied read.
 * Nonnull promotion uses the same source/target authority as the required port. */
export function readScenarioReceiptNullableStoredReferenceRow(call: AdmittedCall, store: StoragePort, input: {
  readonly sourceDependencyId: string; readonly scalarLeafDependencyId: string; readonly sourceRow: StoredRow;
}): Promise<StoredRow | null> {
  return readObservedStoredReferenceRow(call, store, input, true);
}
async function readObservedStoredReferenceRow(call: AdmittedCall, store: StoragePort, input: {
  readonly sourceDependencyId: string; readonly scalarLeafDependencyId: string; readonly sourceRow: StoredRow;
}, nullable: boolean): Promise<StoredRow | null> {
  const poisonSourceOwner = () => {
    const carrier = typeof input === 'object' && input !== null ? Object.getOwnPropertyDescriptor(input, 'sourceRow') : undefined;
    if (carrier !== undefined && 'value' in carrier) {
      const issuing = ownerRows.get(carrier.value as StoredRow);
      if (issuing !== undefined) issuing.session.capture.poisoned = true;
    }
  };
  let state: Capture;
  try { state = capture(call, store); }
  catch (error) { poisonSourceOwner(); throw error; }
  const owner = ownerSessions.get(call);
  let acquired = false;
  try {
    object(input, ['sourceDependencyId', 'scalarLeafDependencyId', 'sourceRow']);
    const reference = state.bound.referenceDependencies.get(input.sourceDependencyId);
    const scalar = state.bound.plan.returns.flatMap(returned => returned.dependencies)
      .find(dependency => dependency.id === input.scalarLeafDependencyId);
    const leafReference = state.bound.referenceDependencies.get(input.scalarLeafDependencyId);
    const requiredReferenceLeaf = !nullable && scalar !== undefined && leafReference !== undefined &&
      leafReference.profile.kind === 'field' && !leafReference.profile.array && !leafReference.profile.nullable &&
      leafReference.profile.field === scalar.field && leafReference.profile.type === scalar.type &&
      leafReference.dependency.model === scalar.model && leafReference.dependency.field === scalar.field &&
      leafReference.dependency.type === scalar.type && state.bound.artifactModels.has(leafReference.profile.target);
    const observations = state.observations.filter(observation => observation.dependencyId === input.sourceDependencyId);
    const observation = observations[0], issued = observation === undefined ? undefined : storedParentInputs.get(observation);
    const source = ownerRows.get(input.sourceRow);
    // Reserved identity is a DATA dependency on the readable target record,
    // never an authored field or nullable-reference scalar projection.
    const targetId = !nullable && scalar !== undefined && scalar.role === 'data' && scalar.field === 'id' &&
      scalar.type === 'text' && state.bound.idDependencies.has(scalar.id);
    if (owner === undefined || owner.session === null || owner.busy || state.pending !== 0 || state.returnId !== null ||
        owner.executingCall !== call || source?.session !== owner || source.stage !== owner.stage ||
        reference?.profile.kind !== 'field' || reference.profile.array || reference.profile.nullable !== nullable ||
        reference.dependency.queryId !== undefined || scalar === undefined || scalar.queryId !== undefined ||
        scalar.id === reference.dependency.id || scalar.model !== reference.profile.target || !targetId && !requiredReferenceLeaf && (
          state.bound.models.get(scalar.model)?.fields.get(scalar.field) !==
            (state.bound.narrowedDependencies.get(scalar.id)?.declarationType ?? scalar.type) ||
          state.bound.idDependencies.has(scalar.id)) || leafReference !== undefined && !requiredReferenceLeaf ||
        state.bound.nominalDependencies.has(scalar.id) || state.bound.fileDependencies.has(scalar.id) ||
        source.model !== reference.dependency.model || observations.length !== 1 || issued?.call !== call ||
        issued.owner !== owner || issued.stage !== owner.stage || issued.row !== input.sourceRow ||
        observation!.model !== source.model || !state.bound.plan.returns.some(returned =>
          returned.dependencies.some(dependency => dependency.id === reference.dependency.id) &&
          returned.dependencies.some(dependency => dependency.id === scalar.id))) {
      return invalid('stored scalar reference requires its exact observed source, scalar pair and current owner stage.');
    }
    if (!requiredReferenceLeaf) scalarType(scalar.type);
    ownerHealthy(owner); owner.busy = true; state.pending++; acquired = true;
    const stage = owner.stage;
    const healthy = () => {
      capture(call, store); ownerHealthy(owner);
      if (owner.executingCall !== call || owner.stage !== stage || !owner.busy || state.pending !== 1 || state.returnId !== null) {
        return invalid('stored scalar promotion crossed its original owner stage.');
      }
    };
    await issued.revalidate(); healthy();
    const currentSource = await owner.session.views.final.get(source.model, input.sourceRow.id); healthy();
    if (currentSource === null || !sameModelLifetime(observation!.row, currentSource) ||
        stableStringify(currentSource) !== stableStringify(observation!.row)) {
      throw new StateError('forbidden', 'Stored scalar source changed after its original observation.');
    }
    const recipient = admittedEventRecipientDependencies(call, state);
    const privateRecipient = !nullable && recipient?.sourceId === input.sourceDependencyId &&
      recipient.leafId === input.scalarLeafDependencyId && source.model === 'appointments.Appointment' &&
      scalar.model === 'customer.Contact' && scalar.field === 'email';
    if (!privateRecipient) {
      await observeModelQuerySourceAuthority(call, store, owner, state, source.model, currentSource,
        [reference.dependency.field], 1); healthy();
    }
    const wire = storedReferenceWire(reference.profile, currentSource) as { id: RecordId } | null;
    const target = wire === null ? null : await owner.session.views.final.get(scalar.model, wire.id); healthy();
    if (wire !== null && (target === null || target.archivedAt !== null)) throw new StateError('forbidden', 'Stored scalar target lifetime is unavailable.');
    const narrowed = state.bound.narrowedDependencies.get(scalar.id);
    if (target !== null && narrowed !== undefined) capturedNarrowedControl(call, owner, state, narrowed, target);
    const targetAuthority = target === null || privateRecipient ? null : await observeModelQuerySourceAuthority(call, store, owner, state,
      scalar.model, target, targetId ? [] : [scalar.field], 1); healthy();
    const recipientRevalidate = privateRecipient && target !== null
      ? await observeEventRecipientTargetAuthority(call, store, owner, state, currentSource, target,
        input.sourceDependencyId, input.scalarLeafDependencyId) : undefined;
    healthy();
    await issued.revalidate(); healthy();
    if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Stored scalar projection moved beyond its admitted checkpoint.');
    healthy();
    await targetAuthority?.revalidate(); healthy();
    await recipientRevalidate?.(); healthy();
    // Ordinary stored-reference reads can depend on distinct subjects; they
    // retain their complete Identity conjunction. The event recipient instead
    // has the exact Work-root/Contact owner fence above.
    if (!privateRecipient) {
      const memberships = scenarioReceiptMemberships(owner.call, store), actorUserId = call.context.actor?.userId ?? null,
        teamId = call.context.team?.teamId ?? null;
      const membership = actorUserId === null || teamId === null ? null : await memberships.findMembership(teamId, actorUserId); healthy();
      const policyDomains = ownerPolicyDomains(owner, healthy);
      const authority = await observeRowGrantAuthority({ actorUserId, teamId, membership, memberships }, async context => {
        for (const entry of [{ model: source.model, row: currentSource, field: reference.dependency.field },
          ...(target === null ? [] : [{ model: scalar.model, row: target, field: scalar.field }])]) {
          const producer = querySourceProducer(call.def as GeneratedOperationDef, entry.model), read = producer?.readPolicies?.get(entry.model);
          if (producer?.app !== call.context.app || producer.readPolicies === undefined || read === undefined || !('grants' in read)) {
            return invalid('stored scalar conjunction requires its installed source and target grants.');
          }
          let projected: Awaited<ReturnType<typeof projectInstalledSourceRowAndAncestors>>;
          try {
            projected = await projectInstalledSourceRowAndAncestors({ model: entry.model, row: entry.row,
              readPolicies: producer.readPolicies, policy: producer.policy, context, revision: call.revision,
              fence: undefined, store, rows: new Map([[`${entry.model}\0${entry.row.id}`, entry.row]]), ownerRows: {
                assertHealthy: healthy, policyQuery: policyDomains.capture, read: async (model, id) => {
                  healthy(); const row = await owner.session!.views.final.get(model, id); healthy(); return row;
                },
              } });
          } catch (error) {
            if (error instanceof FenceConflictError) throw new StateError('conflict', 'Stored scalar conjunction moved beyond its checkpoint.');
            throw error;
          }
          healthy();
          if (projected.record === null || (targetId && entry.model === scalar.model && entry.field === 'id'
            ? projected.record.id !== entry.row.id
            : !projected.grants.some(grant => grant.fields.includes(entry.field)) || !Object.hasOwn(projected.record.data, entry.field))) {
            throw new StateError('forbidden', 'Stored scalar source or target authority is unavailable.');
          }
        }
        return true;
      }); healthy();
      await authority.revalidate(); healthy();
      if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Stored scalar final authority moved beyond its checkpoint.');
      healthy();
    }
    if (target !== null) {
      ownerRows.set(target, { session: owner, stage, model: scalar.model });
      if (privateRecipient) eventRecipientRows.set(target, { call, owner, stage,
        sourceId: input.sourceDependencyId, leafId: input.scalarLeafDependencyId });
    }
    return target;
  } catch (error) { state.poisoned = true; if (owner !== undefined) owner.capture.poisoned = true; poisonSourceOwner(); throw error; }
  finally { if (acquired) { state.pending--; owner!.busy = false; } }
}
/** Capture only reached installed-policy collections from this actual owner
 * stage. Original query checks retain their stage rows; final grants use the
 * same domains with actual owner effects, without broadening query certificates. */
function ownerPolicyDomains(owner: ReceiptOwnerSession, healthy: () => void) {
  type Parent = Readonly<{model: ModelName; id: RecordId}>;
  const domains = new Map<string, {model: ModelName; parent: Parent | undefined; rows: readonly StoredRow[]}>();
  const keyOf = (model: ModelName, parent?: Parent) => stableStringify([model, parent ?? null]);
  const capture = async (model: ModelName, parent?: Parent): Promise<readonly StoredRow[]> => {
    healthy();
    const key = keyOf(model, parent), cached = domains.get(key);
    if (cached !== undefined) return cached.rows;
    if (domains.size >= MAX_ITEMS || owner.session === null) return invalid('policy collection exceeds its owning stage.');
    const rows = await owner.session.views.final.query({model, authority: 'owner', archived: 'exclude',
      order: [{field: 'id', direction: 'asc'}], limit: owner.maxRows, ...(parent === undefined ? {} : {parent})});
    healthy();
    const copied = deepFreeze(dataCopy(rows));
    domains.set(key, {model, parent, rows: copied});
    return copied;
  };
  const retained = (assertHealthy: () => void, writes: readonly DomainWrite[] = []) =>
    async (model: ModelName, parent?: Parent): Promise<readonly StoredRow[]> => {
      assertHealthy();
      const domain = domains.get(keyOf(model, parent));
      if (domain === undefined) throw new StateError('forbidden', 'Policy collection requires its original observed owner domain.');
      const rows = new Map(domain.rows.map(row => [row.id, row]));
      for (const write of writes) if (write.model === model) {
        if (write.kind === 'remove') rows.delete(write.id);
        else rows.set(write.row.id, write.row);
      }
      const current = [...rows.values()].filter(row => row.archivedAt === null &&
        (parent === undefined || row.parent?.model === parent.model && row.parent.id === parent.id));
      if (current.length > owner.maxRows) return invalid('policy collection exceeds its owning row bound.');
      current.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      assertHealthy(); return Object.freeze(current);
    };
  return {capture, retained};
}

export interface ScenarioReceiptRequireSource {
  readonly source: ScenarioResultDisclosurePlan['source'];
  readonly owner: string;
  readonly node: { readonly start: number; readonly end: number };
  readonly statement: { readonly start: number; readonly end: number };
  readonly parameters: readonly { readonly name: string; readonly typeId: CanTypeId }[];
  readonly sites: readonly ScenarioReceiptMembershipSite[];
}
/** Private literal host tracking; these callbacks issue no row authority. */
export interface ScenarioReceiptRequireObserver {
  readonly field: (model: string, row: StoredRow | ProjectedRecord, field: string) => void;
  readonly query: (model: string, records: readonly ProjectedRecord[], id?: string,
    parent?: Readonly<{ model: string; id: string }>) => void;
}

/** One original pre-write Require, evaluated once on the genuine admitted row.
 * Its source queries borrow this owner stage; complete owner domains and
 * current Identity survive to the fence. */
export async function executeScenarioReceiptRequire(call: AdmittedCall, store: StoragePort, input: {
  readonly original: ScenarioReceiptRequireSource;
  /** Independently loaded from the verified source-Require inventory. */
  readonly checked: ScenarioReceiptRequireSource;
  readonly parameter: string;
  readonly capture: (observer: ScenarioReceiptRequireObserver) => InstalledSourceQueryPredicate;
}): Promise<boolean> {
  const state = capture(call, store), owner = ownerSessions.get(call);
  let acquired = false;
  try {
    if (owner === undefined || owner.session === null || owner.stage !== 0 || owner.busy ||
        state.pending !== 0 || state.returnId !== null || owner.executingCall !== call ||
        owner.callGuards.length >= MAX_ITEMS) {
      return invalid('source Require needs its actual initial owner stage.');
    }
    const original = deepFreeze(dataCopy(input.original));
    const sites = checkScenarioReceiptMembershipSites(original.sites);
    const checked = deepFreeze(dataCopy(input.checked));
    const source = checked.source;
    const [site] = sites;
    if (stableStringify(checked) !== stableStringify(original) ||
        source.path !== state.bound.plan.source.path || source.sha256 !== state.bound.plan.source.sha256 ||
        original.owner !== call.def.name || stableStringify(original.source) !== stableStringify(source) ||
        sites.length !== 1 || site === undefined || site.stage !== 'read-predicate' || site.owner !== call.def.name ||
        stableStringify(site.source) !== stableStringify(source) ||
        stableStringify(site.node) !== stableStringify(original.node) ||
        stableStringify(site.statement) !== stableStringify(original.statement)) {
      return invalid('source Require needs its exact original guard and independently checked read observer.');
    }
    const reference = call.recordRefs.find(ref => ref.param === input.parameter);
    const declared = original.parameters.find(parameter => parameter.name === input.parameter);
    if (reference === undefined || declared?.typeId !== reference.model ||
        original.parameters.length !== (call.def as GeneratedOperationDef).descriptor.inputs.length ||
        new Set(original.parameters.map(parameter => parameter.name)).size !== original.parameters.length) {
      return invalid('source Require needs its complete original parameters and admitted model slot.');
    }
    const occurrence = `source-require:${call.def.name}:${original.node.start}:${original.node.end}`;
    if (owner.callGuards.some(guard => guard.name === occurrence)) return invalid('source Require must execute once.');
    owner.busy = true; state.pending++; acquired = true;
    const healthy = () => {
      capture(call, store); ownerHealthy(owner);
      if (owner.stage !== 0 || owner.executingCall !== call || !owner.busy || state.pending !== 1 || state.returnId !== null) {
        return invalid('source Require crossed its original owner stage.');
      }
    };
    const rows = new Map<string, StoredRow>();
    const rowKey = (model: string, id: string) => `${model}\0${id}`;
    const read = async (model: ModelName, id: RecordId): Promise<StoredRow | null> => {
      healthy();
      // This observer cannot cross stage zero or write. Reuse raw snapshot
      // rows, never projected grants; Identity and the revision fence stay live.
      const key = rowKey(model, id), cached = rows.get(key);
      if (cached !== undefined) return cached;
      const row = await owner.session!.views.final.get(model, id); healthy();
      if (row !== null) rows.set(key, row);
      return row;
    };
    const policyDomains = ownerPolicyDomains(owner, healthy);
    const query = async (model: ModelName, parent?: Readonly<{model: ModelName; id: RecordId}>): Promise<readonly StoredRow[]> => {
      const domain = await policyDomains.capture(model, parent);
      for (const row of domain) rows.set(rowKey(model, row.id), row);
      return domain;
    };
    const root = await read(reference.model, reference.id);
    if (root === null || stableStringify(root) !== stableStringify(reference.row)) {
      throw new StateError('conflict', 'Source Require model differs from its admitted row.');
    }
    const domains: Array<{ model: ModelName; ids: readonly string[]; id?: RecordId;
      parent?: Readonly<{ model: ModelName; id: RecordId }> }> = [];
    const observe = <T>(action: () => T): T => {
      try { healthy(); return action(); }
      catch (error) { state.poisoned = true; owner.capture.poisoned = true; throw error; }
    };
    const observer: ScenarioReceiptRequireObserver = Object.freeze({
      field: (model: string, projected: StoredRow | ProjectedRecord, field: string) => observe(() => {
        const row = rows.get(rowKey(model, projected.id));
        if (row === undefined || row.version !== projected.version || !state.bound.artifactModels.has(model as ModelName)) {
          return invalid('source field needs its actual original owner row.');
        }
        // Metadata identity is already tied to this issued row, without a data grant.
        if (!state.bound.artifactModels.get(model as ModelName)!.fields.some(entry => entry.name === field) && field !== 'parent') return;
        // The row/field identity is checked here. Its owner value belongs to
        // this original stage; this operation's later writes cannot revoke
        // the decision, while the storage revision fence catches other writers.
      }),
      query: (model: string, records: readonly ProjectedRecord[], id?: string,
        parent?: Readonly<{ model: string; id: string }>) => observe(() => {
        if (domains.length >= MAX_ITEMS || !state.bound.artifactModels.has(model as ModelName) ||
            records.some(record => rows.get(rowKey(model, record.id))?.version !== record.version)) {
          return invalid('source query needs its complete genuine owning domain.');
        }
        domains.push({ model: model as ModelName, ids: Object.freeze(records.map(record => record.id)),
          ...(id === undefined ? {} : { id: id as RecordId }),
          ...(parent === undefined ? {} : { parent: { model: parent.model as ModelName, id: parent.id as RecordId } }) });
      }),
    });
    const predicate = input.capture(observer);
    if (typeof predicate !== 'function') return invalid('source Require needs its installed original predicate.');
    const memberships = scenarioReceiptMemberships(owner.call, store), actorUserId = call.context.actor?.userId ?? null,
      teamId = call.context.team?.teamId ?? null;
    const membership = actorUserId === null || teamId === null ? null : await memberships.findMembership(teamId, actorUserId);
    healthy();
    const context: ByContext = { actorUserId, teamId, membership, memberships };
    const ownerRecord = (row: StoredRow) => projectSourceRowFields(row,
      [{ fields: Object.keys(row.data) }], []);
    let answer: boolean | undefined;
    const authority = await observeRowGrantAuthority(context, async observed => {
      // The first pass records all actual source subjects. Snapshot validation
      // may call this collector again; the original authored guard runs once.
      if (answer !== undefined) return answer;
      answer = await evaluateInstalledReadPredicate(predicate, ownerRecord(root), {
        context: observed, row: root, revision: call.revision, fence: undefined,
        sourcePresence: Object.freeze(Object.keys(root.data)),
      }, store, { read, assertHealthy: healthy, query, policyQuery: policyDomains.capture });
      healthy(); return answer;
    });
    await authority.revalidate(); healthy();
    owner.callGuards.push(Object.freeze({ name: occurrence, evaluate: async () => {
      const final = owner.finalized;
      if (final === null) return invalid('source Require needs actual finalized owner effects.');
      const finalHealthy = () => {
        if (owner.finalized !== final || owner.capture.poisoned) return invalid('source Require final capture changed.');
      };
      // The original decision is retained across this operation's own
      // writes. Recheck its complete pre-write domains at the fenced revision.
      // Source guards execute at their original pre-write stage. Own later
      // effects do not replace that domain; current Identity still rechecks it.
      // Consumed fields separately retain their final-overlay authority below.
      const originalDomains = policyDomains.retained(finalHealthy);
      const originalRead = async (model: ModelName, id: RecordId): Promise<StoredRow | null> => {
        finalHealthy();
        const key = rowKey(model, id);
        if (!rows.has(key)) throw new StateError('forbidden', 'Source Require requested an unobserved original row.');
        return rows.get(key)!;
      };
      const current = await observeRowGrantAuthority(context, async _observed => {
        for (const domain of domains) {
          const candidates = domain.id === undefined ? await originalDomains(domain.model, domain.parent) :
            [await originalRead(domain.model, domain.id)].filter((row): row is StoredRow => row !== null);
          const ids = candidates.map(row => row.id);
          if (stableStringify(ids) !== stableStringify(domain.ids)) throw new StateError('forbidden', 'Source Require owner query domain changed.');
        }
        return true;
      });
      await current.revalidate(); await authority.revalidate(); finalHealthy();
      if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Source Require moved beyond its original revision.');
      return true;
    } }));
    return authority.value;
  } catch (error) { state.poisoned = true; if (owner !== undefined) owner.capture.poisoned = true; throw error; }
  finally { if (acquired) { state.pending--; owner!.busy = false; } }
}

/** Borrow only this complete root predicate domain. Source-policy collections
 * retain id order and exclude archives; final authority sees the actual final
 * owning overlay while the original query guard retains its intermediate rows. */
function predicateControlDomain(model: ModelName, domain: readonly StoredRow[], maxRows: number,
  assertHealthy: () => void, writes: readonly DomainWrite[] = []) {
  return async (requested: ModelName, parent?: Readonly<{model: ModelName; id: RecordId}>): Promise<readonly StoredRow[]> => {
    assertHealthy();
    if (parent !== undefined || requested !== model) throw new StateError('validation', 'Source collection needs its original committed query domain.');
    const rows = new Map(domain.map(row => [row.id, row]));
    for (const write of writes) if (write.model === model) {
      if (write.kind === 'remove') rows.delete(write.id);
      else rows.set(write.row.id, write.row);
    }
    const selected = [...rows.values()].filter(row => row.archivedAt === null && row.parent == null);
    if (selected.length > maxRows) throw new StateError('validation', 'Source predicate domain exceeds its owning row bound.');
    selected.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    assertHealthy(); return Object.freeze(selected);
  };
}
/** Original first-query rows reuse the installed source/ancestor projector and
 * complete Identity observation, both now and against actual final effects. */
async function observeModelQuerySourceAuthority(call: AdmittedCall, store: StoragePort, owner: ReceiptOwnerSession,
  state: Capture, model: ModelName, row: StoredRow, fields: readonly string[], pending = 0,
  predicateDomain?: readonly StoredRow[],
  decisionPolicies?: ReadonlyMap<ModelName, ViewerSourceReadPolicy>): Promise<{
    readonly requireFields: (fields: readonly string[]) => Promise<void>; readonly revalidate: () => Promise<void>;
  }> {
  const producer = querySourceProducer(call.def as GeneratedOperationDef, model);
  const policies = decisionPolicies ?? producer?.readPolicies;
  const read = policies?.get(model);
  const queryOwned = queryProducers.get(call.def as GeneratedOperationDef)?.readPolicies?.has(model) === true;
  if (producer?.app !== call.context.app || policies === undefined || read === undefined ||
      !('grants' in read) && (!queryOwned || !producer.policy.has(model)) ||
      owner.session === null || owner.callGuards.length >= MAX_ITEMS) return invalid('model query requires its installed whole source field grants.');
  const stage = owner.stage;
  const healthy = () => {
    capture(call, store); ownerHealthy(owner);
    if (owner.executingCall !== call || owner.stage !== stage || !owner.busy || state.pending !== pending || state.returnId !== null) {
      return invalid('model query source authority crossed its original owner stage.');
    }
  };
  const policyDomains = ownerPolicyDomains(owner, healthy);
  const reader = scenarioReceiptMemberships(owner.call, store), actorUserId = call.context.actor?.userId ?? null,
    teamId = call.context.team?.teamId ?? null;
  const membership = actorUserId === null || teamId === null ? null : await reader.findMembership(teamId, actorUserId); healthy();
  const context: ByContext = { actorUserId, teamId, membership, memberships: reader };
  const project = async (current: StoredRow, observed: ByContext,
    load: (model: ModelName, id: RecordId) => Promise<StoredRow | null>, assertHealthy: () => void,
    query?: (model: ModelName, parent?: Readonly<{model: ModelName; id: RecordId}>) => Promise<readonly StoredRow[]>,
    policyQuery = policyDomains.capture) => {
    try {
      return await projectInstalledSourceRowAndAncestors({ model, row: current,
        readPolicies: policies!, policy: producer.policy, context: observed, revision: call.revision,
        fence: undefined, store, rows: new Map([[`${model}\0${current.id}`, current]]),
        ownerRows: { read: load, assertHealthy, policyQuery, ...(query === undefined ? {} : { query }) } });
    } catch (error) {
      if (error instanceof FenceConflictError) throw new StateError('conflict', 'Model query source authority moved beyond its checkpoint.');
      throw error;
    }
  };
  const requiredFields = new Set(fields);
  const readable = (value: Awaited<ReturnType<typeof project>>) => value.record !== null && [...requiredFields].every(field => field === 'parent'
    ? value.record!.parent !== null && value.record!.parent.model === state.bound.artifactModels.get(model)?.parent
    : ('grants' in read ? value.grants.some(grant => grant.fields.includes(field)) : true) && (field === 'id' || Object.hasOwn(value.record!.data, field)));
  const authority = await observeRowGrantAuthority(context, observed => project(row, observed,
    async (model, id) => { healthy(); const value = await owner.session!.views.final.get(model, id); healthy(); return value; }, healthy,
    predicateDomain === undefined ? undefined : predicateControlDomain(model, predicateDomain, owner.maxRows, healthy)));
  healthy();
  if (!readable(authority.value)) throw new StateError('forbidden', 'Original model query source fields are unavailable.');
  await authority.revalidate(); healthy();
  owner.callGuards.push(Object.freeze({ name: `model-query:${call.def.name}:${model}:${row.id}:${stage}:${owner.callGuards.length}`, evaluate: async () => {
    if (owner.finalized === null) return invalid('model query source lacks actual final owner effects.');
    const final = owner.finalized;
    const finalHealthy = () => { if (owner.finalized !== final || owner.capture.poisoned) return invalid('model query final owner effects changed.'); };
    const load = async (model: ModelName, id: RecordId): Promise<StoredRow | null> => {
      finalHealthy();
      const write = final.writes.find(write => write.model === model && (write.kind === 'insert' ? write.row.id : write.id) === id);
      const current = write === undefined ? await store.cohortLoad({ model, id, expectedRevision: call.revision }) : write.kind === 'remove' ? null : write.row;
      finalHealthy(); return current;
    };
    const current = await load(model, row.id);
    if (current === null || !sameModelLifetime(row, current)) throw new StateError('forbidden', 'Original model query row lifetime changed.');
    const now = await observeRowGrantAuthority(context, observed => project(current, observed, load, finalHealthy,
      predicateDomain === undefined ? undefined : predicateControlDomain(model, predicateDomain, owner.maxRows, finalHealthy, final.writes),
      policyDomains.retained(finalHealthy, final.writes)));
    finalHealthy();
    if (!readable(now.value)) throw new StateError('forbidden', 'Model query source field authority changed before commit.');
    await now.revalidate(); await authority.revalidate(); finalHealthy();
    if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Model query source recheck moved beyond its original checkpoint.');
    return true;
  } }));
  return { revalidate: authority.revalidate, requireFields: async fields => {
    healthy();
    for (const field of fields) requiredFields.add(field);
    if (!readable(authority.value)) throw new StateError('forbidden', 'Executed model query source fields are unavailable.');
    await authority.revalidate(); healthy();
  } };
}
/** DESIGN442 guard/presence-consumed owner decision: a marked first-query
 * occurrence of the confined single-query decision shape evaluates its
 * declared control reads as the consuming `Require` decision, never as a
 * viewer grant. Stored `Require` reads ride their bound execution
 * dependency for the same query; bare presence consumes none, so any
 * execution read for the query refuses the presence mark. The returned
 * policies augment only this query's model entry with one decision grant
 * over exactly the declared decision fields. The grant verifies a genuine
 * recorded fact — the row id belongs to this owner decision's issued rows
 * at this revision — so it is neither actor substitution (the null-actor
 * context is untouched), nor a model-wide grant, nor bool-true authority.
 * Observation, requireFields and finalize revalidation all reuse
 * observeModelQuerySourceAuthority above; ordinary viewer behavior is
 * unchanged whenever this returns undefined. */
function guardConsumedDecisionPolicies(call: AdmittedCall, owner: ReceiptOwnerSession,
  state: Capture, plan: ScenarioReceiptQueryPlan, fields: readonly string[],
  issuedIds: ReadonlySet<RecordId>): ReadonlyMap<ModelName, ViewerSourceReadPolicy> | undefined {
  const producer = queryProducers.get(call.def as GeneratedOperationDef);
  const marked = producer?.first?.find(value => value.queryId === plan.id);
  const stored = marked?.guardConsumed === true, presence = marked?.presenceConsumed === true;
  const countFirstSeat = countFirstSeatProfile(call.def as GeneratedOperationDef, state.bound);
  const countExecution = state.queries[0], firstExecution = state.queries[1];
  const selectedIndex = firstExecution?.selectedIndices[0];
  const selected = selectedIndex === undefined ? undefined : firstExecution?.candidates[selectedIndex]?.row;
  const selectedSeatGuard = stored && countFirstSeat?.first.id === plan.id && owner.stage === 0 &&
    countExecution?.plan.id === countFirstSeat.count.id && countExecution.stage === owner.stage &&
    countExecution.ownerDecision && countExecution.complete && countExecution.countSelected &&
    firstExecution?.plan.id === plan.id && firstExecution.complete && firstExecution.firstSelected &&
    firstExecution.owner === owner && firstExecution.stage === owner.stage && firstExecution.ownerDecision && selected !== undefined &&
    issuedIds.size === 1 && issuedIds.has(selected.id);
  if (!stored && !presence || state.bound.resultModel !== undefined ||
      (state.bound.plan.queries?.length ?? 0) !== 1 && !selectedSeatGuard ||
      producer?.readPolicies === undefined) return undefined;
  // Contained queries additionally require the exact admitted versioned
  // parent reference (the same checks as resolveQueryParent); any other
  // parent origin stays refused. The decision grant then verifies each
  // observed child row's parent linkage against that admitted parent, so
  // the mark never becomes model-wide access.
  let admittedParent: { readonly model: ModelName; readonly id: string } | undefined;
  if (plan.parent !== undefined) {
    if (plan.parent.origin.kind !== 'admitted-reference') return undefined;
    const parameter = plan.parent.origin.parameter;
    const references = call.recordRefs.filter(reference => reference.param === parameter);
    const reference = references[0];
    // The issued reference must be exactly the declared input model: the
    // plan parent selects either that row itself or its immutable parent
    // linkage, never an unrelated child of the parent model.
    const declared = queryParentInputModel(call.def as GeneratedOperationDef, parameter, plan.parent.model,
      state.bound.artifactModels);
    if (references.length !== 1 || reference === undefined ||
        reference.expectedVersion === null || reference.row.id !== reference.id ||
        reference.row.version !== reference.expectedVersion ||
        declared === undefined || reference.model !== declared) {
      return undefined;
    }
    // Direct same-model inputs resolve to the admitted row itself; a
    // one-hop navigation resolves to the admitted row's immutable parent
    // linkage, verified against the plan parent model here.
    const navigated = reference.model === plan.parent.model
      ? { model: reference.model, id: reference.id }
      : state.bound.artifactModels.get(reference.model)?.parent === plan.parent.model &&
        reference.row.parent?.model === plan.parent.model
        ? { model: plan.parent.model, id: reference.row.parent.id } : undefined;
    if (navigated === undefined) return undefined;
    admittedParent = navigated;
  }
  const executions = referenceProducers.get(call.def as GeneratedOperationDef)?.boundExecutionDependencies;
  const executionFields = [...executions?.values() ?? []].filter(value => value.association.queryId === plan.id)
    .map(value => value.association.dependency.field);
  if (stored !== (executionFields.length !== 0)) return undefined;
  const declared = new Set([...plan.dependencies.filter(dependency =>
    dependency.role === 'control' && dependency.field !== 'parent').map(dependency => dependency.field),
    ...(stored ? executionFields : [])]);
  if (!fields.every(field => declared.has(field))) return undefined;
  const read = producer.readPolicies.get(plan.model);
  if (read === undefined || !('grants' in read)) return undefined;
  if ([...declared].some(field => read.secretFields.some(secret => secret === field ||
      secret.startsWith(`${field}.`) || field.startsWith(`${secret}.`)))) return undefined;
  const stage = owner.stage;
  const decisionGrant = Object.freeze({ fields: Object.freeze([...declared]),
    read: async (observation: { readonly row: StoredRow }): Promise<boolean> => {
      if (!issuedIds.has(observation.row.id)) return false;
      const issued = ownerRows.get(observation.row);
      if (issued !== undefined && (issued.session !== owner || issued.stage !== stage ||
          issued.model !== plan.model)) return false;
      // Contained grants additionally pin the observed child row to the
      // admitted parent; rows from any other parent stay refused even
      // when issued in the same stage.
      if (admittedParent !== undefined && (observation.row.parent?.model !== admittedParent.model ||
          observation.row.parent?.id !== admittedParent.id)) return false;
      return true;
    } });
  const policies = new Map(producer.readPolicies);
  policies.set(plan.model, Object.freeze({ ...read,
    fields: read.fields, secretFields: read.secretFields,
    grants: Object.freeze([...read.grants, decisionGrant]) }));
  return policies;
}
/** Resolve only the checked source selector while the actual owner query is
 * busy. Its parent remains a retained authority witness even for zero rows. */
async function resolveQueryParent(call: AdmittedCall, store: StoragePort, owner: ReceiptOwnerSession,
  state: Capture, execution: QueryExecution): Promise<{ model: ModelName; id: RecordId } | undefined> {
  const parent = execution.plan.parent;
  if (parent === undefined) return undefined;
  const healthy = () => {
    capture(call, store); ownerHealthy(owner);
    if (owner.executingCall !== call || owner.stage !== execution.stage || !owner.busy || state.pending !== 0 || state.returnId !== null) {
      return invalid('query parent crossed its original owner stage.');
    }
  };
  healthy();
  let id: RecordId, original: StoredRow | undefined;
  if (parent.origin.kind === 'admitted-reference') {
    const parameter = parent.origin.parameter;
    const references = call.recordRefs.filter(ref => ref.param === parameter);
    const reference = references[0];
    const declared = queryParentInputModel(call.def as GeneratedOperationDef, parameter, parent.model,
      state.bound.artifactModels);
    if (references.length !== 1 || reference === undefined ||
        reference.expectedVersion === null || reference.row.id !== reference.id || reference.row.version !== reference.expectedVersion ||
        declared === undefined || reference.model !== declared) {
      return invalid('query parent requires its exact admitted versioned reference.');
    }
    if (reference.model === parent.model) {
      id = reference.id; original = reference.row;
    } else if (state.bound.artifactModels.get(reference.model)?.parent === parent.model &&
        reference.row.parent?.model === parent.model) {
      // One-hop navigation: the admitted row is version-pinned and its
      // parent linkage immutable, so the navigated parent id is exact for
      // this call; no same-model lifetime witness exists for the hop.
      id = reference.row.parent.id; original = undefined;
    } else {
      return invalid('query parent requires its exact admitted versioned reference.');
    }
  } else {
    const dependencyId = parent.origin.dependencyId;
    const observations = state.observations.filter(observation => observation.dependencyId === dependencyId);
    const observation = observations[0], issued = observation === undefined ? undefined : storedParentInputs.get(observation);
    const reference = state.bound.referenceDependencies.get(dependencyId);
    if (observations.length !== 1 || observation === undefined || issued?.call !== call || issued.owner !== owner ||
        issued.stage !== execution.stage || reference === undefined || reference.profile.target !== parent.model ||
        reference.profile.array || reference.profile.nullable || ownerRows.get(issued.row)?.session !== owner ||
        ownerRows.get(issued.row)?.stage !== execution.stage || ownerRows.get(issued.row)?.model !== observation.model) {
      return invalid('query parent requires its one genuine same-stage stored reference observation.');
    }
    await issued.revalidate(); healthy();
    const wire = storedReferenceWire(reference.profile, observation.row) as { id: RecordId };
    id = wire.id;
    const source = await owner.session!.views.final.get(observation.model, observation.row.id); healthy();
    if (source === null || !sameModelLifetime(observation.row, source) || stableStringify(source) !== stableStringify(observation.row)) {
      return invalid('query parent source differs from its original observation stage.');
    }
    await observeModelQuerySourceAuthority(call, store, owner, state, observation.model, source, [reference.profile.field]); healthy();
  }
  const row = await owner.session!.views.final.get(parent.model, id); healthy();
  if (row === null || row.archivedAt !== null || original !== undefined && !sameModelLifetime(original, row)) {
    throw new StateError('forbidden', 'Query parent lifetime is unavailable.');
  }
  await observeModelQuerySourceAuthority(call, store, owner, state, parent.model, row, []); healthy();
  execution.parent = deepFreeze(dataCopy({ model: parent.model, row,
    secretFields: [...state.bound.models.get(parent.model)!.secrets] }));
  return { model: parent.model, id };
}
/** Runs the real viewer engine over this transaction's complete bounded owner
 * stage. Native source runs once, sequentially; handles preserve original rows. */
export async function executeScenarioReceiptQuery(call: AdmittedCall, store: StoragePort, input: {
  readonly queryId: string;
  readonly predicate: (candidate: { readonly slot: ScenarioReceiptQuerySlot; readonly record: ProjectedRecord }) => boolean | Promise<boolean>;
}): Promise<ScenarioReceiptQueryResult> {
  return executeScenarioReceiptQueryMode(call, store, input, false);
}
/** The complete genuine domain precedes its stored-bool lambda. Only the
 * visited prefix reads CONTROL; the first true skips every later predicate. */
export async function executeScenarioReceiptAny(call: AdmittedCall, store: StoragePort, input: {
  readonly queryId: string;
  readonly predicate: (candidate: { readonly slot: ScenarioReceiptQuerySlot; readonly record: ProjectedRecord }) => boolean | Promise<boolean>;
}): Promise<boolean> {
  const result = await executeScenarioReceiptQueryMode(call, store, input, true);
  return result.count !== 0;
}
/** Exact owner-domain observation for a checked mutation decision. The caller
 * owns the active stage, bounded domain and commit fence; this path performs
 * no viewer projection or source read-policy evaluation. */
async function observeOwnerDecisionQuery(domain: readonly StoredRow[], model: CanonicalModelDescriptor,
  plan: ScenarioReceiptQueryPlan, revision: AdmittedCall['revision'],
  predicate: (record: ProjectedRecord, row: StoredRow) => boolean | Promise<boolean>): Promise<ObservedQueryResult> {
  const candidates: Array<{ row: StoredRow; record: ProjectedRecord; matched: boolean }> = [];
  for (const row of domain) {
    const record = projectSourceRowFields(row, [{ fields: Object.keys(row.data) }], []);
    const matched = await predicate(record, row);
    if (typeof matched !== 'boolean') return invalid('owner decision query predicate requires bool.');
    candidates.push({ row, record, matched });
  }
  const selected = candidates.map((candidate, index) => ({ ...candidate, index }))
    .filter(candidate => candidate.matched);
  const ordered = orderSourceReadRecords(selected.map(candidate => candidate.record), model,
    plan.order.length === 0 ? [{ field: 'id', direction: 'asc' }] : plan.order);
  if (plan.limit !== null && ordered.length > plan.limit) return invalid('owner decision query exceeds its declared limit.');
  const selectedIndices = ordered.map(record => selected.find(candidate => candidate.record === record)!.index);
  return { records: [...ordered], revision, candidates, selectedIndices };
}

async function executeScenarioReceiptQueryMode(call: AdmittedCall, store: StoragePort, input: {
  readonly queryId: string;
  readonly predicate: (candidate: { readonly slot: ScenarioReceiptQuerySlot; readonly record: ProjectedRecord }) => boolean | Promise<boolean>;
}, any: boolean): Promise<ScenarioReceiptQueryResult> {
  const state = capture(call, store), owner = ownerSessions.get(call);
  try {
    object(input, ['queryId', 'predicate']);
    if (owner === undefined || owner.session === null || state.returnId !== null || typeof input.predicate !== 'function') return invalid('query requires the actual active owner call and source predicate.');
    const plan = state.bound.plan.queries?.find(query => query.id === input.queryId);
    const producer = queryProducers.get(call.def as GeneratedOperationDef);
    const selection = querySelections.get(call.def as GeneratedOperationDef)?.get(input.queryId);
    const anyProfile = state.bound.anyQueries.get(input.queryId);
    if (plan === undefined || producer === undefined || producer.app !== call.context.app || state.queries.some(query => query.plan.id === plan.id)) return invalid('one actual execution per checked query occurrence required.');
    if (any !== (anyProfile !== undefined)) return invalid('query execution must match its exact source-bound ANY occurrence.');
    const firstMark = producer.first?.find(value => value.queryId === plan.id);
    const countFirstSeat = countFirstSeatProfile(call.def as GeneratedOperationDef, state.bound);
    if (countFirstSeat !== undefined && plan.id === countFirstSeat.count.id &&
        (owner.stage !== 0 || state.queries.length !== 0)) {
      return invalid('seat capacity count must execute first at its original pre-write owner stage.');
    }
    if (countFirstSeat !== undefined && plan.id === countFirstSeat.first.id) {
      const count = state.queries[0];
      if (owner.stage !== 0 || state.queries.length !== 1 || count?.plan.id !== countFirstSeat.count.id ||
          count.stage !== owner.stage || !count.ownerDecision || !count.complete || !count.countSelected ||
          count.firstSelected || count.anyConsumed || count.selectionConsumed) {
        return invalid('seat target first requires the original consumed capacity count before its query.');
      }
    }
    const otherAny = [...state.bound.anyQueries.values()].find(value => value.queryId !== plan.id);
    const pairedFirst = firstMark?.presenceConsumed === true && state.bound.resultModel === undefined &&
      state.bound.type === 'void' && state.bound.plan.queries?.length === 2 &&
      otherAny?.kind === 'predicate' && otherAny.model === plan.model &&
      stableStringify(otherAny.query.parent) === stableStringify(plan.parent);
    const pairedTarget = firstMark?.targetConsumed === true && state.bound.resultModel === undefined &&
      state.bound.type === 'void' && state.bound.plan.queries?.length === 2 &&
      otherAny?.kind === 'predicate' && otherAny.model === plan.model &&
      stableStringify(otherAny.query.parent) === stableStringify(plan.parent);
    const otherFirst = state.bound.plan.queries?.find(query => query.id !== plan.id);
    const pairedAny = anyProfile?.kind === 'predicate' && state.bound.resultModel === undefined &&
      state.bound.type === 'void' && state.bound.plan.queries?.length === 2 && otherFirst !== undefined &&
      otherFirst.model === plan.model && stableStringify(otherFirst.parent) === stableStringify(plan.parent) &&
      producer.first?.some(value => value.queryId === otherFirst.id &&
        (value.presenceConsumed === true || value.targetConsumed === true)) === true;
    const targetFirst = firstMark?.targetConsumed === true && state.bound.resultModel === undefined &&
      state.bound.type === 'void' && state.bound.plan.queries?.length === 1 &&
      state.bound.anyQueries.size === 0;
    if (firstMark?.presenceConsumed === true && state.bound.plan.queries?.length === 2 && !pairedFirst) {
      return invalid('decision-only first requires its exact checked companion ANY domain.');
    }
    if (firstMark?.targetConsumed === true && !targetFirst && !pairedTarget &&
        !(countFirstSeat !== undefined && plan.id === countFirstSeat.first.id)) {
      return invalid('selected write target requires its exact checked void decision.');
    }
    const ownerDecision = pairedAny === true || pairedFirst === true || pairedTarget === true || targetFirst ||
      countFirstSeat !== undefined && (plan.id === countFirstSeat.count.id || plan.id === countFirstSeat.first.id);
    const predicate = input.predicate;
    if (anyProfile?.kind === 'predicate') {
      const captured = producer.captureAnyPredicate?.(call, plan.id);
      if (captured !== predicate) return invalid('predicate ANY requires its exact once-captured active source callback.');
    }
    const execution: QueryExecution = { call, owner, stage: owner.stage, ownerDecision, plan, handle: Object.freeze({}), candidates: [],
      selectedIndices: [], activeSlot: null, complete: false, firstSelected: false, countSelected: false, anyConsumed: false, selectionConsumed: false, selectionSlot: null };
    queryHandles.set(execution.handle, execution); state.queries.push(execution);
    const memberships = scenarioReceiptMemberships(owner.call, store);
    const context = { actorUserId: call.context.actor?.userId ?? null, teamId: call.context.team?.teamId ?? null };
    return await ownerOperation(owner, async () => {
      const parent = await resolveQueryParent(call, store, owner, state, execution);
      const domain = await owner.session!.views.final.query({ model: plan.model, authority: 'owner',
        ...(parent === undefined ? {} : { parent }), limit: owner.maxRows, archived: plan.archived });
      for (const row of domain) ownerRows.set(row, { session: owner, stage: owner.stage, model: plan.model });
      // The exact checked any/first decision pair uses the owner domain.
      // Other query occurrences keep the viewer base below.
      const decisionPolicies = guardConsumedDecisionPolicies(call, owner, state, plan, [],
        new Set(domain.map(row => row.id)));
      const adapter = { ...store, readRevision: () => store.readRevision(), query: async () => domain };
      // Other queries keep ordinary viewer checks and source policies.
      const base = { model: plan.model, modelDescriptor: queryModelDescriptor(state.bound, plan), authority: 'viewer' as const,
        policy: producer.policy, context, memberships, store: producer.readPolicies === undefined ? adapter : store,
        ...(producer.readPolicies === undefined ? {} : { sourceReadPolicies: decisionPolicies ?? producer.readPolicies }), archived: plan.archived,
        ...(plan.order.length === 0 ? {} : { order: plan.order }), ...(plan.limit === null ? {} : { limit: plan.limit }) };
      const requiredFields = any ? [] : [...new Set(plan.dependencies.filter(dep => dep.role === 'control' && dep.field !== 'parent').map(dep => dep.field))];
      const stageRows = new Map<string, StoredRow | null>();
      const stageHealthy = () => {
        capture(call, store); ownerHealthy(owner);
        if (owner.stage !== execution.stage || owner.executingCall !== call || !owner.busy || state.pending !== 0 || execution.complete) {
          return invalid('source query crossed its actual owner stage.');
        }
      };
      const policyDomains = ownerPolicyDomains(owner, stageHealthy);
      const predicateDomain = anyProfile?.kind === 'predicate' && plan.parent === undefined ? domain : undefined;
      const stageReader = { assertHealthy: stageHealthy, policyQuery: policyDomains.capture,
        ...(predicateDomain === undefined ? {} : { query: predicateControlDomain(plan.model, predicateDomain, owner.maxRows, stageHealthy) }),
        read: async (model: ModelName, id: RecordId) => {
        stageHealthy(); const key = `${model}\0${id}`;
        if (!stageRows.has(key)) { stageRows.set(key, await owner.session!.views.final.get(model, id)); stageHealthy(); }
        return stageRows.get(key)!;
      } };
      const sourceAuthorities: Array<Awaited<ReturnType<typeof observeModelQuerySourceAuthority>> | undefined> = [];
      const observeCandidate = async (record: ProjectedRecord, row: StoredRow) => {
        ownerHealthy(owner);
        if (owner.executingCall !== call || owner.stage !== execution.stage) return invalid('query predicate crossed its original owner stage.');
        const sourceAuthority = !ownerDecision && (producer.readPolicies !== undefined || state.bound.resultModel !== undefined || plan.parent !== undefined || plan.dependencies.some(dep => dep.field === 'parent'))
          ? await observeModelQuerySourceAuthority(call, store, owner, state, plan.model, row,
            (any || selection !== undefined || (plan.parent !== undefined || producer.readPolicies !== undefined) && state.bound.resultModel === undefined) ? [] : plan.dependencies.map(dependency => dependency.field),
            0, predicateDomain, decisionPolicies) : undefined;
        sourceAuthorities.push(sourceAuthority);
        const slot = Object.freeze({});
        const candidate = { row, record: deepFreeze(dataCopy(record)), slot, dependencies: new Set<string>(),
          reads: new Map<string, number>(), markers: new Map<string, number>(), pendingRead: null as string | null, matched: false, parentRows: [] as StoredRow[] };
        querySlots.set(slot, { execution, index: execution.candidates.length }); execution.candidates.push(candidate);
        // ANY's collection is completed and ordered before any lambda runs.
        if (any) { candidate.matched = true; return true; }
        execution.activeSlot = slot;
        try {
          const accepted = await predicate(Object.freeze({ slot, record: queryPredicateRecord(execution, execution.candidates.length - 1, store) }));
          capture(call, store); ownerHealthy(owner);
          if (typeof accepted !== 'boolean') return invalid('query predicate requires an actual boolean.');
          if (candidate.pendingRead !== null || [...candidate.reads].some(([field, count]) => candidate.markers.get(field) !== count)) return invalid('query predicate omitted an executed control source marker.');
          if (candidate.parentRows.some(row => queryParentRows.get(row)?.observed !== true)) return invalid('query predicate omitted its issued owning parent observation.');
          await sourceAuthority?.requireFields(plan.dependencies.filter(dependency => candidate.dependencies.has(dependency.id)).map(dependency => dependency.field));
          candidate.matched = accepted; return accepted;
        } finally { execution.activeSlot = null; }
      };
      const observed = ownerDecision
        ? await observeOwnerDecisionQuery(domain, queryModelDescriptor(state.bound, plan), plan, call.revision, observeCandidate)
        : await queryRecordsObserved(base, observeCandidate, requiredFields,
          producer.readPolicies === undefined ? undefined : domain,
          producer.readPolicies === undefined ? undefined : stageReader);
      if (observed.candidates.length !== execution.candidates.length || observed.candidates.some((candidate, index) =>
        candidate.row !== execution.candidates[index]!.row || candidate.matched !== execution.candidates[index]!.matched)) return invalid('actual query engine lost original candidate correspondence.');
      if (any) {
        const ordered = observed.selectedIndices.map(index => execution.candidates[index]!);
        const authorities = observed.selectedIndices.map(index => sourceAuthorities[index]);
        if (ordered.length !== execution.candidates.length) return invalid('ANY requires the entire unfiltered original domain.');
        execution.candidates.splice(0, execution.candidates.length, ...ordered);
        sourceAuthorities.splice(0, sourceAuthorities.length, ...authorities);
        for (const [index, candidate] of execution.candidates.entries()) {
          candidate.matched = false; querySlots.set(candidate.slot, { execution, index });
        }
        const selected: number[] = [];
        for (const [index, candidate] of execution.candidates.entries()) {
          execution.activeSlot = candidate.slot;
          try {
            const profile = anyProfile!;
            // Every value comes from this occurrence's checked projection.
            // Predicate capture authenticates source; immediate markers retain
            // only fields that the checked callback actually read.
            if (profile.kind !== 'predicate') await sourceAuthorities[index]!.requireFields([profile.field]);
            const accepted = await predicate(Object.freeze({ slot: candidate.slot, record: queryPredicateRecord(execution, index, store) }));
            stageHealthy();
            if (profile.kind === 'predicate') {
              const first = plan.dependencies[0]!;
              if (typeof accepted !== 'boolean' || candidate.pendingRead !== null ||
                  candidate.reads.keys().next().value !== first.field ||
                  [...candidate.dependencies][0] !== profile.dependencyIds[0] ||
                  [...candidate.reads].some(([field, count]) => candidate.markers.get(field) !== count) ||
                  [...candidate.dependencies].some(id => !profile.dependencyIds.includes(id))) return invalid('predicate ANY requires its proved first read and exact executed CONTROL markers.');
              if (!ownerDecision) await sourceAuthorities[index]!.requireFields(plan.dependencies.filter(dependency => candidate.dependencies.has(dependency.id)).map(dependency => dependency.field));
              stageHealthy();
            } else if (typeof accepted !== 'boolean' || accepted !== candidate.record.data[profile.field] ||
                candidate.pendingRead !== null || candidate.reads.size !== 1 || candidate.reads.get(profile.field) !== 1 ||
                candidate.markers.get(profile.field) !== 1 || candidate.dependencies.size !== 1 ||
                !candidate.dependencies.has(profile.dependencyId)) return invalid('ANY requires its one actual stored-bool read, immediate marker and exact verdict.');
            await sourceAuthorities[index]?.revalidate(); stageHealthy();
            candidate.matched = accepted;
            if (accepted) { selected.push(index); break; }
          } finally { execution.activeSlot = null; }
        }
        execution.selectedIndices = Object.freeze(selected); execution.anyConsumed = true;
      } else execution.selectedIndices = Object.freeze([...observed.selectedIndices]);
      execution.complete = true;
      // Engine order is independent of authored predicate reads. Attribute its
      // selected-row fields without inventing source reads or markers.
      for (const index of execution.selectedIndices) for (const dependency of plan.dependencies) {
        if (dependency.role === 'control' && plan.order.some(term => term.field === dependency.field)) execution.candidates[index]!.dependencies.add(dependency.id);
      }
      // Projection DATA belongs only to actually selected rows. False
      // candidates establish visibility/control, not selected field access.
      if (!ownerDecision && (plan.parent !== undefined || producer.readPolicies !== undefined) && (state.bound.resultModel === undefined || selection !== undefined)) for (const index of execution.selectedIndices) {
        const candidate = execution.candidates[index]!;
        await sourceAuthorities[index]?.requireFields(plan.dependencies.filter(dependency => dependency.role === 'data' ||
          candidate.dependencies.has(dependency.id)).map(dependency => dependency.field));
      }
      // Recheck the same full domain and current grants without rerunning source.
      // Later own writes never substitute for this original intermediate stage.
      if (owner.callGuards.length >= MAX_ITEMS) return invalid('query commit guard budget exceeded.');
      owner.callGuards.push(Object.freeze({ name: `query:${call.def.name}:${plan.id}`, evaluate: async () => {
        if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Query checkpoint moved before outer commit.');
        if (ownerDecision) return true;
        const guardInput = { ...base }; delete guardInput.limit;
        const final = owner.finalized;
        const finalHealthy = () => {
          if (final === null || owner.finalized !== final || owner.capture.poisoned) return invalid('source query final owning effects are unavailable.');
        };
        const originalReader = { assertHealthy: finalHealthy, policyQuery: policyDomains.retained(finalHealthy),
          ...(predicateDomain === undefined ? {} : { query: predicateControlDomain(plan.model, predicateDomain, owner.maxRows, finalHealthy) }),
          read: async (model: ModelName, id: RecordId) => {
          finalHealthy(); const key = `${model}\0${id}`;
          if (!stageRows.has(key)) throw new StateError('forbidden', 'Source query guard requested an unobserved original ancestor.');
          return stageRows.get(key)!;
        } };
        const current = await queryRecordsObserved(guardInput, () => true, requiredFields,
          producer.readPolicies === undefined ? undefined : domain, producer.readPolicies === undefined ? undefined : originalReader);
        const original = observed.candidates.map(candidate => candidate.record).sort((a, b) =>
          current.records.findIndex(row => row.id === a.id) - current.records.findIndex(row => row.id === b.id));
        const domainWitness = (records: readonly ProjectedRecord[]) => any
          ? records.map(record => ({ ...record, data: null })) : records;
        if (stableStringify(domainWitness(current.records)) !== stableStringify(domainWitness(original))) throw new StateError('forbidden', 'Original query domain or field authority changed before commit.');
        if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Query authority read moved beyond outer checkpoint.');
        return true;
      } }));
      return Object.freeze({ query: execution.handle, rows: Object.freeze(execution.selectedIndices.map(index => {
        const candidate = execution.candidates[index]!; return Object.freeze({ slot: candidate.slot, record: candidate.record });
      })), count: execution.selectedIndices.length });
    }, call);
  } catch (error) { state.poisoned = true; if (owner !== undefined) owner.capture.poisoned = true; throw error; }
}
const queryParentRows = new WeakMap<StoredRow, { readonly execution: QueryExecution;
  readonly slot: ScenarioReceiptQuerySlot; readonly dependencyId: string; observed: boolean }>();

/** Finite active-query navigation for Run.parent → Branch.parent. The parent
 * comes from the actual candidate and declared containment, never request IDs.
 * Its ordinary dependency still observes the owning Branch metadata separately. */
export async function readScenarioReceiptQueryParentRow(call: AdmittedCall, store: StoragePort, input: {
  readonly slot: ScenarioReceiptQuerySlot; readonly dependencyId: string;
}): Promise<StoredRow> {
  let state: Capture | undefined, acquired = false;
  const slotMember = typeof input === 'object' && input !== null ? Object.getOwnPropertyDescriptor(input, 'slot') : undefined;
  const issued = slotMember !== undefined && 'value' in slotMember ? querySlots.get(slotMember.value) : undefined;
  try {
    state = capture(call, store); object(input, ['slot', 'dependencyId']);
    const execution = issued?.execution, owner = ownerSessions.get(call);
    const candidate = execution?.candidates[issued!.index];
    const dependency = state.bound.referenceDependencies.get(input.dependencyId);
    const parent = candidate?.row.parent;
    if (execution === undefined || candidate === undefined || owner === undefined || owner.session === null ||
        execution.call !== call || execution.owner !== owner || execution.stage !== owner.stage || !owner.busy ||
        owner.executingCall !== call || execution.activeSlot !== input.slot || execution.complete || state.pending !== 0 ||
        state.returnId !== null || parent == null || dependency?.profile.kind !== 'parent' ||
        dependency.dependency.queryId !== undefined && dependency.dependency.queryId !== execution.plan.id ||
        dependency.dependency.model !== parent.model || state.bound.artifactModels.get(execution.plan.model)?.parent !== parent.model ||
        candidate.pendingRead !== null || (candidate.reads.get('parent') ?? 0) === 0 ||
        !execution.plan.dependencies.some(dep => dep.role === 'control' && dep.field === 'parent' && dep.type === parent.model &&
          candidate.dependencies.has(dep.id))) {
      return invalid('parent navigation requires its actual active query slot and exact owning parent dependency.');
    }
    ownerHealthy(owner); state.pending += 1; acquired = true;
    const healthy = () => {
      capture(call, store); ownerHealthy(owner);
      if (owner.executingCall !== call || owner.stage !== execution.stage || !owner.busy || state!.pending !== 1 ||
          state!.returnId !== null || execution.activeSlot !== input.slot || execution.complete) {
        return invalid('query parent navigation crossed its original active candidate.');
      }
    };
    const row = await owner.session.views.final.get(parent.model, parent.id); healthy();
    if (row === null || row.archivedAt !== null || row.parent?.model !== dependency.profile.target) {
      throw new StateError('forbidden', 'Query candidate parent lifetime is unavailable.');
    }
    await observeModelQuerySourceAuthority(call, store, owner, state, parent.model, row, [], 1); healthy();
    // Each issuance has its own identity even when two candidates share Branch.
    const original = deepFreeze(dataCopy(row));
    ownerRows.set(original, { session: owner, stage: owner.stage, model: parent.model });
    queryParentRows.set(original, { execution, slot: input.slot, dependencyId: input.dependencyId, observed: false });
    candidate.parentRows.push(original);
    return original;
  } catch (error) {
    if (state !== undefined) state.poisoned = true;
    if (issued !== undefined) issued.execution.owner.capture.poisoned = true;
    throw error;
  } finally { if (acquired) state!.pending -= 1; }
}

/** Consume first at its original owner stage. This supplies the genuine row for
 * native private binding; ordinary field/mutation gates still own authority.
 * Every matched index remains saved: first is never a query limit/truncation. */
export async function selectScenarioReceiptQueryFirstRow(call: AdmittedCall, store: StoragePort, input: {
  readonly query: ScenarioReceiptQueryHandle;
  readonly first?: Pick<ScenarioReceiptQueryFirstMetadata, 'node' | 'statement'>;
}): Promise<StoredRow | null> {
  const state = capture(call, store), owner = ownerSessions.get(call);
  try {
    object(input, ['query', ...(Object.hasOwn(input, 'first') ? ['first'] : [])]);
    const query = queryHandles.get(input.query);
    const metadata = queryProducers.get(call.def as GeneratedOperationDef)?.first?.find(value => value.queryId === query?.plan.id);
    let originalFirst = false;
    if (Object.hasOwn(input, 'first')) {
      const marker = object(input.first, ['node', 'statement']);
      const node = firstQueryNode(marker.node), statement = firstQueryNode(marker.statement);
      if (metadata === undefined || stableStringify({ node, statement }) !== stableStringify({ node: metadata.node, statement: metadata.statement })) return invalid('first consumer differs from its actual checked Let and call.');
      originalFirst = true;
    }
    if (metadata !== undefined && !originalFirst) return invalid('checked first consumer omitted its original Let and call.');
    const executionFirst = originalFirst || query !== undefined && [...referenceProducers.get(call.def as GeneratedOperationDef)?.boundExecutionDependencies.values() ?? []]
      .some(value => value.association.queryId === query.plan.id);
    if (owner === undefined || state.bound.resultModel === undefined && !executionFirst || owner.busy || state.pending !== 0 || state.returnId !== null ||
        owner.executingCall !== call || query === undefined || query.call !== call || query.owner !== owner ||
        query.stage !== owner.stage || !query.complete || query.firstSelected || query.countSelected || query.selectionConsumed || query.anyConsumed ||
        querySelections.get(call.def as GeneratedOperationDef)?.has(query.plan.id) === true ||
        !state.bound.plan.returns.some(returned => returned.projection === undefined && returnQueryIds(returned).includes(query.plan.id)) &&
        !executionFirst) {
      return invalid('first requires its genuine completed singular-model query at the original owner stage.');
    }
    ownerHealthy(owner);
    const index = query.selectedIndices[0], row = index === undefined ? null : query.candidates[index]!.row;
    const issued = row === null ? undefined : ownerRows.get(row);
    if (row !== null && (issued?.session !== owner || issued.stage !== owner.stage || issued.model !== query.plan.model)) {
      return invalid('first lost its genuine original selected owner row.');
    }
    return await ownerOperation(owner, async () => {
      // DESIGN442: the confined decision shape records its selected-row
      // authority as the same owner decision; unmarked rows keep viewer.
      const decisionFields = row === null ? [] : [...new Set(state.bound.plan.returns
        .filter(returned => returnQueryIds(returned).includes(query.plan.id))
        .flatMap(returned => returned.dependencies
          .filter(dependency => dependency.model === query.plan.model).map(dependency => dependency.field)))];
      const decisionPolicies = row === null ? undefined : guardConsumedDecisionPolicies(call, owner, state,
        query.plan, decisionFields, new Set([row.id]));
      if (row !== null && !query.ownerDecision) await observeModelQuerySourceAuthority(call, store, owner, state, query.plan.model, row,
        decisionFields, 0, undefined, decisionPolicies);
      query.firstSelected = true; return row;
    }, call);
  } catch (error) {
    state.poisoned = true; if (owner !== undefined) owner.capture.poisoned = true;
    const issued = queryHandles.get(input?.query); if (issued !== undefined) issued.owner.capture.poisoned = true;
    throw error;
  }
}
/** Consume an actual count occurrence without performing a first-row read.
 * The owning query evidence retains every original match and false candidate;
 * this typed int does not attest native arithmetic or mint query authority. */
export async function bindScenarioReceiptQueryCount(call: AdmittedCall, store: StoragePort, input: {
  readonly query: ScenarioReceiptQueryHandle;
}): Promise<bigint> {
  const state = capture(call, store), owner = ownerSessions.get(call);
  try {
    object(input, ['query']);
    const query = queryHandles.get(input.query);
    const countFirstSeat = countFirstSeatProfile(call.def as GeneratedOperationDef, state.bound);
    const voidSeatCount = state.bound.resultModel === undefined && countFirstSeat !== undefined &&
      query?.plan.id === countFirstSeat.count.id && query.ownerDecision && query.stage === 0 &&
      owner?.stage === 0 && state.queries.length === 1 && state.queries[0] === query;
    if (owner === undefined || state.bound.resultModel === undefined && !voidSeatCount || owner.busy || state.pending !== 0 || state.returnId !== null ||
        owner.executingCall !== call || query === undefined || query.call !== call || query.owner !== owner ||
        query.stage !== owner.stage || !query.complete || query.firstSelected || query.countSelected || query.selectionConsumed || query.anyConsumed ||
        querySelections.get(call.def as GeneratedOperationDef)?.has(query.plan.id) === true ||
        !state.bound.plan.returns.some(returned => returned.projection === undefined && returnQueryIds(returned).includes(query.plan.id))) {
      return invalid('count requires its genuine completed singular-model query at the original owner stage.');
    }
    return await ownerOperation(owner, async () => {
      query.countSelected = true; return BigInt(query.selectedIndices.length);
    }, call);
  } catch (error) {
    state.poisoned = true; if (owner !== undefined) owner.capture.poisoned = true;
    const issued = queryHandles.get(input?.query); if (issued !== undefined) issued.owner.capture.poisoned = true;
    throw error;
  }
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
    const observed = dependency?.field === 'parent'
      ? candidate.row.parent != null && candidate.row.parent.model === dependency.type &&
        stableStringify(candidate.row.parent) === stableStringify(candidate.record.parent)
      : dependency !== undefined && Object.hasOwn(candidate.record.data, dependency.field);
    if (dependency === undefined || dependency.role !== 'control' || !observed ||
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
/** Bind the eager original message selection before count/concat. The loader
 * owns the recipe; only genuine selected slots and receiving facts enter here. */
export async function bindScenarioReceiptQuerySelection(call: AdmittedCall, store: StoragePort, input: {
  readonly query: ScenarioReceiptQueryHandle; readonly wire: unknown;
  readonly rows: readonly { readonly slot: ScenarioReceiptQuerySlot; readonly files: readonly FinalizedFileObservation[] }[];
}): Promise<readonly unknown[]> {
  let state: Capture | undefined, owner: ReceiptOwnerSession | undefined, execution: QueryExecution | undefined, acquired = false;
  try {
    state = capture(call, store); owner = ownerSessions.get(call);
    object(input, ['query', 'wire', 'rows']);
    execution = queryHandles.get(input.query);
    const profile = querySelections.get(call.def as GeneratedOperationDef)?.get(execution?.plan.id ?? ''), producer = queryProducers.get(call.def as GeneratedOperationDef),
      files = fileProducers.get(call.def as GeneratedOperationDef);
    if (owner === undefined || owner.session === null || owner.busy || state.pending !== 0 || state.returnId !== null ||
        owner.executingCall !== call || execution === undefined || execution.call !== call || execution.owner !== owner ||
        execution.stage !== owner.stage || !execution.complete || execution.firstSelected || execution.countSelected || execution.selectionConsumed ||
        execution.selectionSlot !== null || profile === undefined || producer?.readPolicies === undefined || files?.app !== call.context.app) {
      return invalid('selected messages require their exact completed query, recipe, owner stage and receiving producer.');
    }
    if (!Array.isArray(input.rows) || Object.getPrototypeOf(input.rows) !== Array.prototype ||
        Reflect.ownKeys(input.rows).length !== input.rows.length + 1 || input.rows.length !== execution.selectedIndices.length) {
      return invalid('exact dense ordered selected slot census required.');
    }
    const rows = Array.from({ length: input.rows.length }, (_, index) => {
      const property = Object.getOwnPropertyDescriptor(input.rows, String(index));
      if (property === undefined || !('value' in property) || !property.enumerable) return invalid('own selected slots required.');
      const row = property.value as typeof input.rows[number]; object(row, ['slot', 'files']);
      if (row.slot !== execution!.candidates[execution!.selectedIndices[index]!]!.slot) return invalid('selected slots differ from actual complete query order.');
      return row;
    });
    const wire = scenarioQuerySelectionWire(profile, execution.selectedIndices.map(index => execution!.candidates[index]!.record));
    if (stableStringify(wire) !== stableStringify(dataCopy(input.wire))) return invalid('selected message wire differs from its actual owning fields and order.');
    ownerHealthy(owner); owner.busy = true; acquired = true;
    const stage = owner.stage, healthy = () => {
      capture(call, store); ownerHealthy(owner!);
      if (owner!.executingCall !== call || owner!.stage !== stage || !owner!.busy || state!.pending !== 0 || state!.returnId !== null ||
          execution!.stage !== stage || !execution!.complete || execution!.selectionConsumed) return invalid('selected message capture crossed its original owner stage.');
    };
    const retained: Array<() => Promise<void>> = [];
    for (let index = 0; index < rows.length; index++) {
      const candidate = execution.candidates[execution.selectedIndices[index]!]!;
      ownerRows.set(candidate.row, { session: owner, stage, model: profile.model });
      execution.activeSlot = candidate.slot; execution.selectionSlot = candidate.slot;
      try {
        for (const field of profile.fields) {
          await observeScenarioReceiptDependency(call, store, { dependencyId: field.dependencyId, model: profile.model,
            row: candidate.row, field: field.field, ...(field.fileProfile === undefined ? {} : { files: rows[index]!.files }) });
          healthy();
          for (const dependency of execution.plan.dependencies) if (dependency.role === 'data' && dependency.field === field.field) candidate.dependencies.add(dependency.id);
          if (field.fileProfile !== undefined) {
            const observation = state.observations.at(-1)!; const captured = storedFileInputs.get(observation);
            if (captured?.call !== call || captured.owner !== owner || captured.stage !== stage) return invalid('selected attachments lost their actual receiving observation.');
            retained.push(captured.revalidate);
          }
        }
      } finally { execution.activeSlot = null; execution.selectionSlot = null; }
    }
    // One complete current source/ancestor/Identity conjunction follows all
    // selected File awaits; false candidates require only their actual controls.
    const memberships = scenarioReceiptMemberships(owner.call, store), actorUserId = call.context.actor?.userId ?? null,
      teamId = call.context.team?.teamId ?? null;
    const membership = actorUserId === null || teamId === null ? null : await memberships.findMembership(teamId, actorUserId); healthy();
    const authority = await observeRowGrantAuthority({ actorUserId, teamId, membership, memberships }, async context => {
      for (const candidate of execution!.candidates) {
        const current = await owner!.session!.views.final.get(profile.model, candidate.row.id); healthy();
        if (current === null || !sameModelLifetime(candidate.row, current) || stableStringify(current) !== stableStringify(candidate.row)) {
          throw new StateError('forbidden', 'Selected query row differs from its original stage.');
        }
        const projected = await projectInstalledSourceRowAndAncestors({ model: profile.model, row: current,
          readPolicies: producer.readPolicies!, policy: producer.policy, context, revision: call.revision, fence: undefined,
          store, rows: new Map([[`${profile.model}\0${current.id}`, current]]), ownerRows: { assertHealthy: healthy,
            read: async (model, id) => { healthy(); const row = await owner!.session!.views.final.get(model, id); healthy(); return row; } } }); healthy();
        const required = execution!.plan.dependencies.filter(dependency => candidate.dependencies.has(dependency.id)).map(dependency => dependency.field);
        if (projected.record === null || required.some(field => !Object.hasOwn(projected.record!.data, field) ||
            !projected.grants.some(grant => grant.fields.includes(field)))) throw new StateError('forbidden', 'Original selected query source fields are unavailable.');
      }
      if (execution!.parent !== undefined) {
        const parent = execution!.parent, current = await owner!.session!.views.final.get(parent.model, parent.row.id); healthy();
        if (current === null || !sameModelLifetime(parent.row, current)) throw new StateError('forbidden', 'Original selection parent lifetime changed.');
        const projected = await projectInstalledSourceRowAndAncestors({ model: parent.model, row: current,
          readPolicies: producer.readPolicies!, policy: producer.policy, context, revision: call.revision, fence: undefined, store,
          rows: new Map([[`${parent.model}\0${current.id}`, current]]), ownerRows: { assertHealthy: healthy,
            read: async (model, id) => { healthy(); const row = await owner!.session!.views.final.get(model, id); healthy(); return row; } } }); healthy();
        if (projected.record === null) throw new StateError('forbidden', 'Original selection parent authority is unavailable.');
      }
      return true;
    }); healthy();
    for (const revalidate of retained) { await revalidate(); healthy(); }
    if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Selected message capture moved beyond its checkpoint.');
    healthy(); await authority.revalidate(); healthy();
    if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Selected message final authority moved beyond its checkpoint.');
    healthy();
    execution.selectionConsumed = true;
    return wire;
  } catch (error) {
    if (state !== undefined) state.poisoned = true;
    if (owner !== undefined) owner.capture.poisoned = true;
    const property = typeof input === 'object' && input !== null ? Object.getOwnPropertyDescriptor(input, 'query') : undefined;
    const issuing = property !== undefined && 'value' in property ? queryHandles.get(property.value) : undefined;
    if (issuing !== undefined) issuing.owner.capture.poisoned = true;
    if (error instanceof FenceConflictError) throw new StateError('conflict', 'Selected message capture moved beyond its checkpoint.');
    throw error;
  } finally {
    if (execution !== undefined && acquired) { execution.activeSlot = null; execution.selectionSlot = null; }
    if (owner !== undefined && acquired) owner.busy = false;
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

/** A declared due event is a private owner source. Its root is the exact
 * admitted Work reference; containment navigation can only follow that
 * current row's actual parent chain. This grants the handler's checked
 * parent dependency without substituting a null-actor viewer policy. */
async function observeEventOwnerReferenceAuthority(call: AdmittedCall, store: StoragePort,
  owner: ReceiptOwnerSession, state: Capture, dependencyId: string, row: StoredRow,
  profile: StoredReferenceFieldProfile, model: ModelName): Promise<(() => Promise<void>) | undefined> {
  const sources = frameworkProducers.get(call.def as GeneratedOperationDef)?.sendGuards
    ?.flatMap(guard => guard.eventSource === undefined ? [] : [guard.eventSource]) ?? [];
  const recipient = admittedEventRecipientDependencies(call, state);
  const recipientLink = recipient?.sourceId === dependencyId && profile.kind === 'field' &&
    model === 'appointments.Appointment' && profile.field === 'contact' &&
    profile.target === 'customer.Contact' && !profile.array && !profile.nullable;
  if (sources.length === 0 || profile.kind !== 'parent' && !recipientLink) return undefined;
  const source = admittedEventIntrinsic(call, 'eventTerm');
  if (source === undefined || owner.call !== call || owner.session === null ||
      owner.callGuards.length >= MAX_ITEMS) return invalid('event parent requires its actual due owner source.');
  const due = dueWorkAdmissions.get(call)!;
  const payload = object(due.eventPayload, [source.modelField.name, source.revisionField.name]);
  const workRef = decodeValue(source.modelField.model, payload[source.modelField.name]) as { readonly id: string };
  const admittedRef = call.recordRefs.find(ref => ref.param === source.modelField.name &&
    ref.model === source.modelField.model && ref.id === workRef.id);
  if (admittedRef === undefined ||
      (decodeValue(source.modelField.model, admittedInputWire(call.inputs, source.modelField.name)) as { readonly id: string }).id !== workRef.id ||
      decodeValue('int', payload[source.revisionField.name]) !==
        decodeValue('int', admittedInputWire(call.inputs, source.revisionField.name))) {
    return invalid('event parent lacks its exact retained Work reference and revision.');
  }
  const stage = owner.stage;
  const healthy = () => {
    capture(call, store); ownerHealthy(owner);
    if (owner.executingCall !== call || owner.stage !== stage || !owner.busy || state.pending !== 1 ||
        state.returnId !== null) return invalid('event parent crossed its original owner observation.');
  };
  const chain: Array<{ readonly model: ModelName; readonly row: StoredRow }> = [];
  let currentModel = source.modelField.model as ModelName;
  let currentId = admittedRef.id;
  for (let depth = 0; depth < 8; depth++) {
    healthy();
    const current = await owner.session.views.final.get(currentModel, currentId);
    healthy();
    if (current === null || current.archivedAt !== null || current.id !== currentId ||
        (depth === 0 && !sameModelLifetime(admittedRef.row, current))) {
      throw new StateError('forbidden', 'Event parent source row lifetime is unavailable.');
    }
    chain.push({ model: currentModel, row: deepFreeze(dataCopy(current)) });
    if (currentModel === model && currentId === row.id) {
      if (stableStringify(current) !== stableStringify(row) ||
          (recipientLink ? depth !== 0 || !Object.hasOwn(current.data, 'contact') : current.parent?.model !== profile.target) ||
          storedReferenceWire(profile, current) === undefined) {
        throw new StateError('forbidden', 'Event reference differs from its current source row.');
      }
      const saved = chain.map(entry => ({ model: entry.model, row: entry.row }));
      const revalidate = async () => {
        healthy();
        for (const entry of saved) {
          const now = await owner.session!.views.final.get(entry.model, entry.row.id);
          healthy();
          if (now === null || stableStringify(now) !== stableStringify(entry.row)) {
            throw new StateError('forbidden', 'Event parent source changed during its original observation.');
          }
        }
        if (await store.readRevision() !== call.revision) {
          throw new StateError('conflict', 'Event parent source moved beyond its admitted checkpoint.');
        }
      };
      await revalidate();
      owner.callGuards.push(Object.freeze({ name: `event-parent:${call.def.name}:${dependencyId}:${stage}`, evaluate: async () => {
        const final = owner.finalized;
        if (final === null || owner.capture.poisoned) return invalid('event parent lacks actual final owner effects.');
        for (const entry of saved) {
          const write = final.writes.find(write => write.model === entry.model &&
            (write.kind === 'insert' ? write.row.id : write.id) === entry.row.id);
          const now = write === undefined
            ? await store.cohortLoad({ model: entry.model, id: entry.row.id, expectedRevision: call.revision })
            : write.kind === 'remove' ? null : write.row;
          if (owner.finalized !== final || owner.capture.poisoned || now === null ||
              stableStringify(now) !== stableStringify(entry.row)) {
            throw new StateError('forbidden', 'Event parent source changed before commit.');
          }
        }
        if (await store.readRevision() !== call.revision) {
          throw new StateError('conflict', 'Event parent source moved beyond its original checkpoint.');
        }
        return true;
      } }));
      return revalidate;
    }
    if (current.parent === null || current.parent === undefined) break;
    currentModel = current.parent.model;
    currentId = current.parent.id;
  }
  return undefined;
}

/** A private Reminder may read only the Contact actually stored on its Work
 * appointment. Freeze both rows and the email-bearing target at observation,
 * then compare those same full rows against the final atomic commit. */
async function observeEventRecipientTargetAuthority(call: AdmittedCall, store: StoragePort,
  owner: ReceiptOwnerSession, state: Capture, source: StoredRow, target: StoredRow,
  sourceDependencyId: string, leafDependencyId: string): Promise<() => Promise<void>> {
  const pair = admittedEventRecipientDependencies(call, state);
  if (pair?.sourceId !== sourceDependencyId || pair.leafId !== leafDependencyId ||
      owner.call !== call || owner.session === null || owner.callGuards.length >= MAX_ITEMS ||
      target.archivedAt !== null || !Object.hasOwn(target.data, 'email')) {
    return invalid('event recipient requires its exact current Appointment.contact and Contact.email dependency pair.');
  }
  const due = dueWorkAdmissions.get(call)!;
  const event = admittedEventIntrinsic(call, 'eventTerm')!;
  const payload = object(due.eventPayload, [event.modelField.name, event.revisionField.name]);
  const ref = decodeValue(event.modelField.model, payload[event.modelField.name]) as { readonly id: string };
  const sourceProfile = state.bound.referenceDependencies.get(sourceDependencyId)?.profile;
  const contactRef = sourceProfile === undefined ? undefined : storedReferenceWire(sourceProfile, source) as { readonly id: string };
  if (source.id !== ref.id || source.archivedAt !== null || contactRef?.id !== target.id ||
      !call.recordRefs.some(admitted => admitted.param === event.modelField.name &&
        admitted.model === event.modelField.model && admitted.id === source.id && sameModelLifetime(admitted.row, source))) {
    throw new StateError('forbidden', 'Event recipient is not linked from its admitted Work appointment.');
  }
  const stage = owner.stage;
  const healthy = () => {
    capture(call, store); ownerHealthy(owner);
    if (owner.executingCall !== call || owner.stage !== stage || !owner.busy || state.pending !== 1 ||
        state.returnId !== null) return invalid('event recipient crossed its original owner observation.');
  };
  const saved = [
    { model: 'appointments.Appointment' as ModelName, row: deepFreeze(dataCopy(source)) },
    { model: 'customer.Contact' as ModelName, row: deepFreeze(dataCopy(target)) },
  ];
  const revalidate = async () => {
    healthy();
    for (const entry of saved) {
      const current = await owner.session!.views.final.get(entry.model, entry.row.id);
      healthy();
      if (current === null || stableStringify(current) !== stableStringify(entry.row)) {
        throw new StateError('forbidden', 'Event recipient changed during its original observation.');
      }
    }
    if (await store.readRevision() !== call.revision) {
      throw new StateError('conflict', 'Event recipient moved beyond its admitted checkpoint.');
    }
  };
  await revalidate();
  owner.callGuards.push(Object.freeze({ name: `event-recipient:${call.def.name}:${sourceDependencyId}:${leafDependencyId}:${stage}:${owner.callGuards.length}`,
    evaluate: async () => {
      const final = owner.finalized;
      if (final === null || owner.capture.poisoned) return invalid('event recipient lacks actual final owner effects.');
      for (const entry of saved) {
        const write = final.writes.find(write => write.model === entry.model &&
          (write.kind === 'insert' ? write.row.id : write.id) === entry.row.id);
        const current = write === undefined
          ? await store.cohortLoad({ model: entry.model, id: entry.row.id, expectedRevision: call.revision })
          : write.kind === 'remove' ? null : write.row;
        if (owner.finalized !== final || owner.capture.poisoned || current === null ||
            stableStringify(current) !== stableStringify(entry.row)) {
          throw new StateError('forbidden', 'Event recipient changed before commit.');
        }
      }
      if (await store.readRevision() !== call.revision) {
        throw new StateError('conflict', 'Event recipient moved beyond its original checkpoint.');
      }
      return true;
    } }));
  return revalidate;
}

/** Current origin authority is observed before native promotion. The exact
 * facts survive child awaits and join Invoke's mandatory private guard ledger;
 * target admission remains independent and no target row is loaded here. */
async function observeReferenceAuthority(call: AdmittedCall, store: StoragePort, owner: ReceiptOwnerSession,
  state: Capture, dependencyId: string, row: StoredRow, profile: StoredReferenceFieldProfile, model: ModelName): Promise<() => Promise<void>> {
  const eventOwner = await observeEventOwnerReferenceAuthority(call, store, owner, state, dependencyId, row, profile, model);
  if (eventOwner !== undefined) return eventOwner;
  const producer = referenceProducers.get(call.def as GeneratedOperationDef);
  if (producer === undefined || producer.app !== call.context.app || owner.session === null ||
      stableStringify(producer.source) !== stableStringify(state.bound.plan.source)) return invalid('matching installed reference source policy required.');
  const read = producer.readPolicies?.get(model);
  if (read !== undefined && 'grants' in read) {
    const current = await owner.session.views.final.get(model, row.id);
    capture(call, store); ownerHealthy(owner);
    if (owner.executingCall !== call || !owner.busy || state.pending !== 1 || state.returnId !== null ||
        current === null || !sameModelLifetime(row, current) || stableStringify(current) !== stableStringify(row)) {
      throw new StateError('forbidden', 'Source reference differs from its original current owner observation.');
    }
    const authority = await observeModelQuerySourceAuthority(call, store, owner, state, model, current, [profile.field], 1);
    return authority.revalidate;
  }
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

/** Stored File arguments use the existing owner rows, source projector and
 * physical Files producer. No wire/reference shape issues an observation. */
async function observeStoredFileAuthority(call: AdmittedCall, store: StoragePort, owner: ReceiptOwnerSession,
  state: Capture, dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number],
  row: StoredRow, profile: ScenarioFileFieldProfile | StoredNominalFieldProfile, observations: readonly FinalizedFileObservation[]): Promise<{
    readonly files: readonly RetainedFinalizedFile[]; readonly revalidate: () => Promise<void>;
  }> {
  const source = dependency.queryId === undefined ? referenceProducers.get(call.def as GeneratedOperationDef) :
    querySourceProducer(call.def as GeneratedOperationDef, dependency.model), producer = fileProducers.get(call.def as GeneratedOperationDef);
  const read = source?.readPolicies?.get(dependency.model);
  if (owner.session === null || source?.app !== call.context.app || source.readPolicies === undefined || read === undefined ||
      !('grants' in read) || producer?.app !== call.context.app || owner.callGuards.length >= MAX_ITEMS ||
      owner.storedFileChecks.length >= MAX_ITEMS) return invalid('stored File source requires its installed original grants and receiving Files producer.');
  const receiving = fileReceiver(producer.app, call.context.actor?.userId ?? null, call.context.team?.teamId ?? null);
  const fileRefs = (wire: unknown) => 'hasFiles' in profile ? storedNominalFileRefs(profile, wire) : scenarioFileWireRefs(profile, wire);
  const wire = dependencyObservedWire(dependency, row), refs = [...new Set(fileRefs(wire))];
  if (!Array.isArray(observations) || Object.getPrototypeOf(observations) !== Array.prototype) return invalid('own dense File observation array required.');
  const length = Object.getOwnPropertyDescriptor(observations, 'length');
  if (length === undefined || !('value' in length) || length.value !== refs.length ||
      Reflect.ownKeys(observations).length !== refs.length + 1) return invalid('complete distinct File observation census required.');
  const facts = new Map<string, RetainedFinalizedFile>();
  for (let index = 0; index < refs.length; index++) {
    const item = Object.getOwnPropertyDescriptor(observations, String(index));
    if (item === undefined || !('value' in item) || !item.enumerable) return invalid('own dense File observation array required.');
    const fact = readLiveScenarioFile(item.value, receiving);
    if (fact === null || !refs.includes(fact.ref) || facts.has(fact.ref)) return invalid('genuine exact receiving File census required.');
    facts.set(fact.ref, fact);
  }
  const files = Object.freeze(refs.map(ref => facts.get(ref)!)), stage = owner.stage;
  const healthy = () => {
    capture(call, store); ownerHealthy(owner);
    if (owner.executingCall !== call || owner.stage !== stage || !owner.busy || state.pending !== 1 || state.returnId !== null) {
      return invalid('stored File capture crossed its original parent stage.');
    }
  };
  const reader = scenarioReceiptMemberships(owner.call, store), actorUserId = call.context.actor?.userId ?? null,
    teamId = call.context.team?.teamId ?? null;
  const membership = actorUserId === null || teamId === null ? null : await reader.findMembership(teamId, actorUserId); healthy();
  const context: ByContext = { actorUserId, teamId, membership, memberships: reader };
  const project = async (current: StoredRow, observed: ByContext, load: (model: ModelName, id: RecordId) => Promise<StoredRow | null>, assertHealthy: () => void) => {
    try {
      return await projectInstalledSourceRowAndAncestors({ model: dependency.model, row: current,
        readPolicies: source.readPolicies!, policy: source.policy, context: observed, revision: call.revision,
        fence: undefined, store, rows: new Map([[`${dependency.model}\0${current.id}`, current]]), ownerRows: { read: load, assertHealthy } });
    } catch (error) {
      if (error instanceof FenceConflictError) throw new StateError('conflict', 'Stored File source moved beyond its checkpoint.');
      throw error;
    }
  };
  const readable = (current: StoredRow, projected: Awaited<ReturnType<typeof project>>) => {
    // An id-only/subfield grant must not pass by coinciding with an empty array.
    if (projected.record === null || !projected.grants.some(grant => grant.fields.includes(dependency.field)) ||
        !Object.hasOwn(current.data, dependency.field)) return false;
    try { fileRefs(current.data[dependency.field]); }
    catch { return false; }
    const original = projectSourceRowFields(row, projected.grants, read.secretFields);
    return Object.hasOwn(original.data, dependency.field) && stableStringify(original.data[dependency.field]) === stableStringify(wire);
  };
  const authority = await observeRowGrantAuthority(context, observed => project(row, observed,
    async (model, id) => { healthy(); const value = await owner.session!.views.final.get(model, id); healthy(); return value; }, healthy));
  healthy();
  if (!readable(row, authority.value)) throw new StateError('forbidden', 'Original whole stored File field is unavailable.');
  const revalidate = async () => {
    for (const file of files) if (await producer.revalidate(file, receiving) !== true) {
      throw new StateError('forbidden', 'Original stored File bytes, receiver or retention is unavailable.');
    }
    await authority.revalidate();
    if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Stored File check moved beyond the original checkpoint.');
  };
  await revalidate(); healthy();
  owner.callGuards.push(Object.freeze({ name: `stored-file:${call.def.name}:${dependency.id}:${stage}`, evaluate: async () => {
    if (owner.finalized === null) return invalid('stored File dependency lacks actual final owner effects.');
    const final = owner.finalized;
    const finalHealthy = () => { if (owner.finalized !== final || owner.capture.poisoned) return invalid('stored File final owner effects changed.'); };
    const load = async (model: ModelName, id: RecordId) => {
      finalHealthy();
      const write = final.writes.find(write => write.model === model && (write.kind === 'insert' ? write.row.id : write.id) === id);
      const current = write === undefined ? await store.cohortLoad({ model, id, expectedRevision: call.revision }) : write.kind === 'remove' ? null : write.row;
      finalHealthy(); return current;
    };
    const current = await load(dependency.model, row.id);
    if (current === null || !sameModelLifetime(row, current)) throw new StateError('forbidden', 'Original stored File row lifetime changed.');
    const projected = await observeRowGrantAuthority(context, observed => project(current, observed, load, finalHealthy));
    finalHealthy();
    if (!readable(current, projected.value)) throw new StateError('forbidden', 'Original whole stored File authority changed before commit.');
    await projected.revalidate(); await revalidate(); finalHealthy(); return true;
  } }));
  // This final physical pass follows all other child guards. Full original
  // Identity facts and the State fence are checked after the external await.
  owner.storedFileChecks.push(revalidate);
  return { files, revalidate };
}

/** Reserved metadata uses the original source row-read rules, including
 * containment and complete Identity facts. The private original snapshot is
 * retained while later owner updates are checked through the same lifetime. */
async function observeRowIdAuthority(call: AdmittedCall, store: StoragePort, owner: ReceiptOwnerSession | undefined,
  state: Capture, row: StoredRow, model: ModelName, dependencyId: string, admitted: boolean): Promise<() => Promise<void>> {
  const producer = referenceProducers.get(call.def as GeneratedOperationDef), dependency = state.bound.idDependencies.get(dependencyId);
  if (producer?.app !== call.context.app || producer.readPolicies === undefined || dependency === undefined ||
      stableStringify(producer.source) !== stableStringify(dependency.source) ||
      stableStringify(producer.source) !== stableStringify(state.bound.plan.source)) return invalid('matching installed row id source policy required.');
  if (owner !== undefined && owner.session === null) return invalid('row id requires its actual owner read view.');
  const guards = owner?.callGuards ?? state.rowIdGuards;
  if (guards.length >= MAX_ITEMS) return invalid('row id commit guard budget exceeded.');
  const stage = owner?.stage;
  const healthy = () => {
    capture(call, store);
    if (owner !== undefined) ownerHealthy(owner);
    if (state.pending !== 1 || state.returnId !== null || owner !== undefined &&
        (owner.stage !== stage || !owner.busy || owner.executingCall !== call)) return invalid('row id crossed its actual call or owner stage.');
  };
  const read = async (model: ModelName, id: RecordId): Promise<StoredRow | null> => {
    healthy();
    const value = owner === undefined ? await store.cohortLoad({ model, id, expectedRevision: call.revision }) :
      await owner.session!.views.final.get(model, id);
    healthy(); return value;
  };
  const current = await read(model, row.id);
  if (current === null || !sameModelLifetime(row, current) || !admitted && stableStringify(current) !== stableStringify(row)) {
    throw new StateError('forbidden', 'Current row id lifetime is unavailable.');
  }
  const reader = scenarioReceiptMemberships(owner?.call ?? call, store), actorUserId = call.context.actor?.userId ?? null,
    teamId = call.context.team?.teamId ?? null;
  const membership = actorUserId === null || teamId === null ? null : await reader.findMembership(teamId, actorUserId); healthy();
  const context: ByContext = { actorUserId, teamId, membership, memberships: reader };
  const policyDomains = owner === undefined ? undefined : ownerPolicyDomains(owner, healthy);
  const project = async (current: StoredRow, observed: ByContext,
    read: (model: ModelName, id: RecordId) => Promise<StoredRow | null>, assertHealthy: () => void,
    policyQuery = policyDomains?.capture) => {
    try {
      const value = await projectInstalledSourceRowAndAncestors({ model, row: current,
        readPolicies: producer.readPolicies!, policy: producer.policy, context: observed, revision: call.revision,
        fence: undefined, store, rows: new Map([[`${model}\0${current.id}`, current]]), ownerRows: { read, assertHealthy, ...(policyQuery === undefined ? {} : { policyQuery }) } });
      assertHealthy(); return value;
    } catch (error) {
      if (error instanceof FenceConflictError) throw new StateError('conflict', 'Row id source authority moved beyond its checkpoint.');
      throw error;
    }
  };
  const authority = await observeRowGrantAuthority(context, observed => project(current, observed, read, healthy)); healthy();
  if (authority.value.record?.id !== row.id) throw new StateError('forbidden', 'Current row id source authority is unavailable.');
  await authority.revalidate(); healthy();
  if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Row id moved beyond its admitted checkpoint.');
  healthy();
  guards.push(Object.freeze({ name: `row-id:${call.def.name}:${dependencyId}:${stage ?? 'admitted'}`, evaluate: async () => {
    const final = owner?.finalized;
    const writes = owner === undefined ? state.rowIdWrites : final?.writes;
    if (writes === undefined) return invalid('row id lacks captured final effects.');
    if (owner !== undefined && final == null) return invalid('row id lacks actual final owner effects.');
    const finalHealthy = () => {
      if (state.poisoned || owner === undefined && state.rowIdWrites !== writes ||
          owner !== undefined && (owner.capture.poisoned || owner.finalized !== final)) return invalid('row id final capture changed.');
    };
    const read = async (model: ModelName, id: RecordId): Promise<StoredRow | null> => {
      finalHealthy();
      const write = writes.find(write => write.model === model && (write.kind === 'insert' ? write.row.id : write.id) === id);
      const value = write === undefined ? await store.cohortLoad({ model, id, expectedRevision: call.revision }) :
        write.kind === 'remove' ? null : write.row;
      finalHealthy(); return value;
    };
    const current = await read(model, row.id);
    if (current === null || !sameModelLifetime(row, current)) throw new StateError('forbidden', 'Row id lifetime is unavailable at commit.');
    const projected = await observeRowGrantAuthority(context, observed => project(current, observed, read, finalHealthy, policyDomains?.retained(finalHealthy, writes))); finalHealthy();
    if (projected.value.record?.id !== row.id) throw new StateError('forbidden', 'Row id source grant no longer holds at commit.');
    await projected.revalidate(); await authority.revalidate(); finalHealthy();
    if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Row id commit authority moved beyond its checkpoint.');
    finalHealthy(); return true;
  } }));
  return async () => {
    healthy();
    const current = await read(model, row.id);
    if (current === null || !sameModelLifetime(row, current) || !admitted && stableStringify(current) !== stableStringify(row)) {
      throw new StateError('forbidden', 'Row id lifetime changed before observation completed.');
    }
    const projected = await observeRowGrantAuthority(context, observed => project(current, observed, read, healthy)); healthy();
    if (projected.value.record?.id !== row.id) throw new StateError('forbidden', 'Row id grant changed before observation completed.');
    await projected.revalidate(); await authority.revalidate(); healthy();
  };
}

type ScenarioReceiptDependencyInput = {
  readonly dependencyId: string; readonly model: ModelName; readonly row: StoredRow; readonly field: string;
  readonly files?: readonly FinalizedFileObservation[];
};
export type ScenarioReceiptRowIdInput = {
  readonly dependencyId: string; readonly model: ModelName; readonly row: StoredRow;
} | {
  readonly dependencyId: string; readonly model: ModelName; readonly reference: AdmittedCall['recordRefs'][number];
};
/** Native host supplies its actual protected binding. For a receipt owner
 * session it must preserve the exact issued row, including its stage. Copies,
 * host overlays and final-row coincidence cannot establish intermediate proof.
 */
export async function observeScenarioReceiptDependency(call: AdmittedCall, store: StoragePort,
  input: ScenarioReceiptDependencyInput): Promise<void> {
  await observeScenarioReceiptDependencyValue(call, store, input, false);
}
/** Derive reserved text metadata from either a genuine current-stage owner row
 * or this call's exact admitted reference. Admission retains its original row
 * and version; current source authority is evaluated against the live lifetime. */
export async function observeScenarioReceiptRowId(call: AdmittedCall, store: StoragePort,
  input: ScenarioReceiptRowIdInput): Promise<string> {
  return (await observeScenarioReceiptDependencyValue(call, store, input, true))!;
}
async function observeScenarioReceiptDependencyValue(call: AdmittedCall, store: StoragePort,
  raw: ScenarioReceiptDependencyInput | ScenarioReceiptRowIdInput, rowId: boolean): Promise<string | undefined> {
  let state: Capture;
  try { state = capture(call, store); }
  catch (error) {
    const carrier = typeof raw === 'object' && raw !== null ? Object.getOwnPropertyDescriptor(raw, 'row') : undefined;
    if (carrier !== undefined && 'value' in carrier) {
      const issuing = ownerRows.get(carrier.value as StoredRow);
      if (issuing !== undefined) issuing.session.capture.poisoned = true;
    }
    throw error;
  }
  const owner = ownerSessions.get(call);
  let acquired = false, acquiredOwner = false;
  try {
    if (state.pending !== 0) return invalid('concurrent observations are forbidden.');
    if (state.returnId !== null) return invalid('observation cannot follow the selected return.');
    let input: ScenarioReceiptDependencyInput;
    let admitted: AdmittedCall['recordRefs'][number] | undefined;
    if (rowId) {
      const hasReference = Object.hasOwn(raw, 'reference');
      object(raw, ['dependencyId', 'model', hasReference ? 'reference' : 'row']);
      if (hasReference) {
        admitted = (raw as Extract<ScenarioReceiptRowIdInput, { reference: unknown }>).reference;
        if (!call.recordRefs.includes(admitted) || admitted.model !== raw.model || admitted.row.id !== admitted.id) {
          return invalid("row id requires this call's exact admitted reference.");
        }
      }
      input = { dependencyId: raw.dependencyId, model: raw.model,
        row: admitted?.row ?? (raw as Extract<ScenarioReceiptRowIdInput, { row: unknown }>).row, field: 'id' };
    } else {
      input = raw as ScenarioReceiptDependencyInput;
      object(input, ['dependencyId', 'model', 'row', 'field', ...(Object.hasOwn(input, 'files') ? ['files'] : [])]);
    }
    // Opaque Files observations never pass through JSON/native wire copying.
    const observed = dataCopy({ dependencyId: input.dependencyId, model: input.model, row: input.row, field: input.field });
    const execution = referenceProducers.get(call.def as GeneratedOperationDef)?.boundExecutionDependencies.get(observed.dependencyId);
    // DESIGN442 (0411): an execution-registered read that is also a result
    // dependency records its observation below (return-dep completeness);
    // execution-only reads keep the early return with no observation.
    const executionResultLinked = execution !== undefined &&
      state.bound.plan.returns.some(returned => returned.dependencies.some(other => other.id === observed.dependencyId));
    const dependency = execution?.association.dependency ?? state.bound.plan.returns.flatMap(entry => entry.dependencies).find(dep => dep.id === observed.dependencyId);
    if (dependency === undefined || dependency.model !== observed.model || dependency.field !== observed.field) return invalid('native observation disagrees with its checked dependency.');
    const recipient = admittedEventRecipientDependencies(call, state);
    if (recipient?.leafId === dependency.id) {
      const issuedRecipient = eventRecipientRows.get(input.row);
      if (owner === undefined || issuedRecipient?.call !== call || issuedRecipient.owner !== owner ||
          issuedRecipient.stage !== owner.stage || issuedRecipient.sourceId !== recipient.sourceId ||
          issuedRecipient.leafId !== recipient.leafId || observed.model !== 'customer.Contact' || observed.field !== 'email') {
        return invalid('event recipient email requires its exact promoted Contact row.');
      }
    }
    if (state.observations.length + state.intrinsics.length + (executedDependencies.get(state)?.size ?? 0) >= MAX_ITEMS) return invalid('observation budget exceeded.');
    const row = checkedRow(observed.row);
    const narrowed = state.bound.narrowedDependencies.get(dependency.id);
    if (narrowed !== undefined) capturedNarrowedControl(call, owner, state, narrowed, input.row);
    const namedEnum = state.bound.namedEnumDependencies.get(dependency.id);
    const nominal = execution?.profile === undefined ? state.bound.nominalDependencies.get(dependency.id) : { profile: execution.profile };
    const reference = state.bound.referenceDependencies.get(dependency.id);
    const file = state.bound.fileDependencies.get(dependency.id);
    const id = state.bound.idDependencies.get(dependency.id);
    if (rowId && id === undefined) return invalid('row id observation requires its exact reserved metadata dependency.');
    if (id !== undefined && state.observations.some(observation => observation.dependencyId === dependency.id)) return invalid('row id dependency was already observed.');
    if (file !== undefined) scenarioFileWireRefs(file.profile, dependencyObservedWire(dependency, row));
    else if (reference !== undefined) storedReferenceWire(reference.profile, row);
    else if (namedEnum !== undefined) {
      const wire = dependencyObservedWire(dependency, row);
      if (stableStringify(encodeValue(dependency.type, validateValue(state.bound.valueSchema!, dependency.type, wire, 'create'))) !== stableStringify(wire)) return invalid('canonical owning named enum observation required.');
    }
    else if (nominal === undefined) scalarWire(dependency.type, dependencyObservedWire(dependency, row));
    else storedNominalWire(nominal.profile, getDataPath(row.data, dependency.field));
    if (row.archivedAt !== null) return invalid('cannot observe an archived row.');
    const linkedQuery = dependency.queryId === undefined ? undefined : state.queries.find(query => query.plan.id === dependency.queryId);
    const linkedCandidate = linkedQuery?.candidates.find(candidate => candidate.slot === linkedQuery.activeSlot);
    const selectedRead = linkedQuery !== undefined && linkedCandidate !== undefined && input.row === linkedCandidate.row && linkedQuery.selectionSlot === linkedCandidate.slot &&
      linkedQuery.complete && linkedQuery.selectedIndices.includes(linkedQuery.candidates.indexOf(linkedCandidate)) && dependency.role === 'data' &&
      querySelections.get(call.def as GeneratedOperationDef)?.get(linkedQuery.plan.id)?.fields.some(field => field.dependencyId === dependency.id) === true;
    if (dependency.queryId !== undefined && (owner === undefined || linkedQuery === undefined || linkedCandidate === undefined ||
        linkedQuery.call !== call || linkedQuery.owner !== owner || linkedQuery.stage !== owner.stage ||
        owner.executingCall !== call || !owner.busy || linkedQuery.complete && !selectedRead || linkedCandidate.pendingRead !== null ||
        querySlots.get(linkedCandidate.slot)?.execution !== linkedQuery || linkedCandidate.dependencies.has(dependency.id))) {
      return invalid('candidate-only observation requires its exact active owner query slot.');
    }
    // The supplied Turn.position is a separate source occurrence from the
    // prior Turn candidate. Keep this required INT CONTROL confined to the
    // active predicate, after its candidate position read/marker; no generic
    // scalar or nullable admission port is implied.
    const suppliedPosition = !rowId && linkedQuery !== undefined && linkedCandidate !== undefined &&
      dependency.field === 'position' && dependency.type === 'int' && dependency.role === 'control' &&
      dependency.model === linkedQuery.plan.model && state.bound.models.get(dependency.model)?.fields.get('position') === 'int' &&
      !state.bound.narrowedDependencies.has(dependency.id) &&
      !linkedQuery.plan.dependencies.some(item => item.id === dependency.id) &&
      (linkedCandidate.reads.get('position') ?? 0) > 0 && linkedQuery.plan.dependencies.some(item =>
        item.field === 'position' && item.type === 'int' && item.role === 'control' && linkedCandidate.dependencies.has(item.id));
    // The original supplied Branch remains its separate lazy parent source
    // occurrence. Only an exact admitted row can use either busy port.
    if (!rowId && linkedQuery !== undefined && (reference?.profile.kind === 'parent' || suppliedPosition)) {
      admitted = call.recordRefs.find(ref => ref.model === observed.model && ref.row === input.row && ref.id === row.id);
      if (suppliedPosition && (admitted === undefined || admitted.expectedVersion === null || row.version !== admitted.expectedVersion ||
          !requiredVersionedReferenceInput(call.def as GeneratedOperationDef, admitted.param, observed.model))) admitted = undefined;
    }
    // Execution-registered reads verified their row/stage discipline at query
    // time and through once-only above; result-linked ones still record below.
    // Both skip the ordinary busy/parent/issued gates (which cannot pass for
    // execution reads) but keep liveness and owner acquisition.
    if (owner !== undefined) {
      ownerHealthy(owner);
      if (execution === undefined || !executionResultLinked) {
        const issued = ownerRows.get(input.row), parent = queryParentRows.get(input.row);
        const candidate = parent === undefined ? undefined : parent.execution.candidates[querySlots.get(parent.slot)!.index];
        const activeParent = parent !== undefined && !rowId && reference?.profile.kind === 'parent' &&
          parent.dependencyId === dependency.id && parent.execution.call === call && parent.execution.owner === owner &&
          parent.execution.stage === owner.stage && parent.execution.activeSlot === parent.slot && !parent.execution.complete &&
          candidate?.pendingRead === null && (candidate.reads.get('parent') ?? 0) > 0 &&
          parent.execution.plan.dependencies.some(dep => dep.field === 'parent' && candidate.dependencies.has(dep.id));
        const activeAdmittedSource = admitted !== undefined && !rowId && (reference?.profile.kind === 'parent' || suppliedPosition) &&
          linkedQuery !== undefined && linkedCandidate !== undefined;
        if (parent !== undefined && (!activeParent || linkedQuery !== undefined && parent.execution !== linkedQuery) ||
            owner.busy && !activeParent && !activeAdmittedSource && !selectedRead || admitted === undefined &&
            (issued?.session !== owner || issued.stage !== owner.stage || issued.model !== observed.model)) {
          return invalid('observation requires the actual current-stage owner row and active parent query slot.');
        }
      }
      if (!owner.busy) { owner.busy = true; acquiredOwner = true; }
    }
    if (execution !== undefined) {
      const query = state.queries.find(query => query.plan.id === execution.association.queryId);
      const selected = query?.selectedIndices[0];
      if (rowId || owner === undefined || query === undefined || query.call !== call || query.owner !== owner ||
          query.stage !== owner.stage || !query.complete || !query.firstSelected || query.countSelected ||
          query.selectionConsumed || query.anyConsumed || selected === undefined ||
          query.candidates[selected]?.row !== input.row || executedDependencies.get(state)?.has(dependency.id)) {
        return invalid('execution Contract read requires its once-only original first-selected current-stage owner row.');
      }
    }
    if (id !== undefined && owner === undefined && admitted === undefined) return invalid('current row id requires its actual current-stage owner session.');
    state.pending += 1; acquired = true;
    let referenceRevalidate: (() => Promise<void>) | undefined;
    if (execution !== undefined) {
      const current = await owner!.session!.views.final.get(observed.model, row.id);
      if (current === null || !sameModelLifetime(row, current) ||
          stableStringify(getDataPath(current.data, dependency.field)) !== stableStringify(getDataPath(row.data, dependency.field))) {
        throw new StateError('forbidden', 'Execution Contract source differs from its original selected field.');
      }
      // DESIGN442: a `Require` stored read off a marked first-selected row
      // evaluates as the same recorded owner decision; all other execution
      // reads keep viewer authority.
      const decisionQuery = state.queries.find(query => query.plan.id === execution.association.queryId);
      const decisionPolicies = decisionQuery === undefined ? undefined : guardConsumedDecisionPolicies(call,
        owner!, state, decisionQuery.plan, [dependency.field], new Set([row.id]));
      const authority = await observeModelQuerySourceAuthority(call, store, owner!, state, observed.model, current, [dependency.field], 1,
        undefined, decisionPolicies);
      referenceRevalidate = () => authority.requireFields([dependency.field]);
    }
    if (suppliedPosition && admitted !== undefined) {
      const current = await owner!.session!.views.final.get(observed.model, row.id);
      if (current === null || !sameModelLifetime(row, current) ||
          stableStringify(dependencyObservedWire(dependency, current)) !== stableStringify(dependencyObservedWire(dependency, row))) {
        throw new StateError('forbidden', 'Query-linked supplied position lifetime changed.');
      }
      const authority = await observeModelQuerySourceAuthority(call, store, owner!, state, observed.model, current, ['position'], 1);
      referenceRevalidate = () => authority.requireFields(['position']);
    }
    if (id !== undefined) referenceRevalidate = await observeRowIdAuthority(call, store, owner, state, row, observed.model, dependency.id, admitted !== undefined);
    let files: readonly RetainedFinalizedFile[] | undefined;
    if (file !== undefined || nominal?.profile.hasFiles === true) {
      if (owner === undefined || input.files === undefined) return invalid('stored File capture requires the actual owner row and genuine File observations.');
      const captured = await observeStoredFileAuthority(call, store, owner, state, dependency, row, file?.profile ?? nominal!.profile, input.files);
      files = captured.files; referenceRevalidate = captured.revalidate;
    } else if (Object.hasOwn(input, 'files')) return invalid('File facts require the declared stored File or protected contract dependency.');
    if (reference !== undefined) {
      if (owner === undefined) return invalid('source reference capture requires its actual current-stage owner session.');
      if (linkedQuery !== undefined) {
        const current = await owner.session!.views.final.get(observed.model, row.id);
        if (current === null || !sameModelLifetime(row, current) ||
            stableStringify(storedReferenceWire(reference.profile, current)) !== stableStringify(storedReferenceWire(reference.profile, row))) {
          throw new StateError('forbidden', 'Query-linked source reference lifetime changed.');
        }
        const authority = await observeModelQuerySourceAuthority(call, store, owner, state, observed.model, current,
          [dependency.field], 1);
        referenceRevalidate = () => authority.requireFields([dependency.field]);
      } else referenceRevalidate = await observeReferenceAuthority(call, store, owner, state, dependency.id, row, reference.profile, observed.model);
    }
    const current = await store.load(observed.model, row.id);
    capture(call, store);
    const revision = await store.readRevision();
    capture(call, store);
    if (state.returnId !== null) return invalid('observation must complete before return selection.');
    if (revision !== call.revision) throw new StateError('conflict', 'Scenario observation moved beyond its admitted revision.');
    if (referenceRevalidate !== undefined) {
      await referenceRevalidate(); capture(call, store);
      if (owner !== undefined) ownerHealthy(owner);
      if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Source reference final observation moved beyond its admitted revision.');
      capture(call, store); if (owner !== undefined) ownerHealthy(owner);
    }
    if (execution !== undefined) {
      let executed = executedDependencies.get(state);
      if (executed === undefined) { executed = new Set(); executedDependencies.set(state, executed); }
      executed.add(dependency.id);
      // Execution-only reads record nothing and return here; result-linked
      // execution reads fall through to record their observation below.
      if (!executionResultLinked) {
        return undefined;
      }
    }
    const secrets = state.bound.models.get(observed.model)!.secrets;
    if (secrets.length > MAX_ITEMS) return invalid('original secrecy inventory exceeds its finite budget.');
    const observation = { dependencyId: dependency.id, model: observed.model, row,
      secretFields: [...secrets],
      ...(files === undefined ? {} : { files }),
      stored: current !== null && stableStringify(current) === stableStringify(row), ownerSession: owner !== undefined };
    state.observations.push(observation);
    if (owner !== undefined && [...state.bound.narrowedDependencies.values()].some(binding =>
        scenarioNarrowedFieldControls(binding).some(control => control.id === dependency.id))) {
      narrowedControlInputs.set(observation, { call, owner, stage: owner.stage, row: input.row });
    }
    if (linkedQuery !== undefined) {
      if (linkedQuery.activeSlot !== linkedCandidate!.slot || linkedQuery.complete && !selectedRead || linkedQuery.stage !== owner!.stage ||
          owner!.executingCall !== call || !owner!.busy) return invalid('ordinary observation crossed its active query candidate.');
      linkedCandidate!.dependencies.add(dependency.id);
      queryLinkedObservations.set(observation, { execution: linkedQuery, slot: linkedCandidate!.slot });
    }
    const queryParent = queryParentRows.get(input.row);
    if (queryParent !== undefined) queryParent.observed = true;
    if (reference !== undefined) storedParentInputs.set(observation, { call, owner: owner!, stage: owner!.stage,
      row: input.row, revalidate: referenceRevalidate! });
    if (files !== undefined) storedFileInputs.set(observation, { call, owner: owner!, stage: owner!.stage, revalidate: referenceRevalidate!, used: false });
    return id === undefined ? undefined : row.id;
  } catch (error) { state.poisoned = true; if (owner !== undefined) owner.capture.poisoned = true; throw error; }
  finally { if (acquired) { state.pending -= 1; if (owner !== undefined && acquiredOwner) owner.busy = false; } }
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
      const event = admittedEventIntrinsic(call, dependency.parameter);
      const parameter = event === undefined ? dependency.parameter : event.revisionField.name;
      const wire = dataCopy(admittedInputWire(call.inputs, parameter)); scalarWire(dependency.type, wire);
      if (event !== undefined) {
        const payload = object(dueWorkAdmissions.get(call)!.eventPayload, [event.modelField.name, event.revisionField.name]);
        if (decodeValue('int', payload[event.revisionField.name]) !== decodeValue('int', wire)) {
          return invalid('event revision intrinsic differs from retained Work input.');
        }
      }
      if (stableStringify(wire) !== stableStringify(observed.wire) ||
          stableStringify(encodeValue(dependency.type, decodeValue(dependency.type, wire))) !== stableStringify(wire)) {
        return invalid('intrinsic input differs from its original canonical admitted wire.');
      }
      observation = { dependencyId: dependency.id, kind: dependency.kind, wire };
    } else {
      const member = Object.getOwnPropertyDescriptor(input, 'reference');
      const event = admittedEventIntrinsic(call, dependency.parameter);
      const parameter = event === undefined ? dependency.parameter : event.modelField.name;
      const reference = call.recordRefs.find(ref => ref.param === parameter);
      const sourceRef = event === undefined ? undefined : decodeValue(event.modelField.model,
        object(dueWorkAdmissions.get(call)!.eventPayload, [event.modelField.name, event.revisionField.name])[event.modelField.name]) as
        { readonly model: string; readonly id: string };
      if (member === undefined || !('value' in member) || reference === undefined || member.value !== reference ||
          reference.model !== dependency.model || reference.id !== reference.row.id ||
          (event === undefined && reference.expectedVersion !== reference.row.version) ||
          (event !== undefined && (sourceRef?.model !== event.modelField.model || sourceRef.id !== reference.id)) ||
          observed.wire !== String(reference.row.version)) {
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
        const event = dependency.kind === 'admitted-reference-version' ? admittedEventIntrinsic(call, dependency.parameter) : undefined;
        const parameter = event === undefined ? dependency.kind === 'admitted-reference-version' ? dependency.parameter : '' : event.modelField.name;
        const reference = call.recordRefs.find(ref => ref.param === parameter)!;
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

function modelResultObservedRow(returned: ScenarioResultDisclosurePlan['returns'][number],
  observations: ScenarioReceiptAssociation['observations'], model: ModelName, id: RecordId): StoredRow | undefined {
  const identities = new Set(returned.dependencies.filter(dependency => dependency.role === 'data' &&
    dependency.model === model && dependency.field === 'id' && dependency.type === 'text').map(dependency => dependency.id));
  return observations.find(observation => identities.has(observation.dependencyId) && observation.model === model &&
    observation.row.id === id && observation.row.archivedAt === null)?.row;
}

/** Influence-linked first-selected lifetime for whole-row idempotent replay.
 * An admitted replay return carries influences but no data-ID dependency, so
 * no separate defining observation exists. State's own completed first
 * selection — the genuine owner row at the live stage, checked source
 * authority, installed commit guard — defines the existing model result
 * lifetime instead. Unselected candidates, foreign rows, other models and
 * unlinked queries keep the refusal at the call sites. */
function firstSelectedExecutionRow(returned: ScenarioResultDisclosurePlan['returns'][number],
  state: Capture, owner: ReceiptOwnerSession, model: ModelName, row: StoredRow): StoredRow | undefined {
  for (const execution of state.queries) {
    if (!execution.complete || !execution.firstSelected) continue;
    if (execution.owner !== owner || execution.stage !== owner.stage) continue;
    if (!returnQueryIds(returned).includes(execution.plan.id)) continue;
    if (execution.plan.model !== model) continue;
    const selected = execution.selectedIndices[0];
    const candidate = selected === undefined ? undefined : execution.candidates[selected];
    if (candidate === undefined || candidate.row.id !== row.id) continue;
    if (!sameModelLifetime(candidate.row, row)) continue;
    return candidate.row;
  }
  return undefined;
}

/** Saved form of the replay lifetime above: the retained influence-linked
 * query's actually selected candidate row, still present and unarchived.
 * Current grants are rechecked by the saved projection, never here. */
function firstSelectedSavedRow(plan: ScenarioResultDisclosurePlan,
  returned: ScenarioResultDisclosurePlan['returns'][number],
  queries: readonly ScenarioReceiptQueryObservation[],
  model: string, id: RecordId): StoredRow | undefined {
  for (const queryId of returnQueryIds(returned)) {
    if (plan.queries?.find(query => query.id === queryId)?.model !== model) continue;
    const saved = queries.find(query => query.queryId === queryId);
    if (saved === undefined) continue;
    const selected = saved.selectedIndices[0];
    const candidate = selected === undefined ? undefined : saved.candidates[selected];
    if (candidate === undefined || candidate.row.id !== id || candidate.row.archivedAt !== null) continue;
    return candidate.row;
  }
  return undefined;
}

/** Bind a once-evaluated stored-model return, not a structural reference or raw
 * native object. The genuine host supplies its exact current owner row.
 * A created result survives net effects; an existing result requires the
 * original data-ID observation — or, for whole-row idempotent replay, the
 * influence-linked completed first selection — and retains that lifetime
 * without a write. */
export async function bindScenarioReceiptModelResult(call: AdmittedCall, store: StoragePort,
  input: { readonly returnId: string; readonly row: StoredRow }): Promise<Readonly<{ id: RecordId }>> {
  const state = capture(call, store), owner = ownerSessions.get(call);
  let acquired = false;
  try {
    object(input, ['returnId', 'row']);
    const model = state.bound.resultModel, issued = ownerRows.get(input.row);
    const returned = state.bound.plan.returns.find(returned => returned.id === input.returnId);
    const producer = referenceProducers.get(call.def as GeneratedOperationDef);
    if (owner === undefined || owner.session === null || model === undefined || returned === undefined ||
        state.returnId !== null || state.modelResult !== undefined || state.pending !== 0 || owner.busy ||
        issued?.session !== owner || issued.model !== model || issued.stage !== owner.stage ||
        producer?.app !== call.context.app || producer.readPolicies === undefined || owner.callGuards.length >= MAX_ITEMS) {
      return invalid('model result requires its genuine current-stage row, original read policy and unused return binding.');
    }
    ownerHealthy(owner);
    const row = checkedRow(dataCopy(input.row)), stage = owner.stage;
    if (row.archivedAt !== null) return invalid('archived model result is unavailable.');
    owner.busy = true; state.pending++; acquired = true;
    const healthy = () => {
      capture(call, store); ownerHealthy(owner);
      if (owner.executingCall !== call || owner.stage !== stage || !owner.busy || state.pending !== 1 ||
          state.returnId !== null || ownerRows.get(input.row) !== issued) return invalid('model result crossed its actual owning return stage.');
    };
    const policyDomains = ownerPolicyDomains(owner, healthy);
    const previous = await owner.session.views.entry.get(model, row.id); healthy();
    const existing = previous !== null;
    const observed = modelResultObservedRow(returned, state.observations, model, row.id) ??
      firstSelectedExecutionRow(returned, state, owner, model, row);
    if (existing && (observed === undefined || !sameModelLifetime(observed, row))) {
      return invalid('existing row result requires its separate defining lifetime profile.');
    }
    if (existing && !sameModelLifetime(previous, row)) {
      return invalid('existing model return requires its genuine entry lifetime.');
    }
    const reader = scenarioReceiptMemberships(owner.call, store), actorUserId = call.context.actor?.userId ?? null,
      teamId = call.context.team?.teamId ?? null;
    const membership = actorUserId === null || teamId === null ? null : await reader.findMembership(teamId, actorUserId); healthy();
    const context: ByContext = { actorUserId, teamId, membership, memberships: reader };
    const project = async (current: StoredRow, observed: ByContext, read: (model: ModelName, id: RecordId) => Promise<StoredRow | null>,
      assertHealthy: () => void, policyQuery = policyDomains.capture) => {
      try {
        return await projectInstalledSourceRowAndAncestors({ model, row: current,
          readPolicies: producer.readPolicies!, policy: producer.policy, context: observed, revision: call.revision,
          fence: undefined, store, rows: new Map([[`${model}\0${current.id}`, current]]), ownerRows: { read, assertHealthy, policyQuery } });
      } catch (error) {
        if (error instanceof FenceConflictError) throw new StateError('conflict', 'Returned model source authority moved beyond its checkpoint.');
        throw error;
      }
    };
    const authority = await observeRowGrantAuthority(context, observed => project(row, observed,
      async (model, id) => { healthy(); const value = await owner.session!.views.final.get(model, id); healthy(); return value; }, healthy));
    healthy();
    if (authority.value.record === null) throw new StateError('forbidden', 'Current returned model authority is unavailable.');
    await authority.revalidate(); healthy();
    if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Model result moved beyond its original return checkpoint.');
    healthy();
    const wire = Object.freeze({ id: row.id });
    state.modelResult = { existing, returnId: returned.id, model, row, wire };
    owner.modelResults.push({ existing, model, row });
    owner.callGuards.push(Object.freeze({ name: `model-result:${call.def.name}:${returned.id}:${stage}`, evaluate: async () => {
      if (owner.finalized === null) return invalid('model result lacks actual final owner effects.');
      const final = owner.finalized;
      const finalHealthy = () => {
        if (owner.finalized !== final || owner.capture.poisoned) return invalid('model result final owner effects changed.');
      };
      const read = async (model: ModelName, id: RecordId): Promise<StoredRow | null> => {
        finalHealthy();
        const write = final.writes.find(write => write.model === model && (write.kind === 'insert' ? write.row.id : write.id) === id);
        const current = write === undefined ? await store.cohortLoad({ model, id, expectedRevision: call.revision }) : write.kind === 'remove' ? null : write.row;
        finalHealthy(); return current;
      };
      const current = await read(model, row.id);
      if (current === null || !sameModelLifetime(row, current)) throw new StateError('forbidden', 'Returned model lifetime is unavailable at commit.');
      const projected = await observeRowGrantAuthority(context, observed => project(current, observed, read, finalHealthy, policyDomains.retained(finalHealthy, final.writes)));
      finalHealthy();
      if (projected.value.record === null) throw new StateError('forbidden', 'Returned model grant no longer holds at commit.');
      await projected.revalidate(); await authority.revalidate(); finalHealthy();
      if (await store.readRevision() !== call.revision) throw new StateError('conflict', 'Returned model commit authority moved beyond its checkpoint.');
      finalHealthy(); return true;
    } }));
    return wire;
  } catch (error) { state.poisoned = true; if (owner !== undefined) owner.capture.poisoned = true; throw error; }
  finally { if (acquired) { state.pending--; owner!.busy = false; } }
}

function sameModelLifetime(original: StoredRow, current: StoredRow): boolean {
  return current.id === original.id && current.archivedAt === null && current.version >= original.version &&
    current.created === original.created && current.createdBy === original.createdBy &&
    stableStringify(current.parent ?? null) === stableStringify(original.parent ?? null);
}

export function selectScenarioReceiptReturn(call: AdmittedCall, store: StoragePort, returnId: string): void {
  const state = capture(call, store);
  try {
    if (state.pending !== 0 || ownerSessions.get(call)?.busy === true) { state.poisoned = true; return invalid('return selection cannot precede pending owner reads/observations.'); }
    const returned = state.bound.plan.returns.find(entry => entry.id === returnId);
    if (state.returnId !== null || returned === undefined) return invalid('one actual checked return path required.');
    const countFirstSeat = countFirstSeatProfile(call.def as GeneratedOperationDef, state.bound);
    if (countFirstSeat !== undefined) {
      const [count, first] = state.queries;
      const selected = first?.selectedIndices[0] !== undefined;
      if (state.queries.length !== 2 || count?.plan.id !== countFirstSeat.count.id ||
          first?.plan.id !== countFirstSeat.first.id || count.stage !== 0 || first.stage !== 0 ||
          !count.ownerDecision || !first.ownerDecision || !count.complete || !first.complete ||
          !count.countSelected || !first.firstSelected ||
          (executedDependencies.get(state)?.has(countFirstSeat.activeDependencyId) === true) !== selected) {
        return invalid('seat assignment requires its consumed capacity count, selected target and guarded active read before effects return.');
      }
    }
    requireReturnDependencies(state, returned, state.observations);
    if (returned.intrinsics?.some(dep => !state.intrinsics.some(entry => entry.dependencyId === dep.id))) {
      return invalid('required observations must complete before selecting the actual return.');
    }
    requireQueryResult(state, returned, state.bound.resultModel === undefined ? state.queryResult : state.modelResult?.wire);
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

/**
 * Due Work admission bytes recorded from installed-producer staging.
 * `scheduleWrite` is a frozen copy of the single staged `work.schedule`
 * update produced by the installed `stageDueSchedule` for this admitted
 * call — never handler output. Recorded once per admitted call by State
 * invoke admission from the trusted invoker input (see
 * `noteDueWorkAdmission`); `retainScenarioReceipt` below compares the
 * returned pair against it, so executor byte replacement refuses.
 */
export interface DueWorkAdmission {
  readonly event: string;
  readonly occurrenceId: string;
  readonly key: string;
  readonly scope: { readonly app: string; readonly owner: string; readonly ownerPackage: string };
  readonly scheduleWrite: unknown;
  /** Original staged Work payload, required only by typed event SENDs. */
  readonly eventPayload?: unknown;
}
const dueWorkAdmissions = new WeakMap<AdmittedCall, DueWorkAdmission>();
export function noteDueWorkAdmission(call: AdmittedCall, admission: DueWorkAdmission): void {
  if (dueWorkAdmissions.has(call)) return invalid('duplicate due Work admission for one admitted call.');
  if (typeof admission !== 'object' || admission === null || Array.isArray(admission)) return invalid('due Work admission requires its defining shape.');
  for (const field of ['event', 'occurrenceId', 'key'] as const) {
    if (typeof admission[field] !== 'string' || (admission[field] as string) === '') return invalid('due Work admission requires its exact due coordinates.');
  }
  const scope = admission.scope;
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope) ||
    typeof (scope as DueWorkAdmission['scope']).app !== 'string' ||
    typeof (scope as DueWorkAdmission['scope']).owner !== 'string' ||
    typeof (scope as DueWorkAdmission['scope']).ownerPackage !== 'string') return invalid('due Work admission requires its exact due scope.');
  const staged = admission.scheduleWrite;
  if (typeof staged !== 'object' || staged === null || Array.isArray(staged) ||
    (staged as { readonly model?: unknown }).model !== 'work.schedule' ||
    (staged as { readonly kind?: unknown }).kind !== 'update') return invalid('due Work admission requires its staged schedule update.');
  if (Object.hasOwn(admission, 'eventPayload')) {
    const write = staged as { readonly row?: { readonly data?: { readonly payload?: unknown } } };
    if (typeof admission.eventPayload !== 'object' || admission.eventPayload === null || Array.isArray(admission.eventPayload) ||
        stableStringify(dataCopy(write.row?.data?.payload)) !== stableStringify(dataCopy(admission.eventPayload))) {
      return invalid('due event payload differs from its installed staged Work head.');
    }
  }
  const context = call.context as { readonly kind?: unknown; readonly source?: unknown; readonly trustedSource?: unknown };
  if (context.kind !== 'trusted' || context.source !== 'schedule' ||
    context.trustedSource !== `schedule:${admission.event}`) return invalid('due Work admission differs from its admitted trusted schedule call.');
  dueWorkAdmissions.set(call, deepFreeze(dataCopy(admission)));
}
function isDueWorkWrite(write: unknown): boolean {
  return typeof write === 'object' && write !== null &&
    ((write as { readonly model?: unknown }).model === 'work.schedule' ||
      (write as { readonly model?: unknown }).model === 'work.occurrence');
}
/**
 * Fence-coherent due Work verification (scope-1 issuance binding). The
 * two-write census is necessary only: sufficiency is byte-equality of the
 * returned schedule update against the recorded installed-producer staging
 * plus occurrence insert coherence and admitted-call coordination. A forged
 * well-shaped replacement (altered payload/time/state with admitted
 * ids/event/scope) fails the byte comparison. Never a model-name strip.
 */
function verifyDueWorkWrites(call: AdmittedCall, admission: DueWorkAdmission, writes: readonly unknown[], result: unknown): 'completed' | 'failed' {
  const pair = writes.filter(isDueWorkWrite);
  if (pair.length !== 2 || pair.length !== writes.filter(write =>
    typeof write === 'object' && write !== null &&
    typeof (write as { readonly model?: unknown }).model === 'string' &&
    ((write as { readonly model?: unknown }).model as string).startsWith('work.')).length) {
    return invalid('due Work pair must be exactly one schedule update plus one occurrence insert, nothing else.');
  }
  const schedule = pair.find(write => (write as { readonly model?: unknown }).model === 'work.schedule');
  const occurrence = pair.find(write => (write as { readonly model?: unknown }).model === 'work.occurrence');
  if (schedule === undefined || occurrence === undefined) return invalid('due Work pair must be exactly one schedule update plus one occurrence insert, nothing else.');
  if ((schedule as { readonly kind?: unknown }).kind !== 'update' ||
    (occurrence as { readonly kind?: unknown }).kind !== 'insert') {
    return invalid('due Work pair must be exactly one schedule update plus one occurrence insert, nothing else.');
  }
  if (stableStringify(dataCopy(schedule)) !== stableStringify(dataCopy(admission.scheduleWrite))) {
    return invalid('due schedule write differs from its recorded staged admission.');
  }
  const row = (schedule as { readonly row?: unknown }).row;
  if (typeof row !== 'object' || row === null || Array.isArray(row)) return invalid('due schedule write carries no stored row.');
  const data = (row as { readonly data?: unknown }).data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return invalid('due schedule write carries no row data.');
  const fields = data as Record<string, unknown>;
  if ((schedule as { readonly id?: unknown }).id !== admission.occurrenceId ||
    fields['occurrenceId'] !== admission.occurrenceId || fields['key'] !== admission.key ||
    fields['event'] !== admission.event || fields['state'] !== 'admitted' ||
    fields['scopeApp'] !== admission.scope.app || fields['scopeOwner'] !== admission.scope.owner ||
    fields['scopeOwnerPackage'] !== admission.scope.ownerPackage) {
    return invalid('due schedule write disagrees with its admitted due coordinates.');
  }
  const orow = (occurrence as { readonly row?: unknown }).row;
  if (typeof orow !== 'object' || orow === null || Array.isArray(orow)) return invalid('due occurrence write carries no stored row.');
  const odata = (orow as { readonly data?: unknown }).data;
  if (typeof odata !== 'object' || odata === null || Array.isArray(odata)) return invalid('due occurrence write carries no row data.');
  const ofields = odata as Record<string, unknown>;
  if ((orow as { readonly id?: unknown }).id !== admission.occurrenceId ||
    ofields['occurrenceId'] !== admission.occurrenceId) {
    return invalid('due occurrence write disagrees with its admitted occurrence.');
  }
  const status = ofields['status'];
  if (status !== 'completed' && status !== 'failed') return invalid('due occurrence write carries no terminal status.');
  const code = ofields['code'], message = ofields['message'];
  if (status === 'failed') {
    if (typeof code !== 'string' || code === '' || typeof message !== 'string' || message === '' || result !== null) {
      return invalid('due failed terminal requires its exact code/message with a null result.');
    }
  } else if (code !== null || message !== null) {
    return invalid('due completed terminal requires null code/message.');
  }
  return status;
}
/** Invoke alone calls this after execution; no executor-supplied association is accepted. */
export function retainScenarioReceipt(call: AdmittedCall, effects: ExecutionEffects): ScenarioReceiptAssociation | undefined {
  let state = captures.get(call);
  const owner = ownerSessions.get(call); ownerSessions.delete(call);
  const dueAdmission = dueWorkAdmissions.get(call); dueWorkAdmissions.delete(call);
  if (owner !== undefined) {
    if (!owner.closed || owner.finalized === null || owner.commitEffects === null || owner.capture.poisoned || owner.capture.pending !== 0) {
      return invalid('owner session must finalize successfully inside its actual execution.');
    }
    for (const key of ['history', 'uniqueClaims', 'uniqueReleases', 'resolvedDefaults'] as const) {
      if (stableStringify(dataCopy(effects[key])) !== stableStringify(owner.commitEffects[key])) {
        return invalid(`executor ${key} differ from the actual finalized owner effects.`);
      }
    }
    let dueEmptyNoAssociation = false;
    const returned = effects.writes as readonly unknown[];
    const committed = owner.commitEffects.writes as readonly unknown[];
    const returnedWork = returned.filter(isDueWorkWrite);
    const committedWork = committed.filter(isDueWorkWrite);
    const returnedDomain = returned.filter(write => !isDueWorkWrite(write));
    const committedDomain = committed.filter(write => !isDueWorkWrite(write));
    if (stableStringify(dataCopy(returnedDomain)) !== stableStringify(dataCopy(committedDomain))) {
      return invalid('executor writes differ from the actual finalized owner effects.');
    }
    if (returnedWork.length !== 0 || committedWork.length !== 0) {
      // A declared event emitted by an ordinary receipt owner stages its
      // Work source through that owner's genuine finalization callback. Its
      // Work writes must be the exact finalized source suffix; business writes
      // still match the separate disclosure below. Due handlers retain their
      // stronger recorded terminal-pair admission.
      if (dueAdmission === undefined) {
        if (owner.options.stageSources === undefined ||
            owner.finalized.writes.some(isDueWorkWrite) ||
            stableStringify(dataCopy(returnedWork)) !== stableStringify(dataCopy(committedWork))) {
          return invalid('executor source Work writes differ from the actual finalized owner sources.');
        }
      } else {
        if (stableStringify(dataCopy(returnedWork)) !== stableStringify(dataCopy(committedWork)) &&
            committedWork.length !== 0) {
          return invalid('executor Work writes differ from the actual finalized owner effects.');
        }
        const terminalStatus = verifyDueWorkWrites(call, dueAdmission, returnedWork, effects.result);
        // Only the actual branded authored-failure shape (empty domain, null
        // result, failed Work terminal) deliberately lacks a successful State
        // return. A completed handler with zero domain writes follows the
        // normal checked return/capture/association handling below; empty
        // writes never waive it. Decided AFTER the independent framework-outbox
        // and owned-schedule checks: refusal still proves every retained guard
        // before its receipt association is withheld.
        if (returnedDomain.length === 0 && effects.result === null && terminalStatus === 'failed') {
          dueEmptyNoAssociation = true;
        }
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
    if (dueEmptyNoAssociation) {
      // Refusal (or empty-domain success): every retained guard above
      // proved, so no State receipt association forms — mirroring the
      // non-receipt path. The verified Work pair still commits below with
      // the failed terminal persisting.
      captures.delete(call);
      return undefined;
    }
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
    state ??= { bound, returnId: null, poisoned: false, pending: 0, observations: [], rowIdGuards: [], intrinsics: [], queries: [], queryResult: undefined, files: [] };
    state.returnId ??= bound.plan.returns[0]!.id;
  }
  if (state === undefined || state.returnId === null) return invalid('checked scenario omitted its actual return capture.');
  if (state.poisoned || state.pending !== 0) return invalid('capture is poisoned or unfinished.');
  resultWire(bound, dataCopy(result));
  const returned = bound.plan.returns.find(entry => entry.id === state.returnId)!;
  requireQueryResult(state, returned, result);
  const required = new Set(returned.dependencies.map(dep => dep.id));
  const observed = state.observations.filter(entry => required.has(entry.dependencyId));
  if (state.observations.some(entry => storedFileInputs.get(entry)?.used && !observed.includes(entry))) {
    return invalid('return omitted an evaluated stored File CALL dependency.');
  }
  requireReturnDependencies(state, returned, observed);
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
        [locator.field, assignmentField(bound, write.model, locator.field).type])) } });
  }
  for (const entry of observed) if (!entry.stored && !entry.ownerSession && !changed.some(change => change.model === entry.model &&
      stableStringify(change.row) === stableStringify(entry.row))) {
    return invalid('provisional read is not the final committed own-row snapshot; owner-session join required.');
  }
  for (const selected of owner?.modelResults ?? []) {
    const write = writes.find(write => write.model === selected.model &&
      (write.kind === 'insert' ? write.row.id : write.id) === selected.row.id);
    if (selected.existing) {
      if (write !== undefined && (write.kind !== 'update' || !sameModelLifetime(selected.row, write.row))) {
        return invalid('existing returned model must preserve its original lifetime through the enclosing effects.');
      }
      continue;
    }
    if (write?.kind !== 'insert' || !sameModelLifetime(selected.row, write.row) ||
        !changed.some(change => change.model === selected.model && change.row.id === selected.row.id &&
          stableStringify(change.row) === stableStringify(write.row))) {
      return invalid('newly-created returned model must survive in its enclosing committed changed snapshots.');
    }
  }
  return deepFreeze(dataCopy({ kind: 'scenario-result/v1' as const, plan: bound.plan, resultType: bound.type,
    returnId: state.returnId,
    observations: observed.map(({ stored: _stored, ownerSession: _ownerSession, ...entry }) => entry),
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
function isAssignmentType(type: unknown): type is CanTypeId {
  if (typeof type !== 'string') return false;
  if (/^file(\[\])?\??$/.test(type)) return true;
  try { storedNominalType(type); return true; } catch { return false; }
}
/** Nominal persistence establishes whole syntax only. Its refs require the
 * genuine current owning schema, never a schema-free JSON traversal. */
function savedAssignmentRefs(type: CanTypeId, wire: unknown): readonly string[] | null {
  if (/^file(\[\])?\??$/.test(type)) return savedFileRefs(type, wire);
  savedNominalWire(type, wire); return null;
}

/** Legacy receipts are unassociated; malformed recognized metadata refuses. */
export function readScenarioReceiptAssociation(receipt: Receipt): ScenarioReceiptAssociation | null {
  return readSavedScenarioAssociation(receipt);
}
function readSavedScenarioAssociation(receipt: Receipt,
  enclosingChanges?: ScenarioReceiptAssociation['changed']): ScenarioReceiptAssociation | null {
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
  const plan = checkScenarioResultDisclosurePlan(value['plan']), resultModel = modelResultType(value['resultType']);
  const resultType = resultModel === undefined ? disclosureType(value['resultType'], plan) : resultModel as CanTypeId;
  const returned = plan.returns.find(entry => entry.id === value['returnId']);
  if (returned === undefined) return invalid('unknown selected return path.');
  if (resultModel !== undefined) {
    if (plan.returns.some(returned => returned.projection !== undefined)) return invalid('saved model result requires its singular source profile.');
    modelResultWire(receipt.outcome.result);
    checkSavedQueries(plan, returned, value['queries'], receipt.outcome.result);
  } else if (returned.projection === undefined) {
    // Same pure-control profile as registration: no stored reads, or only
    // stored CONTROL-role decision reads, means the influences are execution
    // gating only (admitted intrinsics are recorded replay-stable inputs),
    // and the saved queries below revalidate the gating snapshot. Void
    // results carry no value to shape (the wire demands null), so the
    // demand applies only to value-bearing returns, mirroring registration.
    if (resultType !== 'void' && returned.influences.length !== 0 && !returned.dependencies.every(dependency => dependency.role === 'control'))
      return invalid('saved scalar query influences require their defining profile.');
    scalarWire(resultType, receipt.outcome.result); checkSavedQueries(plan, returned, value['queries'], receipt.outcome.result); }
  else checkSavedQueries(plan, returned, value['queries'], receipt.outcome.result);
  const observations = list(value['observations']);
  for (const entry of observations) {
    const observation = object(entry, ['dependencyId', 'model', 'row', 'secretFields',
      ...(typeof entry === 'object' && entry !== null && Object.hasOwn(entry, 'files') ? ['files'] : [])]);
    const dependency = returned.dependencies.find(dep => dep.id === observation['dependencyId']);
    if (dependency === undefined || dependency.model !== observation['model']) return invalid('foreign saved dependency.');
    const row = checkedRow(observation['row']), wire = dependencyObservedWire(dependency, row);
    const query = dependency.queryId === undefined ? undefined : plan.queries?.find(query => query.id === dependency.queryId);
    const messageRole = dependency.role === 'data' && dependency.field === 'role' &&
      (dependency.type === 'TextMessage.role' || dependency.type === 'std.TextMessage.role') &&
      query?.model === dependency.model && stableStringify(query.source) === stableStringify(dependency.source) &&
      query.dependencies.some(entry => entry.role === 'data' && entry.field === dependency.field && entry.type === dependency.type &&
        stableStringify(entry.source) === stableStringify(dependency.source)) &&
      (wire === 'system' || wire === 'user' || wire === 'assistant');
    if (!messageRole) savedDependencyWire(dependency.type, wire);
    paths(observation['secretFields']);
    if (dependency.type === 'file[]' || Object.hasOwn(observation, 'files')) {
      const refs = dependency.type === 'file[]' ? new Set(savedFileRefs(dependency.type, dependencyObservedWire(dependency, row))) : null;
      if (refs === null) savedNominalWire(dependency.type, dependencyObservedWire(dependency, row));
      const files = list(observation['files']).map(checkRetainedScenarioFile);
      if (new Set(files.map(file => file.ref)).size !== files.length || refs !== null &&
          (files.length !== refs.size || files.some(file => !refs.has(file.ref)))) {
        return invalid('saved stored File dependency omitted its exact distinct File census.');
      }
      for (const file of files) {
        const expected = fileReceiver(receipt.identity.app, receipt.identity.principal === 'public' ? null : receipt.identity.principal,
          file.receiver.team === receipt.identity.principal && receipt.identity.owner === 'app' ? null : receipt.identity.owner);
        if (stableStringify(file.receiver) !== stableStringify(expected)) return invalid('stored File dependency receiver differs from its receipt.');
      }
    }
  }
  checkSavedLinkedDependencies(returned, observations as DependencyObservation[],
    (value['queries'] ?? []) as ScenarioReceiptQueryObservation[]);
  for (const saved of (value['queries'] ?? []) as readonly ScenarioReceiptQueryObservation[]) {
    const query = plan.queries!.find(query => query.id === saved.queryId)!;
    if (query.parent?.origin.kind !== 'stored-reference') continue;
    const dependencyId = query.parent.origin.dependencyId;
    const dependency = returned.dependencies.find(dependency => dependency.id === dependencyId);
    const selected = observations.filter(entry => (entry as DependencyObservation).dependencyId === dependencyId) as DependencyObservation[];
    if (dependency === undefined || selected.length !== 1 || saved.parent === undefined || dependency.type !== saved.parent.model ||
        stableStringify(dependencyObservedWire(dependency, selected[0]!.row)) !== stableStringify({ id: saved.parent.row.id })) {
      return invalid('saved query parent differs from its original stored reference observation.');
    }
  }
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
      if (isAssignmentType(type)) {
        if (++fileFieldCount > MAX_ITEMS) return invalid('saved File field budget exceeded.');
        if (!Object.hasOwn(value, 'fileAssignments') || !Object.hasOwn(row.data, field) ||
            (change['withheldFields'] as string[]).includes(field)) return invalid('saved File field omitted its checked assignment closure.');
        savedAssignmentRefs(type, row.data[field]);
      } else if (type !== null) scalarType(type);
    }
    const key = `${change['model']}/${row.id}`;
    if (identities.has(key) || !receipt.outcome.recordVersions.some(version => version.model === change['model'] &&
        version.id === row.id && version.version === row.version)) return invalid('changed snapshot disagrees with committed identities.');
    identities.add(key);
  }
  if (changed.length !== receipt.outcome.recordVersions.length) return invalid('incomplete committed changed snapshots.');
  const witnesses = enclosingChanges ?? changed as ScenarioReceiptAssociation['changed'];
  if (resultModel !== undefined) {
    const id = modelResultWire(receipt.outcome.result);
    const matches = witnesses.filter(change => change.model === resultModel && change.row.id === id);
    const observed = modelResultObservedRow(returned, observations as ScenarioReceiptAssociation['observations'], resultModel, id) ??
      firstSelectedSavedRow(plan, returned, (value['queries'] ?? []) as ScenarioReceiptQueryObservation[], resultModel, id);
    if (matches.length > 0 ? matches.length !== 1 || matches[0]!.row.archivedAt !== null : observed === undefined) {
      return invalid('saved model result lacks its enclosing surviving committed row.');
    }
  }
  const assignments = list(value['fileAssignments'] ?? []); const assignmentKeys = new Set<string>();
  for (const raw of assignments) {
    const assignment = object(raw, ['model', 'recordId', 'rowVersion', 'field', 'file']);
    const model = text(assignment['model']), id = text(assignment['recordId']), field = text(assignment['field']);
    const file = checkRetainedScenarioFile(assignment['file']);
    const change = changed.find(entry => (entry as Record<string, unknown>)['model'] === model &&
      ((entry as Record<string, unknown>)['row'] as StoredRow).id === id) as ScenarioReceiptAssociation['changed'][number] | undefined;
    const type = change?.fieldTypes[field];
    if (change === undefined || assignment['rowVersion'] !== change.row.version || !isAssignmentType(type) ||
        !Object.hasOwn(change.row.data, field) || change.withheldFields.includes(field) ||
        savedAssignmentRefs(type, change.row.data[field])?.includes(file.ref) === false) {
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
      readSavedScenarioAssociation({ ...receipt, identity: { ...receipt.identity, operation: saved['target'] as Receipt['identity']['operation'] },
        outcome: { status: 'committed', result: saved['result'], recordVersions: [],
          scenario: { ...child, changed: [] } as unknown as ScenarioReceiptAssociation } }, witnesses);
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
  const storedFiles = [{ def: def as GeneratedOperationDef, association }, ...(association.calls ?? []).flatMap(call =>
    call.scenario === undefined ? [] : [{ def: input.registry.get(call.target) as GeneratedOperationDef, association: call.scenario }])]
    .flatMap(saved => saved.association.observations.filter(entry =>
      saved.association.plan.returns.find(returned => returned.id === saved.association.returnId)!.dependencies.some(dep =>
        dep.id === entry.dependencyId && (dep.type === 'file[]' ||
          boundPlans.get(saved.def)?.nominalDependencies.get(dep.id)?.profile.hasFiles === true))).map(observation => ({
          def: saved.def, dependency: saved.association.plan.returns.find(returned => returned.id === saved.association.returnId)!.dependencies.find(dep => dep.id === observation.dependencyId)!,
          observation: observation as DependencyObservation,
        })));
  const fileProducer = fileProducers.get(def as GeneratedOperationDef);
  const receiver = actorUserId === null ? null : fileReceiver(input.app, actorUserId, teamId);
  const fileFields = association.changed.flatMap(change => Object.entries(change.fieldTypes)
    .filter(([, type]) => isAssignmentType(type))
    .map(([field, type]) => ({ change, field, type: type as CanTypeId,
      assignments: (association.fileAssignments ?? []).filter(assignment => assignment.model === change.model &&
        assignment.recordId === change.row.id && assignment.field === field) })));
  const readableFileFields = async (change: ScenarioReceiptAssociation['changed'][number], current: StoredRow | null,
    nominalGrant: (field: string) => Promise<boolean>): Promise<string[]> => {
    if (fileProducer === undefined || fileProducer.app !== input.app || receiver === null || current === null ||
        current.id !== change.row.id || current.version < change.row.version || current.archivedAt !== null ||
        current.created !== change.row.created || current.createdBy !== change.row.createdBy ||
        (current.parent?.model ?? null) !== (change.row.parent?.model ?? null) ||
        (current.parent?.id ?? null) !== (change.row.parent?.id ?? null)) return [];
    const readable: string[] = [];
    for (const entry of fileFields.filter(entry => entry.change === change)) {
      try {
        const profile = assignmentField(currentBound, change.model, entry.field);
        if (profile.type !== entry.type || !Object.hasOwn(current.data, entry.field) ||
            stableStringify(current.data[entry.field]) !== stableStringify(change.row.data[entry.field])) continue;
        const refs = new Set(assignmentRefs(profile, change.row.data[entry.field]));
        assignmentRefs(profile, current.data[entry.field]);
        if (entry.assignments.length !== refs.size || new Set(entry.assignments.map(value => value.file.ref)).size !== refs.size ||
            entry.assignments.some(value => !refs.has(value.file.ref))) continue;
        if ('nominal' in profile) {
          if (!await nominalGrant(entry.field)) continue;
        }
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
    if (fileFields.length === 0 && storedFiles.length === 0) return projection;
    // Complete every State row read before the final external physical checks.
    const pending: Array<{ readonly record: ProjectedRecord; readonly changed: ScenarioReceiptAssociation['changed'][number] | undefined; readonly current: StoredRow | null }> = [];
    for (const record of projection.records) {
      const changed = projectedChanges.get(record);
      pending.push({ record, changed, current: changed === undefined ? null : await input.store.load(changed.model, changed.row.id) });
    }
    // Finish State reads before the final external physical pass. Earlier
    // source projections already cover original grants and ancestors; the
    // following Identity snapshot and State fence protect those decisions.
    for (const saved of storedFiles) {
      const bound = boundPlans.get(saved.def), file = bound?.fileDependencies.get(saved.dependency.id),
        nominal = bound?.nominalDependencies.get(saved.dependency.id), profile = file ?? nominal;
      const current = await input.store.load(saved.observation.model, saved.observation.row.id);
      if (profile === undefined || stableStringify(profile.dependency) !== stableStringify(saved.dependency) || current === null ||
          !sameModelLifetime(saved.observation.row, current) || !Object.hasOwn(current.data, saved.dependency.field)) return { result: null, records: [] };
      try {
        if (file !== undefined) scenarioFileWireRefs(file.profile, current.data[saved.dependency.field]);
        else storedNominalFileRefs(nominal!.profile, current.data[saved.dependency.field]);
      }
      catch { return { result: null, records: [] }; }
    }
    const records: ProjectedRecord[] = [];
    for (const { record, changed, current } of pending) {
      if (changed === undefined) { records.push(record); continue; }
      // This is the same authentic projection whose whole source grant was
      // checked in projectOnce. Identity and State are fenced after this pass.
      const fields = await readableFileFields(changed, current, async field => Object.hasOwn(record.data, field));
      const data = { ...record.data };
      for (const entry of fileFields.filter(entry => entry.change === changed)) if (!fields.includes(entry.field)) delete data[entry.field];
      records.push({ ...record, data });
    }
    for (const saved of storedFiles) {
      const producer = fileProducers.get(saved.def);
      if (producer?.app !== input.app || receiver === null || saved.observation.files === undefined) return { result: null, records: [] };
      for (const file of saved.observation.files) {
        try {
          if (stableStringify(file.receiver) !== stableStringify(receiver) || await producer.revalidate(file, receiver) !== true) return { result: null, records: [] };
        } catch { return { result: null, records: [] }; }
      }
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
  const modelInfluence = currentBound.resultModel !== undefined || association.calls?.some(saved =>
    modelResultType(saved.scenario?.resultType) !== undefined) === true;
  const scopedQueryInfluence = currentBound.plan.queries?.some(query => query.parent !== undefined) === true ||
    association.calls?.some(saved => saved.scenario?.plan.queries?.some(query => query.parent !== undefined)) === true;
  const fileInfluence = storedFiles.length !== 0 || fileFields.some(entry => !/^file(\[\])?\??$/.test(entry.type));
  const modelSourceProducers = [def, ...(association.calls ?? []).map(saved => input.registry.get(saved.target))]
    .flatMap(def => def === undefined ? [] : [referenceProducers.get(def as GeneratedOperationDef)])
    .filter((producer): producer is NonNullable<typeof producer> => producer?.app === input.app && producer.readPolicies !== undefined);
  const rowIdInfluence = currentBound.idDependencies.size !== 0 || association.calls?.some(saved => {
    const target = input.registry.get(saved.target);
    return target !== undefined && (boundPlans.get(target as GeneratedOperationDef)?.idDependencies.size ?? 0) !== 0;
  }) === true;
  const referenceInfluence = currentBound.referenceDependencies.size !== 0 ||
    association.calls?.some(saved => {
      const target = input.registry.get(saved.target);
      return target !== undefined && (boundPlans.get(target as GeneratedOperationDef)?.referenceDependencies.size ?? 0) !== 0;
    }) === true;
  const projectOnce = async (member: Awaited<ReturnType<typeof membership>>) => {
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
    const sourceProjection = async (producer: ScenarioReceiptReferenceProducer, model: ModelName, current: StoredRow) => {
      if (producer.readPolicies === undefined) return null;
      try {
        const projected = await projectInstalledSourceRowAndAncestors({ model, row: current,
          readPolicies: producer.readPolicies, policy: producer.policy, context, revision, fence: undefined,
          store: input.store, rows: new Map([[`${model}\0${current.id}`, current]]) });
        return projected.record === null ? null : projected;
      } catch (error) {
        // Source navigation can deny an unavailable ancestor with not_found.
        // The retained receipt stays valid; only its saved disclosure is denied.
        if (error instanceof StateError && error.code === 'not_found') return null;
        throw error;
      }
    };
    const modelResultReadable = async (def: GeneratedOperationDef, bound: BoundPlan, result: unknown,
      scope: Pick<ScenarioReceiptAssociation, 'plan' | 'returnId' | 'observations'> = association) => {
      if (bound.resultModel === undefined) return true;
      const id = modelResultWire(result), model = bound.resultModel;
      const returned = scope.plan.returns.find(returned => returned.id === scope.returnId);
      const witness = association.changed.find(change => change.model === model && change.row.id === id)?.row ??
        (returned === undefined ? undefined : modelResultObservedRow(returned, scope.observations, model, id) ??
          firstSelectedSavedRow(scope.plan, returned, association.queries ?? [], model, id));
      const producer = referenceProducers.get(def);
      if (witness === undefined || producer?.app !== input.app || producer.readPolicies === undefined) return false;
      const current = await currentSavedRow(model, witness);
      return current !== null && await sourceProjection(producer, model, current) !== null;
    };
    const savedProjection = async (model: ModelName, saved: StoredRow, originalSecrets: readonly string[], blocked: readonly string[], queryFields: readonly string[] = [], fileFields: readonly string[] = [],
      nominal?: { readonly field: string; readonly profile: StoredNominalFieldProfile },
      reference?: { readonly field: string; readonly profile: StoredReferenceFieldProfile },
      source?: ScenarioReceiptReferenceProducer) => {
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
        if (source !== undefined) {
          const authority = await sourceProjection(source, model, current);
          const projected = authority === null ? undefined : sourceReferenceProjection(reference.profile, authority.record);
          if (projected === undefined || stableStringify(projected) !== stableStringify(currentWire)) return null;
        } else {
          const policy = input.policy.get(model);
          if (policy === undefined) return null;
          const authority = await projectCurrentRecordForViewerPolicy({ policy, context, row: current });
          const projected = sourceReferenceProjection(reference.profile, authority.record);
          if (!wholeReferenceGrant(policy, authority.allowed, current, reference.profile) || projected === undefined ||
              stableStringify(projected) !== stableStringify(currentWire)) return null;
        }
      }
      const secrets = [...originalSecrets, ...blocked, ...inventory.secrets, ...inventory.withheld.filter(field =>
        !queryFields.includes(field) && !fileFields.includes(field) && field !== nominal?.field && field !== reference?.field)];
      if (source !== undefined || modelInfluence || scopedQueryInfluence) {
        const producer = source ?? modelSourceProducers.find(producer => producer.readPolicies?.has(model));
        if (producer === undefined) return null;
        const projected = await sourceProjection(producer, model, current);
        if (projected === null) return null;
        const read = producer.readPolicies!.get(model)!;
        if ('grants' in read) return projectSourceRowFields(saved, projected.grants, [...secrets, ...read.secretFields]);
        if (source !== undefined) return projectSavedRecordForViewer({ policy: producer.policy.get(model), context, current, saved, originalSecretFields: secrets });
      }
      return projectSavedRecordForViewer({ policy: input.policy.get(model), context, current, saved, originalSecretFields: secrets });
    };
    const dependencyProjection = async (consumer: GeneratedOperationDef, bound: BoundPlan,
      dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number],
      observation: DependencyObservation) => {
      const linkedSource = dependency.queryId === undefined ? undefined : querySourceProducer(consumer, observation.model);
      if (dependency.queryId !== undefined && (linkedSource?.app !== input.app || linkedSource.readPolicies?.has(observation.model) !== true ||
          !bound.plan.queries?.some(query => query.id === dependency.queryId &&
            stableStringify(query.source) === stableStringify(dependency.source)) ||
          stableStringify(linkedSource.source) !== stableStringify(dependency.source))) return null;
      const file = bound.fileDependencies.get(dependency.id), protectedNominal = bound.nominalDependencies.get(dependency.id);
      if (file !== undefined || protectedNominal?.profile.hasFiles === true) {
        if (stableStringify((file ?? protectedNominal)!.dependency) !== stableStringify(dependency) || observation.files === undefined) return null;
        const current = await currentSavedRow(observation.model, observation.row), source = linkedSource ?? referenceProducers.get(consumer), producer = fileProducers.get(consumer);
        const read = source?.readPolicies?.get(observation.model);
        if (current === null || source?.app !== input.app || producer?.app !== input.app || receiver === null || read === undefined ||
            !('grants' in read) || !Object.hasOwn(current.data, dependency.field)) return null;
        try {
          const refs = [...new Set(file !== undefined
            ? scenarioFileWireRefs(file.profile, dependencyObservedWire(dependency, observation.row))
            : storedNominalFileRefs(protectedNominal!.profile, dependencyObservedWire(dependency, observation.row)))];
          if (observation.files.length !== refs.length || observation.files.some(fact => !refs.includes(fact.ref)) ||
              new Set(observation.files.map(fact => fact.ref)).size !== refs.length) return null;
          if (file !== undefined) scenarioFileWireRefs(file.profile, current.data[dependency.field]);
          else storedNominalFileRefs(protectedNominal!.profile, current.data[dependency.field]);
        } catch { return null; }
        const projected = await sourceProjection(source, observation.model, current);
        if (projected === null || !projected.grants.some(grant => grant.fields.includes(dependency.field))) return null;
        for (const fact of observation.files) {
          if (stableStringify(fact.receiver) !== stableStringify(receiver) || await producer.revalidate(fact, receiver) !== true) return null;
        }
        const inventory = bound.models.get(observation.model)!;
        return projectSourceRowFields(observation.row, projected.grants, [...observation.secretFields, ...inventory.secrets,
          ...read.secretFields, ...inventory.withheld.filter(field => field !== dependency.field)]);
      }
      const id = bound.idDependencies.get(dependency.id);
      if (id !== undefined) {
        if (stableStringify(id) !== stableStringify(dependency)) return null;
        const current = await currentSavedRow(observation.model, observation.row), producer = referenceProducers.get(consumer);
        if (current === null || producer?.app !== input.app || producer.readPolicies === undefined ||
            stableStringify(producer.source) !== stableStringify(dependency.source)) return null;
        return (await sourceProjection(producer, observation.model, current))?.record ?? null;
      }
      const reference = bound.referenceDependencies.get(dependency.id);
      if (reference !== undefined) {
        if (stableStringify(reference.dependency) !== stableStringify(dependency)) return null;
        return savedProjection(observation.model, observation.row, observation.secretFields, [], [], [], undefined,
          { field: dependency.field, profile: reference.profile }, linkedSource ??
            (referenceProducers.get(consumer)?.readPolicies?.has(observation.model) ? referenceProducers.get(consumer) : undefined));
      }
      const namedEnum = bound.namedEnumDependencies.get(dependency.id);
      if (namedEnum !== undefined) {
        try {
          const current = await currentSavedRow(observation.model, observation.row);
          if (current === null || observation.files !== undefined || linkedSource === undefined || stableStringify(namedEnum) !== stableStringify(dependency)) return null;
          for (const row of [observation.row, current]) validateValue(bound.valueSchema!, dependency.type, dependencyObservedWire(dependency, row), 'create');
          return savedProjection(observation.model, observation.row, observation.secretFields, [], [dependency.field], [], undefined, undefined, linkedSource);
        } catch { return null; }
      }
      const nominal = bound.nominalDependencies.get(dependency.id);
      if (nominal === undefined) {
        if (observation.files !== undefined) return null;
        const source = querySourceProducer(consumer, observation.model)?.readPolicies?.has(observation.model) ? querySourceProducer(consumer, observation.model) : undefined;
        const projection = await savedProjection(observation.model, observation.row, observation.secretFields, [], [], [], undefined, undefined, source);
        const narrowed = bound.narrowedDependencies.get(dependency.id);
        if (narrowed !== undefined) {
          const current = await currentSavedRow(observation.model, observation.row);
          if (current === null) return null;
          try { scalarWire(narrowed.declarationType, dependencyObservedWire(dependency, current)); }
          catch { return null; }
        }
        return bound.models.get(observation.model)?.fields.get(dependency.field) === (narrowed?.declarationType ?? dependency.type) ? projection : null;
      }
      if (stableStringify(nominal.dependency) !== stableStringify(dependency) || observation.files !== undefined) return null;
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
      if (bound.idDependencies.has(dependency.id)) return projection.id === observation.row.id;
      const reference = bound.referenceDependencies.get(dependency.id);
      if (reference !== undefined) {
        const wire = sourceReferenceProjection(reference.profile, projection);
        return wire !== undefined && stableStringify(wire) === stableStringify(storedReferenceWire(reference.profile, observation.row));
      }
      return Object.hasOwn(projection.data, dependency.field) &&
        stableStringify(projection.data[dependency.field]) === stableStringify(observation.row.data[dependency.field]);
    };
    const queryAuthority = async (consumer: GeneratedOperationDef, bound: BoundPlan, saved: { readonly plan: ScenarioResultDisclosurePlan;
      readonly returnId: string; readonly queries?: readonly ScenarioReceiptQueryObservation[] }) => {
      const returned = saved.plan.returns.find(entry => entry.id === saved.returnId);
      if (returned === undefined) return false;
      for (const id of returnQueryIds(returned)) {
        const recipe = querySelections.get(consumer)?.get(id);
        if (bound.plan.queries?.find(query => query.id === id)?.dependencies.some(dependency => dependency.role === 'data') && bound.resultModel !== undefined) {
          if (recipe === undefined) return false;
          try {
            const observed = saved.queries?.find(query => query.queryId === id);
            if (observed === undefined) return false;
            scenarioQuerySelectionWire(recipe, observed.selectedIndices.map(index => observed.candidates[index]!.record));
          } catch { return false; }
        }
        const plan = bound.plan.queries?.find(query => query.id === id);
        const observed = saved.queries?.find(query => query.queryId === plan?.id);
        if (plan === undefined || observed === undefined) return false;
        try {
          const any = bound.anyQueries.get(id);
          if (any !== undefined) checkSavedScenarioQueryAny(any, observed);
          if (plan.parent !== undefined) {
            const parent = observed.parent, producer = querySourceProducer(consumer, plan.parent.model);
            if (parent === undefined || parent.model !== plan.parent.model || producer?.app !== input.app ||
                producer.readPolicies?.has(parent.model) !== true) return false;
            const current = await currentSavedRow(parent.model, parent.row);
            if (current === null || await sourceProjection(producer, parent.model, current) === null) return false;
          }
          const currentRows: StoredRow[] = [];
          for (const candidate of observed.candidates) {
            const current = await currentSavedRow(plan.model, candidate.row);
            if (current === null) return false;
            if (queryProducers.get(consumer)?.readPolicies !== undefined || bound.resultModel !== undefined || plan.parent !== undefined || plan.dependencies.some(dep => dep.field === 'parent')) {
              const producer = querySourceProducer(consumer, plan.model);
              if (producer?.app !== input.app || producer.readPolicies?.has(plan.model) !== true) return false;
              const source = await sourceProjection(producer, plan.model, current);
              const dependencies = any !== undefined || recipe !== undefined || (plan.parent !== undefined || queryProducers.get(consumer)?.readPolicies !== undefined) && bound.resultModel === undefined
                ? plan.dependencies.filter(dependency => candidate.dependencies.includes(dependency.id)) : plan.dependencies;
              if (source === null || dependencies.some(dependency => dependency.field === 'parent'
                ? source.record!.parent === null || source.record!.parent.model !== dependency.type
                : ('grants' in producer.readPolicies!.get(plan.model)! && !source.grants.some(grant => grant.fields.includes(dependency.field))) ||
                  !Object.hasOwn(source.record!.data, dependency.field))) return false;
            }
            currentRows.push(current);
          }
          const producer = queryProducers.get(consumer);
          await queryRecordsObserved({ model: plan.model, modelDescriptor: queryModelDescriptor(bound, plan), authority: 'viewer',
            policy: producer?.readPolicies === undefined ? input.policy : producer.policy,
            ...(producer?.readPolicies === undefined ? {} : { sourceReadPolicies: producer.readPolicies }), context: { actorUserId, teamId }, memberships,
            store: producer?.readPolicies === undefined ? { ...input.store, readRevision: () => input.store.readRevision(), query: async () => currentRows } : input.store,
            archived: plan.archived, ...(plan.order.length === 0 ? {} : { order: plan.order }) }, () => true,
          any === undefined ? [...new Set(plan.dependencies.filter(dep => dep.role === 'control' && dep.field !== 'parent').map(dep => dep.field))] : [], producer?.readPolicies === undefined ? undefined : currentRows);
        } catch (error) { if (error instanceof StateError) return false; throw error; }
      }
      return true;
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
      if (!savedNarrowedControls(current, child.observations)) dependenciesReadable = false;
      if (!await modelResultReadable(target, current, saved.result, saved.scenario ?? association)) dependenciesReadable = false;
      const returned = child.plan.returns.find(entry => entry.id === child.returnId)!;
      if (!await queryAuthority(target, current, child) || !await savedQueriesReadable(current, child, saved.result, (model, row, secrets, blocked) =>
        savedProjection(model, row, secrets, blocked, current.plan.queries?.filter(query => query.model === model).flatMap(query => query.dependencies.map(dep => dep.field)) ?? [], [], undefined, undefined,
          queryProducers.get(target)?.readPolicies?.has(model) ? querySourceProducer(target, model) : undefined))) dependenciesReadable = false;
      for (const observed of child.observations) {
        const dependency = returned.dependencies.find(dep => dep.id === observed.dependencyId)!;
        const projection = await dependencyProjection(target, current, dependency, observed);
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
    if (!savedNarrowedControls(currentBound, association.observations)) dependenciesReadable = false;
    if (currentBound.resultModel !== undefined && (stableStringify(currentBound.plan) !== stableStringify(association.plan) ||
        !await modelResultReadable(def as GeneratedOperationDef, currentBound, receipt.outcome.status === 'committed' ? receipt.outcome.result : null))) {
      dependenciesReadable = false;
    }
    if (!await queryAuthority(def as GeneratedOperationDef, currentBound, association) ||
        !await savedQueriesReadable(currentBound, association, receipt.outcome.status === 'committed' ? receipt.outcome.result : null, (model, row, secrets, blocked) =>
          savedProjection(model, row, secrets, blocked, currentBound.plan.queries?.filter(query => query.model === model).flatMap(query => query.dependencies.map(dep => dep.field)) ?? [], [], undefined, undefined,
            queryProducers.get(def as GeneratedOperationDef)?.readPolicies?.has(model) ? querySourceProducer(def as GeneratedOperationDef, model) : undefined))) dependenciesReadable = false;
    for (const observation of association.observations) {
      const dependency = returned.dependencies.find(dep => dep.id === observation.dependencyId)!;
      const projection = await dependencyProjection(def as GeneratedOperationDef, currentBound, dependency, observation);
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
        ? await readableFileFields(changed, await currentSavedRow(changed.model, changed.row), async field => {
          const source = referenceProducers.get(def as GeneratedOperationDef), current = await currentSavedRow(changed.model, changed.row);
          if (current === null || source?.app !== input.app || source.readPolicies?.has(changed.model) !== true) return false;
          const projected = await sourceProjection(source, changed.model, current);
          return projected !== null && projected.grants.some(grant => grant.fields.includes(field));
        }) : [];
      const drifted = Object.keys(changed.row.data).filter(field => !files.includes(field) &&
        (!Object.hasOwn(changed.fieldTypes, field) || fields?.get(field) !== changed.fieldTypes[field]));
      const assignedNominal = fileFields.some(entry => entry.change === changed && !/^file(\[\])?\??$/.test(entry.type));
      const record = await savedProjection(changed.model, changed.row, changed.secretFields, [...changed.withheldFields, ...drifted], [], files,
        undefined, undefined, assignedNominal ? referenceProducers.get(def as GeneratedOperationDef) : undefined);
      if (record !== null && dependenciesReadable) { projectedChanges.set(record, changed); records.push(record); }
    }
    return { result: dependenciesReadable && association.resultType === currentBound.type && receipt.outcome.status === 'committed'
      ? dataCopy(receipt.outcome.result) : null, records };
  };
  const project = async (member: Awaited<ReturnType<typeof membership>>) => {
    try { const outcome = await projectOnce(member);
      return outcome; }
    catch (error) {
      // A current row grant can lose its complete Identity facts during an
      // awaited row projection. No partial retained influence escapes it.
      if ((referenceInfluence || modelInfluence || scopedQueryInfluence || fileInfluence || rowIdInfluence) && error instanceof StateError && error.code === 'forbidden' ||
          (modelInfluence || scopedQueryInfluence || fileInfluence || rowIdInfluence) && error instanceof FenceConflictError) return withheld;
      throw error;
    }
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
    if (fileFields.length !== 0 || fileInfluence) {
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
  if (fileFields.length !== 0 || fileInfluence) for (const fact of authorityFacts.values()) {
    if (stableStringify(dataCopy(await input.memberships.findMembership(fact.teamId, fact.userId))) !== fact.snapshot) return withheld;
  }
  if (await input.store.readRevision() !== revision) return withheld;
  return finalProjection;
}
