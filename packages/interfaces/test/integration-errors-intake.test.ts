/**
 * FP.INSTRUMENTATION integration evidence: ErrorsV1 intake over the real
 * route dispatch.
 *
 * Fresh assembly per test: a fully-built `createHttpHandler` (real route
 * dispatch; only the required non-intake sub-handlers are never-called
 * stubs) with the intake leg injected as the delivery join does —
 * `(req) => handleIntakeRequest(deps, bindings, sink, req)` — over a
 * fixed clock, a memory limiter, and a recording sink double. The sink
 * double is the D-owned durable queue seam: 202 means it accepted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpHandler } from '../src/http/routes.js';
import { handleIntakeRequest } from '../src/instrumentation/intake.js';
import type { AdmittedReport, IntakeBinding, IntakeSink } from '../src/instrumentation/intake.js';
import {
  createFakeCatalog,
  createFakeFileUseInfo,
  createFakeInvoker,
  createFakeKernel,
  createFakeRegistry,
  createIdentityFixture,
  createMemoryRateLimiter,
  createRecordingLogger,
  createTestApp,
  createTestIdentityDeps,
  createTestIngressDeps,
  testRequest,
} from '../src/testing.js';
import type { HttpDeps } from '../src/ports.js';

const LIVE_KEY = 'key-live-1';
const FIXED_NOW_MS = Date.parse('2026-10-28T00:00:00.000Z');
const OCCURRED_AT = '2026-10-27T23:59:00.000Z';

function liveBinding(): IntakeBinding {
  return { projectId: 'proj-1', environments: ['production'], releases: ['r1'] };
}

interface IntakeWorld {
  readonly handle: (request: Request) => Promise<Response>;
  readonly sink: IntakeSink & { stored: AdmittedReport[]; failNext: Error | null };
}

async function setup(opts: { mounted: boolean } = { mounted: true }): Promise<IntakeWorld> {
  const fixture = await createIdentityFixture({ email: 'intake@test.example' });
  const ingressAssembly = createTestIngressDeps();
  const logger = createRecordingLogger();
  const clock = { nowMs: () => FIXED_NOW_MS };
  const deps: HttpDeps = {
    app: createTestApp(),
    pages: createFakeRegistry([]),
    invoker: createFakeInvoker({}),
    catalog: createFakeCatalog({}),
    limiter: createMemoryRateLimiter(),
    logger,
    clock,
    identity: createTestIdentityDeps(fixture),
    secureCookies: false,
    uploads: {
      files: createFakeFileUseInfo(true),
      kernel: createFakeKernel({}),
    },
    ingress: {
      bindings: ingressAssembly.deps.bindings,
      verifier: ingressAssembly.deps.verifier,
      sink: ingressAssembly.deps.sink,
    },
  };
  const sink: IntakeSink & { stored: AdmittedReport[]; failNext: Error | null } = {
    stored: [],
    failNext: null,
    async store(report: AdmittedReport) {
      if (this.failNext !== null) {
        const failure = this.failNext;
        this.failNext = null;
        throw failure;
      }
      this.stored.push(report);
      return { reference: `ref-${this.stored.length}` };
    },
  };
  const bindings = {
    resolveKey: (key: string): IntakeBinding | null => (key === LIVE_KEY ? liveBinding() : null),
  };
  const neverCalled = async (): Promise<Response> => {
    throw new Error('unexpected non-intake sub-handler call');
  };
  const handle = createHttpHandler(deps, {
    operations: neverCalled,
    auth: neverCalled,
    uploads: neverCalled,
    ingress: neverCalled,
    oauth: neverCalled,
    ...(opts.mounted ? { intake: (req: Request) => handleIntakeRequest(deps, bindings, sink, req) } : {}),
  });
  return { handle, sink };
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'evt-1',
    occurred_at: OCCURRED_AT,
    message: 'boom',
    ...overrides,
  };
}

function postIntake(key: string, body: unknown): Request {
  return testRequest(`/errors/${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function readCode(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

test('intake: minimal valid report answers 202 with the sink reference', async () => {
  const { handle, sink } = await setup();
  const res = await handle(postIntake(LIVE_KEY, validBody()));
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { reference: 'ref-1' });
  assert.equal(sink.stored.length, 1);
  assert.deepEqual(sink.stored[0], {
    projectId: 'proj-1',
    id: 'evt-1',
    occurredAt: OCCURRED_AT,
    message: 'boom',
  });
});

test('intake: full optional fields are admitted when allowed', async () => {
  const { handle, sink } = await setup();
  const res = await handle(
    postIntake(
      LIVE_KEY,
      validBody({ stack: 'at f', environment: 'production', release: 'r1', fingerprint: 'fp-1' }),
    ),
  );
  assert.equal(res.status, 202);
  assert.deepEqual(sink.stored[0], {
    projectId: 'proj-1',
    id: 'evt-1',
    occurredAt: OCCURRED_AT,
    message: 'boom',
    stack: 'at f',
    environment: 'production',
    release: 'r1',
    fingerprint: 'fp-1',
  });
});

test('intake: unknown keys answer uniform forbidden and store nothing', async () => {
  const { handle, sink } = await setup();
  const first = await readCode(await handle(postIntake('key-nope-a', validBody())));
  const second = await readCode(await handle(postIntake('key-nope-b', validBody())));
  assert.equal(first.status, 403);
  assert.equal(first.body['code'], 'forbidden');
  assert.deepEqual(second, first);
  assert.equal(sink.stored.length, 0);
});

test('intake: method mismatch and bad key shapes answer not_found', async () => {
  const { handle, sink } = await setup();
  const get = await readCode(await handle(testRequest(`/errors/${LIVE_KEY}`, { method: 'GET' })));
  assert.equal(get.status, 404);
  assert.equal(get.body['code'], 'not_found');
  const empty = await readCode(await handle(postIntake('', validBody())));
  assert.equal(empty.status, 404);
  assert.equal(empty.body['code'], 'not_found');
  const nested = await readCode(await handle(testRequest('/errors/a/b', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validBody()),
  })));
  assert.equal(nested.status, 404);
  assert.equal(nested.body['code'], 'not_found');
  assert.equal(sink.stored.length, 0);
});

test('intake: oversize body answers limit', async () => {
  const { handle, sink } = await setup();
  const big = await readCode(await handle(postIntake(LIVE_KEY, validBody({ message: 'x'.repeat(300_000) }))));
  assert.equal(big.status, 429);
  assert.equal(big.body['code'], 'limit');
  assert.equal(sink.stored.length, 0);
});

test('intake: malformed and non-object bodies answer validation', async () => {
  const { handle, sink } = await setup();
  const malformed = await readCode(await handle(postIntake(LIVE_KEY, '{nope')));
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body['code'], 'validation');
  const array = await readCode(await handle(postIntake(LIVE_KEY, [1, 2])));
  assert.equal(array.status, 400);
  assert.equal(array.body['code'], 'validation');
  assert.equal(sink.stored.length, 0);
});

test('intake: unknown versions answer validation', async () => {
  const { handle, sink } = await setup();
  for (const version of [2, '1', undefined]) {
    const body = validBody();
    if (version === undefined) delete body['version'];
    else body['version'] = version;
    const res = await readCode(await handle(postIntake(LIVE_KEY, body)));
    assert.equal(res.status, 400);
    assert.equal(res.body['code'], 'validation');
  }
  assert.equal(sink.stored.length, 0);
});

test('intake: nominating members fail closed as validation', async () => {
  const { handle, sink } = await setup();
  for (const member of ['project', 'quota', 'health', 'viewer']) {
    const res = await readCode(await handle(postIntake(LIVE_KEY, validBody({ [member]: 'x' }))));
    assert.equal(res.status, 400);
    assert.equal(res.body['code'], 'validation');
  }
  assert.equal(sink.stored.length, 0);
});

test('intake: out-of-bound message, environment, release, and stack fail', async () => {
  const { handle, sink } = await setup();
  const cases: Array<Record<string, unknown>> = [
    validBody({ message: '' }),
    validBody({ message: 'x'.repeat(4_097) }),
    validBody({ environment: '' }),
    validBody({ environment: 'staging' }),
    validBody({ release: 'r2' }),
    validBody({ stack: 'x'.repeat(32_001) }),
    validBody({ fingerprint: '' }),
  ];
  for (const body of cases) {
    const res = await readCode(await handle(postIntake(LIVE_KEY, body)));
    assert.equal(res.status, 400);
    assert.equal(res.body['code'], 'validation');
  }
  assert.equal(sink.stored.length, 0);
});

test('intake: bad occurred_at values answer validation', async () => {
  const { handle, sink } = await setup();
  const cases = [
    'not-a-time',
    new Date(FIXED_NOW_MS + 300_001).toISOString(),
    new Date(FIXED_NOW_MS - 7 * 86_400_000 - 1).toISOString(),
  ];
  for (const occurred_at of cases) {
    const res = await readCode(await handle(postIntake(LIVE_KEY, validBody({ occurred_at }))));
    assert.equal(res.status, 400);
    assert.equal(res.body['code'], 'validation');
  }
  const missing = validBody();
  delete missing['occurred_at'];
  const missingRes = await readCode(await handle(postIntake(LIVE_KEY, missing)));
  assert.equal(missingRes.status, 400);
  assert.equal(missingRes.body['code'], 'validation');
  assert.equal(sink.stored.length, 0);
});

test('intake: unmounted prefix answers not_found', async () => {
  const { handle, sink } = await setup({ mounted: false });
  const res = await readCode(await handle(postIntake(LIVE_KEY, validBody())));
  assert.equal(res.status, 404);
  assert.equal(res.body['code'], 'not_found');
  assert.equal(sink.stored.length, 0);
});

test('intake: sink failure answers generic rule_failed without leaking detail', async () => {
  const { handle, sink } = await setup();
  sink.failNext = new Error('durable-queue boom secret-detail');
  const res = await readCode(await handle(postIntake(LIVE_KEY, validBody())));
  assert.equal(res.status, 422);
  assert.equal(res.body['code'], 'rule_failed');
  assert.ok(!JSON.stringify(res.body).includes('boom'));
});

test('intake: per-key throttle allows 120 then answers limit with retry-after', async () => {
  const { handle, sink } = await setup();
  const payload = JSON.stringify(validBody());
  for (let n = 0; n < 120; n++) {
    const res = await handle(
      testRequest(`/errors/${LIVE_KEY}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      }),
    );
    assert.equal(res.status, 202);
  }
  const limited = await handle(
    testRequest(`/errors/${LIVE_KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }),
  );
  assert.equal(limited.status, 429);
  const limitedBody = (await limited.json()) as Record<string, unknown>;
  assert.equal(limitedBody['code'], 'limit');
  assert.ok(limited.headers.get('retry-after') !== null);
  assert.equal(sink.stored.length, 120);
});
