//! Fresh production CLI artifacts exercise the real localized formatter and
//! canonical handler-context bridge. No synthetic formatter or handler body.
#![cfg(unix)]

use std::{
    path::{Path, PathBuf},
    process::Command,
};

#[test]
fn localized_format_preserves_checked_owners_and_runtime_arguments() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root.join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let script: PathBuf = scratch.path().join("consumer.mjs");
    std::fs::write(
        &script,
        include_str!("fixtures/localized-format-consumer.mjs"),
    )
    .unwrap();
    let result = Command::new("node")
        .arg(script)
        .arg(root)
        .arg(env!("CARGO_BIN_EXE_can"))
        .arg(scratch.path())
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&result.stdout));
}

#[test]
fn localized_format_executes_source_owned_branch_options() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root.join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let script: PathBuf = scratch.path().join("consumer.mjs");
    std::fs::write(
        &script,
        include_str!("fixtures/localized-format-consumer.mjs"),
    )
    .unwrap();
    let result = Command::new("node")
        .arg(script)
        .arg(root)
        .arg(env!("CARGO_BIN_EXE_can"))
        .arg(scratch.path())
        .arg("--branch-options")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&result.stdout));
}
