import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { CompileArtifact } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity } from '@canlang/identity';
import { asId, asModel, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { sha256Hex } from '@canlang/files/upload';
import { assembleModules } from './modules.js';
import { buildInvoker } from '../worker/assembly.js';
import { createWorkerFiles } from './worker-files.js';

test('compiler-owned implicit FILES serves authenticated upload, canonical attachment and freshly authorized R2 downloads after restart', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'can-worker-files-'));
  let mf: Miniflare | undefined;
  try {
    const source = resolve('packages/cloudflare/test/fixtures/typed-file-journey.can');
    const artifact = JSON.parse(execFileSync(process.env.CAN_BINDING_COMPILER ?? resolve('compiler/target/debug/can'), ['compile', '--format=json', '--native-scenario-receipts', '--catalog', process.env.CAN_BINDING_CATALOG ?? resolve('packages/cloudflare/dist/native-catalog.json'), source], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: join(root, 'modules'), stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    let now = Date.now();
    const clock = { nowMs: () => now };
    const origin = 'http://127.0.0.1:4500';
    const open = async () => {
      mf = new Miniflare({ compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("private")}}', d1Databases: { DB: 'worker-files' }, r2Buckets: { FILES: 'worker-files' }, d1Persist: join(root, 'd1'), r2Persist: join(root, 'r2') });
      const db = await mf.getD1Database('DB') as unknown as D1Database, bucket = await mf.getR2Bucket('FILES') as unknown as R2Bucket;
      await ensureSchema(db); await ensureIdentitySchema(db);
      const store = createD1Storage(db), identities = createD1IdentityStore(db, { clock });
      const files = await createWorkerFiles({ artifact, asm, env: { DB: db, FILES: bucket }, store, identities, origin, localLoopback: true, clock,
        intentTtlMs: 3600_000, retention: { unattachedHorizonMs: 86400_000, retentionMs: 86400_000, retainAttached: true } });
      assert.ok(files?.canonical); assert.ok(files.fetch);
      return { store, identities, files, invoker: buildInvoker(artifact, asm, store, { memberships: identities, now: () => now, files: files.canonical }) };
    };
    let host = await open();
    const team = await host.identities.createTeam({ timezone: 'UTC' });
    const owner = await host.identities.createUser({ email: 'r2-owner@test.invalid', password_hash: 'unused', email_verified: true });
    await host.identities.createMembership({ team_id: team.team_id, user_id: owner.user_id, is_owner: true, roles: [] });
    const member = await host.identities.createUser({ email: 'r2-member@test.invalid', password_hash: 'unused', email_verified: true });
    const membership = await host.identities.createMembership({ team_id: team.team_id, user_id: member.user_id, is_owner: false, roles: [] });
    const grant = await issueMcpGrant(host.identities, { user_id: owner.user_id, team_id: team.team_id, client_id: 'r2-owner' }, { clock });
    const memberGrant = await issueMcpGrant(host.identities, { user_id: member.user_id, team_id: team.team_id, client_id: 'r2-member' }, { clock });
    let sequence = 0;
    const mutate = async (operation: string, inputs: Record<string, unknown>) => host.invoker.invokeMutation({ operation: `TypedFileJourney.${operation}`, operation_id: asOperationId(uuidv7(now, ++sequence)), inputs }, await resolveIdentity(host.identities, { mcp_grant_token: grant.token }, { clock }));
    const created = await mutate('Entry.create', {}); assert.ok('result' in created);
    const record = created.result.records![0] as { id: string };
    assert.equal(typeof record.id, 'string');
    const request = (path: string, method: string, body?: string | Uint8Array, token = grant.token) => new Request(new URL(path, origin), { method,
      headers: { authorization: `Bearer ${token}`, ...(method === 'PUT' ? { 'upload-offset': '0' } : {}), 'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json' },
      ...(body === undefined ? {} : { body }) });
    const bytes = new TextEncoder().encode('%PDF-1.4\nActual R2 upload\n');
    const intentBody = JSON.stringify({ upload_id: 'r2-actual', operation: 'TypedFileJourney.attach', field: '/attachment', arguments: {}, name: 'actual.pdf', type: 'application/pdf', size: String(bytes.length) });
    assert.equal((await host.files.fetch!(new Request(`${origin}/files/intents`, { method: 'POST', body: intentBody }))).status, 401);
    const upload = await host.files.fetch!(request('/files/intents', 'POST', intentBody)); assert.equal(upload.status, 200, await upload.clone().text());
    const intent = await upload.json() as { content: string; finalize: string };
    assert.equal(new URL(intent.content).origin, origin);
    assert.equal((await host.files.fetch!(request(intent.content, 'PUT', bytes))).status, 200);
    const finalized = await host.files.fetch!(request(intent.finalize, 'POST', JSON.stringify({ upload_id: 'r2-actual', bytes_digest: sha256Hex(bytes) })));
    assert.equal(finalized.status, 200, await finalized.clone().text());
    const ref = (await finalized.json() as { file: string }).file;
    const attachInputs = { entry: { id: record.id, version: '1' }, attachment: { id: ref } };
    const refused = await mutate('attach', { ...attachInputs, accept: false }); assert.ok('error' in refused);
    assert.equal((await host.store.load(asModel('TypedFileJourney.Entry'), asId(record.id)))!.version, 1);
    const attached = await mutate('attach', { ...attachInputs, accept: true }); assert.ok('result' in attached, JSON.stringify(attached));
    const path = `/files/read/TypedFileJourney.Entry/${encodeURIComponent(record.id)}/attachment`;
    const download = await host.files.fetch!(request(path, 'GET')); assert.equal(download.status, 200, await download.clone().text());
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
    assert.equal(download.headers.get('cache-control'), 'private, no-store');
    assert.equal((await host.files.fetch!(request(path, 'GET', undefined, memberGrant.token))).status, 404);
    await mf!.dispose(); mf = undefined; host = await open();
    const restarted = await host.files.fetch!(request(path, 'GET')); assert.equal(restarted.status, 200, await restarted.clone().text());
    assert.deepEqual(new Uint8Array(await restarted.arrayBuffer()), bytes);
    await host.identities.removeMembership(membership.membership_id);
    assert.equal((await host.files.fetch!(request(path, 'GET', undefined, memberGrant.token))).status, 401);
    assert.equal(host.files.intentsUrl, `${origin}/files/intents`);
    const staleIntentResponse = await host.files.fetch!(request('/files/intents', 'POST', intentBody.replace('r2-actual', 'r2-unattached')));
    const staleIntent = await staleIntentResponse.json() as { content: string; finalize: string };
    assert.equal((await host.files.fetch!(request(staleIntent.content, 'PUT', bytes))).status, 200);
    const staleFinal = await host.files.fetch!(request(staleIntent.finalize, 'POST', JSON.stringify({ upload_id: 'r2-unattached', bytes_digest: sha256Hex(bytes) })));
    const unattached = (await staleFinal.json() as { file: string }).file;
    const currentOwner = await resolveIdentity(host.identities, { mcp_grant_token: grant.token }, { clock });
    now += 25 * 3600_000;
    assert.equal(await host.files.canonical!.validate(unattached, currentOwner, 'TypedFileJourney'), false);
    assert.equal(await host.files.canonical!.validate(ref, currentOwner, 'TypedFileJourney'), true);
  } finally { await mf?.dispose(); rmSync(root, { recursive: true, force: true }); }
});
