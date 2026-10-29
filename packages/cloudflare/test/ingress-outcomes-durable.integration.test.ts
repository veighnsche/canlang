import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { Miniflare } from 'miniflare';
import {
  createIngressOutcomeSink,
  createBillingIngressVerifier,
  handleIngressRequest,
  loadBillingIngressBinding,
} from '@canlang/interfaces';

const NOW_MS = Date.parse('2026-10-28T00:00:00.000Z');
const NAMESPACE = 'billing';

it('persists billing outcomes across reopen with replay-stable bytes', { timeout: 120000 }, async () => {
  const runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-15',
    script: 'export default {fetch(){return new Response("ready")}}',
    d1Databases: { DB: 'ingress-outcomes' } });
  try {
    const requireNative = createRequire(import.meta.url);
    const { createD1IngressOutcomeStore } = requireNative(
      fileURLToPath(new URL('../dist/runtime/ingress-outcomes.js', import.meta.url))) as
      typeof import('../src/runtime/ingress-outcomes.js');
    const key = randomBytes(32);
    const configured = loadBillingIngressBinding({
      CAN_INGRESS_BILLING_NAMESPACE: NAMESPACE,
      CAN_INGRESS_BILLING_TEAM: 'team-acme',
      CAN_INGRESS_BILLING_OWNER: 'acme',
      CAN_INGRESS_BILLING_KEYS: JSON.stringify({ current: `whsec_${key.toString('base64')}` }),
    });
    const clock = { nowMs: () => NOW_MS };
    const logger = { log: () => {} };
    const bindings = { bindingFor: (namespace: string) => (namespace === NAMESPACE ? configured.binding : null) };
    const verifier = createBillingIngressVerifier({ binding: configured.binding, clock, keys: configured.keys, isCurrent: () => true });
    const db = await runtime.getD1Database('DB');
    const body = { version: 1, type: 'invoice.paid', producer_event_id: 'evt-1',
      occurred_at: '2026-10-27T23:59:00.000Z', invoice: 'inv-1', amount: '120.00', currency: 'EUR' };
    const signed = () => {
      const raw = JSON.stringify(body);
      const mac = createHmac('sha256', key).update(`evt-1.1793145600.${raw}`, 'utf8').digest('base64');
      return new Request(`https://billing.test/ingress/${NAMESPACE}`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'webhook-id': 'evt-1',
          'webhook-timestamp': '1793145600', 'webhook-signature': `v1,${mac}` }, body: raw });
    };

    // First delivery commits through the D1 store.
    const store = await createD1IngressOutcomeStore({ db });
    const sink = createIngressOutcomeSink({ store, clock });
    const first = await handleIngressRequest({ bindings, verifier, sink, logger, clock }, signed());
    assert.equal(first.status, 200, await first.clone().text());
    assert.deepEqual(await first.json(), { accepted: true, producer_event_id: 'evt-1' });
    const committed = await store.findByProducerEventId('evt-1');
    assert.ok(committed);
    assert.equal(committed.namespace, NAMESPACE);
    assert.equal(committed.operationKind, 'charge');
    assert.deepEqual(committed.event, body);

    // Reopen over the same D1: the outcome survives, and a replay
    // returns the original record bytes unchanged.
    const reopened = await createD1IngressOutcomeStore({ db });
    assert.deepEqual(await reopened.findByProducerEventId('evt-1'), committed);
    const replayed = await handleIngressRequest(
      { bindings, verifier, sink: createIngressOutcomeSink({ store: reopened, clock }), logger, clock }, signed());
    assert.equal(replayed.status, 200, await replayed.clone().text());
    assert.deepEqual(await reopened.findByProducerEventId('evt-1'), committed);

    // Unknown ids associate nothing.
    assert.equal(await reopened.findByProducerEventId('evt-other'), null);
    assert.equal(await reopened.findByProducerEventId(''), null);

    // Namespaces partition: the same producer id under sales commits
    // its own row without disturbing the billing outcome.
    const salesSide = await reopened.record({ ...committed, namespace: 'sales', operationKind: 'lead' });
    assert.equal(salesSide.namespace, 'sales');
    assert.equal(salesSide.operationKind, 'lead');
    assert.deepEqual(await reopened.findByProducerEventId('evt-1'), committed);
    const salesOnly = await reopened.record({ ...committed, namespace: 'sales',
      producerEventId: 'evt-s-9', operationKind: 'lead' });
    assert.deepEqual(await reopened.findByProducerEventId('evt-s-9'), salesOnly);
  } finally {
    await runtime.dispose();
  }
});
