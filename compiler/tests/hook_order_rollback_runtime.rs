//! Canonical CRUD refuses authored hooks while native execution is unavailable.
//! The only observer delegates guards to the installed native owner.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn authored_hook_crud_refuses_before_unavailable_native_execution() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("hook-order-rollback.can");
    std::fs::write(&input, include_str!("fixtures/hook_order_rollback.can")).unwrap();
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
const {FIXED_NOW,asId,asModel,createMemoryIdentityStore,seedMember,makeIdentity,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const model='HookOrder.Entry',auditModel='HookOrder.Audit',operation=`${model}.update`;
assert.equal(artifact.operations.find(entry=>entry.name===operation).kind,'update');
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
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
const checks=[];globalThis.hookOrderChecks=checks;let sequence=0,lastRequest;
async function invoke(name,inputs){
 checks.length=0;
 lastRequest={operation:name,operation_id:uuidv7(FIXED_NOW,++sequence),inputs};
 return invoker.invokeMutation(lastRequest,identity);
}
function committed(outcome){
 assert.ok('result' in outcome,JSON.stringify(outcome));
 assert.equal(outcome.result.status,'committed');return outcome.result.result;
}
async function receipt(){
 const saved=await store.readReceipt({app:'HookOrder',owner:identity.team.team_id,
  principal:identity.actor.user_id,operation:lastRequest.operation,operationId:lastRequest.operation_id});
 assert.ok(saved,'canonical invocation persists its native receipt');
 assert.deepEqual(saved.resolvedDefaults,{});return saved;
}
const initial=committed(await invoke(`${model}.create`,{state:'initial',accept:true}));
assert.equal(initial.version,1);assert.deepEqual(initial.data,{state:'initial',accept:true});
const id=initial.id,stagedId=`${id}/staged/0`;
async function snapshot(){
 return {revision:await store.readRevision(),entry:await store.load(asModel(model),asId(id)),
  entryHistory:await store.historyFor(asModel(model),asId(id)),
  audit:await store.load(asModel(auditModel),asId(stagedId)),
  auditHistory:await store.historyFor(asModel(auditModel),asId(stagedId))};
}
const before=await snapshot();assert.equal(before.audit,null);assert.deepEqual(before.auditHistory,[]);
// The canonical owner refuses this operation before the CRUD executor can
// silently skip its authored hook. This is a refusal proof, not execution
// evidence for candidate adjustments, staged writes or late-guard rollback.
const failed=await invoke(operation,{record:{id,version:'1'},state:'proposed',accept:false});
const message=`Operation ${JSON.stringify(operation)} requires unsupported canonical hooks.`;
assert.ok('error' in failed,JSON.stringify(failed));
assert.equal(failed.error.code,'validation');assert.equal(failed.error.message,message);
assert.deepEqual(checks,[],'refusal precedes authored hook and emitted helper execution');
const after=await snapshot();
assert.deepEqual(after.entry,before.entry,'refusal preserves Entry data and version');
assert.deepEqual(after.entryHistory,before.entryHistory,'refusal preserves Entry history');
assert.equal(after.audit,null);assert.deepEqual(after.auditHistory,[]);
assert.equal(after.revision,before.revision+1,'native rejected receipt advances the global fence once');
const rejectedReceipt=await receipt();
assert.deepEqual(rejectedReceipt.outcome,{status:'rejected',code:'validation',message});
assert.equal(rejectedReceipt.committedRevision,after.revision);
console.log('authored hook CRUD: explicit unsupported refusal, no domain writes or hook execution, native rejected receipt passed');
"#,
    )
    .unwrap();
    let executed = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
