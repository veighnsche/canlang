//! Unpaged source-owned datetime predicates with genuine admitted page time.
use std::{path::Path, process::Command};

#[test]
fn checked_table_time_reaches_native_identity_queries_and_rows() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/table-time.can");
    let input = scratch.path().join("table-time.can");
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
            "paged-time",
            source.replace("display=split\n", "display=split\n   pagination\n"),
        ),
        (
            "cursor-time",
            source.replace("display=split\n", "cursor=\"unreleased\" display=split\n"),
        ),
        (
            "nullable-time",
            source.replace("from:datetime,until", "from:datetime?,until"),
        ),
        (
            "nondatetime-time",
            source
                .replace("from:datetime,until", "from:int,until")
                .replace("from:datetime,state", "from:int,state")
                .replace("until=from", "until=now"),
        ),
        (
            "unsupported-operator",
            source.replace("visit.from>=now", "visit.from>now"),
        ),
        (
            "unsupported-direction",
            source.replace("visit.from>=now", "now<=visit.from"),
        ),
    ] {
        let output = compile(&refused);
        assert_eq!(
            output.status.code(),
            Some(10),
            "{name}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let refused: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        if matches!(
            name,
            "paged-time" | "cursor-time" | "unsupported-operator" | "unsupported-direction"
        ) {
            let expected = if name == "cursor-time" {
                "E1203"
            } else {
                "E6008"
            };
            assert!(
                refused["diagnostics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|diagnostic| diagnostic["code"] == expected),
                "{name}: {refused}"
            );
        }
        assert!(
            refused.get("modules").is_none(),
            "{name}: no partial body artifact"
        );
    }
    std::fs::write(&input, source).unwrap();
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, compiled.stdout).unwrap();
    let consumer = Command::new("node")
        .arg(root.join("implementation/compiler-completion/view-reuse/table-time-consumer.mjs"))
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
    let gated = source.replacen("display=split\n", "display=split\n   require false\n", 1);
    let compiled_gate = compile(&gated);
    assert!(
        compiled_gate.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled_gate.stdout)
    );
    let gated_artifact = scratch.path().join("gated-artifact.json");
    std::fs::write(&gated_artifact, compiled_gate.stdout).unwrap();
    let gated_consumer = Command::new("node")
        .arg(root.join("implementation/compiler-completion/view-reuse/table-time-consumer.mjs"))
        .arg(root)
        .arg(&gated_artifact)
        .arg(scratch.path().join("gated-staged"))
        .arg("gated")
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        gated_consumer.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&gated_consumer.stdout),
        String::from_utf8_lossy(&gated_consumer.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&consumer.stdout));
}

#[test]
fn source_owned_time_predicate_cannot_move_to_another_ui_property() {
    use canlang_compiler::analysis::catalog::{CatalogRequest, load_catalog};
    use canlang_compiler::analysis::check_program;
    use canlang_compiler::codegen::{ir, js};
    use canlang_compiler::source::{SourceDb, Span};
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let mut db = SourceDb::new();
    let id = db.add(
        "table-time.can".into(),
        include_str!("fixtures/table-time.can").into(),
    );
    let path = root.join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: root,
        primary: Span::new(id, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[id], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (mut program, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let table = program.modules[0].pages[0]
        .render
        .iter_mut()
        .find(|node| node.factory == "table")
        .unwrap();
    let (name, value) = table
        .props
        .iter_mut()
        .find(|(key, _)| key == "where")
        .unwrap();
    assert!(matches!(value.expr, ir::IrExpr::PageTimePredicate(_)));
    *name = "empty".into();
    let emitted = js::emit_program(&program);
    assert!(
        emitted
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.code == "E6008"),
        "{:?}",
        emitted.diagnostics
    );
}
