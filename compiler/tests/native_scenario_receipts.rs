//! Opt-in native capture through unchanged CLI output and installed owners.
//! Actual public ordinary and retained transports project State-owned saved associations.
#![cfg(unix)]
use serde_json::Value;
use std::{path::Path, process::Command};
const LIBRARY: &str = r#"package receiptlib
 Given
  export Shared {value:int}
  policy Shared read=members
  export derive caption(shared:Shared):int = shared.value
 When
  crud Shared by=members fields=value
 Then
"#;
const SOURCE: &str = r#"app NativeReceipts
use receiptlib {Shared,caption}
Given
 Item {value:int,enabled:bool,optional:int?,state:enum(a,b)=a,values:int[]?,required:int[]!}
 Machine {state:enum(idle,queued,ready)=idle machine}
 WriteItem {value:int,label:text,note:text?,enabled:bool,private_choice:bool,public_choice:bool}
 contract Packet {value:int}
 policy Item read=members
 policy WriteItem read=members fields=value,label,note,enabled,public_choice
 derive value(item:Item):int = item.value
 derive nested_value(item:Item):int = value(item)+1
 derive difference(first:int,second:int):int = first-second
 derive default_value(item:Item,total:int=item.value):int = total
 derive fallback_value(item:Item):int = item.optional ?? value(item)
 derive enabled(item:Item):bool = item.enabled
 derive choice(value:Item.state):Item.state = value
When
 crud Item by=members fields=value,enabled,optional,values,required
 crud WriteItem by=members fields=value,label,note,enabled,private_choice,public_choice
 scenario literal() -> int by=members
  do return 7
 scenario input(value:int) -> int by=members
  do return value
 scenario operation_id() -> text by=members
  do return operation.id
 scenario original_version(item:Item) -> int by=members
  do return item.version
 scenario post_write_version(item:Item) -> int by=members
  do
   set item {value=item.value+1}
   return item.version
 scenario checked(item:Item) -> int by=members
  do
   require item.enabled
   return 7
 scenario field(item:Item) -> int by=members
  do return item.value
 scenario branch(item:Item) -> int by=members
  do
   if item.enabled
    return item.value
   else
    return 0
 scenario conjunction(item:Item) -> bool by=members
  do return item.enabled and item.value>0
 scenario disjunction(item:Item) -> bool by=members
  do return item.enabled or item.value>0
 scenario fallback(item:Item) -> int by=members
  do return item.optional ?? item.value
 scenario matched(value:Item.state) -> int by=members
  do
   match value
    case a
     return 1
    case b
     return 2
 scenario implicit_void() by=members
  do require true
 scenario conditional_void(selected:bool) by=members
  do
   if selected
    require true
   else
    require true
 scenario ignored(item:Item) -> int by=members
  do
   let unused=item.optional ?? item.value
   return 7
 scenario reused(item:Item) -> bool by=members
  do
   let enabled=item.enabled
   return enabled and enabled
 scenario query() read=true -> int by=members
  do return count(Item)
 scenario absent(item:Item?) -> int? by=members
  do return item?.value
 scenario named_result(value:Item.state) -> Item.state by=members
  do return value
 scenario arrays(values:int[]?) -> int[]? by=members
  do return values
 scenario stored_array(item:Item) -> int[]? by=members
  do return item.values
 scenario literal_array(item:Item) -> int[] by=members
  do return [item.value,item.optional ?? item.value]
 scenario required_array(item:Item) -> int[] by=members
  do return item.required
 scenario composite(value:Packet[]) -> Packet[] by=members
  do return value
 scenario model_array(value:Item[]) -> Item[] by=members
  do return value
 scenario model(item:Item) -> Item by=members
  do return item
 scenario derived(item:Item) -> int by=members
  do return value(item)
 scenario imported(shared:Shared) -> int by=members
  do return caption(shared)
 scenario nested(item:Item) -> int by=members
  do return nested_value(item)
 scenario repeated(item:Item) -> int by=members
  do return value(item)+value(item)
 scenario reordered(item:Item) -> int by=members
  do return difference(second=value(item),first=fallback_value(item))
 scenario derived_default(item:Item) -> int by=members
  do return default_value(item)
 scenario derived_override(item:Item) -> int by=members
  do return default_value(item,total=42)
 scenario derived_lazy(item:Item) -> int by=members
  do
   let selected=fallback_value(item)
   if enabled(item)
    return selected
   else
    return selected
 scenario derived_match(item:Item,selected:Item.state) -> int by=members
  do
   match choice(selected)
    case a
     return value(item)
    case b
     return nested_value(item)
 scenario machine_read(job:Machine) -> bool by=members
  do return job.state==idle
 scenario machine(job:Machine) by=members
  do
   transition job.state idle -> queued
   transition job.state queued -> ready
 scenario changed(item:Item) -> int by=members
  do
   set item {value=2}
   return 1
 scenario computed(item:WriteItem) -> int by=members
  do
   let alias=item
   set alias {value=item.value+1,label=item.label,note=null,enabled=item.enabled}
   return 1
 scenario private_write(item:WriteItem) -> int by=members
  do
   if item.private_choice
    set item {value=2}
   return 1
 scenario public_write(item:WriteItem) -> int by=members
  do
   if item.public_choice
    set item {value=2}
   return 1
Then
"#;
fn compile(scratch: &Path, native: bool) -> Value {
    compile_source(scratch, native, SOURCE)
}
fn compile_source(scratch: &Path, native: bool, contents: &str) -> Value {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let source = scratch.join("native-receipts.can");
    let library = scratch.join("receiptlib.can");
    std::fs::write(&source, contents).unwrap();
    std::fs::write(&library, LIBRARY).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_can"));
    command
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"));
    if native {
        command.arg("--native-scenario-receipts");
    }
    let output = command
        .arg(source)
        .arg(library)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact = serde_json::from_slice(&output.stdout).unwrap();
    std::fs::write(
        scratch.join(if native {
            "native.json"
        } else {
            "default.json"
        }),
        output.stdout,
    )
    .unwrap();
    artifact
}
fn operation<'a>(artifact: &'a Value, name: &str) -> &'a Value {
    artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|op| op["name"] == format!("NativeReceipts.{name}"))
        .unwrap()
}
#[test]
fn intrinsic_compile_output_keeps_admitted_identity_distinct_from_row_fields() {
    // Compiler output qualification only: native invocation awaits the defining
    // adapter's released intrinsic capture, without fabricating observations.
    let (body, then) = SOURCE.rsplit_once("\nThen").unwrap();
    let body = body.replacen(
        "app NativeReceipts\n",
        "app NativeReceipts\nuse std {TextGenerationV1 as LLM} from=deployment.llm\n",
        1,
    );
    let source = format!(
        "{body}\n{}\nThen{then}",
        r#"
 scenario alias_version(item:Item) -> int by=members
  do
   let alias=item
   return (alias.version)
 scenario private_version(item:WriteItem) -> int by=members
  do
   if item.private_choice
    return item.version
   else
    return 0
 scenario nullable_version(item:Item?) -> int? by=members
  do return item?.version
 scenario body_actor() -> user? by=members
  do return actor
 scenario primitive_int(value:int,unused:text) -> int by=members
  do return value
 scenario primitive_text(value:text) -> text by=members
  do
   let alias=value
   return (alias)
 scenario primitive_bool(value:bool) -> bool by=members
  do return value
 scenario primitive_control(selected:bool,value:int) -> int by=members
  do
   if selected
    return value
   else
    return 0
 scenario frozen_optional(value:int?) -> int? by=members
  do return value
 scenario frozen_default(value:int=4) -> int by=members
  do return value
 scenario frozen_array(value:int[]) -> int[] by=members
  do return value
 scenario frozen_enum(value:Item.state) -> Item.state by=members
  do return value
 scenario shorthand_set(item:Item,value:int) -> int by=members
  do
   set item {value}
   return 1
 scenario shorthand_send(source:text,revision:int) by=members
  do send LLM.cancel {source,revision} as stop
 scenario guard_operation_before(item:Item) by=members
  do
   require operation.id!=""
   set item {value=2}
 scenario guard_operation_after(item:Item) by=members
  do
   set item {value=2}
   require operation.id!=""
 scenario guard_version_before(item:Item) by=members
  do
   require item.version>0
   set item {value=2}
 scenario guard_version_after(item:Item) by=members
  do
   set item {value=2}
   require item.version>0
 scenario independent_version_guard(item:Item) -> int by=members
  do
   require item.version>0
   return 7
 scenario independent_operation_guard() -> int by=members
  do
   require operation.id!=""
   return 7
"#
    );
    let scratch = tempfile::tempdir().unwrap();
    let default = compile_source(scratch.path(), false, &source);
    let artifact = compile_source(scratch.path(), true, &source);
    for (name, kind, ty, parameter, model) in [
        ("operation_id", "operation-id", "text", None, None),
        (
            "original_version",
            "admitted-reference-version",
            "int",
            Some("item"),
            Some("NativeReceipts.Item"),
        ),
        (
            "alias_version",
            "admitted-reference-version",
            "int",
            Some("item"),
            Some("NativeReceipts.Item"),
        ),
        (
            "post_write_version",
            "admitted-reference-version",
            "int",
            Some("item"),
            Some("NativeReceipts.Item"),
        ),
    ] {
        assert!(
            operation(&default, name)["result"]
                .get("disclosure")
                .is_none()
        );
        let op = operation(&artifact, name);
        let plan = &op["result"]["disclosure"];
        assert_eq!(plan["version"], 1, "{name}");
        let returns = plan["returns"].as_array().unwrap();
        assert_eq!(returns.len(), 1, "{name}");
        if name == "post_write_version" {
            assert_eq!(returns[0]["dependencies"].as_array().unwrap().len(), 1);
            assert_eq!(returns[0]["dependencies"][0]["field"], "value");
            assert_eq!(returns[0]["dependencies"][0]["role"], "data");
        } else {
            assert_eq!(
                returns[0]["dependencies"],
                serde_json::json!([]),
                "intrinsics must not pretend to be stored fields"
            );
        }
        let intrinsics = returns[0]["intrinsics"].as_array().unwrap();
        assert_eq!(intrinsics.len(), 1, "{name}");
        let intrinsic = &intrinsics[0];
        assert_eq!(intrinsic["kind"], kind);
        assert_eq!(intrinsic["type"], ty);
        assert_eq!(intrinsic["role"], "data");
        assert!(!intrinsic["id"].as_str().unwrap().is_empty());
        assert_eq!(
            intrinsic.get("parameter").and_then(Value::as_str),
            parameter
        );
        assert_eq!(intrinsic.get("model").and_then(Value::as_str), model);
        assert_eq!(intrinsic["source"], plan["source"]);
        assert!(intrinsic.get("field").is_none());
    }
    let private = &operation(&artifact, "private_version")["result"]["disclosure"];
    let paths = private["returns"].as_array().unwrap();
    assert_eq!(paths.len(), 2);
    for path in paths {
        assert_eq!(path["dependencies"].as_array().unwrap().len(), 1);
        assert_eq!(path["dependencies"][0]["field"], "private_choice");
        assert_eq!(path["dependencies"][0]["role"], "control");
    }
    assert_eq!(
        paths
            .iter()
            .filter(|path| path["intrinsics"]
                .as_array()
                .is_some_and(|values| !values.is_empty()))
            .count(),
        1
    );
    for (name, ty) in [
        ("primitive_int", "int"),
        ("primitive_text", "text"),
        ("primitive_bool", "bool"),
    ] {
        let op = operation(&artifact, name);
        let plan = &op["result"]["disclosure"];
        assert_eq!(plan["version"], 1);
        let intrinsics = plan["returns"][0]["intrinsics"].as_array().unwrap();
        assert_eq!(
            intrinsics.len(),
            1,
            "unused required slots have no fabricated evaluation: {name}"
        );
        assert_eq!(intrinsics[0]["kind"], "admitted-input");
        assert_eq!(intrinsics[0]["parameter"], "value");
        assert_eq!(intrinsics[0]["type"], ty);
        assert_eq!(intrinsics[0]["role"], "data");
        assert_eq!(intrinsics[0]["source"], plan["source"]);
        assert!(intrinsics[0].get("model").is_none() && intrinsics[0].get("field").is_none());
        let input = op["inputs"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|input| input["name"] == "value")
            .unwrap();
        assert_eq!(
            input["valueType"], ty,
            "native descriptor binds exact admitted primitive"
        );
        assert_eq!(input["required"], true);
        let generic_input = operation(&default, name)["inputs"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|input| input["name"] == "value")
            .unwrap();
        assert_eq!(
            generic_input.get("valueType").and_then(Value::as_str),
            (ty == "text").then_some("text"),
            "generic primitive input ABI stays unchanged"
        );
    }
    let control = &operation(&artifact, "primitive_control")["result"]["disclosure"];
    let paths = control["returns"].as_array().unwrap();
    assert_eq!(paths.len(), 2);
    let mut lengths = Vec::new();
    for path in paths {
        assert_eq!(path["dependencies"], serde_json::json!([]));
        let intrinsics = path["intrinsics"].as_array().unwrap();
        lengths.push(intrinsics.len());
        assert_eq!(intrinsics[0]["parameter"], "selected");
        assert_eq!(intrinsics[0]["kind"], "admitted-input");
        assert_eq!(intrinsics[0]["type"], "bool");
        assert_eq!(intrinsics[0]["role"], "control");
        if intrinsics.len() == 2 {
            assert_eq!(intrinsics[1]["parameter"], "value");
            assert_eq!(intrinsics[1]["role"], "data");
            assert_eq!(intrinsics[1]["type"], "int");
        }
    }
    lengths.sort();
    assert_eq!(
        lengths,
        [1, 2],
        "nonselected return input is never eagerly observed"
    );
    for name in [
        "frozen_optional",
        "frozen_default",
        "frozen_array",
        "frozen_enum",
    ] {
        let op = operation(&artifact, name);
        assert_eq!(
            op["result"]["type"],
            operation(&default, name)["result"]["type"]
        );
        let plan = &op["result"]["disclosure"];
        assert_eq!(
            plan["version"], 1,
            "existing frozen-input profile stays qualified: {name}"
        );
        for path in plan["returns"].as_array().unwrap() {
            assert!(
                path["intrinsics"]
                    .as_array()
                    .is_none_or(|values| values.is_empty()),
                "distinct frozen profile cannot claim required primitive intrinsic: {name}"
            );
        }
    }
    for (name, expected) in [
        ("shorthand_set", vec![("value", "int")]),
        (
            "shorthand_send",
            vec![("source", "text"), ("revision", "int")],
        ),
    ] {
        let op = operation(&artifact, name);
        let plan = &op["result"]["disclosure"];
        assert_eq!(
            plan["version"], 1,
            "shorthand keeps exact checked source closure: {name}"
        );
        let paths = plan["returns"].as_array().unwrap();
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0]["dependencies"], serde_json::json!([]));
        let intrinsics = paths[0]["intrinsics"].as_array().unwrap();
        assert_eq!(intrinsics.len(), expected.len());
        for (intrinsic, (parameter, ty)) in intrinsics.iter().zip(expected) {
            assert_eq!(intrinsic["kind"], "admitted-input");
            assert_eq!(intrinsic["parameter"], parameter);
            assert_eq!(intrinsic["type"], ty);
            assert_eq!(intrinsic["role"], "data");
            assert_eq!(intrinsic["source"], plan["source"]);
            assert!(intrinsic.get("field").is_none() && intrinsic.get("model").is_none());
            assert_eq!(
                op["inputs"]["fields"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|input| input["name"] == parameter)
                    .unwrap()["valueType"],
                ty
            );
        }
    }
    for name in [
        "guard_operation_before",
        "guard_operation_after",
        "guard_version_before",
        "guard_version_after",
    ] {
        let op = operation(&artifact, name);
        assert_eq!(op["result"]["type"], "void");
        let plan = &op["result"]["disclosure"];
        assert_eq!(plan["version"], 1);
        let paths = plan["returns"].as_array().unwrap();
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0]["dependencies"], serde_json::json!([]));
        let intrinsics = paths[0]["intrinsics"].as_array().unwrap();
        assert_eq!(
            intrinsics.len(),
            1,
            "successful effect guard must retain its exact control: {name}"
        );
        assert_eq!(intrinsics[0]["role"], "control");
        assert_eq!(intrinsics[0]["source"], plan["source"]);
        if name.starts_with("guard_operation") {
            assert_eq!(intrinsics[0]["kind"], "operation-id");
            assert_eq!(intrinsics[0]["type"], "text");
            assert!(
                intrinsics[0].get("parameter").is_none() && intrinsics[0].get("model").is_none()
            );
        } else {
            assert_eq!(intrinsics[0]["kind"], "admitted-reference-version");
            assert_eq!(intrinsics[0]["type"], "int");
            assert_eq!(intrinsics[0]["parameter"], "item");
            assert_eq!(intrinsics[0]["model"], "NativeReceipts.Item");
        }
    }
    for name in ["independent_version_guard", "independent_operation_guard"] {
        let plan = &operation(&artifact, name)["result"]["disclosure"];
        assert_eq!(plan["version"], 1);
        for path in plan["returns"].as_array().unwrap() {
            assert!(
                path["intrinsics"]
                    .as_array()
                    .is_none_or(|values| values.is_empty()),
                "require-only admission cannot taint independent literal without effects: {name}"
            );
            assert_eq!(path["dependencies"], serde_json::json!([]));
        }
    }
    assert!(
        operation(&artifact, "nullable_version")["result"]
            .get("disclosure")
            .is_none(),
        "nullable model version remains whole omitted"
    );
    let actor = &operation(&artifact, "body_actor")["result"]["disclosure"];
    assert_eq!(actor["version"], 1);
    assert_eq!(actor["returns"].as_array().unwrap().len(), 1);
    assert_eq!(actor["returns"][0]["dependencies"], serde_json::json!([]));
    assert_eq!(actor["returns"][0]["influences"], serde_json::json!([]));
    let js = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(js.contains("await observeScenarioReceiptIntrinsic(c,"));
    assert!(js.contains("await set(c,") && js.contains("await send(c,"));
    assert!(js.contains("binding:\"NativeReceipts.LLM\""));
    for module in default["modules"].as_array().unwrap() {
        assert!(
            !module["js"]
                .as_str()
                .unwrap()
                .contains("observeScenarioReceiptIntrinsic")
        );
    }
}
#[test]
fn original_generation_controls_publish_checked_send_set_closure_only() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let source = root.join("packages/cloudflare/test/fixtures/typed-generation-progress.can");
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--format=json",
            "--native-scenario-receipts",
            "--catalog",
        ])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&source)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact: Value = serde_json::from_slice(&output.stdout).unwrap();
    let operations = artifact["operations"].as_array().unwrap();
    for name in ["cancel", "reconcile"] {
        let operation = operations
            .iter()
            .find(|op| op["name"] == format!("TypedGenerationProgress.{name}"))
            .unwrap();
        let plan = &operation["result"]["disclosure"];
        assert_eq!(plan["version"], 1, "{name}");
        assert!(
            plan["returns"].as_array().unwrap().iter().all(|returned| {
                let dependencies = returned["dependencies"].as_array().unwrap();
                dependencies
                    .iter()
                    .any(|dep| dep["field"] == "request_source")
                    && dependencies
                        .iter()
                        .any(|dep| dep["field"] == "request_revision")
                    && dependencies
                        .iter()
                        .all(|dep| dep["model"] == "TypedGenerationProgress.Job")
            }),
            "send request addressing must retain its actual stored-field influences: {plan}"
        );
    }
    let generate = operations
        .iter()
        .find(|op| op["name"] == "TypedGenerationProgress.generate")
        .unwrap();
    let plan = &generate["result"]["disclosure"];
    assert_eq!(plan["version"], 1);
    let returns = plan["returns"].as_array().unwrap();
    assert_eq!(returns.len(), 1);
    assert_eq!(
        returns[0]["dependencies"],
        serde_json::json!([]),
        "invocation metadata is never a fabricated stored field"
    );
    let intrinsics = returns[0]["intrinsics"].as_array().unwrap();
    assert_eq!(
        intrinsics.len(),
        4,
        "original source request and successful admission require complete intrinsic closure"
    );
    for (kind, parameter, ty, role) in [
        ("operation-id", None, "text", "data"),
        ("admitted-reference-version", Some("job"), "int", "data"),
        ("admitted-input", Some("prompt"), "text", "data"),
        ("admitted-input", Some("accept"), "bool", "control"),
    ] {
        let intrinsic = intrinsics
            .iter()
            .find(|value| {
                value["kind"] == kind && value.get("parameter").and_then(Value::as_str) == parameter
            })
            .unwrap();
        assert_eq!(intrinsic["type"], ty);
        assert_eq!(intrinsic["role"], role);
        assert_eq!(intrinsic["source"], plan["source"]);
        assert!(intrinsic.get("field").is_none());
        if kind == "admitted-reference-version" {
            assert_eq!(intrinsic["model"], "TypedGenerationProgress.Job");
        } else {
            assert!(intrinsic.get("model").is_none());
        }
    }
    let callable = artifact["callables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|call| call["id"] == generate["name"])
        .unwrap();
    assert_eq!(plan["source"]["module"], callable["module"]);
    assert!(
        artifact["sources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|source| source["path"] == plan["source"]["path"]
                && source["sha256"] == plan["source"]["sha256"])
    );
    for (parameter, ty) in [("prompt", "text"), ("accept", "bool")] {
        assert_eq!(
            generate["inputs"]["fields"]
                .as_array()
                .unwrap()
                .iter()
                .find(|input| input["name"] == parameter)
                .unwrap()["valueType"],
            ty
        );
    }
    for name in ["visible", "measured", "sequence", "wholeSequence"] {
        let operation = operations
            .iter()
            .find(|op| op["name"] == format!("TypedGenerationProgress.{name}"))
            .unwrap();
        assert!(
            operation["result"].get("disclosure").is_none(),
            "nullable delivery readers remain unqualified: {name}"
        );
    }
    let js = artifact["modules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|module| module["js"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(js.matches("await send(c,").count() >= 3);
    assert!(js.matches("await set(c,").count() >= 3);
    assert!(js.contains("TextGenerationV1") && js.contains("deployment.llm"));
    assert!(js.contains("binding:\"TypedGenerationProgress.LLM\""));
    assert!(
        js.matches("await observeScenarioReceiptIntrinsic(c,")
            .count()
            >= 4
    );
    assert!(
        artifact["sources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|origin| origin["path"].as_str() == source.to_str())
    );
}
#[test]
fn opt_in_native_capture_retains_selected_paths_replays_and_current_state_projection() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let refused = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["check", "--native-scenario-receipts"])
        .arg(scratch.path().join("native-receipts.can"))
        .output()
        .unwrap();
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("only applies to can compile"));
    let default = compile(scratch.path(), false);
    let artifact = compile(scratch.path(), true);
    for op in default["operations"].as_array().unwrap() {
        assert!(op["result"].get("disclosure").is_none());
    }
    for module in default["modules"].as_array().unwrap() {
        let js = module["js"].as_str().unwrap();
        assert!(!js.contains("observeScenarioReceiptDependency"));
        assert!(!js.contains("selectScenarioReceiptReturn"));
    }
    for name in [
        "literal",
        "input",
        "operation_id",
        "original_version",
        "post_write_version",
        "checked",
        "field",
        "branch",
        "conjunction",
        "disjunction",
        "fallback",
        "matched",
        "implicit_void",
        "conditional_void",
        "ignored",
        "reused",
        "arrays",
        "stored_array",
        "literal_array",
        "named_result",
        "derived",
        "imported",
        "nested",
        "repeated",
        "reordered",
        "derived_default",
        "derived_override",
        "derived_lazy",
        "derived_match",
        "machine",
        "changed",
        "computed",
        "private_write",
        "public_write",
    ] {
        let op = operation(&artifact, name);
        let plan = &op["result"]["disclosure"];
        assert_eq!(plan["version"], 1, "{name}");
        let callable = artifact["callables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|call| call["id"] == op["name"])
            .unwrap();
        for origin in std::iter::once(&plan["source"]).chain(
            plan["returns"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|returned| {
                    std::iter::once(&returned["source"]).chain(
                        returned["dependencies"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|dep| &dep["source"]),
                    )
                }),
        ) {
            assert_eq!(origin["module"], callable["module"]);
            assert!(
                artifact["sources"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|source| source["path"] == origin["path"]
                        && source["sha256"] == origin["sha256"])
            );
        }
        assert_eq!(callable["module"], artifact["modules"][0]["path"]);
        assert_eq!(
            op["result"]["type"],
            operation(&default, name)["result"]["type"]
        );
    }
    let imported = &operation(&artifact, "imported")["result"]["disclosure"];
    let imported_origin = &imported["returns"][0]["dependencies"][0]["source"];
    assert!(
        imported_origin["path"]
            .as_str()
            .unwrap()
            .ends_with("receiptlib.can")
    );
    assert_ne!(imported_origin["path"], imported["source"]["path"]);
    assert_ne!(imported_origin["sha256"], imported["source"]["sha256"]);
    for name in [
        "query",
        "absent",
        "composite",
        "model_array",
        "required_array",
        "machine_read",
    ] {
        assert!(
            operation(&artifact, name)["result"]
                .get("disclosure")
                .is_none(),
            "whole unsupported recipe omitted: {name}"
        );
    }
    let model = &operation(&artifact, "model")["result"]["disclosure"];
    assert_eq!(model["version"], 1);
    let paths = model["returns"].as_array().unwrap();
    assert_eq!(paths.len(), 1);
    assert_eq!(paths[0]["dependencies"].as_array().unwrap().len(), 1);
    assert_eq!(paths[0]["dependencies"][0]["model"], "NativeReceipts.Item");
    assert_eq!(paths[0]["dependencies"][0]["field"], "id");
    assert_eq!(paths[0]["dependencies"][0]["role"], "data");
    assert_eq!(paths[0]["dependencies"][0]["type"], "text");
    assert_eq!(paths[0]["influences"], serde_json::json!([]));
    let runner = scratch.path().join("native.mjs");
    std::fs::write(&runner, RUNNER).unwrap();
    let output = Command::new("node")
        .arg(&runner)
        .arg(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
const RUNNER: &str = r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const base=dirname(fileURLToPath(import.meta.url)),root=process.argv[2];
const require=createRequire(resolve(root,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules}=await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker}=await load('@canlang/cloudflare/worker/assembly');
const {loadCanonicalDescriptors}=await load('@canlang/cloudflare/runtime/invoke');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const {readScenarioReceiptAssociation,projectScenarioReceipt}=await load('@canlang/state/invocation');
const {StateError}=await load('@canlang/state/errors');
const {FIXED_NOW,createMemoryIdentityStore,seedMember,makeIdentity,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const artifact=JSON.parse(readFileSync(resolve(base,'native.json'),'utf8'));
const asm=await assembleModules({artifact,sourcePath:resolve(base,'native-receipts.can')},{workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href});
const entry=await import(asm.entryUrl);
assert.deepEqual(entry.canApp().operations,artifact.operations,'actual imported canApp publication');
const loaded=await loadCanonicalDescriptors(asm,artifact);
const {store:backing,probe}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
let commits=0;const store={...backing,commit:async batch=>{commits++;return backing.commit(batch);}};
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
let sequence=0;
const request=(name,inputs)=>({operation:'NativeReceipts.'+name,operation_id:uuidv7(FIXED_NOW,++sequence),inputs});
const receiptFor=req=>store.readReceipt({app:'NativeReceipts',owner:identity.team.team_id,principal:identity.actor.user_id,operation:req.operation,operationId:req.operation_id});
const invoke=req=>invoker.invokeMutation(req,identity);
const committed=async req=>{const value=await invoke(req);assert.ok('result' in value,JSON.stringify(value));assert.equal(value.result.status,'committed');return value.result;};
const create=async data=>{const req=request('Item.create',data);const result=await committed(req);assert.equal(result.records.length,1);return result.records[0];};
const yes=await create({value:'17',enabled:true,optional:null,values:null,required:[]});
const no=await create({value:'-3',enabled:false,optional:'9',values:[],required:[]});
const populated=await create({value:'5',enabled:true,optional:null,values:['9223372036854775807','-2'],required:[]});
const sharedRequest={...request('unused',{value:'23'}),operation:'receiptlib.Shared.create'};
const sharedResult=await committed(sharedRequest);assert.equal(sharedResult.records.length,1);
const shared=sharedResult.records[0];
const rows=new Map([yes,no,populated,shared].map(row=>[row.id,row]));
const ref=row=>({id:row.id,version:String(row.version)});
const saved=[];
for(const [name,inputs,expected,fields] of [
 ['literal',{},'7',[]],['input',{value:'9223372036854775807'},'9223372036854775807',[]],
 ['operation_id',{},null,[]],['original_version',{item:ref(yes)},'1',[]],
 ['checked',{item:ref(yes)},'7',[]],['field',{item:ref(yes)},'17',['value']],
 ['branch',{item:ref(yes)},'17',['enabled','value']],['branch',{item:ref(no)},'0',['enabled']],
 ['conjunction',{item:ref(yes)},true,['enabled','value']],['conjunction',{item:ref(no)},false,['enabled']],
 ['disjunction',{item:ref(yes)},true,['enabled']],['disjunction',{item:ref(no)},false,['enabled','value']],
 ['fallback',{item:ref(yes)},'17',['optional','value']],['fallback',{item:ref(no)},'9',['optional']],
 ['matched',{value:'a'},'1',[]],['matched',{value:'b'},'2',[]],
 ['implicit_void',{},null,[]],['conditional_void',{selected:true},null,[]],['conditional_void',{selected:false},null,[]],
 ['ignored',{item:ref(yes)},'7',[]],['ignored',{item:ref(no)},'7',[]],
 ['reused',{item:ref(yes)},true,['enabled']],['reused',{item:ref(no)},false,['enabled']],
 ['arrays',{values:null},null,[]],['arrays',{values:[]},[],[]],['arrays',{values:['9223372036854775807','-2']},['9223372036854775807','-2'],[]],
 ['stored_array',{item:ref(yes)},null,['values']],['stored_array',{item:ref(no)},[],['values']],['stored_array',{item:ref(populated)},['9223372036854775807','-2'],['values']],
 ['literal_array',{item:ref(yes)},['17','17'],['value','optional']],['literal_array',{item:ref(no)},['-3','9'],['value','optional']],
 ['named_result',{value:'a'},'a',[]],['named_result',{value:'b'},'b',[]],
 ['derived',{item:ref(yes)},'17',['value']],['imported',{shared:ref(shared)},'23',['value']],
 ['nested',{item:ref(yes)},'18',['value']],['repeated',{item:ref(yes)},'34',['value']],
 ['reordered',{item:ref(yes)},'0',['value','optional']],['reordered',{item:ref(no)},'12',['value','optional']],
 ['derived_default',{item:ref(yes)},'17',['value']],['derived_override',{item:ref(yes)},'42',[]],
 ['derived_lazy',{item:ref(yes)},'17',['optional','value','enabled']],['derived_lazy',{item:ref(no)},'9',['optional','enabled']],
 ['derived_match',{item:ref(yes),selected:'a'},'17',['value']],['derived_match',{item:ref(yes),selected:'b'},'18',['value']],
]){
 const req=request(name,inputs),result=await committed(req),receipt=await receiptFor(req);
 const actualExpected=name==='operation_id'?req.operation_id:expected;
 assert.deepEqual(result.result,actualExpected);assert.deepEqual(receipt.outcome.result,actualExpected);
 assert.equal(JSON.stringify(result).includes('scenario-result/v1'),false,'association metadata remains private');
 const association=readScenarioReceiptAssociation(receipt);assert.ok(association,'native State-owned capture');
 const descriptor=artifact.operations.find(op=>op.name===req.operation);
 assert.deepEqual(association.plan,descriptor.result.disclosure);
 const path=association.plan.returns.find(value=>value.id===association.returnId);assert.ok(path);
 if(['input','operation_id','original_version'].includes(name)){
  assert.equal(path.intrinsics.length,1);assert.equal(association.intrinsics.length,1);
  const declared=path.intrinsics[0],captured=association.intrinsics[0];
  assert.equal(captured.dependencyId,declared.id);assert.equal(captured.kind,declared.kind);
  assert.deepEqual(declared.source,association.plan.source);
  assert.equal(captured.wire,name==='operation_id'?req.operation_id:name==='input'?inputs.value:'1');
  if(name==='original_version'){
   assert.equal(declared.parameter,'item');assert.equal(declared.model,'NativeReceipts.Item');
   assert.equal(captured.model,'NativeReceipts.Item');assert.deepEqual(captured.row,await store.load('NativeReceipts.Item',yes.id));
   assert.equal(captured.row.version,1);assert.deepEqual(captured.secretFields,[]);
  }
 }
 assert.deepEqual([...new Set(path.dependencies.map(dep=>dep.field))].sort(),[...fields].sort());
 assert.deepEqual([...association.observations.map(observation=>observation.dependencyId)].sort(),[...path.dependencies.map(dep=>dep.id)].sort());
 assert.deepEqual(association.changed,[]);
 if(name==='literal_array'){
  assert.deepEqual(association.observations.map(observation=>observation.dependencyId),path.dependencies.map(dep=>dep.id),'actual left-to-right marker sequence');
  const ordered=path.dependencies.map(dep=>dep.field);assert.equal(ordered[0],'value');
  assert.equal(ordered[1],'optional');
  assert.equal(ordered.filter(field=>field==='value').length,inputs.item.id===yes.id?2:1,'fallback read remains lazy');
 }
 if(name==='stored_array')assert.equal(path.dependencies[0].type,'int[]?');
 if(name==='reused')assert.equal(new Set(path.dependencies.map(dep=>dep.field)).size,1,'one checked field reused across data/control');
 if(['derived','imported','nested','repeated','reordered','derived_default','derived_override','derived_lazy','derived_match'].includes(name)){
  assert.deepEqual(association.observations.map(observation=>observation.dependencyId),path.dependencies.map(dep=>dep.id),'derive markers preserve actual evaluation chronology');
 }
 if(name==='repeated'){
  assert.equal(path.dependencies.length,2,'two calls read the same defining callee member twice');
  assert.notEqual(path.dependencies[0].id,path.dependencies[1].id,'checked callchains distinguish repeated callee sites');
  assert.equal(new Set(association.observations.map(observation=>observation.dependencyId)).size,2);
 }
 if(name==='reordered'){
  assert.deepEqual(path.dependencies.map(dep=>dep.field),inputs.item.id===yes.id?['value','optional','optional','value']:['value','optional','optional'],'source arguments execute before declaration-slot reorder');
 }
 if(name==='derived_default')assert.equal(path.dependencies.length,1,'omitted source default evaluates one stored read');
 if(name==='derived_override')assert.deepEqual(association.observations,[],'explicit argument skips the source default');
 if(name==='derived_lazy')assert.equal(path.dependencies.filter(dep=>dep.field==='value').length,inputs.item.id===yes.id?1:0,'derive fallback keeps its RHS lazy');
 for(const observation of association.observations){const input=name==='imported'?inputs.shared:inputs.item;assert.equal(observation.model,name==='imported'?'receiptlib.Shared':'NativeReceipts.Item');assert.equal(observation.row.id,input.id);assert.deepEqual(observation.row.data,rows.get(input.id).data);}
 const revision=await store.readRevision(),count=commits,history=await store.historyFor('NativeReceipts.Item',yes.id);
 const replay=await invoke(req);assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');assert.deepEqual(replay.result.result,actualExpected);
 assert.equal(commits,count);assert.equal(await store.readRevision(),revision);assert.deepEqual(await receiptFor(req),receipt);assert.deepEqual(await store.historyFor('NativeReceipts.Item',yes.id),history);
 const projected=await projectScenarioReceipt({receipt,registry:loaded.registry,policy:loaded.policy,app:'NativeReceipts',identity,store,memberships});
 assert.deepEqual(projected.result,actualExpected);assert.deepEqual(projected.records,[]);
 saved.push({req,receipt,expected:actualExpected});
}
// Initial validation/business refusal keeps the actual checked pipeline controls.
const failed=request('checked',{item:ref(no)}),denied=await invoke(failed);
assert.ok('error' in denied,JSON.stringify(denied));assert.equal(denied.error.code,'rule_failed');
assert.equal((await receiptFor(failed)).outcome.status,'rejected');
const invalid=request('input',{value:'not-an-int'}),bad=await invoke(invalid);
assert.ok('error' in bad,JSON.stringify(bad));assert.equal(bad.error.code,'validation');
// Current row changes cannot substitute for the genuinely saved scalar or rerun the handler.
for(const values of [42,{},['not-int'],[null],['1',null]]){
 const req=request('arrays',{values}),before=await store.readRevision(),result=await invoke(req);
 assert.ok('error' in result,JSON.stringify(result));assert.equal(result.error.code,'validation');
 if(Array.isArray(values)){
  const receipt=await receiptFor(req);assert.equal(receipt.outcome.status,'rejected');assert.equal(receipt.outcome.code,'validation');assert.equal(await store.readRevision(),before+1);
 }else{assert.equal(await receiptFor(req),null,'nonarray native inputs refuse before State admission');assert.equal(await store.readRevision(),before);}
}
const current=await store.load('NativeReceipts.Item',yes.id);
await committed(request('Item.update',{record:ref(current),value:'99',values:['8','9']}));
const arrayCurrent=await store.load('NativeReceipts.Item',populated.id);
await committed(request('Item.update',{record:ref(arrayCurrent),values:['11']}));
const field=saved.find(value=>value.req.operation==='NativeReceipts.field');
const before={revision:await store.readRevision(),commits};
const replay=await invoke(field.req);assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');assert.equal(replay.result.result,'17');
assert.equal(commits,before.commits);assert.equal(await store.readRevision(),before.revision);
assert.equal((await projectScenarioReceipt({receipt:field.receipt,registry:loaded.registry,policy:loaded.policy,app:'NativeReceipts',identity,store,memberships})).result,'17');
const originalArray=saved.find(value=>value.req.operation==='NativeReceipts.stored_array'&&value.req.inputs.item.id===populated.id);
const originalDerived=saved.find(value=>value.req.operation==='NativeReceipts.nested');
const derivedReplay=await invoke(originalDerived.req);assert.ok('result' in derivedReplay,JSON.stringify(derivedReplay));
assert.equal(derivedReplay.result.status,'replayed');assert.equal(derivedReplay.result.result,'18','nested derive does not reread the current value 99');
const arrayReplay=await invoke(originalArray.req);assert.ok('result' in arrayReplay,JSON.stringify(arrayReplay));
assert.equal(arrayReplay.result.status,'replayed');assert.deepEqual(arrayReplay.result.result,['9223372036854775807','-2']);
assert.deepEqual(readScenarioReceiptAssociation(await receiptFor(originalArray.req)).observations[0].row.data.values,['9223372036854775807','-2']);
assert.deepEqual((await projectScenarioReceipt({receipt:originalArray.receipt,registry:loaded.registry,policy:loaded.policy,app:'NativeReceipts',identity,store,memberships})).result,['9223372036854775807','-2']);
assert.equal(commits,before.commits);assert.equal(await store.readRevision(),before.revision);
// Dedicated recovery uses the actual public entry with no writable or file capability.
let retainedCommits=0,fileReads=0;
const readonlyStore={...store,commit:async()=>{retainedCommits++;throw new Error('retained commit tripwire');}};
const fileTripwire=new Proxy({},{get(){fileReads++;throw new Error('retained file metadata tripwire');}});
const retainedInvoker=buildInvoker(artifact,asm,readonlyStore,{memberships,now:()=>FIXED_NOW+16*60000,files:fileTripwire});
// Actual generated Set handlers save both the source closure and the final
// issued row. Private selectors control public changed-record existence even
// when their selected branch performs no write.
const written=[];
for(const [name,choice,fields] of [
 ['changed',true,[]],['computed',true,['value','label','enabled']],
 ['post_write_version',true,['value']],
 ['private_write',true,['private_choice']],['private_write',false,['private_choice']],
 ['public_write',true,['public_choice']],['public_write',false,['public_choice']],
]){
 const itemModel=['changed','post_write_version'].includes(name);
 const model=itemModel?'NativeReceipts.Item':'NativeReceipts.WriteItem';
 const born=itemModel?await create({value:'5',enabled:true,optional:null,values:null,required:[]}):
  (await committed(request('WriteItem.create',{value:'5',label:'Original',note:'Clear me',enabled:true,private_choice:choice,public_choice:choice}))).records[0];
 const original=await store.load(model,born.id);
 const req=request(name,{item:ref(born)}),result=await committed(req),receipt=await receiptFor(req);
 const withheld=name==='private_write';
 assert.equal(result.result,withheld?null:'1');assert.equal(receipt.outcome.result,'1');
 assert.equal(result.records.length,choice&&!withheld?1:0);
 const physical=await store.load(model,born.id);
 assert.equal(physical.version,choice?2:1);
 assert.equal(physical.data.value,choice?(['computed','post_write_version'].includes(name)?'6':'2'):'5');
 if(name==='computed'){assert.equal(physical.data.label,'Original');assert.equal(physical.data.note,null);assert.equal(physical.data.enabled,true);}
 const association=readScenarioReceiptAssociation(receipt);assert.ok(association,'Set owns a genuine successful native association');
 assert.deepEqual(association.plan,artifact.operations.find(op=>op.name===req.operation).result.disclosure);
 const path=association.plan.returns.find(value=>value.id===association.returnId);assert.ok(path);
 assert.deepEqual(path.dependencies.map(dep=>dep.field),fields);
 assert.deepEqual(association.observations.map(value=>value.dependencyId),path.dependencies.map(value=>value.id));
 for(const dependency of path.dependencies){assert.equal(dependency.model,model);assert.equal(dependency.role,['computed','post_write_version'].includes(name)?'data':'control');}
 if(name==='post_write_version'){
  assert.equal(path.intrinsics.length,1);assert.equal(association.intrinsics.length,1);
  const declared=path.intrinsics[0],captured=association.intrinsics[0];
  assert.equal(declared.kind,'admitted-reference-version');assert.equal(declared.parameter,'item');assert.equal(declared.type,'int');
  assert.equal(captured.dependencyId,declared.id);assert.equal(captured.kind,declared.kind);assert.equal(captured.wire,'1','post-write expression retains the admitted ORIGINAL version');
  assert.equal(captured.model,model);assert.deepEqual(captured.row,original);assert.equal(captured.row.version,1);
 }
 for(const observation of association.observations){assert.equal(observation.row.id,born.id);assert.deepEqual(observation.row,original);}
 assert.equal(association.changed.length,choice?1:0);
 if(choice){assert.equal(association.changed[0].model,model);assert.deepEqual(association.changed[0].row,physical);}
 const stable=async()=>({row:await store.load(model,born.id),history:await store.historyFor(model,born.id),receipt:await receiptFor(req),
  revision:await store.readRevision(),commits,outbox:probe.outboxAll(),schedules:await store.schedulesDue(Number.MAX_SAFE_INTEGER,100)});
 const before=await stable();
 for(const transport of [invoker,retainedInvoker]){
  const replay=await transport.invokeMutation(req,identity);assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');
  assert.deepEqual(replay.result.result,result.result);assert.deepEqual(replay.result.records,result.records);
 }
 const retained=await retainedInvoker.invokeRetainedMutation(req,identity);assert.ok('result' in retained,JSON.stringify(retained));
 assert.equal(retained.result.status,'replayed');assert.deepEqual(retained.result.result,result.result);assert.deepEqual(retained.result.records,result.records);
 assert.deepEqual(await stable(),before);assert.equal(retainedCommits,0);assert.equal(fileReads,0);
 if(name==='post_write_version'){
  await committed(request('Item.update',{record:ref(physical),value:'99'}));
  assert.equal((await store.load(model,born.id)).version,3);
  const after=await stable();
  for(const dedicated of [false,true]){
   const recovered=await (dedicated?retainedInvoker.invokeRetainedMutation(req,identity):retainedInvoker.invokeMutation(req,identity));
   assert.ok('result' in recovered,JSON.stringify(recovered));assert.equal(recovered.result.status,'replayed');
   assert.equal(recovered.result.result,'1');assert.deepEqual(recovered.result.records,result.records,'saved changed value6/version2 survives later value99/version3');
  }
  assert.deepEqual(await stable(),after);assert.equal(retainedCommits,0);assert.equal(fileReads,0);
 }
 written.push({req,receipt,model,row:physical,result});
}
const originalVersion=saved.find(value=>value.req.operation==='NativeReceipts.original_version');
const originalOperation=saved.find(value=>value.req.operation==='NativeReceipts.operation_id');
const originalInput=saved.find(value=>value.req.operation==='NativeReceipts.input');
const retainedCases=[field,originalArray,originalDerived,originalVersion,originalOperation,originalInput];
const snapshot=async()=>({receipts:await Promise.all(retainedCases.map(value=>receiptFor(value.req))),
 revision:await store.readRevision(),rows:await store.query({model:'NativeReceipts.Item',authority:'owner',archived:'include'}),
 history:await Promise.all([yes,no,populated].map(row=>store.historyFor('NativeReceipts.Item',row.id))),
 outbox:probe.outboxAll(),schedules:await store.schedulesDue(Number.MAX_SAFE_INTEGER,100)});
let retainedBefore=await snapshot();
for(const value of retainedCases){
 const replay=await retainedInvoker.invokeRetainedMutation(value.req,identity);
 assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');
 assert.deepEqual(replay.result.result,value.expected);assert.deepEqual(replay.result.records,[]);
 assert.equal(JSON.stringify(replay).includes('scenario-result/v1'),false,'dedicated output excludes association');
}
assert.deepEqual(await snapshot(),retainedBefore);assert.equal(retainedCommits,0);assert.equal(fileReads,0);
// Existing storage seam: reject the actual observation load after one admission load.
const failure=new StateError('validation','native array observation refused');let targetLoads=0;
const faultStore={...store,load:async(model,id)=>{
 if(model==='NativeReceipts.Item'&&id===yes.id&&++targetLoads===2)throw failure;
 return store.load(model,id);
}};
const faultInvoker=buildInvoker(artifact,asm,faultStore,{memberships,now:()=>FIXED_NOW});
const live=await store.load('NativeReceipts.Item',yes.id),faultRequest=request('literal_array',{item:ref(live)});
const effectsBefore={row:live,history:await store.historyFor('NativeReceipts.Item',yes.id),outbox:probe.outboxAll()};
const refused=await faultInvoker.invokeMutation(faultRequest,identity);
assert.ok('error' in refused,JSON.stringify(refused));assert.equal(refused.error.code,'validation');
assert.equal(targetLoads,2,'first observation rejection starts no later observation');
const rejected=await receiptFor(faultRequest);assert.equal(rejected.outcome.status,'rejected');
assert.equal(readScenarioReceiptAssociation(rejected),null,'no selected successful association');
assert.deepEqual(await store.load('NativeReceipts.Item',yes.id),effectsBefore.row);
assert.deepEqual(await store.historyFor('NativeReceipts.Item',yes.id),effectsBefore.history);
assert.deepEqual(probe.outboxAll(),effectsBefore.outbox);
// This does not claim instrumentation of unobserved pure element evaluation.
// Real generated CRUD archive changes current lifetime; public transports withhold saved values.
for(const row of [yes,populated]){
 const current=await store.load('NativeReceipts.Item',row.id);
 await committed(request('Item.delete',{record:ref(current)}));
 assert.notEqual((await store.load('NativeReceipts.Item',row.id)).archivedAt,null);
}
retainedBefore=await snapshot();
for(const value of retainedCases){
 for(const dedicated of [false,true]){
  const replay=await (dedicated?retainedInvoker.invokeRetainedMutation(value.req,identity):invoke(value.req));
  assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');
  const association=readScenarioReceiptAssociation(value.receipt);
  const path=association.plan.returns.find(path=>path.id===association.returnId);
  const readsRow=path.dependencies.length>0||(path.intrinsics??[]).some(dep=>dep.kind==='admitted-reference-version');
  assert.deepEqual(replay.result.result,readsRow?null:value.expected,'original-reference intrinsic gates lifetime even without stored-field dependencies');assert.deepEqual(replay.result.records,[]);
  assert.equal(JSON.stringify(replay).includes('scenario-result/v1'),false);
 }
}
assert.deepEqual(await snapshot(),retainedBefore);assert.equal(retainedCommits,0);assert.equal(fileReads,0);
// Current read authority also gates the saved Set result and changed row.
for(const value of written){
 const current=await store.load(value.model,value.row.id);
 await committed(request(value.model==='NativeReceipts.Item'?'Item.delete':'WriteItem.delete',{record:ref(current)}));
 const before={receipt:await receiptFor(value.req),row:await store.load(value.model,value.row.id),history:await store.historyFor(value.model,value.row.id),revision:await store.readRevision(),commits};
 for(const dedicated of [false,true]){
  const outcome=await (dedicated?retainedInvoker.invokeRetainedMutation(value.req,identity):retainedInvoker.invokeMutation(value.req,identity));
  assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'replayed');
  assert.equal(outcome.result.result,value.req.operation==='NativeReceipts.changed'?'1':null,'an independent literal remains frozen while required unreadable influences withhold');assert.deepEqual(outcome.result.records,[]);
 }
 assert.deepEqual(await receiptFor(value.req),before.receipt);assert.deepEqual(await store.load(value.model,value.row.id),before.row);
 assert.deepEqual(await store.historyFor(value.model,value.row.id),before.history);assert.equal(await store.readRevision(),before.revision);assert.equal(commits,before.commits);
}
retainedBefore=await snapshot();
const afterArchive={revision:await store.readRevision(),commits};
// Revocation is checked by the released State projection over that exact native receipt.
await memberships.removeMembership(member.membership.membership_id);
for(const value of [...saved,...written]){assert.deepEqual(await projectScenarioReceipt({receipt:value.receipt,registry:loaded.registry,policy:loaded.policy,app:'NativeReceipts',identity,store,memberships}),{result:null,records:[]});}
for(const value of retainedCases){
 const denied=await retainedInvoker.invokeRetainedMutation(value.req,identity);
 assert.ok('error' in denied,JSON.stringify(denied));assert.equal(denied.error.code,'forbidden');
 assert.equal(JSON.stringify(denied).includes('scenario-result/v1'),false);
}
assert.deepEqual(await snapshot(),retainedBefore);assert.equal(retainedCommits,0);assert.equal(fileReads,0);
assert.equal(commits,afterArchive.commits);assert.equal(await store.readRevision(),afterArchive.revision);
assert.equal(probe.outboxAll().length,0);
"#;

#[test]
fn native_reference_array_loop_preserves_ordered_stage_reads_and_empty_replay() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("../../tests/integration/can-dev-server/NativeRefArrays.can");
    let generic = compile_source(scratch.path(), false, source);
    let artifact = compile_source(scratch.path(), true, source);
    let find = |name: &str| {
        artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["name"] == name)
            .unwrap()
    };
    let plan = &find("NativeRefArrays.step")["result"]["disclosure"];
    let paths = plan["returns"]
        .as_array()
        .expect("actual finite sourceFor disclosure");
    assert_eq!(paths.len(), 2);
    assert_eq!(
        paths
            .iter()
            .filter(|path| path["dependencies"].as_array().unwrap().is_empty())
            .count(),
        1
    );
    let nonempty = paths
        .iter()
        .find(|path| !path["dependencies"].as_array().unwrap().is_empty())
        .unwrap();
    assert_eq!(nonempty["dependencies"].as_array().unwrap().len(), 1);
    assert_eq!(nonempty["dependencies"][0]["model"], "NativeRefArrays.Item");
    assert_eq!(nonempty["dependencies"][0]["field"], "value");
    for op in generic["operations"].as_array().unwrap() {
        assert!(op["result"].get("disclosure").is_none());
    }
    let runner = scratch.path().join("reference-array.mjs");
    std::fs::write(&runner, REF_ARRAY_RUNNER).unwrap();
    let output = Command::new("node")
        .arg(&runner)
        .arg(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

const REF_ARRAY_RUNNER: &str = r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const base=dirname(fileURLToPath(import.meta.url)),root=process.argv[2];
const require=createRequire(resolve(root,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules}=await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker}=await load('@canlang/cloudflare/worker/assembly');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const {readScenarioReceiptAssociation}=await load('@canlang/state/invocation');
const {FIXED_NOW,createMemoryIdentityStore,seedMember,makeIdentity,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const artifact=JSON.parse(readFileSync(resolve(base,'native.json'),'utf8'));
const asm=await assembleModules({artifact,sourcePath:resolve(base,'native-receipts.can')},{workDir:resolve(base,'array-modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href});
const entry=await import(asm.entryUrl);assert.deepEqual(entry.canApp().operations,artifact.operations);
const {store:backing,probe}=createTestMemoryStorage();
let commits=0;const store={...backing,commit:async batch=>{commits++;return backing.commit(batch);}};
const memberships=createMemoryIdentityStore(),member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
let sequence=0;const request=(name,inputs)=>({operation:'NativeRefArrays.'+name,operation_id:uuidv7(FIXED_NOW,++sequence),inputs});
const receiptFor=req=>store.readReceipt({app:'NativeRefArrays',owner:identity.team.team_id,principal:identity.actor.user_id,operation:req.operation,operationId:req.operation_id});
const committed=async req=>{const outcome=await invoker.invokeMutation(req,identity);assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'committed');return outcome.result;};
const model='NativeRefArrays.Item';
const a=(await committed(request('Item.create',{value:'0'}))).records[0],b=(await committed(request('Item.create',{value:'0'}))).records[0];
const ref=row=>({id:row.id,version:String(row.version)});
const inputs={items:[ref(a),ref(b),ref(a)]},originalInputs=structuredClone(inputs);
const req=request('step',inputs),beforeCommits=commits,result=await committed(req),receipt=await receiptFor(req);
assert.deepEqual(inputs,originalInputs,'original admitted reference slots remain immutable');
assert.equal(commits,beforeCommits+1,'one root commit for all repeated writes');
const association=readScenarioReceiptAssociation(receipt);assert.ok(association);
const path=association.plan.returns.find(path=>path.id===association.returnId);assert.equal(path.dependencies.length,1);
const dependency=path.dependencies[0];assert.equal(dependency.model,model);assert.equal(dependency.field,'value');
assert.deepEqual(association.observations.map(value=>value.dependencyId),[dependency.id,dependency.id,dependency.id]);
assert.deepEqual(association.observations.map(value=>value.row.id),[a.id,b.id,a.id]);
assert.deepEqual(association.observations.map(value=>value.row.data.value),['0','0','1']);
assert.deepEqual(association.observations.map(value=>value.row.version),[1,1,2]);
const finalA=await store.load(model,a.id),finalB=await store.load(model,b.id);
assert.equal(finalA.data.value,'2');assert.equal(finalB.data.value,'1');assert.equal(finalA.version,2);assert.equal(finalB.version,2);
assert.equal(association.changed.length,2);
for(const row of [finalA,finalB]){const changed=association.changed.find(value=>value.row.id===row.id);assert.equal(changed.model,model);assert.deepEqual(changed.row,row);assert.deepEqual(changed.fieldTypes,{value:'int'});assert.deepEqual(changed.secretFields,[]);assert.deepEqual(changed.withheldFields,[]);}
assert.equal(result.records.length,2);
const stable=async request=>({rows:[await store.load(model,a.id),await store.load(model,b.id)],history:[await store.historyFor(model,a.id),await store.historyFor(model,b.id)],receipt:await receiptFor(request),revision:await store.readRevision(),commits,outbox:probe.outboxAll(),schedules:await store.schedulesDue(Number.MAX_SAFE_INTEGER,100)});
const replay=async(request,result)=>{const before=await stable(request);const outcome=await invoker.invokeMutation(request,identity);assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'replayed');assert.deepEqual(outcome.result.result,result.result);assert.deepEqual(outcome.result.records,result.records);assert.deepEqual(await stable(request),before);};
await replay(req,result);
for(const inputs of [{items:[]},{}]){
 const empty=request('step',inputs),before=await stable(empty),result=await committed(empty),association=readScenarioReceiptAssociation(await receiptFor(empty));assert.ok(association);
 assert.deepEqual(association.observations,[]);assert.deepEqual(association.changed,[]);assert.deepEqual(result.records,[]);
 const after=await stable(empty);assert.deepEqual(after.rows,before.rows);assert.deepEqual(after.history,before.history);assert.deepEqual(after.outbox,before.outbox);assert.deepEqual(after.schedules,before.schedules);
 await replay(empty,result);
}
const unused=request('captured',{items:[ref(finalA)]}),unusedResult=await committed(unused);assert.equal(unusedResult.result,'7');assert.deepEqual(readScenarioReceiptAssociation(await receiptFor(unused)).observations,[]);await replay(unused,unusedResult);
for(const inputs of [{items:[ref(finalA),ref(finalB),ref(finalA),ref(finalB)]},{items:[ref(a)]},{items:[{id:a.id,version:'wrong'}]}]){
 const bad=request('step',inputs),before=await stable(bad),outcome=await invoker.invokeMutation(bad,identity);assert.ok('error' in outcome,JSON.stringify(outcome));
 const after=await stable(bad);for(const key of ['rows','history','outbox','schedules'])assert.deepEqual(after[key],before[key],key+' unchanged after refusal');
 const rejected=after.receipt;if(rejected)assert.equal(readScenarioReceiptAssociation(rejected),null);
}
const otherIdentity=makeIdentity({userId:'nonmember',team:member.team,membership:null});
const foreign=request('step',{items:[ref(finalA)]}),beforeForeign=await stable(foreign),denied=await invoker.invokeMutation(foreign,otherIdentity);assert.ok('error' in denied,JSON.stringify(denied));
for(const key of ['rows','history','outbox','schedules'])assert.deepEqual((await stable(foreign))[key],beforeForeign[key]);
"#;

#[test]
fn original_root_create_archive_receipts_preserve_native_stages_and_replay() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let input = root.join("packages/cloudflare/test/fixtures/typed-scenario-values.can");
    let source = std::fs::read_to_string(&input).unwrap();
    assert_eq!(
        canlang_compiler::source::sha256_hex(source.as_bytes()),
        "57100433b813b279e68aa3409864f5bfd7bb6487502a8b2fe55fcff24b4223b4"
    );
    let scratch = tempfile::tempdir().unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--format=json",
            "--native-scenario-receipts",
            "--catalog",
        ])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg("packages/cloudflare/test/fixtures/typed-scenario-values.can")
        .current_dir(root)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact: Value = serde_json::from_slice(&compiled.stdout).unwrap();
    let find = |name: &str| {
        artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["name"] == format!("TypedScenarioValues.{name}"))
            .unwrap()
    };
    // The eight already qualified sites retain their original plans; this
    // consumer executes only the newly admitted create/archive sites.
    for name in [
        "increment",
        "twice",
        "rollback",
        "echo",
        "boundNullable",
        "boundArray",
        "observedVersion",
        "finish",
        "born",
        "discard",
    ] {
        let plan = &find(name)["result"]["disclosure"];
        assert_eq!(plan["version"], 1, "{name}");
        assert_eq!(
            plan["source"]["sha256"],
            "57100433b813b279e68aa3409864f5bfd7bb6487502a8b2fe55fcff24b4223b4",
            "{name}: original declaring source"
        );
    }
    assert_eq!(find("born")["result"]["type"], "int");
    let born = &find("born")["result"]["disclosure"]["returns"];
    assert_eq!(born.as_array().unwrap().len(), 1);
    assert_eq!(born[0]["dependencies"].as_array().unwrap().len(), 2);
    for dependency in born[0]["dependencies"].as_array().unwrap() {
        assert_eq!(dependency["model"], "TypedScenarioValues.Counter");
        assert_eq!(dependency["field"], "count");
        assert_eq!(dependency["role"], "data");
        assert_eq!(dependency["type"], "int");
    }
    assert_eq!(find("discard")["result"]["type"], "void");
    let discarded = &find("discard")["result"]["disclosure"]["returns"];
    assert_eq!(discarded.as_array().unwrap().len(), 1);
    assert_eq!(discarded[0]["dependencies"], serde_json::json!([]));
    assert_eq!(find("readBound")["kind"], "read");
    assert!(find("readBound")["result"].get("disclosure").is_none());
    let artifact_path = scratch.path().join("original.json");
    std::fs::write(&artifact_path, compiled.stdout).unwrap();
    let compile_variant = |directory: &Path, text: &str| {
        let input = directory.join("typed-scenario-values.can");
        std::fs::write(&input, text).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_can"))
            .args([
                "compile",
                "--format=json",
                "--native-scenario-receipts",
                "--catalog",
            ])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        std::fs::write(directory.join("native.json"), &output.stdout).unwrap();
        serde_json::from_slice::<Value>(&output.stdout).unwrap()
    };

    // An actual late source guard must roll back the created row and its set.
    let rollback = source.replacen(
        "   create Counter {} as counter\n   set counter {count=counter.count+1}\n   return counter.count",
        "   create Counter {} as counter\n   set counter {count=counter.count+1}\n   require false\n   return counter.count",
        1,
    );
    assert_ne!(rollback, source);
    let rollback_source = scratch.path().join("late-guard-source");
    std::fs::create_dir(&rollback_source).unwrap();
    compile_variant(&rollback_source, &rollback);
    let rollback_path = scratch.path().join("rollback.json");
    std::fs::copy(rollback_source.join("native.json"), &rollback_path).unwrap();
    for (name, changed, operation) in [
        (
            "nonempty-create",
            source.replacen("create Counter {} as counter", "create Counter {count=1} as counter", 1),
            "born",
        ),
        (
            "conditional-create",
            source.replacen(
                "   create Counter {} as counter\n   set counter {count=counter.count+1}\n   return counter.count",
                "   if true\n    create Counter {} as counter\n    set counter {count=counter.count+1}\n    return counter.count\n   else\n    return 0",
                1,
            ),
            "born",
        ),
        (
            "hard-remove",
            source.replacen("crud Counter by=members fields=count", "crud Counter by=members fields=count delete=remove", 1),
            "discard",
        ),
    ] {
        assert_ne!(changed, source, "{name}: actual original source variant");
        let variant_source = scratch.path().join(name);
        std::fs::create_dir(&variant_source).unwrap();
        let unsupported = compile_variant(&variant_source, &changed);
        let op = unsupported["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|op| op["name"] == format!("TypedScenarioValues.{operation}"))
            .unwrap();
        assert!(op["result"].get("disclosure").is_none(), "{name}");
    }
    let runner = scratch.path().join("root-create-archive.mjs");
    std::fs::write(&runner, ROOT_CREATE_ARCHIVE_RUNNER).unwrap();
    let output = Command::new("node")
        .arg(&runner)
        .arg(root)
        .arg(&artifact_path)
        .arg(&rollback_path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

const ROOT_CREATE_ARCHIVE_RUNNER: &str = r#"
import assert from 'node:assert/strict';
import {resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const [root,artifactPath,rollbackPath]=process.argv.slice(2),base=dirname(fileURLToPath(import.meta.url));
const require=createRequire(resolve(root,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {loadArtifactFile}=await load('@canlang/cloudflare/runtime/artifact');
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker}=await load('@canlang/cloudflare/worker/assembly');
const {loadCanonicalDescriptors}=await load('@canlang/cloudflare/runtime/invoke');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const {readScenarioReceiptAssociation,projectScenarioReceipt}=await load('@canlang/state/invocation');
const {FIXED_NOW,createMemoryIdentityStore,seedMember,makeIdentity,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const input=loadArtifactFile(artifactPath),artifact=input.artifact;
const assemble=(input,name)=>assembleModules(input,{workDir:resolve(base,name),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href});
const asm=await assemble(input,'original-modules');
const generated=await importVerifiedAssemblyModule(asm,artifact.modules[0].path,artifact);
assert.deepEqual(generated.canApp().operations,artifact.operations,'verified original module publishes the actual checked descriptors');
const loaded=await loadCanonicalDescriptors(asm,artifact);
const {store:backing,probe}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
let commits=0;const store={...backing,commit:async batch=>{commits++;return backing.commit(batch);}};
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
const APP='TypedScenarioValues',MODEL=APP+'.Counter';let sequence=0;
const request=(name,inputs={})=>({operation:APP+'.'+name,operation_id:uuidv7(FIXED_NOW,++sequence),inputs});
const receiptFor=req=>store.readReceipt({app:APP,owner:identity.team.team_id,principal:identity.actor.user_id,operation:req.operation,operationId:req.operation_id});
const invoke=req=>invoker.invokeMutation(req,identity);
const committed=async req=>{const value=await invoke(req);assert.ok('result' in value,JSON.stringify(value));assert.equal(value.result.status,'committed');return value.result;};
const ref=row=>({id:row.id,version:String(row.version)});
const seed=await committed(request('Counter.create'));
assert.equal(seed.records.length,1);assert.equal(seed.records[0].data.count,'1');assert.equal(seed.records[0].version,1);
const bornRequest=request('born'),bornResult=await committed(bornRequest),bornReceipt=await receiptFor(bornRequest);
assert.equal(bornResult.result,'2');assert.equal(bornReceipt.outcome.result,'2');assert.equal(bornResult.records.length,1);
const bornRow=await store.load(MODEL,bornResult.records[0].id);
assert.equal(bornRow.data.count,'2');assert.equal(bornRow.version,1,'create then set finalizes one net insert');
assert.equal(bornReceipt.resolvedDefaults[`0:${MODEL}.count`],'1','the owning model supplies its literal omission default');
const bornAssociation=readScenarioReceiptAssociation(bornReceipt);assert.ok(bornAssociation);
assert.deepEqual(bornAssociation.plan,artifact.operations.find(op=>op.name===bornRequest.operation).result.disclosure);
assert.deepEqual(bornAssociation.observations.map(value=>value.row.data.count),['1','2'],'authored set operand precedes returned staged value');
assert.deepEqual(bornAssociation.observations.map(value=>value.dependencyId),bornAssociation.plan.returns[0].dependencies.map(value=>value.id));
for(const observation of bornAssociation.observations){assert.equal(observation.model,MODEL);assert.equal(observation.row.id,bornRow.id);assert.equal(observation.row.created,bornRow.created);}
assert.equal(bornAssociation.changed.length,1);assert.deepEqual(bornAssociation.changed[0].row,bornRow);
const bornHistory=await store.historyFor(MODEL,bornRow.id);
assert.equal(bornHistory.length,1,'created stages finalize one net creation history entry');
assert.equal(bornHistory[0].change,'create');assert.equal(bornHistory[0].before,null);assert.deepEqual(bornHistory[0].after,{count:'2'});
for(const entry of bornHistory){assert.equal(entry.version,1);assert.equal(entry.operation,bornRequest.operation);assert.equal(entry.operationId,bornRequest.operation_id);assert.equal(entry.actor,identity.actor.user_id);assert.equal(entry.at,FIXED_NOW);}
const discardRequest=request('discard',{counter:ref(seed.records[0])}),discardResult=await committed(discardRequest),discardReceipt=await receiptFor(discardRequest);
assert.equal(discardResult.result,null);assert.deepEqual(discardResult.records,[]);assert.equal(discardReceipt.outcome.result,null);
const discardedRow=await store.load(MODEL,seed.records[0].id);assert.equal(discardedRow.data.count,'1');assert.equal(discardedRow.version,2);assert.equal(discardedRow.archivedAt,FIXED_NOW);
const discardAssociation=readScenarioReceiptAssociation(discardReceipt);assert.ok(discardAssociation);
assert.deepEqual(discardAssociation.observations,[]);assert.equal(discardAssociation.resultType,'void');
assert.deepEqual(discardAssociation.plan.returns[0].dependencies,[]);assert.equal(discardAssociation.changed.length,1);assert.deepEqual(discardAssociation.changed[0].row,discardedRow);
assert.equal((await store.historyFor(MODEL,discardedRow.id)).length,2);
const saved=[{req:bornRequest,result:bornResult,receipt:bornReceipt},{req:discardRequest,result:discardResult,receipt:discardReceipt}];
const stable=async()=>({rows:await store.query({model:MODEL,authority:'owner',archived:'include'}),revision:await store.readRevision(),commits,
 receipts:await Promise.all(saved.map(value=>receiptFor(value.req))),history:await Promise.all([bornRow.id,discardedRow.id].map(id=>store.historyFor(MODEL,id))),
 outbox:probe.outboxAll(),schedules:await store.schedulesDue(Number.MAX_SAFE_INTEGER,100)});
let retainedCommits=0;
const readonlyStore={...store,commit:async()=>{retainedCommits++;throw new Error('retained commit tripwire');}};
const retained=buildInvoker(artifact,asm,readonlyStore,{memberships,now:()=>FIXED_NOW+16*60000});
const replay=async(value,expected=value.result)=>{
 const before=await stable();
 for(const transport of [invoker,retained]){const outcome=await transport.invokeMutation(value.req,identity);assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'replayed');assert.deepEqual(outcome.result.result,expected.result);assert.deepEqual(outcome.result.records,expected.records);}
 const dedicated=await retained.invokeRetainedMutation(value.req,identity);assert.ok('result' in dedicated,JSON.stringify(dedicated));assert.equal(dedicated.result.status,'replayed');assert.deepEqual(dedicated.result.result,expected.result);assert.deepEqual(dedicated.result.records,expected.records);
 assert.deepEqual(await stable(),before);assert.equal(retainedCommits,0);assert.deepEqual(await receiptFor(value.req),value.receipt);
};
for(const value of saved)await replay(value);
await committed(request('Counter.update',{record:ref(bornRow),count:'99'}));
assert.equal((await store.load(MODEL,bornRow.id)).data.count,'99');await replay(saved[0]);
assert.equal((await projectScenarioReceipt({receipt:bornReceipt,registry:loaded.registry,policy:loaded.policy,app:APP,identity,store,memberships})).result,'2');
// The actual source-derived late guard rejects after both provisional stages.
const failedInput=loadArtifactFile(rollbackPath),failedAsm=await assemble(failedInput,'late-guard-modules');
await importVerifiedAssemblyModule(failedAsm,failedInput.artifact.modules[0].path,failedInput.artifact);
const failedInvoker=buildInvoker(failedInput.artifact,failedAsm,store,{memberships,now:()=>FIXED_NOW});
const failing=request('born'),beforeFailure=await stable(),failed=await failedInvoker.invokeMutation(failing,identity);
assert.ok('error' in failed,JSON.stringify(failed));assert.equal(failed.error.code,'rule_failed');
const rejected=await receiptFor(failing);assert.ok(rejected,JSON.stringify(failed));assert.equal(rejected.outcome.status,'rejected');assert.equal(readScenarioReceiptAssociation(rejected),null);
const afterFailure=await stable();for(const key of ['rows','history','receipts','outbox','schedules'])assert.deepEqual(afterFailure[key],beforeFailure[key],key+' unchanged by late guard rollback');
assert.equal(afterFailure.revision,beforeFailure.revision+1);assert.equal(afterFailure.commits,beforeFailure.commits+1,'only rejected bookkeeping commits');
const beforeRejectedReplay=await stable(),again=await failedInvoker.invokeMutation(failing,identity);assert.ok('error' in again);assert.equal(again.error.code,'rule_failed');assert.deepEqual(await stable(),beforeRejectedReplay);assert.deepEqual(await receiptFor(failing),rejected);
const updatedBorn=await store.load(MODEL,bornRow.id);await committed(request('discard',{counter:ref(updatedBorn)}));
await replay(saved[0],{result:null,records:[]});await replay(saved[1]);
assert.equal(bornReceipt.outcome.result,'2','current archive withholds the result without rewriting its original receipt');
const beforeRevocation=await stable();await memberships.removeMembership(member.membership.membership_id);
for(const value of saved){const outcome=await retained.invokeRetainedMutation(value.req,identity);assert.ok('error' in outcome,JSON.stringify(outcome));assert.equal(outcome.error.code,'forbidden');assert.deepEqual(await projectScenarioReceipt({receipt:value.receipt,registry:loaded.registry,policy:loaded.policy,app:APP,identity,store,memberships}),{result:null,records:[]});}
assert.deepEqual(await stable(),beforeRevocation);assert.equal(retainedCommits,0);
"#;
