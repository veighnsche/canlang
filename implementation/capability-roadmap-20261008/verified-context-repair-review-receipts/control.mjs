import {readFile,writeFile,mkdtemp,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {dirname} from 'node:path';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const out=dirname(fileURLToPath(import.meta.url));
const packets=dirname(out);
const before=packets+'/verified-context-execution-before';
const candidate=JSON.parse(await readFile(packets+'/verified-context-repair/private-snapshot.json','utf8')).root;
const old=JSON.parse(await readFile(before+'/runtime-results.json','utf8')).runtime_root;
const artifact=JSON.parse(await readFile(before+'/artifact.json','utf8'));
const hash=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
const now=Date.parse('2026-10-08T10:20:30.123Z'),stamp=new Date(now).toISOString();
const evidence={node:{execPath:process.execPath,version:process.version,sha256:await hash(process.execPath)},source_sha256:await hash(before+'/VerifiedContext.can'),artifact_sha256:await hash(before+'/artifact.json'),runs:[],checks:[],commands_released:false};
const check=(name,condition,detail)=>{evidence.checks.push({name,passed:!!condition,detail});assert.ok(condition,name);};
const freshId=()=>{const t=now.toString(16).padStart(12,'0');return `${t.slice(0,8)}-${t.slice(8)}-7${randomUUID().slice(0,3)}-8${randomUUID().slice(0,3)}-${randomUUID().slice(-12)}`;};
async function run(root,label){
 const work=await mkdtemp('/private/tmp/canlang-context-independent-'+label+'-');
 const {assembleModules}=await import(root+'/packages/cloudflare/dist/runtime/modules.js');
 const {buildInvoker}=await import(root+'/packages/cloudflare/dist/worker/assembly.js');
 const {createTestMemoryStorage}=await import(root+'/packages/state/dist/src/storage/memory.js');
 const {FenceConflictError}=await import(root+'/packages/state/dist/src/storage/port.js');
 const {createMemoryIdentityStore,createFrozenClock}=await import(root+'/packages/identity/dist/src/testing.js');
 const {resolveIdentity,sha256HexText}=await import(root+'/packages/identity/dist/src/index.js');
 const stdlibPath=root+'/packages/cloudflare/dist/runtime/stdlib.js';
 const valuesPath=createRequire(root+'/packages/cloudflare/package.json').resolve('@canlang/values');
 const values=await import(valuesPath),stdlib=await import(stdlibPath);
 for(const name of ['datetime','compareInstant','int64'])check(label+' owning peer '+name,stdlib[name]===values[name]);
 const asm=await assembleModules({artifact,sourcePath:before+'/VerifiedContext.can'},{workDir:work,stdlibUrl:pathToFileURL(stdlibPath).href,uiUrl:pathToFileURL(root+'/packages/ui/dist/src/index.js').href});
 const identities=createMemoryIdentityStore({clock:createFrozenClock(now)});
 const team=await identities.createTeam({timezone:'Europe/Brussels'});
 const alien=await identities.createTeam({timezone:'Asia/Tokyo'});
 const user=await identities.createUser({email:'independent-'+label+'@example.test',password_hash:'test-only',email_verified:true});
 const membership=await identities.createMembership({team_id:team.team_id,user_id:user.user_id,is_owner:false,roles:[]});
 const token=randomUUID();await identities.createSession({user_id:user.user_id,token_sha256:await sha256HexText(token),expires_at:new Date(now+3600000).toISOString(),last_team_id:team.team_id});
 const resolve=(extra={})=>resolveIdentity(identities,{session_token:token,...extra},{clock:createFrozenClock(now)});
 const held=await resolve(),anonymous=await resolveIdentity(identities,{},{clock:createFrozenClock(now)});
 const {store,probe}=createTestMemoryStorage();const invoker=buildInvoker(artifact,asm,store,{memberships:identities,source:'mcp',now:()=>now});
 const runEvidence={label,root,work,valuesPath,valuesRealpath:await realpath(valuesPath),assembly:asm,team,user_id:user.user_id,held,anonymous,observations:[]};evidence.runs.push(runEvidence);
 const known=new Map();
 async function snapshot(){return {revision:await store.readRevision(),rows:await store.query({model:'VerifiedContext.Probe'}),outbox:probe.outboxAll(),schedules:await store.schedulesDue(now+86400000,100),receipts:await Promise.all([...known.values()].map(async identity=>({identity,receipt:await store.readReceipt(identity)})))};}
 async function call(suffix,inputs={},identity=held,id=freshId(),selected=invoker,name=suffix){
  const envelope={operation:'VerifiedContext.'+suffix,operation_id:id,inputs};
  const ri={app:'VerifiedContext',owner:identity.team?.team_id??'app',principal:identity.actor?.user_id??'public',operation:envelope.operation,operationId:id};known.set(JSON.stringify(ri),ri);
  const before=await snapshot();const outcome=await selected.invokeMutation(envelope,identity);const after=await snapshot();
  const observation={name,envelope,identity,before,outcome,after};runEvidence.observations.push(observation);return observation;
 }
 const exact=(o,w)=>o.outcome.result?.status==='committed'&&o.outcome.result.result===w;
 const unchanged=o=>JSON.stringify(o.before)===JSON.stringify(o.after);
 const baseline=await call('datetimeBaseline',{stamp});check(label+' unchanged baseline true',exact(baseline,true),baseline.outcome);
 let actor;
 for(const [suffix,wanted] of [['actorId',user.user_id],['teamId',team.team_id],['teamTimezone',team.timezone],['operationId','envelope'],['operationSource','mcp'],['nowEquals',true]]){
  const o=await call(suffix,suffix==='nowEquals'?{stamp}:{});if(suffix==='actorId')actor=o;
  if(label==='after')check(label+' exact '+suffix,exact(o,wanted==='envelope'?o.envelope.operation_id:wanted),o.outcome);
  else check(label+' missing ambient '+suffix,o.outcome.error?.code==='rule_failed',o.outcome);
 }
 const publicNull=await call('anonymousNull',{},anonymous);check(label+' actual public null branch',exact(publicNull,label==='after'),publicNull.outcome);
 if(label==='before')return;
 const unequal=await call('nowEquals',{stamp:'2026-10-08T10:20:30.124Z'});check('after ms mismatch false',exact(unequal,false),unequal.outcome);
 const replay=await call('actorId',{},await resolve(),actor.envelope.operation_id);check('after scalar exact replay unchanged',replay.outcome.result?.status==='replayed'&&replay.outcome.result.result===user.user_id&&unchanged(replay),replay.outcome);
 for(const [name,identity,inputs,code] of [['anonymous denial',anonymous,{},'forbidden'],['wrong team denial',await resolve({team_id:alien.team_id}),{},'forbidden'],['unknown ambient inputs',held,{actor:{id:'fake'},team:{id:'fake'},now:stamp,operation:{id:'fake',source:'fake'}},'validation']]){
  const o=await call('actorId',inputs,identity,freshId(),invoker,name);check('after '+name+' full state unchanged',o.outcome.error?.code===code&&unchanged(o),o.outcome);
 }
 const invalid=await call('nowEquals',{stamp:'malformed'});check('after exact owning rejection',invalid.outcome.error?.code==='rule_failed'&&invalid.outcome.error.message==='invalid datetime text: malformed',invalid.outcome);
 const invalidReplay=await call('nowEquals',{stamp:'malformed'},held,invalid.envelope.operation_id);check('after rejection replay exact and unchanged',JSON.stringify(invalidReplay.outcome.error)===JSON.stringify(invalid.outcome.error)&&unchanged(invalidReplay),invalidReplay.outcome);
 const samples=[],attempts=[];let competed=false,competitor;
 const observer=new Proxy(store,{get(target,key){if(key==='commit')return async batch=>{
  const entry={expectedRevision:batch.expectedRevision,receipt:batch.receipt,samples:[...samples]};attempts.push(entry);
  if(!competed){competed=true;competitor=await call('datetimeBaseline',{stamp},held,freshId(),invoker,'distinct real competitor');}
  try{const result=await target.commit(batch);entry.commit=result;return result;}catch(error){entry.error={name:error.name,message:error.message,realFence:error instanceof FenceConflictError};throw error;}
 };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const retryInvoker=buildInvoker(artifact,asm,observer,{memberships:identities,source:'mcp',now:()=>{const value=now+samples.length*1000;samples.push(value);return value;}});
 const retry=await call('nowEquals',{stamp},held,freshId(),retryInvoker,'real competing fence retry');
 runEvidence.retry={samples,attempts,competitor,retry};
 check('after one clock sample despite real fence retry',samples.length===1&&samples[0]===now&&exact(retry,true),{samples,outcome:retry.outcome});
 check('after actual two results fixed admitted millis',attempts.length===2&&attempts.every(x=>x.receipt.outcome.result===true&&x.receipt.createdAt===now)&&attempts[0].error?.realFence===true&&attempts[1].commit!==undefined&&attempts[1].expectedRevision===attempts[0].expectedRevision+1,attempts);
 check('after one final retry receipt and competitor receipt',retry.after.revision===retry.before.revision+2&&retry.after.receipts.filter(x=>x.identity.operationId===retry.envelope.operation_id&&x.receipt!==null).length===1&&retry.after.receipts.filter(x=>x.identity.operationId===competitor.envelope.operation_id&&x.receipt!==null).length===1,runEvidence.retry);
 await identities.removeMembership(membership.membership_id);
 for(const [name,identity] of [['held identity current revocation',held],['fresh identity current revocation',await resolve()]]){const o=await call('teamId',{},identity,freshId(),invoker,name);check('after '+name+' no receipt or state change',o.outcome.error?.code==='forbidden'&&unchanged(o),o.outcome);}
 const oldReplay=await call('actorId',{},held,actor.envelope.operation_id,invoker,'existing receipt after revocation');check('after preserves receipt-first replay after membership removal',oldReplay.outcome.result?.status==='replayed'&&oldReplay.outcome.result.result===user.user_id&&unchanged(oldReplay),oldReplay.outcome);
}
try{await run(old,'before');await run(candidate,'after');evidence.status='bounded_independent_controls_passed';}catch(error){evidence.status='failed';evidence.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1;}
evidence.commands_released=true;await writeFile(out+'/runtime-results.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({status:evidence.status,checks:evidence.checks.length,observations:evidence.runs.map(x=>({label:x.label,count:x.observations.length})),failed:evidence.checks.filter(x=>!x.passed),failure:evidence.failure}));
