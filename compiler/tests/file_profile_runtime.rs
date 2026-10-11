//! Checked File profiles reach the public artifact and owning identity codec.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn checked_file_profiles_reach_public_metadata_and_values_codec() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("files.can");
    let mut source = "app Files\nGiven\n Asset {single:file,optional:file?,many:file[],optionalMany:file[]?,requiredMany:file[]!}\n policy Asset read=members\nWhen\n crud Asset by=members fields=single,optional,many,optionalMany,requiredMany\n".to_string();
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
export function create(){throw new Error('CRUD execution is outside this metadata/codec witness');}
export function set(){throw new Error('CRUD execution is outside this metadata/codec witness');}
export function deleteRecord(){throw new Error('CRUD execution is outside this metadata/codec witness');}
"#).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {decodeValue,encodeValue}=await import(pathToFileURL(resolve(process.argv[2],'packages/values/dist/src/index.js')));
const {loadArtifactDescriptors}=await import(pathToFileURL(resolve(process.argv[2],'packages/state/dist/src/invocation/registry.js')));
const {bindFileReferenceProfile,fileReferenceOccurrences}=await import(pathToFileURL(resolve(process.argv[2],'packages/state/dist/src/ports/file-reference-profile.js')));
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
 for(const kind of ['create','update']){
  const crud=artifact.operations.find(operation=>operation.name===`Files.Asset.${kind}`);assert(crud);
  assert.deepEqual(crud.inputs.fields.find(field=>field.name===name),{name,...expected,required:kind==='create'&&expected.required});
 }
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

const requiredField=model.fields.find(field=>field.name==='requiredMany');
assert.deepEqual(requiredField,{name:'requiredMany',field:{kind:'file'},valueType:'file[]!',required:true,array:{required:true},serverOnly:false});
for(const kind of ['create','update']){
 const operation=artifact.operations.find(operation=>operation.name===`Files.Asset.${kind}`);assert(operation);
 const field=operation.inputs.fields.find(field=>field.name==='requiredMany');assert(field);
 assert.deepEqual(field,{name:'requiredMany',field:{kind:'file'},valueType:'file[]!',required:kind==='create',array:{required:true}});
}
const loaded=loadArtifactDescriptors(artifact,{by:'members'});
const bound={artifactModels:new Map(artifact.models.map(model=>[model.name,model])),canonicalModels:loaded.models,
 ...(loaded.valueSchema===undefined?{}:{valueSchema:loaded.valueSchema}),...(loaded.valueTypes===undefined?{}:{valueTypes:loaded.valueTypes})};
for(const [name,type] of [['single','file'],['optional','file?'],['many','file[]'],['optionalMany','file[]?'],['requiredMany','file[]!']]){
 const profile=bindFileReferenceProfile(bound,'Files.Asset',name);
 assert.equal(profile.type,type);assert.equal(profile.fileBearing,true);
 const wire=profile.array?[{id:'asset'}]:{id:'asset'};
 assert.deepEqual(fileReferenceOccurrences(profile,wire),[{ref:'asset',path:profile.array?[0]:[]}]);
 const value=decodeValue(type,wire);assert.deepEqual(encodeValue(type,value),wire);
 assert.throws(()=>fileReferenceOccurrences(profile,profile.array?[{id:'asset',url:'https://invalid.test'}]:{id:'asset',url:'https://invalid.test'}));
 if(profile.nullable) assert.deepEqual(fileReferenceOccurrences(profile,null),[]);
 else assert.throws(()=>fileReferenceOccurrences(profile,null));
}
const requiredProfile=bindFileReferenceProfile(bound,'Files.Asset','requiredMany');
assert.deepEqual(fileReferenceOccurrences(requiredProfile,[]),[],'required presence does not imply nonempty');
assert.throws(()=>fileReferenceOccurrences(requiredProfile,undefined));
for(const select of [copy=>copy.models.find(model=>model.name==='Files.Asset').fields.find(field=>field.name==='requiredMany'),
 ...['create','update'].map(kind=>copy=>copy.operations.find(operation=>operation.name===`Files.Asset.${kind}`).inputs.fields.find(field=>field.name==='requiredMany'))]){
 for(const patch of [{valueType:'file[]'},{array:{required:false}},{valueType:'file[]?'}]){
  const copy=structuredClone(artifact);Object.assign(select(copy),patch);
  assert.throws(()=>loadArtifactDescriptors(copy,{by:'members'}));
 }
}
const skewedModels=structuredClone(loaded.models);skewedModels.find(model=>model.name==='Files.Asset').fields.requiredMany.array.required=false;
assert.throws(()=>bindFileReferenceProfile({...bound,canonicalModels:skewedModels},'Files.Asset','requiredMany'));
console.log('checked File metadata, native returns, released State profiles and owning identity-only codecs passed');
"#).unwrap();
    let executed = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}

#[test]
fn declared_file_event_exports_matching_canonical_and_private_input_descriptors() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = r#"app FileEvents
Given
 Entry {title:text}
 event Received {entry:Entry,single:file,optional:file?,many:file[],optionalMany:file[]?,note:text min=1 max=16 trim}
When
 scenario received on=Received
  do
   let identity=event.entry.id
   let single=event.single
   let optional=event.optional
   let many=event.many
   let optional_many=event.optionalMany
   let note=event.note
 scenario received_cohort on=Received each=Entry as child
  do let single=event.single
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
    let output = compile("file-events", source);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(artifact.get("diagnostics").is_none(), "{artifact}");
    let artifact_path = scratch.path().join("artifact.json");
    std::fs::write(&artifact_path, &output.stdout).unwrap();

    let refused = compile(
        "required-file-event",
        &source.replace("many:file[]", "many:file[]!"),
    );
    assert_eq!(refused.status.code(), Some(10));
    let refused: serde_json::Value = serde_json::from_slice(&refused.stdout).unwrap();
    assert!(refused.get("modules").is_none(), "{refused}");
    assert!(
        refused["diagnostics"]
            .as_array()
            .unwrap()
            .iter()
            .any(|diagnostic| diagnostic["code"] == "E6008"),
        "{refused}"
    );

    std::os::unix::fs::symlink(
        root.join("node_modules"),
        scratch.path().join("node_modules"),
    )
    .unwrap();
    let runner = scratch.path().join("event-descriptors.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(resolve(process.argv[2],'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {loadArtifactFile}=await load('@canlang/cloudflare/runtime/artifact');
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {normalizeSchema}=await load('@canlang/values');
const original=readFileSync(process.argv[3]);
const loaded=loadArtifactFile(process.argv[3]),artifact=loaded.artifact;
const asm=await assembleModules(loaded,{
 workDir:process.argv[4],stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const callable=artifact.callables.find(value=>value.id==='FileEvents.received');
assert(callable);assert.equal(callable.kind,'handler');
assert.equal(Object.hasOwn(callable,'inputStyle'),false);
assert.equal(artifact.operations.some(value=>value.name===callable.id),false);
const {appDefinition:definition,canApp}=await importVerifiedAssemblyModule(asm,callable.module,artifact);
let handler=canApp();for(const member of callable.member)handler=handler[member];
assert.equal(typeof handler,'function');
const operation=definition.operations[callable.id];
assert.equal(operation.handler,'FileEvents.received');
assert.equal(operation.event,'FileEvents.Received');
const event=definition.events[operation.event];assert(event);
assert.deepEqual(event.inputs,{
 entry:{type:'FileEvents.Entry'},
 single:{type:'file'},optional:{type:'file?'},many:{type:'file[]'},optionalMany:{type:'file[]?'},
 note:{type:'text',trim:true,min:1,max:16},
});
const normalized=normalizeSchema({operations:{[operation.event]:{inputs:event.inputs}}});
assert.deepEqual(Object.entries(normalized.operations[operation.event].inputs)
 .map(([name,field])=>({name,type:field.typeId,required:field.required})),[
 {name:'entry',type:'FileEvents.Entry',required:true},
 {name:'single',type:'file',required:true},
 {name:'optional',type:'file?',required:false},
 {name:'many',type:'file[]',required:false},
 {name:'optionalMany',type:'file[]?',required:false},
 {name:'note',type:'text',required:true},
]);
assert.equal(operation.invocation.name,callable.id);
assert.equal(operation.invocation.kind,'scenario');
assert.deepEqual(event.inputFields,[
 {name:'entry',field:{kind:'ref',model:'FileEvents.Entry',requireVersion:false},required:true},
 {name:'single',field:{kind:'file'},valueType:'file',required:true},
 {name:'optional',field:{kind:'file'},valueType:'file?',required:false,nullable:true},
 {name:'many',field:{kind:'file'},valueType:'file[]',required:false,array:{required:false}},
 {name:'optionalMany',field:{kind:'file'},valueType:'file[]?',required:false,nullable:true,array:{required:false}},
 {name:'note',field:{kind:'string'},valueType:'text',required:true},
]);
assert.deepEqual(Object.keys(event.inputs),event.inputFields.map(field=>field.name));
assert.deepEqual(event.inputFields,operation.invocation.inputs.fields);
const cohortCallable=artifact.callables.find(value=>value.id==='FileEvents.received_cohort');
assert(cohortCallable);assert.equal(cohortCallable.kind,'handler');
assert.equal(cohortCallable.module,callable.module);
assert.equal(artifact.operations.some(value=>value.name===cohortCallable.id),false);
let cohortHandler=canApp();for(const member of cohortCallable.member)cohortHandler=cohortHandler[member];
assert.equal(typeof cohortHandler,'function');
const cohortOperation=definition.operations[cohortCallable.id];
assert.equal(cohortOperation.handler,cohortCallable.id);
assert.equal(cohortOperation.event,operation.event);
assert.equal(cohortOperation.invocation.name,cohortCallable.id);
assert.equal(cohortOperation.invocation.kind,'scenario');
assert.deepEqual(definition.cohorts,{[cohortCallable.id]:{kind:'model',model:'FileEvents.Entry',bind:'child'}});
assert.deepEqual(cohortOperation.invocation.inputs.fields,[...event.inputFields,
 {name:'child',field:{kind:'ref',model:'FileEvents.Entry',requireVersion:false},required:true},
]);
assert.equal(event.inputFields.some(field=>field.name==='child'),false);
assert.deepEqual(readFileSync(process.argv[3]),original,'public artifact remains unchanged');
console.log('actual CLI declared File event exports canonical and private input descriptors; ingress authority is outside this check');
"#).unwrap();
    let executed = Command::new("node")
        .arg(runner)
        .arg(root)
        .arg(artifact_path)
        .arg(scratch.path().join("event-modules"))
        .output()
        .unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
