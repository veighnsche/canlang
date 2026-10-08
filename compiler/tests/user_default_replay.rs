//! Singular nonnullable user-copy defaults through canonical CF/State Memory
//! invocation and receipt consumer; no durability or wider CRUD claim.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn computed_user_copy_defaults_receipt_and_replay_under_existing_authority() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("user-default.can");
    std::fs::write(
        &input,
        r#"app UserDefaults
Given
 Entry {label:text}
When
 scenario selected(seed:user,copied:user=seed,tail:user=copied) -> user by=members
  do
   require copied==tail
   return tail
Then
"#,
    )
    .unwrap();
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
const {FIXED_NOW,createMemoryIdentityStore,seedMember,makeIdentity,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const id='UserDefaults.selected',descriptor=artifact.operations.find(operation=>operation.name===id);
assert.equal(descriptor.kind,'scenario');assert.deepEqual(descriptor.result,{type:'user'});
assert.deepEqual(descriptor.inputs.fields.map(field=>[field.name,field.field,field.required]),[
 ['seed',{kind:'user'},true],['copied',{kind:'user'},false],
 ['tail',{kind:'user'},false],
]);
for(const field of descriptor.inputs.fields.slice(1)){
 assert.equal(field.computedDefault,true);assert.equal(Object.hasOwn(field,'default'),false);
}
assert.equal(artifact.callables.find(callable=>callable.id===id).inputStyle,'parameters');
// Only observe calls. Every helper delegates to its installed owner, and the
// maintained assembler routes the genuine modules to the canonical seam.
const seamUrl=pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
const shim=resolve(base,'observed-stdlib.mjs');
writeFileSync(shim,`
export * from ${JSON.stringify(seamUrl)};
import {require as nativeRequire,hasRole as nativeHasRole} from ${JSON.stringify(seamUrl)};
export function hasRole(...args){const result=nativeHasRole(...args);globalThis.userDefaultTrace.push(['admission',args[1],result]);return result;}
function check(...args){globalThis.userDefaultTrace.push(['check',args[0]]);return nativeRequire(...args);}
export {check as require};
`);
const asm=await assembleModules({artifact,sourcePath:resolve(base,'user-default.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(shim).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const colleague=await seedMember(memberships,{isOwner:false,teamId:member.team.team_id});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
// These supplied users are active in the selected team; no directory claim.
const actor={id:member.user.user_id},peer={id:colleague.user.user_id};
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
let sequence=0;
const envelope=inputs=>({operation:id,operation_id:uuidv7(FIXED_NOW,++sequence),inputs});
const receiptIdentity=request=>({app:'UserDefaults',owner:identity.team.team_id,
 principal:identity.actor.user_id,operation:request.operation,operationId:request.operation_id});
const receipt=request=>store.readReceipt(receiptIdentity(request));
const trace=[];globalThis.userDefaultTrace=trace;
async function invoke(request){trace.length=0;return invoker.invokeMutation(request,identity);}
function committed(outcome,want,status='committed'){
 assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,status);
 assert.deepEqual(outcome.result.result,want);assert.deepEqual(Object.keys(outcome.result.result),['id']);return outcome.result;
}
function rejected(outcome,code){assert.ok('error' in outcome,JSON.stringify(outcome));assert.equal(outcome.error.code,code);}
const omitted=envelope({seed:actor});
committed(await invoke(omitted),actor);
assert.deepEqual(trace,[['admission','members',true],['check',true],['check',true]]);
const saved=await receipt(omitted);assert.ok(saved);
assert.deepEqual(saved.resolvedDefaults,{copied:actor,tail:actor});
for(const value of Object.values(saved.resolvedDefaults))assert.deepEqual(Object.keys(value),['id'],'closed user wire without native kind');
assert.deepEqual(Object.keys(saved.resolvedDefaults),['copied','tail'],'report defaults in declaration order');
assert.equal(saved.outcome.status,'committed');assert.deepEqual(saved.outcome.result,actor);
const override=envelope({seed:actor,copied:peer,tail:peer});
committed(await invoke(override),peer);
assert.deepEqual(trace,[['admission','members',true],['check',true],['check',true]]);
const overrideReceipt=await receipt(override);assert.deepEqual(overrideReceipt.resolvedDefaults,{});
// An authored failure after resolution never publishes successful-path defaults.
const failure=envelope({seed:actor,tail:peer});
rejected(await invoke(failure),'rule_failed');
assert.deepEqual(trace,[['admission','members',true],['check',true],['check',false]]);
const failedReceipt=await receipt(failure);assert.ok(failedReceipt);
assert.equal(failedReceipt.outcome.status,'rejected');assert.deepEqual(failedReceipt.resolvedDefaults,{});
await memberships.removeMembership(member.membership.membership_id);
// Existing policy is receipt-first: a matching raw-input hash replays its
// saved outcome before current membership admission, with no handler execution.
committed(await invoke(omitted),actor,'replayed');assert.deepEqual(trace,[]);
assert.deepEqual(await receipt(omitted),saved);
committed(await invoke(override),peer,'replayed');assert.deepEqual(trace,[]);
assert.deepEqual(await receipt(override),overrideReceipt);
rejected(await invoke(failure),'rule_failed');assert.deepEqual(trace,[]);
assert.deepEqual(await receipt(failure),failedReceipt);
// Reusing the identity with explicit inputs is a hash conflict, not a replay
// or an opportunity to resolve defaults again.
rejected(await invoke({...omitted,inputs:{seed:actor,copied:actor,tail:actor}}),'conflict');
assert.deepEqual(trace,[]);assert.deepEqual(await receipt(omitted),saved);
const denied=envelope({seed:actor});
rejected(await invoke(denied),'forbidden');assert.deepEqual(trace,[]);
assert.equal(await receipt(denied),null,'new denied admission must not create a receipt');
console.log('computed user-copy defaults: canonical Memory receipts, override, failure isolation and receipt-first replay passed');
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
