/** Actual captured native CRUD File collection and State whole-field downloads.
 * This does not qualify retention/deletion, a provider, or an original app. */
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
import type { MutationEnvelope, ProjectedRecord, ReceiptIdentity } from '@canlang/contracts';
import type { UploadDeps } from '@canlang/interfaces';
import { distribution } from '@canlang/values/distribution';
import { createD1OwnerRouter } from '@canlang/state/storage/owner-router';
import { ensureSchema } from '@canlang/state/storage/d1';
import { hashInputs } from '@canlang/state/invocation/replay';
import { asId, asModel, asOperation, asOperationId, FIXED_NOW, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity } from '@canlang/identity';
import { createSqliteFileBindings, createSqliteFileStore, type SqliteFileStore } from '@canlang/files/host/sqlite';
import { blobKeyForFile } from '@canlang/files/finalize';
import { sha256Hex, stagingKeyForIntent } from '@canlang/files/upload';
import { createFileJourneyKernel } from '@canlang/interfaces/uploads/kernel';

const root = resolve('.'), APP = 'FileCollectionDownload', MODEL = asModel(`${APP}.Entry`);
const fixture = join(root, 'packages/cloudflare/test/fixtures/file-collection-download.can');
const A_BYTES = new TextEncoder().encode('%PDF-1.4\nCollection A actual bytes\ntrailer\n');
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
function committedFenceLog(before: Awaited<ReturnType<typeof tables>>, after: Awaited<ReturnType<typeof tables>>,
  operation: string, revision: number): void {
  assert.equal(after.fence_log!.length, before.fence_log!.length + 1);
  assert.deepEqual(after.fence_log!.filter(row => row.revision === revision), [{ at: FIXED_NOW, operation, revision }],
    'exactly one new fence log row belongs to the owning commit');
  assert.deepEqual(after.fence_log!.filter(row => row.revision !== revision), before.fence_log,
    'preserve every prior fence log row');
}
function committedHistorySequence(before: Awaited<ReturnType<typeof tables>>, after: Awaited<ReturnType<typeof tables>>): void {
  const prior = before.sqlite_sequence!, history = prior.filter(row => row.name === 'history');
  assert.ok(history.length <= 1);
  const sequence = history[0]?.seq ?? 0;
  assert.ok(typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence >= 0);
  const expected = [...prior.filter(row => row.name !== 'history'), { name: 'history', seq: sequence + 1 }]
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(after.sqlite_sequence, expected, 'only the actual one-history AUTOINCREMENT sequence advances');
}

test('captured native required File collections download only current authorized field members', async () => {
  // The installed Node loader preserves genuine own-data producer metadata.
  const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
  const { prepareLocalPreviewCapture } = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
  const { captureSingleFileSource, captureIsCurrent, verifyCompilerSources } = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
  const { compileCapturedSingleFile } = await nodeImport(installed('dev/compiler-check.js')) as typeof import('../src/dev/compiler-check.js');
  const { assembleModules } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
  const { buildInvoker, createTeamOwnerStorageBoundary } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
  const { createBoundFileHandler, createCanonicalFileBinding } = await nodeImport(installed('runtime/bound-files.js')) as typeof import('../src/runtime/bound-files.js');
  const compiler = join(root, 'compiler/target/debug/can'), catalog = new URL(distribution.catalog);
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const paths = [fixture, compiler, catalog];
  const hashes = await Promise.all(paths.map(async path => digest(await readFile(path))));
  const dir = await mkdtemp(join(tmpdir(), 'can-file-collection-'));
  let worker: Miniflare | undefined, physical: SqliteFileStore | undefined, sequence = 0;
  const clock = { nowMs: () => FIXED_NOW };
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
    assert.equal(artifact.pages.length, 0);
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
    for (const [index, actor] of actors.entries()) await identities.createMembership({ user_id: actor.user_id,
      team_id: index === 3 ? teamB.team_id : teamA.team_id, is_owner: index !== 2, roles: [] });
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
      return genuineKernel.readCurrentSnapshot(...args);
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
    const uploadFile = async (uploadId: string, bytes: Uint8Array) => {
      const response = await handler(request('/files/intents', 'POST', JSON.stringify({ upload_id: uploadId,
        operation: `${MODEL}.create`, field: '/attachments', arguments: {}, name: `${uploadId}.pdf`,
        type: 'application/pdf', size: String(bytes.length) }), grants[0]!.token));
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
    const refA = await uploadFile('collection-a', A_BYTES), refB = await uploadFile('collection-b', B_BYTES);
    const all = async () => ({ ownerA: await tables(a), ownerB: await tables(b), identity: await tables(identityDb),
      files: physical!.files.listAll(), intents: physical!.intents.listAll(),
      bytes: physical!.files.listAll().map(record => physical!.blobs.read(blobKeyForFile(record.file.id))),
      staging: physical!.intents.listAll().map(intent => physical!.blobs.read(stagingKeyForIntent(intent.intentId))) });
    type ProbeEnvelope = MutationEnvelope & { readonly operation_id: ReturnType<typeof nextId> };
    const receiptIdentity = (envelope: ProbeEnvelope): ReceiptIdentity => ({ app: APP, owner: teamA.team_id,
      principal: identity.actor!.user_id, operation: asOperation(envelope.operation), operationId: envelope.operation_id });
    const envelope = (kind: string, inputs: MutationEnvelope['inputs']): ProbeEnvelope => ({
      operation: `${MODEL}.${kind}`, operation_id: nextId(), inputs });
    const ordered = [{ id: refA }, { id: refB }, { id: refA }];
    const create = envelope('create', { attachments: ordered }), submitted = structuredClone(create);
    const beforeCreate = await all(), revision = await store.readRevision();
    const created = await invoker.invokeMutation(create, identity);
    assert.ok('result' in created, JSON.stringify(created)); assert.equal(created.result.status, 'committed');
    assert.deepEqual(create, submitted);
    const row = await store.load(MODEL, asId(create.operation_id)); assert.ok(row);
    assert.equal(row.version, 1); assert.equal(row.data.label, 'Uploaded'); assert.deepEqual(row.data.attachments, ordered);
    const projected = created.result.records as readonly ProjectedRecord[];
    assert.equal(projected.length, 1); assert.deepEqual(projected[0]!.data.attachments, ordered);
    assert.equal(await store.readRevision(), revision + 1);
    const receipt = await store.readReceipt(receiptIdentity(create)); assert.ok(receipt);
    assert.equal(receipt.inputHash, await hashInputs(submitted.inputs)); assert.equal(receipt.committedRevision, revision + 1);
    assert.equal(receipt.outcome.status, 'committed');
    if (receipt.outcome.status !== 'committed') throw new Error('Actual create receipt was not committed.');
    assert.deepEqual(receipt.outcome.recordVersions, [{ model: MODEL, id: row.id, version: 1 }]);
    const history = await store.historyFor(MODEL, row.id);
    assert.equal(history.length, 1); assert.equal(history[0]!.change, 'create');
    assert.deepEqual(history[0]!.after?.attachments, ordered);
    const afterCreate = await all();
    assert.deepEqual(afterCreate.ownerB, beforeCreate.ownerB); assert.deepEqual(afterCreate.identity, beforeCreate.identity);
    assert.deepEqual(Object.keys(afterCreate.ownerA), Object.keys(beforeCreate.ownerA));
    for (const name of Object.keys(beforeCreate.ownerA)) if (!['fence', 'fence_log', 'records', 'receipts', 'history', 'sqlite_sequence'].includes(name))
      assert.deepEqual(afterCreate.ownerA[name], beforeCreate.ownerA[name], `create leaves ${name} unchanged`);
    committedFenceLog(beforeCreate.ownerA, afterCreate.ownerA, create.operation, revision + 1);
    committedHistorySequence(beforeCreate.ownerA, afterCreate.ownerA);
    assert.equal(afterCreate.ownerA.records!.length, beforeCreate.ownerA.records!.length + 1);
    assert.equal(afterCreate.ownerA.receipts!.length, beforeCreate.ownerA.receipts!.length + 1);
    assert.equal(afterCreate.ownerA.history!.length, beforeCreate.ownerA.history!.length + 1);
    for (const ref of [refA, refB]) assert.equal(physical.files.get(ref)?.attachedRecord, `${MODEL}/${row.id}/attachments`);
    const replay = await invoker.invokeMutation(create, identity);
    assert.ok('result' in replay, JSON.stringify(replay)); assert.equal(replay.result.status, 'replayed');
    assert.deepEqual(replay.result.records, created.result.records); assert.deepEqual(await all(), afterCreate);
    const retained = await invoker.invokeRetainedMutation(create, identity);
    assert.ok('result' in retained, JSON.stringify(retained)); assert.equal(retained.result.status, 'replayed');
    assert.deepEqual(retained.result.records, created.result.records); assert.deepEqual(await all(), afterCreate);
    assert.deepEqual(create, submitted);
    const replayOriginalAfterReplacement = async (expectedVersion: number, expectedWire: unknown) => {
      for (const retained of [false, true]) {
        const before = await all(), count = byteReads.length, originalReceipt = await store.readReceipt(receiptIdentity(create));
        const outcome = retained ? await invoker.invokeRetainedMutation(create, identity) : await invoker.invokeMutation(create, identity);
        assert.ok('result' in outcome, JSON.stringify(outcome)); assert.equal(outcome.result.status, 'replayed');
        const current = await store.load(MODEL, row.id); assert.ok(current);
        assert.equal(current.version, expectedVersion); assert.deepEqual(current.data.attachments, expectedWire);
        assert.deepEqual(await all(), before, 'old create recovery cannot restore removed File slots or rewrite physical stores');
        assert.equal(byteReads.length, count); assert.deepEqual(await store.readReceipt(receiptIdentity(create)), originalReceipt);
        assert.deepEqual(create, submitted);
      }
    };
    const base = `/files/read/${MODEL}/${row.id}/attachments`;
    const download = async (ref: string, bytes: Uint8Array) => {
      const before = await all(), count = byteReads.length;
      const response = await handler(request(`${base}/${encodeURIComponent(ref)}`, 'GET', undefined, grants[1]!.token));
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('content-type'), 'application/pdf');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
      assert.equal(byteReads.length, count + 1);
      assert.deepEqual(byteReads.at(-1), { ref, owner: teamA.team_id, principal: actors[0]!.user_id },
        'the second authorized current reader uses the actual physical receiving identity');
      assert.notEqual(actors[0]!.user_id, actors[1]!.user_id);
      assert.deepEqual(await all(), before);
    };
    const withheld = async (req: Request) => {
      const before = await all(), count = byteReads.length, response = await handler(req);
      assert.ok(response.status >= 400 && response.status < 500, String(response.status));
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.notDeepEqual(bytes, A_BYTES); assert.notDeepEqual(bytes, B_BYTES);
      assert.equal(byteReads.length, count, 'withheld field/ref never reaches the physical snapshot callback');
      assert.deepEqual(await all(), before);
    };
    await download(refA, A_BYTES); await download(refB, B_BYTES);
    await withheld(request(`${base}/${refA}`));
    await withheld(request(`${base}/${refA}`, 'GET', undefined, grants[2]!.token));
    await withheld(request(`${base}/${refA}`, 'GET', undefined, grants[3]!.token));
    await withheld(request(`${base}/${uuidv7(FIXED_NOW, 9000)}`, 'GET', undefined, grants[1]!.token));
    await withheld(request(`${base}/%ZZ`, 'GET', undefined, grants[1]!.token));
    await withheld(request(base, 'GET', undefined, grants[1]!.token));
    const beforeLabelRead = await all(), labelByteReads = byteReads.length;
    const labelRead = await invoker.invokeRead({ operation: `${MODEL}.read`, inputs: {} }, identitiesFor[2]!);
    assert.ok('result' in labelRead, JSON.stringify(labelRead));
    assert.ok(labelRead.result !== null && typeof labelRead.result === 'object' && !Array.isArray(labelRead.result));
    const labelRecords = (labelRead.result as { records: readonly ProjectedRecord[] }).records;
    assert.ok(Array.isArray(labelRecords)); assert.equal(labelRecords.length, 1);
    assert.deepEqual(labelRecords[0]!.data, { label: 'Uploaded' });
    assert.equal(byteReads.length, labelByteReads); assert.deepEqual(await all(), beforeLabelRead);
    const replacement = envelope('update', { record: { id: row.id, version: '1' }, attachments: [{ id: refB }] });
    const beforeUpdate = await all(), replaced = await invoker.invokeMutation(replacement, identity);
    assert.ok('result' in replaced, JSON.stringify(replaced)); assert.equal(replaced.result.status, 'committed');
    const current = await store.load(MODEL, row.id); assert.ok(current);
    assert.equal(current.version, 2); assert.deepEqual(current.data.attachments, [{ id: refB }]);
    assert.equal(await store.readRevision(), revision + 2);
    const updatedHistory = await store.historyFor(MODEL, row.id);
    assert.equal(updatedHistory.length, 2); assert.deepEqual(updatedHistory[1]!.before?.attachments, ordered);
    assert.deepEqual(updatedHistory[1]!.after?.attachments, [{ id: refB }]);
    const updateReceipt = await store.readReceipt(receiptIdentity(replacement)); assert.ok(updateReceipt);
    assert.equal(updateReceipt.inputHash, await hashInputs(replacement.inputs));
    assert.equal(updateReceipt.committedRevision, revision + 2); assert.equal(updateReceipt.outcome.status, 'committed');
    if (updateReceipt.outcome.status !== 'committed') throw new Error('Actual replacement receipt was not committed.');
    assert.deepEqual(updateReceipt.outcome.recordVersions, [{ model: MODEL, id: row.id, version: 2 }]);
    const afterUpdate = await all();
    assert.deepEqual(afterUpdate.ownerB, beforeUpdate.ownerB); assert.deepEqual(afterUpdate.identity, beforeUpdate.identity);
    assert.deepEqual(Object.keys(afterUpdate.ownerA), Object.keys(beforeUpdate.ownerA));
    for (const name of Object.keys(beforeUpdate.ownerA)) if (!['fence', 'fence_log', 'records', 'receipts', 'history', 'sqlite_sequence'].includes(name))
      assert.deepEqual(afterUpdate.ownerA[name], beforeUpdate.ownerA[name], `update leaves ${name} unchanged`);
    committedFenceLog(beforeUpdate.ownerA, afterUpdate.ownerA, replacement.operation, revision + 2);
    committedHistorySequence(beforeUpdate.ownerA, afterUpdate.ownerA);
    assert.equal(afterUpdate.ownerA.records!.length, beforeUpdate.ownerA.records!.length);
    assert.equal(afterUpdate.ownerA.receipts!.length, beforeUpdate.ownerA.receipts!.length + 1);
    assert.equal(afterUpdate.ownerA.history!.length, beforeUpdate.ownerA.history!.length + 1);
    const replacedReplay = await invoker.invokeMutation(replacement, identity);
    assert.ok('result' in replacedReplay, JSON.stringify(replacedReplay)); assert.equal(replacedReplay.result.status, 'replayed');
    assert.deepEqual(replacedReplay.result.records, replaced.result.records); assert.deepEqual(await all(), afterUpdate);
    const replacedRetained = await invoker.invokeRetainedMutation(replacement, identity);
    assert.ok('result' in replacedRetained, JSON.stringify(replacedRetained)); assert.equal(replacedRetained.result.status, 'replayed');
    assert.deepEqual(replacedRetained.result.records, replaced.result.records); assert.deepEqual(await all(), afterUpdate);
    await replayOriginalAfterReplacement(2, [{ id: refB }]);
    await withheld(request(`${base}/${refA}`, 'GET', undefined, grants[1]!.token));
    await download(refB, B_BYTES);
    const beforeEmpty = await all(), readsBeforeEmpty = byteReads.length;
    // The owning file[]! contract requires presence, not a nonempty collection.
    const emptyEnvelope = envelope('update', { record: { id: row.id, version: '2' }, attachments: [] });
    const emptySubmitted = structuredClone(emptyEnvelope);
    const empty = await invoker.invokeMutation(emptyEnvelope, identity);
    assert.ok('result' in empty, JSON.stringify(empty)); assert.equal(empty.result.status, 'committed');
    assert.deepEqual(emptyEnvelope, emptySubmitted);
    const removed = await store.load(MODEL, row.id); assert.ok(removed);
    assert.equal(removed.version, 3); assert.deepEqual(removed.data.attachments, []);
    assert.deepEqual((empty.result.records as readonly ProjectedRecord[])[0]!.data.attachments, []);
    assert.equal(await store.readRevision(), revision + 3);
    const removedHistory = await store.historyFor(MODEL, row.id);
    assert.equal(removedHistory.length, 3); assert.equal(removedHistory[2]!.change, 'update');
    assert.deepEqual(removedHistory[2]!.before?.attachments, [{ id: refB }]);
    assert.deepEqual(removedHistory[2]!.after?.attachments, []);
    const emptyReceipt = await store.readReceipt(receiptIdentity(emptyEnvelope)); assert.ok(emptyReceipt);
    assert.equal(emptyReceipt.inputHash, await hashInputs(emptySubmitted.inputs));
    assert.equal(emptyReceipt.committedRevision, revision + 3); assert.equal(emptyReceipt.outcome.status, 'committed');
    if (emptyReceipt.outcome.status !== 'committed') throw new Error('Actual empty collection receipt was not committed.');
    assert.deepEqual(emptyReceipt.outcome.recordVersions, [{ model: MODEL, id: row.id, version: 3 }]);
    const afterEmpty = await all();
    assert.deepEqual(afterEmpty.ownerB, beforeEmpty.ownerB); assert.deepEqual(afterEmpty.identity, beforeEmpty.identity);
    assert.deepEqual(Object.keys(afterEmpty.ownerA), Object.keys(beforeEmpty.ownerA));
    for (const name of Object.keys(beforeEmpty.ownerA)) if (!['fence', 'fence_log', 'records', 'receipts', 'history', 'sqlite_sequence'].includes(name))
      assert.deepEqual(afterEmpty.ownerA[name], beforeEmpty.ownerA[name], `empty update leaves ${name} unchanged`);
    committedFenceLog(beforeEmpty.ownerA, afterEmpty.ownerA, emptyEnvelope.operation, revision + 3);
    committedHistorySequence(beforeEmpty.ownerA, afterEmpty.ownerA);
    assert.equal(afterEmpty.ownerA.records!.length, beforeEmpty.ownerA.records!.length);
    assert.equal(afterEmpty.ownerA.receipts!.length, beforeEmpty.ownerA.receipts!.length + 1);
    assert.equal(afterEmpty.ownerA.history!.length, beforeEmpty.ownerA.history!.length + 1);
    for (const key of ['files', 'intents', 'bytes', 'staging'] as const) assert.deepEqual(afterEmpty[key], beforeEmpty[key],
      'clearing the domain field does not assert physical deletion or alter Files stores');
    assert.equal(byteReads.length, readsBeforeEmpty);
    for (const retained of [false, true]) {
      const outcome = retained ? await invoker.invokeRetainedMutation(emptyEnvelope, identity)
        : await invoker.invokeMutation(emptyEnvelope, identity);
      assert.ok('result' in outcome, JSON.stringify(outcome)); assert.equal(outcome.result.status, 'replayed');
      assert.deepEqual(outcome.result.records, empty.result.records); assert.deepEqual(await all(), afterEmpty);
      assert.deepEqual(emptyEnvelope, emptySubmitted); assert.equal(byteReads.length, readsBeforeEmpty);
    }
    await replayOriginalAfterReplacement(3, []);
    for (const ref of [refA, refB]) await withheld(request(`${base}/${ref}`, 'GET', undefined, grants[1]!.token));
    // Actual admission refuses missing required create input and non-array update
    // input before execution. Update omission is deliberately not a rejection.
    for (const invalid of [envelope('create', {}),
      envelope('update', { record: { id: row.id, version: '3' }, attachments: { id: refB } })]) {
      const before = await all(), count = byteReads.length;
      const outcome = await invoker.invokeMutation(invalid, identity);
      assert.ok('error' in outcome, JSON.stringify(outcome)); assert.equal(outcome.error.code, 'validation');
      assert.equal(byteReads.length, count); assert.deepEqual(await all(), before);
      assert.equal(await store.readReceipt(receiptIdentity(invalid)), null);
    }
    assert.equal(await captureIsCurrent(capture), true);
    assert.deepEqual(await Promise.all(paths.map(async path => digest(await readFile(path)))), hashes);
  } finally { physical?.close(); await worker?.dispose(); await rm(dir, { recursive: true, force: true }); }
}, 120000);
