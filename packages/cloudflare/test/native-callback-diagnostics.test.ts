/** New finite Dev integration witness; original Chat/Creative acceptance remains separate. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, PageReadScope, ProviderBinding, RowView } from '@canlang/contracts';
import { distribution } from '@canlang/values/distribution';
import { StateError } from '@canlang/state/errors';
import { ensureSchema, createD1Storage } from '@canlang/state/storage/d1';
import { asId, asModel, asOperationId, FIXED_NOW, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { associationRowId, readAssociationRow, readReceiptRow, RECEIPT_ASSOCIATION_MODEL, RECEIPT_MODEL } from '@canlang/state/receipt/tables';
import { buildSessionCookie, createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { handlePageRequest, type PageHttpDeps } from '@canlang/interfaces';
import { assembleModules, importVerifiedAssemblyModule } from '@canlang/cloudflare/runtime/modules';
import { assembleWorker } from '@canlang/cloudflare/worker/assembly';
import { invokeMutationCanonical, invokeDueSourceRoutingCanonical, invokeRetainedHandlerOccurrenceCanonical, createCheckedDeliveryProgressProducer } from '@canlang/cloudflare/runtime/invoke';
import type { FenceAttemptDispatchFn } from '@canlang/cloudflare/runtime/invoke';
import { createBoundTextGenerationAdapter } from '@canlang/cloudflare/runtime/bound-text-generation';
import { createBoundTextGenerationDispatcher, resolveGenerationCallbackOrigin } from '@canlang/cloudflare/runtime/bound-dispatch';
import { OllamaChatAdapter } from '@canlang/services/models/ollama';
import { WORK_SYSTEM_COMMANDS, WORK_DISPATCH_STAGE_COMMANDS, createWorkDispatchClaimCommand } from '@canlang/work/kernel/commands';
import { WORK_SCHEDULE_MODEL, WORK_DISPATCH_MODEL, WORK_OCCURRENCE_MODEL, readScheduleRow, readOccurrenceRow, readDispatchImageCorrelation } from '@canlang/work/kernel/tables';
import { handlerOccurrenceRowId, WORK_HANDLER_OCCURRENCE_MODEL, readHandlerOccurrenceRow } from '@canlang/work/kernel/handler-occurrence';
import { attemptDispatch } from '@canlang/work/dispatch';
import { classifyFailure } from '@canlang/work/receipt';
import type { DueScheduleInput } from '@canlang/work/kernel/schedule-staging';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const app = 'CallbackDiagnostics', model = asModel(`${app}.Job`), localModel = 'local-byte-template-v1';
const tokens = (messages: readonly {role:string;content:string}[]) =>
  new TextEncoder().encode(messages.map(value => `<|${value.role}|>\n${value.content}\n`).join('')).length;
async function localProvider() {
  const requests: unknown[] = [];
  const server = createServer(async (request,response) => {
    try {
      assert.equal(request.method,'POST');assert.equal(request.url,'/api/chat');
      const chunks: Uint8Array[] = [];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(input.model,localModel);assert.equal(input.stream,true);assert.equal(input.options.num_predict,128);
      requests.push(input);
      const line = (content:string,done:boolean,extra={}) => JSON.stringify({model:localModel,
        message:{role:'assistant',content,thinking:'PRIVATE_THINKING'},done,...extra})+'\n';
      response.writeHead(200,{'content-type':'application/x-ndjson'});
      response.write(line('Local answer.',false));
      response.end(line('',true,{done_reason:'stop',prompt_eval_count:tokens(input.messages),eval_count:13}));
    } catch {response.writeHead(500);response.end('local protocol refused');}
  });
  await new Promise<void>(done => server.listen(0,'127.0.0.1',done));
  const address=server.address();assert.ok(address && typeof address!=='string');
  return {requests,baseUrl:`http://127.0.0.1:${address.port}`,
    close:()=>new Promise<void>((done,fail)=>server.close(error=>error?fail(error):done()))};
}
async function snapshot(db:D1Database) {
  const tables=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{name:string}>();
  assert.equal(tables.success,true);const result:Record<string,readonly Record<string,unknown>[]>={};
  for(const {name} of tables.results){
    const rows=await db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all<Record<string,unknown>>();
    assert.equal(rows.success,true);result[name]=rows.results.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
type Observer = NonNullable<PageReadScope['observeGenerationCallbackDiagnostics']>;

test('genuine native callback history retains failed Work evidence and uses current source-authorized page reads',
  {timeout:120000},async()=>{
    const source=join(root,'packages/cloudflare/test/fixtures/native-callback-diagnostics.can');
    const owning=join(root,'compiler/tests/fixtures/callback-diagnostics.can');
    const compiler=join(root,'compiler/target/debug/can'),catalog=fileURLToPath(distribution.catalog);
    const paths=[source,owning,compiler,catalog],hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
    const captured=await Promise.all(paths.map(async path=>hash(await readFile(path))));
    const owningBytes=await readFile(owning,'utf8');
    assert.equal(await readFile(source,'utf8'),owningBytes.replace('When\n',
      'When\n crud Job by=members fields=label\n'));
    const dir=await mkdtemp(join(tmpdir(),'can-native-callback-diagnostics-'));
    let worker:Miniflare|undefined,provider:Awaited<ReturnType<typeof localProvider>>|undefined;
    let sequence=0;const clock={nowMs:()=>FIXED_NOW};
    try {
      const env={...process.env};delete env.CAN_CATALOG;
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,source],
        {cwd:root,env,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact,artifactBytes=JSON.stringify(artifact);
      assert.ok(artifact.sources.some(value=>resolve(value.path)===source && value.sha256===captured[0]));
      assert.equal(artifact.pages?.length,1);
      const asm=await assembleModules({artifact,sourcePath:source},{workDir:join(dir,'modules'),
        stdlibUrl:import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),uiUrl:import.meta.resolve('@canlang/ui')});
      const checked=await importVerifiedAssemblyModule(asm,artifact.modules[0]!.path,artifact);
      assert.ok(typeof checked==='object' && checked!==null && 'appDefinition' in checked);
      const appDefinition=checked.appDefinition;
      assert.ok(typeof appDefinition==='object' && appDefinition!==null);
      worker=new Miniflare({compatibilityDate:'2026-07-15',modules:true,script:'export default {fetch(){return new Response("ok")}}',
        d1Databases:{STATE:'native-callback-state',IDENTITY:'native-callback-identity'},d1Persist:join(dir,'d1')});
      const db=await worker.getD1Database('STATE') as unknown as D1Database;
      const idDb=await worker.getD1Database('IDENTITY') as unknown as D1Database;
      await ensureSchema(db);await ensureIdentitySchema(idDb);
      const identities=createD1IdentityStore(idDb,{clock}),team=await identities.createTeam({timezone:'UTC'});
      const owner=await identities.createUser({email:'callback-owner@example.test',password_hash:'unused',email_verified:true});
      const member=await identities.createUser({email:'callback-member@example.test',password_hash:'unused',email_verified:true});
      const ownerMembership=await identities.createMembership({team_id:team.team_id,user_id:owner.user_id,is_owner:true,roles:[]});
      const memberMembership=await identities.createMembership({team_id:team.team_id,user_id:member.user_id,is_owner:false,roles:[]});
      const replacementOwner = await identities.createUser({ email: 'replacement-owner@callback.example.test', password_hash: 'unused', email_verified: true });
      await identities.createMembership({ team_id: team.team_id, user_id: replacementOwner.user_id, is_owner: true, roles: [] });
      const session=async(userId:string,token:string)=>{
        await identities.createSession({user_id:userId,token_sha256:await sha256HexText(token),
          expires_at:new Date(FIXED_NOW+3600000).toISOString(),last_team_id:team.team_id});
        return resolveIdentity(identities,{session_token:token},{clock});
      };
      const ownerToken='native-callback-owner',memberToken='native-callback-member';
      const identity=await session(owner.user_id,ownerToken),memberIdentity=await session(member.user_id,memberToken);
      assert.equal(identity.actor?.user_id,owner.user_id);assert.equal(identity.team?.team_id,team.team_id);
      const store=createD1Storage(db),resources=async()=>({state:await snapshot(db),identity:await snapshot(idDb),requests:provider?.requests.length??0});
      const base={artifact,asm,app,identity,source:'worker',store,memberships:identities,now:clock.nowMs};
      const nextId=()=>uuidv7(FIXED_NOW,++sequence);
      const jobId=nextId(),emptyId=nextId();
      assert.equal((await invokeMutationCanonical({...base,operation:`${model}.create`,operationId:jobId,inputs:{label:'visible'}})).status,'committed');
      assert.equal((await invokeMutationCanonical({...base,operation:`${model}.create`,operationId:emptyId,inputs:{label:'visible'}})).status,'committed');
      const generate={...base,operation:`${app}.generate`,operationId:nextId(),inputs:{job:{id:jobId,version:'1'},prompt:'Local callback witness'}};
      assert.equal((await invokeMutationCanonical(generate)).status,'committed');
      const intent=(await store.outboxPending()).find(value=>value.operationId===generate.operationId);assert.ok(intent);
      const associated=await store.load(asModel(RECEIPT_ASSOCIATION_MODEL),asId(associationRowId(model,jobId,'request')));assert.ok(associated);
      const association=readAssociationRow(associated);assert.equal(association.deliveryId,intent.intentId);assert.equal(association.source,intent.target);
      const originalHistory=await store.historyFor(model,asId(jobId));assert.deepEqual(originalHistory.map(entry=>entry.version),[1,2]);
      const generated=await resources();assert.equal((await invokeMutationCanonical(generate)).status,'replayed');
      assert.deepEqual(await resources(),generated);
      provider=await localProvider();
      const binding:ProviderBinding={deployment:'deployment.llm',capability:'std.TextGenerationV1',capabilityVersion:1,account:'owned-local-byte-model'};
      const local=new OllamaChatAdapter({baseUrl:provider.baseUrl,timeoutMs:30000,maxBodyBytes:16384,models:[localModel],maxOutputTokens:128,clock:{now:clock.nowMs}});
      const installed=local.installTextGeneration({binding,profile:'local-chat',policyRevision:'policy-1',model:localModel,maxInputTokens:1024,
        countInputTokens:input=>tokens(input.messages)});
      const adapter=createBoundTextGenerationAdapter({appDefinition,binding,
        resolveInstalledTextGeneration:deployment=>{assert.equal(deployment,binding.deployment);return installed;}});
      const progressed=await createCheckedDeliveryProgressProducer({asm,artifact,app});
      const dispatcher=await createBoundTextGenerationDispatcher({store,adapter,progressed,workCommands:WORK_SYSTEM_COMMANDS,
        stageCommands:WORK_DISPATCH_STAGE_COMMANDS,createClaimCommand:createWorkDispatchClaimCommand});
      const drive=()=>dispatcher.drive({intentId:intent.intentId,actor:owner.user_id,operation:'test.callback.drive',nowMs:clock.nowMs,
        nextClaimId:()=>`claim-${++sequence}`,maxClaimAgeMs:60000,claimOperationId:asOperationId(nextId()),recordOperationId:asOperationId(nextId()),
        classifyFailure,evaluateGuard:()=>true,readStateSnapshot:()=>null,
        fence:{owner:team.team_id,attemptDispatch:attemptDispatch as FenceAttemptDispatchFn,
          revalidateAuthority:async()=> (await identities.findMembership(team.team_id,owner.user_id))?.status==='active'}});
      assert.equal((await drive()).status,'recorded');assert.equal(provider.requests.length,1);
      const progressedAssociationRow=await store.load(asModel(RECEIPT_ASSOCIATION_MODEL),associated.id);assert.ok(progressedAssociationRow);
      const progressedAssociation=readAssociationRow(progressedAssociationRow);
      assert.deepEqual(progressedAssociation.locator,association.locator);
      assert.deepEqual(association.locator,{recordId:jobId,field:'request'});
      assert.equal(associated.data.recordModel,model);assert.equal(progressedAssociationRow.data.recordModel,associated.data.recordModel);
      assert.equal(progressedAssociation.deliveryId,association.deliveryId);
      assert.equal(progressedAssociation.source,association.source);
      assert.equal(progressedAssociationRow.id,associated.id);
      assert.ok(progressedAssociationRow.version>associated.version);
      assert.ok(progressedAssociation.revision>association.revision,'actual provider progress advances the association checkpoint');
      const receipt=await store.load(asModel(RECEIPT_MODEL),asId(intent.intentId));assert.ok(receipt);
      const context=adapter.resultContext(intent);assert.ok(context);
      assert.equal(readReceiptRow(receipt,context).receipt.status,'succeeded');
      const dispatch=await store.load(WORK_DISPATCH_MODEL,asId(intent.intentId));assert.ok(dispatch);
      assert.equal(readDispatchImageCorrelation(dispatch.data)?.requestRevision,'1');
      const origin=await resolveGenerationCallbackOrigin({artifact,asm,app,owner:team.team_id,ownerPackage:app,model,
        recordId:jobId,field:'request',deliveryId:intent.intentId,source:'std.TextGenerationV1.generate',expectedRevision:await store.readRevision()},store);
      assert.ok(origin);assert.deepEqual(origin,{source:'std.TextGenerationV1.generate',sourceRevision:'1',binding:`${app}.LLM`,
        from:'deployment.llm',scope:{app,owner:team.team_id,ownerPackage:app},event:`${app}.LLM.generate.progressed`,handlers:[`${app}.progressed`]});
      const beforeMissingOrigin=await resources();
      assert.equal(await resolveGenerationCallbackOrigin({artifact,asm,app,owner:team.team_id,ownerPackage:app,model,
        recordId:jobId,field:'request',deliveryId:emptyId,source:'std.TextGenerationV1.generate',expectedRevision:await store.readRevision()},store),null);
      assert.deepEqual(await resources(),beforeMissingOrigin,'missing original dispatch cannot invent callback provenance');
      const rows=await store.query({model:WORK_SCHEDULE_MODEL,authority:'owner'});assert.ok(rows.length>0);
      const failures:{sourceOccurrence:string;occurrenceId:string}[]=[];
      for(const row of rows){
        const occurrence=readScheduleRow(row);assert.equal(occurrence.event,origin.event);assert.deepEqual(occurrence.payload,{delivery_id:intent.intentId});
        const due:DueScheduleInput={key:occurrence.key,scope:origin.scope,occurrenceId:occurrence.occurrenceId,event:occurrence.event,at:occurrence.at};
        const occurrenceId=handlerOccurrenceRowId(occurrence.occurrenceId,`${app}.progressed`);
        const sourceOptions={artifact,asm,app,handler:`${app}.progressed`,due,store,identities,now:clock.nowMs};
        const routed=await invokeDueSourceRoutingCanonical(sourceOptions);
        assert.ok(typeof routed==='object' && routed!==null && 'status' in routed);
        assert.equal(routed.status,'completed');
        const sourceRow=await store.load(WORK_OCCURRENCE_MODEL,asId(occurrence.occurrenceId));assert.ok(sourceRow);
        const sourceReceipt=readOccurrenceRow(sourceRow);assert.equal(sourceReceipt.status,'completed');
        assert.deepEqual(sourceReceipt.result,{fanouts:[],bounds:{pageLimit:100,chunkSize:100},
          handlers:[{handler:`${app}.progressed`,occurrenceId}]});
        const handlerRow=await store.load(WORK_HANDLER_OCCURRENCE_MODEL,asId(occurrenceId));assert.ok(handlerRow);
        const handler=readHandlerOccurrenceRow(handlerRow);assert.equal(handler.state,'pending');
        assert.equal(handler.sourceOccurrence,occurrence.occurrenceId);assert.equal(handler.handler,`${app}.progressed`);
        assert.equal(handler.event,origin.event);assert.deepEqual(handler.payload,{delivery_id:intent.intentId});
        const beforeSourceReplay=await resources();
        const sourceReplay=await invokeDueSourceRoutingCanonical(sourceOptions);
        assert.ok(typeof sourceReplay==='object' && sourceReplay!==null && 'status' in sourceReplay);
        assert.equal(sourceReplay.status,'replayed');assert.deepEqual(await resources(),beforeSourceReplay);
        const handlerOptions={artifact,asm,app,selector:{sourceOccurrence:handler.sourceOccurrence,handler:handler.handler,
          event:handler.event,scope:origin.scope},store,identities,now:clock.nowMs};
        const fired=await invokeRetainedHandlerOccurrenceCanonical(handlerOptions);
        assert.ok(typeof fired==='object' && fired!==null && 'status' in fired);
        assert.equal(fired.status,'failed');
        const failed=await store.load(WORK_OCCURRENCE_MODEL,asId(occurrenceId));assert.ok(failed);
        assert.equal(readOccurrenceRow(failed).status,'failed');assert.equal(readOccurrenceRow(failed).code,'require-false');
        const failedHandler=await store.load(WORK_HANDLER_OCCURRENCE_MODEL,asId(occurrenceId));assert.ok(failedHandler);
        assert.equal(readHandlerOccurrenceRow(failedHandler).state,'failed');
        assert.deepEqual(await store.load(WORK_OCCURRENCE_MODEL,sourceRow.id),sourceRow,'handler refusal retains its completed original source routing receipt');
        failures.push({sourceOccurrence:occurrence.occurrenceId,occurrenceId});
        const beforeReplay=await resources();
        const replayed=await invokeRetainedHandlerOccurrenceCanonical(handlerOptions);
        assert.ok(typeof replayed==='object' && replayed!==null && 'status' in replayed);
        assert.equal(replayed.status,'replayed');
        assert.deepEqual(await resources(),beforeReplay);
      }
      assert.deepEqual(await store.historyFor(model,asId(jobId)),originalHistory);
      assert.deepEqual(await store.load(asModel(RECEIPT_MODEL),asId(intent.intentId)),receipt);
      assert.deepEqual(await store.load(asModel(RECEIPT_ASSOCIATION_MODEL),associated.id),progressedAssociationRow);
      const terminal=await resources();assert.equal((await drive()).status,'not-pending');assert.deepEqual(await resources(),terminal);
      const scopes:{scope:PageReadScope;rows:readonly RowView[]}[]=[],observed:Awaited<ReturnType<Observer>>[]=[];
      const host=await assembleWorker(artifact,asm,{store,identityStore:identities,now:clock.nowMs,
        pageReads:{scope:{app,owner:team.team_id,ownerPackage:app},sourceIdentity:captured[0]!},
        ownerStorage:{app,forIdentity:async current=>{
          if(current.actor===null || current.team?.team_id!==team.team_id)throw new StateError('forbidden','Owner storage requires the actual configured team.');
          return store;
        },forTrustedScope:async()=>{throw new StateError('forbidden','This page witness has no trusted owner storage scope.');}},
        http:{createPageHandler:supplied=>{
          const deps=supplied as unknown as PageHttpDeps,createScope=deps.createReadScope;assert.ok(createScope);
          return request=>handlePageRequest({...deps,createReadScope:async (current, source, resolveCaller)=>{
            const scope=await createScope(current, source, resolveCaller),query=scope.query,observe=scope.observeGenerationCallbackDiagnostics;assert.ok(observe);
            const capture={scope,rows:[] as readonly RowView[]};scopes.push(capture);
            return {...scope,query:async(...args:Parameters<typeof query>)=>{const result=await query(...args);capture.rows=result.rows;return result;},
              observeGenerationCallbackDiagnostics:async (locator:Parameters<Observer>[0])=>{assert.ok(capture.rows.some(row=>row===locator.record));
                const result=await observe(locator);observed.push(result);return result;}};
          }},request);
        }}},{active:true});
      const request=(token=ownerToken,partial=false)=>new Request(`https://example.test/?team=${team.team_id}`,{headers:{
        cookie:buildSessionCookie(token,{maxAgeSeconds:3600,secure:false}).split(';')[0]!,...(partial?{'hx-request':'true'}:{})}});
      for(const partial of [false,true]){
        observed.length=0;const before=await resources(),response=await host.fetch(request(ownerToken,partial)),html=await response.text();
        assert.equal(response.status,200,html);assert.equal(observed.length,2);assert.ok(observed.includes(null));
        const diagnostic=observed.find(value=>value!==null);assert.ok(diagnostic && diagnostic.outcome==='complete');
        assert.equal(diagnostic.snapshotAttribution,'unsupported');assert.equal(diagnostic.failures.length,failures.length);
        assert.deepEqual(diagnostic.failures.map(value=>({sourceOccurrence:value.sourceOccurrence,occurrenceId:value.occurrenceId})),
          [...failures].sort((a,b)=>a.sourceOccurrence.localeCompare(b.sourceOccurrence)));
        for(const failure of diagnostic.failures){assert.equal(failure.deliveryId,intent.intentId);assert.equal(failure.handler,`${app}.progressed`);
          assert.equal(failure.code,'require-false');assert.equal(failure.event,origin.event);assert.equal(failure.recordedAtMs,BigInt(FIXED_NOW));}
        assert.ok(html.includes('require-false'));assert.ok(html.includes('handler requirement rejected the occurrence'));
        assert.equal(html.includes('PRIVATE_THINKING'),false);assert.deepEqual(await resources(),before);
      }
      const retained=scopes.at(-1)!;const row=retained.rows.find(value=>value.id===jobId);assert.ok(row);
      const observe=retained.scope.observeGenerationCallbackDiagnostics;assert.ok(observe);
      const expectCode=(code:string)=>(error:unknown)=>typeof error==='object' && error!==null && 'code' in error && error.code===code;
      const beforeInvalid=await resources();
      const noAssociation=retained.rows.find(value=>value.id===emptyId);assert.ok(noAssociation);
      const physicalOutbox=store.outboxGetBounded;assert.ok(physicalOutbox);let originalReads=0;
      store.outboxGetBounded=async function(input){assert.equal(this,store);originalReads++;return physicalOutbox.call(store,input);};
      try {assert.equal(await observe({record:noAssociation,field:'request'}),null);assert.equal(originalReads,0,
        'no association returns null before original-dispatch/Work reader resolution');}
      finally {store.outboxGetBounded=physicalOutbox;}
      await assert.rejects(observe({record:{...row},field:'request'}),expectCode('validation'));
      const foreign=scopes[0]!.rows.find(value=>value.id===jobId);assert.ok(foreign);assert.notEqual(foreign,row);
      await assert.rejects(observe({record:foreign,field:'request'}),expectCode('validation'));
      await assert.rejects(observe({record:{...row,id:emptyId},field:'request'}),expectCode('validation'));
      assert.deepEqual(await resources(),beforeInvalid);
      // The exact mixed callback grant admits members only at the authored visible label.
      const response=await host.fetch(request(memberToken,true));assert.equal(response.status,200,await response.clone().text());
      const memberScope=scopes.at(-1)!,memberRow=memberScope.rows.find(value=>value.id===jobId);assert.ok(memberRow);
      assert.ok(memberIdentity.actor);assert.equal(memberIdentity.actor.user_id,member.user_id);
      await identities.removeMembership(memberMembership.membership_id);
      const revoked=await resources();
      await assert.rejects(memberScope.scope.observeGenerationCallbackDiagnostics!({record:memberRow,field:'request'}),expectCode('forbidden'));
      assert.deepEqual(await resources(),revoked);
      await identities.reactivateMembership(memberMembership.membership_id,{is_owner:false,roles:[]});
      const physical=store.cohortLoad;assert.ok(physical);let revokeOnce=true,afterRevocation:Awaited<ReturnType<typeof resources>>|undefined;
      store.cohortLoad=async function(input){
        assert.equal(this,store);const result=await physical.call(store,input);
        if(revokeOnce && input.model===WORK_SCHEDULE_MODEL){revokeOnce=false;
          await identities.removeMembership(ownerMembership.membership_id);afterRevocation=await resources();}
        return result;
      };
      try{
        await assert.rejects(observe({record:row,field:'request'}),expectCode('forbidden'));
        assert.equal(revokeOnce,false,'revocation occurs after genuine current authorization inside the bounded Work read');
        assert.ok(afterRevocation);assert.deepEqual(await resources(),afterRevocation);
      }finally{store.cohortLoad=physical;await identities.reactivateMembership(ownerMembership.membership_id,{is_owner:true,roles:[]});}
      assert.equal((await invokeMutationCanonical({...base,operation:`${model}.update`,operationId:nextId(),
        inputs:{record:{id:jobId,version:'2'},label:'hidden'}})).status,'committed');
      // A fresh scope uses the current row and current guarded grant, while the old row conflicts.
      await assert.rejects(observe({record:row,field:'request'}),expectCode('conflict'));
      const deniedBefore=await resources(),denied=await host.fetch(request(memberToken,true));
      assert.notEqual(denied.status,200,'guarded callback denial must not render retained failures');
      assert.equal((await denied.text()).includes('handler requirement rejected the occurrence'),false);
      const deniedScope=scopes.at(-1)!,deniedRow=deniedScope.rows.find(value=>value.id===jobId);assert.ok(deniedRow);
      await assert.rejects(deniedScope.scope.observeGenerationCallbackDiagnostics!({record:deniedRow,field:'request'}),expectCode('forbidden'));
      assert.deepEqual(await resources(),deniedBefore);
      assert.deepEqual(await store.load(asModel(RECEIPT_MODEL),asId(intent.intentId)),receipt);
      assert.deepEqual(await store.load(asModel(RECEIPT_ASSOCIATION_MODEL),associated.id),progressedAssociationRow);
      assert.equal(provider.requests.length,1);assert.equal(JSON.stringify(artifact),artifactBytes);
      await importVerifiedAssemblyModule(asm,artifact.modules[0]!.path,artifact);
      assert.deepEqual(await Promise.all(paths.map(async path=>hash(await readFile(path)))),captured);
    }finally{await provider?.close();await worker?.dispose();await rm(dir,{recursive:true,force:true});}
  });
