//! Null actor defaults and receipt replay through canonical public Memory
//! invocation; membership-only sibling remains denied.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn public_nullable_actor_default_preserves_null_and_receipt_first_replay() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("anonymous-actor-default.can");
    std::fs::write(
        &input,
        r#"app AnonymousActorDefaults
Given
 Entry {label:text}
When
 scenario selected(who:user?=actor) -> user? by=public
  do
   require true
   return who
 scenario memberOnly() by=members
  do
   require true
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
const id='AnonymousActorDefaults.selected',memberOnly='AnonymousActorDefaults.memberOnly';
const descriptor=artifact.operations.find(operation=>operation.name===id);
assert.equal(descriptor.kind,'scenario');assert.equal(descriptor.inputs.fields.length,1);
const who=descriptor.inputs.fields[0];
assert.equal(who.name,'who');assert.equal(who.field.kind,'user');assert.equal(who.nullable,true);
assert.equal(who.computedDefault,true);assert.equal(Object.hasOwn(who,'default'),false);
// The observer records calls while delegating to the installed stdlib.
const seamUrl=pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
const shim=resolve(base,'observed-stdlib.mjs');
writeFileSync(shim,`
export * from ${JSON.stringify(seamUrl)};
import {require as nativeRequire,hasRole as nativeHasRole} from ${JSON.stringify(seamUrl)};
export function hasRole(...args){const result=nativeHasRole(...args);globalThis.anonymousActorTrace.push(['admission',args[1],result]);return result;}
function check(...args){globalThis.anonymousActorTrace.push(['check',args[0]]);return nativeRequire(...args);}
export {check as require};
`);
const asm=await assembleModules({artifact,sourcePath:resolve(base,'anonymous-actor-default.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(shim).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const publicIdentity=makeIdentity({actor:null,team:null,membership:null});
const scopedAnonymous=makeIdentity({actor:null,teamId:member.team.team_id,membership:null});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
let sequence=0;
const envelope=(operation,inputs)=>({operation,operation_id:uuidv7(FIXED_NOW,++sequence),inputs});
const receiptIdentity=(request,identity)=>({app:'AnonymousActorDefaults',
 owner:identity.team?.team_id??'app',principal:identity.actor?.user_id??'public',
 operation:request.operation,operationId:request.operation_id});
const receipt=(request,identity)=>store.readReceipt(receiptIdentity(request,identity));
const trace=[];globalThis.anonymousActorTrace=trace;
const freshTrace=[['admission','public',true],['check',true],['check',true]];
async function invoke(request,identity=publicIdentity){trace.length=0;return invoker.invokeMutation(request,identity);}
function userWire(value){if(value!==null)assert.deepEqual(Object.keys(value),['id'],'closed user wire');}
async function committed(request,want,status='committed'){
 const outcome=await invoke(request);
 assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,status);
 assert.deepEqual(outcome.result.result,want);userWire(outcome.result.result);
 return outcome.result;
}
function rejected(outcome,code){assert.ok('error' in outcome,JSON.stringify(outcome));assert.equal(outcome.error.code,code);}
const omitted=envelope(id,{});
await committed(omitted,null);
assert.deepEqual(trace,freshTrace);
const omittedReceipt=await receipt(omitted,publicIdentity);assert.ok(omittedReceipt);
assert.deepEqual(omittedReceipt.resolvedDefaults,{who:null});assert.deepEqual(Object.keys(omittedReceipt.resolvedDefaults),['who']);
assert.equal(omittedReceipt.outcome.result,null);
const explicitNull=envelope(id,{who:null});
await committed(explicitNull,null);assert.deepEqual(trace,freshTrace);
const nullReceipt=await receipt(explicitNull,publicIdentity);assert.ok(nullReceipt);assert.deepEqual(nullReceipt.resolvedDefaults,{});
const supplied={id:'user-explicit'};
const explicitUser=envelope(id,{who:supplied});
await committed(explicitUser,supplied);assert.deepEqual(trace,freshTrace);
const userReceipt=await receipt(explicitUser,publicIdentity);assert.ok(userReceipt);assert.deepEqual(userReceipt.resolvedDefaults,{});
// Original raw inputs replay their saved outcomes without admission or body
// execution, even when the defaulted actor was null.
await committed(omitted,null,'replayed');assert.deepEqual(trace,[]);assert.deepEqual(await receipt(omitted,publicIdentity),omittedReceipt);
await committed(explicitNull,null,'replayed');assert.deepEqual(trace,[]);assert.deepEqual(await receipt(explicitNull,publicIdentity),nullReceipt);
await committed(explicitUser,supplied,'replayed');assert.deepEqual(trace,[]);assert.deepEqual(await receipt(explicitUser,publicIdentity),userReceipt);
rejected(await invoke({...omitted,inputs:{who:null}}),'conflict');assert.deepEqual(trace,[]);
assert.deepEqual(await receipt(omitted,publicIdentity),omittedReceipt);
// Public source does not broaden the authored members-only sibling.
const denied=envelope(memberOnly,{});
rejected(await invoke(denied,scopedAnonymous),'forbidden');
assert.equal(await receipt(denied,scopedAnonymous),null);
console.log('nullable actor default: null receipt, explicit UserRef overrides and public receipt-first replay passed');
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
