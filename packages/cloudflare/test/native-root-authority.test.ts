/** Real compiled source, original HTTP/MCP transports and production SQLite actor. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Miniflare } from 'miniflare';
import type { CompileArtifact } from '@canlang/contracts';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1IdentityStore, ensureIdentitySchema, sha256HexText, deriveCsrfToken, issueMcpGrant } from '@canlang/identity';
import { mintOperationId } from '@canlang/ui';
import { distribution } from '@canlang/values/distribution';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const fixture = resolve('packages/cloudflare/test/fixtures/native-root-authority.can');

test('compiled Calendar and child use production root authority for create/update/replay/discovery/restart', async () => {
  const compiler = process.env.CAN_TEST_COMPILER ?? resolve('compiler/target/debug/can');
  const { stdout } = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts',
    `--catalog=${fileURLToPath(distribution.catalog)}`, fixture], { maxBuffer: 32 * 1024 * 1024 });
  const artifact = JSON.parse(stdout) as CompileArtifact;
  assert.equal(artifact.operations?.find(operation => operation.name === 'CalendarDemo.newCalendar')?.rootAuthority?.createsRoot, true);
  const { buildDeployBundle, DEPLOY_MAIN_MODULE } = await import(require.resolve('@canlang/cloudflare/deploy/bundle')) as typeof import('../src/deploy/bundle.js');
  const bundle = buildDeployBundle(artifact, { verdict: { active: true } });
  const dir = await mkdtemp(join(tmpdir(), 'can-root-main-'));
  const options = { compatibilityDate: '2026-07-15', modulesRoot: '/',
    modules: [DEPLOY_MAIN_MODULE, ...Object.keys(bundle.modules).filter(path => path !== DEPLOY_MAIN_MODULE)].map(path => ({
      type: 'ESModule' as const, path: `/${path}`, contents: bundle.modules[path]!,
    })), d1Databases: { DB: 'identity-index' }, d1Persist: join(dir, 'd1'),
    durableObjects: { 'CalendarDemo.Schedule': { className: 'CanRootAuthority', useSQLite: true } }, durableObjectsPersist: join(dir, 'do') };
  let mf = new Miniflare(options);
  try {
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    await ensureIdentitySchema(db);
    const identities = createD1IdentityStore(db);
    const team = await identities.createTeam({}), foreignTeam = await identities.createTeam({});
    const user = await identities.createUser({ email: 'root-main@example.test', password_hash: 'unused', email_verified: true });
    const foreignUser = await identities.createUser({ email: 'foreign-root-main@example.test', password_hash: 'unused', email_verified: true });
    const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
    await identities.createMembership({ team_id: foreignTeam.team_id, user_id: foreignUser.user_id, is_owner: true, roles: [] });
    for (const [token, actor, owner] of [['first', user, team], ['foreign', foreignUser, foreignTeam]] as const) await identities.createSession({
      user_id: actor.user_id, token_sha256: await sha256HexText(token), expires_at: new Date(Date.now() + 3_600_000).toISOString(), last_team_id: owner.team_id });
    const mutation = async (operation: string, inputs: unknown, operationId = mintOperationId(), token = 'first') => {
      const response = await mf.dispatchFetch(`http://app.test/api/operations/${operation}`, { method: 'POST', headers: {
        'content-type': 'application/json', cookie: `can_session=${token}`, 'x-csrf-token': await deriveCsrfToken(token),
      }, body: JSON.stringify({ operation_id: operationId, inputs }) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const originalId = mintOperationId();
    const created = await mutation('CalendarDemo.Calendar.create', { name: 'One' }, originalId);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const root = created.body.records[0] as { id: string; version: number };
    assert.match(root.id, /^r1\./);
    const replayed = await mutation('CalendarDemo.Calendar.create', { name: 'One' }, originalId);
    assert.equal(replayed.status, 200, JSON.stringify(replayed.body)); assert.equal(replayed.body.status, 'replayed');
    assert.equal(replayed.body.records[0].id, root.id);
    assert.equal((await mutation('CalendarDemo.Calendar.create', { name: 'Changed' }, originalId)).status, 409);
    const source = await mutation('CalendarDemo.newCalendar', { name: 'Two' });
    assert.equal(source.status, 200, JSON.stringify(source.body));
    const second = source.body.result as { id: string }; assert.notEqual(second.id, root.id);
    const child = await mutation('CalendarDemo.Booking.create', { title: 'Booking', parent: { id: root.id } });
    assert.equal(child.status, 200, JSON.stringify(child.body));
    const booking = child.body.records[0] as { id: string; version: number };
    assert.ok(booking.id.startsWith(`${root.id}.`));
    const updated = await mutation('CalendarDemo.Booking.update', { record: { id: booking.id, version: String(booking.version) }, title: 'Updated' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const namespace = await mf.getDurableObjectNamespace('CalendarDemo.Schedule');
    const falseEnvelope = { operation: 'CalendarDemo.Calendar.create', operation_id: originalId, inputs: { name: 'One' } };
    const originalBody = JSON.stringify({ operation_id: mintOperationId(), inputs: { record: { id: booking.id, version: '2' }, title: 'Forged' } });
    const forged = await namespace.get(namespace.idFromName(root.id)).fetch('http://can-root.internal/invoke', {
      method: 'POST', headers: { 'content-type': 'application/x-can-root-invocation+json' },
      body: JSON.stringify({ kind: 'can-root-invocation/v1', invocation: falseEnvelope,
        locator: { binding: 'CalendarDemo.Schedule', rootId: root.id },
        request: { url: 'http://app.test/api/operations/CalendarDemo.Booking.update', method: 'POST',
          headers: [['content-type', 'application/json'], ['cookie', 'can_session=first'], ['x-csrf-token', await deriveCsrfToken('first')]],
          body: Buffer.from(originalBody).toString('base64') } }),
    });
    assert.equal(forged.headers.get('x-can-root-outcome'), 'v1');
    assert.ok('error' in (await forged.json() as Record<string, unknown>), 'Decoded original request must match its locator before reading business records.');
    const cross = await mutation('CalendarDemo.renameBoth', { left: { id: root.id, version: '1' }, right: { id: second.id, version: '1' }, name: 'Cross' });
    assert.notEqual(cross.status, 200, JSON.stringify(cross.body));
    const foreign = await mutation('CalendarDemo.Booking.update', { record: { id: booking.id, version: '2' }, title: 'Foreign' }, mintOperationId(), 'foreign');
    assert.notEqual(foreign.status, 200, JSON.stringify(foreign.body));
    const { token: grant } = await issueMcpGrant(identities, { user_id: user.user_id, team_id: team.team_id, client_id: 'root-main-test' });
    const read = async () => {
      const response = await mf.dispatchFetch('http://app.test/mcp', { method: 'POST', headers: {
        authorization: `Bearer ${grant}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'CalendarDemo.Booking.read', arguments: {} } }) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    // Discovery is explicitly eventual; each result is re-read and admitted in its root.
    let discovered: Awaited<ReturnType<typeof read>> | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      discovered = await read();
      if (discovered.body.result?.structuredContent?.records?.length > 0) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(discovered?.status, 200, JSON.stringify(discovered));
    assert.equal(discovered?.body.result?.isError, undefined, JSON.stringify(discovered));
    assert.equal(discovered?.body.result?.structuredContent?.records?.[0]?.data?.title, 'Updated', JSON.stringify(discovered));
    await mf.dispose(); mf = new Miniflare(options);
    const reopened = await mutation('CalendarDemo.Calendar.create', { name: 'One' }, originalId);
    assert.equal(reopened.status, 200, JSON.stringify(reopened.body)); assert.equal(reopened.body.status, 'replayed');
    assert.equal(reopened.body.records[0].id, root.id);
    const reopenedDb = await mf.getD1Database('DB') as unknown as D1Database;
    assert.equal((await reopenedDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").all()).results.length, 0);
    // Fresh membership is checked again; a previously selected root cannot retain a revoked grant.
    const reopenedIdentities = createD1IdentityStore(reopenedDb);
    const caretaker = await reopenedIdentities.createUser({ email: 'caretaker-root-main@example.test', password_hash: 'unused', email_verified: true });
    await reopenedIdentities.createMembership({ team_id: team.team_id, user_id: caretaker.user_id, is_owner: true, roles: [] });
    await reopenedIdentities.removeMembership(membership.membership_id);
    assert.notEqual((await mutation('CalendarDemo.Booking.update', { record: { id: booking.id, version: '2' }, title: 'Revoked' })).status, 200);
  } finally { await mf.dispose(); await rm(dir, { recursive: true, force: true }); }
});
