//! Contextual actor default through canonical CF/State Memory receipts;
//! authority comes only from the installed member frame.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn computed_actor_default_uses_member_frame_and_receipt_first_replay() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("actor-default.can");
    std::fs::write(
        &input,
        r#"app ActorDefaults
Given
 Entry {label:text}
When
 scenario selected(who:user?=actor) -> user? by=members
  do
   require true
   return who
Then
"#,
    )
    .unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
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
const capture=artifact.operations.find(operation=>operation.name.endsWith('.selected'))?.result?.disclosure;
assert.equal(capture?.version,1,'actual native host requires a complete emitted scenario disclosure plan');
assert.ok(capture.returns.length>0);
const id='ActorDefaults.selected',descriptor=artifact.operations.find(operation=>operation.name===id);
assert.equal(descriptor.kind,'scenario');assert.equal(descriptor.inputs.fields.length,1);
const who=descriptor.inputs.fields[0];
assert.equal(who.name,'who');assert.equal(who.field.kind,'user');assert.equal(who.nullable,true);
assert.equal(who.computedDefault,true);assert.equal(Object.hasOwn(who,'default'),false);
assert.equal(artifact.callables.find(callable=>callable.id===id).inputStyle,'parameters');
// The observer only records calls and delegates both operations to their
// installed implementations; authority and user encoding remain native.
const seamUrl=pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
const shim=resolve(base,'observed-stdlib.mjs');
writeFileSync(shim,`
export * from ${JSON.stringify(seamUrl)};
import {require as nativeRequire,hasRole as nativeHasRole} from ${JSON.stringify(seamUrl)};
export function hasRole(...args){const result=nativeHasRole(...args);globalThis.actorDefaultTrace.push(['admission',args[1],result]);return result;}
function check(...args){globalThis.actorDefaultTrace.push(['check',args[0]]);return nativeRequire(...args);}
export {check as require};
`);
const asm=await assembleModules({artifact,sourcePath:resolve(base,'actor-default.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(shim).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const colleague=await seedMember(memberships,{isOwner:false,teamId:member.team.team_id});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const actor={id:member.user.user_id},peer={id:colleague.user.user_id};
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
let sequence=0;
const envelope=inputs=>({operation:id,operation_id:uuidv7(FIXED_NOW,++sequence),inputs});
const receiptIdentity=request=>({app:'ActorDefaults',owner:identity.team.team_id,
 principal:identity.actor.user_id,operation:request.operation,operationId:request.operation_id});
const receipt=request=>store.readReceipt(receiptIdentity(request));
const trace=[];globalThis.actorDefaultTrace=trace;
async function invoke(request){trace.length=0;return invoker.invokeMutation(request,identity);}
function checkUser(value){
 if(value!==null)assert.deepEqual(Object.keys(value),['id'],'closed user wire');
}
async function committed(request,want,status='committed'){
 const outcome=await invoke(request);
 assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,status);
 assert.deepEqual(outcome.result.result,want);checkUser(outcome.result.result);
 return outcome.result;
}
function rejected(outcome,code){assert.ok('error' in outcome,JSON.stringify(outcome));assert.equal(outcome.error.code,code);}
const omitted=envelope({});
await committed(omitted,actor);
assert.deepEqual(trace,[['admission','members',true],['check',true],['check',true]]);
const saved=await receipt(omitted);assert.ok(saved);
assert.deepEqual(saved.resolvedDefaults,{who:actor});assert.deepEqual(Object.keys(saved.resolvedDefaults),['who']);
checkUser(saved.resolvedDefaults.who);assert.deepEqual(saved.outcome.result,actor);
const explicitNull=envelope({who:null});
await committed(explicitNull,null);
assert.deepEqual(trace,[['admission','members',true],['check',true],['check',true]]);
const nullReceipt=await receipt(explicitNull);assert.ok(nullReceipt);assert.deepEqual(nullReceipt.resolvedDefaults,{});
const explicitPeer=envelope({who:peer});
await committed(explicitPeer,peer);
assert.deepEqual(trace,[['admission','members',true],['check',true],['check',true]]);
const peerReceipt=await receipt(explicitPeer);assert.ok(peerReceipt);assert.deepEqual(peerReceipt.resolvedDefaults,{});
await memberships.removeMembership(member.membership.membership_id);
// Matching receipts retain their original values; current projection withholds
// the public result after revocation without default or handler execution.
await committed(omitted,null,'replayed');assert.deepEqual(trace,[]);assert.deepEqual(await receipt(omitted),saved);
await committed(explicitNull,null,'replayed');assert.deepEqual(trace,[]);assert.deepEqual(await receipt(explicitNull),nullReceipt);
await committed(explicitPeer,null,'replayed');assert.deepEqual(trace,[]);assert.deepEqual(await receipt(explicitPeer),peerReceipt);
// Same identity with changed supplied input conflicts; a fresh request is
// denied against current membership and creates no receipt.
rejected(await invoke({...omitted,inputs:{who:actor}}),'conflict');assert.deepEqual(trace,[]);
assert.deepEqual(await receipt(omitted),saved);
const denied=envelope({});rejected(await invoke(denied),'forbidden');
assert.deepEqual(trace,[]);assert.equal(await receipt(denied),null);
console.log('computed actor default: member-frame value, explicit overrides and receipt-first Memory replay passed');
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
