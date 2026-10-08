import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,resolve} from 'node:path';

const out=dirname(fileURLToPath(import.meta.url));
const repo='/Users/vince/Projects/canlang';
const frozen='/private/tmp/canlang-runtime-pure-after-db57c379';
const compiler='/private/tmp/can-compiler-0134ebb0-page-handoff/can';
const catalog=`${repo}/packages/values/dist/catalog.json`;
const source=`${out}/VerifiedContext.can`;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hash=async path=>sha(await readFile(path));
const json=value=>JSON.stringify(value,null,2)+'\n';
const commands=[];
const observations=[];
const checks=[];
let producerPins;
const check=(name,passed,detail)=>checks.push({name,passed:!!passed,detail});
async function save(name,value){await writeFile(`${out}/${name}`,json(value));}
async function command(name,executable,args,cwd=repo,timeout=30000){
 const started=Date.now();
 const result=spawnSync(executable,args,{cwd,encoding:'utf8',timeout,maxBuffer:10*1024*1024});
 await writeFile(`${out}/logs/${name}.stdout`,result.stdout??'');
 await writeFile(`${out}/logs/${name}.stderr`,result.stderr??'');
 const entry={name,argv:[executable,...args],cwd,timeout_ms:timeout,elapsed_ms:Date.now()-started,exit_code:result.status,signal:result.signal,error:result.error?{name:result.error.name,message:result.error.message}:null,stdout:`logs/${name}.stdout`,stderr:`logs/${name}.stderr`};
 commands.push(entry);await save('commands.json',commands);return result;
}
async function pinPaths(paths){const pins={};for(const path of paths)pins[path]={sha256:await hash(path),realpath:await realpath(path)};return pins;}
async function saveObservations(metadata){await save('runtime-results.json',{...metadata,observations,checks});}

await mkdir(`${out}/logs`,{recursive:true});
try {
 const node={argv:process.argv,execArgv:process.execArgv,version:process.version,execPath:process.execPath,realpath:await realpath(process.execPath),sha256:await hash(process.execPath),cwd:process.cwd()};
 assert.equal(node.sha256,'e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b');
 assert.equal(node.version,'v24.21.0');
 assert.equal(await hash(compiler),'b2608559e9af0e934a0727faad1d31aee43528cb87a9359f3576a6d8b3db3a7e');
 assert.equal(await hash(catalog),'cd984f375e0d6cbcc2bc6aca5ad5ea5b1b3d3ba9cd17b15ab94e4b15e74ced62');
 await save('execution-tool.json',node);
 const version=await command('compiler-version',compiler,['--version']);assert.equal(version.status,0);
 const references=[`${repo}/implementation/compiler-completion/selected-page-cli-handoff.json`,`${repo}/implementation/capability-roadmap-20261008/runtime-pure-helpers/final-pins.json`,`${repo}/implementation/capability-roadmap-20261008/runtime-pure-helpers-review.json`,`${repo}/implementation/capability-roadmap-20261008/runtime-pure-helpers-review-receipts/review-pins.json`,`${repo}/implementation/capability-roadmap-20261008/f1-invocation/MemberControl.can`,`${repo}/implementation/capability-roadmap-20261008/f1-invocation/run-before-read-strengthening.mjs`];
 const manifest=JSON.parse(await readFile(references[1],'utf8'));
 const existingFrozenPaths=Object.keys(manifest.selected_outputs_and_support).filter(p=>p.startsWith(frozen+'/'));
 const frozenChecks=[];for(const path of existingFrozenPaths){const actual=await hash(path),expected=manifest.selected_outputs_and_support[path];assert.equal(actual,expected,path);frozenChecks.push({path,expected,actual,matched:true});}
 const supplemental=['packages/cloudflare/src/runtime/context.ts','packages/cloudflare/src/runtime/invoke.ts','packages/cloudflare/src/runtime/stdlib.ts','packages/cloudflare/src/worker/assembly.ts','packages/cloudflare/dist/runtime/context.js','packages/state/src/invocation/context.ts','packages/state/src/invocation/invoke.ts','packages/state/src/storage/memory.ts','packages/state/dist/src/storage/memory.js','packages/state/dist/src/invocation/context.js','packages/state/dist/src/invocation/invoke.js','packages/state/dist/src/invocation/admission.js','packages/state/dist/src/invocation/registry.js','packages/state/dist/src/mutation/pipeline.js','packages/state/dist/src/effects/guards.js','packages/identity/dist/src/authentication/context.js','packages/identity/src/authentication/context.ts','packages/contracts/src/state.ts','packages/contracts/src/values.ts','packages/values/src/kinds.ts','packages/values/src/temporal.ts'].map(p=>`${frozen}/${p}`);
 const currentPaths=['packages/cloudflare/src/runtime/context.ts','packages/cloudflare/src/runtime/invoke.ts','packages/cloudflare/src/runtime/stdlib.ts','packages/state/src/invocation/context.ts','packages/state/src/invocation/invoke.ts','packages/state/src/mutation/pipeline.ts','packages/contracts/src/state.ts','packages/contracts/src/values.ts','compiler/src/codegen/ir.rs','compiler/src/codegen/js.rs','compiler/src/analysis/types.rs'].map(p=>`${repo}/${p}`);
 const head=await command('current-head','/usr/bin/git',['rev-parse','HEAD'],repo,10000);assert.equal(head.status,0);
 const status=await command('current-target-status','/usr/bin/git',['status','--short','--',...currentPaths],repo,10000);assert.equal(status.status,0);
 producerPins={current_commit:head.stdout.trim(),current_target_status:status.stdout,current_source_observations:await pinPaths(currentPaths),frozen_verified_outputs:frozenChecks,frozen_supplemental:await pinPaths(supplemental),evidence_references:await pinPaths(references),tools:await pinPaths([compiler,catalog,process.execPath]),source:await pinPaths([source,`${out}/run.mjs`]),qualification:'Current frozen CLI against unchanged db57 runtime bodies plus accepted pure exports. This is not a current runtime refresh, codec/identity installation or source-plan provenance proof.'};
 await save('producer-pins.json',producerPins);
 const checked=await command('raw-check',compiler,['check','--format=json','--catalog',catalog,source]);assert.equal(checked.status,0,'actual source check');
 const compiled=await command('raw-compile',compiler,['compile','--format=json','--catalog',catalog,source]);assert.equal(compiled.status,0,'actual source compile');
 const artifactRaw=compiled.stdout,artifact=JSON.parse(artifactRaw);await writeFile(`${out}/artifact.json`,artifactRaw);
 assert.ok(Array.isArray(artifact.modules)&&artifact.modules.length>0,'actual compiler modules');
 await mkdir(`${out}/generated`,{recursive:true});
 const generated=[];for(const mod of artifact.modules){const path=resolve(`${out}/generated`,mod.path);assert.ok(path.startsWith(`${out}/generated/`));await mkdir(dirname(path),{recursive:true});await writeFile(path,mod.source??mod.code??mod.js);generated.push({path,module_path:mod.path,sha256:await hash(path)});}
 await save('compile-output-pins.json',{artifact:{path:`${out}/artifact.json`,sha256:await hash(`${out}/artifact.json`)},generated,source_sha256:await hash(source)});

 const {assembleModules}=await import(`${frozen}/packages/cloudflare/dist/runtime/modules.js`);
 const {buildInvoker}=await import(`${frozen}/packages/cloudflare/dist/worker/assembly.js`);
 const {createTestMemoryStorage}=await import(`${frozen}/packages/state/dist/src/storage/memory.js`);
 const {createMemoryIdentityStore,createFrozenClock}=await import(`${frozen}/packages/identity/dist/src/testing.js`);
 const {resolveIdentity,sha256HexText}=await import(`${frozen}/packages/identity/dist/src/index.js`);
 const stdlibPath=`${frozen}/packages/cloudflare/dist/runtime/stdlib.js`;
 const stdlib=await import(stdlibPath);
 const req=createRequire(`${frozen}/packages/cloudflare/package.json`),valuesPath=req.resolve('@canlang/values'),values=await import(valuesPath);
 for(const name of ['datetime','compareInstant','int64'])assert.equal(stdlib[name],values[name],`actual producer relay ${name}`);
 const asm=await assembleModules({artifact,sourcePath:source},{workDir:`${out}/assembled`,stdlibUrl:pathToFileURL(stdlibPath).href,uiUrl:pathToFileURL(`${frozen}/packages/ui/dist/src/index.js`).href});
 const loadedModule=await import(asm.entryUrl);assert.equal(typeof loadedModule.canApp,'function');
 const now=Date.parse('2026-10-08T10:20:30.123Z'),clock=createFrozenClock(now),identityStore=createMemoryIdentityStore({clock});
 const team=await identityStore.createTeam({timezone:'Europe/Brussels'}),otherTeam=await identityStore.createTeam({timezone:'Asia/Tokyo'});
 const user=await identityStore.createUser({email:'verified-context-member@example.test',password_hash:'private-test-only',email_verified:true});
 const membership=await identityStore.createMembership({team_id:team.team_id,user_id:user.user_id,is_owner:false,roles:[]});
 const token=randomUUID(),tokenHash=await sha256HexText(token);
 const session=await identityStore.createSession({user_id:user.user_id,token_sha256:tokenHash,expires_at:new Date(now+3600000).toISOString(),last_team_id:team.team_id});
 const resolveMember=()=>resolveIdentity(identityStore,{session_token:token},{clock});
 const member=await resolveMember(),anonymous=await resolveIdentity(identityStore,{},{clock});
 assert.equal(member.actor.user_id,user.user_id);assert.equal(member.team.team_id,team.team_id);assert.equal(member.membership.membership_id,membership.membership_id);
 const {store,probe}=createTestMemoryStorage();
 const invoker=buildInvoker(artifact,asm,store,{memberships:identityStore,now:()=>now,source:'mcp'});
 const operationId=()=>{const t=now.toString(16).padStart(12,'0'),r=randomUUID();return `${t.slice(0,8)}-${t.slice(8)}-7${r.slice(15,18)}-8${r.slice(20,23)}-${r.slice(24)}`;};
 const identities={member,anonymous,user_id:user.user_id,team_id:team.team_id,team_timezone:team.timezone,other_team_id:otherTeam.team_id,membership_id:membership.membership_id,session_id:session.session_id,session_token_sha256:tokenHash};
 const receiptIdentities=[];
 async function snapshot(){const receipts=[];for(const identity of receiptIdentities)receipts.push({identity,receipt:await store.readReceipt(identity)});return {revision:await store.readRevision(),records:await store.query({model:'VerifiedContext.Probe'}),history:probe.historyFor('VerifiedContext.Probe','unused'),outbox:probe.outboxAll(),schedules:await store.schedulesDue(now+86400000,100),receipts};}
 const metadata={status:'running_before_repair',runtime_root:frozen,node,compiler,catalog,source,now,stamp:new Date(now).toISOString(),identity_qualification:'Production credential/session resolver and current membership reader with test memory identity store; canonical State engine over test memory storage, no installed identity/durable claim.',identities,assembler:{entryUrl:asm.entryUrl,moduleUrls:asm.moduleUrls,stdlibUrl:pathToFileURL(stdlibPath).href,valuesPath},artifact_sha256:sha(artifactRaw)};
 async function invoke(name,suffix,inputs={},identity=member,id=operationId(),receiptKind='user'){
  const envelope={operation:`VerifiedContext.${suffix}`,operation_id:id,inputs};
  const receiptIdentity={app:'VerifiedContext',owner:identity.team?.team_id??'app',principal:identity.actor?.user_id??'public',operation:envelope.operation,operationId:id};
  if(!receiptIdentities.some(x=>JSON.stringify(x)===JSON.stringify(receiptIdentity)))receiptIdentities.push(receiptIdentity);
  const before=await snapshot();
  const outcome=await invoker.invokeMutation(envelope,identity),after=await snapshot();
  const observation={name,envelope,actor_user_id:identity.actor?.user_id??null,selected_team_id:identity.team?.team_id??null,before,outcome,after};observations.push(observation);await saveObservations(metadata);return observation;
 }
 const baseline=await invoke('caller-text datetime positive baseline','datetimeBaseline',{stamp:new Date(now).toISOString()});
 check('actual current source caller-text temporal baseline executes true',baseline.outcome.result?.status==='committed'&&baseline.outcome.result?.result===true,baseline.outcome);
 for(const [suffix,expected] of [['actorId',user.user_id],['teamId',team.team_id],['teamTimezone',team.timezone],['operationId','same-envelope-id'],['operationSource','mcp'],['nowEquals',true]]){
  const observed=await invoke(`independent ${suffix} read`,suffix,suffix==='nowEquals'?{stamp:new Date(now).toISOString()}:{});
  observed.expected_after_narrow_repair=expected==='same-envelope-id'?observed.envelope.operation_id:expected;
  check(`before mismatch ${suffix} fails independently`,observed.outcome.error?.code==='rule_failed',{outcome:observed.outcome,expected_after_narrow_repair:observed.expected_after_narrow_repair});
  check(`before ${suffix} rejection has no domain/work writes`,JSON.stringify(observed.before.records)===JSON.stringify(observed.after.records)&&JSON.stringify(observed.before.outbox)===JSON.stringify(observed.after.outbox)&&JSON.stringify(observed.before.schedules)===JSON.stringify(observed.after.schedules),{before_revision:observed.before.revision,after_revision:observed.after.revision});
 }
 const anon=await invoke('anonymous meaningful null control','anonymousNull',{},anonymous);
 check('anonymous before mismatch is recorded as false rather than null success',anon.outcome.result?.status==='committed'&&anon.outcome.result.result===false,{actual:anon.outcome,expected_after_narrow_repair:true});
 const denied=await invoke('anonymous member admission refuses before handler','actorId',{},anonymous);
 check('anonymous members denial has no receipt or revision change',denied.outcome.error?.code==='forbidden'&&denied.before.revision===denied.after.revision,denied.outcome);
 const wrongScopeIdentity=await resolveIdentity(identityStore,{session_token:token,team_id:otherTeam.team_id},{clock});
 const wrongScope=await invoke('same user wrong selected team with no membership','teamId',{},wrongScopeIdentity);
 check('wrong team members denial has no receipt or revision change',wrongScope.outcome.error?.code==='forbidden'&&wrongScope.before.revision===wrongScope.after.revision,wrongScope.outcome);
 const spoof=await invoke('closed input cannot override actor/team/time/operation','actorId',{actor:{id:'forged'},team:{id:'forged'},now:'2030-01-01T00:00:00Z',operation:{id:'forged',source:'forged'}});
 check('forged ambient business fields refused before handler without receipt',spoof.outcome.error?.code==='validation'&&spoof.before.revision===spoof.after.revision,spoof.outcome);
 const firstFailure=observations.find(x=>x.name==='independent actorId read');
 const replay=await invoke('exact rejected actor read envelope replay','actorId',{},await resolveMember(),firstFailure.envelope.operation_id);
 check('rejected actor read replay reproduces error and complete selected snapshot',JSON.stringify(replay.outcome)===JSON.stringify(firstFailure.outcome)&&JSON.stringify(replay.before)===JSON.stringify(replay.after),replay.outcome);
 await identityStore.removeMembership(membership.membership_id);
 const revokedIdentity=await resolveMember();
 const revoked=await invoke('resolved current session after membership removal','teamId',{},revokedIdentity);
 check('current membership removal denies fresh context operation without receipt',revoked.outcome.error?.code==='forbidden'&&revoked.before.revision===revoked.after.revision,{resolved_membership:revokedIdentity.membership,outcome:revoked.outcome});
 assert.equal(await hash(source),producerPins.source[source].sha256,'source unchanged during run');
 assert.equal(await hash(`${out}/artifact.json`),sha(artifactRaw),'artifact unchanged during run');
 for(const path of existingFrozenPaths)assert.equal(await hash(path),manifest.selected_outputs_and_support[path],`frozen output after ${path}`);
 for(const [path,pin] of Object.entries(producerPins.frozen_supplemental))assert.equal(await hash(path),pin.sha256,`frozen supplemental after ${path}`);
 const assembled=await pinPaths(Object.values(asm.moduleUrls).map(fileURLToPath));
 await save('after-pins.json',{source_sha256:await hash(source),artifact_sha256:await hash(`${out}/artifact.json`),assembled,frozen_outputs_unchanged:true,frozen_supplemental_unchanged:true,commands_released:true});
 metadata.status=checks.every(x=>x.passed)?'verified_before_binding_failures_not_product_acceptance':'before_packet_assertion_failure';
 await saveObservations(metadata);
 await save('qualification-checks.json',{status:metadata.status,observations:observations.length,checks,product_acceptance:false,seq010_complete:false,commands_released:true,limitations:['Current frozen CLI and accepted pure relay run on frozen db57 context/invoker/State bodies; no current runtime refresh.','No handler patch, context shim, typed-clock coercion, split facade or compiler/package build.','No internal retry was forced and no typed context value was staged/serialized.','No full actor email mapping, null-team policy, trusted occurrence/hook/page/locale/default/installed identity/provider/owner-routing/authority qualification.']});
 console.log(json({status:metadata.status,observations:observations.length,checks:checks.length,failed:checks.filter(x=>!x.passed),packet:out}));
 if(checks.some(x=>!x.passed))process.exitCode=1;
} catch(error) {
 await save('fatal.json',{name:error.name,message:error.message,stack:error.stack,commands,observations,checks,commands_released:true});
 console.error(error);process.exitCode=1;
}
