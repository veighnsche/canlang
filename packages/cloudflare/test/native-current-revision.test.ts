/** Original current337 native consumer using the reviewed source and runtime join.
 * Worker qualification is recorded separately from each actual main capture.
 * Preserves original policies, WorkflowDefinition CRUD and physical File authority.
 */
import { createCheckoutScratch } from '../src/dev/checkout-scratch.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { ApiGraph, CompileArtifact, ModelName, MutationEnvelope, OperationName, OperationId,
  ProjectedRecord, ReceiptIdentity, ResolvedIdentity, RoleGrant, StoredRow } from '@canlang/contracts';
import type { UploadDeps } from '@canlang/interfaces';
import type { SqliteFileStore } from '@canlang/files/host/sqlite';
import type { SingleFileCapture } from '../src/dev/source-capture.js';
import type { MutationOutcome } from '../src/worker/assembly.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const APP = 'SourceCurrentRevision', OP = `${APP}.generate`;
const TEMPLATE = `${APP}.Template` as ModelName, REVISION = `${APP}.Revision` as ModelName, RUN = `${APP}.Run` as ModelName;
// Compiler's unchanged source proof names its original feasible success Return
// 79d0c5b24994f46af0206a4d6076165d075c65e6e63272c97ce6f2f47d5d08dd.
// CLI path and the labelled setup intentionally receive fresh authentic IDs.
const ORIGINAL_SHA256 = '4da5ddcc956e72ee6f8e0d5942467692c549d925dee2a01a4e01192f93e31bbf';
const SETUP = ' ## BEGIN TEST-AUTHORED SETUP: authenticated original owning CRUD\n' +
  ' crud Template by=creative_manager fields=name,graph,prompt_node,prompt_key,negative_node,negative_key,width_node,width_key,height_node,height_key,outputs,duration,active,current\n' +
  ' crud Revision by=creative_manager fields=number,definition,outputs,duration,published,digest\n' +
  ' ## END TEST-AUTHORED SETUP\n';
const require = createRequire(import.meta.url);
const nodeImport = compileFunction('return import(url)', ['url'], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const producer = (name: string) => pathToFileURL(require.resolve(name)).href;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const GRAPH: ApiGraph = {
  '3': {class_type: 'KSampler', inputs: {seed: 42, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
    positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0], model: ['4', 0]}},
  '4': {class_type: 'CheckpointLoaderSimple', inputs: {ckpt_name: 'owned-local.safetensors'}},
  '5': {class_type: 'EmptyLatentImage', inputs: {width: 512, height: 512, batch_size: 1}},
  '6': {class_type: 'CLIPTextEncode', inputs: {text: '', clip: ['4', 1]}},
  '7': {class_type: 'CLIPTextEncode', inputs: {text: '', clip: ['4', 1]}},
  '8': {class_type: 'VAEDecode', inputs: {samples: ['3', 0], vae: ['4', 2]}},
  '9': {class_type: 'SaveImage', inputs: {filename_prefix: 'Owned', images: ['8', 0]}},
};
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
function committed(value: MutationOutcome, status: 'committed' | 'replayed' = 'committed') {
  assert.ok('result' in value, JSON.stringify(value)); assert.equal(value.result.status, status); return value.result;
}
async function snapshot(db: D1Database) {
  const names = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{name: string}>();
  assert.equal(names.success, true); const result: Record<string, Record<string, unknown>[]> = {};
  for (const {name} of names.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true); result[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
function historySequence(before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>) {
  const previous = before.sqlite_sequence!, history = previous.filter(row => row.name === 'history'); assert.equal(history.length, 1);
  assert.equal(typeof history[0]!.seq, 'number');
  assert.deepEqual(after.sqlite_sequence, [...previous.filter(row => row.name !== 'history'), {name: 'history', seq: Number(history[0]!.seq) + 1}]
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

test('original current337 nullable/current/published/digest returns the same Run with complete source and current authority',
 {timeout: 3600000}, async () => {
  const started = Date.now(), phase = (name: string) => process.stdout.write(`[native-current-revision ${Date.now() - started}ms] ${name}\n`);
  const directory = await createCheckoutScratch(root, 'native-current-revision-');
  let worker: Miniflare | undefined, capture: SingleFileCapture | undefined;
  let physical: SqliteFileStore | undefined, foreignPhysical: SqliteFileStore | undefined;
  try {
    // Private Files, Identity, Values and State authority share the actual
    // installed default Node loader, including the generated module imports.
    const {assembleModules, importVerifiedAssemblyModule} = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
    const {buildInvoker, createTeamOwnerStorageBoundary} = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
    const {loadCanonicalDescriptors} = await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
    const {createBoundFileHandler, createCanonicalFileBinding} = await nodeImport(installed('runtime/bound-files.js')) as typeof import('../src/runtime/bound-files.js');
    const {prepareLocalPreviewCapture} = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
    const {captureSingleFileSource, captureIsCurrent, verifyCompilerSources} = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
    const {parseArtifactText} = await nodeImport(installed('runtime/artifact.js')) as typeof import('../src/runtime/artifact.js');
    const {distribution} = await nodeImport(producer('@canlang/values/distribution')) as typeof import('@canlang/values/distribution');
    const {decodeValue} = await nodeImport(producer('@canlang/values')) as typeof import('@canlang/values');
    const {createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity} = await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
    const {ensureSchema} = await nodeImport(producer('@canlang/state/storage/d1')) as typeof import('@canlang/state/storage/d1');
    const {createD1OwnerRouter} = await nodeImport(producer('@canlang/state/storage/owner-router')) as typeof import('@canlang/state/storage/owner-router');
    const {createSqliteFileStore, createSqliteFileBindings} = await nodeImport(producer('@canlang/files/host/sqlite')) as typeof import('@canlang/files/host/sqlite');
    const {createFileJourneyKernel} = await nodeImport(producer('@canlang/interfaces/uploads/kernel')) as typeof import('@canlang/interfaces/uploads/kernel');
    const {blobKeyForFile} = await nodeImport(producer('@canlang/files/finalize')) as typeof import('@canlang/files/finalize');
    const {sha256Hex, stagingKeyForIntent} = await nodeImport(producer('@canlang/files/upload')) as typeof import('@canlang/files/upload');
    const {digestGraph} = await nodeImport(producer('@canlang/services/media/mapping')) as typeof import('@canlang/services/media/mapping');
    const {readScenarioReceiptAssociation} = await nodeImport(producer('@canlang/state/invocation')) as typeof import('@canlang/state/invocation');
    const {hashInputs} = await nodeImport(producer('@canlang/state/invocation/replay')) as typeof import('@canlang/state/invocation/replay');
    const {uuidv7} = await nodeImport(producer('@canlang/state/testing/invocation/fixtures')) as typeof import('@canlang/state/testing/invocation/fixtures');
    const originalSource = join(root, 'compiler/tests/fixtures/source-current-revision.can');
    const source = join(directory, 'original-current-revision-with-labelled-setup.can');
    const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
    const paths = [originalSource, compiler, catalog], originals = await Promise.all(paths.map(path => readFile(path)));
    assert.equal(originals[0]!.length, 2240); assert.equal(hash(originals[0]!), ORIGINAL_SHA256);
    const originalText = originals[0]!.toString('utf8'); assert.equal(originalText.split('When\n').length, 2);
    const authored = originalText.replace('When\n', `When\n${SETUP}`);
    assert.equal(authored.split(SETUP).length, 2); assert.equal(authored.replace(SETUP, ''), originalText);
    await writeFile(source, authored); const authoredHash = hash(Buffer.from(authored));
    capture = await captureSingleFileSource(prepareLocalPreviewCapture({checkoutRoot: root, appPath: source,
      compilerPath: compiler, catalogPath: catalog, helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md')}));
    assert.equal(capture.sourceSha256, authoredHash); assert.equal(await captureIsCurrent(capture), true);
    for (const [name, path, bytes] of [['compiler', compiler, originals[1]!], ['catalog', catalog, originals[2]!]] as const) {
      const input: SingleFileCapture['inputs'][number] | undefined = capture.inputs.find(value => value.name === name); assert.ok(input); assert.equal(input.state, 'present');
      assert.equal(input.requestedPath, path); assert.equal(input.sha256, hash(bytes));
    }
    // Compiler owns this release gate: run the captured CLI exactly once. No
    // altered source, handauthored artifact, or refusal-as-success fallback.
    const env = {...process.env}; delete env.CAN_CATALOG;
    const {stdout} = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, capture.compilerOperand],
      {cwd: capture.root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024});
    const artifact = parseArtifactText(stdout, source).artifact, originalArtifact = JSON.stringify(artifact);
    assert.equal(verifyCompilerSources(capture, {complete: true, sources: artifact.sources}).ok, true);
    assert.equal(await captureIsCurrent(capture), true);
    const compilerSources = await Promise.all(artifact.sources.map(async value => {
      const path = resolve(capture!.root, value.path), bytes = await readFile(path); assert.equal(hash(bytes), value.sha256); return {path, bytes};
    }));
    const op = artifact.operations?.find(value => value.name === OP); assert.ok(op?.result?.disclosure); assert.equal(op.result.type, RUN);
    assert.equal(artifact.pages.length, 0);
    for (const model of [TEMPLATE, REVISION]) assert.equal(artifact.operations?.find(value => value.name === `${model}.create`)?.kind, 'create');
    assert.equal(op.inputs.fields.length, 1); const parameter = op.inputs.fields[0]!;
    assert.equal(parameter.name, 'template'); assert.equal(parameter.required, true); assert.equal(parameter.default, undefined);
    assert.deepEqual(parameter.field, {kind: 'ref', model: TEMPLATE, requireVersion: true});
    assert.equal(artifact.models!.find(value => value.name === REVISION)!.parent, TEMPLATE);
    const templateModel = artifact.models!.find(value => value.name === TEMPLATE)!;
    const currentField = templateModel.fields.find(value => value.name === 'current'); assert.ok(currentField);
    assert.equal(currentField.nullable, true); assert.equal(currentField.field.kind, 'ref');
    const definitionInput = artifact.operations!.find(value => value.name === `${REVISION}.create`)!.inputs.fields.find(value => value.name === 'definition');
    assert.ok(definitionInput); assert.equal(definitionInput.field.kind, 'nominal'); assert.equal(definitionInput.required, true);
    assert.ok(artifact.valueTypes, 'Compiler must retain the owning WorkflowDefinition schema for genuine CRUD File admission');
    const plan = op.result.disclosure; assert.equal(plan.queries?.length ?? 0, 0);
    assert.equal(plan.source.sha256, authoredHash); assert.equal(resolve(capture.root, plan.source.path), source);
    assert.equal(plan.returns.length, 1, 'native receives the one feasible original successful-Require Return; all four conservative analysis inventories stay Compiler-owned');
    assert.match(plan.returns[0]!.id, /^[0-9a-f]{64}$/);
    for (const returned of plan.returns) {
      assert.deepEqual(returned.influences, []);
      assert.equal(new Set(returned.dependencies.map(value => value.id)).size, returned.dependencies.length);
      for (const dependency of returned.dependencies) { assert.deepEqual(dependency.source, plan.source); assert.equal(dependency.queryId, undefined); }
    }
    // Only the feasible successful Require path reaches Return. Its control
    // and once-Let DATA recipe must retain every original role in source order.
    const complete = plan.returns.filter(value => value.dependencies.some(dependency => dependency.model === REVISION && dependency.field === 'published') &&
      value.dependencies.some(dependency => dependency.model === TEMPLATE && dependency.field === 'current' && dependency.type === `${REVISION}?`));
    assert.equal(complete.length, 1); const returned = complete[0]!;
    const census = [
      [TEMPLATE, 'active', 'bool', 'control'], [TEMPLATE, 'current', `${REVISION}?`, 'control'],
      [TEMPLATE, 'current', REVISION, 'control'], [REVISION, 'published', 'bool', 'control'],
      [TEMPLATE, 'current', REVISION, 'control'], [TEMPLATE, 'current', REVISION, 'data'],
      [REVISION, 'digest', 'text?', 'control'],
      [REVISION, 'digest', 'text', 'data'], [REVISION, 'outputs', 'int', 'data'], [REVISION, 'duration', 'duration', 'data'],
    ];
    assert.deepEqual(returned.dependencies.map(value => [value.model, value.field, value.type, value.role]), census);
    const asm = await assembleModules({artifact, sourcePath: source}, {workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js'), uiUrl: producer('@canlang/ui')});
    const loaded = await loadCanonicalDescriptors(asm, artifact);
    assert.deepEqual(object(object(loaded.registry.get(OP)).descriptor).result, op.result);
    const callable = artifact.callables.find(value => value.id === OP); assert.ok(callable);
    const namespace = object(await importVerifiedAssemblyModule(asm, callable.module, artifact)); assert.equal(namespace[callable.export], OP);
    const appDefinition = object(namespace.appDefinition);
    assert.equal(object(object(appDefinition.operations)[OP]).by, 'members');
    const policies = artifact.modelPolicies; assert.ok(policies, 'original cross-model Template invariant and nominal/delivery Revision lock must activate');
    for (const [model, ids] of [[TEMPLATE, ['require.1', 'lock.1']], [REVISION, ['require.1', 'lock.1', 'lock.2']]] as const) {
      const policy: NonNullable<CompileArtifact['modelPolicies']>[number] | undefined = policies.find(value => value.model === model); assert.ok(policy);
      assert.equal(policy.abi, 'state.owner-model-policies@1'); assert.equal(policy.ownerPackage, APP); assert.equal(policy.module, callable.module);
      assert.deepEqual(policy.rules.map(value => value.id), ids.map(id => `${model}.${id}`)); assert.deepEqual(policy.hooks, []);
    }
    const templatePolicy = policies.find(value => value.model === TEMPLATE)!;
    const templateInvariant = templatePolicy.rules.find(value => value.kind === 'invariant'); assert.ok(templateInvariant);
    // A foreign-row traversal cannot be falsely certified as local/empty.
    assert.ok(templateInvariant.dependencies.some(value => value.model === REVISION && Number.isSafeInteger(value.maxTargets) && value.maxTargets >= 1), 'owning bounded current Revision dependency and reverse selector are required');
    assert.deepEqual(templatePolicy.rules.filter(value => value.kind === 'lock').map(value => value.fields), [['owner']]);
    const revisionLocks = policies.find(value => value.model === REVISION)!.rules.filter(value => value.kind === 'lock');
    assert.deepEqual(revisionLocks.map(value => value.fields), [['number', 'definition', 'outputs', 'duration', 'validation'], ['published', 'digest']]);
    assert.deepEqual(object(object(appDefinition.models)[REVISION]).uniques, [{fields: ['number']}]);
    let handler: unknown = (namespace.canApp as () => unknown)(); for (const member of callable.member) handler = object(handler)[member];
    assert.equal(typeof handler, 'function'); const body = (handler as Function).toString();
    assert.equal((body.match(/\bawait create\(/g) ?? []).length, 1); assert.equal((body.match(/\bexecuteScenarioReceiptQuery\(/g) ?? []).length, 0);
    const created = /const ([$\w]+) = await create\(c,"SourceCurrentRevision\.Run",/.exec(body); assert.ok(created);
    assert.ok(body.includes(`const $receiptValue=${created[1]};`), 'same original Run enters result binding');
    const compiledBytes = new Map(await Promise.all(Object.entries(asm.moduleUrls).map(async ([path, url]) => [path, await readFile(fileURLToPath(url))] as const)));
    phase('original-source-and-assembly:ready');
    worker = new Miniflare({compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: {IDENTITY: 'current-revision-identity', A: 'current-revision-owner-a', B: 'current-revision-owner-b'}, d1Persist: join(directory, 'd1')});
    const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
    const a = await worker.getD1Database('A') as unknown as D1Database, b = await worker.getD1Database('B') as unknown as D1Database;
    await ensureIdentitySchema(identityDb); await ensureSchema(a); await ensureSchema(b);
    let now = Date.now(), sequence = 0; const clock = {nowMs: () => now};
    const identities = createD1IdentityStore(identityDb, {clock});
    const teams = await Promise.all([identities.createTeam({timezone: 'UTC'}), identities.createTeam({timezone: 'UTC'})]);
    const users = await Promise.all(['manager', 'member', 'foreign-manager', 'colleague'].map(name => identities.createUser({email: `${name}@current-revision.example.test`, password_hash: 'unused', email_verified: true})));
    const managerRoles = (index: number): RoleGrant[] => [{role: `${APP}.creative_manager`, granted_at: new Date(now).toISOString(), granted_by: users[index]!.user_id}];
    const ownerIndex = (index: number) => index === 2 ? 1 : 0;
    const memberships = await Promise.all(users.map((user, index) => identities.createMembership({user_id: user.user_id, team_id: teams[ownerIndex(index)]!.team_id,
      is_owner: false, roles: index === 0 || index === 2 ? managerRoles(index) : []})));
    const grants = await Promise.all(users.map((user, index) => issueMcpGrant(identities, {user_id: user.user_id, team_id: teams[ownerIndex(index)]!.team_id, client_id: 'current-revision'}, {clock})));
    const current = (index = 1) => resolveIdentity(identities, {mcp_grant_token: grants[index]!.token}, {clock});
    const manager = await current(0), member = await current(1), foreignIdentity = await current(2);
    physical = createSqliteFileStore(join(directory, 'files.sqlite')); foreignPhysical = createSqliteFileStore(join(directory, 'foreign-files.sqlite'));
    const ownerStorage = await createTeamOwnerStorageBoundary({artifact, asm, app: APP, identities,
      router: createD1OwnerRouter({resolveBinding: selected => selected.app === APP && teams.some(team => team.team_id === selected.owner)
        ? {...selected, db: selected.owner === teams[0]!.team_id ? a : b, initializeFresh: true} : null})});
    const store = await ownerStorage.forIdentity(member), foreign = await ownerStorage.forIdentity(foreignIdentity);
    const retention = {unattachedHorizonMs: 120000, retentionMs: 600000};
    const kernel = createFileJourneyKernel(createSqliteFileBindings(physical, {clock, intentTtlMs: 60000, urlBase: 'https://current-revision.invalid'}));
    const foreignKernel = createFileJourneyKernel(createSqliteFileBindings(foreignPhysical, {clock, intentTtlMs: 60000, urlBase: 'https://foreign-current-revision.invalid'}));
    const files = createCanonicalFileBinding(kernel, retention), foreignFiles = createCanonicalFileBinding(foreignKernel, retention);
    const invoker = buildInvoker(artifact, asm, store, {appId: APP, memberships: identities, source: 'http', now: clock.nowMs, ownerStorage, files});
    const foreignInvoker = buildInvoker(artifact, asm, foreign, {appId: APP, memberships: identities, source: 'http', now: clock.nowMs, ownerStorage, files: foreignFiles});
    const upload: UploadDeps & {kernel: typeof kernel} = {app: {appId: APP, brand: APP, appDefaultLocale: 'en', ownerLabels: new Map()},
      files: {usesFiles: () => true}, kernel, clock, logger: {log: () => {}}, identity: {store: identities, clock, mail: {sendMail: async () => {}},
        verifyBaseUrl: '', recoveryBaseUrl: '', inviteBaseUrl: '', sessionMaxAgeSeconds: 3600}};
    const fileHandler = createBoundFileHandler({artifact, asm, store, memberships: identities, identityStore: identities, clock, upload,
      ownerStorage, physicalFiles: physical.files, retention, fileReferenceBounds: {maxRows: 100, maxReferences: 100}});
    const foreignUpload = {...upload, kernel: foreignKernel};
    const foreignFileHandler = createBoundFileHandler({artifact, asm, store: foreign, memberships: identities, identityStore: identities, clock, upload: foreignUpload,
      ownerStorage, physicalFiles: foreignPhysical.files, retention, fileReferenceBounds: {maxRows: 100, maxReferences: 100}});
    const graphBytes = new TextEncoder().encode(JSON.stringify(GRAPH));
    const uploadGraph = async (index: 0 | 2, nested = false) => {
      const handler = index === 0 ? fileHandler : foreignFileHandler, receiving = index === 0 ? physical! : foreignPhysical!;
      const uploadId = `original-current-revision-graph-${index}${nested ? '-definition' : ''}`;
      const request = (path: string, method: string, body: string | Uint8Array) => new Request(path.startsWith('https:') ? path : `https://current-revision.invalid${path}`,
        {method, headers: {authorization: `Bearer ${grants[index]!.token}`, 'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json',
          ...(method === 'PUT' ? {'upload-offset': '0'} : {})}, body});
      const intentResponse = await handler(request('/files/intents', 'POST', JSON.stringify({upload_id: uploadId,
        operation: nested ? `${REVISION}.create` : `${TEMPLATE}.create`, field: nested ? '/definition/graph' : '/graph',
        arguments: {}, name: 'original-workflow.json', type: 'application/json', size: String(graphBytes.length)})));
      assert.equal(intentResponse.status, 200, await intentResponse.clone().text()); const intent = await intentResponse.json() as {content: string; finalize: string};
      const append = await handler(request(intent.content, 'PUT', graphBytes)); assert.equal(append.status, 200, await append.clone().text());
      const finalized = await handler(request(intent.finalize, 'POST', JSON.stringify({upload_id: uploadId, bytes_digest: sha256Hex(graphBytes)})));
      assert.equal(finalized.status, 200, await finalized.clone().text()); const file = (await finalized.json() as {file: string}).file;
      assert.ok(receiving.files.get(file)); assert.deepEqual(receiving.blobs.read(blobKeyForFile(file)), graphBytes); return file;
    };
    const graph = await uploadGraph(0), nestedGraph = await uploadGraph(0, true), foreignGraph = await uploadGraph(2);
    assert.notEqual(graph, foreignGraph); assert.equal(physical.files.get(foreignGraph), null); assert.equal(foreignPhysical.files.get(graph), null);
    // This is the real standard WorkflowDefinition shape, with a Files-issued
    // graph and WorkflowInput values. No Images/provider call is necessary.
    const definition = {graph: {id: nestedGraph}, prompt: {node: '6', key: 'text'}, negative: {node: '7', key: 'text'}, width: {node: '5', key: 'width'}, height: {node: '5', key: 'height'}};
    const digest = digestGraph(GRAPH);
    const fileState = (selected: SqliteFileStore) => ({files: selected.files.listAll(), intents: selected.intents.listAll(),
      bytes: selected.files.listAll().map(({file}) => [file.id, selected.blobs.read(blobKeyForFile(file.id))]),
      staging: selected.intents.listAll().map(value => [value.intentId, selected.blobs.read(stagingKeyForIntent(value.intentId))])});
    const all = async () => ({identity: await snapshot(identityDb), owner: await snapshot(a), foreign: await snapshot(b), physical: fileState(physical!), foreignPhysical: fileState(foreignPhysical!)});
    const envelope = (operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({operation, operation_id: uuidv7(now, ++sequence), inputs});
    const ref = (row: StoredRow) => ({id: row.id, version: String(row.version)});
    const receiptIdentity = (input: MutationEnvelope, actor: ResolvedIdentity = member): ReceiptIdentity => ({app: APP,
      owner: actor.team!.team_id, principal: actor.actor!.user_id, operation: input.operation as OperationName, operationId: input.operation_id as OperationId});
    const selected = (actor: ResolvedIdentity) => actor.team!.team_id === teams[0]!.team_id ? {store, invoker} : {store: foreign, invoker: foreignInvoker};
    const create = async (model: ModelName, inputs: MutationEnvelope['inputs'], actor = manager): Promise<StoredRow> => {
      const target = selected(actor), input = envelope(`${model}.create`, inputs), revision = await target.store.readRevision();
      const result = committed(await target.invoker.invokeMutation(input, actor)); assert.equal(await target.store.readRevision(), revision + 1);
      const records = result.records as readonly ProjectedRecord[]; assert.equal(records.length, 1); const row = await target.store.load(model, records[0]!.id); assert.ok(row);
      assert.equal(row.version, 1); assert.equal(row.createdBy, actor.actor!.user_id);
      const receipt = await target.store.readReceipt(receiptIdentity(input, actor)); assert.ok(receipt); assert.equal(receipt.outcome.status, 'committed');
      assert.equal(receipt.inputHash, await hashInputs(input.inputs)); assert.equal(receipt.committedRevision, revision + 1);
      const history = await target.store.historyFor(model, row.id); assert.equal(history.length, 1); assert.equal(history[0]!.operationId, input.operation_id);
      assert.equal(history[0]!.before, null); assert.deepEqual(history[0]!.after, row.data); return row;
    };
    const update = async (model: ModelName, row: StoredRow, patch: MutationEnvelope['inputs']) => {
      const latest = await store.load(model, row.id); assert.ok(latest);
      committed(await invoker.invokeMutation(envelope(`${model}.update`, {record: ref(latest), ...patch}), await current(0)));
      const after = await store.load(model, row.id); assert.ok(after); return after;
    };
    const reject = async (input: MutationEnvelope, code: string, actor = member, durable = true) => {
      const target = selected(actor), before = await all(), revision = await target.store.readRevision();
      const outcome = await target.invoker.invokeMutation(input, actor); assert.ok('error' in outcome, JSON.stringify(outcome)); assert.equal(outcome.error.code, code);
      const receipt = await target.store.readReceipt(receiptIdentity(input, actor));
      if (!durable) {
        assert.equal(receipt, null); assert.deepEqual(await all(), before);
        const retried = await target.invoker.invokeMutation(input, actor); assert.ok('error' in retried); assert.equal(retried.error.code, code);
        assert.deepEqual(await all(), before); assert.equal(await target.store.readReceipt(receiptIdentity(input, actor)), null); return;
      }
      assert.ok(receipt); assert.deepEqual(receipt.outcome, {status: 'rejected', code, message: outcome.error.message});
      assert.equal(receipt.inputHash, await hashInputs(input.inputs)); assert.equal(receipt.committedRevision, revision + 1);
      const after = await all(); assert.equal(await target.store.readRevision(), revision + 1);
      for (const table of Object.keys(before.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) assert.deepEqual(after.owner[table], before.owner[table], table);
      assert.equal(after.owner.receipts!.length, before.owner.receipts!.length + 1); assert.deepEqual(after.owner.receipts!.filter(value => value.operation_id !== input.operation_id), before.owner.receipts);
      assert.deepEqual(after.owner.fence, [{id: 1, revision: revision + 1}]); assert.deepEqual(after.owner.fence_log!.filter(value => value.revision !== revision + 1), before.owner.fence_log);
      assert.deepEqual(after.owner.fence_log!.filter(value => value.revision === revision + 1), [{at: now, operation: input.operation, revision: revision + 1}]);
      for (const resource of ['identity', 'foreign', 'physical', 'foreignPhysical'] as const) assert.deepEqual(after[resource], before[resource]);
      const replay = await target.invoker.invokeMutation(input, actor); assert.ok('error' in replay); assert.equal(replay.error.code, code); assert.deepEqual(await all(), after);
    };
    const read = async (operation: string, actor: ResolvedIdentity) => {
      const outcome = await selected(actor).invoker.invokeRead({operation, inputs: {}}, actor); assert.ok('result' in outcome); const records = object(outcome.result).records; assert.ok(Array.isArray(records)); return records.map(object);
    };
    const template = await create(TEMPLATE, {name: '  Original workflow  ', graph: {id: graph}});
    assert.equal(template.data.name, 'Original workflow'); assert.deepEqual(template.data.owner, {id: users[0]!.user_id}); assert.equal(template.data.current, null);
    assert.equal(template.data.active, true); assert.equal(template.data.duration, '120000'); assert.deepEqual(template.data.graph, {id: graph});
    assert.equal(physical.files.get(graph)?.attachedRecord, `${TEMPLATE}/${template.id}/graph`, 'direct graph retention follows the committed Template');
    await reject(envelope(OP, {template: ref(template)}), 'rule_failed');
    // The complete owning nominal field must validate its nested File against
    // actual physical receiving storage, just as the original direct graph does.
    for (const unavailableGraph of [foreignGraph, 'not-finalized-workflow-graph']) {
      await reject(envelope(`${REVISION}.create`, {parent: ref(template), number: '1',
        definition: {...definition, graph: {id: unavailableGraph}}, outputs: '1', duration: '120000'}), 'validation', await current(0));
    }
    const unpublished = await create(REVISION, {parent: ref(template), number: '1', definition, outputs: '1', duration: '120000'});
    assert.deepEqual(unpublished.parent, {model: TEMPLATE, id: template.id}); assert.deepEqual(unpublished.data.definition, definition);
    assert.equal(physical.files.get(graph)?.attachedRecord, `${TEMPLATE}/${template.id}/graph`, 'direct graph retention survives the nested commit');
    assert.equal(physical.files.get(nestedGraph)?.attachedRecord, `${REVISION}/${unpublished.id}/definition`, 'nested WorkflowDefinition graph retention follows the committed Revision');
    assert.equal(unpublished.data.published, false); assert.equal(unpublished.data.digest, null);
    assert.equal((await read(`${REVISION}.read`, await current(1))).some(row => row.id === unpublished.id), false);
    const managerRevision = (await read(`${REVISION}.read`, await current(0))).find(row => row.id === unpublished.id); assert.ok(managerRevision);
    assert.deepEqual(object(managerRevision.data).definition, definition);
    await reject(envelope(`${TEMPLATE}.update`, {record: ref(template), current: ref(unpublished)}), 'rule_failed', await current(0));
    await reject(envelope(`${REVISION}.update`, {record: ref(unpublished), published: true}), 'rule_failed', await current(0));
    // Unique number, duration bounds and immutable definition/number remain
    // owning CRUD constraints; impossible rows never become scenario inputs.
    await reject(envelope(`${REVISION}.create`, {parent: ref(template), number: '1', definition, outputs: '1', duration: '120000'}), 'conflict', await current(0), false);
    await reject(envelope(`${REVISION}.create`, {parent: ref(template), number: '2', definition, outputs: '1', duration: '999'}), 'rule_failed', await current(0));
    await reject(envelope(`${REVISION}.update`, {record: ref(unpublished), number: '2'}), 'rule_failed', await current(0));
    const published = await update(REVISION, unpublished, {published: true, digest}); assert.equal(published.data.published, true); assert.equal(published.data.digest, digest);
    for (const patch of [{published: false}, {digest: null}, {digest: 'changed'}, {outputs: '2'}, {duration: '60000'}, {definition: {...definition, prompt: {node: '7', key: 'text'}}}]) {
      await reject(envelope(`${REVISION}.update`, {record: ref(published), ...patch}), 'rule_failed', await current(0));
    }
    const live = await update(TEMPLATE, template, {current: ref(published)}); assert.deepEqual(live.data.current, ref(published));
    const inactive = await update(TEMPLATE, live, {active: false}); await reject(envelope(OP, {template: ref(inactive)}), 'rule_failed');
    const restored = await update(TEMPLATE, inactive, {active: true});
    await reject(envelope(`${TEMPLATE}.create`, {name: 'Denied member', graph: {id: graph}}), 'forbidden', await current(1), false);
    await reject(envelope(`${REVISION}.update`, {record: ref(published), digest: 'Denied member'}), 'forbidden', await current(1), false);
    // Ordinary members receive precisely the original field-limited source;
    // manager full-field access is an actual explicit Identity role grant.
    const memberTemplates = await read(`${TEMPLATE}.read`, await current(1)); const visibleTemplate = memberTemplates.find(row => row.id === template.id); assert.ok(visibleTemplate);
    assert.deepEqual(object(visibleTemplate.data), {name: 'Original workflow', active: true, current: ref(published)});
    const managerTemplate = (await read(`${TEMPLATE}.read`, await current(0))).find(row => row.id === template.id); assert.ok(managerTemplate);
    assert.deepEqual(object(managerTemplate.data).graph, {id: graph}); assert.deepEqual(object(managerTemplate.data).owner, {id: users[0]!.user_id});
    const memberRevisions = await read(`${REVISION}.read`, await current(1)); assert.ok(memberRevisions.some(row => row.id === published.id));
    const retained: Array<{input: MutationEnvelope; run: StoredRow}> = [];
    const generate = async (sourceTemplate: StoredRow, sourceRevision: StoredRow) => {
      const input = envelope(OP, {template: ref(sourceTemplate)}), before = await all(), revision = await store.readRevision();
      const result = committed(await invoker.invokeMutation(input, await current())), wire = object(result.result); assert.deepEqual(Object.keys(wire), ['id']);
      const run = await store.load(RUN, wire.id as StoredRow['id']); assert.ok(run); retained.push({input, run});
      assert.deepEqual(run.data, {revision: {id: sourceRevision.id}, digest: sourceRevision.data.digest, outputs: sourceRevision.data.outputs, duration: sourceRevision.data.duration},
        'the stored Run keeps its canonical reference ID; the original observed Revision row below retains its version');
      assert.equal(run.parent, null); assert.equal(run.version, 1); assert.equal(run.createdBy, users[1]!.user_id); assert.equal(run.created, now);
      assert.equal(decodeValue('duration', run.data.duration), decodeValue('duration', sourceRevision.data.duration));
      const receipt = await store.readReceipt(receiptIdentity(input)); assert.ok(receipt); assert.equal(receipt.inputHash, await hashInputs(input.inputs)); assert.equal(receipt.committedRevision, revision + 1);
      assert.equal(receipt.outcome.status, 'committed'); if (receipt.outcome.status !== 'committed') throw new Error('Original generate must commit');
      assert.deepEqual(receipt.outcome.result, {id: run.id}); assert.deepEqual(receipt.outcome.recordVersions, [{model: RUN, id: run.id, version: 1}]);
      const association = readScenarioReceiptAssociation(receipt); assert.ok(association); assert.deepEqual(association.plan, plan); assert.equal(association.returnId, returned.id); assert.equal(association.resultType, RUN);
      assert.equal(association.queries?.length ?? 0, 0); assert.equal(association.calls?.length ?? 0, 0); assert.equal(association.changed.length, 1);
      assert.equal(association.changed[0]!.model, RUN); assert.deepEqual(association.changed[0]!.row, run);
      assert.equal(association.changed[0]!.fieldTypes.revision, null);
      assert.deepEqual(association.changed[0]!.withheldFields, ['revision']);
      // The descriptor census above follows source-node order. Runtime
      // observes the once-Let DATA only at its first use after the digest
      // guard; neither original getter nor its CONTROL marker is repeated.
      const expected = [...returned.dependencies.slice(0, 5), returned.dependencies[6]!,
        returned.dependencies[5]!, ...returned.dependencies.slice(7)];
      assert.deepEqual(association.observations.map(value => value.dependencyId), expected.map(value => value.id));
      for (const [index, observation] of association.observations.entries()) {
        assert.equal(observation.model, expected[index]!.model); assert.deepEqual(observation.row, observation.model === TEMPLATE ? sourceTemplate : sourceRevision); assert.deepEqual(observation.secretFields, []);
      }
      assert.deepEqual((result.records as readonly ProjectedRecord[]).map(value => ({id: value.id, data: value.data, parent: value.parent})),
        [{id: run.id, data: {digest: run.data.digest, outputs: run.data.outputs, duration: run.data.duration}, parent: run.parent}]);
      const history = await store.historyFor(RUN, run.id); assert.equal(history.length, 1); const entry = history[0]!;
      assert.equal(entry.operation, OP); assert.equal(entry.operationId, input.operation_id); assert.equal(entry.version, 1); assert.equal(entry.change, 'create'); assert.equal(entry.actor, users[1]!.user_id); assert.equal(entry.before, null); assert.deepEqual(entry.after, run.data);
      const after = await all(); assert.equal(await store.readRevision(), revision + 1); assert.equal(after.owner.records!.length, before.owner.records!.length + 1); assert.equal(after.owner.history!.length, before.owner.history!.length + 1);
      assert.equal(after.owner.receipts!.length, before.owner.receipts!.length + 1); assert.deepEqual(after.owner.records!.filter(value => value.id !== run.id), before.owner.records);
      assert.deepEqual(after.owner.history!.filter(value => value.operation_id !== input.operation_id), before.owner.history); assert.deepEqual(after.owner.receipts!.filter(value => value.operation_id !== input.operation_id), before.owner.receipts);
      assert.deepEqual(after.owner.fence, [{id: 1, revision: revision + 1}]); assert.deepEqual(after.owner.fence_log!.filter(value => value.revision !== revision + 1), before.owner.fence_log);
      assert.deepEqual(after.owner.fence_log!.filter(value => value.revision === revision + 1), [{at: now, operation: OP, revision: revision + 1}]); historySequence(before.owner, after.owner);
      for (const table of Object.keys(before.owner)) if (!['records', 'history', 'receipts', 'fence', 'fence_log', 'sqlite_sequence'].includes(table)) assert.deepEqual(after.owner[table], before.owner[table], table);
      for (const resource of ['identity', 'foreign', 'physical', 'foreignPhysical'] as const) assert.deepEqual(after[resource], before[resource]);
      for (const dedicated of [false, true]) {
        const replay = committed(await (dedicated ? invoker.invokeRetainedMutation(input, await current()) : invoker.invokeMutation(input, await current())), 'replayed');
        assert.deepEqual(replay.result, {id: run.id}); assert.deepEqual(replay.records, result.records); assert.deepEqual(await all(), after); assert.deepEqual(await store.readReceipt(receiptIdentity(input)), receipt);
      }
      return run;
    };
    await generate(restored, published);
    // A second authentic parent proves retained source/target and ancestor
    // lifetime independently. Revision.number is unique within its declared
    // Template parent; both parents retain atomic duplicate refusal.
    const second = await create(TEMPLATE, {name: 'Second workflow', graph: {id: graph}, outputs: '4', duration: '900000'});
    const secondRevision = await create(REVISION, {parent: ref(second), number: '1', definition, outputs: '4', duration: '900000', published: true, digest});
    await reject(envelope(`${REVISION}.create`, {parent: ref(second), number: '1', definition, outputs: '4', duration: '900000', published: true, digest}), 'conflict', await current(0), false);
    const secondLive = await update(TEMPLATE, second, {current: ref(secondRevision)}); await generate(secondLive, secondRevision);
    const runRead = await read(`${RUN}.read`, await current(1)); assert.equal(runRead.length, 2);
    for (const saved of retained) assert.deepEqual(object(runRead.find(row => row.id === saved.run.id)!.data), saved.run.data);
    assert.equal(retained[0]!.run.data.outputs, '1'); assert.equal(retained[1]!.run.data.outputs, '4'); assert.equal(retained[1]!.run.data.duration, '900000');
    const foreignTemplate = await create(TEMPLATE, {name: 'Foreign workflow', graph: {id: foreignGraph}}, foreignIdentity);
    const foreignDefinition = {...definition, graph: {id: foreignGraph}};
    const foreignRevision = await create(REVISION, {parent: ref(foreignTemplate), number: '1', definition: foreignDefinition, outputs: '1', duration: '120000', published: true, digest}, foreignIdentity);
    const foreignUpdate = envelope(`${TEMPLATE}.update`, {record: ref(foreignTemplate), current: ref(foreignRevision)});
    committed(await foreignInvoker.invokeMutation(foreignUpdate, await current(2)));
    const foreignLive = await foreign.load(TEMPLATE, foreignTemplate.id); assert.ok(foreignLive);
    // Admission failures cannot manufacture absent/foreign rows or null facts.
    for (const [value, code] of [[ref(template), 'conflict'], [ref(published), 'not_found'], [ref(foreignLive), 'not_found'],
      [{id: uuidv7(now, ++sequence), version: '1'}, 'not_found']] as const) {
      await reject(envelope(OP, {template: value}), code, await current(1), false);
    }
    await reject(envelope(OP, {}), 'validation', await current(1), false);
    await reject(envelope(OP, {template: null}), 'validation', await current(1), false);
    // Parent/current correspondence uses real other-parent rows, never a fake
    // row or caller-supplied observation. Both candidates are published.
    await reject(envelope(`${TEMPLATE}.update`, {record: ref(restored), current: ref(secondRevision)}), 'rule_failed', await current(0));
    await reject(envelope(`${TEMPLATE}.update`, {record: ref(restored), current: ref(foreignRevision)}), 'not_found', await current(0), false);
    const stable = await all();
    for (const [target, actor] of [[invoker, await current(3)], [foreignInvoker, await current(2)]] as const) {
      const denied = await target.invokeRetainedMutation(retained[0]!.input, actor); assert.ok('error' in denied); assert.equal(denied.error.code, 'not_found'); assert.deepEqual(await all(), stable);
    }
    const replay = async (saved: typeof retained[number], visible: boolean) => {
      const before = await all(), receipt = await store.readReceipt(receiptIdentity(saved.input));
      const outcome = committed(await invoker.invokeMutation(saved.input, await current()), 'replayed');
      assert.deepEqual(outcome.result, visible ? {id: saved.run.id} : null);
      if (visible) assert.equal((outcome.records as readonly ProjectedRecord[])[0]!.id, saved.run.id); else assert.deepEqual(outcome.records, []);
      assert.deepEqual(await all(), before); assert.deepEqual(await store.readReceipt(receiptIdentity(saved.input)), receipt); assert.deepEqual(await store.load(RUN, saved.run.id), saved.run);
    };
    // Current read policy follows the real containing Template.active; stored
    // source facts and the original Run remain exact throughout withholding.
    const disabled = await update(TEMPLATE, restored, {active: false}); await replay(retained[0]!, false);
    assert.equal((await read(`${REVISION}.read`, await current(1))).some(row => row.id === published.id), false);
    const enabled = await update(TEMPLATE, disabled, {active: true}); await replay(retained[0]!, true);
    // A later current pointer must never substitute its new definition/digest
    // into a retained Run or its saved observations from the original call.
    const replacement = await create(REVISION, {parent: ref(enabled), number: '3', definition, outputs: '2', duration: '60000', published: true, digest: `${digest}-replacement`});
    const switched = await update(TEMPLATE, enabled, {current: ref(replacement)}); await replay(retained[0]!, true);
    const savedReceipt = await store.readReceipt(receiptIdentity(retained[0]!.input)); assert.ok(savedReceipt);
    const savedAssociation = readScenarioReceiptAssociation(savedReceipt); assert.ok(savedAssociation);
    assert.ok(savedAssociation.observations.filter(value => value.model === REVISION).every(value => value.row.id === published.id && value.row.version === published.version));
    assert.ok(savedAssociation.observations.filter(value => value.model === TEMPLATE).every(value => JSON.stringify(value.row) === JSON.stringify(restored)));
    await identities.removeMembership(memberships[1]!.membership_id); now += 1000;
    const revoked = await all();
    for (const saved of retained) {
      const outcome = await invoker.invokeRetainedMutation(saved.input, member); assert.ok('error' in outcome); assert.equal(outcome.error.code, 'forbidden'); assert.deepEqual(await all(), revoked);
    }
    await reject(envelope(OP, {template: ref(switched)}), 'forbidden', member, false);
    await identities.reactivateMembership(memberships[1]!.membership_id, {is_owner: false, roles: []});
    for (const saved of retained) await replay(saved, true);
    // Losing the manager role removes full owning-field reads while keeping
    // the explicit ordinary-member projection and existing Run receipt valid.
    await identities.reactivateMembership(memberships[0]!.membership_id, {is_owner: false, roles: []});
    await reject(envelope(`${TEMPLATE}.update`, {record: ref(switched), name: 'Role revoked'}), 'forbidden', await current(0), false);
    const formerManagerTemplates = await read(`${TEMPLATE}.read`, await current(0));
    assert.equal(Object.hasOwn(object(formerManagerTemplates.find(row => row.id === template.id)!.data), 'graph'), false);
    await identities.reactivateMembership(memberships[0]!.membership_id, {is_owner: false, roles: managerRoles(0)});
    // Archive the saved Revision after switching current to the replacement;
    // archive the independent containing Template for the second retained Run.
    committed(await invoker.invokeMutation(envelope(`${REVISION}.delete`, {record: ref(published)}), await current(0))); await replay(retained[0]!, false);
    committed(await invoker.invokeMutation(envelope(`${TEMPLATE}.delete`, {record: ref(secondLive)}), await current(0))); await replay(retained[1]!, false);
    assert.deepEqual(await store.outboxPending(), []); assert.deepEqual(await foreign.outboxPending(), []);
    assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await captureIsCurrent(capture), true);
    assert.equal(hash(await readFile(source)), authoredHash); assert.equal((await readFile(source, 'utf8')).replace(SETUP, ''), originalText);
    assert.deepEqual(await Promise.all(paths.map(async path => hash(await readFile(path)))), originals.map(hash));
    for (const {path, bytes} of compilerSources) assert.deepEqual(await readFile(path), bytes);
    for (const [path, bytes] of compiledBytes) assert.deepEqual(await readFile(fileURLToPath(asm.moduleUrls[path]!)), bytes);
    phase('original-success-replay-current-and-closure:complete');
  } finally {
    try { await physical?.close(); } finally {
      try { await foreignPhysical?.close(); } finally {
        try { await worker?.dispose(); } finally {
          try {
            if (capture !== undefined) {
              const {captureIsCurrent} = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
              assert.equal(await captureIsCurrent(capture), true, 'source/output closure stays current through awaited D1/workerd cleanup');
            }
          } finally { await rm(directory, {recursive: true, force: true}); phase('cleanup:awaited'); }
        }
      }
    }
  }
 });
