/**
 * S7 provider-ingress tests: mapping unit tests, the route matrix
 * (routing, body caps, verification order, receipt semantics, failure
 * mapping), header forwarding, and `createHttpHandler` mounting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VerifiedIngressEnvelope } from '@canlang/contracts';
import type {
  DelegatedContext,
  HttpDeps,
  IngressBinding,
  IngressSink,
  IngressVerifier,
} from '../src/ports.js';
import { systemInterfacesClock } from '../src/ports.js';
import { mapVerifiedIngress } from '../src/ingress/mapping.js';
import { INGRESS_BODY_MAX_BYTES, handleIngressRequest } from '../src/ingress/routes.js';
import { createHttpHandler } from '../src/http/routes.js';
import {
  createFakeCatalog,
  createFakeFileUseInfo,
  createFakeInvoker,
  createFakeKernel,
  createFakeRegistry,
  createIdentityFixture,
  createMemoryRateLimiter,
  createTestApp,
  createTestBinding,
  createTestEnvelope,
  createTestIdentityDeps,
  createTestIngressDeps,
  testRequest,
} from '../src/testing.js';

type IngressSetup = ReturnType<typeof createTestIngressDeps>;

function ingressPost(namespace: string, init: RequestInit = {}): Request {
  return testRequest(`/ingress/${namespace}`, { method: 'POST', ...init });
}

function jsonIngress(namespace: string, body: unknown, headers: Record<string, string> = {}): Request {
  return ingressPost(namespace, {
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function errorOf(res: Response): Promise<{ status: number; code: string; message: string }> {
  const body = (await res.json()) as { code: string; message: string };
  return { status: res.status, code: body.code, message: body.message };
}

function happyDeps(): IngressSetup {
  return createTestIngressDeps({
    verify: { 'acme-billing': createTestEnvelope() },
  });
}

/** Verifier double that captures the exact headers it receives. */
function createCapturingVerifier(envelope: VerifiedIngressEnvelope): IngressVerifier & {
  calls: Array<{ binding: IngressBinding; headers: Record<string, string>; bytes: number }>;
} {
  const calls: Array<{ binding: IngressBinding; headers: Record<string, string>; bytes: number }> = [];
  return {
    calls,
    verify: (binding, input) => {
      calls.push({ binding, headers: input.headers, bytes: input.body.length });
      return Promise.resolve(envelope);
    },
  };
}

function createThrowingVerifier(error: Error): IngressVerifier {
  return {
    verify: () => Promise.reject(error),
  };
}

function createThrowingSink(error: Error): IngressSink {
  return {
    accept: () => Promise.reject(error),
  };
}

/* ------------------------------------------------------------------ */
/* Mapping unit tests.                                                 */
/* ------------------------------------------------------------------ */

test('mapVerifiedIngress builds an actor-null context from the binding', () => {
  const binding = createTestBinding({ team: 'team-9', owner: 'owner-9', namespace: 'shop-events' });
  const context = mapVerifiedIngress(binding, createTestEnvelope());
  assert.equal(context.actor, null);
  assert.equal(context.team, 'team-9');
  assert.equal(context.owner, 'owner-9');
  assert.equal(context.namespace, 'shop-events');
});

test('mapVerifiedIngress passes the verified envelope through as causation', () => {
  const envelope = createTestEnvelope({ producerEventId: 'evt-7', operationKind: 'refund' });
  const context = mapVerifiedIngress(createTestBinding(), envelope);
  assert.equal(context.causation, envelope);
});

/* ------------------------------------------------------------------ */
/* Route matrix.                                                       */
/* ------------------------------------------------------------------ */

test('happy path verifies, maps, sinks, and answers the receipt', async () => {
  const t = happyDeps();
  const res = await handleIngressRequest(t.deps, jsonIngress('acme-billing', { charge: 1 }));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as unknown, { accepted: true, producer_event_id: 'evt-1' });
  assert.equal(t.verifier.calls.length, 1);
  assert.equal(t.sink.calls.length, 1);
  const call = t.sink.calls[0];
  assert.ok(call !== undefined);
  const context = call.context as DelegatedContext;
  assert.equal(context.actor, null);
  assert.equal(context.team, 'team-1');
  assert.equal(context.owner, 'team-1');
  assert.equal(context.namespace, 'acme-billing');
  assert.deepEqual(context.causation, createTestEnvelope());
  assert.deepEqual(call.event, { charge: 1 });
  // Accepts are not logged (delivery volume).
  assert.equal(t.logger.calls.length, 0);
});

test('unknown namespace answers not_found without touching verifier or sink', async () => {
  const t = happyDeps();
  const res = await handleIngressRequest(t.deps, jsonIngress('nope', { charge: 1 }));
  assert.deepEqual(await errorOf(res), { status: 404, code: 'not_found', message: 'Not found.' });
  assert.equal(t.verifier.calls.length, 0);
  assert.equal(t.sink.calls.length, 0);
});

test('verifier null answers 401 forbidden without touching the sink', async () => {
  const t = createTestIngressDeps({ verify: { 'acme-billing': null } });
  const res = await handleIngressRequest(t.deps, jsonIngress('acme-billing', { charge: 1 }));
  const err = await errorOf(res);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'forbidden');
  assert.equal(t.verifier.calls.length, 1);
  assert.equal(t.sink.calls.length, 0);
  // Failure logged at info with routing fields only.
  const logged = t.logger.calls.filter((c) => c.level === 'info');
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.fields?.['namespace'], 'acme-billing');
});

test('envelope/binding namespace mismatch fails closed with 401', async () => {
  const t = createTestIngressDeps({
    verify: { 'acme-billing': createTestEnvelope({ namespace: 'other-ns' }) },
  });
  const res = await handleIngressRequest(t.deps, jsonIngress('acme-billing', { charge: 1 }));
  const err = await errorOf(res);
  assert.equal(err.status, 401);
  assert.equal(err.code, 'forbidden');
  assert.equal(t.sink.calls.length, 0);
  // The binding bug is journaled as an internal incident for operators.
  const internals = t.logger.calls.filter((c) => c.level === 'error');
  assert.equal(internals.length, 1);
});

test('malformed JSON answers validation without calling the verifier', async () => {
  const t = happyDeps();
  const res = await handleIngressRequest(
    t.deps,
    ingressPost('acme-billing', {
      headers: { 'content-type': 'application/json' },
      body: '{"charge":',
    }),
  );
  const err = await errorOf(res);
  assert.equal(err.status, 400);
  assert.equal(err.code, 'validation');
  assert.equal(t.verifier.calls.length, 0);
  assert.equal(t.sink.calls.length, 0);
});

test('non-object JSON answers validation', async () => {
  for (const body of ['[1,2]', '"str"', '42', 'null', '']) {
    const t = happyDeps();
    const res = await handleIngressRequest(
      t.deps,
      ingressPost('acme-billing', {
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    const err = await errorOf(res);
    assert.equal(err.status, 400);
    assert.equal(err.code, 'validation');
    assert.equal(t.verifier.calls.length, 0);
    assert.equal(t.sink.calls.length, 0);
  }
});

test('over-cap bodies answer limit', async () => {
  const t = happyDeps();
  const res = await handleIngressRequest(
    t.deps,
    ingressPost('acme-billing', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(INGRESS_BODY_MAX_BYTES) }),
    }),
  );
  const err = await errorOf(res);
  assert.equal(err.status, 429);
  assert.equal(err.code, 'limit');
  assert.equal(t.verifier.calls.length, 0);
  assert.equal(t.sink.calls.length, 0);
});

test('wrong method answers not_found, never a 405 oracle', async () => {
  const t = happyDeps();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await handleIngressRequest(
      t.deps,
      testRequest('/ingress/acme-billing', { method }),
    );
    const err = await errorOf(res);
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  }
  assert.equal(t.verifier.calls.length, 0);
  assert.equal(t.sink.calls.length, 0);
});

test('empty namespace, extra segments, and undecodable segments are not_found', async () => {
  const t = happyDeps();
  const paths = ['/ingress/', '/ingress/a/b', '/ingress/%E0%A4%A', '/ingress'];
  for (const path of paths) {
    const res = await handleIngressRequest(t.deps, testRequest(path, { method: 'POST' }));
    const err = await errorOf(res);
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
  }
  assert.equal(t.verifier.calls.length, 0);
  assert.equal(t.sink.calls.length, 0);
});

test('verifier throw answers a generic 500 and journals an incident', async () => {
  const t = happyDeps();
  const deps = { ...t.deps, verifier: createThrowingVerifier(new Error('hmac boom [SECURITY_DATA]')) };
  const res = await handleIngressRequest(deps, jsonIngress('acme-billing', { charge: 1 }));
  const err = await errorOf(res);
  assert.equal(err.status, 500);
  assert.equal(err.code, 'rule_failed');
  assert.ok(!err.message.includes('[SECURITY_DATA]'));
  assert.equal(t.sink.calls.length, 0);
  const internals = t.logger.calls.filter((c) => c.level === 'error');
  assert.equal(internals.length, 1);
  assert.ok(typeof internals[0]?.fields?.['incident_id'] === 'string');
});

test('sink decline answers 200 {accepted:false} with the envelope receipt', async () => {
  const t = createTestIngressDeps({
    verify: { 'acme-billing': createTestEnvelope() },
    accepted: false,
  });
  const res = await handleIngressRequest(t.deps, jsonIngress('acme-billing', { charge: 1 }));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as unknown, { accepted: false, producer_event_id: 'evt-1' });
  // Declines are logged (info); accepts are not.
  assert.equal(t.logger.calls.length, 1);
  assert.equal(t.logger.calls[0]?.level, 'info');
});

test('sink throw answers a generic 500 and journals an incident', async () => {
  const t = happyDeps();
  const deps = { ...t.deps, sink: createThrowingSink(new Error('kernel boom [SECURITY_DATA]')) };
  const res = await handleIngressRequest(deps, jsonIngress('acme-billing', { charge: 1 }));
  const err = await errorOf(res);
  assert.equal(err.status, 500);
  assert.equal(err.code, 'rule_failed');
  assert.ok(!err.message.includes('[SECURITY_DATA]'));
  const internals = t.logger.calls.filter((c) => c.level === 'error');
  assert.equal(internals.length, 1);
});

test('raw headers and body reach the verifier untouched', async () => {
  const envelope = createTestEnvelope();
  const verifier = createCapturingVerifier(envelope);
  const t = createTestIngressDeps({ verify: {} });
  const deps = { ...t.deps, verifier };
  const payload = { charge: 42 };
  const res = await handleIngressRequest(
    deps,
    jsonIngress('acme-billing', payload, { 'x-signature': 'sig-1', 'x-delivery': 'del-9' }),
  );
  assert.equal(res.status, 200);
  assert.equal(verifier.calls.length, 1);
  const call = verifier.calls[0];
  assert.ok(call !== undefined);
  assert.equal(call.headers['x-signature'], 'sig-1');
  assert.equal(call.headers['x-delivery'], 'del-9');
  assert.equal(call.bytes, new TextEncoder().encode(JSON.stringify(payload)).length);
});

/* ------------------------------------------------------------------ */
/* Mounting.                                                           */
/* ------------------------------------------------------------------ */

test('POST /ingress/{namespace} reaches the ingress sub-handler via createHttpHandler', async () => {
  const t = happyDeps();
  const identity = await createIdentityFixture({});
  const httpDeps: HttpDeps = {
    app: createTestApp(),
    pages: createFakeRegistry([]),
    invoker: createFakeInvoker({}),
    catalog: createFakeCatalog({}),
    limiter: createMemoryRateLimiter(),
    logger: t.logger,
    clock: systemInterfacesClock,
    identity: createTestIdentityDeps(identity),
    secureCookies: false,
    uploads: { files: createFakeFileUseInfo(false), kernel: createFakeKernel({}) },
    ingress: { bindings: t.deps.bindings, verifier: t.deps.verifier, sink: t.deps.sink },
  };
  const unused = () => Promise.resolve(new Response('unused', { status: 500 }));
  const http = createHttpHandler(httpDeps, {
    operations: unused,
    auth: unused,
    uploads: unused,
    ingress: (req) => handleIngressRequest(t.deps, req),
    oauth: unused,
  });
  const res = await http(jsonIngress('acme-billing', { charge: 3 }));
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()) as unknown, { accepted: true, producer_event_id: 'evt-1' });
  assert.equal(t.sink.calls.length, 1);
});
