//! Real catalog and original source qualification for BDD expression facts.
use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::analysis::types::{ResolvedType, Scalar, SelectedCallTarget};
use canlang_compiler::source::{SourceDb, Span};
use canlang_compiler::syntax::SyntaxKind;
use std::path::PathBuf;

#[test]
fn original_expenseflow_publishes_bdd_calls_and_sequence_observation_types() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let source = std::fs::read_to_string(root.join("examples/ExpenseFlow.can")).unwrap();
    let mut db = SourceDb::new();
    let file = db.add("examples/ExpenseFlow.can".into(), source.clone());
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.expect("actual built catalog required");
    let (checked, diagnostics) = check_program(&db, &[file], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for expression in [
        "reviewer(reviewer_one)",
        "reviewer(reviewer_two)",
        "first(Expense as claim where claim.submitted_by==other)",
        "first(Expense as claim where claim.id==draft_claim.id)",
        "money(0,\"EUR\")",
    ] {
        let offset = source.find(expression).unwrap() as u32;
        let (_, fact) = checked
            .types
            .selected_calls
            .iter()
            .find(|(key, _)| key.start == offset && key.kind == SyntaxKind::Call as u8)
            .unwrap_or_else(|| panic!("missing checked call: {expression}"));
        assert!(!fact.slots.is_empty());
        assert!(matches!(
            fact.target,
            SelectedCallTarget::Builtin { .. } | SelectedCallTarget::Role(_)
        ));
    }
    let offset = source.find("submitted_claim.status ->").unwrap() as u32;
    let ty = checked
        .types
        .node_types
        .iter()
        .find(|(key, _)| {
            key.start <= offset && offset < key.end && key.kind == SyntaxKind::Member as u8
        })
        .unwrap()
        .1;
    assert!(matches!(ty, ResolvedType::Enum { .. }), "{ty:?}");
    let offset = source.find("draft_claim!=null").unwrap() as u32;
    let ty = checked
        .types
        .node_types
        .iter()
        .find(|(key, _)| {
            key.start <= offset && offset < key.end && key.kind == SyntaxKind::Binary as u8
        })
        .unwrap()
        .1;
    assert_eq!(ty, &ResolvedType::Scalar(Scalar::Bool));
}

#[test]
fn header_fixture_scope_and_runner_error_ownership_remain_distinct() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    let source = "app Scope\nGiven\n derive broken():text = missing_production\nWhen\n scenario echo(value:text) read=true -> text by=members\n  do return value\n  examples value=value\n   value -> lower(result),missing_observation(result)\n   \"HI\" -> \"hi\",\"hi\"\nThen\n";
    let mut db = SourceDb::new();
    let file = db.add("scope.can".into(), source.into());
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (checked, diagnostics) = check_program(&db, &[file], Some(&catalog));
    let unresolved: Vec<_> = diagnostics
        .iter()
        .filter(|diag| diag.code == "E2001")
        .map(|diag| &source[diag.primary.start as usize..diag.primary.end as usize])
        .collect();
    assert_eq!(
        unresolved,
        ["missing_production", "value"],
        "{diagnostics:?}"
    );
    let good = source.find("lower(result)").unwrap() as u32;
    let bad = source.find("missing_observation(result)").unwrap() as u32;
    assert!(
        checked
            .types
            .selected_calls
            .keys()
            .any(|key| key.start <= good && good < key.end)
    );
    assert!(
        !checked
            .types
            .selected_calls
            .keys()
            .any(|key| key.start <= bad && bad < key.end)
    );
}
