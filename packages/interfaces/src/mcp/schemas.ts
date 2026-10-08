/**
 * S5 closed-schema derivation: typed operation inputs to closed JSON Schema.
 *
 * Every object rendered here is closed (`additionalProperties: false`) so
 * unknown arguments fail validation (DESIGN section 10). Mutation kinds
 * additionally accept handle mode via `anyOf`; the `action_handle` member is
 * an opaque sealed object here — shape check is object-only, verification is
 * L3/L4's job.
 */
import {
  ARTIFACT_VERSION,
  STD_EMAIL_V1_CONTRACT,
  STD_ERRORS_V1_CONTRACT,
  STD_IMAGES_V1_CONTRACT,
  STD_MAILBOX_V1_CONTRACT,
  STD_PAYMENTS_V1_CONTRACT,
  STD_TEXT_GENERATION_V1_CONTRACT,
  deliveryResultLeaves,
} from '@canlang/contracts';
import type {
  ArtifactOperation,
  BusinessError,
  CapabilityContract,
  ClosedInputs,
  DerivedDeliveryBinding,
  DerivedDeliveryResult,
  DerivedInputDefault,
  DerivedOperationInputs,
  DerivedWritableInput,
} from '@canlang/contracts';
import { INT64_MAX, INT64_MIN, SchemaError, ValueError, decodeValue, parseDecimal } from '@canlang/values';
import type {
  McpInputSchema,
  McpNamedField,
  McpOperationKind,
  McpSchemaField,
  OperationDescriptor,
} from '../ports.js';
import { buildBusinessError } from '../errors/envelope.js';

/**
 * Base closed top-level members of handle-mode args. The full per-operation
 * set is `handleModeAllowed(descriptor)`: base members plus every non-ref
 * typed input (wire `ActionHandleInvocation`: sealed handle + operation_id
 * + all non-record canonical inputs, flattened as siblings). Ref-kind
 * inputs are never admitted in handle mode — the record is sealed.
 */
export const HANDLE_MODE_ALLOWED = ['action_handle', 'operation_id'] as const;

/** Full handle-mode member set for one operation descriptor. */
export function handleModeAllowed(descriptor: OperationDescriptor): readonly string[] {
  const allowed: string[] = [...HANDLE_MODE_ALLOWED];
  for (const named of descriptor.inputs.fields) {
    if (named.field.kind !== 'ref') allowed.push(named.name);
  }
  return allowed;
}

export interface ClosedObjectSchema {
  readonly type: 'object';
  readonly properties: Record<string, unknown>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

/**
 * Mutation kinds carry `operation_id` and admit the handle-mode alternative.
 * Exported for the V02.5 prepared ordinary-MCP plan so dispatch and plan
 * share one rule instead of triplicating it.
 */
export function isMutationKind(kind: McpOperationKind): boolean {
  switch (kind) {
    case 'create':
    case 'update':
    case 'delete':
    case 'scenario':
    case 'team':
      return true;
    case 'read':
    case 'list':
      return false;
  }
}

function fieldSchema(field: McpSchemaField): Record<string, unknown> {
  switch (field.kind) {
    case 'string':
      return { type: 'string' };
    case 'integer':
      // Canonical decimal string at the MCP boundary (DESIGN section 10,
      // wire DecimalString): never a JSON number, no magnitude-dependent
      // wire type.
      return { type: 'string' };
    case 'duration':
      return { type: 'string' };
    case 'boolean':
      return { type: 'boolean' };
    case 'decimal':
      // Decimal lexical form: exact string, never a JSON number (wire: DecimalString).
      return { type: 'string' };
    case 'datetime':
      return { type: 'string', format: 'date-time' };
    case 'file':
      return { type: 'string', format: 'can-file' };
    case 'enum':
      return { type: 'string', enum: [...field.values] };
    case 'money':
      return {
        type: 'object',
        properties: { minor: { type: 'string' }, currency: { type: 'string' } },
        required: ['minor', 'currency'],
        additionalProperties: false,
      };
    case 'ref':
      // ReadRef {id} vs MutationRef {id, version} (wire.ts).
      return {
        type: 'object',
        properties: field.requireVersion
          ? { id: { type: 'string' }, version: { type: 'string' } }
          : { id: { type: 'string' } },
        required: field.requireVersion ? ['id', 'version'] : ['id'],
        additionalProperties: false,
      };
  }
}

/**
 * One property schema: the closed field shape plus the authored
 * `@{desc}` text when present (MCP P4). Absent descriptions render no
 * key — byte-identical to undescribed schemas.
 */
function propertySchema(named: McpNamedField): Record<string, unknown> {
  const schema = fieldSchema(named.field);
  return named.description === undefined ? schema : { ...schema, description: named.description };
}

/** Render typed inputs as one closed JSON Schema object. */
export function toJsonSchema(inputs: McpInputSchema): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const named of inputs.fields) {
    properties[named.name] = propertySchema(named);
    if (named.required) required.push(named.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * Full tool input schema for one operation. Reads/lists get the plain closed
 * schema. Mutations get `operation_id` added as a required string, plus an
 * `anyOf` handle-mode alternative carrying the sealed handle and the
 * operation id (required) plus every non-ref typed input as optional
 * members (wire `ActionHandleInvocation`).
 */
export function toToolInputSchema(descriptor: OperationDescriptor): Record<string, unknown> {
  const ordinary = toJsonSchema(descriptor.inputs);
  if (!isMutationKind(descriptor.kind)) return ordinary;
  const withOpId: Record<string, unknown> = {
    type: 'object',
    properties: { ...ordinary.properties, operation_id: { type: 'string' } },
    required: [...ordinary.required, 'operation_id'],
    additionalProperties: false,
  };
  // Handle branch: sealed handle + operation_id (required) plus every
  // non-ref typed input as an OPTIONAL member (wire ActionHandleInvocation).
  const handleProperties: Record<string, unknown> = {
    // Opaque sealed object: object-only shape check; L3/L4 verifies contents.
    action_handle: { type: 'object' },
    operation_id: { type: 'string' },
  };
  for (const named of descriptor.inputs.fields) {
    if (named.field.kind === 'ref') continue;
    handleProperties[named.name] = propertySchema(named);
  }
  const handleMode: Record<string, unknown> = {
    type: 'object',
    properties: handleProperties,
    required: ['action_handle', 'operation_id'],
    additionalProperties: false,
  };
  // `type: 'object'` root: MCP requires object-rooted inputSchema; both
  // branches are objects so the wrapper is semantically identical.
  return { type: 'object', anyOf: [withOpId, handleMode] };
}

/* ------------------------------------------------------------------ */
/* T19a checked derivation: `ArtifactOperation` -> interface inputs.   */
/*                                                                     */
/* The single L6-owned validation rule behind every T19a builder: HTTP */
/* shapes/catalogs (`http/operations.ts`) and MCP schemas/descriptors  */
/* (`mcp/tools.ts`, below) all check through `checkArtifactOperation`, */
/* so both transports derive the same writable allowlist from the same */
/* checked operation and can never drift apart. (Ideal home for this   */
/* core is `ports.ts`; it stays here until a reservation covers that   */
/* file — the import from `http/operations.ts` is that join.)         */
/*                                                                     */
/* Rule: the writable allowlist is exactly the emitted input names, in */
/* emission order. Server-owned inputs (`server`/`derived` defaults)   */
/* reject the WHOLE descriptor (`server_owned_input`): the T15a/T18    */
/* emitter excludes server-owned fields from operation inputs (proved  */
/* by the T19a pilot emission: `by`/`shout` present in models, absent  */
/* from every operation), so their presence means a tampered or        */
/* hand-built descriptor — never silently dropped, never derived. This */
/* bar is deliberately stricter than the L3 intake, which tolerates    */
/* input defaults it never fills; the interface owns the writable      */
/* allowlist and fails closed on the contradictory                     */
/* caller-supplied-plus-engine-resolved shape. `delivery` (bound       */
/* provider receipts) derives to its validated T13/T14 binding        */
/* (T19b): capability + operation identity, fenced version, declared  */
/* result leaves — carried engine-resolved, never submitted. Unknown  */
/* operation/input/default kinds, duplicate names, and malformed      */
/* members reject the whole descriptor or slice. `literal`/`parent`    */
/* defaults pin verbatim as documented optionality — derivation never  */
/* invents fill values. Dangling `ref` model targets are NOT checked   */
/* here: set executability (ref/model graph, CRUD shapes, uniques) is  */
/* the L3 loader's job; this layer derives per-operation input views.  */
/* ------------------------------------------------------------------ */

/**
 * Machine-readable whole-descriptor rejection reasons. Mirrors the L3
 * `IncompatibleArtifactReason` vocabulary plus the T19a server-owned bar
 * and the T19b delivery bar (`unknown_capability`, `undeclared_result`,
 * `undeclared_leaf`; capability version fencing reuses
 * `version_mismatch`, leaf duplicates reuse `duplicate_name`).
 */
export type IncompatibleDescriptorReason =
  | 'version_mismatch'
  | 'unknown_operation_kind'
  | 'unknown_input_kind'
  | 'unknown_default_kind'
  | 'server_owned_input'
  | 'duplicate_name'
  | 'malformed_descriptor'
  | 'unknown_capability'
  | 'undeclared_result'
  | 'undeclared_leaf';

/**
 * Precise checked-descriptor failure: the descriptor or slice cannot
 * derive and NOTHING from it was derived — there is no partial
 * allowlist and never a silent fallback. `reason` is the
 * machine-readable class; the message names the exact offending member.
 */
export class IncompatibleDescriptorError extends Error {
  readonly reason: IncompatibleDescriptorReason;

  constructor(reason: IncompatibleDescriptorReason, message: string) {
    super(message);
    this.name = 'IncompatibleDescriptorError';
    this.reason = reason;
  }
}

function failDescriptor(reason: IncompatibleDescriptorReason, message: string): never {
  throw new IncompatibleDescriptorError(reason, message);
}

/** One checked caller-suppliable input: element vocabulary plus the T15a/T18 channels. */
export interface CheckedArtifactField {
  readonly name: string;
  readonly field: McpSchemaField;
  readonly required: boolean;
  /** Present and true exactly when the input accepts explicit null. */
  readonly nullable?: boolean;
  /** Present exactly for array inputs; `required` is the T09 `!` marker. */
  readonly array?: { readonly required: boolean };
  /** Source default, pinned verbatim; `server`/`derived` never survive the check. */
  readonly default?: DerivedInputDefault;
  /** Authored `@{desc="..."}` text, verbatim; absent when not authored. */
  readonly description?: string;
}

/**
 * One checked bound provider-receipt input (T19b): the validated T13/T14
 * binding (`capability` + `operation` target identity, fenced version,
 * declared result leaves, recipe key) plus the T15a/T18 additive
 * channels shared with caller-supplied inputs. Engine-resolved: the
 * binding documents what receipt the engine supplies — framing
 * projections (HTTP shapes, MCP schemas) exclude it, the documented
 * `DerivedOperationInputs` projection carries it.
 */
export interface CheckedArtifactDeliveryField {
  readonly name: string;
  readonly delivery: DerivedDeliveryBinding;
  readonly required: boolean;
  /** Present and true exactly when the input accepts explicit null. */
  readonly nullable?: boolean;
  /** Present exactly for array inputs; `required` is the T09 `!` marker. */
  readonly array?: { readonly required: boolean };
  /** Source default, pinned verbatim; `server`/`derived` never survive the check. */
  readonly default?: DerivedInputDefault;
  /** Authored `@{desc="..."}` text, verbatim; absent when not authored. */
  readonly description?: string;
}

/** One checked operation input: caller-supplied or engine-resolved receipt binding. */
export type CheckedArtifactInput = CheckedArtifactField | CheckedArtifactDeliveryField;

/** Narrow one checked input to the engine-resolved receipt binding arm. */
export function isDeliveryField(field: CheckedArtifactInput): field is CheckedArtifactDeliveryField {
  return 'delivery' in field;
}

/** One checked operation: the derivation input every T19 builder shares. */
export interface CheckedArtifactOperation {
  readonly name: string;
  readonly kind: 'read' | 'create' | 'update' | 'delete' | 'scenario';
  readonly description: string;
  readonly fields: readonly CheckedArtifactInput[];
}

/**
 * Operations-only artifact view the derivation consumes. `operations`
 * absent reads as "no descriptors" (matching the L3/L7 loaders), never
 * as an error; models ride the L3 executability join, not this layer.
 */
export interface ArtifactOperationSlice {
  readonly artifact_version?: unknown;
  readonly operations?: unknown;
}

/**
 * Operation kinds with an artifact source. `list`/`team` have NONE —
 * the emitter renders exactly these five (`JsOperationKind`), so no
 * descriptor can derive them and both reject `unknown_operation_kind`
 * by design (never invented): `list` reads travel the fixed bounded
 * collection shape (`CollectionRequest`), `system.team.*` travel the
 * fixed teams-primitive schemas (`SystemTeam*Input`, `identity.ts`).
 */
const CHECKED_OPERATION_KINDS: ReadonlySet<string> = new Set([
  'read',
  'create',
  'update',
  'delete',
  'scenario',
]);

const CHECKED_INPUT_KINDS: ReadonlySet<string> = new Set([
  'ref',
  'string',
  'integer',
  'decimal',
  'money',
  'datetime',
  'duration',
  'boolean',
  'file',
  'enum',
]);

/* ------------------------------------------------------------------ */
/* T19b depth: delivery joins, exact numerics, bound arguments.        */
/*                                                                     */
/* Delivery joins read the frozen T13 capability contracts live (no    */
/* transcription to drift): the send-target identity and frozen       */
/* version come from the six `STD_*_CONTRACT` consts, the declared    */
/* result leaves from `DELIVERY_RESULT_LEAVES` (the verbatim T13c     */
/* transcription, `wire.ts`). Numeric checks reuse the exact L2/T11   */
/* rules (`parseDecimal`, int64 bounds) — bigint-only, never Number.  */
/* ------------------------------------------------------------------ */

/** One fenced capability: frozen version plus op -> declared-result map. */
interface CapabilityTarget {
  readonly version: number;
  readonly results: ReadonlyMap<string, string>;
}

/**
 * The live T13 join: capability name -> fenced contract facts. Six
 * entries (Email/Errors/Payments/TextGeneration/Images/Mailbox);
 * anything else has no T13 identity and rejects `unknown_capability`.
 */
const CAPABILITY_TARGETS: ReadonlyMap<string, CapabilityTarget> = (() => {
  const contracts: readonly CapabilityContract[] = [
    STD_EMAIL_V1_CONTRACT,
    STD_ERRORS_V1_CONTRACT,
    STD_PAYMENTS_V1_CONTRACT,
    STD_TEXT_GENERATION_V1_CONTRACT,
    STD_IMAGES_V1_CONTRACT,
    STD_MAILBOX_V1_CONTRACT,
  ];
  const join = new Map<string, CapabilityTarget>();
  for (const contract of contracts) {
    const results = new Map<string, string>();
    for (const op of contract.operations) results.set(op.name, op.result);
    join.set(contract.name, { version: contract.version, results });
  }
  return join;
})();

/** L2 wire integer shape (`INT_TEXT`): optional `-`, digit run, no plus/exponent. */
const CANONICAL_INT_PATTERN = /^-?\d+$/;

/** Submitted record-version shape (mirrors the versions seam: digits only, arbitrary magnitude). */
const CANONICAL_VERSION_PATTERN = /^\d+$/;

/**
 * Validate one integer wire spelling: canonical digit string in int64
 * range (the L2 `decodeInt64` rule, mirrored — leading zeros read
 * lenient, exactly as there). Returns the failure detail, or null
 * when the spelling binds. Bigint-only; never routes through Number.
 */
function checkIntegerLiteral(value: unknown): string | null {
  if (typeof value !== 'string' || !CANONICAL_INT_PATTERN.test(value)) {
    return `integer values are canonical digit strings (got ${JSON.stringify(value) ?? 'undefined'})`;
  }
  try {
    const parsed = BigInt(value);
    if (parsed < INT64_MIN || parsed > INT64_MAX) {
      return `integer value ${JSON.stringify(value)} exceeds the int64 range`;
    }
    return null;
  } catch {
    return `integer values are canonical digit strings (got ${JSON.stringify(value)})`;
  }
}

/**
 * Validate one decimal wire spelling: the T11 exact parse (string,
 * optional `-`, digit runs, at most 38 significant digits and 18
 * fractional digits, spelling preserved — R16 integral spellings pass
 * with no int64 narrowing). Returns the failure detail, or null when
 * the spelling binds. String-only; a JSON number is never exact.
 */
function checkDecimalLiteral(value: unknown): string | null {
  if (typeof value !== 'string') {
    return `decimal values are canonical decimal strings, never JSON numbers (got ${JSON.stringify(value) ?? 'undefined'})`;
  }
  try {
    parseDecimal(value);
    return null;
  } catch (err) {
    if (err instanceof ValueError && err.code === 'out-of-range') {
      return `decimal value ${JSON.stringify(value)} exceeds 38 significant digits or 18 fractional digits`;
    }
    if (err instanceof ValueError) {
      return `decimal values are canonical decimal strings (got ${JSON.stringify(value)})`;
    }
    throw err;
  }
}

/**
 * Validate one money wire value: exactly `{minor, currency}` (the L2
 * exact-keys shape) with a canonical int64 minor string and a string
 * currency. Returns the failure detail, or null when the value binds.
 */
function checkMoneyLiteral(value: unknown): string | null {
  if (!isDescriptorRecord(value)) {
    return `money values are {minor, currency} objects (got ${JSON.stringify(value) ?? 'undefined'})`;
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'currency' || keys[1] !== 'minor') {
    return `money values carry exactly minor and currency (got ${JSON.stringify(keys)})`;
  }
  const minor = checkIntegerLiteral(value['minor']);
  if (minor !== null) return `money.minor: ${minor}`;
  if (typeof value['currency'] !== 'string') {
    return `money.currency is a string (got ${JSON.stringify(value['currency']) ?? 'undefined'})`;
  }
  return null;
}

/**
 * Check one bound provider-receipt descriptor end to end: record shape,
 * T13 target identity (`capability` + `operation`), frozen version
 * fenced exact, declared result nominal, and the full declared leaf
 * set with verbatim types. Leaf ORDER is presentation (carried
 * verbatim, never fenced); leaf SET and TYPES are the fenced facts —
 * extras, renames, and retypings reject `undeclared_leaf`, drops
 * reject `malformed_descriptor` (an incomplete result is not a real
 * emission). Anything failing rejects the whole descriptor.
 */
function checkArtifactDeliveryDescriptor(value: unknown, what: string): DerivedDeliveryBinding {
  if (!isDescriptorRecord(value)) {
    failDescriptor('malformed_descriptor', `Invalid ${what}: delivery inputs carry a descriptor object.`);
  }
  const capability = value['capability'];
  const operation = value['operation'];
  if (typeof capability !== 'string' || capability === '' || typeof operation !== 'string' || operation === '') {
    failDescriptor(
      'malformed_descriptor',
      `Invalid ${what}: delivery descriptors name a non-empty capability and operation.`,
    );
  }
  const target = CAPABILITY_TARGETS.get(capability);
  if (target === undefined) {
    failDescriptor(
      'unknown_capability',
      `Unknown capability ${JSON.stringify(capability)} for ${what}: ` +
        'bound receipts bind the six T13 capability contracts (std.EmailV1, std.ErrorsV1, ' +
        'std.PaymentsV1, std.TextGenerationV1, std.ImagesV1, std.MailboxV1); bound-local ' +
        'deliveries have no T13 identity and never take the delivery shape.',
    );
  }
  const declaredResult = target.results.get(operation);
  if (declaredResult === undefined) {
    failDescriptor(
      'unknown_capability',
      `Invalid ${what}: ${JSON.stringify(capability)} has no sendable operation ${JSON.stringify(operation)}.`,
    );
  }
  const version = value['version'];
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    failDescriptor(
      'malformed_descriptor',
      `Invalid ${what}: delivery version is the frozen capability contract number (got ${JSON.stringify(version) ?? 'undefined'}).`,
    );
  }
  if (version !== target.version) {
    failDescriptor(
      'version_mismatch',
      `Incompatible ${what}: delivery version ${JSON.stringify(version)} does not match ` +
        `the frozen ${capability} contract version ${target.version}.`,
    );
  }
  const result = value['result'];
  if (!isDescriptorRecord(result) || typeof result['name'] !== 'string' || result['name'] === '') {
    failDescriptor('malformed_descriptor', `Invalid ${what}: delivery results name a non-empty nominal.`);
  }
  const nominal = result['name'];
  if (nominal !== declaredResult) {
    failDescriptor(
      'undeclared_result',
      `Invalid ${what}: result ${JSON.stringify(nominal)} is not declared for ${capability}.${operation} ` +
        `(declared: ${JSON.stringify(declaredResult)}).`,
    );
  }
  const declared = deliveryResultLeaves(nominal);
  if (declared === null) {
    // Unreachable while the T13 contracts and the leaf table agree:
    // every declared result nominal transcribes its leaves. Fail loud
    // if that join ever drifts.
    failDescriptor(
      'undeclared_result',
      `Invalid ${what}: result ${JSON.stringify(nominal)} declares no leaves.`,
    );
  }
  const rawFields: unknown = result['fields'];
  if (!Array.isArray(rawFields)) {
    failDescriptor('malformed_descriptor', `Invalid ${what}: delivery result fields must be an array.`);
  }
  const seen = new Set<string>();
  const leaves: { readonly name: string; readonly type: string }[] = [];
  for (const entry of rawFields) {
    if (!isDescriptorRecord(entry) || typeof entry['name'] !== 'string' || entry['name'] === '') {
      failDescriptor('malformed_descriptor', `Invalid ${what}: delivery leaves need non-empty names.`);
    }
    if (typeof entry['type'] !== 'string' || entry['type'] === '') {
      failDescriptor(
        'malformed_descriptor',
        `Invalid ${what}: delivery leaf ${JSON.stringify(entry['name'])} carries its verbatim type text.`,
      );
    }
    if (seen.has(entry['name'])) {
      failDescriptor(
        'duplicate_name',
        `Duplicate delivery leaf ${JSON.stringify(entry['name'])} for ${what}.`,
      );
    }
    seen.add(entry['name']);
    const declaredLeaf = declared.find((leaf) => leaf.name === entry['name']);
    if (declaredLeaf === undefined || declaredLeaf.type !== entry['type']) {
      failDescriptor(
        'undeclared_leaf',
        declaredLeaf === undefined
          ? `Invalid ${what}: leaf ${JSON.stringify(entry['name'])} is not declared on ${JSON.stringify(nominal)}.`
          : `Invalid ${what}: leaf ${JSON.stringify(entry['name'])} declares type ${JSON.stringify(declaredLeaf.type)} ` +
            `(got ${JSON.stringify(entry['type'])}).`,
      );
    }
    leaves.push({ name: entry['name'], type: entry['type'] });
  }
  if (leaves.length !== declared.length) {
    const missing = declared.filter((leaf) => !seen.has(leaf.name)).map((leaf) => leaf.name);
    failDescriptor(
      'malformed_descriptor',
      `Invalid ${what}: result ${JSON.stringify(nominal)} declares ${declared.length} leaves; ` +
        `the descriptor carries ${leaves.length} (missing: ${missing.map((name) => JSON.stringify(name)).join(', ')}).`,
    );
  }
  const frozenLeaves = Object.freeze(leaves);
  const frozenResult: DerivedDeliveryResult = Object.freeze({ name: nominal, leaves: frozenLeaves });
  return Object.freeze({
    capability,
    operation,
    version,
    result: frozenResult,
    recipe: `delivery:${capability}.${operation}`,
  });
}

function isDescriptorRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Load-time dot-path check for `parent` defaults: non-empty, no empty segments. */
function checkDescriptorDotPath(path: string, what: string): void {
  if (path === '' || path.split('.').some((segment) => segment === '')) {
    failDescriptor('malformed_descriptor', `Invalid ${what} dot path: ${JSON.stringify(path)}.`);
  }
}

/**
 * Check one source-declared input default. `literal`/`parent` pin
 * verbatim; `server`/`derived` reject the descriptor (server-owned is
 * never derivable as input); unknown kinds reject precisely. Extra
 * members are ignored (additive tolerance — only kinds reject).
 *
 * T19b exactness: `literal` defaults on `integer`/`decimal`/`money`/`duration`
 * inputs validate against the canonical wire shapes (int64 digit
 * strings, T11 exact decimals, exact-keys money) — JSON numbers,
 * malformed spellings, and out-of-range values reject the descriptor
 * instead of failing later at admission.
 */
function checkArtifactDefault(
  value: unknown,
  what: string,
  fieldKind: string,
  durationType: string = 'duration',
): DerivedInputDefault | undefined {
  if (value === undefined) return undefined;
  if (!isDescriptorRecord(value) || typeof value['kind'] !== 'string') {
    failDescriptor('malformed_descriptor', `Invalid default for ${what}: a default object needs a kind.`);
  }
  const kind = value['kind'];
  if (kind === 'literal') {
    const literal = value['value'];
    if (fieldKind === 'duration') {
      try {
        decodeValue(durationType, literal);
      } catch (err) {
        if (!(err instanceof SchemaError)) throw err;
        failDescriptor('malformed_descriptor', `Invalid literal default for ${what}: ${err.message}.`);
      }
    }
    if (fieldKind === 'integer' || fieldKind === 'decimal' || fieldKind === 'money') {
      const detail =
        fieldKind === 'integer'
          ? checkIntegerLiteral(literal)
          : fieldKind === 'decimal'
            ? checkDecimalLiteral(literal)
            : checkMoneyLiteral(literal);
      if (detail !== null) {
        failDescriptor('malformed_descriptor', `Invalid literal default for ${what}: ${detail}.`);
      }
    }
    return { kind: 'literal', value: literal };
  }
  if (kind === 'parent') {
    if (typeof value['path'] !== 'string') {
      failDescriptor('malformed_descriptor', `Invalid parent default for ${what}: path must be a dot-path string.`);
    }
    checkDescriptorDotPath(value['path'], `parent default for ${what}`);
    return { kind: 'parent', path: value['path'] };
  }
  if (kind === 'server' || kind === 'derived') {
    failDescriptor(
      'server_owned_input',
      `Invalid ${what}: server-owned inputs are engine-resolved and never caller-supplied (T18 R27); ` +
        'the emitter excludes them from operation inputs, so this descriptor is not a real emission.',
    );
  }
  failDescriptor(
    'unknown_default_kind',
    `Unknown default kind ${JSON.stringify(kind)} for ${what}; supported: literal, parent, server, derived.`,
  );
}

/** Check one input element tag against the closed T04a pilot vocabulary. */
function checkArtifactFieldTag(value: unknown, what: string): McpSchemaField {
  if (!isDescriptorRecord(value) || typeof value['kind'] !== 'string') {
    failDescriptor('malformed_descriptor', `Invalid ${what}: input fields need a kind tag.`);
  }
  const kind = value['kind'];
  if (!CHECKED_INPUT_KINDS.has(kind)) {
    failDescriptor(
      'unknown_input_kind',
      `Unknown input kind ${JSON.stringify(kind)} for ${what}; ` +
        'supported: ref, string, integer, decimal, money, datetime, duration, boolean, file, enum, delivery.',
    );
  }
  if (kind === 'ref') {
    if (typeof value['model'] !== 'string' || value['model'] === '') {
      failDescriptor('malformed_descriptor', `Invalid ${what}: ref inputs name a non-empty model.`);
    }
    if (typeof value['requireVersion'] !== 'boolean') {
      failDescriptor('malformed_descriptor', `Invalid ${what}: requireVersion must be a boolean.`);
    }
    return { kind: 'ref', model: value['model'], requireVersion: value['requireVersion'] };
  }
  if (kind === 'enum') {
    const values: unknown = value['values'];
    if (!Array.isArray(values) || values.some((entry) => typeof entry !== 'string' || entry === '')) {
      failDescriptor(
        'malformed_descriptor',
        `Invalid ${what}: enum inputs carry values as an array of non-empty strings.`,
      );
    }
    return { kind: 'enum', values: [...values] };
  }
  switch (kind) {
    case 'string':
      return { kind: 'string' };
    case 'integer':
      return { kind: 'integer' };
    case 'decimal':
      return { kind: 'decimal' };
    case 'money':
      return { kind: 'money' };
    case 'datetime':
      return { kind: 'datetime' };
    case 'duration':
      return { kind: 'duration' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'file':
      return { kind: 'file' };
    default:
      // Unreachable: the closed-kind screen above admits only these eight
      // past the `ref`/`enum` arms. Fail loud if that ever drifts.
      failDescriptor('unknown_input_kind', `Unknown input kind ${JSON.stringify(kind)} for ${what}.`);
  }
}

/** The T15a/T18 additive channels shared by caller-supplied and receipt inputs. */
interface CheckedInputChannels {
  readonly required: boolean;
  readonly nullable?: boolean;
  readonly array?: { readonly required: boolean };
  readonly default?: DerivedInputDefault;
  readonly description?: string;
}

/** Check the additive channels (required, default, array, description, nullability). */
function checkArtifactInputChannels(
  value: Record<string, unknown>,
  what: string,
  fieldKind: string,
): CheckedInputChannels {
  if (typeof value['required'] !== 'boolean') {
    failDescriptor('malformed_descriptor', `Invalid ${what}: required must be a boolean.`);
  }
  const durationType = `duration${value['array'] === undefined ? '' : '[]'}${value['nullable'] === true ? '?' : ''}`;
  const fallback = checkArtifactDefault(value['default'], what, fieldKind, durationType);
  let array: { readonly required: boolean } | undefined;
  if (value['array'] !== undefined) {
    if (!isDescriptorRecord(value['array']) || typeof value['array']['required'] !== 'boolean') {
      failDescriptor('malformed_descriptor', `Invalid ${what}: array markers carry a boolean required.`);
    }
    array = { required: value['array']['required'] };
  }
  const rawDescription: unknown = value['description'];
  let description: string | undefined;
  if (rawDescription !== undefined) {
    if (typeof rawDescription !== 'string') {
      failDescriptor('malformed_descriptor', `Invalid ${what}: description must be the authored text string.`);
    }
    description = rawDescription;
  }
  return {
    required: value['required'],
    ...(value['nullable'] === true ? { nullable: true as const } : {}),
    ...(array === undefined ? {} : { array }),
    ...(fallback === undefined ? {} : { default: fallback }),
    ...(description === undefined ? {} : { description }),
  };
}

/**
 * Check one operation input: shape, closed kind (caller-supplied or
 * bound receipt), documented default, additive channels.
 */
function checkArtifactInput(value: unknown, opName: string): CheckedArtifactInput {
  if (!isDescriptorRecord(value) || typeof value['name'] !== 'string' || value['name'] === '') {
    failDescriptor(
      'malformed_descriptor',
      `Invalid input on operation ${JSON.stringify(opName)}: inputs need non-empty names.`,
    );
  }
  const name = value['name'];
  const what = `input ${JSON.stringify(name)} on operation ${JSON.stringify(opName)}`;
  const tag = value['field'];
  if (isDescriptorRecord(tag) && tag['kind'] === 'delivery') {
    const delivery = checkArtifactDeliveryDescriptor(tag, what);
    return { name, delivery, ...checkArtifactInputChannels(value, what, 'delivery') };
  }
  const field = checkArtifactFieldTag(tag, what);
  return { name, field, ...checkArtifactInputChannels(value, what, field.kind) };
}

/**
 * Check one operation descriptor: the shared T19a derivation rule. Any
 * unknown kind, server-owned input, duplicate input, or malformed member
 * rejects the WHOLE descriptor — nothing derives partially.
 */
export function checkArtifactOperation(raw: unknown): CheckedArtifactOperation {
  if (!isDescriptorRecord(raw) || typeof raw['name'] !== 'string' || raw['name'] === '') {
    failDescriptor('malformed_descriptor', 'Invalid operation descriptor: operations need non-empty names.');
  }
  const name = raw['name'];
  const kind: unknown = raw['kind'];
  if (typeof kind !== 'string' || !CHECKED_OPERATION_KINDS.has(kind)) {
    failDescriptor(
      'unknown_operation_kind',
      `Unknown operation kind ${JSON.stringify(kind)} on ${JSON.stringify(name)}; ` +
        'supported: read, create, update, delete, scenario.',
    );
  }
  if (typeof raw['description'] !== 'string') {
    failDescriptor(
      'malformed_descriptor',
      `Invalid operation ${JSON.stringify(name)}: description must be a string (authored \`#\` text).`,
    );
  }
  const inputs: unknown = raw['inputs'];
  if (!isDescriptorRecord(inputs) || !Array.isArray(inputs['fields'])) {
    failDescriptor(
      'malformed_descriptor',
      `Invalid operation ${JSON.stringify(name)}: inputs.fields must be an array.`,
    );
  }
  const seen = new Set<string>();
  const fields: CheckedArtifactInput[] = [];
  for (const entry of inputs['fields']) {
    const checked = checkArtifactInput(entry, name);
    if (seen.has(checked.name)) {
      failDescriptor(
        'duplicate_name',
        `Duplicate input ${JSON.stringify(checked.name)} on operation ${JSON.stringify(name)}.`,
      );
    }
    seen.add(checked.name);
    fields.push(checked);
  }
  return {
    name,
    kind: kind as CheckedArtifactOperation['kind'],
    description: raw['description'],
    fields: Object.freeze(fields),
  };
}

/**
 * Fence one derivation slice on the artifact contract version: exact
 * match, never a silent fallback. A version mismatch is the precise
 * error — stale derivation output can never serve a newer artifact.
 */
export function checkArtifactSliceVersion(slice: ArtifactOperationSlice): void {
  if (slice.artifact_version !== ARTIFACT_VERSION) {
    failDescriptor(
      'version_mismatch',
      `Incompatible descriptor slice: artifact_version ${JSON.stringify(slice.artifact_version)} ` +
        `does not match the required artifact contract ${ARTIFACT_VERSION}.`,
    );
  }
}

/**
 * Check one derivation slice end to end: version fence, then every
 * operation through the shared rule. Absent `operations` reads as "no
 * descriptors"; duplicate operation names reject the whole slice.
 */
export function checkArtifactOperations(slice: ArtifactOperationSlice): CheckedArtifactOperation[] {
  checkArtifactSliceVersion(slice);
  const raw: unknown = slice.operations;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    failDescriptor('malformed_descriptor', 'Invalid descriptor slice: operations must be an array.');
  }
  const seen = new Set<string>();
  const checked = raw.map((entry) => checkArtifactOperation(entry));
  for (const operation of checked) {
    if (seen.has(operation.name)) {
      failDescriptor('duplicate_name', `Duplicate operation descriptor: ${JSON.stringify(operation.name)}.`);
    }
    seen.add(operation.name);
  }
  return checked;
}

/**
 * Convert one checked operation to its framing-level MCP input schema:
 * element vocabulary, required flags, verbatim descriptions. Array
 * markers and defaults have no `McpSchemaField` slot: arrays render
 * element-typed here (framing needs names/required/ref-ness only — the
 * closed-inputs and ref-shape checks), while value-level array shapes
 * render in `toToolInputSchemaFromArtifact` and defaults pin in the
 * wire `DerivedOperationInputs` channel (`http/operations.ts`).
 * Engine-resolved receipt bindings have no slot either and are
 * excluded: framing is exactly the submittable allowlist.
 */
export function checkedToMcpInputSchema(checked: CheckedArtifactOperation): McpInputSchema {
  const fields: McpNamedField[] = [];
  for (const named of checked.fields) {
    if (isDeliveryField(named)) continue;
    fields.push({
      name: named.name,
      field: named.field,
      required: named.required,
      ...(named.description === undefined ? {} : { description: named.description }),
    });
  }
  return { fields };
}

/** Checked-derivation entry: one artifact operation to its MCP input schema. */
export function toMcpInputSchema(op: ArtifactOperation): McpInputSchema {
  return checkedToMcpInputSchema(checkArtifactOperation(op));
}

/**
 * One array-aware property schema: the closed element shape (plus the
 * authored description when present), wrapped as `{type: 'array',
 * items}` exactly for array inputs. The description belongs to the
 * member, so it rides the outer object in both cases.
 */
function checkedPropertySchema(checked: CheckedArtifactField): Record<string, unknown> {
  const element = fieldSchema(checked.field);
  if (checked.array === undefined) {
    return checked.description === undefined ? element : { ...element, description: checked.description };
  }
  const arraySchema: Record<string, unknown> = { type: 'array', items: element };
  if (checked.description !== undefined) arraySchema['description'] = checked.description;
  return arraySchema;
}

/**
 * Full array-aware tool input schema for one checked operation. Same
 * structure as `toToolInputSchema` (reads/lists plain closed; mutations
 * add required `operation_id` plus the `anyOf` handle-mode alternative
 * with sealed handle and optional non-ref members), with array inputs
 * rendered as `{type: 'array', items}` in every branch. The pre-T19a
 * renderer stays byte-identical for non-artifact descriptors.
 */
export function checkedToToolInputSchema(checked: CheckedArtifactOperation): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const named of checked.fields) {
    // Receipt bindings are engine-resolved: no schema member on any
    // branch (ordinary or handle) — a submitted value has no meaning.
    if (isDeliveryField(named)) continue;
    properties[named.name] = checkedPropertySchema(named);
    if (named.required) required.push(named.name);
  }
  const ordinary = { type: 'object', properties, required, additionalProperties: false };
  if (!isMutationKind(checked.kind)) return ordinary;
  const withOpId: Record<string, unknown> = {
    type: 'object',
    properties: { ...ordinary.properties, operation_id: { type: 'string' } },
    required: [...ordinary.required, 'operation_id'],
    additionalProperties: false,
  };
  const handleProperties: Record<string, unknown> = {
    action_handle: { type: 'object' },
    operation_id: { type: 'string' },
  };
  for (const named of checked.fields) {
    if (isDeliveryField(named) || named.field.kind === 'ref') continue;
    handleProperties[named.name] = checkedPropertySchema(named);
  }
  const handleMode: Record<string, unknown> = {
    type: 'object',
    properties: handleProperties,
    required: ['action_handle', 'operation_id'],
    additionalProperties: false,
  };
  return { type: 'object', anyOf: [withOpId, handleMode] };
}

/** Checked-derivation entry: one artifact operation to its full tool input schema. */
export function toToolInputSchemaFromArtifact(op: ArtifactOperation): Record<string, unknown> {
  return checkedToToolInputSchema(checkArtifactOperation(op));
}

/* ------------------------------------------------------------------ */
/* T19b bound arguments: submitted values against declared inputs.     */
/*                                                                     */
/* Pure rule, wired into dispatch at E1 (HTTP + MCP, framing first):   */
/* checks (unknown members, missing required) stay in dispatch; this   */
/* rule binds each PRESENT value to its declaration — ref shape by    */
/* the `versioned` flag, enum membership, file opacity, numeric wire  */
/* shapes — and delivery to nothing. Binding mismatch is               */
/* `validation`; version staleness stays L3-owned (`conflict`).        */
/* Strings, booleans, and array-element nulls carry no declared set   */
/* to bind and pass through to L3 admission untouched. Datetimes      */
/* decode through the canonical values-wire form (millis-pinned RFC   */
/* 3339 UTC) because L3 admission judges presence only (E2b/F-R4).     */
/* ------------------------------------------------------------------ */

/** One binding failure: `validation` with the offending member path. */
function bindingError(path: string, message: string): BusinessError {
  return buildBusinessError('validation', message, {
    fields: [{ path, code: 'binding_mismatch', message }],
  });
}

/** Bind one submitted ref value to its ReadRef/MutationRef declaration. */
function checkBoundRef(input: DerivedWritableInput, value: unknown, path: string): BusinessError | null {
  if (!isDescriptorRecord(value)) {
    return bindingError(
      path,
      `Invalid value for input ${JSON.stringify(input.name)}: refs are {id} objects` +
        (input.versioned === true ? ' with an expected version' : '') +
        ` (got ${JSON.stringify(value) ?? 'undefined'}).`,
    );
  }
  if (typeof value['id'] !== 'string' || value['id'] === '') {
    return bindingError(
      path,
      `Invalid value for input ${JSON.stringify(input.name)}: ref ids are non-empty strings.`,
    );
  }
  if (input.versioned !== true) return null;
  const version = value['version'];
  if (typeof version !== 'string' || !CANONICAL_VERSION_PATTERN.test(version)) {
    return bindingError(
      path,
      `Invalid value for input ${JSON.stringify(input.name)}: ` +
        `versioned refs carry a canonical digit-string version (got ${JSON.stringify(version) ?? 'undefined'}).`,
    );
  }
  return null;
}

/** Bind one non-null array element or singular value to its declared kind. */
function checkBoundElement(
  input: DerivedWritableInput,
  value: unknown,
  path: string,
): BusinessError | null {
  switch (input.kind) {
    case 'delivery':
      return bindingError(
        path,
        `Invalid value for input ${JSON.stringify(input.name)}: delivery inputs are engine-resolved ` +
          'and never submitted (no contract admits a caller-supplied receipt value).',
      );
    case 'ref':
      return checkBoundRef(input, value, path);
    case 'enum': {
      const cases = input.enumValues ?? [];
      if (typeof value !== 'string' || !cases.includes(value)) {
        return bindingError(
          path,
          `Invalid value for input ${JSON.stringify(input.name)}: ` +
            `expected one of ${cases.map((entry) => JSON.stringify(entry)).join(', ')} ` +
            `(got ${JSON.stringify(value) ?? 'undefined'}).`,
        );
      }
      return null;
    }
    case 'file':
      if (typeof value !== 'string' || value === '') {
        return bindingError(
          path,
          `Invalid value for input ${JSON.stringify(input.name)}: ` +
            `file values are opaque finalized file id strings (got ${JSON.stringify(value) ?? 'undefined'}).`,
        );
      }
      return null;
    case 'integer':
    case 'decimal':
    case 'money': {
      const detail =
        input.kind === 'integer'
          ? checkIntegerLiteral(value)
          : input.kind === 'decimal'
            ? checkDecimalLiteral(value)
            : checkMoneyLiteral(value);
      return detail === null
        ? null
        : bindingError(path, `Invalid value for input ${JSON.stringify(input.name)}: ${detail}.`);
    }
    case 'duration': {
      // The values codec owns canonical millisecond spelling and int64 bounds.
      try {
        decodeValue('duration', value);
      } catch (err) {
        if (!(err instanceof SchemaError)) throw err;
        return bindingError(path, `Invalid value for input ${JSON.stringify(input.name)}: ${err.message}.`);
      }
      return null;
    }
    case 'datetime': {
      // E2b/F-R4 join: the dispatcher applies the canonical values-wire
      // decode — L3 admission judges presence only and will not catch a
      // non-conforming string (lane B relay). Millis-pinned RFC 3339 UTC
      // binds; anything else mismatches. Not a parallel engine: the
      // canonical decoder owns the verdict; only its outcome is projected.
      try {
        decodeValue('datetime', value);
      } catch (err) {
        if (!(err instanceof SchemaError)) throw err;
        return bindingError(
          path,
          `Invalid value for input ${JSON.stringify(input.name)}: ` +
            'datetime values are RFC 3339 UTC instants with millis ' +
            `(got ${JSON.stringify(value) ?? 'undefined'}).`,
        );
      }
      return null;
    }
    case 'string':
    case 'boolean':
      // No declared set to bind: L3 admission owns these values.
      return null;
  }
}

/**
 * Bind one submitted value to its declared input: null binds to
 * `nullable` only; arrays bind element-wise (element nulls pass
 * through — element-level null acceptance is L3 admission detail);
 * singular values bind by kind. Presence and closedness are framing
 * concerns, never checked here.
 */
export function checkBoundArgument(input: DerivedWritableInput, value: unknown): BusinessError | null {
  const path = `/${input.name}`;
  if (value === null) {
    return input.nullable === true
      ? null
      : bindingError(path, `Invalid value for input ${JSON.stringify(input.name)}: null is not accepted.`);
  }
  if (input.array !== undefined) {
    if (!Array.isArray(value)) {
      return bindingError(
        path,
        `Invalid value for input ${JSON.stringify(input.name)}: array inputs take arrays ` +
          `(got ${JSON.stringify(value) ?? 'undefined'}).`,
      );
    }
    for (let index = 0; index < value.length; index += 1) {
      const element: unknown = value[index];
      if (element === null) continue;
      const failure = checkBoundElement(input, element, `${path}/${index}`);
      if (failure !== null) return failure;
    }
    return null;
  }
  return checkBoundElement(input, value, path);
}

/**
 * Bind every present member of a submitted inputs object to its
 * declared input (first failure wins). Unknown members and missing
 * required inputs are framing concerns — checked by the dispatch
 * closed-inputs rule, never here.
 */
export function checkBoundArguments(
  derived: DerivedOperationInputs,
  inputs: ClosedInputs,
): BusinessError | null {
  for (const input of derived.inputs) {
    if (!Object.hasOwn(inputs, input.name)) continue;
    const failure = checkBoundArgument(input, inputs[input.name]);
    if (failure !== null) return failure;
  }
  return null;
}
