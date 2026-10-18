/** Exact original ancestor-count source: unscoped Run census, lazy parent
 * equality and unfinished short-circuit before one Run creation and return.
 * Only the visibly labelled three-line authenticated CRUD setup is added.
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
import type { CompileArtifact, ModelName, MutationEnvelope, OperationName,
  OperationId, ProjectedRecord, ReceiptIdentity, ResolvedIdentity, StoredRow } from '@canlang/contracts';
import type { SingleFileCapture } from '../src/dev/source-capture.js';
import type { MutationOutcome } from '../src/worker/assembly.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const APP = 'AncestorCount', OP = `${APP}.ask`;
const CONVERSATION = `${APP}.Conversation` as ModelName, BRANCH = `${APP}.Branch` as ModelName, RUN = `${APP}.Run` as ModelName;
const ORIGINAL_SHA256 = '85dd7a5380cafdbb2b4c95f306bf29df9553e6632509c97a63fd5ae16f79909e';
const SETUP = ' ## BEGIN TEST-AUTHORED SETUP: authenticated contained CRUD\n' +
  ' crud Conversation by=members fields=title\n' +
  ' crud Branch by=members fields=title\n' +
  ' crud Run by=members fields=unfinished\n' +
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

test('original unscoped ancestor count keeps lazy query observations, threshold refusal and genuine Run return',
 {timeout: 480000}, async () => {
  const directory = await createCheckoutScratch(root, 'native-ancestor-count-');
  let worker: Miniflare | undefined, capture: SingleFileCapture | undefined;
  const began = performance.now(), phase = (name: string) => console.info(`ancestor native ${name}: ${Math.round(performance.now() - began)}ms`);
  try {
    // Private assembly, row, query and policy producers share the authentic
    // installed default Node loader; no Vitest producer can reconstruct them.
    const {assembleModules, importVerifiedAssemblyModule} = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
    const {buildInvoker, createTeamOwnerStorageBoundary} = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
    const {loadCanonicalDescriptors} = await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
    const {prepareLocalPreviewCapture} = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
    const {captureSingleFileSource, captureIsCurrent, verifyCompilerSources} = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
    const {distribution} = await nodeImport(producer('@canlang/values/distribution')) as typeof import('@canlang/values/distribution');
    const {createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity} = await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
    const {ensureSchema} = await nodeImport(producer('@canlang/state/storage/d1')) as typeof import('@canlang/state/storage/d1');
    const {createD1OwnerRouter} = await nodeImport(producer('@canlang/state/storage/owner-router')) as typeof import('@canlang/state/storage/owner-router');
    const {readScenarioReceiptAssociation} = await nodeImport(producer('@canlang/state/invocation')) as typeof import('@canlang/state/invocation');
    const {hashInputs} = await nodeImport(producer('@canlang/state/invocation/replay')) as typeof import('@canlang/state/invocation/replay');
    const {uuidv7} = await nodeImport(producer('@canlang/state/testing/invocation/fixtures')) as typeof import('@canlang/state/testing/invocation/fixtures');
    const originalSource = join(root, 'compiler/tests/fixtures/native-ancestor-count.can');
    const source = join(directory, 'native-ancestor-count-with-labelled-setup.can');
    const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
    const paths = [originalSource, compiler, catalog], originals = await Promise.all(paths.map(path => readFile(path)));
    assert.equal(originals[0]!.length, 513); assert.equal(hash(originals[0]!), ORIGINAL_SHA256);
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
    const op = artifact.operations?.find(value => value.name === OP); assert.ok(op?.result?.disclosure); assert.equal(op.result.type, RUN);
    assert.equal(artifact.pages.length, 0);
    for (const model of [CONVERSATION, BRANCH, RUN]) assert.equal(artifact.operations?.find(value => value.name === `${model}.create`)?.kind, 'create');
    assert.equal(op.inputs.fields.length, 1); const parameter = op.inputs.fields[0]!;
    assert.equal(parameter.name, 'branch'); assert.equal(parameter.required, true); assert.equal(parameter.default, undefined);
    assert.deepEqual(parameter.field, {kind: 'ref', model: BRANCH, requireVersion: true});
    assert.equal(artifact.models!.find(value => value.name === RUN)!.parent, BRANCH);
    assert.equal(artifact.models!.find(value => value.name === BRANCH)!.parent, CONVERSATION);
    const plan = op.result.disclosure; assert.equal(plan.queries?.length, 1); const queryPlan = plan.queries![0]!;
    assert.equal(plan.source.sha256, authoredHash); assert.equal(resolve(capture.root, plan.source.path), source);
    assert.deepEqual(queryPlan.source, plan.source); assert.equal(queryPlan.model, RUN);
    assert.equal(queryPlan.parent, undefined, 'original unscoped Run domain never becomes branch-scoped');
    assert.deepEqual(queryPlan.order, []); assert.equal(queryPlan.limit, null); assert.equal(queryPlan.archived, 'exclude');
    assert.deepEqual(queryPlan.dependencies.map(value => [value.field, value.type, value.role]), [['parent', BRANCH, 'control'], ['unfinished', 'bool', 'control']]);
    for (const dependency of queryPlan.dependencies) assert.deepEqual(dependency.source, plan.source);
    assert.ok(plan.returns.length > 0);
    const [candidateParent, suppliedParent] = plan.returns[0]!.dependencies; assert.ok(candidateParent); assert.ok(suppliedParent);
    assert.notEqual(candidateParent.id, suppliedParent.id);
    for (const returned of plan.returns) {
      assert.equal(returned.projection, undefined); assert.deepEqual(returned.source, plan.source);
      assert.equal(returned.dependencies.length, 2);
      for (const dependency of returned.dependencies) {
        assert.equal(dependency.model, BRANCH); assert.equal(dependency.field, 'parent'); assert.equal(dependency.type, CONVERSATION);
        assert.equal(dependency.queryId, queryPlan.id); assert.equal(dependency.role, 'control'); assert.deepEqual(dependency.source, plan.source);
      }
      assert.deepEqual(returned.influences.map(value => value.kind), ['query-existence', 'query-cardinality', 'query-membership', 'query-order']);
      assert.ok(returned.influences.every(value => value.queryId === queryPlan.id));
    }
    const asm = await assembleModules({artifact, sourcePath: source}, {workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js'),
      uiUrl: producer('@canlang/ui')});
    const loaded = await loadCanonicalDescriptors(asm, artifact);
    assert.deepEqual(object(object(loaded.registry.get(OP)).descriptor).result, op.result);
    const callable = artifact.callables.find(value => value.id === OP); assert.ok(callable);
    const namespace = object(await importVerifiedAssemblyModule(asm, callable.module, artifact)); assert.equal(namespace[callable.export], OP);
    assert.equal(object(object(object(namespace.appDefinition).operations)[OP]).by, 'members');
    const generated = artifact.modules.find(value => value.path === callable.module)!;
    assert.equal((generated.js.match(/\bcountQuery\(/g) ?? []).length, 1);
    assert.equal((generated.js.match(/\bexecuteScenarioReceiptQuery\(/g) ?? []).length, 1);
    assert.match(generated.js, /countQuery\([\s\S]*< 10n/);
    assert.match(generated.js, /await bindScenarioReceiptModelResult\(c,/);
    assert.doesNotMatch(generated.js, /c\.canApp|canApp\.countQuery|\bcount\(/);
    let handler: unknown = (namespace.canApp as () => unknown)();
    for (const member of callable.member) handler = object(handler)[member];
    assert.equal(typeof handler, 'function'); const body = (handler as Function).toString();
    for (const pattern of [/\bcountQuery\(/g, /\bexecuteScenarioReceiptQuery\(/g, /\bawait readScenarioReceiptQueryParent\(/g, /\bawait create\(/g])
      assert.equal((body.match(pattern) ?? []).length, 1);
    assert.equal((body.match(/\["parent"\]/g) ?? []).length, 3); assert.equal((body.match(/\["unfinished"\]/g) ?? []).length, 1);
    const bridge = /await readScenarioReceiptQueryParent\(c,([$\w]+),"([^"\\]+)"\)/.exec(body); assert.ok(bridge);
    assert.equal(bridge[2], candidateParent.id);
    const same = body.indexOf('same('), firstMarker = body.indexOf(`"parent",${JSON.stringify(candidateParent.id)}`),
      secondMarker = body.indexOf(`"parent",${JSON.stringify(suppliedParent.id)}`), and = body.indexOf('&&', same), unfinished = body.indexOf('["unfinished"]');
    assert.ok(same >= 0 && same < firstMarker && firstMarker < secondMarker && secondMarker < and && and < unfinished);
    const created = /const ([$\w]+) = await create\(c,"AncestorCount\.Run",/.exec(body); assert.ok(created);
    assert.ok(body.indexOf('countQuery(') < created.index); assert.ok(body.includes(`const $receiptValue=${created[1]};`));

    const compiledBytes = new Map(await Promise.all(Object.entries(asm.moduleUrls).map(async ([path, url]) => [path, await readFile(fileURLToPath(url))] as const)));
    worker = new Miniflare({compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: {IDENTITY: 'ancestor-count-identity', A: 'ancestor-count-owner-a', B: 'ancestor-count-owner-b'}, d1Persist: join(directory, 'd1')});
    const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
    const a = await worker.getD1Database('A') as unknown as D1Database, b = await worker.getD1Database('B') as unknown as D1Database;
    await ensureIdentitySchema(identityDb); await ensureSchema(a); await ensureSchema(b);
    let now = Date.now(), sequence = 0; const clock = {nowMs: () => now};
    const identities = createD1IdentityStore(identityDb, {clock});
    const teams = await Promise.all([identities.createTeam({timezone: 'UTC'}), identities.createTeam({timezone: 'UTC'})]);
    const users = await Promise.all(['reader', 'foreign'].map(name => identities.createUser({email: `${name}@ancestor-count.example.test`, password_hash: 'unused', email_verified: true})));
    const memberships = await Promise.all(users.map((user, index) => identities.createMembership({user_id: user.user_id, team_id: teams[index]!.team_id, is_owner: false, roles: []})));
    const grants = await Promise.all(users.map((user, index) => issueMcpGrant(identities, {user_id: user.user_id, team_id: teams[index]!.team_id, client_id: 'ancestor-count'}, {clock})));
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
    // The sole setup issuer is authenticated source-authored generated CRUD.
    const conversation = await create(CONVERSATION, {title: 'Selected conversation'}), otherConversation = await create(CONVERSATION, {title: 'Excluded conversation'}),
      emptyConversation = await create(CONVERSATION, {title: 'Initially empty conversation'});
    const branch = (parent: StoredRow, title: string) => create(BRANCH, {parent: {id: parent.id, version: String(parent.version)}, title});
    const selectedBranch = await branch(conversation, 'Selected'), siblingBranch = await branch(conversation, 'Same conversation sibling'),
      otherBranch = await branch(otherConversation, 'Different conversation'), emptyBranch = await branch(emptyConversation, 'Initially empty');
    const rows: StoredRow[] = [], retained: Array<{input: MutationEnvelope; row: StoredRow}> = [];
    const byId = new Map([selectedBranch, siblingBranch, otherBranch, emptyBranch].map(value => [value.id, value]));
    const ask = async (parent: StoredRow, expectedMatches: number) => {
      const expected = [...rows], input = envelope(OP, {branch: {id: parent.id, version: String(parent.version)}}), before = await all(), revision = await store.readRevision();
      const result = committed(await invoker.invokeMutation(input, await current())), wire = object(result.result);
      assert.deepEqual(Object.keys(wire), ['id']); assert.equal(typeof wire.id, 'string');
      const row = await store.load(RUN, wire.id as StoredRow['id']); assert.ok(row); assert.deepEqual(row.data, {unfinished: true});
      assert.deepEqual(row.parent, {model: BRANCH, id: parent.id}); assert.equal(row.version, 1); assert.equal(row.created, now); assert.equal(row.createdBy, users[0]!.user_id);
      retained.push({input, row}); rows.push(row);
      const receipt = await store.readReceipt(receiptIdentity(input)); assert.ok(receipt); assert.equal(receipt.inputHash, await hashInputs(input.inputs));
      assert.equal(receipt.committedRevision, revision + 1); assert.equal(await store.readRevision(), revision + 1); assert.deepEqual(receipt.resolvedDefaults, {});
      assert.equal(receipt.outcome.status, 'committed'); if (receipt.outcome.status !== 'committed') throw new Error('ask must commit');
      assert.deepEqual(receipt.outcome.result, {id: row.id}); assert.deepEqual(receipt.outcome.recordVersions, [{model: RUN, id: row.id, version: 1}]);
      const association = readScenarioReceiptAssociation(receipt); assert.ok(association); assert.deepEqual(association.plan, plan); assert.equal(association.resultType, RUN);
      assert.equal(association.changed.length, 1); assert.equal(association.changed[0]!.model, RUN); assert.deepEqual(association.changed[0]!.row, row);
      assert.equal(association.queries?.length, 1); const census = association.queries![0]!;
      assert.equal(census.queryId, queryPlan.id); assert.equal(census.revision, revision); assert.equal(census.parent, undefined);
      assert.equal(census.candidates.length, expected.length); assert.deepEqual(new Set(census.candidates.map(value => value.row.id)), new Set(expected.map(value => value.id)));
      const matched: number[] = [];
      for (const [index, candidate] of census.candidates.entries()) {
        const original = expected.find(value => value.id === candidate.row.id); assert.ok(original); assert.deepEqual(candidate.row, original);
        assert.deepEqual(candidate.record.data, original.data); assert.deepEqual(candidate.record.parent, original.parent); assert.deepEqual(candidate.secretFields, []);
        const candidateBranch = byId.get(original.parent!.id); assert.ok(candidateBranch);
        const sameConversation = candidateBranch.parent!.id === parent.parent!.id;
        assert.equal(candidate.matched, sameConversation && original.data.unfinished === true);
        if (candidate.matched) matched.push(index);
        assert.deepEqual(new Set(candidate.dependencies), new Set([queryPlan.dependencies[0]!.id, candidateParent.id, suppliedParent.id,
          ...(sameConversation ? [queryPlan.dependencies[1]!.id] : [])]), 'unfinished RHS is observed only after equal original ancestors');
      }
      assert.equal(matched.length, expectedMatches); assert.deepEqual(census.selectedIndices, matched);
      // Ordinary Branch.parent dependencies are distinct and attributed per
      // actual candidate, even when several Runs have the same Branch parent.
      assert.equal(association.observations.length, expected.length * 2);
      const candidateObservations = association.observations.filter(value => value.dependencyId === candidateParent.id),
        suppliedObservations = association.observations.filter(value => value.dependencyId === suppliedParent.id);
      assert.equal(candidateObservations.length, expected.length); assert.equal(suppliedObservations.length, expected.length);
      for (const [index, candidate] of census.candidates.entries()) {
        assert.equal(candidateObservations[index]!.model, BRANCH); assert.deepEqual(candidateObservations[index]!.row, byId.get(candidate.row.parent!.id));
        assert.deepEqual(candidateObservations[index]!.secretFields, []); assert.equal(suppliedObservations[index]!.model, BRANCH);
        assert.deepEqual(suppliedObservations[index]!.row, parent); assert.deepEqual(suppliedObservations[index]!.secretFields, []);
      }
      const projected = result.records as readonly ProjectedRecord[]; assert.equal(projected.length, 1);
      assert.equal(projected[0]!.id, row.id); assert.deepEqual(projected[0]!.data, row.data); assert.deepEqual(projected[0]!.parent, row.parent);
      const history = await store.historyFor(RUN, row.id); assert.equal(history.length, 1); const entry = history[0]!;
      assert.equal(entry.operation, OP); assert.equal(entry.operationId, input.operation_id); assert.equal(entry.model, RUN); assert.equal(entry.recordId, row.id);
      assert.equal(entry.change, 'create'); assert.equal(entry.version, 1); assert.equal(entry.actor, users[0]!.user_id); assert.equal(entry.before, null); assert.deepEqual(entry.after, row.data);
      const after = await all(); assert.deepEqual(after.identity, before.identity); assert.deepEqual(after.foreign, before.foreign);
      assert.equal(after.owner.records!.length, before.owner.records!.length + 1); assert.equal(after.owner.history!.length, before.owner.history!.length + 1);
      assert.equal(after.owner.receipts!.length, before.owner.receipts!.length + 1); assert.deepEqual(after.owner.fence, [{id: 1, revision: revision + 1}]);
      assert.deepEqual(after.owner.records!.filter(value => value.id !== row.id), before.owner.records);
      assert.deepEqual(after.owner.history!.filter(value => value.operation_id !== input.operation_id), before.owner.history);
      assert.deepEqual(after.owner.receipts!.filter(value => value.operation_id !== input.operation_id), before.owner.receipts);
      assert.deepEqual(after.owner.fence_log!.filter(value => value.revision !== revision + 1), before.owner.fence_log);
      assert.deepEqual(after.owner.fence_log!.filter(value => value.revision === revision + 1), [{at: now, operation: OP, revision: revision + 1}]); historySequence(before.owner, after.owner);
      for (const table of Object.keys(before.owner)) if (!['records', 'history', 'receipts', 'fence', 'fence_log', 'sqlite_sequence'].includes(table)) assert.deepEqual(after.owner[table], before.owner[table], table);
      const replay = committed(await invoker.invokeRetainedMutation(input, await current()), 'replayed');
      assert.deepEqual(replay.result, {id: row.id}); assert.deepEqual(replay.records, result.records); assert.deepEqual(await all(), after);
      assert.deepEqual(await store.readReceipt(receiptIdentity(input)), receipt); return row;
    };
    await ask(emptyBranch, 0); phase('empty query, receipt and replay'); // neither lazy operand is observed
    const seed = async (parent: StoredRow, unfinished: boolean) => {
      const row = await create(RUN, {parent: {id: parent.id, version: String(parent.version)}, unfinished}); rows.push(row); return row;
    };
    for (let index = 0; index < 8; index++) await seed(selectedBranch, true);
    await seed(siblingBranch, true); const finished = await seed(selectedBranch, false);
    const excluded = [await seed(otherBranch, true), await seed(otherBranch, true)];
    const foreignConversation = await create(CONVERSATION, {title: 'Foreign'}, foreignIdentity),
      foreignBranch = await create(BRANCH, {parent: {id: foreignConversation.id, version: '1'}, title: 'Foreign'}, foreignIdentity),
      foreignRun = await create(RUN, {parent: {id: foreignBranch.id, version: '1'}, unfinished: true}, foreignIdentity);
    phase('authentic setup complete');
    await ask(selectedBranch, 9); phase('nine to ten, census, receipt and replay'); // includes the sibling Branch
    const thresholdInput = envelope(OP, {branch: {id: selectedBranch.id, version: '1'}}), beforeThreshold = await all(), thresholdRevision = await store.readRevision();
    const rejected = await invoker.invokeMutation(thresholdInput, await current()); assert.ok('error' in rejected); assert.equal(rejected.error.code, 'rule_failed');
    const rejection = await store.readReceipt(receiptIdentity(thresholdInput)); assert.ok(rejection); assert.equal(rejection.inputHash, await hashInputs(thresholdInput.inputs));
    assert.deepEqual(rejection.outcome, {status: 'rejected', code: 'rule_failed', message: rejected.error.message}); assert.equal(rejection.committedRevision, thresholdRevision + 1);
    phase('threshold rejected receipt');
    const afterThreshold = await all();
    for (const table of Object.keys(beforeThreshold.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) assert.deepEqual(afterThreshold.owner[table], beforeThreshold.owner[table], table);
    assert.deepEqual(afterThreshold.identity, beforeThreshold.identity); assert.deepEqual(afterThreshold.foreign, beforeThreshold.foreign);
    assert.equal(afterThreshold.owner.receipts!.length, beforeThreshold.owner.receipts!.length + 1);
    assert.deepEqual(afterThreshold.owner.receipts!.filter(value => value.operation_id !== thresholdInput.operation_id), beforeThreshold.owner.receipts);
    assert.deepEqual(afterThreshold.owner.fence, [{id: 1, revision: thresholdRevision + 1}]);
    assert.deepEqual(afterThreshold.owner.fence_log!.filter(value => value.revision !== thresholdRevision + 1), beforeThreshold.owner.fence_log);
    assert.deepEqual(afterThreshold.owner.fence_log!.filter(value => value.revision === thresholdRevision + 1), [{at: now, operation: OP, revision: thresholdRevision + 1}]);
    const rejectionReplay = await invoker.invokeMutation(thresholdInput, await current()); assert.ok('error' in rejectionReplay); assert.equal(rejectionReplay.error.code, 'rule_failed'); assert.deepEqual(await all(), afterThreshold);
    for (const [label, ref, code] of [['stale Branch', {id: selectedBranch.id, version: '2'}, 'conflict'],
      ['wrong model', {id: conversation.id, version: '1'}, 'not_found'], ['foreign Branch', {id: foreignBranch.id, version: '1'}, 'not_found']] as const) {
      const input = envelope(OP, {branch: ref}), before = await all(), denied = await invoker.invokeMutation(input, await current());
      assert.ok('error' in denied, label); assert.equal(denied.error.code, code); assert.deepEqual(await all(), before); assert.equal(await store.readReceipt(receiptIdentity(input)), null);
    }
    phase('threshold replay and current reference refusals');
    const anonymous = await resolveIdentity(identities, {}, {clock}), anonymousBefore = await all();
    const anonymousInput = envelope(OP, {branch: {id: emptyBranch.id, version: '1'}}), anonymousDenied = await invoker.invokeMutation(anonymousInput, anonymous);
    assert.ok('error' in anonymousDenied); assert.equal(anonymousDenied.error.code, 'forbidden'); assert.deepEqual(await all(), anonymousBefore);
    const beforeForeign = await all(), foreignDenied = await invoker.invokeRetainedMutation(retained[0]!.input, foreignIdentity);
    assert.ok('error' in foreignDenied); assert.equal(foreignDenied.error.code, 'not_found'); assert.deepEqual(await all(), beforeForeign);
    await identities.removeMembership(memberships[0]!.membership_id); now += 1000; const revoked = await all();
    for (const {input} of retained) {
      const denied = await invoker.invokeRetainedMutation(input, identity); assert.ok('error' in denied); assert.equal(denied.error.code, 'forbidden'); assert.deepEqual(await all(), revoked);
    }
    const freshInput = envelope(OP, {branch: {id: emptyBranch.id, version: '1'}}), freshDenied = await invoker.invokeMutation(freshInput, identity);
    assert.ok('error' in freshDenied); assert.equal(freshDenied.error.code, 'forbidden'); assert.deepEqual(await all(), revoked); assert.equal(await store.readReceipt(receiptIdentity(freshInput)), null);
    await identities.reactivateMembership(memberships[0]!.membership_id, {is_owner: false, roles: []}); const stable = await all();
    for (const {input, row} of retained) {
      const replay = committed(await invoker.invokeRetainedMutation(input, await current()), 'replayed'); assert.deepEqual(replay.result, {id: row.id}); assert.deepEqual(await store.load(RUN, row.id), row); assert.deepEqual(await all(), stable);
    }
    phase('current membership refusals and restored replay');
    assert.deepEqual(await store.load(RUN, finished.id), finished); for (const row of excluded) assert.deepEqual(await store.load(RUN, row.id), row);
    assert.deepEqual(await foreign.load(RUN, foreignRun.id), foreignRun);
    // Genuine source CRUD archives the original created result. Recovery must
    // withhold that lifetime while preserving the immutable saved receipt.
    const original = retained[0]!, originalReceipt = await store.readReceipt(receiptIdentity(original.input));
    const archive = envelope(`${RUN}.delete`, {record: {id: original.row.id, version: String(original.row.version)}});
    committed(await invoker.invokeMutation(archive, await current())); const archived = await store.load(RUN, original.row.id); assert.ok(archived); assert.notEqual(archived.archivedAt, null);
    const archivedResources = await all(), withheld = committed(await invoker.invokeMutation(original.input, await current()), 'replayed');
    assert.equal(withheld.result, null); assert.deepEqual(withheld.records, []); assert.deepEqual(await all(), archivedResources);
    assert.deepEqual(await store.readReceipt(receiptIdentity(original.input)), originalReceipt);
    assert.deepEqual(await store.outboxPending(), []); assert.deepEqual(await foreign.outboxPending(), []);
    for (const resources of [archivedResources.owner, archivedResources.foreign]) for (const table of ['outbox', 'schedules']) assert.deepEqual(resources[table], []);
    phase('archived result withheld and resources unchanged');
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
      } finally { await rm(directory, {recursive: true, force: true}); phase('awaited cleanup'); }
    }
  }
 });
