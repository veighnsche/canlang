/** Whole protected File requests execute beside the owning root's current State. */
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
import { sha256Hex } from '@canlang/files/upload';
import { distribution } from '@canlang/values/distribution';
const require = createRequire(import.meta.url);

test('compiled rooted File upload/attach/read preserves rollback, grants, root isolation and restart', { timeout: 60_000 }, async () => {
  const { stdout } = await promisify(execFile)(process.env.CAN_TEST_COMPILER ?? resolve('compiler/target/debug/can'), [
    'compile', '--format=json', '--native-scenario-receipts', `--catalog=${fileURLToPath(distribution.catalog)}`,
    resolve(process.env.CAN_TEST_FIXTURE ?? 'packages/cloudflare/test/fixtures/native-root-files.can')], { maxBuffer: 32 * 1024 * 1024 });
  const artifact = JSON.parse(stdout) as CompileArtifact;
  const { buildDeployBundle, DEPLOY_MAIN_MODULE } = await import(require.resolve('@canlang/cloudflare/deploy/bundle')) as typeof import('../src/deploy/bundle.js');
  const bundle = buildDeployBundle(artifact, { verdict: { active: true } });
  const dir = await mkdtemp(join(tmpdir(), 'can-root-files-')), origin = 'http://127.0.0.1:4500';
  const options = { compatibilityDate: '2026-07-15', modulesRoot: '/',
    modules: [DEPLOY_MAIN_MODULE, ...Object.keys(bundle.modules).filter(path => path !== DEPLOY_MAIN_MODULE)].map(path => ({
      type: 'ESModule' as const, path: `/${path}`, contents: bundle.modules[path]!,
    })), bindings: { CAN_LOCAL_FILES: true, CAN_DEPLOYMENT_BASE: origin }, d1Databases: { DB: 'root-files-identities' }, d1Persist: join(dir, 'd1'),
    r2Buckets: { FILES: 'root-files-objects' }, r2Persist: join(dir, 'r2'),
    durableObjects: { 'RootFiles.Vault': { className: 'CanRootAuthority', useSQLite: true } }, durableObjectsPersist: join(dir, 'do') };
  let mf = new Miniflare(options);
  try {
    const db = await mf.getD1Database('DB') as unknown as D1Database;
    await ensureIdentitySchema(db); const identities = createD1IdentityStore(db);
    const team = await identities.createTeam({}), foreignTeam = await identities.createTeam({});
    const users = await Promise.all(['owner','member','foreign'].map(name => identities.createUser({ email: `${name}-root-files@example.test`, password_hash: 'unused', email_verified: true })));
    const [owner, member, foreign] = users; assert.ok(owner && member && foreign);
    await identities.createMembership({ team_id: team.team_id, user_id: owner.user_id, is_owner: true, roles: [] });
    const memberMembership = await identities.createMembership({ team_id: team.team_id, user_id: member.user_id, is_owner: false, roles: [] });
    await identities.createMembership({ team_id: foreignTeam.team_id, user_id: foreign.user_id, is_owner: true, roles: [] });
    await identities.createSession({ user_id: owner.user_id, token_sha256: await sha256HexText('session'), expires_at: new Date(Date.now()+3_600_000).toISOString(), last_team_id: team.team_id });
    const grants = await Promise.all(([[owner,team],[member,team],[foreign,foreignTeam]] as const).map(async ([user, selected]) => issueMcpGrant(identities,
      { user_id: user!.user_id, team_id: selected!.team_id, client_id: 'root-files-test' })));
    const token = grants[0]!.token;
    const mutation = async (operation: string, inputs: unknown) => {
      const response = await mf.dispatchFetch(`${origin}/api/operations/RootFiles.${operation}`, { method: 'POST', headers: {
        'content-type': 'application/json', cookie: 'can_session=session', 'x-csrf-token': await deriveCsrfToken('session'),
      }, body: JSON.stringify({ operation_id: mintOperationId(), inputs }) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const created = await mutation('Folder.create', { name: 'First' }); assert.equal(created.status, 200, JSON.stringify(created));
    const root = created.body.records[0] as { id: string };
    const second = await mutation('Folder.create', { name: 'Second' }); assert.equal(second.status, 200, JSON.stringify(second));
    const otherRoot = second.body.records[0] as { id: string };
    const request = (path: string, method = 'GET', body?: string | Uint8Array, grant = token) => mf.dispatchFetch(new URL(path, origin).href, {
      method, headers: { authorization: `Bearer ${grant}`, 'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json',
        ...(method === 'PUT' ? { 'upload-offset': '0' } : {}) }, ...(body === undefined ? {} : { body }),
    });
    const bytes = new TextEncoder().encode('%PDF-1.4\nActual rooted upload\n');
    const upload = await request('/files/intents', 'POST', JSON.stringify({ upload_id: 'root-file', operation: 'RootFiles.attach', field: '/attachment',
      arguments: {}, name: 'root.pdf', type: 'application/pdf', size: String(bytes.length) }));
    assert.equal(upload.status, 200, await upload.clone().text());
    const intent = await upload.json() as { content: string; finalize: string };
    assert.equal((await request(intent.content, 'PUT', bytes)).status, 200);
    const finalized = await request(intent.finalize, 'POST', JSON.stringify({ upload_id: 'root-file', bytes_digest: sha256Hex(bytes) }));
    assert.equal(finalized.status, 200, await finalized.clone().text()); const ref = (await finalized.json() as { file: string }).file;
    const inputs = { folder: { id: root.id, version: '1' }, attachment: { id: ref } };
    const path = `/files/read/RootFiles.Folder/${encodeURIComponent(root.id)}/attachment`;
    const refused = await mutation('attach', { ...inputs, accept: false }); assert.notEqual(refused.status, 200, JSON.stringify(refused));
    assert.equal((await request(path)).status, 404, 'Rejected mutation cannot expose an attachment.');
    const attached = await mutation('attach', { ...inputs, accept: true }); assert.equal(attached.status, 200, JSON.stringify(attached));
    const download = await request(path); assert.equal(download.status, 200, await download.clone().text());
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
    assert.equal((await request(path, 'GET', undefined, grants[1]!.token)).status, 404, 'Active team member lacks the owning field grant.');
    assert.equal((await request(path, 'GET', undefined, grants[2]!.token)).status, 404, 'Foreign team cannot borrow a rooted locator.');
    const wrongRoot = `/files/read/RootFiles.Folder/${encodeURIComponent(otherRoot.id)}/attachment/${encodeURIComponent(ref)}`;
    assert.equal((await request(wrongRoot)).status, 404, 'A valid File identity cannot replace the selected root field association.');
    await mf.dispose(); mf = new Miniflare(options);
    const reopened = await request(path); assert.equal(reopened.status, 200, await reopened.clone().text());
    assert.deepEqual(new Uint8Array(await reopened.arrayBuffer()), bytes);
    const reopenedDb = await mf.getD1Database('DB') as unknown as D1Database;
    await createD1IdentityStore(reopenedDb).removeMembership(memberMembership.membership_id);
    assert.equal((await request(path, 'GET', undefined, grants[1]!.token)).status, 401);
    assert.equal((await reopenedDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").all()).results.length, 0);
  } finally { await mf.dispose(); await rm(dir, { recursive: true, force: true }); }
});
