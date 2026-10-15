//! Actual-list empty captions: shared default and authored localized messages.
#![cfg(unix)]
use std::{path::Path, process::Command};

#[test]
fn list_default_and_explicit_message_reach_real_empty_query() {
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
    let runner =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/list-empty-consumer.mjs");
    for (name, authored, expected) in [
        ("default", input.to_string(), "Geen gegevens."),
        (
            "explicit",
            input.replace(
                "list Job",
                "list Job empty=\"No jobs yet\"@{nl=\"Nog geen taken\"}",
            ),
            "Nog geen taken",
        ),
    ] {
        std::fs::write(&source, authored).unwrap();
        let compiled = compile();
        assert!(
            compiled.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&compiled.stdout),
            String::from_utf8_lossy(&compiled.stderr)
        );
        let artifact = scratch.path().join(format!("{name}.json"));
        std::fs::write(&artifact, compiled.stdout).unwrap();
        let consumed = Command::new("node")
            .arg(&runner)
            .arg(root)
            .arg(&artifact)
            .arg(scratch.path().join(name))
            .arg(expected)
            .output()
            .unwrap();
        assert!(
            consumed.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&consumed.stdout),
            String::from_utf8_lossy(&consumed.stderr)
        );
    }
}

#[test]
fn source_row_callback_keeps_wire_transport_and_lazy_native_source_distinct() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("source-row.can");
    std::fs::write(&source, "app SourceRows\nGiven\n Item {label:text,owner:user?,at:datetime?,score:int}\n policy Item read=public\nWhen\nThen\n page / title=\"Rows\"\n  list Item\n   text row.label,row.owner,row.at,row.score\n   history\n").unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&source)
        .current_dir(root)
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
    let consumed = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/source-row-consumer.mjs"))
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
