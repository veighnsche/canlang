//! Explicit owning enum input claims through canonical CF/State Memory
//! invocation and receipt consumer; no durability or wider CRUD claim.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn checked_enum_input_claims_reject_hostile_wires_before_authored_execution() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("enum-input-claims.can");
    std::fs::write(
        &input,
        r#"app EnumInputClaims
Given
 Entry {state:enum(a,b)=a}
When
 scenario selected(seed:Entry.state,copied:Entry.state=seed,maybe:Entry.state?,ordered:Entry.state[]) -> text by=members
  do
   require maybe==null or maybe==copied
   if ordered==[a,b]
    if copied==a
     return "AB:A"
    else
     return "AB:B"
   else
    require ordered==[b,a]
    if copied==a
     return "BA:A"
    else
     return "BA:B"
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
const id='EnumInputClaims.selected',descriptor=artifact.operations.find(operation=>operation.name===id);
assert.equal(descriptor.kind,'scenario');
assert.deepEqual(descriptor.inputs.fields.map(field=>[field.name,field.field,field.required,field.valueType]),[
 ['seed',{kind:'enum',values:['a','b']},true,'enum(a,b)'],
 ['copied',{kind:'enum',values:['a','b']},false,'enum(a,b)'],
 ['maybe',{kind:'enum',values:['a','b']},false,'enum(a,b)?'],
 ['ordered',{kind:'enum',values:['a','b']},false,'enum(a,b)[]'],
]);
const [seed,copied,maybe,ordered]=descriptor.inputs.fields;
assert.equal(copied.computedDefault,true);assert.equal(Object.hasOwn(copied,'default'),false);
assert.equal(maybe.nullable,true);assert.deepEqual(ordered.array,{required:false});
for(const field of [seed,maybe,ordered]){
 assert.equal(Object.hasOwn(field,'computedDefault'),false);assert.equal(Object.hasOwn(field,'default'),false);
}
assert.equal(artifact.callables.find(callable=>callable.id===id).inputStyle,'parameters');
// Only observe calls. Every helper delegates to its installed owner, and the
// maintained assembler routes the genuine modules to the canonical seam.
const seamUrl=pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
const shim=resolve(base,'observed-stdlib.mjs');
writeFileSync(shim,`
export * from ${JSON.stringify(seamUrl)};
import {require as nativeRequire,hasRole as nativeHasRole} from ${JSON.stringify(seamUrl)};
export function hasRole(...args){const result=nativeHasRole(...args);globalThis.enumInputTrace.push(['admission',args[1],result]);return result;}
function check(...args){globalThis.enumInputTrace.push(['check',args[0]]);return nativeRequire(...args);}
export {check as require};
`);
const asm=await assembleModules({artifact,sourcePath:resolve(base,'enum-input-claims.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(shim).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
let sequence=0;
const envelope=inputs=>({operation:id,operation_id:uuidv7(FIXED_NOW,++sequence),inputs});
const receiptIdentity=request=>({app:'EnumInputClaims',owner:identity.team.team_id,
 principal:identity.actor.user_id,operation:request.operation,operationId:request.operation_id});
const receipt=request=>store.readReceipt(receiptIdentity(request));
const trace=[];globalThis.enumInputTrace=trace;
async function invoke(request){trace.length=0;return invoker.invokeMutation(request,identity);}
function committed(outcome,want){
 assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'committed');
 assert.equal(outcome.result.result,want);
}
for(const [inputs,want,defaults,checks]of [
 [{seed:'a',maybe:null,ordered:['a','b']},'AB:A',{copied:'a'},2],
 [{seed:'b',maybe:'b',ordered:['b','a']},'BA:B',{copied:'b'},3],
 [{seed:'b',copied:'a',maybe:'a',ordered:['a','b']},'AB:A',{},2],
 [{seed:'a',copied:'b',maybe:null,ordered:['b','a']},'BA:B',{},3],
]){
 const request=envelope(inputs);committed(await invoke(request),want);
 assert.deepEqual(trace,[['admission','members',true],...Array.from({length:checks},()=>['check',true])]);
 const saved=await receipt(request);assert.equal(saved.outcome.status,'committed');
 assert.equal(saved.outcome.result,want);assert.deepEqual(saved.resolvedDefaults,defaults);
}
// Scalar/enum claims decode in the canonical execution seam and its validation
// failures are rejected receipts. Non-array carriers fail the earlier owning
// State array-shape admission and produce no receipt. Neither path executes
// authored guards/defaults or publishes successful defaults.
const valid={seed:'a',maybe:null,ordered:['a','b']};
for(const [name,changes,receipted]of [
 ['foreign seed',{seed:'foreign'},true],
 ['wrong singular carrier',{seed:{case:'a'}},true],
 ['nonnull singular null',{seed:null},true],
 ['foreign copied override',{copied:'foreign'},true],
 ['foreign nullable case',{maybe:'foreign'},true],
 ['wrong nullable carrier',{maybe:['a']},true],
 ['foreign array element',{ordered:['a','foreign']},true],
 ['nonnull array null',{ordered:null},true],
 ['wrong array carrier',{ordered:{0:'a',1:'b'}},false],
]){
 const request=envelope({...valid,...changes}),outcome=await invoke(request);
 assert.ok('error' in outcome,`${name}: ${JSON.stringify(outcome)}`);
 assert.equal(outcome.error.code,'validation',name);assert.deepEqual(trace,[],name);
 const saved=await receipt(request);
 if(receipted){
  assert.ok(saved,name);assert.equal(saved.outcome.status,'rejected',name);
  assert.equal(saved.outcome.code,'validation',name);assert.deepEqual(saved.resolvedDefaults,{},name);
 }else assert.equal(saved,null,name);
}
console.log('explicit enum claims: ordered metadata, native nullable/array paths and owning validation receipt policy passed');
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
