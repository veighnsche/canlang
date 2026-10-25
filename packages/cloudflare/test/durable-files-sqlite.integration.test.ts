/** Real workerd SQLite Durable Object: Files kernel authority stays inside one isolate. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare } from 'miniflare';
import { it } from 'vitest';
import { createSqliteFileStore } from '@canlang/files/host/sqlite';
import type { CompileArtifact, StoredRow } from '@canlang/contracts';
import { deriveCsrfToken, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { asId, asModel, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';

it('admits native Worker upload intents through current canonical context before granting retries', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'can-native-upload-admission-'));
  const runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-15',
    script: 'export default {fetch(){return new Response("ready")}}',
    d1Databases: { DB: 'native-upload-admission' }, r2Buckets: { FILES: 'native-upload-admission' } });
  try {
    // Run the real Node importer: Vitest rewrites dynamic ESM namespaces to
    // getter-backed objects, unlike the native namespaces checked by this host.
    const requireNative = createRequire(import.meta.url);
    const { assembleModules } = requireNative(fileURLToPath(new URL('../dist/runtime/modules.js', import.meta.url))) as
      typeof import('../src/runtime/modules.js');
    const { createWorkerFiles } = requireNative(fileURLToPath(new URL('../dist/runtime/worker-files.js', import.meta.url))) as
      typeof import('../src/runtime/worker-files.js');
    const fixture = join(root, 'packages/cloudflare/test/fixtures/typed-file-journey.can');
    const source = join(directory, 'typed-file-journey.can');
    await writeFile(source, (await readFile(fixture, 'utf8'))
      .replace(' Entry { label:text="Uploaded", attachment:file? }',
        ' Entry { label:text="Uploaded", attachment:file? }\n contract UploadDraft {entry:Entry,attachment:file,note:text}\n contract OtherDraft {attachment:file}\n contract UploadEnvelope {drafts:UploadDraft[]?}\n contract UnionEnvelope {draft:UploadDraft|OtherDraft}')
      .replace('Then', ' scenario nested(envelope:UploadEnvelope?) by=owner\n  do\n   require true\n scenario unionDraft(payload:UnionEnvelope) by=owner\n  do\n   require true\nThen'));
    const artifact = JSON.parse(execFileSync(process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can'),
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog',
        process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json'), source],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' })) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
      stdlibUrl: new URL('../dist/runtime/stdlib.js', import.meta.url).href,
      uiUrl: pathToFileURL(createRequire(import.meta.url).resolve('@canlang/ui')).href });
    const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const user = await identities.createUser({ email: 'native-upload@example.test', password_hash: 'unused', email_verified: true });
    const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
    const token = 'native-upload-admission-session';
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
    const store = createMemoryStorage();
    const row = makeRow({ id: asId('upload-entry'), data: { label: 'Uploaded', attachment: null } });
    await store.commit(makeBatch(await store.readRevision(), { writes: [
      { kind: 'insert', model: asModel('TypedFileJourney.Entry'), row },
    ] }));
    const db = await runtime.getD1Database('DB');
    const files = await createWorkerFiles({ artifact, asm, store, identities, clock,
      env: { DB: db, FILES: await runtime.getR2Bucket('FILES') }, origin: 'https://files.test',
      retention: { unattachedHorizonMs: 86400000, retentionMs: 86400000 }, intentTtlMs: 900000 });
    assert.ok(files, 'the compiler must install its implicit Files binding');
    assert.ok(files.fetch, 'the Files binding must expose its HTTP handler');
    assert.ok(files.intentsUrl, 'the Files binding must expose its upload-intent endpoint');
    const fetchFiles = files.fetch.bind(files);
    const headers = { 'content-type': 'application/json', cookie: `can_session=${token}`,
      'x-csrf-token': await deriveCsrfToken(token) };
    const body = { upload_id: 'native-one', operation: 'TypedFileJourney.attach', field: '/attachment',
      arguments: { entry: { id: row.id, version: String(row.version) } }, name: 'native.txt', type: 'text/plain', size: '5' };
    const intent = (input: unknown, withHeaders: ConstructorParameters<typeof Headers>[0] = headers) => fetchFiles(new Request(files.intentsUrl!,
      { method: 'POST', headers: withHeaders, body: JSON.stringify(input) }));
    // accept is deliberately absent: the later business Require remains unevaluated.
    const granted = await intent(body);
    assert.equal(granted.status, 200, await granted.clone().text());
    const grant = await granted.json() as { intent_id: string; content: string; finalize: string };
    assert.deepEqual(await (await intent(body)).json(), grant);
    for (const input of [
      { ...body, operation: 'TypedFileJourney.missing' },
      { ...body, operation: 'TypedFileJourney.Entry.delete' },
      { ...body, field: '/accept' },
      { ...body, arguments: {} },
      { ...body, arguments: { entry: { id: row.id, version: '999' } } },
      { ...body, arguments: { ...body.arguments, unexpected: true } },
    ]) {
      const denied = await intent({ ...input, upload_id: 'invalid' });
      assert.ok([400, 403, 404, 409].includes(denied.status), await denied.clone().text());
    }
    assert.equal((await intent(body, { 'content-type': 'application/json' })).status, 401);
    assert.equal((await intent(body, { ...headers, 'x-csrf-token': 'wrong' })).status, 403);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM can_files_intents').first<{ count: number }>())?.count, 1);
    const nested = { ...body, upload_id: 'nested-one', operation: 'TypedFileJourney.nested',
      field: '/envelope/drafts/0/attachment', arguments: {} };
    for (const args of [{}, { envelope: {} }, { envelope: { drafts: [] } }, { envelope: { drafts: [{}] } }]) {
      assert.equal((await intent({ ...nested, arguments: args })).status, 400,
        'creating optional File ancestors still requires their required record siblings');
    }
    for (const draft of [
      { entry: body.arguments.entry, note: 123 },
      { entry: body.arguments.entry, unknown: true },
      { entry: { id: row.id, version: 'invalid' } },
    ]) {
      assert.equal((await intent({ ...nested, arguments: { envelope: { drafts: [draft] } } })).status, 400,
        'partial drafts still validate supplied scalar, reference and closed-object shape');
    }
    const nestedGranted = await intent({ ...nested,
      arguments: { envelope: { drafts: [{ entry: body.arguments.entry }] } } });
    assert.equal(nestedGranted.status, 200, await nestedGranted.clone().text());
    const union = { ...body, upload_id: 'union-one', operation: 'TypedFileJourney.unionDraft', field: '/payload/draft/value/attachment' };
    for (const draft of [{ value: {} }, { type: 'TypedFileJourney.Unknown', value: {} },
      { type: 'TypedFileJourney.UploadDraft', value: { entry: body.arguments.entry, note: 123 } }]) {
      assert.equal((await intent({ ...union, arguments: { payload: { draft } } })).status, 400,
        'draft unions require a declared discriminator and validate their supplied branch');
    }
    const unionGranted = await intent({ ...union,
      arguments: { payload: { draft: { type: 'TypedFileJourney.UploadDraft', value: { entry: body.arguments.entry } } } } });
    assert.equal(unionGranted.status, 200, await unionGranted.clone().text());
    const appended = await fetchFiles(new Request(grant.content, { method: 'PUT',
      headers: { ...headers, 'upload-offset': '0' }, body: 'hello' }));
    assert.equal(appended.status, 200, await appended.clone().text());
    const digest = `sha256:${createHash('sha256').update('hello').digest('hex')}`;
    const finalized = await fetchFiles(new Request(grant.finalize, { method: 'POST', headers,
      body: JSON.stringify({ upload_id: body.upload_id, bytes_digest: digest }) }));
    assert.equal(finalized.status, 200, await finalized.clone().text());
    assert.ok(await finalized.json());
    await store.commit(makeBatch(await store.readRevision(), { writes: [
      { kind: 'update', model: asModel('TypedFileJourney.Entry'), id: row.id, expectedVersion: row.version,
        row: makeRow({ id: row.id, version: 2, data: { label: 'Changed', attachment: null } }) },
    ] }));
    assert.equal((await intent(body)).status, 409, 'a retained retry must load the current record version');
    await identities.removeMembership(membership.membership_id);
    assert.notEqual((await intent(body)).status, 200, 'a retained retry must recheck current membership');
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM can_files_intents').first<{ count: number }>())?.count, 3);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 120000);

it('executes original CanCreative graph review and generated publication', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'can-native-inspect-files-'));
  const runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-15',
    script: 'export default {fetch(){return new Response("ready")}}',
    d1Databases: { DB: 'native-inspect-files' }, r2Buckets: { FILES: 'native-inspect-files' } });
  try {
    // These native imports preserve the actual assembler and File issuers.
    const requireNative = createRequire(import.meta.url);
    const { assembleModules } = requireNative(fileURLToPath(new URL('../dist/runtime/modules.js', import.meta.url))) as
      typeof import('../src/runtime/modules.js');
    const { createWorkerFiles } = requireNative(fileURLToPath(new URL('../dist/runtime/worker-files.js', import.meta.url))) as
      typeof import('../src/runtime/worker-files.js');
    const { resolveR2FileStoreIdentity } = requireNative(fileURLToPath(new URL('../dist/runtime/r2-files.js', import.meta.url))) as
      typeof import('../src/runtime/r2-files.js');
    const { installNativeFileInventory } = requireNative(fileURLToPath(new URL('../dist/runtime/file-inventory.js', import.meta.url))) as
      typeof import('../src/runtime/file-inventory.js');
    const { loadCanonicalDescriptors } = requireNative(fileURLToPath(new URL('../dist/runtime/invoke.js', import.meta.url))) as
      typeof import('../src/runtime/invoke.js');
    const { loadOpaqueFileStaging } = requireNative(fileURLToPath(new URL('../dist/runtime/opaque-file-staging.js', import.meta.url))) as
      typeof import('../src/runtime/opaque-file-staging.js');
    const { buildInvoker } = requireNative(fileURLToPath(new URL('../dist/worker/assembly.js', import.meta.url))) as
      typeof import('../src/worker/assembly.js');
    const { createTestMemoryStorage } = requireNative('@canlang/state/storage/memory') as typeof import('@canlang/state/storage/memory');
    const { STATE_FILE_REFERENCE_PRODUCER } = requireNative('@canlang/state/storage') as typeof import('@canlang/state/storage');
    const { WORK_FILE_REFERENCE_PRODUCER } = requireNative('@canlang/work/kernel/file-reference-inventory') as
      typeof import('@canlang/work/kernel/file-reference-inventory');
    const { resolveIdentity } = requireNative('@canlang/identity') as typeof import('@canlang/identity');
    const { ComfyUINativeAdapter, digestGraph } = requireNative('@canlang/services') as typeof import('@canlang/services');
    const { createBoundImagesAdapter } = requireNative(fileURLToPath(new URL('../dist/runtime/bound-images.js', import.meta.url))) as
      typeof import('../src/runtime/bound-images.js');
    const { createBoundImagesDispatcher } = requireNative(fileURLToPath(new URL('../dist/runtime/bound-dispatch.js', import.meta.url))) as
      typeof import('../src/runtime/bound-dispatch.js');
    const { importVerifiedAssemblyModule } = requireNative(fileURLToPath(new URL('../dist/runtime/assembly-verification.js', import.meta.url))) as
      typeof import('../src/runtime/assembly-verification.js');
    const { WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS, createWorkDispatchClaimCommand } =
      requireNative('@canlang/work/kernel/commands') as typeof import('@canlang/work/kernel/commands');
    const { planRecoveryScan } = requireNative('@canlang/work/recovery') as typeof import('@canlang/work/recovery');
    const { attemptDispatch } = requireNative('@canlang/work/dispatch') as typeof import('@canlang/work/dispatch');
    const { classifyFailure } = requireNative('@canlang/work/receipt') as typeof import('@canlang/work/receipt');
    const { RECEIPT_MODEL, readReceiptRow } = requireNative('@canlang/state/receipt/tables') as typeof import('@canlang/state/receipt/tables');
    const { uuidv7 } = requireNative('@canlang/state/testing/invocation/fixtures') as typeof import('@canlang/state/testing/invocation/fixtures');
    const apiGraph: ConstructorParameters<typeof ComfyUINativeAdapter>[0]['graph'] = {
      3: { class_type: 'KSampler', inputs: { seed: 42, steps: 20, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent: ['5', 0] } },
      4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'approved.safetensors' } },
      5: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
      6: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
      7: { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
      9: { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: 'reviewed-output' } },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(apiGraph));
    const literal = (...values: (string | number)[]) => ({ kind: 'literal' as const, values });
    const link = (node: string, output = 0) => ({ kind: 'link' as const, node, output });
    const integer = (label: string, min: number, max: number) => ({ kind: 'integer' as const, label, min, max });
    const text = (label: string) => ({ kind: 'text' as const, label, maxLength: 8192 });
    const workflowPolicy = { revision: 'reviewed-native-v1', maxNodes: 6, maxGraphBytes: 16384, outputs: ['9'], nodes: {
      3: { classType: 'KSampler', inputs: { seed: integer('Seed', 42, 42), steps: literal(20), model: link('4'), positive: link('6'), negative: link('7'), latent: link('5') } },
      4: { classType: 'CheckpointLoaderSimple', inputs: { ckpt_name: literal('approved.safetensors') } },
      5: { classType: 'EmptyLatentImage', inputs: { width: integer('Width', 256, 1536), height: integer('Height', 256, 1536) } },
      6: { classType: 'CLIPTextEncode', inputs: { text: text('Prompt'), clip: link('4', 1) } },
      7: { classType: 'CLIPTextEncode', inputs: { text: text('Negative prompt'), clip: link('4', 1) } },
      9: { classType: 'SaveImage', inputs: { images: link('3'), filename_prefix: literal('reviewed-output') } },
    } };
    // This dependency selection supplements the full draft compilation. Keep
    // authored declarations and action bodies verbatim, including their guards.
    const creative = await readFile(join(root, 'draft/apps/CanCreative/CanCreative.can'), 'utf8');
    const chat = await readFile(join(root, 'draft/apps/CanChat/CanChat.can'), 'utf8');
    const declaration = (text: string, heading: string) => {
      const lines = text.split('\n'), matches = lines.flatMap((line, index) => line.startsWith(heading) ? [index] : []);
      assert.equal(matches.length, 1, `One exact original declaration required for ${heading}`);
      const start = matches[0]!;
      let end = start + 1;
      while (end < lines.length && (lines[end] === '' || lines[end]!.startsWith('   '))) end++;
      return lines.slice(start, end).join('\n') + '\n';
    };
    const transcript = chat.split('\n').filter(line => line.startsWith('  export derive transcript('));
    assert.equal(transcript.length, 1, 'only the unreferenced transcript helper is excluded');
    const chatGiven = chat.slice(chat.indexOf('package chat'), chat.indexOf('\n When'))
      .split('\n').filter(line => line !== transcript[0]).join('\n');
    const creativeGiven = creative.slice(creative.indexOf('package creative'), creative.indexOf('\n When'));
    const selected = ['  crud Template ', '  scenario template_edited ', '  scenario inspect(',
      '  scenario validate(', '  scenario publish('].map(heading => declaration(creative, heading));
    const source = join(directory, 'CanCreative.can');
    await writeFile(source, creative.slice(0, creative.indexOf('package creative')) +
      chatGiven + '\n When\n Then\n' + creativeGiven + '\n When\n' + selected.join('') + ' Then\n');
    const artifact = JSON.parse(execFileSync(process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can'),
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog',
        process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json'), source],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' })) as CompileArtifact;
    for (const name of ['creative.inspect', 'creative.validate']) {
      const operation = artifact.operations?.find(candidate => candidate.name === name);
      assert.ok(operation?.result?.disclosure, `${name} must have a native checked receipt; legacy fallback is insufficient`);
    }
    const assemblyOptions = { workDir: directory, stdlibUrl: new URL('../dist/runtime/stdlib.js', import.meta.url).href,
      uiUrl: pathToFileURL(requireNative.resolve('@canlang/ui')).href };
    const asm = await assembleModules({ artifact, sourcePath: source }, assemblyOptions);
    const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const user = await identities.createUser({ email: 'native-inspect@example.test', password_hash: 'unused', email_verified: true });
    const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [{ role: 'creative.creative_manager',
      granted_at: new Date(now).toISOString(), granted_by: user.user_id }] });
    const token = 'native-inspect-files-session';
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const db = await runtime.getD1Database('DB'), bucket = await runtime.getR2Bucket('FILES');
    const fileStoreId = await resolveR2FileStoreIdentity({ db, bucket: bucket as unknown as Parameters<typeof resolveR2FileStoreIdentity>[0]['bucket'], namespace: 'CanCreative/FILES' });
    const scope = { app: 'CanCreative', owner: team.team_id, ownerPackage: 'creative' };
    const authority = { app: scope.app, stateOwner: scope.ownerPackage, stateStoreId: 'native-inspect-state', fileStoreId,
      receiver: { app: scope.app, team: scope.owner, owner: scope.owner } };
    const { store, probe, reopen } = createTestMemoryStorage(authority,
      [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
    const verifyOwner = async () => { assert.ok(await identities.findTeamById(team.team_id)); };
    await installNativeFileInventory({ artifact, asm, store, authority, scope, now: () => now, verifyOwner });
    const filesOptions = { artifact, asm, store, identities, clock, env: { DB: db, FILES: bucket }, origin: 'https://files.test',
      retention: { unattachedHorizonMs: 86400000, retentionMs: 86400000 }, intentTtlMs: 900000 };
    const files = await createWorkerFiles(filesOptions);
    assert.ok(files?.canonical && files.fetch);
    assert.equal(files.fileStoreId, fileStoreId);
    const headers = { 'content-type': 'application/json', cookie: `can_session=${token}`,
      'x-csrf-token': await deriveCsrfToken(token) };
    const operation = 'creative.inspect';
    const grantResponse = await files.fetch(new Request(files.intentsUrl!, { method: 'POST', headers,
      body: JSON.stringify({ upload_id: 'inspect-graph', operation: 'creative.Template.create', field: '/graph',
        arguments: { name: 'Reviewed original workflow' }, name: 'graph.txt', type: 'text/plain',
        size: String(bytes.length) }) }));
    assert.equal(grantResponse.status, 200, await grantResponse.clone().text());
    const grant = await grantResponse.json() as { content: string; finalize: string };
    const uploaded = await files.fetch(new Request(grant.content, { method: 'PUT',
      headers: { ...headers, 'upload-offset': '0' }, body: bytes }));
    assert.equal(uploaded.status, 200, await uploaded.clone().text());
    const finalized = await files.fetch(new Request(grant.finalize, { method: 'POST', headers,
      body: JSON.stringify({ upload_id: 'inspect-graph', bytes_digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }) }));
    assert.equal(finalized.status, 200, await finalized.clone().text());
    const { file: graph } = await finalized.json() as { file: string };
    assert.equal(typeof graph, 'string');
    let sequence = 1;
    const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now, files: files.canonical });
    const createId = uuidv7(now, ++sequence);
    const created = await invoker.invokeMutation({ operation: 'creative.Template.create', operation_id: createId,
      inputs: { name: 'Reviewed original workflow', graph: { id: graph } } }, identity);
    assert.equal('result' in created ? created.result.status : created.error.code, 'committed', JSON.stringify(created));
    const row = await store.load(asModel('creative.Template'), asId(createId));
    assert.ok(row, 'the Template is created by native CRUD, never seeded around its owner rule');
    assert.deepEqual(row.data['owner'], { id: user.user_id });
    // These are real current identities: neither a manager owning another
    // person's Template nor an ordinary member may run the authored action.
    const deniedIdentities = [];
    for (const [label, manager] of [['ordinary-member', false], ['other-manager', true]] as const) {
      const deniedUser = await identities.createUser({ email: `${label}@example.test`, password_hash: 'unused', email_verified: true });
      await identities.createMembership({ team_id: team.team_id, user_id: deniedUser.user_id, is_owner: false,
        roles: manager ? [{ role: 'creative.creative_manager', granted_at: new Date(now).toISOString(), granted_by: user.user_id }] : [] });
      const deniedToken = `creative-${label}`;
      await identities.createSession({ user_id: deniedUser.user_id, token_sha256: await sha256HexText(deniedToken),
        last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
      deniedIdentities.push(await resolveIdentity(identities, { session_token: deniedToken }, { clock }));
    }
    for (const deniedIdentity of deniedIdentities) {
      const beforeDenial: StoredRow | null = structuredClone(await store.load(asModel('creative.Template'), row.id));
      const beforeDeniedSend = probe.outboxAll().length;
      const denied = await invoker.invokeMutation({ operation, operation_id: uuidv7(now, ++sequence),
        inputs: { template: { id: row.id, version: String(row.version) } } }, deniedIdentity);
      assert.ok(!('result' in denied) || denied.result.status !== 'committed', JSON.stringify(denied));
      assert.deepEqual(await store.load(asModel('creative.Template'), row.id), beforeDenial, 'role and owner denial leave the source unchanged');
      assert.equal(probe.outboxAll().length, beforeDeniedSend, 'denied actions stage no SEND');
    }
    const before = await store.readRevision();
    const operationId = uuidv7(now, ++sequence);
    const invoked = await invoker.invokeMutation({ operation, operation_id: operationId,
      inputs: { template: { id: row.id, version: String(row.version) } } }, identity);
    assert.equal('result' in invoked ? invoked.result.status : invoked.error.code, 'committed', JSON.stringify(invoked));
    const [intent] = probe.outboxAll();
    assert.ok(intent);
    assert.equal(probe.outboxAll().length, 1);
    assert.equal(intent.target, 'std.ImagesV1.inspect');
    assert.equal(intent.dispatchGuard, undefined, 'unconditional SEND must not acquire a fabricated dispatch Rule');
    const dispatch = await store.load(asModel('work.dispatch'), asId(intent.intentId));
    assert.ok(dispatch);
    assert.deepEqual(dispatch.data['sendInputs'], { graph: { id: graph } });
    const binding = dispatch.data['sendInputsOrigin'] as import('@canlang/contracts').FrameworkFilePayloadOrigin;
    assert.ok(binding);
    assert.equal(binding.slot.model, 'work.dispatch');
    assert.equal(binding.slot.id, dispatch.id);
    assert.equal(binding.slot.field, 'sendInputs');
    assert.deepEqual(binding.scope, scope);
    assert.equal(binding.origin.kind, 'send-input');
    assert.deepEqual(binding.files.map(item => ({ path: item.path, ref: item.file.ref })), [{ path: ['graph'], ref: graph }]);
    assert.deepEqual((await store.load(asModel('creative.Template'), row.id))?.data['inspection'], { id: intent.intentId, operation: intent.target });

    const openReader = async (readerAsm: typeof asm, readerStore: typeof store, readerArtifact = artifact) => {
      const loaded = await loadCanonicalDescriptors(readerAsm, readerArtifact);
      assert.ok(loaded.valueTypes);
      const operations = new Map<string, { canonical: import('@canlang/contracts').CanonicalOperationDescriptor;
        artifact: NonNullable<CompileArtifact['operations']>[number] }>();
      for (const name of [operation, 'creative.validate', 'creative.publish']) {
        const definition = loaded.registry.get(name) as { descriptor: import('@canlang/contracts').CanonicalOperationDescriptor } | undefined;
        const declaration = readerArtifact.operations?.find(candidate => candidate.name === name);
        assert.ok(definition?.descriptor && declaration);
        operations.set(name, { canonical: definition.descriptor, artifact: declaration });
      }
      const opaque = await loadOpaqueFileStaging({ store: readerStore, inventoryOwner: scope.ownerPackage,
        artifact: readerArtifact, canonicalModels: loaded.models, valueTypes: loaded.valueTypes,
        operations, scope, verify: verifyOwner });
      assert.ok(opaque);
      const original = opaque.sendInputs(operation, intent.target);
      assert.equal(binding.origin.kind, 'send-input');
      if (binding.origin.kind !== 'send-input') throw new Error('missing original SEND input binding');
      assert.equal(binding.origin.inputsDeclarationId, original.inputsDeclarationId);
      assert.deepEqual(binding.origin.caller, original.caller);
      return opaque;
    };
    const opaque = await openReader(asm, store), revision = await store.readRevision();
    const retained = { model: asModel('work.dispatch'), row: dispatch, field: 'sendInputs' as const, binding };
    const request = { source: retained, revision, path: ['graph'], ref: graph, maxBytes: bytes.length };
    assert.deepEqual(await opaque.readSourceFile(request, files.canonical), bytes);
    for (const changed of [
      { ...request, path: ['not-graph'] },
      { ...request, ref: `${graph}-foreign` },
      { ...request, revision: before },
      { ...request, source: { ...retained, row: { ...dispatch, version: (dispatch.version + 1) as typeof dispatch.version } } },
      { ...request, source: { ...retained, binding: { ...binding, files: [] } } },
      { ...request, source: { ...retained, binding: { ...binding, slot: { ...binding.slot, id: asId('other-dispatch') } } } },
    ]) await assert.rejects(() => opaque.readSourceFile(changed, files.canonical));
    const reopened = reopen(authority, [STATE_FILE_REFERENCE_PRODUCER, WORK_FILE_REFERENCE_PRODUCER]);
    const reopenedArtifact = structuredClone(artifact);
    const reopenedAsm = await assembleModules({ artifact: reopenedArtifact, sourcePath: source }, { ...assemblyOptions, workDir: join(directory, 'reopened') });
    await installNativeFileInventory({ artifact: reopenedArtifact, asm: reopenedAsm, store: reopened, authority, scope, now: () => now, verifyOwner });
    const reopenedFiles = await createWorkerFiles({ ...filesOptions, artifact: reopenedArtifact, asm: reopenedAsm, store: reopened });
    assert.ok(reopenedFiles?.canonical);
    const reopenedReader = await openReader(reopenedAsm, reopened, reopenedArtifact);
    assert.deepEqual(await reopenedReader.readSourceFile(request, reopenedFiles.canonical), bytes);
    assert.deepEqual(await reopened.load(asModel('work.dispatch'), dispatch.id), dispatch);

    // The installed adapter receives the graph through the retained Work source,
    // not a provider URL or an arbitrary File ref supplied by the dispatcher.
    const providerBinding = { capability: 'std.ImagesV1', capabilityVersion: 1, account: 'reviewed-local-comfy', deployment: 'deployment.images' };
    const mapping = { workflow: graph, graphDigest: digestGraph(apiGraph), inputs: {
      prompt: { node: '6', key: 'text' }, negative: { node: '7', key: 'text' },
      width: { node: '5', key: 'width' }, height: { node: '5', key: 'height' }, seed: { node: '3', key: 'seed' },
    }, outputs: ['9'] };
    const workflow = { graph, prompt: mapping.inputs.prompt, negative: mapping.inputs.negative,
      width: mapping.inputs.width, height: mapping.inputs.height };
    const providerOrigin = 'https://comfy-no-network.invalid';
    const installed = new ComfyUINativeAdapter({ baseUrl: providerOrigin, timeoutMs: 5000, maxBodyBytes: 65536,
      graph: apiGraph, mapping, clientId: 'native-workflow-review', maxDownloadBytes: 65536, maxOutputs: 4 })
      .installImages({ binding: providerBinding, workflow, seed: { kind: 'fixed', value: 42 }, workflowPolicy });
    assert.ok(installed.workflows);
    assert.equal(installed.workflows.matchesGraph(bytes), true);
    assert.equal(installed.workflows.matchesGraph(new TextEncoder().encode(JSON.stringify({ ...apiGraph,
      4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'unreviewed.safetensors' } } }))), false);
    const originalModule = await importVerifiedAssemblyModule(reopenedAsm, reopenedArtifact.modules[0]!.path, reopenedArtifact) as { appDefinition: unknown };
    let graphReads = 0, providerHttpRequests = 0, dispatchNow = now + 1, interruptGraphRead = false;
    const adapter = createBoundImagesAdapter({ appDefinition: originalModule.appDefinition, binding: providerBinding,
      resolveInstalledImages: deployment => deployment === providerBinding.deployment ? installed : null,
      finalizeOutput: async () => { throw new Error('Workflow review must never finalize generated images'); },
      readWorkflowGraph: async (selected, ref) => {
        graphReads++;
        const bytes = await reopenedReader.readSendInputFile({ intent: selected, revision: await reopened.readRevision(),
          path: selected.target === 'std.ImagesV1.validate' ? ['value', 'graph'] : ['graph'], ref,
          maxBytes: installed.workflows!.maxGraphBytes }, reopenedFiles.canonical);
        if (interruptGraphRead) { interruptGraphRead = false; throw new Error('injected graph-read response loss'); }
        return bytes;
      } });
    const makeDispatcher = (dispatcherStore = reopened) => createBoundImagesDispatcher({ store: dispatcherStore, fileOriginStore: reopened, adapter,
      workCommands: WORK_SYSTEM_COMMANDS, stageCommands: WORK_DISPATCH_STAGE_COMMANDS, createClaimCommand: createWorkDispatchClaimCommand });
    const fenceFor = (_selected: typeof intent) => ({ owner: scope.owner, attemptDispatch: attemptDispatch as unknown as import('../src/runtime/invoke.js').FenceAttemptDispatchFn,
      revalidateAuthority: async () => {
        const current = await identities.findMembership(team.team_id, user.user_id);
        return current?.status === 'active' && current.roles.some(role => role.role === 'creative.creative_manager');
      } });
    const drive = (dispatcher: Awaited<ReturnType<typeof makeDispatcher>>, selected: typeof intent) => dispatcher.drive({
      intentId: selected.intentId, actor: user.user_id, operation: 'test.files.workflow.dispatch', nowMs: () => dispatchNow,
      nextClaimId: () => `workflow-claim-${++sequence}`, maxClaimAgeMs: 60000,
      claimOperationId: uuidv7(now + 1, ++sequence), recordOperationId: uuidv7(now + 1, ++sequence), classifyFailure,
      evaluateGuard: () => { throw new Error('Unconditional workflow SEND must not invent a guard'); },
      readStateSnapshot: () => null, fence: fenceFor(selected) });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).origin === providerOrigin) {
        providerHttpRequests++;
        throw new Error('Workflow inspect/validate must not contact ComfyUI HTTP');
      }
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const dispatcher = await makeDispatcher();
      const inspected = await drive(dispatcher, intent);
      assert.equal(inspected.status, 'recorded', JSON.stringify(inspected));
      if (inspected.status === 'recorded') assert.equal(inspected.state, 'delivered');
      const inspectionRow = await reopened.load(asModel(RECEIPT_MODEL), asId(intent.intentId));
      assert.ok(inspectionRow);
      const inspection = readReceiptRow(inspectionRow).receipt;
      assert.equal(inspection.status, 'succeeded');
      assert.deepEqual((inspection.result as { fields: unknown }).fields, [
        { node: '6', key: 'text', kind: 'text', label: 'Prompt' },
        { node: '7', key: 'text', kind: 'text', label: 'Negative prompt' },
        { node: '5', key: 'width', kind: 'int', label: 'Width' },
        { node: '5', key: 'height', kind: 'int', label: 'Height' },
      ]);
      const receiptBeforeReplay = structuredClone(inspectionRow), readsBeforeReplay = graphReads;
      assert.equal((await drive(await makeDispatcher(), intent)).status, 'not-pending');
      assert.equal(graphReads, readsBeforeReplay, 'acknowledged replay does not inspect again');
      assert.deepEqual(await reopened.load(asModel(RECEIPT_MODEL), asId(intent.intentId)), receiptBeforeReplay);
      const reconciled = await adapter.reconcile(intent, { stagedAtMs: dispatch.created,
        onQueued: async () => { throw new Error('Inspection has no generation queue'); },
        onProgress: async () => { throw new Error('Inspection has no ImageRun progress'); } });
      assert.equal(reconciled?.kind, 'delivered');

      const reopenedInvoker = buildInvoker(reopenedArtifact, reopenedAsm, reopened,
        { memberships: identities, now: () => now, files: reopenedFiles.canonical });
      const validate = async () => {
        const current = await reopened.load(asModel('creative.Template'), row.id);
        assert.ok(current);
        const validationOperationId = uuidv7(now, ++sequence);
        const outcome = await reopenedInvoker.invokeMutation({ operation: 'creative.validate', operation_id: validationOperationId,
          inputs: { template: { id: current.id, version: String(current.version) } } }, identity);
        assert.equal('result' in outcome ? outcome.result.status : outcome.error.code, 'committed', JSON.stringify(outcome));
        const pending = probe.outboxAll().find(candidate => candidate.operation === 'creative.validate' &&
          candidate.intentId !== intent.intentId && candidate.operationId === validationOperationId);
        // The probe retains the actual original Work intent, including after ack.
        assert.ok(pending);
        assert.ok('result' in outcome && outcome.result.result && typeof outcome.result.result === 'object');
        const returned = outcome.result.result as { id: string; version: string };
        assert.equal(typeof returned.id, 'string');
        const revision = await reopened.load(asModel('creative.Revision'), asId(returned.id));
        assert.ok(revision);
        assert.deepEqual(revision.parent, { model: 'creative.Template', id: row.id });
        assert.deepEqual(revision.data['validation'], { id: pending.intentId, operation: pending.target });
        return { pending, revision };

      };
      const { pending: validationIntent, revision: workflowRevision } = await validate();
      const frozenDefinition = structuredClone(workflowRevision.data['definition']);
      const publish = async (selected = workflowRevision, actor = identity) => {
        const current = await reopened.load(asModel('creative.Revision'), selected.id);
        assert.ok(current);
        return reopenedInvoker.invokeMutation({ operation: 'creative.publish', operation_id: uuidv7(now, ++sequence),
          inputs: { revision: { id: current.id, version: String(current.version) } } }, actor);
      };
      const assertRefused = (outcome: Awaited<ReturnType<typeof publish>>) => {
        assert.ok(!('result' in outcome) || outcome.result.status !== 'committed', JSON.stringify(outcome));
      };
      for (const deniedIdentity of deniedIdentities) assertRefused(await publish(workflowRevision, deniedIdentity));
      const beforePendingPublish = structuredClone(await reopened.load(asModel('creative.Revision'), workflowRevision.id));
      const beforePendingTemplate = structuredClone(await reopened.load(asModel('creative.Template'), row.id));
      assertRefused(await publish());
      assert.deepEqual(await reopened.load(asModel('creative.Revision'), workflowRevision.id), beforePendingPublish);
      assert.deepEqual(await reopened.load(asModel('creative.Template'), row.id), beforePendingTemplate, 'pending validation cannot publish or change current');
      const validated = await drive(dispatcher, validationIntent);
      assert.equal(validated.status, 'recorded', JSON.stringify(validated));
      if (validated.status === 'recorded') assert.equal(validated.state, 'delivered');
      const validationRow = await reopened.load(asModel(RECEIPT_MODEL), asId(validationIntent.intentId));
      assert.ok(validationRow);
      const validation = readReceiptRow(validationRow).receipt;
      assert.equal(validation.status, 'succeeded');
      assert.deepEqual(validation.result, { valid: true, digest: installed.validation, detail: null });
      assert.ok(graphReads >= 3, 'inspect, reconcile and validate read actual retained source Files');
      // The same owner/role may see status without receiving the provider
      // result. A successful receipt cannot turn that partial grant into DATA.
      const statusOnlySource = join(directory, 'status-only.can');
      const selectedSource = await readFile(source, 'utf8');
      const statusOnlyText = selectedSource.replace(
        '  policy Revision read=creative_manager and row.parent.owner==actor',
        '  policy Revision read=creative_manager and row.parent.owner==actor fields=parent,published,validation.status');
      assert.notEqual(statusOnlyText, selectedSource);
      await writeFile(statusOnlySource, statusOnlyText);
      const statusOnlyArtifact = JSON.parse(execFileSync(process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can'),
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog',
          process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json'), statusOnlySource],
        { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' })) as CompileArtifact;
      const statusOnlyAsm = await assembleModules({ artifact: statusOnlyArtifact, sourcePath: statusOnlySource },
        { ...assemblyOptions, workDir: join(directory, 'status-only') });
      const statusOnlyInvoker = buildInvoker(statusOnlyArtifact, statusOnlyAsm, reopened,
        { memberships: identities, now: () => now, files: reopenedFiles.canonical });
      const beforeWithheldRevision = await reopened.load(asModel('creative.Revision'), workflowRevision.id);
      const beforeWithheldTemplate = await reopened.load(asModel('creative.Template'), row.id);
      const beforeWithheldOutbox = await reopened.outboxPending();
      const withheld = await statusOnlyInvoker.invokeMutation({ operation: 'creative.publish', operation_id: uuidv7(now, ++sequence),
        inputs: { revision: { id: workflowRevision.id, version: String(workflowRevision.version) } } }, identity);
      assert.ok('error' in withheld, JSON.stringify(withheld));
      assert.equal(withheld.error.code, 'forbidden');
      assert.deepEqual(await reopened.load(asModel('creative.Revision'), workflowRevision.id), beforeWithheldRevision);
      assert.deepEqual(await reopened.load(asModel('creative.Template'), row.id), beforeWithheldTemplate);
      assert.deepEqual(await reopened.outboxPending(), beforeWithheldOutbox);
      const publishRequest = { operation: 'creative.publish', operation_id: uuidv7(now, ++sequence),
        inputs: { revision: { id: workflowRevision.id, version: String(workflowRevision.version) } } };
      const published = await reopenedInvoker.invokeMutation(publishRequest, identity);
      assert.equal('result' in published ? published.result.status : published.error.code, 'committed', JSON.stringify(published));
      const publishedRevision = await reopened.load(asModel('creative.Revision'), workflowRevision.id);
      assert.ok(publishedRevision);
      assert.equal(publishedRevision.data['published'], true);
      assert.equal(publishedRevision.data['digest'], installed.validation);
      assert.deepEqual(publishedRevision.data['definition'], frozenDefinition);
      const afterPublication = await reopened.readRevision();
      const replayed = await reopenedInvoker.invokeMutation(publishRequest, identity);
      assert.ok('result' in replayed);
      assert.equal(replayed.result.status, 'replayed');
      assert.equal(replayed.result.result, null);
      assert.deepEqual(replayed.result.records, []);
      assert.equal(await reopened.readRevision(), afterPublication, 'publication replay performs no effects');
      assertRefused(await publish());
      const currentTemplate = await reopened.load(asModel('creative.Template'), row.id);
      assert.ok(currentTemplate);
      assert.equal((currentTemplate.data['current'] as { id: string }).id, workflowRevision.id);
      const edited = await reopenedInvoker.invokeMutation({ operation: 'creative.Template.update', operation_id: uuidv7(now, ++sequence),
        inputs: { record: { id: currentTemplate.id, version: String(currentTemplate.version) }, prompt_node: '7' } }, identity);
      assert.equal('result' in edited ? edited.result.status : edited.error.code, 'committed', JSON.stringify(edited));
      assert.deepEqual((await reopened.load(asModel('creative.Revision'), workflowRevision.id))?.data['definition'], frozenDefinition,
        'editing a draft cannot change the frozen revision definition');
      const { pending: invalidIntent, revision: invalidRevision } = await validate();
      assert.equal((await drive(dispatcher, invalidIntent)).status, 'recorded');
      const invalidRow = await reopened.load(asModel(RECEIPT_MODEL), asId(invalidIntent.intentId));
      assert.ok(invalidRow);
      assert.equal((readReceiptRow(invalidRow).receipt.result as { valid: boolean }).valid, false);
      assertRefused(await publish(invalidRevision));
      const editedTemplate = await reopened.load(asModel('creative.Template'), row.id);
      assert.ok(editedTemplate);
      const restored = await reopenedInvoker.invokeMutation({ operation: 'creative.Template.update', operation_id: uuidv7(now, ++sequence),
        inputs: { record: { id: row.id, version: String(editedTemplate.version) }, prompt_node: '6' } }, identity);
      assert.equal('result' in restored ? restored.result.status : restored.error.code, 'committed', JSON.stringify(restored));

      const currentRevision = await reopened.readRevision();
      await assert.rejects(reopenedReader.readSendInputFile({ intent: { ...validationIntent,
        arguments: { ...validationIntent.arguments, from: 'deployment.other' } }, revision: currentRevision,
        path: ['value', 'graph'], ref: graph, maxBytes: bytes.length }, reopenedFiles.canonical));
      const { pending: interruptedIntent } = await validate();
      let interruptCompletion = true;
      const interruptedStore = { ...reopened, commit: async (batch: Parameters<typeof reopened.commit>[0]) => {
        if (interruptCompletion && batch.outboxAck?.includes(interruptedIntent.intentId)) {
          interruptCompletion = false;
          throw new Error('injected workflow completion interruption');
        }
        return reopened.commit(batch);
      } };
      const interruptedDispatcher = await makeDispatcher(interruptedStore);
      await assert.rejects(() => drive(interruptedDispatcher, interruptedIntent), /injected workflow completion interruption/);
      const recovery = await makeDispatcher();
      const recover = () => recovery.recover({ actor: user.user_id, operation: 'test.workflow.recovery',
        nowMs: () => now + 60002, maxClaimAgeMs: 60000, limit: 10,
        policy: { maxAttempts: 3, horizonMs: 3600000 }, planRecoveryScan,
        operationIdForStep: () => uuidv7(now + 60002, ++sequence),
        admission: { fence: fenceFor(interruptedIntent), evaluateGuard: () => { throw new Error('No invented workflow guard'); },
          readStateSnapshot: () => null } });
      const released = await recover();
      assert.ok(released.released.includes(interruptedIntent.intentId));
      dispatchNow = now + 60003;
      assert.equal((await drive(recovery, interruptedIntent)).status, 'recorded');
      const recoveredRow = await reopened.load(asModel(RECEIPT_MODEL), asId(interruptedIntent.intentId));
      assert.ok(recoveredRow);
      assert.deepEqual(readReceiptRow(recoveredRow).receipt.result, { valid: true, digest: installed.validation, detail: null });
      const { pending: uncertainIntent } = await validate();
      interruptGraphRead = true;
      const uncertain = await drive(await makeDispatcher(), uncertainIntent);
      assert.equal(uncertain.status, 'recorded');
      if (uncertain.status === 'recorded') assert.equal(uncertain.state, 'uncertain');
      const reconciledReview = await recover();
      assert.ok(reconciledReview.reconciled.some(item => item.intentId === uncertainIntent.intentId && item.state === 'delivered'), JSON.stringify(reconciledReview));
      const { pending: revoked } = await validate();
      const readsBeforeRevoke = graphReads;
      await identities.removeMembership(membership.membership_id);
      const refused = await drive(dispatcher, revoked);
      assert.notEqual(refused.status, 'recorded', 'current membership must survive the dispatch fence');
      assert.equal(graphReads, readsBeforeRevoke, 'revoked authority cannot reach graph bytes or the adapter');
      assertRefused(await publish());
      const beforeRevokedReplay = await reopened.readRevision();
      const revokedReplay = await reopenedInvoker.invokeMutation(publishRequest, identity);
      assert.ok('result' in revokedReplay);
      assert.equal(revokedReplay.result.status, 'replayed');
      assert.equal(revokedReplay.result.result, null);
      assert.deepEqual(revokedReplay.result.records, [], 'exact void replay discloses no saved business data after revocation');
      assert.equal(await reopened.readRevision(), beforeRevokedReplay);
      assert.equal(providerHttpRequests, 0, 'workflow review never generates or contacts the provider');
    } finally { globalThis.fetch = originalFetch; }
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 120000);

it('migrates retained Node blobs without changing store identity or bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-legacy-files-'));
  const path = join(directory, 'files.sqlite');
  const bytes = new Uint8Array(131073).map((_, index) => index % 251);
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE files_blobs (key TEXT PRIMARY KEY, bytes BLOB NOT NULL);
    CREATE TABLE files_store_identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), file_store_id TEXT NOT NULL, authority_json TEXT);
    INSERT INTO files_store_identity VALUES (1, 'retained-physical-store', NULL)`);
  legacy.prepare('INSERT INTO files_blobs (key, bytes) VALUES (?, ?)').run('legacy.bin', bytes);
  legacy.prepare('INSERT INTO files_blobs (key, bytes) VALUES (?, ?)').run('empty.bin', new Uint8Array());
  legacy.close();
  try {
    const store = createSqliteFileStore(path);
    try {
      assert.equal(store.fileStoreId, 'retained-physical-store');
      assert.deepEqual(store.blobs.read('legacy.bin'), bytes);
      assert.deepEqual(store.blobs.read('empty.bin'), new Uint8Array());
      const suffix = new Uint8Array([1, 2, 3]);
      store.blobs.append('legacy.bin', suffix);
      assert.deepEqual(store.blobs.read('legacy.bin'), new Uint8Array([...bytes, ...suffix]));
    } finally { store.close(); }
    const reopened = createSqliteFileStore(path);
    try {
      assert.equal(reopened.fileStoreId, 'retained-physical-store');
      assert.equal(reopened.blobs.sizeOf('legacy.bin'), bytes.byteLength + 3);
      assert.deepEqual(reopened.blobs.read('empty.bin'), new Uint8Array());
    } finally { reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('persists real finalized bytes and metadata, preserves observation issuance, and rolls back both', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-durable-files-'));
  const entry = join(directory, 'entry.js');
  const output = join(directory, 'worker.js');
  const adapter = createRequire(import.meta.url).resolve('@canlang/files/host/durable-sqlite');
  const finalize = createRequire(import.meta.url).resolve('@canlang/files/finalize');
  const upload = createRequire(import.meta.url).resolve('@canlang/files/upload');
  const bound = fileURLToPath(new URL('../dist/runtime/bound-files.js', import.meta.url));
  const staging = fileURLToPath(new URL('../dist/runtime/file-staging.js', import.meta.url));
  const kernel = createRequire(import.meta.url).resolve('@canlang/interfaces/uploads/kernel');
  await writeFile(entry, `
import {createDurableSqliteFileStore,createSqliteFileBindings} from ${JSON.stringify(adapter)};
import {readFinalizedFileObservation} from ${JSON.stringify(finalize)};
import {sha256Hex} from ${JSON.stringify(upload)};
import {createCanonicalFileBinding} from ${JSON.stringify(bound)};
import {readRetainedCanonicalFile} from ${JSON.stringify(staging)};
import {createFileJourneyKernel} from ${JSON.stringify(kernel)};
const receiver={app:'DurableFilesProof',team:'team_1',owner:'team_1',principal:'user_1'};
const retention={unattachedHorizonMs:86400000,retentionMs:86400000};
const json=value=>Response.json(value);
export class FilesProof {
 constructor(ctx){
  this.ctx=ctx;this.now=Date.now();
  this.store=createDurableSqliteFileStore(ctx.storage);
  this.files=createSqliteFileBindings(this.store,{clock:{nowMs:()=>this.now},intentTtlMs:900000,urlBase:'https://files.test'});
 }
 async fetch(request){
  if(new URL(request.url).pathname==='/maximum'){
   const large=new Uint8Array(10*1024*1024).fill(65);
   if(this.files.maxBytes!==large.length)throw new Error('Files default policy changed');
   if(request.method==='POST'){
    const input={upload_id:'maximum-upload',operation:'DurableFilesProof.Document.create',field:'/file',arguments:{},name:'maximum.txt',type:'text/plain',size:String(large.length)};
    const created=this.files.createIntent({request:input,receiver,binding:{adapter:'deployment.web',deliveryId:'maximum-request',resultPath:'file'}});
    if(created.status!=='granted')throw new Error('maximum intent failed');
    for(const [start,end] of [[0,65535],[65535,131073],[131073,large.length]]){
     const appended=this.files.append(created.intentId,receiver,large.subarray(start,end),start);
     if(appended.status!=='appended'||appended.receivedBytes!==end)throw new Error('maximum append failed');
    }
    const repeated=this.files.append(created.intentId,receiver,large.subarray(0,65535),0);
    if(repeated.status!=='appended'||repeated.receivedBytes!==65535)throw new Error('maximum replay duplicated bytes');
    if(this.files.complete(created.intentId,receiver).status!=='completed')throw new Error('maximum completion failed');
    const finalized=this.files.finalize({intentId:created.intentId,retryId:input.upload_id,caller:receiver,bytesDigest:sha256Hex(large)});
    if(finalized.status!=='finalized')throw new Error('maximum finalize failed');
   }
   const record=this.store.files.listAll().find(record=>record.file.sizeBytes===large.length);
   const bytes=this.files.readBytes(record.file.id,receiver);
   return json({ref:record.file.id,store:this.store.fileStoreId,size:bytes.length,digest:sha256Hex(bytes)});
  }
  const bytes=new TextEncoder().encode('durable file bytes');
  if(request.method==='POST'){
   const input={upload_id:'one-upload',operation:'DurableFilesProof.Document.create',field:'/file',arguments:{},name:'proof.txt',type:'text/plain',size:String(bytes.length)};
   const created=this.files.createIntent({request:input,receiver,binding:{adapter:'deployment.web',deliveryId:'one-request',resultPath:'file'}});
   if(created.status!=='granted')throw new Error('intent failed '+JSON.stringify(created));
   const appended=this.files.append(created.intentId,receiver,bytes,0);
   if(appended.status!=='appended')throw new Error('append failed');
   const completed=this.files.complete(created.intentId,receiver);
   if(completed.status!=='completed')throw new Error('complete failed');
   const finalized=this.files.finalize({intentId:created.intentId,retryId:input.upload_id,caller:receiver,bytesDigest:sha256Hex(bytes)});
   if(finalized.status!=='finalized')throw new Error('finalize failed '+JSON.stringify(finalized));
   const record=this.store.files.get(finalized.file.id);
   try {this.store.transaction(()=>{
    this.store.blobs.write('rollback.bin',bytes);
    this.store.files.put({...record,attachedRecord:'rolled-back-record'});
    throw new Error('injected interruption');
   });} catch(error){if(error.message!=='injected interruption')throw error;}
   if(this.store.blobs.read('rollback.bin')!==null||this.store.files.get(finalized.file.id).attachedRecord!==null)throw new Error('rollback lost atomicity');
  }
  const record=this.store.files.listAll()[0];
  if(!record)throw new Error('persistent metadata missing');
  const value=this.files.readBytes(record.file.id,receiver);
  if(value===null)throw new Error('persistent bytes missing');
  const observation=this.files.observeFile(record.file.id,receiver,retention);
  const facts=readFinalizedFileObservation(observation);
  const copied=readFinalizedFileObservation(JSON.parse(JSON.stringify(observation)));
  const foreign=this.files.readBytes(record.file.id,{...receiver,principal:'other-user'});
  if(facts===null||copied!==null||foreign!==null)throw new Error('Files authority weakened');
  if(await this.ctx.storage.get('retained-source-revision')===undefined)await this.ctx.storage.put('retained-source-revision',1);
  const verify=async()=>{if(await this.ctx.storage.get('retained-source-revision')!==1)throw new Error('source-revoked');};
  const physical=createFileJourneyKernel(this.files);let revokeDuringRead=false;
  const originalRead=physical.readCurrentSnapshot.bind(physical);
  physical.readCurrentSnapshot=async(...args)=>{const result=await originalRead(...args);if(revokeDuringRead)await this.ctx.storage.put('retained-source-revision',2);return result;};
  const receiving=createCanonicalFileBinding(physical,retention);
  const read=()=>readRetainedCanonicalFile(receiving,facts,bytes.length,verify);
  const accepted=await read();
  if(new TextDecoder().decode(accepted)!=='durable file bytes')throw new Error('Retained bytes were not the genuine finalized snapshot');
  accepted[0]=0;
  if(new TextDecoder().decode(await read())!=='durable file bytes')throw new Error('Retained consumer changed the physical bytes');
  if(await readRetainedCanonicalFile({...receiving},facts,bytes.length,verify)!==null)throw new Error('Copied binding acquired receiving authority');
  if(await readRetainedCanonicalFile(receiving,facts,bytes.length-1,verify)!==null)throw new Error('Retained read ignored byte bound');
  if(await readRetainedCanonicalFile(receiving,{...facts,receiver:{...facts.receiver,principal:'other-user'}},bytes.length,verify)!==null)throw new Error('Foreign saved receiver acquired bytes');
  if(await readRetainedCanonicalFile(receiving,{...facts,bytesDigest:'sha256:'+'0'.repeat(64)},bytes.length,verify)!==null)throw new Error('Changed saved facts acquired bytes');
  const expectRevoked=async()=>{try{await read();}catch(error){if(error.message==='source-revoked')return;}throw new Error('Revoked source acquired bytes');};
  await this.ctx.storage.put('retained-source-revision',2);await expectRevoked();
  await this.ctx.storage.put('retained-source-revision',1);revokeDuringRead=true;await expectRevoked();
  revokeDuringRead=false;await this.ctx.storage.put('retained-source-revision',1);
  this.now+=retention.unattachedHorizonMs+1;
  if(await read()!==null)throw new Error('Expired retained snapshot acquired bytes');
  this.now-=retention.unattachedHorizonMs+1;
  physical.readCurrentSnapshot=async()=>null;
  try{await read();throw new Error('Changed reader acquired bytes');}catch(error){if(error.message!=='Retained File receiving kernel changed.')throw error;}

  return json({id:record.file.id,store:this.store.fileStoreId,contentType:record.file.contentType,bytes:new TextDecoder().decode(value),genuine:true,copyRejected:true,foreignRejected:true,retainedRead:true});
 }
}
export default {fetch(request,env){return env.FILES.get(env.FILES.idFromName('one-app')).fetch(request);}};
`);
  execFileSync('bun', ['build', '--target=browser', '--format=esm', entry, '--outfile', output], { stdio: 'pipe' });
  const script = await readFile(output, 'utf8');
  const start = () => new Miniflare({ name: 'can-durable-files-proof', compatibilityDate: '2026-07-15', modules: true, script,
    durableObjects: { FILES: { className: 'FilesProof', useSQLite: true } }, durableObjectsPersist: join(directory, 'persist') });
  let runtime = start();
  try {
    const written = await runtime.dispatchFetch('https://files.test/', { method: 'POST' });
    assert.equal(written.status, 200, await written.clone().text());
    const initial = await written.json();
    await runtime.dispose();
    runtime = start();
    const reopened = await runtime.dispatchFetch('https://files.test/');
    assert.equal(reopened.status, 200, await reopened.clone().text());
    assert.deepEqual(await reopened.json(), initial);
    const maximum = await runtime.dispatchFetch('https://files.test/maximum', { method: 'POST' });
    assert.equal(maximum.status, 200, await maximum.clone().text());
    const maximumResult = await maximum.json() as { size: number; digest: string };
    assert.equal(maximumResult.size, 10 * 1024 * 1024);
    assert.equal(maximumResult.digest, `sha256:${createHash('sha256').update(Buffer.alloc(10 * 1024 * 1024, 65)).digest('hex')}`);
    await runtime.dispose();
    runtime = start();
    const maximumReopened = await runtime.dispatchFetch('https://files.test/maximum');
    assert.equal(maximumReopened.status, 200, await maximumReopened.clone().text());
    assert.deepEqual(await maximumReopened.json(), maximumResult);
    assert.deepEqual(initial, { ...initial as object, contentType: 'text/plain', bytes: 'durable file bytes', genuine: true, copyRejected: true, foreignRejected: true, retainedRead: true });
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 60000);
