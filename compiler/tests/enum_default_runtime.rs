//! Finite enum computed defaults through genuine CLI metadata, installed State
//! omission admission and native emitted callables; no receipt/replay coverage.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn finite_enum_defaults_preserve_closed_cases_omission_and_once_order() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = r#"app EnumDefaults
Given
 Entry {state:enum(a,b)=a}
When
 scenario selected(seed:Entry.state,copied:Entry.state=at([seed],0)??seed) -> text by=members
  do
   require true
   if copied==a
    return "A"
   else
    return "B"
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
    let compiled = compile("finite-default", source);
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    std::fs::write(scratch.path().join("artifact.json"), compiled.stdout).unwrap();
    // Source controls retain the owning enum and nonnull default contract.
    for (name, refused) in [
        (
            "null-default",
            source.replace("=at([seed],0)??seed", "=null"),
        ),
        (
            "foreign-domain",
            source
                .replace("Given\n", "Given\n Other {state:enum(c,d)=c}\n")
                .replace("seed:Entry.state", "seed:Other.state")
                .replace("=at([seed],0)??seed", "=seed"),
        ),
    ] {
        let output = compile(name, &refused);
        assert_eq!(output.status.code(), Some(10), "{name}");
        let output: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(output.get("modules").is_none(), "{name}");
        assert!(
            output["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|finding| finding["code"] == "E3011"),
            "{name}: {output}"
        );
    }
    let stdlib = scratch.path().join("node_modules/@canlang/stdlib");
    std::fs::create_dir_all(&stdlib).unwrap();
    std::fs::write(
        stdlib.join("package.json"),
        r#"{"type":"module","exports":"./index.mjs"}"#,
    )
    .unwrap();
    let native_stdlib = serde_json::to_string(
        &root
            .join("packages/stdlib/dist/src/index.js")
            .display()
            .to_string(),
    )
    .unwrap();
    // Wrappers only observe calls; installed owning helpers supply behavior.
    std::fs::write(stdlib.join("index.mjs"), format!(r#"
import assert from 'node:assert/strict';
import {{at as nativeAt,hasRole as nativeHasRole,require as nativeRequire}} from {native_stdlib};
export function at(array,index){{
 globalThis.enumDefaultProbe.trace.push(['default',array[0]]);return nativeAt(array,index);
}}
export function hasRole(context,role){{
 assert.equal(context,globalThis.enumDefaultProbe.context);const allowed=nativeHasRole(context,role);
 globalThis.enumDefaultProbe.trace.push(['admission',role,allowed]);return allowed;
}}
function check(condition,code){{
 globalThis.enumDefaultProbe.trace.push(['check',condition]);return nativeRequire(condition,code);
}}
export {{check as require}};
"#)).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const base=dirname(new URL(import.meta.url).pathname),root=process.argv[2];
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
for(const module of artifact.modules){const path=resolve(base,module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const id='EnumDefaults.selected',reference=artifact.callables.find(item=>item.id===id);assert(reference);
const entry=await import(pathToFileURL(resolve(base,reference.module))),registry=entry.canApp();
let selected=registry;for(const part of reference.member)selected=selected[part];assert.equal(typeof selected,'function');
const descriptor=artifact.operations.find(operation=>operation.name===id);assert.equal(descriptor.kind,'scenario');
assert.equal(reference.inputStyle,'parameters');
assert.deepEqual(descriptor.inputs.fields.map(field=>[field.name,field.field,field.required]),[
 ['seed',{kind:'enum',values:['a','b']},true],['copied',{kind:'enum',values:['a','b']},false],
]);
const seed=descriptor.inputs.fields[0],copied=descriptor.inputs.fields[1];
assert.equal(Object.hasOwn(seed,'computedDefault'),false);assert.equal(copied.computedDefault,true);assert.equal(Object.hasOwn(copied,'default'),false);
assert.deepEqual(entry.appDefinition.operations[id].inputs.seed,{type:'enum',cases:['a','b']});
assert.deepEqual(entry.appDefinition.operations[id].inputs.copied,{type:'enum',cases:['a','b'],computedDefault:true});
const require=createRequire(resolve(root,'package.json'));
const {loadArtifactDescriptors}=await import(pathToFileURL(require.resolve('@canlang/state/invocation/registry')));
const {validateCallInputs}=await import(pathToFileURL(require.resolve('@canlang/state/invocation/admission')));
const loaded=loadArtifactDescriptors(artifact,{by:operation=>entry.appDefinition.operations[operation.name].by}),def=loaded.registry.get(id);
assert.equal(def.generated,true);assert.equal(def.by,'members');
const context={memberships:['members']},trace=[];globalThis.enumDefaultProbe={context,trace};
for(const [wire,want,defaults]of [[{seed:'a'},'A',['a']],[{seed:'b'},'B',['b']],[{seed:'a',copied:'b'},'B',[]],[{seed:'b',copied:'a'},'A',[]]]){
 const admitted=validateCallInputs(def,wire);assert.deepEqual(admitted.refs,[]);assert.deepEqual(admitted.normalized,wire);
 assert.equal(Object.hasOwn(admitted.normalized,'copied'),Object.hasOwn(wire,'copied'),'State must preserve default omission');
 trace.length=0;assert.equal(await selected(context,admitted.normalized),want);
 assert.deepEqual(trace,[['admission','members',true],['check',true],...defaults.map(value=>['default',value]),['check',true]]);
}
const reads=[],input={};
for(const [name,value]of [['seed','b'],['copied',undefined]])Object.defineProperty(input,name,{get(){reads.push(name);return value;}});
trace.length=0;assert.equal(await selected(context,input),'B');assert.deepEqual(reads,['seed','copied']);
assert.deepEqual(trace,[['admission','members',true],['check',true],['default','b'],['check',true]]);
const denied={memberships:[]};globalThis.enumDefaultProbe.context=denied;trace.length=0;
await assert.rejects(selected(denied,{seed:'a'}),error=>error.constructor.name==='AuthoredRequireFailure');
assert.deepEqual(trace,[['admission','members',false],['check',false]],'denied admission must suppress default and body');
// State's generated scalar validator intentionally owns presence/closed shape,
// not enum membership or scalar nullability. Those source contracts are above.
for(const input of [{},{seed:'a',unexpected:'b'}])assert.throws(()=>validateCallInputs(def,input));
console.log('finite enum defaults: closed cases, installed State omission, native once/order/override and admission-before-default passed');
"#).unwrap();
    let executed = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
