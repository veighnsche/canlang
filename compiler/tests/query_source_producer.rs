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
    assert_eq!(deps[4]["type"], "todo.Task.priority");
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
    // The genuine membership producer remains catalog-external. Preserve its
    // shipping refusal; source transport must not silently make it available.
    assert!(!compiled.status.success());
    let refused: Value = serde_json::from_slice(&compiled.stdout).unwrap();
    assert!(
        refused["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["code"] == "E6007"
                && d["message"].as_str().unwrap().contains("active_member"))
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
    assert_eq!(diags.len(), 1, "{diags:?}");
    assert_eq!(diags[0].code, "E6007");
    let artifact: Value =
        serde_json::from_str(&canlang_compiler::codegen::artifact::to_json(&artifact)).unwrap();
    std::fs::write(&artifact_path, serde_json::to_vec(&artifact).unwrap()).unwrap();
    let module = artifact["modules"][0]["js"].as_str().unwrap();
    // Nongrant source data cannot enter a private runtime frame. In particular,
    // a declined read must keep its existing generic viewer query lowering.
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
    assert_eq!(ds.len(), 1);
    assert_eq!(ds[0].code, "E6007");
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
        "query facts must not admit the unqualified guard/profile"
    );
    let runner = scratch.path().join("query-consumer.mjs");
    std::fs::write(&runner,r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(resolve(process.argv[2],'package.json'));
const artifact=JSON.parse(readFileSync(process.argv[3],'utf8'));
const {loadArtifactDescriptors}=await import(pathToFileURL(require.resolve('@canlang/state/invocation/registry')));
const state=dirname(require.resolve('@canlang/state'));
const {checkScenarioResultDisclosurePlan}=await import(pathToFileURL(resolve(state,'invocation/scenario-receipt.js')));
const {checkQueryInventory}=await import(pathToFileURL(resolve(state,'invocation/scenario-query-plan.js')));
// Only the generated nongrant data export is executed. The membership guard
// remains unavailable and CLI publication refuses the complete module above.
const line=artifact.modules[0].js.split('\n').find(line=>line.startsWith('export function canScenarioQuerySources()'));
assert.ok(line);
const entry=await import('data:text/javascript,'+encodeURIComponent(line));
assert.equal(typeof entry.canScenarioQuerySources,'function');
const recipes=entry.canScenarioQuerySources();
assert.deepEqual(Object.keys(recipes),['workbench.context']);
const produced=recipes['workbench.context'];
const checked=checkScenarioResultDisclosurePlan(produced);
assert.deepEqual(checked,produced);assert.ok(Object.isFrozen(checked));
const loaded=loadArtifactDescriptors(artifact,{by:{role:'members'}});
checkQueryInventory(checked,'workbench.Fact[]',artifact.models,loaded.valueSchema);
assert.equal(checked.source.module,artifact.modules[0].path);
assert.equal(checked.queries[0].source.path,'query-sources.can');
assert.equal(checked.queries[0].dependencies[0].type,'rent_catalog.Location?');
assert.equal(checked.queries[0].dependencies[4].type,'todo.Task.priority');
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
console.log('emitted source query recipe accepted by actual installed State owning schema; tampered inventories refused');
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
