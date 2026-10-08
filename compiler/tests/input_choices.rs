//! Finite operation metadata and nonexecuting choice annotations through native callables.
//! The bounded records host checks awaited child queries and admission order.
//! Complete State and CountryRegion/CanApprove serving workflows qualify separately.
#![cfg(unix)]

use serde_json::{Value, json};
use std::{path::Path, process::Command};

#[test]
fn owning_input_choices_publish_checked_bindings_without_executing_annotations() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/input_choices.can");
    let compile = |name: &str, source: &str| {
        let input = scratch.path().join(format!("{name}.can"));
        std::fs::write(&input, source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap()
    };
    let output = compile("choices", source);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact: Value = serde_json::from_slice(&output.stdout).unwrap();
    if let Some(path) = std::env::var_os("CAN_INPUT_CHOICES_ARTIFACT") {
        std::fs::write(path, &output.stdout).unwrap();
    }
    let operations = artifact["operations"].as_array().unwrap();
    let operation = |name: &str| {
        operations
            .iter()
            .find(|operation| operation["name"] == format!("InputChoices.{name}"))
            .unwrap()
    };
    let input = |operation: &Value, name: &str| {
        operation["inputs"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|input| input["name"] == name)
            .unwrap()
            .clone()
    };
    assert_eq!(
        operation("region_choices")["result"]["type"],
        "InputChoices.Region[]"
    );
    assert_eq!(
        operation("reviewer_choices")["result"]["type"],
        "InputChoices.Employee[]"
    );
    assert_eq!(
        input(operation("save"), "region")["choices"],
        json!({"version":1,"readOperation":"InputChoices.region_choices","arguments":{"country":{"input":"country","path":[]}},"value":{"kind":"record"},"labels":["name"]})
    );
    for (name, dependency, path) in [
        ("assign", "submission", vec!["parent"]),
        ("submit", "document", vec![]),
    ] {
        let assignee = input(operation(name), "assignee");
        assert_eq!(
            assignee["choices"],
            json!({"version":1,"readOperation":"InputChoices.reviewer_choices","arguments":{"document":{"input":dependency,"path":path}},"value":{"kind":"field","field":"user"},"labels":["name","role","home"]})
        );
        assert_eq!(assignee["required"], false);
        assert_eq!(assignee["nullable"], true);
        assert_eq!(assignee["description"], "Chosen reviewer");
        assert_eq!(assignee["default"], json!({"kind":"literal","value":null}));
    }
    let note = input(operation("save"), "note");
    assert_eq!(note["default"], json!({"kind":"literal","value":"Kept"}));
    assert_eq!(note["description"], "Address note");
    assert_eq!(
        artifact["requires"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|requirement| requirement["capability"] == "interfaces.input-choices")
            .collect::<Vec<_>>(),
        [&json!({"capability":"interfaces.input-choices","min_version":1})]
    );

    std::fs::write(scratch.path().join("artifact.json"), &output.stdout).unwrap();
    // The installed facade lacks `records`; this narrow host refuses every
    // lookup while preserving its actual admission/reference helpers and UI.
    let packages = scratch.path().join("node_modules/@canlang");
    let stdlib = packages.join("stdlib");
    std::fs::create_dir_all(&stdlib).unwrap();
    std::fs::write(
        stdlib.join("package.json"),
        r#"{"type":"module","exports":"./index.mjs"}"#,
    )
    .unwrap();
    std::fs::write(
        stdlib.join("index.mjs"),
        format!(
            "export {{ require, hasRole, same }} from {};\nexport async function records(context,model,options){{const probe=globalThis.choiceLookup;if(!probe)throw Error('choice lookup executed');probe.calls.push({{context,model,options}});await Promise.resolve();if(probe.error)throw probe.error;return probe.rows;}}\n",
            serde_json::to_string(&root.join("packages/stdlib/dist/src/index.js").display().to_string()).unwrap()
        ),
    )
    .unwrap();
    std::os::unix::fs::symlink(root.join("node_modules/@canlang/ui"), packages.join("ui")).unwrap();
    for module in artifact["modules"].as_array().unwrap() {
        let path = scratch.path().join(module["path"].as_str().unwrap());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, module["js"].as_str().unwrap()).unwrap();
    }
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(
        &runner,
        r#"import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
const artifact = JSON.parse(readFileSync(process.argv[3],'utf8'));
const entry = await import(pathToFileURL(process.argv[2]));
const registry = entry.canApp(), context = {memberships:['members']};
function callable(name){
 const descriptor = artifact.callables.find(callable=>callable.id===`InputChoices.${name}`);
 assert(descriptor,name);let fn=registry;for(const part of descriptor.member)fn=fn[part];return fn;
}
for(const operation of artifact.operations){
 for(const field of operation.inputs.fields){
  if(field.choices)assert.deepEqual(entry.appDefinition.operations[operation.name].inputs[field.name].choices,field.choices);
 }
}
let reads = 0;
const submission = {get parent(){reads++;throw Error('choice annotation executed');}};
const document = {get site(){reads++;throw Error('choice read executed');}};
const assignee = {kind:'user',id:'reviewer'}, region = {id:'region'};
assert.equal(await callable('assign')(context,{submission,assignee}),assignee);
assert.equal(await callable('assign')(context,{submission}),null);
assert.equal(await callable('submit')(context,{document,assignee}),assignee);
assert.equal(await callable('save')(context,{country:document,region}),region);
assert.equal(reads,0,'importing and invoking the owning operations never evaluates choice annotations');
const country={id:'country',get Region(){throw Error('child collection must be queried');}};
const probe={rows:[region],calls:[]};globalThis.choiceLookup=probe;
let inputReads=0;
assert.deepEqual(await callable('region_choices')(context,{get country(){inputReads++;return country;}}),[region]);
assert.equal(inputReads,1);assert.equal(probe.calls.length,1);
assert.equal(probe.calls[0].context,context);assert.equal(probe.calls[0].model,'InputChoices.Region');
assert.deepEqual(probe.calls[0].options,{parent:country});
const failure=Error('child query failed');probe.error=failure;probe.calls=[];
await assert.rejects(callable('region_choices')(context,{country}),error=>error===failure);
assert.equal(probe.calls.length,1);probe.calls=[];
await assert.rejects(callable('region_choices')({memberships:[]},{country}));
assert.equal(probe.calls.length,0,'admission rejects before the child query');
delete globalThis.choiceLookup;
const assign = entry.appDefinition.operations['InputChoices.assign'].inputs.assignee;
assert.equal(assign.default,null);assert.equal(assign.label.source,'Reviewer');
const note = entry.appDefinition.operations['InputChoices.save'].inputs.note;
assert.equal(note.default,'Kept');assert.equal(note.label.source,'Note');
"#,
    )
    .unwrap();
    let executed = Command::new("node")
        .arg(runner)
        .arg(
            scratch
                .path()
                .join(artifact["modules"][0]["path"].as_str().unwrap()),
        )
        .arg(scratch.path().join("artifact.json"))
        .output()
        .unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );

    let replace = |from: &str, to: &str| {
        assert!(
            source.contains(from),
            "missing negative-case anchor: {from}"
        );
        source.replacen(from, to, 1)
    };
    let cycle = replace(
        "scenario save(country:Country,",
        "scenario save(country:Country choices={read=country_choices(region=region),labels=[\"name\"]},",
    )
    .replace(
        "When\n",
        "When\n scenario country_choices(region:Region) read=true -> Country[] by=members\n  do return Country as candidate where candidate.active\n",
    );
    for (name, source, needle) in [
        (
            "mutation-read",
            replace(
                "scenario reviewer_choices(document:Document) read=true",
                "scenario reviewer_choices(document:Document)",
            ),
            "mutation operation",
        ),
        (
            "missing-mapping",
            replace(
                "read=region_choices(country=country)",
                "read=region_choices()",
            ),
            "missing required read argument",
        ),
        (
            "bad-member",
            replace(
                "read=region_choices(country=country)",
                "read=region_choices(country=country.missing)",
            ),
            "member path",
        ),
        (
            "value-type",
            replace("value=\"user\"", "value=\"home\""),
            "incompatible with the assisted input",
        ),
        (
            "self-input",
            replace(
                "read=region_choices(country=country)",
                "read=region_choices(country=region)",
            ),
            "depend on itself",
        ),
        ("cycle", cycle, "form a cycle"),
        (
            "ambient-input",
            replace(
                "read=region_choices(country=country)",
                "read=region_choices(country=actor)",
            ),
            "rooted in this operation's inputs",
        ),
        (
            "helper-input",
            replace(
                "read=region_choices(country=country)",
                "read=region_choices(country=lower(\"x\"))",
            ),
            "executable expressions are unsupported",
        ),
        (
            "literal-input",
            replace(
                "read=region_choices(country=country)",
                "read=region_choices(country=\"x\")",
            ),
            "executable expressions are unsupported",
        ),
    ] {
        let output = compile(name, &source);
        assert_eq!(
            output.status.code(),
            Some(10),
            "{name}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let rejected: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(rejected.get("modules").is_none(), "{name}");
        assert!(
            rejected["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"] == "E3001"
                    && diagnostic["message"].as_str().unwrap().contains(needle)),
            "{name}: {rejected}"
        );
    }
}
