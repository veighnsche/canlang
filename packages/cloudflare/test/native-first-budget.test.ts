/** Original Compiler8aff first Budget consumer body, with one explicitly
 * labelled test-authored member CRUD block in owned temporary source. No tracked
 * fixture edit, raw State seed, undeclared operation or two matching accounts.
 */
import { createCheckoutScratch } from '../src/dev/checkout-scratch.js';
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
import type { CompileArtifact, ModelName, MutationEnvelope, ProviderBinding, ReceiptIdentity, StoredRow, ResolvedIdentity, ProjectedRecord } from '@canlang/contracts';
import type { InstalledMailSender } from '@canlang/services';
import type { SqliteFileStore } from '@canlang/files/host/sqlite';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const APP = 'FirstSources', MODEL = `${APP}.Run` as ModelName, BUDGET = `${APP}.Budget` as ModelName, OP = `${APP}.generate`;
const ORIGINAL_SHA256 = 'bf83e642141e4b827d02ae99e5388496d44ac3b3e87ad2c223a2fd4ec1ee2ac4';
const SETUP = ' ## BEGIN TEST-AUTHORED SETUP: authenticated Budget CRUD\n' +
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

test.each(['row', 'candidate'])('first Budget alias=%s, Sets, guarded Email and model receipt preserve lawful source authority and late rollback',
 {timeout: 240000}, async (queryAlias) => {
  const directory = await createCheckoutScratch(root, 'native-first-budget-');
  const startedAt = Date.now(), phase = (name: string) => console.info(`[native-first-budget] ${name} elapsed_ms=${Date.now() - startedAt}`);
  let worker: Miniflare | undefined, physical: SqliteFileStore | undefined;
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
    const {createD1Storage, ensureSchema} = await nodeImport(pathToFileURL(require.resolve('@canlang/state/storage/d1')).href) as typeof import('@canlang/state/storage/d1');
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
    const originalSource = join(root, 'compiler/tests/fixtures/native-first-budget.can');
    const source = join(directory, 'native-first-budget-with-labelled-setup.can');
    const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
    const paths = [originalSource, compiler, catalog], originals = await Promise.all(paths.map(path => readFile(path)));
    assert.equal(hash(originals[0]!), ORIGINAL_SHA256); assert.equal(originals[0]!.length, 1032);
    const originalText = originals[0]!.toString('utf8'); assert.equal(originalText.split('When\n').length, 2);
    const originalQuery = 'Budget as row where row.account==actor order=row.id';
    const renamedQuery = `Budget as ${queryAlias} where ${queryAlias}.account==actor order=${queryAlias}.id`;
    const authored = originalText.replace(originalQuery, renamedQuery).replace('When\n', `When\n${SETUP}`);
    assert.equal(authored.split(SETUP).length, 2);
    assert.equal(authored.replace(SETUP, '').replace(renamedQuery, originalQuery), originalText);
    await writeFile(source, authored); const authoredHash = hash(Buffer.from(authored));
    // Capture the actual augmented source and installed Values catalog using
    // the existing public capture builder; invoke the locked CLI directly as
    // this standard-library native fixture is outside Dev first-slice.
    const capture = await captureSingleFileSource(prepareLocalPreviewCapture({checkoutRoot: root, appPath: source,
      compilerPath: compiler, catalogPath: catalog, helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md')}));
    assert.equal(capture.sourceSha256, authoredHash); assert.equal(await captureIsCurrent(capture), true);
    for(const [name, path, bytes] of [['compiler', compiler, originals[1]!], ['catalog', catalog, originals[2]!]] as const){
      const input=capture.inputs.find(value=>value.name===name); assert.ok(input); assert.equal(input.state,'present');
      assert.equal(input.requestedPath,path); assert.equal(input.sha256,hash(bytes));
    }
    const env = {...process.env}; delete env.CAN_CATALOG;
    const {stdout} = await promisify(execFile)(compiler, ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, capture.compilerOperand],
      {cwd: capture.root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024});
    assert.equal(await captureIsCurrent(capture), true); assert.equal(hash(await readFile(source)), authoredHash);
    const artifact = JSON.parse(stdout) as CompileArtifact, originalArtifact = JSON.stringify(artifact);
    assert.equal(verifyCompilerSources(capture,{complete:true,sources:artifact.sources}).ok,true);
    assert.equal(artifact.sources.find(value=>resolve(capture.root,value.path)===source)?.sha256, authoredHash);
    const compilerSources=await Promise.all(artifact.sources.map(async value=>{
      const path=resolve(capture.root,value.path),bytes=await readFile(path); assert.equal(hash(bytes),value.sha256); return {path,bytes};
    }));
    const operation = artifact.operations?.find(operation => operation.name === OP); assert.ok(operation?.result?.disclosure);
    assert.equal(operation.result.type, MODEL); assert.equal(artifact.pages.length, 0);
    assert.deepEqual(artifact.operations?.filter(operation => operation.name.startsWith(`${MODEL}.`)).map(operation => operation.name), [`${MODEL}.read`]);
    assert.equal(artifact.operations?.find(operation=>operation.name===`${BUDGET}.create`)?.kind,'create');
    const plan=operation.result.disclosure; assert.equal(plan.queries?.length,1); const firstPlan=plan.queries![0]!;
    assert.equal(plan.source.sha256,authoredHash); assert.equal(resolve(capture.root,plan.source.path),source);
    assert.equal(firstPlan.model,BUDGET); assert.deepEqual(firstPlan.order,[{field:'id',direction:'asc'}]);
    assert.equal(firstPlan.limit,null); assert.equal(firstPlan.archived,'exclude'); assert.deepEqual(firstPlan.source,plan.source);
    assert.equal(firstPlan.dependencies.length,1); assert.equal(firstPlan.dependencies[0]!.field,'account');
    assert.equal(firstPlan.dependencies[0]!.type,'user'); assert.equal(firstPlan.dependencies[0]!.role,'control');
    for(const returned of plan.returns){ assert.equal(returned.projection,undefined);
      assert.deepEqual(returned.influences.map(value=>value.kind),['query-existence','query-cardinality','query-membership','query-order']);
      assert.ok(returned.influences.every(value=>value.queryId===firstPlan.id)); }
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
    assert.equal((generated.js.match(/\bfirstQuery\(/g)||[]).length,1); assert.equal((generated.js.match(/\bexecuteScenarioReceiptQuery\(/g)||[]).length,1);
    assert.doesNotMatch(generated.js,/canApp\.firstQuery|c\.canApp/);
    const compiledBytes=new Map(await Promise.all(Object.entries(asm.moduleUrls).map(async([path,url])=>[path,await readFile(fileURLToPath(url))]as const)));
    phase('source:ready; identity/setup:start');
    worker = new Miniflare({compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: {IDENTITY: 'first-budget-identity', OWNER: 'first-budget-owner', FOREIGN: 'first-budget-foreign'}, d1Persist: join(directory, 'd1')});
    const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
    const db = await worker.getD1Database('OWNER') as unknown as D1Database, foreignDb = await worker.getD1Database('FOREIGN') as unknown as D1Database;
    await ensureIdentitySchema(identityDb); await ensureSchema(db); await ensureSchema(foreignDb);
    const identities = createD1IdentityStore(identityDb, {clock}), team = await identities.createTeam({timezone: 'UTC'});
    const user = await identities.createUser({email: 'first-budget@example.test', password_hash: 'unused', email_verified: true});
    const membership = await identities.createMembership({user_id: user.user_id, team_id: team.team_id, is_owner: true, roles: []});
    // The later revocation removes this caller, while Identity must retain an owner.
    const retainedOwner = await identities.createUser({email: 'first-budget-retained-owner@example.test', password_hash: 'unused', email_verified: true});
    await identities.createMembership({user_id: retainedOwner.user_id, team_id: team.team_id, is_owner: true, roles: []});
    const foreignTeam = await identities.createTeam({timezone: 'UTC'}), foreignUser = await identities.createUser({email: 'first-budget-foreign@example.test', password_hash: 'unused', email_verified: true});
    await identities.createMembership({user_id: foreignUser.user_id, team_id: foreignTeam.team_id, is_owner: true, roles: []});
    const grant = await issueMcpGrant(identities, {user_id: user.user_id, team_id: team.team_id, client_id: 'first-budget'}, {clock});
    const foreignGrant = await issueMcpGrant(identities, {user_id: foreignUser.user_id, team_id: foreignTeam.team_id, client_id: 'first-budget-foreign'}, {clock});
    const current = () => resolveIdentity(identities, {mcp_grant_token: grant.token}, {clock});
    const foreign = () => resolveIdentity(identities, {mcp_grant_token: foreignGrant.token}, {clock});
    physical = createSqliteFileStore(join(directory, 'files.sqlite'));
    const scope = {app: APP, ownerPackage: APP, owner: team.team_id};
    const native = await createNativeFileRetirementBinding({artifact, asm, scope, identities, db, stateStoreId: 'native-first-budget', physicalSqliteFileStore: physical,
      initializeFresh: true, clock, intentTtlMs: 60000, urlBase: 'https://first-budget.invalid', retention: {unattachedHorizonMs: 120000, retentionMs: 600000}, maxRows: 100, maxReferences: 100});
    const fenceFor = await bindNativeEmailDispatchGuards({asm, artifact, store: native.store, identities, scope,
      revalidateAuthority: async () => (await identities.findTeamById(team.team_id))?.team_id === team.team_id});
    const invoker = buildInvoker(artifact, asm, native.store, {appId: APP, memberships: identities, now: clock.nowMs, ownerStorage: native.ownerStorage});
    const foreignInvoker = buildInvoker(artifact, asm, createD1Storage(foreignDb), {appId: APP, memberships: identities, now: clock.nowMs});
    const admittedIdentity = await current();
    const resources = async () => ({identity: await snapshot(identityDb), owner: await snapshot(db), foreign: await snapshot(foreignDb),
      files: physical!.files.listAll(), intents: physical!.intents.listAll()});
    const query = (model: string) => native.store.query({model: asModel(model), authority: 'owner', archived: 'include', order: [{field: 'id', direction: 'asc'}]});
    const envelope = (enabled: boolean, accept = true): MutationEnvelope => ({operation: OP, operation_id: nextId(), inputs: {enabled, accept}});
    const identity = (input: MutationEnvelope): ReceiptIdentity => ({app: APP, owner: team.team_id, principal: user.user_id, operation: asOperation(OP), operationId: asOperationId(input.operation_id)});
    const invoke = async (input: MutationEnvelope) => invoker.invokeMutation(input, await current());
    await new Promise<void>((done, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', done);});
    const address = server.address(); assert.ok(address !== null && typeof address !== 'string');
    const binding: ProviderBinding = {deployment: 'deployment.mail', capability: 'std.EmailV1', capabilityVersion: 1, account: 'local-first-budget'};
    const sender: InstalledMailSender = {binding, mail: new EmailV1Adapter({baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 2000,
      maxBodyBytes: 16384, maxTransportBytes: null, clock: {now: clock.nowMs}})};
    const adapter = createBoundMailAdapter({appDefinition: definition, binding, resolveInstalledMailSender: () => sender});
    const dispatcher = await createBoundMailDispatcher({store: native.store, adapter, workCommands: WORK_SYSTEM_COMMANDS,
      stageCommands: WORK_DISPATCH_STAGE_COMMANDS, createClaimCommand: createWorkDispatchClaimCommand});
    const unchanged = async (before: Awaited<ReturnType<typeof resources>>) => assert.deepEqual(await resources(), before);
    const rejectedWithoutEffects=async(label:string)=>{
      const input=envelope(true),before=await resources(),revision=await native.store.readRevision(),sent=requests.length;
      const refused=await invoke(input); assert.ok('error'in refused,label); assert.equal(refused.error.code,'rule_failed');
      const receipt=await native.store.readReceipt(identity(input)); assert.ok(receipt); assert.equal(receipt.outcome.status,'rejected');
      assert.equal(receipt.committedRevision,revision+1); const after=await resources();
      for(const table of Object.keys(before.owner))if(!['receipts','fence','fence_log'].includes(table))assert.deepEqual(after.owner[table],before.owner[table],label);
      assert.deepEqual(after.identity,before.identity); assert.deepEqual(after.foreign,before.foreign);
      assert.deepEqual(after.files,before.files); assert.deepEqual(after.intents,before.intents); assert.equal(requests.length,sent);
      const replay=await invoke(input); assert.ok('error'in replay); assert.equal(replay.error.code,'rule_failed'); await unchanged(after);
    };
    phase('empty query:start');
    await rejectedWithoutEffects('genuine empty query yields null before any Budget setup');
    const createBudget=async(actor:ResolvedIdentity,active=true):Promise<StoredRow>=>{
      const input:MutationEnvelope={operation:`${BUDGET}.create`,operation_id:nextId(),inputs:{account:{id:actor.actor!.user_id},cap:'100',parallel:'10',spent:'0',held:'0',running:'0',active}};
      const result=await invoker.invokeMutation(input,actor); assert.ok('result'in result,JSON.stringify(result)); assert.equal(result.result.status,'committed');
      const records=result.result.records; assert.ok(records); assert.equal(records.length,1);
      const returned=object(records[0]); assert.equal(typeof returned.id,'string');
      const row=await native.store.load(BUDGET,asId(returned.id as string)); assert.ok(row);
      assert.equal(row.version,1); assert.deepEqual(row.data.account,{id:actor.actor!.user_id}); assert.equal(row.createdBy,actor.actor!.user_id);
      const history=await native.store.historyFor(BUDGET,row.id); assert.equal(history.length,1); assert.equal(history[0]!.operation,`${BUDGET}.create`); return row;
    };
    phase('authenticated setup:start');
    const otherUser=await identities.createUser({email:'first-budget-other@example.test',password_hash:'unused',email_verified:true});
    await identities.createMembership({user_id:otherUser.user_id,team_id:team.team_id,is_owner:false,roles:[]});
    const otherGrant=await issueMcpGrant(identities,{user_id:otherUser.user_id,team_id:team.team_id,client_id:'first-budget-other'},{clock});
    const otherIdentity=await resolveIdentity(identities,{mcp_grant_token:otherGrant.token},{clock}),otherBudget=await createBudget(otherIdentity);
    await rejectedWithoutEffects('different account is policy-hidden, never a forged false candidate');
    const budget=await createBudget(admittedIdentity,false);
    // Original account:user unique is enforced by the authentic CRUD commit,
    // using Values' genuine user reference wire rather than a scalar waiver.
    phase('unique conflict:start');
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
    phase('account lock:start');
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
    const saved: Array<{input: MutationEnvelope; id: string}> = [];
    for (const enabled of [false, true]) {
      phase(`original invocation:start enabled=${enabled}`);
      const selectedBefore=await native.store.load(BUDGET,budget.id); assert.ok(selectedBefore);
      const input = envelope(enabled), before = await resources(), revision = await native.store.readRevision();
      const result = await invoke(input); assert.ok('result' in result, JSON.stringify(result)); assert.equal(result.result.status, 'committed');
      const wire = object(result.result.result); assert.deepEqual(Object.keys(wire), ['id']); assert.equal(typeof wire.id, 'string');
      const id = wire.id as string; saved.push({input, id});
      const row = await native.store.load(MODEL, asId(id)); assert.ok(row); assert.equal(row.version, 1);
      assert.equal(row.createdBy, user.user_id); assert.equal(row.parent ?? null, null); assert.ok(row.data.request !== null);
      assert.deepEqual(row.data.budget,{id:budget.id});
      const currentBudget=await native.store.load(BUDGET,budget.id); assert.ok(currentBudget);
      assert.equal(currentBudget.version,selectedBefore.version+1);
      assert.deepEqual(currentBudget.data,{...selectedBefore.data,held:String(BigInt(String(selectedBefore.data.held))+1n),running:String(BigInt(String(selectedBefore.data.running))+1n)});
      assert.deepEqual(await native.store.load(BUDGET,otherBudget.id),otherBudget,'policy-hidden other member Budget remains untouched');
      const receipt = await native.store.readReceipt(identity(input)); assert.ok(receipt); assert.equal(receipt.inputHash, await hashInputs(input.inputs));
      assert.equal(receipt.committedRevision, revision + 1); assert.equal(await native.store.readRevision(), revision + 1);
      const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
      assert.equal(association.resultType, MODEL); assert.deepEqual(association.plan, operation.result.disclosure);
      assert.deepEqual(new Set(association.changed.map(change=>`${change.model}:${change.row.id}`)),new Set([`${MODEL}:${id}`,`${BUDGET}:${budget.id}`]));
      const runChange = association.changed.find(change => change.model === MODEL)!;
      assert.deepEqual(runChange.row, row, 'physical and receipt Run retain the original Budget and delivery references');
      assert.deepEqual(runChange.row.data.budget, {id: budget.id}); assert.deepEqual(runChange.row.data.request, row.data.request);
      assert.equal(runChange.fieldTypes.budget, null); assert.equal(runChange.fieldTypes.request, null);
      assert.deepEqual(runChange.withheldFields, ['budget', 'request']);
      assert.deepEqual(association.changed.find(change=>change.model===BUDGET)!.row,currentBudget);
      assert.equal(association.queries?.length,1); const census=association.queries![0]!;
      assert.equal(census.queryId,firstPlan.id); assert.equal(census.revision,revision);
      assert.equal(census.candidates.length,1,'source read policy removes another account before predicate');
      assert.deepEqual(census.candidates[0]!.row,selectedBefore); assert.equal(census.candidates[0]!.matched,true);
      assert.deepEqual(census.selectedIndices,[0]); assert.ok(census.candidates[0]!.dependencies.includes(firstPlan.dependencies[0]!.id));
      for(const observation of association.observations.filter(value=>value.model===BUDGET))assert.deepEqual(observation.row,selectedBefore);
      assert.equal(association.calls?.length ?? 0,0); assert.equal(result.result.records?.length,2);
      const projection=object(result.result.records!.find(value=>object(value).id===id)); assert.equal(projection.id,id);
      assert.deepEqual(projection.data, {}, 'mutation projection withholds owning opaque model and delivery fields');
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
      assert.equal(after.owner.records!.length,before.owner.records!.length+(enabled?4:3));
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
      assert.equal(after.owner.history!.length, before.owner.history!.length + 2); assert.equal(after.owner.fence_log!.length, before.owner.fence_log!.length + 1);
      const history = after.owner.history!.filter(row => !before.owner.history!.some(prior => JSON.stringify(prior) === JSON.stringify(row)));
      assert.equal(history.length,2); assert.deepEqual(after.owner.history!.filter(value=>!history.includes(value)),before.owner.history);
      assert.deepEqual(after.owner.fence_log!.filter(value=>value.revision!==revision+1),before.owner.fence_log);
      assert.deepEqual(after.owner.fence_log!.filter(value=>value.revision===revision+1),[{at:now,operation:OP,revision:revision+1}]);
      const sequences=before.owner.sqlite_sequence!,currentSequence=sequences.find(value=>value.name==='history')!.seq;
      assert.equal(typeof currentSequence,'number');
      assert.deepEqual(after.owner.sqlite_sequence,[...sequences.filter(value=>value.name!=='history'),{name:'history',seq:Number(currentSequence)+2}]
        .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
      for(const [model,id,beforeData]of [[MODEL,row.id,null],[BUDGET,budget.id,selectedBefore.data]]as const){
        const values=await native.store.historyFor(model,id),entry=values.at(-1)!; assert.equal(entry.operation,OP);
        assert.equal(entry.operationId,input.operation_id); assert.equal(entry.actor,user.user_id); assert.deepEqual(entry.before,beforeData);
        const finalRow:StoredRow=model===MODEL?row:currentBudget;
        assert.deepEqual(entry.after,finalRow.data); assert.equal(entry.version,finalRow.version);
        assert.equal(entry.change,model===MODEL?'create':'update');
      }
      const replay = await invoke(input); assert.ok('result' in replay, JSON.stringify(replay)); assert.equal(replay.result.status, 'replayed');
      assert.deepEqual(replay.result.result, {id}); assert.deepEqual(replay.result.records, result.result.records); await unchanged(after);
      const pending = await native.store.outboxPending(); assert.equal(pending.length, enabled ? 1 : 0);
      assert.equal((await query(WORK_DISPATCH_MODEL)).length, enabled ? 1 : 0); assert.equal(requests.length, 0);
      if (enabled) {
        const intent = pending[0]!; assert.equal(intent.operationId, input.operation_id); assert.equal(intent.target, 'std.EmailV1.send');
        const dispatch = readDispatchRow((await native.store.load(asModel(WORK_DISPATCH_MODEL), asId(intent.intentId)))!);
        assert.equal(dispatch.sourceGuard?.rule, guard.rule); assert.deepEqual(dispatch.sourceGuard?.inputs, {enabled: true});
        assert.equal(dispatch.attempts, 0);
        phase('original provider drive:start');
        const driven = await dispatcher.drive({intentId: intent.intentId, actor: user.user_id, operation: 'native.first.Budget.Email.drive', nowMs: clock.nowMs,
          nextClaimId: () => `claim-${++sequence}`, maxClaimAgeMs: 60000, claimOperationId: nextId(), recordOperationId: nextId(), classifyFailure,
          evaluateGuard: () => {throw new Error('No legacy postclaim guard fallback');}, readStateSnapshot: () => null, fence: fenceFor(intent)});
        assert.equal(providerFailure, undefined); assert.equal(driven.status, 'recorded'); assert.equal(requests.length, 1);
        const terminal = readReceiptRow((await native.store.load(asModel(RECEIPT_MODEL), asId(intent.intentId)))!);
        assert.equal(terminal.receipt.status, 'succeeded'); assert.deepEqual(terminal.receipt.result, {reference: `accepted-${intent.intentId}`});
        const finalDispatch = readDispatchRow((await native.store.load(asModel(WORK_DISPATCH_MODEL), asId(intent.intentId)))!);
        assert.equal(finalDispatch.attempts, 1); assert.equal((await native.store.outboxGet(intent.intentId))!.status, 'dispatched');
        assert.deepEqual(await native.store.outboxPending(), []);
        assert.ok((await query(RECEIPT_ASSOCIATION_MODEL)).map(readAssociationRow).some(value => value.deliveryId === intent.intentId));
        const terminalResources = await resources(); await invoke(input); await unchanged(terminalResources); assert.equal(requests.length, 1);
        assert.deepEqual(await native.store.readReceipt(identity(input)), receipt);
      }
    }
    phase('original invocations:complete; exhausted guards:start');
    // Same authenticated setup CRUD exercises the original exhausted guards;
    // all values are valid under the original invariant, never raw row edits.
    await updateBudget({running:'10'}); await rejectedWithoutEffects('parallel ceiling fails before Create/SEND');
    await updateBudget({running:'2'}); await updateBudget({spent:'98'});
    await rejectedWithoutEffects('budget capacity fails before Create/SEND'); await updateBudget({spent:'0'});
    // A late failed require rolls back this invocation's actual Create, Sets,
    // SEND occurrence, delivery association and outbox before any provider drive.
    phase('late rollback:start');
    const rejectedInput = envelope(true, false), beforeReject = await resources(), rejected = await invoke(rejectedInput);
    assert.ok('error' in rejected, JSON.stringify(rejected)); assert.equal(rejected.error.code, 'rule_failed');
    const rejectedState = await resources(); assert.equal(requests.length, 1);
    for (const table of Object.keys(beforeReject.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table))
      assert.deepEqual(rejectedState.owner[table], beforeReject.owner[table], table);
    assert.deepEqual(rejectedState.identity, beforeReject.identity); assert.deepEqual(rejectedState.foreign, beforeReject.foreign);
    assert.deepEqual(rejectedState.files, beforeReject.files); assert.deepEqual(rejectedState.intents, beforeReject.intents);
    const retried = await invoke(rejectedInput); assert.ok('error' in retried); assert.equal(retried.error.code, 'rule_failed'); await unchanged(rejectedState);
    assert.equal((await query(MODEL)).length, 2); assert.equal((await query(WORK_DISPATCH_MODEL)).length, 1); assert.deepEqual(await native.store.outboxPending(), []);
    phase('current authority:start');
    const foreignBefore = await resources();
    for (const [selected, actor, code] of [[invoker, await foreign(), 'forbidden'], [foreignInvoker, admittedIdentity, 'not_found']] as const) {
      const denied = await selected.invokeRetainedMutation(saved[1]!.input, actor);
      assert.ok('error' in denied, JSON.stringify(denied)); assert.equal(denied.error.code, code); await unchanged(foreignBefore);
    }
    await identities.removeMembership(membership.membership_id); now += 1000;
    const revoked = await resources();
    const withheld = await invoker.invokeMutation(saved[1]!.input, admittedIdentity);
    assert.ok('result' in withheld, JSON.stringify(withheld)); assert.equal(withheld.result.status, 'replayed');
    assert.equal(withheld.result.result, null); assert.deepEqual(withheld.result.records, []); await unchanged(revoked);
    const retainedDenied = await invoker.invokeRetainedMutation(saved[1]!.input, admittedIdentity);
    assert.ok('error' in retainedDenied, JSON.stringify(retainedDenied)); assert.equal(retainedDenied.error.code, 'forbidden'); await unchanged(revoked);
    const freshDenied = await invoker.invokeMutation(envelope(true), admittedIdentity);
    assert.ok('error' in freshDenied, JSON.stringify(freshDenied)); assert.equal(freshDenied.error.code, 'forbidden');
    const afterDenied = await resources();
    for (const table of Object.keys(revoked.owner)) if (!['receipts', 'fence', 'fence_log'].includes(table)) assert.deepEqual(afterDenied.owner[table], revoked.owner[table], table);
    assert.deepEqual(afterDenied.identity, revoked.identity); assert.deepEqual(afterDenied.foreign, revoked.foreign);
    assert.deepEqual(afterDenied.files, revoked.files); assert.deepEqual(afterDenied.intents, revoked.intents);
    await identities.reactivateMembership(membership.membership_id, {is_owner: true, roles: []});
    const restored = await resources(), replay = await invoke(saved[1]!.input); assert.ok('result' in replay); assert.equal(replay.result.status, 'replayed');
    assert.deepEqual(replay.result.result, {id: saved[1]!.id}); await unchanged(restored); assert.equal(requests.length, 1);
    phase('authority:complete; lifetime/source closure:start');
    assert.equal(hash(await readFile(source)),authoredHash); assert.equal((await readFile(source,'utf8')).replace(SETUP,'').replace(renamedQuery,originalQuery),originalText);
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
      try { physical?.close(); } finally {
        try { phase('awaited cleanup:workerd'); await worker?.dispose(); } finally { await rm(directory, {recursive: true, force: true}); phase('awaited cleanup:complete'); }
      }
    }
  }
 });


test('fresh source-rule Budget CRUD uses actual caller and saved receipt projection', {timeout: 120000}, async () => {
  const directory = await createCheckoutScratch(root, 'source-crud-budget-');
  try {
    const require = createRequire(import.meta.url);
    const {distribution} = await nodeImport(pathToFileURL(require.resolve('@canlang/values/distribution')).href) as typeof import('@canlang/values/distribution');
    const {createMemoryIdentityStore, createFrozenClock} = await nodeImport(pathToFileURL(require.resolve('@canlang/identity/testing')).href) as typeof import('@canlang/identity/testing');
    const {issueMcpGrant, resolveIdentity} = await nodeImport(pathToFileURL(require.resolve('@canlang/identity')).href) as typeof import('@canlang/identity');
    const {createMemoryStorage} = await nodeImport(pathToFileURL(require.resolve('@canlang/state/storage/memory')).href) as typeof import('@canlang/state/storage/memory');
    const {uuidv7, asId} = await nodeImport(pathToFileURL(require.resolve('@canlang/state/testing/invocation/fixtures')).href) as typeof import('@canlang/state/testing/invocation/fixtures');
    const {assembleModules} = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
    const {buildInvoker} = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
    const originalSource = join(root, 'compiler/tests/fixtures/native-first-budget.can');
    const original = await readFile(originalSource); assert.equal(hash(original), ORIGINAL_SHA256);
    const source = join(directory, 'native-first-budget-crud.can');
    const authored = original.toString('utf8').replace('When\n', `When\n${SETUP}`);
    assert.equal(authored.replace(SETUP, ''), original.toString('utf8')); await writeFile(source, authored);
    const env = {...process.env}; delete env.CAN_CATALOG;
    const {stdout} = await promisify(execFile)(join(root, 'compiler/target/debug/can'),
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', fileURLToPath(distribution.catalog), source],
      {cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024});
    const artifact = JSON.parse(stdout) as CompileArtifact;
    assert.equal(artifact.sources.find(entry => resolve(root, entry.path) === source)?.sha256, hash(Buffer.from(authored)));
    const asm = await assembleModules({artifact, sourcePath: source}, {workDir: join(directory, 'modules'),
      stdlibUrl: installed('runtime/stdlib.js'), uiUrl: pathToFileURL(require.resolve('@canlang/ui')).href});
    const clock = createFrozenClock(Date.now()), identities = createMemoryIdentityStore({clock}), store = createMemoryStorage();
    const team = await identities.createTeam({timezone: 'UTC'});
    const actor = async (label: string) => {
      const user = await identities.createUser({email: `${label}@source-crud.test`, password_hash: 'unused', email_verified: true});
      await identities.createMembership({user_id: user.user_id, team_id: team.team_id, is_owner: false, roles: []});
      const grant = await issueMcpGrant(identities, {user_id: user.user_id, team_id: team.team_id, client_id: label}, {clock});
      return resolveIdentity(identities, {mcp_grant_token: grant.token}, {clock});
    };
    const firstActor = await actor('source-crud-first'), secondActor = await actor('source-crud-second');
    const invoker = buildInvoker(artifact, asm, store, {appId: APP, memberships: identities, now: clock.nowMs});
    let sequence = 0;
    const envelope = (operation: string, inputs: MutationEnvelope['inputs']): MutationEnvelope =>
      ({operation, operation_id: uuidv7(clock.nowMs(), ++sequence), inputs});
    const create = async (identity: ResolvedIdentity) => {
      const input = envelope(`${BUDGET}.create`, {account: {id: identity.actor!.user_id}, cap: '100', parallel: '2',
        spent: '0', held: '0', running: '0', active: true});
      const result = await invoker.invokeMutation(input, identity); assert.ok('result' in result, JSON.stringify(result));
      assert.equal(result.result.status, 'committed'); assert.equal(result.result.records?.length, 1);
      const record = result.result.records![0]! as ProjectedRecord; assert.deepEqual(record.data.account, {id: identity.actor!.user_id});
      assert.equal(record.data.cap, '100'); return {input, record};
    };
    const first = await create(firstActor); await create(secondActor);
    // CRUD authoring permits the update; the other account's read rule must
    // withhold its response through a fresh per-call source-policy closure.
    const hiddenInput = envelope(`${BUDGET}.update`, {record: {id: first.record.id, version: String(first.record.version)}, cap: '101'});
    const hidden = await invoker.invokeMutation(hiddenInput, secondActor); assert.ok('result' in hidden, JSON.stringify(hidden));
    assert.equal(hidden.result.status, 'committed'); assert.deepEqual(hidden.result.records, []);
    const current = await store.load(BUDGET, asId(first.record.id)); assert.ok(current); assert.equal(current.data.cap, '101');
    const revision = await store.readRevision();
    const retained = await invoker.invokeRetainedMutation(first.input, firstActor); assert.ok('result' in retained, JSON.stringify(retained));
    assert.equal(retained.result.status, 'replayed'); assert.deepEqual(retained.result.records, [first.record]);
    const hiddenReplay = await invoker.invokeRetainedMutation(hiddenInput, secondActor); assert.ok('result' in hiddenReplay, JSON.stringify(hiddenReplay));
    assert.equal(hiddenReplay.result.status, 'replayed'); assert.deepEqual(hiddenReplay.result.records, []);
    assert.equal(await store.readRevision(), revision); assert.deepEqual(await store.load(BUDGET, current.id), current);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
