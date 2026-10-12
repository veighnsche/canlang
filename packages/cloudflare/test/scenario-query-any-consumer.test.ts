/** Declaration-labelled installed lazy ANY component.
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
const APP='LazyAnyInstalled',BRANCH=`${APP}.Branch` as ModelName,RUN=`${APP}.Run` as ModelName,RESULT=`${APP}.Result` as ModelName,OP=`${APP}.collect`;
const path='lazy-any-installed-component.can',module='lazy-any-installed.mjs',text='## Test-authored installed lazy ANY component; no Compiler or original Chat claim.';
const origin={path,module,sha256:createHash('sha256').update(text).digest('hex')};
type Mode='empty'|'all-false'|'first-true'|'original-guard'|'evaluated-denial'|'missing-marker'|'duplicate-marker'|'copied-marker';
function artifact(mode:Mode):CompileArtifact {
 const fields:Record<string,Record<string,{type:string}>>={[BRANCH]:{title:{type:'text'}},[RUN]:{title:{type:'text'},unfinished:{type:'bool'}},[RESULT]:{found:{type:'bool'}}};
 const rules=[BRANCH,RUN,RESULT].map(model=>({model,rule:`${model}.read.1`}));
 const policy={operations:{[OP]:{by:['members']}},models:Object.fromEntries(rules.map(({model,rule})=>[model,{read:[rule]}]))};
 const definition={id:APP,policy,contracts:{},models:Object.fromEntries(rules.map(({model,rule})=>[model,{fields:fields[model]!,readGrants:[{rule,by:['members'],fields:Object.keys(fields[model]!)}]}])),
  operations:{[OP]:{handler:OP,inputs:{branch:{type:BRANCH}},queryAny:[{queryId:'runs',dependencyId:'unfinished-control'}]}}};
 if(mode==='first-true'||mode==='evaluated-denial'){definition.models[RUN]!.readGrants=[{rule:`${RUN}.read.1`,by:['members'],fields:['title']},{rule:`${RUN}.read.2`,by:['members'],fields:['unfinished']}];policy.models[RUN]!.read.push(`${RUN}.read.2`);}
 const marker=mode==='missing-marker'?'':mode==='copied-marker'?"observeScenarioReceiptQueryDependency(c,MODEL,Object.freeze({unfinished}),'unfinished','unfinished-control');":
  "observeScenarioReceiptQueryDependency(c,MODEL,row,'unfinished','unfinished-control');";
 const duplicate=mode==='duplicate-marker'?"observeScenarioReceiptQueryDependency(c,MODEL,row,'unfinished','unfinished-control');":'';
 const js=`import {require as check,hasRole,create,set,executeScenarioReceiptAny,observeScenarioReceiptQueryDependency,bindScenarioReceiptModelResult,selectScenarioReceiptReturn} from '@canlang/stdlib';
 let executions=0;const predicates=[],getters=[];let notify=()=>{};
 export const counters=()=>({executions,predicates:[...predicates],getters:[...getters]});export const observePredicate=fn=>{notify=fn;};export const collect=${JSON.stringify(OP)};
 export const appDefinition=${JSON.stringify(definition)};
 export function canApp(){return {policy:appDefinition.policy,read:{${rules.map(({rule})=>`${JSON.stringify(rule)}:c=>hasRole(c,'members')`).join(',')}${mode==='first-true'||mode==='evaluated-denial'?`,${JSON.stringify(`${RUN}.read.2`)}:(c,row)=>hasRole(c,'members')&&row.title!=='denied suffix'`:''}},LazyAnyInstalled:{collect:async(c,input)=>{
  executions++;const result=await create(c,${JSON.stringify(RESULT)},{parent:input.branch,found:false});
  const MODEL=${JSON.stringify(RUN)};
  const found=await executeScenarioReceiptAny(c,'runs',async row=>{
   predicates.push(row.id);notify(row.id);
   if(${JSON.stringify(mode)}==='first-true'&&row.id==='c')check(false,'original later predicate failure must remain skipped');
   const unfinished=row.unfinished;getters.push(row.id);${marker}${duplicate}
   return unfinished;
  });
  if(${JSON.stringify(mode)}==='original-guard')check(!found,'Original Require(not Any) failed');
  await set(c,result,{found});const wire=await bindScenarioReceiptModelResult(c,'created-result',result);
  selectScenarioReceiptReturn(c,'created-result');return wire;
 }}};}`;
 return {artifact_version:1,language_version:'declaration-labelled component',tool_version:'consumer fixture',sources:[{path,sha256:origin.sha256}],
  modules:[{path:module,js,map:{version:3,file:module,sources:[path],sourcesContent:[text],names:[],mappings:''}}],
  requires:[{capability:'canlang.builtins',min_version:2},{capability:'state',min_version:1},{capability:'state.parameters',min_version:1}],pages:[],tests:[],
  models:[{name:BRANCH,deleteMode:'archive',fields:[{name:'title',field:{kind:'string'},valueType:'text' as CanTypeId,required:true,serverOnly:false}]},
   {name:RUN,parent:BRANCH,deleteMode:'archive',fields:[{name:'title',field:{kind:'string'},valueType:'text' as CanTypeId,required:true,serverOnly:false},{name:'unfinished',field:{kind:'boolean'},valueType:'bool' as CanTypeId,required:true,serverOnly:false}]},
   {name:RESULT,parent:BRANCH,deleteMode:'archive',fields:[{name:'found',field:{kind:'boolean'},valueType:'bool' as CanTypeId,required:true,serverOnly:false}]}],
  operations:[...rules.map(({model})=>({name:`${model}.read`,kind:'read' as const,description:'',inputs:{fields:[]}})),
   {name:OP,kind:'scenario',description:'',inputs:{fields:[{name:'branch',field:{kind:'ref',model:BRANCH,requireVersion:true},required:true}]},
    result:{type:RESULT as CanTypeId,disclosure:{version:1,source:origin,queries:[{id:'runs',source:origin,model:RUN,
     parent:{source:origin,model:BRANCH,origin:{kind:'admitted-reference',parameter:'branch'}},order:[],limit:null,archived:'exclude',
     dependencies:[{id:'unfinished-control',source:origin,role:'control',field:'unfinished',type:'bool' as CanTypeId}]}],
     returns:[{id:'created-result',source:origin,dependencies:[],influences:(['query-existence','query-cardinality','query-membership','query-order'] as const).map(kind=>({id:`runs-${kind}`,kind,queryId:'runs'}))}]}}}],
  callables:[{id:OP,kind:'operation',module,export:'collect',member:['LazyAnyInstalled','collect'],inputStyle:'parameters'}]};
}
function hold(){let begin!:()=>void,release!:()=>void;const started=new Promise<void>(done=>{begin=done;}),released=new Promise<void>(done=>{release=done;});return {begin,release,started,released};}
let sequence=129000;
async function world(mode:Mode,pause?:ReturnType<typeof hold>){
 const {assembleModules,importVerifiedAssemblyModule}=await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
 const {buildInvoker}=await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
 const {createFrozenClock,createMemoryIdentityStore}=await nodeImport(producer('@canlang/identity/testing')) as typeof import('@canlang/identity/testing');
 const {resolveIdentity,sha256HexText}=await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
 const {createTestMemoryStorage}=await nodeImport(producer('@canlang/state/storage/memory')) as typeof import('@canlang/state/storage/memory');
 const {makeBatch,makeRow,FIXED_NOW,uuidv7}=await nodeImport(producer('@canlang/state/testing/invocation/fixtures')) as typeof import('@canlang/state/testing/invocation/fixtures');
 const {readScenarioReceiptAssociation}=await nodeImport(producer('@canlang/state/invocation')) as typeof import('@canlang/state/invocation');
 const dir=await mkdtemp(join(tmpdir(),'can-lazy-any-installed-'));
 try{
  const compiled=artifact(mode),original=JSON.stringify(compiled),asm=await assembleModules({artifact:compiled,sourcePath:path},{workDir:join(dir,'modules'),stdlibUrl:installed('runtime/stdlib.js')});
  const clock=createFrozenClock(FIXED_NOW),identities=createMemoryIdentityStore({clock}),team=await identities.createTeam({});
  const user=await identities.createUser({email:'lazy-any-installed@example.test',password_hash:'unused',email_verified:true});
  const membership=await identities.createMembership({team_id:team.team_id,user_id:user.user_id,is_owner:false,roles:[]});
  const token=randomBytes(32).toString('hex');await identities.createSession({user_id:user.user_id,token_sha256:await sha256HexText(token),last_team_id:team.team_id,expires_at:new Date(FIXED_NOW+86400000).toISOString()});
  const current=()=>resolveIdentity(identities,{session_token:token},{clock}),identity=await current();
  const {store:physical,probe}=createTestMemoryStorage();
  const branch=makeRow({id:'branch',createdBy:user.user_id,data:{title:'Actual parent'}}),other=makeRow({id:'other',createdBy:user.user_id,data:{title:'Other parent'}});
  const candidates=['a','b','c'].map(id=>({...makeRow({id,createdBy:user.user_id,data:{title:(mode==='first-true'&&id==='c'||mode==='evaluated-denial'&&id==='b')?'denied suffix':id,unfinished:(mode==='first-true'||mode==='original-guard')&&id==='b'}}),parent:{model:BRANCH,id:mode==='empty'?other.id:branch.id}}));
  await physical.commit(makeBatch(await physical.readRevision(),{writes:[{kind:'insert',model:BRANCH,row:branch},{kind:'insert',model:BRANCH,row:other},...candidates.map(row=>({kind:'insert' as const,model:RUN,row}))]}));
  const batches:CommitBatch[]=[];let gated=false,domainCompleted=false;const order:string[]=[];
  // Forward the real storage receiver; only its already-produced domain response is held.
  const store={...physical,query:async(input:Parameters<typeof physical.query>[0])=>{
   const rows=await physical.query(input);if(input.model===RUN){if(pause&&!gated){gated=true;pause.begin();await pause.released;}order.push('domain:end');domainCompleted=true;}return rows;},
   commit:async(batch:CommitBatch)=>{batches.push(batch);return physical.commit(batch);}};
  const ns=await importVerifiedAssemblyModule(asm,module,compiled) as {counters:()=>{executions:number;predicates:string[];getters:string[]};observePredicate:(notify:(id:string)=>void)=>void};
  ns.observePredicate(id=>{assert.equal(domainCompleted,true,'original domain storage query completed before lambda');order.push(`predicate:${id}`);});
  const env={operation:OP,operation_id:uuidv7(FIXED_NOW,++sequence),inputs:{branch:{id:branch.id,version:'1'}}};
  const receiptIdentity:Receipt['identity']={app:APP,owner:team.team_id,principal:user.user_id,operation:OP as Receipt['identity']['operation'],operationId:env.operation_id as OperationId};
  const invoker=buildInvoker(compiled,asm,store,{appId:APP,memberships:identities,now:()=>FIXED_NOW});
  const resources=async()=>({revision:await physical.readRevision(),rows:await Promise.all([BRANCH,RUN,RESULT].map(model=>physical.query({model,authority:'owner',archived:'include'}))),
   history:await Promise.all([BRANCH,RUN,RESULT].map(async model=>(await physical.query({model,authority:'owner',archived:'include'})).map(row=>probe.historyFor(model,row.id)))),outbox:probe.outboxAll(),schedules:await physical.schedulesDue(Number.MAX_SAFE_INTEGER,100),
   receipt:await physical.readReceipt(receiptIdentity),membership:await identities.findMembership(team.team_id,user.user_id),identityRows:{user:await identities.findUserById(user.user_id),team:await identities.findTeamById(team.team_id),session:await identities.findSessionByTokenHash(await sha256HexText(token))}});
  return {compiled,original,asm,ns,physical,store,batches,identities,identity,current,membership,branch,candidates,order,env,receiptIdentity,invoker,resources,readScenarioReceiptAssociation,
   verify:async()=>{assert.equal(JSON.stringify(compiled),original);await importVerifiedAssemblyModule(asm,module,compiled);},close:async()=>{pause?.release();await rm(dir,{recursive:true,force:true});}};
 }catch(error){pause?.release();await rm(dir,{recursive:true,force:true});throw error;}
}
test.each(['empty','all-false','first-true'] as const)('installed lazy ANY completes the domain before the %s predicate prefix',async mode=>{
 const w=await world(mode);try{
  const before=await w.resources(),outcome=await w.invoker.invokeMutation(w.env,w.identity);assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'committed');
  const expected=mode==='empty'?[]:mode==='first-true'?['a','b']:['a','b','c'];
  assert.deepEqual(w.ns.counters(),{executions:1,predicates:expected,getters:expected});assert.equal(w.order[0],'domain:end');
  const results=await w.physical.query({model:RESULT,authority:'owner'});assert.equal(results.length,1);const result=results[0]!;
  assert.deepEqual(result.data,{found:mode==='first-true'});assert.deepEqual(result.parent,{model:BRANCH,id:w.branch.id});assert.equal(result.version,1);
  assert.deepEqual(outcome.result.result,{id:result.id});const after=await w.resources();assert.deepEqual(after.rows.slice(0,2),before.rows.slice(0,2));
  assert.deepEqual(after.history.slice(0,2),before.history.slice(0,2));assert.deepEqual(after.outbox,before.outbox);assert.deepEqual(after.schedules,before.schedules);assert.deepEqual(after.membership,before.membership);assert.deepEqual(after.identityRows,before.identityRows);
  assert.equal(after.revision,before.revision+1);assert.ok(after.receipt);assert.equal(after.receipt.outcome.status,'committed');assert.equal(w.batches.length,1);
  assert.equal(w.batches[0]!.writes.length,1);assert.equal(w.batches[0]!.history.length,1);for(const key of ['outbox','schedules','uniqueClaims','uniqueReleases'] as const)assert.deepEqual(w.batches[0]![key],[]);
  const history=await w.physical.historyFor(RESULT,result.id);assert.equal(history.length,1);assert.equal(history[0]!.change,'create');assert.equal(history[0]!.before,null);assert.deepEqual(history[0]!.after,result.data);assert.equal(history[0]!.operationId,w.env.operation_id);
  const association=w.readScenarioReceiptAssociation(after.receipt);assert.ok(association);assert.equal(association.returnId,'created-result');
  const query=association.queries?.[0];assert.ok(query);assert.equal(query.queryId,'runs');assert.equal(query.candidates.length,mode==='empty'?0:3);
  assert.deepEqual(query.candidates.filter(candidate=>candidate.dependencies.length!==0).map(candidate=>candidate.row.id),expected);
  assert.deepEqual(query.selectedIndices,mode==='first-true'?[1]:[]);
  for(const replay of [()=>w.invoker.invokeMutation(w.env,w.identity),()=>w.invoker.invokeRetainedMutation(w.env,w.identity)]){
   const replayed=await replay();assert.ok('result' in replayed,JSON.stringify(replayed));assert.equal(replayed.result.status,'replayed');assert.deepEqual(replayed.result.result,{id:result.id});assert.deepEqual(await w.resources(),after);assert.equal(w.batches.length,1);assert.equal(w.ns.counters().executions,1);
  }
  if(mode==='first-true'){
   await w.identities.removeMembership(w.membership.membership_id);const revoked=await w.resources();
   const withheld=await w.invoker.invokeMutation(w.env,w.identity);assert.ok('result' in withheld,JSON.stringify(withheld));
   assert.equal(withheld.result.status,'replayed');assert.equal(withheld.result.result,null);assert.deepEqual(withheld.result.records,[]);
   const denied=await w.invoker.invokeRetainedMutation(w.env,w.identity);assert.ok('error' in denied,JSON.stringify(denied));assert.equal(denied.error.code,'forbidden');
   assert.deepEqual(await w.resources(),revoked);assert.equal(w.ns.counters().executions,1);assert.equal(w.batches.length,1);
   await w.identities.reactivateMembership(w.membership.membership_id,{is_owner:false,roles:[]});const restored=await w.resources();
   const replayed=await w.invoker.invokeRetainedMutation(w.env,await w.current());assert.ok('result' in replayed,JSON.stringify(replayed));
   assert.deepEqual(replayed.result.result,{id:result.id});assert.deepEqual(await w.resources(),restored);assert.equal(w.ns.counters().executions,1);assert.equal(w.batches.length,1);
  }
  await w.verify();
 }finally{await w.close();}
});
test.each(['original-guard','evaluated-denial','missing-marker','duplicate-marker','copied-marker'] as const)('installed lazy ANY rolls back %s with one rejected fence',async mode=>{
 const w=await world(mode);try{
  const before=await w.resources(),outcome=await w.invoker.invokeMutation(w.env,w.identity);assert.ok('error' in outcome,JSON.stringify(outcome));
  const after=await w.resources();assert.deepEqual(after.rows,before.rows);assert.deepEqual(after.history,before.history);assert.deepEqual(after.outbox,before.outbox);assert.deepEqual(after.schedules,before.schedules);assert.deepEqual(after.membership,before.membership);assert.deepEqual(after.identityRows,before.identityRows);
  assert.equal(after.revision,before.revision+1,`${mode}: ${JSON.stringify(outcome)}; ${JSON.stringify(w.ns.counters())}`);assert.equal(w.batches.length,1);assert.equal(w.batches[0]!.receipt?.outcome.status,'rejected');
  for(const key of ['writes','history','outbox','schedules','uniqueClaims','uniqueReleases'] as const)assert.deepEqual(w.batches[0]![key],[]);
  const expected=mode==='original-guard'?['a','b']:['a'];
  assert.deepEqual(w.ns.counters().predicates,expected);assert.deepEqual(w.ns.counters().getters,expected);
  assert.ok(after.receipt);assert.deepEqual(after.receipt.identity,w.receiptIdentity);
  assert.deepEqual(after.receipt.outcome,{status:'rejected',code:outcome.error.code,message:outcome.error.message});
  for(const replay of [()=>w.invoker.invokeMutation(w.env,w.identity),()=>w.invoker.invokeRetainedMutation(w.env,w.identity)]){
   const rejected=await replay();assert.ok('error' in rejected);assert.equal(rejected.error.code,outcome.error.code);assert.equal(rejected.error.message,outcome.error.message);
   assert.deepEqual(await w.resources(),after);assert.equal(w.ns.counters().executions,1);assert.equal(w.batches.length,1);
  }await w.verify();
 }finally{await w.close();}
});
test('installed lazy ANY refuses membership revoked during the held actual domain query',async()=>{
 const pause=hold(),w=await world('all-false',pause);let pending:ReturnType<typeof w.invoker.invokeMutation>|undefined;try{
  const before=await w.resources();pending=w.invoker.invokeMutation(w.env,w.identity);
  await Promise.race([pause.started,pending.then(outcome=>{throw new Error(`Invocation ended before the real domain query was held: ${JSON.stringify(outcome)}`);})]);
  await w.identities.removeMembership(w.membership.membership_id);const revoked=await w.resources();pause.release();
  const outcome=await pending;pending=undefined;assert.ok('error' in outcome,JSON.stringify(outcome));assert.equal(outcome.error.code,'forbidden');
  const after=await w.resources();assert.deepEqual(after.rows,before.rows);assert.deepEqual(after.history,before.history);assert.deepEqual(after.outbox,before.outbox);assert.deepEqual(after.schedules,before.schedules);assert.deepEqual(after.membership,revoked.membership);assert.deepEqual(after.identityRows,before.identityRows);
  assert.equal(after.revision,before.revision+1);assert.equal(w.batches.length,1);assert.equal(w.batches[0]!.receipt?.outcome.status,'rejected');
  for(const key of ['writes','history','outbox','schedules','uniqueClaims','uniqueReleases'] as const)assert.deepEqual(w.batches[0]![key],[]);
  const denied=await w.invoker.invokeMutation({...w.env,operation_id:w.env.operation_id.replace(/.$/,'f')},w.identity);assert.ok('error' in denied);assert.equal(denied.error.code,'forbidden');assert.deepEqual(await w.resources(),after);await w.verify();
 }finally{pause.release();try{await pending;}finally{await w.close();}}
});
