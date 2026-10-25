//! Finite first-query slice D (CAN18-v1): unscoped single-Text-equality
//! id-ordered same-model whole-row idempotent replay.
//!
//! Selected sub-shape (smallest complete): `first(Receipt as receipt where
//! receipt.source==source:text-param order=receipt.id)` with
//! `if previous!=null ... return previous` alongside a same-model create.
//! All other sub-shapes (2-cond, event operands, non-id order, contained,
//! no-predicate, hooks, absence requires, direct returns) stay loudly refused.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir::{self, IrExpr, IrItemKind, IrStmt};
use canlang_compiler::codegen::js;
use canlang_compiler::codegen::scenario_queries::serialize_complete_query_receipt;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str = include_str!("fixtures/native-first-replay.can");

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

fn fixture_source(path: &str, source: &str) -> (SourceDb, CheckedProgram, ir::IrProgram, Catalog) {
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

fn prepared_artifact(
    program: &CheckedProgram,
    db: &SourceDb,
    catalog: &Catalog,
) -> (Value, Vec<Diagnostic>) {
    use canlang_compiler::codegen::artifact::to_json;
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
    let mut result = DiagnosticResult::new("first-query-replay", "1.0", 1);
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

use canlang_compiler::diagnostic::DiagnosticResult;

fn operation(artifact: &Value) -> &Value {
    artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == "WholeSources.receive")
        .unwrap()
}

#[test]
fn replay_plan_keeps_text_control_id_order_and_both_returns() {
    let (db, program, _, catalog) = fixture_source("native-first-replay.can", SOURCE);
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let plan = &operation(&prepared)["result"]["disclosure"];
    assert_eq!(plan["version"], 1);
    let [query] = plan["queries"].as_array().unwrap().as_slice() else {
        panic!("one replay query")
    };
    assert_eq!(query["model"], "WholeSources.Receipt");
    assert_eq!(
        query["order"],
        serde_json::json!([{ "field": "id", "direction": "asc" }])
    );
    assert!(query["limit"].is_null());
    assert_eq!(query["archived"], "exclude");
    let [candidate] = query["dependencies"].as_array().unwrap().as_slice() else {
        panic!("one source control")
    };
    assert_eq!(candidate["field"], "source");
    assert_eq!(candidate["type"], "text");
    assert_eq!(candidate["role"], "control");
    let returns = plan["returns"].as_array().unwrap();
    assert_eq!(returns.len(), 2, "replay plus create");
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
}

#[test]
fn replay_mutants_refuse() {
    let (db, program, ir, catalog) = fixture_source("native-first-replay.can", SOURCE);
    let owner = ir
        .items
        .iter()
        .find(|item| item.canonical == "WholeSources.receive")
        .unwrap()
        .id;
    let entry = "$can$m$5265706c6179.mjs";
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
    // Each mutant breaks the exact replay correspondence and must refuse.
    let mutants: Vec<(&str, Box<dyn Fn(&mut ir::IrProgram)>)> = vec![
        (
            "operand",
            Box::new(|changed: &mut ir::IrProgram| {
                let IrItemKind::Scenario { effects, .. } =
                    &mut changed.items[owner.0 as usize].kind
                else {
                    panic!()
                };
                let IrStmt::Let { value, .. } = &mut effects[0] else {
                    panic!()
                };
                let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) = &mut value.expr
                else {
                    panic!()
                };
                let IrExpr::Query(query) = &mut args[0].expr else {
                    panic!()
                };
                let IrExpr::Binary { right, .. } = &mut query.where_pred.as_mut().unwrap().expr
                else {
                    panic!()
                };
                right.expr = IrExpr::Name("accepted".into());
            }),
        ),
        (
            "field",
            Box::new(|changed: &mut ir::IrProgram| {
                let IrItemKind::Scenario { effects, .. } =
                    &mut changed.items[owner.0 as usize].kind
                else {
                    panic!()
                };
                let IrStmt::Let { value, .. } = &mut effects[0] else {
                    panic!()
                };
                let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) = &mut value.expr
                else {
                    panic!()
                };
                let IrExpr::Query(query) = &mut args[0].expr else {
                    panic!()
                };
                let IrExpr::Binary { left, .. } = &mut query.where_pred.as_mut().unwrap().expr
                else {
                    panic!()
                };
                let IrExpr::Member { field, .. } = &mut left.expr else {
                    panic!()
                };
                *field = "accepted".into();
            }),
        ),
        (
            "order",
            Box::new(|changed: &mut ir::IrProgram| {
                let IrItemKind::Scenario { effects, .. } =
                    &mut changed.items[owner.0 as usize].kind
                else {
                    panic!()
                };
                let IrStmt::Let { value, .. } = &mut effects[0] else {
                    panic!()
                };
                let (IrExpr::Call { args, .. } | IrExpr::BoundCall { args, .. }) = &mut value.expr
                else {
                    panic!()
                };
                let IrExpr::Query(query) = &mut args[0].expr else {
                    panic!()
                };
                query.order[0].descending = true;
            }),
        ),
        (
            "replay-target",
            Box::new(|changed: &mut ir::IrProgram| {
                let IrItemKind::Scenario { effects, .. } =
                    &mut changed.items[owner.0 as usize].kind
                else {
                    panic!()
                };
                // Rewrite `return previous` to `return receipt` (drop replay).
                for statement in effects.iter_mut() {
                    if let IrStmt::If { then_branch, .. } = statement {
                        for nested in then_branch.iter_mut() {
                            if let IrStmt::Return {
                                value: Some(value), ..
                            } = nested
                            {
                                value.expr = IrExpr::Name("receipt".into());
                            }
                        }
                    }
                }
            }),
        ),
    ];
    for (mode, mutate) in mutants {
        let mut changed = ir.clone();
        mutate(&mut changed);
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
            "{mode}: replay correspondence survived"
        );
        let emitted = js::emit_program_with_native_source_receipts(&changed, true, &db);
        assert!(
            emitted
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"),
            "{mode}"
        );
    }
}

#[test]
fn other_shapes_stay_refused() {
    // Each shape beyond the selected family must keep its loud refusal.
    // All use the same Receipt model/owner skeleton with one varied clause.
    let base = SOURCE.to_string();
    let cases = [
        (
            "two-cond",
            base.replace(
                "receipt.source==source order=receipt.id",
                "receipt.source==source and receipt.accepted==accepted order=receipt.id",
            ),
        ),
        (
            "non-id-order",
            base.replace("order=receipt.id", "order=receipt.accepted"),
        ),
        (
            "no-predicate",
            base.replace(
                "first(Receipt as receipt where receipt.source==source order=receipt.id)",
                "first(Receipt as receipt order=receipt.id)",
            ),
        ),
    ];
    for (mode, source) in cases {
        let (db, program, _, catalog) = fixture_source("refused-replay.can", &source);
        let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
        assert!(
            diagnostics
                .iter()
                .any(|diagnostic| diagnostic.code == "E6008"
                    && diagnostic
                        .message
                        .contains("original native query correspondence")),
            "{mode}: expected loud first-query refusal, got {diagnostics:?}"
        );
    }
}

#[test]
fn contained_replay_retains_original_parent_and_both_returns() {
    let contained = r#"app ContainedSources
Given
 Location {name:text}
 Order {reference:text unique,location:Location}
 Payable in Order {invoice:text, amount:int,location_id:text}
 policy Location read=members
 policy Order read=members
 policy Payable read=members
When
 crud Order by=members fields=reference,location
 crud Payable by=members fields=invoice,amount,location_id
 scenario record(order:Order,invoice:text,amount:int) -> Payable by=members
  do
   let previous=first(order.Payable as payable where payable.invoice==invoice order=payable.id)
   if previous!=null
    require previous.amount==amount
    return previous
   create Payable {parent=order,invoice,amount,location_id=order.location.id} as payable
   return payable
Then
"#
    .to_string();
    let (db, program, _, catalog) = fixture_source("contained-replay.can", &contained);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let operation = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == "ContainedSources.record")
        .unwrap();
    let plan = &operation["result"]["disclosure"];
    assert_eq!(
        plan["queries"][0]["parent"]["model"],
        "ContainedSources.Order"
    );
    assert_eq!(plan["queries"][0]["parent"]["origin"]["parameter"], "order");
    assert_eq!(plan["returns"].as_array().unwrap().len(), 2);
    let emitted = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(
        emitted.contains("(await readScenarioReceiptStoredReference(c,"),
        "original stored reference.id must promote its exact observed source before the id marker"
    );
}

#[test]
fn genuine_cli_replay_keeps_source_order() {
    let (db, program, _, catalog) = fixture_source("native-first-replay.can", SOURCE);
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(operation(&prepared)["result"]["disclosure"].is_object());
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("native-first-replay.can");
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
    let operation = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == "WholeSources.receive")
        .unwrap();
    assert_eq!(
        operation["result"]["disclosure"]["queries"][0]["order"],
        serde_json::json!([{ "field": "id", "direction": "asc" }])
    );
    assert_eq!(
        operation["result"]["disclosure"]["returns"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        sha256_hex(SOURCE.as_bytes()),
        sha256_hex(std::fs::read(&source).unwrap().as_slice())
    );
    let _ = db;
}

#[test]
fn replay_create_parent_set_keeps_original_receiver_and_refuses_row_swaps() {
    let source = r#"app ParentReplay
Given
 Order {state:text}
 Line in Order {sku:text}
 Receipt in Line {source:text unique,accepted:int}
 policy Order read=members
 policy Line read=members
 policy Receipt read=members
When
 crud Order by=members fields=state
 crud Line by=members fields=sku
 crud Receipt by=members fields=source,accepted
 scenario receive(line:Line,other:Line,source:text,accepted:int) -> Receipt by=members
  do
   let previous=first(Receipt as receipt where receipt.source==source order=receipt.id)
   if previous!=null
    require previous.parent==line and previous.accepted==accepted
    return previous
   create Receipt {parent=line,source,accepted} as receipt
   set line.parent {state="part"}
   return receipt
Then
"#;
    let (db, program, ir, catalog) = fixture_source("parent-replay.can", source);
    let owner = ir
        .items
        .iter()
        .find(|item| item.canonical == "ParentReplay.receive")
        .unwrap();
    let recipe =
        serialize_complete_query_receipt(&program, &ir, owner, &db, Some(&catalog), "parent.mjs");
    assert!(
        recipe.is_some(),
        "parent SET requires a complete source/executable receipt"
    );
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let emitted = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(emitted.contains("observeScenarioReceiptDependency"));
    assert!(emitted.contains("await set(c,"));
    let owner_id = owner.id;
    let mut changed = ir.clone();
    let IrItemKind::Scenario { effects, .. } = &mut changed.items[owner_id.0 as usize].kind else {
        panic!()
    };
    let record = effects
        .iter_mut()
        .find_map(|statement| match statement {
            IrStmt::Set { record, .. } => Some(record),
            _ => None,
        })
        .unwrap();
    let IrExpr::Member { base, .. } = &mut record.expr else {
        panic!()
    };
    base.expr = IrExpr::Name("other".into());
    assert!(
        serialize_complete_query_receipt(
            &program,
            &changed,
            &changed.items[owner_id.0 as usize],
            &db,
            Some(&catalog),
            "parent.mjs"
        )
        .is_none(),
        "same-typed parent row swap must refuse"
    );
    // Parent mutation is a reusable prerequisite, not permission to lower an
    // unobserved post-write sibling domain through the same first receipt.
    let all_source = source.replace("   return receipt\nThen", "   if all(line.parent.Line as item,item.sku==\"one\")\n    set line.parent {state=\"done\"}\n   return receipt\nThen");
    let (all_db, all_program, _, all_catalog) =
        fixture_source("parent-all-refusal.can", &all_source);
    let (_, refused) = prepared_artifact(&all_program, &all_db, &all_catalog);
    assert!(
        refused.iter().any(|diagnostic| diagnostic.code == "E6008"),
        "post-write ALL needs an independent receipt/runtime profile"
    );
}

#[test]
fn purchase_post_write_all_seals_aggregate_bodies_and_emits_its_distinct_frame() {
    let source = include_str!("fixtures/purchase-receive-all.can");
    let (db, program, _, catalog) = fixture_source("purchase-receive-all.can", source);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let owner = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|op| op["name"] == "purchase.receive")
        .unwrap();
    assert_eq!(
        owner["result"]["disclosure"]["purchaseReceiveAll"]["stage"],
        3
    );
    assert!(
        artifact["modules"]
            .as_array()
            .unwrap()
            .iter()
            .any(|module| module["js"]
                .as_str()
                .unwrap()
                .contains("await evaluateScenarioReceiptPurchaseAll(c,"))
    );
    let unrelated = format!(
        "{source}\npackage unrelated\n Given\n  Row {{label:text}}\n  policy Row read=members\n When\n  scenario unsupported() -> Row? by=members\n   do\n    return first(Row as row order=row.id)\n Then\n"
    );
    let (unrelated_db, unrelated_program, _, unrelated_catalog) =
        fixture_source("purchase-unrelated.can", &unrelated);
    let (partial, unrelated_diagnostics) =
        prepared_artifact(&unrelated_program, &unrelated_db, &unrelated_catalog);
    assert!(
        unrelated_diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008")
    );
    let retained = partial["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|op| op["name"] == "purchase.receive")
        .unwrap();
    assert_eq!(
        retained["result"]["disclosure"]["purchaseReceiveAll"]["stage"], 3,
        "an unrelated lowering refusal cannot orphan the exact Receipt rules"
    );
    let changed = source.replace(
        "row.quantity+sum(row.Amendment as amendment select amendment.quantity)",
        "row.quantity",
    );
    let (db, program, _, catalog) = fixture_source("purchase-all-altered.can", &changed);
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008")
    );
}
