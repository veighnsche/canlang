//! Checked query source transport; original application admission remains separate.
#![cfg(unix)]
use canlang_compiler::{
    analysis::{
        CheckedProgram,
        catalog::{Catalog, CatalogRequest, load_catalog},
        check_program,
    },
    codegen::{
        ir::{self, IrExpr, IrItemKind, IrProgram, IrStmt},
        scenario_queries::{serialize_complete_query_receipt, serialize_query_sources},
    },
    source::{SourceDb, Span},
};
use serde_json::Value;
use std::{path::Path, process::Command};

// A declared test cohort for the source producer, with an actual StateRead
// authorization guard. It does not replace the original application's guards.
const SOURCE: &str = r#"app QuerySources uses=[workbench]
package rent_catalog
 Given
  export Location {name:text}
  policy Location read=members
 When
 Then
package todo
 use rent_catalog {Location}
 Given
  export Task {location:Location?,title:text,description:text?,due:datetime?,priority:enum(low,normal,high)=normal,done:bool=false}
  policy Task read=members
 When
 Then
package workbench
 use rent_catalog {Location}
 use todo {Task}
 Given
  contract Scope {targets:Task[]! min=1 max=10}
  export contract Fact {task:Task,version:int min=1,title:Task.title max=2000,description:Task.description max=8000,due:Task.due,priority:Task.priority,done:bool}
 When
  scenario context(location:Location,targets:Scope.targets) read=true -> Fact[] by=members
   require active_member(actor,team)
   do
    let visible=Task as task where task in targets and task.location==location
    require count(visible)==count(targets)
    return visible as task select Fact {task,version=task.version,title=task.title,description=task.description,due=task.due,priority=task.priority,done=task.done}
 Then
"#;

fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()
}
fn checked() -> (SourceDb, CheckedProgram, IrProgram, Option<Catalog>) {
    checked_source(SOURCE)
}
fn checked_source(source: &str) -> (SourceDb, CheckedProgram, IrProgram, Option<Catalog>) {
    let mut db = SourceDb::new();
    let file = db.add("query-sources.can".into(), source.into());
    let path = root().join("packages/values/dist/catalog.json");
    let (catalog, ds) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(ds.is_empty(), "{ds:?}");
    let (program, ds) = check_program(&db, &[file], catalog.as_ref());
    assert!(ds.is_empty(), "{ds:?}");
    let (ir, ds) = ir::build(&program, &db, catalog.as_ref());
    assert!(ds.is_empty(), "{ds:?}");
    (db, program, ir, catalog)
}

fn complete_plan(
    db: &SourceDb,
    program: &CheckedProgram,
    ir: &IrProgram,
    catalog: Option<&Catalog>,
) -> Option<Value> {
    let owner = ir
        .items
        .iter()
        .find(|item| item.canonical == "workbench.context")
        .unwrap();
    serialize_complete_query_receipt(
        program,
        ir,
        owner,
        db,
        catalog,
        "$can$m$5175657279536f7572636573.mjs",
    )
}

#[test]
fn complete_query_recipe_matches_real_published_disclosure_and_state_schema() {
    let source = SOURCE.replace(
        "require active_member(actor,team)",
        "require count(targets)>0",
    );
    let (db, program, ir, catalog) = checked_source(&source);
    let produced =
        complete_plan(&db, &program, &ir, catalog.as_ref()).expect("whole checked query closure");
    assert_eq!(
        Some(produced.clone()),
        plan(&db, &program, &ir, catalog.as_ref())
    );
    let mut result =
        canlang_compiler::diagnostic::DiagnosticResult::new("complete-query-source", "1.0", 1);
    result.complete = true;
    let (artifact, diagnostics) = canlang_compiler::codegen::emit(
        &program,
        &canlang_compiler::codegen::EmitSources {
            db: &db,
            result: &result,
            catalog: catalog.as_ref(),
            options: canlang_compiler::codegen::EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let artifact: Value =
        serde_json::from_str(&canlang_compiler::codegen::artifact::to_json(&artifact)).unwrap();
    let operation = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == "workbench.context")
        .unwrap();
    assert_eq!(operation["result"]["disclosure"], produced);
    let module = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(module.contains("canScenarioQuerySources"));
    for helper in [
        "executeScenarioReceiptQuery",
        "observeScenarioReceiptQueryDependency",
        "bindScenarioReceiptQueryResult",
        "selectScenarioReceiptReturn",
    ] {
        assert!(
            module.contains(helper),
            "prepared publication omitted {helper}"
        );
    }
    assert_eq!(
        module.matches("selectScenarioReceiptReturn(c,").count(),
        1,
        "one authored return must select its capture exactly once"
    );
    let scratch = tempfile::tempdir().unwrap();
    let artifact_path = scratch.path().join("artifact.json");
    let recipe_path = scratch.path().join("receipt.json");
    let runner = scratch.path().join("complete-query-schema.mjs");
    std::fs::write(&artifact_path, serde_json::to_vec(&artifact).unwrap()).unwrap();
    std::fs::write(&recipe_path, serde_json::to_vec(&produced).unwrap()).unwrap();
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(resolve(process.argv[2],'packages/cloudflare/package.json'));
const artifact=JSON.parse(readFileSync(process.argv[3],'utf8'));
const produced=JSON.parse(readFileSync(process.argv[4],'utf8'));
const {loadArtifactDescriptors}=await import(pathToFileURL(require.resolve('@canlang/state/invocation/registry')));
const state=dirname(require.resolve('@canlang/state'));
const {checkScenarioResultDisclosurePlan}=await import(pathToFileURL(resolve(state,'invocation/scenario-receipt.js')));
const {checkQueryInventory}=await import(pathToFileURL(resolve(state,'invocation/scenario-query-plan.js')));
const loaded=loadArtifactDescriptors(artifact,{by:{role:'members'}});
const checked=checkScenarioResultDisclosurePlan(produced);
checkQueryInventory(checked,'workbench.Fact[]',artifact.models,loaded.valueSchema);
assert.deepEqual(checked,produced);
assert.equal(checked.returns.length,1);
assert.equal(checked.returns[0].influences.length,4);
assert.equal(checked.returns[0].projection.fields.length,7);
assert.deepEqual(artifact.operations.find(operation=>operation.name==='workbench.context').result.disclosure,produced);
"#).unwrap();
    let consumed = Command::new("node")
        .arg(runner)
        .arg(root())
        .arg(artifact_path)
        .arg(recipe_path)
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
fn complete_query_recipe_requires_original_proof_and_fresh_executable_correspondence() {
    use canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure;
    let source = SOURCE.replace(
        "require active_member(actor,team)",
        "require count(targets)>0",
    );
    let (db, program, original, catalog) = checked_source(&source);
    let id = original
        .items
        .iter()
        .find(|item| item.canonical == "workbench.context")
        .unwrap()
        .id;
    assert!(complete_plan(&db, &program, &original, catalog.as_ref()).is_some());
    for corruption in 0..10 {
        let mut ir = original.clone();
        match corruption {
            0..=4 => {
                let ScenarioDisclosure::Complete(proof) =
                    ir.scenario_disclosures.get_mut(&id).unwrap()
                else {
                    panic!()
                };
                match corruption {
                    0 => proof.returns[0].influences.pop().map(|_| ()).unwrap(),
                    1 => proof.returns[0].id = "borrowed-return".into(),
                    2 => proof.returns[0].node = proof.node,
                    3 => proof.source.sha256 = "foreign-source".into(),
                    _ => proof.returns[0].source.module = "foreign-owner".into(),
                }
            }
            5 => {
                let IrItemKind::Scenario { guards, .. } = &mut ir.items[id.0 as usize].kind else {
                    panic!()
                };
                guards.clear();
            }
            6 => {
                let IrItemKind::Scenario { params, .. } = &mut ir.items[id.0 as usize].kind else {
                    panic!()
                };
                params.reverse();
            }
            7 => {
                let IrItemKind::Scenario { effects, .. } = &mut ir.items[id.0 as usize].kind else {
                    panic!()
                };
                let IrStmt::Return {
                    value: Some(value), ..
                } = &mut effects[2]
                else {
                    panic!()
                };
                let IrExpr::Query(query) = &mut value.expr else {
                    panic!()
                };
                query
                    .source
                    .as_mut()
                    .unwrap()
                    .projection
                    .as_mut()
                    .unwrap()
                    .fields
                    .swap(0, 1);
            }
            8 => {
                let IrItemKind::Scenario { effects, .. } = &mut ir.items[id.0 as usize].kind else {
                    panic!()
                };
                let IrStmt::Require { cond, .. } = &mut effects[1] else {
                    panic!()
                };
                cond.expr = IrExpr::Bool(true);
            }
            _ => {
                let (declined_db, declined_program, declined_ir, declined_catalog) = checked();
                let mut forged = declined_ir.clone();
                forged
                    .scenario_disclosures
                    .insert(id, original.scenario_disclosures[&id].clone());
                assert!(
                    complete_plan(
                        &declined_db,
                        &declined_program,
                        &forged,
                        declined_catalog.as_ref()
                    )
                    .is_none()
                );
                continue;
            }
        }
        assert!(
            complete_plan(&db, &program, &ir, catalog.as_ref()).is_none(),
            "corruption {corruption}"
        );
        if matches!(corruption, 5 | 8) {
            // A valid detached owner cannot conceal a changed indexed body.
            let detached = &original.items[id.0 as usize];
            for serialize in [serialize_query_sources, serialize_complete_query_receipt] {
                assert!(
                    serialize(
                        &program,
                        &ir,
                        detached,
                        &db,
                        catalog.as_ref(),
                        "$can$m$5175657279536f7572636573.mjs",
                    )
                    .is_none(),
                    "detached owner concealed corruption {corruption}"
                );
            }
        }
    }
    let (declined_db, declined_program, declined_ir, declined_catalog) = checked();
    assert!(
        complete_plan(
            &declined_db,
            &declined_program,
            &declined_ir,
            declined_catalog.as_ref()
        )
        .is_none()
    );
    let mut changed_db = db;
    changed_db.add(
        "query-sources.can".into(),
        source.replace("count(targets)>0", "count(targets)>1"),
    );
    assert!(complete_plan(&changed_db, &program, &original, catalog.as_ref()).is_none());
}
fn plan(
    db: &SourceDb,
    program: &CheckedProgram,
    ir: &IrProgram,
    catalog: Option<&Catalog>,
) -> Option<Value> {
    let owner = ir
        .items
        .iter()
        .find(|item| item.canonical == "workbench.context")
        .unwrap();
    serialize_query_sources(
        program,
        ir,
        owner,
        db,
        catalog,
        "$can$m$5175657279536f7572636573.mjs",
    )
}

#[test]
fn source_recipe_emits_and_matches_installed_state_owning_inventory() {
    // Retain the original three body statements verbatim; no literal result or
    // copied facts stand in for the source query. Whole application is unclaimed.
    let original = include_str!("../../draft/apps/CanWorkbench/CanWorkbench.can");
    for line in SOURCE.lines().filter(|line| {
        line.starts_with("    let visible=")
            || line.starts_with("    require count(visible)")
            || line.starts_with("    return visible")
    }) {
        assert!(original.lines().any(|authored| authored == line));
    }
    let (db, program, ir, catalog) = checked();
    let emitted = plan(&db, &program, &ir, catalog.as_ref()).expect("genuine checked source plan");
    assert_eq!(emitted["queries"][0]["model"], "todo.Task");
    assert_eq!(emitted["queries"][0]["order"], serde_json::json!([]));
    assert_eq!(emitted["queries"][0]["limit"], Value::Null);
    assert_eq!(emitted["queries"][0]["archived"], "exclude");
    let deps = emitted["queries"][0]["dependencies"].as_array().unwrap();
    assert_eq!(deps.len(), 6);
    assert_eq!(deps[0]["field"], "location");
    assert_eq!(deps[0]["role"], "control");
    assert_eq!(deps[0]["type"], "rent_catalog.Location?");
    assert_eq!(deps[4]["type"], "enum(low,normal,high)");
    assert_eq!(
        emitted["returns"][0]["influences"]
            .as_array()
            .unwrap()
            .len(),
        4
    );
    let fields = emitted["returns"][0]["projection"]["fields"]
        .as_array()
        .unwrap();
    assert_eq!(fields.len(), 7);
    assert_eq!(
        fields[0],
        serde_json::json!({"name":"task","kind":"reference"})
    );
    assert_eq!(
        fields[1],
        serde_json::json!({"name":"version","kind":"version"})
    );
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("query-sources.can");
    let artifact_path = scratch.path().join("artifact.json");
    std::fs::write(&source, SOURCE).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--format=json",
            "--native-scenario-receipts",
            "--catalog",
        ])
        .arg(root().join("packages/values/dist/catalog.json"))
        .arg(&source)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    // The original StateRead guard now has a sealed membership producer.
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let published: Value = serde_json::from_slice(&compiled.stdout).unwrap();
    assert!(
        published["modules"][0]["js"]
            .as_str()
            .unwrap()
            .contains("canMembershipSources")
    );
    let mut result =
        canlang_compiler::diagnostic::DiagnosticResult::new("query-source-test", "1.0", 1);
    result.complete = true;
    let (artifact, diags) = canlang_compiler::codegen::emit(
        &program,
        &canlang_compiler::codegen::EmitSources {
            db: &db,
            result: &result,
            catalog: catalog.as_ref(),
            options: canlang_compiler::codegen::EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    assert!(diags.is_empty(), "{diags:?}");
    let artifact: Value =
        serde_json::from_str(&canlang_compiler::codegen::artifact::to_json(&artifact)).unwrap();
    // Preserve the complete shipping descriptor representation for the runtime join.
    std::fs::write(&artifact_path, &compiled.stdout).unwrap();
    let module = artifact["modules"][0]["js"].as_str().unwrap();
    // Nongrant source data cannot enter a private runtime frame. In particular,
    // a source-only guarded read keeps its existing generic viewer query lowering.
    for helper in [
        "executeScenarioReceiptQuery",
        "bindScenarioReceiptQueryResult",
        "observeScenarioReceiptQueryDependency",
        "selectScenarioReceiptReturn",
    ] {
        assert!(
            !module.contains(helper),
            "nongrant source activated {helper}"
        );
    }
    for dependency in emitted["queries"][0]["dependencies"].as_array().unwrap() {
        assert!(module.contains(dependency["id"].as_str().unwrap()));
    }
    let (ordinary, ds) = canlang_compiler::codegen::emit(
        &program,
        &canlang_compiler::codegen::EmitSources {
            db: &db,
            result: &result,
            catalog: catalog.as_ref(),
            options: canlang_compiler::codegen::EmitOptions::new(),
        },
    );
    assert!(ds.is_empty(), "{ds:?}");
    assert!(!ordinary.modules[0].js.contains("canScenarioQuerySources"));
    assert!(
        !ordinary.modules[0]
            .js
            .contains("executeScenarioReceiptQuery")
    );
    let context = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|op| op["name"] == "workbench.context")
        .unwrap();
    assert!(
        context["result"].get("disclosure").is_none(),
        "source facts alone must not admit a complete query receipt"
    );
    let runner = scratch.path().join("query-consumer.mjs");
    std::fs::write(&runner,r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(resolve(process.argv[2],'package.json'));
const artifact=JSON.parse(readFileSync(process.argv[3],'utf8'));
const {loadArtifactDescriptors}=await import(pathToFileURL(require.resolve('@canlang/state/invocation/registry')));
const state=dirname(require.resolve('@canlang/state'));
const {checkScenarioResultDisclosurePlan}=await import(pathToFileURL(resolve(state,'invocation/scenario-receipt.js')));
const {checkQueryInventory}=await import(pathToFileURL(resolve(state,'invocation/scenario-query-plan.js')));
// Import the whole genuine assembled module, including the State-issued
// membership guard. Query inventory alone still grants no private DATA frame.
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules}=await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker}=await load('@canlang/cloudflare/worker/assembly');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const {FIXED_NOW,createMemoryIdentityStore,seedMember,makeIdentity,asModel,asId,makeRow,makeBatch}=await load('@canlang/state/testing/invocation/fixtures');
const stdlib=pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
const shim=resolve(dirname(process.argv[3]),'observed-stdlib.mjs');
writeFileSync(shim,`export * from ${JSON.stringify(stdlib)};
import {active_member as actualMember,records as actualRecords} from ${JSON.stringify(stdlib)};
export async function active_member(...args){
 if(globalThis.poisonMembership){delete globalThis.poisonMembership;try{await actualMember(...args.slice(0,3),{...args[3],source:{...args[3].source,sha256:'0'.repeat(64)}});}catch{}}
 const value=await actualMember(...args);globalThis.guardObserved=true;return value;}
export async function records(...args){const rows=await actualRecords(...args);if(globalThis.guardObserved&&globalThis.afterMembershipObservation)await globalThis.afterMembershipObservation();return rows;}`);
const asm=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:resolve(dirname(process.argv[3]),'modules'),
 stdlibUrl:pathToFileURL(shim).href,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const entry=await import(asm.moduleUrls[artifact.modules[0].path]);
const membership=entry.canMembershipSources()['workbench.context'];
assert.equal(membership.length,2);
assert.equal(membership[0].owner,'workbench.context');
assert.equal(membership[0].stage,'leading-require');
assert.deepEqual(membership[0].calls[0].target,{id:'active_member',kind:'builtin',overload:0});
assert.deepEqual(membership[0].calls[0].slots,[0,1]);
assert.deepEqual(membership[0].calls[0].arguments.map(argument=>argument.type),['user','Team']);
assert.equal(membership[0].source.sha256,artifact.sources[0].sha256);
assert.equal(membership[0].source.path,artifact.sources[0].path);
const copied=entry.canMembershipSources();copied['workbench.context'][0].owner='foreign.context';
assert.equal(entry.canMembershipSources()['workbench.context'][0].owner,'workbench.context');
assert.equal(typeof entry.canScenarioQuerySources,'function');
const recipes=entry.canScenarioQuerySources();
assert.deepEqual(Object.keys(recipes),['workbench.context']);
const produced=recipes['workbench.context'];
const checked=checkScenarioResultDisclosurePlan(produced);
assert.deepEqual(checked,produced);assert.ok(Object.isFrozen(checked));
const loaded=loadArtifactDescriptors(artifact,{by:{role:'members'}});
checkQueryInventory(checked,'workbench.Fact[]',artifact.models,loaded.valueSchema);
assert.equal(checked.source.module,artifact.modules[0].path);
assert.equal(checked.queries[0].source.path,process.argv[4]);
assert.equal(checked.queries[0].dependencies[0].type,'rent_catalog.Location?');
assert.equal(checked.queries[0].dependencies[4].type,'enum(low,normal,high)');
const names=checked.queries[0].dependencies.map(dep=>[dep.role,dep.field]);
assert.deepEqual(names,[['control','location'],['data','title'],['data','description'],['data','due'],['data','priority'],['data','done']]);
// Native query/authorization is not admitted by publishing source data.
assert.equal(artifact.operations.find(op=>op.name==='workbench.context').result.disclosure,undefined);
recipes['workbench.context'].queries[0].model='foreign.Task';
assert.equal(entry.canScenarioQuerySources()['workbench.context'].queries[0].model,'todo.Task');
const reject=value=>assert.throws(()=>{const plan=checkScenarioResultDisclosurePlan(value);checkQueryInventory(plan,'workbench.Fact[]',artifact.models,loaded.valueSchema);});
for(const alter of [
 p=>p.queries[0].model='foreign.Task',
 p=>p.queries[0].dependencies[0].type='text',
 p=>p.queries[0].dependencies=p.queries[0].dependencies.filter(d=>d.field!=='title'),
 p=>p.returns[0].projection.fields[0].kind='version',
 p=>p.returns[0].projection.fields.pop(),
 p=>p.returns[0].influences.pop(),
 p=>p.returns[0].influences[0].queryId='foreign',
 p=>p.queries[0].order=[{field:'done',direction:'desc'}],
]){const changed=structuredClone(checked);alter(changed);reject(changed);}
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const location=makeRow({id:asId('location'),data:{name:'Selected workplace'}});
const task=makeRow({id:asId('task'),data:{location:{id:location.id},title:'Original task',description:null,due:null,priority:'normal',done:false}});
await store.commit(makeBatch(await store.readRevision(),{writes:[
 {kind:'insert',model:asModel('rent_catalog.Location'),row:location},
 {kind:'insert',model:asModel('todo.Task'),row:task}]}));
const revision=await store.readRevision(),history=await store.historyFor(asModel('todo.Task'),task.id);
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
const request={operation:'workbench.context',inputs:{location:{id:location.id},targets:[{id:task.id}]}};
const outcome=await invoker.invokeRead(request,identity);
assert.ok('result'in outcome,JSON.stringify(outcome));
assert.deepEqual(outcome.result,{result:[{task:{id:task.id,version:String(task.version)},version:String(task.version),
 title:'Original task',description:null,due:null,priority:'normal',done:false}],revision});
globalThis.poisonMembership=true;
const poisoned=await invoker.invokeRead(request,identity);assert.ok('error'in poisoned,JSON.stringify(poisoned));assert.equal(poisoned.error.code,'validation');
assert.ok('result'in await invoker.invokeRead(request,identity),'poison cannot contaminate a separate fresh read lifetime');
const outsider=makeIdentity({userId:'outsider',team:member.team,membership:null});
const denied=await invoker.invokeRead(request,outsider);assert.ok('error'in denied);assert.equal(denied.error.code,'forbidden');
let observed=false;globalThis.guardObserved=false;
globalThis.afterMembershipObservation=async()=>{observed=true;delete globalThis.afterMembershipObservation;await memberships.removeMembership(member.membership.membership_id);};
const raced=await invoker.invokeRead(request,identity);assert.equal(observed,true);
assert.ok('error'in raced,JSON.stringify(raced));assert.equal(raced.error.code,'forbidden');
const revoked=await invoker.invokeRead(request,identity);assert.ok('error'in revoked);assert.equal(revoked.error.code,'forbidden');
assert.equal(await store.readRevision(),revision);
assert.deepEqual(await store.historyFor(asModel('todo.Task'),task.id),history);
assert.deepEqual(await store.outboxPending(),[]);
console.log('genuine guarded source query runs through installed State; source forgery, outsider and revoked membership refused');
"#).unwrap();
    let consumed = Command::new("node")
        .arg(runner)
        .arg(root())
        .arg(artifact_path)
        .arg(source)
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
fn source_transport_refuses_actual_ir_and_inventory_skew() {
    let (db, program, original, catalog) = checked();
    assert!(plan(&db, &program, &original, catalog.as_ref()).is_some());
    let id = original
        .items
        .iter()
        .find(|item| item.canonical == "workbench.context")
        .unwrap()
        .id;
    for corruption in 0..12 {
        let mut ir = original.clone();
        match corruption {
            0 => ir.items[id.0 as usize].canonical = "foreign.context".into(),
            1 => {
                let IrItemKind::Scenario { guards, .. } = &mut ir.items[id.0 as usize].kind else {
                    panic!()
                };
                guards.clear();
            }
            2 => {
                let IrItemKind::Scenario { effects, .. } = &mut ir.items[id.0 as usize].kind else {
                    panic!()
                };
                effects.swap(0, 1);
            }
            3 => {
                let IrItemKind::Scenario { effects, .. } = &mut ir.items[id.0 as usize].kind else {
                    panic!()
                };
                let IrStmt::Require { cond, .. } = &mut effects[1] else {
                    panic!()
                };
                cond.expr = IrExpr::Bool(true);
            }
            4 => {
                let IrItemKind::Scenario { effects, .. } = &mut ir.items[id.0 as usize].kind else {
                    panic!()
                };
                let IrStmt::Let { value, .. } = &mut effects[0] else {
                    panic!()
                };
                let IrExpr::Query(q) = &mut value.expr else {
                    panic!()
                };
                q.where_pred = None;
            }
            5 => {
                let IrItemKind::Scenario { effects, .. } = &mut ir.items[id.0 as usize].kind else {
                    panic!()
                };
                let IrStmt::Let { value, .. } = &mut effects[0] else {
                    panic!()
                };
                let IrExpr::Query(q) = &mut value.expr else {
                    panic!()
                };
                q.where_async = true;
            }
            6 => {
                let IrItemKind::Scenario { effects, .. } = &mut ir.items[id.0 as usize].kind else {
                    panic!()
                };
                let IrStmt::Return {
                    value: Some(value), ..
                } = &mut effects[2]
                else {
                    panic!()
                };
                let IrExpr::Query(q) = &mut value.expr else {
                    panic!()
                };
                q.select_param = Some("foreign".into());
            }
            7 => {
                let IrItemKind::Scenario { effects, .. } = &mut ir.items[id.0 as usize].kind else {
                    panic!()
                };
                let IrStmt::Return {
                    value: Some(value), ..
                } = &mut effects[2]
                else {
                    panic!()
                };
                let IrExpr::Query(q) = &mut value.expr else {
                    panic!()
                };
                let IrExpr::Object(fields) = &mut q.select.as_mut().unwrap().expr else {
                    panic!()
                };
                fields.pop();
            }
            8 => {
                let IrItemKind::Scenario { effects, .. } = &mut ir.items[id.0 as usize].kind else {
                    panic!()
                };
                let IrStmt::Return {
                    value: Some(value), ..
                } = &mut effects[2]
                else {
                    panic!()
                };
                let IrExpr::Query(q) = &mut value.expr else {
                    panic!()
                };
                q.source
                    .as_mut()
                    .unwrap()
                    .projection
                    .as_mut()
                    .unwrap()
                    .fields
                    .swap(0, 1);
            }
            9 => {
                let item = ir
                    .items
                    .iter_mut()
                    .find(|item| item.canonical == "todo.Task.location")
                    .unwrap();
                let IrItemKind::Field { ty, .. } = &mut item.kind else {
                    panic!()
                };
                *ty = ir::IrType::Known(canlang_compiler::analysis::ResolvedType::Scalar(
                    canlang_compiler::analysis::Scalar::Text,
                ));
            }
            10 => {
                let item = ir
                    .items
                    .iter_mut()
                    .find(|item| item.canonical == "workbench.Fact.task")
                    .unwrap();
                let IrItemKind::Field { owner, .. } = &mut item.kind else {
                    panic!()
                };
                *owner = id;
            }
            _ => {
                let fact = ir.scenario_disclosures.get_mut(&id).unwrap();
                let canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure::Declined(
                    fact,
                ) = fact
                else {
                    panic!()
                };
                fact.source_facts
                    .as_mut()
                    .unwrap()
                    .queries
                    .as_mut()
                    .unwrap()[0]
                    .dependencies
                    .clear();
            }
        }
        // Corruption 0 changes the lookup name; feed the actual indexed owner.
        assert!(
            serialize_query_sources(
                &program,
                &ir,
                &ir.items[id.0 as usize],
                &db,
                catalog.as_ref(),
                "entry.mjs"
            )
            .is_none(),
            "corruption {corruption}"
        );
    }
}

#[test]
fn source_sealed_first_helper_uses_current_viewer_grants() {
    let source = r#"app HelperFirst
Given
 Slot {at:datetime,label:text,hidden:bool=false}
 policy Slot read=members where=not row.hidden fields=at,label,hidden
 export derive closest(cut:datetime):Slot? = first(Slot as item where item.at<=cut order=-item.at)
When
 scenario pick(cut:datetime) read=true -> Slot? by=members
  do return closest(cut)
Then
"#;
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("helper-first.can");
    let artifact_path = scratch.path().join("artifact.json");
    std::fs::write(&input, source).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--format=json",
            "--native-scenario-receipts",
            "--catalog",
        ])
        .arg(root().join("packages/values/dist/catalog.json"))
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
    std::fs::write(&artifact_path, compiled.stdout).unwrap();
    let runner = scratch.path().join("consumer.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(resolve(process.argv[2],'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const artifact=JSON.parse(readFileSync(process.argv[3],'utf8'));
const {assembleModules}=await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker}=await load('@canlang/cloudflare/worker/assembly');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const {FIXED_NOW,createMemoryIdentityStore,seedMember,makeIdentity,asModel,asId,makeRow,makeBatch}=await load('@canlang/state/testing/invocation/fixtures');
const asm=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:resolve(dirname(process.argv[3]),'modules'),
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const rows=[['older','2031-01-01T00:00:00.000Z',false],['selected','2031-01-02T00:00:00.000Z',false],['hidden','2031-01-03T00:00:00.000Z',true]]
 .map(([id,at,hidden])=>makeRow({id:asId(id),data:{at,label:id,hidden}}));
await store.commit(makeBatch(await store.readRevision(),{writes:rows.map(row=>({kind:'insert',model:asModel('HelperFirst.Slot'),row}))}));
const revision=await store.readRevision(),history=await Promise.all(rows.map(row=>store.historyFor(asModel('HelperFirst.Slot'),row.id)));
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
const request={operation:'HelperFirst.pick',inputs:{cut:'2031-01-04T00:00:00.000Z'}};
const actual=await invoker.invokeRead(request,identity);assert.ok('result'in actual,JSON.stringify(actual));
assert.deepEqual(actual.result,{result:{id:'selected',version:'1'},revision},'FIRST order retains current viewer policy rather than hidden owner rows');
const absent=await invoker.invokeRead({...request,inputs:{cut:'1900-01-01T00:00:00.000Z'}},identity);
assert.ok('result'in absent,JSON.stringify(absent));assert.deepEqual(absent.result,{result:null,revision});
const outsider=makeIdentity({userId:'outsider',team:member.team,membership:null});
for(const who of [outsider]){const denied=await invoker.invokeRead(request,who);assert.ok('error'in denied);assert.equal(denied.error.code,'forbidden');}
await memberships.removeMembership(member.membership.membership_id);
const revoked=await invoker.invokeRead(request,identity);assert.ok('error'in revoked);assert.equal(revoked.error.code,'forbidden');
assert.equal(await store.readRevision(),revision);assert.deepEqual(await store.outboxPending(),[]);
assert.deepEqual(await Promise.all(rows.map(row=>store.historyFor(asModel('HelperFirst.Slot'),row.id))),history);
"#).unwrap();
    let consumed = Command::new("node")
        .arg(runner)
        .arg(root())
        .arg(artifact_path)
        .arg(input)
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
fn public_scalar_query_body_keeps_projection_grants_and_finalization_fence() {
    let source = r#"app ScalarQuery
Given
 Root {enabled:bool=true,currency:currency,total:money}
 Item in Root {price:money,quantity:int,tax:money,discount:money,visible:bool=true}
 policy Root read=members fields=enabled,currency,total
 policy Item read=members where=row.visible fields=price,quantity,tax,discount
When
 scenario summarize(root:Root) by=members
  require root.enabled
  do set root {total=sum(root.Item as item select item.price*item.quantity+item.tax-item.discount,root.currency)}
Then
"#;
    assert!(
        include_str!("../../draft/apps/CanPropose/CanPropose.can")
            .contains("item.price*item.quantity+item.tax-item.discount")
    );
    let contract_source = source.replace(" Root {enabled:bool=true,currency:currency,total:money}",
        " contract QuotedLine {amount:money}\n Root {enabled:bool=true,currency:currency,total:money,lines:QuotedLine[]}")
        .replace("total=sum(root.Item as item select item.price*item.quantity+item.tax-item.discount,root.currency)",
            "lines=root.Item as item select QuotedLine {amount=item.price*item.quantity+item.tax-item.discount}");
    let let_source = contract_source
        .replace("lines:QuotedLine[]}", "lines:QuotedLine[],multiplier:int=1}")
        .replace("fields=enabled,currency,total", "fields=enabled,currency,total,multiplier")
        .replace("  do set root {lines=", "  do\n   let lines=")
        .replace("item.price*item.quantity+item.tax-item.discount}}", "item.price*item.quantity*root.multiplier+item.tax-item.discount}")
        .replace("\nThen", "\n   require count(lines)>0 and all(lines as line,line.amount.minor>0)\n   let first_line=at(lines,0)\n   require first_line!=null\n   set root {lines}\nThen");
    let empty_source = let_source
        .replace(
            "fields=enabled,currency,total,multiplier",
            "fields=enabled,currency,total",
        )
        .replace(
            "   require count(lines)>0 and all(lines as line,line.amount.minor>0)\n",
            "",
        )
        .replace("   require first_line!=null\n", "");
    let created_source = let_source
        .replace(
            " Item in Root",
            " Snapshot in Root {total:money,label:text=\"saved\",lines:QuotedLine[]}\n Item in Root",
        )
        .replace(
            " policy Item",
            " policy Snapshot read=members fields=total,label,lines\n policy Item",
        )
        .replace(
            "scenario summarize(root:Root) by=members",
            "scenario summarize(root:Root) -> Snapshot by=members",
        )
        .replace(
            "set root {lines}",
            "create Snapshot {parent=root,total=first_line.amount,lines} as snapshot\n   return snapshot",
        );
    let scratch = tempfile::tempdir().unwrap();
    for (mode, source) in [
        ("allowed", source.to_owned()),
        ("contract", contract_source.clone()),
        ("let-values", let_source.clone()),
        ("let-empty", empty_source),
        ("let-created", created_source.clone()),
        (
            "let-created-withheld",
            created_source.replace(
                "fields=price,quantity,tax,discount",
                "fields=price,quantity,discount",
            ),
        ),
        (
            "let-created-return-withheld",
            created_source.replace(
                "policy Snapshot read=members fields=total,label",
                "policy Snapshot read=members fields=label",
            ),
        ),
        (
            "let-created-result-hidden",
            created_source.replace(
                "policy Snapshot read=members fields=",
                "policy Snapshot read=members where=false fields=",
            ),
        ),
        (
            "let-member",
            let_source.replace(
                "set root {lines}",
                "set root {lines,total=first_line.amount}",
            ),
        ),
        (
            "let-member-withheld",
            let_source
                .replace(
                    "set root {lines}",
                    "set root {lines,total=first_line.amount}",
                )
                .replace(
                    "fields=price,quantity,tax,discount",
                    "fields=price,quantity,discount",
                ),
        ),
        (
            "let-withheld",
            let_source.replace(
                "fields=price,quantity,tax,discount",
                "fields=price,quantity,discount",
            ),
        ),
        (
            "let-root-withheld",
            let_source.replace(
                "fields=enabled,currency,total,multiplier",
                "fields=enabled,currency,total",
            ),
        ),
        (
            "contract-withheld",
            contract_source.replace(
                "fields=price,quantity,tax,discount",
                "fields=price,quantity,discount",
            ),
        ),
        (
            "projection-withheld",
            source.replace(
                "fields=price,quantity,tax,discount",
                "fields=price,quantity,discount",
            ),
        ),
        (
            "currency-withheld",
            source.replace("fields=enabled,currency,total", "fields=enabled,total"),
        ),
    ] {
        let input = scratch.path().join(format!("{mode}.can"));
        std::fs::write(&input, source).unwrap();
        let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
            .args([
                "compile",
                "--format=json",
                "--native-scenario-receipts",
                "--catalog",
            ])
            .arg(root().join("packages/values/dist/catalog.json"))
            .arg(&input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        assert!(
            compiled.status.success(),
            "{mode}: {}\n{}",
            String::from_utf8_lossy(&compiled.stdout),
            String::from_utf8_lossy(&compiled.stderr)
        );
        if matches!(
            mode,
            "let-values" | "let-empty" | "let-member" | "let-created"
        ) {
            let artifact: serde_json::Value = serde_json::from_slice(&compiled.stdout).unwrap();
            let operation = artifact["operations"]
                .as_array()
                .unwrap()
                .iter()
                .find(|operation| operation["name"] == "ScalarQuery.summarize")
                .unwrap();
            assert!(
                operation["result"]["disclosure"]["queries"]
                    .as_array()
                    .is_some_and(|queries| !queries.is_empty()),
                "computed Values LET must retain its actual complete native query receipt: {operation}"
            );
        }
        std::fs::write(scratch.path().join(format!("{mode}.json")), compiled.stdout).unwrap();
    }
    let postwrite = scratch.path().join("postwrite.can");
    std::fs::write(
        &postwrite,
        source.replace(
            "  do set root {",
            "  do\n   set root {enabled=true}\n   set root {",
        ),
    )
    .unwrap();
    let refused = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--format=json",
            "--native-scenario-receipts",
            "--catalog",
        ])
        .arg(root().join("packages/values/dist/catalog.json"))
        .arg(postwrite)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert_eq!(
        refused.status.code(),
        Some(10),
        "{}\n{}",
        String::from_utf8_lossy(&refused.stdout),
        String::from_utf8_lossy(&refused.stderr)
    );
    let refusal: serde_json::Value = serde_json::from_slice(&refused.stdout).unwrap();
    assert!(
        refusal["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E6008"),
        "post-write queries require State provisional provenance: {refusal}"
    );
    // A decision-only source frame carries no result DATA provenance. The
    // original query must not make a withheld stored field returnable through
    // the ordinary parameter view after an otherwise authorized mutation.
    let withheld_return = scratch.path().join("withheld-return.can");
    std::fs::write(
        &withheld_return,
        source
            .replace("total:money}", "total:money,hidden:text}")
            .replace(
                "scenario summarize(root:Root) by=members",
                "scenario summarize(root:Root) -> text by=members",
            )
            .replace("  do set root {", "  do\n   set root {")
            .replace("\nThen", "\n   return root.hidden\nThen"),
    )
    .unwrap();
    let refused = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--format=json",
            "--native-scenario-receipts",
            "--catalog",
        ])
        .arg(root().join("packages/values/dist/catalog.json"))
        .arg(withheld_return)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert_eq!(
        refused.status.code(),
        Some(10),
        "withheld stored result needs its own complete receipt: {}\n{}",
        String::from_utf8_lossy(&refused.stdout),
        String::from_utf8_lossy(&refused.stderr)
    );
    let refusal: serde_json::Value = serde_json::from_slice(&refused.stdout).unwrap();
    assert!(
        refusal["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E6008"),
        "source-only guard cannot authorize withheld result DATA: {refusal}"
    );
    let runner = scratch.path().join("consumer.mjs");
    std::fs::write(&runner,r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(resolve(process.argv[2],'package.json')),base=dirname(process.argv[1]);
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules}=await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker}=await load('@canlang/cloudflare/worker/assembly');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const {FIXED_NOW,createMemoryIdentityStore,seedMember,makeIdentity,asModel,asId,asVersion,makeRow,makeBatch,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
function alterValueMetadata(artifact,mode){
 const plan=artifact.operations.find(operation=>operation.name==='ScalarQuery.summarize').result.disclosure;
 const query=plan.queries.find(query=>query.dependencies.some(dependency=>dependency.field==='price'));
 let changed=0;
 const alter=value=>{
  if(value===null||typeof value!=='object')return;
  if(value.receiptQueryId===query.id){
   if(mode==='forge-pair-swapped'){
    const price=query.dependencies.find(dependency=>dependency.field==='price'),tax=query.dependencies.find(dependency=>dependency.field==='tax');
    assert.equal(price.type,tax.type);
    for(const pair of value.receiptDependencies){if(pair.queryDependencyId===price.id)pair.queryDependencyId=tax.id;else if(pair.queryDependencyId===tax.id)pair.queryDependencyId=price.id;}
   }else if(mode==='forge-pair-duplicate')value.receiptDependencies.push({...value.receiptDependencies[0]});
   else if(mode==='forge-pair-missing')value.receiptDependencies.pop();
   else if(mode==='forge-cases-swapped'||mode==='forge-model-cases-swapped')[value.receiptCases.empty,value.receiptCases.nonempty]=[value.receiptCases.nonempty,value.receiptCases.empty];
   changed++;
  }
  for(const child of Object.values(value))alter(child);
 };
 for(const module of artifact.modules){
  if(mode==='forge-unissued-capture'){
   const before='function $can$query$value$issue(source,context,body,captures){';
   if(module.js.includes(before)){module.js=module.js.replace(before,before+'if(captures!==undefined)return async()=>{globalThis.__unissuedPureCalls++;return body();};');changed++;}
  }else module.js=module.js.replace(/"(?:[^"\\]|\\.)*"/g,literal=>{
   try{const text=JSON.parse(literal);if(typeof text!=='string')return literal;
    const value=JSON.parse(text),before=changed;alter(value);return changed===before?literal:JSON.stringify(JSON.stringify(value));
   }catch{return literal;}
  });
 }
 assert.ok(changed>=(mode==='forge-unissued-capture'?1:2),mode+': actual inventory and private callback descriptors both changed');
}
for(const mode of ['allowed','projection-withheld','currency-withheld','hidden','finalization-race','contract','contract-withheld','let-values','let-withheld','let-root-withheld','let-race','let-empty','let-member','let-member-withheld','let-created','let-created-withheld','let-created-return-withheld','let-created-result-hidden','let-created-empty','forge-model-cases-swapped','forge-pair-swapped','forge-pair-duplicate','forge-pair-missing','forge-cases-swapped','forge-unissued-capture']){
 const forged=mode.startsWith('forge-'),valuesMode=forged||mode.startsWith('let-');
 const variant=mode==='forge-model-cases-swapped'||mode==='let-created-empty'?'let-created':forged?'let-values':mode==='let-race'?'let-values':mode==='hidden'||mode==='finalization-race'?'allowed':mode;
 const artifact=JSON.parse(readFileSync(resolve(base,variant+'.json'),'utf8'));
 if(forged){globalThis.__unissuedPureCalls=0;alterValueMetadata(artifact,mode);}
 const asm=await assembleModules({artifact,sourcePath:resolve(base,variant+'.can')},{workDir:resolve(base,mode),
  stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
 const {store:backing}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
 const member=await seedMember(memberships,{isOwner:false}),identity=makeIdentity({membership:member.membership,email:member.user.email});
 const root={...makeRow({id:asId('root'),data:{enabled:true,currency:'EUR',total:{minor:'0',currency:'EUR'},...(valuesMode?{lines:[],multiplier:'1'}:mode.startsWith('contract')?{lines:[]}: {})}}),parent:null};
 const item={...makeRow({id:asId('item'),data:{price:{minor:'100',currency:'EUR'},quantity:'2',tax:{minor:'5',currency:'EUR'},discount:{minor:'3',currency:'EUR'},visible:mode!=='hidden'&&mode!=='let-empty'}}),parent:{model:asModel('ScalarQuery.Root'),id:root.id}};
 await backing.commit(makeBatch(await backing.readRevision(),{writes:[{kind:'insert',model:asModel('ScalarQuery.Root'),row:root},...(mode==='let-created-empty'?[]:[{kind:'insert',model:asModel('ScalarQuery.Item'),row:item},...(valuesMode?[{kind:'insert',model:asModel('ScalarQuery.Item'),row:{...item,id:asId('item-2')}}]:[])])]}));
 const history=await backing.historyFor(asModel('ScalarQuery.Root'),root.id);let raced=false;
 const store={...backing,commit:async batch=>{
  if(mode==='finalization-race'&&!raced&&batch.writes.some(write=>write.model==='ScalarQuery.Root')){
   raced=true;await backing.commit(makeBatch(await backing.readRevision(),{writes:[{kind:'update',model:asModel('ScalarQuery.Item'),id:item.id,expectedVersion:item.version,
    row:{...item,version:asVersion(item.version+1),data:{...item.data,price:{minor:'900',currency:'EUR'}}}}]}));
  }
  if(mode==='let-race'&&!raced&&batch.writes.some(write=>write.model==='ScalarQuery.Root')){raced=true;await backing.commit(makeBatch(await backing.readRevision(),{writes:[{kind:'update',model:asModel('ScalarQuery.Item'),id:item.id,expectedVersion:item.version,row:{...item,version:asVersion(item.version+1),data:{...item.data,price:{minor:'900',currency:'EUR'}}}}]}));}
  return backing.commit(batch);
 }};
 let outcome,failure,invoker;
 try{invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
  outcome=await invoker.invokeMutation({operation:'ScalarQuery.summarize',operation_id:uuidv7(FIXED_NOW,1),inputs:{root:{id:root.id,version:String(root.version)}}},identity);
 }catch(error){failure=error;}
 if(forged){
  assert.ok(failure!==undefined||outcome?.error!==undefined,mode+': forged source must refuse');
  const message=String(failure?.message??outcome.error.message);
  assert.match(message,mode==='forge-model-cases-swapped'?/Model query empty return lacks its exact original Values case producer/:mode==='forge-cases-swapped'?/actual original Values query empty\/nonempty case/:mode==='forge-unissued-capture'?/Local owner policy requires plain owning metadata/:/DATA pair/i,mode+': '+message);
  assert.deepEqual(await backing.load(asModel('ScalarQuery.Root'),root.id),root);
  assert.deepEqual(await backing.load(asModel('ScalarQuery.Item'),item.id),item);
  assert.deepEqual(await backing.load(asModel('ScalarQuery.Item'),asId('item-2')),{...item,id:asId('item-2')});
  assert.deepEqual(await backing.historyFor(asModel('ScalarQuery.Root'),root.id),history);
  assert.deepEqual(await backing.outboxPending(),[]);
  assert.equal(globalThis.__unissuedPureCalls,0,'unissued pure closure must never execute');
  if(mode==='forge-model-cases-swapped')assert.deepEqual(await backing.query({model:asModel('ScalarQuery.Snapshot'),authority:'owner'}),[]);
  continue;
 }
 if(failure!==undefined)throw failure;
 if(mode.startsWith('let-created')){
  const rows=await backing.query({model:asModel('ScalarQuery.Snapshot'),authority:'owner'});
  const current=await backing.load(asModel('ScalarQuery.Root'),root.id);
  if(mode==='let-created'||mode==='let-created-return-withheld'){
   assert.ok('result'in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'committed');
   assert.equal(rows.length,1);assert.deepEqual(rows[0].data,{total:{minor:'202',currency:'EUR'},label:'saved',lines:[{amount:{minor:'202',currency:'EUR'}},{amount:{minor:'202',currency:'EUR'}}]});
   assert.deepEqual(outcome.result.result,{id:rows[0].id});assert.equal(outcome.result.records.length,1);assert.deepEqual(outcome.result.records[0].data,mode==='let-created'?{total:{minor:'202',currency:'EUR'},label:'saved'}:{label:'saved'});assert.equal(Object.hasOwn(outcome.result.records[0].data,'lines'),false);
   const replay=await invoker.invokeMutation({operation:'ScalarQuery.summarize',operation_id:uuidv7(FIXED_NOW,1),inputs:{root:{id:root.id,version:String(root.version)}}},identity);
   assert.ok('result'in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');assert.deepEqual(replay.result.result,outcome.result.result);
   assert.deepEqual(await backing.query({model:asModel('ScalarQuery.Snapshot'),authority:'owner'}),rows);
  }else{assert.ok('error'in outcome,JSON.stringify(outcome));assert.equal(outcome.error.code,mode==='let-created-empty'?'rule_failed':'forbidden');assert.deepEqual(rows,[]);if(mode==='let-created-empty')assert.deepEqual(await backing.query({model:asModel('ScalarQuery.Item'),authority:'owner'}),[]);}
  assert.deepEqual(current,root);assert.deepEqual(await backing.historyFor(asModel('ScalarQuery.Root'),root.id),history);assert.deepEqual(await backing.outboxPending(),[]);
  continue;
 }
 const success=mode==='allowed'||mode==='hidden'||mode==='contract'||mode==='finalization-race'||mode==='let-values'||mode==='let-race'||mode==='let-empty'||mode==='let-member',current=await backing.load(asModel('ScalarQuery.Root'),root.id);
 assert.ok(current);assert.equal('result'in outcome,success,mode+': '+JSON.stringify(outcome));
 if(success){assert.equal(outcome.result.status,'committed');if(mode==='let-empty'){assert.deepEqual(current.data.lines,[]);assert.deepEqual(current.data.total,root.data.total);}else if(mode==='let-values'||mode==='let-race'||mode==='let-member'){assert.deepEqual(current.data.lines,[{amount:{minor:mode==='let-race'?'1802':'202',currency:'EUR'}},{amount:{minor:'202',currency:'EUR'}}]);assert.deepEqual(current.data.total,mode==='let-member'?{minor:'202',currency:'EUR'}:root.data.total);}else if(mode==='contract'){assert.deepEqual(current.data.lines,[{amount:{minor:'202',currency:'EUR'}}]);assert.deepEqual(current.data.total,root.data.total);}else assert.deepEqual(current.data.total,{minor:mode==='hidden'?'0':mode==='finalization-race'?'1802':'202',currency:'EUR'});assert.equal(current.version,root.version+1);}
 else{assert.equal(outcome.error.code,mode==='finalization-race'?'conflict':'forbidden');assert.deepEqual(current,root);assert.deepEqual(await backing.historyFor(asModel('ScalarQuery.Root'),root.id),history);}
 assert.deepEqual(await backing.outboxPending(),[]);if(mode==='finalization-race'){assert.equal(raced,true);const completed=await backing.historyFor(asModel('ScalarQuery.Root'),root.id);assert.equal(completed.length,history.length+1);assert.deepEqual(completed.at(-1).after.total,{minor:'1802',currency:'EUR'});assert.ok(completed.every(entry=>entry.after?.total?.minor!=='202'),'retry must publish only the fresh aggregate');}
}
"#).unwrap();
    let consumed = Command::new("node")
        .arg(runner)
        .arg(root())
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
fn source_guard_plain_collections_preserve_global_alias_lineage_and_fences() {
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("guard.can");
    std::fs::write(&input, r#"app GuardValues
Given
 contract Window {from:datetime,until:datetime}
 Root {enabled:bool=true,anchor:datetime,until:datetime,windows:Window[]}
 Span in Root {from:datetime,until:datetime,visible:bool=true,tone:enum(day,night)=day}
 Rule {enabled:bool=true,visible:bool=true,units:int=1}
 policy Rule read=members where=row.visible
 policy Root read=members fields=enabled,anchor,until
 policy Span read=members where=row.visible
 derive eligible(span:Span):bool=format("{tone}",{tone=span.tone})!="" and any(span.parent.Span as sibling,sibling.from==span.from)
 derive covered(root:Root):bool = all(Rule as rule,rule.enabled) and all([root.anchor]+flatten(root.Span as item select [item.from,item.until]) as instant,instant<root.anchor or instant>=root.until or count(Span as item where item.parent==root and eligible(item) and item.from<=instant and instant<item.until)>0)
When
 scenario confirm(root:Root) by=members
  require root.enabled
  require any(root.windows as interval,interval.from<=root.anchor and root.until<=interval.until)
  require sum(Rule as quota select quota.units)<=1
  do
   require covered(root)
   set root {enabled=false}
Then
"#).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--format=json",
            "--native-scenario-receipts",
            "--catalog",
        ])
        .arg(root().join("packages/values/dist/catalog.json"))
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
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let runner = scratch.path().join("consumer.mjs");
    std::fs::write(&runner, r#"import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const require=createRequire(process.argv[2]+'/package.json');
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules}=await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker}=await load('@canlang/cloudflare/worker/assembly');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const {FIXED_NOW,createMemoryIdentityStore,seedMember,makeIdentity,asModel,asId,asVersion,makeRow,makeBatch,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const artifact=JSON.parse(readFileSync(process.argv[4],'utf8'));
const asm=await assembleModules({artifact,sourcePath:process.argv[3]},{workDir:process.argv[5],stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
for(const mode of ['allowed','hidden','empty','race','nonmember','no_rules','hidden_bad_rule','rule_race','hidden_excess','sum_race','no_window','window_race']){
 const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
 const member=await seedMember(memberships,{isOwner:false}),identity=makeIdentity({membership:member.membership,email:member.user.email});
 const root={...makeRow({id:asId('root'),data:{enabled:true,anchor:'2031-01-01T00:00:00.000Z',until:'2031-01-02T00:00:00.000Z',windows:mode==='no_window'?[]:[{from:'2031-01-01T00:00:00.000Z',until:'2031-01-02T00:00:00.000Z'}]}}),parent:null};
 const span={...makeRow({id:asId('span'),data:{from:root.data.anchor,until:root.data.until,visible:mode!=='hidden',tone:'day'}}),parent:{model:asModel('GuardValues.Root'),id:root.id}};
 await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:asModel('GuardValues.Root'),row:root},...(mode==='empty'?[]:[{kind:'insert',model:asModel('GuardValues.Span'),row:span}])]}));
 const rule={...makeRow({id:asId('rule'),data:{enabled:mode!=='hidden_bad_rule',visible:!['hidden_bad_rule','hidden_excess'].includes(mode),units:mode==='hidden_excess'?'2':'1'}}),parent:null};
 if(mode!=='no_rules')await store.commit(makeBatch(await store.readRevision(),{writes:[{kind:'insert',model:asModel('GuardValues.Rule'),row:rule}]}));
 const commit=store.commit.bind(store);let raced=false;
 store.commit=async batch=>{
  if(mode==='race'&&!raced&&batch.writes.some(write=>write.model==='GuardValues.Root')){
   raced=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:asModel('GuardValues.Span'),id:span.id,expectedVersion:span.version,row:{...span,version:asVersion(span.version+1),data:{...span.data,until:span.data.from}}}]}));
  }
  if(mode==='rule_race'&&!raced&&batch.writes.some(write=>write.model==='GuardValues.Root')){
   raced=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:asModel('GuardValues.Rule'),id:rule.id,expectedVersion:rule.version,row:{...rule,version:asVersion(rule.version+1),data:{...rule.data,enabled:false}}}]}));
  }
  if(mode==='sum_race'&&!raced&&batch.writes.some(write=>write.model==='GuardValues.Root')){
   raced=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:asModel('GuardValues.Rule'),id:rule.id,expectedVersion:rule.version,row:{...rule,version:asVersion(rule.version+1),data:{...rule.data,units:'2'}}}]}));
  }
  if(mode==='window_race'&&!raced&&batch.writes.some(write=>write.model==='GuardValues.Root')){
   raced=true;await commit(makeBatch(await store.readRevision(),{writes:[{kind:'update',model:asModel('GuardValues.Root'),id:root.id,expectedVersion:root.version,row:{...root,version:asVersion(root.version+1),data:{...root.data,windows:[]}}}]}));
  }
  return commit(batch);
 };
 if(mode==='nonmember')await memberships.removeMembership(member.membership.membership_id);
 const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
 const request={operation:'GuardValues.confirm',operation_id:uuidv7(FIXED_NOW,1),inputs:{root:{id:root.id,version:'1'}}};
 const result=await invoker.invokeMutation(request,identity),success=mode==='allowed'||mode==='hidden'||mode==='no_rules';
 assert.equal('result'in result,success,mode+': '+JSON.stringify(result));
 const current=await store.load(asModel('GuardValues.Root'),root.id);assert.ok(current);assert.equal(current.data.enabled,!success);
 if(mode==='no_window')assert.deepEqual(current,root);
 if(mode==='window_race'){assert.deepEqual(current.data,{...root.data,windows:[]});assert.equal(current.version,root.version+1);}
 assert.deepEqual(await store.outboxPending(),[]);
 if(success){const revision=await store.readRevision();const replay=await invoker.invokeMutation(request,identity);assert.ok('result'in replay&&replay.result.status==='replayed');assert.equal(await store.readRevision(),revision);}
 if(mode==='race'||mode==='rule_race'||mode==='sum_race'||mode==='window_race')assert.equal(raced,true);
}
"#).unwrap();
    let consumed = Command::new("node")
        .arg(runner)
        .arg(root())
        .arg(input)
        .arg(artifact)
        .arg(scratch.path().join("modules"))
        .output()
        .unwrap();
    assert!(
        consumed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&consumed.stdout),
        String::from_utf8_lossy(&consumed.stderr)
    );
}
