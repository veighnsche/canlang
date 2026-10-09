//! Ordinary source-owned contracts use the existing closed value inventory.
#![cfg(unix)]
use serde_json::{Value, json};
use std::{path::Path, process::Command};

const SOURCE: &str = r#"app ContractApp uses=[Results]
package Results
 Given
  export contract Flat {title:text,count:int,ready:bool,state:enum(open,closed)}
  export contract Nested {summary:Flat,alternatives:Flat[],optional:Flat?}
  export contract Scalars {day:date,at:datetime,elapsed:duration,amount:decimal,total:money}
  export Archive {flat:Flat,nested:Nested}
  policy Archive read=members fields=flat,nested
 When
  crud Archive by=members fields=flat,nested delete=none
  export scenario flat(count:int) read=true -> Flat by=members
   do
    return Flat {title="Task",count,ready=true,state=open}
  export scenario nested(count:int) read=true -> Nested by=members
   do
    let summary=Flat {title="Task",count,ready=true,state=closed}
    return Nested {summary,alternatives=[summary],optional=null}
  export scenario saved(count:int) -> Nested by=members
   do
    let summary=Flat {title="Task",count,ready=true,state=closed}
    return Nested {summary,alternatives=[summary],optional=null}
  export scenario scalars(day:date,at:datetime,elapsed:duration,amount:decimal,total:money) read=true -> Scalars by=members
   do
    return Scalars {day,at,elapsed,amount,total}
 Then
package Other
 Given
  contract Flat {different:bool}
 When
 Then
"#;

fn compile(source: &str, scratch: &Path, name: &str) -> Value {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let input = scratch.join(format!("{name}.can"));
    std::fs::write(&input, source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&input)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    let artifact: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(output.status.success(), "{name}: {artifact}");
    std::fs::write(scratch.join(format!("{name}.json")), output.stdout).unwrap();
    artifact
}

#[test]
fn ordinary_contract_inventory_and_results_do_not_need_judgment() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let artifact = compile(SOURCE, scratch.path(), "ordinary");
    let inventory = artifact["valueTypes"]
        .as_object()
        .expect("ordinary contracts publish their own checked inventory");
    assert!(
        inventory["contracts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|contract| contract["name"] == "Results.Flat")
    );
    for (operation, result) in [
        ("Results.flat", "Results.Flat"),
        ("Results.nested", "Results.Nested"),
        ("Results.saved", "Results.Nested"),
        ("Results.scalars", "Results.Scalars"),
    ] {
        let descriptor = artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|descriptor| descriptor["name"] == operation)
            .unwrap();
        assert_eq!(descriptor["result"], json!({"type":result}));
    }
    let unrelated = SOURCE.replace("  contract Flat {different:bool}", "  contract Flat {different:bool}\n  judgment Unrelated version=1\n   approved noul \"Approve?\" yes=\"Approved\" no=\"Rejected\"");
    let with_judgment = compile(&unrelated, scratch.path(), "unrelated");
    for name in [
        "Results.Flat",
        "Results.Nested",
        "Results.Scalars",
        "Other.Flat",
    ] {
        let schema = |value: &Value| {
            value["valueTypes"]["contracts"]
                .as_array()
                .unwrap()
                .iter()
                .find(|contract| contract["name"] == name)
                .unwrap()
                .clone()
        };
        assert_eq!(schema(&artifact), schema(&with_judgment));
    }
    assert_eq!(artifact["operations"], with_judgment["operations"]);
    let runner = scratch.path().join("native.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const base=dirname(fileURLToPath(import.meta.url)),root=process.argv[2];
const require=createRequire(resolve(root,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules}=await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker}=await load('@canlang/cloudflare/worker/assembly');
const {queryPageRowsCanonical}=await load('@canlang/cloudflare/runtime/invoke');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const {FIXED_NOW,createMemoryIdentityStore,seedMember,makeIdentity,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const artifact=JSON.parse(readFileSync(resolve(base,'ordinary.json'),'utf8'));
const asm=await assembleModules({artifact,sourcePath:resolve(base,'ordinary.can')},{workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href});
const entry=await import(asm.entryUrl);
assert.equal(typeof entry.canApp,'function');
assert.deepEqual(entry.appDefinition.operations['Results.saved'].result,{type:'Results.Nested'});
assert.deepEqual(entry.appDefinition.contracts['Results.Nested'].fields,{
 summary:{type:'Results.Flat'},alternatives:{type:'Results.Flat[]'},optional:{type:'Results.Flat?'}});
assert.deepEqual(entry.appDefinition.contracts['Results.Scalars'].fields,{
 day:{type:'date'},at:{type:'datetime'},elapsed:{type:'duration'},amount:{type:'decimal'},total:{type:'money'}});
assert.deepEqual(entry.appDefinition.models['Results.Archive'].fields,{
 flat:{type:'Results.Flat'},nested:{type:'Results.Nested'}});
assert.deepEqual(entry.appDefinition.operations['Results.Archive.create'].inputs,{
 fields:['flat','nested']});
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
const count='9223372036854775807';
const revision=await store.readRevision();
for(const [operation,state] of [['Results.flat','open'],['Results.nested','closed']]){
 const outcome=await invoker.invokeRead({operation,inputs:{count}},identity);
 assert.ok('result' in outcome,JSON.stringify(outcome));
 const flat={title:'Task',count,ready:true,state};
 assert.deepEqual(outcome.result,{result:operation==='Results.flat'?flat:{summary:flat,alternatives:[flat],optional:null},revision});
}
assert.equal(await store.readRevision(),revision);
const scalarInputs={day:'2024-02-29',at:'2024-02-29T12:34:56.000Z',elapsed:'9007199254740993',amount:'12.34',total:{minor:'1234',currency:'EUR'}};
const scalarOutcome=await invoker.invokeRead({operation:'Results.scalars',inputs:scalarInputs},identity);
assert.ok('result' in scalarOutcome,JSON.stringify(scalarOutcome));
assert.deepEqual(scalarOutcome.result,{result:scalarInputs,revision});
const request={operation:'Results.saved',operation_id:uuidv7(FIXED_NOW,1),inputs:{count}};
const committed=await invoker.invokeMutation(request,identity);
assert.ok('result' in committed,JSON.stringify(committed));
assert.equal(committed.result.status,'committed');
const flat={title:'Task',count,ready:true,state:'closed'};
const expected={summary:flat,alternatives:[flat],optional:null};
assert.deepEqual(committed.result.result,expected);
const saved=await store.readReceipt({app:'ContractApp',owner:identity.team.team_id,
 principal:identity.actor.user_id,operation:request.operation,operationId:request.operation_id});
assert.equal(saved.outcome.status,'committed');
assert.deepEqual(saved.outcome.result,expected);
const model='Results.Archive';
const create={operation:model+'.create',operation_id:uuidv7(FIXED_NOW,2),inputs:{flat,nested:expected}};
const created=await invoker.invokeMutation(create,identity);
assert.ok('result' in created,JSON.stringify(created));
assert.equal(created.result.status,'committed');
assert.equal(created.result.records.length,1);
const row=created.result.records[0];
assert.deepEqual(row.data,{flat,nested:expected});
const persisted=await store.load(model,row.id);
assert.deepEqual(persisted.data,{flat,nested:expected});
const projection=await queryPageRowsCanonical({asm,artifact,model,args:{},identity,store,memberships});
assert.equal(projection.rows.length,1);
assert.equal(projection.rows[0].id,row.id);
assert.deepEqual(projection.rows[0].fields,{flat,nested:expected});
const historyBeforeInvalid=await store.historyFor(model,row.id);
for(const [index,bad] of [
 {...flat,count:'not-int'},
 {...flat,state:'unknown'},
 {...flat,undeclared:true},
 {title:'Task',count,ready:true},
].entries()){
 const invalidRequest={operation:model+'.create',operation_id:uuidv7(FIXED_NOW,3+index),inputs:{flat:bad,nested:expected}};
 const refused=await invoker.invokeMutation(invalidRequest,identity);
 assert.ok('error' in refused,JSON.stringify(refused));
 assert.equal(refused.error.code,'validation');
 const rejectedReceipt=await store.readReceipt({app:'ContractApp',owner:identity.team.team_id,
  principal:identity.actor.user_id,operation:invalidRequest.operation,operationId:invalidRequest.operation_id});
 assert.equal(rejectedReceipt.outcome.status,'rejected');
 assert.equal(rejectedReceipt.outcome.code,'validation');
}
const badNested=await invoker.invokeMutation({operation:model+'.create',operation_id:uuidv7(FIXED_NOW,7),inputs:{flat,nested:{...expected,alternatives:[{...flat,count:'not-int'}]}}},identity);
assert.ok('error' in badNested,JSON.stringify(badNested));
assert.equal(badNested.error.code,'validation');
assert.deepEqual(await store.load(model,row.id),persisted);
assert.deepEqual(await store.historyFor(model,row.id),historyBeforeInvalid);
assert.equal((await queryPageRowsCanonical({asm,artifact,model,args:{},identity,store,memberships})).rows.length,1);
const malformed=await invoker.invokeRead({operation:'Results.flat',inputs:{count:'not-int'}},identity);
assert.ok('error' in malformed);assert.equal(malformed.error.code,'validation');
const outsider=makeIdentity({userId:'nonmember',team:member.team,membership:null});
const denied=await invoker.invokeRead({operation:'Results.flat',inputs:{count}},outsider);
assert.ok('error' in denied);assert.equal(denied.error.code,'forbidden');
console.log('ordinary contracts: canonical schemas, native nested/enum reads, first saved mutation, generated CRUD persistence/projection and malformed contract refusals passed');
"#).unwrap();
    let output = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn unsupported_contract_closures_remain_unpublished_without_new_diagnostics() {
    let scratch = tempfile::tempdir().unwrap();
    let source = SOURCE.replace("  contract Flat {different:bool}", "  contract Flat {different:bool}\n  Record {title:text}\n  contract Container {record:Record}\n  contract Wrapper {container:Container}\n  contract Private {email:email}");
    let artifact = compile(&source, scratch.path(), "unsupported");
    let contracts = artifact["valueTypes"]["contracts"].as_array().unwrap();
    for unsupported in ["Other.Container", "Other.Wrapper", "Other.Private"] {
        assert!(
            !contracts
                .iter()
                .any(|contract| contract["name"] == unsupported)
        );
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let input = scratch.path().join("unknown.can");
    std::fs::write(
        &input,
        SOURCE.replace("different:bool", "different:Missing"),
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(input)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    let refusal: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(!output.status.success());
    assert!(
        refusal["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E2001")
    );
    assert!(refusal.get("modules").is_none());
}
