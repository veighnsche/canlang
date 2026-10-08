//! Production CLI query-order qualification on the actual owning Cloudflare
//! source fixture. Native authorized D1 execution stays with its consumer.
#![cfg(unix)]

use std::path::Path;
use std::process::Command;

#[test]
fn production_model_query_order_preserves_direct_alias_fields_and_refuses_expressions() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .canonicalize()
        .unwrap();
    let source_path = root.join("packages/cloudflare/test/fixtures/typed-authorized-reads.can");
    let source = std::fs::read_to_string(&source_path).unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let compile = |path: &Path| {
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(path)
            .env_remove("CAN_CATALOG")
            .current_dir(&root)
            .output()
            .unwrap();
        let response: serde_json::Value =
            serde_json::from_slice(&output.stdout).unwrap_or_else(|e| {
                panic!(
                    "CLI JSON: {e}: {}\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                )
            });
        (output, response)
    };
    let (output, artifact) = compile(&source_path);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let modules = artifact["modules"].as_array().unwrap();
    let generated = modules
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    for (id, order) in [
        ("TypedAuthorizedReads.ascending", "count"),
        ("TypedAuthorizedReads.descending", "-count"),
    ] {
        assert!(
            artifact["callables"]
                .as_array()
                .unwrap()
                .iter()
                .any(|callable| callable["id"] == id),
            "actual authored callable missing: {id}"
        );
        let records = format!("records(c,\"TypedAuthorizedReads.Entry\",{{order:[\"{order}\"]}})");
        assert_eq!(
            generated.matches(&records).count(),
            1,
            "one authored native order selector for {id}:\n{generated}"
        );
    }
    let authored = "order=entry.count select entry.count";
    assert_eq!(
        source.matches(authored).count(),
        1,
        "unique ascending source anchor"
    );
    for (name, refused_source) in [
        (
            "arithmetic",
            source.replacen(authored, "order=entry.count+1 select entry.count", 1),
        ),
        (
            "foreign-root",
            source
                .replacen(
                    "scenario ascending()",
                    "scenario ascending(entryRecord:Entry)",
                    1,
                )
                .replacen(authored, "order=entryRecord.count select entry.count", 1),
        ),
    ] {
        let path = scratch.path().join(format!("{name}.can"));
        std::fs::write(&path, refused_source).unwrap();
        let (output, response) = compile(&path);
        assert_eq!(
            output.status.code(),
            Some(10),
            "{name}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let diagnostics = response["diagnostics"].as_array().unwrap();
        assert_eq!(diagnostics.len(), 1, "{name}: {diagnostics:?}");
        assert_eq!(diagnostics[0]["code"], "E6008", "{name}: {diagnostics:?}");
        assert_eq!(
            diagnostics[0]["message"],
            "cannot lower expression query order: no §13 lowering exists",
            "{name}: {diagnostics:?}"
        );
        assert!(
            response.get("modules").is_none(),
            "{name}: refused query must not publish modules"
        );
    }
}
