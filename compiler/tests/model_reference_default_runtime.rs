//! Earlier required supplied stored-model defaults through canonical Memory
//! invocation and receipt consumer; no durability or wider CRUD claim.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn earlier_supplied_model_default_uses_current_binding_and_receipts() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("model-reference-default.can");
    let source = include_str!("fixtures/model_reference_default.can");
    std::fs::write(&input, source).unwrap();
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
    // Isolate the new source proof: a defaulted seed, nullable target or
    // array target cannot use the earlier required nonnull supplied seed ABI.
    let control_body = source
        .replace("require seed==copied", "require true")
        .replace("return copied.count", "return seed.count");
    for (name, refused) in [
        (
            "default-chain",
            source.replace(
                "copied:StoredModel=seed",
                "copied:StoredModel=seed,tail:StoredModel=copied",
            ),
        ),
        (
            "nullable-target",
            control_body.replace("copied:StoredModel=seed", "copied:StoredModel?=seed"),
        ),
        (
            "array-target",
            control_body.replace("copied:StoredModel=seed", "copied:StoredModel[]=[seed]"),
        ),
    ] {
        let path = scratch.path().join(format!("{name}.can"));
        std::fs::write(&path, refused).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(path)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(10),
            "{name}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let output: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(output.get("modules").is_none(), "{name}: {output}");
        assert!(
            output["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|finding| finding["code"] == "E6008"),
            "{name}: {output}"
        );
    }
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
assert.equal(capture?.version,1,'actual native host requires a complete emitted disclosure plan');
assert.ok(capture.returns.length>0);
const model='ModelReferenceDefaults.StoredModel',id='ModelReferenceDefaults.selected',descriptor=artifact.operations.find(operation=>operation.name===id);
assert.equal(descriptor.kind,'scenario');assert.deepEqual(descriptor.result,{type:'int',disclosure:capture});
assert.deepEqual(descriptor.inputs.fields.map(field=>[field.name,field.field,field.required]),[
 ['seed',{kind:'ref',model,requireVersion:true},true],['copied',{kind:'ref',model,requireVersion:true},false],
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
export function hasRole(...args){const result=nativeHasRole(...args);globalThis.modelDefaultTrace.push(['admission',args[1],result]);return result;}
function check(...args){globalThis.modelDefaultTrace.push(['check',args[0]]);return nativeRequire(...args);}
export {check as require};
`);
const asm=await assembleModules({artifact,sourcePath:resolve(base,'model-reference-default.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(shim).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
let sequence=0;
const envelope=(inputs,operation=id)=>({operation,operation_id:uuidv7(FIXED_NOW,++sequence),inputs});
const receiptIdentity=request=>({app:'ModelReferenceDefaults',owner:identity.team.team_id,
 principal:identity.actor.user_id,operation:request.operation,operationId:request.operation_id});
const receipt=request=>store.readReceipt(receiptIdentity(request));
const trace=[];globalThis.modelDefaultTrace=trace;
async function invoke(request){trace.length=0;return invoker.invokeMutation(request,identity);}
function committed(outcome,status='committed'){
 assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,status);
 assert.equal(outcome.result.result,'1');return outcome.result;
}
function masked(outcome){assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'replayed');assert.equal(outcome.result.result,null);assert.equal(JSON.stringify(outcome).includes('scenario-result/v1'),false);}
function rejected(outcome,code){assert.ok('error' in outcome,JSON.stringify(outcome));assert.equal(outcome.error.code,code);}
// Obtain references from the real canonical disclosed create record, without seeding
// raw rows or fabricating native views. This is the existing CRUD prerequisite.
async function created(){
 const outcome=await invoke(envelope({},`${model}.create`));
 assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'committed');
 assert.equal(outcome.result.result,null,'generated CRUD has no business result');
 assert.equal(outcome.result.records.length,1,'exact disclosed created record');
 const row=outcome.result.records[0];
 assert.deepEqual(Object.keys(row).sort(),['archivedAt','created','createdBy','data','id','parent','updated','updatedBy','version']);
 assert.equal(typeof row.id,'string');assert.ok(row.id.length>0);
 assert.ok(Number.isSafeInteger(row.version)&&row.version>0);
 assert.equal(row.data.count,'1');assert.equal(row.version,1);
 return {id:row.id,version:String(row.version)};
}
const seed=await created(),other=await created();assert.notEqual(seed.id,other.id);
const omitted=envelope({seed});
committed(await invoke(omitted));
assert.deepEqual(trace,[['admission','members',true],['check',true],['check',true]]);
const saved=await receipt(omitted);assert.ok(saved);
assert.deepEqual(saved.resolvedDefaults,{copied:seed});
assert.deepEqual(Object.keys(saved.resolvedDefaults),['copied']);
assert.deepEqual(Object.keys(saved.resolvedDefaults.copied).sort(),['id','version'],'closed admitted reference wire');
assert.equal(saved.outcome.status,'committed');assert.equal(saved.outcome.result,'1');
const override=envelope({seed,copied:seed});
committed(await invoke(override));
assert.deepEqual(trace,[['admission','members',true],['check',true],['check',true]]);
const overrideReceipt=await receipt(override);assert.deepEqual(overrideReceipt.resolvedDefaults,{});
// A supplied distinct admitted binding fails authored equality and publishes no defaults.
const failure=envelope({seed,copied:other});
rejected(await invoke(failure),'rule_failed');
assert.deepEqual(trace,[['admission','members',true],['check',true],['check',false]]);
const failedReceipt=await receipt(failure);assert.ok(failedReceipt);
assert.equal(failedReceipt.outcome.status,'rejected');assert.deepEqual(failedReceipt.resolvedDefaults,{});
await memberships.removeMembership(member.membership.membership_id);
// Retention remains receipt-first; current authority withholds public saved
// values after revocation, without changing physical receipts or rerunning defaults.
masked(await invoke(omitted));assert.deepEqual(trace,[]);
assert.deepEqual(await receipt(omitted),saved);
masked(await invoke(override));assert.deepEqual(trace,[]);
assert.deepEqual(await receipt(override),overrideReceipt);
rejected(await invoke(failure),'rule_failed');assert.deepEqual(trace,[]);
assert.deepEqual(await receipt(failure),failedReceipt);
// Reusing the identity with explicit inputs is a hash conflict, not a replay
// or an opportunity to resolve defaults again.
rejected(await invoke({...omitted,inputs:{seed,copied:seed}}),'conflict');
assert.deepEqual(trace,[]);assert.deepEqual(await receipt(omitted),saved);
const denied=envelope({seed});
rejected(await invoke(denied),'forbidden');assert.deepEqual(trace,[]);
assert.equal(await receipt(denied),null,'new denied admission must not create a receipt');
console.log('stored-model defaults: canonical Memory receipts, override, failure isolation and receipt-first replay passed');
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
