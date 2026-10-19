//! Finite actor-guard slice: checked contextual `actor.email` /
//! `actor.email_verified` reads in scenario requires (CAN18-v1).
//!
//! Selected admitted family (smallest complete): a literal-`actor`
//! member read of exactly `email`/`email_verified` with matching checked
//! types evaluates through the existing host-supplied `actorFacts`
//! carrier. Grouping is transparent. The analysis records no store
//! grant, and receipt correspondence pins the decoded `c.actorFacts`
//! receivers (middle keeps the caller-row User type over the exact
//! authored actor occurrence; inner synthetic `c` stays Unknown over
//! the pre-unwrap wrapper occurrence) against the authored occurrence.
//!
//! Deliberately still refused: aliases of actor (`let a = actor`),
//! user-typed input member reads, unknown actor fields (early E2013),
//! and hook `actor.<field>` reads (E3003: no hook carrier).
use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::codegen::ir;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::{SourceDb, Span};
use serde_json::Value;
use std::path::{Path, PathBuf};

const FIXTURE: &str = include_str!("fixtures/first-query-actor-guard.can");

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

fn check_source(
    path: &str,
    source: &str,
) -> (SourceDb, CheckedProgram, Catalog, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let file = db.add(path.into(), source.into());
    let catalog_path = native_catalog_path();
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (program, diagnostics) = check_program(&db, &[file], Some(&catalog));
    (db, program, catalog, diagnostics)
}

fn fixture_source(path: &str, source: &str) -> (SourceDb, CheckedProgram, ir::IrProgram, Catalog) {
    let (db, program, catalog, diagnostics) = check_source(path, source);
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
    use canlang_compiler::codegen::{EmitOptions, EmitSources, emit};
use canlang_compiler::codegen::artifact::to_json;
    use canlang_compiler::diagnostic::DiagnosticResult;
    let mut result = DiagnosticResult::new("first-query-actor-guard", "1.0", 1);
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

fn has_code(diagnostics: &[Diagnostic], code: &str) -> bool {
    diagnostics.iter().any(|d| d.code == code)
}

fn emitted_js(prepared: &Value) -> String {
    prepared["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn actor_guard_fixture_admits_with_facts_carrier() {
    let (db, program, _, catalog) = fixture_source("actor-guard.can", FIXTURE);
    let (prepared, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let disclosure = &prepared["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|op| op["name"] == "ActorGuardProbe.accept")
        .unwrap()["result"]["disclosure"];
    assert!(
        disclosure["queries"].as_array().unwrap().len() == 1,
        "navigation-parent first query retained"
    );
    let js = emitted_js(&prepared);
    assert!(js.contains("c.actorFacts.email_verified"), "verified guard carrier");
    assert!(js.contains("c.actorFacts.email"), "email guard carrier");
    assert!(!js.contains("c.actor.email"), "no direct actor row read emitted");
    let _ = db;
}

#[test]
fn grouped_actor_guard_admits() {
    let source = FIXTURE.replace(
        "require actor.email_verified and invitation.email==actor.email",
        "require (actor).email_verified and (invitation).email==(actor).email",
    );
    let (db, program, _, catalog) = fixture_source("actor-grouped.can", &source);
    let (_, diagnostics) = prepared_artifact(&program, &db, &catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let _ = db;
}

#[test]
fn actor_alias_cannot_acquire_facts() {
    let source = FIXTURE.replace(
        "require actor.email_verified and invitation.email==actor.email",
        "let watcher = actor\n   require watcher.email_verified",
    );
    let (_, _, _, diagnostics) = check_source("actor-alias.can", &source);
    assert!(has_code(&diagnostics, "E2013"), "{diagnostics:?}");
}

#[test]
fn unknown_actor_field_refuses() {
    let source = FIXTURE.replace("actor.email_verified", "actor.phone");
    let (_, _, _, diagnostics) = check_source("actor-unknown.can", &source);
    assert!(has_code(&diagnostics, "E2013"), "{diagnostics:?}");
}
