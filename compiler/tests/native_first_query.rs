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
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit, to_json_string};
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
        serde_json::from_str(&to_json_string(&artifact)).unwrap(),
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
