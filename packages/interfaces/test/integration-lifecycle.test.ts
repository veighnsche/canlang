/**
 * B2 integration evidence: lifecycle journeys over one real identity store.
 *
 * Shared-assembly pattern: ONE real identity memory store + ONE recording
 * invoker double + descriptors/shapes, over which a fully-wired
 * `createHttpHandler` (real operations/auth/uploads/ingress/oauth
 * sub-handlers) and `createMcpHandler` are assembled. Owner + member in
 * team T1; user B in team T2 (owner is also a T2 member for consent-binding
 * tests). Sessions + grants for each. Tests-only: no src changes, and no
 * stubbed identity resolution anywhere.
 *
 * The invoker/kernel/verifier/sink doubles are passive recorders EXCEPT the
 * membership-liveness permissions double in the role-lifecycle test, which
 * reads live membership from the real store (documented there; L3 owns the
 * real policy).
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
  removeMember,
  revokeMcpGrantByToken,
  verifyEmail,
} from '@canlang/identity';
import type { IdentityStore } from '@canlang/identity';
import type { ContentCheck } from '@canlang/contracts';
import { createHttpHandler } from '../src/http/routes.js';
import { handleOperationRequest } from '../src/http/operations.js';
import { handleAuthRequest } from '../src/http/auth.js';
import { handleUploadRequest } from '../src/uploads/routes.js';
import { handleIngressRequest } from '../src/ingress/routes.js';
import { handleOAuthRequest } from '../src/oauth/routes.js';
import { createMcpHandler } from '../src/mcp/server.js';
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
  createTestBinding,
  createTestEnvelope,
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

const MUT_OP = 'acme.Todo.create';
const READ_OP = 'acme.Todo.read';
const TEAM_OP = 'system.team.invite';

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
];

const SHAPES: Record<string, OperationInputShape> = {
  [MUT_OP]: { allowed: ['qty', 'label'], required: ['qty'] },
  [READ_OP]: { allowed: ['filter'], required: [] },
  [TEAM_OP]: { allowed: ['email'], required: ['email'] },
};

const PASSWORD = 's3cure-password';
const REDIRECT = 'https://app.example/callback';
// RFC 7636 Appendix B test vector (verifier <-> challenge).
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const ACCEPTED_CHECK: ContentCheck = {
  claimedType: 'application/pdf',
  detectedType: 'application/pdf',
  sizeBytes: 4,
  verdict: 'accepted',
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

async function httpErrorOf(res: Response): Promise<{ status: number; code: string; message: string }> {
  const body = (await res.json()) as HttpErrorBody;
  return { status: res.status, code: body.code, message: body.message };
}

function sessionPost(path: string, cookie: string, csrf: string, body: unknown): Request {
  return testRequest(path, {
    method: 'POST',
    cookie,
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify(body),
  });
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
  readonly sink: ReturnType<typeof createFakeSink>;
  readonly store: IdentityStore;
  /** Team T1: owner + member. */
  readonly team1: string;
  /** Team T2: user B's team; the owner is also a member (consent tests). */
  readonly team2: string;
  readonly owner: UserCreds;
  readonly member: UserCreds;
  readonly userB: UserCreds;
}

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
  const userB = await registerTeamUser(store, fixture.mail, 'userb@test.example', team2, true);
  await store.createMembership({ team_id: team2, user_id: owner.userId, is_owner: false, roles: [] });

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
      [TEAM_OP]: (envelope) => ({
        result: { status: 'committed', operation_id: envelope.operation_id, result: null },
      }),
    },
    reads: {
      [READ_OP]: (envelope) => ({ result: { echoed: envelope.inputs } }),
    },
  });

  const identity = createTestIdentityDeps(fixture);
  const sink = createFakeSink(true);
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
        append: () => ({ status: 'appended', receivedBytes: 4 }),
        complete: () => ({ status: 'completed', check: ACCEPTED_CHECK }),
        // Only intent-1 exists: invented intents fail foreign (404), so the
        // route proves it never mints JSON for unknown ids.
        finalize: ({ intentId }) =>
          intentId === 'intent-1'
            ? {
                status: 'finalized',
                result: { file: 'file-1' },
                file: {
                  id: 'file-1',
                  provenance: {
                    kind: 'request',
                    app: 'test-app',
                    team: 't-1',
                    owner: 't-1',
                    principal: 'u-1',
                    adapter: 'bridge-v1',
                    deliveryId: 'up-1',
                    resultPath: '/attachment',
                  },
                  contentType: 'application/pdf',
                  sizeBytes: 4,
                  bytesDigest: 'sha256:deadbeef',
                  finalizedAt: '2026-10-04T16:00:00.000Z',
                },
              }
            : { status: 'failed', reason: 'foreign' },
      }),
    },
    ingress: {
      bindings: createFakeBindings([
        createTestBinding({ namespace: 'acme-billing' }),
        createTestBinding({ namespace: 'dead-ns' }),
      ]),
      // acme-billing verifies; dead-ns has no entry, so the fake verifier
      // answers null (fail closed) — the unverified journey.
      verifier: createFakeVerifier({ 'acme-billing': createTestEnvelope() }),
      sink,
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
    sink,
    store,
    team1: fixture.teamId,
    team2,
    owner,
    member,
    userB,
  };
}

/** Run the authorize-POST + token-exchange leg and return the access token. */
async function authorizeAccessToken(
  t: Assembly,
  clientId: string,
  cookie: string,
  csrf: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const authRes = await t.http(
    sessionPost('/oauth/authorize', cookie, csrf, {
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      ...extra,
    }),
  );
  assert.equal(authRes.status, 302);
  const location = new URL(authRes.headers.get('location') ?? '');
  const code = location.searchParams.get('code') ?? '';
  assert.ok(code.length > 0);
  const tokenRes = await t.http(
    testRequest('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: VERIFIER,
      }).toString(),
    }),
  );
  assert.equal(tokenRes.status, 200);
  const tokenBody = (await tokenRes.json()) as Record<string, unknown>;
  assert.equal(tokenBody['token_type'], 'Bearer');
  const accessToken = tokenBody['access_token'];
  assert.ok(typeof accessToken === 'string' && accessToken.length > 0);
  return accessToken;
}

/* ------------------------------------------------------------------ */
/* OAuth dance to MCP call.                                            */
/* ------------------------------------------------------------------ */

// B2 evidence: full OAuth dance (register -> authorize POST -> 302 code ->
// token exchange -> access_token) then tools/list + tools/call succeed —
// the real chain over the real store.
test('B2 oauth: full dance yields an access token that drives MCP calls', async () => {
  const t = await setup();
  const regRes = await t.http(
    testRequest('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Desk' }),
    }),
  );
  assert.equal(regRes.status, 201);
  const { client_id } = (await regRes.json()) as { client_id: string };

  const accessToken = await authorizeAccessToken(t, client_id, t.owner.cookie, t.owner.csrf);

  const list = await mcpCall(t.mcp, 'tools/list', {}, { grant: accessToken });
  assert.equal(list.status, 200);
  assert.ok(list.body.result !== undefined);
  const call = await mcpCall(
    t.mcp,
    'tools/call',
    { name: MUT_OP, arguments: { operation_id: freshOperationId(), qty: 1 } },
    { grant: accessToken },
  );
  assert.equal(toolResult(call.body).isError, undefined);
  assert.equal(t.invoker.mutations.length, 1);
  assert.equal(t.invoker.mutations[0]?.identity.actor?.user_id, t.owner.userId);
});

// B2 evidence: consent team binding — authorize with a team override binds
// the grant to that team, observed via the identity reaching the invoker.
test('B2 oauth: authorize team override binds the grant team', async () => {
  const t = await setup();
  const regRes = await t.http(
    testRequest('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    }),
  );
  assert.equal(regRes.status, 201);
  const { client_id } = (await regRes.json()) as { client_id: string };

  const accessToken = await authorizeAccessToken(t, client_id, t.owner.cookie, t.owner.csrf, {
    team: t.team2,
  });
  const call = await mcpCall(
    t.mcp,
    'tools/call',
    { name: READ_OP, arguments: { filter: 'open' } },
    { grant: accessToken },
  );
  assert.equal(toolResult(call.body).isError, undefined);
  assert.equal(t.invoker.reads.length, 1);
  assert.equal(t.invoker.reads[0]?.identity.team?.team_id, t.team2);
});

/* ------------------------------------------------------------------ */
/* Revocation mid-flow.                                                */
/* ------------------------------------------------------------------ */

// B2 evidence: session revocation mid-flow — call ok, logout via the real
// route, then the same call is forbidden (403: the operations route
// projects the contract table, not the MCP-style 401).
test('B2 revoke: logout mid-flow forbids subsequent operation calls', async () => {
  const t = await setup();
  const opBody = (): unknown => ({ operation_id: freshOperationId(), inputs: { qty: 1 } });
  const ok = await t.http(sessionPost(`/api/operations/${MUT_OP}`, t.member.cookie, t.member.csrf, opBody()));
  assert.equal(ok.status, 200);
  const logout = await t.http(sessionPost('/auth/logout', t.member.cookie, t.member.csrf, {}));
  assert.equal(logout.status, 200);
  const after = await t.http(sessionPost(`/api/operations/${MUT_OP}`, t.member.cookie, t.member.csrf, opBody()));
  const err = await httpErrorOf(after);
  assert.equal(err.status, 403);
  assert.equal(err.code, 'forbidden');
  assert.equal(t.invoker.mutations.length, 1);
});

// B2 evidence: grant revocation mid-flow — call ok, revoke, then 401.
test('B2 revoke: grant revoked mid-flow answers 401', async () => {
  const t = await setup();
  const callArgs = (): Record<string, unknown> => ({
    name: READ_OP,
    arguments: { filter: 'open' },
  });
  const before = await mcpCall(t.mcp, 'tools/call', callArgs(), { grant: t.member.grant });
  assert.equal(toolResult(before.body).isError, undefined);
  await revokeMcpGrantByToken(t.store, { token: t.member.grant });
  const res = await t.mcp(
    testRequest('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${t.member.grant}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: callArgs() }),
    }),
  );
  assert.equal(res.status, 401);
  assert.equal(t.invoker.reads.length, 1);
});

/* ------------------------------------------------------------------ */
/* Role/member lifecycle.                                              */
/* ------------------------------------------------------------------ */

// B2 evidence: member calls a team op, then removeMember forbids the next
// call WITHOUT re-issue. The permissions double reads membership liveness
// from the REAL store (L3 owns the real policy; this double exists only to
// prove the lifecycle joins identity truth). The member uses a teamless
// grant so the removeMember team-grant cascade cannot explain the denial:
// auth still passes, and the denial comes from the liveness check.
test('B2 roles: removeMember forbids subsequent calls without re-issue', async () => {
  const t = await setup({
    permissions: {
      canDiscover: () => true,
      canCall: async (identity, operation) => {
        if (operation !== MUT_OP) return true;
        const actor = identity.actor?.user_id;
        if (actor === undefined) return false;
        // Liveness read against the real store; set up with team1 below.
        const membership = await t.store.findMembership(t.team1, actor);
        return membership !== null && membership.status === 'active';
      },
    },
  });
  const { token: appGrant } = await issueMcpGrant(
    t.store,
    { user_id: t.member.userId, team_id: null, client_id: 'lifecycle-probe' },
    {},
  );
  const args = (): Record<string, unknown> => ({
    name: MUT_OP,
    arguments: { operation_id: freshOperationId(), qty: 1 },
  });
  const before = await mcpCall(t.mcp, 'tools/call', args(), { grant: appGrant });
  assert.equal(toolResult(before.body).isError, undefined);

  await removeMember(
    t.store,
    { team_id: t.team1, member_user_id: t.member.userId },
    { removed_by: t.owner.userId },
  );

  // Same grant, no re-issue: auth passes (teamless grants survive the
  // team-grant cascade) and the liveness check denies.
  const after = await mcpCall(t.mcp, 'tools/call', args(), { grant: appGrant });
  assert.equal(after.status, 200);
  const result = toolResult(after.body);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.['code'], 'forbidden');
  assert.equal(t.invoker.mutations.length, 1);
});

/* ------------------------------------------------------------------ */
/* Uploads journey.                                                    */
/* ------------------------------------------------------------------ */

// B2 evidence: uploads journey — intent -> PUT -> finalize returns {file},
// and an invented intent answers 404 (no JSON minting for unknown ids).
// NOTE: the kernel here is the scripted fake; real-kernel evidence for
// these routes lives in the /tmp/s6-kernel-probe.mjs probe run.
test('B2 uploads: intent -> PUT -> finalize journeys to {file}; invented intent 404s', async () => {
  const t = await setup();
  const intent = await t.http(
    sessionPost('/files/intents', t.owner.cookie, t.owner.csrf, {
      upload_id: 'up-1',
      operation: 'shop.Order.create',
      field: '/attachment',
      arguments: {},
      name: 'a.pdf',
      type: 'application/pdf',
      size: '4',
    }),
  );
  assert.equal(intent.status, 200);
  const grant = (await intent.json()) as { intent_id: string };
  assert.equal(grant.intent_id, 'intent-1');

  const put = await t.http(
    testRequest('/files/content/intent-1', {
      method: 'PUT',
      cookie: t.owner.cookie,
      headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': t.owner.csrf },
      body: 'abcd',
    }),
  );
  assert.equal(put.status, 200);
  assert.deepEqual((await put.json()) as unknown, {
    received_bytes: 4,
    complete: true,
    check: ACCEPTED_CHECK,
  });

  const finalize = await t.http(
    sessionPost('/files/finalize/intent-1', t.owner.cookie, t.owner.csrf, {
      upload_id: 'up-1',
      bytes_digest: 'sha256:deadbeef',
    }),
  );
  assert.equal(finalize.status, 200);
  // The route answers the finalized file REFERENCE (the kernel's
  // `result.file`), not the full immutable record.
  assert.deepEqual((await finalize.json()) as unknown, { file: 'file-1' });

  const invented = await t.http(
    sessionPost('/files/finalize/intent-invented', t.owner.cookie, t.owner.csrf, {
      upload_id: 'up-9',
      bytes_digest: 'sha256:deadbeef',
    }),
  );
  const err = await httpErrorOf(invented);
  assert.equal(err.status, 404);
  assert.equal(err.code, 'not_found');
});

/* ------------------------------------------------------------------ */
/* Ingress journey.                                                    */
/* ------------------------------------------------------------------ */

// B2 evidence: verified envelope journeys to a 200 receipt with an
// actor-null sink context; unverified delivery 401s with the sink untouched.
test('B2 ingress: verified envelope sinks with actor-null context; unverified 401s', async () => {
  const t = await setup();
  const ok = await t.http(
    testRequest('/ingress/acme-billing', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': 'valid' },
      body: JSON.stringify({ type: 'charge.succeeded', amount: 100 }),
    }),
  );
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()) as unknown, {
    accepted: true,
    producer_event_id: 'evt-1',
  });
  assert.equal(t.sink.calls.length, 1);
  const sunk = t.sink.calls[0];
  assert.ok(sunk);
  assert.equal((sunk.context as { actor: unknown }).actor, null);

  const sinkCallsBefore = t.sink.calls.length;
  const bad = await t.http(
    testRequest('/ingress/dead-ns', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': 'bogus' },
      body: JSON.stringify({ type: 'charge.succeeded', amount: 100 }),
    }),
  );
  const err = await httpErrorOf(bad);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'forbidden');
  assert.equal(t.sink.calls.length, sinkCallsBefore);
});

/* ------------------------------------------------------------------ */
/* Cross-user isolation.                                               */
/* ------------------------------------------------------------------ */

// B2 evidence: user B's session cannot select team T1 (403), and B's grant
// for their own team cannot call a T1-scoped op (team-scoped canCall ->
// isError forbidden); B's own invocations still carry B's identity.
test('B2 isolation: user B cannot select or act on team T1', async () => {
  const t = await setup({
    permissions: {
      canDiscover: () => true,
      canCall: (identity, operation) =>
        operation !== MUT_OP || identity.team?.team_id === t.team1,
    },
  });
  const select = await t.http(
    sessionPost('/auth/select-team', t.userB.cookie, t.userB.csrf, { team: t.team1 }),
  );
  assert.equal(select.status, 403);

  const { body } = await mcpCall(
    t.mcp,
    'tools/call',
    { name: MUT_OP, arguments: { operation_id: freshOperationId(), qty: 1 } },
    { grant: t.userB.grant },
  );
  const result = toolResult(body);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.['code'], 'forbidden');
  assert.equal(t.invoker.mutations.length, 0);

  // Control: B's grant still drives B's own team-scoped reads (identity
  // binding intact — B acts as B, never as T1).
  const own = await mcpCall(
    t.mcp,
    'tools/call',
    { name: READ_OP, arguments: { filter: 'open' } },
    { grant: t.userB.grant },
  );
  assert.equal(toolResult(own.body).isError, undefined);
  assert.equal(t.invoker.reads[0]?.identity.team?.team_id, t.team2);
  assert.equal(t.invoker.reads[0]?.identity.actor?.user_id, t.userB.userId);
});
