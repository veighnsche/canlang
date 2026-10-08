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
