//! The checked agenda producer reaches the real installed presentation boundary.
use std::{path::Path, process::Command};

#[test]
fn checked_agenda_body_filters_and_preferences_reach_installed_consumers() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/agenda-workflow.can");
    let input = scratch.path().join("agenda.can");
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
        (
            "nonenum-filter",
            source.replace("filter=state", "filter=reason"),
        ),
        (
            "undeclared-default",
            source.replace(
                "defaults={state=preferences.appointment_state}",
                "defaults={reason=\"foreign\"}",
            ),
        ),
        (
            "invalid-default",
            source.replace(
                "defaults={state=preferences.appointment_state}",
                "defaults={state=\"foreign\"}",
            ),
        ),
        (
            "explicit-history-row",
            source.replace("   actions cancel", "   actions cancel\n   history row"),
        ),
        // E5 (CAN18-v1, DESIGN 434/440/975/977): a field-to-field
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
    // E5: the agenda filter+lambda-where conjunction lowers cleanly.
    let admitted = compile(&source.replace(
        "calendar Visit start=from",
        "calendar Visit as row where row.from>=row.until start=from",
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
        .arg(root.join("implementation/compiler-completion/view-reuse/agenda-consumer.mjs"))
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
