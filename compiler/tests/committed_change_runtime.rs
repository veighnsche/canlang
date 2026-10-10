//! Checked committed-model publication and direct emitted declaration ABI.
//! The bounded effect host does not qualify State/Work source activation,
//! original mutation fences, frozen cohort membership, or atomic commits.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn committed_change_inventory_is_complete_canonical_and_executes_private_scalar_inputs() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = include_str!("fixtures/committed_change.can");
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
    let output = compile("committed", source);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(artifact.get("diagnostics").is_none(), "{artifact}");
    let mut descriptors = artifact["committedChanges"].as_array().unwrap().clone();
    descriptors.sort_by(|left, right| left["source"].as_str().cmp(&right["source"].as_str()));
    assert_eq!(
        descriptors,
        vec![
            serde_json::json!({"source":"CommittedJourney.Local.created","model":"CommittedJourney.Local","change":"create","handlers":["CommittedJourney.created"]}),
            serde_json::json!({"source":"CommittedJourney.Local.deleted","model":"CommittedJourney.Local","change":"delete","handlers":["CommittedJourney.deleted"]}),
            serde_json::json!({"source":"CommittedJourney.Local.updated","model":"CommittedJourney.Local","change":"update","handlers":["CommittedJourney.updated_first","CommittedJourney.updated_cohort","CommittedJourney.updated_last"]}),
            serde_json::json!({"source":"Stored.Record.updated","model":"Stored.Record","change":"update","handlers":["CommittedJourney.imported"]}),
        ]
    );
    std::fs::write(scratch.path().join("artifact.json"), &output.stdout).unwrap();
    for (name, refused, code) in [
        (
            "unknown-change",
            source.replace("on=Imported.updated", "on=Imported.renamed"),
            "E3010",
        ),
        (
            "id-collision",
            source
                .replace("each=Entry as entry", "each=Entry as id")
                .replace("set entry", "set id"),
            "E6008",
        ),
        (
            "version-collision",
            source
                .replace("each=Entry as entry", "each=Entry as version")
                .replace("set entry", "set version"),
            "E6008",
        ),
    ] {
        let output = compile(name, &refused);
        assert_eq!(output.status.code(), Some(10), "{name}");
        let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(artifact.get("modules").is_none(), "{name}: {artifact}");
        assert!(
            artifact.get("committedChanges").is_none(),
            "{name}: {artifact}"
        );
        assert!(
            artifact["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|finding| finding["code"] == code),
            "{name}: {artifact}"
        );
    }
    let legacy = compile(
        "declared-only",
        "app DeclaredOnly\nGiven\n event Notice {message:text}\nWhen\n scenario notice on=Notice\n  do\n   let message=event.message\nThen\n",
    );
    assert!(
        legacy.status.success(),
        "{}",
        String::from_utf8_lossy(&legacy.stdout)
    );
    let legacy: serde_json::Value = serde_json::from_slice(&legacy.stdout).unwrap();
    assert!(legacy.get("committedChanges").is_none(), "{legacy}");
    std::fs::write(
        scratch.path().join("legacy.json"),
        serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();

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
 const probe=globalThis.committedProbe;
 if(context!==probe.context || record!==probe.child)throw Error('wrong cohort child scope');
 probe.calls.push({{record,changes}});await Promise.resolve();
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
const base=dirname(new URL(import.meta.url).pathname);
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
for(const module of artifact.modules){const path=resolve(base,module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const functions={};let definition;
for(const name of ['created','updated_first','updated_cohort','updated_last','deleted','imported','declared']){
 const id=`CommittedJourney.${name}`,ref=artifact.callables.find(ref=>ref.id===id);assert(ref);assert.equal(ref.kind,'handler');
 assert.equal(Object.hasOwn(ref,'inputStyle'),false);assert.equal(artifact.operations.some(op=>op.name===id),false);
 const module=await import(pathToFileURL(resolve(base,ref.module)));definition=module.appDefinition;
 let fn=module.canApp();for(const part of ref.member)fn=fn[part];assert.equal(typeof fn,'function');functions[name]=fn;
}
assert.deepEqual(definition.committedChanges,artifact.committedChanges);
assert.deepEqual(definition.cohorts,{'CommittedJourney.updated_cohort':{kind:'model',model:'CommittedJourney.Entry',bind:'entry'}});
const expectedInputs=[
 {name:'id',field:{kind:'string'},valueType:'text',required:true},
 {name:'version',field:{kind:'integer'},valueType:'int',required:true},
];
for(const descriptor of artifact.committedChanges){
 assert.deepEqual(Object.keys(descriptor).sort(),['change','handlers','model','source']);
 for(const id of descriptor.handlers){
  const operation=definition.operations[id];assert(operation);assert.equal(operation.handler,id);assert.equal(operation.event,descriptor.source);
  const profile=operation.invocation;assert(profile);assert.equal(profile.name,id);assert.equal(profile.kind,'scenario');
  const expected=id==='CommittedJourney.updated_cohort'?[...expectedInputs,{name:'entry',field:{kind:'ref',model:'CommittedJourney.Entry',requireVersion:false},required:true}]:expectedInputs;
  assert.deepEqual(profile.inputs.fields,expected);assert.equal(Object.hasOwn(operation,'by'),false);
 }
}
assert.equal(definition.operations['CommittedJourney.declared'].event,'CommittedJourney.Notice');
assert.deepEqual(definition.operations['CommittedJourney.declared'].invocation.inputs.fields,[{name:'message',field:{kind:'string'},valueType:'text',required:true}]);
assert.equal(Object.hasOwn(definition.events,'CommittedJourney.Local.deleted'),false);
assert.equal(Object.hasOwn(definition.events,'Stored.Record.updated'),false);
const context=new Proxy({}, {get(_target,key){throw Error(`unexpected context/row lookup ${String(key)}`);}});
for(const name of ['created','updated_first','updated_last','deleted','imported']){
 const reads=[],event={get id(){reads.push('id');return name==='deleted'?'removed-row':`${name}-row`;},get version(){reads.push('version');return 7n;}};
 await functions[name](context,{event});assert.deepEqual(reads,['id','version']);
}
const child={kind:'ref',model:'CommittedJourney.Entry',id:'cohort-child',version:1n};
const probe={context,child,calls:[]};globalThis.committedProbe=probe;
const inputReads=[],eventReads=[],inputs={};
Object.defineProperty(inputs,'event',{get(){inputReads.push('event');return {get id(){eventReads.push('id');return 'changed-parent';},get version(){eventReads.push('version');return 9n;}};}});
Object.defineProperty(inputs,'entry',{get(){inputReads.push('entry');return child;}});
await functions.updated_cohort(context,inputs);
assert.deepEqual(inputReads,['event','entry']);assert.deepEqual(eventReads,['id','version']);
assert.deepEqual(probe.calls,[{record:child,changes:{label:'changed-parent',count:9n}}]);
const legacy=JSON.parse(readFileSync(resolve(base,'legacy.json'),'utf8'));
for(const module of legacy.modules){const path=resolve(base,'legacy',module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const legacyRef=legacy.callables.find(ref=>ref.id==='DeclaredOnly.notice');assert(legacyRef);
const legacyEntry=await import(pathToFileURL(resolve(base,'legacy',legacyRef.module)));
assert.equal(Object.hasOwn(legacyEntry.appDefinition,'committedChanges'),false);
console.log('checked committed-model complete inventory, canonical imports, private scalar id/version, declaration callable ABI, and cohort binding passed');
"#).unwrap();
    let executed = Command::new("node").arg(runner).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
