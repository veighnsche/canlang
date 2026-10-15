/** Real receiving Files authority crosses the original source SEND and durable queue intake. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { CompileArtifact, MutationEnvelope, StoragePort } from '@canlang/contracts';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work/kernel/file-reference-inventory';
import { createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity } from '@canlang/identity';
import { asModel, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { sha256Hex } from '@canlang/files/upload';
import { blobKeyForFile } from '@canlang/files/finalize';
import { assembleModules } from './modules.js';
import { installNativeFileInventory } from './file-inventory.js';
import { createResourceHost } from './resource-host.js';
import { createWorkerFiles } from './worker-files.js';
import { buildInvoker, type MutationOutcome } from '../worker/assembly.js';

const APP = 'QueuedFiles';
const SOURCE = `app QueuedFiles
context
 queue Direct type=file
 queue Bundled type=Payload
Given
 contract Payload {attachment:file,label:text}
 Processed {label:text}
 policy Processed read=members
When
 scenario publish(attachment:file,bundle:Payload,enabled:bool,accept:bool) by=members
  do
   send Direct.publish {value=attachment} as direct
   send Bundled.publish {value=bundle} when=enabled as bundled
   require accept
 scenario consumeDirect on=Direct
  do
   require actor==null
   let attachment=event
   create Processed {label="direct"} as processed
 scenario consumeBundled on=Bundled
  do
   require actor==null
   let attachment=event.attachment
   create Processed {label=event.label} as processed
Then
`;
function committed(outcome: MutationOutcome, status = 'committed') {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, status);
  assert.equal(outcome.result.result, null);
}

test('authenticated File and nominal File queue sends retain real R2 bytes after 24h and recover durable intake exactly once',
  { timeout: 180_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'can-resource-file-queue-'));
    let mf: Miniflare | undefined;
    try {
      const source = join(root, 'QueuedFiles.can'); await writeFile(source, SOURCE);
      const artifact = JSON.parse(execFileSync(process.env.CAN_BINDING_COMPILER ?? resolve('compiler/target/debug/can'),
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', process.env.CAN_BINDING_CATALOG ?? resolve('packages/cloudflare/dist/native-catalog.json'), source],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as CompileArtifact;
      const require = createRequire(import.meta.url);
      const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: join(root, 'modules'),
        stdlibUrl: pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
        uiUrl: pathToFileURL(require.resolve('@canlang/ui')).href });
      let now = Date.now(), sequence = 0, rejectHandlerCommit = false;
      const finalizedAt = now, clock = { nowMs: () => now }, origin = 'http://127.0.0.1:4500';
      const published: unknown[] = [];
      const open = async () => {
        mf = new Miniflare({ compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("private")}}',
          d1Databases: { STATE: 'queued-files-state', IDENTITY: 'queued-files-identity', META: 'queued-files-meta' },
          r2Buckets: { FILES: 'queued-files-bytes' }, queueProducers: { DIRECT: 'queued-file-direct', BUNDLED: 'queued-file-bundled' },
          d1Persist: join(root, 'd1'), r2Persist: join(root, 'r2') });
        const stateDb = await mf.getD1Database('STATE') as unknown as D1Database;
        const identityDb = await mf.getD1Database('IDENTITY') as unknown as D1Database;
        const metadataDb = await mf.getD1Database('META') as unknown as D1Database;
        const bucket = await mf.getR2Bucket('FILES') as unknown as R2Bucket;
        await ensureSchema(stateDb); await ensureIdentitySchema(identityDb);
        const identities = createD1IdentityStore(identityDb, { clock });
        const files = await createWorkerFiles({ artifact, asm, env: { DB: metadataDb, FILES: bucket }, store: createD1Storage(stateDb), identities,
          origin, localLoopback: true, clock, intentTtlMs: 3600_000,
          retention: { unattachedHorizonMs: 86400_000, retentionMs: 86400_000, retainAttached: true } });
        assert.ok(files?.canonical); assert.ok(files.fetch); assert.ok(files.fileStoreId);
        return { stateDb, metadataDb, bucket, identities, files };
      };
      let state = await open();
      const team = await state.identities.createTeam({ timezone: 'UTC' });
      const owner = await state.identities.createUser({ email: 'queue-files@example.test', password_hash: 'unused', email_verified: true });
      await state.identities.createMembership({ team_id: team.team_id, user_id: owner.user_id, is_owner: true, roles: [] });
      const grant = await issueMcpGrant(state.identities, { user_id: owner.user_id, team_id: team.team_id, client_id: 'queue-files' }, { clock });
      const identity = () => resolveIdentity(state.identities, { mcp_grant_token: grant.token }, { clock });
      const scope = { app: APP, owner: team.team_id, ownerPackage: APP };
      const install = async () => {
        const authority = { app: APP, stateOwner: APP, stateStoreId: 'queued-files-state', fileStoreId: state.files.fileStoreId!,
          receiver: { app: APP, team: team.team_id, owner: team.team_id } };
        const store = createD1Storage(state.stateDb, authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
        await installNativeFileInventory({ artifact, asm, scope, store, authority, now: clock.nowMs,
          verifyOwner: async () => { assert.ok(await state.identities.findTeamById(team.team_id)); } });
        const commit = store.commit;
        Object.defineProperty(store, 'commit', { value: async (batch: Parameters<StoragePort['commit']>[0]) => {
          if (rejectHandlerCommit && batch.writes.some(write => write.model === `${APP}.Processed`)) {
            rejectHandlerCommit = false; throw new Error('queued File handler storage outage');
          }
          return commit.call(store, batch);
        } });
        const canonical = state.files.canonical; assert.ok(canonical);
        const env: Record<string, unknown> = {};
        for (const [binding, producer] of [['Direct', 'DIRECT'], ['Bundled', 'BUNDLED']] as const) {
          const actual = await mf!.getQueueProducer(producer);
          env[`${APP}.${binding}`] = { async send(body: unknown) { await actual.send(body); published.push(body); } };
        }
        return { store, host: await createResourceHost({ artifact, asm, env, store, identities: state.identities, scope,
          now: clock.nowMs, files: canonical }),
          invoker: buildInvoker(artifact, asm, store, { memberships: state.identities, now: clock.nowMs, files: canonical, runtimeBindings: 1 }) };
      };
      let runtime = await install();
      const request = (url: string, method: string, body?: string | Uint8Array, authorized = true) => new Request(new URL(url, origin), { method,
        headers: { ...(authorized ? { authorization: `Bearer ${grant.token}` } : {}), ...(method === 'PUT' ? { 'upload-offset': '0' } : {}),
          'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json' }, ...(body === undefined ? {} : { body }) });
      const bytes = new TextEncoder().encode('%PDF-1.4\nActually queued R2 bytes\n');
      const upload = JSON.stringify({ upload_id: 'queued-file-upload', operation: `${APP}.publish`, field: '/attachment', arguments: {},
        name: 'queued.pdf', type: 'application/pdf', size: String(bytes.length) });
      assert.equal((await state.files.fetch!(request('/files/intents', 'POST', upload, false))).status, 401);
      const accepted = await state.files.fetch!(request('/files/intents', 'POST', upload)); assert.equal(accepted.status, 200, await accepted.clone().text());
      const urls = await accepted.json() as { content: string; finalize: string };
      assert.equal((await state.files.fetch!(request(urls.content, 'PUT', bytes))).status, 200);
      const completed = await state.files.fetch!(request(urls.finalize, 'POST', JSON.stringify({ upload_id: 'queued-file-upload', bytes_digest: sha256Hex(bytes) })));
      assert.equal(completed.status, 200, await completed.clone().text());
      const ref = (await completed.json() as { file: string }).file;
      const physical = () => state.files.readOptions!.physicalFiles.get(ref);
      assert.equal((await physical())!.attachedRecord, null);
      const envelope = (accept: boolean): MutationEnvelope => ({ operation: `${APP}.publish`, operation_id: asOperationId(uuidv7(now, ++sequence)),
        inputs: { attachment: { id: ref }, bundle: { attachment: { id: ref }, label: 'bundled' }, enabled: true, accept } });
      now = finalizedAt + 23 * 3600_000;
      const refused = await runtime.invoker.invokeMutation(envelope(false), await identity());
      assert.ok('error' in refused, JSON.stringify(refused)); assert.equal(refused.error.code, 'rule_failed', JSON.stringify(refused));
      assert.deepEqual(await runtime.store.outboxPending(), []); assert.equal((await physical())!.attachedRecord, null);
      assert.deepEqual(published, []);
      const original = envelope(true);
      committed(await runtime.invoker.invokeMutation(original, await identity()));
      assert.equal((await runtime.store.outboxPending()).length, 2); assert.deepEqual(published, []);
      assert.ok((await physical())!.attachedRecord?.endsWith('/queuePayload'));
      assert.equal((await physical())!.attachedAtMs, now, 'attachment uses the actual timely source commit clock');
      committed(await runtime.invoker.invokeMutation(original, await identity()), 'replayed');
      assert.deepEqual(published, []);
      now = finalizedAt + 25 * 3600_000;
      rejectHandlerCommit = true;
      await assert.rejects(runtime.host.drain(), /queued File handler storage outage/);
      assert.equal(published.length, 2);
      assert.deepEqual(await runtime.store.query({ model: asModel(`${APP}.Processed`), authority: 'owner' }), []);
      await mf!.dispose(); mf = undefined;
      state = await open(); runtime = await install();
      await runtime.host.drain();
      assert.deepEqual((await runtime.store.query({ model: asModel(`${APP}.Processed`), authority: 'owner' })).map(row => row.data.label).sort(), ['bundled', 'direct']);
      assert.equal(published.length, 2, 'restart recovers retained intake without another external publication');
      const revision = await runtime.store.readRevision();
      committed(await runtime.invoker.invokeMutation(original, await identity()), 'replayed');
      await runtime.host.drain(); assert.equal(await runtime.store.readRevision(), revision);
      assert.deepEqual(await runtime.store.outboxPending(), []);
      assert.equal(await state.files.canonical!.validate(ref, await identity(), APP), true);
      const pointer = await state.metadataDb.prepare('SELECT json FROM can_files_blobs WHERE ns=? AND id=?')
        .bind(`${APP}/FILES`, blobKeyForFile(ref)).first<{ json: string }>();
      assert.ok(pointer);
      const object = await state.bucket.get((JSON.parse(pointer.json) as { objectKey: string }).objectKey);
      assert.ok(object); assert.deepEqual(new Uint8Array(await object.arrayBuffer()), bytes);
    } finally { await mf?.dispose(); await rm(root, { recursive: true, force: true }); }
  });
