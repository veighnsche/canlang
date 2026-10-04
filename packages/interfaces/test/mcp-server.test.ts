/**
 * S5 MCP server tests: raw JSON-RPC POSTs through `createMcpHandler` —
 * initialize advertisement, discovery filtering, call framing, auth, and
 * the same-invocation proof against S4 HTTP.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  deriveCsrfToken,
  issueMcpGrant,
  registerWithEmail,
  verifyEmail,
} from '@canlang/identity';
import { FILE_TRANSFER_META_KEY } from '@canlang/contracts';
import { createMcpHandler } from '../src/mcp/server.js';
import { createHttpHandler } from '../src/http/routes.js';
import { handleOperationRequest } from '../src/http/operations.js';
import {
  createFakeCatalog,
  createFakeRegistry,
  createMemoryRateLimiter,
  createTestApp,
  createTestIdentityDeps,
  createTestMcpDeps,
  testRequest,
} from '../src/testing.js';
import type { TestMcpDeps } from '../src/testing.js';
import { systemInterfacesClock } from '../src/ports.js';
import type { HttpDeps, OperationDescriptor, OperationInputShape } from '../src/ports.js';
import { buildBusinessError } from '../src/errors/envelope.js';

const READ_OP = 'acme.Todo.read';
const MUT_OP = 'acme.Todo.create';
const UPDATE_OP = 'acme.Todo.update';
const TEAM_OP = 'system.team.invite';
const HIDDEN_OP = 'acme.secret';

const DESCRIPTORS: readonly OperationDescriptor[] = [
  { name: READ_OP, kind: 'read', description: 'Read a todo.', inputs: { fields: [] } },
  {
    name: MUT_OP,
    kind: 'create',
    description: 'Create a todo.',
    inputs: {
      fields: [
        { name: 'qty', field: { kind: 'integer' }, required: true },
        { name: 'label', field: { kind: 'string' }, required: false },
      ],
    },
  },
  {
    name: UPDATE_OP,
    kind: 'update',
    description: 'Update a todo.',
    inputs: {
      fields: [
        { name: 'record', field: { kind: 'ref', model: 'acme.Todo', requireVersion: true }, required: true },
      ],
    },
  },
  {
    name: TEAM_OP,
    kind: 'team',
    description: 'Invite a member.',
    inputs: { fields: [{ name: 'email', field: { kind: 'string' }, required: true }] },
  },
  { name: HIDDEN_OP, kind: 'read', description: 'Hidden op.', inputs: { fields: [] } },
];

const SHAPES: Record<string, OperationInputShape> = {
  [READ_OP]: { allowed: [], required: [] },
  [MUT_OP]: { allowed: ['qty', 'label'], required: ['qty'] },
  [UPDATE_OP]: { allowed: ['record'], required: ['record'] },
  [TEAM_OP]: { allowed: ['email'], required: ['email'] },
  [HIDDEN_OP]: { allowed: [], required: [] },
};

const INIT_PARAMS = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'test-client', version: '0.0.0' },
};

/** Fresh canonical UUIDv7 operation_id with the time field at `atMs`. */
function freshOperationId(atMs: number = Date.now()): string {
  const timeHex = atMs.toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

interface RpcErrorBody {
  readonly code: number;
  readonly message: string;
}

interface RpcBody {
  readonly result?: unknown;
  readonly error?: RpcErrorBody;
}

interface ToolResultBody {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
}

interface AuthErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

type McpHandler = (request: Request) => Promise<Response>;

async function mcpCall(
  handler: McpHandler,
  method: string,
  params: Record<string, unknown>,
  opts: { grant?: string; cookie?: string; id?: number } = {},
): Promise<{ status: number; body: RpcBody }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (opts.grant !== undefined) headers['authorization'] = `Bearer ${opts.grant}`;
  const res = await handler(
    testRequest('/mcp', {
      method: 'POST',
      headers,
      ...(opts.cookie === undefined ? {} : { cookie: opts.cookie }),
      body: JSON.stringify({ jsonrpc: '2.0', id: opts.id ?? 1, method, params }),
    }),
  );
  return { status: res.status, body: (await res.json()) as RpcBody };
}

function toolResult(body: RpcBody): ToolResultBody {
  assert.ok(body.result !== undefined && body.error === undefined);
  return body.result as ToolResultBody;
}

function rpcError(body: RpcBody): RpcErrorBody {
  assert.ok(body.error !== undefined);
  return body.error;
}

async function setup(opts: {
  discover?: Record<string, boolean>;
  call?: Record<string, boolean>;
  usesFiles?: boolean;
} = {}): Promise<TestMcpDeps & { handler: McpHandler }> {
  const t = await createTestMcpDeps({
    descriptors: DESCRIPTORS,
    shapes: SHAPES,
    mutations: {
      [MUT_OP]: (envelope) => ({
        result: {
          status: 'committed',
          operation_id: envelope.operation_id,
          result: { echoed: envelope.inputs },
        },
      }),
      [UPDATE_OP]: (envelope) => ({
        result: {
          status: 'committed',
          operation_id: envelope.operation_id,
          result: { echoed: envelope.inputs },
        },
      }),
      [TEAM_OP]: (envelope) => ({
        result: { status: 'committed', operation_id: envelope.operation_id, result: null },
      }),
    },
    reads: {
      [READ_OP]: () => ({ result: { item: { id: 'todo-1', title: 'Tested' } } }),
      [HIDDEN_OP]: () => ({ result: { secret: true } }),
    },
    ...(opts.discover === undefined ? {} : { discover: opts.discover }),
    ...(opts.call === undefined ? {} : { call: opts.call }),
    ...(opts.usesFiles === undefined ? {} : { usesFiles: opts.usesFiles }),
  });
  return { ...t, handler: createMcpHandler(t.deps) };
}

/** Register a second, non-owner member on the fixture team and grant them. */
async function createNonOwnerGrant(t: TestMcpDeps): Promise<string> {
  const store = t.deps.identity.store;
  const mail = t.identity.mail;
  await registerWithEmail(
    store,
    mail,
    { email: 'bob@test.example', password: 's3cure-password' },
    { verifyBaseUrl: 'https://test.invalid/verify' },
  );
  const last = mail.messages[mail.messages.length - 1];
  assert.ok(last);
  const token = (last.body_text.match(/[?&]token=([A-Za-z0-9_-]+)/) ?? [])[1] ?? '';
  const { user_id } = await verifyEmail(store, { token });
  await store.createMembership({ team_id: t.identity.teamId, user_id, is_owner: false, roles: [] });
  const issued = await issueMcpGrant(
    store,
    { user_id, team_id: t.identity.teamId, client_id: 'test-client' },
    {},
  );
  return issued.token;
}

test('initialize advertises the fileTransfer _meta when the app uses files', async () => {
  const t = await setup({ usesFiles: true });
  const { status, body } = await mcpCall(t.handler, 'initialize', INIT_PARAMS, { grant: t.grantToken });
  assert.equal(status, 200);
  const result = body.result as {
    protocolVersion: string;
    serverInfo: { name: string; version: string };
    _meta?: Record<string, unknown>;
  };
  assert.equal(result.protocolVersion, '2025-11-25');
  assert.equal(result.serverInfo.name, 'can-mcp');
  assert.equal(result.serverInfo.version, '0.1.0');
  assert.deepEqual(result._meta?.[FILE_TRANSFER_META_KEY], {
    version: 1,
    intents: 'https://test.invalid/uploads/intents',
  });
});

test('initialize omits the fileTransfer _meta when the app has no files', async () => {
  const t = await setup({ usesFiles: false });
  const { body } = await mcpCall(t.handler, 'initialize', INIT_PARAMS, { grant: t.grantToken });
  const result = body.result as { protocolVersion: string; _meta?: Record<string, unknown> };
  assert.equal(result.protocolVersion, '2025-11-25');
  assert.equal(result._meta, undefined);
});

test('initialize falls back to the latest protocol version when unsupported', async () => {
  const t = await setup({});
  const { body } = await mcpCall(
    t.handler,
    'initialize',
    { ...INIT_PARAMS, protocolVersion: '1999-01-01' },
    { grant: t.grantToken },
  );
  const result = body.result as { protocolVersion: string };
  assert.equal(result.protocolVersion, '2025-11-25');
});

test('tools/list filters by canDiscover and shows team tools to owners', async () => {
  const t = await setup({ discover: { [HIDDEN_OP]: false } });
  const { body } = await mcpCall(t.handler, 'tools/list', {}, { grant: t.grantToken });
  const result = body.result as { tools: Array<{ name: string }> };
  const names = result.tools.map((tool) => tool.name);
  assert.ok(names.includes(READ_OP));
  assert.ok(names.includes(MUT_OP));
  assert.ok(names.includes(TEAM_OP));
  assert.ok(!names.includes(HIDDEN_OP));
});

test('tools/list hides team tools from non-owners', async () => {
  const t = await setup({});
  const nonOwner = await createNonOwnerGrant(t);
  const { body } = await mcpCall(t.handler, 'tools/list', {}, { grant: nonOwner });
  const result = body.result as { tools: Array<{ name: string }> };
  const names = result.tools.map((tool) => tool.name);
  assert.ok(names.includes(READ_OP));
  assert.ok(names.includes(MUT_OP));
  assert.ok(!names.includes(TEAM_OP));
});

test('tools/call read success returns text + structuredContent', async () => {
  const t = await setup({});
  const { status, body } = await mcpCall(
    t.handler,
    'tools/call',
    { name: READ_OP, arguments: {} },
    { grant: t.grantToken },
  );
  assert.equal(status, 200);
  const result = toolResult(body);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, { item: { id: 'todo-1', title: 'Tested' } });
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]?.type, 'text');
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ''), {
    item: { id: 'todo-1', title: 'Tested' },
  });
  assert.equal(t.invoker.reads.length, 1);
  assert.deepEqual(t.invoker.reads[0]?.envelope, { operation: READ_OP, inputs: {} });
});

test('tools/call mutation success invokes with the operation envelope', async () => {
  const t = await setup({});
  const operation_id = freshOperationId();
  const { body } = await mcpCall(
    t.handler,
    'tools/call',
    { name: MUT_OP, arguments: { operation_id, qty: '2', label: 'x' } },
    { grant: t.grantToken },
  );
  const result = toolResult(body);
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    status: 'committed',
    operation_id,
    result: { echoed: { qty: '2', label: 'x' } },
  });
  assert.equal(t.invoker.mutations.length, 1);
  assert.deepEqual(t.invoker.mutations[0]?.envelope, {
    operation: MUT_OP,
    operation_id,
    inputs: { qty: '2', label: 'x' },
  });
});

test('tools/call unknown tool is InvalidParams', async () => {
  const t = await setup({});
  const { body } = await mcpCall(
    t.handler,
    'tools/call',
    { name: 'acme.Nope.missing', arguments: {} },
    { grant: t.grantToken },
  );
  assert.equal(rpcError(body).code, -32602);
});

test('tools/call unknown argument is InvalidParams and never invokes', async () => {
  const t = await setup({});
  const { body } = await mcpCall(
    t.handler,
    'tools/call',
    { name: MUT_OP, arguments: { operation_id: freshOperationId(), qty: '1', bogus: 2 } },
    { grant: t.grantToken },
  );
  assert.equal(rpcError(body).code, -32602);
  assert.equal(t.invoker.mutations.length, 0);
});

test('tools/call mutation without operation_id is InvalidParams', async () => {
  const t = await setup({});
  const { body } = await mcpCall(
    t.handler,
    'tools/call',
    { name: MUT_OP, arguments: { qty: '1' } },
    { grant: t.grantToken },
  );
  assert.equal(rpcError(body).code, -32602);
  assert.equal(t.invoker.mutations.length, 0);
});

test('tools/call mutation ref with a bad version shape is InvalidParams', async () => {
  const t = await setup({});
  const bad = await mcpCall(
    t.handler,
    'tools/call',
    { name: UPDATE_OP, arguments: { operation_id: freshOperationId(), record: { id: 'r1', version: 'nope' } } },
    { grant: t.grantToken },
  );
  assert.equal(rpcError(bad.body).code, -32602);
  const numeric = await mcpCall(
    t.handler,
    'tools/call',
    { name: UPDATE_OP, arguments: { operation_id: freshOperationId(), record: { id: 'r1', version: 3 } } },
    { grant: t.grantToken },
  );
  assert.equal(rpcError(numeric.body).code, -32602);
  assert.equal(t.invoker.mutations.length, 0);
});

test('tools/call handle mode passes framing and the invoker receives action_handle', async () => {
  const t = await setup({});
  const action_handle = { kind: 'action_handle', handle: 'sealed-1', target: MUT_OP, revision: '1' };
  const operation_id = freshOperationId();
  const { body } = await mcpCall(
    t.handler,
    'tools/call',
    { name: MUT_OP, arguments: { action_handle, operation_id } },
    { grant: t.grantToken },
  );
  const result = toolResult(body);
  assert.equal(result.isError, undefined);
  assert.equal(t.invoker.mutations.length, 1);
  assert.deepEqual(t.invoker.mutations[0]?.envelope, {
    operation: MUT_OP,
    operation_id,
    inputs: { action_handle },
  });
});

test('tools/call handle mode forwards non-record canonical inputs', async () => {
  const t = await setup({});
  const action_handle = { kind: 'action_handle', handle: 'sealed-2', target: MUT_OP, revision: '1' };
  const operation_id = freshOperationId();
  const { body } = await mcpCall(
    t.handler,
    'tools/call',
    { name: MUT_OP, arguments: { action_handle, operation_id, label: 'via-delegation' } },
    { grant: t.grantToken },
  );
  const result = toolResult(body);
  assert.equal(result.isError, undefined);
  assert.equal(t.invoker.mutations.length, 1);
  assert.deepEqual(t.invoker.mutations[0]?.envelope, {
    operation: MUT_OP,
    operation_id,
    inputs: { action_handle, label: 'via-delegation' },
  });
});

test('tools/call handle mode with a non-object handle is InvalidParams', async () => {
  const t = await setup({});
  const { body } = await mcpCall(
    t.handler,
    'tools/call',
    { name: MUT_OP, arguments: { action_handle: 'not-an-object', operation_id: freshOperationId() } },
    { grant: t.grantToken },
  );
  assert.equal(rpcError(body).code, -32602);
  assert.equal(t.invoker.mutations.length, 0);
});

test('tools/call with a malformed operation_id is InvalidParams', async () => {
  const t = await setup({});
  const { body } = await mcpCall(
    t.handler,
    'tools/call',
    { name: MUT_OP, arguments: { operation_id: 'not-a-uuid', qty: '1' } },
    { grant: t.grantToken },
  );
  assert.equal(rpcError(body).code, -32602);
  assert.equal(t.invoker.mutations.length, 0);
});

test('tools/call read carrying operation_id fails closed', async () => {
  const t = await setup({});
  const { body } = await mcpCall(
    t.handler,
    'tools/call',
    { name: READ_OP, arguments: { operation_id: freshOperationId() } },
    { grant: t.grantToken },
  );
  assert.equal(rpcError(body).code, -32602);
  assert.equal(t.invoker.reads.length, 0);
});

test('tools/call with non-object arguments is rejected without invoking', async () => {
  const t = await setup({});
  const { body } = await mcpCall(
    t.handler,
    'tools/call',
    { name: READ_OP, arguments: 'nope' },
    { grant: t.grantToken },
  );
  // The SDK protocol layer rejects unparseable params before our handler
  // runs (its code, -32603); our own non-object guard stays as
  // defense-in-depth. What matters: no invocation, no leak.
  assert.equal(rpcError(body).code, -32603);
  assert.equal(t.invoker.reads.length, 0);
});

test('tools/call read ref carrying a version is InvalidParams', async () => {
  const descriptor: OperationDescriptor = {
    name: 'acme.Todo.readByRef',
    kind: 'read',
    description: 'Read with a ref.',
    inputs: { fields: [{ name: 'record', field: { kind: 'ref', model: 'acme.Todo', requireVersion: false }, required: true }] },
  };
  const t = await createTestMcpDeps({
    descriptors: [descriptor],
    shapes: { 'acme.Todo.readByRef': { allowed: ['record'], required: ['record'] } },
    reads: { 'acme.Todo.readByRef': () => ({ result: null }) },
  });
  const handler = createMcpHandler(t.deps);
  const { body } = await mcpCall(
    handler,
    'tools/call',
    { name: descriptor.name, arguments: { record: { id: 'r1', version: '3' } } },
    { grant: t.grantToken },
  );
  assert.equal(rpcError(body).code, -32602);
  assert.equal(t.invoker.reads.length, 0);
});

test('tools/call registry/catalog skew answers not_found isError', async () => {
  const t = await createTestMcpDeps({
    descriptors: DESCRIPTORS,
    shapes: { [READ_OP]: { allowed: [], required: [] } },
    reads: { [READ_OP]: () => ({ result: null }) },
  });
  const handler = createMcpHandler(t.deps);
  const { body } = await mcpCall(
    handler,
    'tools/call',
    { name: MUT_OP, arguments: { operation_id: freshOperationId(), qty: '1' } },
    { grant: t.grantToken },
  );
  const result = toolResult(body);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.['code'], 'not_found');
  assert.equal(t.invoker.mutations.length, 0);
});

test('tools/call handle mode with a record input is InvalidParams', async () => {
  const t = await setup({});
  const action_handle = { kind: 'action_handle', handle: 'sealed-1', target: UPDATE_OP, revision: '1' };
  const { body } = await mcpCall(
    t.handler,
    'tools/call',
    {
      name: UPDATE_OP,
      arguments: { action_handle, operation_id: freshOperationId(), record: { id: 'r1', version: '3' } },
    },
    { grant: t.grantToken },
  );
  assert.equal(rpcError(body).code, -32602);
  assert.equal(t.invoker.mutations.length, 0);
});

test('tools/call handle mode on a read tool is InvalidParams', async () => {
  const t = await setup({});
  const { body } = await mcpCall(
    t.handler,
    'tools/call',
    {
      name: READ_OP,
      arguments: { action_handle: { kind: 'action_handle', handle: 'h', target: READ_OP, revision: '1' }, operation_id: freshOperationId() },
    },
    { grant: t.grantToken },
  );
  assert.equal(rpcError(body).code, -32602);
  assert.equal(t.invoker.reads.length, 0);
});

test('tools/call denied by canCall is an isError forbidden, not a protocol error', async () => {
  const t = await setup({ call: { [READ_OP]: false } });
  const { body } = await mcpCall(
    t.handler,
    'tools/call',
    { name: READ_OP, arguments: {} },
    { grant: t.grantToken },
  );
  const result = toolResult(body);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.['code'], 'forbidden');
  assert.equal(
    result.structuredContent?.['message'],
    'You do not have permission to perform this action.',
  );
  assert.equal(t.invoker.reads.length, 0);
  const denied = t.logger.calls.find((call) => call.level === 'info');
  assert.ok(denied);
  assert.equal(denied.fields?.['code'], 'forbidden');
  assert.equal(denied.fields?.['tool'], READ_OP);
});

test('tools/call team tool by a non-owner is an isError forbidden on the call path', async () => {
  const t = await setup();
  const nonOwner = await createNonOwnerGrant(t);
  const { body } = await mcpCall(
    t.handler,
    'tools/call',
    { name: TEAM_OP, arguments: { email: 'new@test.example', operation_id: freshOperationId() } },
    { grant: nonOwner },
  );
  const result = toolResult(body);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.['code'], 'forbidden');
  assert.equal(t.invoker.mutations.length, 0);
});

test('tools/call business error is an isError with the safe message', async () => {
  const t = await createTestMcpDeps({
    descriptors: DESCRIPTORS,
    shapes: SHAPES,
    reads: {
      [READ_OP]: () => ({ error: buildBusinessError('rule_failed', 'The widget is locked.') }),
    },
  });
  const handler = createMcpHandler(t.deps);
  const { body } = await mcpCall(
    handler,
    'tools/call',
    { name: READ_OP, arguments: {} },
    { grant: t.grantToken },
  );
  const result = toolResult(body);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.['code'], 'rule_failed');
  assert.equal(result.structuredContent?.['message'], 'The widget is locked.');
  assert.ok((result.content[0]?.text ?? '').includes('rule_failed'));
});

test('tools/call invoker throw is InternalError with a generic message', async () => {
  const t = await createTestMcpDeps({
    descriptors: DESCRIPTORS,
    shapes: SHAPES,
    reads: {
      [READ_OP]: () => {
        throw new Error('diagnostic-boom');
      },
    },
  });
  const handler = createMcpHandler(t.deps);
  const { body } = await mcpCall(
    handler,
    'tools/call',
    { name: READ_OP, arguments: {} },
    { grant: t.grantToken },
  );
  const error = rpcError(body);
  assert.equal(error.code, -32603);
  // The SDK prefixes McpError text (`MCP error -32603: ...`); what matters
  // is the generic message with no leaked detail.
  assert.ok(error.message.includes('Internal error.'));
  assert.ok(!error.message.includes('diagnostic-boom'));
  const logged = t.logger.calls.find((call) => call.level === 'error');
  assert.ok(logged);
  // The journal entry keeps the diagnostic detail (by design, for support
  // correlation) but must never carry credential material.
  assert.ok(JSON.stringify(logged).includes('diagnostic-boom'));
  assert.ok(!JSON.stringify(logged).includes(t.grantToken));
});

test('missing auth answers 401 with a safe error body', async () => {
  const t = await setup({});
  const res = await t.handler(
    testRequest('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS }),
    }),
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as AuthErrorBody;
  assert.equal(body.error.code, 'forbidden');
  assert.equal(body.error.message, 'Authentication required.');
});

test('session cookie without a grant Bearer [REDACTED] 401', async () => {
  const t = await setup({});
  const res = await t.handler(
    testRequest('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      cookie: t.identity.cookie,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as AuthErrorBody;
  assert.equal(body.error.code, 'forbidden');
});

test('lowercase bearer scheme is accepted', async () => {
  const t = await setup({});
  const res = await t.handler(
    testRequest('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `bearer ${t.grantToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as RpcBody;
  assert.ok(body.result !== undefined);
});

test('session token presented as a grant Bearer [REDACTED] 401', async () => {
  const t = await setup({});
  const res = await t.handler(
    testRequest('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${t.identity.sessionToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
  );
  assert.equal(res.status, 401);
});

test('expired grant answers 401', async () => {
  const t = await setup({});
  const issued = await issueMcpGrant(
    t.deps.identity.store,
    { user_id: t.identity.userId, team_id: t.identity.teamId, client_id: 'expired' },
    { ttlMs: -1000 },
  );
  const res = await t.handler(
    testRequest('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${issued.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
  );
  assert.equal(res.status, 401);
});

test('revoked grant answers 401', async () => {
  const t = await setup({});
  const issued = await issueMcpGrant(
    t.deps.identity.store,
    { user_id: t.identity.userId, team_id: t.identity.teamId, client_id: 'revoke-me' },
    {},
  );
  await t.deps.identity.store.revokeMcpGrant(issued.grant.grant_id);
  const res = await t.handler(
    testRequest('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${issued.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as AuthErrorBody;
  assert.equal(body.error.code, 'forbidden');
});

test('same operation via S4 HTTP and MCP produces deep-equal inputs', async () => {
  const t = await setup({});
  const httpDeps: HttpDeps = {
    app: createTestApp(),
    pages: createFakeRegistry([]),
    invoker: t.invoker,
    catalog: createFakeCatalog(SHAPES),
    limiter: createMemoryRateLimiter(),
    logger: t.logger,
    clock: systemInterfacesClock,
    identity: createTestIdentityDeps(t.identity),
    secureCookies: false,
  };
  const http = createHttpHandler(httpDeps, {
    operations: (req, op) => handleOperationRequest(httpDeps, req, op),
    auth: () => Promise.resolve(new Response('unused', { status: 500 })),
  });
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const inputs = { qty: '2', label: 'x' };
  const httpRes = await http(
    testRequest(`/api/operations/${MUT_OP}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      cookie: t.identity.cookie,
      body: JSON.stringify({ operation_id: freshOperationId(), inputs }),
    }),
  );
  assert.equal(httpRes.status, 200);
  const mcp = await mcpCall(
    t.handler,
    'tools/call',
    { name: MUT_OP, arguments: { operation_id: freshOperationId(), ...inputs } },
    { grant: t.grantToken },
  );
  assert.equal(mcp.status, 200);
  assert.ok(mcp.body.result !== undefined);
  assert.equal(t.invoker.mutations.length, 2);
  const viaHttp = t.invoker.mutations[0];
  const viaMcp = t.invoker.mutations[1];
  assert.ok(viaHttp);
  assert.ok(viaMcp);
  assert.equal(viaHttp.envelope.operation, viaMcp.envelope.operation);
  assert.deepEqual(viaHttp.envelope.inputs, viaMcp.envelope.inputs);
  assert.deepEqual(viaMcp.envelope.inputs, inputs);
});
