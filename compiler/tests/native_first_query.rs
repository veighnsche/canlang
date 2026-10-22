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
