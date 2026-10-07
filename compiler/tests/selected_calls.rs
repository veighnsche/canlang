//! Selected checked bindings through actual public compilation and installed
//! facades. Direct getter inputs qualify expression order, not canonical input
//! admission. Localized formatting/scenario serving gaps remain explicit.
#![cfg(unix)]

use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
use canlang_compiler::analysis::check_program;
use canlang_compiler::codegen::ir;
use canlang_compiler::source::{SourceDb, SourceId, Span};
use std::path::{Path, PathBuf};
use std::process::Command;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

#[test]
fn production_selected_calls_execute_actual_facades() {
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root().join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let script = scratch.path().join("probe.mjs");
    std::fs::write(
        &script,
        include_str!(
            "../../implementation/compiler-completion/selected-calls/implementation/probe.mjs"
        ),
    )
    .unwrap();
    let output = Command::new("node")
        .arg(script)
        .arg(root())
        .arg(env!("CARGO_BIN_EXE_can"))
        .arg(scratch.path())
        .output()
        .expect("Node required for actual facade qualification");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{stdout}\n{stderr}");
    eprintln!("{stdout}");
}

#[test]
fn missing_checked_binding_has_no_catalog_reconstruction_fallback() {
    let mut db = SourceDb::new();
    let id = db.add(
        "selected.can".into(),
        "app T\nGiven\n derive g():text = lower(value=\"HI\")\nWhen\nThen\n".into(),
    );
    let catalog_path = root().join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&catalog_path),
        env: None,
        cwd: Path::new("."),
        primary: Span::new(SourceId(0), 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let catalog = catalog.unwrap();
    let (mut checked, diagnostics) = check_program(&db, &[id], Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    assert_eq!(checked.types.selected_calls.len(), 1);
    checked.types.selected_calls.clear();
    let (ir, diagnostics) = ir::build(&checked, &db, Some(&catalog));
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let emitted = canlang_compiler::codegen::js::emit_program(&ir);
    assert!(
        emitted
            .diagnostics
            .iter()
            .any(|diag| diag.code == "E6008"
                && diag.message.contains("checked selected-call binding")),
        "{:?}",
        emitted.diagnostics
    );
}
