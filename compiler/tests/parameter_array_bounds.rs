//! Compiler-only array input bounds. Runtime enforcement is owned by Packages.
use canlang_compiler::{
    analysis::{
        catalog::{CatalogRequest, load_catalog},
        check_program,
    },
    codegen::ir::{self, IrItemKind},
    source::{SourceDb, Span},
};
use std::{path::PathBuf, process::Command};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}
fn compile(source: &str) -> std::process::Output {
    let scratch = tempfile::tempdir().unwrap();
    let path = scratch.path().join("bounds.can");
    std::fs::write(&path, source).unwrap();
    Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(root().join("packages/values/dist/catalog.json"))
        .arg(path)
        .current_dir(root())
        .output()
        .unwrap()
}
fn decoded(output: &std::process::Output) -> serde_json::Value {
    serde_json::from_slice(&output.stdout).unwrap()
}
const SOURCE: &str = r#"package records
 Given
  export Task {title:text}
  export contract Scope {targets:Task[]! min=1 max=10}
  policy Task read=members
 When
 Then
app ParameterBounds
use records {Task,Scope}
Given
 contract Narrow {targets:Scope.targets min=2 max=5}
 contract Numbers {targets:int[] min=0 max=10}
 contract Labels {label:text min=2 max=8}
 contract Ack {ok:bool}
 capability Worker version=1
  inspect(targets:Narrow.targets) -> Ack
When
 scenario selected(targets:Scope.targets) -> int by=members
  do return count(targets)
 scenario read_selected(targets:Narrow.targets?) read=true -> int by=members
  require targets!=null
  do return count(targets)
 scenario defaulted(targets:Numbers.targets=[]) -> int by=members
  do return count(targets)
 scenario labels(values:Labels.label[]) -> int by=members
  do return count(values)
 scenario unbounded(targets:Task[]) -> int by=members
  do return count(targets)
Then
"#;

#[test]
fn reused_array_parameters_keep_lengths_without_borrowing_required_presence() {
    let mut db = SourceDb::new();
    let file = db.add("parameter-bounds.can".into(), SOURCE.into());
    let path = root().join("packages/values/dist/catalog.json");
    let (catalog, diagnostics) = load_catalog(&CatalogRequest {
        flag: Some(&path),
        env: None,
        cwd: &root(),
        primary: Span::new(file, 0, 0),
    });
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (checked, diagnostics) = check_program(&db, &[file], catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    let (ir, diagnostics) = ir::build(&checked, &db, catalog.as_ref());
    assert!(diagnostics.is_empty(), "{diagnostics:?}");
    for (name, minimum, maximum) in [
        ("ParameterBounds.selected.targets", 1, 10),
        ("ParameterBounds.read_selected.targets", 2, 5),
        ("ParameterBounds.inspect.targets", 2, 5),
        ("ParameterBounds.defaulted.targets", 0, 10),
    ] {
        let item = ir
            .items
            .iter()
            .find(|item| item.canonical == name)
            .unwrap_or_else(|| {
                panic!(
                    "missing {name}; actual parameters: {:?}",
                    ir.items
                        .iter()
                        .filter(|item| matches!(item.kind, IrItemKind::Param { .. }))
                        .map(|item| &item.canonical)
                        .collect::<Vec<_>>()
                )
            });
        let IrItemKind::Param {
            array_bounds: Some(bounds),
            ..
        } = &item.kind
        else {
            panic!("{name}")
        };
        assert_eq!((bounds.min, bounds.max), (Some(minimum), Some(maximum)));
    }
    let output = compile(SOURCE);
    assert!(output.status.success(), "{}", decoded(&output));
    let artifact = decoded(&output);
    let input = |operation: &str| {
        artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["name"] == operation)
            .unwrap()["inputs"]["fields"][0]
            .clone()
    };
    let selected = input("ParameterBounds.selected");
    assert_eq!(selected["min"], 1);
    assert_eq!(selected["max"], 10);
    assert_eq!(selected["array"]["required"], false);
    assert_eq!(selected["required"], false);
    assert_eq!(selected["field"]["model"], "records.Task");
    assert_eq!(selected["field"]["requireVersion"], true);
    assert!(selected.get("distinctBy").is_none() && selected.get("trim").is_none());
    let nullable = input("ParameterBounds.read_selected");
    assert_eq!(nullable["nullable"], true);
    assert_eq!(nullable["min"], 2);
    assert_eq!(nullable["max"], 5);
    assert_eq!(nullable["field"]["requireVersion"], false);
    assert_eq!(nullable["array"]["required"], false);
    let defaulted = input("ParameterBounds.defaulted");
    assert_eq!(
        defaulted["default"],
        serde_json::json!({"kind":"literal","value":[]})
    );
    assert_eq!(defaulted["array"]["required"], false);
    let unbounded = input("ParameterBounds.unbounded");
    assert!(unbounded.get("min").is_none() && unbounded.get("max").is_none());
    let labels = input("ParameterBounds.labels");
    assert!(
        labels.get("min").is_none() && labels.get("max").is_none(),
        "scalar element bounds must not become outer lengths: {labels}"
    );
    let js = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        js.contains("min:1,max:10") && js.contains("min:2,max:5"),
        "actual parameter validation profiles retain bounds: {js}"
    );
    assert!(
        js.contains("operations:{inspect:{inputs:{targets:{type:\"records.Task[]\",min:2,max:5}"),
        "actual capability profile: {js}"
    );
}

#[test]
fn unrepresentable_reused_array_lengths_refuse_actual_cli_publication() {
    for bound in ["max=9007199254740992", "max=count([1])"] {
        let source = format!(
            "app UnsafeBounds\nGiven\n contract Scope {{targets:int[] {bound}}}\nWhen\n scenario consume(targets:Scope.targets) -> int by=members\n  do return count(targets)\nThen\n"
        );
        let output = compile(&source);
        let value = decoded(&output);
        assert!(!output.status.success(), "{bound}: {value}");
        assert!(value.get("modules").is_none(), "{bound}: {value}");
        assert!(
            value["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"] == "E6008"
                    && diagnostic["message"]
                        .as_str()
                        .is_some_and(|message| message.contains("parameter array length"))),
            "{bound}: {value}"
        );
    }
}

#[test]
fn authored_parameter_modifiers_remain_outside_the_parameter_grammar() {
    let source = SOURCE.replace(
        "scenario selected(targets:Scope.targets)",
        "scenario selected(targets:Scope.targets max=5)",
    );
    let output = compile(&source);
    let artifact = decoded(&output);
    assert!(!output.status.success(), "{artifact}");
    assert!(artifact.get("modules").is_none());
    assert!(
        artifact["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E1200"
                && diagnostic["message"]
                    .as_str()
                    .is_some_and(|message| message
                        .contains("parameters do not accept stored-field modifiers"))),
        "{artifact}"
    );
}
