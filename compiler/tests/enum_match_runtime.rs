//! Checked exhaustive branches through the actual emitted callable ABI.
//! Direct host execution qualifies evaluation and effects, not transaction rollback.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn exhaustive_enum_match_preserves_once_scope_returns_and_effect_order() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = r#"app EnumExecution
Given
 Probe {state:enum(a,b)=a,seen:text=""}
 Other {state:enum(a,c)=a}
 policy Probe read=members
When
 crud Probe by=members fields=seen
 scenario caption(record:Probe,a:Other.state) read=true -> text by=members
  do
   match record.state
    case a
     let output="A"
     return output
    case b
     let output="B"
     return output
 scenario guarded(value:Probe.state?) read=true -> text by=members
  do
   if value!=null
    match value
     case a
      return "A"
     case b
      return "B"
   else
    return "None"
 scenario effect(record:Probe,later:bool) by=members
  do
   match record.state
    case a
     set record {seen="A"}
    case b
     set record {seen="B"}
   require later
Then
"#;
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
    let output = compile("exhaustive", source);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    std::fs::write(scratch.path().join("artifact.json"), output.stdout).unwrap();

    // These existing source inputs distinguish coverage, nominal subject
    // ownership, label collisions, nullable guards and unsupported patterns.
    let packet = root.join("implementation/capability-roadmap-20261008/enum-comparison");
    for (name, code, needle) in [
        ("duplicate-case", "E3001", "duplicate match case"),
        ("foreign-case", "E3001", "not in the subject enum"),
        ("nullable-subject", "E3001", "nonnullable finite enum"),
        ("wrong-return-type", "E3001", ""),
        ("branch-scope", "E2001", "branch_value"),
        ("unsupported-wildcard", "E1216", ""),
    ] {
        let input =
            std::fs::read_to_string(packet.join(format!("proposed-contract-inputs/{name}.can")))
                .unwrap();
        let output = compile(name, &input);
        assert_eq!(
            output.status.code(),
            Some(10),
            "{name}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let output: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(output.get("modules").is_none(), "{name}");
        assert!(
            output["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|finding| finding["code"] == code
                    && finding["message"].as_str().unwrap().contains(needle)),
            "{name}: {output}"
        );
    }
    let added = source.replacen("state:enum(a,b)", "state:enum(a,b,c)", 1);
    let output = compile("new_owner_case", &added);
    assert_eq!(output.status.code(), Some(10));
    let output: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(output.get("modules").is_none());
    assert!(
        output["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|finding| finding["code"] == "E3001"
                && finding["message"].as_str().unwrap().contains("missing c"))
    );

    let stdlib = scratch.path().join("node_modules/@canlang/stdlib");
    std::fs::create_dir_all(&stdlib).unwrap();
    std::fs::write(
        stdlib.join("package.json"),
        r#"{"type":"module","exports":"./index.mjs"}"#,
    )
    .unwrap();
    std::fs::write(stdlib.join("index.mjs"), r#"
import assert from 'node:assert/strict';
export function hasRole(context,role){assert.equal(context,globalThis.probe.context);return context.memberships.includes(role);}
export function require(condition){globalThis.probe.trace.push(['require',condition]);if(!condition)throw globalThis.probe.failure;}
export async function set(context,record,input){assert.equal(context,globalThis.probe.context);assert.equal(record,globalThis.probe.record);globalThis.probe.trace.push(['set',input.seen]);}
export async function create(){throw Error('unused create');}
export async function deleteRecord(){throw Error('unused delete');}
"#).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const base=dirname(new URL(import.meta.url).pathname),artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
for(const module of artifact.modules){const path=resolve(base,module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const entry=await import(pathToFileURL(resolve(base,artifact.modules[0].path))),registry=entry.canApp();
function callable(name){const descriptor=artifact.callables.find(item=>item.id===`EnumExecution.${name}`);assert(descriptor,name);let fn=registry;for(const part of descriptor.member)fn=fn[part];return fn;}
const context={memberships:['members']},trace=[],failure=Error('selected failure');globalThis.probe={context,trace,failure,record:null};
for(const state of ['a','b']){
 const record={get state(){assert.equal(this,record);trace.push(['subject',state]);return state;}};globalThis.probe.record=record;
 const label=state.toUpperCase();
 trace.length=0;assert.equal(await callable('caption')(context,{record,a:'c'}),label);assert.deepEqual(trace,[['require',true],['subject',state]]);
 trace.length=0;assert.equal(await callable('guarded')(context,{value:state}),label);assert.deepEqual(trace,[['require',true]]);
 trace.length=0;await callable('effect')(context,{record,later:true});assert.deepEqual(trace,[['require',true],['subject',state],['set',label],['require',true]]);
 trace.length=0;await assert.rejects(callable('effect')(context,{record,later:false}),error=>error===failure);assert.deepEqual(trace,[['require',true],['subject',state],['set',label],['require',false]]);
}
trace.length=0;assert.equal(await callable('guarded')(context,{value:null}),'None');assert.deepEqual(trace,[['require',true]]);
const record={get state(){trace.push(['subject','throw']);throw failure;}};globalThis.probe.record=record;
trace.length=0;await assert.rejects(callable('effect')(context,{record,later:true}),error=>error===failure);assert.deepEqual(trace,[['require',true],['subject','throw']]);
context.memberships=[];trace.length=0;await assert.rejects(callable('caption')(context,{record,a:'a'}),error=>error===failure);assert.deepEqual(trace,[['require',false]]);
console.log('exhaustive enum match: domain/coverage/null/branch scope/return, once and ordered failure passed');
"#).unwrap();
    let output = Command::new("node").arg(runner).output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
