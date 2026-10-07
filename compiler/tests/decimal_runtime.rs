//! Exact Decimal construction from legal checked source through installed public owners.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str = include_str!("fixtures/decimal-runtime/source.can");

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn compile(dir: &Path, name: &str, source: &str) -> std::process::Output {
    let input = dir.join(format!("{name}.can"));
    std::fs::write(&input, source).unwrap();
    Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root().join("packages/values/dist/catalog.json"))
        .arg(input)
        .current_dir(root())
        .output()
        .unwrap()
}

#[test]
fn checked_decimal_materialization_and_default_consumers() {
    for path in [
        "packages/values/dist/catalog.json",
        "node_modules/@canlang/stdlib/dist/src/index.js",
    ] {
        assert!(
            root().join(path).exists(),
            "real built owner required: {path}"
        );
    }
    let scratch = tempfile::Builder::new()
        .prefix("can-decimal-")
        .tempdir()
        .unwrap();
    std::os::unix::fs::symlink(
        root().join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let output = compile(scratch.path(), "exact", SOURCE);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    std::fs::write(scratch.path().join("artifact.json"), &output.stdout).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(
        &runner,
        include_str!("fixtures/decimal-runtime/execute.mjs"),
    )
    .unwrap();
    let executed = Command::new("node")
        .arg(runner)
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&executed.stdout));
}

#[test]
fn decimal_range_and_adjacent_gaps_keep_diagnostics() {
    let scratch = tempfile::tempdir().unwrap();
    for (name, expression, diagnostic) in [
        ("scale19", "1.0000000000000000000", "E3001"),
        (
            "digits39",
            "999999999999999999999.123456789012345678",
            "E3001",
        ),
        ("plus", "+1.50", "E1215"),
    ] {
        let output = compile(
            scratch.path(),
            name,
            &format!("app T\nGiven\n derive value():decimal = {expression}\nWhen\nThen\n"),
        );
        assert!(!output.status.success(), "{name} unexpectedly compiled");
        let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            json["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["code"] == diagnostic),
            "{name}: {json}"
        );
    }
    let output = compile(
        scratch.path(),
        "action",
        "app T\nGiven\nWhen\n scenario mutate(value:decimal=1.50) by=members\n  do\n   let x = value\n scenario descriptor() read=true -> action(mutate) by=members\n  do\n   return action(mutate,{})\nThen\n",
    );
    assert!(!output.status.success());
    let json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        json["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["code"] == "E6008"
                && d["message"]
                    .as_str()
                    .unwrap()
                    .contains("reference to `mutate`")),
        "{json}"
    );
}
