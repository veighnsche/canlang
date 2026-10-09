//! Production CLI query-order qualification on the actual owning Cloudflare
//! source fixture. Native authorized D1 execution stays with its consumer.
#![cfg(unix)]

use std::path::Path;
use std::process::Command;

#[test]
fn ui_order_aliases_and_descending_datetime_keys_keep_their_owning_domain() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = "app Orders uses=[shop]\npackage shop\n Given\n  Entry { at:int, values:int[] }\n  policy Entry read=members\n When\n  crud Entry by=members fields=at,values delete=none\n  scenario latest() by=members read=true -> Entry?\n   do\n    return first(Entry as item order=-item.at)\n Then\n  page / title=\"Orders\"\n   list Entry as item order=-item.at\n    text row.at\n    list Entry as inner order=inner.at\n     text row.at\n";
    let invoke = |name: &str, source: &str, command: &str| {
        let path = scratch.path().join(format!("{name}.can"));
        std::fs::write(&path, source).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args([command, "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(path)
            .env_remove("CAN_CATALOG")
            .current_dir(root)
            .output()
            .unwrap();
        let response: serde_json::Value = serde_json::from_slice(&output.stdout)
            .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&output.stdout)));
        (output, response)
    };
    let (output, artifact) = invoke("owning-order", source, "compile");
    assert!(output.status.success(), "{artifact}");
    let generated = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(generated.contains("order:[\"-at\"]"), "{generated}");
    assert!(generated.contains("order:[\"at\"]"), "{generated}");
    assert!(!generated.contains("order:[\"-item.at\"]"), "{generated}");
    assert!(!generated.contains("order:[\"inner.at\"]"), "{generated}");
    let datetime_source = source.replace("at:int", "at:datetime");
    let (output, response) = invoke("descending-datetime", &datetime_source, "check");
    assert!(output.status.success(), "{response}");
    let (output, response) = invoke("descending-datetime", &datetime_source, "compile");
    assert_eq!(output.status.code(), Some(10), "{response}");
    let diagnostics = response["diagnostics"].as_array().unwrap();
    assert_eq!(diagnostics.len(), 1, "{response}");
    assert_eq!(diagnostics[0]["code"], "E6008", "{response}");
    assert_eq!(
        diagnostics[0]["message"], "cannot lower expression query order: no §13 lowering exists",
        "{response}"
    );
    assert!(response.get("modules").is_none(), "{response}");
    for (name, source, code) in [
        (
            "foreign-alias",
            source.replace("order=-item.at\n    text", "order=-other.at\n    text"),
            "E2013",
        ),
        (
            "outer-alias",
            source.replace("order=inner.at", "order=item.at"),
            "E2013",
        ),
        (
            "missing-field",
            source.replace("order=inner.at", "order=inner.missing"),
            "E2013",
        ),
        (
            "unordered",
            source.replace("order=inner.at", "order=inner.values"),
            "E3006",
        ),
        (
            "reference-path",
            source
                .replace(
                    "Entry { at:int",
                    "Location { name:text }\n  Entry { location:Location?, at:int",
                )
                .replace("order=inner.at", "order=location.name"),
            "E2013",
        ),
    ] {
        let (output, response) = invoke(name, &source, "check");
        assert_eq!(output.status.code(), Some(10), "{name}: {response}");
        assert!(
            response["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"] == code),
            "{name}: {response}"
        );
    }
    let unsupported = source.replace("list Entry as item order=-item.at\n    text row.at\n    list Entry as inner order=inner.at\n     text row.at", "table Entry as item columns=at order=item.at");
    let (output, response) = invoke("table-order", &unsupported, "compile");
    assert_eq!(output.status.code(), Some(10), "{response}");
    assert!(
        response["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E6008"
                && diagnostic["message"]
                    .as_str()
                    .unwrap()
                    .contains("table order")),
        "{response}"
    );
    assert!(response.get("modules").is_none(), "{response}");
}

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
