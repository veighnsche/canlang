use canlang_compiler::{LANGUAGE_VERSION, SCHEMA_VERSION};
use canlang_compiler::analysis::{check_program, CheckedProgram};
use canlang_compiler::analysis::catalog::{load_catalog, Catalog, CatalogRequest};
use canlang_compiler::codegen::{emit, ir, EmitOptions, EmitSources};
use canlang_compiler::diagnostic::{Diagnostic, DiagnosticResult};
use canlang_compiler::source::{SourceDb, SourceId, Span};
use std::sync::atomic::{AtomicUsize, Ordering};

const SOURCE: &str = "app Review\nGiven\n Record { title:text=\"PINNED\" }\nWhen\nThen\n";
fn catalog() -> Catalog {
    static COUNT: AtomicUsize = AtomicUsize::new(0);
    let path = std::env::temp_dir().join(format!("cohort-independent-{}-{}.json", std::process::id(), COUNT.fetch_add(1, Ordering::Relaxed)));
    std::fs::write(&path, r#"{"language_version":"1.0","catalog_version":"1.0.0","entries":[{"id":"lower","js":"lower","owner":"review","kind":"builtin","signature":"lower(value:text)->text","effects":"pure","availability":"implemented"}]}"#).unwrap();
    let (value, diagnostics) = load_catalog(&CatalogRequest { flag: Some(&path), env: None, cwd: path.parent().unwrap(), primary: Span::new(SourceId(0), 0, 0) });
    std::fs::remove_file(path).unwrap();
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    value.unwrap()
}
fn db() -> (SourceDb, SourceId) {
    let mut db = SourceDb::new();
    let id = db.add("review.can".into(), SOURCE.into());
    (db, id)
}
fn result() -> DiagnosticResult {
    DiagnosticResult::new("independent-review", LANGUAGE_VERSION, SCHEMA_VERSION)
}
fn codes(diagnostics: &[Diagnostic]) -> Vec<&str> { diagnostics.iter().map(|d| d.code).collect() }
fn emission(program: &CheckedProgram, db: &SourceDb, catalog: Option<&Catalog>, complete: bool, test: bool) -> (canlang_compiler::codegen::artifact::CompileArtifact, Vec<Diagnostic>) {
    let mut result = result(); result.complete = complete;
    emit(program, &EmitSources { db, catalog, result: &result, options: if test { EmitOptions::test_only() } else { EmitOptions::new() } })
}
fn all_ir_empty(program: &ir::IrProgram) {
    assert!(program.modules.is_empty() && program.items.is_empty() && program.referenced_builtins.is_empty() && program.read_rules.is_empty() && program.invariants.is_empty() && program.locks.is_empty() && program.retention.is_empty() && program.crud_when.is_empty() && program.preferences_valid.is_empty() && program.suites.is_empty() && program.migrations.is_empty());
}
fn deny(program: &CheckedProgram, db: &SourceDb, catalog: Option<&Catalog>) {
    let (ir, diagnostics) = ir::build(program, db, catalog);
    assert_eq!(codes(&diagnostics), ["E6011"]); all_ir_empty(&ir);
    for test in [false, true] {
        let (artifact, diagnostics) = emission(program, db, catalog, true, test);
        assert_eq!(codes(&diagnostics), ["E6011"]);
        assert!(artifact.modules.is_empty() && artifact.callables.is_empty() && artifact.operations.is_empty() && artifact.models.is_empty() && artifact.pages.is_empty() && artifact.migrations.is_empty() && artifact.requires.is_empty() && artifact.tests.is_empty());
        assert_eq!(artifact.sources.len(), db.len());
    }
}

#[test]
fn moving_whole_owners_by_swap_is_valid_but_replacement_has_a_new_owner() {
    let (mut first, id) = db(); let catalog = catalog();
    let (program, diagnostics) = check_program(&first, &[id], Some(&catalog)); assert!(diagnostics.is_empty());
    let mut retained = SourceDb::new(); std::mem::swap(&mut first, &mut retained);
    first.add("review.can".into(), SOURCE.into());
    deny(&program, &first, Some(&catalog));
    let (artifact, diagnostics) = emission(&program, &retained, Some(&catalog), true, false);
    assert!(diagnostics.is_empty()); assert!(artifact.modules[0].js.contains("PINNED"));
    let mut copied = retained.get(id).unwrap().clone(); copied.text = SOURCE.replace("PINNED", "MUTATED"); copied.sha256.clear();
    let cloned_catalog = catalog.clone(); drop(catalog);
    let (again, diagnostics) = emission(&program, &retained, Some(&cloned_catalog), true, false);
    assert!(diagnostics.is_empty()); assert_eq!(again.modules[0].js, artifact.modules[0].js);
}

#[test]
fn original_file_selection_is_copied_and_duplicates_are_not_silently_reordered() {
    let (mut db, _) = db(); let catalog = catalog();
    let b = db.add("b.can".into(), SOURCE.replace("Review", "B"));
    let c = db.add("c.can".into(), SOURCE.replace("Review", "C"));
    let mut files = vec![c, b, c];
    let (program, diagnostics) = check_program(&db, &files, Some(&catalog));
    // Duplicate input retains existing resolver diagnostics; provenance does not certify clean facts.
    assert!(codes(&diagnostics).contains(&"E2002"));
    files.clear(); assert_eq!(program.checked_files(), &[c, b, c]);
    // Existing duplicate declaration policy keeps the first module while reporting E2002.
    assert_eq!(program.modules.iter().map(|m| m.file).collect::<Vec<_>>(), [c, b]);
    let (_, diagnostics) = ir::build(&program, &db, Some(&catalog));
    assert!(!codes(&diagnostics).contains(&"E6011"));
    let (ordered, diagnostics) = check_program(&db, &[c, b], Some(&catalog)); assert!(diagnostics.is_empty());
    let (ir, diagnostics) = ir::build(&ordered, &db, Some(&catalog)); assert!(diagnostics.is_empty());
    assert_eq!(ir.modules.iter().map(|m| m.file).collect::<Vec<_>>(), [c, b]);
}

#[test]
fn refusing_originally_absent_nonzero_and_max_ids_survives_multiple_appends() {
    let (mut db, _) = db(); let catalog = catalog();
    let (absent, diagnostics) = check_program(&db, &[SourceId(2)], Some(&catalog)); assert!(!diagnostics.is_empty());
    deny(&absent, &db, Some(&catalog));
    db.add("first-append.can".into(), SOURCE.replace("Review", "First"));
    assert_eq!(db.add("second-append.can".into(), SOURCE.replace("Review", "Second")), SourceId(2));
    deny(&absent, &db, Some(&catalog));
    let (fresh, diagnostics) = check_program(&db, &[SourceId(2)], Some(&catalog)); assert!(diagnostics.is_empty());
    let (_, diagnostics) = ir::build(&fresh, &db, Some(&catalog)); assert!(diagnostics.is_empty());
    let (maximum, _) = check_program(&db, &[SourceId(u32::MAX)], Some(&catalog)); deny(&maximum, &db, Some(&catalog));
}

#[test]
fn completeness_precedes_cohort_and_cohort_refusal_precedes_parse_and_catalog() {
    let (db, id) = db(); let catalog = catalog(); let (program, _) = check_program(&db, &[id], Some(&catalog));
    let mut foreign = SourceDb::new(); foreign.add("broken.can".into(), "app Broken\n(((\n".into());
    let (artifact, diagnostics) = emission(&program, &foreign, None, false, false);
    assert_eq!(codes(&diagnostics), ["E6005"]); assert!(artifact.modules.is_empty());
    let (artifact, diagnostics) = emission(&program, &foreign, None, false, true);
    assert_eq!(codes(&diagnostics), ["E6011"]); assert!(diagnostics[0].message.contains("source database")); assert!(artifact.modules.is_empty());
    let (_, diagnostics) = ir::build(&program, &foreign, None);
    assert_eq!(codes(&diagnostics), ["E6011"]); assert!(diagnostics[0].message.contains("source database"));
}

#[test]
fn dropping_both_original_owners_does_not_let_new_equivalent_owners_reuse_identity() {
    let (db, id) = db(); let catalog = catalog(); let (program, _) = check_program(&db, &[id], Some(&catalog));
    drop(db); drop(catalog);
    // Bounded ordinary allocation churn, not a timing or raw-address assertion.
    for _ in 0..32 { let (next, _) = self::db(); let next_catalog = self::catalog(); deny(&program, &next, Some(&next_catalog)); }
}

#[test]
fn malformed_unselected_and_appended_sources_stay_inventory_only() {
    let mut db = SourceDb::default(); db.add("bad.can".into(), "app Broken\n(((\n".into());
    let id = db.add("chosen.can".into(), SOURCE.into()); let catalog = catalog();
    let (program, diagnostics) = check_program(&db, &[id], Some(&catalog)); assert!(diagnostics.is_empty());
    let (before, diagnostics) = emission(&program, &db, Some(&catalog), true, false); assert!(diagnostics.is_empty());
    db.add("append.can".into(), "migration Bad from=\"now\"\n (((\n".into());
    let (after, diagnostics) = emission(&program, &db, Some(&catalog), true, false); assert!(diagnostics.is_empty());
    assert_eq!(after.sources.len(), 3); assert_eq!(after.modules[0].map.sources_content.len(), 3);
    assert_eq!(before.modules[0].js, after.modules[0].js); assert!(after.migrations.is_empty());
    assert_eq!(program.checked_files(), &[id]);
}

#[test]
fn empty_selection_and_empty_db_have_real_distinct_owners() {
    let db = SourceDb::new(); let catalog = catalog(); let (program, diagnostics) = check_program(&db, &[], Some(&catalog)); assert!(diagnostics.is_empty());
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog)); assert!(diagnostics.is_empty()); all_ir_empty(&ir);
    deny(&program, &SourceDb::default(), Some(&catalog)); deny(&program, &db, Some(&self::catalog())); deny(&program, &db, None);
}

#[test]
fn coherent_none_keeps_missing_builtin_and_capability_errors_without_cohort_error() {
    let mut db = SourceDb::new(); let id = db.add("none.can".into(), "app Review\nGiven\nWhen\n scenario echo(value:text) read=true -> text by=members\n  do\n   return lower(value)\nThen\n".into());
    let (program, diagnostics) = check_program(&db, &[id], None); assert!(codes(&diagnostics).contains(&"E2001"));
    let (artifact, diagnostics) = emission(&program, &db, None, true, false);
    assert!(!artifact.modules.is_empty()); assert!(!codes(&diagnostics).contains(&"E6011")); assert!(!diagnostics.is_empty());
    deny(&program, &db, Some(&catalog()));
}

#[test]
fn public_fact_and_result_edits_are_accepted_caller_responsibility() {
    let (db, id) = db(); let catalog = catalog(); let (mut program, diagnostics) = check_program(&db, &[id], Some(&catalog)); assert!(diagnostics.is_empty());
    program.catalog_version = "caller-edited".into(); program.modules[0].name = "CallerEdited".into();
    let (ir, diagnostics) = ir::build(&program, &db, Some(&catalog)); assert!(!codes(&diagnostics).contains(&"E6011"));
    assert_eq!(ir.catalog_version, "caller-edited"); assert_eq!(ir.modules[0].name, "CallerEdited");
    deny(&program, &db, Some(&self::catalog()));
}
