/** Actual compiled source through the installed resource host and durable owners. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CompileArtifact, MutationEnvelope, StoragePort } from '@canlang/contracts';
import { createD1IdentityStore, ensureIdentitySchema, resolveIdentity } from '@canlang/identity';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { asModel, asOperationId, FIXED_NOW, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from './modules.js';
import { buildInvoker, type MutationOutcome } from '../worker/assembly.js';
import { startLocalDev, type LocalDev, type LocalDevOptions } from './native-preview.test-support.js';
import { createResourceHost, type ResourceBatch } from './resource-host.js';
import { installNativeFileInventory } from './file-inventory.js';

const APP = 'ResourceHostJourney', OWNER = 'Feature';
const COUNT = '9223372036854775807', TOTAL = '12345678901234567890.123456789012345678';
const SOURCE = `app ResourceHostJourney uses=[Feature]
app Feature
context
 queue Jobs type=Work
 analytics Metrics {count:int,total:decimal}
Given
 contract Work {label:text,count:int,total:decimal}
 Processed {label:text,count:int,total:decimal}
 policy Processed read=members
When
 scenario submit(value:Work,enabled:bool,fail:bool) by=members
  do
   send Jobs.publish {value} when=enabled as queued
   send Metrics.write {count=value.count,total=value.total} when=enabled as measured
   require not fail
 scenario consume on=Jobs
  do
   require actor==null
   require operation.source=="ingress"
   create Processed {label=event.label,count=event.count,total=event.total} as processed
Then
`;
const BRIDGE = `export default { async fetch(request, env) {
 if (new URL(request.url).pathname !== '/analytics' || request.method !== 'POST') return new Response('private');
 env.METRICS.writeDataPoint(await request.json());
 return new Response(null, {status:204});
} };`;
const BROKER = `export default { async queue(batch, env) {
 for (const message of batch.messages) {
  await env.BROKER.prepare('INSERT OR IGNORE INTO received(id,body) VALUES(?,?)').bind(message.body.eventId,JSON.stringify(message.body)).run();
  message.ack();
 }
} };`;
function committed(outcome: MutationOutcome, expected = 'committed'): void {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, expected);
  assert.equal(outcome.result.result, null);
}
async function eventually<T>(read: () => Promise<T>, accepted: (value: T) => boolean): Promise<T> {
  for (let index = 0; index < 100; index++) {
    const value = await read();
    if (accepted(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Installed local resource did not expose its committed delivery.');
}

test('compiled queue/analytics sends use the actual resource host, roll back, replay and recover intake after restart',
  { timeout: 120_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'can-resource-host-'));
    let dev: LocalDev | undefined;
    try {
      const source = join(root, 'ResourceHostJourney.can');
      await writeFile(source, SOURCE);
      const compiler = process.env.CAN_BINDING_COMPILER ?? resolve('compiler/target/debug/can');
      const catalog = process.env.CAN_BINDING_CATALOG ?? resolve('packages/cloudflare/dist/native-catalog.json');
      const artifact = JSON.parse(execFileSync(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as CompileArtifact;
      const require = createRequire(import.meta.url);
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: join(root, 'modules'),
        stdlibUrl: new URL('./stdlib.js', import.meta.url).href,
        uiUrl: pathToFileURL(require.resolve('@canlang/ui')).href });
      const options = (): LocalDevOptions => ({ workerName: 'host-owner', compatibilityDate: '2026-07-15',
        mainModule: 'main.mjs', modules: { 'main.mjs': BRIDGE },
        d1Databases: [{ binding: 'STATE', id: 'host-state' }, { binding: 'IDENTITY', id: 'host-identity' }, { binding: 'BROKER', id: 'host-broker' }],
        queueProducers: { JOBS: 'host-jobs' }, analyticsEngineDatasets: [{ binding: 'METRICS', dataset: 'host-metrics' }],
        d1Persist: join(root, 'd1'), analyticsEnginePersist: join(root, 'analytics'),
        companionWorkers: [{ workerName: 'host-broker', compatibilityDate: '2026-07-15', mainModule: 'broker.mjs', modules: { 'broker.mjs': BROKER },
          d1Databases: [{ binding: 'BROKER', id: 'host-broker' }], queueConsumers: { 'host-jobs': { maxBatchSize: 1, maxBatchTimeout: 0 } } }],
      });
      const now = () => FIXED_NOW;
      const open = async () => {
        dev = await startLocalDev(options());
        const stateDb = await dev.getD1Database('STATE'), identityDb = await dev.getD1Database('IDENTITY');
        const broker = await dev.getD1Database('BROKER');
        await ensureSchema(stateDb); await ensureIdentitySchema(identityDb);
        await broker.exec('CREATE TABLE IF NOT EXISTS received(id TEXT PRIMARY KEY,body TEXT NOT NULL)');
        return { stateDb, physical: createD1Storage(stateDb), identities: createD1IdentityStore(identityDb, { clock: { nowMs: now } }), broker };
      };
      let state = await open();
      const user = await state.identities.createUser({ email: 'resource-host@example.test', password_hash: 'unused', email_verified: true });
      const team = await state.identities.createTeam({ timezone: 'UTC' });
      await state.identities.createMembership({ user_id: user.user_id, team_id: team.team_id, is_owner: false, roles: [] });
      const token = 'resource-host-session';
      await state.identities.createSession({ user_id: user.user_id, token_sha256: createHash('sha256').update(token).digest('hex'),
        expires_at: new Date(FIXED_NOW + 3_600_000).toISOString(), last_team_id: team.team_id });
      const identity = await resolveIdentity(state.identities, { session_token: token, team_id: team.team_id }, { clock: { nowMs: now } });
      const scope = { app: APP, owner: team.team_id, ownerPackage: OWNER };
      const authority = { app: APP, stateOwner: APP, stateStoreId: 'resource-host-state', fileStoreId: 'resource-host-opaque',
        receiver: { app: APP, team: team.team_id, owner: team.team_id } };
      let refuseHandlerCommit = false;
      const install = async () => {
        const physical = createD1Storage(state.stateDb, authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, scope, store: physical, authority, now,
          verifyOwner: async () => { assert.ok(await state.identities.findTeamById(team.team_id)); } });
        const commit = physical.commit;
        Object.defineProperty(physical, 'commit', { value: async (batch: Parameters<StoragePort['commit']>[0]) => {
          if (refuseHandlerCommit && batch.writes.some(write => write.model === `${OWNER}.Processed`)) {
            refuseHandlerCommit = false; throw new Error('resource host transient handler commit failure');
          }
          return commit.call(physical, batch);
        } });
        state.physical = physical;
      };
      await install();
      const store = (): StoragePort => state.physical;
      const pointsInFlight: Array<Promise<void>> = [];
      const host = async () => createResourceHost({ artifact, asm, store: store(), identities: state.identities, scope, now,
        env: { [`${OWNER}.Jobs`]: await dev!.getQueueProducer('JOBS'), [`${OWNER}.Metrics`]: {
          // The Node host forwards this raw API port into the actual installed
          // workerd Analytics binding; its persisted local log is observable.
          writeDataPoint(point: unknown) { pointsInFlight.push(dev!.dispatch('/analytics', { method: 'POST', body: JSON.stringify(point) })
            .then(response => { assert.equal(response.status, 204); })); },
        }, CAN_LOCAL_QUEUE_BINDINGS: { 'host-jobs': `${OWNER}.Jobs` } },
      });
      let resourceHost = await host();
      let invoker = buildInvoker(artifact, asm, store(), { memberships: state.identities, now, runtimeBindings: 1 });
      let sequence = 0;
      const envelope = (label: string, fail = false, enabled = true): MutationEnvelope => ({ operation: `${OWNER}.submit`,
        operation_id: asOperationId(uuidv7(FIXED_NOW, ++sequence)), inputs: { value: { label, count: COUNT, total: TOTAL }, enabled, fail } });
      const processed = () => state.physical.query({ model: asModel(`${OWNER}.Processed`), authority: 'owner' });
      const failed = await invoker.invokeMutation(envelope('rollback', true), identity);
      assert.ok('error' in failed, JSON.stringify(failed)); assert.equal(failed.error.code, 'rule_failed', JSON.stringify(failed));
      assert.deepEqual(await state.physical.outboxPending(), []); assert.deepEqual(await processed(), []);
      assert.deepEqual(await dev!.getAnalyticsDataPoints('host-metrics'), []);
      const first = envelope('first');
      committed(await invoker.invokeMutation(first, identity));
      assert.equal((await state.physical.outboxPending()).length, 2);
      assert.deepEqual(await processed(), []); assert.deepEqual(await dev!.getAnalyticsDataPoints('host-metrics'), []);
      await resourceHost.drain(); await Promise.all(pointsInFlight.splice(0));
      const points = await eventually(() => dev!.getAnalyticsDataPoints('host-metrics'), value => value.length === 1);
      const blob = points[0]!.point.blobs[0]; assert.equal(typeof blob, 'string');
      const metric = JSON.parse(blob as string) as { eventId: string; source: string; fields: unknown };
      assert.equal(metric.source, `${OWNER}.Metrics.write`); assert.deepEqual(metric.fields, { count: COUNT, total: TOTAL });
      const rows = await processed(); assert.equal(rows.length, 1, JSON.stringify(await state.physical.query({ model: asModel('work.handler_occurrence'), authority: 'owner' })));
      assert.deepEqual(rows[0]!.data, { label: 'first', count: COUNT, total: TOTAL });
      const messages = await eventually(() => state.broker.prepare('SELECT body FROM received').all<{ body: string }>(), value => value.results.length === 1);
      const brokerBody = JSON.parse(messages.results[0]!.body) as unknown;
      let acks = 0, retries = 0;
      const batch = (body: unknown): ResourceBatch => ({ queue: 'host-jobs', messages: [{ body, ack() { acks++; }, retry() { retries++; } }] });
      const revision = await state.physical.readRevision();
      await resourceHost.consume(batch(brokerBody)); assert.equal(acks, 1); assert.equal(retries, 0);
      assert.equal(await state.physical.readRevision(), revision);
      committed(await invoker.invokeMutation(first, identity), 'replayed');
      await resourceHost.drain(); assert.equal((await processed()).length, 1);
      assert.equal((await dev!.getAnalyticsDataPoints('host-metrics')).length, 1);

      // The first drain retains intake, delivers both resources, then fails
      // the actual authored handler commit. Recovery owns the remaining work.
      committed(await invoker.invokeMutation(envelope('recovered'), identity));
      refuseHandlerCommit = true;
      await assert.rejects(resourceHost.drain(), /transient handler commit failure/);
      await Promise.all(pointsInFlight.splice(0));
      await eventually(() => dev!.getAnalyticsDataPoints('host-metrics'), value => value.length === 2);
      assert.equal((await processed()).length, 1);
      await dev!.dispose(); dev = undefined;
      state = await open();
      await install();
      invoker = buildInvoker(artifact, asm, store(), { memberships: state.identities, now, runtimeBindings: 1 });
      resourceHost = await host();
      await resourceHost.drain();
      assert.deepEqual((await processed()).map(row => row.data['label']).sort(), ['first', 'recovered']);
      assert.equal((await dev!.getAnalyticsDataPoints('host-metrics')).length, 2, 'restart does not reemit acknowledged analytics');
      const recoveredRevision = await state.physical.readRevision();
      await resourceHost.drain();
      assert.equal(await state.physical.readRevision(), recoveredRevision);
      assert.deepEqual(await state.physical.outboxPending(), []);
      committed(await invoker.invokeMutation(envelope('disabled', false, false), identity));
      await resourceHost.drain();
      assert.deepEqual((await processed()).map(row => row.data['label']).sort(), ['first', 'recovered']);
      assert.equal((await dev!.getAnalyticsDataPoints('host-metrics')).length, 2);
    } finally {
      await dev?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
