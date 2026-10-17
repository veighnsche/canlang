//! Finite table enum filters through installed source-owned request parsing.
use std::{path::Path, process::Command};

#[test]
fn checked_table_filters_defaults_and_protected_rows_reach_installed_consumers() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/table-filters.can");
    let input = scratch.path().join("table-filters.can");
    let compile = |source: &str| {
        std::fs::write(&input, source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(&input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap()
    };
    let compiled = compile(source);
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    for (name, refused) in [
        (
            "unknown-filter",
            source.replace("filter=state", "filter=missing"),
        ),
        (
            "duplicate-filter",
            source.replace("filter=state", "filter=state,state"),
        ),
        ("bare-filter", source.replace("filter=state", "filter")),
        (
            "nonenum-filter",
            source.replace("filter=state", "filter=rank"),
        ),
        (
            "undeclared-default",
            source.replace(
                "defaults={state=preferences.window_state}",
                "defaults={rank=\"open\"}",
            ),
        ),
        (
            "invalid-default",
            source.replace(
                "defaults={state=preferences.window_state}",
                "defaults={state=\"foreign\"}",
            ),
        ),
        (
            "foreign-default",
            source.replace("preferences.window_state}", "preferences.foreign_state}"),
        ),
        (
            "duplicate-default",
            source.replace(
                "defaults={state=preferences.window_state}",
                "defaults={state=preferences.window_state,state=\"open\"}",
            ),
        ),
        // E5 (CAN18-v1, DESIGN 434/440/975/977): the field-to-field
        // comparison lowers to a Lambda where, which now conjoins with
        // the admitted filter (`{op:and,[where,...filters]}` at the query
        // adapter) instead of keeping an E6008. It is asserted admitted
        // below; only genuinely unsupported selectors stay refused here.
    ] {
        let output = compile(&refused);
        assert_eq!(
            output.status.code(),
            Some(10),
            "{name}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let refused: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            refused.get("modules").is_none(),
            "{name}: no partial body artifact"
        );
    }
    // E5: the table filter+lambda-where conjunction lowers cleanly.
    let admitted = compile(&source.replace(
        "table row.Window columns=",
        "table row.Window as visit where visit.from>=visit.until columns=",
    ));
    assert!(
        admitted.status.success(),
        "filtered-lambda lowers: {}\n{}",
        String::from_utf8_lossy(&admitted.stdout),
        String::from_utf8_lossy(&admitted.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let consumer = Command::new("node")
        .arg(root.join("docs/implementation/compiler-completion/view-reuse/table-filter-consumer.mjs"))
        .arg(root)
        .arg(&artifact)
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
}
