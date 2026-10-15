import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import type { SystemCommandDef } from '@canlang/state/ports/system';
import { WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS } from '@canlang/work/kernel/commands';
import { stageCanonicalSend } from '@canlang/work/kernel/dispatch-staging';
import { WORK_DISPATCH_MODEL } from '@canlang/work/kernel/tables';
import { attemptDispatch } from '@canlang/work/dispatch';
import { classifyFailure } from '@canlang/work/receipt';
import { planRecoveryScan } from '@canlang/work/recovery';
import { asModel, asId, asOperationId, uuidv7, FIXED_NOW } from '@canlang/state/testing/invocation/fixtures';
import { assembleDispatchCommands } from '../worker/assembly.js';
import { loadDispatchSystemProducers, createWorkerDispatchJoinPort, withDispatchJoinPort, type FenceAttemptDispatchFn } from './invoke.js';
import { createResourceAdapter, createResourceDispatcher, resolveResourceSend, ResourceDeliveryRejected, type InstalledResourceTransport } from './resource-dispatch.js';

const definition = { runtimeBindings: [
  { owner: 'Resources', name: 'Jobs', kind: 'queue', binding: 'Resources.Jobs', type: 'text', handlers: ['Resources.consume'] },
  { owner: 'Resources', name: 'Metrics', kind: 'analytics-engine', binding: 'Resources.Metrics', schema: [{ name: 'count', type: 'int' }] },
] };

test('resource source validation preserves checked types and exact owner routing without I/O', () => {
  assert.equal(resolveResourceSend({}, 'std.EmailV1.send', {}, 'Resources.Mail'), null);
  const queue = resolveResourceSend(definition, 'Resources.Jobs.publish', { value: 'hello' }, 'Resources.Jobs');
  assert.deepEqual({ ...queue, arguments: { ...queue!.arguments } }, {
    binding: 'Resources.Jobs', from: 'Resources.Jobs', arguments: { value: 'hello' },
  });
  assert.deepEqual({ ...resolveResourceSend(definition, 'Resources.Metrics.write', { count: 3n }, 'Resources.Metrics')!.arguments }, { count: '3' });
  assert.throws(() => resolveResourceSend(definition, 'Resources.Jobs.publish', { value: 3n }, 'Resources.Jobs'));
  assert.throws(() => resolveResourceSend(definition, 'Resources.Jobs.other', { value: 'hello' }, 'Resources.Jobs'));
  assert.throws(() => resolveResourceSend(definition, 'Resources.Metrics.write', { count: 3n, foreign: true }, 'Resources.Metrics'));
});

test('resource sends commit atomically, fence authority, deliver real local queue/analytics events, retry and reconcile stable IDs', async () => {
  const receiver = `export default {
    async queue(batch, env) {
      await env.DB.exec('CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, value TEXT NOT NULL)');
      for (const message of batch.messages) {
        await env.DB.prepare('INSERT OR IGNORE INTO events(id,value) VALUES(?,?)').bind(message.body.eventId, JSON.stringify(message.body.arguments)).run();
        message.ack();
      }
    }
  };`;
  const analytics = `export default {
    async fetch(request, env) {
      await env.DB.exec('CREATE TABLE IF NOT EXISTS points(id TEXT PRIMARY KEY, value TEXT NOT NULL)');
      if(request.method==='POST') {
        const event=await request.json();
        await env.DB.prepare('INSERT OR IGNORE INTO points(id,value) VALUES(?,?)').bind(event.eventId,JSON.stringify(event.arguments)).run();
        return new Response(null,{status:204});
      }
      const row=await env.DB.prepare('SELECT value FROM points WHERE id=?').bind(new URL(request.url).searchParams.get('id')).first();
      return Response.json(row);
    }
  };`;
  const mf = new Miniflare({ compatibilityDate: '2026-07-15', workers: [
    { name: 'owner', modules: true, script: 'export default {fetch(){return new Response("owner")}}',
      d1Databases: { DB: 'owner' }, queueProducers: { OUT: 'resource-jobs' } },
    { name: 'consumer', modules: true, script: receiver, d1Databases: { DB: 'receiver' },
      queueConsumers: { 'resource-jobs': { maxBatchSize: 1, maxBatchTimeout: 0 } } },
    { name: 'analytics', modules: true, script: analytics, d1Databases: { DB: 'analytics' } },
  ] });
  try {
    const database = await mf.getD1Database('DB', 'owner') as unknown as D1Database;
    await ensureSchema(database);
    const physical = createD1Storage(database);
    const queue = await mf.getQueueProducer('OUT', 'owner');
    const sink = await mf.getWorker('analytics');
    const receivingDb = await mf.getD1Database('DB', 'consumer');
    const pointsDb = await mf.getD1Database('DB', 'analytics');
    let sequence = 0, now = FIXED_NOW, allowed = true, queueCalls = 0, analyticsCalls = 0;
    let nextQueue: 'accept' | 'reject' | 'ambiguous' = 'accept';
    const operationId = () => asOperationId(uuidv7(FIXED_NOW, ++sequence));
    const transports = new Map<string, InstalledResourceTransport>([
      ['Resources.Jobs', { kind: 'queue', async deliver(event) {
        queueCalls++;
        const retained = await physical.outboxGet(event.eventId); assert.ok(retained?.originalCommit);
        const row = await physical.load(asModel(WORK_DISPATCH_MODEL), asId(event.eventId)); assert.equal(row?.data['state'], 'claimed');
        const behavior = nextQueue; nextQueue = 'accept';
        if (behavior === 'reject') throw new ResourceDeliveryRejected('Queue not accepting before enqueue.', true);
        await queue.send(event);
        if (behavior === 'ambiguous') throw new Error('Lost acknowledgement after real enqueue.');
      }, async reconcile(eventId) {
        const row = await receivingDb.prepare('SELECT value FROM events WHERE id=?').bind(eventId).first();
        return row === null ? null : { kind: 'delivered', result: { eventId } };
      } }],
      ['Resources.Metrics', { kind: 'analytics-engine', async deliver(event) {
        analyticsCalls++;
        const response = await sink.fetch('http://analytics/event', { method: 'POST', body: JSON.stringify(event) });
        assert.equal(response.status, 204);
      } }],
    ]);
    const adapter = createResourceAdapter({ appDefinition: definition, transports });
    let dispatcher = await createResourceDispatcher({ store: physical, adapter });
    const producers = await loadDispatchSystemProducers();
    const business: SystemCommandDef = {
      name: 'resource.business', async stage(args, ctx) {
        const source = args['source'] as string, binding = args['binding'] as string;
        const request = binding === 'Foreign.Mail' ? { binding, from: 'std.EmailV1', arguments: args['value'] }
          : resolveResourceSend(definition, source, args['value'], binding)!;
        const staged = await stageCanonicalSend({ operationId: args['operationId'] as string, source,
          occurrenceIndex: 0, originOccurrence: null, request: request as unknown as Record<string, unknown> }, ctx);
        if (args['fail'] === true) throw new Error('Business operation rolled back.');
        return { ...staged.effects, result: staged.delivery.id };
      },
    };
    const registry = producers.createSystemRegistry([...assembleDispatchCommands({ l3Commands: producers.l3Commands,
      workCommands: WORK_SYSTEM_COMMANDS, stageCommands: WORK_DISPATCH_STAGE_COMMANDS }), business]);
    const joined = withDispatchJoinPort(physical, await createWorkerDispatchJoinPort(physical));
    const stage = async (source: string, binding: string, value: unknown, fail = false) => {
      const id = operationId();
      const run = await registry.run('resource.business', { source, binding, value, fail, operationId: id },
        { actor: 'resource-user', now, operation: 'Resources.submit', operationId: id }, { store: joined });
      return run.result as string;
    };
    const drive = (id: string) => dispatcher.drive({ intentId: id, actor: 'resource-user', operation: 'Resources.dispatch',
      nowMs: () => now, nextClaimId: () => `claim-${++sequence}`, maxClaimAgeMs: 100,
      claimOperationId: operationId(), recordOperationId: operationId(), classifyFailure,
      evaluateGuard: () => true, readStateSnapshot: () => null,
      fence: { owner: 'resource-owner', attemptDispatch: attemptDispatch as FenceAttemptDispatchFn, revalidateAuthority: () => allowed },
    });
    const recover = () => dispatcher.recover({ actor: 'resource-user', operation: 'Resources.recover', nowMs: () => now,
      maxClaimAgeMs: 100, policy: { maxAttempts: 3, horizonMs: 3_600_000 }, limit: 20,
      operationIdForStep: () => operationId(), planRecoveryScan, revalidateAuthority: () => allowed });
    const waitForEvent = async (id: string) => {
      for (let i = 0; i < 100; i++) {
        try { if (await receivingDb.prepare('SELECT value FROM events WHERE id=?').bind(id).first()) return; } catch { /* queue creates its table */ }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Real local queue did not deliver its committed event.');
    };
    const before = await physical.readRevision();
    await assert.rejects(stage('Resources.Jobs.publish', 'Resources.Jobs', { value: 'rollback' }, true), /rolled back/);
    assert.equal(await physical.readRevision(), before); assert.deepEqual(await physical.outboxPending(), []); assert.equal(queueCalls, 0);
    const denied = await stage('Resources.Jobs.publish', 'Resources.Jobs', { value: 'denied' });
    allowed = false; assert.equal((await drive(denied)).status, 'refused-revoked'); assert.equal(queueCalls, 0);
    allowed = true;
    const id = await stage('Resources.Jobs.publish', 'Resources.Jobs', { value: 'actual queue' });
    nextQueue = 'reject'; const rejected = await drive(id); assert.ok('state' in rejected); assert.equal(rejected.state, 'failed');
    now += 1000; await recover();
    const accepted = await drive(id); assert.ok('state' in accepted); assert.equal(accepted.state, 'delivered');
    await waitForEvent(id);
    assert.equal((await drive(id)).status, 'not-pending'); assert.equal(queueCalls, 2);
    assert.equal((await receivingDb.prepare('SELECT COUNT(*) AS n FROM events WHERE id=?').bind(id).first())?.['n'], 1);
    const uncertain = await stage('Resources.Jobs.publish', 'Resources.Jobs', { value: 'real but ambiguous' });
    nextQueue = 'ambiguous'; const lost = await drive(uncertain); assert.ok('state' in lost); assert.equal(lost.state, 'uncertain');
    await waitForEvent(uncertain);
    dispatcher = await createResourceDispatcher({ store: physical, adapter });
    const calls = queueCalls; now += 1000; await recover(); assert.equal((await drive(uncertain)).status, 'not-pending'); assert.equal(queueCalls, calls);
    const metric = await stage('Resources.Metrics.write', 'Resources.Metrics', { count: 5n });
    assert.equal(analyticsCalls, 0); const written = await drive(metric); assert.ok('state' in written); assert.equal(written.state, 'delivered');
    assert.equal((await pointsDb.prepare('SELECT value FROM points WHERE id=?').bind(metric).first())?.['value'], '{"count":"5"}');
    assert.equal((await drive(metric)).status, 'not-pending'); assert.equal(analyticsCalls, 1);
    const foreign = await stage('std.EmailV1.send', 'Foreign.Mail', { subject: 'another installed consumer' });
    await registry.run('work.dispatch.claim', { intentId: foreign, claimId: 'foreign-claim', claimedAtMs: now, maxClaimAgeMs: 100 },
      { actor: 'resource-user', now, operation: 'Foreign.dispatch', operationId: operationId() }, { store: joined });
    const foreignRow = await physical.load(asModel(WORK_DISPATCH_MODEL), asId(foreign));
    assert.equal(foreignRow?.data['state'], 'claimed');
    now += 1000;
    await recover();
    assert.deepEqual(await physical.load(asModel(WORK_DISPATCH_MODEL), asId(foreign)), foreignRow,
      'resource recovery must leave another consumer’s stale claim unchanged');
  } finally { await mf.dispose(); }
});
