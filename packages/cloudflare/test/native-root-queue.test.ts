/** Same-root queue effects recover from the authoritative SQLite actor, including lost broker memory. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { CompileArtifact } from '@canlang/contracts';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1IdentityStore, ensureIdentitySchema, sha256HexText, deriveCsrfToken, issueMcpGrant } from '@canlang/identity';
import { mintOperationId } from '@canlang/ui';
import { distribution } from '@canlang/values/distribution';
const require = createRequire(import.meta.url);

test('compiled root queue rolls back before commit and recovers one same-root consumer after actor/broker restart', { timeout: 60_000 }, async () => {
  const compiler = process.env.CAN_TEST_COMPILER ?? resolve('compiler/target/debug/can');
  const { stdout } = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts',
    `--catalog=${fileURLToPath(distribution.catalog)}`, resolve(process.env.CAN_TEST_FIXTURE ?? 'packages/cloudflare/test/fixtures/native-root-queue.can')], { maxBuffer: 32 * 1024 * 1024 });
  const artifact = JSON.parse(stdout) as CompileArtifact;
  const { buildDeployBundle, DEPLOY_MAIN_MODULE } = await import(require.resolve('@canlang/cloudflare/deploy/bundle')) as typeof import('../src/deploy/bundle.js');
  const bundle = buildDeployBundle(artifact, { verdict: { active: true } });
  const dir = await mkdtemp(join(tmpdir(), 'can-root-queue-'));
  const options = { compatibilityDate: '2026-07-15', modulesRoot: '/',
    modules: [DEPLOY_MAIN_MODULE, ...Object.keys(bundle.modules).filter(path => path !== DEPLOY_MAIN_MODULE)].map(path => ({
      type: 'ESModule' as const, path: `/${path}`, contents: bundle.modules[path]!,
    })), bindings: { CAN_LOCAL_QUEUE_BINDINGS: { 'root-jobs': 'RootQueue.Jobs' } },
    d1Databases: { DB: 'root-queue-identities' }, d1Persist: join(dir, 'd1'),
    durableObjects: { 'RootQueue.Schedule': { className: 'CanRootAuthority', useSQLite: true } }, durableObjectsPersist: join(dir, 'do'),
    queueProducers: { 'RootQueue.Jobs': 'root-jobs' }, queueConsumers: { 'root-jobs': { maxBatchSize: 1, maxBatchTimeout: 0, retryDelay: 0 } } };
  let mf = new Miniflare(options);
  try {
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    await ensureIdentitySchema(db); const identities = createD1IdentityStore(db);
    const team = await identities.createTeam({});
    const user = await identities.createUser({ email: 'root-queue@example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText('session'),
      expires_at: new Date(Date.now() + 3_600_000).toISOString(), last_team_id: team.team_id });
    const { token: grant } = await issueMcpGrant(identities, { user_id: user.user_id, team_id: team.team_id, client_id: 'root-queue-test' });
    const mutation = async (operation: string, inputs: unknown, operationId = mintOperationId()) => {
      const response = await mf.dispatchFetch(`http://app.test/api/operations/RootQueue.${operation}`, { method: 'POST', headers: {
        'content-type': 'application/json', cookie: 'can_session=session', 'x-csrf-token': await deriveCsrfToken('session'),
      }, body: JSON.stringify({ operation_id: operationId, inputs }) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const created = await mutation('Calendar.create', { name: 'Root' }); assert.equal(created.status, 200, JSON.stringify(created));
    const root = created.body.records[0] as { id: string; version: number };
    const read = async (operation: string, args: unknown) => {
      const response = await mf.dispatchFetch('http://app.test/mcp', { method: 'POST', headers: {
        authorization: `Bearer ${grant}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: `RootQueue.${operation}`, arguments: args } }) });
      const body = await response.json() as Record<string, any>;
      assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.result?.isError, undefined, JSON.stringify(body));
      return body.result.structuredContent as Record<string, any>;
    };
    const status = async () => (await read('status', { calendar: { id: root.id } })).result as string;
    const value = { id: root.id, version: '1' };
    const rejected = await mutation('submit', { calendar: value, title: 'Queued', accept: false }); assert.notEqual(rejected.status, 200, JSON.stringify(rejected));
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(await status(), '0', 'No consumer effect may escape the rejected original mutation.');
    const operationId = mintOperationId();
    const sent = await mutation('submit', { calendar: value, title: 'Queued', accept: true }, operationId); assert.equal(sent.status, 200, JSON.stringify(sent));
    assert.equal(await status(), '0', 'The authoring HTTP response precedes the separate alarm/queue delivery.');
    // Stop before the armed alarm: the pending original outbox must survive even though broker memory does not.
    await mf.dispose(); mf = new Miniflare(options);
    let processed = '0';
    for (let attempt = 0; attempt < 200 && processed === '0'; attempt++) {
      processed = await status();
      if (processed === '0') await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(processed, '1', 'The genuine actor alarm must recover committed source/intake/handler work.');
    const bookings = await read('Booking.read', {});
    assert.equal(bookings.records.length, 1, JSON.stringify(bookings));
    assert.ok(bookings.records[0].id.startsWith(`${root.id}.`));
    assert.equal(bookings.records[0].data.title, 'Queued');
    const replayed = await mutation('submit', { calendar: value, title: 'Queued', accept: true }, operationId);
    assert.equal(replayed.status, 200, JSON.stringify(replayed)); assert.equal(replayed.body.status, 'replayed');
    await mf.dispose(); mf = new Miniflare(options);
    assert.equal(await status(), '1');
    assert.equal((await read('Booking.read', {})).records.length, 1, 'Restart/replay never repeats the committed handler body.');
    const reopenedDb = await mf.getD1Database('DB') as unknown as D1Database;
    assert.equal((await reopenedDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").all()).results.length, 0);
  } finally { await mf.dispose(); await rm(dir, { recursive: true, force: true }); }
});
