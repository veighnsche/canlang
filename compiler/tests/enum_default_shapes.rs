//! Nullable and array enum-copy defaults through canonical CF/State Memory
//! receipts; enum results and broader wire validation are outside this case.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn computed_enum_copy_defaults_cover_nullable_and_array_shapes() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("enum-default-shapes.can");
    std::fs::write(
        &input,
        r#"app EnumDefaultShapes
Given
 Entry {state:enum(a,b)=a}
When
 scenario optional(seed:Entry.state?,copied:Entry.state?=seed,tail:Entry.state?=copied) -> bool by=members
  do return tail==seed
 scenario many(seed:Entry.state[],copied:Entry.state[]=seed,tail:Entry.state[]=copied) -> bool by=members
  do return tail==seed
 scenario maybeMany(seed:Entry.state[]?,copied:Entry.state[]?=seed,tail:Entry.state[]?=copied) -> bool by=members
  do return tail==seed
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
 optional:{id:'EnumDefaultShapes.optional',valueType:'enum(a,b)?',nullable:true,array:false},
 many:{id:'EnumDefaultShapes.many',valueType:'enum(a,b)[]',nullable:false,array:true},
 maybeMany:{id:'EnumDefaultShapes.maybeMany',valueType:'enum(a,b)[]?',nullable:true,array:true},
};
for(const shape of Object.values(shapes)){
 const descriptor=artifact.operations.find(operation=>operation.name===shape.id);
 assert.equal(descriptor.kind,'scenario');
 assert.deepEqual(descriptor.inputs.fields.map(field=>field.name),['seed','copied','tail']);
 for(const field of descriptor.inputs.fields){
  assert.deepEqual(field.field,{kind:'enum',values:['a','b']},`${shape.id}.${field.name}`);
  assert.equal(field.valueType,shape.valueType,`${shape.id}.${field.name}`);
  assert.equal(field.nullable===true,shape.nullable,`${shape.id}.${field.name}`);
  if(shape.array)assert.deepEqual(field.array,{required:false},`${shape.id}.${field.name}`);
  else assert.equal(Object.hasOwn(field,'array'),false,`${shape.id}.${field.name}`);
 }
 assert.equal(Object.hasOwn(descriptor.inputs.fields[0],'computedDefault'),false);
 for(const field of descriptor.inputs.fields.slice(1)){
  assert.equal(field.computedDefault,true,`${shape.id}.${field.name}`);
  assert.equal(Object.hasOwn(field,'default'),false,`${shape.id}.${field.name}`);
 }
}
const asm=await assembleModules({artifact,sourcePath:resolve(base,'enum-default-shapes.can')},{
 workDir:resolve(base,'modules'),
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
let sequence=0;
const envelope=(operation,inputs)=>({operation,operation_id:uuidv7(FIXED_NOW,++sequence),inputs});
const receiptIdentity=request=>({app:'EnumDefaultShapes',owner:identity.team.team_id,
 principal:identity.actor.user_id,operation:request.operation,operationId:request.operation_id});
const receipt=request=>store.readReceipt(receiptIdentity(request));
async function checkCase(name,inputs,wantResult,wantDefaults){
 const request=envelope(shapes[name].id,inputs);
 const outcome=await invoker.invokeMutation(request,identity);
 assert.ok('result' in outcome,JSON.stringify(outcome));
 assert.equal(outcome.result.status,'committed');
 assert.equal(outcome.result.result,wantResult,`${name}: bool result`);
 const saved=await receipt(request);assert.ok(saved,`${name}: receipt`);
 assert.equal(saved.outcome.status,'committed');assert.equal(saved.outcome.result,wantResult);
 assert.deepEqual(saved.resolvedDefaults,wantDefaults,`${name}: resolved defaults`);
 assert.deepEqual(Object.keys(saved.resolvedDefaults),Object.keys(wantDefaults),`${name}: declaration order`);
 return saved;
}
// Nullable singular enum copies preserve null and each finite case.
await checkCase('optional',{seed:null},true,{copied:null,tail:null});
await checkCase('optional',{seed:'b'},true,{copied:'b',tail:'b'});
await checkCase('optional',{seed:'a',copied:'b',tail:null},false,{});
// Ordinary enum arrays preserve empty and ordered cases; supplied copies skip defaults.
await checkCase('many',{seed:[]},true,{copied:[],tail:[]});
await checkCase('many',{seed:['a','b']},true,{copied:['a','b'],tail:['a','b']});
await checkCase('many',{seed:['a','b'],copied:['b'],tail:['a']},false,{});
// Nullable arrays keep null distinct from [], while explicit values remain authoritative.
await checkCase('maybeMany',{seed:null},true,{copied:null,tail:null});
await checkCase('maybeMany',{seed:[]},true,{copied:[],tail:[]});
await checkCase('maybeMany',{seed:['a','b'],copied:['b'],tail:[]},false,{});
console.log('nullable and array enum-copy defaults: canonical Memory results and receipt values passed');
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
