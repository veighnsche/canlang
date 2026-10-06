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
 * unknown model field tags) never reject.
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
} from '../../../contracts/src/state.js';
import type {
  ArtifactModel,
  ArtifactOperation,
  CompileArtifact,
} from '../../../contracts/src/artifact.js';
import { validateByPredicate, type ByPredicate } from '../policy/roles.js';
import { validatePredicateShape } from '../policy/grants.js';
import type { InterimContainment, InterimRefDef } from '../mutation/models.js';

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
>;

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
 * known-nullable field names (both keyed by model, then field), and B5
 * declared ownership per model (additive `parent`/`scope` members the
 * frozen intake cannot hold; one entry per model, empty for declared
 * team-scope roots).
 */
export interface ConvertedArtifactDescriptors {
  readonly set: ExecutionDescriptorSet;
  readonly refs: ReadonlyMap<ModelName, ReadonlyArray<InterimRefDef>>;
  readonly inputArrays: Readonly<
    Record<string, Readonly<Record<string, { readonly required: boolean }>>>
  >;
  readonly serverInits: ReadonlyMap<ModelName, ReadonlyMap<string, ServerInitKind>>;
  readonly nullableFields: ReadonlyMap<ModelName, ReadonlySet<string>>;
  readonly containment: ReadonlyMap<ModelName, InterimContainment>;
}

/** Fully loaded artifact: registry + models + engine-local model attachments. */
export interface LoadedArtifactDescriptors extends LoadedDescriptorSet {
  readonly refs: ReadonlyMap<ModelName, ReadonlyArray<InterimRefDef>>;
  readonly serverInits: ReadonlyMap<ModelName, ReadonlyMap<string, ServerInitKind>>;
  readonly nullableFields: ReadonlyMap<ModelName, ReadonlySet<string>>;
  readonly containment: ReadonlyMap<ModelName, InterimContainment>;
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

/** Validate one canonical operation input; `modelNames` resolves ref targets. */
function checkCanonicalInput(
  value: unknown,
  opName: string,
  modelNames: ReadonlySet<string>,
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
        'supported: ref, string, integer, decimal, money, datetime, boolean, file, enum.',
    );
  }
  if (typeof value['required'] !== 'boolean') {
    fail('malformed_descriptor', `Invalid ${what}: required must be a boolean.`);
  }
  const required = value['required'] as boolean;
  const fallback = checkDefault(value['default'], what);
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
    fields[fieldName] = {
      required: fieldValue['required'] as boolean,
      serverOnly: fieldValue['serverOnly'] as boolean,
      ...(array !== undefined ? { array } : {}),
      ...(fallback !== undefined ? { default: fallback } : {}),
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
      const checked = checkCanonicalInput(input, opName, modelNames);
      if (seenInputs.has(checked.name)) {
        fail(
          'duplicate_name',
          `Duplicate input ${JSON.stringify(checked.name)} on operation ${JSON.stringify(opName)}.`,
        );
      }
      seenInputs.add(checked.name);
      inputs.push(checked);
    }
    const descriptor: CanonicalOperationDescriptor = {
      name: opName as OperationName,
      kind: kind as CanonicalOperationDescriptor['kind'],
      inputs,
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
    const def: GeneratedOperationDef = {
      generated: true,
      name: opName as OperationName,
      kind: kind as CanonicalOperationKind,
      descriptor: deepFreezeLoaded(descriptor),
      by: frozenBy,
      ...(when !== undefined ? { when: deepFreezeLoaded(when) } : {}),
      inputArrays: deepFreezeLoaded(arrayMarkers),
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
  return { registry, models: deepFreezeLoaded(models) };
}

/**
 * Convert a compiled artifact's T15a descriptor slice into the folded T04a
 * intake: `artifact_version` must equal 1 (the pinned artifact contract);
 * absent `operations`/`models` read as "no descriptors", never as an error;
 * model `fields` arrays fold into records by name and additive members drop
 * (except the engine-local channels — T18 server inits and known-nullable
 * names plus B5 declared ownership — which ride beside the intake like
 * refs). Unknown operation/input/default kinds — or any
 * malformed/dangling member — reject the WHOLE conversion.
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
  const containment = new Map<ModelName, InterimContainment>();
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
      fields[field.name] = {
        required: field.required,
        serverOnly: field.serverOnly,
        ...(array !== undefined ? { array } : {}),
        ...(fallback !== undefined ? { default: fallback } : {}),
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
      // other tag — scalars, enum, T04b previews, unknown futures — is
      // ignored per the T04a intake contract.
      const tag: unknown = field.field;
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
            'supported: ref, string, integer, decimal, money, datetime, boolean, file, enum.',
        );
      }
      if (typeof input.required !== 'boolean') {
        fail('malformed_descriptor', `Invalid ${what}: required must be a boolean.`);
      }
      const fallback = checkDefault(input.default, what);
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
          required: input.required,
          ...(fallback !== undefined ? { default: fallback } : {}),
        });
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
    operations.push({
      name: operation.name as OperationName,
      kind: operation.kind as CanonicalOperationDescriptor['kind'],
      inputs,
    });
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
  return { set, refs, inputArrays, serverInits, nullableFields, containment };
}

/**
 * Load a compiled artifact's T15a descriptor slice end to end: convert
 * (`artifactToDescriptorSet`) then load (`loadExecutionDescriptorSet`) with
 * the caller's engine-local policy. Any unknown kind or malformed member
 * rejects the WHOLE artifact with `IncompatibleArtifactError`.
 */
export function loadArtifactDescriptors(
  artifact: ArtifactDescriptorSlice,
  opts: Omit<LoadDescriptorSetOptions, 'inputArrays'>,
): LoadedArtifactDescriptors {
  const converted = artifactToDescriptorSet(artifact);
  const loaded = loadExecutionDescriptorSet(converted.set, {
    by: opts.by,
    ...(opts.when !== undefined ? { when: opts.when } : {}),
    inputArrays: converted.inputArrays,
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
  return {
    registry: loaded.registry,
    models: loaded.models,
    refs,
    serverInits,
    nullableFields,
    containment,
  };
}
