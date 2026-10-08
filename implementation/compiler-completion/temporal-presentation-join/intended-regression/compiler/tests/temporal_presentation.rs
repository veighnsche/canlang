//! Generated native scalar presentation through the installed public codec/UI owners.
#![cfg(unix)]

use std::path::PathBuf;
use std::process::Command;

#[test]
fn native_message_operands_reach_actual_page_and_descriptor_consumers() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
    for owner in [
        "packages/values/dist/catalog.json",
        "node_modules/@canlang/stdlib/dist/src/index.js",
        "node_modules/@canlang/ui/dist/src/index.js",
    ] {
        assert!(root.join(owner).exists(), "built public owner required: {owner}");
    }
    let scratch = tempfile::Builder::new().prefix("can-temporal-presentation-").tempdir().unwrap();
    std::os::unix::fs::symlink(root.join("node_modules"), scratch.path().join("node_modules")).unwrap();
    let input = scratch.path().join("source.can");
    std::fs::write(&input, include_str!("fixtures/temporal-presentation/source.can")).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(input).current_dir(&root).output().unwrap();
    assert!(compiled.status.success(), "{}\n{}", String::from_utf8_lossy(&compiled.stdout), String::from_utf8_lossy(&compiled.stderr));
    std::fs::write(scratch.path().join("artifact.json"), compiled.stdout).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, include_str!("fixtures/temporal-presentation/execute.mjs")).unwrap();
    let executed = Command::new("node").arg(runner).current_dir(scratch.path()).output().unwrap();
    assert!(executed.status.success(), "{}\n{}", String::from_utf8_lossy(&executed.stdout), String::from_utf8_lossy(&executed.stderr));
    eprint!("{}", String::from_utf8_lossy(&executed.stdout));
}
