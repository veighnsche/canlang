/** UNFINISHED original CanChat native consumer, resumed under Muse.
 * Original source, Files, Identity, receipt/replay assertions and 900000ms
 * timeout remain. Latest full run committed the first File-bearing ask, then
 * timed out at 900020ms before terminal/regenerate qualification.
 * Scoped guard controls pass 2/2; nominal/File controls pass 37/37. The latest
 * per-call opaque declaration reuse builds and is source-reviewed, but its
 * affected runtime result is still pending. Retained failures remain failures.
 * File-bearing positive provider dispatch remains unsupported by the installed
 * TextGeneration profile; the empty-attachment journey does not qualify it.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { ModelName, MutationEnvelope, OperationId, OperationName, ProviderBinding, ReceiptIdentity, StoredRow } from '@canlang/contracts';
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
const source = join(root, 'compiler/tests/fixtures/original-a850/CanChat.can');
const SOURCE_SHA256 = '8eb79dd397aa801d97692aa195e24ad9ee29977b4e102e7cbc35e21c9fdd0ad3';
const APP = 'CanChat';
const PROFILE = 'chat.Profile' as ModelName, ALLOWANCE = 'chat.Allowance' as ModelName;
const CONVERSATION = 'chat.Conversation' as ModelName, BRANCH = 'chat.Branch' as ModelName;
const TURN = 'chat.Turn' as ModelName, RUN = 'chat.Run' as ModelName;
const A_BYTES = new TextEncoder().encode('Original CanChat attachment A\n');
const B_BYTES = new TextEncoder().encode('Original CanChat attachment B\n');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const LOCAL_MODEL = 'local-byte-template-v1';
const localTokens = (messages: readonly {role:string;content:string}[]) =>
  new TextEncoder().encode(messages.map(message=>`<|${message.role}|>\n${message.content}\n`).join('')).length;
function object(value: unknown): Record<string, unknown> {
  assert.ok(value!==null && typeof value==='object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function localProvider() {
  const requests: {messages:{role:string;content:string}[]}[]=[];
  const server=createServer(async(request,response)=>{
    try {
      assert.equal(request.method,'POST');assert.equal(request.url,'/api/chat');
      const chunks:Uint8Array[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(input.model,LOCAL_MODEL);assert.equal(input.stream,true);assert.equal(input.options.num_predict,2048);
      assert.ok(Array.isArray(input.messages));requests.push(input);
      const line=(content:string,done:boolean,extra={})=>JSON.stringify({model:LOCAL_MODEL,
        message:{role:'assistant',content,thinking:'PRIVATE_LOCAL_THINKING'},done,...extra})+'\n';
      response.writeHead(200,{'content-type':'application/x-ndjson'});
      const first=line('Local ',false);response.write(first.slice(0,19));response.write(first.slice(19));
      response.write(line('answer.',false));
      response.end(line('',true,{done_reason:'stop',prompt_eval_count:localTokens(input.messages),eval_count:13}));
    } catch {response.writeHead(500);response.end('local model protocol refused');}
  });
  await new Promise<void>((done,fail)=>{
    server.once('error',fail);server.listen(0,'127.0.0.1',()=>{server.off('error',fail);done();});
  });
  const address=server.address();assert.ok(address && typeof address!=='string');
  return {requests,baseUrl:`http://127.0.0.1:${address.port}`,
    close:()=>new Promise<void>((done,fail)=>server.close(error=>error?fail(error):done()))};
}
function committed(outcome: MutationOutcome, status: 'committed'|'replayed' = 'committed') {
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, status);
  return outcome.result;
}
function resultId(outcome: MutationOutcome, status: 'committed'|'replayed' = 'committed') {
  const result = committed(outcome, status);
  assert.ok(result.result && typeof result.result === 'object' && !Array.isArray(result.result));
  const wire = result.result as Record<string, unknown>;
  assert.deepEqual(Object.keys(wire), ['id']);
  assert.equal(typeof wire.id, 'string');
  return wire.id as string;
}
function createdReferenceId(outcome: MutationOutcome) {
  const result = committed(outcome);
  const wire = object(result.result);
  assert.deepEqual(Object.keys(wire), ['id', 'version']);
  assert.equal(typeof wire.id, 'string');
  assert.equal(wire.version, '1', 'a newly created source model reference retains its actual version');
  return wire.id as string;
}
function createdRecordId(outcome: MutationOutcome) {
  const result = committed(outcome);
  assert.equal(result.result, null, 'CRUD has no source-declared scenario result');
  assert.ok(Array.isArray(result.records));
  assert.equal(result.records.length, 1, 'the created row must be disclosed under current access');
  const row = object(result.records[0]);
  assert.equal(typeof row.id, 'string');
  assert.equal(row.id, result.operation_id, 'the original create uses its admitted operation ID');
  return row.id as string;
}
async function tables(db: D1Database) {
  const names = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{name:string}>();
  assert.equal(names.success, true);
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const {name} of names.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true);
    result[name] = rows.results.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}

test('unchanged original CanChat retains Files and exercises original empty terminal/regenerate',
  {timeout: 900000}, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'can-native-original-chat-'));
    let worker: Miniflare|undefined, physical: SqliteFileStore|undefined, provider:Awaited<ReturnType<typeof localProvider>>|undefined;
    try {
      const {assembleModules,importVerifiedAssemblyModule} = await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const {buildInvoker} = await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const {createBoundFileHandler,createCanonicalFileBinding} = await nodeImport(installed('runtime/bound-files.js')) as typeof import('../src/runtime/bound-files.js');
      const {prepareLocalPreviewCapture} = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const {captureSingleFileSource,captureIsCurrent,verifyCompilerSources} = await nodeImport(installed('runtime/native-dev.test-support.js')) as typeof import('../src/runtime/native-dev.test-support.js');
      const {parseArtifactText} = await nodeImport(installed('runtime/artifact.js')) as typeof import('../src/runtime/artifact.js');
      const {createNativeFileRetirementBinding} = await nodeImport(installed('runtime/file-retirement.js')) as typeof import('../src/runtime/file-retirement.js');
      const {bindNativeEmailDispatchGuards,createCheckedDeliveryProgressProducer,invokeDueSourceRoutingCanonical,invokeRetainedHandlerOccurrenceCanonical} =
        await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
      const {createBoundTextGenerationAdapter} = await nodeImport(installed('runtime/bound-text-generation.js')) as typeof import('../src/runtime/bound-text-generation.js');
      const {createBoundTextGenerationDispatcher} = await nodeImport(installed('runtime/bound-dispatch.js')) as typeof import('../src/runtime/bound-dispatch.js');
      const {OllamaChatAdapter} = await nodeImport(producer('@canlang/services/models/ollama')) as typeof import('@canlang/services/models/ollama');
      const {WORK_SYSTEM_COMMANDS,WORK_DISPATCH_STAGE_COMMANDS,createWorkDispatchClaimCommand} =
        await nodeImport(producer('@canlang/work/kernel/commands')) as typeof import('@canlang/work/kernel/commands');
      const {classifyFailure} = await nodeImport(producer('@canlang/work/receipt')) as typeof import('@canlang/work/receipt');
      const {WORK_SCHEDULE_MODEL,readScheduleRow} = await nodeImport(producer('@canlang/work/kernel/tables')) as typeof import('@canlang/work/kernel/tables');
      const {readScenarioReceiptAssociation} = await nodeImport(producer('@canlang/state/invocation')) as typeof import('@canlang/state/invocation');
      const {createD1IdentityStore,ensureIdentitySchema,issueMcpGrant,resolveIdentity} = await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
      const {ensureSchema} = await nodeImport(producer('@canlang/state/storage/d1')) as typeof import('@canlang/state/storage/d1');
      const {hashInputs} = await nodeImport(producer('@canlang/state/invocation/replay')) as typeof import('@canlang/state/invocation/replay');
      const {uuidv7} = await nodeImport(producer('@canlang/state/testing/invocation/fixtures')) as typeof import('@canlang/state/testing/invocation/fixtures');
      const {createSqliteFileStore} = await nodeImport(producer('@canlang/files/host/sqlite')) as typeof import('@canlang/files/host/sqlite');
      const {createFileJourneyKernel} = await nodeImport(producer('@canlang/interfaces/uploads/kernel')) as typeof import('@canlang/interfaces/uploads/kernel');
      const {blobKeyForFile} = await nodeImport(producer('@canlang/files/finalize')) as typeof import('@canlang/files/finalize');
      const {sha256Hex} = await nodeImport(producer('@canlang/files/upload')) as typeof import('@canlang/files/upload');
      const {distribution} = await nodeImport(producer('@canlang/values/distribution')) as typeof import('@canlang/values/distribution');
      const compiler = join(root,'compiler/target/debug/can'), catalog=join(root,'packages/cloudflare/dist/native-catalog.json');
      const captureCatalog=fileURLToPath(distribution.catalog);
      const paths=[source,compiler,catalog,captureCatalog], originals=await Promise.all(paths.map(async path=>digest(await readFile(path))));
      assert.equal(originals[0],SOURCE_SHA256);
      const capture=await captureSingleFileSource(prepareLocalPreviewCapture({checkoutRoot:root,appPath:source,
        compilerPath:compiler,catalogPath:captureCatalog,helpIndexPath:join(root,'docs/specification/CONSTRUCT-HELP.md')}));
      assert.equal(capture.sourceSha256,SOURCE_SHA256);
      assert.equal(await captureIsCurrent(capture),true);
      const env={...process.env};delete env.CAN_CATALOG;
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,capture.compilerOperand],
        {cwd:capture.root,env,timeout:180000,maxBuffer:32*1024*1024});
      const artifact=parseArtifactText(stdout,source).artifact;
      assert.equal(verifyCompilerSources(capture,{complete:true,sources:artifact.sources}).ok,true);
      assert.equal(artifact.models?.length,6);assert.equal(artifact.operations?.length,18);
      const asm=await assembleModules({artifact,sourcePath:source},{workDir:join(dir,'modules'),stdlibUrl:installed('runtime/stdlib.js')});
      worker=new Miniflare({compatibilityDate:'2026-07-15',modules:true,script:'export default {fetch(){return new Response("ok")}}',
        d1Persist:join(dir,'d1'),d1Databases:{IDENTITY:'original-chat-identity',OWNER:'original-chat-owner'}});
      const identityDb=await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const ownerDb=await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(identityDb);await ensureSchema(ownerDb);
      const now=Date.parse('2026-10-12T14:00:00Z'),clock={nowMs:()=>now};let sequence=0;
      const identities=createD1IdentityStore(identityDb,{clock});
      const team=await identities.createTeam({timezone:'UTC'});
      const user=await identities.createUser({email:'original-chat@example.test',password_hash:'unused',email_verified:true});
      const membership=await identities.createMembership({team_id:team.team_id,user_id:user.user_id,is_owner:false,
        roles:[{role:'chat.ai_manager',granted_at:new Date(now).toISOString(),granted_by:user.user_id}]});
      const grant=await issueMcpGrant(identities,{team_id:team.team_id,user_id:user.user_id,client_id:'original-chat'},{clock});
      const identity=await resolveIdentity(identities,{mcp_grant_token:grant.token},{clock});
      physical=createSqliteFileStore(join(dir,'files.sqlite'));
      const retention={unattachedHorizonMs:120000,retentionMs:600000};
      const scope={app:APP,ownerPackage:'chat',owner:team.team_id};
      const native=await createNativeFileRetirementBinding({artifact,asm,scope,identities,db:ownerDb,
        stateStoreId:'native-original-canchat',physicalSqliteFileStore:physical,initializeFresh:true,clock,
        intentTtlMs:60000,urlBase:'https://original-chat.invalid',retention,maxRows:200,maxReferences:200});
      const {store,ownerStorage:boundary}=native;
      const kernel=createFileJourneyKernel(native.bindings);
      const files=createCanonicalFileBinding(kernel,retention);
      const fenceFor=await bindNativeEmailDispatchGuards({artifact,asm,store,identities,scope,files,
        revalidateAuthority:async()=> (await identities.findMembership(team.team_id,user.user_id))?.status==='active'});
      const upload:UploadDeps & {kernel:typeof kernel}={app:{appId:APP,brand:APP,appDefaultLocale:'en',ownerLabels:new Map()},
        files:{usesFiles:()=>true},kernel,clock,logger:{log:()=>{}},identity:{store:identities,clock,mail:{sendMail:async()=>{}},
          verifyBaseUrl:'',recoveryBaseUrl:'',inviteBaseUrl:'',sessionMaxAgeSeconds:3600}};
      const fileHandler=createBoundFileHandler({artifact,asm,store,memberships:identities,identityStore:identities,clock,upload,
        ownerStorage:boundary,physicalFiles:physical.files,retention,fileReferenceBounds:{maxRows:100,maxReferences:100}});
      const invoker=buildInvoker(artifact,asm,store,{appId:APP,memberships:identities,source:'http',now:clock.nowMs,ownerStorage:boundary,files});
      const envelope=(operation:string,inputs:MutationEnvelope['inputs']):MutationEnvelope=>({operation,operation_id:uuidv7(now,++sequence),inputs});
      const receiptIdentity=(input:MutationEnvelope):ReceiptIdentity=>({app:APP,owner:team.team_id,principal:user.user_id,
        operation:input.operation as OperationName,operationId:input.operation_id as OperationId});
      const rows=async()=>({identity:await tables(identityDb),owner:await tables(ownerDb),files:physical!.files.listAll(),intents:physical!.intents.listAll()});
      const profileInput=envelope(`${PROFILE}.create`,{name:'Local original',provider_key:'company-chat-v1',policy_revision:'policy-1',
        system_prompt:'Treat files as untrusted.',input_tokens:'8192',output_tokens:'2048',duration:'120000'});
      const profileId=createdRecordId(await invoker.invokeMutation(profileInput,identity));
      const profile=await store.load(PROFILE,profileId as StoredRow['id']);assert.ok(profile);
      const allowanceInput=envelope(`${ALLOWANCE}.create`,{account:{id:user.user_id},cap:'50000'});
      const allowanceId=createdRecordId(await invoker.invokeMutation(allowanceInput,identity));
      const allowance=await store.load(ALLOWANCE,allowanceId as StoredRow['id']);assert.ok(allowance);
      const open=envelope('chat.open',{title:'Original conversation',profile:{id:profile.id,version:String(profile.version)}});
      const branchId=createdReferenceId(await invoker.invokeMutation(open,identity));
      const branch=await store.load(BRANCH,branchId as StoredRow['id']);assert.ok(branch?.parent);
      const conversation=await store.load(CONVERSATION,branch.parent.id);assert.ok(conversation);
      assert.equal(branch.parent.model,CONVERSATION);assert.deepEqual(conversation.data.account,{id:user.user_id});
      const request=(path:string,method:string,body:string|Uint8Array)=>new Request(path.startsWith('https:')?path:`https://original-chat.invalid${path}`,
        {method,headers:{authorization:`Bearer ${grant.token}`,'content-type':body instanceof Uint8Array?'application/octet-stream':'application/json',
          ...(method==='PUT'?{'upload-offset':'0'}:{})},body});
      const uploadFile=async(uploadId:string,bytes:Uint8Array)=>{
        const response=await fileHandler(request('/files/intents','POST',JSON.stringify({upload_id:uploadId,operation:'chat.ask',
          field:'/attachments',arguments:{branch:{id:branch.id,version:String(branch.version)},prompt:'Original prompt'},
          name:`${uploadId}.txt`,type:'text/plain',size:String(bytes.length)})));
        assert.equal(response.status,200,await response.clone().text());
        const intent=await response.json() as {content:string;finalize:string};
        const append=await fileHandler(request(intent.content,'PUT',bytes));assert.equal(append.status,200,await append.clone().text());
        const finalized=await fileHandler(request(intent.finalize,'POST',JSON.stringify({upload_id:uploadId,bytes_digest:sha256Hex(bytes)})));
        assert.equal(finalized.status,200,await finalized.clone().text());
        const ref=(await finalized.json() as {file:string}).file;
        assert.ok(physical!.files.get(ref));assert.deepEqual(physical!.blobs.read(blobKeyForFile(ref)),bytes);
        return ref;
      };
      const refA=await uploadFile('original-chat-a',A_BYTES),refB=await uploadFile('original-chat-b',B_BYTES);
      const ordered=[{id:refB},{id:refA},{id:refB}];
      const before=await rows(),revision=await store.readRevision();
      const ask=envelope('chat.ask',{branch:{id:branch.id,version:String(branch.version)},prompt:'Original prompt',attachments:ordered});
      const runId=resultId(await invoker.invokeMutation(ask,identity));
      assert.equal(await store.readRevision(),revision+1);
      const run=await store.load(RUN,runId as StoredRow['id']);assert.ok(run);
      const turns=await store.query({model:TURN,authority:'owner'});assert.equal(turns.length,1);
      const turn=turns[0]!;assert.equal(turn.parent?.id,branch.id);
      assert.equal(turn.data.content,'Original prompt');assert.deepEqual(turn.data.attachments,ordered);
      assert.equal(run.parent?.id,branch.id);assert.equal(run.data.unfinished,true);
      const pending=await store.outboxPending();assert.equal(pending.length,1);
      assert.equal(pending[0]!.operation,'chat.ask');assert.equal(pending[0]!.target,'std.TextGenerationV1.generate');
      const receipt=await store.readReceipt(receiptIdentity(ask));assert.ok(receipt);
      assert.equal(receipt.outcome.status,'committed');assert.equal(receipt.inputHash,await hashInputs(ask.inputs));
      assert.equal(receipt.committedRevision,revision+1);
      const after=await rows();assert.deepEqual(after.identity,before.identity);assert.deepEqual(after.intents,before.intents);
      // Genuine receiving retention attaches the asked Files to the committed Turn; every other member stays identical.
      assert.deepEqual(after.files,before.files.map(entry=>({...entry,state:'attached',
        attachedRecord:`${TURN}/${turn.id}/attachments`,attachedAtMs:now})));
      assert.deepEqual(physical!.blobs.read(blobKeyForFile(refA)),A_BYTES);
      assert.deepEqual(physical!.blobs.read(blobKeyForFile(refB)),B_BYTES);
      assert.equal(resultId(await invoker.invokeRetainedMutation(ask,identity),'replayed'),runId);
      assert.deepEqual(await rows(),after);

      // The original File-bearing request is retained exactly. This profile
      // honestly refuses its attachment payload; it is not a positive File
      // generation/regenerate witness and must never strip those attachments.
      provider=await localProvider();
      const binding:ProviderBinding={deployment:'deployment.llm',capability:'std.TextGenerationV1',
        capabilityVersion:1,account:'owned-local-byte-model'};
      const model=new OllamaChatAdapter({baseUrl:provider.baseUrl,timeoutMs:120000,maxBodyBytes:16384,
        models:[LOCAL_MODEL],maxOutputTokens:2048,clock:{now:clock.nowMs}});
      const text=model.installTextGeneration({binding,profile:'company-chat-v1',policyRevision:'policy-1',
        model:LOCAL_MODEL,maxInputTokens:8192,countInputTokens:input=>localTokens(input.messages)});
      const definition=(await importVerifiedAssemblyModule(asm,artifact.modules[0]!.path,artifact) as {appDefinition:unknown}).appDefinition;
      const adapter=createBoundTextGenerationAdapter({appDefinition:definition,binding,
        resolveInstalledTextGeneration:deployment=>{assert.equal(deployment,binding.deployment);return text;}});
      assert.equal(adapter.available(pending[0]!),false,'installed profile cannot consume original TextMessage File[]');
      const progressed=await createCheckedDeliveryProgressProducer({asm,artifact,app:APP});
      const dispatcher=await createBoundTextGenerationDispatcher({store,adapter,progressed,
        workCommands:WORK_SYSTEM_COMMANDS,stageCommands:WORK_DISPATCH_STAGE_COMMANDS,createClaimCommand:createWorkDispatchClaimCommand});
      const drive=(intent:typeof pending[number])=>dispatcher.drive({intentId:intent.intentId,actor:user.user_id,
        operation:'test.original-chat.drive',nowMs:clock.nowMs,nextClaimId:()=>`claim-${++sequence}`,maxClaimAgeMs:60000,
        claimOperationId:uuidv7(now,++sequence) as OperationId,recordOperationId:uuidv7(now,++sequence) as OperationId,
        classifyFailure,evaluateGuard:()=>{throw new Error('Original SEND must use its installed native guard.');},
        readStateSnapshot:()=>null,fence:fenceFor(intent)});
      const beforeUnsupported=await rows();
      const unsupportedStartMs=Date.now();assert.equal((await drive(pending[0]!)).status,'unavailable');const unsupportedEndMs=Date.now();
      assert.equal(provider.requests.length,0);
      const afterUnsupported=await rows();
      assert.deepEqual(afterUnsupported.identity,beforeUnsupported.identity);
      assert.deepEqual(afterUnsupported.files,beforeUnsupported.files);
      assert.deepEqual(afterUnsupported.intents,beforeUnsupported.intents);
      // The receipt-free unavailable verdict commits one empty System batch: exactly one fence
      // revision plus one appended unknown fence_log entry; every other table stays byte-identical.
      const beforeFence=beforeUnsupported.owner['fence'],afterFence=afterUnsupported.owner['fence'];
      assert.equal(beforeFence.length,1);assert.equal(afterFence.length,1);
      assert.deepEqual({...afterFence[0],revision:beforeFence[0]!.revision},beforeFence[0]);
      assert.equal(afterFence[0]!.revision,(beforeFence[0]!.revision as number)+1);
      const beforeLog=beforeUnsupported.owner['fence_log'],afterLog=afterUnsupported.owner['fence_log'];
      assert.equal(afterLog.length,beforeLog.length+1);
      const remaining=[...afterLog];
      for (const prior of beforeLog) {
        const at=remaining.findIndex(row=>JSON.stringify(row)===JSON.stringify(prior));
        assert.ok(at>=0);remaining.splice(at,1);
      }
      assert.equal(remaining.length,1);
      const [entry]=remaining;
      assert.deepEqual(Object.keys(entry!).sort(),['at','operation','revision']);
      assert.equal(entry!.operation,'unknown');
      assert.equal(entry!.revision,afterFence[0]!.revision);
      assert.ok(Number.isSafeInteger(entry!.at) && (entry!.at as number)>=unsupportedStartMs && (entry!.at as number)<=unsupportedEndMs);
      assert.deepEqual({...afterUnsupported.owner,fence:beforeFence,'fence_log':beforeLog},beforeUnsupported.owner);

      // Separate full ORIGINAL empty-attachment branch, with an actual local
      // Ollama protocol/tokenizer. No authored operation, callback or progress
      // is substituted. File-bearing work above remains unfinished.
      const emptyOpen=envelope('chat.open',{title:'Original empty-attachment conversation',profile:{id:profile.id,version:String(profile.version)}});
      const emptyBranchId=createdReferenceId(await invoker.invokeMutation(emptyOpen,identity));
      const emptyBranch=await store.load(BRANCH,emptyBranchId as StoredRow['id']);assert.ok(emptyBranch?.parent);
      const emptyAsk=envelope('chat.ask',{branch:{id:emptyBranch.id,version:String(emptyBranch.version)},prompt:'Original empty prompt',attachments:[]});
      const emptyRunId=resultId(await invoker.invokeMutation(emptyAsk,identity));
      const emptyRun=await store.load(RUN,emptyRunId as StoredRow['id']);assert.ok(emptyRun);
      const question=(await store.query({model:TURN,authority:'owner'})).find(row=>row.parent?.id===emptyBranch.id);
      assert.ok(question);assert.deepEqual(question.data.attachments,[]);
      const emptyIntent=(await store.outboxPending()).find(intent=>intent.operationId===emptyAsk.operation_id);assert.ok(emptyIntent);
      assert.equal(adapter.available(emptyIntent),true);
      const generation=object(object(emptyIntent.arguments.arguments).value);
      assert.equal(generation.source,emptyAsk.operation_id);assert.equal(generation.revision,'1');
      assert.deepEqual(generation.messages,[{role:'system',content:profile.data.system_prompt,attachments:[]},
        {role:'user',content:'Original empty prompt',attachments:[]}]);
      assert.equal((await drive(emptyIntent)).status,'recorded');assert.equal(provider.requests.length,1);
      assert.deepEqual(provider.requests[0]!.messages,[{role:'system',content:profile.data.system_prompt},
        {role:'user',content:'Original empty prompt'}]);
      const expectedUsed=localTokens(provider.requests[0]!.messages)+13;
      const schedules=(await store.query({model:WORK_SCHEDULE_MODEL,authority:'owner'})).map(readScheduleRow)
        .filter(row=>object(row.payload).delivery_id===emptyIntent.intentId);
      assert.ok(schedules.length>0,'actual provider progress must publish original progressed occurrences');
      for(const occurrence of schedules){
        assert.equal(occurrence.event,'chat.LLM.generate.progressed');
        assert.equal(occurrence.scopeApp,APP);assert.equal(occurrence.scopeOwner,team.team_id);assert.equal(occurrence.scopeOwnerPackage,'chat');
        const sourceOptions={artifact,asm,app:APP,handler:'chat.reply_progressed',
          due:{key:occurrence.key,scope,occurrenceId:occurrence.occurrenceId,event:occurrence.event,at:occurrence.at},
          store,identities,now:clock.nowMs,files};
        assert.equal(object(await invokeDueSourceRoutingCanonical(sourceOptions)).status,'completed');
        const handlerOptions={artifact,asm,app:APP,selector:{sourceOccurrence:occurrence.occurrenceId,
          handler:'chat.reply_progressed',event:occurrence.event,scope},store,identities,now:clock.nowMs,files};
        assert.equal(object(await invokeRetainedHandlerOccurrenceCanonical(handlerOptions)).status,'completed');
        const settled=await rows();
        assert.equal(object(await invokeDueSourceRoutingCanonical(sourceOptions)).status,'replayed');
        assert.equal(object(await invokeRetainedHandlerOccurrenceCanonical(handlerOptions)).status,'replayed');
        assert.deepEqual(await rows(),settled);
      }
      const completedRun=await store.load(RUN,emptyRun.id);assert.ok(completedRun);
      assert.equal(completedRun.data.unfinished,false);assert.equal(completedRun.data.used,String(expectedUsed));
      const settledAllowance=await store.load(ALLOWANCE,allowance.id);assert.ok(settledAllowance);
      assert.equal(settledAllowance.data.held,'10240');assert.equal(settledAllowance.data.spent,String(expectedUsed));
      assert.equal(settledAllowance.data.running,'1');
      const originalTurns=(await store.query({model:TURN,authority:'owner'})).filter(row=>row.parent?.id===emptyBranch.id);
      assert.equal(originalTurns.length,2);const answer=originalTurns.find(row=>row.data.role==='assistant');assert.ok(answer);
      assert.equal(answer.data.content,'Local answer.');assert.equal(answer.data.position,'2');
      assert.deepEqual(answer.data.run,{id:emptyRun.id});assert.deepEqual(await store.load(TURN,question.id),question);
      const terminalSnapshot=await rows();
      assert.equal(resultId(await invoker.invokeRetainedMutation(emptyAsk,identity),'replayed'),emptyRunId);
      assert.equal((await drive(emptyIntent)).status,'not-pending');assert.equal(provider.requests.length,1);
      assert.deepEqual(await rows(),terminalSnapshot);

      const regenerate=envelope('chat.regenerate',{turn:{id:question.id,version:String(question.version)},title:'Original alternative'});
      const beforeRegenerate=await rows(),regenerateRevision=await store.readRevision();
      const childId=resultId(await invoker.invokeMutation(regenerate,identity));
      assert.equal(await store.readRevision(),regenerateRevision+1);
      const child=await store.load(RUN,childId as StoredRow['id']);assert.ok(child?.parent);
      const childBranch=await store.load(BRANCH,child.parent.id);assert.ok(childBranch);
      assert.notEqual(childBranch.id,emptyBranch.id);assert.deepEqual(childBranch.parent,emptyBranch.parent);
      assert.equal(childBranch.data.title,'Original alternative');assert.deepEqual(childBranch.data.origin,{id:question.id});
      assert.deepEqual(childBranch.data.prefix,[]);assert.deepEqual(childBranch.data.profile,emptyBranch.data.profile);
      const childTurns=(await store.query({model:TURN,authority:'owner'})).filter(row=>row.parent?.id===childBranch.id);
      assert.equal(childTurns.length,1);assert.equal(childTurns[0]!.data.content,question.data.content);
      assert.deepEqual(childTurns[0]!.data.attachments,[]);assert.deepEqual(childTurns[0]!.data.run,{id:child.id});
      const rootReceipt=await store.readReceipt(receiptIdentity(regenerate));assert.ok(rootReceipt);
      assert.equal(rootReceipt.outcome.status,'committed');assert.equal(rootReceipt.committedRevision,regenerateRevision+1);
      assert.equal(rootReceipt.inputHash,await hashInputs(regenerate.inputs));
      const association=readScenarioReceiptAssociation(rootReceipt);assert.ok(association);
      assert.equal(association.resultType,RUN);assert.equal(association.calls?.length,1);
      assert.equal(association.calls![0]!.caller,'chat.regenerate');assert.equal(association.calls![0]!.target,'chat.ask');
      assert.deepEqual(association.calls![0]!.result,{id:child.id});
      for(const [name,modelName,row] of [['chat.regenerate',BRANCH,childBranch],['chat.ask',TURN,childTurns[0]!]] as const){
        const history=await store.historyFor(modelName,row.id);assert.equal(history.length,1);
        assert.equal(history[0]!.operation,name);assert.equal(history[0]!.operationId,regenerate.operation_id);
        assert.equal(history[0]!.actor,user.user_id);assert.deepEqual(history[0]!.after,row.data);
      }
      const childHistory=await store.historyFor(RUN,child.id);assert.ok(childHistory.length>0);
      for(const entry of childHistory){assert.equal(entry.operation,'chat.ask');assert.equal(entry.operationId,regenerate.operation_id);
        assert.equal(entry.actor,user.user_id);}
      assert.deepEqual(childHistory.at(-1)!.after,child.data);
      const childPending=(await store.outboxPending()).filter(intent=>intent.operationId===regenerate.operation_id);
      assert.equal(childPending.length,1);assert.equal(childPending[0]!.operation,'chat.ask');
      assert.equal(childPending[0]!.target,'std.TextGenerationV1.generate');
      assert.equal(child.data.reserved,'10240');assert.equal(child.data.unfinished,true);
      const childAllowance=await store.load(ALLOWANCE,allowance.id);assert.ok(childAllowance);
      assert.equal(childAllowance.data.held,'20480');assert.equal(childAllowance.data.running,'2');
      assert.equal(childAllowance.data.spent,String(expectedUsed));
      assert.deepEqual(await store.load(RUN,completedRun.id),completedRun);
      assert.deepEqual(await store.load(BRANCH,emptyBranch.id),emptyBranch);
      assert.deepEqual((await store.query({model:TURN,authority:'owner'})).filter(row=>row.parent?.id===emptyBranch.id),originalTurns);
      const afterRegenerate=await rows();assert.equal(afterRegenerate.owner.receipts!.length,beforeRegenerate.owner.receipts!.length+1);
      assert.deepEqual(afterRegenerate.identity,beforeRegenerate.identity);assert.deepEqual(afterRegenerate.files,beforeRegenerate.files);
      assert.deepEqual(afterRegenerate.intents,beforeRegenerate.intents);
      const readback=await invoker.invokeRead({operation:`${RUN}.read`,inputs:{}},identity);assert.ok('result' in readback);
      const records=object(readback.result).records;assert.ok(Array.isArray(records));
      assert.ok(records.some(row=>object(row).id===child.id));assert.ok(records.some(row=>object(row).id===completedRun.id));
      assert.equal(resultId(await invoker.invokeRetainedMutation(regenerate,identity),'replayed'),child.id);
      assert.equal(provider.requests.length,1);assert.deepEqual(await rows(),afterRegenerate);

      for(const reference of [{id:answer.id,version:String(answer.version)},
        {id:question.id,version:String(question.version+1)},{id:childTurns[0]!.id,version:String(childTurns[0]!.version)}]){
        const beforeDenied=await rows();
        const denied=await invoker.invokeMutation(envelope('chat.regenerate',{turn:reference,title:'Denied original alternative'}),identity);
        assert.ok('error' in denied);const afterDenied=await rows();
        for(const key of ['records','history','outbox'] as const)assert.deepEqual(afterDenied.owner[key],beforeDenied.owner[key]);
        assert.deepEqual(afterDenied.files,beforeDenied.files);assert.deepEqual(afterDenied.intents,beforeDenied.intents);
      }
      await identities.removeMembership(membership.membership_id);
      const beforeRevoked=await rows();const revoked=await invoker.invokeRetainedMutation(regenerate,identity);
      assert.ok('error' in revoked);assert.equal(revoked.error.code,'forbidden');assert.deepEqual(await rows(),beforeRevoked);
      assert.equal(provider.requests.length,1);
      assert.deepEqual(await store.load(RUN,run.id),run);assert.deepEqual(await store.load(TURN,turn.id),turn);
      assert.deepEqual(physical.files.get(refA),after.files.find(row=>row.file.id===refA));
      assert.deepEqual(physical.blobs.read(blobKeyForFile(refA)),A_BYTES);assert.deepEqual(physical.blobs.read(blobKeyForFile(refB)),B_BYTES);
      assert.equal(await captureIsCurrent(capture),true);
      assert.deepEqual(await Promise.all(paths.map(async path=>digest(await readFile(path)))),originals);
    } finally {try {await provider?.close();} finally {try {physical?.close();} finally {try {await worker?.dispose();} finally {await rm(dir,{recursive:true,force:true});}}}}
  });
