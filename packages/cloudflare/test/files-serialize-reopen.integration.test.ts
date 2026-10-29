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

const CONCURRENCY = 10;

it('serializes same-intent publication across owners, interruption and reopen', { timeout: 180000 }, async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'can-files-serialize-'));
  const runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-15',
    script: 'export default {fetch(){return new Response("ready")}}',
    d1Databases: { DB: 'files-serialize' }, r2Buckets: { FILES: 'files-serialize' } });
  try {
    const requireNative = createRequire(import.meta.url);
    const { assembleModules } = requireNative(fileURLToPath(new URL('../dist/runtime/modules.js', import.meta.url))) as
      typeof import('../src/runtime/modules.js');
    const { createWorkerFiles } = requireNative(fileURLToPath(new URL('../dist/runtime/worker-files.js', import.meta.url))) as
      typeof import('../src/runtime/worker-files.js');
    const fixture = join(root, 'packages/cloudflare/test/fixtures/typed-file-journey.can');
    const source = join(directory, 'serialize-file-journey.can');
    await writeFile(source, await readFile(fixture, 'utf8'));
    const artifact = JSON.parse(execFileSync(process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can'),
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog',
        process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json'), source],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' })) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
      stdlibUrl: new URL('../dist/runtime/stdlib.js', import.meta.url).href,
      uiUrl: pathToFileURL(createRequire(import.meta.url).resolve('@canlang/ui')).href });
    const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
    const setupOwner = async (tag: string) => {
      const team = await identities.createTeam({ timezone: 'UTC' });
      const user = await identities.createUser({ email: `${tag}@example.test`, password_hash: 'unused', email_verified: true });
      await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
      const token = `files-serialize-${tag}`;
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
      return { 'content-type': 'application/json', cookie: `can_session=${token}`,
        'x-csrf-token': await deriveCsrfToken(token) };
    };
    const headersA = await setupOwner('owner-a');
    const headersB = await setupOwner('owner-b');
    const store = createMemoryStorage();
    const rowA = makeRow({ id: asId('serialize-entry-a'), data: { label: 'A', attachment: null } });
    const rowB = makeRow({ id: asId('serialize-entry-b'), data: { label: 'B', attachment: null } });
    await store.commit(makeBatch(await store.readRevision(), { writes: [
      { kind: 'insert', model: asModel('TypedFileJourney.Entry'), row: rowA },
      { kind: 'insert', model: asModel('TypedFileJourney.Entry'), row: rowB },
    ] }));
    const db = await runtime.getD1Database('DB');
    const bucket = await runtime.getR2Bucket('FILES');
    const openFiles = () => createWorkerFiles({ artifact, asm, store, identities, clock,
      env: { DB: db, FILES: bucket }, origin: 'https://files.test',
      retention: { unattachedHorizonMs: 86400000, retentionMs: 86400000 }, intentTtlMs: 900000 });
    const files = await openFiles();
    assert.ok(files?.fetch);
    const fetchFiles = files.fetch.bind(files);
    const intentBody = (row: typeof rowA, upload_id: string, size: string) => ({ upload_id,
      operation: 'TypedFileJourney.attach', field: '/attachment',
      arguments: { entry: { id: row.id, version: String(row.version) } },
      name: 'serial.txt', type: 'text/plain', size });
    const intent = (input: unknown, withHeaders = headersA) => fetchFiles(new Request(files.intentsUrl!,
      { method: 'POST', headers: withHeaders, body: JSON.stringify(input) }));

    // Concurrent same-retry-identity intents converge: every caller
    // gets the identical grant, one intent row exists, nobody 500s on
    // the uniqueness race.
    const race = await Promise.all(Array.from({ length: CONCURRENCY }, () =>
      intent(intentBody(rowA, 'serial-race', '11'))));
    for (const response of race) assert.equal(response.status, 200, await response.clone().text());
    const grants = await Promise.all(race.map(response => response.json())) as { intent_id: string }[];
    for (const grant of grants) assert.equal(grant.intent_id, grants[0]!.intent_id);
    assert.equal((await db.prepare(
      "SELECT COUNT(*) AS count FROM can_files_intents WHERE ns=? AND retry_id=?")
      .bind('TypedFileJourney/FILES', 'serial-race').first<{ count: number }>())?.count, 1);

    // Owner B's independent intent is unaffected by A's race.
    const grantedB = await intent(intentBody(rowB, 'serial-b', '7'), headersB);
    assert.equal(grantedB.status, 200, await grantedB.clone().text());
    const grantB = await grantedB.json() as { content: string; finalize: string };

    // Content, then concurrent same-intent finalizes: one publication,
    // every caller reads the same immutable ref.
    const grantA = grants[0]! as unknown as { content: string; finalize: string };
    const putA = await fetchFiles(new Request(grantA.content, { method: 'PUT',
      headers: { ...headersA, 'upload-offset': '0' }, body: 'elevenbulks' }));
    assert.equal(putA.status, 200, await putA.clone().text());
    assert.equal(((await putA.json()) as { complete: boolean }).complete, true);
    const digestA = `sha256:${createHash('sha256').update('elevenbulks').digest('hex')}`;
    const finals = await Promise.all(Array.from({ length: CONCURRENCY }, () =>
      fetchFiles(new Request(grantA.finalize, { method: 'POST', headers: headersA,
        body: JSON.stringify({ upload_id: 'serial-race', bytes_digest: digestA }) }))));
    for (const response of finals) assert.equal(response.status, 200, await response.clone().text());
    const finished = await Promise.all(finals.map(response => response.json())) as { file: string }[];
    for (const done of finished) assert.equal(done.file, finished[0]!.file);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM can_files_finalized WHERE ns=? AND id=?')
      .bind('TypedFileJourney/FILES', finished[0]!.file).first<{ count: number }>())?.count, 1);
    // Repeat after settlement returns the same immutable ref.
    const repeated = await fetchFiles(new Request(grantA.finalize, { method: 'POST', headers: headersA,
      body: JSON.stringify({ upload_id: 'serial-race', bytes_digest: digestA }) }));
    assert.equal(repeated.status, 200, await repeated.clone().text());
    assert.equal(((await repeated.json()) as { file: string }).file, finished[0]!.file);

    // Cross-owner: B finalizing A's intent hides its existence.
    const foreign = await fetchFiles(new Request(grantA.finalize, { method: 'POST', headers: headersB,
      body: JSON.stringify({ upload_id: 'serial-race', bytes_digest: digestA }) }));
    assert.equal(foreign.status, 404, await foreign.clone().text());

    // Owner B completes independently with byte-identical recovery.
    const putB = await fetchFiles(new Request(grantB.content, { method: 'PUT',
      headers: { ...headersB, 'upload-offset': '0' }, body: 'sevenb!' }));
    assert.equal(putB.status, 200, await putB.clone().text());
    const digestB = `sha256:${createHash('sha256').update('sevenb!').digest('hex')}`;
    const doneB = await fetchFiles(new Request(grantB.finalize, { method: 'POST', headers: headersB,
      body: JSON.stringify({ upload_id: 'serial-b', bytes_digest: digestB }) }));
    assert.equal(doneB.status, 200, await doneB.clone().text());
    const refB = ((await doneB.json()) as { file: string }).file;
    const pointerB = await db.prepare('SELECT json FROM can_files_blobs WHERE ns=? AND id=?')
      .bind('TypedFileJourney/FILES', `f_${refB}.bin`).first<{ json: string }>();
    assert.ok(pointerB);
    const objectB = await bucket.get((JSON.parse(pointerB.json) as { objectKey: string }).objectKey);
    assert.equal(await objectB!.text(), 'sevenb!');

    // Interruption, crafted deterministically: a prepared journal row
    // with an orphaned R2 object, as a crash after R2 staging but
    // before the D1 commit would leave it.
    const namespace = 'TypedFileJourney/FILES';
    const prefix = `can-files/v1/sha256:${createHash('sha256').update(namespace).digest('hex')}/`;
    const orphanKey = `${prefix}stale-token/u_stale-intent.part`;
    await bucket.put(orphanKey, new TextEncoder().encode('orphaned'));
    await db.batch([db.prepare(
      'INSERT INTO can_files_publications(ns,id,created,state,objects,retired) VALUES (?,?,?,\'prepared\',?,?)')
      .bind(namespace, 'stale-token', now - 2 * 900000, JSON.stringify([orphanKey]), JSON.stringify([]))]);

    // Reopen over the same stores: construction cleanup reclaims the
    // orphan and aborts the stale journal; both owners resume cleanly.
    const reopened = await openFiles();
    assert.ok(reopened?.fetch);
    assert.equal(await bucket.get(orphanKey), null);
    assert.equal((await db.prepare('SELECT state FROM can_files_publications WHERE ns=? AND id=?')
      .bind(namespace, 'stale-token').first<{ state: string }>())?.state, 'aborted');
    const fetchReopened = reopened.fetch.bind(reopened);
    const afterReopen = await fetchReopened(new Request(reopened.intentsUrl!,
      { method: 'POST', headers: headersA, body: JSON.stringify(intentBody(rowA, 'serial-after', '4')) }));
    assert.equal(afterReopen.status, 200, await afterReopen.clone().text());
    const grantAfter = await afterReopen.json() as { content: string; finalize: string };
    const putAfter = await fetchReopened(new Request(grantAfter.content, { method: 'PUT',
      headers: { ...headersA, 'upload-offset': '0' }, body: 'four' }));
    assert.equal(putAfter.status, 200, await putAfter.clone().text());
    const digestAfter = `sha256:${createHash('sha256').update('four').digest('hex')}`;
    const doneAfter = await fetchReopened(new Request(grantAfter.finalize, { method: 'POST', headers: headersA,
      body: JSON.stringify({ upload_id: 'serial-after', bytes_digest: digestAfter }) }));
    assert.equal(doneAfter.status, 200, await doneAfter.clone().text());
    // B's settled file still reads back byte-identical after reopen.
    const objectBAfter = await bucket.get((JSON.parse(pointerB.json) as { objectKey: string }).objectKey);
    assert.equal(await objectBAfter!.text(), 'sevenb!');
  } finally {
    await runtime.dispose();
  }
});
