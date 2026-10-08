//! Genuine emitted computed defaults through the canonical CF/State Memory
//! invocation and receipt consumer; no durability or wider CRUD claim.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn computed_enum_defaults_receipt_once_and_replay_under_existing_authority() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("resolved-default.can");
    std::fs::write(
        &input,
        r#"app ResolvedDefaults
Given
 Entry {state:enum(a,b)=a}
When
 scenario selected(seed:Entry.state,copied:Entry.state=seed,tail:Entry.state=copied) -> text by=members
  do
   require tail==b
   if copied==a
    return "A"
   else
    return "B"
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
const id='ResolvedDefaults.selected',descriptor=artifact.operations.find(operation=>operation.name===id);
assert.equal(descriptor.kind,'scenario');
assert.deepEqual(descriptor.inputs.fields.map(field=>[field.name,field.field,field.required]),[
 ['seed',{kind:'enum',values:['a','b']},true],['copied',{kind:'enum',values:['a','b']},false],
 ['tail',{kind:'enum',values:['a','b']},false],
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
export function hasRole(...args){const result=nativeHasRole(...args);globalThis.resolvedDefaultTrace.push(['admission',args[1],result]);return result;}
function check(...args){globalThis.resolvedDefaultTrace.push(['check',args[0]]);return nativeRequire(...args);}
export {check as require};
`);
const asm=await assembleModules({artifact,sourcePath:resolve(base,'resolved-default.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(shim).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
let sequence=0;
const envelope=inputs=>({operation:id,operation_id:uuidv7(FIXED_NOW,++sequence),inputs});
const receiptIdentity=request=>({app:'ResolvedDefaults',owner:identity.team.team_id,
 principal:identity.actor.user_id,operation:request.operation,operationId:request.operation_id});
const receipt=request=>store.readReceipt(receiptIdentity(request));
const trace=[];globalThis.resolvedDefaultTrace=trace;
async function invoke(request){trace.length=0;return invoker.invokeMutation(request,identity);}
function committed(outcome,status='committed'){
 assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,status);
 assert.equal(outcome.result.result,'B');return outcome.result;
}
function rejected(outcome,code){assert.ok('error' in outcome,JSON.stringify(outcome));assert.equal(outcome.error.code,code);}
const omitted=envelope({seed:'b'});
committed(await invoke(omitted));
assert.deepEqual(trace,[['admission','members',true],['check',true],['check',true]]);
const saved=await receipt(omitted);assert.ok(saved);
assert.deepEqual(saved.resolvedDefaults,{copied:'b',tail:'b'});
assert.deepEqual(Object.keys(saved.resolvedDefaults),['copied','tail'],'report defaults in declaration order');
assert.equal(saved.outcome.status,'committed');assert.equal(saved.outcome.result,'B');
const override=envelope({seed:'a',copied:'b',tail:'b'});
committed(await invoke(override));
assert.deepEqual(trace,[['admission','members',true],['check',true],['check',true]]);
const overrideReceipt=await receipt(override);assert.deepEqual(overrideReceipt.resolvedDefaults,{});
// An authored failure after resolution never publishes successful-path defaults.
const failure=envelope({seed:'a'});
rejected(await invoke(failure),'rule_failed');
assert.deepEqual(trace,[['admission','members',true],['check',true],['check',false]]);
const failedReceipt=await receipt(failure);assert.ok(failedReceipt);
assert.equal(failedReceipt.outcome.status,'rejected');assert.deepEqual(failedReceipt.resolvedDefaults,{});
await memberships.removeMembership(member.membership.membership_id);
// Existing policy is receipt-first: a matching raw-input hash replays its
// saved outcome before current membership admission, with no handler execution.
committed(await invoke(omitted),'replayed');assert.deepEqual(trace,[]);
assert.deepEqual(await receipt(omitted),saved);
committed(await invoke(override),'replayed');assert.deepEqual(trace,[]);
assert.deepEqual(await receipt(override),overrideReceipt);
rejected(await invoke(failure),'rule_failed');assert.deepEqual(trace,[]);
assert.deepEqual(await receipt(failure),failedReceipt);
// Reusing the identity with explicit inputs is a hash conflict, not a replay
// or an opportunity to resolve defaults again.
rejected(await invoke({...omitted,inputs:{seed:'b',copied:'b',tail:'b'}}),'conflict');
assert.deepEqual(trace,[]);assert.deepEqual(await receipt(omitted),saved);
const denied=envelope({seed:'b'});
rejected(await invoke(denied),'forbidden');assert.deepEqual(trace,[]);
assert.equal(await receipt(denied),null,'new denied admission must not create a receipt');
console.log('computed enum defaults: canonical Memory receipts, override, failure isolation and receipt-first replay passed');
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
