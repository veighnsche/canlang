/** Actual original compile, installed State census, Work claim, and Files issuer. */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { ApiGraph, CompileArtifact, MutationEnvelope, OutboxIntent, ProviderBinding, WorkflowNodeMapping } from '@canlang/contracts';
import { distribution } from '@canlang/values/distribution';
import { createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity } from '@canlang/identity';
import { receiverFromIdentity } from '@canlang/interfaces';
import { createFileJourneyKernel } from '@canlang/interfaces/uploads/kernel';
import { ensureSchema } from '@canlang/state/storage/d1';
import { asId, asModel, asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { RECEIPT_MODEL, RECEIPT_ASSOCIATION_MODEL, readReceiptRow, readAssociationRow } from '@canlang/state/receipt/tables';
import { WORK_DISPATCH_MODEL, readDispatchRow, readDispatchImageCorrelation } from '@canlang/work/kernel/tables';
import { createSqliteFileStore } from '@canlang/files/host/sqlite';
import { sha256Hex } from '@canlang/files/upload';
import { blobKeyForFile } from '@canlang/files/finalize';
import { ComfyUINativeAdapter } from '@canlang/services/media/comfyui';
import { digestGraph } from '@canlang/services/media/mapping';
import type { FenceAttemptDispatchFn } from '../src/runtime/invoke.js';
const root = resolve(fileURLToPath(new URL('../../../', import.meta.url))), APP = 'NativeGenerationReceiving';
const nodeImport = compileFunction('return import(url)', ['url'], { importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
const PNG = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,1]);
async function tables(db:D1Database) {
  const names=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{name:string}>();
  assert.equal(names.success,true);const result:Record<string,Record<string,unknown>[]>={};
  for(const {name} of names.results) {
    const rows=await db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all<Record<string,unknown>>();
    assert.equal(rows.success,true);result[name]=rows.results.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
const GRAPH: ApiGraph = {
  '3': {class_type:'KSampler',inputs:{seed:42,steps:20,cfg:7,sampler_name:'euler',scheduler:'normal',denoise:1,positive:['6',0],negative:['7',0],latent_image:['5',0],model:['4',0]}},
  '4': {class_type:'CheckpointLoaderSimple',inputs:{ckpt_name:'owned-local.safetensors'}},
  '5': {class_type:'EmptyLatentImage',inputs:{width:512,height:512,batch_size:1}},
  '6': {class_type:'CLIPTextEncode',inputs:{text:'',clip:['4',1]}},
  '7': {class_type:'CLIPTextEncode',inputs:{text:'',clip:['4',1]}},
  '8': {class_type:'VAEDecode',inputs:{samples:['3',0],vae:['4',2]}},
  '9': {class_type:'SaveImage',inputs:{filename_prefix:'Owned',images:['8',0]}},
};

test('original Generation source and technical receiving progress retain one full File census in the actual fence',
 {timeout:120000}, async () => {
  const dir=await mkdtemp(join(tmpdir(),'can-native-generation-receiving-'));
  let worker: Miniflare | undefined, physical: ReturnType<typeof createSqliteFileStore> | undefined;
  let sequence=0, now=Date.now(), requests=0, active:OutboxIntent | undefined;
  let assertQueued=async ():Promise<void>=>{};
  const clock={nowMs:()=>now}, nextId=()=>asOperationId(uuidv7(now,++sequence));
  const provider=createServer(async (request,response)=>{
    const url=new URL(request.url!,'http://local');
    const json=(value:unknown)=>{response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(value));};
    if(request.method==='POST' && url.pathname==='/prompt') {
      const chunks:Uint8Array[]=[];for await(const chunk of request) chunks.push(Buffer.from(chunk));
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));requests++;
      assert.ok(active);await assertQueued();return json({prompt_id:body.prompt_id,node_errors:{}});
    }
    if(url.pathname.startsWith('/history/')) {const id=decodeURIComponent(url.pathname.slice('/history/'.length));
      return json({[id]:{status:{status_str:'success',completed:true},outputs:{'9':{images:[{filename:'image.png',subfolder:'',type:'output'}]}}}});}
    if(url.pathname==='/view'){response.writeHead(200,{'content-type':'image/png'});response.end(PNG);return;}
    response.writeHead(404);response.end();
  });
  try {
    // One installed Node loader owns assembly and every private Work command.
    const installedModule=(path:string)=>pathToFileURL(join(root,'packages/cloudflare/dist',path)).href;
    const require=createRequire(import.meta.url);
    const {assembleModules,importVerifiedAssemblyModule}=await nodeImport(installedModule('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
    const {buildInvoker}=await nodeImport(installedModule('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
    const {WORK_SYSTEM_COMMANDS,WORK_DISPATCH_STAGE_COMMANDS,createWorkDispatchClaimCommand}=
      await nodeImport(pathToFileURL(require.resolve('@canlang/work/kernel/commands')).href) as typeof import('@canlang/work/kernel/commands');
    const {attemptDispatch}=await nodeImport(pathToFileURL(require.resolve('@canlang/work/dispatch')).href) as typeof import('@canlang/work/dispatch');
    const {classifyFailure}=await nodeImport(pathToFileURL(require.resolve('@canlang/work/receipt')).href) as typeof import('@canlang/work/receipt');
    const source=join(root,'packages/cloudflare/test/fixtures/native-generation-receiving.can');
    const compiler=join(root,'compiler/target/debug/can'), catalog=fileURLToPath(distribution.catalog);
    const originals=await Promise.all([source,compiler,catalog].map(path=>readFile(path)));
    const env={...process.env};delete env.CAN_CATALOG;
    const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],
      {cwd:root,env,timeout:60000,maxBuffer:32*1024*1024});
    const artifact=JSON.parse(stdout) as CompileArtifact, bytes=JSON.stringify(artifact);
    assert.ok(artifact.sources.some(value=>resolve(value.path)===source && value.sha256===createHash('sha256').update(originals[0]!).digest('hex')));
    const asm=await assembleModules({artifact,sourcePath:source},{workDir:join(dir,'modules'),
      stdlibUrl:installedModule('runtime/stdlib.js'),uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
    const namespace=await importVerifiedAssemblyModule(asm,artifact.modules[0]!.path,artifact);
    assert.ok(namespace !== null && typeof namespace === 'object');
    const definition=Object.getOwnPropertyDescriptor(namespace,'appDefinition')!.value;
    const {createNativeFileRetirementBinding}=await nodeImport(pathToFileURL(join(root,'packages/cloudflare/dist/runtime/file-retirement.js')).href) as typeof import('../src/runtime/file-retirement.js');
    const {createBoundImagesAdapter}=await nodeImport(pathToFileURL(join(root,'packages/cloudflare/dist/runtime/bound-images.js')).href) as typeof import('../src/runtime/bound-images.js');
    const {createBoundImagesDispatcher}=await nodeImport(pathToFileURL(join(root,'packages/cloudflare/dist/runtime/bound-dispatch.js')).href) as typeof import('../src/runtime/bound-dispatch.js');
    const {createCanonicalFileBinding}=await nodeImport(pathToFileURL(join(root,'packages/cloudflare/dist/runtime/bound-files.js')).href) as typeof import('../src/runtime/bound-files.js');
    worker=new Miniflare({compatibilityDate:'2026-07-15',modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:'receiving',IDENTITY:'receiving-identity'}});
    const db=await worker.getD1Database('DB') as unknown as D1Database;
    const identityDb=await worker.getD1Database('IDENTITY') as unknown as D1Database;
    await ensureSchema(db);await ensureIdentitySchema(identityDb);
    const identities=createD1IdentityStore(identityDb,{clock}), user=await identities.createUser({email:'receiving@example.test',password_hash:'unused',email_verified:true});
    const team=await identities.createTeam({timezone:'UTC'});
    await identities.createMembership({user_id:user.user_id,team_id:team.team_id,is_owner:true,roles:[]});
    const grant=await issueMcpGrant(identities,{user_id:user.user_id,team_id:team.team_id,client_id:'native-generation'},{clock});
    const identity=()=>resolveIdentity(identities,{mcp_grant_token:grant.token},{clock});
    const receiver=receiverFromIdentity(APP,await identity()), scope={app:APP,ownerPackage:APP,owner:team.team_id};
    const retention={unattachedHorizonMs:120000,retentionMs:600000};physical=createSqliteFileStore(join(dir,'files.sqlite'));
    const resources=async()=>({state:await tables(db),identity:await tables(identityDb),files:physical!.files.listAll(),intents:physical!.intents.listAll(),
      bytes:physical!.files.listAll().map(({file})=>[file.id,physical!.blobs.read(blobKeyForFile(file.id))])});
    const native=await createNativeFileRetirementBinding({artifact,asm,scope,identities,db,stateStoreId:'native-generation-receiving',physicalSqliteFileStore:physical,
      initializeFresh:true,clock,intentTtlMs:60000,urlBase:'https://receiving.invalid',retention,maxRows:200,maxReferences:200});
    const files=createCanonicalFileBinding(createFileJourneyKernel(native.bindings),retention);
    const invoker=buildInvoker(artifact,asm,native.store,{appId:APP,memberships:identities,now:clock.nowMs,ownerStorage:native.ownerStorage,files});
    const graphBytes=new TextEncoder().encode(JSON.stringify(GRAPH)), upload=nextId();
    const intent=native.bindings.createIntent({receiver,binding:{adapter:'native-upload',deliveryId:upload,resultPath:'graph'},request:{upload_id:upload,operation:`${APP}.generate`,field:'/graph',arguments:{},name:'workflow.txt',type:'text/plain',size:String(graphBytes.length)}});
    assert.ok(intent.status==='granted'||intent.status==='duplicate');
    assert.equal(native.bindings.append(intent.intentId,receiver,graphBytes,0).status,'appended');
    assert.equal(native.bindings.complete(intent.intentId,receiver).status,'completed');
    const finalized=native.bindings.finalize({intentId:intent.intentId,retryId:upload,bytesDigest:sha256Hex(graphBytes),caller:receiver});
    assert.equal(finalized.status,'finalized');assert.ok('result' in finalized);const graph=finalized.result.file;
    const create=await invoker.invokeMutation({operation:`${APP}.Job.create`,operation_id:nextId(),inputs:{}},await identity());
    assert.ok('result' in create);assert.equal(create.result.status,'committed');
    let job=(await native.store.query({model:asModel(`${APP}.Job`),authority:'owner'}))[0]!;
    const envelope=():MutationEnvelope=>({operation:`${APP}.generate`,operation_id:nextId(),inputs:{job:{id:job.id,version:String(job.version)},graph:{id:graph},validation:digestGraph(GRAPH),prompt:'Native output',revision:String(job.version),accept:true}});
    const rejectedBase=envelope(), rejectedInput={...rejectedBase,inputs:{...rejectedBase.inputs,accept:false}};
    const physicalBefore={files:physical.files.listAll(),intents:physical.intents.listAll()};
    const beforeRejected=await resources();
    const rejected=await invoker.invokeMutation(rejectedInput,await identity());assert.ok('error' in rejected);assert.equal(rejected.error.code,'rule_failed');
    assert.deepEqual(await native.store.outboxPending(),[]);assert.deepEqual(await native.store.query({model:WORK_DISPATCH_MODEL,authority:'owner'}),[]);
    assert.deepEqual(await native.store.query({model:asModel(RECEIPT_MODEL),authority:'owner'}),[]);
    assert.deepEqual(await native.store.query({model:asModel(RECEIPT_ASSOCIATION_MODEL),authority:'owner'}),[]);
    assert.deepEqual({files:physical.files.listAll(),intents:physical.intents.listAll()},physicalBefore);assert.equal(requests,0);
    const afterRejected=await resources();
    for(const name of Object.keys(beforeRejected.state)) if(!['receipts','fence','fence_log','sqlite_sequence'].includes(name))
      assert.deepEqual(afterRejected.state[name],beforeRejected.state[name],name);
    assert.deepEqual(afterRejected.bytes,beforeRejected.bytes);
    assert.deepEqual(afterRejected.identity,beforeRejected.identity);
    const rejectedRevision=await native.store.readRevision();await invoker.invokeMutation(rejectedInput,await identity());
    assert.equal(await native.store.readRevision(),rejectedRevision);assert.deepEqual(await resources(),afterRejected);
    now=Date.now();const original=envelope();const outcome=await invoker.invokeMutation(original,await identity());assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'committed');
    active=(await native.store.outboxPending())[0]!;assert.ok(active);
    const pendingRow=(await native.store.load(asModel(RECEIPT_MODEL),asId(active.intentId)))!, pending=readReceiptRow(pendingRow);
    assert.equal(pending.receipt.result,null);assert.equal(pending.filePayloadOrigin?.origin.kind,'delivery-result');assert.deepEqual(pending.filePayloadOrigin?.files,[]);
    const dispatch=(await native.store.load(WORK_DISPATCH_MODEL,asId(active.intentId)))!, correlation=readDispatchImageCorrelation(readDispatchRow(dispatch));
    assert.deepEqual(correlation,{requestSource:job.id,requestRevision:String(job.version),requestBinding:`${APP}.Images`,requestFrom:'deployment.comfyui',requestApp:APP,requestOwner:team.team_id});
    assertQueued=async()=>{const current=readReceiptRow((await native.store.load(asModel(RECEIPT_MODEL),asId(active!.intentId)))!,adapter.resultContext(active!)!);
      assert.equal(current.receipt.status,'pending');assert.equal((current.receipt.result as {state:string}).state,'queued');assert.deepEqual(current.filePayloadOrigin!.files,[]);};
    await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));const address=provider.address();assert.ok(address && typeof address!=='string');
    const binding:ProviderBinding={capability:'std.ImagesV1',capabilityVersion:1,deployment:'deployment.comfyui',account:'owned-local'};
    const mapping:WorkflowNodeMapping={workflow:graph,graphDigest:digestGraph(GRAPH),inputs:{prompt:{node:'6',key:'text'},negative:{node:'7',key:'text'},width:{node:'5',key:'width'},height:{node:'5',key:'height'},seed:{node:'3',key:'seed'}},outputs:['9']};
    const installed=new ComfyUINativeAdapter({baseUrl:`http://127.0.0.1:${address.port}`,timeoutMs:30000,maxBodyBytes:16384,graph:GRAPH,mapping,clientId:'receiving',maxDownloadBytes:128,maxOutputs:2}).installImages({binding,
      workflow:{graph,prompt:mapping.inputs.prompt!,negative:mapping.inputs.negative!,width:mapping.inputs.width!,height:mapping.inputs.height!},seed:{kind:'fixed',value:42},maxObservationDurationMs:20000});
    let refusePhysical=false, checks=0;
    const adapter=createBoundImagesAdapter({appDefinition:definition,binding,resolveInstalledImages:()=>installed,
      finalizeOutput:async ({intent,output,resultPath,originalScope})=>{
        assert.deepEqual(originalScope,{app:receiver.app,owner:receiver.owner,principal:receiver.principal});
        return native.bindings.finalizeProviderOutput({receiver,binding:{adapter:binding.deployment,deliveryId:intent.intentId,resultPath},operation:intent.target,field:`/${resultPath}`,args:{},name:'native.png',claimedType:output.contentType,bytes:output.bytes});},
      observeOutput:async (_input,result)=>native.bindings.observeFile(result.result.file,receiver,retention),
      revalidateOutput:async saved=>{checks++;return !refusePhysical && native.bindings.revalidateFile(saved,receiver,retention);}});
    const dispatcher=await createBoundImagesDispatcher({store:native.store,fileOriginStore:native.store,adapter,
      workCommands:WORK_SYSTEM_COMMANDS,stageCommands:WORK_DISPATCH_STAGE_COMMANDS,createClaimCommand:createWorkDispatchClaimCommand});
    const drive=()=>dispatcher.drive({intentId:active!.intentId,actor:'native.Generation.progress',operation:'native.receiving.drive',nowMs:clock.nowMs,nextClaimId:()=>`claim-${++sequence}`,maxClaimAgeMs:60000,
      claimOperationId:nextId(),recordOperationId:nextId(),classifyFailure,evaluateGuard:()=>true,readStateSnapshot:()=>null,
      fence:{owner:team.team_id,attemptDispatch:attemptDispatch as FenceAttemptDispatchFn,revalidateAuthority:async()=>{const current=await identity();return current.actor?.user_id===user.user_id && current.team?.team_id===team.team_id;}}});
    await drive();assert.equal(requests,1);assert.ok(checks>0);
    const completedRow=(await native.store.load(asModel(RECEIPT_MODEL),asId(active.intentId)))!, completed=readReceiptRow(completedRow,adapter.resultContext(active)!);
    assert.equal(completed.receipt.status,'succeeded');assert.equal(completedRow.updatedBy,'native.Generation.progress');
    assert.equal(completed.filePayloadOrigin!.files.length,1);assert.deepEqual(completed.filePayloadOrigin!.files[0]!.path,['outputs',0,'image']);
    const {files:priorFiles,...priorHeader}=pending.filePayloadOrigin!, {files:actualFiles,...actualHeader}=completed.filePayloadOrigin!;
    assert.deepEqual(actualHeader,priorHeader);assert.equal(actualFiles[0]!.file.receiver.principal,user.user_id);assert.equal(actualFiles[0]!.file.provenance.kind,'request');
    assert.equal((completed.receipt.result as {outputs:{image:{id:string}}[]}).outputs[0]!.image.id,actualFiles[0]!.file.ref);
    assert.equal((await native.store.outboxGet(active.intentId))!.status,'dispatched');
    const associations=await native.store.query({model:asModel(RECEIPT_ASSOCIATION_MODEL),authority:'owner'});
    assert.ok(associations.map(readAssociationRow).some(value=>value.deliveryId===active!.intentId));
    const beforeReplay=await native.store.readRevision(), beforeReplayResources=await resources();await invoker.invokeMutation(original,await identity());await drive();
    assert.equal(requests,1);assert.equal(await native.store.readRevision(),beforeReplay);assert.deepEqual(await native.store.load(asModel(RECEIPT_MODEL),asId(active.intentId)),completedRow);
    assert.deepEqual(await resources(),beforeReplayResources);
    // Same real producer with physical final-fence refusal. A physical orphan
    // may exist, but no generated File/result can enter the receipt lifetime.
    job=(await native.store.query({model:asModel(`${APP}.Job`),authority:'owner'}))[0]!;now=Date.now();refusePhysical=true;
    const second=await invoker.invokeMutation(envelope(),await identity());assert.ok('result' in second);assert.equal(second.result.status,'committed');
    active=(await native.store.outboxPending())[0]!;const beforePhysicalChecks=checks, refusal=await drive();
    assert.ok(checks>beforePhysicalChecks,'second output reaches the genuine physical revalidation');assert.equal(requests,2);
    assert.ok(refusal.status==='recorded',JSON.stringify(refusal));assert.equal(refusal.state,'uncertain');assert.equal(refusal.attempts,1);
    assert.equal(refusal.providerOutcome.kind,'uncertain');
    const refusedDispatch=readDispatchRow((await native.store.load(WORK_DISPATCH_MODEL,asId(active.intentId)))!);
    assert.equal(refusedDispatch.state,'uncertain');assert.equal(refusedDispatch.attempts,1);
    assert.equal((await native.store.outboxGet(active.intentId))!.status,'pending');
    const refused=readReceiptRow((await native.store.load(asModel(RECEIPT_MODEL),asId(active.intentId)))!,adapter.resultContext(active)!);
    assert.notEqual(refused.receipt.status,'succeeded');assert.deepEqual(refused.filePayloadOrigin!.files,[]);
    assert.equal(refused.receipt.status,'pending');assert.equal((refused.receipt.result as {state:string}).state,'queued');
    assert.equal(JSON.stringify(artifact),bytes);
    for(const [index,path] of [source,compiler,catalog].entries()) assert.deepEqual(await readFile(path),originals[index]);
  } finally {if(provider.listening) await new Promise<void>(done=>provider.close(()=>done()));await worker?.dispose();physical?.close();await rm(dir,{recursive:true,force:true});}
 });
