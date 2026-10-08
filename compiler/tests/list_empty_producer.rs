//! Required actual-list profile: CLI refusal and the unchanged real empty-query sink.
#![cfg(unix)]
use std::{path::Path, process::Command};

#[test]
fn list_requires_empty_and_explicit_message_reaches_real_empty_query() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("list.can");
    let input = "app Images\nGiven\n Job { title:text }\n policy Job read=public\nWhen\nThen\n page / title=\"Images\"\n  list Job\n   text row.title\n";
    let compile = || {
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(&source)
            .current_dir(root)
            .output()
            .unwrap()
    };
    std::fs::write(&source, input).unwrap();
    let refused = compile();
    assert_eq!(refused.status.code(), Some(10));
    let diagnostics: serde_json::Value = serde_json::from_slice(&refused.stdout).unwrap();
    assert!(
        diagnostics.get("modules").is_none(),
        "no artifact publication"
    );
    let errors = diagnostics["diagnostics"].as_array().unwrap();
    assert_eq!(errors.len(), 1, "{diagnostics}");
    let error = &errors[0];
    assert_eq!(error["code"], "E6008");
    assert!(
        error["message"]
            .as_str()
            .unwrap()
            .contains("ListProps.empty")
    );
    let start = error["primary"]["start"].as_u64().unwrap() as usize;
    let end = error["primary"]["end"].as_u64().unwrap() as usize;
    assert!(
        input[start..end].trim_start().starts_with("list Job"),
        "owning source anchor"
    );

    std::fs::write(
        &source,
        input.replace(
            "list Job",
            "list Job empty=\"No jobs yet\"@{nl=\"Nog geen taken\"}",
        ),
    )
    .unwrap();
    let compiled = compile();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let runner =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/list-empty-consumer.mjs");
    let consumed = Command::new("node")
        .arg(runner)
        .arg(root)
        .arg(&artifact)
        .arg(scratch.path())
        .output()
        .unwrap();
    assert!(
        consumed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&consumed.stdout),
        String::from_utf8_lossy(&consumed.stderr)
    );
}
