import { checkFieldMachine } from '../internal/machine.js';
import { parseTypeId } from '@canlang/values';
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
  type CanonicalFieldDefault,
  type CanonicalInputDef,
  type CanonicalModelDescriptor,
  type CanonicalOperationDescriptor,
  type CanonicalOperationKind,
  type CanonicalScalarKind,
  type DeleteMode,
  type ExecutionDescriptorSet,
  type ModelName,
  type OperationName,
  type QueryPredicate,
} from '@canlang/contracts';
import type {
  ArtifactModel,
  ArtifactOperation,
  ArtifactSource,
  CanTypeId,
  CompileArtifact,
} from '@canlang/contracts';
import { validateByPredicate, type ByPredicate } from '../policy/roles.js';
import { validatePredicateShape } from '../policy/grants.js';
import type { InterimContainment, InterimRefDef } from '../mutation/models.js';
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
 * array markers (`ArtifactOperationInput.array`) the frozen T04a intake
 * cannot hold; admission fills omitted ordinary arrays from it (T16 honors
 * the marker; T04b formalizes array admission). Empty for intake-direct
 * loads, which carry no input array info.
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
  | 'unsupported_server_init';

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
}

/** The artifact slice the join consumes (L7 owns `requires` fulfillment). */
export type ArtifactDescriptorSlice = Pick<
  CompileArtifact,
  'artifact_version' | 'operations' | 'models'
> & Partial<Pick<CompileArtifact, 'sources'>>;

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
  readonly sources?: ReadonlyArray<Readonly<ArtifactSource>>;
  readonly set: ExecutionDescriptorSet;
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
}

/** Fully loaded artifact: registry + models + engine-local model attachments. */
export interface LoadedArtifactDescriptors extends LoadedDescriptorSet {
  /** Copied compilation inputs identify this load; they confer no authority. */
  readonly sources?: ReadonlyArray<Readonly<ArtifactSource>>;
  readonly refs: ReadonlyMap<ModelName, ReadonlyArray<InterimRefDef>>;
  readonly serverInits: ReadonlyMap<ModelName, ReadonlyMap<string, ServerInitKind>>;
  readonly nullableFields: ReadonlyMap<ModelName, ReadonlySet<string>>;
  /** Typed-secret field names, independent of caller-input serverOnly restrictions. */
  readonly secretFields: ReadonlyMap<ModelName, ReadonlySet<string>>;
  readonly containment: ReadonlyMap<ModelName, InterimContainment>;
  readonly deliveryFields: DeliveryFieldSchema;
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
]);

const KNOWN_DEFAULT_KINDS: ReadonlySet<string> = new Set([
  'literal',
  'parent',
  'server',
  'derived',
]);

/** T18 closed server-init tokens the engine resolves (L1 `ArtifactServerInit` minus `computed`). */
const KNOWN_SERVER_INITS: ReadonlySet<string> = new Set(['actor', 'now', 'random_secret']);

const KNOWN_DELETE_MODES: ReadonlySet<string> = new Set(['archive', 'remove', 'none']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Additive claims are own-only; nullable suffix applies to the container. */
function checkResult(
  holder: Record<string, unknown>,
  what: string,
  kind: string,
  modelNames: ReadonlySet<string>,
): CanonicalOperationDescriptor['result'] {
  if (!Object.hasOwn(holder, 'result')) return undefined;
  const result = holder['result'];
  if (!isRecord(result) || !Object.hasOwn(result, 'type')) {
    fail('malformed_descriptor', `Invalid ${what}: result must declare an int/datetime/text/bool/decimal/money/date/duration/user/file profile or bare void.`);
  }
  const type = result['type'];
  const scalarOrVoid = type === 'void' || (typeof type === 'string' &&
    /^(int|datetime|text|bool|decimal|money|date|duration|user|file)(\[\])?\??$/.test(type));
  let knownModelResult = false;
  // Ordinary operations may return a nonnullable singular loaded model;
  // reads alone may return an ordinary array. Spelling alone proves no model.
  if (!scalarOrVoid && (kind === 'scenario' || kind === 'read') && typeof type === 'string') {
    try {
      const parsed = parseTypeId(type);
      knownModelResult = parsed.base.kind === 'nominal' && parsed.base.path.includes('.') &&
        modelNames.has(parsed.base.path) && !parsed.nullable && !parsed.requiredArray &&
        (!parsed.array || kind === 'read');
    } catch {
      // The shared artifact error below covers malformed canonical spellings.
    }
  }
  if (!scalarOrVoid && !knownModelResult) {
    fail('malformed_descriptor', `Invalid ${what}: result must declare an int/datetime/text/bool/decimal/money/date/duration/user/file profile or bare void; scenarios and reads may also declare a known qualified model, and reads a model[].`);
  }
  return Object.freeze({ type: type as CanTypeId });
}

function checkValueType(field: Record<string, unknown>, what: string): CanTypeId | undefined {
  if (!Object.hasOwn(field, 'valueType')) return undefined;
  const type = field['valueType'];
  if (typeof type !== 'string' || !/^(int|datetime|text|bool|decimal|money|date|duration|user|file)(\[\])?\??$/.test(type)) {
    fail('malformed_descriptor', `Invalid ${what}: valueType must declare an int/datetime/text/bool/decimal/money/date/duration/user/file profile.`);
  }
  if (Object.hasOwn(field, 'nullable') &&
      (typeof field['nullable'] !== 'boolean' || type.endsWith('?') !== field['nullable'])) {
    fail('malformed_descriptor', `Invalid ${what}: valueType disagrees with nullable marker.`);
  }
  return type;
}

function checkTypeArray(type: CanTypeId | undefined, array: boolean, what: string): void {
  if (type !== undefined && type.includes('[]') !== array) {
    fail('malformed_descriptor', `Invalid ${what}: valueType disagrees with array marker.`);
  }
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
function artifactValueType(field: Record<string, unknown>, what: string, operationInput = false): CanTypeId | undefined {
  if (Object.hasOwn(field, 'valueType')) {
    checkTypeArray(checkValueType(field, what), field['array'] !== undefined, what);
  }
  const tag = field['field'];
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
  const base = operationInput && tag['kind'] === 'string' &&
    typeof field['valueType'] === 'string' && field['valueType'].replace(/\[\]|\?/g, '') === 'date'
    ? 'date' : scalarTypeForKind(tag['kind']);
  const type = `${base}${field['array'] !== undefined ? '[]' : ''}${Object.hasOwn(field, 'nullable') && field['nullable'] === true ? '?' : ''}`;
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
        'supported: literal, parent, server, derived.',
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
  if (kind === 'server') return { kind: 'server' };
  return { kind: 'derived' };
}

/** A computed default is an own omission claim, never a wire default value. */
function checkComputedDefault(
  input: Record<string, unknown>, operationKind: unknown, inputKind: unknown,
  valueType: CanTypeId | undefined, required: boolean, what: string,
): true | undefined {
  if (!Object.hasOwn(input, 'computedDefault')) return undefined;
  if (input['computedDefault'] !== true || (operationKind !== 'scenario' && operationKind !== 'read') || required ||
      scalarTypeForKind(inputKind) === undefined || valueType === undefined ||
      Object.hasOwn(input, 'default') || input['default'] !== undefined) {
    fail('malformed_descriptor', `Invalid ${what}: computedDefault requires true on an optional checked scalar scenario or read input without a wire default.`);
  }
  return true;
}

/** Validate one canonical operation input; `modelNames` resolves ref targets. */
function checkCanonicalInput(
  value: unknown,
  opName: string,
  modelNames: ReadonlySet<string>,
  operationKind: unknown,
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
        'supported: ref, string, integer, decimal, money, datetime, duration, user, boolean, file, enum.',
    );
  }
  if (typeof value['required'] !== 'boolean') {
    fail('malformed_descriptor', `Invalid ${what}: required must be a boolean.`);
  }
  const required = value['required'] as boolean;
  const fallback = checkDefault(value['default'], what);
  const valueType = checkValueType(value, what);
  const inputBase = valueType?.replace(/\[\]|\?/g, '');
  if (valueType !== undefined && inputBase !== scalarTypeForKind(kind) &&
      !(kind === 'string' && inputBase === 'date')) {
    fail('malformed_descriptor', `Invalid ${what}: valueType disagrees with input kind.`);
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
      name,
      kind: 'ref',
      model: model as ModelName,
      versioned: value['versioned'] as boolean,
      required,
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
      name,
      kind: 'enum',
      required,
      enumValues: [...(values as string[])],
      ...(fallback !== undefined ? { default: fallback } : {}),
    };
  }
  if (value['enumValues'] !== undefined) {
    fail('malformed_descriptor', `Invalid ${what}: enumValues is present exactly for enum.`);
  }
  return {
    name,
    kind: kind as CanonicalScalarKind,
    ...(computedDefault !== undefined ? { computedDefault } : {}),
    ...(valueType !== undefined ? { valueType } : {}),
    required,
    ...(fallback !== undefined ? { default: fallback } : {}),
  };
}

/** Validate one canonical model descriptor; returns the model name. */
function checkCanonicalModel(value: unknown): CanonicalModelDescriptor {
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
    const valueType = checkValueType(fieldValue, what);
    checkTypeArray(valueType, array !== undefined, what);
    fields[fieldName] = {
      ...(valueType !== undefined ? { valueType } : {}),
      ...(valueType !== undefined && Object.hasOwn(fieldValue, 'nullable') ? { nullable: fieldValue['nullable'] as boolean } : {}),
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
  const models: CanonicalModelDescriptor[] = [];
  const modelNames = new Set<string>();
  for (const model of set['models'] as unknown[]) {
    const checked = checkCanonicalModel(model);
    const name = checked.name as string;
    if (modelNames.has(name)) {
      fail('duplicate_name', `Duplicate model descriptor: ${JSON.stringify(name)}.`);
    }
    modelNames.add(name);
    models.push(checked);
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
      const checked = checkCanonicalInput(input, opName, modelNames, kind);
      if (seenInputs.has(checked.name)) {
        fail(
          'duplicate_name',
          `Duplicate input ${JSON.stringify(checked.name)} on operation ${JSON.stringify(opName)}.`,
        );
      }
      seenInputs.add(checked.name);
      inputs.push(checked);
    }
    const result = checkResult(operation, `operation ${JSON.stringify(opName)}`, kind, modelNames);
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
    const arrayMarkers: Record<string, { readonly required: boolean }> = {};
    const opArrays = opts.inputArrays?.[opName];
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
        if (!isRecord(marker) || typeof marker['required'] !== 'boolean') {
          fail(
            'malformed_descriptor',
            `Invalid input array marker ${JSON.stringify(inputName)} on operation ` +
              `${JSON.stringify(opName)}: markers carry a boolean required.`,
          );
        }
        arrayMarkers[inputName] = { required: marker['required'] as boolean };
      }
    }
    for (const input of inputs) {
      if (input.kind !== 'ref' && input.kind !== 'delivery') {
        checkTypeArray(input.valueType, Object.hasOwn(arrayMarkers, input.name), `input ${JSON.stringify(input.name)} on operation ${JSON.stringify(opName)}`);
        if (input.computedDefault === true && arrayMarkers[input.name]?.required === true) {
          fail('malformed_descriptor', `Invalid input ${JSON.stringify(input.name)} on operation ${JSON.stringify(opName)}: computedDefault requires an ordinary array marker.`);
        }
      }
    }
    // Null proof belongs to this exact checked singular-ref input. Use own
    // keys throughout: prototype slots are neither array markers nor proof.
    const nullableRefs: Record<string, true> = Object.create(null) as Record<string, true>;
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
        if (marker !== true || input.kind !== 'ref' || Object.hasOwn(arrayMarkers, inputName)) {
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
    registry.set(opName, Object.freeze(def));
  }
  if (opts.inputArrays !== undefined) {
    for (const opKey of Object.keys(opts.inputArrays)) {
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
  return { registry, models: deepFreezeLoaded(models) };
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
  const sources = checkSources(artifact);
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
  for (const model of rawModels as ArtifactModel[]) {
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
      const fallback = checkDefault(field.default, what);
      let machine: ReturnType<typeof checkFieldMachine> | undefined;
      if (field.machine !== undefined) {
        try { machine = checkFieldMachine(field.machine); }
        catch (error) { fail('malformed_descriptor', `Invalid ${what}: ${String(error)}`); }
        const tag = field.field;
        if (field.required !== false || field.serverOnly !== false || field.nullable === true ||
            array !== undefined || tag?.kind !== 'enum' || !Array.isArray(tag.values) ||
            tag.values.length !== machine.states.length || tag.values.some((state, index) => state !== machine!.states[index]) ||
            fallback?.kind !== 'literal' || fallback.value !== machine.initial) {
          fail('malformed_descriptor', `Invalid ${what}: machine requires a nonnullable enum with matching states and literal initial default.`);
        }
      }
      const tag: unknown = field.field;
      const valueType = artifactValueType(field as unknown as Record<string, unknown>, what);
      fields[field.name] = {
        ...(valueType !== undefined ? { valueType } : {}),
        ...(valueType !== undefined && Object.hasOwn(field, 'nullable') ? { nullable: field.nullable! } : {}),
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
      if (isRecord(tag) && tag['kind'] === 'ref' && array === undefined) {
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
      // B3 declared delivery fields (T15b provider tags): the receipt
      // join's schema channel. Envelope-validated (capability /
      // operation / version / result shape); result leaves have no
      // state-side consumer — generated callers resolve selected leaves
      // statically — so leaves stay presence-only. Array markers don't
      // affect membership: the field IS a delivery field either way.
      if (isRecord(tag) && tag['kind'] === 'delivery') {
        const capability: unknown = tag['capability'];
        const operation: unknown = tag['operation'];
        const version: unknown = tag['version'];
        if (
          typeof capability !== 'string' ||
          capability === '' ||
          typeof operation !== 'string' ||
          operation === '' ||
          typeof version !== 'number' ||
          !Number.isFinite(version)
        ) {
          fail(
            'malformed_descriptor',
            `Invalid ${what}: delivery descriptors carry a non-empty capability, operation, and finite version.`,
          );
        }
        const result: unknown = tag['result'];
        if (!isRecord(result) || typeof result['name'] !== 'string' || !Array.isArray(result['fields'])) {
          fail(
            'malformed_descriptor',
            `Invalid ${what}: delivery descriptors carry a result with a name and leaf fields.`,
          );
        }
        modelDelivery.push(field.name);
      }
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
    const opArrays: Record<string, { readonly required: boolean }> = {};
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
            'supported: ref, string, integer, decimal, money, datetime, duration, user, boolean, file, enum.',
        );
      }
      if (typeof input.required !== 'boolean') {
        fail('malformed_descriptor', `Invalid ${what}: required must be a boolean.`);
      }
      const fallback = checkDefault(input.default, what);
      const valueType = artifactValueType(input as unknown as Record<string, unknown>, what, true);
      const computedDefault = checkComputedDefault(input as unknown as Record<string, unknown>,
        operation.kind, inputKind, valueType, input.required, what);
      if (computedDefault === true && input.array?.required === true) {
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
          name: input.name,
          kind: 'ref',
          model: target as ModelName,
          versioned: refTag['requireVersion'] as boolean,
          required: input.required,
          ...(fallback !== undefined ? { default: fallback } : {}),
        });
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
          name: input.name,
          kind: 'enum',
          required: input.required,
          enumValues: [...(enumTag['values'] as string[])],
          ...(fallback !== undefined ? { default: fallback } : {}),
        });
      } else {
        inputs.push({
          name: input.name,
          kind: inputKind as CanonicalScalarKind,
          ...(computedDefault !== undefined ? { computedDefault } : {}),
          ...(valueType !== undefined ? { valueType } : {}),
          required: input.required,
          ...(fallback !== undefined ? { default: fallback } : {}),
        });
      }
      if (inputKind === 'ref' && Object.hasOwn(input, 'nullable') && input.nullable === true && input.array === undefined) {
        opNullableRefs[input.name] = true;
      }
      // T15a input array markers ride the engine-local channel (the frozen
      // intake has no slot); T16 honors them, T04b formalizes them.
      if (input.array !== undefined) {
        if (!isRecord(input.array) || typeof input.array.required !== 'boolean') {
          fail('malformed_descriptor', `Invalid ${what}: array markers carry a boolean required.`);
        }
        opArrays[input.name] = { required: input.array.required };
      }
    }
    const result = checkResult(operation as unknown as Record<string, unknown>, `operation ${JSON.stringify(operation.name)}`, operation.kind, modelNames);
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
  // uniqueKeys/composite checks and CRUD executability run in the shared
  // intake loader; conversion folds shapes only. Reuse it via a synthetic
  // set so the rules live in exactly one place.
  const set: ExecutionDescriptorSet = {
    contractVersion: EXECUTION_CONTRACT_VERSION,
    operations,
    models,
  };
  // B3: one entry per model (empty for models without deliveries, so
  // downstream joins report unknown-field — never unknown-model — for
  // them). `createDeliverySchema` is the shared builder: its
  // validation doubles as this conversion's whole-set guard.
  const deliveryFields = createDeliverySchema(deliveryEntries);
  return {
    set, refs, inputArrays, inputNullableRefs, serverInits, nullableFields, secretFields, containment, deliveryFields,
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
  const loaded = loadExecutionDescriptorSet(converted.set, {
    by: opts.by,
    ...(opts.when !== undefined ? { when: opts.when } : {}),
    inputArrays: converted.inputArrays,
    inputNullableRefs: converted.inputNullableRefs,
  });
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
    ...(converted.sources !== undefined ? { sources: converted.sources } : {}),
    refs,
    serverInits,
    nullableFields,
    secretFields,
    containment,
    deliveryFields,
  };
}
