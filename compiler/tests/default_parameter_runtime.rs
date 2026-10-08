//! Signature defaults through the actual CLI and unchanged emitted callable ABI.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn derive_defaults_execute_in_order_and_signature_scope_remains_checked() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(
        root.join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let run_cli = |command: &str, name: &str, source: &str| {
        let input = scratch.path().join(name);
        std::fs::write(&input, source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args([command, "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(&input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap()
    };
    let source = "app Defaults\nGiven\n derive chosen(seed:text=\"x\",copied:text=seed,finished:text=copied):text = finished\nWhen\nThen\n";
    let compiled = run_cli("compile", "defaults.can", source);
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    std::fs::write(scratch.path().join("artifact.json"), compiled.stdout).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const base=dirname(new URL(import.meta.url).pathname);
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
for(const module of artifact.modules){const path=resolve(base,module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const registries=new Map();
async function callable(id){
 const descriptor=artifact.callables.find(item=>item.id===id);assert(descriptor,id);
 if(!registries.has(descriptor.module)){const module=await import(pathToFileURL(resolve(base,descriptor.module)));registries.set(descriptor.module,module.canApp());}
 let fn=registries.get(descriptor.module);for(const part of descriptor.member)fn=fn[part];assert.equal(typeof fn,'function');return fn;
}
const chosen=await callable('Defaults.chosen');
const context={};
for(const [args,expected] of [
 [[], 'x'],
 [['supplied'], 'supplied'],
 [[undefined,'second'], 'second'],
 [['first','second'], 'second'],
 [['first','second','third'], 'third'],
 [[''], ''],
])assert.equal(await chosen(context,...args),expected);
console.log('actual derive defaults: omitted, supplied and left-to-right earlier references passed');
"#).unwrap();
    let executed = Command::new("node").arg(&runner).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );

    let refused = "app Refused\nGiven\n derive self(seed:text=seed):text=seed\n derive later(seed:text=copied,copied:text=\"x\"):text=seed\nWhen\n scenario body(seed:text=inside) read=true -> text by=public\n  do\n   let inside=\"body\"\n   return seed\nThen\n";
    let checked = run_cli("check", "refused.can", refused);
    assert_eq!(checked.status.code(), Some(10));
    let output = canlang_compiler::json::parse(&String::from_utf8_lossy(&checked.stdout)).unwrap();
    let diagnostics = output.get("diagnostics").unwrap().as_arr().unwrap();
    assert_eq!(diagnostics.len(), 3, "{diagnostics:?}");
    for (diagnostic, expected) in diagnostics.iter().zip(["seed", "copied", "inside"]) {
        assert_eq!(diagnostic.get("code").unwrap().as_str(), Some("E2001"));
        assert_eq!(
            diagnostic.get("message").unwrap().as_str(),
            Some(format!("unresolved name '{expected}'").as_str())
        );
        let primary = diagnostic.get("primary").unwrap();
        let start = primary.get("start").unwrap().as_i64().unwrap() as usize;
        let end = primary.get("end").unwrap().as_i64().unwrap() as usize;
        assert_eq!(&refused[start..end], expected);
    }
}

#[test]
fn scenario_native_defaults_resolve_once_in_parameter_order() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let compile = |name: &str, source: &str| {
        let input = scratch.path().join(name);
        std::fs::write(&input, source).unwrap();
        Command::new(env!("CARGO_BIN_EXE_can"))
            .args(["compile", "--format=json", "--catalog"])
            .arg(root.join("packages/values/dist/catalog.json"))
            .arg(input)
            .env_remove("CAN_CATALOG")
            .output()
            .unwrap()
    };
    let source = r#"app ScenarioDefaults
Given
 derive decorate(value:text):text = format("{value}!",{value=value})
When
 scenario chosen(seed:text="x",copied:text=seed,finished:text=copied) -> text by=public
  do
   require true
   return finished
 scenario decorated(seed:text="x",copied:text=decorate(seed),finished:text=decorate(copied)) -> text by=public
  do
   require true
   return finished
 scenario number(seed:int=7,copied:int=seed) -> int by=public
  do return copied
 scenario flag(seed:bool=true,copied:bool=seed) -> bool by=public
  do return copied
 scenario nullable(seed:text?="x",copied:text?=seed,finished:text?=copied) -> text? by=public
  do return finished
 scenario array(seed:text[]=["x"],copied:text[]=seed,finished:text[]=copied) -> text[] by=public
  do return finished
 scenario nullableArray(seed:text[]?=["x"],copied:text[]?=seed,finished:text[]?=copied) -> text[]? by=public
  do return finished
 scenario untouched(seed:text?,items:text[]) -> text? by=public
  do return seed
Then
"#;
    let compiled = compile("scenario.can", source);
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    std::fs::write(scratch.path().join("artifact.json"), compiled.stdout).unwrap();
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
function check(value){globalThis.probe.trace.push(['check',value]);if(!value)throw Error('authored requirement');}
export {check as require};
export async function format(template,values){assert.equal(arguments.length,2);assert.equal(template,'{value}!');assert.deepEqual(Object.keys(values),['value']);globalThis.probe.trace.push(['format',values.value]);await Promise.resolve();if(values.value==='fail')throw Error('default failure');return `${values.value}!`;}
"#).unwrap();
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
const entry=await import(pathToFileURL(resolve(base,artifact.modules[0].path))),registry=entry.canApp();
const context={memberships:['public']},trace=[];globalThis.probe={context,trace};
function callable(name){const descriptor=artifact.callables.find(item=>item.id===`ScenarioDefaults.${name}`);assert(descriptor,name);assert.equal(descriptor.kind,'operation');assert.equal(descriptor.inputStyle,'parameters');let fn=registry;for(const part of descriptor.member)fn=fn[part];assert.equal(typeof fn,'function');return fn;}
const require=createRequire(resolve(root,'package.json'));
const {loadArtifactDescriptors}=await import(pathToFileURL(require.resolve('@canlang/state/invocation/registry')));
const {validateCallInputs}=await import(pathToFileURL(require.resolve('@canlang/state/invocation/admission')));
const loaded=loadArtifactDescriptors(artifact,{by:operation=>entry.appDefinition.operations[operation.name].by});
for(const name of ['chosen','decorated','number','flag','nullable','array','nullableArray']){
 const id=`ScenarioDefaults.${name}`,descriptor=artifact.operations.find(operation=>operation.name===id);assert.equal(descriptor.kind,'scenario');
 const def=loaded.registry.get(id);assert.equal(def.generated,true);assert.equal(def.by,'public');
 const admitted=validateCallInputs(def,{});assert.deepEqual(admitted.normalized,{});assert.deepEqual(admitted.refs,[]);
 for(const field of descriptor.inputs.fields)assert.equal(field.required,false);
 for(const field of descriptor.inputs.fields){
  const canonical=entry.appDefinition.operations[id].inputs[field.name];
  if(field.name==='seed'){assert.equal(Object.hasOwn(field,'computedDefault'),false);assert.equal(Object.hasOwn(canonical,'computedDefault'),false);}
  else{assert.equal(field.computedDefault,true);assert.equal(canonical.computedDefault,true);assert.equal(Object.hasOwn(field,'default'),false,'computed presence contains no fabricated wire value');assert.equal(Object.hasOwn(canonical,'default'),false);}
 }

}
for(const [input,expected]of [[{},'x'],[{seed:'supplied'},'supplied'],[{copied:'second'},'second'],[{seed:'first',copied:'second',finished:'third'},'third'],[{seed:''},'']]){
 trace.length=0;assert.equal(await callable('chosen')(context,input),expected);assert.deepEqual(trace,[['check',true],['check',true]]);
}
const decorated=callable('decorated');
for(const [input,expected,formats]of [[{},'x!!',['x','x!']],[{seed:'supplied'},'supplied!!',['supplied','supplied!']],[{copied:'second'},'second!',['second']],[{finished:'override'},'override',['x']],[{seed:'',copied:'',finished:''},'',[]]]){
 trace.length=0;assert.equal(await decorated(context,input),expected);assert.deepEqual(trace,[['check',true],...formats.map(value=>['format',value]),['check',true]]);
}
const reads=[],input={};
for(const [name,value]of [['seed','supplied'],['copied',undefined],['finished',undefined]])Object.defineProperty(input,name,{get(){reads.push(name);return value;}});
trace.length=0;assert.equal(await decorated(context,input),'supplied!!');assert.deepEqual(reads,['seed','copied','finished']);assert.deepEqual(trace,[['check',true],['format','supplied'],['format','supplied!'],['check',true]]);
trace.length=0;await assert.rejects(decorated(context,{seed:'fail'}),{message:'default failure'});assert.deepEqual(trace,[['check',true],['format','fail']]);
assert.equal(await callable('number')(context,{seed:0n}),0n);assert.equal(await callable('flag')(context,{seed:false}),false);
for(const [name,cases]of [
 ['nullable',[[{},'x'],[{seed:'supplied'},'supplied'],[{seed:null},null],[{copied:null},null],[{finished:null},null]]],
 ['array',[[{},['x']],[{seed:['supplied']},['supplied']],[{seed:[]},[]],[{copied:[]},[]],[{finished:[]},[]]]],
 ['nullableArray',[[{},['x']],[{seed:['supplied']},['supplied']],[{seed:null},null],[{seed:[]},[]],[{copied:null},null],[{finished:[]},[]]]],
]){
 const def=loaded.registry.get(`ScenarioDefaults.${name}`),fn=callable(name);
 for(const [wire,expected]of cases){const admitted=validateCallInputs(def,wire);assert.equal(Object.hasOwn(admitted.normalized,'copied'),Object.hasOwn(wire,'copied'));assert.equal(Object.hasOwn(admitted.normalized,'finished'),Object.hasOwn(wire,'finished'));assert.deepEqual(await fn(context,admitted.normalized),expected);}
}
const untouched=artifact.operations.find(operation=>operation.name==='ScenarioDefaults.untouched');
for(const field of untouched.inputs.fields){assert.equal(Object.hasOwn(field,'computedDefault'),false);assert.equal(Object.hasOwn(entry.appDefinition.operations[untouched.name].inputs[field.name],'computedDefault'),false);}
const admittedUntouched=validateCallInputs(loaded.registry.get(untouched.name),{});assert.deepEqual(admittedUntouched.normalized,{items:[]});
console.log('native scenario scalar, nullable and array defaults: real State omission, selected async calls, once/order/laziness and first failure passed');
"#).unwrap();
    let executed = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );

    for (name, declarations, params, code, message) in [
        (
            "nullableElement",
            "Given\n",
            "seed:text?[]=[null],copied:text?[]=seed",
            "E1213",
            "type permits one array suffix followed by one nullable suffix",
        ),
        (
            "ref",
            "Given\n Entry {title:text}\n policy Entry read=public\n",
            "seed:Entry,copied:Entry=seed",
            "E6008",
            "cannot lower parameter default: computed parameter defaults have no §13 lowering",
        ),
    ] {
        let source = format!(
            "app Unsupported\n{declarations}When\n scenario selected({params}) by=public\n  do require true\nThen\n"
        );
        let rejected = compile(&format!("{name}.can"), &source);
        assert_eq!(
            rejected.status.code(),
            Some(10),
            "{}",
            String::from_utf8_lossy(&rejected.stdout)
        );
        let output =
            canlang_compiler::json::parse(&String::from_utf8_lossy(&rejected.stdout)).unwrap();
        assert!(output.get("modules").is_none());
        let diagnostics = output.get("diagnostics").unwrap().as_arr().unwrap();
        assert!(
            diagnostics
                .iter()
                .any(
                    |diagnostic| diagnostic.get("code").unwrap().as_str() == Some(code)
                        && diagnostic.get("message").unwrap().as_str() == Some(message)
                ),
            "{name}: {output:?}"
        );
    }
}
