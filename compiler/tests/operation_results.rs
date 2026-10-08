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
    assert_eq!(
        operation(&artifact, "work.number")["inputs"],
        json!({"fields":[
            {"name":"value","field":{"kind":"integer"},"required":true}
        ]})
    );
    for name in [
        "Client.number",
        "Client.nullable",
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
    let output = compile(
        "app Invalid\nGiven\nWhen\n scenario number() read=true -> int by=members\n  do\n   return \"wrong\"\nThen\n",
    );
    assert!(!output.status.success(), "unchecked result was published");
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        response["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"].as_str().unwrap().starts_with("E3")),
        "{response}"
    );
    assert!(response.get("operations").is_none(), "{response}");
}
