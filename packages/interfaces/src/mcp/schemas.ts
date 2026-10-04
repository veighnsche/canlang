/**
 * S5 closed-schema derivation: typed operation inputs to closed JSON Schema.
 *
 * Every object rendered here is closed (`additionalProperties: false`) so
 * unknown arguments fail validation (DESIGN section 10). Mutation kinds
 * additionally accept handle mode via `anyOf`; the `action_handle` member is
 * an opaque sealed object here — shape check is object-only, verification is
 * L3/L4's job.
 */
import type {
  McpInputSchema,
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
    properties[named.name] = fieldSchema(named.field);
    if (named.required) required.push(named.name);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * Full tool input schema for one operation. Reads/lists get the plain closed
 * schema. Mutations get `operation_id` added as a required string, plus an
 * `anyOf` handle-mode alternative carrying only the sealed handle and the
 * operation id.
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
    handleProperties[named.name] = fieldSchema(named.field);
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
