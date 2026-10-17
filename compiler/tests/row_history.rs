//! Original queried rows reach the installed current-authorized history reader.
use std::{path::Path, process::Command};

#[test]
fn bare_history_uses_original_rows_and_preserves_source_failure_order() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let fixture = root.join("compiler/tests/fixtures/row-history.can");
    let scratch = tempfile::tempdir().unwrap();
    let compile = |input: &Path| {
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap()
    };
    let output = compile(&fixture);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(artifact.get("diagnostics").is_none(), "{artifact}");
    assert_eq!(artifact["pages"].as_array().unwrap().len(), 1);
    let artifact_path = scratch.path().join("artifact.json");
    std::fs::write(&artifact_path, output.stdout).unwrap();
    let consumer = Command::new("node")
        .arg(root.join("docs/implementation/compiler-completion/view-reuse/history-consumer.mjs"))
        .arg(root)
        .arg(&artifact_path)
        .arg(scratch.path().join("staged"))
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        consumer.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&consumer.stdout),
        String::from_utf8_lossy(&consumer.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&consumer.stdout));

    let source = include_str!("fixtures/row-history.can");
    for (name, refused, expected_codes) in [
        (
            "no-row",
            "app NoRow\nGiven\nWhen\nThen\n page /history title=\"History\"\n  history\n"
                .to_string(),
            &["E6008"][..],
        ),
        (
            "explicit-row",
            source.replace("   history\n", "   history row\n"),
            &["E1201"][..],
        ),
        (
            "options",
            source.replace("   history\n", "   history limit=1\n"),
            &["E1201", "E6008"][..],
        ),
        (
            "non-query-view-row",
            source
                .replace(
                    " policy Entry read=members",
                    " policy Entry read=members\n derive chosen(value:Entry):Entry = value",
                )
                .replace(
                    "show audit_body {row=row}",
                    "show audit_body {row=chosen(row)}",
                ),
            &["E6008"][..],
        ),
    ] {
        let input = scratch.path().join(format!("{name}.can"));
        std::fs::write(&input, refused).unwrap();
        let output = compile(&input);
        assert_eq!(
            output.status.code(),
            Some(10),
            "{name}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let refused: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(refused.get("modules").is_none(), "{name}: {refused}");
        assert!(
            refused["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"]
                    .as_str()
                    .is_some_and(|code| expected_codes.contains(&code))),
            "{name}: {refused}"
        );
    }
}
