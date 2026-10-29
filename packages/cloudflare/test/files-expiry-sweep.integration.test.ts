import assert from 'node:assert/strict';
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

it('expires composed intents with staging disposal and idempotent resume', { timeout: 180000 }, async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'can-files-expire-'));
  const runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-15',
    script: 'export default {fetch(){return new Response("ready")}}',
    d1Databases: { DB: 'files-expire' }, r2Buckets: { FILES: 'files-expire' } });
  try {
    const requireNative = createRequire(import.meta.url);
    const { assembleModules } = requireNative(fileURLToPath(new URL('../dist/runtime/modules.js', import.meta.url))) as
      typeof import('../src/runtime/modules.js');
    const { createWorkerFiles } = requireNative(fileURLToPath(new URL('../dist/runtime/worker-files.js', import.meta.url))) as
      typeof import('../src/runtime/worker-files.js');
    const fixture = join(root, 'packages/cloudflare/test/fixtures/typed-file-journey.can');
    const source = join(directory, 'expire-file-journey.can');
    await writeFile(source, await readFile(fixture, 'utf8'));
    const artifact = JSON.parse(execFileSync(process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can'),
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog',
        process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json'), source],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' })) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
      stdlibUrl: new URL('../dist/runtime/stdlib.js', import.meta.url).href,
      uiUrl: pathToFileURL(createRequire(import.meta.url).resolve('@canlang/ui')).href });
    const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const user = await identities.createUser({ email: 'owner@example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
    const token = 'files-expire-owner';
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
    const headers = { 'content-type': 'application/json', cookie: `can_session=${token}`,
      'x-csrf-token': await deriveCsrfToken(token) };
    const store = createMemoryStorage();
    const row = makeRow({ id: asId('expire-entry'), data: { label: 'E', attachment: null } });
    await store.commit(makeBatch(await store.readRevision(), { writes: [
      { kind: 'insert', model: asModel('TypedFileJourney.Entry'), row },
    ] }));
    const db = await runtime.getD1Database('DB');
    const bucket = await runtime.getR2Bucket('FILES');
    const openFiles = () => createWorkerFiles({ artifact, asm, store, identities, clock,
      env: { DB: db, FILES: bucket }, origin: 'https://files.test',
      retention: { unattachedHorizonMs: 86400000, retentionMs: 86400000 }, intentTtlMs: 900000 });
    const files = await openFiles();
    assert.ok(files?.fetch);
    const fetchFiles = files.fetch.bind(files);
    const intentBody = (upload_id: string, size: string) => ({ upload_id,
      operation: 'TypedFileJourney.attach', field: '/attachment',
      arguments: { entry: { id: row.id, version: String(row.version) } },
      name: 'expire.txt', type: 'text/plain', size });
    const intent = (input: unknown) => fetchFiles(new Request(files.intentsUrl!,
      { method: 'POST', headers, body: JSON.stringify(input) }));
    const namespace = 'TypedFileJourney/FILES';
    const intentState = async (retryId: string) =>
      (await db.prepare('SELECT json FROM can_files_intents WHERE ns=? AND retry_id=?')
        .bind(namespace, retryId).first<{ json: string }>());
    const stagingPointer = async (intentId: string) =>
      (await db.prepare('SELECT json FROM can_files_blobs WHERE ns=? AND id=?')
        .bind(namespace, `u_${intentId}.part`).first<{ json: string }>());

    // One open intent with partial staging, one completed intent with
    // full staging: both must expire without any request touching them.
    const grantedOpen = await intent(intentBody('expire-open', '11'));
    assert.equal(grantedOpen.status, 200, await grantedOpen.clone().text());
    const grantOpen = await grantedOpen.json() as { intent_id: string; content: string; finalize: string };
    const putOpen = await fetchFiles(new Request(grantOpen.content, { method: 'PUT',
      headers: { ...headers, 'upload-offset': '0' }, body: 'part' }));
    assert.equal(putOpen.status, 200, await putOpen.clone().text());
    assert.equal(((await putOpen.json()) as { complete: boolean }).complete, false);
    const grantedComplete = await intent(intentBody('expire-complete', '7'));
    assert.equal(grantedComplete.status, 200, await grantedComplete.clone().text());
    const grantComplete = await grantedComplete.json() as { intent_id: string; content: string; finalize: string };
    const putComplete = await fetchFiles(new Request(grantComplete.content, { method: 'PUT',
      headers: { ...headers, 'upload-offset': '0' }, body: 'sevenb!' }));
    assert.equal(putComplete.status, 200, await putComplete.clone().text());
    assert.equal(((await putComplete.json()) as { complete: boolean }).complete, true);
    assert.equal((JSON.parse((await intentState('expire-open'))!.json) as { state: string }).state, 'open');
    assert.equal((JSON.parse((await intentState('expire-complete'))!.json) as { state: string }).state, 'complete');
    const pointerOpen = await stagingPointer(grantOpen.intent_id);
    const pointerComplete = await stagingPointer(grantComplete.intent_id);
    assert.ok(pointerOpen);
    assert.ok(pointerComplete);
    const objectOpen = (JSON.parse(pointerOpen.json) as { objectKey: string }).objectKey;
    const objectComplete = (JSON.parse(pointerComplete.json) as { objectKey: string }).objectKey;
    assert.ok(await bucket.get(objectOpen));
    assert.ok(await bucket.get(objectComplete));

    // Past the TTL, a reopen runs the owning consumer: both intents
    // expire and staging rows drop; the bytes retire through the
    // publication journal for a later cleanup page to delete.
    clock.advance(900001);
    const reopened = await openFiles();
    assert.ok(reopened?.fetch);
    assert.equal((JSON.parse((await intentState('expire-open'))!.json) as { state: string }).state, 'expired');
    assert.equal((JSON.parse((await intentState('expire-complete'))!.json) as { state: string }).state, 'expired');
    assert.equal(await stagingPointer(grantOpen.intent_id), null);
    assert.equal(await stagingPointer(grantComplete.intent_id), null);
    const journals = await db.prepare('SELECT retired FROM can_files_publications WHERE ns=? AND state=?')
      .bind(namespace, 'committed').all<{ retired: string }>();
    const retired = journals.results.flatMap(entry => JSON.parse(entry.retired) as string[]);
    assert.ok(retired.includes(objectOpen));
    assert.ok(retired.includes(objectComplete));

    // Expired grants hide their existence, and a second sweep page is
    // a no-op: no rows change, nothing errors.
    const fetchReopened = reopened.fetch.bind(reopened);
    const putLate = await fetchReopened(new Request(grantOpen.content, { method: 'PUT',
      headers: { ...headers, 'upload-offset': '4' }, body: 'ialbulk!' }));
    assert.equal(putLate.status, 404, await putLate.clone().text());
    const finalizeLate = await fetchReopened(new Request(grantComplete.finalize, { method: 'POST', headers,
      body: JSON.stringify({ upload_id: 'expire-complete', bytes_digest: 'sha256:dead' }) }));
    assert.equal(finalizeLate.status, 404, await finalizeLate.clone().text());
    // Stay inside the test session (one hour) while moving the
    // cleanup horizon well past the sweep journal.
    clock.advance(1800000);
    const resumed = await openFiles();
    assert.ok(resumed?.fetch);
    assert.equal((JSON.parse((await intentState('expire-open'))!.json) as { state: string }).state, 'expired');
    assert.equal((JSON.parse((await intentState('expire-complete'))!.json) as { state: string }).state, 'expired');
    // The resumed construction cleanup reclaims the retired bytes.
    assert.equal(await bucket.get(objectOpen), null);
    assert.equal(await bucket.get(objectComplete), null);

    // Fresh work after expiry still journeys end to end.
    const fetchResumed = resumed.fetch.bind(resumed);
    const grantedFresh = await fetchResumed(new Request(resumed.intentsUrl!,
      { method: 'POST', headers, body: JSON.stringify(intentBody('expire-fresh', '5')) }));
    assert.equal(grantedFresh.status, 200, await grantedFresh.clone().text());
    const grantFresh = await grantedFresh.json() as { content: string; finalize: string };
    const putFresh = await fetchResumed(new Request(grantFresh.content, { method: 'PUT',
      headers: { ...headers, 'upload-offset': '0' }, body: 'fresh' }));
    assert.equal(putFresh.status, 200, await putFresh.clone().text());
    const { createHash } = await import('node:crypto');
    const digestFresh = `sha256:${createHash('sha256').update('fresh').digest('hex')}`;
    const doneFresh = await fetchResumed(new Request(grantFresh.finalize, { method: 'POST', headers,
      body: JSON.stringify({ upload_id: 'expire-fresh', bytes_digest: digestFresh }) }));
    assert.equal(doneFresh.status, 200, await doneFresh.clone().text());
    assert.ok(((await doneFresh.json()) as { file: string }).file);
  } finally {
    await runtime.dispose();
  }
});
