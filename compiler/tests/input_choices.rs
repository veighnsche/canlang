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
    assert_eq!(operation("save")["result"]["type"], "InputChoices.Region");
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
    // The installed facade lacks `records` and `set`. Keep the actual pure
    // helpers and mutation producer; only finite query observations are hosted.
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
            "export {{ ValueError, require, hasRole, same, any, makeUserRef, makeRecordRef }} from {};\nexport {{set}} from '@canlang/cloudflare/runtime/stdlib';\nexport async function records(context,model,options){{const probe=globalThis.choiceLookup;if(!probe)throw Error('choice lookup executed');probe.calls.push({{context,model,options}});probe.trace?.push('query-start');await Promise.resolve();if(probe.error)throw probe.error;const selected=[];for(const row of probe.rows){{if(options.where===undefined||await options.where(row))selected.push(row);}}probe.trace?.push('query-complete');return selected;}}\n",
            serde_json::to_string(&root.join("packages/stdlib/dist/src/index.js").display().to_string()).unwrap()
        ),
    )
    .unwrap();
    std::os::unix::fs::symlink(root.join("node_modules/@canlang/ui"), packages.join("ui")).unwrap();
    std::os::unix::fs::symlink(
        root.join("node_modules/@canlang/cloudflare"),
        packages.join("cloudflare"),
    )
    .unwrap();
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
import {makeRecordRef,makeUserRef} from '@canlang/stdlib';
const artifact = JSON.parse(readFileSync(process.argv[3],'utf8'));
const entry = await import(pathToFileURL(process.argv[2]));
const registry = entry.canApp(), context = {memberships:['members']};
assert.deepEqual(registry.operations.find(operation=>operation.name==='InputChoices.save').result,{type:'InputChoices.Region'});
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
const assignee = makeUserRef('reviewer');
assert.equal(await callable('assign')(context,{submission,assignee:null}),null);
assert.equal(await callable('assign')(context,{submission}),null);
assert.equal(await callable('submit')(context,{document,assignee:null}),null);
assert.equal(await callable('submit')(context,{document}),null);
assert.equal(reads,0,'imports and null/default final guards never evaluate choice annotations');
const country={...makeRecordRef('InputChoices.Country','country'),get Region(){throw Error('child collection must be queried');}};
let parentReads=0;
const region={...makeRecordRef('InputChoices.Region','region'),get parent(){parentReads++;return country;}};
assert.equal(await callable('save')(context,{country,region}),region);
assert.equal(parentReads,1,'the actual save guard reads its parent once without executing the annotation');
await assert.rejects(callable('save')(context,{country:makeRecordRef('InputChoices.Country','other'),region}),{message:'forbidden'});
assert.equal(parentReads,2);

const home=makeRecordRef('InputChoices.Site','home'),otherHome=makeRecordRef('InputChoices.Site','other-home');
const otherUser=makeUserRef('other-user');
function candidate(trace,name,user,site){
 return {get user(){trace.push(`${name}.user`);return user;},
  get home(){trace.push(`${name}.home`);if(site instanceof Error)throw site;return site;}};
}
for(const name of ['assign','submit']){
 const trace=[];
 const doc={get site(){trace.push('document.site');return home;}};
 const sub={get parent(){trace.push('submission.parent');return doc;}};
 const rows=[candidate(trace,'unrelated',otherUser,Error('unrelated home must not be read')),
  candidate(trace,'wrong',assignee,otherHome),candidate(trace,'right',assignee,home),
  {get user(){throw Error('any must stop at the first match');}}];
 const finalProbe={rows,calls:[],trace};globalThis.choiceLookup=finalProbe;
 const args=name==='assign'?{submission:sub,assignee}:{document:doc,assignee};
 assert.equal(await callable(name)(context,args),assignee);
 const navigation=name==='assign'?['submission.parent','document.site']:['document.site'];
 assert.deepEqual(trace,['query-start','query-complete','unrelated.user','wrong.user','wrong.home',
  ...navigation,'right.user','right.home',...navigation],`${name}: real final guard reads after the awaited query and short-circuits`);
 assert.equal(finalProbe.calls.length,1);assert.equal(finalProbe.calls[0].context,context);
 assert.equal(finalProbe.calls[0].model,'InputChoices.Employee');assert.deepEqual(finalProbe.calls[0].options,{});
 trace.length=0;finalProbe.calls=[];
 await assert.rejects(callable(name)({memberships:[]},args),{message:'forbidden'});
 assert.deepEqual(trace,[]);assert.equal(finalProbe.calls.length,0,'admission precedes final guard reads');
}
const missingParent=Error('original submission parent is unavailable');
const missingTrace=[];
const missingSubmission={get parent(){missingTrace.push('submission.parent');throw missingParent;}};
const missingProbe={rows:[],calls:[],trace:missingTrace};globalThis.choiceLookup=missingProbe;
for(const rows of [[],[candidate(missingTrace,'unrelated',otherUser,Error('unrelated home must not be read'))]]){
 missingProbe.rows=rows;missingProbe.calls=[];missingTrace.length=0;
 await assert.rejects(callable('assign')(context,{submission:missingSubmission,assignee}),{message:'forbidden'});
 assert.deepEqual(missingTrace,['query-start','query-complete',...(rows.length===0?[]:['unrelated.user'])]);
 assert.equal(missingProbe.calls.length,1,'a nonnull final guard queries before testing candidates');
}
missingProbe.rows=[candidate(missingTrace,'matching',assignee,home)];missingProbe.calls=[];missingTrace.length=0;
await assert.rejects(callable('assign')(context,{submission:missingSubmission,assignee}),error=>error===missingParent);
assert.deepEqual(missingTrace,['query-start','query-complete','matching.user','matching.home','submission.parent']);
assert.equal(missingProbe.calls.length,1);
delete globalThis.choiceLookup;

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

const choiceTrace=[];
const choiceDocument={get site(){choiceTrace.push('document.site');return home;}};
const first={get home(){choiceTrace.push('first.home');return home;}};
const excluded={get home(){choiceTrace.push('excluded.home');return otherHome;}};
const last={get home(){choiceTrace.push('last.home');return home;}};
const choiceProbe={rows:[first,excluded,last],calls:[],trace:choiceTrace};globalThis.choiceLookup=choiceProbe;
let documentReads=0;
assert.deepEqual(await callable('reviewer_choices')(context,{get document(){documentReads++;return choiceDocument;}}),[first,last]);
assert.equal(documentReads,1);assert.equal(choiceProbe.calls.length,1);
assert.equal(choiceProbe.calls[0].context,context);assert.equal(choiceProbe.calls[0].model,'InputChoices.Employee');
assert.deepEqual(Object.keys(choiceProbe.calls[0].options),['where']);
assert.equal(typeof choiceProbe.calls[0].options.where,'function');
assert.deepEqual(choiceTrace,['query-start','first.home','document.site','excluded.home','document.site',
 'last.home','document.site','query-complete'],'the original read predicate executes once per candidate in domain order');
choiceProbe.error=failure;choiceProbe.calls=[];choiceTrace.length=0;
await assert.rejects(callable('reviewer_choices')(context,{document:choiceDocument}),error=>error===failure);
assert.equal(choiceProbe.calls.length,1);assert.deepEqual(choiceTrace,['query-start'],'query failure precedes predicate reads');
choiceProbe.calls=[];choiceTrace.length=0;
await assert.rejects(callable('reviewer_choices')({memberships:[]},{document:choiceDocument}),{message:'forbidden'});
assert.equal(choiceProbe.calls.length,0);assert.deepEqual(choiceTrace,[],'admission rejects before the query or predicate');
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
