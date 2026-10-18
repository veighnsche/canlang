/** Native bounded count source consumer. The temporary labelled members
 * CRUD setup is separate from the exact 454-byte Compiler CountSources fixture.
 * This qualifies count(branch.Turn)+1 and one new contained Turn, not full Chat.
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
import type { SingleFileCapture } from '../src/dev/source-capture.js';
import type { MutationOutcome } from '../src/worker/assembly.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const APP = 'CountSources', OP = `${APP}.append`;
const CONVERSATION = `${APP}.Conversation` as ModelName, BRANCH = `${APP}.Branch` as ModelName, TURN = `${APP}.Turn` as ModelName;
const ORIGINAL_SHA256 = '4a6ee93932c1d4695145eb3b099ed5be8302c1b1fc68c7928f5205fe352fc28b';
const SETUP = ' ## BEGIN TEST-AUTHORED SETUP: authenticated contained CRUD\n' +
  ' crud Conversation by=members fields=title\n' +
  ' crud Branch by=members fields=title\n' +
  ' crud Turn by=members fields=position\n' +
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

test('released bounded count uses its original Branch scope, empty parent witness and bigint +1 under real D1 authority',
 {timeout: 240000}, async () => {
  const directory = await createCheckoutScratch(root, 'native-count-turn-');
  let worker: Miniflare | undefined, capture: SingleFileCapture | undefined;
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
    const {readScenarioReceiptAssociation} = await nodeImport(producer('@canlang/state/invocation')) as typeof import('@canlang/state/invocation');
    const {hashInputs} = await nodeImport(producer('@canlang/state/invocation/replay')) as typeof import('@canlang/state/invocation/replay');
    const {uuidv7} = await nodeImport(producer('@canlang/state/testing/invocation/fixtures')) as typeof import('@canlang/state/testing/invocation/fixtures');
    const originalSource = join(root, 'compiler/tests/fixtures/native-count-turn.can');
    const source = join(directory, 'native-count-turn-with-labelled-setup.can');
    const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
    const paths = [originalSource, compiler, catalog], originals = await Promise.all(paths.map(path => readFile(path)));
    assert.equal(originals[0]!.length, 454); assert.equal(hash(originals[0]!), ORIGINAL_SHA256);
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
    assert.equal(verifyCompilerSources(capture, {complete: true, sources: artifact.sources}).ok, true);
    assert.equal(await captureIsCurrent(capture), true);
    const compilerSources = await Promise.all(artifact.sources.map(async value => {
      const path = resolve(capture!.root, value.path), bytes = await readFile(path); assert.equal(hash(bytes), value.sha256); return {path, bytes};
    }));
    const op = artifact.operations?.find(value => value.name === OP); assert.ok(op?.result?.disclosure); assert.equal(op.result.type, TURN);
    assert.equal(artifact.pages.length, 0);
    for (const model of [CONVERSATION, BRANCH, TURN]) assert.equal(artifact.operations?.find(value => value.name === `${model}.create`)?.kind, 'create');
    assert.equal(op.inputs.fields.length, 1); const parameter = op.inputs.fields[0]!;
    assert.equal(parameter.name, 'branch'); assert.equal(parameter.required, true); assert.equal(parameter.default, undefined);
    assert.deepEqual(parameter.field, {kind: 'ref', model: BRANCH, requireVersion: true});
    assert.equal(artifact.models!.find(value => value.name === TURN)!.parent, BRANCH);
    assert.equal(artifact.models!.find(value => value.name === BRANCH)!.parent, CONVERSATION);
    const plan = op.result.disclosure; assert.equal(plan.queries?.length, 1); const queryPlan = plan.queries![0]!;
    assert.equal(plan.source.sha256, authoredHash); assert.equal(resolve(capture.root, plan.source.path), source);
    assert.deepEqual(queryPlan.source, plan.source); assert.equal(queryPlan.model, TURN);
    assert.deepEqual(queryPlan.parent, {source: plan.source, model: BRANCH, origin: {kind: 'admitted-reference', parameter: 'branch'}});
    assert.deepEqual(queryPlan.order, []); assert.equal(queryPlan.limit, null); assert.equal(queryPlan.archived, 'exclude');
    assert.deepEqual(queryPlan.dependencies, []); assert.ok(plan.returns.length > 0);
    for (const returned of plan.returns) {
      assert.equal(returned.projection, undefined); assert.deepEqual(returned.dependencies, []);
      assert.deepEqual(returned.influences.map(value => value.kind), ['query-existence', 'query-cardinality', 'query-membership', 'query-order']);
      assert.ok(returned.influences.every(value => value.queryId === queryPlan.id));
    }
    const asm = await assembleModules({artifact, sourcePath: source}, {workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js'),
      uiUrl: producer('@canlang/ui')});
    const loaded = await loadCanonicalDescriptors(asm, artifact);
    assert.equal(loaded.valueSchema, undefined, 'built-in fields use their genuine codecs without inventing a rich Values schema');
    assert.deepEqual(object(object(loaded.registry.get(OP)).descriptor).result, op.result);
    const callable = artifact.callables.find(value => value.id === OP); assert.ok(callable);
    const namespace = object(await importVerifiedAssemblyModule(asm, callable.module, artifact)); assert.equal(namespace[callable.export], OP);
    assert.equal(object(object(object(namespace.appDefinition).operations)[OP]).by, 'members');
    const generated = artifact.modules.find(value => value.path === callable.module)!;
    assert.equal((generated.js.match(/\bcountQuery\(/g) ?? []).length, 1);
    assert.equal((generated.js.match(/\bexecuteScenarioReceiptQuery\(/g) ?? []).length, 1);
    assert.match(generated.js, /int64\(await [\s\S]*countQuery\([\s\S]*\+ 1n\)/);
    assert.match(generated.js, /await bindScenarioReceiptModelResult\(c,/);
    assert.doesNotMatch(generated.js, /c\.canApp|canApp\.countQuery|\bcount\(/);
    const compiledBytes = new Map(await Promise.all(Object.entries(asm.moduleUrls).map(async ([path, url]) => [path, await readFile(fileURLToPath(url))] as const)));
    worker = new Miniflare({compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: {IDENTITY: 'count-turn-identity', A: 'count-turn-owner-a', B: 'count-turn-owner-b'}, d1Persist: join(directory, 'd1')});
    const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
    const a = await worker.getD1Database('A') as unknown as D1Database, b = await worker.getD1Database('B') as unknown as D1Database;
    await ensureIdentitySchema(identityDb); await ensureSchema(a); await ensureSchema(b);
    let now = Date.now(), sequence = 0; const clock = {nowMs: () => now};
    const identities = createD1IdentityStore(identityDb, {clock});
    const teams = await Promise.all([identities.createTeam({timezone: 'UTC'}), identities.createTeam({timezone: 'UTC'})]);
    const users = await Promise.all(['reader', 'foreign'].map(name => identities.createUser({email: `${name}@count-turn.example.test`, password_hash: 'unused', email_verified: true})));
    const memberships = await Promise.all(users.map((user, index) => identities.createMembership({user_id: user.user_id, team_id: teams[index]!.team_id, is_owner: false, roles: []})));
    const grants = await Promise.all(users.map((user, index) => issueMcpGrant(identities, {user_id: user.user_id, team_id: teams[index]!.team_id, client_id: 'count-turn'}, {clock})));
    const current = (index = 0) => resolveIdentity(identities, {mcp_grant_token: grants[index]!.token}, {clock});
    const identity = await current(), foreignIdentity = await current(1);
    const boundary = await createTeamOwnerStorageBoundary({artifact, asm, app: APP, identities,
      router: createD1OwnerRouter({resolveBinding: scope => scope.app === APP && teams.some(team => team.team_id === scope.owner)
        ? {...scope, db: scope.owner === teams[0]!.team_id ? a : b, initializeFresh: true} : null})});
    const store = await boundary.forIdentity(identity), foreign = await boundary.forIdentity(foreignIdentity);
    const invoker = buildInvoker(artifact, asm, store, {appId: APP, memberships: identities, source: 'http', now: clock.nowMs, ownerStorage: boundary});
    const all = async () => ({identity: await snapshot(identityDb), owner: await snapshot(a), foreign: await snapshot(b)});
    const envelope = (operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope => ({operation, operation_id: uuidv7(now, ++sequence), inputs});
    const receiptIdentity = (input: MutationEnvelope, actor: ResolvedIdentity = identity): ReceiptIdentity => ({app: APP,
      owner: actor.team!.team_id, principal: actor.actor!.user_id, operation: input.operation as OperationName, operationId: input.operation_id as OperationId});
    const create = async (model: ModelName, inputs: MutationEnvelope['inputs'], actor: ResolvedIdentity = identity): Promise<StoredRow> => {
      const input = envelope(`${model}.create`, inputs), selected = await boundary.forIdentity(actor), revision = await selected.readRevision();
      const result = committed(await invoker.invokeMutation(input, actor)); assert.equal(await selected.readRevision(), revision + 1);
      const records = result.records as readonly ProjectedRecord[]; assert.equal(records.length, 1);
      const row = await selected.load(model, records[0]!.id); assert.ok(row); assert.equal(row.version, 1); assert.equal(row.createdBy, actor.actor!.user_id);
      const receipt = await selected.readReceipt(receiptIdentity(input, actor)); assert.ok(receipt); assert.equal(receipt.outcome.status, 'committed');
      assert.equal(receipt.inputHash, await hashInputs(input.inputs)); assert.equal(receipt.committedRevision, revision + 1);
      const history = await selected.historyFor(model, row.id); assert.equal(history.length, 1); assert.equal(history[0]!.operation, input.operation);
      assert.equal(history[0]!.operationId, input.operation_id); assert.equal(history[0]!.before, null); assert.deepEqual(history[0]!.after, row.data); return row;
    };
    // Real source-authored authenticated CRUD is the only row/setup issuer.
    const conversation = await create(CONVERSATION, {title: 'Selected conversation'});
    const makeBranch = (title: string) => create(BRANCH, {parent: {id: conversation.id, version: String(conversation.version)}, title});
    const selectedBranch = await makeBranch('Selected branch'), otherBranch = await makeBranch('Excluded branch'), emptyBranch = await makeBranch('Empty branch');
    const seed = (branch: StoredRow, position: string) => create(TURN, {parent: {id: branch.id, version: String(branch.version)}, position});
    const first = await seed(selectedBranch, '7'), second = await seed(selectedBranch, '42'), excluded = await seed(otherBranch, '100');
    const foreignConversation = await create(CONVERSATION, {title: 'Foreign conversation'}, foreignIdentity);
    const foreignBranch = await create(BRANCH, {parent: {id: foreignConversation.id, version: '1'}, title: 'Foreign branch'}, foreignIdentity);
    const foreignTurn = await create(TURN, {parent: {id: foreignBranch.id, version: '1'}, position: '50'}, foreignIdentity);
    for (const branch of [selectedBranch, otherBranch, emptyBranch]) assert.deepEqual(branch.parent, {model: CONVERSATION, id: conversation.id});
    assert.equal(conversation.parent, null); assert.deepEqual(excluded.parent, {model: BRANCH, id: otherBranch.id});
    const selectedRows = [first, second]; const retained: Array<{input: MutationEnvelope; id: StoredRow['id']; position: string}> = [];
    for (const [branch, expectedRows] of [[selectedBranch, selectedRows], [emptyBranch, []], [selectedBranch, selectedRows]] as const) {
      const expected = [...expectedRows], expectedPosition = String(BigInt(expected.length) + 1n);
      const input = envelope(OP, {branch: {id: branch.id, version: String(branch.version)}}), before = await all(), revision = await store.readRevision();
      const result = committed(await invoker.invokeMutation(input, await current())), wire = object(result.result);
      assert.deepEqual(Object.keys(wire), ['id']); assert.equal(typeof wire.id, 'string'); const id = wire.id as StoredRow['id'];
      const row = await store.load(TURN, id); assert.ok(row); retained.push({input, id, position: expectedPosition});
      assert.deepEqual(row.parent, {model: BRANCH, id: branch.id}); assert.deepEqual(row.data, {position: expectedPosition});
      const countPlusOne = decodeValue('int', row.data.position); assert.equal(typeof countPlusOne, 'bigint'); assert.equal(countPlusOne, BigInt(expected.length) + 1n);
      assert.equal(row.version, 1); assert.equal(row.createdBy, users[0]!.user_id); assert.equal(row.created, now);
      assert.deepEqual(await store.load(BRANCH, branch.id), branch); assert.deepEqual(await store.load(CONVERSATION, conversation.id), conversation);
      assert.deepEqual(await store.load(TURN, excluded.id), excluded); assert.deepEqual(await foreign.load(TURN, foreignTurn.id), foreignTurn);
      const receipt = await store.readReceipt(receiptIdentity(input)); assert.ok(receipt); assert.equal(receipt.inputHash, await hashInputs(input.inputs));
      assert.equal(receipt.committedRevision, revision + 1); assert.equal(await store.readRevision(), revision + 1); assert.deepEqual(receipt.resolvedDefaults, {});
      assert.equal(receipt.outcome.status, 'committed'); if (receipt.outcome.status !== 'committed') throw new Error('append must commit');
      assert.deepEqual(receipt.outcome.result, {id}); assert.deepEqual(receipt.outcome.recordVersions, [{model: TURN, id, version: 1}]);
      const association = readScenarioReceiptAssociation(receipt); assert.ok(association); assert.equal(association.resultType, TURN); assert.deepEqual(association.plan, plan);
      assert.equal(association.changed.length, 1); assert.equal(association.changed[0]!.model, TURN); assert.deepEqual(association.changed[0]!.row, row);
      assert.deepEqual(association.observations, []); assert.equal(association.calls?.length ?? 0, 0); assert.equal(association.queries?.length, 1);
      const census = association.queries![0]!; assert.equal(census.queryId, queryPlan.id); assert.equal(census.revision, revision);
      assert.deepEqual(census.parent, {model: BRANCH, row: branch, secretFields: []}, 'empty queries retain the genuine admitted Branch witness');
      assert.equal(census.candidates.length, expected.length); assert.deepEqual(new Set(census.candidates.map(value => value.row.id)), new Set(expected.map(value => value.id)));
      for (const candidate of census.candidates) {
        assert.deepEqual(candidate.row, expected.find(value => value.id === candidate.row.id)); assert.equal(candidate.matched, true);
        assert.deepEqual(candidate.row.parent, {model: BRANCH, id: branch.id}); assert.deepEqual(candidate.secretFields, []); assert.deepEqual(candidate.dependencies, []);
        assert.deepEqual(candidate.record.data, candidate.row.data); assert.deepEqual(candidate.record.parent, candidate.row.parent);
      }
      assert.deepEqual(census.selectedIndices, census.candidates.map((_, index) => index), 'original candidate order is retained, without adding an authored order');
      const projected = result.records as readonly ProjectedRecord[]; assert.equal(projected.length, 1); assert.equal(projected[0]!.id, id);
      assert.deepEqual(projected[0]!.data, row.data); assert.deepEqual(projected[0]!.parent, row.parent);
      const history = await store.historyFor(TURN, id); assert.equal(history.length, 1); const entry = history[0]!;
      assert.equal(entry.model, TURN); assert.equal(entry.recordId, id); assert.equal(entry.version, 1); assert.equal(entry.actor, users[0]!.user_id);
      assert.equal(entry.operation, OP); assert.equal(entry.operationId, input.operation_id); assert.equal(entry.change, 'create');
      assert.equal(entry.before, null); assert.deepEqual(entry.after, row.data); assert.equal(entry.at, now);
      assert.deepEqual(entry.auditProjection, {created: now, createdBy: users[0]!.user_id, secretFields: []});
      const after = await all(); assert.deepEqual(after.identity, before.identity); assert.deepEqual(after.foreign, before.foreign);
      assert.equal(after.owner.records!.length, before.owner.records!.length + 1); assert.equal(after.owner.receipts!.length, before.owner.receipts!.length + 1);
      assert.equal(after.owner.history!.length, before.owner.history!.length + 1); assert.equal(after.owner.fence_log!.length, before.owner.fence_log!.length + 1);
      assert.deepEqual(after.owner.records!.filter(value => value.id !== id), before.owner.records);
      assert.deepEqual(after.owner.receipts!.filter(value => value.operation_id !== input.operation_id), before.owner.receipts);
      assert.deepEqual(after.owner.history!.filter(value => value.operation_id !== input.operation_id), before.owner.history);
      assert.deepEqual(after.owner.fence_log!.filter(value => value.revision !== revision + 1), before.owner.fence_log);
      assert.deepEqual(after.owner.fence_log!.filter(value => value.revision === revision + 1), [{at: now, operation: OP, revision: revision + 1}]);
      historySequence(before.owner, after.owner);
      for (const table of Object.keys(before.owner)) if (!['records', 'history', 'receipts', 'fence', 'fence_log', 'sqlite_sequence'].includes(table))
        assert.deepEqual(after.owner[table], before.owner[table], table);
      const replay = committed(await invoker.invokeRetainedMutation(input, await current()), 'replayed');
      assert.deepEqual(replay.result, {id}); assert.deepEqual(replay.records, result.records); assert.deepEqual(await all(), after);
      assert.deepEqual(await store.readReceipt(receiptIdentity(input)), receipt, 'recovery keeps the original ordered census and parent witness');
      if (branch === selectedBranch) selectedRows.push(row);
    }
    // All references below are inputs to the real admission boundary; none
    // issues or promotes a row, descriptor, source context or grant.
    for (const [label, ref, code] of [
      ['stale original Branch', {id: selectedBranch.id, version: '2'}, 'conflict'],
      ['wrong owning model', {id: conversation.id, version: '1'}, 'not_found'],
      ['foreign physical Branch', {id: foreignBranch.id, version: '1'}, 'not_found'],
    ] as const) {
      const input = envelope(OP, {branch: ref}), before = await all(); const denied = await invoker.invokeMutation(input, await current());
      assert.ok('error' in denied, `${label}: ${JSON.stringify(denied)}`); assert.equal(denied.error.code, code); assert.deepEqual(await all(), before, label);
      assert.equal(await store.readReceipt(receiptIdentity(input)), null);
    }
    const foreignBefore = await all(), foreignDenied = await invoker.invokeRetainedMutation(retained[0]!.input, foreignIdentity);
    assert.ok('error' in foreignDenied); assert.equal(foreignDenied.error.code, 'not_found'); assert.deepEqual(await all(), foreignBefore);
    await identities.removeMembership(memberships[0]!.membership_id); now += 1000;
    const revoked = await all();
    for (const {input} of retained) {
      const denied = await invoker.invokeRetainedMutation(input, identity); assert.ok('error' in denied); assert.equal(denied.error.code, 'forbidden');
      assert.deepEqual(await all(), revoked, 'current member/ancestor authority refuses both populated and empty retained queries');
    }
    const fresh = envelope(OP, {branch: {id: emptyBranch.id, version: '1'}}), refused = await invoker.invokeMutation(fresh, identity);
    assert.ok('error' in refused); assert.equal(refused.error.code, 'forbidden'); const afterRefusal = await all();
    assert.deepEqual(afterRefusal, revoked, 'current members admission fails before execution or a rejection receipt');
    assert.equal(await store.readReceipt(receiptIdentity(fresh)), null);
    const refusalReplay = await invoker.invokeMutation(fresh, identity); assert.ok('error' in refusalReplay); assert.deepEqual(await all(), afterRefusal);
    await identities.reactivateMembership(memberships[0]!.membership_id, {is_owner: false, roles: []});
    const restored = await current(), stable = await all();
    for (const {input, id, position} of retained) {
      const replay = committed(await invoker.invokeRetainedMutation(input, restored), 'replayed'); assert.deepEqual(replay.result, {id});
      assert.equal((await store.load(TURN, id))!.data.position, position); assert.deepEqual(await all(), stable);
    }
    assert.deepEqual(await store.load(TURN, first.id), first); assert.deepEqual(await store.load(TURN, second.id), second);
    assert.deepEqual(await store.load(TURN, excluded.id), excluded); assert.deepEqual(await foreign.load(TURN, foreignTurn.id), foreignTurn);
    assert.deepEqual(await store.outboxPending(), []); assert.deepEqual(await foreign.outboxPending(), []);
    for (const resources of [stable.owner, stable.foreign]) for (const table of ['outbox', 'schedules']) assert.deepEqual(resources[table], []);
    assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await captureIsCurrent(capture), true);
    assert.equal(hash(await readFile(source)), authoredHash); assert.equal((await readFile(source, 'utf8')).replace(SETUP, ''), originalText);
    assert.deepEqual(await Promise.all(paths.map(async path => hash(await readFile(path)))), originals.map(hash));
    for (const {path, bytes} of compilerSources) assert.deepEqual(await readFile(path), bytes);
    for (const [path, bytes] of compiledBytes) assert.deepEqual(await readFile(fileURLToPath(asm.moduleUrls[path]!)), bytes);
  } finally {
    try { await worker?.dispose(); } finally {
      try {
        if (capture !== undefined) {
          const {captureIsCurrent} = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
          assert.equal(await captureIsCurrent(capture), true, 'source/output closure stays current through awaited D1/workerd cleanup');
        }
      } finally { await rm(directory, {recursive: true, force: true}); }
    }
  }
 });
