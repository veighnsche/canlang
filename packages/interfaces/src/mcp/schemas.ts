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

/** Closed top-level members allowed in handle-mode args (server.ts validates). */
export const HANDLE_MODE_ALLOWED = ['action_handle', 'operation_id'] as const;

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
      return { type: 'integer' };
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
  const handleMode: Record<string, unknown> = {
    type: 'object',
    properties: {
      // Opaque sealed object: object-only shape check; L3/L4 verifies contents.
      action_handle: { type: 'object' },
      operation_id: { type: 'string' },
    },
    required: ['action_handle', 'operation_id'],
    additionalProperties: false,
  };
  return { anyOf: [withOpId, handleMode] };
}
