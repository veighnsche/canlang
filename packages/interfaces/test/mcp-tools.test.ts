/**
 * S5 MCP tool-generation tests: closed schemas per kind, operation_id and
 * handle-mode handling for mutations, verbatim descriptions, and closure at
 * every object level.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { McpNamedField, OperationDescriptor } from '../src/ports.js';
import { HANDLE_MODE_ALLOWED, handleModeAllowed, toJsonSchema, toToolInputSchema } from '../src/mcp/schemas.js';
import { toMcpTool, toolsFor } from '../src/mcp/tools.js';
import { createFakeOperationRegistry, createTestApp } from '../src/testing.js';

function field(name: string, kind: McpNamedField['field'], required = true): McpNamedField {
  return { name, field: kind, required };
}

const READ: OperationDescriptor = {
  name: 'TeamTasks.Todo.read',
  kind: 'read',
  description: 'Read one todo by id.',
  inputs: {
    fields: [field('record', { kind: 'ref', model: 'TeamTasks.Todo', requireVersion: false })],
  },
};

const UPDATE: OperationDescriptor = {
  name: 'TeamTasks.Todo.update',
  kind: 'update',
  description: 'Update a todo.',
  inputs: {
    fields: [
      field('record', { kind: 'ref', model: 'TeamTasks.Todo', requireVersion: true }),
      field('title', { kind: 'string' }, false),
      field('priority', { kind: 'integer' }, false),
      field('done', { kind: 'boolean' }, false),
    ],
  },
};

const SCENARIO: OperationDescriptor = {
  name: 'TeamTasks.complete',
  kind: 'scenario',
  description: 'Complete a todo with settlement details.',
  inputs: {
    fields: [
      field('record', { kind: 'ref', model: 'TeamTasks.Todo', requireVersion: true }),
      field('amount', { kind: 'money' }),
      field('rate', { kind: 'decimal' }),
      field('at', { kind: 'datetime' }),
      field('receipt', { kind: 'file' }, false),
      field('mode', { kind: 'enum', values: ['fast', 'slow'] }),
    ],
  },
};

const TEAM: OperationDescriptor = {
  name: 'system.team.invite',
  kind: 'team',
  description: 'Invite a member.',
  inputs: { fields: [field('email', { kind: 'string' })] },
};

/** Assert every shaped object node in a schema tree is explicitly closed. The
 * opaque `action_handle` pass-through ({type:'object'} with no properties)
 * is intentionally open: it carries a sealed blob L3/L4 verifies. */
function assertClosedEverywhere(node: unknown): void {
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;
  if (record['type'] === 'object' && 'properties' in record) {
    assert.equal(record['additionalProperties'], false, 'object level must be closed');
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) value.forEach(assertClosedEverywhere);
    else assertClosedEverywhere(value);
  }
}

test('read tool: plain closed schema, no operation_id', () => {
  const tool = toMcpTool(READ);
  assert.equal(tool.name, 'TeamTasks.Todo.read');
  assert.deepEqual(tool.inputSchema, {
    type: 'object',
    properties: {
      record: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    required: ['record'],
    additionalProperties: false,
  });
});

test('crud update tool: required operation_id plus anyOf handle alternative', () => {
  const schema = toToolInputSchema(UPDATE);
  assert.equal(schema['type'], 'object');
  const branches = schema['anyOf'];
  assert.ok(Array.isArray(branches) && branches.length === 2);
  const [ordinary, handle] = branches as Array<Record<string, unknown>>;
  assert.deepEqual(ordinary?.['required'], ['record', 'operation_id']);
  const props = ordinary?.['properties'] as Record<string, unknown>;
  assert.deepEqual(props?.['operation_id'], { type: 'string' });
  assert.deepEqual(props?.['title'], { type: 'string' });
  assert.deepEqual(props?.['priority'], { type: 'string' });
  assert.deepEqual(props?.['done'], { type: 'boolean' });
  assert.deepEqual(handle, {
    type: 'object',
    properties: {
      action_handle: { type: 'object' },
      operation_id: { type: 'string' },
      title: { type: 'string' },
      priority: { type: 'string' },
      done: { type: 'boolean' },
    },
    required: ['action_handle', 'operation_id'],
    additionalProperties: false,
  });
});

test('scenario tool: money/datetime/decimal/file/enum/ref rendering', () => {
  const schema = toToolInputSchema(SCENARIO);
  const branches = schema['anyOf'] as Array<Record<string, unknown>>;
  const props = (branches[0] as Record<string, unknown>)['properties'] as Record<string, unknown>;
  assert.deepEqual(props['amount'], {
    type: 'object',
    properties: { minor: { type: 'string' }, currency: { type: 'string' } },
    required: ['minor', 'currency'],
    additionalProperties: false,
  });
  assert.deepEqual(props['rate'], { type: 'string' });
  assert.deepEqual(props['at'], { type: 'string', format: 'date-time' });
  assert.deepEqual(props['receipt'], {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1 } },
    required: ['id'],
    additionalProperties: false,
  });
  assert.deepEqual(props['mode'], { type: 'string', enum: ['fast', 'slow'] });
  assert.deepEqual(props['record'], {
    type: 'object',
    properties: { id: { type: 'string' }, version: { type: 'string' } },
    required: ['id', 'version'],
    additionalProperties: false,
  });
  assert.deepEqual((branches[0] as Record<string, unknown>)['required'], [
    'record',
    'amount',
    'rate',
    'at',
    'mode',
    'operation_id',
  ]);
});

test('team tool: handle alternative present', () => {
  const schema = toToolInputSchema(TEAM);
  const branches = schema['anyOf'] as Array<Record<string, unknown>>;
  assert.equal(branches.length, 2);
  assert.deepEqual(
    (branches[1] as Record<string, unknown>)['required'],
    ['action_handle', 'operation_id'],
  );
});

test('description verbatim; toolsFor maps registry list', () => {
  const app = createTestApp();
  const registry = createFakeOperationRegistry([READ, UPDATE]);
  const tools = toolsFor(registry, app);
  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.description, 'Read one todo by id.');
  assert.equal(tools[1]?.description, 'Update a todo.');
  assert.deepEqual(
    tools.map((t) => t.name),
    ['TeamTasks.Todo.read', 'TeamTasks.Todo.update'],
  );
});

test('closed: additionalProperties false at every object level', () => {
  for (const descriptor of [READ, UPDATE, SCENARIO, TEAM]) {
    assertClosedEverywhere(toToolInputSchema(descriptor));
  }
  assertClosedEverywhere(toJsonSchema({ fields: [] }));
});

test('HANDLE_MODE_ALLOWED contents', () => {
  assert.deepEqual([...HANDLE_MODE_ALLOWED], ['action_handle', 'operation_id']);
});

test('handleModeAllowed: base members plus non-ref fields, never refs', () => {
  assert.deepEqual([...handleModeAllowed(UPDATE)], [
    'action_handle',
    'operation_id',
    'title',
    'priority',
    'done',
  ]);
  assert.deepEqual([...handleModeAllowed(TEAM)], ['action_handle', 'operation_id', 'email']);
  assert.deepEqual([...handleModeAllowed(READ)], ['action_handle', 'operation_id']);
});
