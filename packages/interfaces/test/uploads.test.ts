/**
 * S6 upload-transport tests: principals, auth matrix, usesFiles gating,
 * intent/content/finalize routing with kernel-outcome mapping, and
 * `createHttpHandler` mounting. Real identity fixture via
 * `createTestUploadDeps`, scripted `createFakeKernel`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IdentityError,
  deriveCsrfToken,
  issueMcpGrant,
  resolveIdentity,
  revokeMcpGrantByToken,
} from '@canlang/identity';
import type { ContentCheck, ResolvedIdentity, UploadIntentGrant } from '@canlang/contracts';
import type {
  HttpDeps,
  KernelAppendOutcome,
  KernelCompleteOutcome,
  KernelFinalizeOutcome,
} from '../src/ports.js';
import { systemInterfacesClock } from '../src/ports.js';
import { handleUploadRequest } from '../src/uploads/routes.js';
import { bindingForIntent, receiverFromIdentity } from '../src/uploads/principals.js';
import { createHttpHandler } from '../src/http/routes.js';
import {
  createFakeBindings,
  createFakeCatalog,
  createFakeInvoker,
  createFakeKernel,
  createFakeRegistry,
  createFakeSink,
  createFakeVerifier,
  createGrantFixture,
  createMemoryRateLimiter,
  createTestApp,
  createTestIdentityDeps,
  createTestUploadDeps,
  testRequest,
} from '../src/testing.js';

type KernelOpts = Parameters<typeof createFakeKernel>[0];
type Setup = Awaited<ReturnType<typeof setup>>;

async function setup(kernelOpts: KernelOpts = {}) {
  const t = await createTestUploadDeps({ kernel: kernelOpts });
  const csrf = await deriveCsrfToken(t.identity.sessionToken);
  const { token: grant } = await createGrantFixture(t.identity);
  return { ...t, csrf, grant };
}

function intentBody(): Record<string, unknown> {
  return {
    upload_id: 'up-1',
    operation: 'shop.Order.create',
    field: '/attachment',
    arguments: {},
    name: 'a.pdf',
    type: 'application/pdf',
    size: '4',
  };
}

function grantFor(intentId: string): UploadIntentGrant {
  return {
    intent_id: intentId,
    content: `https://test.invalid/files/content/${intentId}`,
    finalize: `https://test.invalid/files/finalize/${intentId}`,
    expires_at: '2026-10-04T16:00:00.000Z',
  };
}

function sessionIntent(t: Setup, body: unknown): Request {
  return testRequest('/files/intents', {
    method: 'POST',
    cookie: t.identity.cookie,
    headers: { 'content-type': 'application/json', 'x-csrf-token': t.csrf },
    body: JSON.stringify(body),
  });
}

function bearerIntent(grant: string, body: unknown): Request {
  return testRequest('/files/intents', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${grant}` },
    body: JSON.stringify(body),
  });
}

function sessionPut(
  t: Setup,
  path: string,
  init: { body?: RequestInit['body']; headers?: Record<string, string>; duplex?: 'half' } = {},
): Request {
  return testRequest(path, {
    method: 'PUT',
    cookie: t.identity.cookie,
    headers: { 'x-csrf-token': t.csrf, ...init.headers },
    ...(init.body === undefined ? {} : { body: init.body }),
    ...(init.duplex === undefined ? {} : { duplex: init.duplex }),
  });
}

function sessionPost(t: Setup, path: string, body: unknown): Request {
  return testRequest(path, {
    method: 'POST',
    cookie: t.identity.cookie,
    headers: { 'content-type': 'application/json', 'x-csrf-token': t.csrf },
    body: JSON.stringify(body),
  });
}

async function errorOf(res: Response): Promise<{ status: number; code: string; message: string }> {
  const body = (await res.json()) as { code: string; message: string };
  return { status: res.status, code: body.code, message: body.message };
}

function grantedKernel(intentId: string): KernelOpts {
  const grant = grantFor(intentId);
  return { createIntent: () => ({ status: 'granted', grant, intentId }) };
}

function callDetail(t: Setup, index: number): { method: string; detail: Record<string, unknown> } {
  assert.ok(t.kernel.calls.length > index, 'expected kernel call');
  const call = t.kernel.calls[index];
  assert.ok(call);
  return { method: call.method, detail: call.detail as Record<string, unknown> };
}

/* ------------------------------------------------------------------ */
/* Principals.                                                         */
/* ------------------------------------------------------------------ */

function resolvedIdentity(overrides: Partial<ResolvedIdentity> & { actor: ResolvedIdentity['actor'] }): ResolvedIdentity {
  return {
    team: null,
    membership: null,
    binding: { kind: 'session', session_id: 's-1' },
    admitted_at: '2026-10-04T15:00:00.000Z',
    ...overrides,
  };
}

test('receiverFromIdentity binds team-app provenance', () => {
  const receiver = receiverFromIdentity(
    'app-1',
    resolvedIdentity({
      actor: { user_id: 'u-1', email: 'a@x.invalid', email_verified: true },
      team: { team_id: 't-1', timezone: 'UTC', created_at: '2026-10-04T15:00:00.000Z' },
    }),
  );
  assert.deepEqual(receiver, { app: 'app-1', team: 't-1', owner: 't-1', principal: 'u-1' });
});

test('receiverFromIdentity falls back to the user id without a team', () => {
  const receiver = receiverFromIdentity(
    'app-1',
    resolvedIdentity({
      actor: { user_id: 'u-1', email: 'a@x.invalid', email_verified: true },
    }),
  );
  assert.deepEqual(receiver, { app: 'app-1', team: 'u-1', owner: 'u-1', principal: 'u-1' });
});

test('receiverFromIdentity rejects public identities as forbidden', () => {
  try {
    receiverFromIdentity('app-1', resolvedIdentity({ actor: null }));
    assert.fail('expected IdentityError');
  } catch (err) {
    assert.ok(err instanceof IdentityError);
    assert.equal(err.code, 'forbidden');
  }
});

test('bindingForIntent tags bridge-v1 with the retry id and field', () => {
  const binding = bindingForIntent({
    upload_id: 'up-9',
    operation: 'shop.Order.create',
    field: '/attachment',
    arguments: {},
    name: 'a.pdf',
    type: 'application/pdf',
    size: '4',
  });
  assert.deepEqual(binding, { adapter: 'bridge-v1', deliveryId: 'up-9', resultPath: '/attachment' });
});

/* ------------------------------------------------------------------ */
/* Auth matrix (POST /files/intents) + spot-checks.                    */
/* ------------------------------------------------------------------ */

test('auth: session + CSRF reaches the kernel and returns the grant verbatim', async () => {
  const grant = grantFor('intent-1');
  const t = await setup(grantedKernel('intent-1'));
  const res = await handleUploadRequest(t.deps, sessionIntent(t, intentBody()));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as unknown, grant);
});

test('auth: bearer grant reaches the kernel with no CSRF', async () => {
  const grant = grantFor('intent-2');
  const t = await setup(grantedKernel('intent-2'));
  const res = await handleUploadRequest(t.deps, bearerIntent(t.grant, intentBody()));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as unknown, grant);
});

test('auth: missing credential is 401 forbidden and never touches the kernel', async () => {
  const t = await setup();
  const res = await handleUploadRequest(
    t.deps,
    testRequest('/files/intents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(intentBody()),
    }),
  );
  assert.deepEqual(await errorOf(res), {
    status: 401,
    code: 'forbidden',
    message: 'Authentication required.',
  });
  assert.equal(
    res.headers.get('www-authenticate'),
    'Bearer resource_metadata="https://test.invalid/.well-known/oauth-protected-resource"',
  );
  assert.equal(t.kernel.calls.length, 0);
});

test('auth: bad CSRF is 403 forbidden and never touches the kernel', async () => {
  const t = await setup();
  const res = await handleUploadRequest(
    t.deps,
    testRequest('/files/intents', {
      method: 'POST',
      cookie: t.identity.cookie,
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'stale-token' },
      body: JSON.stringify(intentBody()),
    }),
  );
  const err = await errorOf(res);
  assert.equal(err.status, 403);
  assert.equal(err.code, 'forbidden');
  assert.equal(t.kernel.calls.length, 0);
});

test('auth: revoked grant is 401', async () => {
  const t = await setup(grantedKernel('intent-3'));
  await revokeMcpGrantByToken(t.deps.identity.store, { token: t.grant });
  const res = await handleUploadRequest(t.deps, bearerIntent(t.grant, intentBody()));
  const err = await errorOf(res);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'forbidden');
  assert.equal(t.kernel.calls.length, 0);
});

test('auth: invalid bearer never falls through to a valid session', async () => {
  const t = await setup();
  const res = await handleUploadRequest(
    t.deps,
    testRequest('/files/intents', {
      method: 'POST',
      cookie: t.identity.cookie,
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': t.csrf,
        authorization: 'Bearer not-a-real-grant',
      },
      body: JSON.stringify(intentBody()),
    }),
  );
  const err = await errorOf(res);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'forbidden');
  assert.equal(t.kernel.calls.length, 0);
});

test('auth: malformed Authorization falls through to the session path', async () => {
  const t = await setup(grantedKernel('intent-4'));
  const res = await handleUploadRequest(
    t.deps,
    testRequest('/files/intents', {
      method: 'POST',
      cookie: t.identity.cookie,
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': t.csrf,
        authorization: 'Basic xyz',
      },
      body: JSON.stringify(intentBody()),
    }),
  );
  assert.equal(res.status, 200);
});

test('auth spot-check: content and finalize without credentials are 401', async () => {
  const t = await setup();
  for (const req of [
    testRequest('/files/content/intent-1', { method: 'PUT', body: 'ab' }),
    testRequest('/files/finalize/intent-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upload_id: 'up-1', bytes_digest: 'sha256:x' }),
    }),
  ]) {
    const res = await handleUploadRequest(t.deps, req);
    const err = await errorOf(res);
    assert.equal(err.status, 401, req.url);
    assert.equal(err.code, 'forbidden', req.url);
  }
  assert.equal(t.kernel.calls.length, 0);
});

test('auth: PUT content with bad CSRF is 403 and never touches the kernel', async () => {
  const t = await setup();
  const res = await handleUploadRequest(
    t.deps,
    testRequest('/files/content/intent-1', {
      method: 'PUT',
      cookie: t.identity.cookie,
      headers: { 'x-csrf-token': 'wrong-token' },
      body: 'ab',
    }),
  );
  const err = await errorOf(res);
  assert.equal(err.status, 403);
  assert.equal(err.code, 'forbidden');
  assert.equal(t.kernel.calls.length, 0);
});

test('auth: valid grant wins over the session cookie with no CSRF', async () => {
  const t = await setup(grantedKernel('intent-5'));
  const res = await handleUploadRequest(
    t.deps,
    testRequest('/files/intents', {
      method: 'POST',
      cookie: t.identity.cookie,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t.grant}` },
      body: JSON.stringify(intentBody()),
    }),
  );
  assert.equal(res.status, 200);
});

test('auth: session token presented as a grant Bearer [REDACTED] 401', async () => {
  const t = await setup();
  const res = await handleUploadRequest(t.deps, bearerIntent(t.identity.sessionToken, intentBody()));
  const err = await errorOf(res);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'forbidden');
  assert.equal(t.kernel.calls.length, 0);
});

test('auth: expired grant is 401', async () => {
  const t = await setup();
  const { token } = await issueMcpGrant(
    t.deps.identity.store,
    { user_id: t.identity.userId, team_id: t.identity.teamId, client_id: 'expired' },
    { ttlMs: -1000 },
  );
  const res = await handleUploadRequest(t.deps, bearerIntent(token, intentBody()));
  const err = await errorOf(res);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'forbidden');
  assert.equal(t.kernel.calls.length, 0);
});

test('auth: session path passes the receiver from the cookie identity', async () => {
  const t = await setup(grantedKernel('intent-6'));
  const resolved = await resolveIdentity(t.deps.identity.store, { session_token: t.identity.sessionToken });
  const res = await handleUploadRequest(t.deps, sessionIntent(t, intentBody()));
  assert.equal(res.status, 200);
  const call = callDetail(t, 0);
  assert.equal(call.method, 'createIntent');
  const input = call.detail as { receiver: Record<string, unknown> };
  assert.equal(input.receiver['principal'], t.identity.userId);
  assert.equal(input.receiver['team'], resolved.team?.team_id ?? t.identity.userId);
});

test('content: garbage content-length falls through to the streaming cap', async () => {
  const t = await setup({
    maxBytes: 8,
    append: () => ({ status: 'appended', receivedBytes: 2 }),
    complete: () => ({ status: 'failed', reason: 'partial' }),
  });
  const res = await handleUploadRequest(
    t.deps,
    sessionPut(t, '/files/content/intent-1', { body: 'ab', headers: { 'content-length': 'not-a-number' } }),
  );
  assert.equal(res.status, 200);
  assert.equal(t.kernel.calls.length, 2);
});

test('intent rejects a non-JSON content type', async () => {
  const t = await setup();
  const res = await handleUploadRequest(
    t.deps,
    testRequest('/files/intents', {
      method: 'POST',
      cookie: t.identity.cookie,
      headers: { 'content-type': 'text/plain', 'x-csrf-token': t.csrf },
      body: JSON.stringify(intentBody()),
    }),
  );
  const err = await errorOf(res);
  assert.equal(err.code, 'validation');
  assert.equal(t.kernel.calls.length, 0);
});

/* ------------------------------------------------------------------ */
/* usesFiles gate.                                                     */
/* ------------------------------------------------------------------ */

test('usesFiles=false answers not_found on all three routes before auth', async () => {
  const t = await createTestUploadDeps({ usesFiles: false });
  const reqs = [
    testRequest('/files/intents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(intentBody()),
    }),
    testRequest('/files/content/intent-1', { method: 'PUT', body: 'ab' }),
    testRequest('/files/finalize/intent-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upload_id: 'up-1', bytes_digest: 'sha256:x' }),
    }),
  ];
  for (const req of reqs) {
    const res = await handleUploadRequest(t.deps, req);
    assert.deepEqual(await errorOf(res), {
      status: 404,
      code: 'not_found',
      message: 'Uploads unavailable.',
    }, req.url);
  }
  assert.equal(t.kernel.calls.length, 0);
});

/* ------------------------------------------------------------------ */
/* Receiver/binding from the kernel call log.                          */
/* ------------------------------------------------------------------ */

test('intent passes the team receiver and bridge binding', async () => {
  const t = await setup(grantedKernel('intent-7'));
  const res = await handleUploadRequest(t.deps, bearerIntent(t.grant, intentBody()));
  assert.equal(res.status, 200);
  assert.equal(t.kernel.calls.length, 1);
  const call = callDetail(t, 0);
  assert.equal(call.method, 'createIntent');
  assert.deepEqual(call.detail['receiver'], {
    app: 'test-app',
    team: t.identity.teamId,
    owner: t.identity.teamId,
    principal: t.identity.userId,
  });
  assert.deepEqual(call.detail['binding'], {
    adapter: 'bridge-v1',
    deliveryId: 'up-1',
    resultPath: '/attachment',
  });
  assert.deepEqual(call.detail['request'], intentBody());
});

test('intent falls back to the user id for a team-less grant', async () => {
  const t = await setup(grantedKernel('intent-8'));
  const issued = await issueMcpGrant(
    t.deps.identity.store,
    { user_id: t.identity.userId, team_id: null, client_id: 'teamless' },
    {},
  );
  const res = await handleUploadRequest(t.deps, bearerIntent(issued.token, intentBody()));
  assert.equal(res.status, 200);
  const call = callDetail(t, 0);
  assert.equal(call.method, 'createIntent');
  assert.deepEqual(call.detail['receiver'], {
    app: 'test-app',
    team: t.identity.userId,
    owner: t.identity.userId,
    principal: t.identity.userId,
  });
});

/* ------------------------------------------------------------------ */
/* Intent mapping.                                                     */
/* ------------------------------------------------------------------ */

test('intent duplicate returns the stored grant', async () => {
  const grant = grantFor('intent-9');
  const t = await setup({
    createIntent: () => ({ status: 'duplicate', grant, intentId: 'intent-9' }),
  });
  const res = await handleUploadRequest(t.deps, sessionIntent(t, intentBody()));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as unknown, grant);
});

test('intent maps all four kernel rejections', async () => {
  const cases = [
    { reason: 'invalid-request', status: 400, code: 'validation' },
    { reason: 'conflict', status: 409, code: 'conflict' },
    { reason: 'oversized', status: 429, code: 'limit' },
    { reason: 'unauthorized', status: 403, code: 'forbidden' },
  ] as const;
  for (const c of cases) {
    const t = await setup({ createIntent: () => ({ status: 'rejected', reason: c.reason }) });
    const res = await handleUploadRequest(t.deps, sessionIntent(t, intentBody()));
    const err = await errorOf(res);
    assert.equal(err.status, c.status, c.reason);
    assert.equal(err.code, c.code, c.reason);
  }
});

test('intent rejects non-object, malformed, and binding-less bodies', async () => {
  const t = await setup(grantedKernel('intent-10'));
  const bad: Array<{ body: string; note: string }> = [
    { body: '[1,2]', note: 'array' },
    { body: '{"upload_id":', note: 'malformed' },
    { body: JSON.stringify({ ...intentBody(), upload_id: undefined }), note: 'missing upload_id' },
    { body: JSON.stringify({ ...intentBody(), field: '' }), note: 'empty field' },
  ];
  for (const b of bad) {
    const res = await handleUploadRequest(
      t.deps,
      testRequest('/files/intents', {
        method: 'POST',
        cookie: t.identity.cookie,
        headers: { 'content-type': 'application/json', 'x-csrf-token': t.csrf },
        body: b.body,
      }),
    );
    const err = await errorOf(res);
    assert.equal(err.status, 400, b.note);
    assert.equal(err.code, 'validation', b.note);
  }
  assert.equal(t.kernel.calls.length, 0);
});

/* ------------------------------------------------------------------ */
/* Content transfer.                                                   */
/* ------------------------------------------------------------------ */

const ACCEPTED_CHECK: ContentCheck = {
  claimedType: 'application/pdf',
  detectedType: 'application/pdf',
  sizeBytes: 4,
  verdict: 'accepted',
};

test('content partial answers complete:false and stays open', async () => {
  const t = await setup({
    append: () => ({ status: 'appended', receivedBytes: 2 }),
    complete: () => ({ status: 'failed', reason: 'partial' }),
  });
  const res = await handleUploadRequest(
    t.deps,
    sessionPut(t, '/files/content/intent-1', {
      headers: { 'content-type': 'application/octet-stream' },
      body: 'ab',
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as unknown, { received_bytes: 2, complete: false });
  assert.deepEqual(
    t.kernel.calls.map((c) => c.method),
    ['append', 'complete'],
  );
});

test('content full journey appends then completes with the check', async () => {
  const t = await setup({
    append: () => ({ status: 'appended', receivedBytes: 4 }),
    complete: () => ({ status: 'completed', check: ACCEPTED_CHECK }),
  });
  const res = await handleUploadRequest(
    t.deps,
    testRequest('/files/content/intent-1', {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        authorization: `Bearer ${t.grant}`,
      },
      body: 'abcd',
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as unknown, {
    received_bytes: 4,
    complete: true,
    check: ACCEPTED_CHECK,
  });
});

test('content early-rejects an over-cap content-length without touching the kernel', async () => {
  const t = await setup({ maxBytes: 8 });
  const res = await handleUploadRequest(
    t.deps,
    sessionPut(t, '/files/content/intent-1', {
      headers: { 'content-type': 'application/octet-stream' },
      body: 'x'.repeat(100),
    }),
  );
  const err = await errorOf(res);
  assert.equal(err.status, 429);
  assert.equal(err.code, 'limit');
  assert.equal(t.kernel.calls.length, 0);
});

test('content rejects an over-cap streamed body', async () => {
  const t = await setup({ maxBytes: 8 });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(100).fill(7));
      controller.close();
    },
  });
  const res = await handleUploadRequest(
    t.deps,
    sessionPut(t, '/files/content/intent-1', {
      headers: { 'content-type': 'application/octet-stream' },
      body: stream,
      duplex: 'half',
    }),
  );
  const err = await errorOf(res);
  assert.equal(err.status, 429);
  assert.equal(err.code, 'limit');
  assert.equal(t.kernel.calls.length, 0);
});

test('content maps append failures', async () => {
  const cases: Array<{ outcome: KernelAppendOutcome; status: number; code: string }> = [
    { outcome: { status: 'failed', reason: 'foreign' }, status: 404, code: 'not_found' },
    { outcome: { status: 'failed', reason: 'closed' }, status: 422, code: 'rule_failed' },
    { outcome: { status: 'failed', reason: 'expired' }, status: 404, code: 'not_found' },
    { outcome: { status: 'failed', reason: 'oversized' }, status: 429, code: 'limit' },
  ];
  for (const c of cases) {
    const t = await setup({ append: () => c.outcome });
    const res = await handleUploadRequest(
      t.deps,
      sessionPut(t, '/files/content/intent-1', { body: 'ab' }),
    );
    const err = await errorOf(res);
    assert.equal(err.status, c.status, JSON.stringify(c.outcome));
    assert.equal(err.code, c.code, JSON.stringify(c.outcome));
    // A failed append never reaches complete.
    assert.deepEqual(
      t.kernel.calls.map((call) => call.method),
      ['append'],
    );
  }
});

test('content maps complete failures after a successful append', async () => {
  const cases: Array<{ outcome: KernelCompleteOutcome; status: number; code: string }> = [
    { outcome: { status: 'failed', reason: 'foreign' }, status: 404, code: 'not_found' },
    { outcome: { status: 'failed', reason: 'expired' }, status: 404, code: 'not_found' },
    { outcome: { status: 'failed', reason: 'closed' }, status: 422, code: 'rule_failed' },
    { outcome: { status: 'failed', reason: 'oversized' }, status: 429, code: 'limit' },
    {
      outcome: { status: 'failed', reason: 'malformed', check: ACCEPTED_CHECK },
      status: 400,
      code: 'validation',
    },
    {
      outcome: { status: 'failed', reason: 'rejected', check: ACCEPTED_CHECK },
      status: 400,
      code: 'validation',
    },
  ];
  for (const c of cases) {
    const t = await setup({
      append: () => ({ status: 'appended', receivedBytes: 4 }),
      complete: () => c.outcome,
    });
    const res = await handleUploadRequest(
      t.deps,
      sessionPut(t, '/files/content/intent-1', { body: 'abcd' }),
    );
    const err = await errorOf(res);
    assert.equal(err.status, c.status, JSON.stringify(c.outcome));
    assert.equal(err.code, c.code, JSON.stringify(c.outcome));
  }
});

test('content decodes a percent-encoded intent id', async () => {
  const t = await setup({
    append: () => ({ status: 'failed', reason: 'foreign' }),
  });
  const res = await handleUploadRequest(t.deps, sessionPut(t, '/files/content/my%20id', { body: 'a' }));
  assert.equal(res.status, 404);
  const call = callDetail(t, 0);
  assert.equal(call.method, 'append');
  assert.equal(call.detail['intentId'], 'my id');
});

/* ------------------------------------------------------------------ */
/* Finalize.                                                           */
/* ------------------------------------------------------------------ */

function finalizedOutcome(status: 'finalized' | 'repeated', ref: string): KernelFinalizeOutcome {
  return {
    status,
    result: { file: ref },
    file: {
      id: ref,
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
  };
}

function finalizeBody(): Record<string, unknown> {
  return { upload_id: 'up-1', bytes_digest: 'sha256:deadbeef' };
}

test('finalize finalized returns the file reference', async () => {
  const t = await setup({ finalize: () => finalizedOutcome('finalized', 'file-1') });
  const res = await handleUploadRequest(
    t.deps,
    testRequest('/files/finalize/intent-1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${t.grant}`,
      },
      body: JSON.stringify(finalizeBody()),
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as unknown, { file: 'file-1' });
  const call = callDetail(t, 0);
  assert.equal(call.method, 'finalize');
  assert.deepEqual(
    { intentId: call.detail['intentId'], retryId: call.detail['retryId'], bytesDigest: call.detail['bytesDigest'] },
    { intentId: 'intent-1', retryId: 'up-1', bytesDigest: 'sha256:deadbeef' },
  );
});

test('finalize repeated returns the same reference', async () => {
  const t = await setup({ finalize: () => finalizedOutcome('repeated', 'file-1') });
  const res = await handleUploadRequest(
    t.deps,
    sessionPost(t, '/files/finalize/intent-1', finalizeBody()),
  );
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as unknown, { file: 'file-1' });
});

test('finalize maps all four kernel failures', async () => {
  const cases = [
    { reason: 'foreign', status: 404, code: 'not_found' },
    { reason: 'expired', status: 404, code: 'not_found' },
    { reason: 'partial', status: 422, code: 'rule_failed' },
    { reason: 'conflict', status: 409, code: 'conflict' },
  ] as const;
  for (const c of cases) {
    const t = await setup({ finalize: () => ({ status: 'failed', reason: c.reason }) });
    const res = await handleUploadRequest(
      t.deps,
      sessionPost(t, '/files/finalize/intent-1', finalizeBody()),
    );
    const err = await errorOf(res);
    assert.equal(err.status, c.status, c.reason);
    assert.equal(err.code, c.code, c.reason);
  }
});

test('finalize of an invented intent is not_found and mints no reference', async () => {
  const t = await setup({ finalize: () => ({ status: 'failed', reason: 'foreign' }) });
  const res = await handleUploadRequest(
    t.deps,
    sessionPost(t, '/files/finalize/no-such-intent', finalizeBody()),
  );
  assert.equal(res.status, 404);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body['code'], 'not_found');
  assert.ok(!('file' in body));
});

test('finalize rejects bodies without upload_id and bytes_digest', async () => {
  const t = await setup({ finalize: () => finalizedOutcome('finalized', 'file-1') });
  const bad: Array<{ body: unknown; note: string }> = [
    { body: {}, note: 'empty object' },
    { body: { upload_id: 'up-1' }, note: 'missing bytes_digest' },
    { body: { upload_id: '', bytes_digest: 'sha256:x' }, note: 'empty upload_id' },
    { body: '[1]', note: 'array' },
  ];
  for (const b of bad) {
    const res = await handleUploadRequest(
      t.deps,
      sessionPost(t, '/files/finalize/intent-1', b.body),
    );
    const err = await errorOf(res);
    assert.equal(err.status, 400, b.note);
    assert.equal(err.code, 'validation', b.note);
  }
  assert.equal(t.kernel.calls.length, 0);
});

/* ------------------------------------------------------------------ */
/* Routing: unknown paths and wrong methods.                           */
/* ------------------------------------------------------------------ */

test('unknown upload paths and wrong methods are not_found without touching the kernel', async () => {
  const t = await setup();
  const reqs = [
    testRequest('/files/nope', { method: 'POST', body: '{}' }),
    testRequest('/files/content', { method: 'PUT', body: 'x' }),
    testRequest('/files/intents', { method: 'GET' }),
    testRequest('/files/intents', { method: 'PUT', body: 'x' }),
    testRequest('/files/intents/extra', { method: 'POST', body: '{}' }),
    testRequest('/files/content/x', { method: 'POST', body: 'x' }),
    testRequest('/files/content/x', { method: 'GET' }),
    testRequest('/files/finalize/x', { method: 'PUT', body: 'x' }),
    testRequest('/files/finalize/x', { method: 'GET' }),
    testRequest('/files/content/', { method: 'PUT', body: 'x' }),
    testRequest('/files/finalize/', { method: 'POST', body: '{}' }),
    testRequest('/files/content/a/b', { method: 'PUT', body: 'x' }),
    testRequest('/files/content/%E0%A4', { method: 'PUT', body: 'x' }),
  ];
  for (const req of reqs) {
    const res = await handleUploadRequest(t.deps, req);
    assert.equal(res.status, 404, req.url);
    const err = (await res.json()) as { code: string };
    assert.equal(err.code, 'not_found', req.url);
  }
  assert.equal(t.kernel.calls.length, 0);
});

/* ------------------------------------------------------------------ */
/* Mounting through the top-level handler.                             */
/* ------------------------------------------------------------------ */

test('POST /files/intents reaches the uploads sub-handler via createHttpHandler', async () => {
  const grant = grantFor('intent-mount');
  const t = await setup(grantedKernel('intent-mount'));
  const httpDeps: HttpDeps = {
    app: createTestApp(),
    pages: createFakeRegistry([]),
    invoker: createFakeInvoker({}),
    catalog: createFakeCatalog({}),
    limiter: createMemoryRateLimiter(),
    logger: t.logger,
    clock: systemInterfacesClock,
    identity: createTestIdentityDeps(t.identity),
    secureCookies: false,
    uploads: { files: t.deps.files, kernel: t.deps.kernel },
    ingress: { bindings: createFakeBindings([]), verifier: createFakeVerifier({}), sink: createFakeSink() },
  };
  const http = createHttpHandler(httpDeps, {
    operations: () => Promise.resolve(new Response('unused', { status: 500 })),
    auth: () => Promise.resolve(new Response('unused', { status: 500 })),
    uploads: (req) => handleUploadRequest(t.deps, req),
    ingress: () => Promise.resolve(new Response('unused', { status: 500 })),
    oauth: () => Promise.resolve(new Response('unused', { status: 500 })),
  });
  const res = await http(
    testRequest('/files/intents', {
      method: 'POST',
      cookie: t.identity.cookie,
      headers: { 'content-type': 'application/json', 'x-csrf-token': t.csrf },
      body: JSON.stringify(intentBody()),
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as unknown, grant);
  assert.equal(t.kernel.calls.length, 1);
});
