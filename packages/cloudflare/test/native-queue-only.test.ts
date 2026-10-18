/** Model-free resource applications still use their actual selected State owner. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { CompileArtifact } from '@canlang/contracts';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1IdentityStore, ensureIdentitySchema, sha256HexText, deriveCsrfToken } from '@canlang/identity';
import { mintOperationId } from '@canlang/ui';
import { distribution } from '@canlang/values/distribution';
import { captureSingleFileSource } from '../dist/runtime/native-dev.test-support.js';
import { localPreviewActivationVerdict } from '../dist/runtime/native-preview.test-support.js';
const require = createRequire(import.meta.url);

test('model-free queue commits and replays in configured team State; unsupported global profile refuses precisely', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-queue-only-'));
  const source = await readFile(resolve('packages/cloudflare/test/fixtures/native-queue-only.can'), 'utf8');
  const { buildDeployBundle, DEPLOY_MAIN_MODULE } = await import(require.resolve('@canlang/cloudflare/deploy/bundle')) as typeof import('../src/deploy/bundle.js');
  const compiler = process.env.CAN_TEST_COMPILER ?? resolve('compiler/target/debug/can');
  let mf: Miniflare | undefined;
  try {
    for (const audience of ['members', 'public'] as const) {
      const fixture = join(dir, `${audience}.can`);
      await writeFile(fixture, source.replace('by=members', `by=${audience}`));
      const { stdout } = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts',
        `--catalog=${fileURLToPath(distribution.catalog)}`, fixture], { maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      assert.equal((artifact.models ?? []).length, 0);
      const bundle = buildDeployBundle(artifact, { verdict: { active: true } });
      const databases = { DB: `${audience}-identity`, TEAM_DB: `${audience}-team` };
      const persistence = join(dir, audience);
      mf = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default {fetch(){return new Response(null,{status:404})}}',
        d1Databases: databases, d1Persist: persistence });
      const identityDb = await mf.getD1Database('DB') as unknown as D1Database;
      await ensureIdentitySchema(identityDb);
      const identities = createD1IdentityStore(identityDb);
      const team = await identities.createTeam({});
      const user = await identities.createUser({ email: `${audience}@queue-only.test`, password_hash: 'unused', email_verified: true });
      await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText('session'),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(), last_team_id: team.team_id });
      await mf.setOptions({ compatibilityDate: '2026-07-15', modulesRoot: '/',
        modules: [DEPLOY_MAIN_MODULE, ...Object.keys(bundle.modules).filter(path => path !== DEPLOY_MAIN_MODULE)].map(path => ({
          type: 'ESModule' as const, path: `/${path}`, contents: bundle.modules[path]!,
        })), d1Databases: databases, d1Persist: persistence,
        bindings: { CAN_LOCAL_QUEUE_BINDINGS: { jobs: 'QueueOnly.Jobs' },
          ...(audience === 'members' ? { CAN_STATE_OWNERS: { version: 1,
            owners: [{ owner: team.team_id, binding: 'TEAM_DB', initializeFresh: true }] } } : {}) },
        queueProducers: { 'QueueOnly.Jobs': 'jobs' }, queueConsumers: { jobs: { maxBatchSize: 1, maxBatchTimeout: 0, retryDelay: 0 } },
      });
      const submit = async (authenticated: boolean, operationId: string) => {
        const response = await mf!.dispatchFetch('http://app.test/api/operations/QueueOnly.submit', { method: 'POST', headers: {
          'content-type': 'application/json', ...(authenticated ? { cookie: 'can_session=session',
            'x-csrf-token': await deriveCsrfToken('session') } : {}),
        }, body: JSON.stringify({ operation_id: operationId, inputs: { title: 'Queued' } }) });
        return { status: response.status, body: await response.json() as Record<string, any> };
      };
      if (audience === 'public') {
        const anonymous = await submit(false, mintOperationId());
        const authenticated = await submit(true, mintOperationId());
        for (const result of [anonymous, authenticated]) {
          assert.equal(result.status, 500, JSON.stringify(result));
          assert.equal(result.body.code, 'deploy-join-missing');
          assert.match(result.body.message, /Model-free resource applications require an explicitly configured team State owner/);
        }
        const db = await mf.getD1Database('DB') as unknown as D1Database;
        assert.equal((await db.prepare('SELECT id FROM records').all()).results.length, 0, 'Refused global scope commits no resource work.');
        await mf.dispose(); mf = undefined;
        continue;
      }
      const operationId = mintOperationId(), authenticated = true;
      const first = await submit(authenticated, operationId);
      assert.equal(first.status, 200, JSON.stringify({ audience, first }));
      const ownerDb = await mf.getD1Database(audience === 'members' ? 'TEAM_DB' : 'DB') as unknown as D1Database;
      let handlers: Record<string, unknown>[] = [];
      for (let attempt = 0; attempt < 100; attempt++) {
        handlers = (await ownerDb.prepare("SELECT data FROM records WHERE model='work.handler_occurrence'").all<Record<string, unknown>>()).results;
        if (handlers.length === 1 && JSON.parse(handlers[0]!.data as string).state === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(handlers.length, 1, JSON.stringify({ audience, handlers }));
      const handler = JSON.parse(handlers[0]!.data as string) as Record<string, unknown>;
      assert.equal(handler.state, 'completed', JSON.stringify(handler));
      assert.equal(handler.scopeOwner, audience === 'members' ? team.team_id : 'app');
      const replayed = await submit(authenticated, operationId);
      assert.equal(replayed.status, 200, JSON.stringify({ audience, replayed }));
      assert.equal(replayed.body.status, 'replayed');
      assert.equal((await ownerDb.prepare("SELECT id FROM records WHERE model='work.handler_occurrence'").all()).results.length, 1);
      if (audience === 'members') {
        const db = await mf.getD1Database('DB') as unknown as D1Database;
        assert.equal((await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").all()).results.length, 0);
      }
      await mf.dispose(); mf = undefined;
    }
  } finally { await mf?.dispose(); await rm(dir, { recursive: true, force: true }); }
});


test('preview activation accepts the exact recovery snapshot and refuses a different digest', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'can-queue-preview-snapshot-'));
  let mf: Miniflare | undefined;
  try {
    const fixture = join(dir, 'QueueOnly.can');
    await writeFile(fixture, await readFile(resolve('packages/cloudflare/test/fixtures/native-queue-only.can'), 'utf8'));
    const compiler = process.env.CAN_TEST_COMPILER ?? resolve('compiler/target/debug/can');
    const { stdout } = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts',
      `--catalog=${fileURLToPath(distribution.catalog)}`, fixture], { maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const { buildDeployBundle, DEPLOY_MAIN_MODULE } = await import(require.resolve('@canlang/cloudflare/deploy/bundle')) as typeof import('../src/deploy/bundle.js');
    const bundle = buildDeployBundle(artifact, { verdict: { active: true } });
    const databases = { DB: 'preview-identity', TEAM_DB: 'preview-team' }, persistence = join(dir, 'd1');
    mf = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
      script: 'export default {fetch(){return new Response(null,{status:404})}}', d1Databases: databases, d1Persist: persistence });
    const identityDb = await mf.getD1Database('DB') as unknown as D1Database;
    await ensureIdentitySchema(identityDb);
    const team = await createD1IdentityStore(identityDb).createTeam({});
    await mf.setOptions({ compatibilityDate: '2026-07-15', modulesRoot: '/',
      modules: [DEPLOY_MAIN_MODULE, ...Object.keys(bundle.modules).filter(path => path !== DEPLOY_MAIN_MODULE)].map(path => ({
        type: 'ESModule' as const, path: `/${path}`, contents: bundle.modules[path]!,
      })), d1Databases: databases, d1Persist: persistence,
      bindings: { CAN_LOCAL_QUEUE_BINDINGS: { jobs: 'QueueOnly.Jobs' }, CAN_STATE_OWNERS: { version: 1,
        owners: [{ owner: team.team_id, binding: 'TEAM_DB', initializeFresh: true }] } },
      queueProducers: { 'QueueOnly.Jobs': 'jobs' }, queueConsumers: { jobs: { maxBatchSize: 1, maxBatchTimeout: 0, retryDelay: 0 } },
    });
    // Recovery can install the genuine native snapshot before the preview
    // host confirms activation. Both producers must use the same digest.
    const worker = await mf.getWorker();
    assert.equal((await worker.scheduled({ scheduledTime: new Date(), cron: 'can-resource-recovery' })).outcome, 'ok');
    const ownerDb = await mf.getD1Database('TEAM_DB') as unknown as D1Database;
    const currentIdentityDb = await mf.getD1Database('DB') as unknown as D1Database;
    const snapshot = await ownerDb.prepare('SELECT digest FROM snapshots WHERE owner = ?').bind('QueueOnly').first<{ digest: string }>();
    assert.ok(snapshot);
    assert.match(snapshot.digest, /^sha256:[a-f0-9]{64}$/);
    const capture = await captureSingleFileSource({ checkoutRoot: dir, appPath: fixture,
      profile: 'local-d1-identity', compilerPath: compiler, catalogPath: fileURLToPath(distribution.catalog),
      helpIndexPath: resolve('docs/specification/CONSTRUCT-HELP.md'),
      packageInputPaths: [{ name: 'cloudflare', path: require.resolve('@canlang/cloudflare/deploy/bundle') }] });
    const verdict = await localPreviewActivationVerdict(artifact, capture, ownerDb, databases.TEAM_DB, team.team_id, currentIdentityDb);
    assert.equal(verdict.active, true, JSON.stringify(verdict));
    const differentDigest = `sha256:${'0'.repeat(64)}`;
    await ownerDb.prepare('UPDATE snapshots SET digest = ? WHERE owner = ?').bind(differentDigest, 'QueueOnly').run();
    const mismatch = await localPreviewActivationVerdict(artifact, capture, ownerDb, databases.TEAM_DB, team.team_id, currentIdentityDb);
    assert.equal(mismatch.active, false);
    if (!mismatch.active) assert.ok(mismatch.reasons.some(reason => reason.code === 'digest-mismatch'), JSON.stringify(mismatch));
    assert.equal(await ownerDb.prepare('SELECT digest FROM snapshots WHERE owner = ?').bind('QueueOnly').first('digest'), differentDigest);
  } finally { await mf?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
