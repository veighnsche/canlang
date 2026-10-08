//! Genuine declared-event cohort artifacts and emitted child ABI/order.
//! The bounded effect host does not qualify frozen membership or atomic commits.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn declared_event_cohorts_publish_checked_child_refs_and_execute_native_bindings() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/cohort_trigger.can");
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
    let output = compile("cohorts", source);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(artifact.get("diagnostics").is_none(), "{artifact}");
    assert!(
        artifact["requires"]
            .as_array()
            .unwrap()
            .iter()
            .any(|requirement| {
                requirement["capability"] == "state.cohorts" && requirement["min_version"] == 1
            })
    );
    if let Some(path) = std::env::var_os("CAN_COHORT_TRIGGER_ARTIFACT") {
        std::fs::write(path, &output.stdout).unwrap();
    }
    std::fs::write(scratch.path().join("artifact.json"), &output.stdout).unwrap();
    for (name, refused, code) in [
        (
            "unknown-model",
            source.replace("each=Entry as entry", "each=Missing as entry"),
            "E4055",
        ),
        (
            "context-shadow",
            source.replace("each=Entry as entry", "each=Entry as event"),
            "E2012",
        ),
        (
            "flat-input-collision",
            source.replace(
                "event Sweep {marker:text}",
                "event Sweep {marker:text,entry:text}",
            ),
            "E6008",
        ),
        (
            "nullable-anchor",
            source.replace("container:Container,marker", "container:Container?,marker"),
            "E4055",
        ),
        (
            "periodic-trigger",
            source
                .replace("on=Sweep each", "on=every(1h) each")
                .replace("event.marker", "\"periodic\""),
            "E6008",
        ),
    ] {
        let output = compile(name, &refused);
        assert_eq!(output.status.code(), Some(10), "{name}");
        let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(artifact.get("modules").is_none(), "{name}: {artifact}");
        assert!(
            artifact["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|finding| finding["code"] == code),
            "{name}: {artifact}"
        );
    }
    let stdlib = scratch.path().join("node_modules/@canlang/stdlib");
    std::fs::create_dir_all(&stdlib).unwrap();
    std::fs::write(
        stdlib.join("package.json"),
        r#"{"type":"module","exports":"./index.mjs"}"#,
    )
    .unwrap();
    let native = serde_json::to_string(
        &root
            .join("packages/stdlib/dist/src/index.js")
            .display()
            .to_string(),
    )
    .unwrap();
    std::fs::write(
        stdlib.join("index.mjs"),
        format!(
            r#"
export * from {native};
export async function set(context,record,changes){{
 const probe=globalThis.cohortProbe;
 if(context!==probe.context || record!==probe.child)throw Error('wrong child scope');
 probe.calls.push({{record,changes}});await Promise.resolve();
 if(probe.failure)throw probe.failure;
}}
"#
        ),
    )
    .unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const base=dirname(new URL(import.meta.url).pathname),artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
for(const module of artifact.modules){const path=resolve(base,module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const refs=artifact.callables.filter(ref=>ref.id.startsWith('CohortJourney.'));
const functions={};let definition;
for(const name of ['sweep','scoped','unbound']){
 const id=`CohortJourney.${name}`,ref=refs.find(ref=>ref.id===id);assert(ref);assert.equal(ref.kind,'handler');
 assert.equal(Object.hasOwn(ref,'inputStyle'),false);assert.equal(artifact.operations.some(op=>op.name===id),false);
 const entry=await import(pathToFileURL(resolve(base,ref.module))),registry=entry.canApp();definition=entry.appDefinition;
 let fn=registry;for(const part of ref.member)fn=fn[part];functions[name]=fn;
}
assert.deepEqual(definition.cohorts,{
 'CohortJourney.sweep':{kind:'model',model:'CohortJourney.Entry',bind:'entry'},
 'CohortJourney.scoped':{kind:'anchored-collection',model:'CohortJourney.Entry',parent:'event.container',bind:'entry'},
 'CohortJourney.unbound':{kind:'model',model:'CohortJourney.Entry',bind:null},
});
for(const name of ['sweep','scoped','unbound']){
 const operation=definition.operations[`CohortJourney.${name}`],profile=operation.invocation;
 assert.equal(operation.event,name==='scoped'?'CohortJourney.Scoped':'CohortJourney.Sweep');
 assert.equal(profile.name,operation.handler);assert.equal(profile.kind,'scenario');
 const fields=profile.inputs.fields,child=fields.at(-1);
 assert.deepEqual(child,{name:name==='unbound'?'$cohort':'entry',field:{kind:'ref',model:'CohortJourney.Entry',requireVersion:false},required:true});
 assert.deepEqual(fields.map(field=>field.name),name==='scoped'?['container','marker','entry']:['marker',name==='unbound'?'$cohort':'entry']);
 assert.equal(Object.hasOwn(operation,'by'),false);
}
const container={kind:'ref',model:'CohortJourney.Container',id:'parent',version:1n};
let countReads=0;
const child={kind:'ref',model:'CohortJourney.Entry',id:'entry',version:1n,parent:container,applicable:true,consent:true,get count(){countReads++;return 3n;}};
const context={},probe={context,child,calls:[]};globalThis.cohortProbe=probe;
const inputReads=[],inputs={};
Object.defineProperty(inputs,'event',{get(){inputReads.push('event');return {marker:'whole'};}});
Object.defineProperty(inputs,'entry',{get(){inputReads.push('entry');return child;}});
await functions.sweep(context,inputs);
assert.deepEqual(inputReads,['event','entry']);assert.equal(countReads,1);
assert.deepEqual(probe.calls,[{record:child,changes:{count:4n,label:'whole'}}]);
probe.calls=[];countReads=0;
await functions.scoped(context,{event:{container,marker:'scoped'},entry:child});
assert.equal(countReads,1);assert.deepEqual(probe.calls,[{record:child,changes:{count:4n,label:'scoped'}}]);
probe.calls=[];
await functions.unbound(context,{event:{marker:'none'}});assert.deepEqual(probe.calls,[]);
child.applicable=false;
await assert.rejects(functions.sweep(context,{event:{marker:'deny'},entry:child}),error=>error.constructor.name==='AuthoredRequireFailure');
assert.deepEqual(probe.calls,[]);child.applicable=true;child.consent=false;
await assert.rejects(functions.sweep(context,{event:{marker:'later'},entry:child}),error=>error.constructor.name==='AuthoredRequireFailure');
assert.deepEqual(probe.calls,[{record:child,changes:{count:4n,label:'later'}}]);child.consent=true;probe.calls=[];
const failure=Error('set failed');probe.failure=failure;
await assert.rejects(functions.sweep(context,{event:{marker:'failure'},entry:child}),error=>error===failure);
assert.equal(probe.calls.length,1);delete probe.failure;probe.calls=[];
await assert.rejects(functions.scoped(context,{event:{container:{...container,id:'other'},marker:'wrong-parent'},entry:child}),error=>error.constructor.name==='AuthoredRequireFailure');
assert.deepEqual(probe.calls,[]);
console.log('genuine declared-event cohort descriptors, private child refs, native ABI/getters/effects/guards/failure passed');
"#).unwrap();
    let executed = Command::new("node").arg(runner).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
