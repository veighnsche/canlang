import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,copyFile,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname} from 'node:path';
import {createRequire} from 'node:module';
const out=dirname(fileURLToPath(import.meta.url)),repo='/Users/vince/Projects/canlang';
const before=`${repo}/implementation/capability-roadmap-20261008/verified-context-execution-before`;
const snapshot=JSON.parse(await readFile(`${out}/private-snapshot.json`,'utf8')),root=snapshot.root;
const sha=b=>createHash('sha256').update(b).digest('hex'),hash=async p=>sha(await readFile(p));
const json=x=>JSON.stringify(x,null,2)+'\n';
const observations=[],checks=[];
const check=(name,passed,detail)=>checks.push({name,passed:!!passed,detail});
const node={argv:process.argv,version:process.version,execPath:process.execPath,realpath:await realpath(process.execPath),sha256:await hash(process.execPath)};
assert.equal(node.sha256,'e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b');
const beforePins=JSON.parse(await readFile(`${before}/final-pins.json`,'utf8'));
for(const [rel,pin] of Object.entries(beforePins.pins))assert.equal(await hash(`${before}/${rel}`),pin,`immutable before ${rel}`);
for(const name of ['VerifiedContext.can','artifact.json'])await copyFile(`${before}/${name}`,`${out}/${name}`);
const artifact=JSON.parse(await readFile(`${out}/artifact.json`,'utf8'));
const {assembleModules}=await import(`${root}/packages/cloudflare/dist/runtime/modules.js`);
const {buildInvoker}=await import(`${root}/packages/cloudflare/dist/worker/assembly.js`);
const {createTestMemoryStorage}=await import(`${root}/packages/state/dist/src/storage/memory.js`);
const {FenceConflictError}=await import(`${root}/packages/state/dist/src/storage/schema.js`);
const {createMemoryIdentityStore,createFrozenClock}=await import(`${root}/packages/identity/dist/src/testing.js`);
const {resolveIdentity,sha256HexText}=await import(`${root}/packages/identity/dist/src/index.js`);
const req=createRequire(`${root}/packages/cloudflare/package.json`),valuesPath=req.resolve('@canlang/values');
const values=await import(valuesPath),stdlibPath=`${root}/packages/cloudflare/dist/runtime/stdlib.js`,stdlib=await import(stdlibPath);
for(const name of ['datetime','compareInstant','int64'])assert.equal(stdlib[name],values[name],`actual relay ${name}`);
const asm=await assembleModules({artifact,sourcePath:`${out}/VerifiedContext.can`},{workDir:`${out}/assembled`,stdlibUrl:pathToFileURL(stdlibPath).href,uiUrl:pathToFileURL(`${root}/packages/ui/dist/src/index.js`).href});
await import(asm.entryUrl);
const now=Date.parse('2026-10-08T10:20:30.123Z'),stamp=new Date(now).toISOString(),clock=createFrozenClock(now),identities=createMemoryIdentityStore({clock});
const team=await identities.createTeam({timezone:'Europe/Brussels'}),otherTeam=await identities.createTeam({timezone:'Asia/Tokyo'});
const user=await identities.createUser({email:'context-repair-member@example.test',password_hash:'private-test-only',email_verified:true});
const membership=await identities.createMembership({team_id:team.team_id,user_id:user.user_id,is_owner:false,roles:[]});
const token=randomUUID(),tokenHash=await sha256HexText(token);
await identities.createSession({user_id:user.user_id,token_sha256:tokenHash,expires_at:new Date(now+3600000).toISOString(),last_team_id:team.team_id});
const resolveMember=()=>resolveIdentity(identities,{session_token:token},{clock});
const member=await resolveMember(),anonymous=await resolveIdentity(identities,{},{clock});
const {store,probe}=createTestMemoryStorage();
const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now,source:'mcp'});
const id=()=>{const t=now.toString(16).padStart(12,'0'),r=randomUUID();return `${t.slice(0,8)}-${t.slice(8)}-7${r.slice(15,18)}-8${r.slice(20,23)}-${r.slice(24)}`;};
const receiptIdentities=[];
async function snapshotState(){const receipts=[];for(const identity of receiptIdentities)receipts.push({identity,receipt:await store.readReceipt(identity)});return {revision:await store.readRevision(),records:await store.query({model:'VerifiedContext.Probe'}),outbox:probe.outboxAll(),schedules:await store.schedulesDue(now+86400000,100),receipts};}
const metadata={status:'running',node,root,foundation:snapshot.foundation,qualification:snapshot.qualification,now,stamp,identity_qualification:'Actual credential resolver/current membership admission over test memory identity; actual canonical State engine/test memory storage. No installed or durable qualification.',member,anonymous,team,user_id:user.user_id,source_sha256:await hash(`${out}/VerifiedContext.can`),artifact_sha256:await hash(`${out}/artifact.json`),before_manifest_sha256:await hash(`${before}/final-pins.json`),assembly:{entryUrl:asm.entryUrl,moduleUrls:asm.moduleUrls,stdlibPath,valuesPath},commands_released:false};
async function save(){await writeFile(`${out}/runtime-results.json`,json({...metadata,observations,checks}));}
async function invoke(name,suffix,inputs={},identity=member,operation_id=id(),selectedInvoker=invoker){
 const envelope={operation:`VerifiedContext.${suffix}`,operation_id,inputs};
 const ri={app:'VerifiedContext',owner:identity.team?.team_id??'app',principal:identity.actor?.user_id??'public',operation:envelope.operation,operationId:operation_id};
 if(!receiptIdentities.some(x=>JSON.stringify(x)===JSON.stringify(ri)))receiptIdentities.push(ri);
 const beforeState=await snapshotState(),outcome=await selectedInvoker.invokeMutation(envelope,identity),afterState=await snapshotState();
 const observation={name,envelope,actor_user_id:identity.actor?.user_id??null,selected_team_id:identity.team?.team_id??null,before:beforeState,outcome,after:afterState};observations.push(observation);await save();return observation;
}
try {
 const baseline=await invoke('unchanged current-source caller-text baseline','datetimeBaseline',{stamp});
 check('real producer datetime baseline remains true',baseline.outcome.result?.status==='committed'&&baseline.outcome.result.result===true,baseline.outcome);
 for(const [suffix,expected] of [['actorId',user.user_id],['teamId',team.team_id],['teamTimezone',team.timezone],['operationId','envelope-id'],['operationSource','mcp'],['nowEquals',true]]){
  const o=await invoke(`actual repaired ${suffix}`,suffix,suffix==='nowEquals'?{stamp}:{});
  const wanted=expected==='envelope-id'?o.envelope.operation_id:expected;
  check(`actual unchanged source ${suffix} exact admitted result`,o.outcome.result?.status==='committed'&&o.outcome.result.result===wanted,{actual:o.outcome,expected:wanted});
 }
 const unequal=await invoke('exact nonzero millisecond datetime mismatch','nowEquals',{stamp:'2026-10-08T10:20:30.124Z'});
 check('one millisecond difference is false',unequal.outcome.result?.status==='committed'&&unequal.outcome.result.result===false,unequal.outcome);
 const anon=await invoke('actual repaired public actor null','anonymousNull',{},anonymous);
 check('anonymous actual source now branches true for null actor',anon.outcome.result?.status==='committed'&&anon.outcome.result.result===true,anon.outcome);
 const actorRead=observations.find(x=>x.name==='actual repaired actorId');
 const replay=await invoke('actual successful scalar actor result replay','actorId',{},await resolveMember(),actorRead.envelope.operation_id);
 check('exact successful scalar replay has no state change',replay.outcome.result?.status==='replayed'&&replay.outcome.result.result===actorRead.outcome.result.result&&JSON.stringify(replay.before)===JSON.stringify(replay.after),replay.outcome);
 const anonDenied=await invoke('anonymous member denial preserved','actorId',{},anonymous);
 check('anonymous member denial before receipt unchanged',anonDenied.outcome.error?.code==='forbidden'&&anonDenied.before.revision===anonDenied.after.revision,anonDenied.outcome);
 const wrongScopeIdentity=await resolveIdentity(identities,{session_token:token,team_id:otherTeam.team_id},{clock});
 const wrongScope=await invoke('wrong selected team member denial preserved','teamId',{},wrongScopeIdentity);
 check('wrong-team members denial before receipt unchanged',wrongScope.outcome.error?.code==='forbidden'&&wrongScope.before.revision===wrongScope.after.revision,wrongScope.outcome);
 const spoof=await invoke('ambient input spoof refusal preserved','actorId',{actor:{id:'forged'},team:{id:'forged'},now:stamp,operation:{id:'forged',source:'forged'}});
 check('closed business input spoof refused before receipt',spoof.outcome.error?.code==='validation'&&spoof.before.revision===spoof.after.revision,spoof.outcome);
 const malformed=await invoke('real datetime malformed caller text refusal','nowEquals',{stamp:'malformed'});
 check('owning malformed datetime error preserved',malformed.outcome.error?.code==='rule_failed'&&malformed.outcome.error.message==='invalid datetime text: malformed',malformed.outcome);

 const hostClockSamples=[],commitAttempts=[];
 let forced=false,competitorOutcome;
 const retryId=id();
 const contendingStore=new Proxy(store,{get(target,key){if(key==='commit')return async batch=>{
   const attempt={expectedRevision:batch.expectedRevision,receipt_operation:batch.receipt?.identity.operation,result:batch.receipt?.outcome.result,createdAt:batch.receipt?.createdAt,hostClockSamples:[...hostClockSamples]};commitAttempts.push(attempt);
   if(!forced){forced=true;competitorOutcome=await invoke('real competing canonical commit to move fence','datetimeBaseline',{stamp});}
   try{const result=await target.commit(batch);attempt.commit=result;return result;}catch(error){attempt.error={name:error.name,message:error.message,real_FenceConflictError:error instanceof FenceConflictError};throw error;}
  }; const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const advancingClock=()=>{const sample=now+hostClockSamples.length*1000;hostClockSamples.push(sample);return sample;};
 const retryInvoker=buildInvoker(artifact,asm,contendingStore,{memberships:identities,now:advancingClock,source:'mcp'});
 const retried=await invoke('real fence retry keeps first admitted now despite advancing host clock','nowEquals',{stamp},await resolveMember(),retryId,retryInvoker);
 check('forced retry observes exactly two real handler-result commits',commitAttempts.length===2&&commitAttempts.every(x=>x.result===true&&x.createdAt===now)&&commitAttempts[0].error?.real_FenceConflictError===true&&commitAttempts[1].commit!==undefined,{commitAttempts,competitor:competitorOutcome.outcome});
 check('retry does not resample advancing host clock',hostClockSamples.length===1&&hostClockSamples[0]===now&&retried.outcome.result?.status==='committed'&&retried.outcome.result.result===true,{hostClockSamples,outcome:retried.outcome});
 const retryReceipts=retried.after.receipts.filter(x=>x.identity.operationId===retryId&&x.receipt!==null);
 check('retry commits one final receipt plus one distinct competing receipt',retryReceipts.length===1&&retried.after.revision===retried.before.revision+2&&retryReceipts[0].receipt.outcome.result===true,{retryReceipts,before_revision:retried.before.revision,after_revision:retried.after.revision});
 await writeFile(`${out}/retry-control.json`,json({kind:'Real StoragePort commit interleaving; competing actual canonical operation advances memory fence. No forged context, handler patch or manufactured conflict error.',commitAttempts,hostClockSamples,competitor:competitorOutcome,retried}));
 await identities.removeMembership(membership.membership_id);
 const revoked=await invoke('fresh current membership removal denial preserved','teamId',{},await resolveMember());
 check('revoked member denial before receipt unchanged',revoked.outcome.error?.code==='forbidden'&&revoked.before.revision===revoked.after.revision,revoked.outcome);
 for(const [rel,pin] of Object.entries(beforePins.pins))assert.equal(await hash(`${before}/${rel}`),pin,`before still frozen ${rel}`);
 for(const [rel,pin] of Object.entries(snapshot.overlays))assert.equal(await hash(`${root}/${rel}`),pin.copied_sha256,`private overlay unchanged ${rel}`);
 metadata.status=checks.every(x=>x.passed)?'narrow_context_candidate_passed_pending_independent_review':'candidate_failed';metadata.commands_released=true;
 await save();
 await writeFile(`${out}/qualification-checks.json`,json({status:metadata.status,checks,observations:observations.length,product_acceptance:false,seq010_complete:false,commands_released:true,limits:['Scalar source reads and bool comparisons only; no typed value writes/defaults/results serialization qualification.','Full actor auth facts/no-team/direct/trusted/hook/page/locale policy remains unqualified.','Actual memory StoragePort retry and replay only; no D1/reopen/process crash or installed identity qualification.','Other package/runtime bodies remain copied frozen nullable-after, not arbitrary current graph.']}));
 console.log(json({status:metadata.status,observations:observations.length,checks:checks.length,failed:checks.filter(x=>!x.passed),two_retry_attempts:commitAttempts.length,host_clock_samples:hostClockSamples}));
 if(checks.some(x=>!x.passed))process.exitCode=1;
}catch(error){await writeFile(`${out}/fatal-after.json`,json({name:error.name,message:error.message,stack:error.stack,observations,checks,commands_released:true}));console.error(error);process.exitCode=1;}
