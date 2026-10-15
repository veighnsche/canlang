//! Outcome 1 (C02 admission/default boundary): `by` runs before any
//! declared parameter default, so an explicit-default parameter
//! (`p:T=expr`) is unavailable to `by=` directly or through a helper
//! call. Required inputs, implicit null/empty-array absence values and
//! admitted defaults stay valid; no runtime order changes.

use canlang_compiler::analysis::check_program;
use canlang_compiler::diagnostic::Diagnostic;
use canlang_compiler::source::SourceDb;

/// Check one source through the full pipeline, sorted by span+code.
fn check(src: &str) -> Vec<Diagnostic> {
    let mut db = SourceDb::new();
    let id = db.add("test.can".to_string(), src.to_string());
    let (_program, mut diags) = check_program(&db, &[id], None);
    diags.sort_by(|a, b| {
        (a.primary.start, a.primary.end, &a.code).cmp(&(b.primary.start, b.primary.end, &b.code))
    });
    diags
}

fn codes(diags: &[Diagnostic]) -> Vec<&str> {
    diags.iter().map(|d| d.code).collect()
}

/// Direct dependence: `by=allowed` on `allowed:bool=true` must be
/// rejected during checking (DESIGN §5).
#[test]
fn direct_by_on_explicit_default_is_rejected() {
    let src = "app T\nGiven\nWhen\n scenario gated(allowed:bool=true) by=allowed\n  do\n   let x = 1\nThen\n";
    let diags = check(src);
    assert_eq!(codes(&diags), vec!["E3011"], "{diags:?}");
}

/// Helper-transitive dependence: passing the explicit-default
/// parameter into a helper from `by=` is the same violation.
#[test]
fn helper_transitive_by_on_explicit_default_is_rejected() {
    let src = "app T\nGiven\n derive allow(x:bool):bool = x\nWhen\n scenario gated(allowed:bool=true) by=allow(allowed)\n  do\n   let x = 1\nThen\n";
    let diags = check(src);
    assert_eq!(codes(&diags), vec!["E3011"], "{diags:?}");
}

/// Required inputs stay available to `by=`, directly and via helpers.
#[test]
fn required_inputs_stay_available_to_by() {
    let src = "app T\nGiven\n derive allow(x:bool):bool = x\nWhen\n scenario gated(allowed:bool) by=allowed\n  do\n   let x = 1\n scenario helped(allowed:bool) by=allow(allowed)\n  do\n   let y = 2\nThen\n";
    let diags = check(src);
    assert!(diags.is_empty(), "required inputs stay valid: {diags:?}");
}

/// Nullable/array absence values and admitted (unreferenced) defaults
/// stay valid; `require` may still observe resolved defaults.
#[test]
fn admitted_defaults_and_absence_values_stay_valid() {
    let src = "app T\nGiven\nWhen\n scenario s(note:text?,tags:text[],count:int=4) by=members\n  require count >= 0\n  require (note ?? \"\") != \"\"\n  require tags == []\n  do\n   let x = 1\nThen\n";
    let diags = check(src);
    assert!(diags.is_empty(), "admitted defaults stay valid: {diags:?}");
}
