//! Checked supplied-array concatenation through the production CLI and Values helper.
#![cfg(unix)]

use std::{path::Path, process::Command};

const SOURCE: &str = r#"app ArrayConcat
Given
 Flag { mode:enum(a,b) }
 policy Flag read=members
 contract Inputs { left:int[],right:int[],tail:int[] }
 derive identity(values:int[]):int[] = values
 derive ints(row:Inputs):int[] = row.left+row.right
 derive awaited(row:Inputs):int[] = identity(row.left)+identity(row.right)
 derive chained(row:Inputs):int[] = row.left+row.right+row.tail
 derive texts(left:text[],right:text[]):text[] = left+right
 derive flags(left:Flag.mode[],right:Flag.mode[]):Flag.mode[] = left+right
 derive references(left:Flag[],right:Flag[]):Flag[] = left+right
When
Then
"#;

fn compile(source: &str, path: &Path) -> std::process::Output {
    std::fs::write(path, source).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(path)
        .current_dir(root)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap()
}

#[test]
fn actual_emitted_arrays_preserve_order_identity_immutability_and_first_failure() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("array-concat.can");
    let output = compile(SOURCE, &source);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, &output.stdout).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(
        &runner,
        r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(resolve(process.argv[2],'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const artifact=JSON.parse(readFileSync(process.argv[3]));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],
 stdlibUrl:pathToFileURL(require.resolve('@canlang/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const entry=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
const registry=entry.canApp(),context={};
function callable(name){
 const descriptor=artifact.callables.find(value=>value.id===`ArrayConcat.${name}`);
 assert.ok(descriptor,`original callable ${name}`);
 let fn=registry;for(const key of descriptor.member)fn=fn[key];assert.equal(typeof fn,'function');return fn;
}
const left=Object.freeze([3n,1n,3n]),right=Object.freeze([2n,1n]),tail=Object.freeze([4n]);
for(const name of ['ints','awaited','chained']){
 const trace=[],row={};
 for(const [key,value]of [['left',left],['right',right],['tail',tail]])Object.defineProperty(row,key,{get(){trace.push(key);return value;}});
 const output=await callable(name)(context,row);
 assert.deepEqual(output,name==='chained'?[3n,1n,3n,2n,1n,4n]:[3n,1n,3n,2n,1n]);
 assert.deepEqual(trace,name==='chained'?['left','right','tail']:['left','right']);
 assert.equal(Object.isFrozen(output),true);assert.notEqual(output,left);assert.notEqual(output,right);
 assert.deepEqual(left,[3n,1n,3n]);assert.deepEqual(right,[2n,1n]);
}
assert.deepEqual(await callable('ints')(context,{left:[],right:[]}),[]);
assert.deepEqual(await callable('texts')(context,['é','😀','é'],['x']),['é','😀','é','x']);
assert.deepEqual(await callable('flags')(context,['b','a'],['b']),['b','a','b']);
const first=Object.freeze({id:'first'}),second=Object.freeze({id:'second'});
const references=await callable('references')(context,Object.freeze([first,second]),Object.freeze([first]));
assert.equal(references.length,3);assert.equal(references[0],first);assert.equal(references[1],second);assert.equal(references[2],first);
assert.equal(Object.isFrozen(references),true,'copying reference values grants no native authority');
// First failure has its original identity and skips later authored operands.
for(const name of ['ints','awaited','chained']){
 for(const failed of ['left','right']){
  const failure=new Error(`${name}:${failed}`),trace=[],row={};
  for(const [key,value]of [['left',left],['right',right],['tail',tail]])Object.defineProperty(row,key,{get(){trace.push(key);if(key===failed)throw failure;return value;}});
  await assert.rejects(callable(name)(context,row),error=>error===failure);
  assert.deepEqual(trace,failed==='left'?['left']:['left','right']);
 }
}
const trace=[],invalid={left:0};Object.defineProperty(invalid,'right',{get(){trace.push('right');return right;}});
await assert.rejects(callable('ints')(context,invalid),error=>error.code==='invalid-construction'&&error.message.includes('concat first'));
assert.deepEqual(trace,['right'],'both supplied operands precede helper validation');
for(const failed of ['left','right']){
 const trace=[],row={};
 for(const [key,value]of [['left',left],['right',right],['tail',tail]])Object.defineProperty(row,key,{get(){trace.push(key);return key===failed?0:value;}});
 await assert.rejects(callable('chained')(context,row),error=>error.code==='invalid-construction');
 assert.deepEqual(trace,['left','right'],'first concat failure skips later chained operands');
}
console.log('compiled supplied-array concat: exact domains, frozen copies, order/once/first failure passed');
"#,
    )
    .unwrap();
    let output = Command::new("node")
        .arg(runner)
        .arg(root)
        .arg(artifact)
        .arg(source)
        .arg(scratch.path().join("modules"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn mixed_unknown_anonymous_and_nullable_arrays_never_publish_concat() {
    let scratch = tempfile::tempdir().unwrap();
    for (name, source) in [
        (
            "mixed",
            "app Refusal\nGiven\n derive mixed(left:int[],right:text[]):int[] = left+right\nWhen\nThen\n",
        ),
        (
            "unknown",
            "app Refusal\nGiven\n derive empty():int[] = []+[]\nWhen\nThen\n",
        ),
        (
            "foreign-enum-owner",
            "app Refusal\nGiven\n Left {mode:enum(a,b)}\n Right {mode:enum(a,b)}\n policy Left read=members\n policy Right read=members\n derive foreign(left:Left.mode[],right:Right.mode[]):Left.mode[] = left+right\nWhen\nThen\n",
        ),
        (
            "anonymous",
            "app Refusal\nGiven\nWhen\n scenario anonymous() by=members\n  do\n   let joined=[{name=\"left\"}]+[{name=\"right\"}]\nThen\n",
        ),
        (
            "nullable",
            "app Refusal\nGiven\n derive nullable(left:int[]?,right:int[]):int[] = left+right\nWhen\nThen\n",
        ),
        (
            "subtract",
            "app Refusal\nGiven\n derive subtract(left:int[],right:int[]):int[] = left-right\nWhen\nThen\n",
        ),
    ] {
        let output = compile(source, &scratch.path().join(format!("{name}.can")));
        assert_eq!(
            output.status.code(),
            Some(10),
            "{name}: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(artifact.get("modules").is_none(), "{name}: {artifact}");
        assert!(
            !artifact["diagnostics"].as_array().unwrap().is_empty(),
            "{name}: {artifact}"
        );
    }
}
