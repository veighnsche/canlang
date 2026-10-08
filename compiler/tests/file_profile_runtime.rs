//! Checked File profiles reach the public artifact and owning identity codec.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn checked_file_profiles_reach_public_metadata_and_values_codec() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("files.can");
    let mut source = "app Files\nGiven\n Asset {single:file,optional:file?,many:file[],optionalMany:file[]?}\n policy Asset read=members\nWhen\n".to_string();
    for (name, ty) in [
        ("single", "file"),
        ("optional", "file?"),
        ("many", "file[]"),
        ("optionalMany", "file[]?"),
    ] {
        source.push_str(&format!(
            " scenario {name}(value:{ty}) -> {ty} by=members\n  do return value\n"
        ));
    }
    source.push_str("Then\n");
    std::fs::write(&input, source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(input)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    std::fs::write(scratch.path().join("artifact.json"), output.stdout).unwrap();
    let stdlib = scratch.path().join("node_modules/@canlang/stdlib");
    std::fs::create_dir_all(&stdlib).unwrap();
    std::fs::write(
        stdlib.join("package.json"),
        r#"{"type":"module","exports":"./index.mjs"}"#,
    )
    .unwrap();
    std::fs::write(stdlib.join("index.mjs"), r#"
import assert from 'node:assert/strict';
export function hasRole(context,role){assert.equal(context,globalThis.context);return role==='members';}
function check(value){assert.equal(value,true);}
export {check as require};
"#).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {decodeValue,encodeValue}=await import(pathToFileURL(resolve(process.argv[2],'packages/values/dist/src/index.js')));
const base=dirname(new URL(import.meta.url).pathname);
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
for(const module of artifact.modules){const path=resolve(base,module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const entry=await import(pathToFileURL(resolve(base,artifact.modules[0].path)));
const registry=entry.canApp();
const model=artifact.models.find(model=>model.name==='Files.Asset');assert(model);
const context={operation:'Other.origin'};globalThis.context=context;
for(const [name,type] of [['single','file'],['optional','file?'],['many','file[]'],['optionalMany','file[]?']]){
 const nullable=type.endsWith('?'),array=type.includes('[]');
 const expected={field:{kind:'file'},valueType:type,required:!nullable&&!array,...(nullable?{nullable:true}:{}),...(array?{array:{required:false}}:{})};
 assert.deepEqual(model.fields.find(field=>field.name===name),{name,...expected,serverOnly:false});
 const operation=artifact.operations.find(operation=>operation.name===`Files.${name}`);assert(operation);
 assert.deepEqual(operation.inputs,{fields:[{name:'value',...expected}]});
 assert.deepEqual(operation.result,{type});
 const wire=array?[{id:'asset'}]:{id:'asset'};
 const value=decodeValue(type,wire);assert(Object.isFrozen(value));
 assert.deepEqual(array?value[0]:value,{kind:'file',id:'asset'});
 assert.deepEqual(encodeValue(type,value),wire);
 const descriptor=artifact.callables.find(item=>item.id===`Files.${name}`);assert(descriptor);
 let fn=registry;for(const part of descriptor.member)fn=fn[part];assert.equal(typeof fn,'function');
 assert.equal(await fn(context,{value}),value,'native identity is preserved by authored return');
 for(const enriched of [{id:'asset',url:'https://invalid.test'},{id:'asset',version:'1'},{kind:'file',id:'asset'},{id:''}]){
  assert.throws(()=>decodeValue(type,array?[enriched]:enriched));
 }
 if(nullable){assert.equal(decodeValue(type,null),null);assert.equal(encodeValue(type,null),null);assert.equal(await fn(context,{value:null}),null);}
 else assert.throws(()=>decodeValue(type,null));
}
console.log('checked File metadata, native returns and owning identity-only codecs passed');
"#).unwrap();
    let executed = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
