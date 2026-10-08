//! Checked operation identities become data only in the owning constructor target slot.
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
fn canonical_action_targets_execute_public_owners() {
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root().join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let output = compile(
        scratch.path(),
        "targets",
        include_str!("fixtures/action-references/source.can"),
    );
    assert!(output.status.success(), "{}", decoded(&output));
    std::fs::write(scratch.path().join("artifact.json"), output.stdout).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(
        &runner,
        include_str!("fixtures/action-references/execute.mjs"),
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
fn invocation_uses_complete_inputs_and_canonical_target() {
    let scratch = tempfile::tempdir().unwrap();
    let source = "app T\nGiven\nWhen\n scenario mutate(value:decimal=1.50) by=members\n  do\n   let x = value\n scenario descriptor() read=true -> text by=members\n  do\n   let reference = invocation(arguments={value=2.50},target=mutate)\n   return \"constructed\"\nThen\n";
    let output = compile(scratch.path(), "invocation", source);
    assert!(output.status.success(), "{}", decoded(&output));
    let artifact = decoded(&output);
    let modules = artifact["modules"].as_array().unwrap();
    let emitted = modules
        .iter()
        .map(|m| m["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(emitted.contains("\"T.mutate\""), "{emitted}");
    assert!(emitted.contains("invocation"));
    // This assertion qualifies canonical emission only. Generated invocation
    // runtime/schema behavior belongs to the separate invocation owner tests.
}
#[test]
fn aliased_crud_targets_preserve_owning_operation_identity() {
    let scratch = tempfile::tempdir().unwrap();
    let source = "package stock\n Given\n  export Widget { title:text }\n  policy Widget read=members\n When\n  crud Widget by=members fields=title\n Then\napp T\nuse stock {Widget as Item}\nGiven\nWhen\n scenario descriptors(record:Item) read=true -> text by=members\n  do\n   let createRef = action(Item.create,{})\n   let updateRef = action(bindings={record=record},target=Item.update)\n   let deleteRef = action(Item.delete,{record=record})\n   return \"constructed\"\nThen\n";
    let output = compile(scratch.path(), "crud", source);
    assert!(output.status.success(), "{}", decoded(&output));
    let artifact = decoded(&output);
    let emitted = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    for op in ["create", "update", "delete"] {
        let canonical = format!("stock.Widget.{op}");
        assert!(
            artifact["operations"]
                .as_array()
                .unwrap()
                .iter()
                .any(|o| o["name"] == canonical)
        );
        assert!(emitted.contains(&format!("\"{canonical}\"")), "{emitted}");
        assert!(!emitted.contains(&format!("\"T.Item.{op}\"")), "{emitted}");
    }
    // The installed facade lacks CRUD helpers, so instantiating these
    // generated modules remains a separate owning-runtime gap.
}
#[test]
fn invalid_constructor_inputs_retain_checker_diagnostics() {
    let scratch = tempfile::tempdir().unwrap();
    let header = "app T\nGiven\n event E { source:text }\n Item { title:text }\n policy Item read=members\nWhen\n crud Item by=members fields=title\n scenario mutate(record:Item, value:text) by=members\n  do\n   let x = value\n scenario reader() read=true -> int by=members\n  do\n   return 1\n scenario handler on=E\n  do\n   let x = 1\n";
    for (name, expression) in [
        ("read", "action(reader,{})"),
        ("text", "action(\"T.mutate\",{})"),
        ("trusted", "action(handler,{})"),
        ("missing_binding", "action(mutate,{})"),
        ("nonrecord", "action(mutate,{record=\"item\"})"),
        (
            "business_binding",
            "action(mutate,{record=record,value=\"x\"})",
        ),
        (
            "incomplete_invocation",
            "invocation(mutate,{record=record})",
        ),
    ] {
        let source = format!(
            "{header} scenario descriptor(record:Item) read=true by=members\n  do\n   let result = {expression}\nThen\n"
        );
        let output = compile(scratch.path(), name, &source);
        assert!(!output.status.success(), "{name} unexpectedly compiled");
        let result = decoded(&output);
        assert!(
            result["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["code"] == "E3005"),
            "{name}: {result}"
        );
    }
}

#[test]
fn operation_values_outside_constructor_target_remain_unsupported() {
    let scratch = tempfile::tempdir().unwrap();
    let output = compile(
        scratch.path(),
        "bare_operation",
        "app T\nGiven\nWhen\n scenario mutate() by=members\n  do\n   let x = 1\n scenario caller() by=members\n  do\n   let target = mutate\nThen\n",
    );
    assert!(!output.status.success());
    let result = decoded(&output);
    assert!(
        result["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|d| d["code"] == "E6008"
                && d["message"]
                    .as_str()
                    .unwrap()
                    .contains("reference to `mutate`")),
        "{result}"
    );
}

#[test]
fn computed_operation_targets_are_not_erased() {
    let scratch = tempfile::tempdir().unwrap();
    for (name, expression) in [
        (
            "throwing_action",
            "action(choose(1 / 0 == 0.0,mutate,mutate),{})",
        ),
        (
            "throwing_invocation",
            "invocation(choose(1 / 0 == 0.0,mutate,mutate),{})",
        ),
        ("object_member", "action(({x=mutate}).x,{})"),
        ("grouped_reference", "action((mutate),{})"),
    ] {
        let source = format!(
            "app T\nGiven\nWhen\n scenario mutate() by=members\n  do\n   let x = 1\n scenario descriptor() read=true -> text by=members\n  do\n   let reference = {expression}\n   return \"constructed\"\nThen\n"
        );
        let output = compile(scratch.path(), name, &source);
        assert!(!output.status.success(), "{name} erased target evaluation");
        let result = decoded(&output);
        assert!(
            result["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["code"] == "E6008"),
            "{name}: {result}"
        );
        assert!(
            result["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .all(|d| d["code"] == "E6008"),
            "{name} must be checked source: {result}"
        );
    }
}
