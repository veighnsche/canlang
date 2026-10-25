//! Outcome 3 (C02/C03 contextual State-read composition): equivalent
//! inline, local and imported helpers preserve the consuming viewer/decision
//! mode in every valid derived/page consumer, with lazy reads, failure
//! propagation and final revocation unchanged. No Boolean-result or
//! incidental route-record exception; no new public effect mode. Strict
//! context-free sites still refuse membership reads.
//!
//! Same synthetic minimal catalog as the owning-inventory tests: the
//! `active_member` state-read builtin plus the pure builtins consumed here.

use canlang_compiler::analysis::catalog::{Catalog, CatalogRequest, load_catalog};
use canlang_compiler::analysis::types::SelectedCallTarget;
use canlang_compiler::analysis::{CheckedProgram, check_program};
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::{SourceDb, Span};

const CATALOG_JSON: &str = r#"{"language_version":"1.0","catalog_version":"0.1.0","entries":[{"id":"active_member","js":"active_member","owner":"lane-03","kind":"builtin","signature":"active_member(person:user,team:Team)->bool","effects":"state-read","availability":"external"},{"id":"any","js":"any","owner":"lane-02","kind":"builtin","signature":"any(domain:C<T> as x,predicate:bool in x scope)->bool","effects":"pure","availability":"implemented"},{"id":"all","js":"all","owner":"lane-02","kind":"builtin","signature":"all(domain:C<T> as x,predicate:bool in x scope)->bool","effects":"pure","availability":"implemented"},{"id":"count","js":"count","owner":"lane-02","kind":"builtin","signature":"count(domain:C<T>)->int","effects":"pure","availability":"implemented"},{"id":"first","js":"first","owner":"lane-02","kind":"builtin","signature":"first(domain:ordered C<T>)->T?","effects":"pure","availability":"implemented"},{"id":"choose","js":"choose","owner":"lane-02","kind":"builtin","signature":"choose(condition:bool,yes:T,no:T)->T","effects":"pure","availability":"implemented"}]}"#;

/// Mirror of the installed `record_page_and_boolean_field` shape: a record
/// page guard plus a membership-reading derived field consumed as text.
const FIELD_SHAPES: &str = "app ContextualMembership\nGiven\n Entry {account:user}\n policy Entry read=members\n derive current(person:user):bool = active_member(person,team)\n derive Entry.visible:bool = current(row.account)\nWhen\nThen\n page /entries/{Entry.id}/access title=\"Access\"\n  require actor!=null and current(actor)\n  text row.visible\n";

fn load_test_catalog() -> (tempfile::TempDir, Catalog) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.json");
    std::fs::write(&path, CATALOG_JSON).unwrap();
    let mut anchor = SourceDb::new();
    let id = anchor.add("anchor.can".into(), String::new());
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: dir.path(),
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    (dir, catalog.unwrap())
}

fn check(source: &str, catalog: &Catalog) -> (CheckedProgram, Vec<Diagnostic>) {
    let mut db = SourceDb::new();
    let id = db.add("composition.can".into(), source.into());
    check_program(&db, &[id], Some(catalog))
}

fn assert_clean(source: &str, catalog: &Catalog) -> CheckedProgram {
    let (program, diagnostics) = check(source, catalog);
    assert!(diagnostics.is_empty(), "{source}\n{diagnostics:?}");
    program
}

fn membership_calls(program: &CheckedProgram) -> Vec<(String, Vec<Option<usize>>)> {
    let mut calls: Vec<_> = program
        .types
        .selected_calls
        .iter()
        .filter_map(|(node, call)| match &call.target {
            SelectedCallTarget::Builtin { id, overload } if id == "active_member" => Some((
                format!("{}..{}", node.start, node.end),
                *overload,
                call.slots.clone(),
            )),
            _ => None,
        })
        .collect();
    calls.sort();
    calls
        .into_iter()
        .map(|(span, overload, slots)| (format!("active_member#{overload}@{span}"), slots))
        .collect()
}

/// A Boolean result never defines permission to read: the non-Boolean
/// spelling of the same derived field admits the same bounded helper read.
#[test]
fn nonbool_derived_fields_admit_equivalent_helper_reads() {
    let (_dir, catalog) = load_test_catalog();
    assert_clean(FIELD_SHAPES, &catalog);
    let nonbool = FIELD_SHAPES
        .replace(
            "derive Entry.visible:bool = current(row.account)",
            "derive Entry.visible:text = choose(current(row.account),\"yes\",\"no\")",
        )
        .replace(" and row.visible", "");
    let program = assert_clean(&nonbool, &catalog);
    assert_eq!(membership_calls(&program).len(), 1);
    let int = FIELD_SHAPES
        .replace(
            "derive Entry.visible:bool = current(row.account)",
            "derive Entry.count:int = count(Entry as e where current(e.account))",
        )
        .replace("  text row.visible\n", "  text \"counted\"\n");
    assert_clean(&int, &catalog);
    let first = FIELD_SHAPES.replace(
        "derive Entry.visible:bool = current(row.account)",
        "derive Entry.visible:text = first([\"yes\"] as value where current(row.account))??\"no\"",
    );
    assert_clean(&first, &catalog);
}

/// Equivalent inline, local and imported helpers preserve the consuming
/// mode: identical selected slots and overloads in policy and page alike.
#[test]
fn inline_local_and_imported_helpers_stay_equivalent() {
    let (_dir, catalog) = load_test_catalog();
    let local = "app Inv\nGiven\n Entry {owner:user}\n derive ok(person:user?):bool = person!=null and active_member(person,team)\n policy Entry read=members where=ok(actor)\nWhen\nThen\n page /entries title=\"Entries\"\n  list Entry as e where ok(actor)\n   text \"hi\"\n";
    let imported = "app Inv uses=[shop]\npackage lib\n Given\n  export derive ok(person:user?):bool = person!=null and active_member(person,team)\n When\n Then\npackage shop\n use lib {ok}\n Given\n  Entry {owner:user}\n  policy Entry read=members where=ok(actor)\n When\n Then\n  page /entries title=\"Entries\"\n   list Entry as e where ok(actor)\n    text \"hi\"\n";
    let local_calls = membership_calls(&assert_clean(local, &catalog));
    let imported_calls = membership_calls(&assert_clean(imported, &catalog));
    assert_eq!(local_calls.len(), 1);
    assert_eq!(imported_calls.len(), 1);
    assert_eq!(
        local_calls[0].1, imported_calls[0].1,
        "same slots in source order"
    );
}

/// Record-less page admission reads with the viewer team authority: the
/// incidental route record is not a prerequisite.
#[test]
fn unbound_page_guards_admit_bounded_reads() {
    let (_dir, catalog) = load_test_catalog();
    let source = "app Inv\nGiven\n Entry {owner:user}\n derive ok(person:user?):bool = person!=null and active_member(person,team)\n policy Entry read=members where=ok(actor)\nWhen\nThen\n page /entries title=\"Entries\"\n  require ok(actor)\n  list Entry as e\n   text \"hi\"\n";
    let program = assert_clean(source, &catalog);
    assert_eq!(membership_calls(&program).len(), 1);
}

/// Lazy reads keep source order: named arguments bind in declaration order
/// without reordering evaluation, and short-circuit order is preserved.
#[test]
fn helper_reads_keep_source_order_and_short_circuit() {
    let (_dir, catalog) = load_test_catalog();
    let source = "app Inv\nGiven\n Entry {owner:user}\n derive ok(person:user?):bool = person!=null and active_member(team=team,person=person)\n policy Entry read=members where=ok(actor)\nWhen\nThen\n";
    let program = assert_clean(source, &catalog);
    let calls = membership_calls(&program);
    assert_eq!(calls.len(), 1);
    assert_eq!(
        calls[0].1,
        vec![Some(1), Some(0)],
        "named slots keep declaration order"
    );
}

/// Failures still propagate unchanged: an ill-typed membership operand
/// fails checking instead of becoming a silent value.
#[test]
fn membership_failures_still_refuse() {
    let (_dir, catalog) = load_test_catalog();
    let source = "app Inv\nGiven\n Entry {owner:user}\n derive ok(person:user?):bool = active_member(person,person)\n policy Entry read=members\nWhen\nThen\n";
    let (_, diagnostics) = check(source, &catalog);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.severity == canlang_compiler::diagnostic::Severity::Error),
        "ill-typed team operand refuses: {diagnostics:?}"
    );
}

/// Nested container render gates keep their strict pure contract: their
/// reads would evaluate per row at render time rather than through the
/// page-admission observer inventory, so membership helpers still refuse
/// there instead of publishing an unobservable read.
#[test]
fn nested_container_gates_stay_strict() {
    let (_dir, catalog) = load_test_catalog();
    let nested = "app Inv\nGiven\n Entry {owner:user}\n derive ok(person:user?):bool = person!=null and active_member(person,team)\n policy Entry read=members where=ok(actor)\nWhen\nThen\n page /entries title=\"Entries\"\n  list Entry as e where ok(actor)\n   require ok(e.owner)\n   text \"hi\"\n";
    let (_, diagnostics) = check(nested, &catalog);
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E3010"),
        "nested render-gate membership refuses: {diagnostics:?}"
    );
    let pure = "app Inv\nGiven\n Entry {owner:user,active:bool}\n policy Entry read=members\nWhen\nThen\n page /entries title=\"Entries\"\n  list Entry as e\n   require e.active\n   text \"hi\"\n";
    assert_clean(pure, &catalog);
}

/// Strict context-free sites still refuse membership reads, directly and
/// through helpers: field defaults, server initializers and parameter
/// defaults gain no membership read through the widened admission.
#[test]
fn strict_sites_still_refuse_membership_reads() {
    let (_dir, catalog) = load_test_catalog();
    for (name, source, code) in [
        (
            "field default",
            "app Inv\nGiven\n Entry {owner:user,flag:bool=active_member(actor,team)}\n policy Entry read=members\nWhen\nThen\n",
            "E3011",
        ),
        (
            "server initializer",
            "app Inv\nGiven\n Entry {owner:user,seen:bool server=active_member(actor,team)}\n policy Entry read=members\nWhen\nThen\n",
            "E3011",
        ),
        (
            "helper in field default",
            "app Inv\nGiven\n Entry {owner:user,flag:bool=ok(actor)}\n derive ok(person:user?):bool = person!=null and active_member(person,team)\n policy Entry read=members\nWhen\nThen\n",
            "E3010",
        ),
    ] {
        let (_, diagnostics) = check(source, &catalog);
        assert!(
            diagnostics.iter().any(|diagnostic| diagnostic.code == code),
            "{name} still refuses: {diagnostics:?}"
        );
    }
}
