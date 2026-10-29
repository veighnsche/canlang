import { StateError } from '../errors.js';
import { checkOwnerModelPolicyDescriptors } from '../mutation/model-policies.js';
import { checkFieldMachine } from '../internal/machine.js';
import {
  normalizeValueTypes, ValueTypesError, parseTypeId, printTypeId, decodeValue, encodeValue,
  compareDecimal, compareDate, compareInstant, compareMoney, isDecimal, isDateValue, isDatetime, isMoney, datetime,
  type NormalizedSchema,
} from '@canlang/values';
import { bindScenarioReceiptPlan } from './scenario-receipt.js';
import { checkScenarioResultDisclosurePlanSet } from './scenario-plan.js';
import type { ScenarioResultDisclosurePlan } from '@canlang/contracts';
/** Transport-shaped installed disclosure: today's single plan or the
 * ordered copy-plan array for partitioned owners. The contracts type still
 * names the single plan; the runtime carries the transported shape and State
 * revalidates it at every custody boundary. */
function installedDisclosureCopies(disclosure: ScenarioResultDisclosurePlan): readonly ScenarioResultDisclosurePlan[] {
  return Array.isArray(disclosure)
    ? disclosure as unknown as readonly ScenarioResultDisclosurePlan[]
    : [disclosure];
}
/**
 * Lane 03 T16a: operation registry — INTERIM engine-local defs plus the
 * generated-descriptor join.
 *
 * INTERIM half: `InterimOperationDef` keeps its exact shape and behavior; the
 * L1 artifact carried no operation descriptors yet when it was written, so
 * admission consumed these hand-built descriptors. Preserved byte-for-byte
 * for existing callers.
 *
 * JOIN half (T16a, core scope = T15a descriptors): `loadArtifactDescriptors`
 * converts a compiled artifact's `operations[]`/`models[]` (L1 `artifact.ts`,
 * `artifact_version` 1) into the frozen T04a intake (`ExecutionDescriptorSet`,
 * `contractVersion` 1) and loads it into an `OperationRegistry` that `admit`
 * and `invoke` consume directly — no parallel engine. `loadExecutionDescriptorSet`
 * loads an already-folded intake set for callers that hold one.
 *
 * Compatibility (execution-contract §6/§7): exact version match, never a
 * silent fallback. An unknown operation kind, input kind, or default kind —
 * or any malformed/dangling descriptor below — rejects the WHOLE set with a
 * precise `IncompatibleArtifactError`. Additive members L3 ignores (op/input
 * descriptions, nullability, model ownership, T04b-preview model field tags,
 * unknown model field tags) never reject. Own result/valueType claims use
 * the finite typed profile; optional source revisions identify the load only.
 *
 * Engine-local attachments (T04a §3: authorization predicates stay
 * engine-local until T04b carries generated policy): the loader maps a `by`
 * predicate (and an optional CRUD `when` precondition) onto every generated
 * operation via `LoadDescriptorSetOptions`. Model field `ref` tags fold into
 * engine-local `InterimRefDef` entries returned beside the set; the model
 * table builder (`mutation/models.ts`) consumes them.
 */

import {
  EXECUTION_CONTRACT_VERSION,
  STATE_CONTRACT_VERSION,
  T04A_PINNED_VERSIONS,
  STD_EMAIL_V1_CONTRACT,
  STD_ERRORS_V1_CONTRACT,
  STD_IMAGES_V1_CONTRACT,
  STD_MAILBOX_V1_CONTRACT,
  STD_PAYMENTS_V1_CONTRACT,
  STD_TEXT_GENERATION_V1_CONTRACT,
  deliveryResultLeaves,
  type CanonicalFieldDefault,
  type CanonicalDeliveryDescriptor,
  type CanonicalJudgmentDeliveryDescriptor,
  type CanonicalInputDef,
  type CanonicalModelDescriptor,
  type CanonicalOwnerModelPolicies,
  type CanonicalOperationDescriptor,
  type CanonicalOperationKind,
  type CanonicalScalarKind,
  type CanonicalValueTypes,
  type DeleteMode,
  type ExecutionDescriptorSet,
  type ModelName,
  type OperationName,
  type QueryPredicate,
  type StateUniqueKeyProducerBinding,
  type StateFieldValidationProducerBinding,
} from '@canlang/contracts';
import type {
  ArtifactGivenKeyword,
  ArtifactGivenTrait,
  ArtifactModel,
  ArtifactCallable,
  ArtifactOperation,
  ArtifactSource,
  CanTypeId,
  CompileArtifact,
} from '@canlang/contracts';
import { validateByPredicate, type ByPredicate } from '../policy/roles.js';
import { validatePredicateShape } from '../policy/grants.js';
import { modelFieldConstraintSchema, type InterimContainment, type InterimRefDef } from '../mutation/models.js';
import {
  createDeliverySchema,
  type DeliveryFieldSchema,
} from '../receipt/grants.js';
import {
  prepareDescriptorInputs,
  type PreparedOperationPlan,
} from './prepared-inputs.js';

/**
 * INTERIM input descriptor. Scalar bounds arrive with S5/L2; S3 validates
 * presence, shape, and closedness only.
 */
export type InterimInputDef =
  | { type: 'record'; model: ModelName; versioned: boolean; required: boolean }
  | { type: 'scalar'; required: boolean };

/** INTERIM operation descriptor: admission policy plus input shapes. */
export interface InterimOperationDef {
  name: OperationName;
  kind: 'scenario' | 'crud.create' | 'crud.update' | 'crud.delete' | 'read';
  by: ByPredicate;
  inputs: Record<string, InterimInputDef>;
}

/**
 * T16a generated operation: a validated canonical descriptor plus its
 * engine-local authorization (`by`) and optional CRUD candidate
 * precondition (`when`). `inputArrays` carries the T15a operation-input
 * array markers from the artifact or checked canonical ref carriers;
 * intake-direct scalar/nominal markers may also arrive through loader hints.
 * Admission fills eligible ordinary-array omissions from this joined channel.
 */
export interface GeneratedOperationDef {
  readonly generated: true;
  /** Operation identity (mirrors `descriptor.name` for interim parity). */
  readonly name: OperationName;
  /** Canonical kind (mirrors `descriptor.kind` for interim parity). */
  readonly kind: CanonicalOperationKind;
  readonly descriptor: CanonicalOperationDescriptor;
  readonly by: ByPredicate;
  readonly when?: QueryPredicate;
  readonly inputArrays: Readonly<Record<string, { readonly required: boolean }>>;
  /** Checked explicit nullable singular-ref inputs; absent carries no proof. */
  readonly inputNullableRefs?: Readonly<Record<string, true>>;
  /**
   * V02.4 prepared-inputs plan (`state-generated/v1`): copied data-only
   * input metadata for this def, built fresh at load. Present on every
   * loader-produced def; absent on synthetic/interim-derived defs, which
   * carry no proven producer provenance. Admission ignores it (a later
   * bridge handoff consumes it); the prepared validator is pinned
   * against the current-TS validator, never a second authority.
   */
  readonly preparedInputs?: PreparedOperationPlan;
}

/** Same-load nominal input declarations are private admission provenance. */
const generatedInputDeclarations = new WeakMap<GeneratedOperationDef, {
  readonly valueSchema: NormalizedSchema; readonly modelNames: ReadonlySet<string>;
}>();
export function generatedCallInputDeclarations(def: GeneratedOperationDef) {
  return generatedInputDeclarations.get(def);
}

/** True for loader-produced generated defs (never for interim defs). */
export function isGeneratedOperationDef(
  def: InterimOperationDef | GeneratedOperationDef,
): def is GeneratedOperationDef {
  return (
    typeof def === 'object' &&
    def !== null &&
    (def as { generated?: unknown }).generated === true
  );
}

/** Registry: fully qualified operation name to interim or generated descriptor. */
export type OperationRegistry = ReadonlyMap<string, InterimOperationDef | GeneratedOperationDef>;

/** Machine-readable whole-set rejection reasons (see `IncompatibleArtifactError`). */
export type IncompatibleArtifactReason =
  | 'version_mismatch'
  | 'unknown_operation_kind'
  | 'unknown_input_kind'
  | 'unknown_default_kind'
  | 'malformed_descriptor'
  | 'duplicate_name'
  | 'dangling_reference'
  | 'unsupported_composite_unique'
  | 'unsupported_server_init'
  | 'unknown_producer'
  | 'unsupported_given_contribution';

/**
 * Precise incompatible-artifact failure: the descriptor set (or artifact
 * slice) cannot load and NOTHING from it was admitted — there is no partial
 * registry and never a silent fallback. `reason` is the machine-readable
 * class; the message names the exact offending member and the expected
 * contract versions.
 */
export class IncompatibleArtifactError extends Error {
  readonly reason: IncompatibleArtifactReason;

  constructor(reason: IncompatibleArtifactReason, message: string) {
    super(message);
    this.name = 'IncompatibleArtifactError';
    this.reason = reason;
  }
}

function fail(reason: IncompatibleArtifactReason, message: string): never {
  throw new IncompatibleArtifactError(reason, message);
}

/** Engine-local policy mapped onto generated operations at load time. */
export interface LoadDescriptorSetOptions {
  /**
   * Authorization per generated operation: one predicate for the whole set,
   * or a function of the validated descriptor. Malformed predicates throw
   * plain `Error` (caller programmer bug, mirroring `crudDefs`) — never an
   * artifact error, since the predicate is engine-local, not artifact content.
   */
  readonly by: ByPredicate | ((op: CanonicalOperationDescriptor) => ByPredicate);
  /**
   * Optional CRUD candidate precondition per generated operation. Attached
   * to update/delete defs and threaded into the pipeline; creates ignore it
   * (mirroring interim `crudDefs`, where `when` never runs on creates).
   */
  readonly when?:
    | QueryPredicate
    | ((op: CanonicalOperationDescriptor) => QueryPredicate | undefined);
  /**
   * T04b-preview engine-local input array markers, keyed by operation name
   * then input name. The artifact loader populates this from
   * `ArtifactOperationInput.array`; intake-direct callers pass it only when
   * they hold out-of-intake marker info. Entries naming no loaded
   * operation/input, or carrying a non-boolean `required`, reject the set.
   */
  readonly inputArrays?: Readonly<
    Record<string, Readonly<Record<string, { readonly required: boolean }>>>
  >;
  /** Intake-direct checked nullable singular-ref association, keyed by operation/input. */
  readonly inputNullableRefs?: Readonly<Record<string, Readonly<Record<string, true>>>>;
}

/** A loaded set: the admission-ready registry plus validated model intake. */
export interface LoadedDescriptorSet {
  readonly registry: OperationRegistry;
  readonly models: ReadonlyArray<CanonicalModelDescriptor>;
  /** Normalized once from the checked source inventory; absent for legacy sets. */
  readonly valueSchema?: NormalizedSchema;
  readonly valueTypes?: CanonicalValueTypes;
}

/** The artifact slice the join consumes (L7 owns `requires` fulfillment). */
export type ArtifactDescriptorSlice = Pick<
  CompileArtifact,
  'artifact_version' | 'operations' | 'models'
> & Partial<Pick<CompileArtifact, 'sources' | 'valueTypes' | 'modelPolicies' | 'modules' | 'callables' | 'givenContracts' | 'requires'>>;

/**
 * T18 engine-resolvable server initializer (closed subset of L1
 * `ArtifactServerInit`: `actor` stamps the invoking actor as a wire
 * `{id}` user value, `now` stamps the frozen invocation clock as an RFC
 * 3339 millis datetime string, `random_secret` mints fresh opaque hex
 * material per execution).
 */
export type ServerInitKind = 'actor' | 'now' | 'random_secret';

/**
 * Converted artifact descriptors: the folded intake set, engine-local model
 * refs derived from singular top-level `ref` field tags (array-of-ref tags
 * are skipped — ref paths treat arrays as opaque leaves, so deriving them
 * would reject valid creates; T04b formalizes), per-operation input
 * array markers, T18 per-field server initializers, T18
 * known-nullable field names (both keyed by model, then field), B5
 * declared ownership per model (additive `parent`/`scope` members the
 * frozen intake cannot hold; one entry per model, empty for declared
 * team-scope roots), and B3 declared delivery fields per model (T15b
 * `delivery` field tags; the receipt join's schema source).
 */
export interface ConvertedArtifactDescriptors {
  readonly modelPolicies?: readonly CanonicalOwnerModelPolicies[];
  readonly sources?: ReadonlyArray<Readonly<ArtifactSource>>;
  readonly set: ExecutionDescriptorSet;
  readonly valueSchema?: NormalizedSchema;
  readonly refs: ReadonlyMap<ModelName, ReadonlyArray<InterimRefDef>>;
  readonly inputArrays: Readonly<
    Record<string, Readonly<Record<string, { readonly required: boolean }>>>
  >;
  readonly inputNullableRefs: Readonly<Record<string, Readonly<Record<string, true>>>>;
  readonly serverInits: ReadonlyMap<ModelName, ReadonlyMap<string, ServerInitKind>>;
  readonly nullableFields: ReadonlyMap<ModelName, ReadonlySet<string>>;
  /** Typed-secret field names, independent of caller-input serverOnly restrictions. */
  readonly secretFields: ReadonlyMap<ModelName, ReadonlySet<string>>;
  readonly containment: ReadonlyMap<ModelName, InterimContainment>;
  readonly deliveryFields: DeliveryFieldSchema;
  /**
   * BGI-08 checked `state.unique-key@1` bindings in artifact order. Trait
   * instantiations fold into `set.models` above; keyword rules arrive here
   * for the seam to resolve against saved implementations. Empty when the
   * artifact carries no keyword rules — never inferred, never partial.
   */
  readonly givenUniqueKeys: ReadonlyArray<StateUniqueKeyProducerBinding>;
  readonly givenFieldValidations: ReadonlyArray<StateFieldValidationProducerBinding>;
}

/** Fully loaded artifact: registry + models + engine-local model attachments. */
export interface LoadedArtifactDescriptors extends LoadedDescriptorSet {
  /** Immutable checked JSON metadata; owning native callbacks remain separate. */
  readonly modelPolicies?: readonly CanonicalOwnerModelPolicies[];
  /** Copied compilation inputs identify this load; they confer no authority. */
  readonly sources?: ReadonlyArray<Readonly<ArtifactSource>>;
  readonly refs: ReadonlyMap<ModelName, ReadonlyArray<InterimRefDef>>;
  readonly serverInits: ReadonlyMap<ModelName, ReadonlyMap<string, ServerInitKind>>;
  readonly nullableFields: ReadonlyMap<ModelName, ReadonlySet<string>>;
  /** Typed-secret field names, independent of caller-input serverOnly restrictions. */
  readonly secretFields: ReadonlyMap<ModelName, ReadonlySet<string>>;
  readonly containment: ReadonlyMap<ModelName, InterimContainment>;
  readonly deliveryFields: DeliveryFieldSchema;
  /**
   * BGI-08 checked `state.unique-key@1` bindings in artifact order (see
   * `ConvertedArtifactDescriptors.givenUniqueKeys`). Intake-direct sets
   * (`loadExecutionDescriptorSet`) carry no checked source and expose no
   * member: generated behavior never loads without its checked contract.
   */
  readonly givenUniqueKeys: ReadonlyArray<StateUniqueKeyProducerBinding>;
  readonly givenFieldValidations?: ReadonlyArray<StateFieldValidationProducerBinding>;
}

const KNOWN_OPERATION_KINDS: ReadonlySet<string> = new Set([
  'read',
  'create',
  'update',
  'delete',
  'scenario',
]);

const KNOWN_INPUT_KINDS: ReadonlySet<string> = new Set([
  'ref',
  'string',
  'integer',
  'decimal',
  'money',
  'datetime',
  'duration',
  'user',
  'boolean',
  'file',
  'enum',
  'nominal',
  'delivery',
]);

const KNOWN_DEFAULT_KINDS: ReadonlySet<string> = new Set([
  'literal',
  'parent',
  'context',
  'server',
  'derived',
]);

/** T18 closed server-init tokens the engine resolves (L1 `ArtifactServerInit` minus `computed`). */
const KNOWN_SERVER_INITS: ReadonlySet<string> = new Set(['actor', 'now', 'random_secret']);

const KNOWN_DELETE_MODES: ReadonlySet<string> = new Set(['archive', 'remove', 'none']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Own-only intake claims use the defining Values inventory normalizer. */
function checkValueTypes(holder: Record<string, unknown>): {
  valueTypes?: CanonicalValueTypes; valueSchema?: NormalizedSchema;
} {
  if (!Object.hasOwn(holder, 'valueTypes')) return {};
  try {
    // Names come only from actual same-load declarations. The ordinary model
    // checker below still owns their complete descriptors and relationships.
    const declarations = holder['models'] ?? [];
    if (!Array.isArray(declarations)) fail('malformed_descriptor', 'Same-load models require an actual declaration array.');
    const modelNames: string[] = [];
    for (let index = 0; index < declarations.length; index += 1) {
      const member = Object.getOwnPropertyDescriptor(declarations, String(index));
      if (member === undefined || !('value' in member) || !isRecord(member.value)) fail('malformed_descriptor', 'Same-load model declarations require own data.');
      const name = Object.getOwnPropertyDescriptor(member.value, 'name');
      if (name === undefined || !('value' in name) || typeof name.value !== 'string') fail('malformed_descriptor', 'Same-load model identities require own data.');
      modelNames.push(name.value);
    }
    return normalizeValueTypes(holder['valueTypes'], modelNames);
  }
  catch (error) {
    const reason = error instanceof ValueTypesError
      ? error.code === 'duplicate' ? 'duplicate_name' : error.code === 'dangling' ? 'dangling_reference' : 'malformed_descriptor'
      : 'malformed_descriptor';
    fail(reason, `Invalid valueTypes inventory: ${String(error)}`);
  }
}

function checkedNominal(type: unknown, schema?: NormalizedSchema): boolean {
  if (typeof type !== 'string' || schema === undefined) return false;
  try {
    const parsed = parseTypeId(type);
    return printTypeId(parsed) === type && parsed.base.kind === 'nominal' &&
      (Object.hasOwn(schema.contracts, parsed.base.path) || Object.hasOwn(schema.enums, parsed.base.path) ||
        schema.aliases !== undefined && Object.hasOwn(schema.aliases, parsed.base.path));
  } catch { return false; }
}

function checkNominalValueType(holder: Record<string, unknown>, what: string, schema?: NormalizedSchema): CanTypeId {
  const type = Object.hasOwn(holder, 'valueType') ? holder['valueType'] : undefined;
  if (!checkedNominal(type, schema)) fail('dangling_reference', `Invalid ${what}: nominal valueType must resolve in checked valueTypes.`);
  if (Object.hasOwn(holder, 'nullable') && (typeof holder['nullable'] !== 'boolean' || (type as string).endsWith('?') !== holder['nullable'])) {
    fail('malformed_descriptor', `Invalid ${what}: valueType disagrees with nullable marker.`);
  }
  return type as CanTypeId;
}

/** Every explicit array type retains the exact owning required marker. */
function checkNominalArray(type: CanTypeId | undefined, marker: { readonly required: boolean } | undefined, what: string, schema?: NormalizedSchema): void {
  checkTypeArray(type, marker !== undefined, what);
  if (type !== undefined && parseTypeId(type).requiredArray !== (marker?.required === true)) {
    fail('malformed_descriptor', `Invalid ${what}: valueType disagrees with array.required marker.`);
  }
}

/** Additive claims are own-only; nullable suffix applies to the container. */
function checkResult(
  holder: Record<string, unknown>,
  what: string,
  kind: string,
  modelNames: ReadonlySet<string>,
  valueSchema?: NormalizedSchema,
): CanonicalOperationDescriptor['result'] {
  if (!Object.hasOwn(holder, 'result')) return undefined;
  const resultMember = Object.getOwnPropertyDescriptor(holder, 'result');
  if (resultMember === undefined || !('value' in resultMember)) fail('malformed_descriptor', `Invalid ${what}: result requires own data.`);
  const result = resultMember.value;
  if (!isRecord(result) || !Object.hasOwn(result, 'type')) {
    fail('malformed_descriptor', `Invalid ${what}: result must declare an int/datetime/text/bool/decimal/money/date/duration/currency/user/file profile, canonical inline enum profile or bare void.`);
  }
  const typeMember = Object.getOwnPropertyDescriptor(result, 'type');
  if (typeMember === undefined || !('value' in typeMember)) fail('malformed_descriptor', `Invalid ${what}: result type requires own data.`);
  const type = typeMember.value;
  const scalarOrVoid = type === 'void' || (typeof type === 'string' &&
    /^(int|datetime|text|bool|decimal|money|date|duration|currency|user|file)(\[\])?\??$/.test(type));
  let inlineEnumResult = false;
  let knownModelResult = false;
  // Reads may return an absent singular model or an ordinary model array.
  // Mutation results retain their required singular identity.
  if (!scalarOrVoid && typeof type === 'string') {
    try {
      const parsed = parseTypeId(type);
      inlineEnumResult = parsed.base.kind === 'enum' && !parsed.requiredArray && printTypeId(parsed) === type;
      knownModelResult = (kind === 'scenario' || kind === 'read') && parsed.base.kind === 'nominal' && parsed.base.path.includes('.') &&
        modelNames.has(parsed.base.path) && printTypeId(parsed) === type &&
        (!parsed.nullable || kind === 'read' && !parsed.array) && !parsed.requiredArray &&
        (!parsed.array || kind === 'read');
    } catch {
      // The shared artifact error below covers malformed canonical spellings.
    }
  }
  if (!scalarOrVoid && !inlineEnumResult && !knownModelResult && !checkedNominal(type, valueSchema)) {
    fail('malformed_descriptor', `Invalid ${what}: result must declare an int/datetime/text/bool/decimal/money/date/duration/currency/user/file profile, canonical inline enum profile or bare void; scenarios and reads may also declare a known qualified model, and reads a model[].`);
  }
  if ('disclosure' in result && !Object.hasOwn(result, 'disclosure')) {
    fail('malformed_descriptor', `Invalid ${what}: scenario disclosure requires own data.`);
  }
  const claim = Object.getOwnPropertyDescriptor(result, 'disclosure');
  if (claim !== undefined) {
    if (!('value' in claim) || !['scenario', 'read'].includes(kind) || Object.keys(result).some(key => !['type', 'disclosure'].includes(key))) {
      fail('malformed_descriptor', `Invalid ${what}: scenario disclosure requires closed source data.`);
    }
    try {
      const copies = checkScenarioResultDisclosurePlanSet(claim.value);
      // Singles keep today's exact plan value; partitioned owners install the
      // ordered copy-plan array. The cast carries the transported shape past
      // the single-plan contracts type; every custody boundary revalidates.
      const disclosure = (copies.length === 1 ? copies[0]! : copies) as unknown as ScenarioResultDisclosurePlan;
      return Object.freeze({ type: type as CanTypeId, disclosure });
    }
    catch (error) { fail('malformed_descriptor', error instanceof Error ? error.message : 'Invalid scenario dependency plan.'); }
  }
  return Object.freeze({ type: type as CanTypeId });
}

function checkValueType(field: Record<string, unknown>, what: string, valueSchema?: NormalizedSchema): CanTypeId | undefined {
  if (!Object.hasOwn(field, 'valueType')) return undefined;
  const type = field['valueType'];
  if (checkedNominal(type, valueSchema)) return checkNominalValueType(field, what, valueSchema);
  if (typeof type === 'string' && type.startsWith('enum(')) {
    let parsed: ReturnType<typeof parseTypeId>;
    try { parsed = parseTypeId(type); }
    catch { fail('malformed_descriptor', `Invalid ${what}: valueType must declare a canonical inline enum profile.`); }
    return checkEnumValueType(field, parsed.base.kind === 'enum' ? parsed.base.cases : undefined, what, valueSchema);
  }
  if (typeof type !== 'string' || !/^(int|datetime|text|bool|decimal|money|date|duration|currency|email|timezone|url|user|file)(?:\[\](?:!|\?)?|\?)?$/.test(type)) {
    fail('malformed_descriptor', `Invalid ${what}: valueType must declare an int/datetime/text/bool/decimal/money/date/duration/currency/email/timezone/url/user/file profile.`);
  }
  try { if (printTypeId(parseTypeId(type)) !== type) throw new Error('noncanonical type'); }
  catch { fail('malformed_descriptor', `Invalid ${what}: valueType must use canonical Values array syntax.`); }
  if (Object.hasOwn(field, 'nullable') &&
      (typeof field['nullable'] !== 'boolean' || type.endsWith('?') !== field['nullable'])) {
    fail('malformed_descriptor', `Invalid ${what}: valueType disagrees with nullable marker.`);
  }
  return type;
}

/** Explicit enum claims belong to the ordered declaration; absent claims stay legacy. */
function checkEnumValueType(
  holder: Record<string, unknown>, values: unknown, what: string, valueSchema?: NormalizedSchema,
): CanTypeId | undefined {
  if (!Object.hasOwn(holder, 'valueType')) return undefined;
  const type = holder['valueType'];
  let valid = false;
  if (typeof type === 'string' && Array.isArray(values)) {
    try {
      const parsed = parseTypeId(type);
      const cases = parsed.base.kind === 'enum' ? parsed.base.cases :
        parsed.base.kind === 'nominal' && valueSchema !== undefined && Object.hasOwn(valueSchema.enums, parsed.base.path)
          ? valueSchema.enums[parsed.base.path]!.cases : undefined;
      valid = cases !== undefined && (parsed.base.kind === 'nominal' || !parsed.requiredArray) &&
        printTypeId(parsed) === type && cases.length === values.length &&
        cases.every((entry, index) => entry === values[index]) &&
        (!Object.hasOwn(holder, 'nullable') ||
          typeof holder['nullable'] === 'boolean' && parsed.nullable === holder['nullable']);
    } catch {
      // Whole-set rejection below owns malformed and contradictory claims.
    }
  }
  if (!valid) {
    fail('malformed_descriptor', `Invalid ${what}: valueType must declare a canonical inline enum matching its ordered cases and nullable marker.`);
  }
  return type as CanTypeId;
}

function checkTypeArray(type: CanTypeId | undefined, array: boolean, what: string): void {
  if (type !== undefined && type.includes('[]') !== array) {
    fail('malformed_descriptor', `Invalid ${what}: valueType disagrees with array marker.`);
  }
}

/** Stored model refs resolve only in this load, with source-exact container markers. */
function checkStoredModelValueType(field: Record<string, unknown>, what: string, modelNames: ReadonlySet<string>,
  valueSchema?: NormalizedSchema, target?: string): CanTypeId {
  const arrayMember = Object.getOwnPropertyDescriptor(field, 'array');
  if (arrayMember === undefined && 'array' in field || arrayMember !== undefined && !('value' in arrayMember)) {
    fail('malformed_descriptor', `Invalid ${what}: stored reference array must be own data.`);
  }
  let requiredArray = false;
  if (arrayMember !== undefined) {
    const marker = arrayMember.value;
    if (!isRecord(marker) || ![Object.prototype, null].includes(Object.getPrototypeOf(marker)) || Reflect.ownKeys(marker).length !== 1) {
      fail('malformed_descriptor', `Invalid ${what}: stored reference array requires a closed boolean marker.`);
    }
    const required = Object.getOwnPropertyDescriptor(marker, 'required');
    if (required === undefined || !('value' in required) || !required.enumerable || typeof required.value !== 'boolean') {
      fail('malformed_descriptor', `Invalid ${what}: stored reference array requires an own boolean required marker.`);
    }
    requiredArray = required.value;
  }
  const nullableMember = Object.getOwnPropertyDescriptor(field, 'nullable');
  if (nullableMember === undefined && 'nullable' in field || nullableMember !== undefined &&
      (!('value' in nullableMember) || typeof nullableMember.value !== 'boolean')) {
    fail('malformed_descriptor', `Invalid ${what}: stored reference nullable must be an own boolean.`);
  }
  const nullable = nullableMember?.value === true;
  const claimed = Object.getOwnPropertyDescriptor(field, 'valueType');
  if (claimed === undefined && 'valueType' in field || claimed !== undefined && !('value' in claimed)) {
    fail('malformed_descriptor', `Invalid ${what}: stored reference valueType must be own data.`);
  }
  const type: unknown = claimed === undefined && target !== undefined
    ? `${target}${arrayMember === undefined ? '' : requiredArray ? '[]!' : '[]'}${nullable ? '?' : ''}` : claimed?.value;
  let parsed: ReturnType<typeof parseTypeId>;
  try {
    if (typeof type !== 'string') throw new Error();
    parsed = parseTypeId(type);
    if (parsed.base.kind !== 'nominal' || printTypeId(parsed) !== type ||
        parsed.array !== (arrayMember !== undefined) || parsed.requiredArray !== requiredArray || parsed.nullable !== nullable ||
        target !== undefined && parsed.base.path !== target) throw new Error();
  } catch { fail('malformed_descriptor', `Invalid ${what}: stored model valueType must exactly match its ref target and array/nullable markers.`); }
  if (parsed.base.kind !== 'nominal' || !modelNames.has(parsed.base.path) || checkedNominal(type, valueSchema)) {
    fail('dangling_reference', `Invalid ${what}: stored reference target requires one same-load model and no value declaration overlap.`);
  }
  return type as CanTypeId;
}

/** Exact scalar names at the canonical boundary; never inferred from JS carriers. */
function scalarTypeForKind(kind: unknown): string | undefined {
  switch (kind) {
    case 'integer': return 'int';
    case 'datetime': return 'datetime';
    case 'boolean': return 'bool';
    case 'decimal': return 'decimal';
    case 'money': return 'money';
    case 'date': return 'date';
    case 'duration': return 'duration';
    case 'user': return 'user';
    case 'file': return 'file';
    case 'string': return 'text';
    default: return undefined;
  }
}

/** Collapsed string tags require own claims; operation inputs also collapse checked date source. */
function artifactValueType(field: Record<string, unknown>, what: string, operationInput = false, valueSchema?: NormalizedSchema,
  modelNames?: ReadonlySet<string>): CanTypeId | undefined {
  const storedTag = Object.getOwnPropertyDescriptor(field, 'field');
  if (!operationInput && storedTag !== undefined && 'value' in storedTag && isRecord(storedTag.value)) {
    const tag = Object.getOwnPropertyDescriptors(storedTag.value);
    if (tag['kind'] !== undefined && 'value' in tag['kind'] && tag['kind'].value === 'ref') {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(storedTag.value)) || Reflect.ownKeys(storedTag.value).length !== 2 ||
          tag['model'] === undefined || !('value' in tag['model']) || typeof tag['model'].value !== 'string' ||
          !tag['kind'].enumerable || !tag['model'].enumerable || modelNames === undefined) {
        fail('malformed_descriptor', `Invalid ${what}: stored ref tag requires closed own kind/model data and same-load models.`);
      }
      return checkStoredModelValueType(field, what, modelNames, valueSchema, tag['model'].value);
    }
  }
  const nominalTag = storedTag !== undefined && 'value' in storedTag ? storedTag.value : undefined;
  if (Object.hasOwn(field, 'field') && isRecord(nominalTag) && Object.hasOwn(nominalTag, 'kind') && nominalTag['kind'] === 'nominal') {
    if (!Object.hasOwn(nominalTag, 'name') || !checkedNominal(nominalTag['name'], valueSchema)) {
      fail('dangling_reference', `Invalid ${what}: own nominal tag name must resolve in checked valueTypes.`);
    }
    const parsedTag = parseTypeId(nominalTag['name'] as string);
    if (parsedTag.array || parsedTag.nullable) fail('malformed_descriptor', `Invalid ${what}: nominal tag name must be bare.`);
    const marker = field['array'];
    if (marker !== undefined && (!isRecord(marker) || typeof marker['required'] !== 'boolean')) fail('malformed_descriptor', `Invalid ${what}: array markers carry a boolean required.`);
    const expected = `${nominalTag['name']}${marker !== undefined ? (isRecord(marker) && marker['required'] === true ? '[]!' : '[]') : ''}${field['nullable'] === true ? '?' : ''}`;
    const type = checkNominalValueType(Object.hasOwn(field, 'valueType') ? field : { ...field, valueType: expected }, what, valueSchema);
    if (type !== expected) fail('malformed_descriptor', `Invalid ${what}: valueType disagrees with nominal compiler tag.`);
    checkNominalArray(type, marker as { required: boolean } | undefined, what, valueSchema);
    return type;
  }
  if (Object.hasOwn(field, 'field') && isRecord(nominalTag) &&
      Object.hasOwn(nominalTag, 'kind') && nominalTag['kind'] === 'enum') {
    const values = nominalTag['values'];
    let association = field;
    if (!operationInput && !Object.hasOwn(field, 'valueType')) {
      if (!Array.isArray(values) || values.length === 0 ||
          values.some(entry => typeof entry !== 'string' || entry === '')) {
        fail('malformed_descriptor', `Invalid ${what}: enum fields require ordered non-empty cases.`);
      }
      const array = field['array'];
      association = { ...field,
        valueType: `enum(${values.join(',')})${array === undefined ? '' : isRecord(array) && array['required'] === true ? '[]!' : '[]'}${field['nullable'] === true ? '?' : ''}` };
    }
    const type = checkEnumValueType(association, values, what, valueSchema);
    if (!operationInput && type !== undefined && parseTypeId(type).nullable !== (field['nullable'] === true)) {
      fail('malformed_descriptor', `Invalid ${what}: valueType disagrees with enum compiler nullable marker.`);
    }
    const marker = field['array'];
    if (checkedNominal(type, valueSchema) && marker !== undefined && (!isRecord(marker) || typeof marker['required'] !== 'boolean')) fail('malformed_descriptor', `Invalid ${what}: array markers carry a boolean required.`);
    checkNominalArray(type, marker as { required: boolean } | undefined, what, valueSchema);
    return type;
  }
  if (Object.hasOwn(field, 'valueType')) {
    checkTypeArray(checkValueType(field, what, valueSchema), field['array'] !== undefined, what);
  }
  const tag = nominalTag;
  if (!Object.hasOwn(field, 'field') || !isRecord(tag) || !Object.hasOwn(tag, 'kind') ||
      scalarTypeForKind(tag['kind']) === undefined) {
    if (Object.hasOwn(field, 'valueType')) {
      fail('malformed_descriptor', `Invalid ${what}: valueType requires an own supported compiler tag.`);
    }
    return undefined;
  }
  if (tag['kind'] === 'string' && !Object.hasOwn(field, 'valueType')) return undefined;
  if (Object.hasOwn(field, 'nullable') && typeof field['nullable'] !== 'boolean') {
    fail('malformed_descriptor', `Invalid ${what}: nullable must be a boolean.`);
  }
  const claimedBase = typeof field['valueType'] === 'string' ? field['valueType'].replace(/\[\]|\?|!/g, '') : undefined;
  const base = tag['kind'] === 'string' && (claimedBase === 'email' || claimedBase === 'timezone' || claimedBase === 'url' || claimedBase === 'currency' ||
    operationInput && claimedBase === 'date') ? claimedBase : scalarTypeForKind(tag['kind']);
  const marker = field['array'];
  const type = `${base}${marker !== undefined ? isRecord(marker) && marker['required'] === true ? '[]!' : '[]' : ''}${Object.hasOwn(field, 'nullable') && field['nullable'] === true ? '?' : ''}`;
  if (Object.hasOwn(field, 'valueType') && field['valueType'] !== type) {
    fail('malformed_descriptor', `Invalid ${what}: valueType disagrees with compiler tag.`);
  }
  return type;
}

function checkSources(artifact: Record<string, unknown>): ReadonlyArray<Readonly<ArtifactSource>> | undefined {
  if (!Object.hasOwn(artifact, 'sources')) return undefined;
  const sources = artifact['sources'];
  if (!Array.isArray(sources)) {
    fail('malformed_descriptor', 'Invalid artifact sources: sources must be an array.');
  }
  return Object.freeze(Array.from(sources, (source: unknown) => {
    if (!isRecord(source) || !Object.hasOwn(source, 'path') || !Object.hasOwn(source, 'sha256')) {
      fail('malformed_descriptor', 'Invalid artifact source: own nonempty path and lowercase SHA-256 are required.');
    }
    const path = source['path'];
    const sha256 = source['sha256'];
    if (typeof path !== 'string' || path === '' || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      fail('malformed_descriptor', 'Invalid artifact source: own nonempty path and lowercase SHA-256 are required.');
    }
    return Object.freeze({ path, sha256 });
  }));
}

/** A policy claim must name actual emitted production paths, never logical modules.
 * Inspect own data without executing module/path/array accessors. */
function artifactPolicyModulePaths(artifact: Record<string, unknown>): readonly string[] {
  const inventory = Object.getOwnPropertyDescriptor(artifact, 'modules');
  if (inventory === undefined || !('value' in inventory) || !Array.isArray(inventory.value)
    || Object.getPrototypeOf(inventory.value) !== Array.prototype) fail('malformed_descriptor', 'Model policies require an own emitted module inventory.');
  const modules = inventory.value as unknown[];
  if (Reflect.ownKeys(modules).some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= modules.length))) fail('malformed_descriptor', 'Invalid emitted module inventory member.');
  const paths: string[] = [];
  for (let i = 0; i < modules.length; i++) {
    const entry = Object.getOwnPropertyDescriptor(modules, String(i));
    if (entry === undefined || !('value' in entry) || !isRecord(entry.value)
      || (Object.getPrototypeOf(entry.value) !== Object.prototype && Object.getPrototypeOf(entry.value) !== null)) fail('malformed_descriptor', 'Invalid emitted module inventory element.');
    const module = Object.getOwnPropertyDescriptors(entry.value);
    if (Reflect.ownKeys(module).some(key => typeof key !== 'string' || !['path', 'js', 'map'].includes(key)
      || !('value' in module[key]!))) fail('malformed_descriptor', 'Invalid emitted module member or accessor.');
    const path = module['path'];
    if (path === undefined || !('value' in path) || typeof path.value !== 'string' || path.value === ''
      || module['js'] === undefined || typeof module['js'].value !== 'string'
      || module['map'] === undefined || !isRecord(module['map'].value)) fail('malformed_descriptor', 'Invalid emitted module inventory.');
    paths.push(path.value);
  }
  return paths;
}

/** Load-time dot-path check: non-empty with no empty segments. */
function checkLoadDotPath(path: string, what: string): void {
  if (path === '' || path.split('.').some((segment) => segment === '')) {
    fail('malformed_descriptor', `Invalid ${what} dot path: ${JSON.stringify(path)}.`);
  }
}

/** Deep-freeze loaded descriptors so post-load mutation cannot alter enforcement. */
function deepFreezeLoaded<T>(value: T, seen: Set<unknown> = new Set()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreezeLoaded(entry, seen);
    }
  } else {
    for (const entry of Object.values(value)) {
      deepFreezeLoaded(entry, seen);
    }
  }
  return Object.freeze(value);
}

/**
 * Validate one source-declared default (`CanonicalFieldDefault` spelling,
 * shared with `ArtifactFieldDefault`). Unknown kinds reject; literal values
 * must be serializable data; parent paths must be well-formed dot paths.
 * Extra members are ignored (additive tolerance — only kinds reject).
 */
function checkDefault(value: unknown, what: string): CanonicalFieldDefault | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value['kind'] !== 'string') {
    fail('malformed_descriptor', `Invalid default for ${what}: a default object needs a kind.`);
  }
  const kind = value['kind'] as string;
  if (!KNOWN_DEFAULT_KINDS.has(kind)) {
    fail(
      'unknown_default_kind',
      `Unknown default kind ${JSON.stringify(kind)} for ${what}; ` +
        'supported: literal, parent, context, server, derived.',
    );
  }
  if (kind === 'literal') {
    try {
      structuredClone(value['value']);
    } catch {
      fail(
        'malformed_descriptor',
        `Invalid literal default for ${what}: values must be serializable data.`,
      );
    }
    return { kind: 'literal', value: structuredClone(value['value']) };
  }
  if (kind === 'parent') {
    if (typeof value['path'] !== 'string') {
      fail(
        'malformed_descriptor',
        `Invalid parent default for ${what}: path must be a dot-path string.`,
      );
    }
    checkLoadDotPath(value['path'] as string, `parent default for ${what}`);
    return { kind: 'parent', path: value['path'] as string };
  }
  if (kind === 'context') {
    const members = Object.getOwnPropertyDescriptors(value);
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== 2 ||
        !['kind', 'value'].every(key => members[key] !== undefined && 'value' in members[key]! && members[key]!.enumerable) ||
        members['value']!.value !== 'actor') fail('malformed_descriptor', `Invalid context default for ${what}: exact actor recipe required.`);
    return { kind: 'context', value: 'actor' };
  }
  if (kind === 'server') return { kind: 'server' };
  return { kind: 'derived' };
}

/** Ordinary context defaults retain caller overrides and exact User typing. */
function checkContextDefault(fallback: CanonicalFieldDefault | undefined, type: CanTypeId | undefined,
  required: unknown, serverOnly: unknown, array: unknown, what: string): void {
  if (fallback?.kind === 'context' && (type !== 'user' && type !== 'user?' || required !== false ||
      serverOnly !== false || array !== undefined)) {
    fail('malformed_descriptor', `Invalid context default for ${what}: ordinary singular User field required.`);
  }
}

/** A computed default is an own omission claim, never a wire default value. */
function checkComputedDefault(
  input: Record<string, unknown>, operationKind: unknown, inputKind: unknown,
  valueType: CanTypeId | undefined, required: boolean, what: string,
): true | undefined {
  if (!Object.hasOwn(input, 'computedDefault')) return undefined;
  if (input['computedDefault'] !== true || (operationKind !== 'scenario' && operationKind !== 'read') || required ||
      (inputKind !== 'nominal' && inputKind !== 'enum' && inputKind !== 'ref' && (scalarTypeForKind(inputKind) === undefined || valueType === undefined)) ||
      ((inputKind === 'ref' || (inputKind === 'enum' && valueType === undefined)) && (Object.hasOwn(input, 'array') || input['array'] !== undefined ||
        (Object.hasOwn(input, 'nullable') && input['nullable'] !== false) || valueType?.endsWith('?'))) ||
      Object.hasOwn(input, 'default') || input['default'] !== undefined) {
    fail('malformed_descriptor', `Invalid ${what}: computedDefault requires true on an optional checked scalar/enum or singular nonnullable legacy enum/ref scenario or read input without a wire default.`);
  }
  return true;
}

/** Outer length metadata is exact own data; element admission remains separate. */
function checkInputArrayBounds(value: Record<string, unknown>, what: string, array?: boolean): { min?: number; max?: number } {
  const bounds: { min?: number; max?: number } = {};
  for (const key of ['min', 'max'] as const) {
    const member = Object.getOwnPropertyDescriptor(value, key);
    if (member === undefined) {
      if (key in value) fail('malformed_descriptor', `Invalid ${what}: ${key} must be own data.`);
      continue;
    }
    if (!Object.hasOwn(member, 'value') || typeof member.value !== 'number' ||
        !Number.isSafeInteger(member.value) || member.value < 0) {
      fail('malformed_descriptor', `Invalid ${what}: ${key} must be a nonnegative safe integer.`);
    }
    bounds[key] = member.value as number;
  }
  if (bounds.min !== undefined && bounds.max !== undefined && bounds.min > bounds.max) {
    fail('malformed_descriptor', `Invalid ${what}: min exceeds max.`);
  }
  if (array === false && (bounds.min !== undefined || bounds.max !== undefined)) {
    fail('malformed_descriptor', `Invalid ${what}: length bounds require an array.`);
  }
  return bounds;
}

function checkInputArrayMarker(value: unknown, what: string): { readonly required: boolean } {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('malformed_descriptor', `Invalid ${what}: array marker must be plain own data.`);
  const member = Object.getOwnPropertyDescriptor(value, 'required');
  if (Reflect.ownKeys(value).length !== 1 || member === undefined || !Object.hasOwn(member, 'value') || typeof member.value !== 'boolean') {
    fail('malformed_descriptor', `Invalid ${what}: array marker requires an own boolean required.`);
  }
  return { required: member.value as boolean };
}

/** Snapshot engine hints without evaluating caller channels, entries or markers. */
function checkedInputArrayHints(opts: LoadDescriptorSetOptions): Record<string, Record<string, { readonly required: boolean }>> | undefined {
  const channel = Object.getOwnPropertyDescriptor(opts, 'inputArrays');
  if (channel === undefined) {
    if ('inputArrays' in opts) fail('malformed_descriptor', 'inputArrays must be own data.');
    return undefined;
  }
  if (!Object.hasOwn(channel, 'value')) fail('malformed_descriptor', 'inputArrays must be own data.');
  if (channel.value === undefined) return undefined;
  const copy: Record<string, Record<string, { readonly required: boolean }>> = Object.create(null) as Record<string, Record<string, { readonly required: boolean }>>;
  const recordEntries = (value: unknown, what: string): PropertyDescriptorMap => {
    if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      fail('malformed_descriptor', `Invalid ${what}: expected an own-data metadata object.`);
    }
    const entries = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(entries)) {
      if (typeof key !== 'string' || !Object.hasOwn(entries[key]!, 'value')) fail('malformed_descriptor', `Invalid ${what}: entries must be own data.`);
    }
    return entries;
  };
  const operations = recordEntries(channel.value, 'inputArrays');
  for (const opName of Object.keys(operations)) {
    const entries = recordEntries(operations[opName]!.value, `input array markers for ${JSON.stringify(opName)}`);
    const markers: Record<string, { readonly required: boolean }> = Object.create(null) as Record<string, { readonly required: boolean }>;
    for (const name of Object.keys(entries)) markers[name] = checkInputArrayMarker(entries[name]!.value, `input array marker ${JSON.stringify(name)}`);
    copy[opName] = markers;
  }
  return copy;
}

/** Validate one canonical operation input; `modelNames` resolves ref targets. */
function checkCanonicalInput(
  value: unknown,
  opName: string,
  modelNames: ReadonlySet<string>,
  operationKind: unknown,
  valueSchema?: NormalizedSchema,
  valueTypes?: CanonicalValueTypes,
): CanonicalInputDef {
  if (!isRecord(value) || typeof value['name'] !== 'string' || value['name'] === '') {
    fail(
      'malformed_descriptor',
      `Invalid input on operation ${JSON.stringify(opName)}: inputs need non-empty names.`,
    );
  }
  const name = value['name'] as string;
  const what = `input ${JSON.stringify(name)} on operation ${JSON.stringify(opName)}`;
  const kind = value['kind'];
  if (typeof kind !== 'string' || !KNOWN_INPUT_KINDS.has(kind)) {
    fail(
      'unknown_input_kind',
      `Unknown input kind ${JSON.stringify(kind)} for ${what}; ` +
        'supported: ref, string, integer, decimal, money, datetime, duration, user, boolean, file, enum, nominal, delivery.',
    );
  }
  if (typeof value['required'] !== 'boolean') {
    fail('malformed_descriptor', `Invalid ${what}: required must be a boolean.`);
  }
  const required = value['required'] as boolean;
  const bounds = checkInputArrayBounds(value, what);
  let refArray: { readonly required: boolean } | undefined;
  let refNullable: boolean | undefined;
  if (kind === 'ref') {
    const arrayMember = Object.getOwnPropertyDescriptor(value, 'array');
    if (arrayMember === undefined && 'array' in value || arrayMember !== undefined && !Object.hasOwn(arrayMember, 'value')) {
      fail('malformed_descriptor', `Invalid ${what}: array must be own data.`);
    }
    refArray = arrayMember === undefined ? undefined : checkInputArrayMarker(arrayMember.value, what);
    const nullableMember = Object.getOwnPropertyDescriptor(value, 'nullable');
    if (nullableMember === undefined && 'nullable' in value || nullableMember !== undefined &&
        (!Object.hasOwn(nullableMember, 'value') || typeof nullableMember.value !== 'boolean')) {
      fail('malformed_descriptor', `Invalid ${what}: nullable must be an own boolean.`);
    }
    refNullable = nullableMember === undefined ? undefined : nullableMember.value as boolean;
  }
  const fallback = checkDefault(value['default'], what);
  const valueType = kind === 'enum'
    ? checkEnumValueType(value, value['enumValues'], what, valueSchema) :
      kind === 'nominal' ? checkNominalValueType(value, what, valueSchema) : checkValueType(value, what);
  if (fallback?.kind === 'context') {
    checkContextDefault(fallback, valueType, required, false, value['array'], what);
    if (kind !== 'user' || operationKind !== 'create') fail('malformed_descriptor', `Invalid ${what}: context defaults belong to model creation inputs.`);
  }
  const inputBase = valueType?.replace(/\[\]|\?|!/g, '');
  if (kind !== 'enum' && kind !== 'nominal' && valueType !== undefined && inputBase !== scalarTypeForKind(kind) &&
      !(kind === 'string' && (inputBase === 'date' || inputBase === 'email' || inputBase === 'timezone' || inputBase === 'url' || inputBase === 'currency'))) {
    fail('malformed_descriptor', `Invalid ${what}: valueType disagrees with input kind.`);
  }
  if (kind === 'nominal') {
    if (Object.hasOwn(value, 'enumValues')) fail('malformed_descriptor', `Invalid ${what}: enumValues is present exactly for enum.`);
    const computedDefault = checkComputedDefault(value, operationKind, kind, valueType, required, what);
    return { ...bounds, name, kind: 'nominal', valueType: valueType!, required,
      ...(computedDefault !== undefined ? { computedDefault } : {}),
      ...(fallback !== undefined ? { default: fallback } : {}),
      ...(Object.hasOwn(value, 'nullable') ? { nullable: value['nullable'] } : {}) };
  }
  const computedDefault = checkComputedDefault(value, operationKind, kind, valueType, required, what);
  if (kind === 'ref') {
    if (typeof value['model'] !== 'string' || value['model'] === '') {
      fail('malformed_descriptor', `Invalid ${what}: ref inputs name a non-empty model.`);
    }
    if (typeof value['versioned'] !== 'boolean') {
      fail('malformed_descriptor', `Invalid ${what}: versioned must be a boolean.`);
    }
    const model = value['model'] as string;
    if (!modelNames.has(model)) {
      fail(
        'dangling_reference',
        `Invalid ${what}: model ${JSON.stringify(model)} has no descriptor in this set.`,
      );
    }
    return {
      ...bounds,
      name,
      kind: 'ref',
      ...(refArray !== undefined ? { array: refArray } : {}),
      ...(refNullable !== undefined ? { nullable: refNullable } : {}),
      model: model as ModelName,
      versioned: value['versioned'] as boolean,
      required,
      ...(computedDefault !== undefined ? { computedDefault } : {}),
      ...(fallback !== undefined ? { default: fallback } : {}),
    };
  }
  if (kind === 'enum') {
    const values = value['enumValues'];
    if (
      !Array.isArray(values) ||
      values.some((entry) => typeof entry !== 'string' || entry === '')
    ) {
      fail(
        'malformed_descriptor',
        `Invalid ${what}: enum inputs carry enumValues as an array of non-empty strings.`,
      );
    }
    return {
      ...bounds,
      name,
      kind: 'enum',
      required,
      enumValues: [...(values as string[])],
      ...(valueType !== undefined ? { valueType } : {}),
      ...(computedDefault !== undefined ? { computedDefault } : {}),
      ...(fallback !== undefined ? { default: fallback } : {}),
    };
  }
  if (value['enumValues'] !== undefined) {
    fail('malformed_descriptor', `Invalid ${what}: enumValues is present exactly for enum.`);
  }
  if (kind === 'delivery') {
    // T04b §10.1 delivery-input join: the delivery descriptor carries the
    // fenced T13 binding (engine-resolved receipt, never caller-submitted).
    // The canonical delivery variant has no valueType/array/nullable/
    // computedDefault slots: valueType rides the descriptor leaves (a
    // present top-level valueType fails in checkValueType above when it
    // disagrees, mirroring the ref precedent of dropping non-variant
    // claims); array markers travel the engine opArrays channel like
    // scalars; an explicit computedDefault is contradictory and rejects.
    const deliveryMember = Object.getOwnPropertyDescriptor(value, 'delivery');
    if (deliveryMember === undefined && 'delivery' in value ||
        deliveryMember !== undefined && !Object.hasOwn(deliveryMember, 'value')) {
      fail('malformed_descriptor', `Invalid ${what}: delivery must be own data.`);
    }
    if (deliveryMember === undefined) {
      fail('malformed_descriptor', `Invalid ${what}: delivery inputs carry a delivery descriptor.`);
    }
    if (value['computedDefault'] === true) {
      fail('malformed_descriptor', `Invalid ${what}: delivery inputs are engine-resolved receipts, never computed defaults.`);
    }
    const delivery = checkInputDeliveryDescriptor(deliveryMember.value, what, valueTypes);
    return {
      ...bounds,
      name,
      kind: 'delivery',
      delivery,
      required,
      ...(fallback !== undefined ? { default: fallback } : {}),
    };
  }
  return {
    ...bounds,
    name,
    kind: kind as CanonicalScalarKind,
    ...(computedDefault !== undefined ? { computedDefault } : {}),
    ...(valueType !== undefined ? { valueType } : {}),
    required,
    ...(fallback !== undefined ? { default: fallback } : {}),
  };
}

/** Validate one canonical model descriptor; returns the model name. */
function checkFieldConstraints(field: Record<string, unknown>, type: CanTypeId | undefined, what: string, valueSchema?: NormalizedSchema): void {
  if (!['trim', 'min', 'max'].some(key => Object.hasOwn(field, key))) return;
  if (type === undefined) fail('malformed_descriptor', `Invalid ${what}: constraints require a checked valueType.`);
  for (const key of ['trim', 'min', 'max']) {
    if (Object.hasOwn(field, key) && (field[key] === undefined || field[key] === null)) {
      fail('malformed_descriptor', `Invalid ${what}: ${key} cannot be absent or null when claimed.`);
    }
  }
  try {
    modelFieldConstraintSchema({ valueType: type,
      ...(Object.hasOwn(field, 'trim') ? { trim: field['trim'] as boolean } : {}),
      ...(Object.hasOwn(field, 'min') ? { min: field['min'] as NonNullable<CanonicalModelDescriptor['fields'][string]['min']> } : {}),
      ...(Object.hasOwn(field, 'max') ? { max: field['max'] as NonNullable<CanonicalModelDescriptor['fields'][string]['max']> } : {}),
    }, valueSchema);
  } catch (error) { fail('malformed_descriptor', `Invalid ${what}: ${String(error)}`); }
}

/** Delivery claims are detached own JSON data, never executable metadata. */
function copyDeliveryData(value: unknown, what: string, active = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || active.has(value) ||
      (Array.isArray(value) ? Object.getPrototypeOf(value) !== Array.prototype :
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) {
    fail('malformed_descriptor', `Invalid ${what}: delivery metadata requires acyclic own JSON data.`);
  }
  const array = Array.isArray(value), entries = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(entries);
  if (keys.some(key => typeof key !== 'string' || !(array && key === 'length') &&
      (!Object.hasOwn(entries[key]!, 'value') || !entries[key]!.enumerable))) {
    fail('malformed_descriptor', `Invalid ${what}: delivery metadata requires enumerable own data.`);
  }
  active.add(value);
  try {
    if (array) {
      if (keys.length !== value.length + 1) fail('malformed_descriptor', `Invalid ${what}: delivery arrays must be dense own data.`);
      return Array.from({ length: value.length }, (_, index) => {
        const entry = entries[String(index)];
        if (entry === undefined || !Object.hasOwn(entry, 'value')) fail('malformed_descriptor', `Invalid ${what}: delivery arrays must be dense own data.`);
        return copyDeliveryData(entry.value, what, active);
      });
    }
    // Stable key order permits full-leaf comparison without changing producer array order.
    return Object.fromEntries(Object.keys(entries).sort().map(key => [key, copyDeliveryData(entries[key]!.value, what, active)]));
  } finally { active.delete(value); }
}

function checkModelNullable(field: Record<string, unknown>, what: string): boolean | undefined {
  const member = Object.getOwnPropertyDescriptor(field, 'nullable');
  if (member === undefined) {
    if ('nullable' in field) fail('malformed_descriptor', `Invalid ${what}: nullable must be an own boolean.`);
    return undefined;
  }
  if (!Object.hasOwn(member, 'value') || typeof member.value !== 'boolean') {
    fail('malformed_descriptor', `Invalid ${what}: nullable must be an own boolean.`);
  }
  return member.value as boolean;
}

/** Preserve the B3 envelope rules and every original result-leaf declaration. */
function checkModelDelivery(value: unknown, what: string, valueTypes?: CanonicalValueTypes):
  CanonicalDeliveryDescriptor | CanonicalJudgmentDeliveryDescriptor {
  const tag = copyDeliveryData(value, what);
  if (!isRecord(tag) || !Object.hasOwn(tag, 'kind') || tag['kind'] !== 'delivery') fail('malformed_descriptor', `Invalid ${what}: expected a delivery descriptor.`);
  if (!['capability', 'operation', 'version', 'result'].every(key => Object.hasOwn(tag, key))) {
    fail('malformed_descriptor', `Invalid ${what}: delivery identity/version must match its standard or source Judgment profile.`);
  }
  const capability = tag['capability'], operation = tag['operation'], version = tag['version'];
  const judgment = Object.hasOwn(tag, 'judgment');
  if (typeof capability !== 'string' || capability === '' || typeof operation !== 'string' || operation === '' ||
      (judgment ? tag['judgment'] !== true || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(capability) ||
        operation !== 'evaluate' || typeof version !== 'string' || version.length > 19 || !/^(0|[1-9][0-9]*)$/.test(version) || BigInt(version) > 9223372036854775807n
        : typeof version !== 'number' || !Number.isFinite(version))) {
    fail('malformed_descriptor', `Invalid ${what}: delivery identity/version must match its standard or source Judgment profile.`);
  }
  const result = tag['result'];
  if (!isRecord(result) || !Object.hasOwn(result, 'name') || !Object.hasOwn(result, 'fields') ||
      typeof result['name'] !== 'string' || !Array.isArray(result['fields'])) {
    fail('malformed_descriptor', `Invalid ${what}: delivery descriptors carry a result with a name and leaf fields.`);
  }
  if (result['fields'].some((leaf: unknown) => !isRecord(leaf) || !Object.hasOwn(leaf, 'name') || !Object.hasOwn(leaf, 'type') ||
      typeof leaf['name'] !== 'string' || typeof leaf['type'] !== 'string')) {
    fail('malformed_descriptor', `Invalid ${what}: delivery result leaves require own name/type data.`);
  }
  if (judgment) {
    if (result['name'] !== capability) fail('malformed_descriptor', `Invalid ${what}: Judgment result name must match its owning capability.`);
    const declared = valueTypes?.contracts.find(entry => entry.name === result['name']);
    if (declared === undefined) fail('dangling_reference', `Invalid ${what}: Judgment result has no checked nominal contract.`);
    if (JSON.stringify(result['fields']) !== JSON.stringify(copyDeliveryData(declared.fields, what))) {
      fail('malformed_descriptor', `Invalid ${what}: Judgment result leaves disagree with checked valueTypes.`);
    }
  }
  return tag as unknown as CanonicalDeliveryDescriptor | CanonicalJudgmentDeliveryDescriptor;
}

/**
 * T04b §10.1 delivery-input join: the six T13 capability contracts the
 * loader fences delivery operation inputs against. Built from the same
 * live contract objects the L6 derivation fences (identical source of
 * truth, never hardcoded versions): unknown capabilities/operations
 * reject, versions fence exact, result leaves must match the verbatim
 * declared set and types (leaf order is presentation, carried verbatim).
 */
const DELIVERY_CAPABILITY_TARGETS: ReadonlyMap<string, { version: number; results: ReadonlyMap<string, string> }> = (() => {
  const contracts = [
    STD_EMAIL_V1_CONTRACT,
    STD_ERRORS_V1_CONTRACT,
    STD_PAYMENTS_V1_CONTRACT,
    STD_TEXT_GENERATION_V1_CONTRACT,
    STD_IMAGES_V1_CONTRACT,
    STD_MAILBOX_V1_CONTRACT,
  ];
  const join = new Map<string, { version: number; results: Map<string, string> }>();
  for (const contract of contracts) {
    const results = new Map<string, string>();
    for (const op of contract.operations) results.set(op.name, op.result);
    join.set(contract.name, { version: contract.version, results });
  }
  return join;
})();

/**
 * Validate one delivery operation input descriptor: the structural
 * identity/version profile (shared with model field tags) plus the
 * T04b-p per-capability fence — the capability must be a T13 contract,
 * the operation one of its sendable operations, the version the exact
 * frozen contract number, and the result the declared nominal with its
 * full verbatim leaf set. Anything failing rejects the whole set; the
 * L3 reason vocabulary is unchanged (fence failures are
 * `version_mismatch`, content failures `malformed_descriptor` with the
 * precise member named, judgment-without-contract `dangling_reference`).
 */
function checkInputDeliveryDescriptor(value: unknown, what: string, valueTypes?: CanonicalValueTypes):
  CanonicalDeliveryDescriptor | CanonicalJudgmentDeliveryDescriptor {
  const tag = copyDeliveryData(value, what);
  if (!isRecord(tag) || !Object.hasOwn(tag, 'kind') || tag['kind'] !== 'delivery') fail('malformed_descriptor', `Invalid ${what}: expected a delivery descriptor.`);
  if (!['capability', 'operation', 'version', 'result'].every(key => Object.hasOwn(tag, key))) {
    fail('malformed_descriptor', `Invalid ${what}: delivery identity/version must match its standard or source Judgment profile.`);
  }
  const capability = tag['capability'], operation = tag['operation'], version = tag['version'];
  const judgment = Object.hasOwn(tag, 'judgment');
  if (typeof capability !== 'string' || capability === '' || typeof operation !== 'string' || operation === '' ||
      (judgment ? tag['judgment'] !== true || !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(capability) ||
        operation !== 'evaluate' || typeof version !== 'string' || version.length > 19 || !/^(0|[1-9][0-9]*)$/.test(version) || BigInt(version) > 9223372036854775807n
        : typeof version !== 'number' || !Number.isFinite(version))) {
    fail('malformed_descriptor', `Invalid ${what}: delivery identity/version must match its standard or source Judgment profile.`);
  }
  const result = tag['result'];
  if (!isRecord(result) || !Object.hasOwn(result, 'name') || !Object.hasOwn(result, 'fields') ||
      typeof result['name'] !== 'string' || !Array.isArray(result['fields'])) {
    fail('malformed_descriptor', `Invalid ${what}: delivery descriptors carry a result with a name and leaf fields.`);
  }
  if (result['fields'].some((leaf: unknown) => !isRecord(leaf) || !Object.hasOwn(leaf, 'name') || !Object.hasOwn(leaf, 'type') ||
      typeof leaf['name'] !== 'string' || typeof leaf['type'] !== 'string')) {
    fail('malformed_descriptor', `Invalid ${what}: delivery result leaves require own name/type data.`);
  }
  if (judgment) {
    if (result['name'] !== capability) fail('malformed_descriptor', `Invalid ${what}: Judgment result name must match its owning capability.`);
    const declared = valueTypes?.contracts.find(entry => entry.name === result['name']);
    if (declared === undefined) fail('dangling_reference', `Invalid ${what}: Judgment result has no checked nominal contract.`);
    if (JSON.stringify(result['fields']) !== JSON.stringify(copyDeliveryData(declared.fields, what))) {
      fail('malformed_descriptor', `Invalid ${what}: Judgment result leaves disagree with checked valueTypes.`);
    }
    return tag as unknown as CanonicalJudgmentDeliveryDescriptor;
  }
  const target = DELIVERY_CAPABILITY_TARGETS.get(capability as string);
  if (target === undefined) {
    fail(
      'malformed_descriptor',
      `Unknown capability ${JSON.stringify(capability)} for ${what}: ` +
        'bound receipts bind the six T13 capability contracts (std.EmailV1, std.ErrorsV1, ' +
        'std.PaymentsV1, std.TextGenerationV1, std.ImagesV1, std.MailboxV1); bound-local ' +
        'deliveries have no T13 identity and never take the delivery shape.',
    );
  }
  const declaredResult = target.results.get(operation as string);
  if (declaredResult === undefined) {
    fail(
      'malformed_descriptor',
      `Invalid ${what}: ${JSON.stringify(capability)} has no sendable operation ${JSON.stringify(operation)}.`,
    );
  }
  if (!Number.isInteger(version)) {
    fail(
      'malformed_descriptor',
      `Invalid ${what}: delivery version is the frozen capability contract number (got ${JSON.stringify(version) ?? 'undefined'}).`,
    );
  }
  if (version !== target.version) {
    fail(
      'version_mismatch',
      `Incompatible ${what}: delivery version ${JSON.stringify(version)} does not match ` +
        `the frozen ${capability} contract version ${target.version}.`,
    );
  }
  const nominal = result['name'] as string;
  if (nominal !== declaredResult) {
    fail(
      'malformed_descriptor',
      `Invalid ${what}: result ${JSON.stringify(nominal)} is not declared for ${capability}.${operation} ` +
        `(declared: ${JSON.stringify(declaredResult)}).`,
    );
  }
  const declared = deliveryResultLeaves(nominal);
  if (declared === null) {
    // Unreachable while the T13 contracts and the leaf table agree:
    // every declared result nominal transcribes its leaves. Fail loud
    // if that join ever drifts.
    fail(
      'malformed_descriptor',
      `Invalid ${what}: result ${JSON.stringify(nominal)} declares no leaves.`,
    );
  }
  const seen = new Set<string>();
  for (const entry of result['fields'] as unknown[]) {
    const leaf = entry as { name: unknown; type: unknown };
    if (seen.has(leaf['name'] as string)) {
      fail('duplicate_name', `Duplicate delivery leaf ${JSON.stringify(leaf['name'])} for ${what}.`);
    }
    seen.add(leaf['name'] as string);
    const declaredLeaf = declared.find((candidate) => candidate.name === leaf['name']);
    if (declaredLeaf === undefined || declaredLeaf.type !== leaf['type']) {
      fail(
        'malformed_descriptor',
        declaredLeaf === undefined
          ? `Invalid ${what}: leaf ${JSON.stringify(leaf['name'])} is not declared on ${JSON.stringify(nominal)}.`
          : `Invalid ${what}: leaf ${JSON.stringify(leaf['name'])} declares type ${JSON.stringify(leaf['type'])} ` +
            `(declared: ${JSON.stringify(declaredLeaf.type)}).`,
      );
    }
  }
  if (seen.size !== declared.length) {
    const missing = declared.filter((leaf) => !seen.has(leaf.name)).map((leaf) => leaf.name);
    fail(
      'malformed_descriptor',
      `Invalid ${what}: result ${JSON.stringify(nominal)} declares ${declared.length} leaves; ` +
        `the descriptor carries ${seen.size} (missing: ${missing.map((name) => JSON.stringify(name)).join(', ')}).`,
    );
  }
  return tag as unknown as CanonicalDeliveryDescriptor;
}

function checkCanonicalModel(value: unknown, modelNames: ReadonlySet<string>, valueSchema?: NormalizedSchema,
  valueTypes?: CanonicalValueTypes): CanonicalModelDescriptor {
  if (!isRecord(value) || typeof value['name'] !== 'string' || value['name'] === '') {
    fail('malformed_descriptor', 'Invalid model descriptor: models need non-empty names.');
  }
  const name = value['name'] as string;
  if (!isRecord(value['fields'])) {
    fail(
      'malformed_descriptor',
      `Invalid model ${JSON.stringify(name)}: fields must be an object.`,
    );
  }
  const fields: Record<string, CanonicalModelDescriptor['fields'][string]> = {};
  for (const [fieldName, fieldValue] of Object.entries(value['fields'] as Record<string, unknown>)) {
    const what = `field ${JSON.stringify(fieldName)} on model ${JSON.stringify(name)}`;
    if (fieldName === '' || fieldName.includes('.')) {
      fail(
        'malformed_descriptor',
        `Invalid ${what}: field names are non-empty single segments.`,
      );
    }
    if (!isRecord(fieldValue)) {
      fail('malformed_descriptor', `Invalid ${what}: field defs must be objects.`);
    }
    const nullable = checkModelNullable(fieldValue, what);
    const deliveryMember = Object.getOwnPropertyDescriptor(fieldValue, 'delivery');
    if (deliveryMember === undefined && 'delivery' in fieldValue ||
        deliveryMember !== undefined && !Object.hasOwn(deliveryMember, 'value')) {
      fail('malformed_descriptor', `Invalid ${what}: delivery must be own data.`);
    }
    const delivery = deliveryMember === undefined ? undefined : checkModelDelivery(deliveryMember.value, what, valueTypes);
    if (typeof fieldValue['required'] !== 'boolean' || typeof fieldValue['serverOnly'] !== 'boolean') {
      fail('malformed_descriptor', `Invalid ${what}: required and serverOnly must be booleans.`);
    }
    let array: { readonly required: boolean } | undefined;
    if (fieldValue['array'] !== undefined) {
      const marker = fieldValue['array'];
      if (!isRecord(marker) || typeof marker['required'] !== 'boolean') {
        fail('malformed_descriptor', `Invalid ${what}: array markers carry a boolean required.`);
      }
      array = { required: marker['required'] as boolean };
    }
    const fallback = checkDefault(fieldValue['default'], what);
    let machine: ReturnType<typeof checkFieldMachine> | undefined;
    if (fieldValue['machine'] !== undefined) {
      try { machine = checkFieldMachine(fieldValue['machine']); }
      catch (error) { fail('malformed_descriptor', `Invalid ${what}: ${String(error)}`); }
      if (fieldValue['required'] !== false || fieldValue['serverOnly'] !== false || fieldValue['nullable'] === true || array !== undefined ||
          fallback?.kind !== 'literal' || fallback.value !== machine.initial) {
        fail('malformed_descriptor', `Invalid ${what}: machine requires a singular omitted-only literal initial default.`);
      }
    }
    const typeMember = Object.getOwnPropertyDescriptor(fieldValue, 'valueType');
    let modelReference = false;
    if (typeMember !== undefined && 'value' in typeMember && typeof typeMember.value === 'string') {
      try {
        const parsed = parseTypeId(typeMember.value);
        modelReference = parsed.base.kind === 'nominal' && modelNames.has(parsed.base.path);
      } catch { /* The owning checker below reports malformed type claims. */ }
    }
    const valueType = modelReference ? checkStoredModelValueType(fieldValue, what, modelNames, valueSchema)
      : checkValueType(fieldValue, what, valueSchema);
    checkContextDefault(fallback, valueType, fieldValue['required'], fieldValue['serverOnly'], array, what);
    checkFieldConstraints(fieldValue, valueType, what, valueSchema);
    checkNominalArray(valueType, array, what, valueSchema);
    fields[fieldName] = {
      ...(valueType !== undefined ? { valueType } : {}),
      ...(Object.hasOwn(fieldValue, 'trim') ? { trim: fieldValue['trim'] as boolean } : {}),
      ...(Object.hasOwn(fieldValue, 'min') ? { min: fieldValue['min'] as NonNullable<CanonicalModelDescriptor['fields'][string]['min']> } : {}),
      ...(Object.hasOwn(fieldValue, 'max') ? { max: fieldValue['max'] as NonNullable<CanonicalModelDescriptor['fields'][string]['max']> } : {}),
      ...(nullable !== undefined ? { nullable } : {}),
      ...(delivery !== undefined ? { delivery } : {}),
      required: fieldValue['required'] as boolean,
      serverOnly: fieldValue['serverOnly'] as boolean,
      ...(array !== undefined ? { array } : {}),
      ...(fallback !== undefined ? { default: fallback } : {}),
      ...(machine !== undefined ? { machine } : {}),
    };
  }
  if (typeof value['deleteMode'] !== 'string' || !KNOWN_DELETE_MODES.has(value['deleteMode'])) {
    fail(
      'malformed_descriptor',
      `Invalid model ${JSON.stringify(name)}: deleteMode is archive, remove, or none.`,
    );
  }
  let uniqueKeys: ReadonlyArray<string> | undefined;
  if (value['uniqueKeys'] !== undefined) {
    if (!Array.isArray(value['uniqueKeys'])) {
      fail(
        'malformed_descriptor',
        `Invalid model ${JSON.stringify(name)}: uniqueKeys must be an array.`,
      );
    }
    for (const key of value['uniqueKeys'] as unknown[]) {
      if (typeof key !== 'string' || key === '') {
        fail(
          'malformed_descriptor',
          `Invalid model ${JSON.stringify(name)}: unique keys are non-empty field names.`,
        );
      }
      if (key.includes(',')) {
        fail(
          'unsupported_composite_unique',
          `Model ${JSON.stringify(name)} declares composite unique ${JSON.stringify(key)}; ` +
            'composite uniques need T04b and cannot load in the T16a core scope.',
        );
      }
      if (!Object.hasOwn(fields, key)) {
        fail(
          'dangling_reference',
          `Unknown unique-key field ${JSON.stringify(key)} on model ${JSON.stringify(name)}.`,
        );
      }
    }
    uniqueKeys = [...(value['uniqueKeys'] as string[])];
  }
  return {
    name: name as ModelName,
    fields,
    deleteMode: value['deleteMode'] as CanonicalModelDescriptor['deleteMode'],
    ...(uniqueKeys !== undefined ? { uniqueKeys } : {}),
  };
}

/**
 * Core-scope executability: CRUD descriptors must carry what the generated
 * executor consumes. Creates resolve their model from the `<Model>.create`
 * emission convention; updates/deletes carry the synthesized versioned
 * `record` ref (identity + fencing — an unversioned or missing target
 * cannot execute; extra ref FIELD inputs beside it are ordinary values).
 * Reads/scenarios need no structural shape here (reads admit for
 * denied-not-unknown; scenarios run through the caller's execute seam).
 */
function checkCrudExecutable(
  descriptor: CanonicalOperationDescriptor,
  modelNames: ReadonlySet<string>,
): void {
  const name = descriptor.name as string;
  if (descriptor.kind === 'create') {
    if (!name.endsWith('.create') || name.length === '.create'.length) {
      fail(
        'malformed_descriptor',
        `Invalid create operation ${JSON.stringify(name)}: core-scope creates are ` +
          'named <Model>.create.',
      );
    }
    const model = name.slice(0, -'.create'.length);
    if (!modelNames.has(model)) {
      fail(
        'dangling_reference',
        `Invalid create operation ${JSON.stringify(name)}: model ${JSON.stringify(model)} ` +
          'has no descriptor in this set.',
      );
    }
    return;
  }
  if (descriptor.kind === 'update' || descriptor.kind === 'delete') {
    const record = descriptor.inputs.find(
      (input): input is Extract<CanonicalInputDef, { kind: 'ref' }> =>
        input.kind === 'ref' && input.name === 'record',
    );
    if (record?.versioned !== true) {
      fail(
        'malformed_descriptor',
        `Invalid ${descriptor.kind} operation ${JSON.stringify(name)}: core-scope ` +
          `${descriptor.kind}s carry a versioned "record" ref.`,
      );
    }
  }
}

/**
 * Load a validated `ExecutionDescriptorSet` into an admission-ready registry.
 * `contractVersion` must equal 1; unknown operation/input kinds reject the
 * WHOLE set — nothing is registered on any failure. Engine-local `by`/`when`
 * policy maps onto every generated operation (see `LoadDescriptorSetOptions`).
 */
export function loadExecutionDescriptorSet(
  set: ExecutionDescriptorSet,
  opts: LoadDescriptorSetOptions,
): LoadedDescriptorSet {
  return loadCheckedDescriptorSet(set, opts);
}

function loadCheckedDescriptorSet(
  set: ExecutionDescriptorSet, opts: LoadDescriptorSetOptions, checked?: { set: ExecutionDescriptorSet; valueSchema?: NormalizedSchema },
): LoadedDescriptorSet {
  if (!isRecord(set)) {
    fail('malformed_descriptor', 'Invalid descriptor set: the set must be an object.');
  }
  // Exact version match first: a version mismatch is the precise error, never
  // a silent fallback onto older/newer intake rules.
  if (set['contractVersion'] !== EXECUTION_CONTRACT_VERSION) {
    fail(
      'version_mismatch',
      `Incompatible descriptor set: contractVersion ${JSON.stringify(set['contractVersion'])} ` +
        `does not match the required execution contract ${EXECUTION_CONTRACT_VERSION}.`,
    );
  }
  // The state pin is self-checked at load: this guards mixed-version assembly
  // (values/identity/wire/examples pins are checked by L7 activation, which
  // owns `requires` fulfillment).
  if (STATE_CONTRACT_VERSION !== T04A_PINNED_VERSIONS.state) {
    fail(
      'version_mismatch',
      `Incompatible state contract: loaded ${STATE_CONTRACT_VERSION}, ` +
        `required ${T04A_PINNED_VERSIONS.state}.`,
    );
  }
  if (!Array.isArray(set['operations']) || !Array.isArray(set['models'])) {
    fail('malformed_descriptor', 'Invalid descriptor set: operations and models must be arrays.');
  }
  const inputArrayHints = checkedInputArrayHints(opts);
  const { valueSchema, valueTypes } = checked === undefined ? checkValueTypes(set) :
    { valueSchema: checked.valueSchema, valueTypes: checked.set.valueTypes };
  const models: CanonicalModelDescriptor[] = [];
  const modelNames = new Set<string>();
  for (const model of set['models'] as unknown[]) {
    const nameMember = isRecord(model) ? Object.getOwnPropertyDescriptor(model, 'name') : undefined;
    if (nameMember === undefined || !('value' in nameMember) || typeof nameMember.value !== 'string' || nameMember.value === '') {
      fail('malformed_descriptor', 'Invalid model descriptor: models need own non-empty names.');
    }
    const name = nameMember.value;
    if (modelNames.has(name)) {
      fail('duplicate_name', `Duplicate model descriptor: ${JSON.stringify(name)}.`);
    }
    modelNames.add(name);
  }
  for (const model of set['models'] as unknown[]) {
    models.push(checkCanonicalModel(model, modelNames, valueSchema, valueTypes));
  }
  const registry = new Map<string, InterimOperationDef | GeneratedOperationDef>();
  const seenOps = new Set<string>();
  for (const operation of set['operations'] as unknown[]) {
    if (!isRecord(operation) || typeof operation['name'] !== 'string' || operation['name'] === '') {
      fail('malformed_descriptor', 'Invalid operation descriptor: operations need non-empty names.');
    }
    const opName = operation['name'] as string;
    if (seenOps.has(opName)) {
      fail('duplicate_name', `Duplicate operation descriptor: ${JSON.stringify(opName)}.`);
    }
    seenOps.add(opName);
    const kind = operation['kind'];
    if (typeof kind !== 'string' || !KNOWN_OPERATION_KINDS.has(kind)) {
      fail(
        'unknown_operation_kind',
        `Unknown operation kind ${JSON.stringify(kind)} on ${JSON.stringify(opName)}; ` +
          'supported: read, create, update, delete, scenario.',
      );
    }
    if (!Array.isArray(operation['inputs'])) {
      fail(
        'malformed_descriptor',
        `Invalid operation ${JSON.stringify(opName)}: inputs must be an array.`,
      );
    }
    const inputs: CanonicalInputDef[] = [];
    const seenInputs = new Set<string>();
    for (const input of operation['inputs'] as unknown[]) {
      const checked = checkCanonicalInput(input, opName, modelNames, kind, valueSchema, valueTypes);
      if (seenInputs.has(checked.name)) {
        fail(
          'duplicate_name',
          `Duplicate input ${JSON.stringify(checked.name)} on operation ${JSON.stringify(opName)}.`,
        );
      }
      seenInputs.add(checked.name);
      inputs.push(checked);
    }
    const result = checkResult(operation, `operation ${JSON.stringify(opName)}`, kind, modelNames, valueSchema);
    if (result?.disclosure !== undefined && checked === undefined) {
      fail('malformed_descriptor', 'Scenario disclosure requires the defining artifact source/callable/model inventory.');
    }
    const descriptor: CanonicalOperationDescriptor = {
      name: opName as OperationName,
      kind: kind as CanonicalOperationDescriptor['kind'],
      inputs,
      ...(result !== undefined ? { result } : {}),
    };
    checkCrudExecutable(descriptor, modelNames);
    // Engine-local policy mapping (T04a §3): the artifact carries no `by`,
    // so the caller maps predicates here. Malformed predicates are caller
    // programmer bugs (plain Error), never artifact errors.
    const by = typeof opts.by === 'function' ? opts.by(descriptor) : opts.by;
    validateByPredicate(by, `generated by for operation ${JSON.stringify(opName)}`);
    let when: QueryPredicate | undefined;
    if (opts.when !== undefined) {
      const raw = typeof opts.when === 'function' ? opts.when(descriptor) : opts.when;
      if (raw !== undefined) {
        try {
          validatePredicateShape(raw);
        } catch (error) {
          throw new Error(
            `Invalid generated when for operation ${JSON.stringify(opName)}: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
        try {
          when = structuredClone(raw);
        } catch {
          throw new Error(
            `Invalid generated when for operation ${JSON.stringify(opName)}: ` +
              'predicates must be serializable data.',
          );
        }
      }
    }
    let frozenBy: ByPredicate;
    try {
      frozenBy = deepFreezeLoaded(structuredClone(by));
    } catch {
      throw new Error(
        `Invalid generated by for operation ${JSON.stringify(opName)}: ` +
          'predicates must be serializable data.',
      );
    }
    // T04b-preview input array markers (engine-local channel): entries must
    // name loaded operations/inputs with boolean markers, else fail loud.
    const arrayMarkers: Record<string, { readonly required: boolean }> = Object.create(null) as Record<string, { readonly required: boolean }>;
    for (const input of inputs) {
      if (input.kind === 'ref' && input.array !== undefined) arrayMarkers[input.name] = { required: input.array.required };
    }
    const opArrays = inputArrayHints?.[opName];
    if (opArrays !== undefined) {
      if (!isRecord(opArrays)) {
        fail(
          'malformed_descriptor',
          `Invalid input array markers for operation ${JSON.stringify(opName)}.`,
        );
      }
      for (const [inputName, marker] of Object.entries(opArrays)) {
        if (!seenInputs.has(inputName)) {
          fail(
            'dangling_reference',
            `Invalid input array marker ${JSON.stringify(inputName)} on operation ` +
              `${JSON.stringify(opName)}: no such input.`,
          );
        }
        const checkedMarker = checkInputArrayMarker(marker, `input ${JSON.stringify(inputName)}`);
        if (Object.hasOwn(arrayMarkers, inputName) && arrayMarkers[inputName]!.required !== checkedMarker.required) {
          fail('malformed_descriptor', `Contradictory input array marker ${JSON.stringify(inputName)} on operation ${JSON.stringify(opName)}.`);
        }
        arrayMarkers[inputName] = checkedMarker;
      }
    }
    for (const input of inputs) {
      checkInputArrayBounds(input as unknown as Record<string, unknown>, `input ${JSON.stringify(input.name)} on operation ${JSON.stringify(opName)}`, Object.hasOwn(arrayMarkers, input.name));
      if (input.kind === 'ref' && input.computedDefault === true && Object.hasOwn(arrayMarkers, input.name)) {
        fail('malformed_descriptor', `Invalid input ${JSON.stringify(input.name)} on operation ${JSON.stringify(opName)}: computedDefault ref requires a singular input.`);
      }
      if (input.kind !== 'ref' && input.kind !== 'delivery') {
        checkNominalArray(input.valueType, arrayMarkers[input.name], `input ${JSON.stringify(input.name)} on operation ${JSON.stringify(opName)}`, valueSchema);
        if (input.kind === 'enum' && input.computedDefault === true && input.valueType === undefined && Object.hasOwn(arrayMarkers, input.name)) {
          fail('malformed_descriptor', `Invalid input ${JSON.stringify(input.name)} on operation ${JSON.stringify(opName)}: computedDefault enum requires a singular input.`);
        }
        if (input.computedDefault === true && arrayMarkers[input.name]?.required === true) {
          fail('malformed_descriptor', `Invalid input ${JSON.stringify(input.name)} on operation ${JSON.stringify(opName)}: computedDefault requires an ordinary array marker.`);
        }
      }
    }
    // Null proof belongs to this exact checked singular-ref input. Use own
    // keys throughout: prototype slots are neither array markers nor proof.
    const nullableRefs: Record<string, true> = Object.create(null) as Record<string, true>;
    for (const input of inputs) {
      if (input.kind === 'ref' && input.nullable === true && !Object.hasOwn(arrayMarkers, input.name)) nullableRefs[input.name] = true;
    }
    const hasNullableRefs = opts.inputNullableRefs !== undefined && Object.hasOwn(opts.inputNullableRefs, opName);
    const opNullableRefs = hasNullableRefs ? opts.inputNullableRefs![opName] : undefined;
    if (hasNullableRefs) {
      if (!isRecord(opNullableRefs)) {
        fail('malformed_descriptor', `Invalid nullable ref markers for operation ${JSON.stringify(opName)}.`);
      }
      for (const [inputName, marker] of Object.entries(opNullableRefs)) {
        const input = descriptor.inputs.find((entry) => entry.name === inputName);
        if (input === undefined) {
          fail('dangling_reference', `Invalid nullable ref marker ${JSON.stringify(inputName)} on operation ${JSON.stringify(opName)}: no such input.`);
        }
        if (marker !== true || input.kind !== 'ref' || input.nullable === false || input.computedDefault === true || Object.hasOwn(arrayMarkers, inputName)) {
          fail('malformed_descriptor', `Invalid nullable ref marker ${JSON.stringify(inputName)} on operation ${JSON.stringify(opName)}: only true singular-ref markers are supported.`);
        }
        nullableRefs[inputName] = true;
      }
    }
    const def: GeneratedOperationDef = {
      generated: true,
      name: opName as OperationName,
      kind: kind as CanonicalOperationKind,
      descriptor: deepFreezeLoaded(descriptor),
      by: frozenBy,
      ...(when !== undefined ? { when: deepFreezeLoaded(when) } : {}),
      inputArrays: deepFreezeLoaded(arrayMarkers),
      inputNullableRefs: deepFreezeLoaded(nullableRefs),
      // V02.4: fresh prepared-inputs plan per def per load — never a
      // cached lookup by operation name. Built from the validated
      // descriptor, so whole-set rejection below/above leaves no
      // partial plan behind (the def is only registered on success).
      preparedInputs: deepFreezeLoaded(prepareDescriptorInputs(descriptor, arrayMarkers, nullableRefs)),
    };
    if (valueSchema !== undefined) generatedInputDeclarations.set(def, {
      valueSchema, modelNames: new Set(modelNames),
    });
    registry.set(opName, Object.freeze(def));
  }
  if (inputArrayHints !== undefined) {
    for (const opKey of Object.keys(inputArrayHints)) {
      if (!seenOps.has(opKey)) {
        fail(
          'dangling_reference',
          `Invalid input array markers for operation ${JSON.stringify(opKey)}: ` +
            'no such operation in this set.',
        );
      }
    }
  }
  if (opts.inputNullableRefs !== undefined) {
    for (const opKey of Object.keys(opts.inputNullableRefs)) {
      if (!seenOps.has(opKey)) {
        fail('dangling_reference', `Invalid nullable ref markers for operation ${JSON.stringify(opKey)}: no such operation in this set.`);
      }
    }
  }
  return { registry, models: deepFreezeLoaded(models),
    ...(valueSchema !== undefined ? { valueSchema } : {}),
    ...(valueTypes !== undefined ? { valueTypes } : {}) };
}

/**
 * Convert a compiled artifact's T15a descriptor slice into the folded T04a
 * intake: `artifact_version` must equal 1 (the pinned artifact contract);
 * absent `operations`/`models` read as "no descriptors", never as an error;
 * model `fields` arrays fold into records by name and additive members drop
 * (except the engine-local channels — T18 server inits and known-nullable
 * names, B5 declared ownership, B3 delivery-field membership — which ride
 * beside the intake like refs). Unknown operation/input/default kinds —
 * or any malformed/dangling member — reject the WHOLE conversion.
 */
/**
 * BGI-08 checked Given-contract join: trait instantiations fold into the
 * effective models (contributed fields face the uniform loop below), and
 * keyword rules validate into `StateUniqueKeyProducerBinding` entries the
 * seam resolves against saved implementations. Bindings derive ONLY from
 * the artifact's checked `givenContracts` — the loader invents no anonymous
 * applications, and any unknown producer, hidden authority or unsupported
 * contribution rejects the WHOLE set.
 */

/** Contributed leaves use the same native associations and codecs as authored fields. */
function givenRuntimeShape(typeText: unknown): { type: string; base: string; field: Record<string, unknown>; array: boolean; nullable: boolean } {
  try {
    if (typeof typeText !== 'string') throw new Error('missing type');
    const parsed = parseTypeId(typeText.replace(/\s/g, '').replace(/^boolean(?=\[|\?|$)/, 'bool').replace(/^integer(?=\[|\?|$)/, 'int'));
    const base = parsed.base;
    const tags: Readonly<Record<string, string>> = { bool: 'boolean', int: 'integer', decimal: 'decimal', text: 'string',
      email: 'string', timezone: 'string', date: 'date', datetime: 'datetime', duration: 'duration', money: 'money', user: 'user', file: 'file' };
    const name = base.kind === 'scalar' || base.kind === 'stringlike' ? base.name : base.kind;
    if (parsed.requiredArray || base.kind !== 'enum' && tags[name] === undefined) throw new Error('unsupported leaf');
    return { type: printTypeId(parsed), base: name, field: base.kind === 'enum' ? { kind: 'enum', values: [...base.cases] } : { kind: tags[name] },
      array: parsed.array, nullable: parsed.nullable };
  } catch {
    fail('unsupported_given_contribution', `Invalid contributed type ${JSON.stringify(typeText)}; this contribution needs explicit owner integration.`);
  }
}

/** Split source arrays without rounding numeric literals or splitting quoted commas. */
function givenArrayConstants(source: string): string[] {
  if (!source.startsWith('[') || !source.endsWith(']')) throw new Error('expected array');
  const body = source.slice(1, -1);
  if (body.trim() === '') return [];
  const values: string[] = [];
  let quoted = false;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ',') { values.push(body.slice(start, index).trim()); start = index + 1; }
  }
  if (quoted) throw new Error('unterminated string');
  const last = body.slice(start).trim();
  if (last !== '') values.push(last);
  return values;
}

function givenRuntimeLiteral(typeText: string, defaultText: string, what: string): unknown {
  try {
    const shape = givenRuntimeShape(typeText);
    const source = defaultText.trim();
    if (source === 'null' && shape.nullable) return null;
    if (shape.array) {
      const elementType = shape.type.replace(/\[\]\??$/, '');
      return givenArrayConstants(source).map(item => givenRuntimeLiteral(elementType, item, what));
    }
    if (shape.base === 'text' && !source.startsWith('"')) throw new Error('expected quoted text');
    if (['int', 'decimal', 'enum'].includes(shape.base) && source.startsWith('"')) throw new Error('expected source literal');
    let wire: unknown = source.startsWith('"') ? JSON.parse(source) : source;
    if (shape.base === 'bool') {
      if (source !== 'true' && source !== 'false') throw new Error('expected bool');
      wire = source === 'true';
    }
    if (shape.base === 'duration' && typeof wire === 'string') {
      const units: Readonly<Record<string, bigint>> = { ms: 1n, s: 1000n, m: 60000n, h: 3600000n, d: 86400000n };
      const duration = /^(-?[0-9]+)(ms|s|m|h|d)$/.exec(wire);
      if (duration !== null) wire = (BigInt(duration[1]!) * units[duration[2]!]!).toString();
    }
    if (shape.base === 'datetime' && typeof wire === 'string') wire = encodeValue('datetime', datetime(wire));
    // The wire owner enforces ranges, exact datetime syntax, enum cases and validated strings.
    return encodeValue(shape.type, decodeValue(shape.type, wire));
  } catch {
    fail('malformed_descriptor', `Invalid ${what}: default ${JSON.stringify(defaultText)} does not inhabit ${JSON.stringify(typeText)}.`);
  }
}

function givenLengthBound(shape: ReturnType<typeof givenRuntimeShape>): boolean {
  return shape.array || ['text', 'email', 'timezone'].includes(shape.base);
}

function givenRuntimeBound(typeText: string, bound: string, what: string): unknown {
  const shape = givenRuntimeShape(typeText);
  if (givenLengthBound(shape)) {
    const parsed = Number(bound);
    if (/^[0-9]+$/.test(bound.trim()) && Number.isSafeInteger(parsed)) return parsed;
    fail('unsupported_given_contribution', `Invalid ${what}: bound ${JSON.stringify(bound)} must be a safe nonnegative length.`);
  }
  if (!['int', 'decimal', 'duration', 'money', 'date', 'datetime'].includes(shape.base)) {
    fail('malformed_descriptor', `Invalid ${what}: ${shape.base} fields take no bounds.`);
  }
  return givenRuntimeLiteral(shape.type.replace(/\?$/, ''), bound, what);
}

function compareGivenBounds(typeText: string, left: unknown, right: unknown, what: string): number {
  try {
    const shape = givenRuntimeShape(typeText);
    if (givenLengthBound(shape)) {
      if (typeof left !== 'number' || typeof right !== 'number' || !Number.isSafeInteger(left) || !Number.isSafeInteger(right)) throw new Error('invalid length');
      return left < right ? -1 : left > right ? 1 : 0;
    }
    const type = shape.type.replace(/\?$/, '');
    const a = decodeValue(type, left);
    const b = decodeValue(type, right);
    if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
    if (isDecimal(a) && isDecimal(b)) return compareDecimal(a, b);
    if (isDateValue(a) && isDateValue(b)) return compareDate(a, b);
    if (isDatetime(a) && isDatetime(b)) return compareInstant(a, b);
    if (isMoney(a) && isMoney(b)) return compareMoney(a, b);
    throw new Error('unordered bound');
  } catch {
    fail('malformed_descriptor', `Invalid ${what}: cannot compare declared native bounds.`);
  }
}

function sameGivenValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameGivenTypedValue(type: string, left: unknown, right: unknown): boolean {
  try {
    return sameGivenValue(encodeValue(type, decodeValue(type, left)), encodeValue(type, decodeValue(type, right)));
  } catch { return false; }
}

function sameGivenBound(type: string, left: unknown, right: unknown, what: string): boolean {
  if (left === undefined || right === undefined) return left === right;
  return compareGivenBounds(type, left, right, what) === 0;
}

function givenConstraints(entry: Record<string, unknown>, typeText: string, what: string): Record<string, unknown> {
  const shape = givenRuntimeShape(typeText);
  const trim = entry['trim'] ?? false;
  if (typeof trim !== 'boolean' || trim && (shape.base !== 'text' || shape.array)) {
    fail('malformed_descriptor', `Invalid ${what}: trim needs a text field.`);
  }
  const result: Record<string, unknown> = trim ? { trim: true } : {};
  for (const bound of ['min', 'max'] as const) {
    if (entry[bound] === undefined) continue;
    if (typeof entry[bound] !== 'string') fail('malformed_descriptor', `Invalid ${what}: bounds are source-text constants.`);
    result[bound] = givenRuntimeBound(typeText, entry[bound], what);
  }
  if (result['min'] !== undefined && result['max'] !== undefined && compareGivenBounds(typeText, result['min'], result['max'], what) > 0) {
    fail('malformed_descriptor', `Invalid ${what}: bounds contradict.`);
  }
  return result;
}

interface GivenContractsShape {
  readonly traits: ArtifactGivenTrait[];
  readonly keywords: ArtifactGivenKeyword[];
}

/** BGI-08 read the optional `givenContracts` member (absent reads as none). */
function checkGivenContractsShape(artifact: Record<string, unknown>): GivenContractsShape {
  if (!Object.hasOwn(artifact, 'givenContracts') || artifact['givenContracts'] === undefined) {
    return { traits: [], keywords: [] };
  }
  const claimed = artifact['givenContracts'];
  if (!isRecord(claimed) || !Array.isArray(claimed['traits']) || !Array.isArray(claimed['keywords'])) {
    fail('malformed_descriptor', 'Invalid artifact givenContracts: traits and keywords must be arrays.');
  }
  return {
    traits: claimed['traits'] as ArtifactGivenTrait[],
    keywords: claimed['keywords'] as ArtifactGivenKeyword[],
  };
}

/**
 * BGI-08 fold checked trait instantiations into effective models. Model
 * attachments append synthesized leaf fields (new fields require their
 * checked default, mirroring the compiler); field attachments merge
 * trim/min/max/default constraints onto the existing field with
 * strongest-wins bound intersection. Contributed fields return to the
 * uniform loop, so duplicate/conflict/contradiction outcomes match
 * authored validation — with trait attribution on the refusal.
 */
function foldGivenTraitContributions(
  rawModels: unknown[],
  traits: ArtifactGivenTrait[],
  modelNames: Set<string>,
): unknown[] {
  if (traits.length === 0) return rawModels;
  const byName = new Map<string, Record<string, unknown>>();
  for (const model of rawModels) {
    if (isRecord(model) && typeof model['name'] === 'string') byName.set(model['name'], model);
  }
  // Copied field arrays per touched model; untouched models keep their refs.
  const foldedFields = new Map<string, Array<Record<string, unknown>>>();
  const foldedBy = new Map<string, Map<string, string>>();
  const fieldsOf = (modelName: string, what: string): Array<Record<string, unknown>> => {
    const cached = foldedFields.get(modelName);
    if (cached !== undefined) return cached;
    const model = byName.get(modelName);
    const fields = model?.['fields'];
    if (!isRecord(model) || !Array.isArray(fields)) {
      fail(
        'malformed_descriptor',
        `Invalid artifact model ${JSON.stringify(modelName)}: fields must be an array.`,
      );
    }
    const copy = (fields as unknown[]).map((entry) =>
      (isRecord(entry) ? { ...entry } : entry) as Record<string, unknown>,
    );
    foldedFields.set(modelName, copy);
    return copy;
  };
  const contributorOf = (modelName: string): Map<string, string> => {
    const cached = foldedBy.get(modelName);
    if (cached !== undefined) return cached;
    const fresh = new Map<string, string>();
    foldedBy.set(modelName, fresh);
    return fresh;
  };
  traits.forEach((item, index) => {
    if (!isRecord(item)) {
      fail('malformed_descriptor', `Invalid given trait instantiation #${index}: expected an object.`);
    }
    const trait = item as Record<string, unknown>;
    const label = typeof trait['trait'] === 'string' && trait['trait'] !== ''
      ? `trait \`${trait['trait'] as string}\``
      : 'inline trait';
    const target = trait['target'];
    const fields = trait['fields'];
    if (typeof target !== 'string' || target === '' || !Array.isArray(fields)) {
      fail(
        'malformed_descriptor',
        `Invalid ${label} instantiation #${index}: target and fields are required.`,
      );
    }
    const what = `${label} on ${target}`;
    if (modelNames.has(target)) {
      foldGivenModelAttachment(
        what, target, fields as unknown[], fieldsOf, contributorOf(target), byName.get(target)?.['uniqueKeys'],
      );
      return;
    }
    const dot = target.lastIndexOf('.');
    const head = dot < 0 ? '' : target.slice(0, dot);
    const tail = dot < 0 ? '' : target.slice(dot + 1);
    if (head === '' || tail === '' || tail.includes('.') || !modelNames.has(head)) {
      fail(
        'dangling_reference',
        `Invalid ${what}: model ${JSON.stringify(dot < 0 ? target : head)} has no descriptor in this set.`,
      );
    }
    foldGivenFieldAttachment(
      what, head, tail, fields as unknown[], fieldsOf(head, what),
    );
  });
  if (foldedFields.size === 0) return rawModels;
  return rawModels.map((model) => {
    if (!isRecord(model) || typeof model['name'] !== 'string') return model;
    const folded = foldedFields.get(model['name']);
    if (folded === undefined) return model;
    return { ...model, fields: folded };
  });
}

/** BGI-08 one model attachment: append synthesized leaf fields. */
function foldGivenModelAttachment(
  what: string,
  modelName: string,
  fields: unknown[],
  fieldsOf: (modelName: string, what: string) => Array<Record<string, unknown>>,
  contributedBy: Map<string, string>,
  uniqueKeys: unknown,
): void {
  const target = fieldsOf(modelName, what);
  for (const entry of fields) {
    if (!isRecord(entry)) {
      fail('malformed_descriptor', `Invalid ${what}: contributed fields must be objects.`);
    }
    const name = entry['name'];
    const typeText = entry['type'];
    if (typeof name !== 'string' || name === '' || typeof typeText !== 'string') {
      fail('malformed_descriptor', `Invalid ${what}: contributed fields need a name and a type.`);
    }
    const shape = givenRuntimeShape(typeText);
    const fieldWhat = `${what} contributes \`${name}\``;
    const rawDefault = entry['default'];
    if (rawDefault === undefined) fail('malformed_descriptor', `Invalid ${fieldWhat} with no default; existing creates and fixtures stay valid only with one.`);
    if (typeof rawDefault !== 'string') fail('malformed_descriptor', `Invalid ${fieldWhat}: defaults are source-text constants.`);
    const literal = givenRuntimeLiteral(typeText, rawDefault, fieldWhat);
    const constraints = givenConstraints(entry, typeText, fieldWhat);
    const first = contributedBy.get(name);
    if (first !== undefined) {
      fail(
        'duplicate_name',
        `Invalid ${what}: contributes \`${name}\`, already contributed by ${first}.`,
      );
    }
    const authored = target.find((candidate) => candidate['name'] === name);
    if (authored !== undefined) {
      // Compiler artifacts carry effective schemas for migrations/UI and
      // checked Given provenance. Reuse that field once only when all of
      // its admitted runtime behavior matches; raw descriptor consumers
      // still fold missing fields below, and sibling contributions refuse.
      const field = authored['field'];
      const value = authored['default'];
      const allowed = new Set(['name', 'field', 'required', 'serverOnly', 'valueType',
        'nullable', 'array', 'default', 'trim', 'min', 'max', 'machine', 'description']);
      const matches = Object.keys(authored).every(key => allowed.has(key)) &&
        !(Array.isArray(uniqueKeys) && uniqueKeys.includes(name)) &&
        sameGivenValue(field, shape.field) &&
        authored['required'] === false && authored['serverOnly'] === false &&
        (authored['nullable'] === true) === shape.nullable &&
        (shape.array ? sameGivenValue(authored['array'], { required: false }) : authored['array'] === undefined) &&
        authored['machine'] === undefined &&
        (authored['valueType'] === undefined || authored['valueType'] === shape.type) &&
        (authored['trim'] ?? false) === (constraints['trim'] ?? false) &&
        sameGivenBound(shape.type, authored['min'], constraints['min'], what) && sameGivenBound(shape.type, authored['max'], constraints['max'], what) &&
        isRecord(value) && Object.keys(value).length === 2 &&
        value['kind'] === 'literal' && sameGivenTypedValue(shape.type, value['value'], literal);
      if (!matches) {
        fail('duplicate_name', `Invalid ${what}: contributes \`${name}\`, already declared on model ${JSON.stringify(modelName)} with a conflicting runtime schema.`);
      }
      contributedBy.set(name, what);
      continue;
    }
    contributedBy.set(name, what);
    target.push({
      name,
      field: shape.field,
      required: false,
      serverOnly: false,
      valueType: shape.type,
      ...(shape.nullable ? { nullable: true } : {}),
      ...(shape.array ? { array: { required: false } } : {}),
      default: { kind: 'literal', value: literal },
      ...constraints,
    });
  }
}

/** BGI-08 one field attachment: merge constraints onto the existing field. */
function foldGivenFieldAttachment(
  what: string,
  modelName: string,
  fieldName: string,
  fields: unknown[],
  target: Array<Record<string, unknown>>,
): void {
  if (fields.length !== 1) {
    fail(
      'malformed_descriptor',
      `Invalid ${what}: needs a single-field constraint template for a field attachment.`,
    );
  }
  const entry = fields[0];
  if (!isRecord(entry)) {
    fail('malformed_descriptor', `Invalid ${what}: contributed fields must be objects.`);
  }
  const typeText = entry['type'];
  const shape = givenRuntimeShape(typeText);
  const index = target.findIndex((candidate) => candidate['name'] === fieldName);
  if (index < 0) {
    fail(
      'dangling_reference',
      `Invalid ${what}: field ${JSON.stringify(fieldName)} has no descriptor on model ${JSON.stringify(modelName)}.`,
    );
  }
  const authored = target[index] as Record<string, unknown>;
  const association = artifactValueType(authored, what) ?? (isRecord(authored['field']) && authored['field']['kind'] === 'string' ? 'text' : undefined);
  if (association !== shape.type) {
    fail('malformed_descriptor', `Invalid ${what}: has type ${JSON.stringify(typeText)}, cannot change \`${fieldName}\` from its declared type.`);
  }
  const merged: Record<string, unknown> = { ...authored };
  const rawDefault = entry['default'];
  if (rawDefault !== undefined) {
    if (typeof rawDefault !== 'string') {
      fail('malformed_descriptor', `Invalid ${what}: defaults are source-text constants.`);
    }
    const literal = givenRuntimeLiteral(shape.type, rawDefault, what);
    const declared = authored['default'];
    if (declared === undefined) {
      merged['default'] = { kind: 'literal', value: literal };
      merged['required'] = false;
    } else if (isRecord(declared) && declared['kind'] === 'literal' && sameGivenTypedValue(shape.type, declared['value'], literal)) {
      // Agreement: the authored default already carries the constraint.
    } else {
      fail(
        'malformed_descriptor',
        `Invalid ${what}: default ${JSON.stringify(rawDefault)} contradicts the declared default.`,
      );
    }
  }
  const constraints = givenConstraints(entry, shape.type, what);
  if (constraints['trim'] === true || authored['trim'] === true) merged['trim'] = true;
  for (const bound of ['min', 'max'] as const) {
    const parsed = constraints[bound];
    if (parsed === undefined) continue;
    const declared = authored[bound];
    if (declared === undefined) merged[bound] = parsed;
    else {
      const comparison = compareGivenBounds(shape.type, declared, parsed, what);
      merged[bound] = (bound === 'min' ? comparison < 0 : comparison > 0) ? parsed : declared;
    }
  }
  if (merged['min'] !== undefined && merged['max'] !== undefined && compareGivenBounds(shape.type, merged['min'], merged['max'], what) > 0) {
    fail('malformed_descriptor', `Invalid ${what}: bounds contradict the declared bounds.`);
  }
  target[index] = merged;
}

/**
 * BGI-08 validate keyword rules into checked `state.unique-key@1` bindings:
 * exact producer/semantics/lifecycle match, text in/out, no admitted
 * reads/effects/authority (the pure producer admits none — anything
 * declared is hidden authority), and a target naming an existing singular
 * non-nullable text field with no builtin unique. The compiler owns the
 * rule identity; the loader re-derives it from target+keyword and refuses
 * anything that does not match exactly.
 */
function checkGivenKeywordBindings(
  keywords: ArtifactGivenKeyword[],
  models: CanonicalModelDescriptor[],
): StateUniqueKeyProducerBinding[] {
  if (keywords.length === 0) return [];
  const byName = new Map(models.map((model) => [model.name as string, model]));
  const seen = new Set<string>();
  const bindings: StateUniqueKeyProducerBinding[] = [];
  keywords.forEach((item, index) => {
    if (!isRecord(item)) {
      fail('malformed_descriptor', `Invalid given keyword rule #${index}: expected an object.`);
    }
    const rule = item as unknown as Record<string, unknown>;
    const producer = rule['producer'];
    if (producer !== 'state.unique-key@1') {
      fail(
        'unknown_producer',
        `Invalid given keyword rule #${index}: unknown producer ${JSON.stringify(producer)}; ` +
          'v1 admits state.unique-key@1 — generated code never self-registers producers.',
      );
    }
    const where = typeof rule['ruleId'] === 'string' && rule['ruleId'] !== ''
      ? `keyword rule ${JSON.stringify(rule['ruleId'])}`
      : `given keyword rule #${index}`;
    if (rule['semantics'] !== 'nfkc-ascii-lowercase' || rule['lifecycle'] !== 'commit-keys') {
      fail(
        'unknown_producer',
        `Invalid ${where}: semantics ${JSON.stringify(rule['semantics'])} / lifecycle ` +
          `${JSON.stringify(rule['lifecycle'])} is not the checked state.unique-key@1 contract.`,
      );
    }
    const input = rule['input'];
    const result = rule['result'];
    if (!isRecord(input) || typeof input['name'] !== 'string' || input['name'] === '' ||
        input['type'] !== 'text' || !isRecord(result) || result['type'] !== 'text') {
      fail(
        'malformed_descriptor',
        `Invalid ${where}: the producer binds checked text input to checked text result.`,
      );
    }
    for (const admitted of ['reads', 'effects', 'authority'] as const) {
      const declared = rule[admitted];
      if (!Array.isArray(declared)) {
        fail('malformed_descriptor', `Invalid ${where}: ${admitted} must be an array.`);
      }
      if (declared.length !== 0) {
        fail(
          'malformed_descriptor',
          `Invalid ${where}: declares ${admitted} the pure producer does not admit — hidden authority refuses.`,
        );
      }
    }
    const ruleId = rule['ruleId'];
    const keyword = rule['keyword'];
    const targetModel = rule['targetModel'];
    const targetField = rule['targetField'];
    if (typeof ruleId !== 'string' || ruleId === '' || typeof keyword !== 'string' || keyword === '' ||
        typeof targetModel !== 'string' || targetModel === '' ||
        typeof targetField !== 'string' || targetField === '') {
      fail(
        'malformed_descriptor',
        `Invalid ${where}: rule, keyword, targetModel and targetField are required.`,
      );
    }
    if (ruleId !== `${targetField}#${keyword}`) {
      fail(
        'malformed_descriptor',
        `Invalid ${where}: rule identity must be its target field plus its keyword.`,
      );
    }
    const model = byName.get(targetModel);
    if (model === undefined) {
      fail(
        'dangling_reference',
        `Invalid ${where}: model ${JSON.stringify(targetModel)} has no descriptor in this set.`,
      );
    }
    const prefix = `${targetModel}.`;
    const fieldName = targetField.startsWith(prefix) ? targetField.slice(prefix.length) : '';
    if (fieldName === '' || fieldName.includes('.')) {
      fail('malformed_descriptor', `Invalid ${where}: target field names one model-local field.`);
    }
    const field = model.fields[fieldName];
    if (field === undefined) {
      fail(
        'dangling_reference',
        `Invalid ${where}: field ${JSON.stringify(fieldName)} has no descriptor on model ${JSON.stringify(targetModel)}.`,
      );
    }
    if (field.array !== undefined || field.nullable === true ||
        (field.valueType !== undefined && field.valueType !== 'text')) {
      fail(
        'malformed_descriptor',
        `Invalid ${where}: needs a checked text field — nullable, array and non-text targets refuse.`,
      );
    }
    if (model.uniqueKeys?.includes(fieldName) === true) {
      fail(
        'malformed_descriptor',
        `Invalid ${where}: conflicts with the declared builtin unique on ` +
          `${JSON.stringify(targetField)} (canonical and builtin keys never share a field).`,
      );
    }
    const dependencies = rule['dependencies'];
    if (!Array.isArray(dependencies) || !dependencies.includes(targetField)) {
      fail(
        'malformed_descriptor',
        `Invalid ${where}: dependencies must name the bound field ${JSON.stringify(targetField)}.`,
      );
    }
    const unit = rule['unitId'];
    const exportName = rule['export'];
    const fingerprint = rule['fingerprint'];
    if (typeof unit !== 'string' || unit === '' ||
        typeof exportName !== 'string' || exportName === '' ||
        typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      fail(
        'malformed_descriptor',
        `Invalid ${where}: the saved implementation needs a unit, an export and a lowercase SHA-256 fingerprint.`,
      );
    }
    if (seen.has(ruleId)) {
      fail(
        'duplicate_name',
        `Invalid ${where}: duplicate keyword rule ${JSON.stringify(ruleId)}.`,
      );
    }
    seen.add(ruleId);
    bindings.push({
      abi: 'state.unique-key@1',
      rule: ruleId,
      model: targetModel as ModelName,
      field: fieldName,
      semantics: 'nfkc-ascii-lowercase',
      lifecycle: 'commit-keys',
      input: { name: input['name'] as string, type: 'text' },
      result: { type: 'text' },
      implementation: { unit, export: exportName, fingerprint },
    });
  });
  return bindings;
}

/** Admit the source-derived fixed field-validation contract without executing metadata. */
function checkGivenFieldBindings(traits: ArtifactGivenTrait[], models: CanonicalModelDescriptor[]): StateFieldValidationProducerBinding[] {
  const byName = new Map(models.map(model => [model.name as string, model]));
  const seen = new Set<string>();
  const bindings: StateFieldValidationProducerBinding[] = [];
  const exact = (value: unknown, keys: string[]): Record<string, unknown> => {
    if (!isRecord(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return property === undefined || !property.enumerable || !('value' in property);
    })) fail('malformed_descriptor', 'Invalid field validation: expected exact own data fields.');
    return value;
  };
  for (const trait of traits) {
    const claim = Object.getOwnPropertyDescriptor(trait, 'validation');
    if (claim === undefined) {
      if ('validation' in trait) fail('malformed_descriptor', 'Field validation must be an own data claim.');
      continue;
    }
    if (!('value' in claim)) fail('malformed_descriptor', 'Field validation must be an own data claim.');
    const validation = exact(claim.value, ['producer', 'export', 'lifecycle', 'input', 'result', 'reads', 'effects', 'authority', 'fingerprint']);
    const input = exact(validation['input'], ['name', 'type']);
    const result = exact(validation['result'], ['type']);
    if (validation['producer'] !== 'state.field-validation@1' || validation['export'] !== 'check' ||
        validation['lifecycle'] !== 'validate-fields' || input['name'] !== 'value' || input['type'] !== 'text' || result['type'] !== 'bool' ||
        ['reads', 'effects', 'authority'].some(key => !Array.isArray(validation[key]) || (validation[key] as unknown[]).length !== 0 || Reflect.ownKeys(validation[key] as unknown[]).length !== 1) ||
        typeof validation['fingerprint'] !== 'string' || !/^[0-9a-f]{64}$/.test(validation['fingerprint'])) {
      fail('malformed_descriptor', 'Invalid field validation: only the fixed pure text-to-bool producer is supported.');
    }
    // Identity and target remain compiler-owned; model traits cannot acquire checks.
    for (const key of ['id', 'owner', 'unitId', 'target'] as const) {
      const property = Object.getOwnPropertyDescriptor(trait, key);
      if (property === undefined || !('value' in property) || typeof property.value !== 'string' || property.value === '') {
        fail('malformed_descriptor', 'Invalid field validation identity.');
      }
    }
    const dot = trait.target.lastIndexOf('.');
    const modelName = trait.target.slice(0, dot);
    const fieldName = trait.target.slice(dot + 1);
    const model = byName.get(modelName);
    const field = model?.fields[fieldName];
    if (!modelName.startsWith(`${trait.owner}.`) || field === undefined || field.valueType !== 'text' || field.array !== undefined || field.nullable === true ||
        trait.fields.length !== 1 || trait.fields[0]?.type !== 'text' || !/^[A-Za-z0-9_-]+$/.test(trait.unitId)) {
      fail('malformed_descriptor', 'Field validation requires one nonnullable native text field template on its owning model.');
    }
    if (seen.has(trait.id)) fail('duplicate_name', 'Duplicate field validation rule.');
    seen.add(trait.id);
    bindings.push({ abi: 'state.field-validation@1', rule: trait.id, model: modelName as ModelName, field: fieldName,
      lifecycle: 'validate-fields', input: { name: 'value', type: 'text' }, result: { type: 'bool' },
      implementation: { unit: trait.unitId, export: 'check', fingerprint: validation['fingerprint'] } });
  }
  return bindings;
}

export function artifactToDescriptorSet(
  artifact: ArtifactDescriptorSlice,
): ConvertedArtifactDescriptors {
  if (!isRecord(artifact)) {
    fail('malformed_descriptor', 'Invalid artifact descriptor slice: expected an object.');
  }
  if (artifact['artifact_version'] !== T04A_PINNED_VERSIONS.artifact) {
    fail(
      'version_mismatch',
      `Incompatible artifact: artifact_version ${JSON.stringify(artifact['artifact_version'])} ` +
        `does not match the required artifact contract ${T04A_PINNED_VERSIONS.artifact}.`,
    );
  }
  const policyClaim = Object.getOwnPropertyDescriptor(artifact, 'modelPolicies');
  if ((policyClaim === undefined && 'modelPolicies' in artifact) || (policyClaim !== undefined && !('value' in policyClaim))) {
    fail('malformed_descriptor', 'Model policies require an own data claim.');
  }
  const policyModules = policyClaim === undefined ? undefined : artifactPolicyModulePaths(artifact);
  const sources = checkSources(artifact);
  const { valueTypes, valueSchema } = checkValueTypes(artifact);
  const rawOperations: unknown[] =
    artifact['operations'] === undefined ? [] : (artifact['operations'] as unknown[]);
  const rawModels: unknown[] =
    artifact['models'] === undefined ? [] : (artifact['models'] as unknown[]);
  if (!Array.isArray(rawOperations) || !Array.isArray(rawModels)) {
    fail('malformed_descriptor', 'Invalid artifact descriptors: operations and models must be arrays.');
  }
  // Models first: operation ref targets resolve against these names, and
  // mutually recursive models resolve by name without expansion.
  const modelNames = new Set<string>();
  for (const model of rawModels) {
    if (!isRecord(model) || typeof model['name'] !== 'string' || model['name'] === '') {
      fail('malformed_descriptor', 'Invalid artifact model: models need non-empty names.');
    }
    const name = model['name'] as string;
    if (modelNames.has(name)) {
      fail('duplicate_name', `Duplicate model descriptor: ${JSON.stringify(name)}.`);
    }
    modelNames.add(name);
  }
  const refs = new Map<ModelName, InterimRefDef[]>();
  const serverInits = new Map<ModelName, Map<string, ServerInitKind>>();
  const nullableFields = new Map<ModelName, Set<string>>();
  const secretFields = new Map<ModelName, Set<string>>();
  const containment = new Map<ModelName, InterimContainment>();
  const deliveryEntries: Array<readonly [string, ReadonlyArray<string>]> = [];
  const models: CanonicalModelDescriptor[] = [];
  // BGI-08: fold checked trait instantiations into the effective models
  // before the uniform loop validates them (contributed fields face the
  // same checks as authored ones); keyword rules validate after, against
  // the folded descriptors.
  const givenContracts = checkGivenContractsShape(artifact);
  const effectiveModels = foldGivenTraitContributions(rawModels, givenContracts.traits, modelNames);
  for (const model of effectiveModels as ArtifactModel[]) {
    if (!Array.isArray(model.fields)) {
      fail(
        'malformed_descriptor',
        `Invalid artifact model ${JSON.stringify(model.name)}: fields must be an array.`,
      );
    }
    const seenFields = new Set<string>();
    const fields: Record<string, CanonicalModelDescriptor['fields'][string]> = {};
    const modelRefs: InterimRefDef[] = [];
    const modelInits = new Map<string, ServerInitKind>();
    const modelNullable = new Set<string>();
    const modelSecrets = new Set<string>();
    const modelDelivery: string[] = [];
    for (const field of model.fields) {
      if (typeof field.name !== 'string' || field.name === '') {
        fail(
          'malformed_descriptor',
          `Invalid artifact model ${JSON.stringify(model.name)}: fields need non-empty names.`,
        );
      }
      if (seenFields.has(field.name)) {
        fail(
          'duplicate_name',
          `Duplicate field ${JSON.stringify(field.name)} on model ${JSON.stringify(model.name)}.`,
        );
      }
      seenFields.add(field.name);
      if (typeof field.required !== 'boolean' || typeof field.serverOnly !== 'boolean') {
        fail(
          'malformed_descriptor',
          `Invalid field ${JSON.stringify(field.name)} on model ${JSON.stringify(model.name)}: ` +
            'required and serverOnly must be booleans.',
        );
      }
      let array: { readonly required: boolean } | undefined;
      if (field.array !== undefined) {
        if (!isRecord(field.array) || typeof field.array.required !== 'boolean') {
          fail(
            'malformed_descriptor',
            `Invalid field ${JSON.stringify(field.name)} on model ${JSON.stringify(model.name)}: ` +
              'array markers carry a boolean required.',
          );
        }
        array = { required: field.array.required };
      }
      const what = `field ${JSON.stringify(field.name)} on model ${JSON.stringify(model.name)}`;
      const nullable = checkModelNullable(field as unknown as Record<string, unknown>, what);
      const tagMember = Object.getOwnPropertyDescriptor(field, 'field');
      if (tagMember !== undefined && !Object.hasOwn(tagMember, 'value')) fail('malformed_descriptor', `Invalid ${what}: field tag must be own data.`);
      const tag: unknown = tagMember?.value;
      const kindMember = isRecord(tag) ? Object.getOwnPropertyDescriptor(tag, 'kind') : undefined;
      if (kindMember !== undefined && !Object.hasOwn(kindMember, 'value')) fail('malformed_descriptor', `Invalid ${what}: field kind must be own data.`);
      const delivery = kindMember?.value === 'delivery' ? checkModelDelivery(tag, what, valueTypes) : undefined;
      const fallback = checkDefault(field.default, what);
      let machine: ReturnType<typeof checkFieldMachine> | undefined;
      if (field.machine !== undefined) {
        try { machine = checkFieldMachine(field.machine); }
        catch (error) { fail('malformed_descriptor', `Invalid ${what}: ${String(error)}`); }
        if (field.required !== false || field.serverOnly !== false || field.nullable === true ||
            array !== undefined || !isRecord(tag) || kindMember?.value !== 'enum' || !Array.isArray(tag.values) ||
            tag.values.length !== machine.states.length || tag.values.some((state, index) => state !== machine!.states[index]) ||
            fallback?.kind !== 'literal' || fallback.value !== machine.initial) {
          fail('malformed_descriptor', `Invalid ${what}: machine requires a nonnullable enum with matching states and literal initial default.`);
        }
      }
      const valueType = artifactValueType(field as unknown as Record<string, unknown>, what, false, valueSchema, modelNames);
      checkContextDefault(fallback, valueType, field.required, field.serverOnly, array, what);
      checkFieldConstraints(field as unknown as Record<string, unknown>, valueType, what, valueSchema);
      fields[field.name] = {
        ...(valueType !== undefined ? { valueType } : {}),
        ...(Object.hasOwn(field, 'trim') ? { trim: field.trim } : {}),
        ...(Object.hasOwn(field, 'min') ? { min: field.min } : {}),
        ...(Object.hasOwn(field, 'max') ? { max: field.max } : {}),
        ...(nullable !== undefined ? { nullable } : {}),
        ...(delivery !== undefined ? { delivery } : {}),
        required: field.required,
        serverOnly: field.serverOnly,
        ...(array !== undefined ? { array } : {}),
        ...(fallback !== undefined ? { default: fallback } : {}),
        ...(machine !== undefined ? { machine } : {}),
      };
      // T18 engine-local channels (the frozen intake has no slots; the
      // model-table builder consumes these beside the intake, like refs).
      // `init` rides `server` defaults only (`checkDefault` already folds
      // the kind; anything there on other kinds is additive tolerance).
      // Absent `init` reads as unspecified (pre-T18 artifacts): the
      // engine resolves nothing — never invented. `computed` rejects the
      // WHOLE set: silent absence would be wrong, so T04b vocabulary is
      // required, not optional.
      if (fallback?.kind === 'server') {
        const declared = field.default;
        const rawInit: unknown =
          declared !== undefined && declared.kind === 'server' ? declared.init : undefined;
        if (rawInit !== undefined) {
          if (typeof rawInit !== 'string') {
            fail(
              'malformed_descriptor',
              `Invalid ${what}: server init tokens are strings.`,
            );
          }
          if (rawInit === 'computed') {
            fail(
              'unsupported_server_init',
              `Invalid ${what}: this server initializer needs T04b vocabulary and ` +
                'cannot load in the T18 core scope.',
            );
          }
          if (!KNOWN_SERVER_INITS.has(rawInit)) {
            fail(
              'malformed_descriptor',
              `Unknown server init ${JSON.stringify(rawInit)} for ${what}; ` +
                'supported: actor, now, random_secret.',
            );
          }
          modelInits.set(field.name, rawInit as ServerInitKind);
        }
      }
      // Additive `nullable: true` marks known-nullable fields (omitted
      // fills null on create, L2 parity); anything else reads as unknown
      // and never rejects (hand-built fixtures omit it).
      if (field.nullable === true) {
        modelNullable.add(field.name);
      }
      // Engine-local ref derivation: singular top-level `ref` tags become
      // pipeline ref paths (archived-target + disposal enforcement). Every
      // other tag is ignored by ref derivation; the exact typed
      // association above is independent of this channel.
      if (Object.hasOwn(field, 'field') && isRecord(tag) && Object.hasOwn(tag, 'kind') && tag.kind === 'secret') {
        modelSecrets.add(field.name);
      }
      if (isRecord(tag) && kindMember?.value === 'ref' && array === undefined) {
        if (typeof tag['model'] !== 'string' || tag['model'] === '') {
          fail('malformed_descriptor', `Invalid ${what}: ref fields name a non-empty model.`);
        }
        const target = tag['model'] as string;
        if (!modelNames.has(target)) {
          fail(
            'dangling_reference',
            `Invalid ${what}: model ${JSON.stringify(target)} has no descriptor in this set.`,
          );
        }
        modelRefs.push({ field: field.name, model: target as ModelName });
      }
      // Membership and the complete canonical descriptor share the checked tag.
      // Arrays retain membership independently of container nullability.
      if (delivery !== undefined) modelDelivery.push(field.name);
    }
    if (typeof model.deleteMode !== 'string' || !KNOWN_DELETE_MODES.has(model.deleteMode)) {
      fail(
        'malformed_descriptor',
        `Invalid artifact model ${JSON.stringify(model.name)}: deleteMode is archive, remove, or none.`,
      );
    }
    models.push({
      name: model.name as ModelName,
      fields,
      deleteMode: model.deleteMode as DeleteMode,
      ...(model.uniqueKeys !== undefined ? { uniqueKeys: [...model.uniqueKeys] } : {}),
    });
    refs.set(model.name as ModelName, modelRefs);
    serverInits.set(model.name as ModelName, modelInits);
    nullableFields.set(model.name as ModelName, modelNullable);
    secretFields.set(model.name as ModelName, modelSecrets);
    deliveryEntries.push([model.name, modelDelivery]);
    // B5 declared ownership (adopted T28-A): `parent` marks a contained
    // child of that canonical model; `scope: 'app'` marks an app root;
    // neither marks a team-scope root (the default — the empty entry
    // still arms root enforcement). Dangling parents reject the whole
    // set (mirroring ref targets); cycles reject at table build.
    const ownership = `containment on model ${JSON.stringify(model.name)}`;
    const declaredParent: unknown = model.parent;
    const declaredScope: unknown = model.scope;
    if (declaredParent !== undefined) {
      if (typeof declaredParent !== 'string' || declaredParent === '') {
        fail(
          'malformed_descriptor',
          `Invalid ${ownership}: parent must be a non-empty model name.`,
        );
      }
      if (!modelNames.has(declaredParent)) {
        fail(
          'dangling_reference',
          `Invalid ${ownership}: model ${JSON.stringify(declaredParent)} has no descriptor in this set.`,
        );
      }
    }
    if (declaredScope !== undefined && declaredScope !== 'app') {
      fail(
        'malformed_descriptor',
        `Invalid ${ownership}: scope is "app" when present.`,
      );
    }
    if (declaredParent !== undefined && declaredScope !== undefined) {
      fail(
        'malformed_descriptor',
        `Invalid ${ownership}: parent and scope are mutually exclusive.`,
      );
    }
    containment.set(model.name as ModelName, {
      ...(declaredParent !== undefined ? { parent: declaredParent as ModelName } : {}),
      ...(declaredScope !== undefined ? { scope: 'app' as const } : {}),
    });
  }
  const operations: CanonicalOperationDescriptor[] = [];
  const inputArrays: Record<string, Record<string, { readonly required: boolean }>> = {};
  const inputNullableRefs: Record<string, Record<string, true>> = Object.create(null) as Record<string, Record<string, true>>;
  for (const operation of rawOperations as ArtifactOperation[]) {
    if (typeof operation.name !== 'string' || operation.name === '') {
      fail('malformed_descriptor', 'Invalid artifact operation: operations need non-empty names.');
    }
    if (typeof operation.kind !== 'string' || !KNOWN_OPERATION_KINDS.has(operation.kind)) {
      fail(
        'unknown_operation_kind',
        `Unknown operation kind ${JSON.stringify(operation.kind)} on ` +
          `${JSON.stringify(operation.name)}; supported: read, create, update, delete, scenario.`,
      );
    }
    const rawInputs = (operation as { inputs?: unknown }).inputs;
    if (!isRecord(rawInputs) || !Array.isArray(rawInputs['fields'])) {
      fail(
        'malformed_descriptor',
        `Invalid artifact operation ${JSON.stringify(operation.name)}: inputs.fields must be an array.`,
      );
    }
    const inputs: CanonicalInputDef[] = [];
    const seenInputs = new Set<string>();
    const opArrays: Record<string, { readonly required: boolean }> = Object.create(null) as Record<string, { readonly required: boolean }>;
    const opNullableRefs: Record<string, true> = Object.create(null) as Record<string, true>;
    for (const input of rawInputs['fields'] as ArtifactOperation['inputs']['fields']) {
      if (typeof input.name !== 'string' || input.name === '') {
        fail(
          'malformed_descriptor',
          `Invalid artifact operation ${JSON.stringify(operation.name)}: inputs need non-empty names.`,
        );
      }
      if (seenInputs.has(input.name)) {
        fail(
          'duplicate_name',
          `Duplicate input ${JSON.stringify(input.name)} on operation ` +
            `${JSON.stringify(operation.name)}.`,
        );
      }
      seenInputs.add(input.name);
      const what =
        `input ${JSON.stringify(input.name)} on operation ${JSON.stringify(operation.name)}`;
      const tag = input.field as { kind?: unknown };
      if (!isRecord(input.field) || typeof tag['kind'] !== 'string') {
        fail('malformed_descriptor', `Invalid ${what}: input fields need a kind tag.`);
      }
      const inputKind = tag['kind'] as string;
      if (!KNOWN_INPUT_KINDS.has(inputKind)) {
        fail(
          'unknown_input_kind',
          `Unknown input kind ${JSON.stringify(inputKind)} for ${what}; ` +
            'supported: ref, string, integer, decimal, money, datetime, duration, user, boolean, file, enum, nominal, delivery.',
        );
      }
      if (typeof input.required !== 'boolean') {
        fail('malformed_descriptor', `Invalid ${what}: required must be a boolean.`);
      }
      const arrayMember = Object.getOwnPropertyDescriptor(input, 'array');
      if (arrayMember === undefined && 'array' in input || arrayMember !== undefined && !Object.hasOwn(arrayMember, 'value')) fail('malformed_descriptor', `Invalid ${what}: array must be own data.`);
      const checkedArray = arrayMember === undefined ? undefined : checkInputArrayMarker(arrayMember.value, what);
      const nullableMember = inputKind === 'ref' ? Object.getOwnPropertyDescriptor(input, 'nullable') : undefined;
      if (inputKind === 'ref') {
        if (nullableMember === undefined && 'nullable' in input || nullableMember !== undefined && (!Object.hasOwn(nullableMember, 'value') || typeof nullableMember.value !== 'boolean')) fail('malformed_descriptor', `Invalid ${what}: nullable must be an own boolean.`);
      }
      const refNullable = nullableMember === undefined ? undefined : nullableMember.value as boolean;
      const bounds = checkInputArrayBounds(input as unknown as Record<string, unknown>, what, checkedArray !== undefined);
      const fallback = checkDefault(input.default, what);
      const valueType = artifactValueType(input as unknown as Record<string, unknown>, what, true, valueSchema);
      const computedDefault = checkComputedDefault(input as unknown as Record<string, unknown>,
        operation.kind, inputKind, valueType, input.required, what);
      if (computedDefault === true && checkedArray?.required === true) {
        fail('malformed_descriptor', `Invalid ${what}: computedDefault requires an ordinary array marker.`);
      }
      if (inputKind === 'ref') {
        const refTag = input.field as { model?: unknown; requireVersion?: unknown };
        if (typeof refTag['model'] !== 'string' || refTag['model'] === '') {
          fail('malformed_descriptor', `Invalid ${what}: ref inputs name a non-empty model.`);
        }
        if (typeof refTag['requireVersion'] !== 'boolean') {
          fail('malformed_descriptor', `Invalid ${what}: requireVersion must be a boolean.`);
        }
        const target = refTag['model'] as string;
        if (!modelNames.has(target)) {
          fail(
            'dangling_reference',
            `Invalid ${what}: model ${JSON.stringify(target)} has no descriptor in this set.`,
          );
        }
        inputs.push({
          ...bounds,
          name: input.name,
          kind: 'ref',
          ...(checkedArray !== undefined ? { array: checkedArray } : {}),
          ...(refNullable !== undefined ? { nullable: refNullable } : {}),
          model: target as ModelName,
          versioned: refTag['requireVersion'] as boolean,
          required: input.required,
          ...(computedDefault !== undefined ? { computedDefault } : {}),
          ...(fallback !== undefined ? { default: fallback } : {}),
        });
      } else if (inputKind === 'nominal') {
        inputs.push({ ...bounds, name: input.name, kind: 'nominal', valueType: valueType!, required: input.required,
          ...(computedDefault !== undefined ? { computedDefault } : {}),
          ...(fallback !== undefined ? { default: fallback } : {}) });
      } else if (inputKind === 'enum') {
        const enumTag = input.field as { values?: unknown };
        if (
          !Array.isArray(enumTag['values']) ||
          (enumTag['values'] as unknown[]).some(
            (entry) => typeof entry !== 'string' || entry === '',
          )
        ) {
          fail(
            'malformed_descriptor',
            `Invalid ${what}: enum inputs carry values as an array of non-empty strings.`,
          );
        }
        inputs.push({
          ...bounds,
          name: input.name,
          kind: 'enum',
          required: input.required,
          enumValues: [...(enumTag['values'] as string[])],
          ...(valueType !== undefined ? { valueType } : {}),
          ...(computedDefault !== undefined ? { computedDefault } : {}),
          ...(fallback !== undefined ? { default: fallback } : {}),
        });
      } else if (inputKind === 'delivery') {
        // T04b §10.1 delivery-input join: the artifact delivery tag carries
        // the fenced T13 binding. A top-level valueType with a delivery tag
        // already fails in artifactValueType above; nullable drops like
        // scalars (no canonical slot); array markers travel the engine
        // opArrays channel via the generic path below; computedDefault=true
        // already fails in checkComputedDefault above.
        const delivery = checkInputDeliveryDescriptor(
          (input.field as { kind?: unknown }) as unknown, what, valueTypes,
        );
        inputs.push({
          ...bounds,
          name: input.name,
          kind: 'delivery',
          delivery,
          required: input.required,
          ...(fallback !== undefined ? { default: fallback } : {}),
        });
      } else {
        inputs.push({
          ...bounds,
          name: input.name,
          kind: inputKind as CanonicalScalarKind,
          ...(computedDefault !== undefined ? { computedDefault } : {}),
          ...(valueType !== undefined ? { valueType } : {}),
          required: input.required,
          ...(fallback !== undefined ? { default: fallback } : {}),
        });
      }
      if (inputKind === 'ref' && refNullable === true && checkedArray === undefined) {
        opNullableRefs[input.name] = true;
      }
      // Keep the joined engine channel for every array kind; ref inputs also
      // retain their checked source carrier on the canonical descriptor.
      if (checkedArray !== undefined) {
        opArrays[input.name] = { required: checkedArray.required };
      }
    }
    const result = checkResult(operation as unknown as Record<string, unknown>, `operation ${JSON.stringify(operation.name)}`, operation.kind, modelNames, valueSchema);
    if (result?.disclosure !== undefined) {
      const copies = installedDisclosureCopies(result.disclosure);
      const source = copies[0]!.source;
      const modulePaths = artifactPolicyModulePaths(artifact as unknown as Record<string, unknown>);
      const callableMember = Object.getOwnPropertyDescriptor(artifact, 'callables');
      if (callableMember === undefined || !('value' in callableMember) || !Array.isArray(callableMember.value)) {
        fail('malformed_descriptor', 'Scenario dependency plan requires its actual callable inventory.');
      }
      let matches = 0;
      for (let i = 0; i < callableMember.value.length; i += 1) {
        const item = Object.getOwnPropertyDescriptor(callableMember.value, String(i));
        if (item === undefined || !('value' in item) || !isRecord(item.value)) fail('malformed_descriptor', 'Invalid scenario callable inventory.');
        const callable = Object.getOwnPropertyDescriptors(item.value);
        for (const key of ['kind', 'id', 'module']) if (callable[key] === undefined || !('value' in callable[key]!)) {
          fail('malformed_descriptor', 'Scenario callable identity requires own data.');
        }
        // C24 scope-1: an internal trusted-handler registration carries
        // its checked disclosure inside the private invocation only.
        // Public `artifact.operations` still excludes every trusted
        // handler; this admits the exact handler callable (kind
        // `handler`) with the same single-match/module/source checks,
        // never a second public operation.
        if ((callable['kind']!.value === 'operation' || callable['kind']!.value === 'handler') && callable['id']!.value === operation.name && callable['module']!.value === source.module) matches += 1;
      }
      const origins = [source, ...copies.flatMap(copy => copy.returns.flatMap(returned =>
        [returned.source, ...returned.dependencies.map(dependency => dependency.source),
          ...(returned.intrinsics ?? []).map(dependency => dependency.source),
          ...(returned.projection === undefined ? [] : [returned.projection.source])])),
        ...(copies[0]!.queries ?? []).flatMap(query => [query.source, ...(query.parent === undefined ? [] : [query.parent.source]), ...query.dependencies.map(dependency => dependency.source)])];
      if (origins.some(origin => !sources?.some(entry => entry.path === origin.path && entry.sha256 === origin.sha256) ||
            !modulePaths.includes(origin.module)) || matches !== 1) {
        fail('malformed_descriptor', 'Scenario dependency plan disagrees with its exact artifact source/callable module.');
      }
    }
    operations.push({
      name: operation.name as OperationName,
      kind: operation.kind as CanonicalOperationDescriptor['kind'],
      inputs,
      ...(result !== undefined ? { result } : {}),
    });
    if (Object.keys(opNullableRefs).length > 0) {
      inputNullableRefs[operation.name] = opNullableRefs;
    }
    if (Object.keys(opArrays).length > 0) {
      inputArrays[operation.name] = opArrays;
    }
  }
  // BGI-08: keyword rules bind against the folded models (a rule may
  // target a trait-contributed text field; builtin-unique clashes refuse).
  const givenUniqueKeys = checkGivenKeywordBindings(givenContracts.keywords, models);
  const givenFieldValidations = checkGivenFieldBindings(givenContracts.traits, models);
  if (givenFieldValidations.length !== 0 && (!Array.isArray(artifact['requires']) || !artifact['requires'].some(requirement =>
    isRecord(requirement) && requirement['capability'] === 'state.field-validation' && requirement['min_version'] === 1))) {
    fail('version_mismatch', 'Field validation requires the state.field-validation v1 capability claim.');
  }
  // uniqueKeys/composite checks and CRUD executability run in the shared
  // intake loader; conversion folds shapes only. Reuse it via a synthetic
  // set so the rules live in exactly one place.
  const set: ExecutionDescriptorSet = {
    contractVersion: EXECUTION_CONTRACT_VERSION,
    ...(valueTypes !== undefined ? { valueTypes } : {}),
    operations,
    models,
  };
  // B3: one entry per model (empty for models without deliveries, so
  // downstream joins report unknown-field — never unknown-model — for
  // them). `createDeliverySchema` is the shared builder: its
  // validation doubles as this conversion's whole-set guard.
  const deliveryFields = createDeliverySchema(deliveryEntries);
  let modelPolicies: readonly CanonicalOwnerModelPolicies[] | undefined;
  if (policyClaim !== undefined) {
    try {
      modelPolicies = checkOwnerModelPolicyDescriptors({ descriptors: policyClaim.value,
        models: new Map(models.map(model => [model.name, model])), modules: policyModules! });
    } catch (error) {
      if (error instanceof StateError && error.code === 'validation') fail('malformed_descriptor', error.message);
      throw error;
    }
  }
  return {
    ...(valueSchema !== undefined ? { valueSchema } : {}),
    set, refs, inputArrays, inputNullableRefs, serverInits, nullableFields, secretFields, containment, deliveryFields,
    givenUniqueKeys,
    givenFieldValidations,
    ...(modelPolicies !== undefined ? { modelPolicies } : {}),
    ...(sources !== undefined ? { sources } : {}),
  };
}

/**
 * Load a compiled artifact's T15a descriptor slice end to end: convert
 * (`artifactToDescriptorSet`) then load (`loadExecutionDescriptorSet`) with
 * the caller's engine-local policy. Any unknown kind or malformed member
 * rejects the WHOLE artifact with `IncompatibleArtifactError`.
 */
export function loadArtifactDescriptors(
  artifact: ArtifactDescriptorSlice,
  opts: Omit<LoadDescriptorSetOptions, 'inputArrays' | 'inputNullableRefs'>,
): LoadedArtifactDescriptors {
  const converted = artifactToDescriptorSet(artifact);
  const loaded = loadCheckedDescriptorSet(converted.set, {
    by: opts.by,
    ...(opts.when !== undefined ? { when: opts.when } : {}),
    inputArrays: converted.inputArrays,
    inputNullableRefs: converted.inputNullableRefs,
  }, converted);
  for (const def of loaded.registry.values()) {
    if (!isGeneratedOperationDef(def) || def.descriptor.result?.disclosure === undefined) continue;
    try {
      const callable = Array.prototype.find.call(artifact.callables ?? [], (item: ArtifactCallable) =>
        item.kind === 'operation' && item.id === def.name &&
        item.module === installedDisclosureCopies(def.descriptor.result!.disclosure!)[0]!.source.module) as ArtifactCallable | undefined;
      const style = callable === undefined ? undefined : Object.getOwnPropertyDescriptor(callable, 'inputStyle');
      if ((callable !== undefined && 'inputStyle' in callable && style === undefined) ||
          (style !== undefined && (!('value' in style) || !style.enumerable || style.value !== 'parameters'))) {
        fail('malformed_descriptor', 'Scenario default callable input style requires own parameter-style data.');
      }
      bindScenarioReceiptPlan(def, artifact.models ?? [], { parameterStyle: style?.value === 'parameters', canonicalModels: loaded.models,
        ...(converted.valueSchema !== undefined ? { valueSchema: converted.valueSchema } : {}),
        ...(loaded.valueTypes !== undefined ? { valueTypes: loaded.valueTypes } : {}) });
    }
    catch (error) { fail('malformed_descriptor', error instanceof Error ? error.message : 'Invalid scenario disclosure inventory.'); }
  }
  const refs: Map<ModelName, ReadonlyArray<InterimRefDef>> = new Map();
  for (const [model, modelRefs] of converted.refs) {
    refs.set(model, deepFreezeLoaded([...modelRefs]));
  }
  // Fresh maps per load (caller-owned, like `refs` above): the inner
  // contents are immutable primitives, so no deeper freeze applies.
  const serverInits: Map<ModelName, ReadonlyMap<string, ServerInitKind>> = new Map(
    [...converted.serverInits].map(([model, inits]) => [model, new Map(inits)]),
  );
  const nullableFields: Map<ModelName, ReadonlySet<string>> = new Map(
    [...converted.nullableFields].map(([model, names]) => [model, new Set(names)]),
  );
  const containment: Map<ModelName, InterimContainment> = new Map(
    [...converted.containment].map(([model, declared]) => [model, { ...declared }]),
  );
  const secretFields: Map<ModelName, ReadonlySet<string>> = new Map(
    [...converted.secretFields].map(([model, names]) => [model, new Set(names)]),
  );
  const deliveryFields: Map<ModelName, ReadonlySet<string>> = new Map(
    [...converted.deliveryFields].map(([model, fields]) => [model, new Set(fields)]),
  );
  return {
    registry: loaded.registry,
    models: loaded.models,
    ...(loaded.valueSchema !== undefined ? { valueSchema: loaded.valueSchema } : {}),
    ...(loaded.valueTypes !== undefined ? { valueTypes: loaded.valueTypes } : {}),
    ...(converted.sources !== undefined ? { sources: converted.sources } : {}),
    ...(converted.modelPolicies !== undefined ? { modelPolicies: converted.modelPolicies } : {}),
    refs,
    serverInits,
    nullableFields,
    secretFields,
    containment,
    deliveryFields,
    givenUniqueKeys: deepFreezeLoaded([...converted.givenUniqueKeys]),
    givenFieldValidations: deepFreezeLoaded([...converted.givenFieldValidations]),
  };
}
