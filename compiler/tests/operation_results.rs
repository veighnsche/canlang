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
        ("Client.copyDate", "date"),
        ("Client.copyOptionalDate", "date?"),
        ("Client.copyDates", "date[]"),
        ("Client.copyOptionalDates", "date[]?"),
        ("Client.copyDuration", "duration"),
        ("Client.copyOptionalDuration", "duration?"),
        ("Client.copyDurations", "duration[]"),
        ("Client.copyOptionalDurations", "duration[]?"),
        ("Client.defaultInstant", "datetime"),
        ("Client.optionalDefaultInstant", "datetime?"),
        ("Client.defaultInstants", "datetime[]"),
        ("Client.defaultDate", "date"),
        ("Client.optionalDefaultDate", "date?"),
        ("Client.defaultDates", "date[]"),
        ("Client.defaultDuration", "duration"),
        ("Client.number", "text"),
        ("Client.textArray", "text[]"),
        ("Client.optionalText", "text?"),
        ("Client.optionalTexts", "text[]?"),
        ("Client.boolean", "bool"),
        ("Client.nullableBoolean", "bool?"),
        ("Client.booleans", "bool[]"),
        ("Client.optionalBooleans", "bool[]?"),
        ("Client.decimalValue", "decimal"),
        ("Client.optionalDecimal", "decimal?"),
        ("Client.decimals", "decimal[]"),
        ("Client.optionalDecimals", "decimal[]?"),
        ("Client.moneyValue", "money"),
        ("Client.optionalMoney", "money?"),
        ("Client.monies", "money[]"),
        ("Client.optionalMonies", "money[]?"),
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
        ("Client.defaultDate", json!("2030-01-01")),
        ("Client.optionalDefaultDate", json!("2030-01-01")),
        ("Client.defaultDates", json!(["2030-01-01"])),
        ("Client.defaultDuration", json!("1000")),
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
        ("day", json!("2030-01-01")),
        ("optionalDay", json!("2030-01-01")),
        ("days", json!(["2030-01-01"])),
        ("maybeDays", json!(["2030-01-01"])),
        ("elapsed", json!("1000")),
        ("optionalElapsed", json!("1000")),
        ("elapsedValues", json!(["1000"])),
        ("maybeElapsedValues", json!(["1000"])),
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
        "Client.specialized",
        "Client.Item.read",
        "Client.Item.create",
        "Client.Item.update",
        "Client.Item.delete",
    ] {
        assert!(operation(&artifact, name).get("result").is_none(), "{name}");
    }
    for (name, ty) in [
        ("Client.number", "text"),
        ("Client.textArray", "text[]"),
        ("Client.optionalText", "text?"),
        ("Client.optionalTexts", "text[]?"),
    ] {
        let input = &operation(&artifact, name)["inputs"]["fields"][0];
        assert_eq!(input["field"]["kind"], "string", "{name}: {input}");
        assert_eq!(input["valueType"], ty, "{name}: {input}");
        assert_eq!(input["nullable"] == true, ty.ends_with('?'));
        assert_eq!(input.get("array").is_some(), ty.contains("[]"));
    }
    for (name, ty) in [
        ("Client.copyDate", "date"),
        ("Client.copyOptionalDate", "date?"),
        ("Client.copyDates", "date[]"),
        ("Client.copyOptionalDates", "date[]?"),
        ("Client.defaultDate", "date"),
        ("Client.optionalDefaultDate", "date?"),
        ("Client.defaultDates", "date[]"),
    ] {
        let input = &operation(&artifact, name)["inputs"]["fields"][0];
        assert_eq!(input["field"]["kind"], "string", "{name}: {input}");
        assert_eq!(input["valueType"], ty, "{name}: {input}");
        assert_eq!(input["nullable"] == true, ty.ends_with('?'));
        assert_eq!(input.get("array").is_some(), ty.contains("[]"));
    }
    for (name, ty) in [
        ("Client.copyDuration", "duration"),
        ("Client.copyOptionalDuration", "duration?"),
        ("Client.copyDurations", "duration[]"),
        ("Client.copyOptionalDurations", "duration[]?"),
        ("Client.defaultDuration", "duration"),
    ] {
        let input = &operation(&artifact, name)["inputs"]["fields"][0];
        assert_eq!(input["field"]["kind"], "duration", "{name}: {input}");
        assert!(input.get("valueType").is_none(), "{name}: {input}");
        assert_eq!(input["nullable"] == true, ty.ends_with('?'));
        assert_eq!(input.get("array").is_some(), ty.contains("[]"));
    }
    for input in operation(&artifact, "Client.specialized")["inputs"]["fields"]
        .as_array()
        .unwrap()
    {
        if input["name"] == "day" {
            assert_eq!(input["valueType"], "date", "{input}");
        } else {
            assert!(input.get("valueType").is_none(), "{input}");
        }
    }
    for input in operation(&artifact, "Client.booleans")["inputs"]["fields"]
        .as_array()
        .unwrap()
    {
        assert_eq!(input["field"]["kind"], "boolean");
        assert!(input.get("valueType").is_none(), "{input}");
    }
    for (name, ty, kind) in [
        ("Client.decimalValue", "decimal", "decimal"),
        ("Client.optionalDecimal", "decimal?", "decimal"),
        ("Client.decimals", "decimal[]", "decimal"),
        ("Client.optionalDecimals", "decimal[]?", "decimal"),
        ("Client.moneyValue", "money", "money"),
        ("Client.optionalMoney", "money?", "money"),
        ("Client.monies", "money[]", "money"),
        ("Client.optionalMonies", "money[]?", "money"),
    ] {
        let input = &operation(&artifact, name)["inputs"]["fields"][0];
        assert_eq!(input["field"]["kind"], kind, "{name}: {input}");
        if ty == "decimal" || ty == "money" {
            assert!(input.get("valueType").is_none(), "{name}: {input}");
        }
        assert_eq!(
            input["nullable"] == true,
            ty.ends_with('?'),
            "{name}: {input}"
        );
        assert_eq!(
            input.get("array").is_some(),
            ty.contains("[]"),
            "{name}: {input}"
        );
    }
    for (name, ty) in [
        ("title", "text"),
        ("optional", "text?"),
        ("titles", "text[]"),
        ("maybeTitles", "text[]?"),
        ("day", "date"),
        ("optionalDay", "date?"),
        ("days", "date[]"),
        ("maybeDays", "date[]?"),
    ] {
        let field = model["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|field| field["name"] == name)
            .unwrap();
        assert_eq!(field["valueType"], ty, "{field}");
        assert_eq!(field["nullable"] == true, ty.ends_with('?'));
        assert_eq!(field.get("array").is_some(), ty.contains("[]"));
        for operation_name in ["Client.Item.create", "Client.Item.update"] {
            let input = operation(&artifact, operation_name)["inputs"]["fields"]
                .as_array()
                .unwrap()
                .iter()
                .find(|field| field["name"] == name)
                .unwrap();
            assert_eq!(input["valueType"], ty, "{operation_name}: {input}");
        }
    }
    for field in model["fields"].as_array().unwrap().iter().filter(|field| {
        ![
            "title",
            "optional",
            "titles",
            "maybeTitles",
            "day",
            "optionalDay",
            "days",
            "maybeDays",
        ]
        .iter()
        .any(|name| field["name"] == *name)
    }) {
        assert!(field.get("valueType").is_none(), "{field}");
    }
    for (name, ty) in [
        ("day", "date"),
        ("optionalDay", "date?"),
        ("days", "date[]"),
        ("maybeDays", "date[]?"),
    ] {
        let field = model["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == name)
            .unwrap();
        assert_eq!(field["field"]["kind"], "date", "{field}");
        assert_eq!(field["valueType"], ty, "{field}");
    }
    for name in [
        "elapsed",
        "optionalElapsed",
        "elapsedValues",
        "maybeElapsedValues",
    ] {
        let field = model["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == name)
            .unwrap();
        assert_eq!(field["field"]["kind"], "duration", "{field}");
        assert!(field.get("valueType").is_none(), "{field}");
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
        (
            "app Invalid\nGiven\nWhen\n scenario day() read=true -> date by=members\n  do return date(\"2030-02-30\")\nThen\n",
            "E3001",
        ),
        (
            "app Invalid\nGiven\nWhen\n scenario day(raw:text,value:date=date(raw)) read=true -> date by=members\n  do return value\nThen\n",
            "E6008",
        ),
        (
            "app Invalid\nGiven\n Ledger {cash:money=money(92233720368547758.08,\"EUR\")}\nWhen\nThen\n",
            "E6008",
        ),
        (
            "app Invalid\nGiven\n Ledger {coins:money[]=[money(92233720368547758.08,\"EUR\")]}\nWhen\nThen\n",
            "E6008",
        ),
        (
            "app Invalid\nGiven\nWhen\n scenario cash(raw:decimal,value:money=money(raw,\"EUR\")) read=true -> money by=members\n  do return value\nThen\n",
            "E6008",
        ),
        (
            "app Invalid\nGiven\nWhen\n scenario coins(raw:decimal,value:money[]=[money(raw,\"EUR\")]) read=true -> money[] by=members\n  do return value\nThen\n",
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
