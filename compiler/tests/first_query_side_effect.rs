//! Finite first-query slice: terminal side-effect creates (CAN18-v1).
//!
//! Selected admitted family (smallest complete): a contained single-predicate
//! id-ordered first query with a presence (`!=null`) require, one top-level
//! create immediately followed by exactly one plain scalar-constant return
//! and nothing else. The create executes terminally as a side effect in
//! source order. The admission rule is deliberately positional: any other
//! tail (operation/helper calls, lets, aliases, branches, further effects)
//! keeps the intermediate-call linkage or its loud refusal, so alias escapes
//! through objects, branches or rebindings cannot slip through as unlinked
//! side effects. No use/alias inventory is attempted.
//!
//! Deliberately still refused (exact next scope, not this batch): bare
//! absence requires, `if` absence/presence branches with in-branch creates,
//! `==null`-or field-check requires, and predicateless first queries. Their
//! absence/conditional-create replay needs the State runtime owner; the
//! compiler keeps the precise correspondence refusal meanwhile.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::{SourceDb, Span, sha256_hex};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

const SEED: &str = r#"app SideEffectSources
Given
 P {v:int=0}
 C in P {v:int=0}
 D {w:int=0}
 policy P read=members
 policy C read=members
 policy D read=members
When
 crud P by=members fields=v
 crud C by=members fields=parent,v
 scenario go(p:P,n:int) -> int by=members
  do
   let c=first(p.C as c where c.v==n order=c.id)
   require c!=null
   create D {w=n} as d
   return 1
Then
"#;

const SAME_MODEL: &str = r#"app SideEffectSources
Given
 P {v:int=0}
 C in P {v:int=0}
 D {}
 policy P read=members
 policy C read=members
 policy D read=members
When
 scenario go(p:P,n:int) -> int by=members
  do
   let c=first(p.C as c where c.v==n order=c.id)
   require c!=null
   create C {parent=p,v=n} as created
   return 1
Then
"#;

const DIRECT_CALL: &str = r#"app SideEffectSources
Given
 P {v:int=0}
 C in P {v:int=0}
 D {}
 policy P read=members
 policy C read=members
 policy D read=members
When
 scenario sink(d:D) -> int by=members
  do
   return 1
 scenario go(p:P,n:int) -> int by=members
  do
   let c=first(p.C as c where c.v==n order=c.id)
   require c!=null
   create D {} as d
   call sink {d} as s
   return 1
Then
"#;

const HELPER_CALL: &str = r#"app SideEffectSources
Given
 P {v:int=0}
 C in P {v:int=0}
 D {w:int=0}
 policy P read=members
 policy C read=members
 policy D read=members
 derive tag(d:D):int = d.w
When
 scenario go(p:P,n:int) -> int by=members
  do
   let c=first(p.C as c where c.v==n order=c.id)
   require c!=null
   create D {w=n} as d
   let t=tag(d)
   return 1
Then
"#;

const ALIAS_CALL: &str = r#"app SideEffectSources
Given
 P {v:int=0}
 C in P {v:int=0}
 D {w:int=0}
 policy P read=members
 policy C read=members
 policy D read=members
 derive tag(d:D):int = d.w
When
 scenario go(p:P,n:int) -> int by=members
  do
   let c=first(p.C as c where c.v==n order=c.id)
   require c!=null
   create D {w=n} as d
   let alias=d
   let t=tag(alias)
   return 1
Then
"#;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().into()
}

fn native_owner_root() -> PathBuf {
    // Repository-relative by default; the old canonical-checkout hardcode
    // would silently consume another checkout's catalog.
    root()
}

/// Explicit frozen catalog override wins (e.g. `CAN_NATIVE_CATALOG` pointing
/// at an immutable producer copy); otherwise the repository-relative native
/// catalog next to the checkout under test. Validation never silently
/// consumes another checkout's catalog.
fn native_catalog_path() -> PathBuf {
    if let Some(path) = std::env::var_os("CAN_NATIVE_CATALOG") {
        return path.into();
    }
    native_owner_root().join("packages/cloudflare/dist/native-catalog.json")
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
    let mut result = DiagnosticResult::new("first-query-side-effect", "1.0", 1);
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
    diagnostics.iter().any(|diagnostic| {
        diagnostic.code == "E6008" && diagnostic.message.contains(fragment)
    })
}

/// The refused tail leaves no prepared native recipe: the genuine CLI reports
/// the loud E6008 envelope (exit 10) with no `operations` array at all, so
/// no executable native query/create plan exists for it downstream. This
/// pins the actual prepared-recipe exclusion rather than only the
/// diagnostic text (which another lowering owner can also emit).
fn genuine_cli_envelope_has_no_operations(output: &std::process::Output) -> bool {
    if output.status.success() {
        return false;
    }
    let envelope: Value = serde_json::from_slice(&output.stdout).unwrap();
    let has_e6008 = envelope["diagnostics"]
        .as_array()
        .is_some_and(|diagnostics| {
            diagnostics.iter().any(|diagnostic| {
                diagnostic["code"] == "E6008"
                    && diagnostic["message"]
                        .as_str()
                        .is_some_and(|message| message.contains("cannot lower"))
            })
        });
    has_e6008 && envelope.get("operations").is_none()
}

#[test]
fn terminal_side_effect_scalar_return_admits() {
    let (db, program, _, catalog) = fixture_source("side-effect-seed.can", SEED);
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let disclosure = &operation(&prepared, "SideEffectSources.go")["result"]["disclosure"];
    let [query] = disclosure["queries"].as_array().unwrap().as_slice() else {
        panic!("one first query")
    };
    assert_eq!(query["model"], "SideEffectSources.C");
    assert_eq!(
        query["order"],
        serde_json::json!([{ "field": "id", "direction": "asc" }])
    );
    let [returned] = disclosure["returns"].as_array().unwrap().as_slice() else {
        panic!("one scalar return")
    };
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
    let _ = db;
}

#[test]
fn same_model_terminal_create_admits() {
    let (db, program, _, catalog) = fixture_source("side-effect-same-model.can", SAME_MODEL);
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let _ = db;
}

#[test]
fn direct_operation_call_use_refuses() {
    let (db, program, _, catalog) = fixture_source("side-effect-direct-call.can", DIRECT_CALL);
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(
        has_e6008(&diagnostics, "cannot lower call effect"),
        "later operation call keeps its loud linkage refusal, got {diagnostics:?}"
    );
    let _ = db;
}

#[test]
fn helper_call_use_refuses() {
    let (db, program, _, catalog) = fixture_source("side-effect-helper-call.can", HELPER_CALL);
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(
        has_e6008(&diagnostics, "original native query correspondence"),
        "helper consumption of the created binding refuses, got {diagnostics:?}"
    );
    let _ = db;
}

#[test]
fn alias_threaded_call_use_refuses() {
    let (db, program, _, catalog) = fixture_source("side-effect-alias-call.can", ALIAS_CALL);
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(
        has_e6008(&diagnostics, "original native query correspondence"),
        "`let` alias use refuses exactly like the direct use, got {diagnostics:?}"
    );
    let _ = db;
}

#[test]
fn genuine_cli_refused_tails_emit_no_operations() {
    let scratch = tempfile::tempdir().unwrap();
    for (mode, source) in [
        ("direct-call", DIRECT_CALL),
        ("helper-call", HELPER_CALL),
        ("alias-call", ALIAS_CALL),
    ] {
        let path = scratch.path().join(format!("side-effect-{mode}.can"));
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
        assert!(
            genuine_cli_envelope_has_no_operations(&output),
            "{mode}: refused tail must leave no prepared native recipe, got {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            sha256_hex(source.as_bytes()),
            sha256_hex(std::fs::read(&path).unwrap().as_slice())
        );
    }
}

#[test]
fn absence_require_admits() {
    // Absence primitive: `require c==null` consumes only the first
    // binding's absence (same confined carve-out as `!=null`), so the
    // terminal create + scalar return admits with the same four query
    // influences and no stored-read dependencies.
    let source = SEED.replace("require c!=null", "require c==null");
    let (db, program, _, catalog) = fixture_source("side-effect-absence.can", &source);
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let disclosure = &operation(&prepared, "SideEffectSources.go")["result"]["disclosure"];
    let [query] = disclosure["queries"].as_array().unwrap().as_slice() else {
        panic!("one first query")
    };
    assert_eq!(query["model"], "SideEffectSources.C");
    let [returned] = disclosure["returns"].as_array().unwrap().as_slice() else {
        panic!("one scalar return")
    };
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
    let _ = db;
}

const CONJUNCTION: &str = include_str!("fixtures/first-query-side-effect-conjunction.can");

#[test]
fn absence_conjunctions_admit_with_control_dependency() {
    // Flow-sensitive conjunctions: `c==null or c.v==m` (RHS sees non-null
    // c) and `c!=null and c.v==m` (same) consume the binding's absence plus
    // one stored control read. The plan carries that control dependency; the
    // guard-consumed runtime slice (next scope) proves the field comparison
    // executes with decision authority.
    let (db, program, _, catalog) =
        fixture_source("first-query-side-effect-conjunction.can", CONJUNCTION);
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for name in [
        "ConjunctionSources.go_or",
        "ConjunctionSources.go_and",
    ] {
        let disclosure = &operation(&prepared, name)["result"]["disclosure"];
        let [query] = disclosure["queries"].as_array().unwrap().as_slice() else {
            panic!("{name}: one first query")
        };
        assert_eq!(query["model"], "ConjunctionSources.C");
    }
    let _ = db;
}

#[test]
fn absence_branch_and_predicateless_shapes_stay_refused() {
    // Still next scope: absence/presence branches with in-branch creates
    // and predicateless first queries. The compiler keeps the precise
    // correspondence refusal meanwhile.
    let cases = [
        (
            "absence-branch-create",
            SEED.replace(
                "require c!=null\n   create D {w=n} as d\n   return 1",
                "if c==null\n    create D {w=n} as d\n    return 1\n   else\n    return 0",
            ),
        ),
        (
            "predicateless-contained",
            SEED.replace(
                "first(p.C as c where c.v==n order=c.id)",
                "first(p.C as c order=c.id)",
            ),
        ),
    ];
    for (mode, source) in cases {
        let (db, program, _, catalog) = fixture_source("side-effect-refused.can", &source);
        let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
        assert!(
            has_e6008(&diagnostics, "original native query correspondence"),
            "{mode}: expected loud first-query refusal, got {diagnostics:?}"
        );
        let _ = db;
    }
}

#[test]
fn genuine_cli_side_effect_compiles() {
    let (db, program, _, catalog) = fixture_source("side-effect-seed.can", SEED);
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(operation(&prepared, "SideEffectSources.go")["result"]["disclosure"].is_object());
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("side-effect-seed.can");
    std::fs::write(&source, SEED.as_bytes()).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(native_catalog_path())
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
        .find(|operation| operation["name"] == "SideEffectSources.go")
        .unwrap();
    assert_eq!(
        operation["result"]["disclosure"]["queries"][0]["model"],
        serde_json::json!("SideEffectSources.C")
    );
    assert_eq!(
        sha256_hex(SEED.as_bytes()),
        sha256_hex(std::fs::read(&source).unwrap().as_slice())
    );
    let _ = db;
}
