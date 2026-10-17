//! Finite first-query slice: if-branch conditional creates (CAN18-v1).
//!
//! Selected admitted family (smallest complete): a contained single-predicate
//! id-ordered first query with an `if <binding>==null` branch holding exactly
//! one nested create, requires and proven sets in the arms, and a captured
//! tail (requires, literal returns, proven sets/emits). The taken arm executes
//! through normal per-effect authorization; the receipt observes the proven
//! statements, it does not pre-register which arm runs. The arm binding must
//! not leak: arm/trailing lets are refused (no laundering or shadowing), and
//! the binding name must not occur in the condition, the sibling arm, or any
//! trailing statement.
//!
//! Deliberately still refused (exact next scope, not this batch): void
//! first-query scenarios (empty-returns plan), two creates under one branch,
//! non-null-check conditions on nested creates, arm lets/calls, trailing
//! calls/lets/branches, and uses of the conditional binding outside its arm.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

const IFBRANCH: &str = include_str!("fixtures/first-query-ifbranch-create.can");

const TWO_CREATES: &str = r#"app IfBranchSources
Given
 P {v:int}
 C in P {v:int}
 D {w:int}
 policy P read=members fields=v
 policy C read=members fields=parent,v
 policy D read=members fields=w
When
 crud P by=members fields=v
 crud C by=members fields=parent,v
 scenario go_two(p:P,n:int) -> int by=members
  do
   let c=first(p.C as c where c.v==n order=c.id)
   if c==null
    create D {w=n} as d
   else
    create D {w=0} as e
   return 1
Then
"#;

const INPUT_CONDITION: &str = r#"app IfBranchSources
Given
 P {v:int}
 C in P {v:int}
 D {w:int}
 policy P read=members fields=v
 policy C read=members fields=parent,v
 policy D read=members fields=w
When
 crud P by=members fields=v
 crud C by=members fields=parent,v
 scenario go_input(p:P,n:int) -> int by=members
  do
   let c=first(p.C as c where c.v==n order=c.id)
   require c==null
   if n==0
    create D {w=n} as d
   return 1
Then
"#;

const TRAILING_USE: &str = r#"app IfBranchSources
Given
 P {v:int}
 C in P {v:int}
 D {w:int}
 policy P read=members fields=v
 policy C read=members fields=parent,v
 policy D read=members fields=w
When
 crud P by=members fields=v
 crud C by=members fields=parent,v
 scenario go_use(p:P,n:int) -> int by=members
  do
   let c=first(p.C as c where c.v==n order=c.id)
   if c==null
    create D {w=n} as d
   else
    require n==0
   require d.w==0
   return 1
Then
"#;

const ARM_LET: &str = r#"app IfBranchSources
Given
 P {v:int}
 C in P {v:int}
 D {w:int}
 policy P read=members fields=v
 policy C read=members fields=parent,v
 policy D read=members fields=w
When
 crud P by=members fields=v
 crud C by=members fields=parent,v
 scenario go_let(p:P,n:int) -> int by=members
  do
   let c=first(p.C as c where c.v==n order=c.id)
   if c==null
    let m=n
    create D {w=m} as d
   else
    require n==0
   return 1
Then
"#;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

fn native_catalog_path() -> PathBuf {
    if let Some(path) = std::env::var_os("CAN_NATIVE_CATALOG") {
        return path.into();
    }
    root().join("packages/cloudflare/dist/native-catalog.json")
}

fn fixture_source(path: &str, source: &str) -> (SourceDb, CheckedProgram, ir::IrProgram, Catalog) {
    let mut db = SourceDb::new();
    let file = db.add(path.into(), source.into());
    let path = native_catalog_path();
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
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit, to_json_string};
    use canlang_compiler::diagnostic::DiagnosticResult;
    let mut result = DiagnosticResult::new("first-query-ifbranch", "1.0", 1);
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

fn operation<'a>(artifact: &'a Value, name: &str) -> &'a Value {
    artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == name)
        .unwrap()
}

fn has_e6008(diagnostics: &[Diagnostic], fragment: &str) -> bool {
    diagnostics
        .iter()
        .any(|diagnostic| diagnostic.code == "E6008" && diagnostic.message.contains(fragment))
}

fn admitted_disclosure<'a>(prepared: &'a Value, operation_name: &str) -> &'a Value {
    let disclosure = &operation(prepared, operation_name)["result"]["disclosure"];
    let [query] = disclosure["queries"].as_array().unwrap().as_slice() else {
        panic!("one first query")
    };
    assert_eq!(query["model"], "IfBranchSources.C");
    assert_eq!(
        query["order"],
        serde_json::json!([{ "field": "id", "direction": "asc" }])
    );
    // The shared tail return is reached via both branch paths, so the receipt
    // factors one scalar return per path, each with the same four query
    // influences and no data dependencies.
    let returns = disclosure["returns"].as_array().unwrap();
    assert_eq!(returns.len(), 2, "branch-factored returns");
    for returned in returns {
        assert!(returned["projection"].is_null());
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
        assert!(returned["dependencies"].as_array().unwrap().is_empty());
    }
    assert_ne!(returns[0]["id"], returns[1]["id"]);
    let js = prepared["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(js.contains("firstQuery("), "emitted native query call");
    assert!(
        !js.contains("first query lacks its checked native source"),
        "no unprepared-query fallback"
    );
    disclosure
}

#[test]
fn ifbranch_create_else_set_admits() {
    let (db, program, _, catalog) = fixture_source("ifbranch-create.can", IFBRANCH);
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    admitted_disclosure(&prepared, "IfBranchSources.go_branch");
    let _ = db;
}

#[test]
fn ifbranch_trailing_set_admits() {
    let (db, program, _, catalog) = fixture_source("ifbranch-create.can", IFBRANCH);
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    admitted_disclosure(&prepared, "IfBranchSources.go_trailing");
    let _ = db;
}

#[test]
fn ifbranch_two_creates_refuse() {
    let (db, program, _, catalog) = fixture_source("ifbranch-two-creates.can", TWO_CREATES);
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(
        has_e6008(&diagnostics, "cannot lower first query"),
        "two conditional creates keep their loud refusal, got {diagnostics:?}"
    );
    let _ = db;
}

#[test]
fn ifbranch_input_condition_create_refuses() {
    let (db, program, _, catalog) = fixture_source("ifbranch-input-cond.can", INPUT_CONDITION);
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(
        has_e6008(&diagnostics, "cannot lower first query"),
        "non-null-check nested create keeps its loud refusal, got {diagnostics:?}"
    );
    let _ = db;
}

#[test]
fn ifbranch_trailing_binding_use_refuses() {
    // A trailing use of the arm binding never resolves: the postdominator
    // env reset drops arm bindings, so checking fails loudly with E2001
    // before any receipt is even attempted. This pins the no-leak property
    // at its earliest boundary.
    let mut db = SourceDb::new();
    let file = db.add("ifbranch-trailing-use.can".into(), TRAILING_USE.into());
    let path = native_catalog_path();
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (_, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(
        diagnostics.iter().any(|diagnostic| {
            diagnostic.code == "E2001" && diagnostic.message.contains("unresolved name")
        }),
        "trailing use of the conditional binding keeps its loud refusal, got {diagnostics:?}"
    );
    let _ = db;
}

#[test]
fn ifbranch_arm_let_refuses() {
    let (db, program, _, catalog) = fixture_source("ifbranch-arm-let.can", ARM_LET);
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(
        has_e6008(&diagnostics, "cannot lower first query"),
        "arm lets keep their loud refusal, got {diagnostics:?}"
    );
    let _ = db;
}

/// The refused conditional tails leave no prepared native recipe: the genuine
/// CLI reports the loud E6008 envelope (exit 10) with no `operations` array at
/// all, so no executable native query/create plan exists for them downstream.
#[test]
fn genuine_cli_refused_ifbranch_tails_emit_no_operations() {
    let scratch = tempfile::tempdir().unwrap();
    for (mode, source, code, fragment) in [
        ("two-creates", TWO_CREATES, "E6008", "cannot lower"),
        ("input-cond", INPUT_CONDITION, "E6008", "cannot lower"),
        ("trailing-use", TRAILING_USE, "E2001", "unresolved name"),
        ("arm-let", ARM_LET, "E6008", "cannot lower"),
    ] {
        let path = scratch.path().join(format!("ifbranch-{mode}.can"));
        std::fs::write(&path, source.as_bytes()).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args([
                "compile",
                "--native-scenario-receipts",
                "--format=json",
                "--catalog",
            ])
            .arg(native_catalog_path())
            .arg(&path)
            .current_dir(root())
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
        let refused = envelope["diagnostics"]
            .as_array()
            .is_some_and(|diagnostics| {
                diagnostics.iter().any(|diagnostic| {
                    diagnostic["code"] == code
                        && diagnostic["message"]
                            .as_str()
                            .is_some_and(|message| message.contains(fragment))
                })
            });
        assert!(
            refused && envelope.get("operations").is_none(),
            "{mode}: refused conditional tail must leave no prepared native recipe, got {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            sha256_hex(source.as_bytes()),
            sha256_hex(std::fs::read(&path).unwrap().as_slice())
        );
    }
}

