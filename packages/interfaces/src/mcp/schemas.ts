/**
 * S5 closed-schema derivation: typed operation inputs to closed JSON Schema.
 *
 * Every object rendered here is closed (`additionalProperties: false`) so
 * unknown arguments fail validation (DESIGN section 10). Mutation kinds
 * additionally accept handle mode via `anyOf`; the `action_handle` member is
 * an opaque sealed object here — shape check is object-only, verification is
 * L3/L4's job.
 */
import { ARTIFACT_VERSION } from '@canlang/contracts';
import type { ArtifactOperation, DerivedInputDefault } from '@canlang/contracts';
import type {
  McpInputSchema,
  McpNamedField,
  McpOperationKind,
  McpSchemaField,
  OperationDescriptor,
} from '../ports.js';

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

/** Mutation kinds carry `operation_id` and admit the handle-mode alternative. */
function isMutationKind(kind: McpOperationKind): boolean {
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
/* provider receipts) rejects precisely as T19b remainder; unknown     */
/* operation/input/default kinds, duplicate names, and malformed       */
/* members reject the whole descriptor or slice. `literal`/`parent`    */
/* defaults pin verbatim as documented optionality — derivation never  */
/* invents fill values. Dangling `ref` model targets are NOT checked   */
/* here: set executability (ref/model graph, CRUD shapes, uniques) is  */
/* the L3 loader's job; this layer derives per-operation input views.  */
/* ------------------------------------------------------------------ */

/**
 * Machine-readable whole-descriptor rejection reasons. Mirrors the L3
 * `IncompatibleArtifactReason` vocabulary plus the T19a server-owned bar.
 */
export type IncompatibleDescriptorReason =
  | 'version_mismatch'
  | 'unknown_operation_kind'
  | 'unknown_input_kind'
  | 'unknown_default_kind'
  | 'server_owned_input'
  | 'duplicate_name'
  | 'malformed_descriptor';

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

/** One checked operation: the derivation input every T19a builder shares. */
export interface CheckedArtifactOperation {
  readonly name: string;
  readonly kind: 'read' | 'create' | 'update' | 'delete' | 'scenario';
  readonly description: string;
  readonly fields: readonly CheckedArtifactField[];
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
  'boolean',
  'file',
  'enum',
]);

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
 */
function checkArtifactDefault(value: unknown, what: string): DerivedInputDefault | undefined {
  if (value === undefined) return undefined;
  if (!isDescriptorRecord(value) || typeof value['kind'] !== 'string') {
    failDescriptor('malformed_descriptor', `Invalid default for ${what}: a default object needs a kind.`);
  }
  const kind = value['kind'];
  if (kind === 'literal') {
    return { kind: 'literal', value: value['value'] };
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
      kind === 'delivery'
        ? `Invalid ${what}: bound provider-receipt inputs need T19b (T13/T14 depth) and cannot derive in the T19a pilot scope.`
        : `Unknown input kind ${JSON.stringify(kind)} for ${what}; ` +
          'supported: ref, string, integer, decimal, money, datetime, boolean, file, enum.',
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
    case 'boolean':
      return { kind: 'boolean' };
    case 'file':
      return { kind: 'file' };
    default:
      // Unreachable: the closed-kind screen above admits only these seven
      // past the `ref`/`enum` arms. Fail loud if that ever drifts.
      failDescriptor('unknown_input_kind', `Unknown input kind ${JSON.stringify(kind)} for ${what}.`);
  }
}

/** Check one operation input: shape, closed kind, documented default, additive channels. */
function checkArtifactInput(value: unknown, opName: string): CheckedArtifactField {
  if (!isDescriptorRecord(value) || typeof value['name'] !== 'string' || value['name'] === '') {
    failDescriptor(
      'malformed_descriptor',
      `Invalid input on operation ${JSON.stringify(opName)}: inputs need non-empty names.`,
    );
  }
  const name = value['name'];
  const what = `input ${JSON.stringify(name)} on operation ${JSON.stringify(opName)}`;
  const field = checkArtifactFieldTag(value['field'], what);
  if (typeof value['required'] !== 'boolean') {
    failDescriptor('malformed_descriptor', `Invalid ${what}: required must be a boolean.`);
  }
  const fallback = checkArtifactDefault(value['default'], what);
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
    name,
    field,
    required: value['required'],
    ...(value['nullable'] === true ? { nullable: true as const } : {}),
    ...(array === undefined ? {} : { array }),
    ...(fallback === undefined ? {} : { default: fallback }),
    ...(description === undefined ? {} : { description }),
  };
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
  const fields: CheckedArtifactField[] = [];
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
 */
export function checkedToMcpInputSchema(checked: CheckedArtifactOperation): McpInputSchema {
  return {
    fields: checked.fields.map(
      (named): McpNamedField => ({
        name: named.name,
        field: named.field,
        required: named.required,
        ...(named.description === undefined ? {} : { description: named.description }),
      }),
    ),
  };
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
    if (named.field.kind === 'ref') continue;
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
