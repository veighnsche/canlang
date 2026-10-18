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

for (const sourcePolicy of [false, true]) test(`captured native File collections ${sourcePolicy ? 'source' : 'ordinary'} downloads and previews require current whole-field authority`, async () => {
  const fixture = join(root, 'packages/cloudflare/test/fixtures', sourcePolicy
    ? 'file-collection-source-preview.can' : 'file-collection-download.can');
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
  const { buildInvoker, createTeamOwnerStorageBoundary } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
  const { createBoundFileHandler, createCanonicalFileBinding } = await nodeImport(installed('runtime/bound-files.js')) as typeof import('../src/runtime/bound-files.js');
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
    assert.deepEqual(row.data.ordinary, []); assert.equal(row.data.nullable, null);
    const projected = created.result.records as readonly ProjectedRecord[];
    assert.equal(projected.length, 1); assert.deepEqual(projected[0]!.data, mutationProjection(row.data));
    assert.equal(await store.readRevision(), revision + 1);
    const receipt = await store.readReceipt(receiptIdentity(create)); assert.ok(receipt);
    assert.equal(receipt.inputHash, await hashInputs(submitted.inputs)); assert.equal(receipt.committedRevision, revision + 1);
    // Admission fills the ordinary input with []; the model pipeline owns
    // omitted nullable/literal defaults and persists those exact contributions.
    assert.deepEqual(receipt.resolvedDefaults, { label: 'Uploaded', nullable: null });
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
    const download = async (ref: string, bytes: Uint8Array, field = 'attachments') => {
      const before = await all(), count = byteReads.length;
      const response = await handler(request(`/files/read/${MODEL}/${row.id}/${field}/${encodeURIComponent(ref)}`, 'GET', undefined, grants[1]!.token));
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('content-type'), 'application/pdf');
      assert.equal(response.headers.get('content-disposition'), 'attachment');
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
    assert.deepEqual((empty.result.records as readonly ProjectedRecord[])[0]!.data, mutationProjection(removed.data));
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
    const updateCollections = async (patch: MutationEnvelope['inputs'], attachmentField: 'attachments' | 'ordinary' | 'nullable' | null) => {
      const prior = await store.load(MODEL, row.id); assert.ok(prior);
      const before = await all(), priorHistory = await store.historyFor(MODEL, row.id), priorRevision = await store.readRevision();
      const update = envelope('update', { record: { id: row.id, version: String(prior.version) }, ...patch });
      const submitted = structuredClone(update), reads = byteReads.length;
      const outcome = await invoker.invokeMutation(update, identity);
      assert.ok('result' in outcome, JSON.stringify(outcome)); assert.equal(outcome.result.status, 'committed');
      assert.deepEqual(update, submitted); assert.equal(byteReads.length, reads);
      const current = await store.load(MODEL, row.id); assert.ok(current);
      assert.equal(current.version, prior.version + 1); assert.deepEqual(current.data, { ...prior.data, ...patch });
      assert.deepEqual((outcome.result.records as readonly ProjectedRecord[])[0]!.data, mutationProjection(current.data));
      assert.equal(await store.readRevision(), priorRevision + 1);
      const currentHistory = await store.historyFor(MODEL, row.id);
      assert.deepEqual(currentHistory.slice(0, -1), priorHistory); assert.equal(currentHistory.length, priorHistory.length + 1);
      const change = currentHistory.at(-1)!;
      assert.equal(change.change, 'update'); assert.equal(change.operationId, update.operation_id);
      assert.equal(change.operation, update.operation); assert.equal(change.version, current.version);
      assert.deepEqual(change.before, prior.data); assert.deepEqual(change.after, current.data);
      const receipt = await store.readReceipt(receiptIdentity(update)); assert.ok(receipt);
      assert.equal(receipt.inputHash, await hashInputs(submitted.inputs)); assert.equal(receipt.committedRevision, priorRevision + 1);
      assert.deepEqual(receipt.resolvedDefaults, {}); assert.equal(receipt.outcome.status, 'committed');
      if (receipt.outcome.status !== 'committed') throw new Error('Actual optional collection update did not commit.');
      assert.deepEqual(receipt.outcome.recordVersions, [{ model: MODEL, id: row.id, version: current.version }]);
      const after = await all();
      assert.deepEqual(after.ownerB, before.ownerB); assert.deepEqual(after.identity, before.identity);
      assert.deepEqual(Object.keys(after.ownerA), Object.keys(before.ownerA));
      for (const name of Object.keys(before.ownerA)) if (!['fence', 'fence_log', 'records', 'receipts', 'history', 'sqlite_sequence'].includes(name))
        assert.deepEqual(after.ownerA[name], before.ownerA[name], `optional update leaves ${name} unchanged`);
      committedFenceLog(before.ownerA, after.ownerA, update.operation, priorRevision + 1);
      committedHistorySequence(before.ownerA, after.ownerA);
      assert.equal(after.ownerA.records!.length, before.ownerA.records!.length);
      assert.equal(after.ownerA.receipts!.length, before.ownerA.receipts!.length + 1);
      assert.equal(after.ownerA.history!.length, before.ownerA.history!.length + 1);
      // Only genuine current members of this field acquire its locator. A
      // newly finalized file gets its first attachment time; removed references
      // and every byte/provenance fact retain their exact prior physical state.
      const currentRefs = new Set(attachmentField === null ? [] :
        ((current.data[attachmentField] ?? []) as readonly { readonly id: string }[]).map(file => file.id));
      assert.deepEqual(after.files, before.files.map(file => currentRefs.has(file.file.id) ? { ...file,
        state: 'attached', attachedAtMs: file.attachedAtMs ?? FIXED_NOW,
        attachedRecord: `${MODEL}/${row.id}/${attachmentField}` } : file));
      for (const key of ['intents', 'bytes', 'staging'] as const) assert.deepEqual(after[key], before[key]);
      return { update, submitted, current };
    };
    const recoverCollection = async (saved: Awaited<ReturnType<typeof updateCollections>>) => {
      for (const retained of [false, true]) {
        const before = await all(), current = await store.load(MODEL, row.id), reads = byteReads.length;
        const receipt = await store.readReceipt(receiptIdentity(saved.update));
        const outcome = retained ? await invoker.invokeRetainedMutation(saved.update, identity)
          : await invoker.invokeMutation(saved.update, identity);
        assert.ok('result' in outcome, JSON.stringify(outcome)); assert.equal(outcome.result.status, 'replayed');
        assert.deepEqual(await store.load(MODEL, row.id), current);
        assert.deepEqual(await all(), before); assert.equal(byteReads.length, reads);
        assert.deepEqual(await store.readReceipt(receiptIdentity(saved.update)), receipt);
        assert.deepEqual(saved.update, saved.submitted);
      }
    };
    for (const field of ['ordinary', 'nullable'] as const) {
      const fieldPath = `/files/read/${MODEL}/${row.id}/${field}`;
      for (const ref of [refA, refB]) await withheld(request(`${fieldPath}/${ref}`, 'GET', undefined, grants[1]!.token));
      const populatedWire = field === 'ordinary' ? ordered : [{ id: refB }, { id: refA }, { id: refB }];
      const populated = await updateCollections({ [field]: populatedWire }, field);
      await recoverCollection(populated);
      await download(refA, A_BYTES, field); await download(refB, B_BYTES, field);
      await withheld(request(`${fieldPath}/${refA}`, 'GET', undefined, grants[2]!.token));
      await withheld(request(`${fieldPath}/${refA}`, 'GET', undefined, grants[3]!.token));
      await withheld(request(`${fieldPath}/${uuidv7(FIXED_NOW, 9001)}`, 'GET', undefined, grants[1]!.token));
      await withheld(request(fieldPath, 'GET', undefined, grants[1]!.token));
      const otherField = field === 'ordinary' ? 'nullable' : 'ordinary';
      await withheld(request(`/files/read/${MODEL}/${row.id}/${otherField}/${refA}`, 'GET', undefined, grants[1]!.token));
      // A real different-field update omits both collection inputs: no fill or
      // nullable default can overwrite the already populated owning field.
      const omitted = await updateCollections({ label: `Preserved ${field}` }, field);
      assert.deepEqual(omitted.current.data[field], populatedWire);
      await recoverCollection(omitted); await download(refA, A_BYTES, field);
      const cleared = await updateCollections({ [field]: [] }, null);
      assert.deepEqual(cleared.current.data[field], []); await recoverCollection(cleared);
      await recoverCollection(populated); await recoverCollection(omitted);
      for (const ref of [refA, refB]) await withheld(request(`${fieldPath}/${ref}`, 'GET', undefined, grants[1]!.token));
      if (field === 'nullable') {
        const repopulated = await updateCollections({ nullable: populatedWire }, 'nullable');
        assert.deepEqual(repopulated.current.data.nullable, populatedWire);
        await download(refA, A_BYTES, field);
        const nulled = await updateCollections({ nullable: null }, null);
        assert.equal(nulled.current.data.nullable, null); await recoverCollection(nulled);
        await recoverCollection(repopulated); await recoverCollection(populated); await recoverCollection(cleared);
        for (const ref of [refA, refB]) await withheld(request(`${fieldPath}/${ref}`, 'GET', undefined, grants[1]!.token));
      }
      await replayOriginalAfterReplacement((await store.load(MODEL, row.id))!.version, []);
    }
    // Extend the same original captured consumer, rather than substituting a
    // hand-written artifact or a permissive File policy for the image route.
    const png = await uploadFile('preview-png', PNG_BYTES, 'application/pdf'); // claimed MIME is not authority
    const jpeg = await uploadFile('preview-jpeg', JPEG_BYTES, 'image/jpeg');
    await updateCollections({ ordinary: [{ id: png }, { id: jpeg }] }, 'ordinary');
    const previewPath = (ref: string) => `/files/preview/${MODEL}/${row.id}/ordinary/${encodeURIComponent(ref)}`;
    const preview = async (ref: string, expected: Uint8Array, mime: string) => {
      const before = await all(), count = byteReads.length;
      const response = await handler(request(previewPath(ref), 'GET', undefined, grants[1]!.token));
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get('content-type'), mime);
      assert.equal(response.headers.get('content-disposition'), 'inline');
      assert.equal(response.headers.get('content-length'), String(expected.byteLength));
      assert.equal(response.headers.get('cache-control'), 'private, no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), expected);
      assert.equal(byteReads.length, count + 1, 'each request observes the original physical bytes afresh');
      assert.deepEqual(byteReads.at(-1), { ref, owner: teamA.team_id, principal: actors[0]!.user_id });
      assert.deepEqual(await all(), before);
    };
    const noPreview = async (req: Request, physicalRead = false) => {
      const before = await all(), count = byteReads.length;
      const response = await handler(req);
      assert.ok(response.status >= 400 && response.status < 500, String(response.status));
      const body = new Uint8Array(await response.arrayBuffer());
      assert.notDeepEqual(body, PNG_BYTES); assert.notDeepEqual(body, JPEG_BYTES);
      assert.equal(byteReads.length, count + Number(physicalRead));
      assert.deepEqual(await all(), before);
    };
    await preview(png, PNG_BYTES, 'image/png'); await preview(png, PNG_BYTES, 'image/png');
    await preview(jpeg, JPEG_BYTES, 'image/jpeg');
    const downloadImage = await handler(request(previewPath(png).replace('/preview/', '/read/'), 'GET', undefined, grants[1]!.token));
    assert.equal(downloadImage.status, 200); assert.equal(downloadImage.headers.get('content-disposition'), 'attachment');
    assert.deepEqual(new Uint8Array(await downloadImage.arrayBuffer()), PNG_BYTES);
    await noPreview(request(`/files/preview/${MODEL}/${row.id}/ordinary`, 'GET', undefined, grants[1]!.token));
    await noPreview(request(previewPath(png), 'POST', undefined, grants[1]!.token));
    for (const token of [undefined, grants[2]!.token, grants[3]!.token])
      await noPreview(request(previewPath(png), 'GET', undefined, token));
    await noPreview(request(previewPath(refA), 'GET', undefined, grants[1]!.token));
    await noPreview(request(previewPath(png).replace('/ordinary/', '/nullable/'), 'GET', undefined, grants[1]!.token));
    await updateCollections({ attachments: [{ id: refA }] }, 'attachments');
    await noPreview(request(`/files/preview/${MODEL}/${row.id}/attachments/${refA}`, 'GET', undefined, grants[1]!.token), true);
    const pngRecord = physical.files.get(png); assert.ok(pngRecord);
    physical.files.put({ ...pngRecord, file: { ...pngRecord.file, contentType: 'image/jpeg' } });
    await noPreview(request(previewPath(png), 'GET', undefined, grants[1]!.token), true);
    physical.files.put(pngRecord);
    const pngBlob = physical.blobs.read(blobKeyForFile(png)); assert.ok(pngBlob);
    physical.blobs.write(blobKeyForFile(png), new Uint8Array(pngBlob.length).fill(120));
    await noPreview(request(previewPath(png), 'GET', undefined, grants[1]!.token), true);
    physical.blobs.write(blobKeyForFile(png), pngBlob);
    now = FIXED_NOW + retention.retentionMs + 1;
    await noPreview(request(previewPath(png), 'GET', undefined, grants[1]!.token), true);
    now = FIXED_NOW;
    await identities.removeMembership(members[1]!.membership_id);
    await noPreview(request(previewPath(png), 'GET', undefined, grants[1]!.token));
    await identities.reactivateMembership(members[1]!.membership_id, { is_owner: true, roles: [] });
    await preview(png, PNG_BYTES, 'image/png');
    const heldPreview = async (change: () => Promise<unknown>) => {
      gate = hold();
      const pending = handler(request(previewPath(png), 'GET', undefined, grants[1]!.token));
      await Promise.race([gate.started, pending.then(response => {
        throw new Error(`Expected held original snapshot; received HTTP ${response.status}`);
      })]);
      await change(); const after = await all();
      const held = gate; gate = undefined; held.release();
      const response = await pending;
      assert.ok(response.status >= 400 && response.status < 500, String(response.status));
      assert.notDeepEqual(new Uint8Array(await response.arrayBuffer()), PNG_BYTES);
      assert.deepEqual(await all(), after);
    };
    await heldPreview(() => identities.removeMembership(members[1]!.membership_id));
    await identities.reactivateMembership(members[1]!.membership_id, { is_owner: true, roles: [] });
    await heldPreview(() => updateCollections({ ordinary: [{ id: jpeg }] }, 'ordinary'));
    await noPreview(request(previewPath(png), 'GET', undefined, grants[1]!.token));
    await preview(jpeg, JPEG_BYTES, 'image/jpeg');
    if (sourcePolicy) {
      const visibility = async (label: string) => {
        const current = await store.load(MODEL, row.id); assert.ok(current);
        const outcome = await invoker.invokeMutation(envelope('update', {
          record: { id: row.id, version: String(current.version) }, label }), identity);
        assert.ok('result' in outcome, JSON.stringify(outcome)); assert.equal(outcome.result.status, 'committed');
        assert.equal((await store.load(MODEL, row.id))?.data.label, label);
      };
      await visibility('');
      await noPreview(request(previewPath(jpeg), 'GET', undefined, grants[1]!.token));
      await visibility('Visible again');
      await preview(jpeg, JPEG_BYTES, 'image/jpeg');
    }
    assert.equal(await captureIsCurrent(capture), true);
    assert.deepEqual(await Promise.all(paths.map(async path => digest(await readFile(path)))), hashes);
  } finally { gate?.release(); physical?.close(); await worker?.dispose(); await rm(dir, { recursive: true, force: true }); }
}, 240000);
