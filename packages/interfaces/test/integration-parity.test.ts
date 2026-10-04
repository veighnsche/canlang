/**
 * B1 integration evidence: browser/MCP transport equivalence.
 *
 * Shared-assembly pattern: ONE real identity memory store + ONE recording
 * invoker double + descriptors/shapes, over which BOTH `createHttpHandler`
 * (operations sub-handler = the real `handleOperationRequest`) and
 * `createMcpHandler` are assembled. Two verified users (owner + member) in
 * one team; sessions + grants for each. Tests-only: no src changes, and no
 * stubbed identity resolution anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  buildSessionCookie,
  deriveCsrfToken,
  issueMcpGrant,
  loginWithPassword,
  registerWithEmail,
  revokeMcpGrantByToken,
  revokeSessionByToken,
  verifyEmail,
} from '@canlang/identity';
import type { IdentityStore } from '@canlang/identity';
import { createHttpHandler } from '../src/http/routes.js';
import { handleOperationRequest } from '../src/http/operations.js';
import { handleAuthRequest } from '../src/http/auth.js';
import { handleUploadRequest } from '../src/uploads/routes.js';
import { handleIngressRequest } from '../src/ingress/routes.js';
import { handleOAuthRequest } from '../src/oauth/routes.js';
import { createMcpHandler } from '../src/mcp/server.js';
import { toMcpTool } from '../src/mcp/tools.js';
import { toToolInputSchema } from '../src/mcp/schemas.js';
import {
  createFakeBindings,
  createFakeCatalog,
  createFakeFileUseInfo,
  createFakeInvoker,
  createFakeKernel,
  createFakeOperationRegistry,
  createFakePermissions,
  createFakeRegistry,
  createFakeSink,
  createFakeVerifier,
  createIdentityFixture,
  createMemoryRateLimiter,
  createRecordingLogger,
  createTestApp,
  createTestIdentityDeps,
  testRequest,
} from '../src/testing.js';
import type { IdentityFixture } from '../src/testing.js';
import { systemInterfacesClock } from '../src/ports.js';
import type {
  HttpDeps,
  McpDeps,
  McpPermissions,
  OperationDescriptor,
  OperationInputShape,
} from '../src/ports.js';
import { buildBusinessError } from '../src/errors/envelope.js';

const MUT_OP = 'acme.Todo.create';
const READ_OP = 'acme.Todo.read';
const TEAM_OP = 'system.team.invite';
const DENY_OP = 'acme.Denied.run';
const ERR_OP = 'acme.Broken.run';

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
  {
    name: READ_OP,
    kind: 'read',
    description: 'Read a todo.',
    inputs: { fields: [{ name: 'filter', field: { kind: 'string' }, required: false }] },
  },
  {
    name: TEAM_OP,
    kind: 'team',
    description: 'Invite a member.',
    inputs: { fields: [{ name: 'email', field: { kind: 'string' }, required: true }] },
  },
  { name: DENY_OP, kind: 'scenario', description: 'Denied op.', inputs: { fields: [] } },
  {
    name: ERR_OP,
    kind: 'create',
    description: 'Failing op.',
    inputs: { fields: [{ name: 'qty', field: { kind: 'integer' }, required: true }] },
  },
];

const SHAPES: Record<string, OperationInputShape> = {
  [MUT_OP]: { allowed: ['qty', 'label'], required: ['qty'] },
  [READ_OP]: { allowed: ['filter'], required: [] },
  [TEAM_OP]: { allowed: ['email'], required: ['email'] },
  [DENY_OP]: { allowed: [], required: [] },
  [ERR_OP]: { allowed: ['qty'], required: ['qty'] },
};

const PASSWORD = 's3cure-password';

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

interface HttpErrorBody {
  readonly code: string;
  readonly message: string;
}

type HttpHandler = (request: Request) => Promise<Response>;
type McpHandler = (request: Request) => Promise<Response>;

function toolResult(body: RpcBody): ToolResultBody {
  assert.ok(body.result !== undefined && body.error === undefined);
  return body.result as ToolResultBody;
}

function rpcError(body: RpcBody): RpcErrorBody {
  assert.ok(body.error !== undefined);
  return body.error;
}

async function mcpCall(
  handler: McpHandler,
  method: string,
  params: Record<string, unknown>,
  opts: { grant?: string; id?: number } = {},
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
      body: JSON.stringify({ jsonrpc: '2.0', id: opts.id ?? 1, method, params }),
    }),
  );
  return { status: res.status, body: (await res.json()) as RpcBody };
}

function opPost(
  op: string,
  opts: { cookie?: string; csrf?: string; body: unknown },
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.csrf !== undefined) headers['x-csrf-token'] = opts.csrf;
  return testRequest(`/api/operations/${op}`, {
    method: 'POST',
    headers,
    ...(opts.cookie === undefined ? {} : { cookie: opts.cookie }),
    body: JSON.stringify(opts.body),
  });
}

async function httpErrorOf(res: Response): Promise<{ status: number; code: string; message: string }> {
  const body = (await res.json()) as HttpErrorBody;
  return { status: res.status, code: body.code, message: body.message };
}

interface UserCreds {
  readonly userId: string;
  readonly sessionToken: string;
  readonly cookie: string;
  readonly csrf: string;
  readonly grant: string;
}

async function registerTeamUser(
  store: IdentityStore,
  mail: IdentityFixture['mail'],
  email: string,
  teamId: string,
  isOwner: boolean,
): Promise<UserCreds> {
  await registerWithEmail(
    store,
    mail,
    { email, password: PASSWORD },
    { verifyBaseUrl: 'https://test.invalid/verify' },
  );
  const last = mail.messages[mail.messages.length - 1];
  assert.ok(last);
  const token = (last.body_text.match(/[?&]token=([A-Za-z0-9_-]+)/) ?? [])[1] ?? '';
  const { user_id } = await verifyEmail(store, { token });
  await store.createMembership({ team_id: teamId, user_id, is_owner: isOwner, roles: [] });
  const { token: sessionToken } = await loginWithPassword(store, { email, password: PASSWORD });
  const cookie = buildSessionCookie(sessionToken, { maxAgeSeconds: 3600, secure: false });
  const csrf = await deriveCsrfToken(sessionToken);
  const { token: grant } = await issueMcpGrant(
    store,
    { user_id, team_id: teamId, client_id: 'test-client' },
    {},
  );
  return { userId: user_id, sessionToken, cookie, csrf, grant };
}

interface Assembly {
  readonly http: HttpHandler;
  readonly mcp: McpHandler;
  readonly invoker: ReturnType<typeof createFakeInvoker>;
  readonly store: IdentityStore;
  readonly teamId: string;
  readonly owner: UserCreds;
  readonly member: UserCreds;
  /** Second team the owner also owns, for grant team-binding tests. */
  readonly team2: string;
  readonly ownerT2Grant: string;
  /** Bare team nobody belongs to, for foreign-team select tests. */
  readonly foreignTeam: string;
}

/**
 * Shared assembly: one real store, one recording invoker, both transports.
 * The invoker is a passive recorder EXCEPT two scripted L3 stand-ins,
 * documented at each use: `TEAM_OP` enforces owner-only membership and
 * `DENY_OP` always answers forbidden (HTTP has no permission port, so the
 * invoker's business error is the HTTP-side denial under test).
 */
async function setup(opts: {
  permissions?: McpPermissions;
} = {}): Promise<Assembly> {
  const fixture = await createIdentityFixture({ email: 'owner@test.example' });
  const store = fixture.store;
  const ownerCsrf = await deriveCsrfToken(fixture.sessionToken);
  const { token: ownerGrant } = await issueMcpGrant(
    store,
    { user_id: fixture.userId, team_id: fixture.teamId, client_id: 'test-client' },
    {},
  );
  const owner: UserCreds = {
    userId: fixture.userId,
    sessionToken: fixture.sessionToken,
    cookie: fixture.cookie,
    csrf: ownerCsrf,
    grant: ownerGrant,
  };
  const member = await registerTeamUser(store, fixture.mail, 'member@test.example', fixture.teamId, false);

  const team2 = (await store.createTeam({})).team_id;
  await store.createMembership({ team_id: team2, user_id: owner.userId, is_owner: true, roles: [] });
  const { token: ownerT2Grant } = await issueMcpGrant(
    store,
    { user_id: owner.userId, team_id: team2, client_id: 'test-client' },
    {},
  );
  const foreignTeam = (await store.createTeam({})).team_id;

  const logger = createRecordingLogger();
  const invoker = createFakeInvoker({
    mutations: {
      [MUT_OP]: (envelope) => ({
        result: {
          status: 'committed',
          operation_id: envelope.operation_id,
          result: { echoed: envelope.inputs },
        },
      }),
      // Scripted L3 stand-in: owner-only team policy. MCP enforces this in
      // server.ts; HTTP relies on the invoker's business error, which is
      // exactly the equivalence under test.
      [TEAM_OP]: (envelope, identity) =>
        identity.membership?.is_owner === true
          ? { result: { status: 'committed', operation_id: envelope.operation_id, result: null } }
          : { error: buildBusinessError('forbidden') },
      [DENY_OP]: () => ({ error: buildBusinessError('forbidden') }),
      [ERR_OP]: () => ({ error: buildBusinessError('validation', 'Qty must be positive.') }),
    },
    reads: {
      [READ_OP]: (envelope) => ({ result: { echoed: envelope.inputs } }),
    },
  });

  const identity = createTestIdentityDeps(fixture);
  const httpDeps: HttpDeps = {
    app: createTestApp(),
    pages: createFakeRegistry([]),
    invoker,
    catalog: createFakeCatalog(SHAPES),
    limiter: createMemoryRateLimiter(),
    logger,
    clock: systemInterfacesClock,
    identity,
    secureCookies: false,
    uploads: {
      files: createFakeFileUseInfo(true),
      kernel: createFakeKernel({
        createIntent: () => ({
          status: 'granted',
          intentId: 'intent-1',
          grant: {
            intent_id: 'intent-1',
            content: 'https://test.invalid/files/content/intent-1',
            finalize: 'https://test.invalid/files/finalize/intent-1',
            expires_at: '2026-10-04T16:00:00.000Z',
          },
        }),
      }),
    },
    ingress: {
      bindings: createFakeBindings([]),
      verifier: createFakeVerifier({}),
      sink: createFakeSink(),
    },
  };
  const mcpDeps: McpDeps = {
    app: httpDeps.app,
    registry: createFakeOperationRegistry(DESCRIPTORS),
    permissions: opts.permissions ?? createFakePermissions({}),
    invoker,
    catalog: httpDeps.catalog,
    files: { usesFiles: () => false, intentsUrl: () => 'https://test.invalid/files/intents' },
    identity,
    logger,
    clock: systemInterfacesClock,
  };
  const http = createHttpHandler(httpDeps, {
    operations: (req, op) => handleOperationRequest(httpDeps, req, op),
    auth: (req) => handleAuthRequest(httpDeps, req),
    uploads: (req) =>
      handleUploadRequest(
        {
          app: httpDeps.app,
          files: httpDeps.uploads.files,
          kernel: httpDeps.uploads.kernel,
          identity,
          logger,
          clock: systemInterfacesClock,
        },
        req,
      ),
    ingress: (req) =>
      handleIngressRequest(
        {
          bindings: httpDeps.ingress.bindings,
          verifier: httpDeps.ingress.verifier,
          sink: httpDeps.ingress.sink,
          logger,
          clock: systemInterfacesClock,
        },
        req,
      ),
    oauth: (req) =>
      handleOAuthRequest(
        { identity, limiter: httpDeps.limiter, logger, clock: systemInterfacesClock },
        req,
      ),
  });
  const mcp = createMcpHandler(mcpDeps);
  return {
    http,
    mcp,
    invoker,
    store,
    teamId: fixture.teamId,
    owner,
    member,
    team2,
    ownerT2Grant,
    foreignTeam,
  };
}

/* ------------------------------------------------------------------ */
/* Same-op invocation.                                                 */
/* ------------------------------------------------------------------ */

// B1 evidence: same mutation via HTTP and MCP produces deep-equal invoker inputs.
test('B1 same-op: identical mutation via HTTP and MCP records deep-equal inputs', async () => {
  const t = await setup();
  const inputs = { qty: 2, label: 'x' };
  const httpRes = await t.http(
    opPost(MUT_OP, {
      cookie: t.owner.cookie,
      csrf: t.owner.csrf,
      body: { operation_id: freshOperationId(), inputs },
    }),
  );
  assert.equal(httpRes.status, 200);
  const mcpRes = await mcpCall(
    t.mcp,
    'tools/call',
    { name: MUT_OP, arguments: { operation_id: freshOperationId(), ...inputs } },
    { grant: t.owner.grant },
  );
  assert.equal(mcpRes.status, 200);
  assert.equal(toolResult(mcpRes.body).isError, undefined);
  assert.equal(t.invoker.mutations.length, 2);
  const viaHttp = t.invoker.mutations[0];
  const viaMcp = t.invoker.mutations[1];
  assert.ok(viaHttp);
  assert.ok(viaMcp);
  assert.equal(viaHttp.envelope.operation, viaMcp.envelope.operation);
  assert.deepEqual(viaHttp.envelope.inputs, viaMcp.envelope.inputs);
  assert.deepEqual(viaMcp.envelope.inputs, inputs);
});

// B1 evidence: read framing fidelity on MCP; HTTP has no read-operation
// route (S4 operations are POST-mutation-only; reads travel via page GETs),
// so read parity is MCP-side envelope fidelity plus the documented gap.
test('B1 same-op: read via MCP preserves inputs exactly; HTTP operations are mutation-only', async () => {
  const t = await setup();
  const { body } = await mcpCall(
    t.mcp,
    'tools/call',
    { name: READ_OP, arguments: { filter: 'open' } },
    { grant: t.owner.grant },
  );
  assert.equal(toolResult(body).isError, undefined);
  assert.equal(t.invoker.reads.length, 1);
  assert.deepEqual(t.invoker.reads[0]?.envelope, {
    operation: READ_OP,
    inputs: { filter: 'open' },
  });
  // The HTTP operations route only serves POST mutations: a GET is 404, and
  // documents that reads have no HTTP-operation equivalent.
  const get = await t.http(testRequest(`/api/operations/${READ_OP}`, { method: 'GET' }));
  assert.equal(get.status, 404);
});

/* ------------------------------------------------------------------ */
/* Single derivation point for descriptions/schemas.                   */
/* ------------------------------------------------------------------ */

// B1 evidence: tools/list entries derive once from the descriptor — no
// per-transport copy of descriptions or schemas.
test('B1 derivation: tools/list entry deep-equals toMcpTool/toToolInputSchema output', async () => {
  const t = await setup();
  const { body } = await mcpCall(t.mcp, 'tools/list', {}, { grant: t.owner.grant });
  assert.ok(body.result !== undefined && body.error === undefined);
  const listed = (body.result as { tools: Array<Record<string, unknown>> }).tools;
  assert.ok(Array.isArray(listed));
  const descriptor = DESCRIPTORS.find((d) => d.name === MUT_OP);
  assert.ok(descriptor);
  const entry = listed.find((tool) => tool['name'] === MUT_OP);
  assert.ok(entry);
  assert.deepEqual(entry, toMcpTool(descriptor));
  assert.deepEqual(entry['inputSchema'], toToolInputSchema(descriptor));
  assert.equal(entry['description'], descriptor.description);
});

/* ------------------------------------------------------------------ */
/* Rejected equally.                                                   */
/* ------------------------------------------------------------------ */

// B1 evidence: forged credentials rejected equally. Statuses differ by a
// DOCUMENTED rule (MCP/S6 credential denials are 401; the operations route
// projects the contract table, so forbidden is 403) — the safe meaning
// (code `forbidden`) is identical on both transports.
test('B1 reject: forged credential is forbidden on both transports', async () => {
  const t = await setup();
  const httpRes = await t.http(
    opPost(MUT_OP, {
      cookie: 'can_session=garbage',
      csrf: 'garbage',
      body: { operation_id: freshOperationId(), inputs: { qty: 1 } },
    }),
  );
  const httpErr = await httpErrorOf(httpRes);
  assert.equal(httpErr.status, 403);
  assert.equal(httpErr.code, 'forbidden');

  const mcpRes = await t.mcp(
    testRequest('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer [REDACTED]',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
  );
  assert.equal(mcpRes.status, 401);
  const mcpErr = (await mcpRes.json()) as AuthErrorBody;
  assert.equal(mcpErr.error.code, 'forbidden');
  assert.equal(t.invoker.mutations.length, 0);
});

// B1 evidence: expired grants rejected on both transports. The HTTP-side
// grant path is /files/* (operations take sessions, not grants), so both
// sides answer the MCP-style credential 401 here.
test('B1 reject: expired grant is 401 on both transports', async () => {
  const t = await setup();
  const { token } = await issueMcpGrant(
    t.store,
    { user_id: t.owner.userId, team_id: t.teamId, client_id: 'expired' },
    { ttlMs: -1000 },
  );
  const mcpRes = await t.mcp(
    testRequest('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
  );
  assert.equal(mcpRes.status, 401);
  const httpRes = await t.http(
    testRequest('/files/intents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ upload_id: 'up-1', field: '/attachment' }),
    }),
  );
  const httpErr = await httpErrorOf(httpRes);
  assert.equal(httpErr.status, 401);
  assert.equal(httpErr.code, 'forbidden');
});

// B1 evidence: a grant revoked mid-flow stops working on both transports.
test('B1 reject: grant revoked mid-flow is 401 on both transports', async () => {
  const t = await setup();
  const { token } = await issueMcpGrant(
    t.store,
    { user_id: t.owner.userId, team_id: t.teamId, client_id: 'revoke-me' },
    {},
  );
  const before = await mcpCall(t.mcp, 'tools/list', {}, { grant: token });
  assert.equal(before.status, 200);
  await revokeMcpGrantByToken(t.store, { token });
  const mcpRes = await t.mcp(
    testRequest('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    }),
  );
  assert.equal(mcpRes.status, 401);
  const httpRes = await t.http(
    testRequest('/files/intents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ upload_id: 'up-1', field: '/attachment' }),
    }),
  );
  const httpErr = await httpErrorOf(httpRes);
  assert.equal(httpErr.status, 401);
  assert.equal(httpErr.code, 'forbidden');
});

// B1 evidence: a revoked session stops invoking over HTTP. The operations
// route projects the contract table, so the status is 403 (not the
// MCP-style 401) with the same safe `forbidden` code.
test('B1 reject: revoked session is forbidden over HTTP', async () => {
  const t = await setup();
  const ok = await t.http(
    opPost(MUT_OP, {
      cookie: t.owner.cookie,
      csrf: t.owner.csrf,
      body: { operation_id: freshOperationId(), inputs: { qty: 1 } },
    }),
  );
  assert.equal(ok.status, 200);
  await revokeSessionByToken(t.store, { token: t.owner.sessionToken });
  const res = await t.http(
    opPost(MUT_OP, {
      cookie: t.owner.cookie,
      csrf: t.owner.csrf,
      body: { operation_id: freshOperationId(), inputs: { qty: 1 } },
    }),
  );
  const err = await httpErrorOf(res);
  assert.equal(err.status, 403);
  assert.equal(err.code, 'forbidden');
  assert.equal(t.invoker.mutations.length, 1);
});

// B1 evidence: unknown-team scope is rejected over HTTP (foreign team 403,
// nonexistent team 404), while MCP — which has no team override — binds the
// grant team: a grant for another team cannot touch a team-scoped op.
test('B1 reject: unknown team override forbidden over HTTP; MCP binds the grant team', async () => {
  const t = await setup();
  const foreign = await t.http(
    testRequest('/auth/select-team', {
      method: 'POST',
      cookie: t.owner.cookie,
      headers: { 'content-type': 'application/json', 'x-csrf-token': t.owner.csrf },
      body: JSON.stringify({ team: t.foreignTeam }),
    }),
  );
  assert.equal(foreign.status, 403);
  const missing = await t.http(
    testRequest('/auth/select-team', {
      method: 'POST',
      cookie: t.owner.cookie,
      headers: { 'content-type': 'application/json', 'x-csrf-token': t.owner.csrf },
      body: JSON.stringify({ team: 'team-does-not-exist' }),
    }),
  );
  assert.equal(missing.status, 404);

  // MCP has no override: team scoping is the grant binding + canCall.
  const scoped = await setup({
    permissions: {
      canDiscover: () => true,
      canCall: (identity, operation) =>
        operation !== MUT_OP || identity.team?.team_id === t.teamId,
    },
  });
  const { body } = await mcpCall(
    scoped.mcp,
    'tools/call',
    { name: MUT_OP, arguments: { operation_id: freshOperationId(), qty: 1 } },
    { grant: scoped.ownerT2Grant },
  );
  const result = toolResult(body);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.['code'], 'forbidden');
  assert.equal(scoped.invoker.mutations.length, 0);
});

// B1 evidence: unknown arguments fail validation on both transports.
test('B1 reject: unknown argument is 400 over HTTP and -32602 over MCP', async () => {
  const t = await setup();
  const httpRes = await t.http(
    opPost(MUT_OP, {
      cookie: t.owner.cookie,
      csrf: t.owner.csrf,
      body: { operation_id: freshOperationId(), inputs: { qty: 1, bogus: true } },
    }),
  );
  const httpErr = await httpErrorOf(httpRes);
  assert.equal(httpErr.status, 400);
  assert.equal(httpErr.code, 'validation');
  const { body } = await mcpCall(
    t.mcp,
    'tools/call',
    { name: MUT_OP, arguments: { operation_id: freshOperationId(), qty: 1, bogus: true } },
    { grant: t.owner.grant },
  );
  assert.equal(rpcError(body).code, -32602);
  assert.equal(t.invoker.mutations.length, 0);
});

// B1 evidence: mutations without operation_id are rejected on both transports.
test('B1 reject: missing operation_id is 400 over HTTP and -32602 over MCP', async () => {
  const t = await setup();
  const httpRes = await t.http(
    opPost(MUT_OP, {
      cookie: t.owner.cookie,
      csrf: t.owner.csrf,
      body: { inputs: { qty: 1 } },
    }),
  );
  const httpErr = await httpErrorOf(httpRes);
  assert.equal(httpErr.status, 400);
  assert.equal(httpErr.code, 'validation');
  const { body } = await mcpCall(
    t.mcp,
    'tools/call',
    { name: MUT_OP, arguments: { qty: 1 } },
    { grant: t.owner.grant },
  );
  assert.equal(rpcError(body).code, -32602);
  assert.equal(t.invoker.mutations.length, 0);
});

// B1 evidence: canCall=false denies over MCP while HTTP — which has no
// permission port — denies via the invoker business error; the safe message
// text is IDENTICAL on both transports.
test('B1 reject: canCall=false (MCP) and invoker-forbidden (HTTP) share identical text', async () => {
  const t = await setup({ permissions: createFakePermissions({ call: { [DENY_OP]: false } }) });
  const httpRes = await t.http(
    opPost(DENY_OP, {
      cookie: t.owner.cookie,
      csrf: t.owner.csrf,
      body: { operation_id: freshOperationId(), inputs: {} },
    }),
  );
  const httpErr = await httpErrorOf(httpRes);
  assert.equal(httpErr.status, 403);
  assert.equal(httpErr.code, 'forbidden');
  const { body } = await mcpCall(
    t.mcp,
    'tools/call',
    { name: DENY_OP, arguments: { operation_id: freshOperationId() } },
    { grant: t.owner.grant },
  );
  const result = toolResult(body);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.['code'], 'forbidden');
  assert.equal(result.structuredContent?.['message'], httpErr.message);
});

// B1 evidence: owner-only team tool by a non-owner is forbidden on both
// transports with the same safe message (MCP: server owner check; HTTP:
// invoker business error via the scripted L3 stand-in).
test('B1 reject: owner-only team tool by non-owner shares identical text', async () => {
  const t = await setup();
  const httpRes = await t.http(
    opPost(TEAM_OP, {
      cookie: t.member.cookie,
      csrf: t.member.csrf,
      body: { operation_id: freshOperationId(), inputs: { email: 'new@test.example' } },
    }),
  );
  const httpErr = await httpErrorOf(httpRes);
  assert.equal(httpErr.status, 403);
  assert.equal(httpErr.code, 'forbidden');
  const { body } = await mcpCall(
    t.mcp,
    'tools/call',
    {
      name: TEAM_OP,
      arguments: { operation_id: freshOperationId(), email: 'new@test.example' },
    },
    { grant: t.member.grant },
  );
  const result = toolResult(body);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.['code'], 'forbidden');
  assert.equal(result.structuredContent?.['message'], httpErr.message);
});

/* ------------------------------------------------------------------ */
/* Replay passthrough.                                                 */
/* ------------------------------------------------------------------ */

// B1 evidence: transports neither mint nor strip operation_ids — the same
// id sent twice on each transport reaches the invoker twice, verbatim.
// Idempotency is L3's; the transport must pass through.
test('B1 replay: duplicate operation_id reaches the invoker twice per transport', async () => {
  const t = await setup();
  const httpId = freshOperationId();
  for (let i = 0; i < 2; i++) {
    const res = await t.http(
      opPost(MUT_OP, {
        cookie: t.owner.cookie,
        csrf: t.owner.csrf,
        body: { operation_id: httpId, inputs: { qty: 1 } },
      }),
    );
    assert.equal(res.status, 200);
  }
  const mcpId = freshOperationId();
  for (let i = 0; i < 2; i++) {
    const { body } = await mcpCall(
      t.mcp,
      'tools/call',
      { name: MUT_OP, arguments: { operation_id: mcpId, qty: 1 } },
      { grant: t.owner.grant },
    );
    assert.equal(toolResult(body).isError, undefined);
  }
  assert.equal(t.invoker.mutations.length, 4);
  const ids = t.invoker.mutations.map((call) => call.envelope.operation_id);
  assert.deepEqual(ids, [httpId, httpId, mcpId, mcpId]);
});

/* ------------------------------------------------------------------ */
/* Error-shape parity.                                                 */
/* ------------------------------------------------------------------ */

// B1 evidence: one invoker business error renders with identical code +
// message on both transports, and the message leaks no internals.
test('B1 errors: business error shares code+message on both transports, no leak', async () => {
  const t = await setup();
  const httpRes = await t.http(
    opPost(ERR_OP, {
      cookie: t.owner.cookie,
      csrf: t.owner.csrf,
      body: { operation_id: freshOperationId(), inputs: { qty: 1 } },
    }),
  );
  const httpErr = await httpErrorOf(httpRes);
  assert.equal(httpErr.status, 400);
  assert.equal(httpErr.code, 'validation');
  const { body } = await mcpCall(
    t.mcp,
    'tools/call',
    { name: ERR_OP, arguments: { operation_id: freshOperationId(), qty: 1 } },
    { grant: t.owner.grant },
  );
  const result = toolResult(body);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.['code'], httpErr.code);
  assert.equal(result.structuredContent?.['message'], httpErr.message);
  assert.ok(!httpErr.message.includes('Error at'));
  assert.ok(!httpErr.message.includes('.ts:'));
  const text = result.content[0]?.text ?? '';
  assert.ok(!text.includes('Error at'));
  assert.ok(!text.includes('.ts:'));
});
