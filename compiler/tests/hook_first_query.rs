//! Hook first-query correspondence (CAN18-v1 Lane C23, outcome 5).
//!
//! First admitted sub-shape: a declared-event handler (`on=Tick`) whose void
//! body holds exactly one unordered `first(Model as row where
//! row.<text>==event.<text>)` plus one non-null `require`. The checked event
//! payload is handler context (like `actor`), so the query carries no
//! transported input; the native receipt, plan and emitter joins re-prove
//! the exact occurrence against the declared event record and field.
//! Everything else keeps its exact current E6008 refusal.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir::IrProgram;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit, to_json_string};
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, Span};
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn fixture_source(path: &str, source: &str) -> (SourceDb, CheckedProgram, IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add(path.into(), source.into());
    let catalog_path = root().join("packages/cloudflare/dist/native-catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = canlang_compiler::codegen::ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (db, program, ir, catalog)
}

fn prepared_artifact(
    program: &CheckedProgram,
    db: &SourceDb,
    catalog: &Catalog,
) -> (serde_json::Value, Vec<Diagnostic>) {
    let mut result = DiagnosticResult::new("hook-first-query", "1.0", 1);
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

const HOOK_FIRST_SOURCE: &str = "app HookFirst\nGiven\n Budget {source:text,approved:bool}\n event Tick {source:text}\n policy Budget read=public\nWhen\n scenario probe on=Tick\n  do\n   let budget=first(Budget as row where row.source==event.source)\n   require budget!=null and budget.approved\nThen\n";

/// Handler operations publish outside `artifact.operations` (reads only);
/// their native plan rides the module `canScenarioQuerySources` inventory.
fn hook_query_plan(module_js: &str) -> serde_json::Value {
    let marker = "canScenarioQuerySources(){return JSON.parse(\"";
    let start = module_js.find(marker).expect("query sources inventory") + marker.len();
    let raw = &module_js[start..];
    let mut decoded = String::new();
    let mut chars = raw.chars();
    while let Some(char) = chars.next() {
        if char == '\\' {
            let escaped = chars.next().expect("escape");
            decoded.push('\\');
            decoded.push(escaped);
        } else if char == '"' {
            break;
        } else {
            decoded.push(char);
        }
    }
    let inner: String = serde_json::from_str(&format!("\"{decoded}\"")).expect("string literal");
    let plans: serde_json::Value = serde_json::from_str(&inner).expect("plans JSON");
    plans["HookFirst.probe"].clone()
}

fn first_query_refusal(source: &str) -> Vec<Diagnostic> {
    let (db, program, _, catalog) = fixture_source("hook-first-refusal.can", source);
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.message
                    == "cannot lower first query: original native query correspondence is unavailable"),
        "exact first-query refusal expected: {diagnostics:?}"
    );
    diagnostics
}

/// The first admitted hook sub-shape lowers through the real native
/// pipeline: a real receipt plan with the text control dependency, native
/// `firstQuery` emission, and handler-kind callable publication.
#[test]
fn hook_event_first_query_admits_single_text_shape() {
    let (db, program, _, catalog) = fixture_source("hook-first.can", HOOK_FIRST_SOURCE);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let text = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(
        text.contains("await firstQuery(c,await executeScenarioReceiptQuery(c,"),
        "hook first lowers natively: {text}"
    );
    assert!(
        text.contains("queryFirst:") && text.contains("executionDependencies:"),
        "hook first publishes its checked occurrence metadata"
    );
    let plan = hook_query_plan(text);
    assert_eq!(plan["version"], 1);
    let queries = plan["queries"].as_array().unwrap();
    assert_eq!(queries.len(), 1);
    assert_eq!(queries[0]["model"], "HookFirst.Budget");
    assert!(queries[0].get("parent").is_none(), "unscoped hook scan keeps no parent");
    assert_eq!(queries[0]["order"], serde_json::json!([]));
    assert_eq!(queries[0]["archived"], "exclude");
    let dependencies = queries[0]["dependencies"].as_array().unwrap();
    assert_eq!(dependencies.len(), 1);
    assert_eq!(dependencies[0]["role"], "control");
    assert_eq!(dependencies[0]["field"], "source");
    assert_eq!(dependencies[0]["type"], "text");
    assert_eq!(plan["returns"].as_array().unwrap().len(), 2);
    let callable = artifact["callables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|callable| callable["id"] == "HookFirst.probe")
        .unwrap();
    assert_eq!(callable["kind"], "handler");
}

/// Authored ordering on the hook shape stays refused: only the unordered
/// engine-default selection is admitted.
#[test]
fn hook_event_first_query_with_order_stays_refused() {
    first_query_refusal(&HOOK_FIRST_SOURCE.replace(
        "first(Budget as row where row.source==event.source)",
        "first(Budget as row where row.source==event.source order=row.id)",
    ));
}

/// Non-text event operands stay refused: the hook arm admits text only.
#[test]
fn hook_event_first_query_with_int_operand_stays_refused() {
    let source = "app HookFirst\nGiven\n Budget {seq:int,approved:bool}\n event Tick {seq:int}\n policy Budget read=public\nWhen\n scenario probe on=Tick\n  do\n   let budget=first(Budget as row where row.seq==event.seq)\n   require budget!=null and budget.approved\nThen\n";
    first_query_refusal(source);
}

/// Multi-hop event chains stay refused: only `event.<field>` is admitted.
#[test]
fn hook_event_first_query_with_chained_operand_stays_refused() {
    let source = "app HookFirst\nGiven\n Note {source:text}\n Budget {source:text,approved:bool}\n event Tick {note:Note}\n policy Budget read=public\nWhen\n scenario probe on=Tick\n  do\n   let budget=first(Budget as row where row.source==event.note.source)\n   require budget!=null and budget.approved\nThen\n";
    first_query_refusal(source);
}

/// A second first-query in the hook body stays refused: the slice admits
/// exactly one.
#[test]
fn hook_event_first_query_with_second_let_stays_refused() {
    first_query_refusal(&HOOK_FIRST_SOURCE.replace(
        "   let budget=first(Budget as row where row.source==event.source)\n",
        "   let prior=first(Budget as row where row.source==event.source)\n   let budget=first(Budget as row where row.source==event.source)\n",
    ));
}

/// Split requirements stay refused: the slice admits the single non-null
/// conjunction shape.
#[test]
fn hook_event_first_query_with_split_requires_stays_refused() {
    first_query_refusal(&HOOK_FIRST_SOURCE.replace(
        "   require budget!=null and budget.approved\n",
        "   require budget!=null\n   require budget.approved\n",
    ));
}

/// The nullable-or twin stays refused, matching its `by=` counterpart.
#[test]
fn hook_event_first_query_with_nullable_or_stays_refused() {
    first_query_refusal(&HOOK_FIRST_SOURCE.replace(
        "   require budget!=null and budget.approved\n",
        "   require budget==null or budget.approved\n",
    ));
}

/// Header guards stay refused for the hook slice.
#[test]
fn hook_event_first_query_with_header_guard_stays_refused() {
    first_query_refusal(&HOOK_FIRST_SOURCE.replace(
        " scenario probe on=Tick\n",
        " scenario probe on=Tick\n  require event.source!=\"\"\n",
    ));
}

/// A hook without any first-query keeps its existing compilation: no
/// diagnostics and the ordinary pure lowering, never the native helper.
#[test]
fn hook_without_first_query_compiles_unchanged() {
    let source = "app HookFirst\nGiven\n Budget {source:text,approved:bool}\n event Tick {source:text}\n policy Budget read=public\nWhen\n scenario plain on=Tick\n  do\n   require event.source!=\"\"\nThen\n";
    let (db, program, _, catalog) = fixture_source("hook-plain.can", source);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let text = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(
        !text.contains("firstQuery("),
        "query-less hook gains no native query lowering"
    );
}

/// The `by=` void twin keeps its exact admission beside the hook slice.
#[test]
fn void_param_first_query_control_still_admits() {
    let source = "app VoidProbe\nGiven\n Budget {source:text,approved:bool}\n policy Budget read=members\nWhen\n scenario generate(source:text,accept:bool) by=members\n  do\n   let budget=first(Budget as row where row.source==source)\n   require budget!=null and budget.approved\n   require accept\nThen\n";
    let (db, program, _, catalog) = fixture_source("void-param-control.can", source);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let text = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(text.contains("await firstQuery(c,await executeScenarioReceiptQuery(c,"));
}

/// The contained-domain `by=` slice keeps its exact admitted parent edge.
#[test]
fn contained_param_first_query_control_still_admits() {
    let source = "app DomainProbe\nGiven\n Term {name:text}\n Seat in Term {account:user,active:bool}\n policy Term read=members\n policy Seat read=members\nWhen\n scenario assign(term:Term,account:user) -> bool by=members\n  do\n   let seat=first(term.Seat as seat where seat.account==account order=seat.id)\n   require seat!=null and seat.active\n   return true\nThen\n";
    let (db, program, _, catalog) = fixture_source("contained-control.can", source);
    let (artifact, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let operation = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == "DomainProbe.assign")
        .unwrap();
    assert_eq!(
        operation["result"]["disclosure"]["queries"][0]["parent"]["origin"]["parameter"],
        "term"
    );
}
