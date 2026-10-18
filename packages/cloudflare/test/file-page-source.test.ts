/** Genuine compiled page File consumer, physical receiver and originating credentials. */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { MutationEnvelope, ProjectedRecord, ReceiptIdentity, PageDescriptor, PageReadScope, FileValue, PresentationContext } from '@canlang/contracts';
import type { UploadDeps, PageHttpDeps } from '@canlang/interfaces';
import { handlePageRequest, resolveRequestIdentity, buildPageSourceContext } from '@canlang/interfaces';
import { distribution } from '@canlang/values/distribution';
import { createD1OwnerRouter } from '@canlang/state/storage/owner-router';
import { ensureSchema } from '@canlang/state/storage/d1';
import { hashInputs } from '@canlang/state/invocation/replay';
import { asId, asModel, asOperation, asOperationId, FIXED_NOW, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity, buildSessionCookie, sha256HexText } from '@canlang/identity';
import { createSqliteFileBindings, createSqliteFileStore, type SqliteFileStore } from '@canlang/files/host/sqlite';
import { blobKeyForFile } from '@canlang/files/finalize';
import { sha256Hex, stagingKeyForIntent } from '@canlang/files/upload';
import { createFileJourneyKernel } from '@canlang/interfaces/uploads/kernel';

const root = resolve('.'), APP = 'FileCollectionDownload', MODEL = asModel(`${APP}.Entry`);
const A_BYTES = new TextEncoder().encode('%PDF-1.4\nCollection A actual bytes\ntrailer\n');
const PNG_BYTES = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR2kAAAAASUVORK5CYII=', 'base64'));
const JPEG_BYTES = new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCfAAX/2Q==', 'base64'));
const B_BYTES = new TextEncoder().encode('%PDF-1.4\nCollection B actual bytes\ntrailer\n');
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
async function tables(db: D1Database) {
  const names = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name")
    .all<{ name: string }>();
  assert.equal(names.success, true);
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const { name } of names.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true);
    result[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
test('original compiled File[] text binds only current original page occurrences', async () => {
  const sourcePolicy = true;
  const fixture = join(root, 'packages/cloudflare/test/fixtures/file-page-source.can');
  // Source-only File grants currently participate in independent canonical
  // reads, not mutation-result disclosure. The stored wire remains complete;
  // the source fixture's mutation result must expose its ordinary label only.
  const mutationProjection = (data: ProjectedRecord['data']) => sourcePolicy ? { label: data.label } : data;
  // The installed Node loader preserves genuine own-data producer metadata.
  const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
  const { prepareLocalPreviewCapture } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
  const { captureSingleFileSource, captureIsCurrent, verifyCompilerSources } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
  const { compileCapturedSingleFile } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
  const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
  const { assembleWorker, buildInvoker, createTeamOwnerStorageBoundary } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
  const { createBoundFileHandler, createCanonicalFileBinding, createBoundFileReadResolver } = await nodeImport(installed('runtime/bound-files.js')) as typeof import('../src/runtime/bound-files.js');
  const { createPageReadScopeCanonical } = await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
  const compiler = join(root, 'compiler/target/debug/can'), catalog = new URL(distribution.catalog);
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const paths = [fixture, compiler, catalog];
  const hashes = await Promise.all(paths.map(async path => digest(await readFile(path))));
  const dir = await mkdtemp(join(tmpdir(), 'can-file-collection-'));
  let worker: Miniflare | undefined, physical: SqliteFileStore | undefined, sequence = 0;
  let now = FIXED_NOW;
  const clock = { nowMs: () => now };
  let gate: { started: Promise<void>; begin(): void; released: Promise<void>; release(): void } | undefined;
  const hold = () => {
    let begin!: () => void, release!: () => void;
    const started = new Promise<void>(done => { begin = done; });
    const released = new Promise<void>(done => { release = done; });
    return { started, begin, released, release };
  };
  const nextId = () => asOperationId(uuidv7(FIXED_NOW, ++sequence));
  try {
    const capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root, appPath: fixture,
      compilerPath: compiler, catalogPath: fileURLToPath(catalog), helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
    assert.equal(await captureIsCurrent(capture), true);
    const compiled = await compileCapturedSingleFile(capture);
    assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics'
      ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
    if (compiled.kind !== 'artifact') throw new Error('The actual required File collection source did not compile.');
    const artifact = compiled.artifact;
    assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
    assert.equal(artifact.pages.length, 1);
    assert.equal(artifact.sources.find(source => resolve(source.path) === fixture)?.sha256, hashes[0]);
    const field = artifact.models?.find(model => model.name === MODEL)?.fields.find(value => value.name === 'attachments');
    assert.ok(field); assert.equal(field.field.kind, 'file'); assert.equal(field.array?.required, true);
    assert.equal(field.valueType, 'file[]!'); assert.equal(field.required, true);
    for (const kind of ['create', 'update'] as const) {
      const input = artifact.operations?.find(operation => operation.name === `${MODEL}.${kind}`)?.inputs.fields
        .find(value => value.name === 'attachments');
      assert.ok(input); assert.equal(input.field.kind, 'file'); assert.equal(input.array?.required, true);
      assert.equal(input.valueType, 'file[]!'); assert.equal(input.required, kind === 'create');
    }
    for (const [name, type, nullable] of [['ordinary', 'file[]', false], ['nullable', 'file[]?', true]] as const) {
      const field = artifact.models!.find(model => model.name === MODEL)!.fields.find(field => field.name === name);
      assert.ok(field); assert.equal(field.field.kind, 'file'); assert.equal(field.valueType, type);
      assert.equal(field.required, false); assert.equal(field.array?.required, false);
      assert.equal(field.nullable === true, nullable);
      for (const kind of ['create', 'update'] as const) {
        const input = artifact.operations!.find(operation => operation.name === `${MODEL}.${kind}`)!.inputs.fields
          .find(field => field.name === name);
        assert.ok(input); assert.equal(input.field.kind, 'file'); assert.equal(input.valueType, type);
        assert.equal(input.required, false); assert.equal(input.array?.required, false);
        assert.equal(input.nullable === true, nullable);
      }
    }
    const asm = await assembleModules({ artifact, sourcePath: fixture }, { workDir: join(dir, 'modules'),
      stdlibUrl: installed('runtime/stdlib.js'), uiUrl: pathToFileURL(createRequire(import.meta.url).resolve('@canlang/ui')).href });
    worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: { IDENTITY: 'collection-identity', A: 'collection-owner-a', B: 'collection-owner-b' }, d1Persist: join(dir, 'd1') });
    const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
    const a = await worker.getD1Database('A') as unknown as D1Database, b = await worker.getD1Database('B') as unknown as D1Database;
    await ensureIdentitySchema(identityDb); await ensureSchema(a); await ensureSchema(b);
    const identities = createD1IdentityStore(identityDb, { clock });
    const teamA = await identities.createTeam({ timezone: 'UTC' }), teamB = await identities.createTeam({ timezone: 'UTC' });
    const actors = await Promise.all(['uploader', 'reader', 'label', 'foreign'].map(name => identities.createUser({
      email: `${name}@file-collection.example.test`, password_hash: 'unused', email_verified: true })));
    const members = await Promise.all(actors.map((actor, index) => identities.createMembership({ user_id: actor.user_id,
      team_id: index === 3 ? teamB.team_id : teamA.team_id, is_owner: index !== 2, roles: [] })));
    const grants = await Promise.all(actors.map((actor, index) => issueMcpGrant(identities, { user_id: actor.user_id,
      team_id: index === 3 ? teamB.team_id : teamA.team_id, client_id: 'file-collection' }, { clock })));
    const identitiesFor = await Promise.all(grants.map(grant => resolveIdentity(identities, { mcp_grant_token: grant.token }, { clock })));
    const identity = identitiesFor[0]!;
    const boundary = await createTeamOwnerStorageBoundary({ artifact, asm, app: APP, identities,
      router: createD1OwnerRouter({ resolveBinding: scope => scope.app === APP && [teamA.team_id, teamB.team_id].includes(scope.owner)
        ? { ...scope, db: scope.owner === teamA.team_id ? a : b, initializeFresh: true } : null }) });
    const store = await boundary.forIdentity(identity);
    // Initialize both real owning schemas before snapshots; no cross-owner fallback.
    await boundary.forIdentity(identitiesFor[3]!);
    physical = createSqliteFileStore(join(dir, 'files.sqlite'));
    const genuineKernel = createFileJourneyKernel(createSqliteFileBindings(physical, {
      clock, intentTtlMs: 60000, urlBase: 'https://file-collection.invalid' }));
    const byteReads: { ref: string; owner: string; principal: string }[] = [];
    const kernel = { ...genuineKernel, async readCurrentSnapshot(...args: Parameters<typeof genuineKernel.readCurrentSnapshot>) {
      byteReads.push({ ref: args[0], owner: args[1].owner, principal: args[1].principal });
      const snapshot = await genuineKernel.readCurrentSnapshot(...args);
      if (gate !== undefined) { const held = gate; held.begin(); await held.released; }
      return snapshot;
    } };
    const upload: UploadDeps & { kernel: typeof kernel } = { app: { appId: APP, brand: APP, appDefaultLocale: 'en', ownerLabels: new Map() },
      files: { usesFiles: () => true }, kernel, clock, logger: { log: () => {} }, identity: { store: identities, clock,
        mail: { sendMail: async () => {} }, verifyBaseUrl: '', recoveryBaseUrl: '', inviteBaseUrl: '', sessionMaxAgeSeconds: 3600 } };
    const retention = { unattachedHorizonMs: 120000, retentionMs: 600000 };
    const handler = createBoundFileHandler({ artifact, asm, store, memberships: identities, identityStore: identities,
      clock, upload, ownerStorage: boundary, physicalFiles: physical.files, retention,
      fileReferenceBounds: { maxRows: 100, maxReferences: 100 } });
    const invoker = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities,
      now: clock.nowMs, ownerStorage: boundary, files: createCanonicalFileBinding(genuineKernel, retention) });
    const request = (path: string, method = 'GET', body?: string | Uint8Array, token?: string) => new Request(
      path.startsWith('https:') ? path : `https://file-collection.invalid${path}`, { method,
        headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(method === 'PUT' ? { 'upload-offset': '0' } : {}),
          'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json' },
        ...(body === undefined ? {} : { body }) });
    const uploadFile = async (uploadId: string, bytes: Uint8Array, claimedType = 'application/pdf') => {
      const response = await handler(request('/files/intents', 'POST', JSON.stringify({ upload_id: uploadId,
        operation: `${MODEL}.create`, field: '/attachments', arguments: {}, name: `${uploadId}.pdf`,
        type: claimedType, size: String(bytes.length) }), grants[0]!.token));
      assert.equal(response.status, 200, await response.clone().text());
      const intent = await response.json() as { content: string; finalize: string };
      const appended = await handler(request(intent.content, 'PUT', bytes, grants[0]!.token));
      assert.equal(appended.status, 200, await appended.clone().text());
      const finalized = await handler(request(intent.finalize, 'POST', JSON.stringify({ upload_id: uploadId,
        bytes_digest: sha256Hex(bytes) }), grants[0]!.token));
      assert.equal(finalized.status, 200, await finalized.clone().text());
      const ref = (await finalized.json() as { file: string }).file;
      assert.ok(ref); assert.ok(physical!.files.get(ref)); return ref;
    };
    const png = await uploadFile('page-png', PNG_BYTES, 'image/png');
    const jpeg = await uploadFile('page-jpeg', JPEG_BYTES, 'image/jpeg');
    const createId = nextId();
    const envelope: MutationEnvelope = { operation: `${MODEL}.create`, operation_id: createId,
      inputs: { label: 'Visible Files', attachments: [{ id: png }, { id: jpeg }, { id: png }],
        ordinary: [], nullable: null, cover: { id: png } } };
    const created = await invoker.invokeMutation(envelope, identity);
    assert.ok('result' in created, JSON.stringify(created)); assert.equal(created.result.status, 'committed');
    const row = await store.load(MODEL, asId(createId)); assert.ok(row);
    assert.deepEqual(row.data.attachments, [{ id: png }, { id: jpeg }, { id: png }]);
    // Original browser credentials, not the MCP identity used for creation.
    const token = 'page-file-original-session';
    const session = await identities.createSession({ user_id: actors[1]!.user_id,
      token_sha256: await sha256HexText(token), expires_at: new Date(FIXED_NOW + 3600000).toISOString(),
      last_team_id: teamA.team_id });
    const cookie = buildSessionCookie(token, { secure: false, maxAgeSeconds: 3600 }).split(';')[0]!;
    const credential = new Request('https://file-collection.invalid/files', { headers: { cookie } });
    const resolveCaller = async () => (await resolveRequestIdentity(identities, credential, { clock })).identity;
    const browserIdentity = await resolveCaller();
    // Fixed selected physical store: no second owner router is given to this reader.
    const reads = createBoundFileReadResolver({ artifact, asm, store, memberships: identities,
      identityStore: identities, clock, upload, physicalFiles: physical.files, retention,
      fileReferenceBounds: { maxRows: 100, maxReferences: 100 } });
    const scopeFor = (admitted: typeof browserIdentity, source: Parameters<typeof createPageReadScopeCanonical>[0]['pageSource'],
      originalCredential: () => Promise<typeof browserIdentity>) => createPageReadScopeCanonical({ artifact, asm, store,
        identity: admitted, memberships: identities, now: clock.nowMs, pageSource: source!,
        pageFiles: { read: reads.read, resolveCaller: originalCredential } });
    const scope = scopeFor(browserIdentity, buildPageSourceContext(browserIdentity), resolveCaller);
    assert.ok(scope.presentFile); assert.ok(scope.readRecords);
    const projected = await scope.readRecords(MODEL, {}); assert.equal(projected.length, 1);
    const files = projected[0]!.attachments as FileValue[];
    assert.deepEqual(files.map(file => file.id), [png, jpeg, png]); assert.notEqual(files[0], files[2]);
    const before = { owner: await tables(a), foreign: await tables(b), files: physical.files.listAll() };
    // The existing File target sink consumes the exact source-bound occurrence,
    // using the download presenter rather than image preview or a public URL.
    const { button } = await nodeImport(pathToFileURL(join(root, 'packages/ui/dist/src/index.js')).href) as typeof import('@canlang/ui');
    const buttonContext: PresentationContext = {
      preferredLocales: [], appDefaultLocale: 'en',
      theme: { mode: 'system', accent: 'blue', density: 'comfortable' },
      path: '/files', isPartial: false, csrfToken: 'unused', principal: null, invocation: null,
      query: async () => { throw new Error('File button must not query'); }, presentFile: scope.presentFile,
    };
    const targetLink = await button({ context: buttonContext, target: files[0]!, caption: 'Open <attachment>' });
    assert.ok(targetLink.includes(`href="/files/read/${MODEL}/${row.id}/attachments/${png}"`), targetLink);
    assert.ok(targetLink.includes('Open &lt;attachment&gt;'), targetLink);
    assert.ok(!targetLink.includes('/files/preview/'), targetLink);
    const unavailableTarget = await button({ context: buttonContext, target: null, caption: 'Open <attachment>' });
    const copiedTarget = await button({ context: buttonContext, target: { ...files[0]! }, caption: 'Open <attachment>' });
    assert.equal(copiedTarget, unavailableTarget);
    assert.match(unavailableTarget, /disabled aria-disabled="true"/);
    assert.ok(!unavailableTarget.includes('href=') && !unavailableTarget.includes(png));
    for (const file of files) assert.ok(await scope.presentFile(file));
    assert.equal(await scope.presentFile({ ...files[0]! }), null);
    assert.equal(await scope.presentFile({ kind: 'file', id: png }), null);
    const foreignScope = scopeFor(browserIdentity, buildPageSourceContext(browserIdentity), resolveCaller);
    assert.equal(await foreignScope.presentFile!(files[0]!), null);
    await foreignScope.close?.();
    const currentPartial = () => resolveIdentity(identities, { mcp_grant_token: grants[2]!.token }, { clock });
    const partial = scopeFor(identitiesFor[2]!, buildPageSourceContext(identitiesFor[2]!), currentPartial);
    const partialRows = await partial.readRecords!(MODEL, {});
    assert.equal(partialRows.length, 1);
    assert.equal(partialRows[0]!.attachments, undefined);
    assert.equal(partialRows[0]!.cover, undefined);
    assert.equal(await partial.presentFile!(files[0]!), null);
    await partial.close?.();
    assert.ok(byteReads.length >= 3);
    for (const physicalRead of byteReads) {
      assert.equal(physicalRead.owner, teamA.team_id);
      assert.equal(physicalRead.principal, actors[0]!.user_id);
    }
    const result = await scope.query(browserIdentity, MODEL, { order: ['created'] });
    const returned = result.rows[0]!;
    assert.deepEqual((returned.fields.attachments as FileValue[]).map(file => file.id), [png, jpeg, png]);
    assert.deepEqual(returned.fields.ordinary, []); assert.equal(returned.fields.nullable, null);
    assert.ok(scope.resolveFileImage);
    assert.deepEqual(await scope.resolveFileImage({ model: MODEL, record: returned, field: 'cover' }), {
      previewUrl: `/files/preview/${MODEL}/${row.id}/cover/${png}`,
      originalUrl: `/files/read/${MODEL}/${row.id}/cover/${png}` });
    assert.equal(await scope.resolveFileImage({ model: MODEL, record: { ...returned }, field: 'cover' }), null);
    assert.equal(await scope.resolveFileImage({ model: MODEL, record: returned, field: 'attachments' }), null);
    assert.equal(await scope.resolveFileImage({ model: 'Foreign.Entry', record: returned, field: 'cover' }), null);
    // The original compiler page export and owning renderer perform the text call.
    const page = artifact.pages[0]!;
    const originalModule = await nodeImport(asm.moduleUrls[page.module]!);
    const descriptor = originalModule[page.export] as PageDescriptor;
    assert.equal(descriptor.owner, page.owner); assert.equal(descriptor.path, page.path);
    let pageDeps: PageHttpDeps | undefined;
    const actualWorker = await assembleWorker(artifact, asm, {
      store, identityStore: identities, now: clock.nowMs, ownerStorage: boundary,
      files: { usesFiles: true, kernel, fetch: handler,
        canonical: createCanonicalFileBinding(genuineKernel, retention),
        readOptions: { upload, physicalFiles: physical.files, retention,
          fileReferenceBounds: { maxRows: 100, maxReferences: 100 } } },
      http: { createPageHandler: actual => {
        pageDeps = actual as PageHttpDeps;
        return request => handlePageRequest(pageDeps!, request);
      } },
    }, { active: true });
    const response = await actualWorker.fetch(credential);
    assert.equal(response.status, 200); const html = await response.text();
    const pngLink = `/files/read/${MODEL}/${row.id}/attachments/${png}`;
    const jpegLink = `/files/read/${MODEL}/${row.id}/attachments/${jpeg}`;
    assert.equal(html.split(`href="${pngLink}"`).length - 1, 2);
    assert.equal(html.split(`href="${jpegLink}"`).length - 1, 1);
    assert.ok(html.indexOf(pngLink) < html.indexOf(jpegLink));
    assert.deepEqual({ owner: await tables(a), foreign: await tables(b), files: physical.files.listAll() }, before);
    // Close while the real owner router is still acquiring its physical store.
    const ownerGate = hold();
    let ownerCalls = 0, pendingDeps: PageHttpDeps | undefined;
    const pendingWorker = await assembleWorker(artifact, asm, {
      store, identityStore: identities, now: clock.nowMs,
      ownerStorage: { ...boundary, forIdentity: async admitted => {
        ownerCalls++;
        const selected = await boundary.forIdentity(admitted);
        ownerGate.begin(); await ownerGate.released; return selected;
      } },
      http: { createPageHandler: actual => {
        pendingDeps = actual as PageHttpDeps;
        return request => handlePageRequest(pendingDeps!, request);
      } },
    }, { active: true });
    assert.equal(pendingWorker.pageCount, 1);
    assert.ok(pendingDeps?.createReadScope);
    const pendingScope = await pendingDeps.createReadScope(browserIdentity, buildPageSourceContext(browserIdentity), resolveCaller);
    const pendingRows = pendingScope.readRecords!(MODEL, {});
    await ownerGate.started;
    const closing = pendingScope.close?.(); ownerGate.release();
    await assert.rejects(pendingRows); await closing;
    await assert.rejects(() => pendingScope.readRecords!(MODEL, {}));
    assert.equal(ownerCalls, 1, 'closed lazy scope cannot reacquire an owner');
    // Pending physical work cannot escape a terminal close.
    const heldScope = scopeFor(browserIdentity, buildPageSourceContext(browserIdentity), resolveCaller);
    const heldRows = await heldScope.readRecords!(MODEL, {});
    gate = hold(); const pending = heldScope.presentFile!((heldRows[0]!.attachments as FileValue[])[0]!);
    await gate.started; await heldScope.close?.(); gate.release(); gate = undefined;
    assert.equal(await pending, null);
    assert.equal(await heldScope.presentFile!((heldRows[0]!.attachments as FileValue[])[0]!), null);
    // Rechecking an expired/revoked original session never uses admitted identity.
    await identities.revokeSession(session.session_id);
    await assert.rejects(() => scope.presentFile!(files[0]!));
    await scope.close?.();
    assert.equal(await scope.presentFile(files[0]!), null);
    // A genuine changed source predicate withholds File fields and their links.
    const currentOwner = () => resolveIdentity(identities, { mcp_grant_token: grants[0]!.token }, { clock });
    const label = async (value: string) => {
      const current = await store.load(MODEL, row.id); assert.ok(current);
      const changed = await invoker.invokeMutation({ operation: `${MODEL}.update`, operation_id: nextId(),
        inputs: { record: { id: row.id, version: String(current.version) }, label: value } }, await currentOwner());
      assert.ok('result' in changed, JSON.stringify(changed)); assert.equal(changed.result.status, 'committed');
    };
    await label('');
    const ownerIdentity = await currentOwner();
    const hiddenScope = scopeFor(ownerIdentity, buildPageSourceContext(ownerIdentity), currentOwner);
    const hidden = await hiddenScope.readRecords!(MODEL, {});
    assert.equal(hidden.length, 1); assert.equal(hidden[0]!.attachments, undefined);
    assert.equal(await hiddenScope.presentFile!(files[0]!), null);
    await hiddenScope.close?.();
    await label('Visible Files');
    const restoredScope = scopeFor(await currentOwner(), buildPageSourceContext(await currentOwner()), currentOwner);
    const restored = await restoredScope.readRecords!(MODEL, {});
    assert.deepEqual((restored[0]!.attachments as FileValue[]).map(file => file.id), [png, jpeg, png]);
    assert.ok(await restoredScope.presentFile!((restored[0]!.attachments as FileValue[])[0]!));
    await restoredScope.close?.();
    assert.deepEqual(physical.files.listAll(), before.files);
    assert.equal(await captureIsCurrent(capture), true);
    assert.deepEqual(await Promise.all(paths.map(async path => digest(await readFile(path)))), hashes);
  } finally { gate?.release(); physical?.close(); await worker?.dispose(); await rm(dir, { recursive: true, force: true }); }
}, 240000);
