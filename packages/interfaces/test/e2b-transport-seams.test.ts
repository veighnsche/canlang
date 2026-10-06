/**
 * E2b transport-seam tests (F-independent slice): HTTP and MCP dispatch
 * agree on authority and error meaning; explicit null binds to nullable
 * inputs on both transports and never normalizes; multipart and
 * sealed-handle payloads are rejected loudly on HTTP operation POSTs
 * (file bytes ride S6 intents; handle submission is MCP-only).
 *
 * Grounding (no invented operations or types):
 * - `GADGET_CREATE` is the t19a fixture verbatim (E1/E2a precedent): real
 *   `can 0.1.0` emission over the T15a-shaped Shop source, including the
 *   nullable versioned `owner` ref that exercises the null seams.
 * - MCP descriptors derive from the same slice via
 *   `registryFromArtifactOperations`, so registry/catalog skew cannot
 *   fake a parity verdict.
 *
 * No parallel validation: every denial below is the dispatcher's own
 * framing/bound/invoker error observed through its transport projection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { deriveCsrfToken } from '@canlang/identity';
import { ARTIFACT_VERSION } from '../../contracts/src/artifact.js';
import type { ArtifactOperation } from '../../contracts/src/artifact.js';
import type { ClosedInputs, ConflictCurrent, MutationEnvelope, ResolvedIdentity } from '@canlang/contracts';
import type { MutationOutcome } from '../src/ports.js';
import { buildBusinessError } from '../src/errors/envelope.js';
import {
  catalogFromArtifactOperations,
  deriveOperationInputs,
  handleOperationRequest,
} from '../src/http/operations.js';
import { registryFromArtifactOperations } from '../src/mcp/tools.js';
import { createMcpHandler } from '../src/mcp/server.js';
import {
  bindingFromDerived,
  clearFormBindings,
  errorOutcome,
  registerFormBinding,
  safeFormError,
} from '../src/http/formErrors.js';
import {
  createTestApp,
  createTestDeps,
  createTestMcpDeps,
  testRequest,
} from '../src/testing.js';
import { generatedFields } from '../../ui/src/forms.js';

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

/* E2b-authored minimal scenario: one datetime input. No datetime lives in
 * the t19a/t19b fixture corpus; the shape still derives through the real
 * checked derivation, so only the operation's existence is authored. */
const REMIND_AT: ArtifactOperation = {
  "name": "Shop.remindAt",
  "kind": "scenario",
  "description": "",
  "inputs": {"fields": [
    {"name": "at", "field": {"kind": "datetime"}, "required": true},
  ]},
};

const E2B_SLICE = { artifact_version: ARTIFACT_VERSION, operations: [GADGET_CREATE, REMIND_AT] };
const OP = 'Shop.Gadget.create';
const REMIND_OP = 'Shop.remindAt';

/** Minimal binding-valid submission for Shop.Gadget.create. */
const VALID_CREATE: ClosedInputs = { title: 'w', price: '1.50', ids: ['a'], code: 'c' };

/** Fresh canonical UUIDv7 operation_id. */
function freshOperationId(): string {
  const timeHex = Date.now().toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

function opRequest(opts: {
  cookie?: string;
  csrfHeader?: string;
  acceptHtml?: boolean;
  htmx?: boolean;
  contentType?: string;
  body: string;
}): Request {
  const headers: Record<string, string> = { 'content-type': opts.contentType ?? 'application/json' };
  if (opts.csrfHeader !== undefined) headers['x-csrf-token'] = opts.csrfHeader;
  if (opts.acceptHtml === true) headers['accept'] = 'text/html';
  if (opts.htmx === true) headers['HX-Request'] = 'true';
  return testRequest('/api/operations/op', {
    method: 'POST',
    headers,
    ...(opts.cookie === undefined ? {} : { cookie: opts.cookie }),
    body: opts.body,
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
  grant?: string,
): Promise<{ status: number; body: RpcBody }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (grant !== undefined) headers['authorization'] = `Bearer ${grant}`;
  const res = await handler(
    testRequest('/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return { status: res.status, body: (await res.text()) as unknown as RpcBody };
  }
  return { status: res.status, body: (await res.json()) as RpcBody };
}

function echoMutation(envelope: MutationEnvelope): MutationOutcome {
  return {
    result: { status: 'committed', operation_id: envelope.operation_id, result: { echoed: envelope.inputs } },
  };
}

async function httpSetup(mutations?: Record<string, (envelope: MutationEnvelope, identity: ResolvedIdentity) => MutationOutcome>) {
  const t = await createTestDeps({ mutations: mutations ?? { [OP]: echoMutation, [REMIND_OP]: echoMutation } });
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const catalog = catalogFromArtifactOperations(E2B_SLICE);
  return { t, deps: { ...t.deps, catalog }, csrf };
}

async function mcpSetup(mutations?: Record<string, (envelope: MutationEnvelope, identity: ResolvedIdentity) => MutationOutcome>) {
  const t = await createTestMcpDeps({
    descriptors: registryFromArtifactOperations(E2B_SLICE).list(createTestApp()),
    mutations: mutations ?? { [OP]: echoMutation, [REMIND_OP]: echoMutation },
  });
  const catalog = catalogFromArtifactOperations(E2B_SLICE);
  const deps = { ...t.deps, catalog };
  return { t, deps, handler: createMcpHandler(deps), grant: t.grantToken };
}

interface ErrorBody {
  readonly code: string;
  readonly message: string;
  readonly fields?: ReadonlyArray<{ readonly path: string; readonly code: string; readonly message: string }>;
  readonly retryable?: boolean;
}

test('E2b parity: anonymous mutation is denied on both transports', async () => {
  const { t: httpT, deps } = await httpSetup();
  const httpRes = await handleOperationRequest(
    deps,
    opRequest({ body: JSON.stringify({ operation_id: freshOperationId(), inputs: VALID_CREATE }) }),
    OP,
  );
  assert.equal(httpRes.status, 403);
  assert.deepEqual(await httpRes.json(), {
    code: 'forbidden',
    message: 'Authentication required.',
    retryable: false,
  });
  assert.equal(httpT.invoker.mutations.length, 0);

  const { handler } = await mcpSetup();
  const mcp = await mcpCall(handler, 'tools/call', {
    name: OP,
    arguments: { ...VALID_CREATE, operation_id: freshOperationId() },
  });
  assert.equal(mcp.status, 401);
  assert.deepEqual(mcp.body, { error: { code: 'forbidden', message: 'Authentication required.' } });
});

test('E2b parity: one business error keeps its meaning on both transports', async () => {
  const conflict = () =>
    ({
      error: buildBusinessError('conflict', 'Stale version.', {
        fields: [{ path: '/record/version', code: 'stale', message: 'Stale version.' }],
      }),
    }) as MutationOutcome;
  // The conflict must come from the invoker through a wired session.
  clearFormBindings();
  const wired = await httpSetup({ [OP]: conflict });
  const res = await handleOperationRequest(
    wired.deps,
    opRequest({
      cookie: wired.t.identity.cookie,
      csrfHeader: wired.csrf,
      body: JSON.stringify({ operation_id: freshOperationId(), inputs: VALID_CREATE }),
    }),
    OP,
  );
  assert.equal(res.status, 409);
  const httpBody = (await res.json()) as ErrorBody;
  assert.equal(httpBody.code, 'conflict');
  assert.equal(httpBody.message, 'Stale version.');
  assert.deepEqual(httpBody.fields, [{ path: '/record/version', code: 'stale', message: 'Stale version.' }]);
  assert.equal(wired.t.invoker.mutations.length, 1);

  const mcpT = await mcpSetup({ [OP]: conflict });
  const mcp = await mcpCall(
    mcpT.handler,
    'tools/call',
    { name: OP, arguments: { ...VALID_CREATE, operation_id: freshOperationId() } },
    mcpT.grant,
  );
  assert.equal(mcp.status, 200);
  const result = mcp.body.result as {
    content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
    structuredContent: ErrorBody;
    isError?: boolean;
  };
  assert.equal(result.isError, true);
  assert.ok(result.content[0]?.text.includes('conflict: Stale version.'));
  assert.equal(result.structuredContent.code, 'conflict');
  assert.equal(result.structuredContent.message, 'Stale version.');
  assert.deepEqual(result.structuredContent.fields, httpBody.fields);
  assert.equal(mcpT.t.invoker.mutations.length, 1);
});

test('E2b parity: bound denial maps to validation on HTTP and InvalidParams on MCP', async () => {
  const inputs = { ...VALID_CREATE, state: 'DRAFT' };
  const { t: httpT, deps, csrf } = await httpSetup();
  const httpRes = await handleOperationRequest(
    deps,
    opRequest({
      cookie: httpT.identity.cookie,
      csrfHeader: csrf,
      body: JSON.stringify({ operation_id: freshOperationId(), inputs }),
    }),
    OP,
  );
  assert.equal(httpRes.status, 400);
  const httpBody = (await httpRes.json()) as ErrorBody;
  assert.equal(httpBody.code, 'validation');
  assert.ok(httpBody.message.includes('"draft", "submitted"'));
  assert.equal(httpBody.fields?.[0]?.code, 'binding_mismatch');
  assert.equal(httpBody.fields?.[0]?.path, '/state');
  assert.equal(httpT.invoker.mutations.length, 0);

  const mcpT = await mcpSetup();
  const mcp = await mcpCall(
    mcpT.handler,
    'tools/call',
    { name: OP, arguments: { ...inputs, operation_id: freshOperationId() } },
    mcpT.grant,
  );
  assert.equal(mcp.status, 200);
  assert.ok(mcp.body.error !== undefined);
  assert.equal(mcp.body.error.code, -32602);
  assert.ok(mcp.body.error.message.includes('"draft", "submitted"'));
  assert.equal(mcpT.t.invoker.mutations.length, 0);
});

test('E2b parity: bare invoker forbidden answers the uniform message on both transports', async () => {
  const deny = () => ({ error: buildBusinessError('forbidden') }) as MutationOutcome;
  const uniform = 'You do not have permission to perform this action.';
  const { t: httpT, deps, csrf } = await httpSetup({ [OP]: deny });
  const httpRes = await handleOperationRequest(
    deps,
    opRequest({
      cookie: httpT.identity.cookie,
      csrfHeader: csrf,
      body: JSON.stringify({ operation_id: freshOperationId(), inputs: VALID_CREATE }),
    }),
    OP,
  );
  assert.equal(httpRes.status, 403);
  const httpBody = (await httpRes.json()) as ErrorBody;
  assert.equal(httpBody.message, uniform);

  const mcpT = await mcpSetup({ [OP]: deny });
  const mcp = await mcpCall(
    mcpT.handler,
    'tools/call',
    { name: OP, arguments: { ...VALID_CREATE, operation_id: freshOperationId() } },
    mcpT.grant,
  );
  const result = mcp.body.result as { structuredContent: ErrorBody; isError?: boolean };
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.code, 'forbidden');
  assert.equal(result.structuredContent.message, uniform);
});

test('E2b null: explicit null binds to nullable on both transports and stores verbatim', async () => {
  const inputs = { ...VALID_CREATE, owner: null };
  const { t: httpT, deps, csrf } = await httpSetup();
  const httpRes = await handleOperationRequest(
    deps,
    opRequest({
      cookie: httpT.identity.cookie,
      csrfHeader: csrf,
      body: JSON.stringify({ operation_id: freshOperationId(), inputs }),
    }),
    OP,
  );
  assert.equal(httpRes.status, 200);
  assert.equal(httpT.invoker.mutations.length, 1);
  assert.deepEqual(httpT.invoker.mutations[0]?.envelope.inputs, inputs);

  const mcpT = await mcpSetup();
  const mcp = await mcpCall(
    mcpT.handler,
    'tools/call',
    { name: OP, arguments: { ...inputs, operation_id: freshOperationId() } },
    mcpT.grant,
  );
  assert.equal(mcp.body.error, undefined);
  assert.equal(mcpT.t.invoker.mutations.length, 1);
  assert.deepEqual(mcpT.t.invoker.mutations[0]?.envelope.inputs, inputs);
});

test('E2b null: explicit null on non-nullable rejects on both transports', async () => {
  const inputs = { ...VALID_CREATE, title: null };
  const { t: httpT, deps, csrf } = await httpSetup();
  const httpRes = await handleOperationRequest(
    deps,
    opRequest({
      cookie: httpT.identity.cookie,
      csrfHeader: csrf,
      body: JSON.stringify({ operation_id: freshOperationId(), inputs }),
    }),
    OP,
  );
  assert.equal(httpRes.status, 400);
  const httpBody = (await httpRes.json()) as ErrorBody;
  assert.ok(httpBody.message.includes('null is not accepted'));
  assert.equal(httpT.invoker.mutations.length, 0);

  const mcpT = await mcpSetup();
  const mcp = await mcpCall(
    mcpT.handler,
    'tools/call',
    { name: OP, arguments: { ...inputs, operation_id: freshOperationId() } },
    mcpT.grant,
  );
  assert.ok(mcp.body.error !== undefined);
  assert.equal(mcp.body.error.code, -32602);
  assert.ok(mcp.body.error.message.includes('null is not accepted'));
  assert.equal(mcpT.t.invoker.mutations.length, 0);
});

test('E2b null: omitted optional admits and the dispatcher normalizes nothing', async () => {
  const { t, deps, csrf } = await httpSetup();
  const res = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrfHeader: csrf,
      body: JSON.stringify({ operation_id: freshOperationId(), inputs: VALID_CREATE }),
    }),
    OP,
  );
  assert.equal(res.status, 200);
  const received = t.invoker.mutations[0]?.envelope.inputs;
  assert.ok(received !== undefined);
  assert.equal(Object.hasOwn(received, 'owner'), false);
  assert.equal(Object.hasOwn(received, 'stock'), false);
  assert.deepEqual(received, VALID_CREATE);
});

test('E2b drafts: explicit-null drafts re-render with the denial and leak nothing', async () => {
  clearFormBindings();
  const { t, deps, csrf } = await httpSetup();
  const derived = deriveOperationInputs(GADGET_CREATE);
  registerFormBinding(
    bindingFromDerived({
      derived,
      mode: 'create',
      action: `/api/operations/${OP}`,
      fields: generatedFields(derived, 'create'),
      submit: 'Save',
      idPrefix: 'e2b-null',
      timeZone: 'UTC',
    }),
  );
  const res = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrfHeader: csrf,
      acceptHtml: true,
      body: JSON.stringify({
        operation_id: freshOperationId(),
        inputs: { ...VALID_CREATE, owner: null, state: 'DRAFT' },
      }),
    }),
    OP,
  );
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('&quot;draft&quot;, &quot;submitted&quot;'), 'checker message explains');
  assert.ok(!html.includes('    at '), 'no stack frames leak');
  assert.equal(t.invoker.mutations.length, 0);
});

test('E2b transport: multipart operation POSTs reject before dispatch', async () => {
  const { t, deps, csrf } = await httpSetup();
  const res = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrfHeader: csrf,
      contentType: 'multipart/form-data; boundary=----e2b',
      body: '------e2b--\r\n',
    }),
    OP,
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as ErrorBody;
  assert.equal(body.code, 'validation');
  assert.equal(body.message, 'Unsupported content type.');
  assert.equal(t.invoker.mutations.length, 0);
});

test('E2b boundary: HTTP rejects sealed-handle payloads loudly (MCP-only submission)', async () => {
  const { t, deps, csrf } = await httpSetup();
  const sealed = { kind: 'action_handle', handle: 'h-1', target: OP, revision: 'r1' };
  const inInputs = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrfHeader: csrf,
      body: JSON.stringify({ operation_id: freshOperationId(), inputs: { ...VALID_CREATE, action_handle: sealed } }),
    }),
    OP,
  );
  assert.equal(inInputs.status, 400);
  const inInputsBody = (await inInputs.json()) as ErrorBody;
  assert.equal(inInputsBody.message, "Unknown input 'action_handle'.");
  assert.equal(inInputsBody.fields?.[0]?.path, '/action_handle');

  const topLevel = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrfHeader: csrf,
      body: JSON.stringify({ operation_id: freshOperationId(), inputs: VALID_CREATE, action_handle: sealed }),
    }),
    OP,
  );
  assert.equal(topLevel.status, 400);
  const topLevelBody = (await topLevel.json()) as ErrorBody;
  assert.equal(topLevelBody.code, 'validation');
  assert.ok(topLevelBody.message.includes('MCP-only'));
  assert.equal(topLevelBody.fields?.[0]?.path, '/action_handle');
  assert.equal(t.invoker.mutations.length, 0);
});

test('E2b context: grant team and session user reach the invoker on their transport', async () => {
  const { t: httpT, deps, csrf } = await httpSetup();
  const httpRes = await handleOperationRequest(
    deps,
    opRequest({
      cookie: httpT.identity.cookie,
      csrfHeader: csrf,
      body: JSON.stringify({ operation_id: freshOperationId(), inputs: VALID_CREATE }),
    }),
    OP,
  );
  assert.equal(httpRes.status, 200);
  const httpIdentity = httpT.invoker.mutations[0]?.identity;
  assert.equal(httpIdentity?.actor?.user_id, httpT.identity.userId);
  assert.equal(httpIdentity?.binding.kind, 'session');

  const mcpT = await mcpSetup();
  const mcp = await mcpCall(
    mcpT.handler,
    'tools/call',
    { name: OP, arguments: { ...VALID_CREATE, operation_id: freshOperationId() } },
    mcpT.grant,
  );
  assert.equal(mcp.body.error, undefined);
  const mcpIdentity = mcpT.t.invoker.mutations[0]?.identity;
  assert.equal(mcpIdentity?.actor?.user_id, mcpT.t.identity.userId);
  assert.equal(mcpIdentity?.binding.kind, 'mcp_grant');
  assert.equal(mcpIdentity?.team?.team_id, mcpT.t.identity.teamId);
});

test('E2b datetime: millis-pinned instant dispatches on both transports verbatim', async () => {
  const inputs = { at: '2026-10-06T06:00:00.000Z' };
  const { t: httpT, deps, csrf } = await httpSetup();
  const httpRes = await handleOperationRequest(
    deps,
    opRequest({
      cookie: httpT.identity.cookie,
      csrfHeader: csrf,
      body: JSON.stringify({ operation_id: freshOperationId(), inputs }),
    }),
    REMIND_OP,
  );
  assert.equal(httpRes.status, 200);
  assert.equal(httpT.invoker.mutations.length, 1);
  assert.deepEqual(httpT.invoker.mutations[0]?.envelope.inputs, inputs);

  const mcpT = await mcpSetup();
  const mcp = await mcpCall(
    mcpT.handler,
    'tools/call',
    { name: REMIND_OP, arguments: { ...inputs, operation_id: freshOperationId() } },
    mcpT.grant,
  );
  assert.equal(mcp.body.error, undefined);
  assert.equal(mcpT.t.invoker.mutations.length, 1);
  assert.deepEqual(mcpT.t.invoker.mutations[0]?.envelope.inputs, inputs);
});

/** One L3-carried conflict current in the pinned bb1ca7a shape. */
function carriedCurrents(): ConflictCurrent {
  return {
    message: 'Stale version.',
    current: {
      model: 'Shop.Gadget',
      id: 'g1',
      version: 2,
      updated: '2026-10-06T06:00:00.000Z',
      updatedBy: 'bob',
      values: { title: 'current-title', price: '9.99' },
    },
  };
}

test('E2b conflict: carried currents render the conflict outcome on generated bindings', async () => {
  clearFormBindings();
  const carried = carriedCurrents();
  const { t, deps, csrf } = await httpSetup({
    [OP]: () => ({
      error: buildBusinessError('conflict', 'Stale version.', {
        fields: [{ path: '/title', code: 'stale', message: 'Stale version.' }],
        conflict: carried,
      }),
    }),
  });
  const derived = deriveOperationInputs(GADGET_CREATE);
  registerFormBinding(
    bindingFromDerived({
      derived,
      mode: 'create',
      action: `/api/operations/${OP}`,
      fields: generatedFields(derived, 'create'),
      submit: 'Save',
      idPrefix: 'e2b-conflict',
      timeZone: 'UTC',
    }),
  );
  const res = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrfHeader: csrf,
      acceptHtml: true,
      body: JSON.stringify({
        operation_id: freshOperationId(),
        inputs: { ...VALID_CREATE, title: 'my-draft' },
      }),
    }),
    OP,
  );
  assert.equal(res.status, 409);
  const html = await res.text();
  assert.ok(html.includes('alert alert-warning'), 'conflict banner, not failed');
  assert.ok(html.includes('Current value'), 'per-field current join');
  assert.ok(html.includes('current-title'), 'carried current renders');
  assert.ok(html.includes('value="my-draft"'), 'draft never overwritten by currents');
  assert.ok(!html.includes('alert alert-error'));
  assert.ok(!html.includes('    at '), 'no stack frames leak');
  assert.equal(t.invoker.mutations.length, 1, 'conflict came from the invoker');
});

test('E2b conflict: hand-built bindings keep the failed banner even with carried currents', async () => {
  clearFormBindings();
  const { t, deps, csrf } = await httpSetup({
    [OP]: () => ({
      error: buildBusinessError('conflict', 'Stale version.', { conflict: carriedCurrents() }),
    }),
  });
  registerFormBinding({
    operation: OP,
    action: `/api/operations/${OP}`,
    mode: 'create',
    fields: [{ path: 'title', label: 'Title', type: 'text', required: true }],
    submit: 'Save',
    idPrefix: 'e2b-hand',
    timeZone: 'UTC',
  });
  const res = await handleOperationRequest(
    deps,
    opRequest({
      cookie: t.identity.cookie,
      csrfHeader: csrf,
      acceptHtml: true,
      body: JSON.stringify({ operation_id: freshOperationId(), inputs: VALID_CREATE }),
    }),
    OP,
  );
  assert.equal(res.status, 409);
  const html = await res.text();
  assert.ok(html.includes('alert alert-error'), 'failed banner');
  assert.ok(html.includes('Stale version.'));
  assert.ok(!html.includes('Current value'), 'no currents join on hand paths');
  assert.ok(!html.includes('current-title'));
});

test('E2b conflict: outcome mapping and safe projection fail closed', () => {
  const derived = deriveOperationInputs(GADGET_CREATE);
  const generated = bindingFromDerived({
    derived,
    mode: 'create',
    action: `/api/operations/${OP}`,
    fields: [],
    submit: 'Save',
    idPrefix: 'x',
    timeZone: 'UTC',
  });
  const hand = {
    operation: OP,
    action: '/x',
    mode: 'create' as const,
    fields: [],
    submit: 's',
    idPrefix: 'x',
    timeZone: 'UTC',
  };
  const carried = carriedCurrents();
  const withCurrents = buildBusinessError('conflict', 'Stale version.', { conflict: carried });
  // Mapping: generated + currents → conflict outcome with verbatim values.
  const mapped = errorOutcome(withCurrents, generated);
  assert.equal(mapped.status, 'conflict');
  if (mapped.status === 'conflict') {
    assert.deepEqual(mapped.current, { title: 'current-title', price: '9.99' });
    assert.equal(mapped.message, 'Stale version.');
  }
  // Without currents, without a binding, or with a hand binding → failed.
  assert.equal(errorOutcome(buildBusinessError('conflict', 'Stale.'), generated).status, 'failed');
  assert.equal(errorOutcome(withCurrents).status, 'failed');
  assert.equal(errorOutcome(withCurrents, hand).status, 'failed');
  // Projection: well-shaped currents pass; malformed or off-code currents drop.
  assert.deepEqual(safeFormError(withCurrents).conflict, carried);
  const malformed = buildBusinessError('conflict', 'Stale.', {
    conflict: {
      message: 'x',
      current: { model: 'm', id: 'i', version: '2', updated: 'u', updatedBy: 'b', values: {} },
    } as unknown as ConflictCurrent,
  });
  assert.equal(safeFormError(malformed).conflict, undefined);
  const offCode = buildBusinessError('validation', 'Bad.', { conflict: carried });
  assert.equal(safeFormError(offCode).conflict, undefined);
});

test('E2b datetime: non-conforming values mismatch on both transports', async () => {
  const cases: ReadonlyArray<{ readonly label: string; readonly at: unknown }> = [
    { label: 'missing millis', at: '2026-10-06T06:00:00Z' },
    { label: 'lowercase markers', at: '2026-10-06t06:00:00.000z' },
    { label: 'offset form', at: '2026-10-06T06:00:00.000+00:00' },
    { label: 'garbage', at: 'not-a-datetime' },
    { label: 'JSON number', at: 1728192000000 },
  ];
  const { t: httpT, deps, csrf } = await httpSetup();
  for (const kase of cases) {
    const res = await handleOperationRequest(
      deps,
      opRequest({
        cookie: httpT.identity.cookie,
        csrfHeader: csrf,
        body: JSON.stringify({ operation_id: freshOperationId(), inputs: { at: kase.at } }),
      }),
      REMIND_OP,
    );
    assert.equal(res.status, 400, kase.label);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.code, 'validation', kase.label);
    assert.ok(body.message.includes('RFC 3339 UTC instants with millis'), kase.label);
    assert.equal(body.fields?.[0]?.path, '/at', kase.label);
    assert.equal(body.fields?.[0]?.code, 'binding_mismatch', kase.label);
  }
  assert.equal(httpT.invoker.mutations.length, 0);

  const mcpT = await mcpSetup();
  for (const kase of cases) {
    const mcp = await mcpCall(
      mcpT.handler,
      'tools/call',
      { name: REMIND_OP, arguments: { at: kase.at, operation_id: freshOperationId() } },
      mcpT.grant,
    );
    assert.ok(mcp.body.error !== undefined, kase.label);
    assert.equal(mcp.body.error.code, -32602, kase.label);
    assert.ok(mcp.body.error.message.includes('RFC 3339 UTC instants with millis'), kase.label);
  }
  assert.equal(mcpT.t.invoker.mutations.length, 0);
});
