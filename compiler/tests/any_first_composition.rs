//! Leading `require not any(...)` composed with a companion `first` query.
//!
//! The admitted direct-any profile is narrow: a leading negated `any`
//! over a navigated `invitation.parent.C` domain whose conjunction
//! conjuncts are each sealed by operand shape/name/field/type/span
//! (including the exact `c.actor` carrier) with the shared one-hop
//! parent lineage, under `by=members` or `by=authenticated`. The
//! original CanCustomer accept uses `by=authenticated` over the same
//! navigated domain; recover uses a reference-array helper closure and
//! remains separate recorded work, not claimed here.
//! The scenario below is void (the accept shape): the installed
//! `native-any-first-composition` consumer proves the executable half;
//! these units pin source-level admission and refusals, while the
//! retained-IR matcher seals live in-crate
//! (`any_first_retained_tests`), not re-proven here.
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::artifact::to_json;
use canlang_compiler::codegen::ir;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, Span};
use serde_json::Value;
use std::path::{Path, PathBuf};

const BASE: &str = r#"app AnyFirstProbe
Given
 P {v:int,active:bool=true}
 C in P {account:user,role:enum(administrator,booker),active:bool=true}
 D in P {account:user,role:C.role,w:int}
 I in P {role:C.role}
 policy P read=members fields=v,active
 policy C read=members fields=parent,account,role,active
 policy D read=members fields=parent,account,role,w
 policy I read=members fields=parent,role
When
 crud P by=members fields=v
 crud C by=members fields=parent,account,role,active
 crud D by=members fields=parent,account,role,w
 crud I by=members fields=parent,role
 scenario accept(invitation:I) by=members
  require not any(invitation.parent.C as grant,GRANT)
  do
   let c=first(invitation.parent.C as c where c.account==actor and c.role==invitation.role order=c.id)
   require c!=null
   create D {parent=invitation.parent,account=actor,role=invitation.role,w=1} as d
Then
"#;

const GRANT: &str = "grant.account==actor and grant.role==invitation.role and grant.active";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

struct Loaded {
    db: SourceDb,
    catalog: Catalog,
    diagnostics: Vec<Diagnostic>,
    checked: Option<CheckedProgram>,
}

fn load(path: &str, source: &str) -> Loaded {
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
    if !diagnostics.is_empty() {
        return Loaded {
            db,
            catalog,
            diagnostics,
            checked: None,
        };
    }
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let _ = ir;
    Loaded {
        db,
        catalog,
        diagnostics: Vec::new(),
        checked: Some(program),
    }
}

fn prepared(
    program: &CheckedProgram,
    db: &SourceDb,
    catalog: &Catalog,
) -> (Value, Vec<Diagnostic>) {
    let mut result = DiagnosticResult::new("any-first-composition", "1.0", 1);
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

fn operation<'a>(artifact: &'a Value, name: &str) -> &'a Value {
    artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == name)
        .unwrap()
}

fn source(name: &str, grant: &str) -> String {
    BASE.replace("GRANT", grant).replace("AnyFirstProbe", name)
}

fn accept_queries(prepared: &Value, app: &str) -> Vec<Value> {
    operation(prepared, &format!("{app}.accept"))["result"]["disclosure"]["queries"]
        .as_array()
        .unwrap()
        .clone()
}

fn emitted_predicate(prepared: &Value) -> String {
    prepared["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap_or(""))
        .find(|js| js.contains("queryAny"))
        .unwrap_or("")
        .into()
}

#[test]
fn any_first_composition_admits_sealed_conjunction() {
    let loaded = load(
        "any-first-composition-unit.can",
        &source("AnyFirstProbe", GRANT),
    );
    assert!(loaded.diagnostics.is_empty(), "{:?}", loaded.diagnostics);
    let Loaded {
        db,
        catalog,
        checked,
        ..
    } = loaded;
    let program = checked.unwrap();
    let (prepared, diagnostics) = prepared(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let queries = accept_queries(&prepared, "AnyFirstProbe");
    assert_eq!(queries.len(), 2, "any plus first queries, got {queries:?}");
    let any = queries
        .iter()
        .find(|query| query["dependencies"].as_array().unwrap().len() == 3)
        .expect("three-conjunct any query");
    assert_eq!(any["parent"]["model"], "AnyFirstProbe.P");
    assert_eq!(any["parent"]["origin"]["kind"], "admitted-reference");
    let js = emitted_predicate(&prepared);
    assert!(
        js.contains(r#""kind":"predicate""#) && js.contains(r#""direct":true"#),
        "emitted direct predicate ANY callback, got {js:?}"
    );
    let _ = db;
}

#[test]
fn authenticated_by_admits_same_sealed_composition() {
    let src = source("AnyFirstAuthProbe", GRANT).replacen(
        "scenario accept(invitation:I) by=members",
        "scenario accept(invitation:I) by=authenticated",
        1,
    );
    let loaded = load("any-first-authenticated-unit.can", &src);
    assert!(loaded.diagnostics.is_empty(), "{:?}", loaded.diagnostics);
    let Loaded {
        db,
        catalog,
        checked,
        ..
    } = loaded;
    let program = checked.unwrap();
    let (prepared, diagnostics) = prepared(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let queries = accept_queries(&prepared, "AnyFirstAuthProbe");
    assert_eq!(queries.len(), 2, "any plus first queries, got {queries:?}");
    let any = queries
        .iter()
        .find(|query| query["dependencies"].as_array().unwrap().len() == 3)
        .expect("three-conjunct any query");
    assert_eq!(any["parent"]["model"], "AnyFirstAuthProbe.P");
    assert_eq!(any["parent"]["origin"]["kind"], "admitted-reference");
    let js = emitted_predicate(&prepared);
    assert!(
        js.contains(r#""kind":"predicate""#) && js.contains(r#""direct":true"#),
        "emitted direct predicate ANY callback, got {js:?}"
    );
    let _ = db;
}

#[test]
fn reordered_conjunction_admits_with_same_census() {
    // Pure conjuncts commute: reordered source still seals each operand
    // to its own span, so the same three CONTROL deps admit.
    let loaded = load(
        "any-first-reorder.can",
        &source(
            "AnyFirstReorder",
            "grant.role==invitation.role and grant.account==actor and grant.active",
        ),
    );
    assert!(loaded.diagnostics.is_empty(), "{:?}", loaded.diagnostics);
    let Loaded {
        db,
        catalog,
        checked,
        ..
    } = loaded;
    let (prepared, diagnostics) = prepared(&checked.unwrap(), &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let queries = accept_queries(&prepared, "AnyFirstReorder");
    assert_eq!(queries.len(), 2, "any plus first queries, got {queries:?}");
    let _ = db;
}

#[test]
fn conjunct_subset_admits_smaller_census() {
    // A two-conjunct any over the same domain is independently coherent:
    // admission is shape-generic, not hardcoded to three conjuncts.
    let loaded = load(
        "any-first-subset.can",
        &source(
            "AnyFirstSubset",
            "grant.account==actor and grant.role==invitation.role",
        ),
    );
    assert!(loaded.diagnostics.is_empty(), "{:?}", loaded.diagnostics);
    let Loaded {
        db,
        catalog,
        checked,
        ..
    } = loaded;
    let (prepared, diagnostics) = prepared(&checked.unwrap(), &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let queries = accept_queries(&prepared, "AnyFirstSubset");
    assert_eq!(queries.len(), 2, "any plus first queries, got {queries:?}");
    let _ = db;
}

#[test]
fn positive_polarity_any_admits_same_composition() {
    // CAN18 outcome5 (C02/C04/C19): the positive dual of the negated
    // composition admits the same sealed narrow profile. Polarity lives
    // in the emitted guard alone, never in the receipt plan; this
    // supersedes the earlier positive-polarity refusal.
    let loaded = load(
        "any-first-positive.can",
        &source("AnyFirstPositive", GRANT).replace("require not any(", "require any("),
    );
    assert!(loaded.diagnostics.is_empty(), "{:?}", loaded.diagnostics);
    let Loaded {
        db,
        catalog,
        checked,
        ..
    } = loaded;
    let program = checked.unwrap();
    let (prepared, diagnostics) = prepared(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let queries = accept_queries(&prepared, "AnyFirstPositive");
    assert_eq!(queries.len(), 2, "any plus first queries, got {queries:?}");
    let any = queries
        .iter()
        .find(|query| query["dependencies"].as_array().unwrap().len() == 3)
        .expect("three-conjunct any query");
    assert_eq!(any["parent"]["model"], "AnyFirstPositive.P");
    assert_eq!(any["parent"]["origin"]["kind"], "admitted-reference");
    let js = emitted_predicate(&prepared);
    assert!(
        js.contains(r#""kind":"predicate""#) && js.contains(r#""direct":true"#),
        "emitted direct predicate ANY callback, got {js:?}"
    );
    let _ = db;
}

#[test]
fn operand_type_mismatch_refuses_at_check() {
    let loaded = load(
        "any-first-typemismatch.can",
        &source(
            "AnyFirstTypemismatch",
            "grant.account==invitation.role and grant.active",
        ),
    );
    assert!(
        loaded
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3002"),
        "user/enum operand confusion must refuse, got {:?}",
        loaded.diagnostics
    );
}

#[test]
fn cross_model_composition_refuses() {
    // `any` over parent.D beside `first` over parent.C stays refused:
    // the narrow profile composes one shared domain, not mixed models.
    let loaded = load(
        "any-first-foreign.can",
        &source(
            "AnyFirstForeign",
            "grant.account==actor and grant.role==invitation.role",
        )
        .replace(
            "invitation.parent.C as grant",
            "invitation.parent.D as grant",
        ),
    );
    assert!(loaded.diagnostics.is_empty(), "{:?}", loaded.diagnostics);
    let Loaded {
        db,
        catalog,
        checked,
        ..
    } = loaded;
    let (_, diagnostics) = prepared(&checked.unwrap(), &db, &catalog);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "cross-model any/first must keep the refusal, got {diagnostics:?}"
    );
    let _ = db;
}
