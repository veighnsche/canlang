/**
 * FP.SOURCE-MAPPINGS integration evidence: the configured versioned
 * BillingIngress binding over the real route dispatch, with
 * committed-outcome correlation.
 *
 * Fresh assembly per test: `loadBillingIngressBinding` over an
 * injected env object (explicit deployment configuration, never
 * guesses), the real HMAC verifier, and the real sink over a memory
 * outcome store, served through `createHttpHandler` with the real
 * ingress leg. Only the non-ingress sub-handlers are never-called
 * stubs. Requests are signed with node:crypto exactly like a
 * standard-webhooks producer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createHttpHandler } from '../src/http/routes.js';
import { handleIngressRequest } from '../src/ingress/routes.js';
import {
  createBillingIngressVerifier,
  loadBillingIngressBinding,
} from '../src/ingress/billing.js';
import {
  createIngressOutcomeSink,
  createMemoryIngressOutcomeStore,
} from '../src/ingress/outcomes.js';
import type { IngressOutcomeStore } from '../src/ingress/outcomes.js';
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

const NOW_MS = Date.parse('2026-10-28T00:00:00.000Z');
const NAMESPACE = 'billing';
const TEAM = 'team-acme';
const OWNER = 'acme';
const OCCURRED_AT = '2026-10-27T23:59:00.000Z';

function whsec(): { encoded: string; raw: Buffer } {
  const raw = randomBytes(32);
  return { encoded: `whsec_${raw.toString('base64')}`, raw };
}

interface BillingWorld {
  readonly handle: (request: Request) => Promise<Response>;
  readonly store: IngressOutcomeStore;
  readonly keys: { current: { encoded: string; raw: Buffer }; previous?: { encoded: string; raw: Buffer } };
}

async function setup(withPrevious: boolean): Promise<BillingWorld> {
  const keys = { current: whsec(), ...(withPrevious ? { previous: whsec() } : {}) };
  const configured = loadBillingIngressBinding({
    CAN_INGRESS_BILLING_NAMESPACE: NAMESPACE,
    CAN_INGRESS_BILLING_TEAM: TEAM,
    CAN_INGRESS_BILLING_OWNER: OWNER,
    CAN_INGRESS_BILLING_KEYS: JSON.stringify(
      withPrevious
        ? { current: keys.current.encoded, previous: keys.previous!.encoded }
        : { current: keys.current.encoded },
    ),
  });
  const clock = { nowMs: () => NOW_MS };
  const logger = createRecordingLogger();
  const store = createMemoryIngressOutcomeStore();
  const verifier = createBillingIngressVerifier({
    binding: configured.binding,
    clock,
    keys: configured.keys,
    isCurrent: () => true,
  });
  const sink = createIngressOutcomeSink({ store, clock });
  const bindings = {
    bindingFor: (namespace: string) => (namespace === NAMESPACE ? configured.binding : null),
  };
  const ingressDeps = { bindings, verifier, sink, logger, clock };

  const fixture = await createIdentityFixture({ email: 'billing@test.example' });
  const ingressAssembly = createTestIngressDeps();
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
  const neverCalled = async (): Promise<Response> => {
    throw new Error('unexpected non-ingress sub-handler call');
  };
  const handle = createHttpHandler(deps, {
    operations: neverCalled,
    auth: neverCalled,
    uploads: neverCalled,
    ingress: (req: Request) => handleIngressRequest(ingressDeps, req),
    oauth: neverCalled,
  });
  return { handle, store, keys };
}

function billingBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    type: 'invoice.paid',
    producer_event_id: 'evt-1',
    occurred_at: OCCURRED_AT,
    invoice: 'inv-1',
    amount: '120.00',
    currency: 'EUR',
    ...overrides,
  };
}

function signed(
  namespace: string,
  body: Record<string, unknown>,
  key: Buffer,
  id = 'evt-1',
  timestamp = '1793145600',
  sendRaw?: string,
): Request {
  const raw = JSON.stringify(body);
  const mac = createHmac('sha256', key).update(`${id}.${timestamp}.${raw}`, 'utf8').digest('base64');
  return testRequest(`/ingress/${namespace}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${mac}`,
    },
    body: sendRaw ?? raw,
  });
}

test('billing: signed delivery commits a correlated outcome', async () => {
  const { handle, store, keys } = await setup(false);
  const res = await handle(signed(NAMESPACE, billingBody(), keys.current.raw));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { accepted: true, producer_event_id: 'evt-1' });
  const record = await store.findByProducerEventId('evt-1');
  assert.ok(record);
  assert.equal(record.namespace, NAMESPACE);
  assert.equal(record.operationKind, 'charge');
  assert.match(record.requestDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(record.event, billingBody());
  assert.equal(record.committedAt, '2026-10-28T00:00:00.000Z');
});

test('billing: replay returns the original record bytes', async () => {
  const { handle, store, keys } = await setup(false);
  const first = await handle(signed(NAMESPACE, billingBody(), keys.current.raw));
  assert.equal(first.status, 200);
  const before = await store.findByProducerEventId('evt-1');
  const second = await handle(signed(NAMESPACE, billingBody(), keys.current.raw));
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { accepted: true, producer_event_id: 'evt-1' });
  assert.deepEqual(await store.findByProducerEventId('evt-1'), before);
});

test('billing: only matching committed outcomes associate', async () => {
  const { handle, store, keys } = await setup(false);
  const res = await handle(signed(NAMESPACE, billingBody(), keys.current.raw));
  assert.equal(res.status, 200);
  assert.equal(await store.findByProducerEventId('evt-other'), null);
  assert.equal(await store.findByProducerEventId(''), null);
});

test('billing: bad signatures fail closed without oracle detail', async () => {
  const { handle, keys } = await setup(false);
  const stranger = whsec();
  for (const request of [
    signed(NAMESPACE, billingBody(), stranger.raw),
    signed(
      NAMESPACE,
      billingBody(),
      keys.current.raw,
      'evt-1',
      '1793145600',
      JSON.stringify(billingBody({ amount: '999.00' })),
    ),
    signed(NAMESPACE, billingBody(), keys.current.raw, 'evt-1', '1000000000'),
  ]) {
    const res = await handle(request);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, 'forbidden');
  }
});

test('billing: wrong contract version fails closed', async () => {
  const { handle, keys } = await setup(false);
  const res = await handle(signed(NAMESPACE, billingBody({ version: 2 }), keys.current.raw));
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { code: string }).code, 'forbidden');
});

test('billing: unknown namespaces answer not_found', async () => {
  const { handle, keys } = await setup(false);
  const res = await handle(signed('sales', billingBody(), keys.current.raw));
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { code: string }).code, 'not_found');
});

test('billing: previous rotation key still verifies', async () => {
  const { handle, store, keys } = await setup(true);
  const res = await handle(signed(NAMESPACE, billingBody(), keys.previous!.raw));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { accepted: true, producer_event_id: 'evt-1' });
  assert.ok(await store.findByProducerEventId('evt-1'));
});

test('billing: binding loader rejects unconfigured deployments fast', async () => {
  const keys = whsec();
  const good = {
    CAN_INGRESS_BILLING_NAMESPACE: NAMESPACE,
    CAN_INGRESS_BILLING_TEAM: TEAM,
    CAN_INGRESS_BILLING_OWNER: OWNER,
    CAN_INGRESS_BILLING_KEYS: JSON.stringify({ current: keys.encoded }),
  };
  assert.equal(loadBillingIngressBinding(good).binding.adapter, 'standard-webhooks-v1-billing');
  assert.throws(() => loadBillingIngressBinding({ ...good, CAN_INGRESS_BILLING_NAMESPACE: '' }), /explicit non-empty/);
  assert.throws(() => loadBillingIngressBinding({ ...good, CAN_INGRESS_BILLING_KEYS: undefined }), /whsec_ publication/);
  assert.throws(
    () => loadBillingIngressBinding({ ...good, CAN_INGRESS_BILLING_KEYS: '{"current":"nope"}' }),
    /whsec_ publication/,
  );
});
