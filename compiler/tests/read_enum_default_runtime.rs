//! Wrapped enum read defaults over canonical viewer-projected Memory records.
//! The int[] result stays released; no read receipts or durability claim.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn read_enum_defaults_use_projected_records_once_in_order_and_live_admission() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("read-enum-default.can");
    let original = std::fs::read_to_string(
        root.join("packages/cloudflare/test/fixtures/typed-scenario-values.can"),
    )
    .unwrap();
    let source = original.replace("Counter { count:int=1 }", "Counter { count:int=1, state:enum(a,b)=a }")
        .replace("scenario readBound(counter:Counter,values:int[]=[counter.count]) -> int[] by=members read=true\n  do return values", r#"scenario readBound(counter:Counter,values:int[]=[counter.count],nullableSeed:Counter.state?=at([counter.state],0),nullableCopy:Counter.state?=nullableSeed,nullableTail:Counter.state?=nullableCopy,arraySeed:Counter.state[]=[counter.state],arrayCopy:Counter.state[]=arraySeed,arrayTail:Counter.state[]=arrayCopy,nullableArraySeed:Counter.state[]?=at([[counter.state]],0),nullableArrayCopy:Counter.state[]?=nullableArraySeed,nullableArrayTail:Counter.state[]?=nullableArrayCopy) -> int[] by=members read=true
  do
   require nullableSeed==nullableCopy and nullableCopy==nullableTail
   require arraySeed==arrayCopy and arrayCopy==arrayTail
   require nullableArraySeed==nullableArrayCopy and nullableArrayCopy==nullableArrayTail
   return values"#);
    assert_ne!(source, original);
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
const {FIXED_NOW,createMemoryIdentityStore,seedMember,makeIdentity,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const app='TypedScenarioValues',model=`${app}.Counter`,id=`${app}.readBound`;
const descriptor=artifact.operations.find(operation=>operation.name===id);
assert.equal(descriptor.kind,'read');assert.deepEqual(descriptor.result,{type:'int[]'});
assert.deepEqual(descriptor.inputs.fields[0].field,{kind:'ref',model,requireVersion:false});
assert.equal(descriptor.inputs.fields[1].computedDefault,true);
const names=['nullableSeed','nullableCopy','nullableTail','arraySeed','arrayCopy','arrayTail','nullableArraySeed','nullableArrayCopy','nullableArrayTail'];
assert.deepEqual(descriptor.inputs.fields.slice(2).map(field=>field.name),names);
for(const [index,field]of descriptor.inputs.fields.slice(2).entries()){
 assert.deepEqual(field.field,{kind:'enum',values:['a','b']});
 assert.equal(field.required,false);assert.equal(field.computedDefault,true);assert.equal(Object.hasOwn(field,'default'),false);
 assert.equal(field.valueType,index<3?'enum(a,b)?':index<6?'enum(a,b)[]':'enum(a,b)[]?');
 assert.equal(field.nullable===true,index<3||index>=6);
 if(index>=3)assert.deepEqual(field.array,{required:false});else assert.equal(Object.hasOwn(field,'array'),false);
}
assert.equal(artifact.callables.find(callable=>callable.id===id).inputStyle,'parameters');
// Only observe calls. Every helper delegates to its installed owner, and the
// maintained assembler routes the genuine modules to the canonical seam.
const seamUrl=pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
const shim=resolve(base,'observed-stdlib.mjs');
writeFileSync(shim,`
export * from ${JSON.stringify(seamUrl)};
import {require as nativeRequire,hasRole as nativeHasRole,at as nativeAt} from ${JSON.stringify(seamUrl)};
export function at(...args){globalThis.readEnumTrace.push(['default',structuredClone(args[0])]);return nativeAt(...args);}
export function hasRole(...args){const result=nativeHasRole(...args);globalThis.readEnumTrace.push(['admission',args[1],result]);return result;}
function check(...args){globalThis.readEnumTrace.push(['check',args[0]]);return nativeRequire(...args);}
export {check as require};
`);
const asm=await assembleModules({artifact,sourcePath:resolve(base,'read-enum-default.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(shim).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
const outsider=makeIdentity({userId:'nonmember',team:member.team,membership:null});
const anonymous=makeIdentity({actor:null,team:null,membership:null});
const trace=[];globalThis.readEnumTrace=trace;
const created=await invoker.invokeMutation({operation:`${model}.create`,operation_id:uuidv7(FIXED_NOW,1),inputs:{}},identity);
assert.ok('result' in created,JSON.stringify(created));assert.equal(created.result.status,'committed');
const row=created.result.result;assert.equal(row.data.count,'1');assert.equal(row.data.state,'a');
const counter={id:row.id},revision=await store.readRevision(),history=await store.historyFor(model,row.id);
async function unchanged(){
 assert.equal(await store.readRevision(),revision,'reads never commit a receipt or effects');
 assert.deepEqual(await store.historyFor(model,row.id),history);
}
async function read(inputs,who=identity){trace.length=0;return invoker.invokeRead({operation:id,inputs:{counter,...inputs}},who);}
async function success(inputs,want,wantTrace){
 const outcome=await read(inputs);assert.ok('result' in outcome,JSON.stringify(outcome));
 assert.deepEqual(outcome.result,{result:want,revision});assert.deepEqual(trace,wantTrace);await unchanged();
}
const guards=[['admission','members',true],['check',true]];
const body=[['check',true],['check',true],['check',true]];
await success({},['1'],[...guards,['default',['a']],['default',[['a']]],...body]);
// Explicit null/empty values remain supplied; no helper default executes.
await success({values:[],nullableSeed:null,nullableCopy:null,nullableTail:null,
 arraySeed:[],arrayCopy:[],arrayTail:[],nullableArraySeed:null,nullableArrayCopy:null,nullableArrayTail:null},[],[...guards,...body]);
// Ordered arrays and explicit cases override all source-derived seeds coherently.
await success({values:['9'],nullableSeed:'b',nullableCopy:'b',nullableTail:'b',
 arraySeed:['b','a'],arrayCopy:['b','a'],arrayTail:['b','a'],
 nullableArraySeed:['b','a'],nullableArrayCopy:['b','a'],nullableArrayTail:['b','a']},['9'],[...guards,...body]);
for(const who of [anonymous,outsider]){
 const outcome=await read({},who);assert.ok('error' in outcome,JSON.stringify(outcome));
 assert.equal(outcome.error.code,'forbidden');assert.deepEqual(trace,[]);await unchanged();
}
await memberships.removeMembership(member.membership.membership_id);
const revoked=await read({});assert.ok('error' in revoked,JSON.stringify(revoked));
assert.equal(revoked.error.code,'forbidden');assert.deepEqual(trace,[]);await unchanged();
console.log('read enum defaults: canonical projected records, helper once/order, explicit overrides and live admission passed');
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
