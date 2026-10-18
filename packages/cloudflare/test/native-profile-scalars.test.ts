/** Original Profile source consumer for the released scalar-source producer.
 * Runtime outcomes below require this complete installed native execution;
 * source/descriptor/factory qualification alone does not establish them.
 */
import { createCheckoutScratch } from '../src/runtime/checkout-scratch.test-support.js';
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
import type { CompileArtifact, ModelName, MutationEnvelope, OperationName,
  OperationId, ProjectedRecord, ReceiptIdentity, ResolvedIdentity, StoredRow } from '@canlang/contracts';
import type { SqliteFileStore } from '@canlang/files/host/sqlite';
import type { SingleFileCapture } from '../src/dev/source-capture.js';
import type { MutationOutcome } from '../src/worker/assembly.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const APP = 'SourceProfileScalars', OP = `${APP}.ask`;
const CONVERSATION = `${APP}.Conversation` as ModelName, BRANCH = `${APP}.Branch` as ModelName, RUN = `${APP}.Run` as ModelName;
const PROFILE = `${APP}.Profile` as ModelName;
const ORIGINAL_SHA256 = '06e8633f8d0b8d1b7b57333447a4bda47db36676db8b43bab5259f6064693995';
const SETUP = ' ## BEGIN TEST-AUTHORED SETUP: authenticated contained CRUD\n' +
  ' crud Conversation by=members fields=title\n' +
  ' crud Branch by=members fields=title,profile\n' +
  ' crud Profile by=members fields=name,provider_key,policy_revision,system_prompt,input_tokens,output_tokens,duration,active\n' +
  ' ## END TEST-AUTHORED SETUP\n';
const require = createRequire(import.meta.url);
const nodeImport = compileFunction('return import(url)', ['url'], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const producer = (name: string) => pathToFileURL(require.resolve(name)).href;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
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

test('original required Profile reference keeps scalar codecs, nine read pairs, same Run and current authority',
 {timeout: 3600000}, async () => {
  // Finite first-run allowance reflects measured source/grant native costs;
  // it does not change Office/A7 limits or establish latency acceptance.
  const started = Date.now(), phase = (name: string) => {
    process.stdout.write(`[native-profile ${Date.now() - started}ms] ${name}\n`);
  };
  phase('source:start');
  const directory = await createCheckoutScratch(root, 'native-profile-scalars-');
  let worker: Miniflare | undefined, capture: SingleFileCapture | undefined, physical: SqliteFileStore | undefined, foreignPhysical: SqliteFileStore | undefined;
  try {
    // Private assembly, row, query and policy producers share the authentic
    // installed default Node loader; no Vitest producer can reconstruct them.
    const {assembleModules, importVerifiedAssemblyModule} = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
    const {buildInvoker, createTeamOwnerStorageBoundary} = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
    const {loadCanonicalDescriptors} = await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
    const {prepareLocalPreviewCapture} = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
    const {captureSingleFileSource, captureIsCurrent, verifyCompilerSources} = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
    const {distribution} = await nodeImport(producer('@canlang/values/distribution')) as typeof import('@canlang/values/distribution');
    const {decodeValue} = await nodeImport(producer('@canlang/values')) as typeof import('@canlang/values');
    const {createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity} = await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
    const {ensureSchema} = await nodeImport(producer('@canlang/state/storage/d1')) as typeof import('@canlang/state/storage/d1');
    const {createD1OwnerRouter} = await nodeImport(producer('@canlang/state/storage/owner-router')) as typeof import('@canlang/state/storage/owner-router');
    const {createSqliteFileStore} = await nodeImport(producer('@canlang/files/host/sqlite')) as typeof import('@canlang/files/host/sqlite');
    const {readScenarioReceiptAssociation} = await nodeImport(producer('@canlang/state/invocation')) as typeof import('@canlang/state/invocation');
    const {hashInputs} = await nodeImport(producer('@canlang/state/invocation/replay')) as typeof import('@canlang/state/invocation/replay');
    const {uuidv7} = await nodeImport(producer('@canlang/state/testing/invocation/fixtures')) as typeof import('@canlang/state/testing/invocation/fixtures');
    const originalSource = join(root, 'compiler/tests/fixtures/source-profile-scalars.can');
    const source = join(directory, 'native-profile-scalars-with-labelled-setup.can');
    const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
    const paths = [originalSource, compiler, catalog], originals = await Promise.all(paths.map(path => readFile(path)));
    assert.equal(originals[0]!.length, 1483); assert.equal(hash(originals[0]!), ORIGINAL_SHA256);
    const originalText = originals[0]!.toString('utf8'); assert.equal(originalText.split('When\n').length, 2);
    const authored = originalText.replace('When\n', `When\n${SETUP}`);
    assert.equal(authored.split(SETUP).length, 2); assert.equal(authored.replace(SETUP, ''), originalText);
    await writeFile(source, authored); const authoredHash = hash(Buffer.from(authored));
    capture = await captureSingleFileSource(prepareLocalPreviewCapture({checkoutRoot: root, appPath: source,
      compilerPath: compiler, catalogPath: catalog, helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md')}));
    assert.equal(capture.sourceSha256, authoredHash); assert.equal(await captureIsCurrent(capture), true);
    for (const [name, path, bytes] of [['compiler', compiler, originals[1]!], ['catalog', catalog, originals[2]!]] as const) {
      const input: SingleFileCapture['inputs'][number] | undefined = capture.inputs.find(value => value.name === name);
      assert.ok(input); assert.equal(input.state, 'present');
      assert.equal(input.requestedPath, path); assert.equal(input.sha256, hash(bytes));
    }
    // Use the captured actual CLI and native flag, without changing product
    // first-slice admission or inventing a fixture artifact/capture profile.
    const env = {...process.env}; delete env.CAN_CATALOG;
    const {stdout} = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, capture.compilerOperand],
      {cwd: capture.root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024});
    const artifact = JSON.parse(stdout) as CompileArtifact, originalArtifact = JSON.stringify(artifact);
    phase('source:compiled');
    assert.equal(verifyCompilerSources(capture, {complete: true, sources: artifact.sources}).ok, true);
    assert.equal(await captureIsCurrent(capture), true);
    const compilerSources = await Promise.all(artifact.sources.map(async value => {
      const path = resolve(capture!.root, value.path), bytes = await readFile(path); assert.equal(hash(bytes), value.sha256); return {path, bytes};
    }));
    const op = artifact.operations?.find(value => value.name === OP); assert.ok(op?.result?.disclosure); assert.equal(op.result.type, RUN);
    assert.equal(artifact.pages.length, 0);
    for (const model of [CONVERSATION, BRANCH, PROFILE]) assert.equal(artifact.operations?.find(value => value.name === `${model}.create`)?.kind, 'create');
    assert.equal(op.inputs.fields.length, 1); const parameter = op.inputs.fields[0]!;
    assert.equal(parameter.name, 'branch'); assert.equal(parameter.required, true); assert.equal(parameter.default, undefined);
    assert.deepEqual(parameter.field, {kind: 'ref', model: BRANCH, requireVersion: true});
    assert.equal(artifact.models!.find(value => value.name === RUN)!.parent, BRANCH);
    assert.equal(artifact.models!.find(value => value.name === BRANCH)!.parent, CONVERSATION);
    const profileInput = artifact.operations!.find(value => value.name === `${BRANCH}.create`)!.inputs.fields.find(value => value.name === 'profile');
    assert.ok(profileInput); assert.deepEqual(profileInput.field, {kind: 'ref', model: PROFILE, requireVersion: true}); assert.equal(profileInput.required, true);
    const plan = op.result.disclosure; assert.equal(plan.queries?.length ?? 0, 0);
    assert.equal(plan.source.sha256, authoredHash); assert.equal(resolve(capture.root, plan.source.path), source);
    assert.equal(plan.returns.length, 1); const returned = plan.returns[0]!;
    assert.deepEqual(returned.influences, []); assert.equal(returned.dependencies.length, 18);
    const controls = returned.dependencies.filter(value => value.role === 'control'), dataDependencies = returned.dependencies.filter(value => value.role === 'data');
    assert.deepEqual(controls.map(value => [value.model, value.field, value.type]), [[BRANCH, 'profile', PROFILE], [PROFILE, 'active', 'bool']]);
    const leaves = ['input_tokens', 'output_tokens', 'system_prompt', 'provider_key', 'policy_revision', 'input_tokens', 'output_tokens', 'duration'] as const;
    assert.equal(dataDependencies.length, 16); assert.equal(new Set(returned.dependencies.map(value => value.id)).size, 18);
    for (const dependency of returned.dependencies) { assert.deepEqual(dependency.source, plan.source); assert.equal(dependency.queryId, undefined); }
    for (const [index, field] of leaves.entries()) {
      assert.equal(dataDependencies[index * 2]!.model, BRANCH); assert.equal(dataDependencies[index * 2]!.field, 'profile'); assert.equal(dataDependencies[index * 2]!.type, PROFILE);
      assert.equal(dataDependencies[index * 2 + 1]!.model, PROFILE); assert.equal(dataDependencies[index * 2 + 1]!.field, field);
      assert.equal(dataDependencies[index * 2 + 1]!.type, field === 'duration' ? 'duration' : field.endsWith('tokens') ? 'int' : 'text');
    }
    const asm = await assembleModules({artifact, sourcePath: source}, {workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js'),
      uiUrl: producer('@canlang/ui')});
    const loaded = await loadCanonicalDescriptors(asm, artifact);
    assert.deepEqual(object(object(loaded.registry.get(OP)).descriptor).result, op.result);
    const callable = artifact.callables.find(value => value.id === OP); assert.ok(callable);
    assert.deepEqual(artifact.modelPolicies, [{abi: 'state.owner-model-policies@1', model: PROFILE, ownerPackage: APP, module: callable.module,
      rules: [{kind: 'invariant', id: `${PROFILE}.require.1`, dependencies: []},
        {kind: 'lock', id: `${PROFILE}.lock.1`, fields: ['name', 'provider_key', 'policy_revision', 'system_prompt', 'input_tokens', 'output_tokens', 'duration']}], hooks: []}]);
    const namespace = object(await importVerifiedAssemblyModule(asm, callable.module, artifact)); assert.equal(namespace[callable.export], OP);
    assert.equal(object(object(object(namespace.appDefinition).operations)[OP]).by, 'members');
    const generated = artifact.modules.find(value => value.path === callable.module)!;
    assert.match(generated.js, /await bindScenarioReceiptModelResult\(c,/);
    let handler: unknown = (namespace.canApp as () => unknown)(); for (const member of callable.member) handler = object(handler)[member];
    assert.equal(typeof handler, 'function'); const body = (handler as Function).toString();
    assert.equal((body.match(/\bawait create\(/g) ?? []).length, 1);
    assert.equal((body.match(/\bexecuteScenarioReceiptQuery\(/g) ?? []).length, 0);
    const created = /const ([$\w]+) = await create\(c,"SourceProfileScalars\.Run",/.exec(body); assert.ok(created);
    assert.ok(body.includes(`const $receiptValue=${created[1]};`), 'same original Run enters result binding');
    const compiledBytes = new Map(await Promise.all(Object.entries(asm.moduleUrls).map(async ([path, url]) => [path, await readFile(fileURLToPath(url))] as const)));
    worker = new Miniflare({compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: {IDENTITY: 'profile-scalars-identity', A: 'profile-scalars-owner-a', B: 'profile-scalars-owner-b'}, d1Persist: join(directory, 'd1')});
    const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
    const a = await worker.getD1Database('A') as unknown as D1Database, b = await worker.getD1Database('B') as unknown as D1Database;
    await ensureIdentitySchema(identityDb); await ensureSchema(a); await ensureSchema(b);
    let now = Date.now(), sequence = 0; const clock = {nowMs: () => now};
    const identities = createD1IdentityStore(identityDb, {clock});
    const teams = await Promise.all([identities.createTeam({timezone: 'UTC'}), identities.createTeam({timezone: 'UTC'})]);
    const users = await Promise.all(['reader', 'foreign'].map(name => identities.createUser({email: `${name}@profile-scalars.example.test`, password_hash: 'unused', email_verified: true})));
    const memberships = await Promise.all(users.map((user, index) => identities.createMembership({user_id: user.user_id, team_id: teams[index]!.team_id, is_owner: false, roles: []})));
    const grants = await Promise.all(users.map((user, index) => issueMcpGrant(identities, {user_id: user.user_id, team_id: teams[index]!.team_id, client_id: 'profile-scalars'}, {clock})));
    const current = (index = 0) => resolveIdentity(identities, {mcp_grant_token: grants[index]!.token}, {clock});
    const identity = await current(), foreignIdentity = await current(1);
    physical = createSqliteFileStore(join(directory, 'files.sqlite')); foreignPhysical = createSqliteFileStore(join(directory, 'foreign-files.sqlite'));
    // This original scalar profile has no File inputs, fields or results. Use
    // its real routed State owner stores; the real SQLite resources below
    // remain part of every unchanged-resource check, without retirement setup.
    const ownerStorage = await createTeamOwnerStorageBoundary({artifact, asm, app: APP, identities,
      router: createD1OwnerRouter({resolveBinding: selected => selected.app === APP &&
        teams.some(team => team.team_id === selected.owner)
        ? {...selected, db: selected.owner === teams[0]!.team_id ? a : b, initializeFresh: true} : null})});
    const store = await ownerStorage.forIdentity(identity), foreign = await ownerStorage.forIdentity(foreignIdentity);
    const invoker = buildInvoker(artifact, asm, store, {appId: APP, memberships: identities, source: 'http', now: clock.nowMs, ownerStorage}),
      foreignInvoker = buildInvoker(artifact, asm, foreign, {appId: APP, memberships: identities, source: 'http', now: clock.nowMs, ownerStorage});
    phase('authenticated-stores:ready');
    const all = async () => ({identity: await snapshot(identityDb), owner: await snapshot(a), foreign: await snapshot(b),
      files: physical!.files.listAll(), intents: physical!.intents.listAll(), foreignFiles: foreignPhysical!.files.listAll(), foreignIntents: foreignPhysical!.intents.listAll()});
    const envelope = (operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({operation, operation_id: uuidv7(now, ++sequence), inputs});
    const receiptIdentity = (input: MutationEnvelope, actor: ResolvedIdentity = identity): ReceiptIdentity => ({app: APP,
      owner: actor.team!.team_id, principal: actor.actor!.user_id, operation: input.operation as OperationName, operationId: input.operation_id as OperationId});
    const create = async (model: ModelName, inputs: MutationEnvelope['inputs'], actor: ResolvedIdentity = identity): Promise<StoredRow> => {
      const input = envelope(`${model}.create`, inputs), selected = actor.team!.team_id === teams[0]!.team_id ? store : foreign, selectedInvoker = selected === store ? invoker : foreignInvoker, revision = await selected.readRevision();
      const result = committed(await selectedInvoker.invokeMutation(input, actor)); assert.equal(await selected.readRevision(), revision + 1);
      const records = result.records as readonly ProjectedRecord[]; assert.equal(records.length, 1);
      const row = await selected.load(model, records[0]!.id); assert.ok(row); assert.equal(row.version, 1); assert.equal(row.createdBy, actor.actor!.user_id);
      const receipt = await selected.readReceipt(receiptIdentity(input, actor)); assert.ok(receipt); assert.equal(receipt.outcome.status, 'committed');
      assert.equal(receipt.inputHash, await hashInputs(input.inputs)); assert.equal(receipt.committedRevision, revision + 1);
      const history = await selected.historyFor(model, row.id); assert.equal(history.length, 1); assert.equal(history[0]!.operation, input.operation);
      assert.equal(history[0]!.operationId, input.operation_id); assert.equal(history[0]!.before, null); assert.deepEqual(history[0]!.after, row.data); return row;
    };
    const rejected = async (input: MutationEnvelope, code: string) => {
      const before = await all(), revision = await store.readRevision(), outcome = await invoker.invokeMutation(input, await current());
      assert.ok('error' in outcome, JSON.stringify(outcome)); assert.equal(outcome.error.code, code);
      const receipt = await store.readReceipt(receiptIdentity(input)); assert.ok(receipt);
      assert.deepEqual(receipt.outcome, {status: 'rejected', code, message: outcome.error.message}); assert.equal(receipt.inputHash, await hashInputs(input.inputs)); assert.equal(receipt.committedRevision, revision + 1);
      const after = await all();
      for (const table of Object.keys(before.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) assert.deepEqual(after.owner[table], before.owner[table], table);
      assert.equal(after.owner.receipts!.length, before.owner.receipts!.length + 1); assert.deepEqual(after.owner.receipts!.filter(value => value.operation_id !== input.operation_id), before.owner.receipts);
      assert.deepEqual(after.owner.fence, [{id: 1, revision: revision + 1}]); assert.deepEqual(after.owner.fence_log!.filter(value => value.revision !== revision + 1), before.owner.fence_log);
      assert.deepEqual(after.owner.fence_log!.filter(value => value.revision === revision + 1), [{at: now, operation: input.operation, revision: revision + 1}]);
      for (const resource of ['identity', 'foreign', 'files', 'intents', 'foreignFiles', 'foreignIntents'] as const) assert.deepEqual(after[resource], before[resource]);
      const replay = await invoker.invokeMutation(input, await current()); assert.ok('error' in replay); assert.equal(replay.error.code, code); assert.deepEqual(await all(), after);
    };
    const profile = await create(PROFILE, {name: '  Default  ', provider_key: 'provider-key', policy_revision: 'policy-v1', system_prompt: 'System prompt'});
    assert.deepEqual(profile.data, {name: 'Default', provider_key: 'provider-key', policy_revision: 'policy-v1', system_prompt: 'System prompt', input_tokens: '8192', output_tokens: '2048', duration: '120000', active: true});
    assert.equal(decodeValue('duration', profile.data.duration), 120000n);
    const conversation = await create(CONVERSATION, {title: '  Original conversation  '}); assert.deepEqual(conversation.data.account, {id: users[0]!.user_id}); assert.equal(conversation.data.title, 'Original conversation');
    const update = async (model: ModelName, original: StoredRow, patch: MutationEnvelope['inputs']) => {
      const row = await store.load(model, original.id); assert.ok(row);
      return committed(await invoker.invokeMutation(envelope(`${model}.update`, {record: {id: row.id, version: String(row.version)}, ...patch}), await current()));
    };
    await rejected(envelope(`${PROFILE}.update`, {record: {id: profile.id, version: '1'}, provider_key: 'locked-change'}), 'rule_failed');
    for (const patch of [{input_tokens: '32769'}, {output_tokens: '8193'}, {duration: '999'}]) {
      await rejected(envelope(`${PROFILE}.create`, {name: 'Bounds control', provider_key: 'key', policy_revision: 'revision', system_prompt: 'Prompt', ...patch}), 'duration' in patch ? 'rule_failed' : 'validation');
    }
    await update(PROFILE, profile, {active: false});
    const inactiveProfile = await store.load(PROFILE, profile.id); assert.ok(inactiveProfile);
    const inactiveBranch = await create(BRANCH, {parent: {id: conversation.id, version: '1'}, title: 'Inactive control',
      profile: {id: profile.id, version: String(inactiveProfile.version)}});
    assert.deepEqual(inactiveBranch.data.profile, {id: profile.id, version: String(inactiveProfile.version)});
    await rejected(envelope(OP, {branch: {id: inactiveBranch.id, version: '1'}}), 'rule_failed');
    await update(PROFILE, profile, {active: true});
    const restoredProfile = await store.load(PROFILE, profile.id); assert.ok(restoredProfile);
    const branch = await create(BRANCH, {parent: {id: conversation.id, version: '1'}, title: 'Original branch',
      profile: {id: profile.id, version: String(restoredProfile.version)}});
    assert.deepEqual(branch.data.profile, {id: profile.id, version: String(restoredProfile.version)});
    phase('setup-controls:complete');
    const retained: Array<{input: MutationEnvelope; run: StoredRow}> = [];
    const ask = async (sourceBranch: StoredRow, sourceProfile: StoredRow) => {
      const caseNumber = retained.length + 1; phase(`ask:${caseNumber}:start`);
      const actualProfile = await store.load(PROFILE, sourceProfile.id); assert.ok(actualProfile);
      const input = envelope(OP, {branch: {id: sourceBranch.id, version: String(sourceBranch.version)}}), before = await all(), revision = await store.readRevision();
      const result = committed(await invoker.invokeMutation(input, await current())), wire = object(result.result); assert.deepEqual(Object.keys(wire), ['id']);
      phase(`ask:${caseNumber}:committed`);
      const run = await store.load(RUN, wire.id as StoredRow['id']); assert.ok(run); retained.push({input, run});
      const data = actualProfile.data;
      assert.deepEqual(run.data, {reserved: String(BigInt(String(data.input_tokens)) + BigInt(String(data.output_tokens))), system_prompt: data.system_prompt,
        provider_key: data.provider_key, policy_revision: data.policy_revision, input_tokens: data.input_tokens, output_tokens: data.output_tokens, duration: data.duration});
      assert.deepEqual(run.parent, {model: BRANCH, id: sourceBranch.id}); assert.equal(run.version, 1); assert.equal(run.createdBy, users[0]!.user_id); assert.equal(run.created, now);
      assert.equal(typeof decodeValue('int', run.data.reserved), 'bigint'); assert.equal(decodeValue('duration', run.data.duration), decodeValue('duration', actualProfile.data.duration));
      const receipt = await store.readReceipt(receiptIdentity(input)); assert.ok(receipt); assert.equal(receipt.inputHash, await hashInputs(input.inputs)); assert.equal(receipt.committedRevision, revision + 1);
      assert.equal(receipt.outcome.status, 'committed'); if (receipt.outcome.status !== 'committed') throw new Error('Profile ask must commit');
      assert.deepEqual(receipt.outcome.result, {id: run.id}); assert.deepEqual(receipt.outcome.recordVersions, [{model: RUN, id: run.id, version: 1}]);
      const association = readScenarioReceiptAssociation(receipt); assert.ok(association); assert.deepEqual(association.plan, plan); assert.equal(association.resultType, RUN);
      assert.equal(association.queries?.length ?? 0, 0); assert.equal(association.calls?.length ?? 0, 0); assert.equal(association.changed.length, 1); assert.equal(association.changed[0]!.model, RUN); assert.deepEqual(association.changed[0]!.row, run);
      // Nine original occurrences retain their own reference+leaf observations,
      // including repeated token leaves; actual evaluation begins with active.
      const expected = [...controls, ...dataDependencies];
      assert.deepEqual(association.observations.map(value => value.dependencyId), expected.map(value => value.id));
      for (const [index, observation] of association.observations.entries()) {
        assert.equal(observation.model, expected[index]!.model); assert.deepEqual(observation.row, observation.model === BRANCH ? sourceBranch : actualProfile); assert.deepEqual(observation.secretFields, []);
      }
      assert.deepEqual((result.records as readonly ProjectedRecord[]).map(value => ({id: value.id, data: value.data, parent: value.parent})), [{id: run.id, data: run.data, parent: run.parent}]);
      const history = await store.historyFor(RUN, run.id); assert.equal(history.length, 1); const entry = history[0]!;
      assert.equal(entry.operation, OP); assert.equal(entry.operationId, input.operation_id); assert.equal(entry.version, 1); assert.equal(entry.change, 'create'); assert.equal(entry.actor, users[0]!.user_id); assert.equal(entry.before, null); assert.deepEqual(entry.after, run.data);
      const after = await all(); assert.equal(await store.readRevision(), revision + 1); assert.equal(after.owner.records!.length, before.owner.records!.length + 1); assert.equal(after.owner.history!.length, before.owner.history!.length + 1);
      assert.equal(after.owner.receipts!.length, before.owner.receipts!.length + 1); assert.deepEqual(after.owner.records!.filter(value => value.id !== run.id), before.owner.records);
      assert.deepEqual(after.owner.history!.filter(value => value.operation_id !== input.operation_id), before.owner.history); assert.deepEqual(after.owner.receipts!.filter(value => value.operation_id !== input.operation_id), before.owner.receipts);
      assert.deepEqual(after.owner.fence, [{id: 1, revision: revision + 1}]); assert.deepEqual(after.owner.fence_log!.filter(value => value.revision !== revision + 1), before.owner.fence_log);
      assert.deepEqual(after.owner.fence_log!.filter(value => value.revision === revision + 1), [{at: now, operation: OP, revision: revision + 1}]); historySequence(before.owner, after.owner);
      for (const table of Object.keys(before.owner)) if (!['records', 'history', 'receipts', 'fence', 'fence_log', 'sqlite_sequence'].includes(table)) assert.deepEqual(after.owner[table], before.owner[table], table);
      for (const resource of ['identity', 'foreign', 'files', 'intents', 'foreignFiles', 'foreignIntents'] as const) assert.deepEqual(after[resource], before[resource]);
      phase(`ask:${caseNumber}:readback`);
      const replay = committed(await invoker.invokeRetainedMutation(input, await current()), 'replayed'); assert.deepEqual(replay.result, {id: run.id}); assert.deepEqual(replay.records, result.records); assert.deepEqual(await all(), after); assert.deepEqual(await store.readReceipt(receiptIdentity(input)), receipt);
      phase(`ask:${caseNumber}:replay`);
    };
    await ask(branch, profile);
    const maximum = await create(PROFILE, {name: 'Maximum', provider_key: 'max-key', policy_revision: 'max-v1', system_prompt: 'x'.repeat(8192), input_tokens: '32768', output_tokens: '8192', duration: '600000'});
    const secondConversation = await create(CONVERSATION, {title: 'Boundary conversation'}), secondBranch = await create(BRANCH, {parent: {id: secondConversation.id, version: '1'}, title: 'Boundary branch', profile: {id: maximum.id, version: '1'}});
    await ask(secondBranch, maximum); assert.equal(retained[0]!.run.data.reserved, '10240'); assert.equal(retained[1]!.run.data.reserved, '40960');
    const foreignProfile = await create(PROFILE, {name: 'Foreign', provider_key: 'foreign-key', policy_revision: 'foreign-v1', system_prompt: 'Foreign prompt'}, foreignIdentity),
      foreignConversation = await create(CONVERSATION, {title: 'Foreign'}, foreignIdentity), foreignBranch = await create(BRANCH, {parent: {id: foreignConversation.id, version: '1'}, title: 'Foreign', profile: {id: foreignProfile.id, version: '1'}}, foreignIdentity);
    for (const [ref, code] of [[{id: branch.id, version: '2'}, 'conflict'], [{id: conversation.id, version: '1'}, 'not_found'], [{id: foreignBranch.id, version: '1'}, 'not_found']] as const) {
      const input = envelope(OP, {branch: ref}), before = await all(), outcome = await invoker.invokeMutation(input, await current()); assert.ok('error' in outcome); assert.equal(outcome.error.code, code); assert.deepEqual(await all(), before); assert.equal(await store.readReceipt(receiptIdentity(input)), null);
    }
    const beforeForeign = await all(), foreignDenied = await foreignInvoker.invokeRetainedMutation(retained[0]!.input, foreignIdentity); assert.ok('error' in foreignDenied); assert.equal(foreignDenied.error.code, 'not_found'); assert.deepEqual(await all(), beforeForeign);
    phase('foreign-and-stale:complete');
    await identities.removeMembership(memberships[0]!.membership_id); now += 1000; const revoked = await all();
    for (const {input} of retained) { const outcome = await invoker.invokeRetainedMutation(input, identity); assert.ok('error' in outcome); assert.equal(outcome.error.code, 'forbidden'); assert.deepEqual(await all(), revoked); }
    const revokedFresh = envelope(OP, {branch: {id: branch.id, version: '1'}}), revokedOutcome = await invoker.invokeMutation(revokedFresh, identity);
    assert.ok('error' in revokedOutcome); assert.equal(revokedOutcome.error.code, 'forbidden'); assert.deepEqual(await all(), revoked); assert.equal(await store.readReceipt(receiptIdentity(revokedFresh)), null);
    await identities.reactivateMembership(memberships[0]!.membership_id, {is_owner: false, roles: []}); const stable = await all();
    for (const {input, run} of retained) { const replay = committed(await invoker.invokeRetainedMutation(input, await current()), 'replayed'); assert.deepEqual(replay.result, {id: run.id}); assert.deepEqual(await all(), stable); }
    phase('current-membership:complete');
    const withheld = async (input: MutationEnvelope) => { const before = await all(), replay = committed(await invoker.invokeMutation(input, await current()), 'replayed'); assert.equal(replay.result, null); assert.deepEqual(replay.records, []); assert.deepEqual(await all(), before); };
    const liveProfile = await store.load(PROFILE, profile.id); assert.ok(liveProfile);
    committed(await invoker.invokeMutation(envelope(`${PROFILE}.delete`, {record: {id: liveProfile.id, version: String(liveProfile.version)}}), await current())); await withheld(retained[0]!.input);
    committed(await invoker.invokeMutation(envelope(`${CONVERSATION}.delete`, {record: {id: secondConversation.id, version: '1'}}), await current())); await withheld(retained[1]!.input);
    for (const {input, run} of retained) { assert.deepEqual(await store.load(RUN, run.id), run); assert.ok(await store.readReceipt(receiptIdentity(input))); }
    phase('archived-target-and-ancestor:withheld');
    assert.deepEqual(await store.outboxPending(), []); assert.deepEqual(await foreign.outboxPending(), []);
    assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await captureIsCurrent(capture), true);
    assert.equal(hash(await readFile(source)), authoredHash); assert.equal((await readFile(source, 'utf8')).replace(SETUP, ''), originalText);
    assert.deepEqual(await Promise.all(paths.map(async path => hash(await readFile(path)))), originals.map(hash));
    for (const {path, bytes} of compilerSources) assert.deepEqual(await readFile(path), bytes);
    for (const [path, bytes] of compiledBytes) assert.deepEqual(await readFile(fileURLToPath(asm.moduleUrls[path]!)), bytes);
    phase('source-closure:current');
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
