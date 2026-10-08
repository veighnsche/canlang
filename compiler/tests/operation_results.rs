//! Fresh checked CLI artifacts are the authority for bounded result publication.
use serde_json::{Value, json};
use std::path::PathBuf;
use std::process::Command;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn compile(source: &str) -> std::process::Output {
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("results.can");
    std::fs::write(&path, source).unwrap();
    Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root().join("packages/values/dist/catalog.json"))
        .arg(path)
        .current_dir(root())
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap()
}

fn operation<'a>(artifact: &'a Value, name: &str) -> &'a Value {
    artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|operation| operation["name"] == name)
        .unwrap_or_else(|| panic!("missing {name}: {}", artifact["operations"]))
}

#[test]
fn checked_results_follow_owning_declarations_and_shared_publication() {
    let output = compile(include_str!("fixtures/operation-results/source.can"));
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        operation(&artifact, "work.number")["result"],
        json!({"type":"int"})
    );
    assert_eq!(
        operation(&artifact, "work.finish")["result"],
        json!({"type":"void"})
    );
    for (name, ty) in [
        ("Client.nullable", "int?"),
        ("Client.instant", "datetime"),
        ("Client.optionalInstant", "datetime?"),
        ("Client.integers", "int[]"),
        ("Client.instants", "datetime[]"),
        ("Client.optionalIntegers", "int[]?"),
        ("Client.optionalInstants", "datetime[]?"),
        ("Client.defaultInstant", "datetime"),
        ("Client.optionalDefaultInstant", "datetime?"),
        ("Client.defaultInstants", "datetime[]"),
    ] {
        assert_eq!(
            operation(&artifact, name)["result"],
            json!({"type":ty}),
            "{name}"
        );
    }
    assert_eq!(
        operation(&artifact, "work.number")["inputs"],
        json!({"fields":[
            {"name":"value","field":{"kind":"integer"},"required":true}
        ]})
    );
    for (name, expected) in [
        ("Client.defaultInstant", json!("2030-01-01T00:00:00.000Z")),
        (
            "Client.optionalDefaultInstant",
            json!("2030-01-01T00:00:00.000Z"),
        ),
        (
            "Client.defaultInstants",
            json!(["2030-01-01T00:00:00.000Z"]),
        ),
    ] {
        let input = &operation(&artifact, name)["inputs"]["fields"][0];
        assert_eq!(
            input["default"],
            json!({"kind":"literal","value":expected}),
            "{name}: {input}"
        );
        assert_eq!(input["required"], false, "{name}: {input}");
    }
    let model = artifact["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|model| model["name"] == "Client.Item")
        .unwrap();
    for (name, expected) in [
        ("at", json!("2030-01-01T00:00:00.000Z")),
        (
            "instants",
            json!([
                "2030-01-01T00:00:00.125Z",
                "1969-12-31T23:59:59.100Z",
                "2000-02-29T23:15:00.000Z",
                "0001-01-01T00:00:00.000Z",
                "9999-12-31T23:59:59.999Z"
            ]),
        ),
    ] {
        let field = model["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|field| field["name"] == name)
            .unwrap();
        assert_eq!(
            field["default"],
            json!({"kind":"literal","value":expected}),
            "{name}: {field}"
        );
    }
    for name in [
        "Client.number",
        "Client.textArray",
        "Client.optionalText",
        "Client.boolean",
        "Client.Item.read",
        "Client.Item.create",
        "Client.Item.update",
        "Client.Item.delete",
    ] {
        assert!(operation(&artifact, name).get("result").is_none(), "{name}");
    }
    let names: Vec<_> = artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .map(|operation| operation["name"].as_str().unwrap())
        .collect();
    assert!(!names.contains(&"Client.selected"));
    assert!(!names.contains(&"Client.complete"));
    assert!(!names.contains(&"Client.hidden"));

    let entry = artifact["modules"][0]["js"].as_str().unwrap();
    assert!(entry.contains("default:datetime(\"2030-01-01T00:00:00Z\")"));
    let start = entry.find("operations:[").expect("canApp operations") + "operations:".len();
    let mut values = serde_json::Deserializer::from_str(&entry[start..]).into_iter::<Value>();
    let embedded = values.next().unwrap().unwrap();
    assert_eq!(
        embedded, artifact["operations"],
        "shared serializer keeps every descriptor aligned"
    );
}

#[test]
fn invalid_result_body_never_publishes_a_successful_artifact() {
    for (source, prefix) in [
        (
            "app Invalid\nGiven\nWhen\n scenario number() read=true -> int by=members\n  do\n   return \"wrong\"\nThen\n",
            "E3",
        ),
        (
            "app Invalid\nGiven\nWhen\n scenario number() read=true -> int[][] by=members\n  do return [[1]]\nThen\n",
            "E1213",
        ),
        (
            "app Invalid\nGiven\nWhen\n scenario number() read=true -> int?[] by=members\n  do return [null,1]\nThen\n",
            "E1213",
        ),
        (
            "app Invalid\nGiven\nWhen\n scenario instant(value:datetime=datetime(\"2030-02-30T00:00:00Z\")) read=true -> datetime by=members\n  do return value\nThen\n",
            "E3001",
        ),
        (
            "app Invalid\nGiven\nWhen\n scenario instant(raw:text,value:datetime=datetime(raw)) read=true -> datetime by=members\n  do return value\nThen\n",
            "E6008",
        ),
    ] {
        let output = compile(source);
        assert!(!output.status.success(), "unchecked result was published");
        let response: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            response["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"].as_str().unwrap().starts_with(prefix)),
            "{response}"
        );
        assert!(response.get("operations").is_none(), "{response}");
    }
}
