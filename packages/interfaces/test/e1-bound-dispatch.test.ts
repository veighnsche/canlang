/**
 * E1 bound-input dispatch wiring tests: the pure T19b bound checker is
 * actually invoked on HTTP and MCP dispatch; delivery bindings stay
 * visible (derived channel) and never submitted; equal-authority
 * submissions invoke with identity/envelope unchanged; both transports
 * reach the same verdicts.
 *
 * Grounding (no invented operations or types):
 * - `GADGET_CREATE` is the t19a fixture verbatim: real `can 0.1.0`
 *   emission (commit aabcdfa) over the T15a-shaped Shop source.
 * - `RETRY` is the t19b Tier-2 fixture verbatim (T15b delivery pattern).
 * - `NOTIFY_EMAIL` mirrors the t19b `deliveryOp(0)` single-receipt shape
 *   (std.EmailV1.send v1, EmailAccepted leaves), renamed to the HTTP
 *   operation-name vocabulary (no underscore).
 * - `GADGET_READ` is the t19b `LEDGER_READ` fixture verbatim.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deriveCsrfToken } from '@canlang/identity';
import { ARTIFACT_VERSION } from '../../contracts/src/artifact.js';
import type { ArtifactOperation } from '../../contracts/src/artifact.js';
import {
  catalogFromArtifactOperations,
  handleOperationRequest,
} from '../src/http/operations.js';
import { registryFromArtifactOperations } from '../src/mcp/tools.js';
import { createMcpHandler } from '../src/mcp/server.js';
import {
  createFakeCatalog,
  createTestApp,
  createTestDeps,
  createTestMcpDeps,
  testRequest,
} from '../src/testing.js';

/* Verbatim t19a emission: Shop.Gadget.create. */
const GADGET_CREATE: ArtifactOperation = {
  "name": "Shop.Gadget.create",
  "kind": "create",
  "description": "",
  "inputs": {"fields": [
    {"name": "title", "field": {"kind": "string"}, "required": true},
    {"name": "stock", "field": {"kind": "integer"}, "required": false, "default": {"kind": "literal", "value": "0"}},
    {"name": "price", "field": {"kind": "decimal"}, "required": true},
    {"name": "state", "field": {"kind": "enum", "values": ["draft", "submitted"]}, "required": false, "default": {"kind": "literal", "value": "draft"}},
    {"name": "owner", "field": {"kind": "ref", "model": "Shop.Gadget", "requireVersion": true}, "required": false, "nullable": true},
    {"name": "tags", "field": {"kind": "string"}, "required": false, "array": {"required": false}},
    {"name": "ids", "field": {"kind": "string"}, "required": true, "array": {"required": true}},
    {"name": "code", "field": {"kind": "string"}, "required": true},
  ]},
};

/* Verbatim t19b Tier-2 fixture: Receipts.retry. */
const RETRY: ArtifactOperation = {
  "name": "Receipts.retry",
  "kind": "scenario",
  "description": "",
  "inputs": {"fields": [
    {"name": "note", "field": {"kind": "string"}, "required": true},
    {"name": "attempt", "field": {"kind": "delivery", "capability": "std.EmailV1", "operation": "send", "version": 1, "result": {"name": "EmailAccepted", "fields": [{"name": "reference", "type": "text"}]}}, "required": false, "nullable": true},
  ]},
};

/* Single-receipt scenario mirroring t19b deliveryOp(0), HTTP-name vocabulary. */
const NOTIFY_EMAIL: ArtifactOperation = {
  "name": "Receipts.notifyEmail",
  "kind": "scenario",
  "description": "",
  "inputs": {"fields": [
    {"name": "receipt", "field": {"kind": "delivery", "capability": "std.EmailV1", "operation": "send", "version": 1, "result": {"name": "EmailAccepted", "fields": [{"name": "reference", "type": "text"}]}}, "required": true},
  ]},
};

/* Verbatim t19b emission: Ledger.Gadget.read (empty inputs). */
const GADGET_READ: ArtifactOperation = {
  "name": "Ledger.Gadget.read",
  "kind": "read",
  "description": "",
  "inputs": {"fields": []},
};

const E1_OPS: readonly ArtifactOperation[] = [GADGET_CREATE, RETRY, NOTIFY_EMAIL, GADGET_READ];
const E1_SLICE = { artifact_version: ARTIFACT_VERSION, operations: E1_OPS };

/** Minimal binding-valid submission for Shop.Gadget.create. */
const VALID_CREATE = { title: 'w', price: '1.50', ids: ['a'], code: 'c' };

/** Fresh canonical UUIDv7 operation_id with the time field at `atMs`. */
function freshOperationId(atMs: number = Date.now()): string {
  const timeHex = atMs.toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

/** JSON operation POST; `_csrf` rides inside `inputs` (canonical location). */
function opRequest(cookie: string, body: string): Request {
  return testRequest('/api/operations/op', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cookie,
    body,
  });
}

type McpHandler = (request: Request) => Promise<Response>;

interface RpcBody {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

async function mcpCall(
  handler: McpHandler,
  method: string,
  params: Record<string, unknown>,
  grant: string,
): Promise<{ status: number; body: RpcBody }> {
  const res = await handler(
    testRequest('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${grant}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return { status: res.status, body: (await res.json()) as RpcBody };
}

function toolText(body: RpcBody): string {
  assert.ok(body.result !== undefined && body.error === undefined);
  const content = (body.result as { content: Array<{ text: string }> }).content;
  return content[0]?.text ?? '';
}

function echoMutation(envelope: { operation_id: string; inputs: unknown }): {
  result: { status: 'committed'; operation_id: string; result: { echoed: unknown } };
} {
  return {
    result: { status: 'committed', operation_id: envelope.operation_id, result: { echoed: envelope.inputs } },
  };
}

async function httpSetup(opNames: readonly string[] = ['Shop.Gadget.create', 'Receipts.retry', 'Receipts.notifyEmail']) {
  const t = await createTestDeps({
    mutations: Object.fromEntries(opNames.map((name) => [name, echoMutation])),
  });
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const catalog = catalogFromArtifactOperations(E1_SLICE);
  return { t, deps: { ...t.deps, catalog }, csrf };
}

async function mcpSetup() {
  const t = await createTestMcpDeps({
    descriptors: registryFromArtifactOperations(E1_SLICE).list(createTestApp()),
    mutations: {
      'Shop.Gadget.create': echoMutation,
      'Receipts.retry': echoMutation,
      'Receipts.notifyEmail': echoMutation,
    },
    reads: {
      'Ledger.Gadget.read': () => ({ result: { rows: [] } }),
    },
  });
  const catalog = catalogFromArtifactOperations(E1_SLICE);
  const deps = { ...t.deps, catalog };
  return { t, deps, handler: createMcpHandler(deps), grant: t.grantToken };
}

interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly fields?: ReadonlyArray<{ readonly path: string; readonly code: string }>;
}

/** Submissions that pass framing but mismatch their bound declarations. */
const MISMATCHES: ReadonlyArray<{ readonly label: string; readonly inputs: Record<string, unknown>; readonly hint: string }> = [
  { label: 'enum case', inputs: { state: 'DRAFT' }, hint: '"draft", "submitted"' },
  { label: 'integer as JSON number', inputs: { stock: 5 }, hint: 'canonical digit strings' },
  { label: 'decimal as JSON number', inputs: { price: 1.5 }, hint: 'never JSON numbers' },
  { label: 'null on non-nullable', inputs: { title: null }, hint: 'null is not accepted' },
  { label: 'array shape', inputs: { ids: 'a' }, hint: 'take arrays' },
  { label: 'ref empty id', inputs: { owner: { id: '' } }, hint: 'non-empty strings' },
  { label: 'versioned ref missing version', inputs: { owner: { id: 'g-1' } }, hint: 'canonical digit-string version' },
];

test('E1 HTTP: binding mismatch rejects before admission', async () => {
  const { t, deps, csrf } = await httpSetup();
  for (const kase of MISMATCHES) {
    const res = await handleOperationRequest(
      deps,
      opRequest(
        t.identity.cookie,
        JSON.stringify({
          operation_id: freshOperationId(),
          inputs: { ...VALID_CREATE, ...kase.inputs, _csrf: csrf },
        }),
      ),
      'Shop.Gadget.create',
    );
    assert.equal(res.status, 400, kase.label);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.code, 'validation', kase.label);
    assert.equal(body.fields?.[0]?.code, 'binding_mismatch', kase.label);
    assert.ok(body.message.includes(kase.hint), `${kase.label}: ${body.message}`);
  }
  assert.equal(t.invoker.mutations.length, 0, 'no mismatch reached the invoker');
});

test('E1 HTTP: valid submission invokes with the envelope unchanged', async () => {
  const { t, deps, csrf } = await httpSetup();
  const operation_id = freshOperationId();
  const res = await handleOperationRequest(
    deps,
    opRequest(
      t.identity.cookie,
      JSON.stringify({ operation_id, inputs: { ...VALID_CREATE, _csrf: csrf } }),
    ),
    'Shop.Gadget.create',
  );
  assert.equal(res.status, 200);
  assert.equal(t.invoker.mutations.length, 1);
  assert.deepEqual(t.invoker.mutations[0]?.envelope, {
    operation: 'Shop.Gadget.create',
    operation_id,
    inputs: VALID_CREATE,
  });
  assert.equal(t.invoker.mutations[0]?.identity.actor?.user_id, t.identity.userId);
});

test('E1 HTTP: submitted delivery fails framing as unknown; bindings never submit', async () => {
  const { t, deps, csrf } = await httpSetup();
  const smuggled = await handleOperationRequest(
    deps,
    opRequest(
      t.identity.cookie,
      JSON.stringify({
        operation_id: freshOperationId(),
        inputs: { note: 'hi', attempt: { id: 'd-1' }, _csrf: csrf },
      }),
    ),
    'Receipts.retry',
  );
  assert.equal(smuggled.status, 400);
  const smuggledBody = (await smuggled.json()) as ErrorBody;
  assert.equal(smuggledBody.code, 'validation');
  assert.equal(smuggledBody.fields?.[0]?.code, 'unknown');
  // The binding is documented but unsubmittable: the clean call invokes.
  const ok = await handleOperationRequest(
    deps,
    opRequest(
      t.identity.cookie,
      JSON.stringify({ operation_id: freshOperationId(), inputs: { note: 'hi', _csrf: csrf } }),
    ),
    'Receipts.retry',
  );
  assert.equal(ok.status, 200);
  assert.equal(t.invoker.mutations.length, 1);
  assert.deepEqual(t.invoker.mutations[0]?.envelope.inputs, { note: 'hi' });
});

test('E1 HTTP: receipt-only operation invokes with empty inputs', async () => {
  const { t, deps, csrf } = await httpSetup();
  const catalog = catalogFromArtifactOperations(E1_SLICE);
  assert.deepEqual(catalog.shapeFor('Receipts.notifyEmail'), { allowed: [], required: [] });
  assert.equal(catalog.derivedFor('Receipts.notifyEmail')?.inputs.length, 1);
  const operation_id = freshOperationId();
  const res = await handleOperationRequest(
    deps,
    opRequest(
      t.identity.cookie,
      JSON.stringify({ operation_id, inputs: { _csrf: csrf } }),
    ),
    'Receipts.notifyEmail',
  );
  assert.equal(res.status, 200);
  assert.equal(t.invoker.mutations.length, 1);
  assert.deepEqual(t.invoker.mutations[0]?.envelope, {
    operation: 'Receipts.notifyEmail',
    operation_id,
    inputs: {},
  });
});

test('E1 MCP: binding mismatch rejects as InvalidParams', async () => {
  const { t, handler, grant } = await mcpSetup();
  // Non-ref members pass MCP framing, so these rejections prove the bound
  // checker itself ran on the MCP path (framing has no such messages).
  for (const kase of MISMATCHES.slice(0, 5)) {
    const { body } = await mcpCall(
      handler,
      'tools/call',
      {
        name: 'Shop.Gadget.create',
        arguments: { ...VALID_CREATE, ...kase.inputs, operation_id: freshOperationId() },
      },
      grant,
    );
    assert.ok(body.error !== undefined, kase.label);
    assert.equal(body.error.code, -32602, kase.label);
    assert.ok(body.error.message.includes(kase.hint), `${kase.label}: ${body.error.message}`);
  }
  assert.equal(t.invoker.mutations.length, 0, 'no mismatch reached the invoker');
});

test('E1 MCP: ref framing precedes binding (framing-first order)', async () => {
  const { t, handler, grant } = await mcpSetup();
  for (const [inputs, message] of [
    [{ owner: { id: '' } }, 'Invalid record id.'],
    [{ owner: { id: 'g-1' } }, 'Invalid record version.'],
  ] as const) {
    const { body } = await mcpCall(
      handler,
      'tools/call',
      {
        name: 'Shop.Gadget.create',
        arguments: { ...VALID_CREATE, ...inputs, operation_id: freshOperationId() },
      },
      grant,
    );
    assert.ok(body.error !== undefined);
    assert.equal(body.error.code, -32602);
    assert.ok(body.error.message.includes(message), body.error.message);
  }
  assert.equal(t.invoker.mutations.length, 0);
});

test('E1 MCP: valid mutation and read invoke', async () => {
  const { t, handler, grant } = await mcpSetup();
  const operation_id = freshOperationId();
  const called = await mcpCall(
    handler,
    'tools/call',
    { name: 'Shop.Gadget.create', arguments: { ...VALID_CREATE, operation_id } },
    grant,
  );
  const echoed = JSON.parse(toolText(called.body)) as { result: { echoed: unknown } };
  assert.deepEqual(echoed.result.echoed, VALID_CREATE);
  assert.equal(t.invoker.mutations.length, 1);
  assert.deepEqual(t.invoker.mutations[0]?.envelope, {
    operation: 'Shop.Gadget.create',
    operation_id,
    inputs: VALID_CREATE,
  });
  const read = await mcpCall(handler, 'tools/call', { name: 'Ledger.Gadget.read', arguments: {} }, grant);
  const rows = JSON.parse(toolText(read.body)) as { rows: unknown[] };
  assert.deepEqual(rows, { rows: [] });
  assert.equal(t.invoker.reads.length, 1);
});

test('E1 MCP: handle mode binds carried members', async () => {
  const { t, handler, grant } = await mcpSetup();
  const rejected = await mcpCall(
    handler,
    'tools/call',
    {
      name: 'Shop.Gadget.create',
      arguments: {
        action_handle: { sealed: true },
        operation_id: freshOperationId(),
        ...VALID_CREATE,
        state: 'DRAFT',
      },
    },
    grant,
  );
  assert.ok(rejected.body.error !== undefined);
  assert.equal(rejected.body.error.code, -32602);
  assert.ok(rejected.body.error.message.includes('"draft", "submitted"'), rejected.body.error.message);
  const operation_id = freshOperationId();
  const ok = await mcpCall(
    handler,
    'tools/call',
    {
      name: 'Shop.Gadget.create',
      arguments: { action_handle: { sealed: true }, operation_id, ...VALID_CREATE },
    },
    grant,
  );
  assert.ok(ok.body.error === undefined);
  assert.equal(t.invoker.mutations.length, 1);
  assert.deepEqual(t.invoker.mutations[0]?.envelope.inputs, {
    action_handle: { sealed: true },
    ...VALID_CREATE,
  });
});

test('E1 parity: both transports reach the same verdicts', async () => {
  // Explicit null on a nullable ref is excluded: MCP framing owns strict
  // ref shape (rejects null, pre-existing) while binding owns nullability
  // (accepts) — the transports differed there before E1 and differ
  // identically now; E1 changes neither framing rule.
  const valids: Record<string, unknown>[] = [
    { ...VALID_CREATE },
    { ...VALID_CREATE, stock: '3' },
    { ...VALID_CREATE, state: 'submitted', tags: ['x'] },
  ];
  const invalids: Record<string, unknown>[] = MISMATCHES.slice(0, 5).map((kase) => ({
    ...VALID_CREATE,
    ...kase.inputs,
  }));
  const httpVerdicts: boolean[] = [];
  {
    const { t, deps, csrf } = await httpSetup();
    for (const inputs of [...valids, ...invalids]) {
      const res = await handleOperationRequest(
        deps,
        opRequest(
          t.identity.cookie,
          JSON.stringify({ operation_id: freshOperationId(), inputs: { ...inputs, _csrf: csrf } }),
        ),
        'Shop.Gadget.create',
      );
      httpVerdicts.push(res.status === 200);
    }
  }
  const mcpVerdicts: boolean[] = [];
  {
    const { handler, grant } = await mcpSetup();
    for (const inputs of [...valids, ...invalids]) {
      const { body } = await mcpCall(
        handler,
        'tools/call',
        { name: 'Shop.Gadget.create', arguments: { ...inputs, operation_id: freshOperationId() } },
        grant,
      );
      mcpVerdicts.push(body.error === undefined);
    }
  }
  assert.deepEqual(httpVerdicts, [...valids.map(() => true), ...invalids.map(() => false)]);
  assert.deepEqual(mcpVerdicts, httpVerdicts);
});

test('E1 equal authority (MCP): interface submission matches the direct call', async () => {
  const { t, handler, grant } = await mcpSetup();
  const operation_id = freshOperationId();
  const called = await mcpCall(
    handler,
    'tools/call',
    { name: 'Shop.Gadget.create', arguments: { ...VALID_CREATE, operation_id } },
    grant,
  );
  const throughInterface = JSON.parse(toolText(called.body)) as unknown;
  assert.equal(t.invoker.mutations.length, 1);
  const call = t.invoker.mutations[0];
  assert.ok(call !== undefined);
  assert.equal(call.identity.actor?.user_id, t.identity.userId);
  assert.deepEqual(call.envelope, { operation: 'Shop.Gadget.create', operation_id, inputs: VALID_CREATE });
  const direct = await t.invoker.invokeMutation(call.envelope, call.identity);
  assert.ok('result' in direct);
  assert.deepEqual(direct.result, throughInterface);
});

test('E1 binding visibility: dispatch consults the derived channel', async () => {
  const seen: string[] = [];
  const catalog = catalogFromArtifactOperations(E1_SLICE);
  const spy = {
    ...catalog,
    derivedFor: (operation: string) => {
      seen.push(operation);
      return catalog.derivedFor(operation);
    },
  };
  {
    const { t, csrf } = await httpSetup();
    const res = await handleOperationRequest(
      { ...t.deps, catalog: spy },
      opRequest(
        t.identity.cookie,
        JSON.stringify({ operation_id: freshOperationId(), inputs: { ...VALID_CREATE, _csrf: csrf } }),
      ),
      'Shop.Gadget.create',
    );
    assert.equal(res.status, 200);
  }
  {
    const { t, grant } = await mcpSetup();
    const deps = { ...t.deps, catalog: spy };
    const { body } = await mcpCall(
      createMcpHandler(deps),
      'tools/call',
      { name: 'Shop.Gadget.create', arguments: { ...VALID_CREATE, operation_id: freshOperationId() } },
      grant,
    );
    assert.ok(body.error === undefined);
  }
  assert.deepEqual(seen, ['Shop.Gadget.create', 'Shop.Gadget.create']);
});

test('E1 legacy: shape-only catalogs keep framing-only behavior', async () => {
  const { t, csrf } = await httpSetup(['acme.widget']);
  const deps = {
    ...t.deps,
    catalog: createFakeCatalog({ 'acme.widget': { allowed: ['state'], required: [] } }),
  };
  const operation_id = freshOperationId();
  // No derived channel: a value no declaration binds still invokes, exactly
  // as before E1 (framing owns membership; binding needs declarations).
  const res = await handleOperationRequest(
    deps,
    opRequest(
      t.identity.cookie,
      JSON.stringify({ operation_id, inputs: { state: 'DRAFT', _csrf: csrf } }),
    ),
    'acme.widget',
  );
  assert.equal(res.status, 200);
  assert.equal(t.invoker.mutations.length, 1);
});
