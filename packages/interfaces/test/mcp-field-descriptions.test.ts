/**
 * MCP P4 field-description tests: authored `@{desc}` text renders as the
 * JSON Schema property `description` (ordinary and handle-mode branches);
 * undescribed inputs render no key and stay valid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpNamedField, OperationDescriptor } from '../src/ports.js';
import { toJsonSchema, toToolInputSchema } from '../src/mcp/schemas.js';
import { toMcpTool } from '../src/mcp/tools.js';

function field(
  name: string,
  kind: McpNamedField['field'],
  required = true,
  description?: string,
): McpNamedField {
  return description === undefined ? { name, field: kind, required } : { name, field: kind, required, description };
}

const READ: OperationDescriptor = {
  name: 'TeamTasks.Todo.read',
  kind: 'read',
  description: 'Read one todo.',
  inputs: {
    fields: [
      field('record', { kind: 'ref', model: 'TeamTasks.Todo', requireVersion: false }, true, 'The todo to read.'),
      field('note', { kind: 'string' }, false),
    ],
  },
};

const UPDATE: OperationDescriptor = {
  name: 'TeamTasks.Todo.update',
  kind: 'update',
  description: 'Update a todo.',
  inputs: {
    fields: [
      field('record', { kind: 'ref', model: 'TeamTasks.Todo', requireVersion: true }),
      field('title', { kind: 'string' }, false, 'Display title.'),
      field('priority', { kind: 'integer' }, false),
    ],
  },
};

test('read tool: property description present when authored, absent-but-valid when not', () => {
  const tool = toMcpTool(READ);
  const properties = (tool.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
  assert.equal(properties['record']?.['description'], 'The todo to read.');
  assert.equal(properties['record']?.['type'], 'object');
  assert.ok(!('description' in (properties['note'] as Record<string, unknown>)));
  assert.deepEqual(properties['note'], { type: 'string' });
});

test('mutation tool: descriptions render in both ordinary and handle-mode branches', () => {
  const schema = toToolInputSchema(UPDATE) as {
    type: string;
    anyOf: [{ properties: Record<string, Record<string, unknown>> }, { properties: Record<string, Record<string, unknown>> }];
  };
  assert.equal(schema.type, 'object');
  const [ordinary, handle] = schema.anyOf;
  assert.equal(ordinary.properties['title']?.['description'], 'Display title.');
  assert.equal(handle.properties['title']?.['description'], 'Display title.');
  assert.ok(!('description' in (ordinary.properties['priority'] as Record<string, unknown>)));
  assert.ok(!('description' in (handle.properties['priority'] as Record<string, unknown>)));
  // Ref inputs stay out of handle mode; framing members carry no description.
  assert.ok(!('record' in handle.properties));
  assert.ok(!('description' in (handle.properties['operation_id'] as Record<string, unknown>)));
});

test('undescribed inputs render byte-identical schemas', () => {
  const plain = toJsonSchema({ fields: [field('title', { kind: 'string' }, false)] });
  assert.deepEqual(plain, {
    type: 'object',
    properties: { title: { type: 'string' } },
    required: [],
    additionalProperties: false,
  });
});

test('object-typed properties carry description beside the shape', () => {
  const schema = toJsonSchema({
    fields: [field('amount', { kind: 'money' }, true, 'Settlement amount.')],
  });
  assert.deepEqual(schema.properties['amount'], {
    type: 'object',
    properties: { minor: { type: 'string' }, currency: { type: 'string' } },
    required: ['minor', 'currency'],
    additionalProperties: false,
    description: 'Settlement amount.',
  });
});
