//! Genuine enum result metadata and canonical Memory invocation.
//! This consumer requires the defining State enum-result intake contract.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn owned_enum_results_preserve_cases_wrappers_and_canonical_admission() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("enum-result.can");
    std::fs::write(
        &input,
        r#"app EnumResults
Given
 Entry {state:enum(a,b)=a}
When
 scenario singular(value:Entry.state) -> Entry.state by=members
  do
   require true
   return value
 scenario nullable(value:Entry.state?) -> Entry.state? by=members
  do
   require true
   return value
 scenario array(value:Entry.state[]) -> Entry.state[] by=members
  do
   require true
   return value
 scenario nullableArray(value:Entry.state[]?) -> Entry.state[]? by=members
  do
   require true
   return value
 scenario readSingular(value:Entry.state) -> Entry.state read=true by=members
  do
   require true
   return value
 scenario readNullable(value:Entry.state?) -> Entry.state? read=true by=members
  do
   require true
   return value
 scenario readArray(value:Entry.state[]) -> Entry.state[] read=true by=members
  do
   require true
   return value
 scenario readNullableArray(value:Entry.state[]?) -> Entry.state[]? read=true by=members
  do
   require true
   return value
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
const {FIXED_NOW,asId,asModel,createMemoryIdentityStore,seedMember,makeIdentity,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const profiles=[
 ['singular','readSingular','enum(a,b)',['a','b']],
 ['nullable','readNullable','enum(a,b)?',[null,'b']],
 ['array','readArray','enum(a,b)[]',[[],['b','a','b']]],
 ['nullableArray','readNullableArray','enum(a,b)[]?',[null,[],['b','a']]],
];
for(const [mutation,read,type] of profiles){
 for(const name of [mutation,read]){
  const id=`EnumResults.${name}`,descriptor=artifact.operations.find(operation=>operation.name===id);
  assert.ok(descriptor,id);assert.equal(descriptor.kind,name===read?'read':'scenario');
  assert.deepEqual(descriptor.result,{type});
  assert.equal(descriptor.inputs.fields[0].valueType,type);
  assert.deepEqual(descriptor.inputs.fields[0].field,{kind:'enum',values:['a','b']});
  assert.equal(artifact.callables.find(callable=>callable.id===id).inputStyle,'parameters');
 }
}
// These wrappers observe execution only; the installed native owners decide
// admission and authored require behavior. No enum-result adapter is installed.
const seamUrl=pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
const shim=resolve(base,'observed-stdlib.mjs');
writeFileSync(shim,`
export * from ${JSON.stringify(seamUrl)};
import {require as nativeRequire,hasRole as nativeHasRole} from ${JSON.stringify(seamUrl)};
export function hasRole(...args){const result=nativeHasRole(...args);globalThis.enumResultTrace.push(['admission',args[1],result]);return result;}
function check(...args){globalThis.enumResultTrace.push(['check',args[0]]);return nativeRequire(...args);}
export {check as require};
`);
const asm=await assembleModules({artifact,sourcePath:resolve(base,'enum-result.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(shim).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const reference=artifact.callables.find(callable=>callable.id==='EnumResults.singular');
const entry=await import(asm.moduleUrls[reference.module]);
assert.deepEqual(entry.canApp().operations,artifact.operations);
for(const [mutation,read] of profiles){
 for(const name of [mutation,read]){
  const result=entry.appDefinition.operations[`EnumResults.${name}`].result;
  assert.equal(result.type,'enum');assert.deepEqual(result.cases,['a','b']);
  assert.equal(result.array===true,name.endsWith('Array')||name==='array'||name==='readArray');
  assert.equal(result.nullable===true,name.toLowerCase().includes('nullable'));
 }
}
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const outsider=makeIdentity({userId:'nonmember',team:member.team,membership:null});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
const trace=[];globalThis.enumResultTrace=trace;let sequence=0;
const model=asModel('EnumResults.Entry'),recordId=asId('unused-enum-result-record');
for(const [mutation,read,_type,values] of profiles){
 for(const value of values){
  trace.length=0;
  const outcome=await invoker.invokeMutation({operation:`EnumResults.${mutation}`,
   operation_id:uuidv7(FIXED_NOW,++sequence),inputs:{value}},identity);
  assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'committed');
  assert.deepEqual(outcome.result.result,value);
  assert.deepEqual(trace,[['admission','members',true],['check',true],['check',true]]);
  const revision=await store.readRevision(),history=await store.historyFor(model,recordId);
  trace.length=0;
  const readOutcome=await invoker.invokeRead({operation:`EnumResults.${read}`,inputs:{value}},identity);
  assert.ok('result' in readOutcome,JSON.stringify(readOutcome));
  assert.deepEqual(readOutcome.result,{result:value,revision});
  assert.deepEqual(trace,[['admission','members',true],['check',true],['check',true]]);
  assert.equal(await store.readRevision(),revision);assert.deepEqual(await store.historyFor(model,recordId),history);
 }
}
trace.length=0;
const denied=await invoker.invokeMutation({operation:'EnumResults.singular',
 operation_id:uuidv7(FIXED_NOW,++sequence),inputs:{value:'a'}},outsider);
assert.ok('error' in denied,JSON.stringify(denied));assert.equal(denied.error.code,'forbidden');
assert.deepEqual(trace,[],'canonical denial precedes generated admission and authored body');
console.log('owned enum results: canonical Memory mutation/read wrappers, ordered wire values and admission passed');
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
