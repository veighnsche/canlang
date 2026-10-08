//! Nullable and array user-copy defaults through canonical CF/State Memory
//! receipt serialization; no contextual actor or wider reference claim.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn computed_user_copy_defaults_cover_nullable_and_array_shapes() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("user-default-shapes.can");
    std::fs::write(
        &input,
        r#"app UserShapes
Given
 Entry {label:text}
When
 scenario optional(seed:user?,copied:user?=seed,tail:user?=copied) -> user? by=members
  do return tail
 scenario many(seed:user[],copied:user[]=seed,tail:user[]=copied) -> user[] by=members
  do return tail
 scenario maybeMany(seed:user[]?,copied:user[]?=seed,tail:user[]?=copied) -> user[]? by=members
  do return tail
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
import {readFileSync} from 'node:fs';
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
const shapes={
 optional:{id:'UserShapes.optional',nullable:true,array:false},
 many:{id:'UserShapes.many',nullable:false,array:true},
 maybeMany:{id:'UserShapes.maybeMany',nullable:true,array:true},
};
for(const shape of Object.values(shapes)){
 const descriptor=artifact.operations.find(operation=>operation.name===shape.id);
 assert.equal(descriptor.kind,'scenario');
 for(const field of descriptor.inputs.fields){
  assert.equal(field.field.kind,'user',`${shape.id}.${field.name}: ${JSON.stringify(field)}`);
  assert.equal(field.nullable===true,shape.nullable,`${shape.id}.${field.name}`);
  assert.equal(Object.hasOwn(field,'array'),shape.array,`${shape.id}.${field.name}`);
 }
 for(const field of descriptor.inputs.fields.slice(1)){
  assert.equal(field.computedDefault,true,`${shape.id}.${field.name}`);
  assert.equal(Object.hasOwn(field,'default'),false,`${shape.id}.${field.name}`);
 }
}
const asm=await assembleModules({artifact,sourcePath:resolve(base,'user-default-shapes.can')},{
 workDir:resolve(base,'modules'),
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const colleague=await seedMember(memberships,{isOwner:false,teamId:member.team.team_id});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const actor={id:member.user.user_id},peer={id:colleague.user.user_id};
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
let sequence=0;
const envelope=(operation,inputs)=>({operation,operation_id:uuidv7(FIXED_NOW,++sequence),inputs});
const receiptIdentity=request=>({app:'UserShapes',owner:identity.team.team_id,
 principal:identity.actor.user_id,operation:request.operation,operationId:request.operation_id});
const receipt=request=>store.readReceipt(receiptIdentity(request));
function checkUsers(value){
 if(value===null)return;
 for(const user of Array.isArray(value)?value:[value])assert.deepEqual(Object.keys(user),['id'],'closed user wire');
}
async function checkCase(name,inputs,wantResult,wantDefaults){
 const request=envelope(shapes[name].id,inputs);
 const outcome=await invoker.invokeMutation(request,identity);
 assert.ok('result' in outcome,JSON.stringify(outcome));
 assert.equal(outcome.result.status,'committed');
 assert.deepEqual(outcome.result.result,wantResult,`${name}: business result`);
 checkUsers(outcome.result.result);
 const saved=await receipt(request);assert.ok(saved,`${name}: receipt`);
 assert.deepEqual(saved.resolvedDefaults,wantDefaults,`${name}: resolved defaults`);
 assert.deepEqual(Object.keys(saved.resolvedDefaults),Object.keys(wantDefaults),`${name}: declaration order`);
 for(const value of Object.values(saved.resolvedDefaults))checkUsers(value);
 return saved;
}
// Nullable scalar: null and a supplied active same-team user each flow
// through both computed defaults and into the native result and receipt.
await checkCase('optional',{seed:null},null,{copied:null,tail:null});
await checkCase('optional',{seed:actor},actor,{copied:actor,tail:actor});
await checkCase('optional',{seed:actor,copied:actor,tail:null},null,{});
// Ordinary arrays preserve both the empty array and ordered user wire values.
await checkCase('many',{seed:[]},[],{copied:[],tail:[]});
await checkCase('many',{seed:[actor,peer]},[actor,peer],{copied:[actor,peer],tail:[actor,peer]});
await checkCase('many',{seed:[actor,peer],copied:[peer],tail:[]},[],{});
// Nullable ordinary arrays preserve null independently from an empty list.
await checkCase('maybeMany',{seed:null},null,{copied:null,tail:null});
await checkCase('maybeMany',{seed:[actor,peer]},[actor,peer],{copied:[actor,peer],tail:[actor,peer]});
await checkCase('maybeMany',{seed:[actor,peer],copied:[peer],tail:null},null,{});
console.log('nullable and array user-copy defaults: canonical Memory results and receipt wire passed');
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
