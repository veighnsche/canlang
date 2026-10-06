/**
 * B4 mid-flight credential fence: a revocation (or expiry) landing
 * between admission and commit voids the in-flight mutation on both
 * dispatch paths (HTTP operations + MCP tools/call). Injection is
 * deterministic: doubles revoke the credential (or advance the clock)
 * from a hook that runs strictly after admission resolves and before
 * the commit fence re-reads. Denials carry the admission-identical
 * message (no oracle); live credentials pass through untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  buildSessionCookie,
  deriveCsrfToken,
  revokeMcpGrantByToken,
  sha256HexText,
} from '@canlang/identity';
import { handleOperationRequest } from '../src/http/operations.js';
import { createMcpHandler } from '../src/mcp/server.js';
import { createTestDeps, createTestMcpDeps, testRequest } from '../src/testing.js';
import type { OperationDescriptor, OperationInputShape } from '../src/ports.js';

const OP = 'acme.order';
const SHAPES = { [OP]: { allowed: ['qty', 'label'], required: ['qty'] } };
const ADMISSION_MESSAGE = 'Session expired or revoked.';

/** Fresh canonical UUIDv7 operation_id with the time field at `atMs`. */
function freshOperationId(atMs: number = Date.now()): string {
  const timeHex = atMs.toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');
  return `${timeHex.slice(0, 8)}-${timeHex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

async function httpSetup() {
  const t = await createTestDeps({
    shapes: SHAPES,
    mutations: {
      [OP]: (envelope) => ({
        result: { status: 'committed', operation_id: envelope.operation_id },
      }),
    },
  });
  return { ...t, csrf: await deriveCsrfToken(t.identity.sessionToken) };
}

function opRequest(cookie: string, csrf: string, body: string): Request {
  return testRequest('/operations/acme.order', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    cookie,
    body,
  });
}

function opBody(): string {
  return JSON.stringify({ operation: OP, operation_id: freshOperationId(), inputs: { qty: 2 } });
}

test('B4: a session revoked mid-flight voids the HTTP commit (403, never invokes)', async () => {
  const t = await httpSetup();
  // The catalog resolves after admission, before the commit fence — but
  // `shapeFor` is sync, so a real revoke cannot land deterministically
  // from inside it. Instead the hook flips a flag and the store wrapper
  // serves the revoked row from then on: admission (before the hook)
  // reads live, the fence (after the hook) reads revoked. The real
  // revoke-then-read path is pinned in the identity half; the MCP pin
  // below covers a real revoke end to end through the async hook.
  let midFlightRevoked = false;
  const realFind = t.deps.identity.store.findSessionByTokenHash.bind(t.deps.identity.store);
  const inner = t.deps.catalog.shapeFor.bind(t.deps.catalog);
  const deps = {
    ...t.deps,
    identity: {
      ...t.deps.identity,
      store: {
        ...t.deps.identity.store,
        findSessionByTokenHash: async (hash: string) => {
          const row = await realFind(hash);
          if (!midFlightRevoked || row === null) return row;
          return { ...row, revoked_at: new Date(Date.now()).toISOString() };
        },
      },
    },
    catalog: {
      ...t.deps.catalog,
      shapeFor: (operation: string) => {
        midFlightRevoked = true;
        return inner(operation);
      },
    },
  };
  const res = await handleOperationRequest(deps, opRequest(t.identity.cookie, t.csrf, opBody()), OP);
  assert.equal(res.status, 403);
  const body = (await res.json()) as { code: string; message: string };
  assert.equal(body.code, 'forbidden');
  assert.equal(body.message, ADMISSION_MESSAGE);
  assert.equal(t.invoker.mutations.length, 0);
});

test('B4: a live session passes the HTTP fence and commits', async () => {
  const t = await httpSetup();
  const res = await handleOperationRequest(t.deps, opRequest(t.identity.cookie, t.csrf, opBody()), OP);
  assert.equal(res.status, 200);
  const payload = (await res.json()) as { status: string };
  assert.equal(payload.status, 'committed');
  assert.equal(t.invoker.mutations.length, 1);
});

test('B4: a session expiring mid-flight voids the HTTP commit', async () => {
  const t = await httpSetup();
  // Short-lived session of our own: live at admission, dead at commit.
  const token = `b4-short-${randomBytes(8).toString('hex')}`;
  const baseMs = Date.now();
  await t.deps.identity.store.createSession({
    user_id: t.identity.userId,
    token_sha256: await sha256HexText(token),
    expires_at: new Date(baseMs + 60_000).toISOString(),
    last_team_id: t.identity.teamId,
  });
  const cookie = buildSessionCookie(token, { maxAgeSeconds: 3600, secure: false });
  const csrf = await deriveCsrfToken(token);
  let nowMs = baseMs;
  const inner = t.deps.catalog.shapeFor.bind(t.deps.catalog);
  const deps = {
    ...t.deps,
    clock: { nowMs: () => nowMs },
    catalog: {
      ...t.deps.catalog,
      shapeFor: (operation: string) => {
        nowMs = baseMs + 120_000;
        return inner(operation);
      },
    },
  };
  const res = await handleOperationRequest(deps, opRequest(cookie, csrf, opBody()), OP);
  assert.equal(res.status, 403);
  const body = (await res.json()) as { code: string; message: string };
  assert.equal(body.code, 'forbidden');
  assert.equal(body.message, ADMISSION_MESSAGE);
  assert.equal(t.invoker.mutations.length, 0);
});

const MUT_OP = 'acme.Todo.create';
const DESCRIPTORS: readonly OperationDescriptor[] = [
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
];
const MCP_SHAPES: Record<string, OperationInputShape> = {
  [MUT_OP]: { allowed: ['qty', 'label'], required: ['qty'] },
};

async function mcpSetup() {
  return createTestMcpDeps({
    descriptors: DESCRIPTORS,
    shapes: MCP_SHAPES,
    mutations: {
      [MUT_OP]: (envelope) => ({
        result: { status: 'committed', operation_id: envelope.operation_id },
      }),
    },
  });
}

async function mcpCall(
  handler: (request: Request) => Promise<Response>,
  grant: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: { result?: unknown; error?: { code: number; message: string } } }> {
  const res = await handler(
    testRequest('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${grant}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: MUT_OP, arguments: args },
      }),
    }),
  );
  return { status: res.status, body: (await res.json()) as { result?: unknown; error?: { code: number; message: string } } };
}

function mutationArgs(): Record<string, unknown> {
  return { operation_id: freshOperationId(), qty: 2 };
}

test('B4: a grant revoked mid-flight voids the MCP commit (isError, never invokes)', async () => {
  const t = await mcpSetup();
  // `canCall` runs after admission, before the commit fence: the
  // revocation lands strictly inside the mid-flight window.
  const inner = t.deps.permissions.canCall.bind(t.deps.permissions);
  const deps = {
    ...t.deps,
    permissions: {
      ...t.deps.permissions,
      canCall: async (...call: Parameters<typeof inner>) => {
        await revokeMcpGrantByToken(t.deps.identity.store, { token: t.grantToken });
        return inner(...call);
      },
    },
  };
  const { body } = await mcpCall(createMcpHandler(deps), t.grantToken, mutationArgs());
  assert.equal(body.error, undefined);
  const result = body.result as {
    content: ReadonlyArray<{ type: string; text: string }>;
    structuredContent?: { code: string; message: string };
    isError?: boolean;
  };
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.code, 'forbidden');
  assert.equal(result.structuredContent?.message, ADMISSION_MESSAGE);
  assert.equal(t.invoker.mutations.length, 0);
});

test('B4: a live grant passes the MCP fence and commits', async () => {
  const t = await mcpSetup();
  const { body } = await mcpCall(createMcpHandler(t.deps), t.grantToken, mutationArgs());
  assert.equal(body.error, undefined);
  const result = body.result as { isError?: boolean; structuredContent?: { status: string } };
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent?.status, 'committed');
  assert.equal(t.invoker.mutations.length, 1);
});

test('B4: mid-flight MCP denial matches the admission denial (no oracle)', async () => {
  const t = await mcpSetup();
  // Admission-time death: pre-revoked grant answers 401 at the gate.
  await revokeMcpGrantByToken(t.deps.identity.store, { token: t.grantToken });
  const denied = await mcpCall(createMcpHandler(t.deps), t.grantToken, mutationArgs());
  assert.equal(denied.status, 401);
  const gate = denied.body as unknown as { error: { code: string; message: string } };
  assert.equal(gate.error.code, 'forbidden');
  // Mid-flight death answers the identical message inside isError.
  const live = await mcpSetup();
  const inner = live.deps.permissions.canCall.bind(live.deps.permissions);
  const deps = {
    ...live.deps,
    permissions: {
      ...live.deps.permissions,
      canCall: async (...call: Parameters<typeof inner>) => {
        await revokeMcpGrantByToken(live.deps.identity.store, { token: live.grantToken });
        return inner(...call);
      },
    },
  };
  const { body } = await mcpCall(createMcpHandler(deps), live.grantToken, mutationArgs());
  const result = body.result as { structuredContent?: { code: string; message: string } };
  assert.equal(result.structuredContent?.code, gate.error.code);
  assert.equal(result.structuredContent?.message, gate.error.message);
  assert.equal(live.invoker.mutations.length, 0);
});
