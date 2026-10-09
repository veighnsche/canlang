//! Native source-row versions cross the actual delete form's wire boundary.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn generated_delete_controls_encode_protected_versions_at_the_ui_boundary() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("delete-control.can");
    std::fs::write(&source, "app DeleteControl\nGiven\n Item {title:text,enabled:bool=true}\n policy Item read=members\nWhen\n crud Item by=members fields=title,enabled\nThen\n page / title=\"Items\"\n  list Item\n   text row.version+1\n   card \"Controls\"\n    require row.enabled\n    delete\n").unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&source)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let runner =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/delete-control-consumer.mjs");
    let executed = Command::new("node")
        .arg(runner)
        .arg(root)
        .arg(&artifact)
        .arg(scratch.path())
        .output()
        .unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
