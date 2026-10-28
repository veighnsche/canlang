import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { it } from 'vitest';
import { Miniflare } from 'miniflare';
import type { CompileArtifact } from '@canlang/contracts';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { asId, asModel, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { deriveCsrfToken, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

it('enforces the layered file policy at upload admission', { timeout: 180000 }, async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'can-files-policy-'));
  const runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-15',
    script: 'export default {fetch(){return new Response("ready")}}',
    d1Databases: { DB: 'files-policy' }, r2Buckets: { FILES: 'files-policy' } });
  try {
    const requireNative = createRequire(import.meta.url);
    const { assembleModules } = requireNative(fileURLToPath(new URL('../dist/runtime/modules.js', import.meta.url))) as
      typeof import('../src/runtime/modules.js');
    const { createWorkerFiles } = requireNative(fileURLToPath(new URL('../dist/runtime/worker-files.js', import.meta.url))) as
      typeof import('../src/runtime/worker-files.js');
    // The app declares a narrower policy than the 10MiB baseline: only
    // text/plain, at most 1MiB per file.
    const fixture = join(root, 'packages/cloudflare/test/fixtures/typed-file-journey.can');
    const source = join(directory, 'policy-file-journey.can');
    await writeFile(source, (await readFile(fixture, 'utf8')).replace('app TypedFileJourney\n',
      'app TypedFileJourney\ncontext\n files types="text/plain" max=1MiB\n'));
    const artifact = JSON.parse(execFileSync(process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can'),
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog',
        process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json'), source],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' })) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
      stdlibUrl: new URL('../dist/runtime/stdlib.js', import.meta.url).href,
      uiUrl: pathToFileURL(createRequire(import.meta.url).resolve('@canlang/ui')).href });
    const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const user = await identities.createUser({ email: 'files-policy@example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
    const token = 'files-policy-session';
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
    const store = createMemoryStorage();
    const row = makeRow({ id: asId('policy-entry'), data: { label: 'Uploaded', attachment: null } });
    await store.commit(makeBatch(await store.readRevision(), { writes: [
      { kind: 'insert', model: asModel('TypedFileJourney.Entry'), row },
    ] }));
    const db = await runtime.getD1Database('DB');
    const files = await createWorkerFiles({ artifact, asm, store, identities, clock,
      env: { DB: db, FILES: await runtime.getR2Bucket('FILES') }, origin: 'https://files.test',
      retention: { unattachedHorizonMs: 86400000, retentionMs: 86400000 }, intentTtlMs: 900000 });
    assert.ok(files?.fetch, 'the Files binding must expose its HTTP handler');
    const fetchFiles = files.fetch.bind(files);
    const headers = { 'content-type': 'application/json', cookie: `can_session=${token}`,
      'x-csrf-token': await deriveCsrfToken(token) };
    const body = { upload_id: 'policy-one', operation: 'TypedFileJourney.attach', field: '/attachment',
      arguments: { entry: { id: row.id, version: String(row.version) } }, name: 'policy.txt', type: 'text/plain', size: '5' };
    const intent = (input: unknown) => fetchFiles(new Request(files.intentsUrl!,
      { method: 'POST', headers, body: JSON.stringify(input) }));

    // App override: 2MiB clears the 10MiB baseline but exceeds the
    // declared 1MiB — refused as a quota limit.
    const overApp = await intent({ ...body, upload_id: 'policy-over-app', size: '2097152' });
    assert.equal(overApp.status, 429, await overApp.clone().text());
    assert.equal(((await overApp.json()) as { code: string }).code, 'limit');

    // Deployment cap: a 512-byte deployment limit refuses a 513-byte
    // intent the app policy would admit.
    const capped = await createWorkerFiles({ artifact, asm, store, identities, clock,
      env: { DB: db, FILES: await runtime.getR2Bucket('FILES') }, origin: 'https://files.test',
      retention: { unattachedHorizonMs: 86400000, retentionMs: 86400000 }, intentTtlMs: 900000,
      limits: { maxBytes: 512 } });
    assert.ok(capped?.fetch);
    const cappedIntent = (input: unknown) => capped.fetch!(new Request(capped.intentsUrl!,
      { method: 'POST', headers, body: JSON.stringify(input) }));
    const overCap = await cappedIntent({ ...body, upload_id: 'policy-over-cap', size: '513' });
    assert.equal(overCap.status, 429, await overCap.clone().text());
    assert.equal(((await overCap.json()) as { code: string }).code, 'limit');
    const underCap = await cappedIntent({ ...body, upload_id: 'policy-under-cap', size: '5' });
    assert.equal(underCap.status, 200, await underCap.clone().text());

    // Granted within both, then the declared content-type allowlist
    // bites: detected PNG bytes are not text/plain, so the append
    // that completes the declared size is rejected as validation.
    const granted = await intent({ ...body, upload_id: 'policy-png', size: '8' });
    assert.equal(granted.status, 200, await granted.clone().text());
    const grant = await granted.json() as { intent_id: string; content: string; finalize: string };
    const appended = await fetchFiles(new Request(grant.content, { method: 'PUT',
      headers: { ...headers, 'upload-offset': '0' }, body: PNG_MAGIC }));
    assert.equal(appended.status, 400, await appended.clone().text());
    assert.equal(((await appended.json()) as { code: string }).code, 'validation');

    // Control: text bytes finalize cleanly under the same policy.
    const textGranted = await intent({ ...body, upload_id: 'policy-text', size: '9' });
    assert.equal(textGranted.status, 200, await textGranted.clone().text());
    const textGrant = await textGranted.json() as { content: string; finalize: string };
    const textAppended = await fetchFiles(new Request(textGrant.content, { method: 'PUT',
      headers: { ...headers, 'upload-offset': '0' }, body: 'plaintext' }));
    assert.equal(textAppended.status, 200, await textAppended.clone().text());
    const textDigest = `sha256:${createHash('sha256').update('plaintext').digest('hex')}`;
    const textFinalized = await fetchFiles(new Request(textGrant.finalize, { method: 'POST', headers,
      body: JSON.stringify({ upload_id: 'policy-text', bytes_digest: textDigest }) }));
    assert.equal(textFinalized.status, 200, await textFinalized.clone().text());
    assert.ok(await textFinalized.json());
  } finally {
    await runtime.dispose();
  }
});
