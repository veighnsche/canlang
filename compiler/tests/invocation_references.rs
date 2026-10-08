//! Generated complete invocation construction uses the existing public Values contracts.
#![cfg(unix)]
use std::path::{Path, PathBuf};
use std::process::Command;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}
fn compile(dir: &Path, name: &str, source: &str) -> std::process::Output {
    let path = dir.join(format!("{name}.can"));
    std::fs::write(&path, source).unwrap();
    Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root().join("packages/values/dist/catalog.json"))
        .arg(path)
        .current_dir(root())
        .output()
        .unwrap()
}
fn decoded(output: &std::process::Output) -> serde_json::Value {
    serde_json::from_slice(&output.stdout)
        .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&output.stderr)))
}
#[test]
fn generated_invocations_execute_and_enter_existing_values_codecs() {
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root().join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let output = compile(
        scratch.path(),
        "invocations",
        include_str!("fixtures/invocation-references/source.can"),
    );
    assert!(output.status.success(), "{}", decoded(&output));
    std::fs::write(scratch.path().join("artifact.json"), output.stdout).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(
        &runner,
        include_str!("fixtures/invocation-references/execute.mjs"),
    )
    .unwrap();
    let result = Command::new("node")
        .arg(runner)
        .current_dir(scratch.path())
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
fn invocation_target_alias_uses_owner_identity() {
    let scratch = tempfile::tempdir().unwrap();
    let source = "package work\n Given\n When\n  export scenario mutate(value:int) by=members\n   do\n    let copy = value\n Then\napp Client\nuse work {mutate as execute}\nGiven\nWhen\n scenario descriptor() read=true -> invocation(execute) by=members\n  do\n   return invocation(execute,{value=4})\nThen\n";
    let output = compile(scratch.path(), "alias", source);
    assert!(output.status.success(), "{}", decoded(&output));
    let artifact = decoded(&output);
    let emitted = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(emitted.contains("invocation(work.mutate)"), "{emitted}");
    assert!(emitted.contains("\"work.mutate\""), "{emitted}");
    assert!(!emitted.contains("invocation(Client.execute)"));
}
