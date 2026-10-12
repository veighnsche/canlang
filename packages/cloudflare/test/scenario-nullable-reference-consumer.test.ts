/** Declaration-labelled installed getter/callback9 component.
 * Uses actual default loader, State/Identity/Memory; no Compiler/native-source claim. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileFunction, constants } from 'node:vm';
import { test } from 'vitest';
import type { CanTypeId, CommitBatch, CompileArtifact, ModelName, OperationId, Receipt } from '@canlang/contracts';
const root=resolve(fileURLToPath(new URL('../../../',import.meta.url))),require=createRequire(import.meta.url);
const nodeImport=compileFunction('return import(url)',['url'],{importModuleDynamically:constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
const installed=(path:string)=>pathToFileURL(join(root,'packages/cloudflare/dist',path)).href;
const producer=(name:string)=>pathToFileURL(require.resolve(name)).href;
const APP='NullableInstalled',SOURCE=`${APP}.Source` as ModelName,TARGET=`${APP}.Target` as ModelName,OP=`${APP}.readNullable`;
const path='nullable-installed-component.can',module='nullable-installed.mjs',text='## Declaration-labelled getter/receiver component, no compiled source claim.';
const origin={path,module,sha256:createHash('sha256').update(text).digest('hex')};
const sourceDependency={id:'source-current',source:origin,role:'control' as const,model:SOURCE,field:'current',type:`${TARGET}?` as CanTypeId};
const leaf={id:'target-published',source:origin,role:'data' as const,model:TARGET,field:'published',type:'bool' as CanTypeId};
function artifact(requiredReferenceControl=false):CompileArtifact {
 const observedSource={...sourceDependency,type:requiredReferenceControl?TARGET as CanTypeId:sourceDependency.type};
 const fields:Readonly<Record<string,Readonly<Record<string,{readonly type:string}>>>>=
  {[SOURCE]:{current:{type:`${TARGET}?`}},[TARGET]:{published:{type:'bool'}}};
 const rules=Object.keys(fields).map(model=>({model,rule:`${model}.read.1`}));
 const policy={operations:{[OP]:{by:['members']}},models:Object.fromEntries(rules.map(({model,rule})=>[model,{read:[rule]}]))};
 const definition={id:APP,policy,contracts:{},models:Object.fromEntries(rules.map(({model,rule})=>[model,{fields:fields[model]!,readGrants:[{rule,by:['members'],fields:Object.keys(fields[model]!)}]}])),
  operations:{[OP]:{handler:OP,inputs:{source:{type:SOURCE}}}}};
 const js=`import {hasRole,observeScenarioReceiptDependency,readScenarioReceiptNullableStoredReference,selectScenarioReceiptReturn} from '@canlang/stdlib';
 let executions=0,getters=0,targets=0;export const counters=()=>({executions,getters,targets});export const readNullable=${JSON.stringify(OP)};
 export const appDefinition=${JSON.stringify(definition)};
 export function canApp(){return {policy:appDefinition.policy,read:{${rules.map(({rule})=>`${JSON.stringify(rule)}:c=>hasRole(c,'members')`).join(',')}},NullableInstalled:{readNullable:async(c,input)=>{
  executions++;const reference=input.source.current;getters++;
  await observeScenarioReceiptDependency(c,${JSON.stringify(SOURCE)},input.source,'current','source-current');
  const target=await readScenarioReceiptNullableStoredReference(c,input.source,reference,'source-current','target-published');
  if(target===null){selectScenarioReceiptReturn(c,'absent');return false;}
  targets++;const published=target.published;
  await observeScenarioReceiptDependency(c,${JSON.stringify(TARGET)},target,'published','target-published');
  selectScenarioReceiptReturn(c,'published');return published;
 }}};}`;
 return {artifact_version:1,language_version:'declaration-labelled component',tool_version:'consumer fixture',sources:[{path,sha256:origin.sha256}],
  modules:[{path:module,js,map:{version:3,file:module,sources:[path],sourcesContent:[text],names:[],mappings:''}}],
  requires:[{capability:'canlang.builtins',min_version:2},{capability:'state',min_version:1},{capability:'state.parameters',min_version:1}],pages:[],tests:[],
  models:[{name:SOURCE,deleteMode:'archive',fields:[{name:'current',field:{kind:'ref',model:TARGET},valueType:`${TARGET}?` as CanTypeId,nullable:true,required:false,serverOnly:false}]},
   {name:TARGET,parent:SOURCE,deleteMode:'archive',fields:[{name:'published',field:{kind:'boolean'},valueType:'bool' as CanTypeId,required:true,serverOnly:false}]}],
  operations:[...rules.map(({model})=>({name:`${model}.read`,kind:'read' as const,description:'',inputs:{fields:[]}})),
   {name:OP,kind:'scenario',description:'',inputs:{fields:[{name:'source',field:{kind:'ref',model:SOURCE,requireVersion:true},required:true}]},
    result:{type:'bool' as CanTypeId,disclosure:{version:1,source:origin,returns:[
     {id:'absent',source:origin,influences:[],dependencies:[observedSource]},
     {id:'published',source:origin,influences:[],dependencies:[observedSource,leaf]},
    ]}}}],callables:[{id:OP,kind:'operation',module,export:'readNullable',member:['NullableInstalled','readNullable'],inputStyle:'parameters'}]};
}

/** Synthetic one-Return component of two distinct required reference CONTROL
 * occurrences and later DATA from the same once-evaluated Let. Requires the
 * released State6e plural correspondence; no original337 claim. */
function onceLetArtifact(mode:'normal'|'before-promotion'|'duplicate-data'='normal'):CompileArtifact {
 const compiled=artifact(true),original=compiled.modules[0]!;
 const publishedSource={...sourceDependency,id:'published-receiver-control',type:TARGET as CanTypeId};
 const letSource={...sourceDependency,id:'let-current-control',type:TARGET as CanTypeId};
 const currentData={...sourceDependency,id:'let-current-data',role:'data' as const,type:TARGET as CanTypeId};
 const publishedControl={...leaf,id:'target-published-control',role:'control' as const};
 const before=`  executions++;const reference=input.source.current;getters++;
  await observeScenarioReceiptDependency(c,${JSON.stringify(SOURCE)},input.source,'current','source-current');
  const target=await readScenarioReceiptNullableStoredReference(c,input.source,reference,'source-current','target-published');
  if(target===null){selectScenarioReceiptReturn(c,'absent');return false;}
  targets++;const published=target.published;
  await observeScenarioReceiptDependency(c,${JSON.stringify(TARGET)},target,'published','target-published');
  selectScenarioReceiptReturn(c,'published');return published;`;
 let after=`  executions++;const publishedReference=input.source.current;getters++;
  await observeScenarioReceiptDependency(c,${JSON.stringify(SOURCE)},input.source,'current','published-receiver-control');
  const publishedTarget=await readScenarioReceiptNullableStoredReference(c,input.source,publishedReference,'published-receiver-control','target-published-control');
  if(publishedTarget===null)throw Error('Required published receiver unexpectedly absent');
  targets++;const published=publishedTarget.published;
  await observeScenarioReceiptDependency(c,${JSON.stringify(TARGET)},publishedTarget,'published','target-published-control');
  const reference=input.source.current;getters++;
  await observeScenarioReceiptDependency(c,${JSON.stringify(SOURCE)},input.source,'current','let-current-control');
  const target=await readScenarioReceiptNullableStoredReference(c,input.source,reference,'let-current-control','target-published');
  if(target===null)throw Error('Required original Let unexpectedly absent');
  targets++;
  // DATA belongs to the exact evaluated Let above. No fresh source.current
  // getter is allowed to manufacture a replacement event for this marker.
  await observeScenarioReceiptDependency(c,${JSON.stringify(SOURCE)},input.source,'current','let-current-data');
  const sameLetPublished=target.published;
  await observeScenarioReceiptDependency(c,${JSON.stringify(TARGET)},target,'published','target-published');
  selectScenarioReceiptReturn(c,'published');return published&&sameLetPublished;`;
 const dataMarker=`await observeScenarioReceiptDependency(c,${JSON.stringify(SOURCE)},input.source,'current','let-current-data');`;
 if(mode==='before-promotion')after=after.replace("  const target=await readScenarioReceiptNullableStoredReference(c,input.source,reference,'let-current-control','target-published');",`  try{${dataMarker}}catch{return true;}
  const target=await readScenarioReceiptNullableStoredReference(c,input.source,reference,'let-current-control','target-published');`);
 if(mode==='duplicate-data')after=after.replace(dataMarker,`${dataMarker}
  try{${dataMarker}}catch{return true;}`);
 assert.ok(original.js.includes(before),'component must adapt its exact existing handauthored handler');
 return {...compiled,modules:compiled.modules.map(entry=>entry===original?{...entry,js:entry.js.replace(before,after)}:entry),
  operations:compiled.operations!.map(operation=>operation.name!==OP?operation:{...operation,
   result:{type:'bool' as CanTypeId,disclosure:{version:1,source:origin,returns:[
    {id:'published',source:origin,influences:[],dependencies:[publishedSource,publishedControl,letSource,currentData,leaf]},
   ]}}})};
}
function hold(){let begin!:()=>void,release!:()=>void;const started=new Promise<void>(done=>{begin=done;}),released=new Promise<void>(done=>{release=done;});return {begin,release,started,released};}
let sequence=129000;
async function world(absent:boolean,pause?:ReturnType<typeof hold>,requiredReferenceControl=false,componentArtifact?:CompileArtifact){
 const {assembleModules,importVerifiedAssemblyModule}=await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
 const {buildInvoker}=await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
 const {createFrozenClock,createMemoryIdentityStore}=await nodeImport(producer('@canlang/identity/testing')) as typeof import('@canlang/identity/testing');
 const {resolveIdentity,sha256HexText}=await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
 const {createTestMemoryStorage}=await nodeImport(producer('@canlang/state/storage/memory')) as typeof import('@canlang/state/storage/memory');
 const {makeBatch,makeRow,FIXED_NOW,uuidv7}=await nodeImport(producer('@canlang/state/testing/invocation/fixtures')) as typeof import('@canlang/state/testing/invocation/fixtures');
 const {readScenarioReceiptAssociation}=await nodeImport(producer('@canlang/state/invocation')) as typeof import('@canlang/state/invocation');
 const dir=await mkdtemp(join(tmpdir(),'can-nullable-installed-'));
 try{
  const compiled=componentArtifact??artifact(requiredReferenceControl),original=JSON.stringify(compiled),asm=await assembleModules({artifact:compiled,sourcePath:path},{workDir:join(dir,'modules'),stdlibUrl:installed('runtime/stdlib.js')});
  const clock=createFrozenClock(FIXED_NOW),identities=createMemoryIdentityStore({clock}),team=await identities.createTeam({});
  const user=await identities.createUser({email:'nullable-installed@example.test',password_hash:'unused',email_verified:true});
  const membership=await identities.createMembership({team_id:team.team_id,user_id:user.user_id,is_owner:false,roles:[]});
  const token=randomBytes(32).toString('hex');await identities.createSession({user_id:user.user_id,token_sha256:await sha256HexText(token),last_team_id:team.team_id,expires_at:new Date(FIXED_NOW+86400000).toISOString()});
  const identity=await resolveIdentity(identities,{session_token:token},{clock});
  const {store:physical,probe}=createTestMemoryStorage();
  const source=makeRow({id:'source',createdBy:user.user_id,data:{current:absent?null:{id:'target'}}}),target={...makeRow({id:'target',createdBy:user.user_id,data:{published:true}}),parent:{model:SOURCE,id:source.id}};
  await physical.commit(makeBatch(await physical.readRevision(),{writes:[{kind:'insert',model:SOURCE,row:source},{kind:'insert',model:TARGET,row:target}]}));
  const batches:CommitBatch[]=[];let targetLoads=0,gated=false;
  const gate=async(model:string)=>{if(model!==TARGET)return;targetLoads++;if(pause&&!gated){gated=true;pause.begin();await pause.released;}};
  // These wrappers forward real storage results/receivers; no reference or grant is issued here.
  const store={...physical,load:async(...args:Parameters<typeof physical.load>)=>{const row=await physical.load(...args);await gate(args[0]);return row;},
   cohortLoad:async(input:Parameters<typeof physical.cohortLoad>[0])=>{const row=await physical.cohortLoad(input);await gate(input.model);return row;},
   commit:async(batch:CommitBatch)=>{batches.push(batch);return physical.commit(batch);}};
  const ns=await importVerifiedAssemblyModule(asm,module,compiled) as {counters:()=>{executions:number;getters:number;targets:number}};
  const env={operation:OP,operation_id:uuidv7(FIXED_NOW,++sequence),inputs:{source:{id:source.id,version:'1'}}};
  const receiptIdentity:Receipt['identity']={app:APP,owner:team.team_id,principal:user.user_id,operation:OP as Receipt['identity']['operation'],operationId:env.operation_id as OperationId};
  const invoker=buildInvoker(compiled,asm,store,{appId:APP,memberships:identities,now:()=>FIXED_NOW});
  const resources=async()=>({revision:await physical.readRevision(),rows:await Promise.all([SOURCE,TARGET].map(model=>physical.query({model,authority:'owner',archived:'include'}))),
   history:[probe.historyFor(SOURCE,source.id),probe.historyFor(TARGET,target.id)],outbox:probe.outboxAll(),schedules:await physical.schedulesDue(Number.MAX_SAFE_INTEGER,100),
   receipt:await physical.readReceipt(receiptIdentity),membership:await identities.findMembership(team.team_id,user.user_id),identityRows:{user:await identities.findUserById(user.user_id),team:await identities.findTeamById(team.team_id),session:await identities.findSessionByTokenHash(await sha256HexText(token))}});
  return {compiled,original,asm,ns,physical,store,batches,identities,identity,membership,source,target,env,receiptIdentity,invoker,resources,targetLoads:()=>targetLoads,readScenarioReceiptAssociation,
   verify:async()=>{assert.equal(JSON.stringify(compiled),original);await importVerifiedAssemblyModule(asm,module,compiled);},close:async()=>{pause?.release();await rm(dir,{recursive:true,force:true});}};
 }catch(error){pause?.release();await rm(dir,{recursive:true,force:true});throw error;}
}
test('installed nullable getter/callback9 preserves genuine null, target scalar and current membership',async()=>{
 for(const absent of [true,false]){const w=await world(absent);try{
  const before=await w.resources(),result=await w.invoker.invokeMutation(w.env,w.identity);assert.ok('result' in result,JSON.stringify(result));assert.equal(result.result.status,'committed');assert.equal(result.result.result,!absent);
  assert.deepEqual(w.ns.counters(),{executions:1,getters:1,targets:absent?0:1});if(absent)assert.equal(w.targetLoads(),0);else assert.ok(w.targetLoads()>0);
  const after=await w.resources();assert.deepEqual(after.rows,before.rows);assert.deepEqual(after.history,before.history);assert.deepEqual(after.outbox,before.outbox);assert.deepEqual(after.schedules,before.schedules);assert.deepEqual(after.membership,before.membership);assert.deepEqual(after.identityRows,before.identityRows);
  assert.equal(after.revision,before.revision+1);assert.ok(after.receipt);assert.equal(after.receipt.outcome.status,'committed');assert.equal(w.batches.length,1);
  for(const key of ['writes','history','outbox','schedules','uniqueClaims','uniqueReleases'] as const)assert.deepEqual(w.batches[0]![key],[]);
  const association=w.readScenarioReceiptAssociation(after.receipt);assert.ok(association);assert.equal(association.returnId,absent?'absent':'published');
  assert.deepEqual(association.observations.map(value=>value.dependencyId),absent?['source-current']:['source-current','target-published']);
  for(const replay of [()=>w.invoker.invokeMutation(w.env,w.identity),()=>w.invoker.invokeRetainedMutation(w.env,w.identity)]){
   const replayed=await replay();assert.ok('result' in replayed,JSON.stringify(replayed));assert.equal(replayed.result.status,'replayed');assert.equal(replayed.result.result,!absent);assert.deepEqual(await w.resources(),after);assert.equal(w.batches.length,1);assert.equal(w.ns.counters().executions,1);
  }await w.verify();
 }finally{await w.close();}}
 const pause=hold(),w=await world(false,pause);let pending:ReturnType<typeof w.invoker.invokeMutation>|undefined;try{
  const before=await w.resources();pending=w.invoker.invokeMutation(w.env,w.identity);
  await Promise.race([pause.started,pending.then(result=>{throw Error('Invocation ended before genuine target load: '+JSON.stringify(result));})]);
  await w.identities.removeMembership(w.membership.membership_id);const revoked=await w.resources();pause.release();
  const outcome=await pending;pending=undefined;assert.ok('error' in outcome,JSON.stringify(outcome));const after=await w.resources();assert.deepEqual(after.rows,before.rows);assert.deepEqual(after.history,before.history);assert.deepEqual(after.outbox,before.outbox);assert.deepEqual(after.schedules,before.schedules);assert.deepEqual(after.membership,revoked.membership);assert.deepEqual(after.identityRows,before.identityRows);
  assert.equal(outcome.error.code,'forbidden');assert.equal(after.revision,before.revision+1);assert.equal(w.batches.length,1);assert.equal(w.batches[0]!.receipt?.outcome.status,'rejected');
  assert.ok(after.receipt);assert.deepEqual(after.receipt.identity,w.receiptIdentity);assert.equal(after.receipt.outcome.status,'rejected');
  for(const key of ['writes','history','outbox','schedules','uniqueClaims','uniqueReleases'] as const)assert.deepEqual(w.batches[0]![key],[]);
  const denied=await w.invoker.invokeMutation({...w.env,operation_id:w.env.operation_id.replace(/.$/,'f')},w.identity);assert.ok('error' in denied);assert.equal(denied.error.code,'forbidden');assert.deepEqual(await w.resources(),after);await w.verify();
 }finally{pause.release();try{await pending;}finally{await w.close();}}
});

test('installed nullable receiver retains required reference CONTROL over its genuine nullable declaration',async()=>{
 const w=await world(false,undefined,true);try{
  const before=await w.resources(),result=await w.invoker.invokeMutation(w.env,w.identity);
  assert.ok('result' in result,JSON.stringify(result));assert.equal(result.result.status,'committed');assert.equal(result.result.result,true);
  assert.deepEqual(w.ns.counters(),{executions:1,getters:1,targets:1});
  const after=await w.resources();assert.ok(after.receipt);
  assert.deepEqual({...after,revision:before.revision,receipt:before.receipt},before);
  assert.equal(after.revision,before.revision+1);assert.equal(w.batches.length,1);
  const association=w.readScenarioReceiptAssociation(after.receipt);assert.ok(association);
  assert.deepEqual(association.observations.map(value=>value.dependencyId),['source-current','target-published']);
  const replayed=await w.invoker.invokeRetainedMutation(w.env,w.identity);
  assert.ok('result' in replayed,JSON.stringify(replayed));assert.equal(replayed.result.status,'replayed');assert.equal(replayed.result.result,true);
  assert.deepEqual(await w.resources(),after);assert.equal(w.ns.counters().executions,1);assert.equal(w.batches.length,1);await w.verify();
 }finally{await w.close();}
});


test('installed nullable component observes DATA from its same once-evaluated Let after distinct source controls',async()=>{
 const w=await world(false,undefined,true,onceLetArtifact());try{
  const before=await w.resources(),result=await w.invoker.invokeMutation(w.env,w.identity);
  assert.ok('result' in result,JSON.stringify(result));assert.equal(result.result.status,'committed');assert.equal(result.result.result,true);
  assert.deepEqual(w.ns.counters(),{executions:1,getters:2,targets:2});
  const after=await w.resources();assert.ok(after.receipt);assert.ok(w.targetLoads()>0);
  assert.deepEqual({...after,revision:before.revision,receipt:before.receipt},before);
  assert.equal(after.revision,before.revision+1);assert.equal(w.batches.length,1);
  for(const key of ['writes','history','outbox','schedules','uniqueClaims','uniqueReleases'] as const)assert.deepEqual(w.batches[0]![key],[]);
  const association=w.readScenarioReceiptAssociation(after.receipt);assert.ok(association);assert.equal(association.returnId,'published');
  assert.deepEqual(association.observations.map(value=>value.dependencyId),[
   'published-receiver-control','target-published-control','let-current-control','let-current-data','target-published',
  ]);
  for(const replay of [()=>w.invoker.invokeMutation(w.env,w.identity),()=>w.invoker.invokeRetainedMutation(w.env,w.identity)]){
   const replayed=await replay();assert.ok('result' in replayed,JSON.stringify(replayed));assert.equal(replayed.result.status,'replayed');assert.equal(replayed.result.result,true);
   assert.deepEqual(await w.resources(),after);assert.deepEqual(w.ns.counters(),{executions:1,getters:2,targets:2});assert.equal(w.batches.length,1);
  }await w.verify();
 }finally{await w.close();}
});


test('caught DATA markers before promotion completion or after its one use remain terminal',async()=>{
 for(const mode of ['before-promotion','duplicate-data'] as const){
  const w=await world(false,undefined,true,onceLetArtifact(mode));try{
   const before=await w.resources(),outcome=await w.invoker.invokeMutation(w.env,w.identity);
   assert.ok('error' in outcome,JSON.stringify(outcome));assert.equal(outcome.error.code,'validation');
   assert.match(outcome.error.message,/Nullable source marker/);
   const after=await w.resources();assert.ok(after.receipt);assert.equal(after.receipt.outcome.status,'rejected');
   assert.deepEqual({...after,revision:before.revision,receipt:before.receipt},before);
   assert.equal(after.revision,before.revision+1);assert.equal(w.batches.length,1);
   for(const key of ['writes','history','outbox','schedules','uniqueClaims','uniqueReleases'] as const)assert.deepEqual(w.batches[0]![key],[]);
   const counters=w.ns.counters();assert.equal(counters.executions,1);assert.equal(counters.getters,2);
   for(const replay of [()=>w.invoker.invokeMutation(w.env,w.identity),()=>w.invoker.invokeRetainedMutation(w.env,w.identity)]){
    const saved=await replay();assert.ok('error' in saved,JSON.stringify(saved));assert.equal(saved.error.code,outcome.error.code);assert.equal(saved.error.message,outcome.error.message);
    assert.deepEqual(await w.resources(),after);assert.deepEqual(w.ns.counters(),counters);assert.equal(w.batches.length,1);
   }await w.verify();
  }finally{await w.close();}
 }
});
