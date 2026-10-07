import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
const snapshot='/private/tmp/canlang-nullable-ref-after-db57c379';
const out=fileURLToPath(new URL('./',import.meta.url));
const privateRoot='/private/tmp/canlang-nullable-ref-after-d1-final';
const artifactPath=new URL('../f1-metadata/artifacts/bounded-compile.json',import.meta.url);
const sourcePath=fileURLToPath(new URL('../f1-metadata/Bounded.can',import.meta.url));
const sha=x=>createHash('sha256').update(x).digest('hex');
const json=x=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?`${v}n`:v,2)+'\n';
const raw=await readFile(artifactPath),artifact=JSON.parse(raw);
assert.equal(sha(raw),'9f39ab8caf73621ab825eeb1db0507282d38932884d1316c9029a7be5060b343');
const {Miniflare}=createRequire(`${snapshot}/packages/cloudflare/package.json`)('miniflare');
const {assembleModules}=await import(`${snapshot}/packages/cloudflare/dist/runtime/modules.js`);
const {buildInvoker}=await import(`${snapshot}/packages/cloudflare/dist/worker/assembly.js`);
const {createD1Storage,ensureSchema}=await import(`${snapshot}/packages/state/dist/src/storage/d1.js`);
const {createMemoryIdentityStore,createFrozenClock}=await import(`${snapshot}/packages/identity/dist/src/testing.js`);
const {resolveIdentity,sha256HexText}=await import(`${snapshot}/packages/identity/dist/src/index.js`);
const runtimePath=`${snapshot}/packages/cloudflare/dist/runtime/stdlib.js`;
await mkdir(privateRoot,{recursive:true});
const assembled=await assembleModules({artifact,sourcePath},{workDir:`${privateRoot}/modules`,stdlibUrl:pathToFileURL(runtimePath).href,uiUrl:pathToFileURL(`${snapshot}/packages/ui/dist/src/index.js`).href});
const now=Date.now(),clock=createFrozenClock(now),identityStore=createMemoryIdentityStore({clock});
const team=await identityStore.createTeam({}),user=await identityStore.createUser({email:'nullable-after@test.invalid',password_hash:'x',email_verified:true});
await identityStore.createMembership({team_id:team.team_id,user_id:user.user_id,is_owner:true,roles:[]});
const token=randomUUID();await identityStore.createSession({user_id:user.user_id,token_sha256:await sha256HexText(token),expires_at:new Date(now+3600000).toISOString(),last_team_id:team.team_id});
const identity=await resolveIdentity(identityStore,{session_token:token},{clock});
const opId=()=>{const t=now.toString(16).padStart(12,'0'),r=randomUUID();return `${t.slice(0,8)}-${t.slice(8)}-7${r.slice(15,18)}-8${r.slice(20,23)}-${r.slice(24)}`};
let mf,db,store,invoker;
async function open(){
 mf=new Miniflare({modules:true,script:'export default { fetch() { return new Response("ok"); } }',d1Databases:{DB:'nullable-ref-after-bounded'},d1Persist:`${privateRoot}/persist`});
 db=await mf.getD1Database('DB');await ensureSchema(db);store=createD1Storage(db);
 invoker=buildInvoker(artifact,assembled,store,{memberships:identityStore,now:()=>now});
}
async function snap(){const tables={};for(const table of ['records','history','receipts','outbox','schedules','fence','fence_log'])tables[table]=(await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;return {revision:await store.readRevision(),tables};}
const receipts=[],checks=[];
function check(name,passed,detail){checks.push({name,passed:!!passed,detail});}
async function save(){await writeFile(`${out}/runtime-results.json`,json({qualification:'Unchanged actual Bounded artifact; production assembler, canonical invoker and State D1 adapter; Cloudflare runtime peer; actual identity resolver with memory identity store; persisted Miniflare D1 dispose/reopen and fresh invoker in same Node host.',snapshot,privateRoot,artifactPath:fileURLToPath(artifactPath),artifactSha256:sha(raw),runtimePath,now,receipts}));await writeFile(`${out}/qualification-checks.json`,json({checks,passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).length}));}
async function mutation(name,operation,inputs,id=opId()){
 const before=await snap(),envelope={operation,operation_id:id,inputs};let outcome;
 try{outcome=await invoker.invokeMutation(envelope,identity)}catch(e){outcome={throw:{name:e.name,message:e.message,stack:e.stack}}}
 const after=await snap(),r={name,envelope,outcome,before,after};receipts.push(r);await save();return r;
}
const committed=r=>r.outcome.result?.status==='committed';
const error=(r,code)=>r.outcome.error?.code===code;
const row=(r,id=r.envelope.operation_id)=>r.after.tables.records.find(x=>x.model==='Bounded.Job'&&x.id===id);
const ref=r=>({id:r.id,version:String(r.version)});
const unchanged=r=>json(r.before)===json(r.after);
function replayCheck(name,r,original){check(name,r.outcome.result?.status==='replayed'&&json(r.outcome.result.result)===json(original.outcome.result.result)&&unchanged(r),{outcome:r.outcome});}
try{
 await open();check('fresh private persisted D1', (await snap()).tables.records.length===0);
 const account=await mutation('Account default create','Bounded.Account.create',{});
 check('scalar account commits',committed(account));
 const accountRow=account.after.tables.records.find(x=>x.model==='Bounded.Account'&&x.id===account.envelope.operation_id);
 const omitted=await mutation('omitted nullable Job create','Bounded.Job.create',{});
 const explicit=await mutation('explicit null Job create','Bounded.Job.create',{account:null});
 for(const r of [omitted,explicit]){
  const current=row(r),data=current?JSON.parse(current.data):null,result=r.outcome.result?.result?.data;
  check(`${r.name} persists source-owned null at version 1`,committed(r)&&current?.version===1&&data?.account===null&&result?.account===null,{row:current,result:r.outcome.result});
  check(`${r.name} exact scalar/machine defaults and representation`,data?.title==='test'&&data?.count==='1'&&typeof data?.count==='string'&&data?.enabled===true&&data?.status==='idle'&&typeof current?.version==='number',{persisted:data,runtimeTypes:Object.fromEntries(Object.entries(result??{}).map(([k,v])=>[k,v===null?'null':typeof v]))});
  const stored=r.after.tables.receipts.find(x=>x.operation_id===r.envelope.operation_id);
  const defaults=stored?JSON.parse(stored.resolved_defaults):null;
  check(`${r.name} creation receipt stores exact null-fill ownership`,!!stored&&defaults?.title==='test'&&defaults?.count==='1'&&defaults?.enabled===true&&defaults?.status==='idle'&&(r===omitted?Object.hasOwn(defaults,'account')&&defaults.account===null:!Object.hasOwn(defaults,'account')),{receipt:stored,defaults});
  replayCheck(`${r.name} retry unchanged`,await mutation(`${r.name} retry`,'Bounded.Job.create',r.envelope.inputs,r.envelope.operation_id),r);
 }
 const referenced=await mutation('current versioned nullable ref create','Bounded.Job.create',{account:ref(accountRow)});
 check('current ref create commits',committed(referenced)&&JSON.parse(row(referenced).data).account.id===accountRow.id);
 const omissionUpdate=await mutation('update omission keeps supplied ref','Bounded.Job.update',{record:ref(row(referenced))});
 check('update omission keeps current account ref',committed(omissionUpdate)&&JSON.parse(row(omissionUpdate,row(referenced).id).data).account.id===accountRow.id);
 const oldRow=row(omissionUpdate,row(referenced).id);
 const clear=await mutation('current ref cleared to null','Bounded.Job.update',{record:ref(oldRow),account:null});
 const cleared=row(clear,oldRow.id);
 check('clear commits null with exactly one net version',committed(clear)&&cleared.version===oldRow.version+1&&JSON.parse(cleared.data).account===null,{row:cleared});
 replayCheck('clear retry precedes stale ref and preserves result/hash/state',await mutation('matching clear retry','Bounded.Job.update',clear.envelope.inputs,clear.envelope.operation_id),clear);
 const changed=await mutation('same id changed null payload','Bounded.Job.update',{record:ref(oldRow),title:'changed'},clear.envelope.operation_id);
 check('changed same-id payload conflicts without effects',error(changed,'conflict')&&unchanged(changed));
 const stale=await mutation('fresh stale null update','Bounded.Job.update',{record:ref(oldRow),account:null});
 check('fresh stale ref still conflicts unchanged',error(stale,'conflict')&&unchanged(stale));
 for(const [name,operation,inputs,code] of [
  ['missing nullable target','Bounded.Job.create',{account:{id:'missing',version:'1'}},'not_found'],
  ['wrong model typed ref','Bounded.Job.update',{record:ref(accountRow),account:null},'not_found'],
  ['missing version nonnull','Bounded.Job.create',{account:{id:accountRow.id}},'validation'],
  ['malformed version nonnull','Bounded.Job.create',{account:{id:accountRow.id,version:'01'}},'validation'],
  ['ref array remains invalid','Bounded.Job.create',{account:[]},'validation'],
  ['nonnull malformed shape remains invalid','Bounded.Job.create',{account:'invalid'},'validation'],
  ['required record explicit null remains invalid','Bounded.Job.update',{record:null,account:null},'validation'],
 ]){const r=await mutation(name,operation,inputs);check(`${name} refuses before effects`,error(r,code)&&unchanged(r),{outcome:r.outcome});}
 const advanced=await mutation('two edges on default-null created Job','Bounded.advance',{job:ref(row(omitted))});
 const advancedRow=row(advanced,row(omitted).id),history=advanced.after.tables.history.filter(x=>x.operation_id===advanced.envelope.operation_id);
 check('two ordered edges retain null account and one version',committed(advanced)&&advancedRow.version===2&&JSON.parse(advancedRow.data).account===null&&JSON.parse(advancedRow.data).status==='ready'&&history.length===2&&history.every(x=>x.version===2)&&JSON.parse(history[0].after).status==='queued'&&JSON.parse(history[1].after).status==='ready',{row:advancedRow,history});
 const beforeRestart=await snap();await mf.dispose();await open();const afterRestart=await snap();receipts.push({name:'persist dispose/reopen with fresh invoker',before:beforeRestart,after:afterRestart});
 check('same private D1 persist directory reopens exact state',json(beforeRestart)===json(afterRestart));
 for(const r of [omitted,explicit,clear])replayCheck(`reopened ${r.name} matching replay`,await mutation(`reopened ${r.name} replay`,r.envelope.operation,r.envelope.inputs,r.envelope.operation_id),r);
 const advancedReplay=await mutation('reopened void scenario replay',advanced.envelope.operation,advanced.envelope.inputs,advanced.envelope.operation_id);
 check('reopened void scenario replay preserves domain state/history/hash',advancedReplay.outcome.result?.status==='replayed'&&unchanged(advancedReplay));
 check('void scenario replay preserves exact runtime result representation',Object.is(advancedReplay.outcome.result?.result,advanced.outcome.result?.result),{committedType:typeof advanced.outcome.result?.result,replayedType:typeof advancedReplay.outcome.result?.result,committed:advanced.outcome,replayed:advancedReplay.outcome});
 const beforeRead=await snap(),read=await invoker.invokeRead({operation:'Bounded.Job.read',inputs:{}},identity),afterRead=await snap();receipts.push({name:'public exact known records read',outcome:read,before:beforeRead,after:afterRead});
 const records=read.result?.records;
 const expected=[advancedRow,row(explicit),cleared].map(r=>({id:r.id,version:r.version,data:JSON.parse(r.data)})).sort((a,b)=>a.id.localeCompare(b.id));
 const actual=Array.isArray(records)?records.map(r=>({id:r.id,version:r.version,data:{title:r.data.title,count:r.data.count,enabled:r.data.enabled,account:r.data.account,status:r.data.status}})).sort((a,b)=>a.id.localeCompare(b.id)):null;
 let exactProjection=false;try{assert.deepEqual(actual,expected);exactProjection=true}catch{}
 check('public read returns exact three known null-account projections unchanged',exactProjection&&json(beforeRead)===json(afterRead),{expected,actual,read});
}catch(e){receipts.push({name:'fatal retained',error:{name:e.name,message:e.message,stack:e.stack}});check('harness completed without fatal',false);process.exitCode=1;}finally{if(mf)await mf.dispose();await save();}
console.log(json({checks:checks.length,passed:checks.filter(c=>c.passed).length,failed:checks.filter(c=>!c.passed).map(c=>c.name),privateRoot}));
if(checks.some(c=>!c.passed))process.exitCode=1;
