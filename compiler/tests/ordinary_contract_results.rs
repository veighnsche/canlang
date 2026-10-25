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
fn timezone_contract_closures_publish_and_unknown_fields_still_refuse() {
    let scratch = tempfile::tempdir().unwrap();
    let source = SOURCE.replace("  contract Flat {different:bool}", "  contract Flat {different:bool}\n  Record {title:text}\n  contract Container {record:Record}\n  contract Wrapper {container:Container}\n  contract Calendar {zone:timezone,zones:timezone[],optional:timezone?}");
    let artifact = compile(&source, scratch.path(), "unsupported");
    let contracts = artifact["valueTypes"]["contracts"].as_array().unwrap();
    for supported in ["Other.Container", "Other.Wrapper", "Other.Calendar"] {
        assert!(
            contracts
                .iter()
                .any(|contract| contract["name"] == supported)
        );
    }
    let calendar = contracts
        .iter()
        .find(|contract| contract["name"] == "Other.Calendar")
        .unwrap();
    assert_eq!(
        calendar["fields"],
        serde_json::json!([
            {"name":"zone","type":"timezone"},
            {"name":"zones","type":"timezone[]"},
            {"name":"optional","type":"timezone?"},
        ])
    );
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

#[test]
fn ordinary_contract_modifiers_publish_exact_owning_schema_bounds() {
    let scratch = tempfile::tempdir().unwrap();
    let source = r#"app NominalBounds
Given
 Source {title:text trim min=1}
 contract Fact {version:int min=1 max=9223372036854775807,title:Source.title max=2000,description:text? max=8000,amount:decimal min=1.25 max=2.5,titles:text[] min=1 max=10}
When
 scenario result() read=true -> Fact by=members
  do return Fact {version=1,title="title",description=null,amount=1.5,titles=["title"]}
Then
"#;
    let artifact = compile(source, scratch.path(), "nominal-bounds");
    let fields = &artifact["valueTypes"]["contracts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|contract| contract["name"] == "NominalBounds.Fact")
        .unwrap()["fields"];
    assert_eq!(
        fields,
        &json!([
            {"name":"version","type":"int","min":"1","max":"9223372036854775807"},
            {"name":"title","type":"text","trim":true,"min":1,"max":2000},
            {"name":"description","type":"text?","max":8000},
            {"name":"amount","type":"decimal","min":"1.25","max":"2.5"},
            {"name":"titles","type":"text[]","min":1,"max":10}
        ])
    );
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let runner = scratch.path().join("nominal-bounds.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(process.argv[2]+'/package.json');
const {normalizeValueTypes,validateValue}=await import(pathToFileURL(require.resolve('@canlang/values')));
const artifact=JSON.parse(readFileSync(process.argv[3],'utf8'));
const {valueSchema,valueTypes}=normalizeValueTypes(artifact.valueTypes);
assert.ok(Object.isFrozen(valueTypes.contracts));
const valid={version:'9223372036854775807',title:'  title  ',description:null,amount:'1.5',titles:['title']};
const normalized=validateValue(valueSchema,'NominalBounds.Fact',valid,'create');
assert.equal(normalized.version,9223372036854775807n);
assert.equal(normalized.title,'title');
for(const invalid of [
 {...valid,version:'0'}, {...valid,version:'9223372036854775808'},
 {...valid,title:'   '}, {...valid,title:'x'.repeat(2001)},
 {...valid,description:'x'.repeat(8001)},
 {...valid,amount:'1.24'}, {...valid,amount:'2.51'},
 {...valid,titles:[]}, {...valid,titles:Array(11).fill('title')},
]) assert.throws(()=>validateValue(valueSchema,'NominalBounds.Fact',invalid,'create'));
validateValue(valueSchema,'NominalBounds.Fact',{...valid,version:'1',amount:'1.25'},'create');
validateValue(valueSchema,'NominalBounds.Fact',{...valid,amount:'2.5'},'create');
"#).unwrap();
    let consumed = Command::new("node")
        .arg(runner)
        .arg(root)
        .arg(scratch.path().join("nominal-bounds.json"))
        .output()
        .unwrap();
    assert!(
        consumed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&consumed.stdout),
        String::from_utf8_lossy(&consumed.stderr)
    );
    for (name, invalid) in [
        ("computed", source.replace("max=2000", "max=1000+1000")),
        (
            "unsafe-length",
            source.replace("max=2000", "max=9007199254740992"),
        ),
    ] {
        let input = scratch.path().join(format!("{name}.can"));
        std::fs::write(&input, invalid).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(input)
            .output()
            .unwrap();
        let refusal: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(!output.status.success(), "{name}: {refusal}");
        assert!(refusal.get("modules").is_none());
        assert!(
            refusal["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"] == "E6008"),
            "{name}: {refusal}"
        );
    }
}

#[test]
fn ordinary_contract_model_refs_use_the_actual_same_load_model_inventory() {
    let scratch = tempfile::tempdir().unwrap();
    let source = r#"package todo
 Given
  export Task {title:text trim min=1}
  policy Task read=members fields=title
 When
 Then
app ModelContracts
use todo {Task}
Given
 contract Fact {task:Task,optional:Task?,tasks:Task[],version:int,title:Task.title}
When
 scenario snapshot(task:Task,optional:Task?,tasks:Task[],version:int,title:text) read=true -> Fact by=members
  do return Fact {task,optional,tasks,version,title}
Then
"#;
    let artifact = compile(source, scratch.path(), "model-contract");
    let contracts = artifact["valueTypes"]["contracts"].as_array().unwrap();
    let fact = contracts
        .iter()
        .find(|contract| contract["name"] == "ModelContracts.Fact")
        .unwrap();
    assert_eq!(
        fact["fields"],
        json!([
            {"name":"task","type":"todo.Task"},
            {"name":"optional","type":"todo.Task?"},
            {"name":"tasks","type":"todo.Task[]"},
            {"name":"version","type":"int"},
            {"name":"title","type":"text","trim":true,"min":1}
        ])
    );
    assert!(
        !contracts
            .iter()
            .any(|contract| contract["name"] == "todo.Task"),
        "model row schemas are not nominal contracts"
    );
    let operation = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == "ModelContracts.snapshot")
        .unwrap();
    assert_eq!(operation["result"], json!({"type":"ModelContracts.Fact"}));
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let runner = scratch.path().join("model-contract.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(process.argv[2]+'/package.json');
const {normalizeValueTypes,validateValue,encodeValue,decodeValue}=await import(pathToFileURL(require.resolve('@canlang/values')));
const artifact=JSON.parse(readFileSync(process.argv[3],'utf8'));
const models=artifact.models.map(model=>model.name);
assert.deepEqual(models,['todo.Task']);
const {valueTypes,valueSchema}=normalizeValueTypes(artifact.valueTypes,models);
assert.ok(Object.isFrozen(valueTypes.contracts));
assert.throws(()=>normalizeValueTypes(artifact.valueTypes),error=>error.code==='dangling');
assert.throws(()=>normalizeValueTypes(artifact.valueTypes,[]),error=>error.code==='dangling');
assert.throws(()=>normalizeValueTypes(artifact.valueTypes,[...models,'ModelContracts.Fact']),error=>error.code==='duplicate');
assert.throws(()=>normalizeValueTypes(artifact.valueTypes,[...models,...models]),error=>error.code==='duplicate');
const dangling=structuredClone(artifact.valueTypes);
dangling.contracts.find(contract=>contract.name==='ModelContracts.Fact').fields[0].type='todo.Missing';
assert.throws(()=>normalizeValueTypes(dangling,models),error=>error.code==='dangling');
const first={id:'019a4500-0000-7000-8000-000000000001',version:'7'};
const second={id:'019a4500-0000-7000-8000-000000000002',version:'9'};
const wire={task:first,optional:null,tasks:[second,first],version:'7',title:'  Task  '};
const native=validateValue(valueSchema,'ModelContracts.Fact',wire,'create');
assert.equal(native.task.model,'todo.Task');
assert.equal(native.task.version,7n);
assert.equal(native.version,7n);
assert.equal(native.optional,null);
assert.equal(native.title,'Task');
assert.deepEqual(native.tasks.map(ref=>[ref.model,ref.id,ref.version]),[['todo.Task',second.id,9n],['todo.Task',first.id,7n]]);
assert.deepEqual(encodeValue('ModelContracts.Fact',native),{...wire,title:'Task'});
assert.deepEqual(encodeValue('todo.Task',decodeValue('todo.Task',first)),first);
const present=validateValue(valueSchema,'ModelContracts.Fact',{...wire,optional:second,tasks:[]},'create');
assert.equal(present.optional.version,9n);
assert.deepEqual(present.tasks,[]);
const {task:omittedTask,...missingTask}=wire;
assert.throws(()=>validateValue(valueSchema,'ModelContracts.Fact',missingTask,'create'));
const readRef=validateValue(valueSchema,'ModelContracts.Fact',{...wire,task:{id:first.id}},'create');
assert.equal(readRef.task.version,undefined);
const normalizedRef=validateValue(valueSchema,'ModelContracts.Fact',{...wire,task:{...first,version:'07'}},'create');
assert.equal(normalizedRef.task.version,7n);
assert.equal(encodeValue('ModelContracts.Fact',normalizedRef).task.version,'7');
for(const [index,invalid] of [
 {...wire,unknown:true}, {...wire,task:null}, {...wire,task:{...first,title:'row contents'}},
 {...wire,task:{...first,version:7}},
 {...wire,optional:false}, {...wire,tasks:null}, {...wire,tasks:[null]},
 {...wire,tasks:[{...second,version:'invalid'}]}, {...wire,title:'   '}
].entries()) assert.throws(()=>validateValue(valueSchema,'ModelContracts.Fact',invalid,'create'),`invalid model contract case ${index}`);
const {loadArtifactDescriptors}=await import(pathToFileURL(require.resolve('@canlang/state/invocation/registry')));
const loaded=loadArtifactDescriptors(artifact,{by:'members'});
assert.deepEqual(loaded.models.map(model=>model.name),models);
assert.deepEqual(loaded.registry.get('ModelContracts.snapshot').descriptor.result,{type:'ModelContracts.Fact'});
assert.deepEqual(validateValue(loaded.valueSchema,'ModelContracts.Fact',wire,'create'),native);
assert.throws(()=>loadArtifactDescriptors({...artifact,models:[]},{by:'members'}),error=>error.reason==='dangling_reference');
assert.throws(()=>loadArtifactDescriptors({...artifact,models:[...artifact.models,...artifact.models]},{by:'members'}),error=>error.reason==='duplicate_name');
"#).unwrap();
    let consumed = Command::new("node")
        .arg(runner)
        .arg(root)
        .arg(scratch.path().join("model-contract.json"))
        .output()
        .unwrap();
    assert!(
        consumed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&consumed.stdout),
        String::from_utf8_lossy(&consumed.stderr)
    );
}

#[test]
fn ordinary_contract_file_union_closure_binds_original_state_profiles() {
    let scratch = tempfile::tempdir().unwrap();
    let source = r#"app FileProfile
Given
 Record {attachments:file[]! min=1 max=2,label:text trim min=1 max=5}
 policy Record read=members
 contract Packet {attachments:file[]! min=1 max=3,optional:file?,related:Record?,label:text trim max=5,state:enum(open,closed)}
 contract Empty {note:text}
 contract Bundle {choice:Packet|Empty,extras:file[],optional:file[]?}
When
 scenario inspect(payload:Bundle) read=true -> Bundle by=members
  do return payload
 scenario inspectNullable(payload:Bundle?) read=true -> Bundle? by=members
  do return payload
 scenario bounded(values:Record.attachments) read=true -> file[] by=members
  do return values
Then
"#;
    // A nominal union cannot lend publication to an incomplete or model arm.
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    for (name, refused_source) in [
        (
            "mixed-model-union",
            source.replace("choice:Packet|Empty", "choice:Packet|Record"),
        ),
        (
            "cyclic-contract-union",
            source.replace(
                "contract Empty {note:text}",
                "contract Empty {note:text,next:Bundle}",
            ),
        ),
    ] {
        let input = scratch.path().join(format!("{name}.can"));
        std::fs::write(&input, refused_source).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        let refusal: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(!output.status.success(), "{name}: {refusal}");
        assert!(refusal.get("modules").is_none(), "{name}: {refusal}");
        assert!(
            refusal["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"] == "E6008"),
            "{name}: {refusal}"
        );
    }
    let artifact = compile(source, scratch.path(), "file-profile");
    let contracts = artifact["valueTypes"]["contracts"].as_array().unwrap();
    for name in [
        "FileProfile.Packet",
        "FileProfile.Empty",
        "FileProfile.Bundle",
    ] {
        assert!(contracts.iter().any(|contract| contract["name"] == name));
    }
    assert!(
        !contracts
            .iter()
            .any(|contract| contract["name"] == "FileProfile.Record")
    );
    let bundle = contracts
        .iter()
        .find(|contract| contract["name"] == "FileProfile.Bundle")
        .unwrap();
    let choice = bundle["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|field| field["name"] == "choice")
        .unwrap();
    assert_eq!(choice["type"], "FileProfile.Packet|FileProfile.Empty");
    let runner = scratch.path().join("file-profile.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(process.argv[2]+'/package.json');
const {loadArtifactDescriptors}=await import(pathToFileURL(require.resolve('@canlang/state/invocation/registry')));
const {StateError}=await import(pathToFileURL(require.resolve('@canlang/state/errors')));
const {bindDeclaredFileReferenceProfile,fileReferenceOccurrences}=await import(pathToFileURL(process.argv[2]+'/packages/state/dist/src/ports/file-reference-profile.js'));
const artifact=JSON.parse(readFileSync(process.argv[3],'utf8'));
const loaded = loadArtifactDescriptors(artifact, { by: 'members' });
const bound = { artifactModels: new Map(artifact.models.map(model => [model.name, model])),
  canonicalModels: loaded.models, valueSchema: loaded.valueSchema, valueTypes: loaded.valueTypes };
const original = loaded.registry.get('FileProfile.inspect').descriptor;
const declaration = original.inputs.find(input => input.name === 'payload');
assert.equal(declaration.valueType, 'FileProfile.Bundle');
assert.equal(original.result.type, declaration.valueType);
const profile = bindDeclaredFileReferenceProfile(bound, declaration.valueType, declaration);
const resultProfile = bindDeclaredFileReferenceProfile(bound, original.result.type);
assert.equal(profile.fileBearing, true);
const wire = { choice: { type: 'FileProfile.Packet', value: {
  attachments: [{ id: 'alpha' }, { id: 'alpha' }], optional: { id: 'beta' },
  related: { id: 'record', version: '1' }, label: 'label', state: 'open',
} }, extras: [{ id: 'gamma' }], optional: null };
const expected = [
  { ref: 'alpha', path: ['choice', 'value', 'attachments', 0] },
  { ref: 'alpha', path: ['choice', 'value', 'attachments', 1] },
  { ref: 'beta', path: ['choice', 'value', 'optional'] },
  { ref: 'gamma', path: ['extras', 0] },
];
assert.deepEqual(fileReferenceOccurrences(profile, wire), expected);
assert.deepEqual(fileReferenceOccurrences(resultProfile, wire), expected);
const optional = loaded.registry.get('FileProfile.inspectNullable').descriptor.inputs[0];
const nullableProfile = bindDeclaredFileReferenceProfile(bound, optional.valueType, optional);
assert.deepEqual(fileReferenceOccurrences(nullableProfile, null), []);
assert.deepEqual(fileReferenceOccurrences(nullableProfile, wire), expected);
assert.deepEqual(fileReferenceOccurrences(profile, { choice: { type: 'FileProfile.Empty', value: { note: 'none' } },
  extras: [], optional: [{ id: 'delta' }] }), [{ ref: 'delta', path: ['optional', 0] }]);
for (const mutate of [
  copy => { copy.choice.value.attachments = []; },
  copy => { copy.choice.value.attachments[0].url = 'https://invalid.test'; },
  copy => { copy.choice.value.optional = { id: 7 }; },
  copy => { copy.choice.value.label = ' label '; },
  copy => { copy.choice.value.label = 'overbound'; },
  copy => { copy.choice.value.state = 'missing'; },
  copy => { copy.choice.value.related.version = '01'; },
  copy => { copy.choice.type = 'FileProfile.Missing'; },
  copy => { copy.choice.authority = true; },
  copy => { delete copy.extras; },
  copy => { copy.optional = [null]; },
]) {
  const malformed = structuredClone(wire); mutate(malformed);
  assert.throws(() => fileReferenceOccurrences(profile, malformed), error => error instanceof StateError);
}
assert.throws(() => fileReferenceOccurrences({ ...profile }, wire), error => error instanceof StateError);
for (const type of ['FileProfile.Missing', 'file []', 'text|FileProfile.Packet']) {
  assert.throws(() => bindDeclaredFileReferenceProfile(bound, type), error => error instanceof StateError);
}
const bounded = loaded.registry.get('FileProfile.bounded').descriptor.inputs.find(input => input.name === 'values');
assert.equal(bounded.min, 1); assert.equal(bounded.max, 2);
assert.equal(bounded.valueType, 'file[]');
const boundedProfile = bindDeclaredFileReferenceProfile(bound, bounded.valueType, bounded);
const required = loaded.models.find(model => model.name === 'FileProfile.Record').fields.attachments;
assert.equal(required.valueType, 'file[]!'); assert.deepEqual(required.array, { required: true });
const requiredProfile = bindDeclaredFileReferenceProfile(bound, required.valueType, required);
for (const profile of [boundedProfile, requiredProfile]) {
  assert.deepEqual(fileReferenceOccurrences(profile, [{ id: 'alpha' }]), [{ ref: 'alpha', path: [0] }]);
  for (const wire of [[], Array(3).fill({ id: 'alpha' }), undefined, null]) {
    assert.throws(() => fileReferenceOccurrences(profile, wire), error => error instanceof StateError);
  }
}
const label = loaded.models.find(model => model.name === 'FileProfile.Record').fields.label;
const text = bindDeclaredFileReferenceProfile(bound, label.valueType, label);
assert.equal(text.fileBearing, false);
assert.deepEqual(fileReferenceOccurrences(text, 'label'), []);
for (const value of [' label ', '', 'longer']) {
  assert.throws(() => fileReferenceOccurrences(text, value), error => error instanceof StateError);
}
for (const constraint of [{ ...bounded, valueType: 'file[]!' }, { ...bounded, min: -1 },
  { ...bounded, max: undefined }, { ...bounded, trim: true }]) {
  assert.throws(() => bindDeclaredFileReferenceProfile(bound, bounded.valueType, constraint), error => error instanceof StateError);
}
const skewed = structuredClone(loaded.valueTypes);
skewed.contracts = skewed.contracts.filter(contract => contract.name !== 'FileProfile.Packet');
assert.throws(() => bindDeclaredFileReferenceProfile({ ...bound, valueTypes: skewed }, declaration.valueType),
  error => error instanceof StateError);
"#).unwrap();
    let consumed = Command::new("node")
        .arg(runner)
        .arg(root)
        .arg(scratch.path().join("file-profile.json"))
        .output()
        .unwrap();
    assert!(
        consumed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&consumed.stdout),
        String::from_utf8_lossy(&consumed.stderr)
    );
}
