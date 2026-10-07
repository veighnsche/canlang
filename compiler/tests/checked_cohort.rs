//! Public checked-input ownership controls. Artifacts are inspected here;
//! these tests do not claim execution of generated JavaScript.

use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::cli::{Analyzer, CatalogAnalyzer};
use canlang_compiler::codegen::artifact::CompileArtifact;
use canlang_compiler::codegen::{EmitOptions, EmitSources, emit, ir};
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, SourceId, Span};
use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};
use std::io::Write;
use tempfile::NamedTempFile;

const OLD: &str = "app Shop\nGiven\n Gadget { title:text=\"OLD\" }\nWhen\nThen\n";
const CALL: &str = "app Shop\nGiven\nWhen\n scenario echo(value:text) read=true -> text by=members\n  do\n   return lower(value)\nThen\n";

fn catalog_file(version: &str, effects: &str) -> NamedTempFile {
    let mut file = NamedTempFile::new().unwrap();
    write!(
        file,
        "{}",
        serde_json::json!({
            "language_version": "1.0", "catalog_version": version,
            "entries": [{"id": "lower", "js": "lower", "owner": "fixture",
                "kind": "builtin", "signature": "lower(value:text)->text",
                "effects": effects, "availability": "implemented"}]
        })
    )
    .unwrap();
    file
}

fn load(file: &NamedTempFile) -> Catalog {
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(file.path()),
        env: None,
        cwd: file.path().parent().unwrap(),
        primary: Span::new(SourceId(0), 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    catalog.unwrap()
}

fn owned(db: &SourceDb, file: &NamedTempFile) -> (CheckedProgram, DiagnosticResult, Catalog) {
    let analysis = CatalogAnalyzer::new(
        Some(file.path().to_path_buf()),
        None,
        file.path().parent().unwrap().to_path_buf(),
    )
    .analyze_owned(db, "cohort-test");
    assert!(analysis.result.complete);
    assert!(!analysis.result.has_errors(), "{:?}", analysis.result);
    (
        analysis.program.unwrap(),
        analysis.result,
        analysis.catalog.unwrap(),
    )
}

fn checked(
    db: &SourceDb,
    files: &[SourceId],
    catalog: Option<&Catalog>,
) -> (CheckedProgram, DiagnosticResult) {
    let (program, diagnostics) = check_program(db, files, catalog);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let mut result = DiagnosticResult::new("cohort-test", LANGUAGE_VERSION, SCHEMA_VERSION);
    result.add_sources(db);
    result.diagnostics = diagnostics;
    result.finish();
    (program, result)
}

fn emitted(
    program: &CheckedProgram,
    db: &SourceDb,
    result: &DiagnosticResult,
    catalog: Option<&Catalog>,
    options: EmitOptions,
) -> (CompileArtifact, Vec<Diagnostic>) {
    emit(
        program,
        &EmitSources {
            db,
            result,
            catalog,
            options,
        },
    )
}

fn clean(
    program: &CheckedProgram,
    db: &SourceDb,
    result: &DiagnosticResult,
    catalog: &Catalog,
) -> CompileArtifact {
    let (artifact, diagnostics) = emitted(program, db, result, Some(catalog), EmitOptions::new());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(!artifact.modules.is_empty());
    artifact
}

fn refused(
    program: &CheckedProgram,
    db: &SourceDb,
    result: &DiagnosticResult,
    catalog: Option<&Catalog>,
) {
    // Test-only must never acknowledge a source/catalog mismatch.
    for options in [EmitOptions::new(), EmitOptions::test_only()] {
        let (artifact, diagnostics) = emitted(program, db, result, catalog, options);
        assert_eq!(
            diagnostics.iter().map(|d| d.code).collect::<Vec<_>>(),
            ["E6011"]
        );
        assert!(artifact.modules.is_empty());
        assert!(artifact.callables.is_empty());
        assert!(artifact.operations.is_empty());
        assert!(artifact.models.is_empty());
        assert!(artifact.pages.is_empty());
        assert!(artifact.migrations.is_empty());
        assert!(artifact.tests.is_empty());
        assert!(artifact.requires.is_empty());
    }
    // Public direct-IR callers must receive the same refusal independently.
    let (ir, diagnostics) = ir::build(program, db, catalog);
    assert_eq!(
        diagnostics.iter().map(|d| d.code).collect::<Vec<_>>(),
        ["E6011"]
    );
    assert!(ir.modules.is_empty());
    assert!(ir.items.is_empty());
    assert!(ir.suites.is_empty());
    assert!(ir.migrations.is_empty());
}

#[test]
fn owned_control_and_foreign_equal_ids_spans_or_hashes() {
    let file = catalog_file("1.0.0", "pure");
    let mut db = SourceDb::default();
    let id = db.add("same.can".into(), OLD.into());
    let (program, result, catalog) = owned(&db, &file);
    assert!(
        clean(&program, &db, &result, &catalog).modules[0]
            .js
            .contains("\"OLD\"")
    );

    for text in [OLD.to_string(), OLD.replace("OLD", "NEW")] {
        assert_eq!(text.len(), OLD.len());
        let mut foreign = SourceDb::default();
        assert_eq!(foreign.add("same.can".into(), text), id);
        refused(&program, &foreign, &result, Some(&catalog));
    }
}

#[test]
fn swapped_source_numbering_refuses_and_rechecking_restores_ownership() {
    let file = catalog_file("1.0.0", "pure");
    let one = "app One\nGiven\n Thing { title:text=\"ONE\" }\nWhen\nThen\n";
    let two = one.replace("One", "Two").replace("ONE", "TWO");
    let mut db = SourceDb::new();
    db.add("one.can".into(), one.into());
    db.add("two.can".into(), two.clone());
    let (program, result, catalog) = owned(&db, &file);
    let mut foreign = SourceDb::new();
    foreign.add("two.can".into(), two);
    foreign.add("one.can".into(), one.into());
    refused(&program, &foreign, &result, Some(&catalog));

    let (rechecked, result) = checked(&foreign, &[SourceId(0), SourceId(1)], Some(&catalog));
    let artifact = clean(&rechecked, &foreign, &result, &catalog);
    assert_eq!(rechecked.modules[0].name, "Two");
    assert!(artifact.modules[0].js.contains("\"ONE\""));
    assert!(artifact.modules[0].js.contains("\"TWO\""));
}

#[test]
fn owner_moves_catalog_clone_and_immutable_append_preserve_old_semantics_and_inventory() {
    let file = catalog_file("1.0.0", "pure");
    let mut db = SourceDb::new();
    let id = db.add("same.can".into(), OLD.into());
    let (program, result, catalog) = owned(&db, &file);
    let before = clean(&program, &db, &result, &catalog);
    let mut moved_db = db;
    let moved_catalog = catalog;
    let clone = moved_catalog.clone();
    drop(moved_catalog);
    moved_db.add("same.can".into(), OLD.replace("OLD", "NEW"));
    assert_eq!(moved_db.get(id).unwrap().text, OLD);
    assert_eq!(program.checked_files(), &[id]);
    let after = clean(&program, &moved_db, &result, &clone);
    assert_eq!(after.modules[0].js, before.modules[0].js);
    assert_eq!(after.sources.len(), 2);
    assert_eq!(after.sources[0].sha256, before.sources[0].sha256);
    assert_ne!(after.sources[0].sha256, after.sources[1].sha256);
    assert_eq!(after.modules[0].map.sources_content.len(), 2);
    assert_eq!(
        after.modules[0].map.sources_content[0].as_deref(),
        Some(OLD)
    );
    assert!(
        after.modules[0].map.sources_content[1]
            .as_deref()
            .unwrap()
            .contains("NEW")
    );
    let (ir, diagnostics) = ir::build(&program, &moved_db, Some(&clone));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(!ir.items.is_empty());
}

#[test]
fn changed_or_independently_reloaded_catalog_requires_rechecking() {
    let file = catalog_file("1.0.0", "pure");
    let mut db = SourceDb::new();
    db.add("call.can".into(), CALL.into());
    let (program, result, catalog) = owned(&db, &file);
    let baseline = clean(&program, &db, &result, &catalog);
    assert!(baseline.modules[0].js.contains("lower("));
    assert!(!baseline.modules[0].js.contains("await lower("));
    // Exact same bytes/version still create a different catalog owner.
    refused(&program, &db, &result, Some(&load(&file)));

    for version in ["1.0.0", "7.0.0"] {
        let changed = load(&catalog_file(version, "state-read"));
        refused(&program, &db, &result, Some(&changed));
        let (rechecked, result) = checked(&db, &[SourceId(0)], Some(&changed));
        let artifact = clean(&rechecked, &db, &result, &changed);
        assert!(artifact.modules[0].js.contains("await lower("));
        assert_eq!(artifact.requires[0].min_version.to_string(), &version[..1]);
    }
}

#[test]
fn complete_gate_and_test_only_acknowledgment_are_separate_from_cohort() {
    let file = catalog_file("1.0.0", "pure");
    let mut db = SourceDb::new();
    db.add("same.can".into(), OLD.into());
    let (program, mut result, catalog) = owned(&db, &file);
    result.complete = false;
    let (artifact, diagnostics) =
        emitted(&program, &db, &result, Some(&catalog), EmitOptions::new());
    assert_eq!(
        diagnostics.iter().map(|d| d.code).collect::<Vec<_>>(),
        ["E6005"]
    );
    assert!(artifact.modules.is_empty());
    let (artifact, diagnostics) = emitted(
        &program,
        &db,
        &result,
        Some(&catalog),
        EmitOptions::test_only(),
    );
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(!artifact.modules.is_empty());
    let mut foreign = SourceDb::new();
    foreign.add("same.can".into(), OLD.replace("OLD", "NEW"));
    let (artifact, diagnostics) = emitted(
        &program,
        &foreign,
        &result,
        Some(&catalog),
        EmitOptions::test_only(),
    );
    assert_eq!(
        diagnostics.iter().map(|d| d.code).collect::<Vec<_>>(),
        ["E6011"]
    );
    assert!(artifact.modules.is_empty());
}

#[test]
fn selected_nonzero_sources_and_caller_order_are_preserved() {
    let catalog = load(&catalog_file("1.0.0", "pure"));
    let mut db = SourceDb::new();
    db.add("unchecked.can".into(), "this is not a Can module\n".into());
    let one = db.add("one.can".into(), OLD.replace("Shop", "One"));
    let two = db.add(
        "two.can".into(),
        OLD.replace("Shop", "Two").replace("OLD", "TWO"),
    );
    let (program, result) = checked(&db, &[two, one], Some(&catalog));
    assert_eq!(program.checked_files(), &[two, one]);
    assert_eq!(
        program
            .modules
            .iter()
            .map(|m| m.name.as_str())
            .collect::<Vec<_>>(),
        ["Two", "One"]
    );
    let artifact = clean(&program, &db, &result, &catalog);
    assert_eq!(artifact.sources.len(), 3);
    assert_eq!(artifact.modules[0].map.sources_content.len(), 3);
    assert!(!artifact.modules[0].js.contains("this is not a Can module"));
    let (subset, subset_result) = checked(&db, &[two], Some(&catalog));
    let artifact = clean(&subset, &db, &subset_result, &catalog);
    assert!(artifact.modules[0].js.contains("\"TWO\""));
    assert!(!artifact.modules[0].js.contains("\"OLD\""));
    assert_eq!(artifact.sources.len(), 3);
}

#[test]
fn originally_nonexistent_selected_id_cannot_become_checked_by_append() {
    let catalog = load(&catalog_file("1.0.0", "pure"));
    let mut db = SourceDb::new();
    let (program, analysis_diagnostics) = check_program(&db, &[SourceId(0)], Some(&catalog));
    assert!(!analysis_diagnostics.is_empty());
    let result = DiagnosticResult::new("cohort-test", LANGUAGE_VERSION, SCHEMA_VERSION);
    refused(&program, &db, &result, Some(&catalog));
    assert_eq!(db.add("now-present.can".into(), OLD.into()), SourceId(0));
    refused(&program, &db, &result, Some(&catalog));
}

#[test]
fn catalog_absence_is_part_of_the_checked_owner_contract() {
    let catalog = load(&catalog_file("1.0.0", "pure"));
    let mut db = SourceDb::new();
    let id = db.add("same.can".into(), OLD.into());
    let (with_catalog, result) = checked(&db, &[id], Some(&catalog));
    refused(&with_catalog, &db, &result, None);
    let (without_catalog, result) = checked(&db, &[id], None);
    refused(&without_catalog, &db, &result, Some(&catalog));
    let (ir, diagnostics) = ir::build(&without_catalog, &db, None);
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert!(!ir.items.is_empty());
    let (artifact, diagnostics) = emitted(&without_catalog, &db, &result, None, EmitOptions::new());
    assert!(!artifact.modules.is_empty());
    assert!(diagnostics.iter().any(|d| d.code == "E6007"));
    assert!(diagnostics.iter().all(|d| d.code != "E6011"));
}
