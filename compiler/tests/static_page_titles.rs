//! Static page captions resolve through production artifacts and the installed UI.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn named_static_page_titles_preserve_owner_and_translation() {
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
        include_str!("fixtures/static-page-title-consumer.mjs"),
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
}
