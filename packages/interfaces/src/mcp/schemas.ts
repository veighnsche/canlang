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
import type { NormalizedField } from '@canlang/values';
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
  InputChoiceBinding,
  CanonicalValueTypes,
} from '@canlang/contracts';
import { INT64_MAX, INT64_MIN, SchemaError, ValueError, decodeValue, normalizeValueTypes, parseDecimal, parseTypeId, validateValue } from '@canlang/values';
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
    case 'nominal':
      return nominalSchema(field.name, field.valueTypes);
    case 'string':
      return { type: 'string' };
    case 'integer':
      // Canonical decimal string at the MCP boundary (DESIGN section 10,
      // wire DecimalString): never a JSON number, no magnitude-dependent
      // wire type.
      return { type: 'string' };
    case 'duration':
      return { type: 'string' };
    case 'user':
    case 'file':
      return {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1 } },
        required: ['id'],
        additionalProperties: false,
      };
    case 'boolean':
      return { type: 'boolean' };
    case 'decimal':
      // Decimal lexical form: exact string, never a JSON number (wire: DecimalString).
      return { type: 'string' };
    case 'datetime':
      return { type: 'string', format: 'date-time' };
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

/** Render only the same checked declaration inventory used by Values admission. */
function nominalSchema(name: string, inventory: CanonicalValueTypes): Record<string, unknown> {
  const { valueSchema } = normalizeValueTypes(inventory);
  const definitions: Record<string, unknown> = Object.create(null);
  const visited = new Set<string>();
  const shape = (parsed: ReturnType<typeof parseTypeId>, type: string, descriptor?: NormalizedField): Record<string, unknown> => {
    const base = parsed.base;
    let element: Record<string, unknown>;
    if (base.kind === 'nominal') {
      visit(base.path);
      element = { $ref: `#/$defs/${base.path.replaceAll('~', '~0').replaceAll('/', '~1')}` };
    } else if (base.kind === 'scalar') {
      if (!['text', 'bool', 'int', 'decimal', 'money', 'date', 'datetime', 'duration', 'email', 'url'].includes(base.name)) {
        failDescriptor('malformed_descriptor', `Unsupported nominal schema scalar ${JSON.stringify(base.name)}.`);
      }
      element = base.name === 'bool' ? { type: 'boolean' }
        : base.name === 'money' ? fieldSchema({ kind: 'money' }) : { type: 'string' };
    } else if (base.kind === 'stringlike') element = { type: 'string' };
    else if (base.kind === 'user' || base.kind === 'file') element = fieldSchema({ kind: base.kind });
    else if (base.kind === 'enum') element = { type: 'string', enum: [...base.cases] };
    else failDescriptor('malformed_descriptor', `Unsupported nominal schema type ${JSON.stringify(type)}.`);
    let array: Record<string, unknown> = parsed.array ? { type: 'array', items: element } : element;
    if (descriptor !== undefined) {
      const min = parsed.array ? 'minItems' : 'minLength';
      const max = parsed.array ? 'maxItems' : 'maxLength';
      if (descriptor.lengthMin !== undefined) array[min] = descriptor.lengthMin;
      if (descriptor.lengthMax !== undefined) array[max] = descriptor.lengthMax;
      if (descriptor.format === 'name') array['pattern'] = '^[A-Za-z_][A-Za-z0-9_]*$';
      if (descriptor.distinctBy === 'id') {
        array['description'] = 'Each item must have a distinct id.';
        if (descriptor.excludedIds !== undefined && descriptor.excludedIds.length !== 0) {
          array['items'] = { allOf: [element, { properties: { id: { not: { enum: [...descriptor.excludedIds] } } } }] };
        }
      }
    }
    return parsed.nullable ? { anyOf: [array, { type: 'null' }] } : array;
  };
  const visit = (key: string): void => {
    if (visited.has(key)) return;
    visited.add(key);
    const contract = valueSchema.contracts[key];
    const enumeration = valueSchema.enums[key];
    const alias = valueSchema.aliases?.[key];
    if (contract !== undefined) {
      const properties: Record<string, unknown> = Object.create(null);
      for (const [field, descriptor] of Object.entries(contract.fields)) properties[field] = shape(descriptor.type, descriptor.typeId, descriptor);
      definitions[key] = { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
    } else if (enumeration !== undefined) definitions[key] = { type: 'string', enum: [...enumeration.cases] };
    else if (alias !== undefined) definitions[key] = shape(alias.type, alias.typeId, alias);
    else failDescriptor('malformed_descriptor', `Nominal ${JSON.stringify(key)} lacks a checked declaration.`);
  };
  visit(name);
  return { $ref: `#/$defs/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`, $defs: definitions };
}

/** Nominal references resolve at the actual tool root, including anyOf branches. */
function hoistDefinitions(root: Record<string, unknown>): void {
  const definitions: Record<string, unknown> = Object.create(null);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!isDescriptorRecord(value)) return;
    const local = value['$defs'];
    if (isDescriptorRecord(local)) {
      for (const [name, definition] of Object.entries(local)) {
        if (Object.hasOwn(definitions, name) && JSON.stringify(definitions[name]) !== JSON.stringify(definition)) {
          failDescriptor('malformed_descriptor', `Conflicting checked nominal schema ${JSON.stringify(name)}.`);
        }
        definitions[name] = definition;
      }
      delete value['$defs'];
    }
    Object.values(value).forEach(visit);
  };
  visit(root);
  if (Object.keys(definitions).length !== 0) root['$defs'] = definitions;
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
  $defs?: Record<string, unknown>;
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const named of inputs.fields) {
    properties[named.name] = propertySchema(named);
    if (named.required) required.push(named.name);
  }
  const root = { type: 'object' as const, properties, required, additionalProperties: false as const };
  hoistDefinitions(root);
  return root;
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
  const root = { type: 'object', anyOf: [withOpId, handleMode], ...(ordinary.$defs === undefined ? {} : { $defs: ordinary.$defs }) };
  hoistDefinitions(root);
  return root;
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
  readonly choices?: InputChoiceBinding;
  readonly name: string;
  readonly field: McpSchemaField;
  /** Owning compiler claim, retained only after kind/container consistency checks. */
  readonly valueType?: string;
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
  /** Required only for full-context choices intake; otherwise left to owning model consumers. */
  readonly models?: unknown;
  /** Actual owning nominal inventory; never inferred from model spelling. */
  readonly valueTypes?: unknown;
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
  'nominal',
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
function checkArtifactDeliveryDescriptor(value: unknown, what: string, inventory?: CanonicalValueTypes): DerivedDeliveryBinding {
  if (!isDescriptorRecord(value)) {
    failDescriptor('malformed_descriptor', `Invalid ${what}: delivery inputs carry a descriptor object.`);
  }
  if ('judgment' in value) {
    const required = ['kind', 'judgment', 'capability', 'operation', 'version', 'result'];
    if (Object.keys(value).length !== required.length || required.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined || !Object.hasOwn(descriptor, 'value');
    })) failDescriptor('malformed_descriptor', `Invalid ${what}: judgment descriptor must be closed own data.`);
  }
  const capability = value['capability'];
  const operation = value['operation'];
  if ('judgment' in value) {
    if (value['judgment'] !== true || typeof capability !== 'string' || capability === '' || operation !== 'evaluate' ||
        typeof value['version'] !== 'string' || inventory === undefined) {
      failDescriptor('malformed_descriptor', `Invalid ${what}: judgment delivery requires its checked nominal inventory and exact string version.`);
    }
    try {
      const decoded = decodeValue('int', value['version']);
      if (typeof decoded !== 'bigint' || decoded < 0n || decoded.toString() !== value['version']) throw new Error('version');
    }
    catch { failDescriptor('version_mismatch', `Invalid ${what}: canonical judgment version required.`); }
    const declared = inventory.contracts.find(contract => contract.name === capability);
    const result = value['result'];
    const rawLeaves = isDescriptorRecord(result) ? result['fields'] : undefined;
    if (declared === undefined || !isDescriptorRecord(result) || result['name'] !== capability || !Array.isArray(rawLeaves) ||
        rawLeaves.length !== declared.fields.length) failDescriptor('undeclared_result', `Invalid ${what}: undeclared judgment result.`);
    const leaves = declared.fields.map((field, index) => {
      const leaf = rawLeaves[index];
      if (!isDescriptorRecord(leaf) || leaf['name'] !== field.name || leaf['type'] !== field.type) {
        failDescriptor('undeclared_leaf', `Invalid ${what}: judgment result leaves disagree with the checked inventory.`);
      }
      return Object.freeze({ name: field.name, type: field.type });
    });
    return Object.freeze({ judgment: true as const, capability, operation: 'evaluate' as const, version: value['version'],
      result: Object.freeze({ name: capability, leaves: Object.freeze(leaves) }), recipe: `delivery:${capability}.evaluate` });
  }
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
 * T19b exactness: `literal` defaults on `integer`/`decimal`/`money`/`duration`/`user`
 * inputs validate against the canonical wire shapes (int64 digit
 * strings, T11 exact decimals, exact-keys money) — JSON numbers,
 * malformed spellings, and out-of-range values reject the descriptor
 * instead of failing later at admission.
 */
function checkArtifactDefault(
  value: unknown,
  what: string,
  fieldKind: string,
  valueType: string = fieldKind,
): DerivedInputDefault | undefined {
  if (value === undefined) return undefined;
  if (!isDescriptorRecord(value) || typeof value['kind'] !== 'string') {
    failDescriptor('malformed_descriptor', `Invalid default for ${what}: a default object needs a kind.`);
  }
  const kind = value['kind'];
  if (kind === 'literal') {
    const literal = value['value'];
    if (fieldKind === 'duration' || fieldKind === 'user') {
      try {
        decodeValue(valueType, literal);
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
function checkArtifactFieldTag(value: unknown, what: string, inventory?: CanonicalValueTypes): McpSchemaField {
  if (!isDescriptorRecord(value) || typeof value['kind'] !== 'string') {
    failDescriptor('malformed_descriptor', `Invalid ${what}: input fields need a kind tag.`);
  }
  const kind = value['kind'];
  if (kind === 'nominal') {
    if (['kind', 'name'].some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor === undefined || !Object.hasOwn(descriptor, 'value');
    })) failDescriptor('malformed_descriptor', `Invalid ${what}: nominal claims must be own data.`);
    const name = value['name'];
    if (typeof name !== 'string' || inventory === undefined ||
        ![...inventory.contracts, ...(inventory.enums ?? []), ...(inventory.aliases ?? [])].some(declaration => declaration.name === name)) {
      failDescriptor('malformed_descriptor', `Invalid ${what}: nominal inputs require the full checked valueTypes inventory.`);
    }
    return { kind: 'nominal', name, valueTypes: inventory };
  }
  if (!CHECKED_INPUT_KINDS.has(kind)) {
    failDescriptor(
      'unknown_input_kind',
      `Unknown input kind ${JSON.stringify(kind)} for ${what}; ` +
        'supported: ref, string, integer, decimal, money, datetime, duration, user, boolean, file, enum, delivery.',
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
    case 'user':
      return { kind: 'user' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'file':
      return { kind: 'file' };
    default:
      // Unreachable: the closed-kind screen above admits only the scalar tags
      // past the `ref`/`enum` arms. Fail loud if that ever drifts.
      failDescriptor('unknown_input_kind', `Unknown input kind ${JSON.stringify(kind)} for ${what}.`);
  }
}

/** The T15a/T18 additive channels shared by caller-supplied and receipt inputs. */
interface CheckedInputChannels {
  readonly required: boolean;
  readonly valueType?: string;
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
  nominalName?: string,
  enumValues?: readonly string[],
): CheckedInputChannels {
  if (typeof value['required'] !== 'boolean') {
    failDescriptor('malformed_descriptor', `Invalid ${what}: required must be a boolean.`);
  }
  const valueType = `${fieldKind}${value['array'] === undefined ? '' : '[]'}${value['nullable'] === true ? '?' : ''}`;
  const fallback = checkArtifactDefault(value['default'], what, fieldKind, valueType);
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
  let claimedType: string | undefined;
  if (Object.hasOwn(value, 'valueType')) {
    const rawType = value['valueType'];
    if (typeof rawType !== 'string') {
      failDescriptor('malformed_descriptor', `Invalid ${what}: valueType must declare a supported scalar profile.`);
    }
    let type: ReturnType<typeof parseTypeId>;
    try {
      type = parseTypeId(rawType);
    } catch (err) {
      if (!(err instanceof ValueError)) throw err;
      failDescriptor('malformed_descriptor', `Invalid ${what}: valueType must declare a supported scalar profile.`);
    }
    const base = type.base.kind === 'nominal' && nominalName === type.base.path ? 'nominal'
      : type.base.kind === 'scalar' ? type.base.name
      : type.base.kind === 'user' || type.base.kind === 'file' || type.base.kind === 'enum' ? type.base.kind : undefined;
    if (base === undefined || (type.requiredArray && fieldKind !== 'nominal')) {
      failDescriptor('malformed_descriptor', `Invalid ${what}: valueType must declare a supported scalar profile.`);
    }
    const expectedKind = base === 'int' ? 'integer' : base === 'bool' ? 'boolean'
      : base === 'text' || base === 'date' ? 'string' : base;
    if (expectedKind !== fieldKind) {
      failDescriptor('malformed_descriptor', `Invalid ${what}: valueType disagrees with input kind.`);
    }
    if (type.base.kind === 'enum' && (enumValues === undefined ||
        type.base.cases.length !== enumValues.length ||
        type.base.cases.some((entry, index) => entry !== enumValues[index]))) {
      failDescriptor('malformed_descriptor', `Invalid ${what}: valueType disagrees with enum cases.`);
    }
    if (type.array !== (array !== undefined)) {
      failDescriptor('malformed_descriptor', `Invalid ${what}: valueType disagrees with array marker.`);
    }
    if (fieldKind === 'nominal' && type.requiredArray !== (array?.required === true)) {
      failDescriptor('malformed_descriptor', `Invalid ${what}: valueType disagrees with required array marker.`);
    }
    if ((Object.hasOwn(value, 'nullable') && typeof value['nullable'] !== 'boolean') ||
        type.nullable !== (value['nullable'] === true)) {
      failDescriptor('malformed_descriptor', `Invalid ${what}: valueType disagrees with nullable marker.`);
    }
    claimedType = rawType;
  }
  return {
    required: value['required'],
    ...(claimedType === undefined ? {} : { valueType: claimedType }),
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
function checkArtifactInput(value: unknown, opName: string, inventory?: CanonicalValueTypes): CheckedArtifactInput {
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
    const delivery = checkArtifactDeliveryDescriptor(tag, what, inventory);
    return { name, delivery, ...checkArtifactInputChannels(value, what, 'delivery') };
  }
  const field = checkArtifactFieldTag(tag, what, inventory);
  const channels = checkArtifactInputChannels(value, what, field.kind,
    field.kind === 'nominal' ? field.name : undefined, field.kind === 'enum' ? field.values : undefined);
  if (field.kind === 'nominal' && channels.default?.kind === 'literal') {
    const type = channels.valueType ?? `${field.name}${channels.array === undefined ? '' : channels.array.required ? '[]!' : '[]'}${channels.nullable ? '?' : ''}`;
    try { validateValue(normalizeValueTypes(field.valueTypes).valueSchema, type, channels.default.value, 'create'); }
    catch { failDescriptor('malformed_descriptor', `Invalid ${what}: nominal literal default fails its owning schema.`); }
  }
  return { name, field, ...channels };
}

/**
 * Check one operation descriptor: the shared T19a derivation rule. Any
 * unknown kind, server-owned input, duplicate input, or malformed member
 * rejects the WHOLE descriptor — nothing derives partially.
 */
function checkArtifactOperationBase(raw: unknown, inventory?: CanonicalValueTypes): CheckedArtifactOperation {
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
    const checked = checkArtifactInput(entry, name, inventory);
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

/** A choices claim needs its owning operation/read/model slice, never a single descriptor. */
export function checkArtifactOperation(raw: unknown): CheckedArtifactOperation {
  const checked = checkArtifactOperationBase(raw);
  if (rawChoiceFields(raw).length !== 0) {
    failDescriptor('malformed_descriptor', `Choices on ${JSON.stringify(checked.name)} require a full artifact operation/model slice.`);
  }
  return checked;
}

function choiceMember(value: unknown, key: string, what: string): unknown {
  if (typeof value !== 'object' || value === null) failDescriptor('malformed_descriptor', `Invalid ${what}: expected metadata object.`);
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (property === undefined) {
    if (key in value) failDescriptor('malformed_descriptor', `Invalid ${what}: inherited ${JSON.stringify(key)}.`);
    return undefined;
  }
  if (!Object.hasOwn(property, 'value')) failDescriptor('malformed_descriptor', `Invalid ${what}: accessor ${JSON.stringify(key)}.`);
  return property.value as unknown;
}

function choiceObject(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (!isDescriptorRecord(value) || Reflect.ownKeys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value, key)) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    failDescriptor('malformed_descriptor', `Invalid ${what}: expected exactly ${keys.join(', ')}.`);
  }
  for (const key of keys) choiceMember(value, key, what);
  return value;
}

function choiceName(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    failDescriptor('malformed_descriptor', `Invalid ${what}: expected a declared field name.`);
  }
  return value;
}

function choiceArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) failDescriptor('malformed_descriptor', `Invalid ${what}: expected an array.`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, String(index))) failDescriptor('malformed_descriptor', `Invalid ${what}: expected own array entries.`);
    choiceMember(value, String(index), what);
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) failDescriptor('malformed_descriptor', `Invalid ${what}: expected a dense metadata array.`);
  return value;
}

function rawChoiceFields(raw: unknown): Record<string, unknown>[] {
  if (!isDescriptorRecord(raw) || !isDescriptorRecord(raw['inputs']) || !Array.isArray(raw['inputs']['fields'])) return [];
  return raw['inputs']['fields'].filter((field: unknown): field is Record<string, unknown> =>
    isDescriptorRecord(field) && 'choices' in field);
}

interface ChoiceType {
  readonly kind: string;
  readonly model?: string;
  readonly scalar?: string;
  readonly enumValues?: readonly string[];
  readonly array: boolean;
  readonly nullable: boolean;
}
interface ChoiceModel {
  readonly fields: ReadonlyMap<string, Record<string, unknown>>;
  readonly parent?: string;
}

function inputChoiceType(field: CheckedArtifactInput, what: string): ChoiceType {
  if (isDeliveryField(field)) failDescriptor('malformed_descriptor', `Invalid ${what}: delivery inputs cannot supply choices.`);
  const tag = field.field;
  return { kind: tag.kind, ...(tag.kind === 'ref' ? { model: tag.model } : {}),
    ...(tag.kind === 'enum' ? { enumValues: tag.values } : {}),
    ...(field.valueType === undefined ? {} : { scalar: field.valueType.replace(/\[\]\??$|\?$/, '') }),
    array: field.array !== undefined, nullable: field.nullable === true };
}

function modelChoiceType(field: Record<string, unknown>, what: string): ChoiceType {
  const tag = choiceMember(field, 'field', what);
  const kind = choiceMember(tag, 'kind', what);
  if (typeof kind !== 'string') failDescriptor('malformed_descriptor', `Invalid ${what}: expected a field kind.`);
  const normalized = kind === 'date' ? 'string' : kind;
  if (!CHECKED_INPUT_KINDS.has(normalized) || normalized === 'delivery') {
    failDescriptor('malformed_descriptor', `Invalid ${what}: unsupported candidate field kind ${JSON.stringify(kind)}.`);
  }
  const model = kind === 'ref' ? choiceMember(tag, 'model', what) : undefined;
  if (kind === 'ref' && (typeof model !== 'string' || model === '')) failDescriptor('malformed_descriptor', `Invalid ${what}: expected a referenced model.`);
  const enumValues = kind === 'enum' ? choiceArray(choiceMember(tag, 'values', what), what).map(value => {
    if (typeof value !== 'string' || value === '') failDescriptor('malformed_descriptor', `Invalid ${what}: expected an enum case.`);
    return value;
  }) : undefined;
  const claimed = choiceMember(field, 'valueType', what);
  const array = choiceMember(field, 'array', what);
  const nullable = choiceMember(field, 'nullable', what);
  if (nullable !== undefined && typeof nullable !== 'boolean') failDescriptor('malformed_descriptor', `Invalid ${what}: invalid nullable marker.`);
  if (array !== undefined) {
    const marker = choiceObject(array, ['required'], what);
    if (typeof marker['required'] !== 'boolean') failDescriptor('malformed_descriptor', `Invalid ${what}: invalid array marker.`);
  }
  if (claimed !== undefined) {
    if (typeof claimed !== 'string') failDescriptor('malformed_descriptor', `Invalid ${what}: invalid checked type.`);
    let type: ReturnType<typeof parseTypeId>;
    try { type = parseTypeId(claimed); }
    catch { failDescriptor('malformed_descriptor', `Invalid ${what}: invalid checked type.`); }
    const base = type.base.kind === 'scalar' ? type.base.name : type.base.kind;
    const expected = base === 'int' ? 'integer' : base === 'bool' ? 'boolean' : base === 'text' || base === 'date' ? 'string' : base;
    if (expected !== normalized || type.array !== (array !== undefined) || type.nullable !== (nullable === true) || type.requiredArray) {
      failDescriptor('malformed_descriptor', `Invalid ${what}: checked type disagrees with owning field.`);
    }
  }
  return { kind: normalized, ...(typeof model === 'string' ? { model } : {}), ...(enumValues === undefined ? {} : { enumValues }),
    ...(typeof claimed === 'string' ? { scalar: claimed.replace(/\[\]\??$|\?$/, '') } : kind === 'date' ? { scalar: 'date' } : {}),
    array: array !== undefined, nullable: nullable === true };
}

function compatibleChoiceType(from: ChoiceType, to: ChoiceType, what: string, prerequisite = false): void {
  if (from.array || to.array || from.kind !== to.kind || from.model !== to.model ||
      (from.scalar !== undefined && to.scalar !== undefined && from.scalar !== to.scalar) ||
      (from.kind === 'string' && (from.scalar === undefined || to.scalar === undefined || from.scalar !== to.scalar)) ||
      (!prerequisite && from.nullable && !to.nullable) ||
      (from.kind === 'enum' && JSON.stringify(from.enumValues) !== JSON.stringify(to.enumValues))) {
    failDescriptor('malformed_descriptor', `Invalid ${what}: incompatible scalar/reference choice value.`);
  }
}

function attachInputChoices(raw: readonly unknown[], checked: CheckedArtifactOperation[], rawModels: unknown): CheckedArtifactOperation[] {
  const models = new Map<string, ChoiceModel>();
  for (const model of choiceArray(rawModels, 'choices model slice')) {
    const name = choiceMember(model, 'name', 'choices model');
    if (typeof name !== 'string' || name === '' || models.has(name)) failDescriptor('malformed_descriptor', 'Invalid or duplicate choices model name.');
    const fields = new Map<string, Record<string, unknown>>();
    for (const field of choiceArray(choiceMember(model, 'fields', name), name)) {
      const fieldName = choiceName(choiceMember(field, 'name', name), name);
      if (!isDescriptorRecord(field) || fields.has(fieldName)) failDescriptor('duplicate_name', `Duplicate candidate field ${fieldName}.`);
      fields.set(fieldName, field);
    }
    const parent = choiceMember(model, 'parent', name);
    if (parent !== undefined && (typeof parent !== 'string' || parent === '')) failDescriptor('malformed_descriptor', `Invalid parent model for ${name}.`);
    models.set(name, { fields, ...(typeof parent === 'string' ? { parent } : {}) });
  }
  const operations = new Map(checked.map((operation, index) => [operation.name, { checked: operation, raw: raw[index] }]));
  const edges = new Map<string, Set<string>>();
  const result = checked.map(operation => {
    const claims = rawChoiceFields(operations.get(operation.name)!.raw);
    const fields = operation.fields.map(field => {
      const claim = claims.find(candidate => choiceMember(candidate, 'name', operation.name) === field.name);
      if (claim === undefined) return field;
      const what = `choices for ${operation.name}.${field.name}`;
      const assisted = inputChoiceType(field, what);
      if (assisted.array) failDescriptor('malformed_descriptor', `Invalid ${what}: assisted input must be singular.`);
      if (assisted.model !== undefined && !models.has(assisted.model)) failDescriptor('malformed_descriptor', `Invalid ${what}: unknown assisted model.`);
      const binding = choiceObject(choiceMember(claim, 'choices', what), ['version', 'readOperation', 'arguments', 'value', 'labels'], what);
      if (binding['version'] !== 1) failDescriptor('version_mismatch', `Invalid ${what}: unsupported choices version.`);
      const target = typeof binding['readOperation'] === 'string' ? operations.get(binding['readOperation']) : undefined;
      if (target === undefined || target.checked.kind !== 'read' || target.checked.name.startsWith('std.')) {
        failDescriptor('malformed_descriptor', `Invalid ${what}: choices require a declared readonly business operation.`);
      }
      const resultType = choiceMember(choiceMember(target.raw, 'result', what), 'type', what);
      if (typeof resultType !== 'string' || !resultType.endsWith('[]') || !models.has(resultType.slice(0, -2))) {
        failDescriptor('undeclared_result', `Invalid ${what}: read result must be a declared singular model array.`);
      }
      const candidateName = resultType.slice(0, -2);
      const candidate = models.get(candidateName)!;
      const argumentsRaw = binding['arguments'];
      if (!isDescriptorRecord(argumentsRaw) || (Object.getPrototypeOf(argumentsRaw) !== Object.prototype && Object.getPrototypeOf(argumentsRaw) !== null)) {
        failDescriptor('malformed_descriptor', `Invalid ${what}: expected own argument mappings.`);
      }
      const argumentsChecked: Record<string, { readonly input: string; readonly path: readonly string[] }> = Object.create(null);
      const dependencies = new Set<string>();
      for (const param of Reflect.ownKeys(argumentsRaw)) {
        if (typeof param !== 'string') failDescriptor('malformed_descriptor', `Invalid ${what}: invalid argument name.`);
        const readParam = target.checked.fields.find(entry => entry.name === param);
        if (readParam === undefined) failDescriptor('malformed_descriptor', `Invalid ${what}: unknown read parameter ${param}.`);
        const mapping = choiceObject(choiceMember(argumentsRaw, param, what), ['input', 'path'], what);
        const input = choiceName(mapping['input'], what);
        const sourceField = operation.fields.find(entry => entry.name === input);
        if (sourceField === undefined) failDescriptor('malformed_descriptor', `Invalid ${what}: unknown owning input ${input}.`);
        let sourceType = inputChoiceType(sourceField, what);
        const path = choiceArray(mapping['path'], what).map(value => choiceName(value, what));
        for (const segment of path) {
          if (sourceType.array || sourceType.kind !== 'ref' || sourceType.model === undefined) failDescriptor('malformed_descriptor', `Invalid ${what}: unsupported non-record path.`);
          const owner = models.get(sourceType.model);
          const leaf = owner?.fields.get(segment);
          if (leaf !== undefined) sourceType = modelChoiceType(leaf, what);
          else if (segment === 'parent' && owner?.parent !== undefined && models.has(owner.parent)) sourceType = { kind: 'ref', model: owner.parent, array: false, nullable: false };
          else failDescriptor('malformed_descriptor', `Invalid ${what}: unknown model path ${segment}.`);
        }
        const readType = inputChoiceType(readParam, what);
        if ((sourceType.model !== undefined && !models.has(sourceType.model)) ||
            (readType.model !== undefined && !models.has(readType.model))) failDescriptor('malformed_descriptor', `Invalid ${what}: unknown argument model.`);
        // Absent/null prerequisites suppress lookup; the mapped value is
        // checked against the required read parameter only when present.
        compatibleChoiceType(sourceType, readType, what, true);
        argumentsChecked[param] = Object.freeze({ input, path: Object.freeze(path) });
        dependencies.add(`${operation.name}:${input}`);
      }
      for (const param of target.checked.fields) {
        if (isDeliveryField(param) || (param.required && !Object.hasOwn(argumentsChecked, param.name))) {
          failDescriptor('malformed_descriptor', `Invalid ${what}: required read parameter ${param.name} has no mapping.`);
        }
      }
      const value = binding['value'];
      const valueKind = choiceMember(value, 'kind', what);
      let checkedValue: InputChoiceBinding['value'];
      if (valueKind === 'record') {
        choiceObject(value, ['kind'], what);
        compatibleChoiceType({ kind: 'ref', model: candidateName, array: false, nullable: false }, assisted, what);
        checkedValue = Object.freeze({ kind: 'record' });
      } else if (valueKind === 'field') {
        const valueObject = choiceObject(value, ['kind', 'field'], what);
        const name = choiceName(valueObject['field'], what);
        const leaf = candidate.fields.get(name);
        if (leaf === undefined) failDescriptor('undeclared_leaf', `Invalid ${what}: unknown value field ${name}.`);
        compatibleChoiceType(modelChoiceType(leaf, what), assisted, what);
        checkedValue = Object.freeze({ kind: 'field', field: name });
      } else failDescriptor('malformed_descriptor', `Invalid ${what}: unsupported value selector.`);
      const labels = choiceArray(binding['labels'], what).map(value => choiceName(value, what));
      if (new Set(labels).size !== labels.length) failDescriptor('duplicate_name', `Invalid ${what}: duplicate label fields.`);
      for (const label of labels) {
        const leaf = candidate.fields.get(label);
        if (leaf === undefined) failDescriptor('undeclared_leaf', `Invalid ${what}: unknown label field ${label}.`);
        const type = modelChoiceType(leaf, what);
        if (type.array || ['file', 'delivery'].includes(type.kind)) {
          failDescriptor('malformed_descriptor', `Invalid ${what}: labels require singular scalar/reference/user leaves.`);
        }
      }
      edges.set(`${operation.name}:${field.name}`, dependencies);
      const choices: InputChoiceBinding = Object.freeze({ version: 1, readOperation: target.checked.name,
        arguments: Object.freeze(argumentsChecked), value: checkedValue, labels: Object.freeze(labels) });
      return { ...field, choices };
    });
    return { ...operation, fields: Object.freeze(fields) };
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) failDescriptor('malformed_descriptor', `Choices dependency cycle at ${name}.`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of edges.get(name) ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of edges.keys()) visit(name);
  return result;
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
  const inventoryDescriptor = Object.getOwnPropertyDescriptor(slice, 'valueTypes');
  if (inventoryDescriptor === undefined && 'valueTypes' in slice) failDescriptor('malformed_descriptor', 'valueTypes must be own data.');
  if (inventoryDescriptor !== undefined && !Object.hasOwn(inventoryDescriptor, 'value')) {
    failDescriptor('malformed_descriptor', 'valueTypes must be own data.');
  }
  let inventory: CanonicalValueTypes | undefined;
  if (inventoryDescriptor !== undefined) {
    try { inventory = normalizeValueTypes(inventoryDescriptor.value).valueTypes; }
    catch (error) { failDescriptor('malformed_descriptor', error instanceof Error ? error.message : 'Invalid valueTypes inventory.'); }
  }
  const raw: unknown = slice.operations;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    failDescriptor('malformed_descriptor', 'Invalid descriptor slice: operations must be an array.');
  }
  const seen = new Set<string>();
  const checked = raw.map((entry) => checkArtifactOperationBase(entry, inventory));
  for (const operation of checked) {
    if (seen.has(operation.name)) {
      failDescriptor('duplicate_name', `Duplicate operation descriptor: ${JSON.stringify(operation.name)}.`);
    }
    seen.add(operation.name);
  }
  return raw.some(entry => rawChoiceFields(entry).length !== 0)
    ? attachInputChoices(raw, checked, slice.models) : checked;
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
      ...(named.valueType === undefined ? {} : { valueType: named.valueType }),
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
  const shape: Record<string, unknown> = checked.array === undefined
    ? element
    : { type: 'array', items: element };
  const schema = (checked.field.kind === 'user' || checked.field.kind === 'nominal' || checked.field.kind === 'enum') && checked.nullable === true
    ? { anyOf: [shape, { type: 'null' }] }
    : shape;
  return checked.description === undefined ? schema : { ...schema, description: checked.description };
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
  if (!isMutationKind(checked.kind)) { hoistDefinitions(ordinary); return ordinary; }
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
  const root = { type: 'object', anyOf: [withOpId, handleMode] };
  hoistDefinitions(root);
  return root;
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
    case 'nominal':
      return bindingError(path, 'Nominal bindings require the complete owning value validation.');
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
    case 'user':
    case 'file':
    case 'duration': {
      // Values owns these wire shapes; full wrappers are checked at entry.
      try {
        decodeValue(input.kind, value);
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
  if (input.kind === 'nominal') {
    if (input.valueTypes === undefined || input.valueType === undefined) return bindingError(`/${input.name}`, 'Nominal input lacks its checked owning inventory.');
    try { validateValue(normalizeValueTypes(input.valueTypes).valueSchema, input.valueType, value, 'create'); return null; }
    catch (error) { return bindingError(`/${input.name}`, error instanceof Error ? error.message : 'Invalid nominal value.'); }
  }
  const path = `/${input.name}`;
  if (input.kind === 'user') {
    // The owning codec validates the complete profile, including array element nulls.
    const type = `user${input.array === undefined ? '' : '[]'}${input.nullable === true ? '?' : ''}`;
    try {
      decodeValue(type, value);
    } catch (err) {
      if (!(err instanceof SchemaError)) throw err;
      const violation = err.violations[0];
      const suffix = violation?.path.map((part) => String(part).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
      return bindingError(
        suffix ? `${path}/${suffix}` : path,
        `Invalid value for input ${JSON.stringify(input.name)}: ${violation?.message ?? err.message}.`,
      );
    }
    return null;
  }
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
