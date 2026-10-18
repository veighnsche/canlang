/** Native stored File[] CALL control: original CHAT fragment plus labelled test-authored
 * member CRUD setup. This qualifies stored File[] CALL only, not full CanChat.
 * Reuse unchanged owning State stored-file and native-frame forgery/lifetime controls.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { ModelName, MutationEnvelope, OperationId, OperationName, ProjectedRecord,
  ReceiptIdentity, ResolvedIdentity, StoredRow } from '@canlang/contracts';
import type { UploadDeps } from '@canlang/interfaces';
import type { SqliteFileStore } from '@canlang/files/host/sqlite';
import type { MutationOutcome } from '../src/worker/assembly.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const require = createRequire(import.meta.url);
const nodeImport = compileFunction('return import(url)', ['url'], {
  importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
});
const installed = (path: string) => pathToFileURL(join(root, 'packages/cloudflare/dist', path)).href;
const producer = (specifier: string) => pathToFileURL(require.resolve(specifier)).href;
const APP = 'CanChat', CONVERSATION = 'chat.Conversation' as ModelName, BRANCH = 'chat.Branch' as ModelName,
  TURN = 'chat.Turn' as ModelName, RUN = 'chat.Run' as ModelName;
const fixture = join(root, 'packages/cloudflare/test/fixtures/native-stored-file-call.can');
const ORIGINAL_FRAGMENT_SHA256 = 'dc1d8cd18bd1a5792fa48fd4600c20e506245639d8530604831ef1116f147705';
// Defining Compiler589 test CHAT raw string, with only this separately labelled
// setup inserted after When. Parent and child bodies are never changed here.
const TEST_SETUP = '  ## TEST-AUTHORED SETUP ONLY: authenticated members CRUD; original CHAT fragment is preserved.\n' +
  '  crud Conversation by=members fields=title\n' +
  '  crud Branch by=members fields=title\n' +
  '  crud Turn by=members fields=content,attachments\n';
const A_BYTES = new TextEncoder().encode('%PDF-1.4\nOriginal stored CALL A bytes\ntrailer\n');
const B_BYTES = new TextEncoder().encode('%PDF-1.4\nOriginal stored CALL B bytes\ntrailer\n');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>;
}
async function tables(db: D1Database) {
  const names = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{name: string}>();
  assert.equal(names.success, true); const result: Record<string, Record<string, unknown>[]> = {};
  for (const { name } of names.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true); result[name] = rows.results.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
function committed(outcome: MutationOutcome, status: 'committed' | 'replayed' = 'committed') {
  assert.ok('result' in outcome, JSON.stringify(outcome)); assert.equal(outcome.result.status, status); return outcome.result;
}
function resultId(outcome: MutationOutcome, status: 'committed' | 'replayed' = 'committed') {
  const result = committed(outcome, status), wire = object(result.result);
  assert.deepEqual(Object.keys(wire), ['id']); assert.equal(typeof wire.id, 'string'); return wire.id as string;
}
function historySequence(before: Awaited<ReturnType<typeof tables>>, after: Awaited<ReturnType<typeof tables>>, delta: number) {
  const previous=before.sqlite_sequence!,history=previous.filter(row=>row.name==='history');assert.ok(history.length<=1);
  const sequence=history[0]?.seq ?? 0;assert.equal(typeof sequence,'number');
  assert.deepEqual(after.sqlite_sequence,[...previous.filter(row=>row.name!=='history'),{name:'history',seq:Number(sequence)+delta}]
    .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
function hold() {
  let begin!: () => void, release!: () => void;
  const started = new Promise<void>(done => { begin = done; }), released = new Promise<void>(done => { release = done; });
  return { started, begin, released, release };
}

test('labelled CHAT setup feeds original stored File[] CALL with genuine ancestor/ref/File authority, one fence and current replay',
  { timeout: 240000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'can-native-stored-file-call-'));
    let worker: Miniflare | undefined, physical: SqliteFileStore | undefined, gate: ReturnType<typeof hold> | undefined;
    let active: Promise<MutationOutcome> | undefined;
    try {
      // ALL runtime/capability and Files issuer APIs use the same installed Node
      // default loader. No Vitest module can reconstruct their private authority.
      const { assembleModules, importVerifiedAssemblyModule } = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const { buildInvoker, createTeamOwnerStorageBoundary } = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const { loadCanonicalDescriptors } = await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
      const { createBoundFileHandler, createCanonicalFileBinding } = await nodeImport(installed('runtime/bound-files.js')) as typeof import('../src/runtime/bound-files.js');
      const { prepareLocalPreviewCapture } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { captureSingleFileSource, captureIsCurrent, verifyCompilerSources } = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const { parseArtifactText } = await nodeImport(installed('runtime/artifact.js')) as typeof import('../src/runtime/artifact.js');
      const { distribution } = await nodeImport(producer('@canlang/values/distribution')) as typeof import('@canlang/values/distribution');
      const { createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity } = await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
      const { ensureSchema } = await nodeImport(producer('@canlang/state/storage/d1')) as typeof import('@canlang/state/storage/d1');
      const { createD1OwnerRouter } = await nodeImport(producer('@canlang/state/storage/owner-router')) as typeof import('@canlang/state/storage/owner-router');
      const { readScenarioReceiptAssociation, stableStringify } = await nodeImport(producer('@canlang/state/invocation')) as typeof import('@canlang/state/invocation');
      const { hashInputs } = await nodeImport(producer('@canlang/state/invocation/replay')) as typeof import('@canlang/state/invocation/replay');
      const { uuidv7 } = await nodeImport(producer('@canlang/state/testing/invocation/fixtures')) as typeof import('@canlang/state/testing/invocation/fixtures');
      const { createSqliteFileStore, createSqliteFileBindings } = await nodeImport(producer('@canlang/files/host/sqlite')) as typeof import('@canlang/files/host/sqlite');
      const { createFileJourneyKernel } = await nodeImport(producer('@canlang/interfaces/uploads/kernel')) as typeof import('@canlang/interfaces/uploads/kernel');
      const { blobKeyForFile } = await nodeImport(producer('@canlang/files/finalize')) as typeof import('@canlang/files/finalize');
      const { sha256Hex, stagingKeyForIntent } = await nodeImport(producer('@canlang/files/upload')) as typeof import('@canlang/files/upload');
      const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
      const paths = [fixture, compiler, catalog], originals = await Promise.all(paths.map(async path => digest(await readFile(path))));
      const source = await readFile(fixture, 'utf8'); assert.equal(source.split(TEST_SETUP).length, 2);
      const fragment = source.replace(TEST_SETUP, ''); assert.equal(Buffer.byteLength(fragment), 750);
      assert.equal(digest(Buffer.from(fragment)), ORIGINAL_FRAGMENT_SHA256);
      const capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root, appPath: fixture,
        compilerPath: compiler, catalogPath: catalog, helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
      assert.equal(capture.sourceSha256, originals[0]);
      for (const [name,path,hash] of [['compiler',compiler,originals[1]],['catalog',catalog,originals[2]]] as const) {
        const input = capture.inputs.find(input => input.name === name); assert.ok(input);
        assert.equal(input.state, 'present'); assert.equal(input.requestedPath, path); assert.equal(input.sha256, hash);
      }
      assert.equal(await captureIsCurrent(capture), true);
      // Original std TextMessage declaration stays outside Dev first-slice
      // admission. Compile the captured locked CLI; never relax that admission.
      const env = { ...process.env }; delete env.CAN_CATALOG;
      const { stdout } = await promisify(execFile)(compiler,
        ['compile','--format=json','--native-scenario-receipts','--catalog',catalog,capture.compilerOperand],
        { cwd: capture.root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = parseArtifactText(stdout, fixture).artifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
      assert.equal(artifact.sources.find(source => resolve(source.path) === fixture)?.sha256, originals[0]);
      assert.equal(await captureIsCurrent(capture), true);
      const asm = await assembleModules({ artifact, sourcePath: fixture }, { workDir: join(directory,'modules'), stdlibUrl: installed('runtime/stdlib.js') });
      const generated = new Map(await Promise.all(Object.entries(asm.moduleUrls).map(async ([path,url]) => [path,await readFile(fileURLToPath(url))] as const)));
      const loaded = await loadCanonicalDescriptors(asm, artifact);
      const operation = (name: string) => { const found = artifact.operations?.find(operation => operation.name === name); assert.ok(found,name); return found; };
      for (const model of [CONVERSATION,BRANCH,TURN]) assert.equal(operation(`${model}.create`).kind,'create');
      const ask = operation('chat.ask'), regenerate = operation('chat.regenerate');
      const parameter = ask.inputs.fields.find(field => field.name === 'attachments'); assert.ok(parameter);
      assert.equal(parameter.field.kind,'file'); assert.equal(parameter.valueType,'file[]');
      assert.equal(parameter.array?.required,false); assert.equal(parameter.required,false); assert.deepEqual(parameter.default,{kind:'literal',value:[]});
      const storedField = artifact.models!.find(model => model.name === TURN)!.fields.find(field => field.name === 'attachments'); assert.ok(storedField);
      assert.equal(storedField.valueType,'file[]'); assert.equal(storedField.array?.required,false); assert.equal(storedField.max,8);
      const branchInput = ask.inputs.fields.find(field => field.name === 'branch'); assert.ok(branchInput);
      assert.equal(branchInput.field.kind,'ref'); if(branchInput.field.kind!=='ref') throw new Error('Original Branch ref missing');
      assert.equal(branchInput.field.model,BRANCH); assert.equal(branchInput.required,true); assert.equal(branchInput.nullable===true,false);
      const callable = artifact.callables.find(callable => callable.id === regenerate.name); assert.ok(callable);
      const module = object(await importVerifiedAssemblyModule(asm,callable.module,artifact));
      const declaration = object(object(object(module.appDefinition).operations)[regenerate.name]);
      assert.ok(Array.isArray(declaration.callSites)); assert.equal(declaration.callSites.length,1);
      const site = object(declaration.callSites[0]); assert.deepEqual(site.targets,['chat.ask']); assert.equal(site.resultType,RUN);
      assert.deepEqual(site.source,regenerate.result!.disclosure!.source);
      const dependencies = regenerate.result!.disclosure!.returns.flatMap(returned=>returned.dependencies).filter(dependency=>dependency.type==='file[]');
      assert.ok(dependencies.length>0); const fileDependency=dependencies[0]!;
      assert.equal(fileDependency.model,TURN); assert.equal(fileDependency.field,'attachments');
      assert.ok(dependencies.every(dependency=>dependency.id===fileDependency.id));
      assert.deepEqual(site.fileInputs,[{name:'attachments',dependencyId:fileDependency.id}]);
      const emitted=artifact.modules.find(module=>module.path===callable.module)!.js;
      const marker=`await observeScenarioReceiptDependency(c,"chat.Turn",$receiptRow,"attachments",${JSON.stringify(fileDependency.id)});`;
      assert.equal(emitted.split(marker).length-1,1);
      const originalAsk=object(object(loaded.registry.get(ask.name)).descriptor); assert.deepEqual(originalAsk.result,ask.result);
      worker=new Miniflare({compatibilityDate:'2026-07-15',modules:true,script:'export default {fetch(){return new Response("ok")}}',
        d1Persist:join(directory,'d1'),d1Databases:{IDENTITY:'stored-call-identity',A:'stored-call-owner-a',B:'stored-call-owner-b'}});
      const identityDb=await worker.getD1Database('IDENTITY') as unknown as D1Database,
        a=await worker.getD1Database('A') as unknown as D1Database,b=await worker.getD1Database('B') as unknown as D1Database;
      await ensureIdentitySchema(identityDb);await ensureSchema(a);await ensureSchema(b);
      const now=Date.parse('2026-10-11T14:00:00Z'),clock={nowMs:()=>now};let sequence=0;
      const identities=createD1IdentityStore(identityDb,{clock});
      const teams=await Promise.all([identities.createTeam({timezone:'UTC'}),identities.createTeam({timezone:'UTC'})]);
      const users=await Promise.all(['reader','foreign'].map(name=>identities.createUser({email:`${name}@stored-call.example.test`,password_hash:'unused',email_verified:true})));
      const members=await Promise.all(users.map((user,index)=>identities.createMembership({team_id:teams[index]!.team_id,user_id:user.user_id,is_owner:false,roles:[]})));
      const grants=await Promise.all(users.map((user,index)=>issueMcpGrant(identities,{team_id:teams[index]!.team_id,user_id:user.user_id,client_id:'stored-file-call'},{clock})));
      const current=(index=0)=>resolveIdentity(identities,{mcp_grant_token:grants[index]!.token},{clock});
      const identity=await current(),foreignIdentity=await current(1);
      const boundary=await createTeamOwnerStorageBoundary({artifact,asm,app:APP,identities,
        router:createD1OwnerRouter({resolveBinding:scope=>scope.app===APP&&teams.some(team=>team.team_id===scope.owner)
          ? {...scope,db:scope.owner===teams[0]!.team_id?a:b,initializeFresh:true}:null})});
      const store=await boundary.forIdentity(identity),foreign=await boundary.forIdentity(foreignIdentity);
      physical=createSqliteFileStore(join(directory,'files.sqlite'));
      const genuine=createFileJourneyKernel(createSqliteFileBindings(physical,{clock,intentTtlMs:60000,urlBase:'https://stored-call.invalid'}));
      const observed:string[]=[];
      const kernel={...genuine,async observeFile(...args:Parameters<typeof genuine.observeFile>){
        observed.push(args[0]);const observation=await genuine.observeFile(...args);
        if(gate!==undefined){const held=gate;held.begin();await held.released;}return observation;
      }};
      const retention={unattachedHorizonMs:120000,retentionMs:600000};
      const upload:UploadDeps & {kernel:typeof kernel}={app:{appId:APP,brand:APP,appDefaultLocale:'en',ownerLabels:new Map()},
        files:{usesFiles:()=>true},kernel,clock,logger:{log:()=>{}},identity:{store:identities,clock,mail:{sendMail:async()=>{}},
          verifyBaseUrl:'',recoveryBaseUrl:'',inviteBaseUrl:'',sessionMaxAgeSeconds:3600}};
      const handler=createBoundFileHandler({artifact,asm,store,memberships:identities,identityStore:identities,clock,upload,
        ownerStorage:boundary,physicalFiles:physical.files,retention,fileReferenceBounds:{maxRows:100,maxReferences:100}});
      const files=createCanonicalFileBinding(kernel,retention);
      const invoker=buildInvoker(artifact,asm,store,{appId:APP,memberships:identities,source:'http',now:clock.nowMs,ownerStorage:boundary,files});
      const request=(path:string,method:string,body:string|Uint8Array)=>new Request(path.startsWith('https:')?path:`https://stored-call.invalid${path}`,
        {method,headers:{authorization:`Bearer ${grants[0]!.token}`,'content-type':body instanceof Uint8Array?'application/octet-stream':'application/json',
          ...(method==='PUT'?{'upload-offset':'0'}:{})},body});
      const uploadFile=async(uploadId:string,bytes:Uint8Array)=>{
        const response=await handler(request('/files/intents','POST',JSON.stringify({upload_id:uploadId,operation:`${TURN}.create`,
          field:'/attachments',arguments:{},name:`${uploadId}.pdf`,type:'application/pdf',size:String(bytes.length)})));
        assert.equal(response.status,200,await response.clone().text());const intent=await response.json() as {content:string;finalize:string};
        const append=await handler(request(intent.content,'PUT',bytes));assert.equal(append.status,200,await append.clone().text());
        const finalized=await handler(request(intent.finalize,'POST',JSON.stringify({upload_id:uploadId,bytes_digest:sha256Hex(bytes)})));
        assert.equal(finalized.status,200,await finalized.clone().text());const ref=(await finalized.json() as {file:string}).file;
        assert.ok(physical!.files.get(ref));assert.deepEqual(physical!.blobs.read(blobKeyForFile(ref)),bytes);return ref;
      };
      const refA=await uploadFile('stored-call-a',A_BYTES),refB=await uploadFile('stored-call-b',B_BYTES);
      const all=async()=>({identity:await tables(identityDb),owner:await tables(a),foreign:await tables(b),files:physical!.files.listAll(),
        intents:physical!.intents.listAll(),bytes:physical!.files.listAll().map(({file})=>[file.id,physical!.blobs.read(blobKeyForFile(file.id))]),
        staging:physical!.intents.listAll().map(intent=>[intent.intentId,physical!.blobs.read(stagingKeyForIntent(intent.intentId))])});
      const envelope=(operation:string,inputs:MutationEnvelope['inputs']):MutationEnvelope=>({operation,operation_id:uuidv7(now,++sequence),inputs});
      const receiptIdentity=(input:MutationEnvelope,actor:ResolvedIdentity=identity):ReceiptIdentity=>({app:APP,owner:actor.team!.team_id,
        principal:actor.actor!.user_id,operation:input.operation as OperationName,operationId:input.operation_id as OperationId});
      const create=async(model:ModelName,inputs:MutationEnvelope['inputs'],actor:ResolvedIdentity=identity):Promise<StoredRow>=>{
        const input=envelope(`${model}.create`,inputs),selected=await boundary.forIdentity(actor),revision=await selected.readRevision();
        const result=committed(await invoker.invokeMutation(input,actor));assert.equal(await selected.readRevision(),revision+1);
        const records=result.records as readonly ProjectedRecord[];assert.equal(records.length,1);
        const row=await selected.load(model,records[0]!.id);assert.ok(row);assert.equal(row.version,1);assert.equal(row.createdBy,actor.actor!.user_id);
        const receipt=await selected.readReceipt(receiptIdentity(input,actor));assert.ok(receipt);assert.equal(receipt.outcome.status,'committed');
        assert.equal(receipt.inputHash,await hashInputs(input.inputs));assert.equal(receipt.committedRevision,revision+1);
        const history=await selected.historyFor(model,row.id);assert.equal(history.length,1);assert.deepEqual(history[0]!.after,row.data);
        return row;
      };
      // Every source row, version, grant and parent is issued by real owning CRUD.
      const conversation=await create(CONVERSATION,{title:'Original conversation'});
      const branch=await create(BRANCH,{parent:{id:conversation.id,version:String(conversation.version)},title:'Original branch'});
      const ordered=[{id:refB},{id:refA},{id:refB}];
      const turn=await create(TURN,{parent:{id:branch.id,version:String(branch.version)},content:'Original stored prompt',attachments:ordered});
      const emptyTurn=await create(TURN,{parent:{id:branch.id,version:String(branch.version)},content:'Original empty prompt',attachments:[]});
      assert.deepEqual(turn.data.attachments,ordered);assert.deepEqual(emptyTurn.data.attachments,[]);
      assert.deepEqual(turn.parent,{model:BRANCH,id:branch.id});assert.deepEqual(branch.parent,{model:CONVERSATION,id:conversation.id});assert.equal(conversation.parent,null);
      const foreignConversation=await create(CONVERSATION,{title:'Foreign conversation'},foreignIdentity);
      const foreignBranch=await create(BRANCH,{parent:{id:foreignConversation.id,version:'1'},title:'Foreign branch'},foreignIdentity);
      const foreignTurn=await create(TURN,{parent:{id:foreignBranch.id,version:'1'},content:'Foreign prompt',attachments:[]},foreignIdentity);
      const rootRead=await invoker.invokeRead({operation:`${CONVERSATION}.read`,inputs:{}},identity);
      assert.ok('result' in rootRead);const rootRecords=object(rootRead.result).records;assert.ok(Array.isArray(rootRecords));
      assert.equal(rootRecords.length,1);assert.equal(object(rootRecords[0]).id,conversation.id);assert.equal(object(rootRecords[0]).parent ?? null,null);
      const retained:Array<{input:MutationEnvelope;id:string}>=[];
      for(const sourceTurn of [turn,emptyTurn]){
        const input=envelope('chat.regenerate',{turn:{id:sourceTurn.id,version:String(sourceTurn.version)},title:`Regenerated ${sourceTurn.id}`});
        const before=await all(),revision=await store.readRevision(),count=observed.length;
        const id=resultId(await invoker.invokeMutation(input,identity));retained.push({input,id});
        assert.equal(await store.readRevision(),revision+1);
        assert.deepEqual(observed.slice(count),sourceTurn===turn?[refB,refA]:[],'each distinct original File observed once, including explicit empty capture');
        const run=await store.load(RUN,id as StoredRow['id']);assert.ok(run);assert.deepEqual(run.data,{account:{id:users[0]!.user_id}});
        assert.equal(run.version,1);assert.equal(run.createdBy,users[0]!.user_id);assert.ok(run.parent);
        const createdBranch=await store.load(BRANCH,run.parent.id);assert.ok(createdBranch);
        assert.deepEqual(createdBranch.parent,{model:CONVERSATION,id:conversation.id});assert.equal(createdBranch.data.title,input.inputs.title);
        assert.equal(createdBranch.version,1);assert.equal(createdBranch.createdBy,users[0]!.user_id);
        const receipt=await store.readReceipt(receiptIdentity(input));assert.ok(receipt);assert.equal(receipt.inputHash,await hashInputs(input.inputs));
        assert.equal(receipt.committedRevision,revision+1);const association=readScenarioReceiptAssociation(receipt);assert.ok(association);
        assert.deepEqual(association.plan,regenerate.result!.disclosure);assert.equal(association.resultType,RUN);
        assert.equal(association.calls?.length,1);const call=association.calls![0]!;
        assert.equal(call.site,site.id);assert.equal(call.caller,'chat.regenerate');assert.equal(call.target,'chat.ask');assert.deepEqual(call.result,{id});
        assert.equal(call.targetInterface,stableStringify(originalAsk));assert.ok(call.scenario);assert.deepEqual(call.scenario.plan,ask.result!.disclosure);
        assert.equal(call.references.length,1);assert.equal(call.references[0]!.model,BRANCH);assert.deepEqual(call.references[0]!.row,createdBranch);
        const captured=association.observations.filter(value=>value.dependencyId===fileDependency.id);assert.equal(captured.length,1);
        assert.equal(captured[0]!.model,TURN);assert.deepEqual(captured[0]!.row,sourceTurn);assert.ok(Object.hasOwn(captured[0]!,'files'));
        assert.deepEqual(captured[0]!.files!.map(file=>file.ref),sourceTurn===turn?[refB,refA]:[]);
        for(const file of captured[0]!.files!){assert.equal(file.receiver.app,APP);assert.equal(file.receiver.owner,teams[0]!.team_id);
          assert.equal(file.receiver.team,teams[0]!.team_id);assert.equal(file.receiver.principal,users[0]!.user_id);assert.equal(file.bytesDigest,sha256Hex(file.ref===refA?A_BYTES:B_BYTES));assert.deepEqual(file.retention,retention);}
        assert.deepEqual(new Set(association.changed.map(change=>change.row.id)),new Set([createdBranch.id,run.id]));
        const parentHistory=await store.historyFor(BRANCH,createdBranch.id),childHistory=await store.historyFor(RUN,run.id);
        assert.equal(parentHistory.length,1);assert.equal(childHistory.length,1);
        for(const [history,name,row]of [[parentHistory,'chat.regenerate',createdBranch],[childHistory,'chat.ask',run]] as const){
          assert.equal(history[0]!.operation,name);assert.equal(history[0]!.operationId,input.operation_id);assert.equal(history[0]!.actor,users[0]!.user_id);
          assert.deepEqual(history[0]!.after,row.data);assert.equal(history[0]!.before,null);assert.equal(history[0]!.version,1);}
        const after=await all();for(const key of ['identity','foreign','files','intents','bytes','staging'] as const)assert.deepEqual(after[key],before[key],key);
        assert.equal(after.owner.records!.length,before.owner.records!.length+2);assert.equal(after.owner.history!.length,before.owner.history!.length+2);
        assert.equal(after.owner.receipts!.length,before.owner.receipts!.length+1);assert.equal(after.owner.fence_log!.length,before.owner.fence_log!.length+1);
        historySequence(before.owner,after.owner,2);
        assert.deepEqual(after.owner.fence_log!.filter(row=>row.revision===revision+1),[{at:now,operation:input.operation,revision:revision+1}]);
        assert.deepEqual(after.owner.fence_log!.filter(row=>row.revision!==revision+1),before.owner.fence_log);
        assert.deepEqual(after.owner.records!.filter(row=>row.id!==createdBranch.id&&row.id!==run.id),before.owner.records);
        for(const table of Object.keys(before.owner))if(!['records','history','receipts','fence','fence_log','sqlite_sequence'].includes(table))assert.deepEqual(after.owner[table],before.owner[table],table);
        assert.equal(resultId(await invoker.invokeRetainedMutation(input,identity),'replayed'),id);assert.deepEqual(await all(),after);
      }
      const admissionRefusal=async(label:string,reference:{id:string;version:string})=>{
        const input=envelope('chat.regenerate',{turn:reference,title:label}),before=await all();
        const denied=await invoker.invokeMutation(input,identity);assert.ok('error' in denied,`${label}: ${JSON.stringify(denied)}`);
        assert.deepEqual(await all(),before,label);
      };
      await admissionRefusal('stale original Turn',{id:turn.id,version:'2'});
      await admissionRefusal('wrong owning model',{id:branch.id,version:'1'});
      await admissionRefusal('foreign physical owner Turn',{id:foreignTurn.id,version:'1'});
      // Exact existing physical port: change owned temporary bytes, never forge
      // metadata/observation/source authority. The staged Branch must roll back.
      const key=blobKeyForFile(refA),bytes=physical.blobs.read(key);assert.ok(bytes);physical.blobs.remove(key);
      const physicalBefore=await all(),physicalInput=envelope('chat.regenerate',{turn:{id:turn.id,version:'1'},title:'Physical refusal'});
      const denied=await invoker.invokeMutation(physicalInput,identity);assert.ok('error' in denied);
      const rejected=await store.readReceipt(receiptIdentity(physicalInput));assert.ok(rejected);assert.equal(rejected.outcome.status,'rejected');
      const physicalAfter=await all();for(const key of ['identity','foreign','files','intents','bytes','staging'] as const)assert.deepEqual(physicalAfter[key],physicalBefore[key]);
      for(const table of Object.keys(physicalBefore.owner))if(!['receipts','fence','fence_log'].includes(table))assert.deepEqual(physicalAfter.owner[table],physicalBefore.owner[table]);
      assert.equal(physicalAfter.owner.receipts!.length,physicalBefore.owner.receipts!.length+1);assert.equal(physicalAfter.owner.fence_log!.length,physicalBefore.owner.fence_log!.length+1);
      const rejectedReplay=await invoker.invokeMutation(physicalInput,identity);assert.ok('error' in rejectedReplay);assert.deepEqual(await all(),physicalAfter);
      const withheld=committed(await invoker.invokeRetainedMutation(retained[0]!.input,identity),'replayed');
      assert.equal(withheld.result,null);assert.deepEqual(withheld.records,[]);assert.deepEqual(await all(),physicalAfter);
      physical.blobs.write(key,bytes);assert.equal(resultId(await invoker.invokeRetainedMutation(retained[0]!.input,identity),'replayed'),retained[0]!.id);
      // Revocation while the actual opaque observation awaits still prevents
      // original source admission and every staged child/resource effect.
      gate=hold();const held=gate,heldInput=envelope('chat.regenerate',{turn:{id:turn.id,version:'1'},title:'In-flight revoke'});
      active=invoker.invokeMutation(heldInput,identity);const pending=active;
      await Promise.race([held.started,pending.then(outcome=>assert.fail(`Expected actual pending File observation: ${JSON.stringify(outcome)}`))]);
      await identities.removeMembership(members[0]!.membership_id);const revoked=await all();held.release();gate=undefined;
      const inflight=await pending;active=undefined;assert.ok('error' in inflight);const afterInflight=await all();
      const heldReceipt=await store.readReceipt(receiptIdentity(heldInput));assert.ok(heldReceipt);assert.equal(heldReceipt.outcome.status,'rejected');
      assert.equal(afterInflight.owner.receipts!.length,revoked.owner.receipts!.length+1);assert.equal(afterInflight.owner.fence_log!.length,revoked.owner.fence_log!.length+1);
      for(const key of ['identity','foreign','files','intents','bytes','staging'] as const)assert.deepEqual(afterInflight[key],revoked[key]);
      for(const table of Object.keys(revoked.owner))if(!['receipts','fence','fence_log'].includes(table))assert.deepEqual(afterInflight.owner[table],revoked.owner[table]);
      for(const {input}of retained){const before=await all(),result=await invoker.invokeRetainedMutation(input,identity);assert.ok('error' in result);
        assert.equal(result.error.code,'forbidden');assert.deepEqual(await all(),before);}
      await identities.reactivateMembership(members[0]!.membership_id,{is_owner:false,roles:[]});const restored=await current(),stable=await all();
      for(const {input,id}of retained){assert.equal(resultId(await invoker.invokeRetainedMutation(input,restored),'replayed'),id);assert.deepEqual(await all(),stable);}
      assert.deepEqual(await store.load(TURN,turn.id),turn);assert.deepEqual(await store.load(TURN,emptyTurn.id),emptyTurn);
      assert.deepEqual(await foreign.load(TURN,foreignTurn.id),foreignTurn);
      assert.equal((await store.query({model:RUN,authority:'owner'})).length,2);assert.deepEqual(await foreign.query({model:RUN,authority:'owner'}),[]);
      assert.equal(JSON.stringify(artifact),originalArtifact);assert.equal(await captureIsCurrent(capture),true);
      assert.deepEqual(await Promise.all(paths.map(async path=>digest(await readFile(path)))),originals);
      for(const [path,bytes]of generated)assert.deepEqual(await readFile(fileURLToPath(asm.moduleUrls[path]!)),bytes);
    } finally {gate?.release();await active?.catch(()=>{});try {physical?.close();} finally {try {await worker?.dispose();} finally {await rm(directory,{recursive:true,force:true});}}}
  });
