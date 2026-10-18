/** Exact original three-query composition: unscoped lazy ancestor guard,
 * source Budget first, then contained Turn count; same Run is returned with
 * original Budget Set, guarded SEND and late require preserved. Setup only CRUD.
 */
import { createCheckoutScratch } from '../src/runtime/checkout-scratch.test-support.js';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, ModelName, MutationEnvelope, ProjectedRecord, ProviderBinding, ReceiptIdentity, StoredRow, ResolvedIdentity } from '@canlang/contracts';
import type { InstalledMailSender } from '@canlang/services';
import type { SingleFileCapture } from '../src/dev/source-capture.js';
import type { SqliteFileStore } from '@canlang/files/host/sqlite';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const APP = 'ThreeQueryPair', MODEL = `${APP}.Run` as ModelName, BUDGET = `${APP}.Budget` as ModelName, OP = `${APP}.generate`;
const CONVERSATION = `${APP}.Conversation` as ModelName, BRANCH = `${APP}.Branch` as ModelName, TURN = `${APP}.Turn` as ModelName;
const ORIGINAL_SHA256 = 'e0ecc8305cb132f5730a7bf08680b303929a0f1ad2f39dff255fd831f0ad2150';
const SETUP = ' ## BEGIN TEST-AUTHORED SETUP: authenticated setup CRUD\n' +
  ' crud Conversation by=members fields=title\n' +
  ' crud Branch by=members fields=title\n' +
  ' crud Run by=members fields=budget\n' +
  ' crud Turn by=members fields=position,run\n' +
  ' crud Budget by=members fields=account,cap,parallel,spent,held,running,active\n' +
  ' ## END TEST-AUTHORED SETUP\n';
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const nodeImport = compileFunction('return import(url)', ['url'], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
async function snapshot(db: D1Database) {
  const names = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{name: string}>();
  assert.equal(names.success, true);
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const {name} of names.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true); result[name] = rows.results.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}

test('three original ordered queries preserve lazy ancestors, same Branch and Run, source authority and late rollback',
 {timeout: 7200000}, async () => {
  // The prior finite 1800000ms run completed three original cases and provider
  // terminal replay, then timed out in case four. Preserve all remaining guard,
  // rollback, authority and lifetime checks with a measured finite allowance.
  // This does not alter Office/A7 limits or establish latency acceptance.
  const directory = await createCheckoutScratch(root, 'native-three-query-run-turn-');
  const startedAt = Date.now(), phase = (name: string) => console.info(`[native-three-query-run-turn] ${name} elapsed_ms=${Date.now() - startedAt}`);
  let worker: Miniflare | undefined, physical: SqliteFileStore | undefined, foreignPhysical: SqliteFileStore | undefined, capture: SingleFileCapture | undefined;
  let sequence = 0, now = Date.now(); const clock = {nowMs: () => now};
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST'); assert.equal(request.url, '/send');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { const part = Buffer.from(chunk); bytes += part.length; assert.ok(bytes <= 16384); chunks.push(part); }
      const body = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      assert.deepEqual(Object.keys(body).sort(), ['attachments', 'body', 'delivery_id', 'subject', 'to']);
      assert.equal(body.to, 'recipient@example.test'); assert.equal(body.subject, 'Source first');
      assert.equal(body.body, 'Original ordered selection'); assert.deepEqual(body.attachments, []);
      assert.equal(request.headers['idempotency-key'], body.delivery_id); requests.push(body);
      response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({reference: `accepted-${body.delivery_id}`}));
    } catch (error) { response.writeHead(500); response.end(); server.emit('controlFailure', error); }
  });
  let providerFailure: unknown; server.on('controlFailure', error => {providerFailure = error;});
  try {
    const require = createRequire(import.meta.url);
    // One installed default loader owns all private producer and consumer authority.
    const {createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity} = await nodeImport(pathToFileURL(require.resolve('@canlang/identity')).href) as typeof import('@canlang/identity');
    const {ensureSchema} = await nodeImport(pathToFileURL(require.resolve('@canlang/state/storage/d1')).href) as typeof import('@canlang/state/storage/d1');
    const {asId, asModel, asOperation, asOperationId, uuidv7} = await nodeImport(pathToFileURL(require.resolve('@canlang/state/testing/invocation/fixtures')).href) as typeof import('@canlang/state/testing/invocation/fixtures');
    const {RECEIPT_MODEL, RECEIPT_ASSOCIATION_MODEL, readReceiptRow, readAssociationRow} = await nodeImport(pathToFileURL(require.resolve('@canlang/state/receipt/tables')).href) as typeof import('@canlang/state/receipt/tables');
    const {readScenarioReceiptAssociation} = await nodeImport(pathToFileURL(require.resolve('@canlang/state/invocation')).href) as typeof import('@canlang/state/invocation');
    const {hashInputs} = await nodeImport(pathToFileURL(require.resolve('@canlang/state/invocation/replay')).href) as typeof import('@canlang/state/invocation/replay');
    const {createSqliteFileStore} = await nodeImport(pathToFileURL(require.resolve('@canlang/files/host/sqlite')).href) as typeof import('@canlang/files/host/sqlite');
    const {WORK_DISPATCH_MODEL, readDispatchRow} = await nodeImport(pathToFileURL(require.resolve('@canlang/work/kernel/tables')).href) as typeof import('@canlang/work/kernel/tables');
    const nextId = () => asOperationId(uuidv7(now, ++sequence));
    const {distribution} = await nodeImport(pathToFileURL(require.resolve('@canlang/values/distribution')).href) as typeof import('@canlang/values/distribution');
    const {assembleModules, importVerifiedAssemblyModule} = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
    const {buildInvoker} = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
    const {prepareLocalPreviewCapture} = await nodeImport(installed('dev/preview-inputs.js')) as typeof import('../src/dev/preview-inputs.js');
    const {captureSingleFileSource, captureIsCurrent, verifyCompilerSources} = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
    const {createNativeFileRetirementBinding} = await nodeImport(installed('dev/file-retirement.js')) as typeof import('../src/dev/file-retirement.js');
    const {bindNativeEmailDispatchGuards} = await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
    const {createBoundMailAdapter} = await nodeImport(installed('runtime/bound-mail.js')) as typeof import('../src/runtime/bound-mail.js');
    const {createBoundMailDispatcher} = await nodeImport(installed('runtime/bound-dispatch.js')) as typeof import('../src/runtime/bound-dispatch.js');
    const {EmailV1Adapter} = await nodeImport(pathToFileURL(require.resolve('@canlang/services/mail/adapter')).href) as typeof import('@canlang/services/mail/adapter');
    const {WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS, createWorkDispatchClaimCommand} = await nodeImport(pathToFileURL(require.resolve('@canlang/work/kernel/commands')).href) as typeof import('@canlang/work/kernel/commands');
    const {classifyFailure} = await nodeImport(pathToFileURL(require.resolve('@canlang/work/receipt')).href) as typeof import('@canlang/work/receipt');
    // Coordinator-reviewed original Compiler fixture plus the separately
    // released labelled setup scope. Root runs this outside Dev first-slice.
    phase('source:start');
    const originalSource = join(root, 'compiler/tests/fixtures/native-three-query-run-turn.can');
    const source = join(directory, 'native-three-query-run-turn-with-labelled-setup.can');
    const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
    const paths = [originalSource, compiler, catalog], originals = await Promise.all(paths.map(path => readFile(path)));
    assert.equal(hash(originals[0]!), ORIGINAL_SHA256); assert.equal(originals[0]!.length, 1684);
    const originalText = originals[0]!.toString('utf8'); assert.equal(originalText.split('When\n').length, 2);
    const authored = originalText.replace('When\n', `When\n${SETUP}`);
    assert.equal(authored.split(SETUP).length, 2); assert.equal(authored.replace(SETUP, ''), originalText);
    await writeFile(source, authored); const authoredHash = hash(Buffer.from(authored));
    // Capture the actual augmented source and installed Values catalog using
    // the existing public capture builder; invoke the locked CLI directly as
    // this standard-library native fixture is outside Dev first-slice.
    capture = await captureSingleFileSource(prepareLocalPreviewCapture({checkoutRoot: root, appPath: source,
      compilerPath: compiler, catalogPath: catalog, helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md')}));
    assert.equal(capture.sourceSha256, authoredHash); assert.equal(await captureIsCurrent(capture), true);
    for(const [name, path, bytes] of [['compiler', compiler, originals[1]!], ['catalog', catalog, originals[2]!]] as const){
      const input: SingleFileCapture['inputs'][number] | undefined = capture.inputs.find(value=>value.name===name);
      assert.ok(input); assert.equal(input.state,'present');
      assert.equal(input.requestedPath,path); assert.equal(input.sha256,hash(bytes));
    }
    const env = {...process.env}; delete env.CAN_CATALOG;
    const {stdout} = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, capture.compilerOperand],
      {cwd: capture.root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024});
    assert.equal(await captureIsCurrent(capture), true); assert.equal(hash(await readFile(source)), authoredHash);
    const artifact = JSON.parse(stdout) as CompileArtifact, originalArtifact = JSON.stringify(artifact);
    assert.equal(verifyCompilerSources(capture,{complete:true,sources:artifact.sources}).ok,true);
    assert.equal(artifact.sources.find(value=>resolve(capture!.root,value.path)===source)?.sha256, authoredHash);
    const compilerSources=await Promise.all(artifact.sources.map(async value=>{
      const path=resolve(capture!.root,value.path),bytes=await readFile(path); assert.equal(hash(bytes),value.sha256); return {path,bytes};
    }));
    const operation = artifact.operations?.find(operation => operation.name === OP); assert.ok(operation?.result?.disclosure);
    assert.equal(operation.result.type, MODEL); assert.equal(artifact.pages.length, 0);
    for (const model of [CONVERSATION, BRANCH, MODEL, TURN, BUDGET]) assert.equal(artifact.operations?.find(value => value.name === `${model}.create`)?.kind, 'create');
    assert.equal(artifact.models!.find(value => value.name === BRANCH)!.parent, CONVERSATION);
    for (const model of [MODEL, TURN]) assert.equal(artifact.models!.find(value => value.name === model)!.parent, BRANCH);
    assert.deepEqual(artifact.models!.find(value => value.name === TURN)!.fields.find(value => value.name === 'run')!.field, {kind: 'ref', model: MODEL});
    for (const [model, field, target] of [[MODEL, 'budget', BUDGET], [TURN, 'run', MODEL]] as const)
      assert.deepEqual(artifact.operations!.find(value => value.name === `${model}.create`)!.inputs.fields.find(value => value.name === field)!.field,
        {kind: 'ref', model: target, requireVersion: true});
    const branchInput = operation.inputs.fields.find(value => value.name === 'branch'); assert.ok(branchInput);
    assert.equal(branchInput.required, true); assert.deepEqual(branchInput.field, {kind: 'ref', model: BRANCH, requireVersion: true});
    assert.equal(artifact.operations?.find(operation=>operation.name===`${BUDGET}.create`)?.kind,'create');
    const plan=operation.result.disclosure; assert.equal(plan.queries?.length,3); const ancestorPlan=plan.queries![0]!, firstPlan=plan.queries![1]!, countPlan=plan.queries![2]!;
    assert.equal(plan.source.sha256,authoredHash); assert.equal(resolve(capture.root,plan.source.path),source);
    assert.equal(firstPlan.model,BUDGET); assert.deepEqual(firstPlan.order,[{field:'id',direction:'asc'}]);
    assert.equal(firstPlan.limit,null); assert.equal(firstPlan.archived,'exclude'); assert.deepEqual(firstPlan.source,plan.source);
    assert.equal(firstPlan.dependencies.length,1); assert.equal(firstPlan.dependencies[0]!.field,'account');
    assert.equal(firstPlan.dependencies[0]!.type,'user'); assert.equal(firstPlan.dependencies[0]!.role,'control');
    assert.equal(firstPlan.parent, undefined);
    assert.equal(ancestorPlan.model, MODEL); assert.equal(ancestorPlan.parent, undefined);
    assert.deepEqual(ancestorPlan.order, []); assert.equal(ancestorPlan.limit, null); assert.equal(ancestorPlan.archived, 'exclude'); assert.deepEqual(ancestorPlan.source, plan.source);
    assert.deepEqual(ancestorPlan.dependencies.map(value => [value.field, value.type, value.role]), [['parent', BRANCH, 'control'], ['unfinished', 'bool', 'control']]);
    const [candidateParent, suppliedParent] = plan.returns[0]!.dependencies.filter(value => value.queryId === ancestorPlan.id);
    assert.ok(candidateParent); assert.ok(suppliedParent); assert.notEqual(candidateParent.id, suppliedParent.id);

    assert.equal(countPlan.model, TURN); assert.deepEqual(countPlan.source, plan.source);
    assert.deepEqual(countPlan.parent, {source: plan.source, model: BRANCH, origin: {kind: 'admitted-reference', parameter: 'branch'}});
    assert.deepEqual(countPlan.order, []); assert.equal(countPlan.limit, null); assert.equal(countPlan.archived, 'exclude'); assert.deepEqual(countPlan.dependencies, []);
    for (const returned of plan.returns) {
      assert.equal(returned.projection, undefined); assert.deepEqual(returned.source, plan.source);
      const parents = returned.dependencies.filter(value => value.queryId !== undefined); assert.equal(parents.length, 2);
      for (const dependency of parents) {
        assert.equal(dependency.queryId, ancestorPlan.id); assert.equal(dependency.model, BRANCH); assert.equal(dependency.field, 'parent');
        assert.equal(dependency.type, CONVERSATION); assert.equal(dependency.role, 'control'); assert.deepEqual(dependency.source, plan.source);
      }
      assert.equal(returned.influences.length, 12);
      for (const [index, query] of [ancestorPlan, firstPlan, countPlan].entries()) {
        const influences = returned.influences.slice(index * 4, index * 4 + 4);
        assert.deepEqual(influences.map(value => value.kind), ['query-existence', 'query-cardinality', 'query-membership', 'query-order']);
        assert.ok(influences.every(value => value.queryId === query.id));
      }
    }
    for(const field of ['active','running','parallel','spent','held','cap'])
      assert.ok(plan.returns.some(value=>value.dependencies.some(dependency=>dependency.model===BUDGET&&dependency.field===field)));
    const asm = await assembleModules({artifact, sourcePath: source}, {workDir: join(directory, 'modules'), stdlibUrl: installed('runtime/stdlib.js'),
      uiUrl: pathToFileURL(require.resolve('@canlang/ui')).href});
    const callable = artifact.callables.find(callable => callable.id === OP); assert.ok(callable);
    // Assert the producer's actual claim; the installed loader binds its
    // original module callbacks and owns policy enforcement at the final fence.
    assert.deepEqual(artifact.modelPolicies, [{ abi: 'state.owner-model-policies@1', model: BUDGET,
      ownerPackage: APP, module: callable.module, rules: [
        { kind: 'invariant', id: `${BUDGET}.require.1`, dependencies: [] },
        { kind: 'lock', id: `${BUDGET}.lock.1`, fields: ['account'] },
      ], hooks: [] }]);
    const namespace = object(await importVerifiedAssemblyModule(asm, callable.module, artifact)); assert.equal(namespace[callable.export], OP);
    const definition = object(namespace.appDefinition), guard = object((object(object(definition.operations)[OP]).sendGuards as unknown[])[0]);
    assert.deepEqual(guard.inputs, [{name: 'enabled', type: 'bool'}]);
    const generated = artifact.modules.find(module => module.path === callable.module); assert.ok(generated);
    assert.match(generated.js, /await bindScenarioReceiptModelResult\(c,/);
    assert.equal((generated.js.match(/\bfirstQuery\(/g)||[]).length,1); assert.equal((generated.js.match(/\bexecuteScenarioReceiptQuery\(/g)||[]).length,3);
    assert.doesNotMatch(generated.js,/canApp\.firstQuery|c\.canApp/);
    assert.equal((generated.js.match(/\bcountQuery\(/g) ?? []).length, 2);
    let handler: unknown = (namespace.canApp as () => unknown)();
    for (const member of callable.member) handler = object(handler)[member];
    assert.equal(typeof handler, 'function'); const body = (handler as Function).toString();
    assert.equal((body.match(/\bawait create\(/g) ?? []).length, 2);
    const runCreate = /\bconst ([$\w]+) = await create\(c,"ThreeQueryPair\.Run",/.exec(body);
    const turnCreate = /\bconst ([$\w]+) = await create\(c,"ThreeQueryPair\.Turn",/.exec(body);
    assert.ok(runCreate); assert.ok(turnCreate); assert.ok(runCreate.index < turnCreate.index);
    const countClause = body.slice(turnCreate.index, body.indexOf('await set(', turnCreate.index));
    assert.ok(countClause.includes(`run:${runCreate[1]}}`)); assert.match(countClause, /int64\(await [\s\S]*countQuery\([\s\S]*\+ 1n\)/);
    assert.ok(body.includes(`const $receiptValue=${runCreate[1]};`), 'same first Run is returned');
    assert.ok(body.indexOf('countQuery(') < body.indexOf('firstQuery(') && body.indexOf('firstQuery(') < runCreate.index);
    assert.equal((body.match(/\bawait readScenarioReceiptQueryParent\(/g) ?? []).length, 1);
    const bridge = /await readScenarioReceiptQueryParent\(c,([$\w]+),"([^"\\]+)"\)/.exec(body); assert.ok(bridge); assert.equal(bridge[2], candidateParent.id);
    const same = body.indexOf('same('), candidateMarker = body.indexOf(`"parent",${JSON.stringify(candidateParent.id)}`),
      suppliedMarker = body.indexOf(`"parent",${JSON.stringify(suppliedParent.id)}`), and = body.indexOf('&&', same), unfinished = body.indexOf('["unfinished"]');
    assert.ok(same >= 0 && same < candidateMarker && candidateMarker < suppliedMarker && suppliedMarker < and && and < unfinished);


    const compiledBytes=new Map(await Promise.all(Object.entries(asm.moduleUrls).map(async([path,url])=>[path,await readFile(fileURLToPath(url))]as const)));
    phase('source:ready; authenticated setup:start');
    worker = new Miniflare({compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: {IDENTITY: 'three-query-pair-identity', OWNER: 'three-query-pair-owner', FOREIGN: 'three-query-pair-foreign'}, d1Persist: join(directory, 'd1')});
    const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
    const db = await worker.getD1Database('OWNER') as unknown as D1Database, foreignDb = await worker.getD1Database('FOREIGN') as unknown as D1Database;
    await ensureIdentitySchema(identityDb); await ensureSchema(db); await ensureSchema(foreignDb);
    const identities = createD1IdentityStore(identityDb, {clock}), team = await identities.createTeam({timezone: 'UTC'});
    const user = await identities.createUser({email: 'three-query-pair@example.test', password_hash: 'unused', email_verified: true});
    const membership = await identities.createMembership({user_id: user.user_id, team_id: team.team_id, is_owner: true, roles: []});
    const foreignTeam = await identities.createTeam({timezone: 'UTC'}), foreignUser = await identities.createUser({email: 'three-query-pair-foreign@example.test', password_hash: 'unused', email_verified: true});
    await identities.createMembership({user_id: foreignUser.user_id, team_id: foreignTeam.team_id, is_owner: true, roles: []});
    const grant = await issueMcpGrant(identities, {user_id: user.user_id, team_id: team.team_id, client_id: 'three-query-pair'}, {clock});
    const foreignGrant = await issueMcpGrant(identities, {user_id: foreignUser.user_id, team_id: foreignTeam.team_id, client_id: 'three-query-pair-foreign'}, {clock});
    const current = () => resolveIdentity(identities, {mcp_grant_token: grant.token}, {clock});
    const foreign = () => resolveIdentity(identities, {mcp_grant_token: foreignGrant.token}, {clock});
    physical = createSqliteFileStore(join(directory, 'files.sqlite'));
    const scope = {app: APP, ownerPackage: APP, owner: team.team_id};
    const native = await createNativeFileRetirementBinding({artifact, asm, scope, identities, db, stateStoreId: 'native-three-query-run-turn', physicalSqliteFileStore: physical,
      initializeFresh: true, clock, intentTtlMs: 60000, urlBase: 'https://three-query-pair.invalid', retention: {unattachedHorizonMs: 120000, retentionMs: 600000}, maxRows: 100, maxReferences: 100});
    const fenceFor = await bindNativeEmailDispatchGuards({asm, artifact, store: native.store, identities, scope,
      revalidateAuthority: async () => (await identities.findTeamById(team.team_id))?.team_id === team.team_id});
    const invoker = buildInvoker(artifact, asm, native.store, {appId: APP, memberships: identities, now: clock.nowMs, ownerStorage: native.ownerStorage});
    foreignPhysical = createSqliteFileStore(join(directory, 'foreign-files.sqlite'));
    const foreignNative = await createNativeFileRetirementBinding({artifact, asm,
      scope: {app: APP, ownerPackage: APP, owner: foreignTeam.team_id}, identities, db: foreignDb, stateStoreId: 'native-three-query-pair-foreign', physicalSqliteFileStore: foreignPhysical,
      initializeFresh: true, clock, intentTtlMs: 60000, urlBase: 'https://three-query-pair-foreign.invalid', retention: {unattachedHorizonMs: 120000, retentionMs: 600000}, maxRows: 100, maxReferences: 100});
    const foreignInvoker = buildInvoker(artifact, asm, foreignNative.store, {appId: APP, memberships: identities, now: clock.nowMs, ownerStorage: foreignNative.ownerStorage});
    const admittedIdentity = await current();
    const resources = async () => ({identity: await snapshot(identityDb), owner: await snapshot(db), foreign: await snapshot(foreignDb),
      files: physical!.files.listAll(), intents: physical!.intents.listAll(),
      foreignFiles: foreignPhysical!.files.listAll(), foreignIntents: foreignPhysical!.intents.listAll()});
    const query = (model: string) => native.store.query({model: asModel(model), authority: 'owner', archived: 'include', order: [{field: 'id', direction: 'asc'}]});
    const create = async (model: ModelName, inputs: MutationEnvelope['inputs'], actor: ResolvedIdentity = admittedIdentity, selected = native): Promise<StoredRow> => {
      const input: MutationEnvelope = {operation: `${model}.create`, operation_id: nextId(), inputs};
      const selectedInvoker = selected === native ? invoker : foreignInvoker, revision = await selected.store.readRevision();
      const result = await selectedInvoker.invokeMutation(input, actor); assert.ok('result' in result, JSON.stringify(result)); assert.equal(result.result.status, 'committed');
      assert.equal(await selected.store.readRevision(), revision + 1); assert.equal(result.result.records?.length, 1);
      const id = object(result.result.records![0]).id; assert.equal(typeof id, 'string');
      const row = await selected.store.load(model, asId(id as string)); assert.ok(row); assert.equal(row.version, 1); assert.equal(row.createdBy, actor.actor!.user_id);
      const receipt = await selected.store.readReceipt({app: APP, owner: actor.team!.team_id, principal: actor.actor!.user_id, operation: asOperation(input.operation), operationId: asOperationId(input.operation_id)});
      assert.ok(receipt); assert.equal(receipt.inputHash, await hashInputs(input.inputs)); assert.equal(receipt.committedRevision, revision + 1);
      const history = await selected.store.historyFor(model, row.id); assert.equal(history.length, 1);
      assert.equal(history[0]!.operation, input.operation); assert.equal(history[0]!.operationId, input.operation_id); assert.equal(history[0]!.before, null); assert.deepEqual(history[0]!.after, row.data); return row;
    };
    const conversation = await create(CONVERSATION, {title: 'Selected conversation'}), otherConversation = await create(CONVERSATION, {title: 'Excluded conversation'}),
      emptyConversation = await create(CONVERSATION, {title: 'Empty conversation'});
    const branch = (owner: StoredRow, title: string) => create(BRANCH, {parent: {id: owner.id, version: String(owner.version)}, title});
    const selectedBranch = await branch(conversation, 'Selected'), siblingBranch = await branch(conversation, 'Same conversation sibling'),
      otherBranch = await branch(otherConversation, 'Excluded'), emptyBranch = await branch(emptyConversation, 'Empty');
    const branches = new Map([selectedBranch, siblingBranch, otherBranch, emptyBranch].map(value => [value.id, value]));
    const envelope = (enabled: boolean, accept = true, parent: StoredRow = selectedBranch): MutationEnvelope => ({operation: OP, operation_id: nextId(),
      inputs: {branch: {id: parent.id, version: String(parent.version)}, enabled, accept}});
    const identity = (input: MutationEnvelope): ReceiptIdentity => ({app: APP, owner: team.team_id, principal: user.user_id, operation: asOperation(OP), operationId: asOperationId(input.operation_id)});
    const invoke = async (input: MutationEnvelope) => invoker.invokeMutation(input, await current());
    await new Promise<void>((done, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', done);});
    const address = server.address(); assert.ok(address !== null && typeof address !== 'string');
    const binding: ProviderBinding = {deployment: 'deployment.mail', capability: 'std.EmailV1', capabilityVersion: 1, account: 'local-three-query-pair'};
    const sender: InstalledMailSender = {binding, mail: new EmailV1Adapter({baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 2000,
      maxBodyBytes: 16384, maxTransportBytes: null, clock: {now: clock.nowMs}})};
    const adapter = createBoundMailAdapter({appDefinition: definition, binding, resolveInstalledMailSender: () => sender});
    const dispatcher = await createBoundMailDispatcher({store: native.store, adapter, workCommands: WORK_SYSTEM_COMMANDS,
      stageCommands: WORK_DISPATCH_STAGE_COMMANDS, createClaimCommand: createWorkDispatchClaimCommand});
    const unchanged = async (before: Awaited<ReturnType<typeof resources>>) => assert.deepEqual(await resources(), before);
    const rejectedWithoutEffects=async(label:string,parent:StoredRow=selectedBranch)=>{
      const input=envelope(true,true,parent),before=await resources(),revision=await native.store.readRevision(),sent=requests.length;
      const refused=await invoke(input); assert.ok('error'in refused,label); assert.equal(refused.error.code,'rule_failed');
      const receipt=await native.store.readReceipt(identity(input)); assert.ok(receipt); assert.equal(receipt.outcome.status,'rejected');
      assert.equal(receipt.committedRevision,revision+1); assert.equal(receipt.inputHash, await hashInputs(input.inputs)); const after=await resources();
      assert.equal(after.owner.receipts!.length, before.owner.receipts!.length + 1);
      assert.deepEqual(after.owner.receipts!.filter(value => value.operation_id !== input.operation_id), before.owner.receipts);
      assert.deepEqual(after.owner.fence, [{id: 1, revision: revision + 1}]);
      assert.deepEqual(after.owner.fence_log!.filter(value => value.revision !== revision + 1), before.owner.fence_log);
      assert.deepEqual(after.owner.fence_log!.filter(value => value.revision === revision + 1), [{at: now, operation: OP, revision: revision + 1}]);
      for(const table of Object.keys(before.owner))if(!['receipts','fence','fence_log'].includes(table))assert.deepEqual(after.owner[table],before.owner[table],label);
      assert.deepEqual(after.identity,before.identity); assert.deepEqual(after.foreign,before.foreign);
      assert.deepEqual(after.files,before.files); assert.deepEqual(after.intents,before.intents);
      assert.deepEqual(after.foreignFiles, before.foreignFiles); assert.deepEqual(after.foreignIntents, before.foreignIntents); assert.equal(requests.length,sent);
      const replay=await invoke(input); assert.ok('error'in replay); assert.equal(replay.error.code,'rule_failed'); await unchanged(after);
    };
    phase('empty Budget/source query:start');
    await rejectedWithoutEffects('genuine empty query yields null before any Budget setup');
    const createBudget = (actor: ResolvedIdentity, active = true, selected = native) => create(BUDGET,
      {account: {id: actor.actor!.user_id}, cap: '100', parallel: '10', spent: '0', held: '0', running: '0', active}, actor, selected);
    const otherUser=await identities.createUser({email:'three-query-pair-other@example.test',password_hash:'unused',email_verified:true});
    await identities.createMembership({user_id:otherUser.user_id,team_id:team.team_id,is_owner:false,roles:[]});
    const otherGrant=await issueMcpGrant(identities,{user_id:otherUser.user_id,team_id:team.team_id,client_id:'three-query-pair-other'},{clock});
    const otherIdentity=await resolveIdentity(identities,{mcp_grant_token:otherGrant.token},{clock}),otherBudget=await createBudget(otherIdentity);
    await rejectedWithoutEffects('different account is policy-hidden, never a forged false candidate');
    const budget=await createBudget(admittedIdentity,false);
    // Original account:user unique is enforced by the authentic CRUD commit,
    // using Values' genuine user reference wire rather than a scalar waiver.
    phase('authenticated unique:start');
    const duplicateInput: MutationEnvelope = {operation: `${BUDGET}.create`, operation_id: nextId(),
      inputs: {account: {id: user.user_id}, cap: '100', parallel: '10', spent: '0', held: '0', running: '0', active: true}};
    const crudIdentity = (input: MutationEnvelope): ReceiptIdentity => ({app: APP, owner: team.team_id, principal: user.user_id,
      operation: asOperation(input.operation), operationId: asOperationId(input.operation_id)});
    const beforeDuplicate = await resources(), duplicateRevision = await native.store.readRevision();
    const duplicate = await invoker.invokeMutation(duplicateInput, await current());
    assert.ok('error' in duplicate, JSON.stringify(duplicate)); assert.equal(duplicate.error.code, 'conflict');
    assert.equal(await native.store.readReceipt(crudIdentity(duplicateInput)), null, 'losing unique commit produces no receipt');
    assert.equal(await native.store.readRevision(), duplicateRevision); await unchanged(beforeDuplicate);

    // Original lock account refuses a genuine different user, at the actual
    // current record version. Its business rejection is retained at one fence.
    phase('authenticated account lock:start');
    const lockedBefore = await native.store.load(BUDGET, budget.id); assert.ok(lockedBefore);
    const lockInput: MutationEnvelope = {operation: `${BUDGET}.update`, operation_id: nextId(),
      inputs: {record: {id: lockedBefore.id, version: String(lockedBefore.version)}, account: {id: otherUser.user_id}}};
    const beforeLock = await resources(), lockRevision = await native.store.readRevision(), sentBeforeLock = requests.length;
    const locked = await invoker.invokeMutation(lockInput, await current());
    assert.ok('error' in locked, JSON.stringify(locked)); assert.equal(locked.error.code, 'rule_failed');
    const lockReceipt = await native.store.readReceipt(crudIdentity(lockInput)); assert.ok(lockReceipt);
    assert.deepEqual(lockReceipt.identity, crudIdentity(lockInput)); assert.equal(lockReceipt.inputHash, await hashInputs(lockInput.inputs));
    assert.deepEqual(lockReceipt.resolvedDefaults, {}); assert.equal(lockReceipt.createdAt, now);
    assert.deepEqual(lockReceipt.outcome, {status: 'rejected', code: 'rule_failed', message: locked.error.message});
    assert.equal(lockReceipt.committedRevision, lockRevision + 1); assert.equal(await native.store.readRevision(), lockRevision + 1);
    const afterLock = await resources();
    for (const table of Object.keys(beforeLock.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table))
      assert.deepEqual(afterLock.owner[table], beforeLock.owner[table], table);
    assert.equal(afterLock.owner.receipts!.length, beforeLock.owner.receipts!.length + 1);
    assert.deepEqual(afterLock.owner.receipts!.filter(value => value.operation_id !== lockInput.operation_id), beforeLock.owner.receipts);
    assert.deepEqual(beforeLock.owner.fence, [{id: 1, revision: lockRevision}]);
    assert.deepEqual(afterLock.owner.fence, [{id: 1, revision: lockRevision + 1}]);
    assert.deepEqual(afterLock.owner.fence_log!.filter(value => value.revision !== lockRevision + 1), beforeLock.owner.fence_log);
    assert.deepEqual(afterLock.owner.fence_log!.filter(value => value.revision === lockRevision + 1),
      [{at: now, operation: lockInput.operation, revision: lockRevision + 1}]);
    assert.deepEqual(afterLock.identity, beforeLock.identity); assert.deepEqual(afterLock.foreign, beforeLock.foreign);
    assert.deepEqual(afterLock.files, beforeLock.files); assert.deepEqual(afterLock.intents, beforeLock.intents);
    assert.deepEqual(afterLock.foreignFiles, beforeLock.foreignFiles); assert.deepEqual(afterLock.foreignIntents, beforeLock.foreignIntents);
    assert.equal(requests.length, sentBeforeLock); assert.deepEqual(await native.store.load(BUDGET, budget.id), lockedBefore);
    assert.deepEqual(await native.store.load(BUDGET, otherBudget.id), otherBudget);
    const lockReplay = await invoker.invokeMutation(lockInput, await current());
    assert.ok('error' in lockReplay, JSON.stringify(lockReplay)); assert.equal(lockReplay.error.code, 'rule_failed');
    assert.equal(lockReplay.error.message, locked.error.message); await unchanged(afterLock);
    assert.deepEqual(await native.store.readReceipt(crudIdentity(lockInput)), lockReceipt); assert.equal(requests.length, sentBeforeLock);
    const ordered=(await query(BUDGET)).map(value=>value.id); assert.deepEqual(ordered,[otherBudget.id,budget.id].sort());
    await rejectedWithoutEffects('genuine selected inactive Budget fails before Create/SEND');
    const updateBudget=async(patch:Record<string,unknown>)=>{
      const row=await native.store.load(BUDGET,budget.id); assert.ok(row);
      const result=await invoker.invokeMutation({operation:`${BUDGET}.update`,operation_id:nextId(),inputs:{record:{id:row.id,version:String(row.version)},...patch}},await current());
      assert.ok('result'in result,JSON.stringify(result)); assert.equal(result.result.status,'committed');
    };
    await updateBudget({active:true});
    const seed = async (parentRow: StoredRow, position: string, budgetRow = budget, actor = admittedIdentity, selected = native) => {
      const parent = {id: parentRow.id, version: String(parentRow.version)};
      const currentBudget = await selected.store.load(BUDGET, budgetRow.id); assert.ok(currentBudget);
      const run = await create(MODEL, {parent, budget: {id: currentBudget.id, version: String(currentBudget.version)}}, actor, selected);
      const turn = await create(TURN, {parent, position, run: {id: run.id, version: String(run.version)}}, actor, selected); return {run, turn};
    };
    const ownedRuns: StoredRow[] = [], seededPairs: Array<{run: StoredRow; turn: StoredRow}> = [], selectedTurns: StoredRow[] = [], emptyTurns: StoredRow[] = [];
    let foreignSeed: {run: StoredRow; turn: StoredRow} | undefined, foreignBranch: StoredRow | undefined;
    const saved: Array<{input: MutationEnvelope; id: string; turnId: StoredRow['id']; position: string}> = [];
    const executeOriginalCase = async (index: 0 | 1 | 2 | 3, parentRow: StoredRow, expectedRows: StoredRow[], enabled: boolean): Promise<void> => {
      phase(`original setup:index=${index}`);
      if (index === 1) {
        const first = await seed(selectedBranch, '7'), second = await seed(selectedBranch, '42'), excluded = await seed(otherBranch, '100');
        seededPairs.push(first, second, excluded); ownedRuns.push(first.run, second.run, excluded.run); selectedTurns.push(first.turn, second.turn);
        const currentBudget = await native.store.load(BUDGET, budget.id); assert.ok(currentBudget);
        const sibling = await create(MODEL, {parent: {id: siblingBranch.id, version: '1'}, budget: {id: currentBudget.id, version: String(currentBudget.version)}}); ownedRuns.push(sibling);
        const foreignIdentity = await foreign(), foreignConversation = await create(CONVERSATION, {title: 'Foreign'}, foreignIdentity, foreignNative);
        foreignBranch = await create(BRANCH, {parent: {id: foreignConversation.id, version: '1'}, title: 'Foreign'}, foreignIdentity, foreignNative);
        const foreignBudget = await createBudget(foreignIdentity, true, foreignNative); foreignSeed = await seed(foreignBranch, '50', foreignBudget, foreignIdentity, foreignNative);
      }
      const expected = [...expectedRows], originalRuns = [...ownedRuns], position = String(BigInt(expected.length) + 1n), sentBefore = requests.length;

      const selectedBefore=await native.store.load(BUDGET,budget.id); assert.ok(selectedBefore);
      const input = envelope(enabled, true, parentRow), before = await resources(), revision = await native.store.readRevision();
      phase(`original three-query invoke:index=${index} enabled=${enabled}`);
      const result = await invoke(input); assert.ok('result' in result, JSON.stringify(result)); assert.equal(result.result.status, 'committed');
      const wire = object(result.result.result); assert.deepEqual(Object.keys(wire), ['id']); assert.equal(typeof wire.id, 'string');
      const id = wire.id as string;
      const row = await native.store.load(MODEL, asId(id)); assert.ok(row); assert.equal(row.version, 1);
      assert.equal(row.createdBy, user.user_id); assert.deepEqual(row.parent, {model: BRANCH, id: parentRow.id}); assert.ok(row.data.request !== null);
      assert.deepEqual(row.data.budget,{id:budget.id}); assert.equal(row.data.unfinished, true);
      const newTurns = (await query(TURN)).filter(value => !before.owner.records!.some(prior => prior.id === value.id));
      assert.equal(newTurns.length, 1); const turn = newTurns[0]!;
      assert.deepEqual(turn.parent, row.parent); assert.deepEqual(turn.data, {position, run: {id}}); assert.equal(turn.version, 1);
      assert.equal(turn.createdBy, user.user_id); assert.equal(turn.created, now);
      saved.push({input, id, turnId: turn.id, position});
      assert.deepEqual(await native.store.load(BRANCH, parentRow.id), parentRow); assert.deepEqual(await native.store.load(CONVERSATION, conversation.id), conversation);
      for (const seeded of seededPairs) assert.deepEqual(await native.store.load(TURN, seeded.turn.id), seeded.turn);
      if (foreignSeed !== undefined) assert.deepEqual(await foreignNative.store.load(TURN, foreignSeed.turn.id), foreignSeed.turn);

      const currentBudget=await native.store.load(BUDGET,budget.id); assert.ok(currentBudget);
      assert.equal(currentBudget.version,selectedBefore.version+1);
      assert.deepEqual(currentBudget.data,{...selectedBefore.data,held:String(BigInt(String(selectedBefore.data.held))+1n),running:String(BigInt(String(selectedBefore.data.running))+1n)});
      assert.deepEqual(await native.store.load(BUDGET,otherBudget.id),otherBudget,'policy-hidden other member Budget remains untouched');
      phase(`original census/receipt:index=${index}`);
      const receipt = await native.store.readReceipt(identity(input)); assert.ok(receipt); assert.equal(receipt.inputHash, await hashInputs(input.inputs));
      assert.equal(receipt.committedRevision, revision + 1); assert.equal(await native.store.readRevision(), revision + 1);
      const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
      assert.equal(association.resultType, MODEL); assert.deepEqual(association.plan, plan);
      assert.deepEqual(new Set(association.changed.map(change=>`${change.model}:${change.row.id}`)),new Set([`${MODEL}:${id}`,`${BUDGET}:${budget.id}`,`${TURN}:${turn.id}`]));
      assert.deepEqual(association.changed.find(change=>change.model===MODEL)!.row,row);
      assert.deepEqual(association.changed.find(change=>change.model===BUDGET)!.row,currentBudget);
      const runChange = association.changed.find(change => change.model === MODEL)!;
      assert.equal(runChange.fieldTypes.budget, null); assert.equal(runChange.fieldTypes.request, null);
      assert.deepEqual(runChange.withheldFields, ['budget', 'request']);
      assert.deepEqual(association.changed.map(value => value.model), [BUDGET, MODEL, TURN], 'State net writes use model/id order');
      assert.deepEqual(association.changed[2]!.row, turn);
      assert.equal(association.changed[2]!.fieldTypes.run, null);
      assert.deepEqual(association.changed[2]!.withheldFields, ['run']);
      assert.equal(receipt.outcome.status, 'committed'); if (receipt.outcome.status !== 'committed') throw new Error('pair must commit');
      assert.deepEqual(receipt.outcome.recordVersions, [{model: BUDGET, id: budget.id, version: currentBudget.version}, {model: MODEL, id: row.id, version: 1}, {model: TURN, id: turn.id, version: 1}]);
      assert.deepEqual(receipt.outcome.result, {id});
      assert.equal(runChange.fieldTypes.unfinished, 'bool');
      assert.equal(association.queries?.length,3);
      const ancestor = association.queries![0]!; assert.equal(ancestor.queryId, ancestorPlan.id); assert.equal(ancestor.revision, revision); assert.equal(ancestor.parent, undefined);
      assert.equal(ancestor.candidates.length, originalRuns.length); assert.deepEqual(new Set(ancestor.candidates.map(value => value.row.id)), new Set(originalRuns.map(value => value.id)));
      const matches: number[] = [];
      for (const [slot, candidate] of ancestor.candidates.entries()) {
        const original = originalRuns.find(value => value.id === candidate.row.id); assert.ok(original); assert.deepEqual(candidate.row, original);
        assert.deepEqual(candidate.record.parent, original.parent); assert.equal(candidate.record.data.unfinished, original.data.unfinished); assert.deepEqual(candidate.record.data.budget, original.data.budget);
        const ownerBranch = branches.get(original.parent!.id); assert.ok(ownerBranch); const sameConversation = ownerBranch.parent!.id === parentRow.parent!.id;
        assert.equal(candidate.matched, sameConversation && original.data.unfinished === true); if (candidate.matched) matches.push(slot);
        assert.deepEqual(new Set(candidate.dependencies), new Set([ancestorPlan.dependencies[0]!.id, candidateParent.id, suppliedParent.id,
          ...(sameConversation ? [ancestorPlan.dependencies[1]!.id] : [])]));
      }
      assert.equal(matches.length, [0, 3, 1, 4][index], 'original ancestor count includes sibling Branch Runs and excludes other Conversations');
      assert.ok(matches.length < 10); assert.deepEqual(ancestor.selectedIndices, matches);
      const candidateReads = association.observations.filter(value => value.dependencyId === candidateParent.id), suppliedReads = association.observations.filter(value => value.dependencyId === suppliedParent.id);
      assert.equal(candidateReads.length, originalRuns.length); assert.equal(suppliedReads.length, originalRuns.length);
      for (const [slot, candidate] of ancestor.candidates.entries()) {
        assert.equal(candidateReads[slot]!.model, BRANCH); assert.deepEqual(candidateReads[slot]!.row, branches.get(candidate.row.parent!.id)); assert.deepEqual(candidateReads[slot]!.secretFields, []);
        assert.equal(suppliedReads[slot]!.model, BRANCH); assert.deepEqual(suppliedReads[slot]!.row, parentRow); assert.deepEqual(suppliedReads[slot]!.secretFields, []);
      }
      const census=association.queries![1]!;
      assert.equal(census.queryId,firstPlan.id); assert.equal(census.revision,revision);
      assert.equal(census.candidates.length,1,'source read policy removes another account before predicate');
      assert.deepEqual(census.candidates[0]!.row,selectedBefore); assert.equal(census.candidates[0]!.matched,true);
      assert.equal(census.parent, undefined); assert.deepEqual(census.candidates[0]!.record.data, selectedBefore.data);
      assert.deepEqual(census.candidates[0]!.secretFields, []);
      assert.deepEqual(census.selectedIndices,[0]); assert.ok(census.candidates[0]!.dependencies.includes(firstPlan.dependencies[0]!.id));
      for(const observation of association.observations.filter(value=>value.model===BUDGET))assert.deepEqual(observation.row,selectedBefore);
      const count = association.queries![2]!; assert.equal(count.queryId, countPlan.id); assert.equal(count.revision, revision);
      assert.deepEqual(count.parent, {model: BRANCH, row: parentRow, secretFields: []}, 'empty count retains admitted parent');
      assert.equal(count.candidates.length, expected.length);
      assert.deepEqual(new Set(count.candidates.map(value => value.row.id)), new Set(expected.map(value => value.id)));
      for (const candidate of count.candidates) {
        assert.deepEqual(candidate.row, expected.find(value => value.id === candidate.row.id)); assert.equal(candidate.matched, true);
        assert.deepEqual(candidate.secretFields, []); assert.deepEqual(candidate.dependencies, []);
        assert.deepEqual(candidate.record.data, candidate.row.data); assert.deepEqual(candidate.record.parent, candidate.row.parent);
      }
      assert.deepEqual(count.selectedIndices, count.candidates.map((_, index) => index));
      assert.equal(association.calls?.length ?? 0,0); assert.equal(result.result.records?.length,3);
      const projected = result.result.records as readonly ProjectedRecord[];
      assert.deepEqual(projected.map(value => value.id), [budget.id, row.id, turn.id]);
      assert.deepEqual(projected[2]!.data, {position}); assert.deepEqual(projected[2]!.parent, turn.parent);
      const projection=object(projected.find(value=>value.id===id)); assert.equal(projection.id,id);
      assert.deepEqual(projection.data, {unfinished: true}, 'original primitive unfinished remains readable while opaque budget/request stay withheld');
      const budgetProjection=object(result.result.records!.find(value=>object(value).id===budget.id));
      assert.deepEqual(budgetProjection.data,currentBudget.data); assert.equal(BigInt(String(budgetProjection.version)),BigInt(currentBudget.version));
      const deliveries = (await query(RECEIPT_MODEL)).map(row => readReceiptRow(row));
      const delivery = deliveries.find(delivery => delivery.filePayloadOrigin?.origin.kind === 'delivery-result' && delivery.filePayloadOrigin.origin.intent.operationId === input.operation_id ||
        delivery.filePayloadOrigin?.origin.kind === 'delivery-skipped' && delivery.filePayloadOrigin.origin.send.operationId === input.operation_id);
      assert.ok(delivery); assert.equal(delivery.receipt.status, enabled ? 'pending' : 'skipped');
      assert.ok(delivery.filePayloadOrigin); const deliveryOrigin = delivery.filePayloadOrigin.origin;
      assert.ok(deliveryOrigin.kind === 'delivery-result' || deliveryOrigin.kind === 'delivery-skipped');
      assert.deepEqual(deliveryOrigin.association, {model: MODEL, recordId: id, field: 'request'});
      const after = await resources(); assert.deepEqual(after.identity, before.identity); assert.deepEqual(after.foreign, before.foreign);
      assert.equal(after.owner.records!.length,before.owner.records!.length+(enabled?5:4));
      assert.equal(after.owner.receipts!.length,before.owner.receipts!.length+1);
      assert.deepEqual(after.owner.records!.filter(value=>before.owner.records!.some(prior=>prior.id===value.id)&&value.id!==budget.id),
        before.owner.records!.filter(value=>value.id!==budget.id));
      for(const table of Object.keys(before.owner))if(!['records','history','receipts','outbox','fence','fence_log','sqlite_sequence','file_reference_authority'].includes(table))assert.deepEqual(after.owner[table],before.owner[table],table);
      assert.deepEqual(after.owner.receipts!.filter(value=>value.operation_id!==input.operation_id),before.owner.receipts);
      assert.equal(after.owner.outbox!.length,before.owner.outbox!.length+(enabled?1:0));
      assert.deepEqual(after.owner.outbox!.filter(value=>value.operation_id!==input.operation_id),before.owner.outbox);
      const associations=(await query(RECEIPT_ASSOCIATION_MODEL)).map(row=>({row,value:readAssociationRow(row)}));
      assert.equal(associations.filter(({row,value})=>row.data.recordModel===MODEL&&value.locator.recordId===id&&value.locator.field==='request'&&value.deliveryId===delivery.receipt.deliveryId).length,1);
      // The original protected delivery and send-guard headers add genuine
      // durable lifetimes, even when their declared payload has no Files.
      const priorAuthority=before.owner.file_reference_authority![0]!,nextAuthority=after.owner.file_reference_authority![0]!;
      assert.equal(after.owner.file_reference_authority!.length,1);
      assert.deepEqual({...nextAuthority,opaque_lifetimes:priorAuthority.opaque_lifetimes},priorAuthority);
      const headers=[delivery.filePayloadOrigin];
      if(enabled){const dispatch=readDispatchRow((await query(WORK_DISPATCH_MODEL)).find(value=>value.id===delivery.receipt.deliveryId)!);
        assert.ok(dispatch.filePayloadOrigin);headers.push(dispatch.filePayloadOrigin);}
      const addedLifetimes=headers.map(header=>{assert.deepEqual(header.files,[]);const {files,...binding}=header;return {binding,files:[]};});
      const priorLifetimes=JSON.parse(String(priorAuthority.opaque_lifetimes)) as unknown[];
      const nextLifetimes=JSON.parse(String(nextAuthority.opaque_lifetimes)) as unknown[];
      const sort=(values:unknown[])=>values.map(value=>JSON.stringify(value)).sort();
      assert.deepEqual(sort(nextLifetimes),sort([...priorLifetimes,...addedLifetimes]));
      assert.deepEqual(after.files, before.files); assert.deepEqual(after.intents, before.intents);
      assert.deepEqual(after.foreignFiles, before.foreignFiles); assert.deepEqual(after.foreignIntents, before.foreignIntents);
      assert.equal(after.owner.history!.length, before.owner.history!.length + 3); assert.equal(after.owner.fence_log!.length, before.owner.fence_log!.length + 1);
      const history = after.owner.history!.filter(row => !before.owner.history!.some(prior => JSON.stringify(prior) === JSON.stringify(row)));
      assert.equal(history.length,3); assert.deepEqual(after.owner.history!.filter(value=>!history.includes(value)),before.owner.history);
      assert.deepEqual(after.owner.fence_log!.filter(value=>value.revision!==revision+1),before.owner.fence_log);
      assert.deepEqual(after.owner.fence_log!.filter(value=>value.revision===revision+1),[{at:now,operation:OP,revision:revision+1}]);
      const sequences=before.owner.sqlite_sequence!,currentSequence=sequences.find(value=>value.name==='history')!.seq;
      assert.equal(typeof currentSequence,'number');
      assert.deepEqual(after.owner.sqlite_sequence,[...sequences.filter(value=>value.name!=='history'),{name:'history',seq:Number(currentSequence)+3}]
        .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
      assert.deepEqual(before.owner.fence, [{id: 1, revision}]); assert.deepEqual(after.owner.fence, [{id: 1, revision: revision + 1}]);
      assert.deepEqual([...history].sort((a, b) => Number(a.seq) - Number(b.seq)).map(value => [value.model, value.record_id]),
        [[TURN, turn.id], [BUDGET, budget.id], [MODEL, row.id]], 'new Run history remains at its last contributing source stage');
      for(const [model,id,beforeData]of [[MODEL,row.id,null],[TURN,turn.id,null],[BUDGET,budget.id,selectedBefore.data]]as const){
        const values=await native.store.historyFor(model,id),entry=values.at(-1)!; assert.equal(entry.operation,OP);
        assert.equal(entry.operationId,input.operation_id); assert.equal(entry.actor,user.user_id); assert.deepEqual(entry.before,beforeData);
        const finalRow:StoredRow=model===MODEL?row:model===TURN?turn:currentBudget;
        assert.deepEqual(entry.after,finalRow.data); assert.equal(entry.version,finalRow.version);
        assert.equal(entry.change,model===BUDGET?'update':'create');
      }
      phase(`original exact replay:index=${index}`);
      const replay = await invoke(input); assert.ok('result' in replay, JSON.stringify(replay)); assert.equal(replay.result.status, 'replayed');
      assert.deepEqual(replay.result.result, {id}); assert.deepEqual(replay.result.records, result.result.records); await unchanged(after);
      assert.deepEqual(await native.store.readReceipt(identity(input)), receipt, 'replay retains both original ordered query censuses');
      const pending = await native.store.outboxPending(); assert.equal(pending.length, enabled ? 1 : 0);
      assert.equal((await query(WORK_DISPATCH_MODEL)).length, sentBefore + (enabled ? 1 : 0)); assert.equal(requests.length, sentBefore);
      if (enabled) {
        const intent = pending[0]!; assert.equal(intent.operationId, input.operation_id); assert.equal(intent.target, 'std.EmailV1.send');
        const dispatch = readDispatchRow((await native.store.load(asModel(WORK_DISPATCH_MODEL), asId(intent.intentId)))!);
        assert.equal(dispatch.sourceGuard?.rule, guard.rule); assert.deepEqual(dispatch.sourceGuard?.inputs, {enabled: true});
        assert.equal(dispatch.attempts, 0);
        phase('original provider terminal drive:start');
        const driven = await dispatcher.drive({intentId: intent.intentId, actor: user.user_id, operation: 'native.first.Budget.Email.drive', nowMs: clock.nowMs,
          nextClaimId: () => `claim-${++sequence}`, maxClaimAgeMs: 60000, claimOperationId: nextId(), recordOperationId: nextId(), classifyFailure,
          evaluateGuard: () => {throw new Error('No legacy postclaim guard fallback');}, readStateSnapshot: () => null, fence: fenceFor(intent)});
        assert.equal(providerFailure, undefined); assert.equal(driven.status, 'recorded'); assert.equal(requests.length, sentBefore + 1);
        const terminal = readReceiptRow((await native.store.load(asModel(RECEIPT_MODEL), asId(intent.intentId)))!);
        assert.equal(terminal.receipt.status, 'succeeded'); assert.deepEqual(terminal.receipt.result, {reference: `accepted-${intent.intentId}`});
        const finalDispatch = readDispatchRow((await native.store.load(asModel(WORK_DISPATCH_MODEL), asId(intent.intentId)))!);
        assert.equal(finalDispatch.attempts, 1); assert.equal((await native.store.outboxGet(intent.intentId))!.status, 'dispatched');
        assert.deepEqual(await native.store.outboxPending(), []);
        assert.ok((await query(RECEIPT_ASSOCIATION_MODEL)).map(readAssociationRow).some(value => value.deliveryId === intent.intentId));
        const terminalResources = await resources();
        assert.deepEqual(terminalResources.foreignFiles, after.foreignFiles); assert.deepEqual(terminalResources.foreignIntents, after.foreignIntents);
        await invoke(input); await unchanged(terminalResources); assert.equal(requests.length, sentBefore + 1);
        assert.deepEqual(await native.store.readReceipt(identity(input)), receipt);
      }
      ownedRuns.push(row); if (parentRow === selectedBranch) selectedTurns.push(turn); else emptyTurns.push(turn);
    };
    for (const [index, parentRow, expectedRows, enabled] of [[0, emptyBranch, emptyTurns, false], [1, selectedBranch, selectedTurns, false],
      [2, emptyBranch, emptyTurns, true], [3, selectedBranch, selectedTurns, false]] as const) {
      await executeOriginalCase(index, parentRow, expectedRows, enabled);
    }
    // Genuine default-true sibling Runs bring the original conversation count
    // to ten without adding Turn rows or changing the source's unscoped domain.
    phase('ancestor threshold setup/refusal:start');
    const sameConversationRuns = ownedRuns.filter(row => branches.get(row.parent!.id)!.parent!.id === conversation.id && row.data.unfinished === true);
    for (let index = sameConversationRuns.length; index < 10; index++) {
      const currentBudget = await native.store.load(BUDGET, budget.id); assert.ok(currentBudget);
      const row = await create(MODEL, {parent: {id: siblingBranch.id, version: '1'}, budget: {id: currentBudget.id, version: String(currentBudget.version)}}); ownedRuns.push(row);
    }
    await rejectedWithoutEffects('ancestor threshold ten refuses before Budget/Create/SEND');
    phase('original exhausted Budget guards:start');
    // Same authenticated setup CRUD exercises the original exhausted guards;
    // all values are valid under the original invariant, never raw row edits.
    await updateBudget({running:'10'}); await rejectedWithoutEffects('parallel ceiling fails before Create/SEND', emptyBranch);
    await updateBudget({running:'4'}); const exhausted = await native.store.load(BUDGET, budget.id); assert.ok(exhausted);
    await updateBudget({spent: String(100n - BigInt(String(exhausted.data.held)))});
    await rejectedWithoutEffects('budget capacity fails before Create/SEND', emptyBranch); await updateBudget({spent:'0'});
    // A late failed require rolls back this invocation's actual two Creates, Sets,
    // SEND occurrence, delivery association and outbox before any provider drive.
    phase('original late rollback:start');
    const rejectedInput = envelope(true, false, emptyBranch), beforeReject = await resources(), rejectedRevision = await native.store.readRevision(), rejected = await invoke(rejectedInput);
    assert.ok('error' in rejected, JSON.stringify(rejected)); assert.equal(rejected.error.code, 'rule_failed');
    const rejectedReceipt = await native.store.readReceipt(identity(rejectedInput)); assert.ok(rejectedReceipt);
    assert.equal(rejectedReceipt.inputHash, await hashInputs(rejectedInput.inputs)); assert.equal(rejectedReceipt.committedRevision, rejectedRevision + 1);
    assert.deepEqual(rejectedReceipt.outcome, {status: 'rejected', code: 'rule_failed', message: rejected.error.message});
    const rejectedState = await resources(); assert.equal(requests.length, 1);
    assert.equal(rejectedState.owner.receipts!.length, beforeReject.owner.receipts!.length + 1);
    assert.deepEqual(rejectedState.owner.receipts!.filter(value => value.operation_id !== rejectedInput.operation_id), beforeReject.owner.receipts);
    assert.deepEqual(rejectedState.owner.fence, [{id: 1, revision: rejectedRevision + 1}]);
    assert.deepEqual(rejectedState.owner.fence_log!.filter(value => value.revision !== rejectedRevision + 1), beforeReject.owner.fence_log);
    assert.deepEqual(rejectedState.owner.fence_log!.filter(value => value.revision === rejectedRevision + 1), [{at: now, operation: OP, revision: rejectedRevision + 1}]);
    for (const table of Object.keys(beforeReject.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table))
      assert.deepEqual(rejectedState.owner[table], beforeReject.owner[table], table);
    assert.deepEqual(rejectedState.identity, beforeReject.identity); assert.deepEqual(rejectedState.foreign, beforeReject.foreign);
    assert.deepEqual(rejectedState.files, beforeReject.files); assert.deepEqual(rejectedState.intents, beforeReject.intents);
    assert.deepEqual(rejectedState.foreignFiles, beforeReject.foreignFiles); assert.deepEqual(rejectedState.foreignIntents, beforeReject.foreignIntents);
    const retried = await invoke(rejectedInput); assert.ok('error' in retried); assert.equal(retried.error.code, 'rule_failed'); await unchanged(rejectedState);
    assert.equal((await query(MODEL)).length, ownedRuns.length); assert.equal((await query(TURN)).length, 3 + saved.length); assert.equal((await query(WORK_DISPATCH_MODEL)).length, 1); assert.deepEqual(await native.store.outboxPending(), []);
    for (const [label, reference, code] of [
      ['stale Branch', {id: selectedBranch.id, version: '2'}, 'conflict'],
      ['wrong model', {id: conversation.id, version: '1'}, 'not_found'],
      ['foreign physical Branch', {id: foreignBranch!.id, version: '1'}, 'not_found'],
    ] as const) {
      const input: MutationEnvelope = {...envelope(false), inputs: {branch: reference, enabled: false, accept: true}}, before = await resources();
      const denied = await invoke(input); assert.ok('error' in denied, `${label}: ${JSON.stringify(denied)}`); assert.equal(denied.error.code, code);
      await unchanged(before); assert.equal(await native.store.readReceipt(identity(input)), null);
    }
    phase('current/foreign authority:start');
    const foreignBefore = await resources();
    for (const [selected, actor, code] of [[invoker, await foreign(), 'forbidden'], [foreignInvoker, await foreign(), 'not_found']] as const) {
      const denied = await selected.invokeRetainedMutation(saved[1]!.input, actor);
      assert.ok('error' in denied, JSON.stringify(denied)); assert.equal(denied.error.code, code); await unchanged(foreignBefore);
    }
    await identities.removeMembership(membership.membership_id); now += 1000;
    const revoked = await resources();
    const withheld = await invoker.invokeMutation(saved[1]!.input, admittedIdentity);
    assert.ok('result' in withheld, JSON.stringify(withheld)); assert.equal(withheld.result.status, 'replayed');
    assert.equal(withheld.result.result, null); assert.deepEqual(withheld.result.records, []); await unchanged(revoked);
    for (const {input} of saved) {
      const retainedDenied = await invoker.invokeRetainedMutation(input, admittedIdentity);
      assert.ok('error' in retainedDenied, JSON.stringify(retainedDenied)); assert.equal(retainedDenied.error.code, 'forbidden'); await unchanged(revoked);
    }
    const freshDenied = await invoker.invokeMutation(envelope(true), admittedIdentity);
    assert.ok('error' in freshDenied, JSON.stringify(freshDenied)); assert.equal(freshDenied.error.code, 'forbidden');
    const afterDenied = await resources();
    for (const table of Object.keys(revoked.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) assert.deepEqual(afterDenied.owner[table], revoked.owner[table], table);
    assert.deepEqual(afterDenied.identity, revoked.identity); assert.deepEqual(afterDenied.foreign, revoked.foreign);
    assert.deepEqual(afterDenied.files, revoked.files); assert.deepEqual(afterDenied.intents, revoked.intents);
    assert.deepEqual(afterDenied.foreignFiles, revoked.foreignFiles); assert.deepEqual(afterDenied.foreignIntents, revoked.foreignIntents);
    await identities.reactivateMembership(membership.membership_id, {is_owner: true, roles: []});
    const restored = await resources(), replay = await invoke(saved[1]!.input); assert.ok('result' in replay); assert.equal(replay.result.status, 'replayed');
    assert.deepEqual(replay.result.result, {id: saved[1]!.id}); await unchanged(restored); assert.equal(requests.length, 1);
    phase('restored current authority/saved replay:start');
    for (const savedPair of saved) {
      phase(`saved replay:operation=${savedPair.input.operation_id}`);
      const repeated = await invoker.invokeRetainedMutation(savedPair.input, await current()); assert.ok('result' in repeated, JSON.stringify(repeated));
      assert.equal(repeated.result.status, 'replayed'); assert.deepEqual(repeated.result.result, {id: savedPair.id});
      assert.deepEqual((await native.store.load(TURN, savedPair.turnId))!.data, {position: savedPair.position, run: {id: savedPair.id}}); await unchanged(restored);
    }
    for (const seeded of seededPairs) {
      assert.deepEqual(await native.store.load(MODEL, seeded.run.id), seeded.run); assert.deepEqual(await native.store.load(TURN, seeded.turn.id), seeded.turn);
    }
    assert.ok(foreignSeed); assert.deepEqual(await foreignNative.store.load(TURN, foreignSeed.turn.id), foreignSeed.turn);

    phase('original result lifetime/archive:start');
    const original = saved[0]!, originalRow = await native.store.load(MODEL, asId(original.id)); assert.ok(originalRow);
    const originalReceipt = await native.store.readReceipt(identity(original.input));
    const archived = await invoker.invokeMutation({operation: `${MODEL}.delete`, operation_id: nextId(), inputs: {record: {id: originalRow.id, version: String(originalRow.version)}}}, await current());
    assert.ok('result' in archived, JSON.stringify(archived)); assert.equal(archived.result.status, 'committed');
    assert.notEqual((await native.store.load(MODEL, originalRow.id))!.archivedAt, null);
    const lifetimeResources = await resources(), lifetimeReplay = await invoke(original.input); assert.ok('result' in lifetimeReplay, JSON.stringify(lifetimeReplay));
    assert.equal(lifetimeReplay.result.status, 'replayed'); assert.equal(lifetimeReplay.result.result, null); assert.deepEqual(lifetimeReplay.result.records, []);
    await unchanged(lifetimeResources); assert.deepEqual(await native.store.readReceipt(identity(original.input)), originalReceipt);
    phase('current source/output closure:start');
    assert.equal(hash(await readFile(source)),authoredHash); assert.equal((await readFile(source,'utf8')).replace(SETUP,''),originalText);
    for(const {path,bytes}of compilerSources)assert.deepEqual(await readFile(path),bytes);
    for(const [path,bytes]of compiledBytes)assert.deepEqual(await readFile(fileURLToPath(asm.moduleUrls[path]!)),bytes);
    assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await captureIsCurrent(capture), true);
    assert.deepEqual(await Promise.all(paths.map(async path => hash(await readFile(path)))), originals.map(hash));
  } finally {
    try {
      phase('awaited cleanup:server');
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    } finally {
      try { await physical?.close(); } finally {
        try { await foreignPhysical?.close(); } finally {
          try { phase('awaited cleanup:workerd'); await worker?.dispose(); } finally {
            try {
              phase('awaited cleanup:source closure');
              if (capture !== undefined) {
                const {captureIsCurrent} = await nodeImport(installed('dev/source-capture.js')) as typeof import('../src/dev/source-capture.js');
                assert.equal(await captureIsCurrent(capture), true, 'consumed source/output closure remains current through awaited cleanup');
              }
            } finally { await rm(directory, {recursive: true, force: true}); phase('awaited cleanup:complete'); }
          }
        }
      }
    }
  }
 });
