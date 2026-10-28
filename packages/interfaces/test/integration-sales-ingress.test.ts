/**
 * FP.SOURCE-MAPPINGS integration evidence: the second configured
 * versioned SalesIngress binding over the real route dispatch, with
 * committed-outcome correlation through the shared outcome sink —
 * plus billing/sales coexistence through one composite dispatch.
 *
 * Fresh assembly per test: `loadSalesIngressBinding` over an injected
 * env object (explicit deployment configuration, never guesses), the
 * real HMAC verifier, and the real sink over a memory outcome store,
 * served through `createHttpHandler` with the real ingress leg. Only
 * the non-ingress sub-handlers are never-called stubs. Requests are
 * signed with node:crypto exactly like a standard-webhooks producer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createHttpHandler } from '../src/http/routes.js';
import { createCompositeIngressVerifier, handleIngressRequest } from '../src/ingress/routes.js';
import {
  createSalesIngressVerifier,
  loadSalesIngressBinding,
} from '../src/ingress/sales.js';
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
import type { HttpDeps, IngressBinding, IngressVerifier } from '../src/ports.js';

const NOW_MS = Date.parse('2026-10-28T00:00:00.000Z');
const NAMESPACE = 'sales';
const TEAM = 'team-acme';
const OWNER = 'acme';
const OCCURRED_AT = '2026-10-27T23:59:00.000Z';

function whsec(): { encoded: string; raw: Buffer } {
  const raw = randomBytes(32);
  return { encoded: `whsec_${raw.toString('base64')}`, raw };
}

interface SalesWorld {
  readonly handle: (request: Request) => Promise<Response>;
  readonly store: IngressOutcomeStore;
  readonly keys: { current: { encoded: string; raw: Buffer }; previous?: { encoded: string; raw: Buffer } };
}

async function setup(withPrevious: boolean): Promise<SalesWorld> {
  const keys = { current: whsec(), ...(withPrevious ? { previous: whsec() } : {}) };
  const configured = loadSalesIngressBinding({
    CAN_INGRESS_SALES_NAMESPACE: NAMESPACE,
    CAN_INGRESS_SALES_TEAM: TEAM,
    CAN_INGRESS_SALES_OWNER: OWNER,
    CAN_INGRESS_SALES_KEYS: JSON.stringify(
      withPrevious
        ? { current: keys.current.encoded, previous: keys.previous!.encoded }
        : { current: keys.current.encoded },
    ),
  });
  const clock = { nowMs: () => NOW_MS };
  const logger = createRecordingLogger();
  const store = createMemoryIngressOutcomeStore();
  const verifier = createSalesIngressVerifier({
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

  const fixture = await createIdentityFixture({ email: 'sales@test.example' });
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

function salesBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    type: 'lead.created',
    producer_event_id: 'evt-1',
    occurred_at: OCCURRED_AT,
    lead: 'lead-1',
    email: 'buyer@example.test',
    source: 'web',
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

test('sales: signed delivery commits a correlated outcome', async () => {
  const { handle, store, keys } = await setup(false);
  const res = await handle(signed(NAMESPACE, salesBody(), keys.current.raw));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { accepted: true, producer_event_id: 'evt-1' });
  const record = await store.findByProducerEventId('evt-1');
  assert.ok(record);
  assert.equal(record.namespace, NAMESPACE);
  assert.equal(record.operationKind, 'lead');
  assert.match(record.requestDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(record.event, salesBody());
  assert.equal(record.committedAt, '2026-10-28T00:00:00.000Z');
});

test('sales: replay returns the original record bytes', async () => {
  const { handle, store, keys } = await setup(false);
  const first = await handle(signed(NAMESPACE, salesBody(), keys.current.raw));
  assert.equal(first.status, 200);
  const before = await store.findByProducerEventId('evt-1');
  const second = await handle(signed(NAMESPACE, salesBody(), keys.current.raw));
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { accepted: true, producer_event_id: 'evt-1' });
  assert.deepEqual(await store.findByProducerEventId('evt-1'), before);
});

test('sales: only matching committed outcomes associate', async () => {
  const { handle, store, keys } = await setup(false);
  const res = await handle(signed(NAMESPACE, salesBody(), keys.current.raw));
  assert.equal(res.status, 200);
  assert.equal(await store.findByProducerEventId('evt-other'), null);
  assert.equal(await store.findByProducerEventId(''), null);
});

test('sales: bad signatures fail closed without oracle detail', async () => {
  const { handle, keys } = await setup(false);
  const stranger = whsec();
  for (const request of [
    signed(NAMESPACE, salesBody(), stranger.raw),
    signed(
      NAMESPACE,
      salesBody(),
      keys.current.raw,
      'evt-1',
      '1793145600',
      JSON.stringify(salesBody({ email: 'mallory@example.test' })),
    ),
    signed(NAMESPACE, salesBody(), keys.current.raw, 'evt-1', '1000000000'),
  ]) {
    const res = await handle(request);
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { code: string }).code, 'forbidden');
  }
});

test('sales: wrong contract version fails closed', async () => {
  const { handle, keys } = await setup(false);
  const res = await handle(signed(NAMESPACE, salesBody({ version: 2 }), keys.current.raw));
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { code: string }).code, 'forbidden');
});

test('sales: unknown namespaces answer not_found', async () => {
  const { handle, keys } = await setup(false);
  const res = await handle(signed('billing', salesBody(), keys.current.raw));
  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as { code: string }).code, 'not_found');
});

test('sales: previous rotation key still verifies', async () => {
  const { handle, store, keys } = await setup(true);
  const res = await handle(signed(NAMESPACE, salesBody(), keys.previous!.raw));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { accepted: true, producer_event_id: 'evt-1' });
  assert.ok(await store.findByProducerEventId('evt-1'));
});

test('sales: binding loader rejects unconfigured deployments fast', async () => {
  const keys = whsec();
  const good = {
    CAN_INGRESS_SALES_NAMESPACE: NAMESPACE,
    CAN_INGRESS_SALES_TEAM: TEAM,
    CAN_INGRESS_SALES_OWNER: OWNER,
    CAN_INGRESS_SALES_KEYS: JSON.stringify({ current: keys.encoded }),
  };
  assert.equal(loadSalesIngressBinding(good).binding.adapter, 'standard-webhooks-v1-sales');
  assert.throws(() => loadSalesIngressBinding({ ...good, CAN_INGRESS_SALES_NAMESPACE: '' }), /explicit non-empty/);
  assert.throws(() => loadSalesIngressBinding({ ...good, CAN_INGRESS_SALES_KEYS: undefined }), /whsec_ publication/);
  assert.throws(
    () => loadSalesIngressBinding({ ...good, CAN_INGRESS_SALES_KEYS: '{"current":"nope"}' }),
    /whsec_ publication/,
  );
});

test('sales+billing: one composite dispatch serves both bindings with isolated outcomes', async () => {
  const billingKeys = whsec();
  const salesKeys = whsec();
  const billing = loadBillingIngressBinding({
    CAN_INGRESS_BILLING_NAMESPACE: 'billing',
    CAN_INGRESS_BILLING_TEAM: TEAM,
    CAN_INGRESS_BILLING_OWNER: OWNER,
    CAN_INGRESS_BILLING_KEYS: JSON.stringify({ current: billingKeys.encoded }),
  });
  const sales = loadSalesIngressBinding({
    CAN_INGRESS_SALES_NAMESPACE: NAMESPACE,
    CAN_INGRESS_SALES_TEAM: TEAM,
    CAN_INGRESS_SALES_OWNER: OWNER,
    CAN_INGRESS_SALES_KEYS: JSON.stringify({ current: salesKeys.encoded }),
  });
  const clock = { nowMs: () => NOW_MS };
  const logger = createRecordingLogger();
  const store = createMemoryIngressOutcomeStore();
  const byNamespace = new Map<string, IngressBinding>([
    ['billing', billing.binding],
    [NAMESPACE, sales.binding],
  ]);
  const verifier: IngressVerifier = createCompositeIngressVerifier([
    createBillingIngressVerifier({ binding: billing.binding, clock, keys: billing.keys, isCurrent: () => true }),
    createSalesIngressVerifier({ binding: sales.binding, clock, keys: sales.keys, isCurrent: () => true }),
  ]);
  const sink = createIngressOutcomeSink({ store, clock });
  const handle = (request: Request) =>
    handleIngressRequest({ bindings: { bindingFor: (namespace: string) => byNamespace.get(namespace) ?? null }, verifier, sink, logger, clock }, request);
  const billingBody = {
    version: 1, type: 'invoice.paid', producer_event_id: 'evt-billing-1', occurred_at: OCCURRED_AT,
    invoice: 'inv-1', amount: '120.00', currency: 'EUR',
  };

  const billingRes = await handle(signed('billing', billingBody, billingKeys.raw, 'evt-billing-1'));
  assert.equal(billingRes.status, 200);
  const salesRes = await handle(signed(NAMESPACE, salesBody({ producer_event_id: 'evt-sales-1' }), salesKeys.raw, 'evt-sales-1'));
  assert.equal(salesRes.status, 200);
  const billingRecord = await store.findByProducerEventId('evt-billing-1');
  assert.ok(billingRecord);
  assert.equal(billingRecord.namespace, 'billing');
  assert.equal(billingRecord.operationKind, 'charge');
  const salesRecord = await store.findByProducerEventId('evt-sales-1');
  assert.ok(salesRecord);
  assert.equal(salesRecord.namespace, NAMESPACE);
  assert.equal(salesRecord.operationKind, 'lead');

  // Cross-posts fail closed: each grammar verifies only its own route.
  const billingToSales = await handle(signed(NAMESPACE, billingBody, billingKeys.raw, 'evt-billing-1'));
  assert.equal(billingToSales.status, 401);
  const salesToBilling = await handle(
    signed('billing', salesBody({ producer_event_id: 'evt-sales-1' }), salesKeys.raw, 'evt-sales-1'),
  );
  assert.equal(salesToBilling.status, 401);
});
