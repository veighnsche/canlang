//! Visibly bounded first(Budget ...) source plus the genuine native query
//! producer. Metadata/import checks grant no candidate, row or native authority.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::scenario_disclosure::ScenarioDisclosure;
use canlang_compiler::analysis::{CheckedProgram, ResolvedType, Scalar, check_program};
use canlang_compiler::codegen::ir::{
    self, IrCallTarget, IrExpr, IrItem, IrItemKind, IrProgram, IrStmt, IrType,
};
use canlang_compiler::codegen::js;
use canlang_compiler::codegen::scenario_queries::serialize_complete_query_receipt;
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str = include_str!("fixtures/native-first-budget.can");
const SOURCE_HASH: &str = "bf83e642141e4b827d02ae99e5388496d44ac3b3e87ad2c223a2fd4ec1ee2ac4";
const OWNER: &str = "FirstSources.generate";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn native_owner_root() -> PathBuf {
    let public = Path::new("/Users/vince/Projects/canlang");
    if public
        .join("packages/cloudflare/dist/native-catalog.json")
        .is_file()
    {
        public.into()
    } else {
        root()
    }
}

fn fixture() -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    fixture_at("native-first-budget.can")
}

fn fixture_at(path: &str) -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    assert_eq!(sha256_hex(SOURCE.as_bytes()), SOURCE_HASH);
    fixture_source(path, SOURCE)
}

fn fixture_source(path: &str, source: &str) -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add(path.into(), source.into());
    let path = native_owner_root().join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir, catalog)
}

fn item<'a>(ir: &'a IrProgram, canonical: &str) -> &'a IrItem {
    ir.items
        .iter()
        .find(|item| item.canonical == canonical)
        .unwrap()
}

fn prepared_artifact(
    program: &CheckedProgram,
    db: &SourceDb,
    catalog: &Catalog,
) -> (Value, Vec<Diagnostic>) {
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::codegen::artifact::to_json;
    let mut result = DiagnosticResult::new("first-query-source", "1.0", 1);
    result.add_sources(db);
    let (artifact, diagnostics) = emit(
        program,
        &EmitSources {
            db,
            result: &result,
            catalog: Some(catalog),
            options: EmitOptions {
                allow_incomplete_test_only: false,
                native_scenario_receipts: true,
            },
        },
    );
    (
        serde_json::from_str(&to_json(&artifact)).unwrap(),
        diagnostics,
    )
}

fn operation(artifact: &Value) -> &Value {
    artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == OWNER)
        .unwrap()
}

fn assert_plan(plan: &Value, path: &str, hash: &str, return_ids: &[&str]) {
    assert_eq!(plan["version"], 1);
    assert_eq!(plan["source"]["path"], path);
    assert_eq!(plan["source"]["sha256"], hash);
    let [query] = plan["queries"].as_array().unwrap().as_slice() else {
        panic!("one first query")
    };
    assert_eq!(query["model"], "FirstSources.Budget");
    assert_eq!(
        query["order"],
        serde_json::json!([{ "field": "id", "direction": "asc" }])
    );
    assert!(query["limit"].is_null());
    assert_eq!(query["archived"], "exclude");
    let [candidate] = query["dependencies"].as_array().unwrap().as_slice() else {
        panic!("one candidate account control")
    };
    assert_eq!(candidate["field"], "account");
    assert_eq!(candidate["type"], "user");
    assert_eq!(candidate["role"], "control");
    let returns = plan["returns"].as_array().unwrap();
    assert_eq!(
        returns
            .iter()
            .map(|value| value["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        return_ids
    );
    for returned in returns {
        assert_eq!(
            returned["influences"]
                .as_array()
                .unwrap()
                .iter()
                .map(|influence| influence["kind"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "query-existence",
                "query-cardinality",
                "query-membership",
                "query-order"
            ]
        );
        assert!(
            returned["influences"]
                .as_array()
                .unwrap()
                .iter()
                .all(|influence| influence["queryId"] == query["id"])
        );
        assert!(returned["projection"].is_null());
    }
    let dependencies = returns
        .iter()
        .flat_map(|returned| returned["dependencies"].as_array().unwrap())
        .collect::<Vec<_>>();
    for field in ["active", "running", "parallel", "spent", "held", "cap"] {
        assert!(
            dependencies
                .iter()
                .any(|dependency| dependency["model"] == "FirstSources.Budget"
                    && dependency["field"] == field),
            "original selected row read {field} remains an ordinary dependency"
        );
    }
    assert!(
        dependencies
            .iter()
            .all(|dependency| dependency["field"] != "id"),
        "id order is a query influence, not a fabricated stored field"
    );
}

#[test]
fn genuine_driver_and_cli_first_query_keep_candidate_controls_selected_reads_and_source_order() {
    let (db, program, ir, catalog) = fixture();
    let ScenarioDisclosure::Complete(checked) = &ir.scenario_disclosures[&item(&ir, OWNER).id]
    else {
        panic!("bounded native first source Complete")
    };
    let return_ids: Vec<_> = checked
        .returns
        .iter()
        .map(|returned| returned.id.as_str())
        .collect();
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(
        diagnostics.is_empty(),
        "genuine prepared first query: {diagnostics:?}"
    );
    assert_eq!(operation(&prepared)["result"]["type"], "FirstSources.Run");
    assert_plan(
        &operation(&prepared)["result"]["disclosure"],
        "native-first-budget.can",
        SOURCE_HASH,
        &return_ids,
    );

    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("native-first-budget.can");
    std::fs::write(&source, SOURCE.as_bytes()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(native_owner_root().join("packages/cloudflare/dist/native-catalog.json"))
        .arg(&source)
        .current_dir(root())
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact: Value = serde_json::from_slice(&output.stdout).unwrap();
    let (_, _, cli_ir, _) = fixture_at(source.to_str().unwrap());
    let ScenarioDisclosure::Complete(cli_checked) =
        &cli_ir.scenario_disclosures[&item(&cli_ir, OWNER).id]
    else {
        panic!("original absolute-path CLI source Complete")
    };
    let cli_return_ids: Vec<_> = cli_checked
        .returns
        .iter()
        .map(|returned| returned.id.as_str())
        .collect();
    assert_plan(
        &operation(&artifact)["result"]["disclosure"],
        source.to_str().unwrap(),
        SOURCE_HASH,
        &cli_return_ids,
    );
    let artifact_path = scratch.path().join("artifact.json");
    std::fs::write(&artifact_path, output.stdout).unwrap();
    let runner = scratch.path().join("native-first-query.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';
const require=createRequire(resolve(process.argv[2],'package.json')),load=name=>import(pathToFileURL(require.resolve(name)));
const stdlibRequire=createRequire(resolve(process.argv[6],'package.json'));
const artifact=JSON.parse(readFileSync(process.argv[3])),source=readFileSync(process.argv[4],'utf8');
const hash=createHash('sha256').update(source).digest('hex');assert.equal(hash,process.argv[7]);
const stdlibUrl=pathToFileURL(stdlibRequire.resolve('@canlang/cloudflare/runtime/stdlib')).href;
const stdlib=await import(stdlibUrl);assert.equal(typeof stdlib.firstQuery,'function','released real firstQuery export is a prerequisite');
assert.equal(typeof stdlib.executeScenarioReceiptQuery,'function');
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {loadArtifactDescriptors}=await load('@canlang/state/invocation/registry');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],stdlibUrl,uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const operation=artifact.operations.find(operation=>operation.name==='FirstSources.generate'),plan=operation.result.disclosure,query=plan.queries[0];
const loaded=loadArtifactDescriptors(artifact,{by:'members'});assert.deepEqual(loaded.registry.get(operation.name).descriptor.result.disclosure,plan);
assert.equal(operation.result.type,'FirstSources.Run');assert.equal(plan.source.sha256,hash);assert.equal(plan.source.path,process.argv[4]);
assert.equal(query.model,'FirstSources.Budget');assert.deepEqual(query.order,[{field:'id',direction:'asc'}]);assert.equal(query.limit,null);assert.equal(query.archived,'exclude');
assert.equal(query.dependencies.length,1);assert.equal(query.dependencies[0].field,'account');assert.equal(query.dependencies[0].type,'user');assert.equal(query.dependencies[0].role,'control');
assert.ok(plan.returns.length>0);assert.equal(new Set(plan.returns.map(returned=>returned.id)).size,plan.returns.length);
for(const returned of plan.returns){assert.deepEqual(returned.influences.map(influence=>influence.kind),['query-existence','query-cardinality','query-membership','query-order']);
assert.ok(returned.influences.every(influence=>influence.queryId===query.id));assert.equal(Object.hasOwn(returned,'projection'),false);}
const callable=artifact.callables.find(callable=>callable.id===operation.name),module=await importVerifiedAssemblyModule(assembly,callable.module,artifact),factory=module.canApp();
assert.equal(module.appDefinition.operations[operation.name].by,'members');assert.equal(module.appDefinition.operations[operation.name].read,false);
let handler=factory;for(const part of callable.member)handler=handler[part];const body=handler.toString();
const once=pattern=>assert.equal((body.match(pattern)||[]).length,1);
once(/\bexecuteScenarioReceiptQuery\(/g);once(/\bfirstQuery\(/g);once(/\bawait create\(/g);once(/\bawait send\(/g);
once(/\bawait bindScenarioReceiptModelResult\(/g);once(/\bselectScenarioReceiptReturn\(/g);assert.equal((body.match(/\bawait set\(/g)||[]).length,2);
assert.ok(body.includes(`await executeScenarioReceiptQuery(c,${JSON.stringify(query.id)},async(`));
// In the capture form JavaScript evaluates the awaited array argument before
// calling firstQuery. The enclosing await must settle firstQuery before Let.
const wrapped=/\bawait \(\(([$\w]+)\)=>firstQuery\(c,\1\[0\]\)\)\(\[await executeScenarioReceiptQuery\(c,/.test(body);
const direct=/\bawait firstQuery\(c,await executeScenarioReceiptQuery\(c,/.test(body);
assert.ok(wrapped||direct,'real executor result is passed once to awaited firstQuery');
const first=body.indexOf('firstQuery('),executed=body.indexOf('executeScenarioReceiptQuery('),created=body.indexOf('await create(');
const chosenSet=body.indexOf('await set('),sent=body.indexOf('await send('),runSet=body.indexOf('await set(',chosenSet+1),late=body.indexOf('check(',runSet);
const bound=body.indexOf('await bindScenarioReceiptModelResult('),selected=body.indexOf('selectScenarioReceiptReturn('),returned=body.lastIndexOf('return ');
assert.ok(first>=0&&executed>=0&&first<created&&executed<created&&created<chosenSet&&chosenSet<sent&&sent<runSet&&runSet<late&&late<bound&&bound<selected&&selected<returned);
assert.equal((body.match(/\["account"\]/g)||[]).length,1,'candidate predicate reads account once');
assert.equal(body.includes('when:{rule:'),true);assert.equal(body.includes('when:()=>'),false);assert.equal(body.includes('return $receiptModelResult;'),true);
const dependencies=[...new Map(plan.returns.flatMap(returned=>returned.dependencies).map(dependency=>[dependency.id,dependency])).values()];assert.ok(dependencies.every(dependency=>dependency.field!=='id'));
for(const field of ['active','running','parallel','spent','held','cap'])assert.ok(dependencies.some(dependency=>dependency.model==='FirstSources.Budget'&&dependency.field===field));
for(const dependency of dependencies){const marker=`await observeScenarioReceiptDependency(c,${JSON.stringify(dependency.model)},$receiptRow,${JSON.stringify(dependency.field)},${JSON.stringify(dependency.id)});`;
 assert.equal(body.split(marker).length-1,1,'each original selected-row source read is captured once');}
const guard=module.appDefinition.operations[operation.name].sendGuards[0];assert.deepEqual(guard.inputs,[{name:'enabled',type:'bool'}]);assert.equal(guard.source.sha256,hash);
// Import genuine consumers only. Candidate/policy evaluation, current selected
// row issuance, writes, false/skipped SEND and rollback remain Dev-owned.
console.log('Bounded first Budget: actual prepared compiler/CLI/verified factory/installed State retain candidate controls, four same-Run influences, ordinary selected reads and awaited source order; native execution unqualified');
"#).unwrap();
    let output = Command::new("node")
        .arg(&runner)
        .arg(root())
        .arg(&artifact_path)
        .arg(&source)
        .arg(scratch.path().join("modules"))
        .arg(native_owner_root())
        .arg(SOURCE_HASH)
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&output.stdout));
}

#[test]
fn same_span_first_query_source_ir_facts_and_prepared_declaration_mutants_refuse() {
    let (db, program, ir, catalog) = fixture();
    let owner = item(&ir, OWNER).id;
    let entry = "$can$m$4669727374536f7572636573.mjs";
    assert!(
        serialize_complete_query_receipt(
            &program,
            &ir,
            &ir.items[owner.0 as usize],
            &db,
            Some(&catalog),
            entry
        )
        .is_some()
    );
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(operation(&prepared)["result"]["disclosure"].is_object());
    for mode in [
        "first-target",
        "first-result-type",
        "predicate-actor",
        "order",
        "query-source",
        "collection-call",
        "statement-order",
        "selected-set",
        "return",
        "facts-source",
        "facts-influence",
        "facts-account-type",
        "budget-field-type",
    ] {
        let mut changed = ir.clone();
        if mode.starts_with("facts-") {
            let facts = match changed.scenario_disclosures.get_mut(&owner).unwrap() {
                ScenarioDisclosure::Complete(value) => value.source_facts.as_mut().unwrap(),
                ScenarioDisclosure::Declined(value) => value.source_facts.as_mut().unwrap(),
            };
            let query = &mut facts.queries.as_mut().unwrap()[0];
            match mode {
                "facts-source" => query.source.sha256 = "0".repeat(64),
                "facts-influence" => {
                    query.influences.pop().unwrap();
                }
                _ => {
                    query.dependencies[0].ty = ResolvedType::Scalar(Scalar::Text);
                    query.dependencies[0].type_id = "text".into();
                }
            }
        } else if mode == "budget-field-type" {
            let field = item(&changed, "FirstSources.Budget.account").id;
            let IrItemKind::Field { ty, .. } = &mut changed.items[field.0 as usize].kind else {
                panic!("field")
            };
            *ty = IrType::Known(ResolvedType::Scalar(Scalar::Text));
        } else {
            let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!("scenario")
            };
            if mode == "statement-order" {
                effects.swap(0, 1);
            } else if mode == "selected-set" {
                let IrStmt::Set { record, .. } = &mut effects[3] else {
                    panic!("chosen Set")
                };
                record.expr = IrExpr::Name("run".into());
            } else if mode == "return" {
                let IrStmt::Return {
                    value: Some(value), ..
                } = effects.last_mut().unwrap()
                else {
                    panic!("Return")
                };
                value.expr = IrExpr::Name("budget".into());
            } else {
                let IrStmt::Let { value, .. } = &mut effects[0] else {
                    panic!("first Let")
                };
                if mode == "first-result-type" {
                    let ResolvedType::Nullable(inner) = &value.ty else {
                        panic!("first nullable result")
                    };
                    value.ty = *inner.clone();
                } else {
                    let (IrExpr::Call { target, args } | IrExpr::BoundCall { target, args, .. }) =
                        &mut value.expr
                    else {
                        panic!("first Call")
                    };
                    if mode == "first-target" {
                        let IrCallTarget::Builtin { id, .. } = target else {
                            panic!("first builtin")
                        };
                        *id = "last".into();
                    } else {
                        let IrExpr::Query(query) = &mut args[0].expr else {
                            panic!("original query")
                        };
                        match mode {
                            "predicate-actor" => {
                                let IrExpr::Binary { right, .. } =
                                    &mut query.where_pred.as_mut().unwrap().expr
                                else {
                                    panic!("predicate")
                                };
                                right.expr = IrExpr::Name("enabled".into());
                            }
                            "order" => query.order[0].descending = true,
                            "query-source" => query.source = None,
                            _ => query.collection_call.as_mut().unwrap().overload += 1,
                        }
                    }
                }
            }
        }
        assert!(
            serialize_complete_query_receipt(
                &program,
                &changed,
                &changed.items[owner.0 as usize],
                &db,
                Some(&catalog),
                entry
            )
            .is_none(),
            "{mode}: original query closure survived"
        );
        // Raw IR lacks the original prepared query/guard outputs. The public
        // collector refusal above tests mutation semantics independently.
        let emitted = js::emit_program_with_native_source_receipts(&changed, true, &db);
        assert!(
            emitted
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{mode}: {:?}",
            emitted.diagnostics
        );
        assert!(
            emitted
                .operations
                .iter()
                .find(|operation| operation.name == OWNER)
                .is_none_or(|operation| operation.disclosure.is_none()),
            "{mode}"
        );
    }
    let mut stale = SourceDb::new();
    stale.add(
        "native-first-budget.can".into(),
        SOURCE.replace("Original ordered selection", "Modified ordered selection"),
    );
    assert!(
        serialize_complete_query_receipt(
            &program,
            &ir,
            &ir.items[owner.0 as usize],
            &stale,
            Some(&catalog),
            entry
        )
        .is_none()
    );
    for canonical in [
        "FirstSources.Budget.account",
        "FirstSources.generate.enabled",
    ] {
        let (db, mut program, ir, catalog) = fixture();
        let id = item(&ir, canonical).id;
        program
            .types
            .symbol_types
            .insert(id, ResolvedType::Scalar(Scalar::Text));
        let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{canonical}: {diagnostics:?}"
        );
        assert!(
            artifact["operations"]
                .as_array()
                .unwrap()
                .iter()
                .find(|operation| operation["name"] == OWNER)
                .is_none_or(|operation| operation["result"]["disclosure"].is_null()),
            "{canonical}"
        );
    }
}

const MEMBERSHIP_SOURCE: &str = "app AuthorizationCanUse\nGiven\n Conversation {title:text trim max=200,account:user server=actor,active:bool=true}\n Branch in Conversation {title:text trim max=200}\n Budget {account:user,active:bool,running:int=0,parallel:int=1}\n Run in Branch {unfinished:bool=true}\n export derive can_use(person:user?,conversation:Conversation):bool = person!=null and active_member(person,team) and conversation.account==person and conversation.active\n policy Conversation read=members and row.account==actor\n policy Branch read=can_use(actor,row.parent)\n policy Branch read=members and row.parent.account==actor fields=parent\n policy Run read=members\n policy Budget read=members\nWhen\n crud Budget by=members fields=account,active,running,parallel\n scenario ask(branch:Branch) by=members -> Run\n  require can_use(actor,branch.parent)\n  do\n   let budget=first(Budget as row where row.account==actor order=row.id)\n   require budget!=null and budget.active\n   create Run {parent=branch,unfinished=true} as run\n   return run\nThen\n";

fn membership_fixture() -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add("membership-first.can".into(), MEMBERSHIP_SOURCE.into());
    let path = native_owner_root().join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir, catalog)
}

#[test]
fn membership_derive_body_only_mutation_refuses_first_receipt() {
    let (db, program, ir, catalog) = membership_fixture();
    let owner = item(&ir, "AuthorizationCanUse.ask").id;
    let entry = "$can$m$test.mjs";
    assert!(
        serialize_complete_query_receipt(
            &program,
            &ir,
            &ir.items[owner.0 as usize],
            &db,
            Some(&catalog),
            entry
        )
        .is_some(),
        "original membership derive keeps its first-query receipt"
    );
    // Body-only deletion: the mutable IR callee body loses its membership
    // read while the checked call, result type and span stay identical.
    // Lane selection authenticates the original declaration in its defining
    // source, so the sealed authorization lane is kept and the mutant
    // refuses; it must never fall back to ordinary derive matching.
    let mut changed = ir.clone();
    let derive = item(&changed, "AuthorizationCanUse.can_use").id;
    let IrItemKind::DeriveFn { expr, .. } = &mut changed.items[derive.0 as usize].kind else {
        panic!("derive")
    };
    let body = expr.as_mut().unwrap();
    assert_eq!(body.ty, ResolvedType::Scalar(Scalar::Bool));
    body.expr = IrExpr::Bool(true);
    assert!(
        serialize_complete_query_receipt(
            &program,
            &changed,
            &changed.items[owner.0 as usize],
            &db,
            Some(&catalog),
            entry
        )
        .is_none(),
        "body-only membership deletion must refuse"
    );
}

#[test]
fn first_query_alias_renaming_retains_original_source_correspondence() {
    let original = "Budget as row where row.account==actor order=row.id";
    for alias in ["candidate", "budgetRow"] {
        let source = SOURCE.replace(
            original,
            &format!("Budget as {alias} where {alias}.account==actor order={alias}.id"),
        );
        let (db, program, ir, catalog) = fixture_source("renamed-first.can", &source);
        let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
        assert!(diagnostics.is_empty(), "{alias}: {diagnostics:?}");
        let disclosure = &operation(&artifact)["result"]["disclosure"];
        assert_eq!(
            disclosure["source"]["sha256"],
            sha256_hex(source.as_bytes())
        );
        assert_eq!(
            disclosure["queries"][0]["order"],
            serde_json::json!([{"field":"id","direction":"asc"}])
        );
        assert!(
            serialize_complete_query_receipt(
                &program,
                &ir,
                item(&ir, OWNER),
                &db,
                Some(&catalog),
                "./app.js"
            )
            .is_some(),
            "original renamed IR must prepare"
        );
        let mut changed = ir.clone();
        let IrItemKind::Scenario { effects, .. } =
            &mut changed.items[item(&ir, OWNER).id.0 as usize].kind
        else {
            panic!()
        };
        let IrStmt::Let { value, .. } = &mut effects[0] else {
            panic!()
        };
        let IrExpr::Call { args, .. } = &mut value.expr else {
            panic!()
        };
        let IrExpr::Query(query) = &mut args[0].expr else {
            panic!()
        };
        query.where_param = "unbound".into();
        assert!(
            serialize_complete_query_receipt(
                &program,
                &changed,
                item(&changed, OWNER),
                &db,
                Some(&catalog),
                "./app.js"
            )
            .is_none(),
            "changed lowered alias must refuse"
        );
    }
}

#[test]
fn first_query_declared_scalar_input_and_default_order_keep_exact_source_join() {
    for (field, input, alias, order, grouped) in [
        ("source", "source", "candidate", "", false),
        ("reference", "requested", "entry", " order=entry.id", false),
        ("reference", "requested", "entry", "", true),
    ] {
        let source = SOURCE
            .replace(
                "account:user unique,",
                &format!("account:user unique, {field}:text,"),
            )
            .replace(
                "enabled:bool,accept:bool",
                &format!("enabled:bool,accept:bool,{input}:text,other:text"),
            )
            .replace(
                "Budget as row where row.account==actor order=row.id",
                &if grouped {
                    format!("Budget as {alias} where (({alias}.{field})==({input})){order}")
                } else {
                    format!("Budget as {alias} where {alias}.{field}=={input}{order}")
                },
            );
        let (db, program, ir, catalog) = fixture_source("input-first.can", &source);
        let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
        assert!(diagnostics.is_empty(), "{diagnostics:?}");
        let plan = &operation(&artifact)["result"]["disclosure"];
        assert_eq!(plan["queries"][0]["dependencies"][0]["field"], field);
        assert_eq!(plan["queries"][0]["dependencies"][0]["type"], "text");
        assert_eq!(
            plan["queries"][0]["order"],
            if order.is_empty() {
                serde_json::json!([])
            } else {
                serde_json::json!([{"field":"id","direction":"asc"}])
            }
        );
        let owner = item(&ir, OWNER).id;
        for mode in ["operand", "field", "order", "binding"] {
            let mut changed = ir.clone();
            let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!()
            };
            let IrStmt::Let { value, .. } = &mut effects[0] else {
                panic!()
            };
            let IrExpr::Call { args, .. } = &mut value.expr else {
                panic!()
            };
            let IrExpr::Query(scan) = &mut args[0].expr else {
                panic!()
            };
            match mode {
                "order" if scan.order.is_empty() => {
                    scan.order.push(canlang_compiler::codegen::ir::IrOrder {
                        field: "id".into(),
                        descending: false,
                    })
                }
                "order" => scan.order.clear(),
                "binding" => scan.where_param = "foreign".into(),
                _ => {
                    let IrExpr::Binary { left, right, .. } =
                        &mut scan.where_pred.as_mut().unwrap().expr
                    else {
                        panic!()
                    };
                    if mode == "operand" {
                        right.expr = IrExpr::Name("other".into());
                    } else {
                        let IrExpr::Member { field, .. } = &mut left.expr else {
                            panic!()
                        };
                        *field = "account".into();
                    }
                }
            }
            assert!(
                serialize_complete_query_receipt(
                    &program,
                    &changed,
                    &changed.items[owner.0 as usize],
                    &db,
                    Some(&catalog),
                    "./app.js"
                )
                .is_none(),
                "{mode}"
            );
        }
    }
}

#[test]
fn first_lookup_and_late_requirement_do_not_require_guarded_send_effects() {
    let source = include_str!("../../packages/cloudflare/test/fixtures/native-first-lookup.can");
    let (db, program, ir, catalog) = fixture_source("native-first-lookup.can", source);
    assert!(
        matches!(
            ir.scenario_disclosures[&item(&ir, "LookupSources.lookup").id],
            ScenarioDisclosure::Complete(_)
        ),
        "{:?}",
        ir.scenario_disclosures[&item(&ir, "LookupSources.lookup").id]
    );
    assert!(
        serialize_complete_query_receipt(
            &program,
            &ir,
            item(&ir, "LookupSources.lookup"),
            &db,
            Some(&catalog),
            "./app.js"
        )
        .is_some(),
        "original source query plan"
    );
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let operation = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == "LookupSources.lookup")
        .unwrap();
    assert!(operation["result"]["disclosure"].is_object());
    assert_eq!(
        operation["result"]["disclosure"]["queries"][0]["order"],
        serde_json::json!([])
    );
    let owner = item(&ir, "LookupSources.lookup").id;
    let mut changed = ir.clone();
    let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind else {
        panic!()
    };
    let IrStmt::Require { cond, .. } = &mut effects[3] else {
        panic!()
    };
    cond.expr = IrExpr::Bool(true);
    assert!(
        serialize_complete_query_receipt(
            &program,
            &changed,
            &changed.items[owner.0 as usize],
            &db,
            Some(&catalog),
            "./app.js"
        )
        .is_none(),
        "removing the late business guard must refuse"
    );
}

const REFERENCE_RESULT: &str = r#"app ReferenceSources
Given
 Deal {title:text}
 Intake {source:text,deal:Deal}
 policy Deal read=members
 policy Intake read=members
When
 crud Deal by=members fields=title
 crud Intake by=members fields=source,deal
 scenario promote(source:text,accept:bool) -> Deal by=members
  do
   let existing=first(Intake as candidate where candidate.source==source)
   if existing!=null
    require accept
    return existing.deal
   create Deal {title=source} as deal
   require accept
   return deal
Then
"#;

#[test]
fn required_reference_return_and_fresh_branch_emit_distinct_observations_and_sealed_guards() {
    let (db, program, ir, catalog) = fixture_source("reference-results.can", REFERENCE_RESULT);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let operation = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|op| op["name"] == "ReferenceSources.promote")
        .unwrap();
    let plan = &operation["result"]["disclosure"];
    assert_eq!(plan["returns"].as_array().unwrap().len(), 2);
    let modules = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        modules.contains("await readScenarioReceiptStoredReference(c,$receiptValue,"),
        "{modules}"
    );
    assert!(
        modules.contains(
            "await bindScenarioReceiptModelResult(c,$receiptReturns[0],$receiptModelView)"
        )
    );
    assert!(
        modules
            .contains("await bindScenarioReceiptModelResult(c,$receiptReturns[0],$receiptValue)")
    );
    let owner = item(&ir, "ReferenceSources.promote").id;
    for mode in [
        "branch-guard",
        "branch-condition",
        "reference-field",
        "reference-receiver",
        "branch-order",
    ] {
        let mut changed = ir.clone();
        let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind else {
            unreachable!()
        };
        let IrStmt::If {
            cond, then_branch, ..
        } = &mut effects[1]
        else {
            unreachable!()
        };
        match mode {
            "branch-condition" => cond.expr = IrExpr::Bool(true),
            "branch-guard" => {
                then_branch.remove(0);
            }
            "branch-order" => then_branch.swap(0, 1),
            _ => {
                let IrStmt::Return {
                    value: Some(value), ..
                } = &mut then_branch[1]
                else {
                    unreachable!()
                };
                let IrExpr::Member { base, field } = &mut value.expr else {
                    unreachable!()
                };
                if mode == "reference-field" {
                    *field = "source".into();
                } else {
                    base.expr = IrExpr::Name("copied".into());
                }
            }
        }
        let emitted = js::emit_program_with_native_source_receipts(&changed, true, &db);
        assert!(
            emitted
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{mode}: {:?}",
            emitted.diagnostics
        );
        assert!(
            emitted
                .operations
                .iter()
                .find(|op| op.name == "ReferenceSources.promote")
                .is_none_or(|op| op.disclosure.is_none()),
            "{mode}"
        );
    }
}

#[test]
fn required_reference_result_reuses_the_same_rules_after_renaming_grouping_and_parameter_binding() {
    let renamed = REFERENCE_RESULT
        .replace("ReferenceSources", "Reused")
        .replace("Intake", "Selection")
        .replace("Deal", "Outcome")
        .replace("source", "key")
        .replace("deal", "outcome")
        .replace("existing", "selected")
        .replace("candidate", "entry");
    let grouped = REFERENCE_RESULT
        .replace("candidate.source==source", "((candidate.source)==(source))")
        .replace("existing!=null", "(existing!=null)")
        .replace("return existing.deal", "return ((existing).deal)");
    let parameter = REFERENCE_RESULT.replace("scenario promote(source:text,accept:bool)", "scenario promote(existing:Intake,source:text,accept:bool)")
        .replace("   let existing=first(Intake as candidate where candidate.source==source)\n   if existing!=null\n    require accept\n    return existing.deal\n   create Deal {title=source} as deal\n   require accept\n   return deal", "   require accept\n   return existing.deal");
    for source in [renamed, grouped, parameter] {
        let (db, program, _, catalog) = fixture_source("reused-reference.can", &source);
        let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
        assert!(diagnostics.is_empty(), "{source}\n{diagnostics:?}");
        let modules = artifact["modules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|module| module["js"].as_str().unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(modules.contains("await readScenarioReceiptStoredReference(c,$receiptValue,"));
        assert!(!modules.contains("$receiptValue[\"id\"]"));
    }
}

#[test]
fn required_reference_chain_emits_each_original_bridge_and_refuses_replaced_edges() {
    let source =
        include_str!("../../packages/cloudflare/test/fixtures/native-reference-chain-result.can");
    let (db, program, ir, catalog) = fixture_source("reference-chain.can", source);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let modules = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        modules.contains("(await readScenarioReceiptStoredReference(c,"),
        "{modules}"
    );
    assert!(modules.contains("await readScenarioReceiptStoredReference(c,$receiptValue,"));
    let owner = item(&ir, "ReferenceChain.promote").id;
    for mode in ["source-field", "leaf-field", "source-type", "branch-guard"] {
        let mut changed = ir.clone();
        let other = ResolvedType::Record {
            symbol: item(&ir, "ReferenceChain.Intake").id,
            stored: true,
        };
        let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind else {
            unreachable!()
        };
        let IrStmt::If { then_branch, .. } = &mut effects[1] else {
            unreachable!()
        };
        if mode == "branch-guard" {
            then_branch.remove(0);
        } else {
            let IrStmt::Return {
                value: Some(value), ..
            } = &mut then_branch[1]
            else {
                unreachable!()
            };
            let IrExpr::Member { base, field } = &mut value.expr else {
                unreachable!()
            };
            match mode {
                "leaf-field" => *field = "copied".into(),
                "source-type" => base.ty = other,
                _ => {
                    let IrExpr::Member { field, .. } = &mut base.expr else {
                        unreachable!()
                    };
                    *field = "copied".into();
                }
            }
        }
        let emitted = js::emit_program_with_native_source_receipts(&changed, true, &db);
        assert!(
            emitted
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{mode}: {:?}",
            emitted.diagnostics
        );
        assert!(
            emitted
                .operations
                .iter()
                .find(|operation| operation.name == "ReferenceChain.promote")
                .is_none_or(|operation| operation.disclosure.is_none()),
            "{mode}"
        );
    }
}

#[test]
fn original_first_execution_is_independent_of_void_scalar_and_model_result_shapes() {
    for (result, body) in [
        ("", "   require budget!=null\n"),
        (" -> bool", "   require budget!=null\n   return enabled\n"),
        (
            " -> Run",
            "   require budget!=null\n   create Run {title=\"Created\"} as run\n   return run\n",
        ),
    ] {
        let source = format!(
            "app FirstSources\nGiven\n Budget {{account:user,held:int}}\n Run {{title:text}}\n policy Budget read=members\n policy Run read=members\nWhen\n scenario generate(enabled:bool){result} by=members\n  do\n   let budget=first(Budget as row where row.account==actor order=row.id)\n{body}Then\n"
        );
        let (db, program, ir, catalog) = fixture_source("independent-first.can", &source);
        let owner = item(&ir, OWNER);
        let ScenarioDisclosure::Complete(checked) = &ir.scenario_disclosures[&owner.id] else {
            panic!("{result}: {:?}", ir.scenario_disclosures[&owner.id]);
        };
        let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
        assert!(diagnostics.is_empty(), "{result}: {diagnostics:?}");
        let plan = &operation(&artifact)["result"]["disclosure"];
        let actual_ids = plan["returns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            actual_ids,
            checked
                .returns
                .iter()
                .map(|value| value.id.as_str())
                .collect::<Vec<_>>()
        );
        assert_eq!(plan["queries"].as_array().unwrap().len(), 1);
        let text = artifact["modules"][0]["js"].as_str().unwrap();
        assert!(text.contains("queryFirst:["), "{text}");
        assert!(text.contains("await firstQuery(c,"), "{text}");
        for returned in plan["returns"].as_array().unwrap() {
            let original = checked
                .returns
                .iter()
                .find(|value| value.id == returned["id"])
                .unwrap();
            assert_eq!(
                returned["influences"].as_array().unwrap().len(),
                original.influences.len()
            );
        }
    }
}

#[test]
fn scalar_require_uses_original_first_field_observation_without_retaining_result_dependency() {
    let source = "app FirstSources\nGiven\n Budget {account:user,held:int}\n policy Budget read=members\nWhen\n scenario generate(enabled:bool) -> bool by=members\n  do\n   let budget=first(Budget as row where row.account==actor order=row.id)\n   require budget!=null and (not enabled or budget.held>0)\n   return true\nThen\n";
    let (db, program, original, catalog) = fixture_source("scalar-require-first.can", source);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let plan = &operation(&artifact)["result"]["disclosure"];
    assert!(
        plan["returns"][0]["dependencies"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(
        plan["returns"][0]["influences"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let text = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(text.contains("executionDependencies:["));
    assert!(text.contains("observeScenarioReceiptDependency"));
    assert!(text.contains("\"field\":\"held\",\"type\":\"int\""));
    let mut corrupt = original.clone();
    let IrItemKind::Scenario { effects, .. } =
        &mut corrupt.items[item(&original, OWNER).id.0 as usize].kind
    else {
        panic!("scenario");
    };
    let IrStmt::Require { cond, .. } = &mut effects[1] else {
        panic!("Require");
    };
    fn replace(value: &mut ir::TypedExpr) {
        match &mut value.expr {
            IrExpr::Member { field, .. } if field == "held" => *field = "account".into(),
            IrExpr::Binary { left, right, .. } => {
                replace(left);
                replace(right);
            }
            IrExpr::Unary { operand, .. } => replace(operand),
            _ => {}
        }
    }
    replace(cond);
    let emitted = js::emit_program_with_native_source_receipts(&corrupt, true, &db);
    assert!(
        emitted
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008")
    );
}

#[test]
fn scalar_require_preserves_existing_stored_contract_schema_identity() {
    let source = "app FirstSources\nGiven\n contract Details {note:text}\n Budget {account:user,input:Details,held:int}\n policy Budget read=members\nWhen\n scenario generate(input:Details) -> bool by=members\n  do\n   let budget=first(Budget as row where row.account==actor order=row.id)\n   require budget!=null and budget.input==input and budget.held>0\n   return true\nThen\n";
    let (db, program, _, catalog) = fixture_source("contract-scalar-require-first.can", source);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let text = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(text.contains("\"field\":\"held\",\"type\":\"int\""));
    assert!(text.contains("\"field\":\"input\",\"type\":\"FirstSources.Details\""));
}

#[test]
fn scalar_require_helper_reuses_exact_call_formal_and_body_proof() {
    let source = "app FirstSources\nGiven\n Budget {account:user,approved:bool,active:bool}\n policy Budget read=members\n derive allowed(record:Budget):bool = record.approved and record.active\nWhen\n scenario generate() -> bool by=members\n  do\n   let budget=first(Budget as row where row.account==actor order=row.id)\n   require budget!=null and allowed(record=budget)\n   return true\nThen\n";
    let (db, program, original, catalog) = fixture_source("scalar-require-helper.can", source);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let text = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(text.contains("executionDependencies:["));
    for field in ["approved", "active"] {
        assert!(text.contains(&format!("\"field\":\"{field}\",\"type\":\"bool\"")));
        assert!(text.contains(&format!("$receiptRow,\"{field}\"")));
    }
    let mut corrupt = original.clone();
    let helper = item(&original, "FirstSources.allowed").id;
    let IrItemKind::DeriveFn {
        expr: Some(body), ..
    } = &mut corrupt.items[helper.0 as usize].kind
    else {
        panic!("derive");
    };
    let IrExpr::Binary { left, .. } = &mut body.expr else {
        panic!("and");
    };
    let IrExpr::Member { field, .. } = &mut left.expr else {
        panic!("member");
    };
    *field = "active".into();
    let emitted = js::emit_program_with_native_source_receipts(&corrupt, true, &db);
    assert!(
        emitted
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008")
    );
}

#[test]
fn same_owner_first_scalar_helpers_preserve_nested_slots_and_defaults() {
    for (helpers, call) in [
        (
            "derive inner(record:Budget):bool = record.approved\n derive allowed(record:Budget):bool = inner(record)",
            "allowed(budget)",
        ),
        (
            "derive allowed(record:Budget,flag:bool):bool = record.approved and flag",
            "allowed(record=budget,flag=true)",
        ),
        (
            "derive allowed(record:Budget,flag:bool=true):bool = record.approved and flag",
            "allowed(record=budget)",
        ),
    ] {
        let source = format!(
            "app FirstSources\nGiven\n Budget {{account:user,approved:bool}}\n policy Budget read=members\n {helpers}\nWhen\n scenario generate() -> bool by=members\n  do\n   let budget=first(Budget as row where row.account==actor order=row.id)\n   require budget!=null and {call}\n   return true\nThen\n"
        );
        let (db, program, _, catalog) = fixture_source("unsupported-first-helper.can", &source);
        let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
        assert!(diagnostics.is_empty(), "{helpers}: {diagnostics:?}");
        assert!(
            artifact["modules"][0]["js"]
                .as_str()
                .unwrap()
                .contains("executionDependencies:[")
        );
    }
}

#[test]
fn unsupported_first_field_types_retain_require_authority_and_refuse() {
    for (field, guard) in [
        ("secret:text?", "budget.secret==null"),
        ("secret:enum(Open,Closed)", "budget.secret==Open"),
        ("secret:text[]", "budget.secret==[\"a\"]"),
    ] {
        let source = format!(
            "app FirstSources\nGiven\n Budget {{account:user,{field}}}\n policy Budget read=members\nWhen\n scenario generate() -> bool by=members\n  do\n   let budget=first(Budget as row where row.account==actor order=row.id)\n   require budget!=null and {guard}\n   return true\nThen\n"
        );
        let (db, program, _, catalog) = fixture_source("unsupported-first-field.can", &source);
        let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{field}: {diagnostics:?}"
        );
    }
}

#[test]
fn grouped_nested_helper_defaults_keep_original_slots_and_refuse_changed_defaults() {
    let source = "app FirstSources\nGiven\n Budget {account:user,approved:bool}\n policy Budget read=members\n derive inner(record:Budget,flag:bool=true):bool = not flag or record.approved\n derive allowed(record:Budget,flag:bool=true):bool = inner(flag=flag,record=record)\nWhen\n scenario generate() -> bool by=members\n  do\n   let budget=first(Budget as row where row.account==actor order=row.id)\n   require budget!=null and allowed(record=((budget)))\n   return true\nThen\n";
    let (db, program, original, catalog) =
        fixture_source("grouped-first-helper-default.can", source);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(
        artifact["modules"][0]["js"]
            .as_str()
            .unwrap()
            .contains("executionDependencies:[")
    );
    let mut changed = original.clone();
    let helper = item(&original, "FirstSources.allowed");
    let IrItemKind::DeriveFn { params, .. } = &helper.kind else {
        panic!("derive");
    };
    let IrItemKind::Param {
        default: Some(ir::IrDefault::Literal(value)),
        ..
    } = &mut changed.items[params[1].0 as usize].kind
    else {
        panic!("default");
    };
    value.expr = IrExpr::Bool(false);
    assert!(
        js::emit_program_with_native_source_receipts(&changed, true, &db)
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008")
    );
}

#[test]
fn eager_unused_helper_operands_keep_authority_but_explicit_defaults_cut_it_off() {
    for (signature, call, observes) in [
        (
            "record:Budget,probe:bool",
            "allowed(record=budget,probe=budget.approved)",
            true,
        ),
        (
            "record:Budget,probe:bool=record.approved",
            "allowed(record=budget)",
            true,
        ),
        (
            "record:Budget,probe:bool=record.approved",
            "allowed(record=budget,probe=true)",
            false,
        ),
    ] {
        let source = format!(
            "app FirstSources\nGiven\n Budget {{account:user,approved:bool}}\n policy Budget read=members\n derive allowed({signature}):bool = true\nWhen\n scenario generate() -> bool by=members\n  do\n   let budget=first(Budget as row where row.account==actor order=row.id)\n   require budget!=null and {call}\n   return true\nThen\n"
        );
        let (db, program, _, catalog) = fixture_source("eager-first-helper.can", &source);
        let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
        assert!(
            diagnostics.is_empty(),
            "{signature}/{call}: {diagnostics:?}"
        );
        assert_eq!(
            artifact["modules"][0]["js"]
                .as_str()
                .unwrap()
                .contains("executionDependencies:["),
            observes,
            "{signature}/{call}"
        );
    }
}

#[test]
fn retained_reference_first_and_optional_account_keep_exact_source_ir_correspondence() {
    let original = include_str!("fixtures/event-change-retained.can");
    let prefix = &original[..original.find("    if resource==null").unwrap()];
    let source = format!(
        "{}    emit ApplyChange {{change}}\n    return change\n  scenario consume on=ApplyChange\n   do require true\n Then\n",
        prefix.replace(
            "  scenario change_schedule(",
            "  export scenario change_schedule("
        )
    );
    let (db, program, ir, catalog) = fixture_source("retained-first.can", &source);
    let owner = item(&ir, "events.change_schedule").id;
    let entry = "$can$m$6576656e7473.mjs";
    assert!(
        serialize_complete_query_receipt(
            &program,
            &ir,
            &ir.items[owner.0 as usize],
            &db,
            Some(&catalog),
            entry
        )
        .is_some()
    );
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for mode in [
        "optional-field",
        "fallback",
        "identity-operand",
        "predicate-order",
        "control-field",
        "input-default",
    ] {
        let mut changed = ir.clone();
        if mode == "control-field" {
            let field = item(&changed, "events.Change.resource").id;
            let IrItemKind::Field { ty, .. } = &mut changed.items[field.0 as usize].kind else {
                panic!("field")
            };
            *ty = IrType::Known(ResolvedType::Scalar(Scalar::Text));
        } else if mode == "input-default" {
            let parameter = item(&changed, "events.change_schedule.resource").id;
            let IrItemKind::Param { default, .. } = &mut changed.items[parameter.0 as usize].kind
            else {
                panic!("param")
            };
            *default = None;
        } else {
            let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!("scenario")
            };
            if mode == "optional-field" || mode == "fallback" {
                let IrStmt::Create { input, .. } = &mut effects[1] else {
                    panic!("create")
                };
                let IrExpr::Object(fields) = &mut input.expr else {
                    panic!("object")
                };
                let (_, account) = fields
                    .iter_mut()
                    .find(|(name, _)| name == "account")
                    .unwrap();
                let IrExpr::Binary { left, right, .. } = &mut account.expr else {
                    panic!("coalesce")
                };
                if mode == "fallback" {
                    right.expr = IrExpr::Name("retained".into());
                } else {
                    let IrExpr::Member { field, .. } = &mut left.expr else {
                        panic!("member")
                    };
                    *field = "author".into();
                }
            } else {
                let IrStmt::Let { value, .. } = &mut effects[0] else {
                    panic!("let")
                };
                let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) = &mut value.expr
                else {
                    panic!("call")
                };
                let IrExpr::Query(query) = &mut args[0].expr else {
                    panic!("query")
                };
                let predicate = query.where_pred.as_mut().unwrap();
                let IrExpr::Binary { left, right, .. } = &mut predicate.expr else {
                    panic!("and")
                };
                if mode == "predicate-order" {
                    std::mem::swap(left, right);
                } else {
                    let IrExpr::Binary { left: identity, .. } = &mut left.expr else {
                        panic!("inner and")
                    };
                    let IrExpr::Binary { right: operand, .. } = &mut identity.expr else {
                        panic!("identity")
                    };
                    let IrExpr::Member { field, .. } = &mut operand.expr else {
                        panic!("venue")
                    };
                    *field = "pending_change".into();
                }
            }
        }
        assert!(
            serialize_complete_query_receipt(
                &program,
                &changed,
                &changed.items[owner.0 as usize],
                &db,
                Some(&catalog),
                entry
            )
            .is_none(),
            "{mode} retained substituted source semantics"
        );
    }
}

#[test]
fn contained_first_update_and_source_loop_keep_imported_parent_and_nullable_slot_correspondence() {
    let source=r#"app FirstSources uses=[invoices]
package customers
 Given
  export Customer {active:bool=true}
 When
 Then
package invoices
 use customers {Customer}
 Given
  Invoice in Customer {title:text}
  History in Customer {invoice:Invoice?,complete:bool=false}
  Sale in Customer {source:text}
  event SaleCheck {sale:Sale}
  role finance
 When
  scenario generate(customer:Customer,invoice:Invoice?,complete:bool) by=finance
   do
    let history=first(customer.History as history order=history.id)
    if history==null
     create History {parent=customer,invoice,complete} as history
    else
     set history {invoice,complete}
    for sale in customer.Sale as sale limit=500
     emit SaleCheck {sale}
  scenario observe_sale on=SaleCheck
   do let selected=event.sale
 Then
"#;
    let (db,program,ir,catalog)=fixture_source("contained-loop.can",source);
    let (artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);
    assert!(diagnostics.is_empty(),"{diagnostics:?}");
    let operation=artifact["operations"].as_array().unwrap().iter().find(|operation|operation["name"]=="invoices.generate").unwrap();
    let plan=&operation["result"]["disclosure"];
    assert_eq!(plan["sourceEmissions"]["owner"],"invoices.generate");
    let loops=plan["sourceEmissions"]["loops"].as_array().unwrap();
    assert_eq!(loops.len(),1);
    assert_eq!(loops[0]["maximum"],500);
    assert_eq!(loops[0]["parentModel"],"customers.Customer");
    assert_eq!(loops[0]["model"],"invoices.Sale");
    assert_eq!(loops[0]["event"],"invoices.SaleCheck");
    assert_eq!(loops[0]["handler"],"invoices.observe_sale");
    assert!(artifact["modules"].as_array().unwrap().iter().any(|module|module["js"].as_str().unwrap().contains("await nativeScenarioSourceLoop(c,")));
    // The original/fresh join retains every executable loop operand;
    // editing its IR cannot borrow the original source's finite budget.
    assert!(serialize_complete_query_receipt(&program,&ir,item(&ir,"invoices.generate"),&db,Some(&catalog),"FirstSources").is_some());
    let mut changed=ir.clone();
    let owner_id=item(&ir,"invoices.generate").id;
    let IrItemKind::Scenario {effects,..}=&mut changed.items[owner_id.0 as usize].kind else {panic!("scenario");};
    let IrStmt::For {limit:Some(limit),..}=effects.last_mut().unwrap() else {panic!("loop");};
    limit.expr=IrExpr::Int(501);
    assert!(serialize_complete_query_receipt(&program,&changed,item(&changed,"invoices.generate"),&db,Some(&catalog),"FirstSources").is_none());
    let renamed=source.replace("customer:Customer","client:Customer")
        .replace("customer.","client.").replace("parent=customer","parent=client")
        .replace("history","selected_history").replace("sale","entry").replace("limit=500","limit=271");
    let (renamed_db,renamed_program,_,renamed_catalog)=fixture_source("renamed-loop.can",&renamed);
    let (_,renamed_diagnostics)=prepared_artifact(&renamed_program,&renamed_db,&renamed_catalog);
    assert!(renamed_diagnostics.is_empty(),"{renamed_diagnostics:?}");
    for (name,changed) in [
        ("copied-nullable-set",source.replace("     set history {invoice,complete}","     let copied=invoice\n     set history {invoice=copied,complete}")),
        ("computed-nullable-set",source.replace("set history {invoice,complete}","set history {invoice=invoice ?? invoice,complete}")),
        ("write-loop-not-source",source.replace("emit SaleCheck {sale}","set sale {source=\"changed\"}")),
        ("global-loop",source.replace("customer.Sale as sale","Sale as sale")),
        ("filtered-loop",source.replace("customer.Sale as sale limit","customer.Sale as sale where sale.source!=\"\" limit")),
        ("loop-over-budget",source.replace("limit=500","limit=501")),
        ("additional-handler",source.replace("  scenario observe_sale on=SaleCheck", "  scenario extra_sale on=SaleCheck\n   do let selected=event.sale\n  scenario observe_sale on=SaleCheck")),
        ("cohort-handler",source.replace("on=SaleCheck\n   do", "on=SaleCheck each=Sale as selected\n   do")),
    ] {
        let (db,program,_,catalog)=fixture_source(&format!("{name}.can"),&changed);
        let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);
        assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{name}: {diagnostics:?}");
    }
}


#[test]
fn original_event_provider_tail_keeps_guarded_reference_types_and_refuses_substitutions() {
    let source = include_str!("fixtures/event-change-retained.can");
    let (db, program, ir, catalog) = fixture_source("event-change-original.can", source);
    let owner = item(&ir, "events.change_schedule").id;
    let entry = "$can$m$6576656e7473.mjs";
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(
        serialize_complete_query_receipt(
            &program,
            &ir,
            &ir.items[owner.0 as usize],
            &db,
            Some(&catalog),
            entry
        )
        .is_some()
    );
    for mode in [
        "guard",
        "intermediate-type",
        "late-require",
        "previous-source",
        "created-handle",
        "guard-read-fact",
    ] {
        let mut changed = ir.clone();
        if mode == "guard-read-fact" {
            let ScenarioDisclosure::Complete(proof) =
                changed.scenario_disclosures.get_mut(&owner).unwrap()
            else {
                panic!("complete")
            };
            assert!(proof.returns.iter().any(|returned| {
                returned
                    .dependencies
                    .iter()
                    .any(|read| read.field_name == "venue_state")
            }));
            for returned in &mut proof.returns {
                returned
                    .dependencies
                    .retain(|read| read.field_name != "venue_state");
            }
        } else {
            let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner.0 as usize].kind
            else {
                panic!("scenario")
            };
            if mode == "created-handle" {
                effects.swap(1, 3);
            } else {
                let IrStmt::If { else_branch, .. } = &mut effects[3] else {
                    panic!("outer if")
                };
                let IrStmt::If {
                    cond, then_branch, ..
                } = &mut else_branch[1]
                else {
                    panic!("inner if")
                };
                if mode == "guard" {
                    cond.expr = IrExpr::Bool(true);
                } else if mode == "late-require" {
                    then_branch.remove(0);
                } else if mode == "intermediate-type" {
                    let IrStmt::Require { cond, .. } = &mut then_branch[0] else {
                        panic!("require")
                    };
                    let IrExpr::Binary { left, .. } = &mut cond.expr else {
                        panic!("and")
                    };
                    let IrExpr::Binary { left, .. } = &mut left.expr else {
                        panic!("equality")
                    };
                    let IrExpr::Member { base, .. } = &mut left.expr else {
                        panic!("venue state")
                    };
                    assert!(matches!(base.ty, ResolvedType::Record { stored: true, .. }));
                    base.ty = ResolvedType::Nullable(Box::new(base.ty.clone()));
                } else {
                    let IrStmt::Send { args, .. } = &mut then_branch[1] else {
                        panic!("send")
                    };
                    let IrExpr::Object(entries) = &mut args.expr else {
                        panic!("arguments")
                    };
                    entries
                        .iter_mut()
                        .find(|(name, _)| name == "previous_source")
                        .unwrap()
                        .1
                        .expr = IrExpr::Text("forged".into());
                }
            }
        }
        assert!(
            serialize_complete_query_receipt(
                &program,
                &changed,
                &changed.items[owner.0 as usize],
                &db,
                Some(&catalog),
                entry
            )
            .is_none(),
            "{mode} survived source correspondence"
        );
    }
}

#[test]
fn optional_customer_helper_domains_keep_original_source_and_ir_owners() {
    use canlang_compiler::codegen::scenario_decisions::serialize_decision_sources;
    let source = include_str!("fixtures/source-require-optional-customer.can");
    let (db, program, original, catalog) =
        fixture_source("source-require-optional-customer.can", source);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for owner in ["events.check_register", "rent_reservations.link_legacy"] {
        let operation = artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["name"] == owner)
            .unwrap();
        assert!(
            operation["result"]["disclosure"].is_object(),
            "{owner}: {operation}"
        );
        let owner = item(&original, owner);
        assert!(matches!(
            original.scenario_disclosures[&owner.id],
            ScenarioDisclosure::Complete(_)
        ));
        assert!(
            serialize_decision_sources(&program, &original, owner, &db, Some(&catalog)).is_some()
        );
    }
    let register = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|value| value["name"] == "events.check_register")
        .unwrap();
    for (name, expected) in [("email", "email?"), ("account", "user?")] {
        let field = register["inputs"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|value| value["name"] == name)
            .unwrap();
        assert_eq!(field["valueType"], expected);
    }
    fn replace_call(value: &mut ir::TypedExpr, mode: &str) -> bool {
        match &mut value.expr {
            IrExpr::Call {
                target: IrCallTarget::DeriveFn(target),
                args,
            }
            | IrExpr::BoundCall {
                target: IrCallTarget::DeriveFn(target),
                args,
                ..
            } if target == "customer.owns" => {
                if mode == "call-target" {
                    *target = "customer.has_role".into();
                } else {
                    args[1].expr = IrExpr::Name("same_typed_other_customer".into());
                }
                true
            }
            IrExpr::Binary { left, right, .. } => {
                replace_call(left, mode) || replace_call(right, mode)
            }
            IrExpr::Unary { operand, .. } => replace_call(operand, mode),
            _ => false,
        }
    }
    for mode in [
        "call-target",
        "same-model-binding",
        "helper-body",
        "helper-parameter",
        "count-predicate",
    ] {
        let mut changed = original.clone();
        let owner = item(&changed, "events.check_register").id;
        match mode {
            "call-target" | "same-model-binding" => {
                let IrItemKind::Scenario { guards, .. } = &mut changed.items[owner.0 as usize].kind
                else {
                    panic!("scenario");
                };
                let IrStmt::Require { cond, .. } = &mut guards[4] else {
                    panic!("require");
                };
                assert!(replace_call(cond, mode));
            }
            "helper-body" => {
                let id = item(&changed, "customer.owns").id;
                let IrItemKind::DeriveFn {
                    expr: Some(body), ..
                } = &mut changed.items[id.0 as usize].kind
                else {
                    panic!("helper");
                };
                body.expr = IrExpr::Bool(true);
            }
            "helper-parameter" => {
                let id = item(&changed, "customer.owns").id;
                let IrItemKind::DeriveFn { params, .. } = &mut changed.items[id.0 as usize].kind
                else {
                    panic!("helper");
                };
                params.swap(0, 1);
            }
            "count-predicate" => {
                let id = item(&changed, "events.Event.available").id;
                let IrItemKind::DeriveField {
                    expr: Some(body), ..
                } = &mut changed.items[id.0 as usize].kind
                else {
                    panic!("derived field");
                };
                let IrExpr::Binary { right, .. } = &mut body.expr else {
                    panic!("subtraction");
                };
                let IrExpr::Call { args, .. } = &mut right.expr else {
                    panic!("count");
                };
                let IrExpr::Query(query) = &mut args[0].expr else {
                    panic!("query");
                };
                query.where_pred.as_mut().unwrap().expr = IrExpr::Bool(true);
            }
            _ => unreachable!(),
        }
        assert!(
            serialize_decision_sources(
                &program,
                &changed,
                &changed.items[owner.0 as usize],
                &db,
                Some(&catalog)
            )
            .is_none(),
            "{mode} retained its decision correspondence"
        );
    }
}

#[test]
fn original_register_tail_keeps_created_provider_and_schedule_correspondence() {
    let source = include_str!("fixtures/event-register-source.can");
    let (db, program, original, catalog) = fixture_source("event-register-source.can", source);
    let owner = item(&original, "events.check_register").id;
    assert!(matches!(&original.scenario_disclosures[&owner], ScenarioDisclosure::Complete(_)));
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let operation = artifact["operations"].as_array().unwrap().iter().find(|value|value["name"]=="events.check_register").unwrap();
    assert!(operation["result"]["disclosure"].is_object(), "{operation}");
    for mode in ["create-account", "paid-order", "schedule-event", "provider-result", "reused-trait"] {
        let mut changed = original.clone();
        if mode == "provider-result" {
            let id = item(&changed, "invoice.BillingV1.charge").id;
            let IrItemKind::CapabilityOp { result, .. } = &mut changed.items[id.0 as usize].kind else { panic!("provider"); };
            *result = ir::IrType::Known(ResolvedType::Scalar(Scalar::Text));
        } else if mode == "reused-trait" {
            let id = item(&changed, "invoice.Settlement.state").id;
            let IrItemKind::Field {ty,..} = &mut changed.items[id.0 as usize].kind else {panic!("trait");};
            *ty = ir::IrType::Known(ResolvedType::Scalar(Scalar::Text));
        } else {
            let IrItemKind::Scenario {effects,..} = &mut changed.items[owner.0 as usize].kind else {panic!("scenario");};
            if mode == "create-account" {
                let IrStmt::Create {input,..} = &mut effects[0] else {panic!("create");};
                let IrExpr::Object(entries) = &mut input.expr else {panic!("inputs");};
                let (_, value) = entries.iter_mut().find(|(name,_)|name=="account").unwrap();
                let IrExpr::Binary {left,right,..} = &mut value.expr else {panic!("coalesce");};
                std::mem::swap(left,right);
            } else {
                let IrStmt::If {else_branch,..} = &mut effects[1] else {panic!("branch");};
                if mode == "paid-order" { else_branch.swap(1,2); }
                else {
                    let IrStmt::Schedule {event,..} = &mut else_branch[3] else {panic!("schedule");};
                    *event = "events.AttendeeNotice".into();
                }
            }
        }
        assert!(serialize_complete_query_receipt(&program,&changed,&changed.items[owner.0 as usize],
            &db,Some(&catalog),"$can$m$6576656e7473.mjs").is_none(),"{mode} retained altered source correspondence");
    }

}

#[test]
fn commercial_money_sums_preserve_nullable_history_guard_and_original_first() {
    let authored=std::fs::read_to_string(root().join("draft/apps/CanInvoice/CanInvoice.can")).unwrap();
    let start=authored.find("  scenario review_commercial_history(").unwrap();
    let end=start+authored[start..].find("\n   examples ").unwrap();
    let guards=authored[start..end].replace("scenario review_commercial_history(","scenario verify(");
    let mut source=include_str!("../../packages/cloudflare/test/fixtures/invoice-collect-owner-probe.can").to_string()
        .replace("package customer\n","package customer\n use rent_catalog {Location}\n")
        .replace("export Customer {kind:","export Customer {locations:Location[],currency:currency,kind:");
    let at=source.rfind(" Then\n").unwrap();
    source.insert_str(at,&format!("{guards}\n  scenario observe_sale on=SaleCheck\n   do let selected=event.sale\n"));
    let (db,program,ir,catalog)=fixture_source("commercial-money.can",&source);
    let (artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);
    assert!(diagnostics.is_empty(),"{diagnostics:?}");
    let owner=item(&ir,"invoice.verify");
    assert!(matches!(ir.scenario_disclosures[&owner.id],ScenarioDisclosure::Complete(_)));
    assert!(serialize_complete_query_receipt(&program,&ir,owner,&db,Some(&catalog),"$can$m$696e766f696365.mjs").is_some());
    let operation=artifact["operations"].as_array().unwrap().iter().find(|entry|entry["name"]=="invoice.verify").unwrap();
    assert_eq!(operation["result"]["disclosure"]["sourceEmissions"]["loops"][0]["maximum"],500);
    assert!(!artifact["callables"].as_array().unwrap().iter().any(|entry|entry["id"]=="invoice.first_paid_invoice"));
    // Equal Money types cannot substitute the source's complete contained
    // child census or the original same-row stored currency field.
    for (name,changed) in [
        ("global-payment-domain",source.replace("sum(row.ExternalPayment as payment select payment.amount,row.currency)",
            "sum(ExternalPayment as payment select payment.amount,row.currency)")),
        ("foreign-currency",source.replace("sum(row.ExternalPayment as payment select payment.amount,row.currency)",
            "sum(row.ExternalPayment as payment select payment.amount,row.parent.currency)")),
        ("parent-filter",source.replace("attempt.kind==collection and attempt.status==succeeded select attempt.amount",
            "attempt.kind==collection and attempt.parent.currency==row.currency and attempt.status==succeeded select attempt.amount")),
    ] {
        assert_ne!(source,changed,"{name}");
        let (db,program,_,catalog)=fixture_source(&format!("{name}.can"),&changed);
        let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);
        assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{name}: {diagnostics:?}");
    }
}

#[test]
fn original_book_and_reschedule_keep_required_reference_and_body_correspondence() {
    let source=include_str!("fixtures/book-original-source.can");
    let (db,program,original,catalog)=fixture_source("book-original-source.can",source);
    for name in ["appointments.book","appointments.reschedule","appointments.cancel","appointments.discard_reschedule","appointments.retry_cleanup"] {
        let owner=item(&original,name);
        assert!(matches!(&original.scenario_disclosures[&owner.id],ScenarioDisclosure::Complete(_)),"{name}");
    }
    let (artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);
    assert!(diagnostics.is_empty(),"{diagnostics:?}");
    let code=artifact["modules"].as_array().unwrap().iter().filter_map(|module|module["js"].as_str())
        .find(|code|code.contains("constructorInputs:")).expect("original constructor input");
    let raw=code.split_once("constructorInputs:").unwrap().1;
    let inputs=serde_json::Deserializer::from_str(raw).into_iter::<Value>().next().unwrap().unwrap();
    let inputs=inputs.as_array().unwrap();
    assert_eq!(inputs.len(),1);
    let input=&inputs[0];
    assert_eq!(input["owner"],"appointments.book");
    assert_eq!(input["parameter"],"type");
    assert_eq!(input["rootModel"],"appointments.Type");
    assert_eq!(input["parents"],serde_json::json!(["appointments.Calendar"]));
    assert_eq!(input["sourceField"],"host");
    assert_eq!(input["leafModel"],"employee.Employee");
    assert_eq!(input["leafField"],"user");
    assert_eq!(input["model"],"appointments.Appointment");
    assert_eq!(input["field"],"host");
    assert_ne!(input["sourceDependencyId"],input["leafDependencyId"]);
    for mode in ["create-path","provider-default","effect-order","previous-predicate","loop-filter","loop-target","loop-bound","loop-condition"] {
        let mut changed=original.clone();
        let name=if mode=="previous-predicate" {"appointments.reschedule"}
            else if mode=="loop-condition" {"appointments.retry_cleanup"}
            else if mode.starts_with("loop-") {"appointments.discard_reschedule"}
            else{"appointments.book"};
        let owner=item(&changed,name).id;
        if mode=="provider-default" {
            let id=item(&changed,"shift.CommitmentRequest.before").id;
            let IrItemKind::Field {default:Some(ir::IrDefault::Literal(value)),..}=&mut changed.items[id.0 as usize].kind else {panic!("default");};
            value.expr=IrExpr::DurationMs(1);
        }else{
            let IrItemKind::Scenario {effects,..}=&mut changed.items[owner.0 as usize].kind else {panic!("scenario");};
            if mode.starts_with("loop-") {
                let IrStmt::For{domain,limit:Some(limit),body,..}=&mut effects[0] else{panic!("loop");};
                match mode {
                    "loop-bound"=>limit.expr=IrExpr::Int(99),
                    "loop-filter"=>{
                        let IrExpr::Query(query)=&mut domain.expr else{panic!("query");};
                        query.where_pred.as_mut().unwrap().expr=IrExpr::Bool(true);
                    },
                    "loop-target"=>{
                        let IrStmt::Set{record,..}=&mut body[0] else{panic!("set");};
                        record.expr=IrExpr::Name("foreign".into());
                    },
                    _=>{
                        let IrStmt::If{cond,..}=&mut body[0] else{panic!("condition");};
                        let IrExpr::Unary{operand,..}=&mut cond.expr else{panic!("not");};
                        let IrExpr::Member{field,..}=&mut operand.expr else{panic!("member");};
                        *field="room_released".into();
                    },
                }
            }else if mode=="effect-order" {effects.swap(2,3);}
            else if mode=="create-path" {
                let IrStmt::Create {input,..}=&mut effects[0] else {panic!("create");};
                let IrExpr::Object(entries)=&mut input.expr else {panic!("object");};
                let (_,value)=entries.iter_mut().find(|(name,_)|name=="host").unwrap();
                let IrExpr::Member {field,..}=&mut value.expr else {panic!("host");};
                *field="account".into();
            }else{
                let IrStmt::Let {value,..}=&mut effects[0] else {panic!("first");};
                let IrExpr::Call {args,..}=&mut value.expr else {panic!("call");};
                let IrExpr::Query(query)=&mut args[0].expr else {panic!("query");};
                query.where_pred.as_mut().unwrap().expr=IrExpr::Bool(true);
            }
        }
        assert!(serialize_complete_query_receipt(&program,&changed,&changed.items[owner.0 as usize],&db,Some(&catalog),"$can$m$6170706f696e746d656e7473.mjs").is_none(),"{mode} retained altered original semantics");
    }

}

#[test]
fn parent_timezone_keeps_its_original_stored_dependency() {
    for (name,source) in [
        ("native-parent-timezone.can",include_str!("../../packages/cloudflare/test/fixtures/native-parent-timezone.can")),
        ("native-reference-timezone.can",include_str!("../../packages/cloudflare/test/fixtures/native-reference-timezone.can")),
    ] {
    let (db,program,ir,catalog)=fixture_source(name,source);
    let owner=item(&ir,"ParentTimezone.day");
    assert!(matches!(&ir.scenario_disclosures[&owner.id],ScenarioDisclosure::Complete(_)),"{:?}",ir.scenario_disclosures[&owner.id]);
    let (artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);
    assert!(diagnostics.is_empty(),"{diagnostics:?}");
    let operation=artifact["operations"].as_array().unwrap().iter().find(|value|value["name"]=="ParentTimezone.day").unwrap();
    assert!(operation["result"]["disclosure"].is_object(),"{operation}");
    for field_name in ["ParentTimezone.Resource.timezone"].into_iter().chain(
        (name=="native-reference-timezone.can").then_some("ParentTimezone.Booking.location")) {
        let mut changed=ir.clone();
        let field=changed.items.iter_mut().find(|value|value.canonical==field_name).unwrap();
        let IrItemKind::Field{ty,..}=&mut field.kind else {panic!("stored field");};
        *ty=IrType::Known(ResolvedType::Scalar(Scalar::Text));
        assert!(serialize_complete_query_receipt(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog),"$can$m$506172656e7454696d657a6f6e65.mjs").is_none(),"{field_name}: the actual stored reference and timezone declarations must remain original");
    }
}
}

#[test]
fn original_purchase_decision_keeps_nested_guard_money_closure_and_branch_correspondence() {
    use canlang_compiler::codegen::scenario_decisions::serialize_decision_sources;
    let source=include_str!("fixtures/purchase-decision-source-require.can");
    let (db,program,ir,catalog)=fixture_source("purchase-decision.can",source);
    let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);
    assert!(diagnostics.is_empty(),"{diagnostics:?}");
    let owner=item(&ir,"purchase.decide");
    assert!(serialize_decision_sources(&program,&ir,owner,&db,Some(&catalog)).is_some());
    for mode in ["branch-condition","nested-guard","guard-position","budget-helper"] {
        let mut changed=ir.clone();
        if mode=="budget-helper" {
            let field=changed.items.iter_mut().find(|item|item.canonical=="purchase.Budget.remaining").unwrap();
            let IrItemKind::DeriveField{expr,..}=&mut field.kind else{panic!("derive field");};
            expr.as_mut().unwrap().expr=IrExpr::Money{minor:0,currency:"EUR".into()};
        } else {
            let IrItemKind::Scenario{effects,..}=&mut changed.items[owner.id.0 as usize].kind else{panic!("owner");};
            let IrStmt::If{cond,then_branch,..}=&mut effects[0] else{panic!("if");};
            match mode {
                "branch-condition"=>cond.expr=IrExpr::Bool(true),
                "nested-guard"=>{let IrStmt::Require{cond,..}=&mut then_branch[0] else{panic!("require");};cond.expr=IrExpr::Bool(true);},
                "guard-position"=>then_branch.swap(0,1),
                _=>unreachable!(),
            }
        }
        assert!(serialize_decision_sources(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog)).is_none(),"{mode}");
    }
    for (name,changed) in [
        ("guard-value-copied-to-effect",source.replace("set request {state=approved,decision=reason}",
            "set request {state=approved,decision=format(\"{available}\",{available=request.parent.remaining.minor})}")),
        ("late-require",source.replace("     require request.parent.active", "     set request {decision=reason}\n     require request.parent.active")),
        ("global-budget-domain",source.replace("sum(row.Request as request where request.state==approved", "sum(Request as request where request.state==approved")),
        ("foreign-currency",source.replace("sum(row.Increase as increase select increase.amount,row.amount.currency)", "sum(row.Increase as increase select increase.amount,row.parent.total.currency)")),
    ] {
        assert_ne!(source,changed,"{name}");
        let (db,program,_,catalog)=fixture_source(&format!("{name}.can"),&changed);
        let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);
        assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{name}: {diagnostics:?}");
    }
}

#[test]
fn original_purchase_intake_keeps_unique_key_guard_and_create_correspondence() {
    use canlang_compiler::codegen::scenario_decisions::serialize_decision_sources;
    let source=include_str!("fixtures/purchase-intake-source-require.can");
    let authored=std::fs::read_to_string(root().join("draft/apps/CanPurchase/CanPurchase.can")).unwrap();
    let start=authored.find("  scenario intake_invoice(").unwrap();
    let end=start+authored[start..].find("   examples ").unwrap();
    assert!(source.contains(&authored[start..end]));
    let (db,program,ir,catalog)=fixture_source("purchase-intake.can",source);
    let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);
    assert!(diagnostics.is_empty(),"{diagnostics:?}");
    let owner=item(&ir,"purchase.intake_invoice");
    assert!(serialize_decision_sources(&program,&ir,owner,&db,Some(&catalog)).is_some());
    for mode in ["predicate","created-key","create-order"] {
        let mut changed=ir.clone();
        let IrItemKind::Scenario{effects,..}=&mut changed.items[owner.id.0 as usize].kind else{panic!("scenario");};
        match mode {
            "predicate"=>{let IrStmt::Require{cond,..}=&mut effects[0] else{panic!("guard");};cond.expr=IrExpr::Bool(true);},
            "created-key"=>{
                let IrStmt::Create{input,..}=&mut effects[1] else{panic!("create");};
                let IrExpr::Object(entries)=&mut input.expr else{panic!("input");};
                entries.iter_mut().find(|(key,_)|key=="source").unwrap().1.expr=IrExpr::Text("different".into());
            },
            "create-order"=>effects.swap(0,1),
            _=>unreachable!(),
        }
        assert!(serialize_decision_sources(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog)).is_none(),"{mode} retained altered source correspondence");
    }
    for (name,changed) in [
        ("not-unique",source.replace("source:text unique","source:text")),
        ("positive-global-scan",source.replace("require not any(InvoiceDocument","require any(InvoiceDocument")),
        ("different-create-key",source.replace("document,source=trim(source)","document,source=source")),
        ("different-guard-key",source.replace("item.source==trim(source)","item.source==source")),
        ("copied-query-data",source.replace("source=trim(source)} as invoice_document","source=format(\"{exists}\",{exists=any(InvoiceDocument as item,item.source==trim(source))})} as invoice_document")),
        ("late-guard",source.replace("    require not any(InvoiceDocument as item,item.source==trim(source))\n","")
            .replace("    return invoice_document","    require not any(InvoiceDocument as item,item.source==trim(source))\n    return invoice_document")),
    ] {
        assert_ne!(source,changed,"{name}");
        let (db,program,_,catalog)=fixture_source(&format!("{name}.can"),&changed);
        let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);
        assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{name}: {diagnostics:?}");
    }
}

#[test]
fn qualified_enum_case_is_a_literal_without_a_stored_prefix_dependency() {
    let source=include_str!("../../packages/cloudflare/test/fixtures/native-qualified-enum-case.can");
    let (db,program,ir,catalog)=fixture_source("native-qualified-enum-case.can",source);
    let owner=item(&ir,"QualifiedCase.act");
    assert!(matches!(&ir.scenario_disclosures[&owner.id],ScenarioDisclosure::Complete(_)),"{:?}",ir.scenario_disclosures[&owner.id]);
    let (artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);
    assert!(diagnostics.is_empty(),"{diagnostics:?}");
    let operation=artifact["operations"].as_array().unwrap().iter().find(|value|value["name"]=="QualifiedCase.act").unwrap();
    assert!(operation["result"]["disclosure"].is_object(),"{operation}");
    let mut changed=ir.clone();
    let IrItemKind::Scenario{effects,..}=&mut changed.items[owner.id.0 as usize].kind else {panic!("scenario");};
    let IrStmt::Set{changes,..}=&mut effects[0] else {panic!("SET");};
    let IrExpr::Object(entries)=&mut changes.expr else {panic!("fields");};
    entries.iter_mut().find(|(name,_)|name=="state").unwrap().1.expr=IrExpr::Text("ready".into());
    assert!(serialize_complete_query_receipt(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog),"$can$m$5175616c696669656443617365.mjs").is_none(),"a different SET case cannot retain the original source proof");
}

#[test]
fn declared_contract_send_seals_constructor_nested_schema_and_authored_defaults() {
    use canlang_compiler::codegen::scenario_decisions::serialize_decision_sources;
    let source=include_str!("fixtures/declared-contract-send.can");
    let (db,program,ir,catalog)=fixture_source("declared-contract-send.can",source);
    let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);
    assert!(diagnostics.is_empty(),"{diagnostics:?}");
    let owner=item(&ir,"worker.notify");
    assert!(serialize_decision_sources(&program,&ir,owner,&db,Some(&catalog)).is_some());
    for mode in ["constructor-type","constructor-field","field-type","field-order","schema-kind",
        "default-bool","default-nullable","default-array","required-array","module-source","field-bound"] {
        let mut changed=ir.clone();
        match mode {
            "module-source"=>{let module=item(&changed,"api.Detail").module;changed.modules[module.0 as usize].name="foreign".into();},
            "constructor-type"|"constructor-field"=>{
                let alternate=item(&changed,"api.Detail").id;
                let IrItemKind::Scenario{effects,..}=&mut changed.items[owner.id.0 as usize].kind else{panic!("scenario");};
                let IrStmt::Send{args,..}=&mut effects[1] else{panic!("send");};
                let IrExpr::Object(arguments)=&mut args.expr else{panic!("args");};
                let packet=&mut arguments[0].1;
                if mode=="constructor-type"{packet.ty=ResolvedType::Record{symbol:alternate,stored:false};}
                else{let IrExpr::Object(fields)=&mut packet.expr else{panic!("packet");};fields[0].0="details".into();}
            },
            "field-order"|"schema-kind"=>{
                let id=item(&changed,"api.Detail").id;
                let IrItemKind::Contract{fields,..}=&mut changed.items[id.0 as usize].kind else{panic!("contract");};
                if mode=="field-order"{fields.swap(0,1);}
                else{changed.items[id.0 as usize].kind=IrItemKind::Event{fields:fields.clone()};}
            },
            _=>{
                let name=match mode{"field-type"|"field-bound"=>"title","default-bool"=>"enabled","default-nullable"=>"note",_=>"tags"};
                let id=item(&changed,&format!("api.Detail.{name}")).id;
                let IrItemKind::Field{ty,default,required_array,modifiers,..}=&mut changed.items[id.0 as usize].kind else{panic!("field");};
                match mode {
                    "field-type"=>*ty=IrType::Known(ResolvedType::Scalar(Scalar::Int)),
                    "required-array"=>*required_array=true,
                    "field-bound"=>modifiers.min.as_mut().unwrap().expr=IrExpr::Int(1),
                    _=>{let Some(ir::IrDefault::Literal(value))=default else{panic!("literal default");};
                        value.expr=match mode{"default-bool"=>IrExpr::Bool(false),"default-nullable"=>IrExpr::Text("Substituted".into()),_=>IrExpr::Array(Vec::new())};},
                }
            },
        }
        assert!(serialize_decision_sources(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog)).is_none(),"{mode}");
    }
    for (name,changed) in [
        ("query-data",source.replace("detail=Detail {title}","detail=Detail {title=format(\"{count}\",{count=count(root.Child)})}")),
        ("derived-data",source.replace("  derive allowed(root:Root)","  derive Root.count:int=count(row.Child)\n  derive allowed(root:Root)")
            .replace("detail=Detail {title}","detail=Detail {title=format(\"{count}\",{count=root.count})}")),
        ("computed-default",source.replace("note:text?=\"Original\"","note:text?=trim(\" Original \")")),
    ] {
        assert_ne!(source,changed,"{name}");
        let (db,program,_,catalog)=fixture_source(&format!("{name}.can"),&changed);
        let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);
        assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{name}: {diagnostics:?}");
    }
}

#[test]
fn literal_format_keeps_operand_data_and_original_template_correspondence() {
    let source=include_str!("../../packages/cloudflare/test/fixtures/native-literal-format.can");
    let (db,program,ir,catalog)=fixture_source("native-literal-format.can",source);
    let owner=item(&ir,"LiteralFormat.render");
    assert!(matches!(&ir.scenario_disclosures[&owner.id],ScenarioDisclosure::Complete(_)),"{:?}",ir.scenario_disclosures[&owner.id]);
    let (artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);
    assert!(diagnostics.is_empty(),"{diagnostics:?}");
    let operation=artifact["operations"].as_array().unwrap().iter().find(|value|value["name"]=="LiteralFormat.render").unwrap();
    let dependencies=operation["result"]["disclosure"]["returns"][0]["dependencies"].as_array().unwrap();
    assert!(dependencies.iter().any(|value|value["model"]=="LiteralFormat.Root"&&value["field"]=="code"&&value["role"]=="data"));
    let mut changed=ir.clone();
    let IrItemKind::Scenario{effects,..}=&mut changed.items[owner.id.0 as usize].kind else{panic!("scenario");};
    let IrStmt::Return{value:Some(value),..}=&mut effects[1] else{panic!("return");};
    let args=match &mut value.expr{IrExpr::Call{args,..}|IrExpr::BoundCall{args,..}=>args,_=>panic!("format")};
    args[0].expr=IrExpr::Text("Substituted {code}".into());
    assert!(serialize_complete_query_receipt(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog),"$can$m$4c69746572616c466f726d6174.mjs").is_none());
}

#[test]
fn required_parent_helper_retains_original_edges_and_field_dependencies() {
    let source=include_str!("../../packages/cloudflare/test/fixtures/native-parent-helper.can");
    let (db,program,ir,catalog)=fixture_source("native-parent-helper.can",source);
    let owner=item(&ir,"ParentHelper.act");
    assert!(matches!(&ir.scenario_disclosures[&owner.id],ScenarioDisclosure::Complete(_)),"{:?}",ir.scenario_disclosures[&owner.id]);
    let (artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);
    assert!(diagnostics.is_empty(),"{diagnostics:?}");
    let operation=artifact["operations"].as_array().unwrap().iter().find(|value|value["name"]=="ParentHelper.act").unwrap();
    let dependencies=operation["result"]["disclosure"]["returns"][0]["dependencies"].as_array().unwrap();
    for (model,field) in [("ParentHelper.Child","parent"),("ParentHelper.Parent","label")] {
        assert!(dependencies.iter().any(|value|value["model"]==model&&value["field"]==field&&value["role"]=="data"),"{model}.{field}: {dependencies:?}");
    }
    let mut changed=ir.clone();
    let IrItemKind::Scenario{effects,..}=&mut changed.items[owner.id.0 as usize].kind else{panic!("scenario");};
    let IrStmt::Return{value:Some(value),..}=&mut effects[1] else{panic!("return");};
    let args=match &mut value.expr{IrExpr::Call{args,..}|IrExpr::BoundCall{args,..}=>args,_=>panic!("helper")};
    args[0].expr=IrExpr::Name("child".into());
    assert!(serialize_complete_query_receipt(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog),"$can$m$506172656e7448656c706572.mjs").is_none());
}

#[test]
fn original_event_effects_seal_defining_schema_without_mutating_source_or_payload() {
    use canlang_compiler::codegen::scenario_decisions::serialize_decision_sources;
    for (path,source,owner_name,event_name) in [
        ("source-event-emit.can",include_str!("../../packages/cloudflare/test/fixtures/native-source-require-emit.can"),"SourceGuardEmit.notify","SourceGuardEmit.Checked"),
        ("source-event-schedule.can",include_str!("../../packages/cloudflare/test/fixtures/native-source-require-schedule.can"),"SourceGuardSchedule.notify","SourceGuardSchedule.Checked"),
    ] {
        let source=source.replace("event Checked {root:Root,message:text}","event Checked {root:Root,message:text=\"Original default\"}");
        let(db,program,ir,catalog)=fixture_source(path,&source);
        let owner=item(&ir,owner_name);
        assert!(serialize_decision_sources(&program,&ir,owner,&db,Some(&catalog)).is_some(),"original {path}");
        for mode in ["field-order","field-type","field-owner","field-name","field-module","field-default","field-bound","required-array","event-kind","event-name","event-module","event-export","module-name","field-census","event-duplicate","event-canonical","field-canonical"] {
            let mut changed=ir.clone();let event=item(&changed,event_name).id;
            let IrItemKind::Event{fields}=&changed.items[event.0 as usize].kind else{panic!("event");};
            let field=fields[1];let other=fields[0];
            match mode {
                "field-order"=>{let IrItemKind::Event{fields}=&mut changed.items[event.0 as usize].kind else{unreachable!()};fields.swap(0,1);},
                "field-census"=>{let IrItemKind::Event{fields}=&mut changed.items[event.0 as usize].kind else{unreachable!()};fields.push(other);},
                "event-kind"=>changed.items[event.0 as usize].kind=IrItemKind::Contract{fields:fields.clone(),label:None},
                "event-name"=>changed.items[event.0 as usize].name="Substituted".into(),
                "event-canonical"=>changed.items[event.0 as usize].canonical="foreign.Checked".into(),
                "event-duplicate"=>{let duplicate=changed.items[event.0 as usize].clone();changed.items.push(duplicate);},
                "event-module"=>changed.items[event.0 as usize].module.0+=1,
                "event-export"=>changed.items[event.0 as usize].exported=!changed.items[event.0 as usize].exported,
                "module-name"=>{let module=changed.items[event.0 as usize].module;changed.modules[module.0 as usize].name="foreign".into();},
                "field-name"=>changed.items[field.0 as usize].name="substituted".into(),
                "field-canonical"=>changed.items[field.0 as usize].canonical="foreign.Checked.message".into(),
                "field-module"=>changed.items[field.0 as usize].module.0+=1,
                _=>{let span=changed.items[field.0 as usize].span;
                    let IrItemKind::Field{owner,ty,default,required_array,modifiers,..}=&mut changed.items[field.0 as usize].kind else{panic!("field");};
                    match mode {
                        "field-type"=>*ty=IrType::Known(ResolvedType::Scalar(Scalar::Int)),
                        "field-owner"=>*owner=other,
                        "required-array"=>*required_array=!*required_array,
                        "field-bound"=>modifiers.min=Some(ir::TypedExpr{expr:IrExpr::Int(1),ty:ResolvedType::Scalar(Scalar::Int),span}),
                        _=>*default=Some(ir::IrDefault::Literal(ir::TypedExpr{expr:IrExpr::Text("Substituted default".into()),ty:ResolvedType::Scalar(Scalar::Text),span})),
                    }
                },
            }
            assert!(serialize_decision_sources(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog)).is_none(),"{path}: event-only {mode} mutation retained original effect authority");
        }
    }
}

#[test]
fn original_invoice_document_keeps_contained_projection_and_helper_formal_correspondence() {
    use canlang_compiler::codegen::scenario_decisions::serialize_decision_sources;
    let source=include_str!("fixtures/invoice-document-source-projection.can");
    let (db,program,ir,catalog)=fixture_source("invoice-document-source-projection.can",source);
    let (artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);
    assert!(diagnostics.is_empty(),"{diagnostics:?}");
    let owner=item(&ir,"invoice.document");
    assert!(serialize_decision_sources(&program,&ir,owner,&db,Some(&catalog)).is_some());
    assert!(artifact["modules"].as_array().unwrap().iter().any(|module|module["js"].as_str().unwrap().contains("nativeScenarioSourceSendQuery")));
    let receipt=item(&ir,"invoice.generate_receipt");
    assert!(serialize_decision_sources(&program,&ir,receipt,&db,Some(&catalog)).is_some());
    let guarded=artifact["modules"].as_array().unwrap().iter().map(|module|
        module["js"].as_str().unwrap().matches("check(await nativeScenarioRequire(c,").count()).sum::<usize>();
    assert_eq!(guarded,17,"receipt, credit, correlated allowance and complete payment owners need their actual source observers");
    let module=artifact["modules"].as_array().unwrap().iter().filter_map(|module|module["js"].as_str()).find(|text|text.contains("invoice.credit_review")).unwrap();
    assert!(module.contains("if (await nativeScenarioRequire(c,"),"the original post-CREATE condition needs a real staged observer");
    let credit=item(&ir,"invoice.credit_review");
    assert!(serialize_decision_sources(&program,&ir,credit,&db,Some(&catalog)).is_some());
    for mode in ["prefix-order","condition","then-value"] {
        let mut changed=ir.clone();
        let IrItemKind::Scenario{effects,..}=&mut changed.items[credit.id.0 as usize].kind else{panic!("credit");};
        match mode {
            "prefix-order"=>effects.swap(0,1),
            "condition"=>{let IrStmt::If{cond,..}=&mut effects[1] else{panic!("if");};cond.expr=IrExpr::Bool(false);},
            _=>{let IrStmt::If{then_branch,..}=&mut effects[1] else{panic!("if");};let IrStmt::Set{changes,..}=&mut then_branch[0] else{panic!("set");};let IrExpr::Object(fields)=&mut changes.expr else{panic!("fields");};fields[0].1.expr=IrExpr::Bool(false);},
        }
        assert!(serialize_decision_sources(&program,&changed,&changed.items[credit.id.0 as usize],&db,Some(&catalog)).is_none(),"staged IF {mode}");
    }
    for (name,condition) in [
        ("staged-local","    let copied=invoice\n    if copied.refund_due.minor>0"),
        ("staged-input-version","    if invoice.refund_due.minor>0 and invoice.version==1"),
    ] {
        let changed=source.replace("    if invoice.refund_due.minor>0",condition);
        let (db,program,_,catalog)=fixture_source(&format!("{name}.can"),&changed);
        let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);
        assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{name}: {diagnostics:?}");
    }
    for (name,index) in [("refund_allowance",1),("external_refund_allowance",2)] {
        let mut changed=ir.clone();let owner=item(&changed,&format!("invoice.{name}")).id;
        let IrItemKind::Scenario{guards,..}=&mut changed.items[owner.0 as usize].kind else{panic!("scenario");};
        let IrStmt::Require{cond,..}=&mut guards[index] else{panic!("guard");};
        let IrExpr::Binary{right,..}=&mut cond.expr else{panic!("comparison");};
        let IrExpr::Binary{right,..}=&mut right.expr else{panic!("subtract");};
        let args=match &mut right.expr{IrExpr::Call{args,..}|IrExpr::BoundCall{args,..}=>args,_=>panic!("SUM")};
        let IrExpr::Query(query)=&mut args[0].expr else{panic!("query");};
        query.parent.as_mut().unwrap().expr=IrExpr::Name("payment".into());
        assert!(serialize_decision_sources(&program,&changed,&changed.items[owner.0 as usize],&db,Some(&catalog)).is_none(),"{name}");
    }
    for name in ["settled","balance","received","collection_pending","refund_pending"] {
        let mut changed=ir.clone();let field=item(&changed,&format!("invoice.Invoice.{name}")).id;
        let IrItemKind::DeriveField{expr:Some(body),..}=&mut changed.items[field.0 as usize].kind else{panic!("derive");};
        body.expr=IrExpr::Bool(true);
        assert!(serialize_decision_sources(&program,&changed,&changed.items[receipt.id.0 as usize],&db,Some(&catalog)).is_none(),"{name}");
    }
    for mode in ["projection","order","parent","helper-formal","nominal-kind","order-field-type","order-field-owner","order-field-module"] {
        let mut changed=ir.clone();
        if mode.starts_with("order-field-"){
            let id=item(&changed,"invoice.Line.position").id;
            if mode=="order-field-module"{changed.items[id.0 as usize].module=item(&changed,"customer.Customer").module;}
            else{let foreign=item(&changed,"invoice.Credit").id;
                let IrItemKind::Field{ty,owner,..}=&mut changed.items[id.0 as usize].kind else{panic!("field");};
                if mode=="order-field-type"{*ty=IrType::Known(ResolvedType::Scalar(Scalar::Text));}else{*owner=foreign;}}
        }else if mode=="nominal-kind"{
            let id=item(&changed,"invoice.DocumentLine").id;
            let IrItemKind::Contract{fields,..}=&changed.items[id.0 as usize].kind else{panic!("contract");};
            changed.items[id.0 as usize].kind=IrItemKind::Event{fields:fields.clone()};
        }else{
            let helper=item(&changed,"invoice.issued_snapshot").id;
            if mode=="helper-formal"{
                let IrItemKind::DeriveFn{params,..}=&mut changed.items[helper.0 as usize].kind else{panic!("helper");};params.swap(0,1);
            }else{
                let IrItemKind::DeriveFn{expr:Some(body),..}=&mut changed.items[helper.0 as usize].kind else{panic!("helper");};
                let IrExpr::Object(fields)=&mut body.expr else{panic!("snapshot");};
                let (_,lines)=fields.iter_mut().find(|(name,_)|name=="lines").unwrap();
                let IrExpr::Query(query)=&mut lines.expr else{panic!("query");};
                match mode{
                    "order"=>query.order[0].descending=true,
                    "parent"=>query.parent.as_mut().unwrap().expr=IrExpr::Name("foreign".into()),
                    _=>{let IrExpr::Object(fields)=&mut query.select.as_mut().unwrap().expr else{panic!("select");};fields[0].1.expr=IrExpr::Text("Substituted".into());},
                }
            }
        }
        assert!(serialize_decision_sources(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog)).is_none(),"{mode}");
    }
    let helper=source.lines().find(|line|line.starts_with("  derive issued_snapshot(")).unwrap();
    let renamed=helper.replace("(invoice:Invoice,","(subject:Invoice,").replace("invoice.","subject.");
    let (db,program,_,catalog)=fixture_source("renamed-model-formal.can",&source.replace(helper,&renamed));
    let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
    for(name,changed)in[
        ("positive-global-key",source.replace("and not any(ExternalPayment as payment,payment.reference==reference)","and any(ExternalPayment as payment,payment.reference==reference)")),
        ("disjunctive-global-key",source.replace("and not any(ExternalPayment as payment,payment.reference==reference)","or not any(ExternalPayment as payment,payment.reference==reference)")),
        ("different-created-key",source.replace("parent=invoice,amount,reference,received,evidence", "parent=invoice,amount,reference=trim(reference),received,evidence")),
        ("global-leading-sum",source.replace("sum(invoice.Attempt as old where", "sum(Attempt as old where")),
        ("ordered-leading-sum",source.replace("old.status==succeeded select old.amount,invoice.currency)","old.status==succeeded order=old.reference select old.amount,invoice.currency)")),
        ("global-derived-any",source.replace("any(row.Attempt as attempt,attempt.kind==collection", "any(Attempt as attempt,attempt.kind==collection")),
        ("foreign-derived-predicate",source.replace("attempt.kind==collection and attempt.status in", "attempt.parent.state==issued and attempt.status in")),
        ("global-domain",source.replace("invoice.Line as line order", "Line as line order")),
        ("unjoined-filter",source.replace("invoice.Line as line order", "invoice.Line as line where line.quantity>0 order")),
        ("foreign-reference",source.replace("title=line.description", "title=line.parent.issuer")),
        ("copied-receiver",source.replace("    send Documents.", "    let copy=invoice\n    send Documents.").replace("snapshot=issued_snapshot(invoice,", "snapshot=issued_snapshot(copy,")),
    ]{
        assert_ne!(source,changed,"{name}");
        let(db,program,_,catalog)=fixture_source(&format!("{name}.can"),&changed);
        let(_,diagnostics)=prepared_artifact(&program,&db,&catalog);
        assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{name}: {diagnostics:?}");
    }
}

#[test]
fn void_constructor_count_retains_required_parent_and_original_scalar_consumer() {
 let source=include_str!("fixtures/rent-restore-count-source.can");
 let (db,program,ir,catalog)=fixture_source("rent-restore-count-source.can",source);
 let owner=item(&ir,"rent_reservations.restore");
 assert!(matches!(&ir.scenario_disclosures[&owner.id],ScenarioDisclosure::Complete(_)),"{:?}",ir.scenario_disclosures[&owner.id]);
 let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);
 assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let module="$can$m$436f6e7374727563746f72436f756e74.mjs";
 let plan=serialize_complete_query_receipt(&program,&ir,owner,&db,Some(&catalog),module).expect("original count receipt");
 assert_eq!(plan["queries"].as_array().unwrap().len(),1,"leading helper belongs to its independently checked source observer");
 for mode in ["count-offset","consumer-field","parent-operand","effect-order","field-type"] {
  let mut changed=ir.clone();
  if mode=="field-type" {
   let field=item(&changed,"rent_reservations.ResourcePolicy.sequence").id;
   let IrItemKind::Field{ty,..}=&mut changed.items[field.0 as usize].kind else{panic!("field");};
   *ty=IrType::Known(ResolvedType::Scalar(Scalar::Text));
  }else{
   let IrItemKind::Scenario{effects,..}=&mut changed.items[owner.id.0 as usize].kind else{panic!("scenario");};
   if mode=="effect-order"{effects.swap(0,1);}else{
    let IrStmt::Create{input,..}=&mut effects[1] else{panic!("create");};
    let IrExpr::Object(entries)=&mut input.expr else{panic!("object");};
    if mode=="consumer-field"{entries.iter_mut().find(|(name,_)|name=="sequence").unwrap().0="baseline".into();}
    else if mode=="parent-operand"{
     let parent=&mut entries.iter_mut().find(|(name,_)|name=="parent").unwrap().1;
     let IrExpr::Member{field,..}=&mut parent.expr else{panic!("parent");};*field="location".into();
    }else{
     let value=&mut entries.iter_mut().find(|(name,_)|name=="sequence").unwrap().1;
     let IrExpr::Binary{right,..}=&mut value.expr else{panic!("add");};right.expr=IrExpr::Int(2);
    }
   }
  }
  assert!(serialize_complete_query_receipt(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog),module).is_none(),"{mode}");
 }
}

#[test]
fn created_parent_keeps_its_exact_original_create_and_required_parent_association() {
 let source=include_str!("fixtures/rent-restore-count-source.can");
 let (db,program,ir,catalog)=fixture_source("created-parent.can",source);
 let owner=item(&ir,"rent_reservations.block");
 let authored=std::fs::read_to_string(root().join("draft/apps/CanRent/CanRent.can")).unwrap();
 let start=authored.find("    create Downtime {parent=resource,source=operation.id,from,until,reason} as downtime").unwrap();
 let end=start+authored[start..].find("    create DowntimeEvidence").unwrap();
 assert!(source.contains(&authored[start..end]),"the fixture preserves both original CREATE statements");
 assert!(matches!(&ir.scenario_disclosures[&owner.id],ScenarioDisclosure::Complete(_)),"{:?}",ir.scenario_disclosures[&owner.id]);
 let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let module="$can$m$436f6e7374727563746f72436f756e74.mjs";
 assert!(serialize_complete_query_receipt(&program,&ir,owner,&db,Some(&catalog),module).is_some());
 for mode in ["parent-input","created-binding","borrowed-parent","count-parent","child-owner"] {
  let mut changed=ir.clone();
  if mode=="child-owner"{
   let child=item(&changed,"rent_reservations.Downtime").id;
   let IrItemKind::Model{owner,..}=&mut changed.items[child.0 as usize].kind else{panic!("child");};*owner=ir::IrOwner::Team;
  }else{
   let IrItemKind::Scenario{effects,..}=&mut changed.items[owner.id.0 as usize].kind else{panic!("scenario");};
   if mode=="parent-input"||mode=="created-binding"{
    let IrStmt::Create{input,binding,..}=&mut effects[0] else{panic!("source create");};
    if mode=="created-binding"{*binding=Some("copied".into());}else{
     let IrExpr::Object(fields)=&mut input.expr else{panic!("fields");};fields.iter_mut().find(|(name,_)|name=="parent").unwrap().1.expr=IrExpr::Name("other".into());
    }
   }else{
    let IrStmt::Create{input,..}=&mut effects[1] else{panic!("consumer create");};
    let IrExpr::Object(fields)=&mut input.expr else{panic!("fields");};
    if mode=="borrowed-parent"{
     let IrExpr::Member{base,..}=&mut fields.iter_mut().find(|(name,_)|name=="parent").unwrap().1.expr else{panic!("parent");};base.expr=IrExpr::Name("copied".into());
    }else{
     let IrExpr::Binary{left,..}=&mut fields.iter_mut().find(|(name,_)|name=="sequence").unwrap().1.expr else{panic!("count plus one");};
     let args=match &mut left.expr{IrExpr::Call{args,..}|IrExpr::BoundCall{args,..}=>args,_=>panic!("count")};
     let IrExpr::Query(query)=&mut args[0].expr else{panic!("domain");};
     let IrExpr::Member{base,..}=&mut query.parent.as_mut().unwrap().expr else{panic!("domain parent");};base.expr=IrExpr::Name("resource".into());
    }
   }
  }
  assert!(serialize_complete_query_receipt(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog),module).is_none(),"{mode}");
 }
 for (name,changed) in [
  ("copied-created",source.replace("    create ResourcePolicy {parent=downtime.parent,sequence=count(downtime.parent.ResourcePolicy)+1,value=resource_evidence(downtime.parent)} as policy_snapshot_1\n  scenario restore", "    let copied=downtime\n    create ResourcePolicy {parent=copied.parent,sequence=count(copied.parent.ResourcePolicy)+1,value=resource_evidence(copied.parent)} as policy_snapshot_1\n  scenario restore")),
  ("copied-input",source.replace("    create Downtime {parent=resource,source=operation.id", "    let copied=resource\n    create Downtime {parent=copied,source=operation.id")),
 ] {
  assert_ne!(source,changed,"{name}");
  let (db,program,_,catalog)=fixture_source(&format!("{name}.can"),&changed);
  let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{name}: {diagnostics:?}");
 }
}

#[test]
fn source_only_emit_data_seals_helper_formals_and_nominal_event_payload() {
    use canlang_compiler::codegen::scenario_decisions::serialize_decision_sources;
    let source=include_str!("../../packages/cloudflare/test/fixtures/native-source-emit-data.can");
    let(db,program,ir,catalog)=fixture_source("source-emit-data.can",source);
    let(_,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
    let owner=item(&ir,"SourceEmitData.notify");
    assert!(serialize_decision_sources(&program,&ir,owner,&db,Some(&catalog)).is_some());
    let input=item(&ir,"SourceEmitData.input");
    assert!(serialize_decision_sources(&program,&ir,input,&db,Some(&catalog)).is_some());
    for name in ["SourceEmitData.Snapshot.title","SourceEmitData.Snapshot.reason"]{
        let mut changed=ir.clone();let field=item(&changed,name).id;
        let IrItemKind::Field{ty,..}=&mut changed.items[field.0 as usize].kind else{panic!("Contract field");};
        *ty=IrType::Known(ResolvedType::Scalar(Scalar::Int));
        assert!(serialize_decision_sources(&program,&changed,&changed.items[input.id.0 as usize],&db,Some(&catalog)).is_none(),"supplied nominal Event Contract schema {name}");
    }
    for mode in ["helper-field","helper-formal","contract-field","contract-order","event-field","event-default"]{
        let mut changed=ir.clone();
        match mode{
            "helper-field"=>{let helper=item(&changed,"SourceEmitData.snapshot").id;
                let IrItemKind::DeriveFn{expr:Some(value),..}=&mut changed.items[helper.0 as usize].kind else{panic!("helper");};
                let IrExpr::Object(fields)=&mut value.expr else{panic!("object");};
                let IrExpr::Member{field,..}=&mut fields[0].1.expr else{panic!("source");};*field="secret".into();},
            "helper-formal"=>{let helper=item(&changed,"SourceEmitData.snapshot").id;
                let IrItemKind::DeriveFn{params,..}=&changed.items[helper.0 as usize].kind else{panic!("helper");};let param=params[0];
                let IrItemKind::Param{index,..}=&mut changed.items[param.0 as usize].kind else{panic!("formal");};*index+=1;},
            "contract-order"=>{let contract=item(&changed,"SourceEmitData.Snapshot").id;
                let IrItemKind::Contract{fields,..}=&mut changed.items[contract.0 as usize].kind else{panic!("contract");};fields.swap(0,1);},
            _=>{let name=if mode=="contract-field"{"SourceEmitData.Snapshot.title"}else{"SourceEmitData.Checked.value"};let field=item(&changed,name).id;
                let IrItemKind::Field{ty,default,..}=&mut changed.items[field.0 as usize].kind else{panic!("field");};
                if mode=="event-default"{*default=Some(ir::IrDefault::Literal(ir::TypedExpr{expr:IrExpr::Null,ty:ResolvedType::Null,span:owner.span}));}
                else{*ty=IrType::Known(ResolvedType::Scalar(Scalar::Int));}},
        }
        assert!(serialize_decision_sources(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog)).is_none(),"{mode}");
    }
}

#[test]
fn booking_report_contract_array_data_retains_its_owning_schema_and_field() {
 let source=include_str!("fixtures/rent-booking-report-source.can");
 let (db,program,ir,catalog)=fixture_source("booking-report.can",source);
 let owner=item(&ir,"rent_reservations.depart");
 assert!(matches!(&ir.scenario_disclosures[&owner.id],ScenarioDisclosure::Complete(_)),"{:?}",ir.scenario_disclosures[&owner.id]);
 let (artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let operation=artifact["operations"].as_array().unwrap().iter().find(|operation|operation["name"]==owner.canonical).unwrap();
 assert!(operation["result"]["disclosure"].is_object(),"{operation}");
 let original=std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../draft/apps/CanRent/CanRent.can")).unwrap();
 for prefix in ["contract BookingInterval ","contract ReportBooking ","derive report_booking("] {
  assert_eq!(source.lines().find(|line|line.trim_start().starts_with(prefix)).unwrap().trim(),
    original.lines().find(|line|line.trim_start().starts_with(prefix)).unwrap().trim(),"original {prefix}");
 }
 for mode in ["contract-order","contract-leaf","contract-owner","enum-owner","enum-cases"] {
  let mut changed=ir.clone();
  if mode=="contract-order" {
   let id=item(&changed,"rent_reservations.BookingInterval").id;
   let IrItemKind::Contract{fields,..}=&mut changed.items[id.0 as usize].kind else{panic!("contract");};fields.swap(0,1);
  }else if mode.starts_with("enum") {
   let id=item(&changed,"rent_reservations.Booking.status").id;
   let other=item(&changed,"rent_reservations.Booking.quantity").id;
   let IrItemKind::Field{ty:IrType::Known(ResolvedType::Enum{owner,cases}),..}=&mut changed.items[id.0 as usize].kind else{panic!("enum");};
   if mode=="enum-owner"{*owner=Some(other);}else{cases.swap(0,1);}
  }else{
   let id=item(&changed,"rent_reservations.BookingInterval.until").id;
   let other=item(&changed,"rent_reservations.ReportBooking").id;
   let IrItemKind::Field{ty,owner,..}=&mut changed.items[id.0 as usize].kind else{panic!("leaf");};
   if mode=="contract-owner"{*owner=other;}else{*ty=IrType::Known(ResolvedType::Scalar(Scalar::Text));}
  }
  assert!(serialize_complete_query_receipt(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog),"$can$m$426f6f6b696e675265706f7274.mjs").is_none(),"{mode}");
 }
 for (name,leaf) in [("file","file?"),("model","Booking?")] {
  let changed=source.replace("contract BookingInterval { from:datetime, until:datetime }",&format!("contract BookingInterval {{ from:datetime, until:datetime, authority:{leaf} }}"));
  assert_ne!(source,changed);
  let(db,program,changed_ir,catalog)=fixture_source(&format!("protected-{name}.can"),&changed);
  let changed_owner=item(&changed_ir,"rent_reservations.depart");
  assert!(!matches!(changed_ir.scenario_disclosures[&changed_owner.id],ScenarioDisclosure::Complete(_)),"{name}");
  assert!(serialize_complete_query_receipt(&program,&changed_ir,changed_owner,&db,Some(&catalog),"$can$m$426f6f6b696e675265706f7274.mjs").is_none(),"{name}");
 }
}

#[test]
fn original_model_helper_identity_retains_required_stored_reference() {
 let source=include_str!("fixtures/helper-reference-identity.can");
 let(db,program,ir,catalog)=fixture_source("helper-reference-identity.can",source);
 let owner=item(&ir,"worker.prepare");
 assert!(matches!(ir.scenario_disclosures[&owner.id],ScenarioDisclosure::Complete(_)),"{:?}",ir.scenario_disclosures[&owner.id]);
 let (artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let operation=artifact["operations"].as_array().unwrap().iter().find(|operation|operation["name"]==owner.canonical).unwrap();
 assert!(operation["result"]["disclosure"].is_object(),"{operation}");
 for mode in ["field-type","helper-substitution","helper-formal"] {
  let mut changed=ir.clone();
  if mode=="field-type" {
   let id=item(&changed,"worker.Booking.customer").id;
   let IrItemKind::Field{ty,..}=&mut changed.items[id.0 as usize].kind else{panic!("field");};
   *ty=IrType::Known(ResolvedType::Nullable(Box::new(match ty {IrType::Known(value)=>value.clone(),_=>panic!("known")})));
  } else {
   let id=item(&changed,"worker.benefit_request").id;
   let IrItemKind::DeriveFn{params,expr:Some(body),..}=&mut changed.items[id.0 as usize].kind else{panic!("helper");};
   if mode=="helper-substitution" {
    let IrExpr::Object(fields)=&mut body.expr else{panic!("construct");};
    let IrExpr::Member{base,..}=&mut fields[0].1.expr else{panic!("id");};
    let IrExpr::Member{field,..}=&mut base.expr else{panic!("reference");};*field="visible".into();
   } else {
    let parameter=params[0];let IrItemKind::Param{index,..}=&mut changed.items[parameter.0 as usize].kind else{panic!("formal");};*index=1;
   }
  }
  assert!(serialize_complete_query_receipt(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog),"$can$m$48656c7065724964656e74697479.mjs").is_none(),"{mode}");
 }
 let copied=source.replace("    set booking {checked=true}","    let copy=booking\n    set booking {checked=true}").replace("benefit_request(booking)}","benefit_request(copy)}");
 let(_,_,copied_ir,_)=fixture_source("copied-helper-input.can",&copied);
 let copied_owner=item(&copied_ir,"worker.prepare");
 assert!(!matches!(copied_ir.scenario_disclosures[&copied_owner.id],ScenarioDisclosure::Complete(_)));
}

#[test]
fn original_helper_parent_reference_keeps_containment_and_field_identity() {
 let source=include_str!("fixtures/helper-parent-reference-identity.can");
 let(db,program,ir,catalog)=fixture_source("helper-parent-reference-identity.can",source);
 let owner=item(&ir,"worker.prepare");
 assert!(matches!(ir.scenario_disclosures[&owner.id],ScenarioDisclosure::Complete(_)),"{:?}",ir.scenario_disclosures[&owner.id]);
 let (artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let operation=artifact["operations"].as_array().unwrap().iter().find(|operation|operation["name"]==owner.canonical).unwrap();
 assert!(operation["result"]["disclosure"].is_object(),"{operation}");
 for mode in ["helper-parent-receiver","schema-parent","location-target"] {
  let mut changed=ir.clone();
  if mode=="schema-parent" {
   let id=item(&changed,"worker.Booking").id;
   let IrItemKind::Model{owner,..}=&mut changed.items[id.0 as usize].kind else{panic!("model");};*owner=canlang_compiler::codegen::ir::IrOwner::App;
  }else if mode=="location-target" {
   let id=item(&changed,"worker.Resource.location").id;let other=item(&changed,"api.Customer").id;
   let IrItemKind::Field{ty,..}=&mut changed.items[id.0 as usize].kind else{panic!("field");};*ty=IrType::Known(ResolvedType::Record{symbol:other,stored:true});
  }else{
   let id=item(&changed,"worker.benefit_request").id;
   let IrItemKind::DeriveFn{expr:Some(body),..}=&mut changed.items[id.0 as usize].kind else{panic!("helper");};
   let IrExpr::Object(fields)=&mut body.expr else{panic!("object");};
   let IrExpr::Member{base:location,..}=&mut fields[1].1.expr else{panic!("id");};
   let IrExpr::Member{base:parent,..}=&mut location.expr else{panic!("location");};
   let IrExpr::Member{base,..}=&mut parent.expr else{panic!("parent");};base.expr=IrExpr::Name("other".into());
  }
  assert!(serialize_complete_query_receipt(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog),"$can$m$48656c7065724964656e74697479.mjs").is_none(),"{mode}");
 }
}

#[test]
fn contained_cancel_loop_preserves_original_domain_work_and_delivery_carrier() {
    use canlang_compiler::codegen::scenario_decisions::serialize_decision_sources;
    let full=include_str!("../../packages/cloudflare/test/fixtures/invoice-credit-loop-source.can");
    let source=format!("{}{}",&full[..full.find("  scenario collected on=").unwrap()],&full[full.find("  scenario cancel_pending(").unwrap()..]);
    let source=source.lines().filter(|line|!line.starts_with("  derive first_paid_invoice(")).collect::<Vec<_>>().join("\n");
    let source=source.as_str();
    let (db,program,ir,catalog)=fixture_source("invoice-credit-loop-source.can",source);
    let (artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);
    assert!(diagnostics.is_empty(),"{diagnostics:?}");
    let owner=item(&ir,"invoice.cancel_pending");
    assert!(serialize_decision_sources(&program,&ir,owner,&db,Some(&catalog)).is_some());
    let code=artifact["modules"].as_array().unwrap().iter().filter_map(|module|module["js"].as_str()).collect::<Vec<_>>().join("\n");
    assert!(code.contains("canScenarioBodyLoopSources"));assert!(code.contains("nativeScenarioSourceLoopItem"));
    assert!(code.contains("nativeScenarioSourceSendData"));
    for mode in ["bound","parent","filter","target","operation","binding","create-parent","carrier"]{
        let mut changed=ir.clone();
        {
            let IrItemKind::Scenario{effects,..}=&mut changed.items[owner.id.0 as usize].kind else{panic!("scenario");};
            let IrStmt::For{domain,limit:Some(limit),body,..}=&mut effects[0] else{panic!("loop");};
            match mode{
                "bound"=>limit.expr=IrExpr::Int(101),
                "parent"|"filter"=>{let IrExpr::Query(query)=&mut domain.expr else{panic!("query");};
                    if mode=="parent"{query.parent.as_mut().unwrap().expr=IrExpr::Name("foreign".into());}
                    else{query.where_pred.as_mut().unwrap().expr=IrExpr::Bool(true);}},
                "target"=>{let IrStmt::Set{record,..}=&mut body[0] else{panic!("set");};record.expr=IrExpr::Name("invoice".into());},
                "operation"|"binding"=>{let IrStmt::Send{operation,deployment_binding,..}=&mut body[1] else{panic!("send");};
                    if mode=="operation"{*operation="std.PaymentsV1.refund".into();}else{*deployment_binding=Some("foreign.payments".into());}},
                "create-parent"|"carrier"=>{let IrStmt::Create{input,..}=&mut body[2] else{panic!("create");};let IrExpr::Object(fields)=&mut input.expr else{panic!("object");};
                    let field=if mode=="carrier"{"cancellation"}else{"parent"};
                    fields.iter_mut().find(|(name,_)|name==field).unwrap().1.expr=IrExpr::Name("foreign".into());},
                _=>unreachable!(),
            }
        }
        assert!(serialize_decision_sources(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog)).is_none(),"{mode}");
    }
    for(name,changed)in[
        ("oversized",source.replace("in [pending,unknown] limit=100\n     set attempt", "in [pending,unknown] limit=201\n     set attempt")),
        ("global",source.replace("for attempt in invoice.Attempt as candidate", "for attempt in Attempt as candidate")),
        ("data-alias",source.replace("send Payments.cancel {reference=attempt.reference}","let alias=attempt\n     send Payments.cancel {reference=alias.reference}")),
    ]{
        let (db,program,_,catalog)=fixture_source(&format!("{name}.can"),&changed);
        let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);
        assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{name}: {diagnostics:?}");
    }
}

#[test]
fn original_settlement_emit_seals_derived_aggregate_data_closure() {
    use canlang_compiler::codegen::scenario_decisions::serialize_decision_sources;
    let source=include_str!("fixtures/invoice-document-source-projection.can");
    let(db,program,ir,catalog)=fixture_source("invoice-settlement-source.can",source);
    let(artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
    let owner=item(&ir,"invoice.record_payment");
    assert!(artifact["modules"].as_array().unwrap().iter().any(|module|module["js"].as_str().unwrap().contains("nativeScenarioSourceEmitQuery")));
    assert!(serialize_decision_sources(&program,&ir,owner,&db,Some(&catalog)).is_some());
    for mode in ["derived-body","refunded-body","derived-filter","derived-owner","derived-type","helper-formal","contract-order","child-predicate"]{
        let mut changed=ir.clone();
        match mode{
            "derived-body"|"refunded-body"|"derived-filter"|"derived-owner"|"derived-type"=>{
                let id=item(&changed,if mode=="refunded-body"{"invoice.Invoice.refunded"}else{"invoice.Invoice.received"}).id;
                let IrItemKind::DeriveField{expr,model,ty,..}=&mut changed.items[id.0 as usize].kind else{panic!("derive");};
                if mode=="derived-body"||mode=="refunded-body"{let value=expr.as_mut().unwrap();value.expr=IrExpr::Money{minor:0,currency:"EUR".into()};}
                else if mode=="derived-filter"{
                    let IrExpr::Binary{left,..}=&mut expr.as_mut().unwrap().expr else{panic!("aggregate addition");};
                    let args=match &mut left.expr{IrExpr::Call{args,..}|IrExpr::BoundCall{args,..}=>args,_=>panic!("sum")};
                    let query=args.iter_mut().find_map(|value|match &mut value.expr{IrExpr::Query(query)=>Some(query),_=>None}).unwrap();
                    query.where_pred.as_mut().unwrap().expr=IrExpr::Bool(true);
                }
                else if mode=="derived-owner"{model.0+=1;}
                else{*ty=IrType::Known(ResolvedType::Scalar(Scalar::Bool));}
            },
            "helper-formal"=>{
                let helper=item(&changed,"invoice.settlement");let IrItemKind::DeriveFn{params,..}=&helper.kind else{panic!("helper");};let id=params[0];
                let IrItemKind::Param{index,..}=&mut changed.items[id.0 as usize].kind else{panic!("formal");};*index+=1;
            },
            "contract-order"=>{
                let id=item(&changed,"invoice.Settlement").id;
                let IrItemKind::Contract{fields,..}=&mut changed.items[id.0 as usize].kind else{panic!("contract");};fields.swap(0,1);
            },
            "child-predicate"=>{
                let id=item(&changed,"invoice.settlement").id;
                let IrItemKind::DeriveFn{expr:Some(body),..}=&mut changed.items[id.0 as usize].kind else{panic!("helper");};
                let IrExpr::Object(fields)=&mut body.expr else{panic!("object");};
                let pending=&mut fields.iter_mut().find(|(name,_)|name=="collection_pending").unwrap().1;
                let args=match &mut pending.expr{IrExpr::Call{args,..}|IrExpr::BoundCall{args,..}=>args,_=>panic!("any")};
                let predicate=args.iter_mut().find_map(|value|match &mut value.expr{IrExpr::Lambda{body,..}=>Some(body),_=>None}).unwrap();
                predicate.expr=IrExpr::Bool(false);
            },
            _=>unreachable!(),
        }
        assert!(serialize_decision_sources(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog)).is_none(),"{mode}");
    }
}

#[test]
fn native_scalar_data_egress_keeps_its_real_void_mutation_receipt() {
 let source=include_str!("fixtures/native-data-egress-source.can");
 let(db,program,ir,catalog)=fixture_source("native-data-egress-source.can",source);
 let(artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
 for name in ["worker.act","worker.capture"]{
  let owner=item(&ir,name);assert!(matches!(ir.scenario_disclosures[&owner.id],ScenarioDisclosure::Complete(_)));
  let operation=artifact["operations"].as_array().unwrap().iter().find(|operation|operation["name"]==name).unwrap();
  assert!(operation["result"]["disclosure"].is_object(),"{operation}");
  for field in ["amount","reference","state"]{assert!(operation["result"]["disclosure"]["returns"].as_array().unwrap().iter()
    .flat_map(|returned|returned["dependencies"].as_array().unwrap()).any(|dependency|dependency["role"]=="data"&&dependency["field"]==field));}
 }
}

#[test]
fn created_refund_send_keeps_original_create_binding_stage_and_scalar_sources() {
    use canlang_compiler::codegen::scenario_decisions::serialize_decision_sources;
    let full=include_str!("../../packages/cloudflare/test/fixtures/invoice-created-send-source.can");
    let source=format!("{}{}",&full[..full.find("  scenario collected on=").unwrap()],&full[full.find("  scenario refund_source(").unwrap()..]);
    let source=source.lines().filter(|line|!line.starts_with("  derive first_paid_invoice(")).collect::<Vec<_>>().join("\n");
    let (db,program,ir,catalog)=fixture_source("created-refund-send.can",&source);
    let (artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
    let owner=item(&ir,"invoice.refund_source");assert!(serialize_decision_sources(&program,&ir,owner,&db,Some(&catalog)).is_some());
    let code=artifact["modules"].as_array().unwrap().iter().filter_map(|module|module["js"].as_str()).collect::<Vec<_>>().join("\n");
    assert!(code.contains("nativeScenarioSourceSendData(c"));assert!(code.contains("\\\"created\\\""));assert!(code.contains("\\\"parentParameter\\\":\\\"invoice\\\""));
    for mode in ["binding","parent","created-value","created-root","operation","stage"]{
        let mut changed=ir.clone();let IrItemKind::Scenario{effects,..}=&mut changed.items[owner.id.0 as usize].kind else{panic!("owner");};
        if mode=="stage"{effects.swap(0,2);}
        else if mode=="operation"||mode=="created-root"{
            let IrStmt::Send{operation,args,..}=&mut effects[1] else{panic!("send");};
            if mode=="operation"{*operation="std.PaymentsV1.collect".into();}
            else{let IrExpr::Object(fields)=&mut args.expr else{panic!("args");};let value=&mut fields.iter_mut().find(|(name,_)|name=="reference").unwrap().1;
                let IrExpr::Member{base,..}=&mut value.expr else{panic!("created scalar");};base.expr=IrExpr::Name("payment".into());}
        }else{
            let IrStmt::Create{binding,input,..}=&mut effects[0] else{panic!("create");};
            if mode=="binding"{*binding=Some("foreign".into());}
            else{let IrExpr::Object(fields)=&mut input.expr else{panic!("input");};let field=if mode=="parent"{"parent"}else{"reference"};
                fields.iter_mut().find(|(name,_)|name==field).unwrap().1.expr=if mode=="parent"{IrExpr::Name("payment".into())}else{IrExpr::Text("substituted".into())};}
        }
        assert!(serialize_decision_sources(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog)).is_none(),"{mode}");
    }
    let copied=source.replace("    send Payments.refund {payment=payment.reference,amount,reference=refund.reference}","    let copy=refund\n    send Payments.refund {payment=payment.reference,amount,reference=copy.reference}");
    let (db,program,_,catalog)=fixture_source("copied-created-refund.can",&copied);
    let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{diagnostics:?}");
}


#[test]
fn original_entitlement_helper_keeps_imported_reference_identity() {
 let source=include_str!("fixtures/helper-entitlement-original.can");
 let(db,program,ir,catalog)=fixture_source("helper-entitlement-original.can",source);
 let owner=item(&ir,"rent_reservations.prepare");
 assert!(matches!(ir.scenario_disclosures[&owner.id],ScenarioDisclosure::Complete(_)),"{:?}",ir.scenario_disclosures[&owner.id]);
 let (artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let operation=artifact["operations"].as_array().unwrap().iter().find(|operation|operation["name"]==owner.canonical).unwrap();
 assert!(operation["result"]["disclosure"].is_object(),"{operation}");
 assert_eq!(operation["result"]["disclosure"]["queries"].as_array().map_or(0,Vec::len),0,"literal Values FIRST grants no records query");
 let project=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
 for (path,prefix) in [("draft/apps/CanRent/CanRent.can","derive benefit_request("),("draft/apps/CanRent/CanRent.can","derive membership_unit("),
   ("draft/apps/CanMember/CanMember.can","export contract Entitlement "),("draft/apps/CanMember/CanMember.can","export contract BenefitInterval ")] {
  let original=std::fs::read_to_string(project.join(path)).unwrap();
  assert_eq!(source.lines().find(|line|line.trim_start().starts_with(prefix)).unwrap().trim(),
   original.lines().find(|line|line.trim_start().starts_with(prefix)).unwrap().trim());
 }
 for mode in ["unused-case","declaring-owner","foreign-owner","predicate","literal"] {
  let mut changed=ir.clone();
  if mode=="declaring-owner" {
   let other=item(&changed,"rent_reservations.Resource").id;let id=item(&changed,"member_terms.Benefit.unit").id;
   let IrItemKind::Field{owner,..}=&mut changed.items[id.0 as usize].kind else{panic!("owner");};*owner=other;
  }else if mode=="unused-case" {
   let id=item(&changed,"member_terms.Benefit.unit").id;
   let IrItemKind::Field{ty:IrType::Known(ResolvedType::Enum{cases,..}),..}=&mut changed.items[id.0 as usize].kind else{panic!("enum");};cases.push("week".into());
  }else{
   let other=item(&changed,"rent_reservations.Resource.price_unit").id;
   let id=item(&changed,"rent_reservations.membership_unit").id;
   let IrItemKind::DeriveFn{expr:Some(body),..}=&mut changed.items[id.0 as usize].kind else{panic!("helper");};
   let IrExpr::Binary{left,..}=&mut body.expr else{panic!("fallback");};
   let IrExpr::Call{args,..}=&mut left.expr else{panic!("first");};
   let IrExpr::Query(query)=&mut args[0].expr else{panic!("query");};
   if mode=="predicate"{query.where_pred.as_mut().unwrap().expr=IrExpr::Bool(false);}else{
    let canlang_compiler::codegen::ir::IrQueryDomain::Value{base,..}=&mut query.domain else{panic!("Values");};
    let IrExpr::Array(entries)=&mut base.expr else{panic!("literal");};
    if mode=="literal"{entries[0].expr=IrExpr::Text("day".into());}else{
     let ResolvedType::Array{element,..}=&mut base.ty else{panic!("type");};
     let ResolvedType::Enum{owner,..}=element.as_mut() else{panic!("enum type");};*owner=Some(other);
     for entry in entries{entry.ty=element.as_ref().clone();}
    }
   }
  }
  assert!(serialize_complete_query_receipt(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog),"$can$m$456e7469746c656d656e74536f75726365.mjs").is_none(),"{mode}");
 }
}

#[test]
fn affiliate_scalar_let_and_created_schedule_keep_exact_original_source() {
    use canlang_compiler::codegen::scenario_decisions::serialize_decision_sources;
    let source=include_str!("fixtures/affiliate-created-schedule.can");
    let(db,program,ir,catalog)=fixture_source("affiliate-created-schedule.can",source);
    let(artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
    let owner=item(&ir,"affiliate.settle");
    assert!(serialize_decision_sources(&program,&ir,owner,&db,Some(&catalog)).is_some());
    let code=artifact["modules"].as_array().unwrap().iter().filter_map(|module|module["js"].as_str()).collect::<Vec<_>>().join("\n");
    assert!(code.contains("nativeScenarioSourceLetData(c,"));assert!(code.contains("nativeScenarioSourceSchedule(c,"));
    for mode in ["let-field","let-root","let-stage","create-binding","create-parent","schedule-key","schedule-time","schedule-owner","schedule-payload","field-type"] {
        let mut changed=ir.clone();
        if mode=="field-type" {let field=item(&changed,"affiliate.Partner.provider_account").id;let IrItemKind::Field{ty,..}=&mut changed.items[field.0 as usize].kind else{panic!("field")};*ty=IrType::Known(ResolvedType::Scalar(Scalar::Int));}
        else {
            let IrItemKind::Scenario{effects,..}=&mut changed.items[owner.id.0 as usize].kind else{panic!("owner")};
            if mode=="let-stage" {effects.swap(0,2);}
            else if mode.starts_with("let-"){let IrStmt::Let{value,..}=&mut effects[0] else{panic!("let")};let IrExpr::Member{base,field}=&mut value.expr else{panic!("member")};if mode=="let-field"{*field="provider_state".into();}else{base.expr=IrExpr::Name("foreign".into());}}
            else if mode.starts_with("create-"){let IrStmt::Create{binding,input,..}=&mut effects[2] else{panic!("create")};if mode=="create-binding"{*binding=Some("foreign".into());}else{let IrExpr::Object(fields)=&mut input.expr else{panic!("input")};fields.iter_mut().find(|(name,_)|name=="parent").unwrap().1.expr=IrExpr::Name("foreign".into());}}
            else {let IrStmt::Schedule{key,at,owner_package,payload,..}=&mut effects[3] else{panic!("schedule")};match mode{
                "schedule-key"=>key.expr=IrExpr::Text("substituted".into()),
                "schedule-time"=>at.expr=IrExpr::DurationMs(123),
                "schedule-owner"=>*owner_package="foreign".into(),
                _=>{let IrExpr::Object(fields)=&mut payload.expr else{panic!("payload")};fields[0].1.expr=IrExpr::Name("partner".into());},
            }}
        }
        if mode=="field-type" {
            // Header control metadata alone grants no LET DATA. The independent
            // LET field declaration seal must reject during complete emission.
            let emitted=js::emit_program_with_native_source_receipts(&changed,true,&db);
            assert!(emitted.diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{mode}: {:?}",emitted.diagnostics);
        }else{assert!(serialize_decision_sources(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog)).is_none(),"{mode} retained source authority");}
    }
}

#[test]
fn original_no_show_retains_required_event_identity_and_complete_created_tail() {
 use canlang_compiler::codegen::scenario_decisions::serialize_decision_sources;
 let source=include_str!("fixtures/rent-original-emission.can");
 let(db,program,ir,catalog)=fixture_source("rent-original-emission.can",source);
 let(_,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let owner=item(&ir,"rent_reservations.no_show");assert!(matches!(ir.scenario_disclosures[&owner.id],ScenarioDisclosure::Complete(_)));
 assert!(serialize_decision_sources(&program,&ir,owner,&db,Some(&catalog)).is_some());
 for mode in ["emitted-root","revision","effect-order","event-type"]{
  let mut changed=ir.clone();
  if mode=="event-type"{let field=item(&changed,"rent_reservations.ReservationChanged.booking").id;let IrItemKind::Field{ty,..}=&mut changed.items[field.0 as usize].kind else{panic!("field")};*ty=IrType::Known(ResolvedType::Scalar(Scalar::Text));}
  else{let IrItemKind::Scenario{effects,..}=&mut changed.items[owner.id.0 as usize].kind else{panic!("owner")};
   if mode=="effect-order"{effects.swap(0,3);}else{let IrStmt::Emit{payload,..}=&mut effects[3] else{panic!("emit")};let IrExpr::Object(fields)=&mut payload.expr else{panic!("payload")};if mode=="emitted-root"{fields[0].1.expr=IrExpr::Name("foreign".into());}else{fields[1].1.expr=IrExpr::Int(999);}}
  }
  let emitted=js::emit_program_with_native_source_receipts(&changed,true,&db);assert!(emitted.diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{mode}: {:?}",emitted.diagnostics);
 }
 for altered in [source.replace("emit ReservationChanged {booking,revision=booking.version+1}","let copied=booking\n    emit ReservationChanged {booking=copied,revision=booking.version+1}")]{
  let(db,program,_,catalog)=fixture_source("different-root-event.can",&altered);let(_,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{diagnostics:?}");
 }
}

#[test]
fn original_quote_derived_contract_seals_body_schema_and_child_domain() {
 let source=include_str!("fixtures/propose-document-derived-contract.can");
 let(db,program,_,catalog)=fixture_source("quote-derived-contract.can",source);
 let(artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);
 assert!(diagnostics.is_empty(),"{diagnostics:?}");
 assert!(artifact["operations"].as_array().unwrap().iter().any(|operation|operation["name"]=="propose.document"));
 for name in ["propose.QuoteLine.title","propose.QuoteInterval.from","propose.Revision.intervals"]{
  let(db,mut changed,_,catalog)=fixture_source("quote-schema-substitution.can",source);
  let field=changed.symbols.iter().find(|symbol|symbol.canonical==name).unwrap().id;
  changed.types.symbol_types.insert(field,ResolvedType::Scalar(Scalar::Int));
  let(_,diagnostics)=prepared_artifact(&changed,&db,&catalog);
  assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{name}: {diagnostics:?}");
 }
 for (mode,member) in [("protected-file","file"),("stored-model","Revision")]{
  let changed=source.replace("export contract QuoteInterval { from:datetime, until:datetime }",&format!("export contract QuoteInterval {{ from:{member}, until:datetime }}"));
  assert_ne!(source,changed);
  let(db,program,_,catalog)=fixture_source(&format!("quote-{mode}.can"),&changed);
  let(_,diagnostics)=prepared_artifact(&program,&db,&catalog);
  assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{mode}: {diagnostics:?}");
 }
}

#[test]
fn original_departure_keeps_its_cancel_key_and_constructor_stage() {
 use canlang_compiler::codegen::scenario_decisions::serialize_decision_sources;
 let source=include_str!("fixtures/rent-original-emission.can");let(db,program,ir,catalog)=fixture_source("rent-original-emission.can",source);
 let(_,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let owner=item(&ir,"rent_reservations.depart");assert!(serialize_decision_sources(&program,&ir,owner,&db,Some(&catalog)).is_some());
 for mode in ["key","scope","stage","count"]{
  let mut changed=ir.clone();let IrItemKind::Scenario{effects,..}=&mut changed.items[owner.id.0 as usize].kind else{panic!("owner")};
  match mode{
   "key"|"scope"=>{let IrStmt::Cancel{key,owner_package,..}=&mut effects[0]else{panic!("cancel")};if mode=="key"{key.expr=IrExpr::Text("foreign:occupancy".into());}else{*owner_package="foreign".into();}},
   "stage"=>effects.swap(0,2),
   _=>{let IrStmt::Create{input,..}=&mut effects[2]else{panic!("create")};let IrExpr::Object(fields)=&mut input.expr else{panic!("input")};fields.iter_mut().find(|(name,_)|name=="sequence").unwrap().1.expr=IrExpr::Int(99);},
  }
  assert!(serialize_decision_sources(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog)).is_none(),"{mode} borrowed original cancellation/count authority");
 }
}

#[test]
fn contained_sibling_constructor_preserves_native_prefix_and_original_loop_closure() {
 let source=include_str!("fixtures/rent-block-loop-source.can");
 let (db,program,ir,catalog)=fixture_source("rent-block-loop-source.can",source);
 let owner=item(&ir,"rent_reservations.block");
 assert!(matches!(&ir.scenario_disclosures[&owner.id],ScenarioDisclosure::Complete(_)),"{:?}",ir.scenario_disclosures[&owner.id]);
 let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let module="$can$m$436f6e7374727563746f72436f756e74.mjs";
 assert!(serialize_complete_query_receipt(&program,&ir,owner,&db,Some(&catalog),module).is_some());
 let unprepared=js::emit_program_with_native_source_receipts(&ir,true,&db);
 assert!(unprepared.diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"raw IR cannot issue the private loop producer");
 for mode in ["limit","parent","predicate","reference","create-parent","helper","field-type","child-owner","default"] {
  let mut changed=ir.clone();
  if mode=="helper" {
   let helper=item(&changed,"rent_reservations.busy").id;
   let IrItemKind::DeriveFn{expr:Some(value),..}=&mut changed.items[helper.0 as usize].kind else{panic!("helper");};value.expr=IrExpr::Bool(true);
  }else if mode=="default" {
   let field=item(&changed,"rent_reservations.Conflict.resolved").id;
   let IrItemKind::Field{default:Some(ir::IrDefault::Literal(value)),..}=&mut changed.items[field.0 as usize].kind else{panic!("default");};value.expr=IrExpr::Bool(true);
  }else if mode=="field-type" {
   let field=item(&changed,"rent_reservations.Booking.reserved_from").id;
   let IrItemKind::Field{ty,..}=&mut changed.items[field.0 as usize].kind else{panic!("field");};*ty=IrType::Known(ResolvedType::Scalar(Scalar::Text));
  }else if mode=="child-owner" {
   let model=item(&changed,"rent_reservations.Conflict").id;
   let IrItemKind::Model{owner,..}=&mut changed.items[model.0 as usize].kind else{panic!("model");};*owner=ir::IrOwner::Team;
  }else{
   let IrItemKind::Scenario{effects,..}=&mut changed.items[owner.id.0 as usize].kind else{panic!("scenario");};
   let IrStmt::For{domain,limit:Some(limit),body,..}=effects.last_mut().unwrap() else{panic!("loop");};
   if mode=="limit"{limit.expr=IrExpr::Int(1001);}
   else if mode=="parent"||mode=="predicate"{
    let IrExpr::Query(query)=&mut domain.expr else{panic!("query");};
    if mode=="parent"{query.parent.as_mut().unwrap().expr=IrExpr::Name("other".into());}
    else{query.where_pred.as_mut().unwrap().expr=IrExpr::Bool(true);}
   }else{
    let IrStmt::Create{input,..}=&mut body[0]else{panic!("create");};let IrExpr::Object(fields)=&mut input.expr else{panic!("fields");};
    fields.iter_mut().find(|(name,_)|name==if mode=="reference"{"booking"}else{"parent"}).unwrap().1.expr=IrExpr::Name("other".into());
   }
  }
  assert!(serialize_complete_query_receipt(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog),module).is_none(),"{mode}");
 }
}

#[test]
fn original_shift_request_retains_created_and_parent_source_ownership() {
 let source=include_str!("fixtures/shift-request-original.can");
 let(db,program,_,catalog)=fixture_source("shift-request-original.can",source);
 let(artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let operation=artifact["operations"].as_array().unwrap().iter().find(|operation|operation["name"]=="shift.request_swap").unwrap();
 assert!(operation["result"]["disclosure"].is_null(),"source-only owner must not acquire a native receipt claim");
 for(name,ty)in [("shift.DutyNotice.swap",ResolvedType::Scalar(Scalar::Text)),("shift.Commitment.revision",ResolvedType::Scalar(Scalar::Text)),("shift.Swap.revision",ResolvedType::Scalar(Scalar::Text))]{
  let(db,mut changed,_,catalog)=fixture_source("shift-source-schema-substitution.can",source);
  let field=changed.symbols.iter().find(|symbol|symbol.canonical==name).unwrap().id;changed.types.symbol_types.insert(field,ty);
  let(_,diagnostics)=prepared_artifact(&changed,&db,&catalog);
  assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{name}: {diagnostics:?}");
 }
 for(mode,changed)in [
  ("copied-created",source.replace("    emit DutyNotice {duty,recipient=substitute.user", "    let copied=swap\n    emit DutyNotice {duty,recipient=substitute.user").replace("kind=swap_request,swap}","kind=swap_request,swap=copied}")),
  ("copied-parent",source.replace("    create Swap {parent=duty", "    let copied=duty\n    create Swap {parent=copied")),
 ]{
  assert_ne!(source,changed,"{mode}");let(db,program,_,catalog)=fixture_source(&format!("shift-{mode}.can"),&changed);
  let(_,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{mode}: {diagnostics:?}");
 }
}

#[test]
fn original_shift_nested_first_requires_every_helper_consumer_private() {
 let source=include_str!("fixtures/shift-assign-original.can");
 let(db,program,_,catalog)=fixture_source("shift-assign-original.can",source);
 let(_,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
 for(mode,changed)in [
  ("exported",source.replace("  derive previous_work(","  export derive previous_work(")),
  ("ordinary-tail",source.replace("    create Commitment {parent=roster", "    let selected=previous_work(roster,employee,from,null)\n    create Commitment {parent=roster")),
  ("exported-outer",source.replace("  derive travel_entered(","  export derive travel_entered(")),
  ("unused",source.replace(" and travel_entered(roster,employee,location,from,until,before,after,null)","")),
 ]{
  assert_ne!(source,changed,"{mode}");let(db,program,_,catalog)=fixture_source(&format!("shift-first-{mode}.can"),&changed);
  let(_,diagnostics)=prepared_artifact(&program,&db,&catalog);
  assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"&&diagnostic.message.contains("first query")),"{mode}: {diagnostics:?}");
 }
}

#[test]
fn original_event_cancel_clears_only_declared_optional_reference_with_null() {
 let source=include_str!("fixtures/event-cancel-original-source.can");
 let (db,program,_,catalog)=fixture_source("event-cancel-original-source.can",source);
 let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);
 assert!(diagnostics.is_empty(),"{diagnostics:?}");
}

#[test]
fn original_propose_offers_keep_required_identity_path_ownership() {
 let source=include_str!("fixtures/propose-handoff-original.can");
 let(db,program,_,catalog)=fixture_source("propose-handoff-original.can",source);
 let(artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let js=artifact["modules"].as_array().unwrap().iter().filter_map(|module|module["js"].as_str()).collect::<String>();assert!(js.contains("identityPaths"));
 for nullable in [false,true]{
  let(db,mut changed,_,catalog)=fixture_source("propose-path-schema-substitution.can",source);
  let field=changed.symbols.iter().find(|symbol|symbol.canonical=="propose.Proposal.location").unwrap().id;
  let customer=changed.symbols.iter().find(|symbol|symbol.canonical=="customer.Customer").unwrap().id;
  let ty=if nullable{ResolvedType::Nullable(Box::new(changed.types.symbol_types[&field].clone()))}else{ResolvedType::Record{symbol:customer,stored:true}};
  changed.types.symbol_types.insert(field,ty);let(_,diagnostics)=prepared_artifact(&changed,&db,&catalog);
  assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"nullable={nullable}: {diagnostics:?}");
 }
 let changed=source.replace("    send Rooms.hold_offer {value=QuoteOffer", "    let copied=revision\n    send Rooms.hold_offer {value=QuoteOffer").replace("customer=revision.parent.parent.id","customer=copied.parent.parent.id");
 // Apply only to the hold scenario so the alias remains a genuine local.
 let boundary=changed.find("  export scenario request_booking(").unwrap();let changed=format!("{}{}",&changed[..boundary],changed[boundary..].replace("customer=copied.parent.parent.id","customer=revision.parent.parent.id"));
 let(db,program,_,catalog)=fixture_source("propose-path-copied-root.can",&changed);
 let(_,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{diagnostics:?}");
}

#[test]
fn original_member_recheck_keeps_required_parameters_in_optional_event_slots() {
 let source=include_str!("fixtures/member-recheck-original-source.can");
 let (db,program,_,catalog)=fixture_source("member-recheck-original-source.can",source);
 let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);
 assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let copied=source.replace("    emit CompanyAccessStep {customer,location,after=null}",
     "    let copied=location\n    emit CompanyAccessStep {customer,location=copied,after=null}");
 let (db,program,_,catalog)=fixture_source("member-recheck-copied-reference.can",&copied);
 let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);
 assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{diagnostics:?}");
}

#[test]
fn original_event_release_keeps_declared_nullable_identity_edges() {
 let source=include_str!("fixtures/event-release-original-source.can");
 let(db,program,_,catalog)=fixture_source("event-release-original-source.can",source);
 let(artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let js=artifact["modules"].as_array().unwrap().iter().filter_map(|module|module["js"].as_str()).collect::<String>();assert!(js.contains("identityPaths")&&js.contains("nullable"));
 for foreign in [false,true]{
  let(db,mut changed,_,catalog)=fixture_source("event-release-reference-substitution.can",source);
  let field=changed.symbols.iter().find(|symbol|symbol.canonical=="events.Change.resource").unwrap().id;
  let ty=if foreign{let customer=changed.symbols.iter().find(|symbol|symbol.canonical=="customer.Customer").unwrap().id;ResolvedType::Nullable(Box::new(ResolvedType::Record{symbol:customer,stored:true}))}else{let ResolvedType::Nullable(inner)=changed.types.symbol_types[&field].clone()else{panic!("nullable source field")};*inner};
  changed.types.symbol_types.insert(field,ty);let(_,diagnostics)=prepared_artifact(&changed,&db,&catalog);assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"foreign={foreign}: {diagnostics:?}");
 }
}

#[test]
fn original_prepare_branch_counts_keep_independent_current_domains() {
 let source=include_str!("fixtures/rent-prepare-branch-count.can");
 let (db,program,ir,catalog)=fixture_source("rent-prepare-branch-count.can",source);
 let owner=item(&ir,"rent_reservations.prepare");
 assert!(matches!(ir.scenario_disclosures[&owner.id],ScenarioDisclosure::Complete(_)));
 let (artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);
 assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let operation=artifact["operations"].as_array().unwrap().iter().find(|value|value["name"]=="rent_reservations.prepare").unwrap();
 assert!(operation["result"]["disclosure"].is_object(),"original full owner needs its real native receipt");
}

#[test]
fn original_prepare_branch_count_metadata_cannot_drop_reached_observations() {
 let source=include_str!("fixtures/rent-prepare-branch-count.can");
 let(db,program,ir,catalog)=fixture_source("rent-prepare-branch-count.can",source);
 let owner=item(&ir,"rent_reservations.prepare");
 let module="$can$m$72656e745f7265736572766174696f6e73.mjs";
 assert!(serialize_complete_query_receipt(&program,&ir,owner,&db,Some(&catalog),module).is_some());
 let ScenarioDisclosure::Complete(proof)=&ir.scenario_disclosures[&owner.id] else{panic!("complete")};
 assert!(proof.returns.iter().all(|returned|returned.influences.len()==4));
 let reached=proof.returns.iter().map(|returned|returned.influences[0].query_id.clone()).collect::<std::collections::HashSet<_>>();
 assert_eq!(reached.len(),2,"both authored arms retain their distinct reached COUNT");
 for mode in ["drop-reached-count","wrong-branch-query","decision-node","decision-calls","return-id","return-source","helper-field-type","branch-order","branch-condition"] {
  let mut changed=ir.clone();
  if mode=="helper-field-type" {
   let field=item(&changed,"rent_catalog.Location.name").id;
   let IrItemKind::Field{ty,..}=&mut changed.items[field.0 as usize].kind else{panic!("field")};
   *ty=IrType::Known(ResolvedType::Scalar(Scalar::Int));
  } else if mode.starts_with("branch-"){
   let IrItemKind::Scenario{effects,..}=&mut changed.items[owner.id.0 as usize].kind else{panic!("owner")};
   let IrStmt::If{cond,then_branch,..}=&mut effects[0] else{panic!("branch")};
   if mode=="branch-order"{then_branch.swap(1,2);}else{cond.expr=IrExpr::Bool(false);}
  } else {
   let ScenarioDisclosure::Complete(proof)=changed.scenario_disclosures.get_mut(&owner.id).unwrap() else{panic!("complete")};
   match mode {
    "drop-reached-count"=>proof.returns[0].influences.clear(),
    "wrong-branch-query"=>{let other=proof.returns.iter().find(|returned|returned.influences[0].query_id!=proof.returns[0].influences[0].query_id).unwrap().influences.clone();proof.returns[0].influences=other;},
    "decision-node"=>proof.returns[0].decisions[0].node.start+=1,
    "decision-calls"=>{let node=proof.returns[0].decisions[0].node;proof.returns[0].decisions[0].calls.push(node);}
    "return-id"=>proof.returns[0].id.push_str("-changed"),
    "return-source"=>proof.returns[0].source.sha256.push('0'),
    _=>unreachable!(),
   }
  }
  if mode=="helper-field-type"{let emitted=js::emit_program_with_native_source_receipts(&changed,true,&db);assert!(emitted.diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{mode}: {:?}",emitted.diagnostics);}
  else{assert!(serialize_complete_query_receipt(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog),module).is_none(),"{mode} borrowed original branch COUNT authority");}
 }
}

#[test]
fn original_shift_descendant_control_keeps_its_exact_selected_loop_and_public_root() {
 use canlang_compiler::codegen::scenario_decisions::serialize_decision_sources;
 let source=include_str!("fixtures/shift-recover-original.can");
 let (db,program,ir,catalog)=fixture_source("shift-recover-original.can",source);
 let owner=item(&ir,"shift.recover_commitment");
 let (artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let code=artifact["modules"].as_array().unwrap().iter().filter_map(|module|module["js"].as_str()).collect::<Vec<_>>().join("\n");
 assert!(code.contains("nativeScenarioSourceLoopItem(c"));assert!(code.contains("\\\"ancestors\\\""));assert!(code.contains("\\\"loop\\\""));
 assert!(serialize_decision_sources(&program,&ir,owner,&db,Some(&catalog)).is_some());
 let unprepared=js::emit_program_with_native_source_receipts(&ir,true,&db);assert!(unprepared.diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"));
 let oversized=source.replace("limit=100\n     if commitment.conflict","limit=201\n     if commitment.conflict");
 assert_ne!(source,oversized);let (large_db,large_program,_,large_catalog)=fixture_source("shift-recover-guard-overflow.can",&oversized);
 let (_,large_diagnostics)=prepared_artifact(&large_program,&large_db,&large_catalog);
 assert!(large_diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{large_diagnostics:?}");
 for mode in ["limit","filter","condition","update","item","prefix","field-type","helper"] {
  let mut changed=ir.clone();
  if mode=="helper" {
   let helper=item(&changed,"shift.fits").id;
   let IrItemKind::DeriveFn{expr:Some(value),..}=&mut changed.items[helper.0 as usize].kind else{panic!("helper");};value.expr=IrExpr::Bool(true);
  }else if mode=="field-type"{
   let field=item(&changed,"shift.Commitment.until").id;let IrItemKind::Field{ty,..}=&mut changed.items[field.0 as usize].kind else{panic!("field");};*ty=IrType::Known(ResolvedType::Scalar(Scalar::Text));
  }else{
   let IrItemKind::Scenario{effects,..}=&mut changed.items[owner.id.0 as usize].kind else{panic!("owner");};
   if mode=="prefix"{effects.swap(0,1);}else{
    let IrStmt::For{item,domain,limit:Some(limit),body,..}=effects.last_mut().unwrap()else{panic!("loop");};
    if mode=="item"{*item="foreign".into();}
    else if mode=="limit"{limit.expr=IrExpr::Int(101);}
    else if mode=="filter"{let IrExpr::Query(query)=&mut domain.expr else{panic!("query");};query.where_pred.as_mut().unwrap().expr=IrExpr::Bool(true);}
    else{let IrStmt::If{cond,then_branch,..}=&mut body[0]else{panic!("condition");};
     if mode=="condition"{cond.expr=IrExpr::Bool(true);}else{
      let IrStmt::Set{record,..}=&mut then_branch[0]else{panic!("update");};record.expr=IrExpr::Name("commitment".into());
     }
    }
   }
  }
  assert!(serialize_decision_sources(&program,&changed,&changed.items[owner.id.0 as usize],&db,Some(&catalog)).is_none(),"{mode}");
 }
}

#[test]
fn original_crm_win_admits_only_source_narrowed_nullable_reference_slots() {
 let source=include_str!("fixtures/crm-win-nullable-source.can");
 let(db,program,ir,catalog)=fixture_source("crm-win-nullable-source.can",source);
 let(artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let operation=artifact["operations"].as_array().unwrap().iter().find(|operation|operation["name"]=="crm.win").unwrap();
 for name in ["booking","term"]{let input=operation["inputs"]["fields"].as_array().unwrap().iter().find(|input|input["name"]==name).unwrap();assert_eq!(input["nullable"],true);assert_eq!(input["required"],false);assert!(input.get("default").is_none());assert_eq!(input["field"]["requireVersion"],true);}
 let owner=item(&ir,"crm.win");assert!(matches!(&ir.scenario_disclosures[&owner.id],ScenarioDisclosure::Complete(_)));
 for mode in ["branch-condition","key-input","key-field","nullable-declaration"]{
  let mut changed=ir.clone();
  if mode=="nullable-declaration"{let parameter=item(&changed,"crm.win.booking").id;let IrItemKind::Param{ty,..}=&mut changed.items[parameter.0 as usize].kind else{panic!("param")};*ty=IrType::Known(ResolvedType::Scalar(Scalar::Text));}
  else{let IrItemKind::Scenario{effects,..}=&mut changed.items[owner.id.0 as usize].kind else{panic!("owner")};let IrStmt::If{cond,then_branch,..}=&mut effects[0]else{panic!("branch")};if mode=="branch-condition"{cond.expr=IrExpr::Bool(true);}else{let IrStmt::Create{input,..}=&mut then_branch[2]else{panic!("create")};let IrExpr::Object(fields)=&mut input.expr else{panic!("fields")};let key=fields.iter_mut().find(|(name,_)|name=="booking").unwrap();if mode=="key-input"{key.1.expr=IrExpr::Name("term".into());}else{key.0="term".into();}}}
  let emitted=js::emit_program_with_native_source_receipts(&changed,true,&db);assert!(emitted.diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{mode}: {:?}",emitted.diagnostics);
 }
 for (name,changed) in [("positive-any",source.replace("require not any(Sale as sale,sale.booking==booking)","require any(Sale as sale,sale.booking==booking)")),("different-key",source.replace("create Sale {deal,booking} as evidence","create Sale {deal,term} as evidence")),("non-unique",source.replace("booking:Booking? unique","booking:Booking?"))]{
  let(db,program,_,catalog)=fixture_source(name,&changed);let(_,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{name}: {diagnostics:?}");
 }
}

#[test]
fn missing_source_observer_does_not_erase_original_model_guard_domains() {
 let source=r#"app MissingGuard uses=[checks]
package checks
 Given
  contract Interval {from:datetime,until:datetime}
  Root {active:bool=true,intervals:Interval[]}
  Child in Root {allowed:bool}
  policy Root read=members
  policy Child read=members
  derive allowed(root:Root):bool=any(root.intervals as interval,interval.from<now) and any(root.Child as child,child.allowed)
 When
  scenario mutate(root:Root) by=members
   require allowed(root)
   do set root {active=false}
 Then
"#;
 for (name,source) in [("leading",source.to_owned()),("staged",source.replace("   require allowed(root)\n   do set root {active=false}","   do\n    set root {active=false}\n    if allowed(root)\n     set root {active=true}"))] {
  let (db,program,_,catalog)=fixture_source(&format!("missing-observer-{name}.can"),&source);
  let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);
  assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"&&diagnostic.message.contains("source guard")),"{name}: {diagnostics:?}");
 }
 let (db,mut changed,_,catalog)=fixture_source("erased-original-helper-query.can",source);
 let helper=changed.symbols.iter().find(|symbol|symbol.canonical=="checks.allowed").unwrap().id;
 let root=changed.symbols.iter().find(|symbol|symbol.canonical=="checks.Root").unwrap().id;
 let literal=changed.effects.models[&root].fields.iter().find_map(|field|field.default).unwrap();
 changed.effects.derives.get_mut(&helper).unwrap().expr=Some(literal);
 let (_,diagnostics)=prepared_artifact(&changed,&db,&catalog);
 assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"&&diagnostic.message.contains("source guard")),"erased original helper: {diagnostics:?}");
 for (name,body) in [("scalar","root.active"),("values-any","any(root.intervals as interval,interval.from<now)")] {
  let pure=source.replace("any(root.intervals as interval,interval.from<now) and any(root.Child as child,child.allowed)",body);
  let (db,program,_,catalog)=fixture_source(&format!("ordinary-helper-{name}.can"),&pure);
  let (_,diagnostics)=prepared_artifact(&program,&db,&catalog);
  assert!(diagnostics.is_empty(),"{name}: {diagnostics:?}");
 }
}

#[test]
fn original_shift_decline_seals_model_paths_and_scalar_leaf_schemas() {
 let source=include_str!("fixtures/shift-decline-original.can");
 let(db,program,_,catalog)=fixture_source("shift-decline-original.can",source);
 let(artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let js=artifact["modules"].as_array().unwrap().iter().filter_map(|module|module["js"].as_str()).collect::<String>();assert!(js.contains("dataPaths")&&js.contains("identityPaths"));
 for(name,ty)in [("shift.DutyNotice.duty",ResolvedType::Scalar(Scalar::Text)),("employee.Employee.user",ResolvedType::Scalar(Scalar::Text)),("shift.Commitment.revision",ResolvedType::Scalar(Scalar::Money))]{
  let(db,mut changed,_,catalog)=fixture_source("shift-decline-schema-substitution.can",source);let field=changed.symbols.iter().find(|symbol|symbol.canonical==name).unwrap().id;
  changed.types.symbol_types.insert(field,ty);let(_,diagnostics)=prepared_artifact(&changed,&db,&catalog);assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{name}: {diagnostics:?}");
 }
 for(mode,changed)in [
  ("copied-parent",source.replace("    emit DutyNotice {duty=swap.parent", "    let copied=swap\n    emit DutyNotice {duty=copied.parent")),
  ("reserved-version",source.replace("revision=swap.parent.parent.revision","revision=swap.parent.parent.version")),
 ]{let(db,program,_,catalog)=fixture_source(&format!("shift-decline-{mode}.can"),&changed);let(_,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{mode}: {diagnostics:?}");}
}

#[test]
fn source_observer_budget_belongs_to_each_original_owner() {
 let mut source=String::from("app ManyGuards uses=[checks]\npackage checks\n Given\n  Root {active:bool=true}\n  Child in Root {allowed:bool}\n  policy Root read=members\n  policy Child read=members\n When\n");
 for index in 0..101 {source.push_str(&format!("  scenario mutate_{index}(root:Root) by=members\n   require any(root.Child as child,child.allowed)\n   require not any(root.Child as child,not child.allowed)\n   do set root {{active=false}}\n"));}
 source.push_str(" Then\n");
 let (db,program,_,catalog)=fixture_source("many-original-observers.can",&source);
 let (artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);
 assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let code=artifact["modules"].as_array().unwrap().iter().filter_map(|module|module["js"].as_str()).collect::<Vec<_>>().join("\n");
 assert_eq!(code.matches("await nativeScenarioRequire(c,").count(),202);
 let (changed_db,mut changed,_,changed_catalog)=fixture_source("many-original-observers.can",&source);
 let owner=changed.symbols.iter().find(|symbol|symbol.canonical=="checks.mutate_100").unwrap().id;
 let root=changed.symbols.iter().find(|symbol|symbol.canonical=="checks.Root").unwrap().id;
 let literal=changed.effects.models[&root].fields.iter().find_map(|field|field.default).unwrap();
 changed.effects.scenarios.get_mut(&owner).unwrap().guards[0].cond=Some(literal);
 let (_,diagnostics)=prepared_artifact(&changed,&changed_db,&changed_catalog);
 assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{diagnostics:?}");
}


#[test]
fn original_shift_accept_seals_ancestor_writes_reference_and_sibling_domain() {
 let source=include_str!("fixtures/shift-accept-original.can");
 let(db,program,_,catalog)=fixture_source("shift-accept-original.can",source);
 let(artifact,diagnostics)=prepared_artifact(&program,&db,&catalog);assert!(diagnostics.is_empty(),"{diagnostics:?}");
 let js=artifact["modules"].as_array().unwrap().iter().filter_map(|module|module["js"].as_str()).collect::<String>();
 assert!(js.contains("parentDepth")&&js.contains("nativeScenarioSourceLoop")&&js.contains("nativeReadReference"));
 for(name,ty)in [("shift.Swap.substitute",ResolvedType::Scalar(Scalar::Text)),("shift.Commitment.employee",ResolvedType::Scalar(Scalar::Text))]{
  let(db,mut changed,_,catalog)=fixture_source("shift-accept-schema-substitution.can",source);
  let field=changed.symbols.iter().find(|symbol|symbol.canonical==name).unwrap().id;
  changed.types.symbol_types.insert(field,ty);let(_,diagnostics)=prepared_artifact(&changed,&db,&catalog);
  assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{name}: {diagnostics:?}");
 }
 let(db,mut changed,_,catalog)=fixture_source("shift-accept-parent-substitution.can",source);
 let roster=changed.symbols.iter().find(|symbol|symbol.canonical=="shift.Roster").unwrap().id;
 let target=*changed.types.node_types.keys().find(|key|key.kind==canlang_compiler::syntax::SyntaxKind::Path as u8
    &&db.get(key.file).and_then(|file|file.text.get(key.start as usize..key.end as usize)).is_some_and(|text|text.trim()=="swap.parent.parent")).unwrap();
 changed.types.node_types.insert(target,ResolvedType::Record{symbol:roster,stored:true});
 let(_,diagnostics)=prepared_artifact(&changed,&db,&catalog);assert!(diagnostics.iter().any(|diagnostic|diagnostic.code=="E6008"),"{diagnostics:?}");
}
