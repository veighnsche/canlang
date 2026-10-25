//! Canonical CRUD executes checked hooks in order with atomic rollback and replay.
//! The only observer delegates guards to the installed native owner.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn authored_hook_crud_orders_adjustments_and_replays_success() {
    run_native_hook_case("positive");
}

#[test]
fn authored_hook_crud_rolls_back_late_guard_and_replays_rejection() {
    run_native_hook_case("rollback");
}

#[test]
fn authored_hook_crud_preserves_typed_invocation_context_and_defaults() {
    run_native_hook_case("contextual");
}

#[test]
fn authored_hook_crud_preserves_core_typed_context_and_defaults() {
    run_native_hook_case("contextual_core");
}

#[test]
fn authored_update_hook_keeps_native_before_stable_through_adjustments_and_replay() {
    run_native_hook_case("before_positive");
}

#[test]
fn authored_update_hook_before_capture_rolls_back_late_rejection_and_replays() {
    run_native_hook_case("before_rollback");
}

fn run_native_hook_case(case: &str) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("hook-order-rollback.can");
    // Exercise native readonly metadata and omitted server initializers without
    // changing the original authored behavior fixture.
    let source = include_str!("fixtures/hook_order_rollback.can")
        .replace("Audit {note:text}", "Audit {note:text,author:user server=actor,at:datetime server=now}")
        .replace(
            "require event.after.state==\"proposed\"",
            "require event.after.state==\"proposed\"\n   require event.after.id!=\"\"\n   require event.after.version==2",
        );
    let source = if matches!(case, "contextual" | "contextual_core") {
        // One owning authored source is shared with the portable native host.
        // Its bytes are identical to the original full contextual case.
        include_str!("fixtures/hook_order_contextual.can").to_string()
    } else {
        source
    };
    let source = if case == "contextual_core" {
        source
            .replace(",team_timezone:timezone", "")
            .replace(",actor_email:email", "")
            .replace(",team_timezone=team.timezone", "")
            .replace(",actor_email=actor.email", "")
    } else {
        source
    };
    let source = if matches!(case, "before_positive" | "before_rollback") {
        // The original ordered candidate/staging workflow remains intact; its
        // update-only snapshot reads use the real native before projection.
        source
            .replace("Audit {note:text,", "Audit {note:text,before_state:text,before_id:text,before_version:int,")
            .replace("require event.after.version==2", "require event.after.version==2\n   require event.before.state==\"initial\"\n   require event.before.id==event.after.id\n   require event.before.version==1\n   require event.before.accept")
            .replace("create Audit {note=event.after.state}", "create Audit {note=event.after.state,before_state=event.before.state,before_id=event.before.id,before_version=event.before.version}")
            .replace("require event.after.state==\"first\"", "require event.after.state==\"first\"\n   require event.before.state==\"initial\"")
            .replace("require event.after.state==\"second\"", "require event.after.state==\"second\"\n   require event.before.state==\"initial\"\n   require event.before.version==1")
    } else {
        source
    };
    std::fs::write(&input, source).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&input)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    std::fs::write(scratch.path().join("artifact.json"), compiled.stdout).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(
        &runner,
        r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const base=dirname(fileURLToPath(import.meta.url)),root=process.argv[2];
const require=createRequire(resolve(root,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules}=await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker}=await load('@canlang/cloudflare/worker/assembly');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const {hashInputs}=await load('@canlang/state/invocation/replay');
const {FIXED_NOW,asId,asModel,createMemoryIdentityStore,seedMember,makeIdentity,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const model='HookOrder.Entry',auditModel='HookOrder.Audit',operation=`${model}.update`;
assert.equal(artifact.operations.find(entry=>entry.name===operation).kind,'update');
const hookId='HookOrder.adjustEntry';
const policy=artifact.modelPolicies.find(entry=>entry.model===model);
assert.equal(policy.abi,'state.owner-model-policies@1');
assert.equal(policy.ownerPackage,'HookOrder');
assert.equal(policy.module,artifact.modules[0].path);
assert.deepEqual(policy.hooks,[{id:hookId,op:'update',operation}]);
const callable=artifact.callables.filter(entry=>entry.id===hookId);
assert.equal(callable.length,1);
assert.equal(callable[0].kind,'handler');assert.equal(callable[0].module,policy.module);
assert.deepEqual(callable[0].member,['hooks',operation,'run']);
// Observe only native guard calls. Invocation contexts, models, admission
// and persistence remain production-owned; the shim delegates unchanged.
const seamUrl=pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
const shim=resolve(base,'observed-stdlib.mjs');
writeFileSync(shim,`
export * from ${JSON.stringify(seamUrl)};
import {require as nativeRequire} from ${JSON.stringify(seamUrl)};
function check(...args){
 globalThis.hookOrderChecks.push({condition:args[0],code:args[1]});
 return nativeRequire(...args);
}
export {check as require};
`);
const asm=await assembleModules({artifact,sourcePath:resolve(base,'hook-order-rollback.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(shim).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {store:backing}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const batches=[];
const store={...backing,commit:async batch=>{batches.push(batch);return backing.commit(batch);}};
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
const checks=[];globalThis.hookOrderChecks=checks;let sequence=0,lastRequest;
async function invoke(name,inputs){
 checks.length=0;
 lastRequest={operation:name,operation_id:uuidv7(FIXED_NOW,++sequence),inputs};
 return invoker.invokeMutation(lastRequest,identity);
}
function committed(outcome,expectedRecords=1){
 assert.ok('result' in outcome,JSON.stringify(outcome));
 assert.equal(outcome.result.status,'committed');
 assert.equal(outcome.result.result,null,'generated CRUD has no declared business result');
 assert.equal(outcome.result.records.length,expectedRecords,'exact disclosed changed records');
 if(expectedRecords===0)return null;
 const row=outcome.result.records[0];
 assert.deepEqual(Object.keys(row).sort(),['archivedAt','created','createdBy','data','id','parent','updated','updatedBy','version']);
 assert.equal(typeof row.id,'string');assert.ok(row.id.length>0);
 assert.ok(Number.isSafeInteger(row.version)&&row.version>0);
 return row;
}
async function receipt(){
 const saved=await store.readReceipt({app:'HookOrder',owner:identity.team.team_id,
  principal:identity.actor.user_id,operation:lastRequest.operation,operationId:lastRequest.operation_id});
 assert.ok(saved,'canonical invocation persists its native receipt');
 assert.equal(saved.identity.operation,lastRequest.operation);
 assert.equal(saved.identity.operationId,lastRequest.operation_id);
 assert.equal(saved.inputHash,await hashInputs(lastRequest.inputs));
 assert.equal(saved.createdAt,FIXED_NOW);
 return saved;
}
const initial=committed(await invoke(`${model}.create`,{state:'initial',accept:true}));
assert.equal(initial.version,1);assert.deepEqual(initial.data,{state:'initial',accept:true});
const id=initial.id;
async function snapshot(){
 const audits=await store.query({model:asModel(auditModel),authority:'owner'});
 assert.ok(audits.length<=1,'one original staged Audit');
 const audit=audits[0]??null;
 return {revision:await store.readRevision(),entry:await store.load(asModel(model),asId(id)),
  entryHistory:await store.historyFor(asModel(model),asId(id)),
  audit,
  auditHistory:audit===null?[]:await store.historyFor(asModel(auditModel),asId(audit.id))};
}
const before=await snapshot();assert.equal(before.audit,null);assert.deepEqual(before.auditHistory,[]);
const beforeCase=['before_positive','before_rollback'].includes(process.argv[3]);
if(['rollback','before_rollback'].includes(process.argv[3])){
const failed=await invoke(operation,{record:{id,version:'1'},state:'proposed',accept:false});
const failedRequest=lastRequest;
assert.ok('error' in failed,JSON.stringify(failed));
assert.equal(failed.error.code,'rule_failed');
assert.deepEqual(checks.map(check=>check.condition),[...Array(beforeCase?12:5).fill(true),false],
 'native guards see readonly identity/version and both ordered adjustments before the late refusal');
const after=await snapshot();
assert.deepEqual(after.entry,before.entry,'late refusal preserves Entry data and version');
assert.deepEqual(after.entryHistory,before.entryHistory,'late refusal preserves Entry history');
assert.equal(after.audit,null);assert.deepEqual(after.auditHistory,[]);
assert.equal(after.revision,before.revision+1,'native rejected receipt advances the global fence once');
const rejectedReceipt=await receipt();
assert.deepEqual(rejectedReceipt.outcome,{status:'rejected',code:'rule_failed',message:failed.error.message});
assert.deepEqual(rejectedReceipt.resolvedDefaults,{});
assert.equal(rejectedReceipt.committedRevision,after.revision);
const rejectedBatch=batches.at(-1);
assert.equal(rejectedBatch.expectedRevision,before.revision);
assert.deepEqual(rejectedBatch.receipt,rejectedReceipt);
for(const field of ['writes','history','outbox','schedules','uniqueClaims','uniqueReleases','outboxAck'])
 assert.deepEqual(rejectedBatch[field]??[],[],`late refusal stages no ${field}`);
const rejectedBatchCount=batches.length;
checks.length=0;
assert.deepEqual(await invoker.invokeMutation(failedRequest,identity),failed,'same-envelope failed replay');
assert.deepEqual(checks,[],'failed replay never runs hooks');
assert.deepEqual(await snapshot(),after);assert.equal(batches.length,rejectedBatchCount);
console.log('native hook late rollback, rejected receipt and failed replay passed');
}else{
const positiveBatchCount=batches.length;
const succeeded=await invoke(operation,{record:{id,version:'1'},state:'proposed',accept:true});
const successRequest=lastRequest;
committed(succeeded);
assert.deepEqual(checks.map(check=>check.condition),Array(beforeCase?13:6).fill(true));
const final=await snapshot();
assert.equal(final.revision,before.revision+1,'one fenced positive commit');
assert.equal(batches.length,positiveBatchCount+1);
assert.equal(final.entry.id,id);assert.equal(final.entry.version,2);
assert.deepEqual(final.entry.data,{state:'second',accept:true});
const auditWrites=batches.at(-1).writes.filter(write=>write.model===auditModel);
assert.equal(auditWrites.length,1,'one actual staged Audit write');
const stagedId=auditWrites[0].row.id;
assert.ok(stagedId.includes(successRequest.operation_id),'staged identity belongs to the live invocation');
assert.ok(stagedId.includes(hookId),'staged identity belongs to the original hook');
assert.equal(final.audit.id,stagedId);assert.equal(final.audit.version,1);assert.equal(final.audit.parent,null);
if(['contextual','contextual_core'].includes(process.argv[3])){
 assert.deepEqual(final.audit.data,{
  note:'first',author:{id:identity.actor.user_id},at:new Date(FIXED_NOW).toISOString(),
  explicit_author:{id:identity.actor.user_id},explicit_at:new Date(FIXED_NOW).toISOString(),
  team_id:identity.team.team_id,
  operation_id:successRequest.operation_id,operation_source:'worker',
  actor_verified:identity.actor.email_verified,
  ...(process.argv[3]==='contextual'?{team_timezone:identity.team.timezone,actor_email:identity.actor.email}:{}),
 });
 assert.deepEqual(final.audit.data.explicit_author,final.audit.data.author,
  'typed actor and omitted State server=actor agree within the same live invocation');
 assert.equal(final.audit.data.explicit_at,final.audit.data.at,
  'typed Datetime now and omitted State server=now agree within the same live invocation');
}else{
assert.deepEqual(final.audit.data,{note:'first',author:{id:identity.actor.user_id},at:new Date(FIXED_NOW).toISOString(),
 ...(beforeCase?{before_state:'initial',before_id:id,before_version:'1'}:{})});
if(beforeCase){
 assert.equal(final.audit.data.before_state,before.entry.data.state,'staged values retain immutable old state after candidate adjustment');
 assert.equal(final.audit.data.before_id,before.entry.id);
 assert.equal(BigInt(final.audit.data.before_version),BigInt(before.entry.version));
 assert.equal(final.entry.data.state,'second');assert.equal(final.entry.version,2);
}
}
for(const row of [final.entry,final.audit]){
 assert.equal(row.created,FIXED_NOW);assert.equal(row.updated,FIXED_NOW);
 assert.equal(row.createdBy,identity.actor.user_id);assert.equal(row.updatedBy,identity.actor.user_id);
 assert.equal(row.archivedAt,null);
}
assert.deepEqual(succeeded.result.records[0].data,{state:'second',accept:true});
assert.equal(succeeded.result.records[0].id,id);assert.equal(succeeded.result.records[0].version,2);
assert.equal(final.entryHistory.length,before.entryHistory.length+1);
assert.equal(final.auditHistory.length,1);
for(const entry of [final.entryHistory.at(-1),final.auditHistory[0]]){
 assert.equal(entry.operation,operation);assert.equal(entry.operationId,successRequest.operation_id);
}
assert.deepEqual(final.entryHistory.at(-1).before,before.entry.data);
assert.deepEqual(final.entryHistory.at(-1).after,final.entry.data);
assert.deepEqual(final.auditHistory[0].after,final.audit.data);
const committedReceipt=await receipt();
assert.equal(committedReceipt.outcome.status,'committed');
assert.deepEqual(committedReceipt.outcome.result,final.entry,'saved CRUD business result is the original target row');
assert.deepEqual([...committedReceipt.outcome.recordVersions].sort((a,b)=>a.model.localeCompare(b.model)),[
 {model:auditModel,id:stagedId,version:1},{model,id,version:2}]);
assert.deepEqual(committedReceipt.resolvedDefaults,{
 '1:HookOrder.Audit.author':{id:identity.actor.user_id},
 '1:HookOrder.Audit.at':new Date(FIXED_NOW).toISOString(),
});
assert.equal(committedReceipt.committedRevision,final.revision);
const positiveBatch=batches.at(-1);
assert.equal(positiveBatch.expectedRevision,before.revision);
assert.equal(positiveBatch.writes.length,2);assert.equal(positiveBatch.history.length,2);
for(const field of ['outbox','schedules','uniqueClaims','uniqueReleases','outboxAck'])
 assert.deepEqual(positiveBatch[field]??[],[],`positive hook commit has no ${field}`);
assert.deepEqual(positiveBatch.receipt,committedReceipt);
checks.length=0;
const replay=await invoker.invokeMutation(successRequest,identity);
assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');
assert.deepEqual(replay.result.records,succeeded.result.records);
assert.equal(replay.result.result,null);
assert.deepEqual(checks,[],'successful replay never runs hooks or resolves server initializers');
assert.deepEqual(await snapshot(),final);assert.equal(batches.length,positiveBatchCount+1);
assert.deepEqual(await receipt(),committedReceipt);
console.log('native hooks: ordered adjustments, readonly metadata, server omissions, committed receipt and success replay passed');
}
"#,
    )
    .unwrap();
    let executed = Command::new("node")
        .arg(runner)
        .arg(root)
        .arg(case)
        .output()
        .unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
