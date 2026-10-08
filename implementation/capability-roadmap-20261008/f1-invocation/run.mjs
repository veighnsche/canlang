import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
const frozen=process.argv[2]??fileURLToPath(new URL('../../../',import.meta.url));
const out=fileURLToPath(new URL('./',import.meta.url));
const runtimeMode=process.env.F1_RUNTIME_MODE??'cloudflare-runtime';
const runtimePath=runtimeMode==='cloudflare-runtime'?`${frozen}/packages/cloudflare/dist/runtime/stdlib.js`:`${frozen}/packages/stdlib/dist/src/index.js`;
const privateRoot=`/private/tmp/canlang-f1-invocation-${runtimeMode}-${process.env.F1_RUN_TAG??'complete'}`;
const {Miniflare}=createRequire(`${frozen}/packages/cloudflare/package.json`)('miniflare');
const {assembleModules}=await import(`${frozen}/packages/cloudflare/dist/runtime/modules.js`);
const {buildInvoker}=await import(`${frozen}/packages/cloudflare/dist/worker/assembly.js`);
const {createD1Storage,ensureSchema}=await import(`${frozen}/packages/state/dist/src/storage/d1.js`);
const {createMemoryIdentityStore,createFrozenClock}=await import(`${frozen}/packages/identity/dist/src/testing.js`);
const {resolveIdentity,sha256HexText}=await import(`${frozen}/packages/identity/dist/src/index.js`);
const stdlib=await import(runtimePath);
const {createContext}=await import(`${frozen}/packages/cloudflare/dist/runtime/context.js`);
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?`${v}n`:v,2)+'\n';
const now=Date.now(),clock=createFrozenClock(now),identityStore=createMemoryIdentityStore({clock});
const teamA=await identityStore.createTeam({}),teamB=await identityStore.createTeam({});
async function user(email,team,owner){
 const u=await identityStore.createUser({email,password_hash:'x',email_verified:true});
 const member=await identityStore.createMembership({team_id:team.team_id,user_id:u.user_id,is_owner:owner,roles:[]});
 const token=randomUUID();
 await identityStore.createSession({user_id:u.user_id,token_sha256:await sha256HexText(token),expires_at:new Date(now+3600000).toISOString(),last_team_id:team.team_id});
 const held=await resolveIdentity(identityStore,{session_token:token},{clock});
 return {u,member,token,held};
}
const owner=await user('f1-owner@test.invalid',teamA,true),member=await user('f1-member@test.invalid',teamA,false),other=await user('f1-other@test.invalid',teamB,false);
const anonymous=await resolveIdentity(identityStore,{},{clock});
const opId=()=>{const t=now.toString(16).padStart(12,'0'),r=randomUUID();return `${t.slice(0,8)}-${t.slice(8)}-7${r.slice(15,18)}-8${r.slice(20,23)}-${r.slice(24)}`};
const sources={bounded:{artifact:`${out}/../f1-metadata/artifacts/bounded-compile.json`,source:`${out}/../f1-metadata/Bounded.can`},member:{artifact:`${out}/member-control-compile.json`,source:`${out}/MemberControl.can`}};
const artifacts={},assemblies={};
await mkdir(privateRoot,{recursive:true});
for(const [key,paths] of Object.entries(sources)){
 const raw=await readFile(paths.artifact);artifacts[key]=JSON.parse(raw);
 assemblies[key]=await assembleModules({artifact:artifacts[key],sourcePath:paths.source},{workDir:`${privateRoot}/modules/${key}`,stdlibUrl:pathToFileURL(runtimePath).href,uiUrl:pathToFileURL(`${frozen}/packages/ui/dist/src/index.js`).href});
}
let mf,db,store,invokers;
async function open(){
 mf=new Miniflare({modules:true,script:'export default { fetch() { return new Response("ok"); } }',d1Databases:{DB:'f1-invocation-bounded'},d1Persist:`${privateRoot}/persist`});
 db=await mf.getD1Database('DB');await ensureSchema(db);store=createD1Storage(db);
 invokers=Object.fromEntries(Object.keys(artifacts).map(k=>[k,buildInvoker(artifacts[k],assemblies[k],store,{memberships:identityStore,now:()=>now})]));
}
const receipts=[];let sequence=0;
async function snap(){
 const tables={};for(const table of ['records','history','receipts','outbox','schedules','fence','fence_log']){
  const q=await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();tables[table]=q.results;
 }
 return {revision:await store.readRevision(),tables};
}
async function save(){await writeFile(`${out}/runtime-results.json`,json({qualification:'Actual unchanged emitted artifacts, production assembler/canonical invoker/state D1 adapter; Miniflare persisted local D1. Identity resolver/live memberships use test memory store (no installed identity claim).',runtimeMode,runtimePath,now,privateRoot,receipts}));}
async function mutation(name,key,operation,inputs,identity=owner.held,id=opId()){
 const envelope={operation,operation_id:id,inputs},before=await snap();
 let outcome;try{outcome=await invokers[key].invokeMutation(envelope,identity)}catch(e){outcome={throw:{name:e.name,message:e.message,stack:e.stack}}}
 const runtimeResult=outcome.result?.result;
 const runtimeTypes=runtimeResult&&typeof runtimeResult==='object'?{result:typeof runtimeResult,version:typeof runtimeResult.version,data:Object.fromEntries(Object.entries(runtimeResult.data??{}).map(([k,v])=>[k,v===null?'null':typeof v]))}:null;
 const after=await snap();const r={sequence:++sequence,name,key,envelope,outcome,runtimeTypes,before,after};receipts.push(r);await save();return r;
}
function committed(r){return r.outcome.result?.status==='committed'}
function row(r,model){return r.after.tables.records.find(x=>x.model===model&&x.id===r.envelope.operation_id)}
function ref(record){return {id:record.id,version:String(record.version)}}
function code(r,expected){return r.outcome.error?.code===expected}
const checks=[];function check(name,passed,detail){checks.push({name,passed:!!passed,detail});}
async function read(name,key,operation,inputs,identity=owner.held){const before=await snap();const outcome=await invokers[key].invokeRead({operation,inputs},identity);const after=await snap();receipts.push({sequence:++sequence,name,key,envelope:{operation,inputs},outcome,before,after});await save();return outcome;}
try{
 await open();
 const initial=await snap();check('fresh private D1 run has no previous receipt',initial.tables.receipts.length===0,{count:initial.tables.receipts.length});
 const account=await mutation('bounded scalar account create defaults','bounded','Bounded.Account.create',{});
 check('actual bounded account default persisted',committed(account)&&JSON.parse(row(account,'Bounded.Account')?.data??'null')?.name==='account');
 const job=await mutation('bounded scalar/default/null create','bounded','Bounded.Job.create',{});
 const omittedRow=row(job,'Bounded.Job');check('actual bounded creation committed with scalar/machine defaults',committed(job)&&omittedRow!==undefined,{row:omittedRow});
 const createdFields=omittedRow?JSON.parse(omittedRow.data):null;
 check('actual bounded omitted nullable reference becomes null',createdFields?.account===null,{fields:createdFields});
 const repeat=await mutation('matching create retry same raw inputs','bounded','Bounded.Job.create',{},owner.held,job.envelope.operation_id);
 check('matching retry replays stable result without rows/history/version duplication',repeat.outcome.result?.status==='replayed'&&json(repeat.outcome.result?.result)===json(job.outcome.result?.result)&&json(repeat.before)===json(repeat.after));
 const changed=await mutation('changed payload same operation identity','bounded','Bounded.Job.create',{title:'changed'},owner.held,job.envelope.operation_id);
 check('changed payload reuse conflicts without write',code(changed,'conflict')&&json(changed.before)===json(changed.after));
 const explicitNull=await mutation('explicit nullable reference null','bounded','Bounded.Job.create',{account:null});check('explicit null commits',committed(explicitNull));
 const accountRow=row(account,'Bounded.Account');
 const referenced=await mutation('current versioned nullable reference supplied','bounded','Bounded.Job.create',{account:ref(accountRow)});check('current versioned reference supplied commits',committed(referenced));
 const jrow=row(referenced,'Bounded.Job');
 check('supported current-ref scalar/machine defaults persisted',jrow&&JSON.parse(jrow.data).title==='test'&&JSON.parse(jrow.data).count==='1'&&JSON.parse(jrow.data).enabled===true&&JSON.parse(jrow.data).status==='idle');
 const defaultTypeReceipt={artifactFieldDefaults:artifacts.bounded.models.find(m=>m.name==='Bounded.Job').fields.filter(f=>f.default).map(f=>({field:f.name,wireValue:f.default.value,wireType:typeof f.default.value})),runtimeTypes:referenced.runtimeTypes,persistedDataTypes:Object.fromEntries(Object.entries(JSON.parse(jrow.data)).map(([k,v])=>[k,v===null?'null':typeof v])),persistedVersionType:typeof jrow.version};
 check('runtime and persisted scalar default types captured exactly',referenced.runtimeTypes.data.title==='string'&&referenced.runtimeTypes.data.count==='string'&&referenced.runtimeTypes.data.enabled==='boolean'&&referenced.runtimeTypes.data.status==='string'&&referenced.runtimeTypes.version==='number'&&defaultTypeReceipt.persistedVersionType==='number',defaultTypeReceipt);
 const supportedReplay=await mutation('matching supported-reference create retry','bounded','Bounded.Job.create',{account:ref(accountRow)},owner.held,referenced.envelope.operation_id);
 check('supported current-reference create replays result without duplicate effects',supportedReplay.outcome.result?.status==='replayed'&&json(supportedReplay.outcome.result?.result)===json(referenced.outcome.result?.result)&&json(supportedReplay.before)===json(supportedReplay.after));
 const wrongModel=await mutation('wrong model id supplied to typed Job parameter','bounded','Bounded.advance',{job:ref(accountRow)});check('wrong model id refuses via descriptor-owned model',code(wrongModel,'not_found'));
 const missing=await mutation('missing Job reference','bounded','Bounded.advance',{job:{id:'missing-job-id',version:'1'}});check('missing reference refuses',code(missing,'not_found'));
 const noVersion=await mutation('missing expected version','bounded','Bounded.advance',{job:{id:jrow.id}});check('missing version refuses',code(noVersion,'validation'));
 const advanced=await mutation('two actual ordered machine transitions','bounded','Bounded.advance',{job:ref(jrow)});
 const advancedRow=advanced.after.tables.records.find(x=>x.model==='Bounded.Job'&&x.id===jrow.id);
 const advanceHistory=advanced.after.tables.history.filter(x=>x.operation_id===advanced.envelope.operation_id);
 check('two transitions commit one net record version',committed(advanced)&&advancedRow?.version===jrow.version+1&&JSON.parse(advancedRow.data).status==='ready',{row:advancedRow,history:advanceHistory});
 check('two transitions preserve ordered history at net version',advanceHistory.length===2&&advanceHistory.every(h=>h.version===jrow.version+1)&&JSON.parse(advanceHistory[0].after).status==='queued'&&JSON.parse(advanceHistory[1].after).status==='ready',{history:advanceHistory});
 const advancedReplay=await mutation('matching transition retry stale submitted ref replays first','bounded','Bounded.advance',{job:ref(jrow)},owner.held,advanced.envelope.operation_id);
 check('matching transition replay precedes stale-reference admission',advancedReplay.outcome.result?.status==='replayed'&&json(advancedReplay.before)===json(advancedReplay.after));
 const stale=await mutation('fresh operation stale Job ref','bounded','Bounded.advance',{job:ref(jrow)});check('fresh stale reference conflicts',code(stale,'conflict'));
 const updateInputs={record:ref(advancedRow),title:'changed by authorized update'};
 const updated=await mutation('authorized generated scalar update preserves machine/default/ref fields','bounded','Bounded.Job.update',updateInputs);
 const updatedRow=updated.after.tables.records.find(x=>x.model==='Bounded.Job'&&x.id===advancedRow.id);
 check('authorized generated update one version and preserves omitted fields',committed(updated)&&updatedRow.version===advancedRow.version+1&&JSON.parse(updatedRow.data).title==='changed by authorized update'&&JSON.parse(updatedRow.data).count==='1'&&JSON.parse(updatedRow.data).status==='ready'&&json(JSON.parse(updatedRow.data).account)===json(JSON.parse(advancedRow.data).account));
 const updateReplay=await mutation('matching generated update replay with now-stale submitted record','bounded','Bounded.Job.update',updateInputs,owner.held,updated.envelope.operation_id);
 check('generated update duplicate replay result/hash no extra history/versions',updateReplay.outcome.result?.status==='replayed'&&json(updateReplay.outcome.result?.result)===json(updated.outcome.result?.result)&&json(updateReplay.before)===json(updateReplay.after));
 const directCreate=await mutation('direct CRUD supplies managed field','bounded','Bounded.Job.create',{status:'ready'});check('direct CRUD managed create bypass refuses',code(directCreate,'validation'));
 const directUpdate=await mutation('direct CRUD supplies managed field update','bounded','Bounded.Job.update',{record:ref(advancedRow),status:'idle'});check('direct CRUD managed update bypass refuses',code(directUpdate,'validation'));
 const omittedRead=await read('actual public read omitted selector','bounded','Bounded.Job.read',{},anonymous);
 const expectedPublicData=JSON.parse(updatedRow.data);
 const omittedReadReceipt=receipts.at(-1);
 check('actual public omitted-input read serves exact known safe projection without state writes',Array.isArray(omittedRead.result?.records)&&omittedRead.result.records.length===1&&omittedRead.result.records[0].id===updatedRow.id&&omittedRead.result.records[0].version===updatedRow.version&&json(omittedRead.result.records[0].data)===json(expectedPublicData)&&json(omittedReadReceipt.before)===json(omittedReadReceipt.after),{expectedId:updatedRow.id,expectedVersion:updatedRow.version,expectedPublicData,actual:omittedRead});
 const explicitRead=await read('actual public read explicit unsupported selector input','bounded','Bounded.Job.read',{fields:['title','status']},anonymous);
 check('unsupported explicit read selector input refuses closed schema',explicitRead.error?.code==='validation');
 const memberAccount=await mutation('member control current account create','member','MemberControl.Account.create',{},member.held);
 const memberAccountRow=row(memberAccount,'MemberControl.Account');
 const memberJobInputs={account:ref(memberAccountRow)};
 const memberJob=await mutation('member control scalar/default create','member','MemberControl.Job.create',memberJobInputs,member.held);check('live member generated CRUD create commits',committed(memberJob));
 const memberRow=row(memberJob,'MemberControl.Job');
 const wrongActor=await mutation('anonymous wrong actor control','member','MemberControl.Job.create',{},anonymous);check('anonymous control denies',code(wrongActor,'forbidden'));
 const ownerPass=await mutation('owner control allowed in active scope','member','MemberControl.ownerGate',{accept:true});check('active owner admission commits',committed(ownerPass));
 const wrongOwner=await mutation('wrong actor member owner control','member','MemberControl.ownerGate',{accept:true},member.held);check('member lacking owner authority denies',code(wrongOwner,'forbidden'));
 const wrongScope=await mutation('other team member lacks owner authority in selected scope','member','MemberControl.ownerGate',{accept:true},other.held);check('other team member owner-gate scope denies',code(wrongScope,'forbidden'));
 const rollback=await mutation('controlled late guard fails after actual transition staging','member','MemberControl.lateFail',{job:ref(memberRow),accept:false},member.held);
 const rollbackReplay=await mutation('late guard failure matching retry','member','MemberControl.lateFail',{job:ref(memberRow),accept:false},member.held,rollback.envelope.operation_id);
 check('controlled late failure rolls back staged row/history while persisting rejection receipt',code(rollback,'rule_failed')&&json(rollback.before.tables.records)===json(rollback.after.tables.records)&&json(rollback.before.tables.history)===json(rollback.after.tables.history)&&rollback.after.tables.receipts.length===rollback.before.tables.receipts.length+1);
 check('late failure matching retry unchanged error/hash/history',json(rollbackReplay.outcome)===json(rollback.outcome)&&json(rollbackReplay.before)===json(rollbackReplay.after));
 await identityStore.removeMembership(member.member.membership_id);
 const revoked=await mutation('held identity after live membership revocation fresh operation','member','MemberControl.Job.create',{account:ref(memberAccountRow)},member.held);check('fresh held identity observes current revocation',code(revoked,'forbidden'));
 const revokedReplay=await mutation('matching historical committed retry after revocation','member','MemberControl.Job.create',memberJobInputs,member.held,memberJob.envelope.operation_id);
 check('receipt replay current authorization posture captured',true,{outcome:revokedReplay.outcome});
 const deniedReplay=await mutation('matching fresh-denied retry still revoked','member','MemberControl.Job.create',{account:ref(memberAccountRow)},member.held,revoked.envelope.operation_id);check('fresh denial retry consistent while revoked',json(deniedReplay.outcome)===json(revoked.outcome));
 await identityStore.reactivateMembership(member.member.membership_id,{is_owner:false,roles:[]});
 const readmit=await mutation('same previously admission-denied identity after membership restore','member','MemberControl.Job.create',{account:ref(memberAccountRow)},member.held,revoked.envelope.operation_id);check('fresh admission denial had no receipt and readmits after restoration',committed(readmit));
 const directScope=[];for(const [name,fn] of [['create',()=>stdlib.create({},'Bounded.Job',{id:'bypass-id',data:{}})],['set',()=>stdlib.set({},'Bounded.Job',jrow.id,{status:'ready'})],['transition',()=>stdlib.transition({},'Bounded.Job',jrow.id,'status','ready','idle')]]){
 const before=await snap();try{await fn();directScope.push({name,returned:true,before,after:await snap()})}catch(e){directScope.push({name,error:{name:e.name,code:e.code,message:e.message},before,after:await snap()})}
 }
 receipts.push({sequence:++sequence,name:'selected runtime stdlib outside canonical scope bypass controls',directScope});await save();
 check('public direct transition requires canonical scope',directScope.find(x=>x.name==='transition')?.error?.code==='validation');
 const beforeRestart=await snap();await mf.dispose();mf=undefined;
 await open();const afterRestart=await snap();check('D1 stop/reopen same private persisted directory retains all rows/history/receipt/fence',json(beforeRestart)===json(afterRestart));
 const restartReplay=await mutation('persisted restart fresh invoker exact creation replay','bounded','Bounded.Job.create',{account:ref(accountRow)},owner.held,referenced.envelope.operation_id);
 check('persisted restart replay saved result no duplicate effects',restartReplay.outcome.result?.status==='replayed'&&json(restartReplay.outcome.result?.result)===json(referenced.outcome.result?.result)&&json(restartReplay.before)===json(restartReplay.after));
 const restartUpdateReplay=await mutation('persisted generated update receipt after restart','bounded','Bounded.Job.update',updateInputs,owner.held,updated.envelope.operation_id);
 check('persisted restart update saved result unchanged hash/history/versions',restartUpdateReplay.outcome.result?.status==='replayed'&&json(restartUpdateReplay.outcome.result?.result)===json(updated.outcome.result?.result)&&json(restartUpdateReplay.before)===json(restartUpdateReplay.after));
 const restartFailReplay=await mutation('persisted rejected receipt after restart','member','MemberControl.lateFail',{job:ref(memberRow),accept:false},member.held,rollback.envelope.operation_id);
 check('persisted restart rejection replay same stable business error',json(restartFailReplay.outcome)===json(rollback.outcome)&&json(restartFailReplay.before)===json(restartFailReplay.after));
 await writeFile(`${out}/qualification-checks.json`,json({status:checks.every(x=>x.passed)?'passed':'failed_before_repair',checks,persistedRestart:{beforeRestart,afterRestart},limitations:['Member control is separate authored complete source, not the original bounded source.','Identity uses actual resolver/live membership test memory store; state uses production D1 adapter on persisted local Miniflare.','Selected StoragePort binding is caller supplied; no deployed owner-storage routing or all-app qualification asserted.','Canonical generated model table does not join hooks/invariants/locks; no full-generated-hook qualification.']}));
 console.log(json({status:checks.every(x=>x.passed)?'passed':'failed_before_repair',checks:checks.length,failed:checks.filter(x=>!x.passed),vectors:receipts.length}));
}catch(e){await writeFile(`${out}/fatal-before-repair.json`,json({name:e.name,message:e.message,stack:e.stack,checks}));console.error(e);process.exitCode=1;}finally{if(mf)await mf.dispose();await save();}
