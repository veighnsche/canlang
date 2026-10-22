//! Fresh CLI collection calls execute against the installed Values owner.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn checked_sum_tags_and_scoped_predicates_reach_values() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root.join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let script = scratch.path().join("consumer.mjs");
    std::fs::write(
        &script,
        include_str!("fixtures/collection-call-consumer.mjs"),
    )
    .unwrap();
    let output = Command::new("node")
        .arg(script)
        .arg(root)
        .arg(env!("CARGO_BIN_EXE_can"))
        .arg(scratch.path())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn scoped_contract_collection_refuses_a_foreign_source_domain() {
    use canlang_compiler::analysis::{
        catalog::{CatalogRequest, load_catalog},
        check_program,
    };
    use canlang_compiler::codegen::ir;
    use canlang_compiler::source::{SourceDb, Span};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut db = SourceDb::new();
    let file = db.add(
        "scoped-contract-alias.can".into(),
        include_str!("fixtures/scoped-contract-alias.can").into(),
    );
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (mut program, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (_, diagnostics) = ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let fact = program
        .types
        .checked_contract_collection_calls
        .values_mut()
        .min_by_key(|fact| fact.node.start)
        .unwrap();
    let original = fact.node;
    fact.domain = fact.alias;
    let (changed, diagnostics) = ir::build(&program, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let diagnostics = canlang_compiler::codegen::js::emit_program_with_native_source_receipts(
        &changed, false, &db,
    )
    .diagnostics;
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"
                && diagnostic.primary.file == original.file
                && diagnostic.primary.start == original.start
                && diagnostic.message.contains("collection call source facts")),
        "{diagnostics:?}"
    );
}
