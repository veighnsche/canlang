//! Original SEND inputs are declaration facts, never native invocation authority.
use std::path::{Path, PathBuf};
use std::process::Command;

const SOURCE: &str = r#"app SendInputs
use std {TextGenerationV1 as LLM} from=deployment.llm
use std {TextRequest}
Given
 Item {enabled:bool}
 contract Bounds {values:int[] min=1 max=4}
 contract Payload {attachment:file,copies:file[],note:text?}
 policy Item read=members
When
 scenario dispatch(enabled:bool,item:Item?,values:Bounds.values,empties:int[]=[],upload:file,payload:Payload,request:TextRequest,prompt:text,counted:int=abs(-1)) by=members
  require item!=null
  do
   let initial=counted
   send LLM.cancel {source=prompt,revision=1} when=enabled and item.enabled and count(values)>0 and count(empties)>=0 and upload==payload.attachment and count(payload.copies)>0 and request.source==prompt and initial>0 as receipt
Then
"#;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .into()
}

#[test]
fn actual_cli_rule_and_installed_state_keep_original_order_schema_and_file_census() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("send-input-declarations.can");
    std::fs::write(&source, SOURCE).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--native-scenario-receipts",
            "--format=json",
            "--catalog",
        ])
        .arg(root().join("packages/values/dist/catalog.json"))
        .arg(&source)
        .current_dir(root())
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact = scratch.path().join("artifact.json");
    std::fs::write(&artifact, output.stdout).unwrap();
    let runner = scratch.path().join("send-inputs.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(resolve(process.argv[2],'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const artifact=JSON.parse(readFileSync(process.argv[3]));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const assembly=await assembleModules({artifact,sourcePath:process.argv[4]},{workDir:process.argv[5],
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const module=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
const definition=module.appDefinition, registry=module.canApp();
const guards=definition.operations['SendInputs.dispatch'].sendGuards;
assert.equal(guards.length,1);
const guard=guards[0], profile=guard.inputDeclaration;
assert.equal(profile.kind,'inputs');
const names=['enabled','item','values','empties','upload','payload','request','prompt','initial'];
const types=['bool','SendInputs.Item?','int[]','int[]','file','SendInputs.Payload','TextRequest','text','int'];
assert.deepEqual(guard.inputs,names.map((name,index)=>({name,type:types[index]})));
assert.deepEqual(profile.canonical.map(input=>input.name),names);
assert.deepEqual(profile.artifact.map(input=>input.name),names);
assert.deepEqual(profile.artifact.map(input=>input.valueType),types);
assert.deepEqual(profile.canonical[1],{name:'item',kind:'ref',model:'SendInputs.Item',versioned:true,required:true,nullable:true});
assert.deepEqual(profile.artifact[1].field,{kind:'ref',model:'SendInputs.Item',requireVersion:true});
assert.deepEqual(profile.canonical[2],{name:'values',kind:'integer',valueType:'int[]',required:true,min:1,max:4});
assert.deepEqual(profile.artifact[2].array,{required:false});
assert.deepEqual(profile.artifact[3].array,{required:false});
assert.deepEqual(profile.artifact[4].field,{kind:'file'});
assert.deepEqual(profile.artifact[5].field,{kind:'nominal',name:'SendInputs.Payload'});
assert.deepEqual(profile.artifact[6].field,{kind:'nominal',name:'TextRequest'});
for(const input of [...profile.canonical,...profile.artifact]) {
 assert.equal(input.required,true,'every frozen lexical slot is present even when null or empty');
 assert.equal(Object.hasOwn(input,'default'),false,'frozen inputs never re-evaluate a declaration default');
 assert.equal(Object.hasOwn(input,'computedDefault'),false);
}
const callable=artifact.callables.find(callable=>callable.id===guard.rule);
assert.equal(callable.kind,'rule');
assert.deepEqual(callable.member,['sendWhen',guard.rule]);
assert.equal(callable.module,artifact.modules[0].path);
assert.equal(module[callable.export],guard.rule);
assert.equal(Object.hasOwn(callable,'inputStyle'),false);
assert.equal(guard.source.path,process.argv[4]);
assert.equal(guard.source.sha256,createHash('sha256').update(readFileSync(process.argv[4])).digest('hex'));
const source=readFileSync(process.argv[4],'utf8');
assert.equal(source.slice(guard.node.start,guard.node.end),
 'enabled and item.enabled and count(values)>0 and count(empties)>=0 and upload==payload.attachment and count(payload.copies)>0 and request.source==prompt and initial>0');
// The actual module/source join qualifies these facts; State binding below is
// typed correspondence only, with no admission, issuer, current-row or grant.
const {artifactToDescriptorSet}=await load('@canlang/state/invocation/registry');
const {bindOpaqueFileDeclarations,resolveOpaqueFileProjection}=await load('@canlang/state/storage');
const {normalizeValueTypes,validateValue}=await load('@canlang/values');
const canonical=artifactToDescriptorSet(artifact).set;
const origin={path:guard.source.path,sha256:guard.source.sha256,module:callable.module};
const inventory={owner:'schema-test',snapshotId:'schema-test',digest:'schema-test'};
const originalContracts=JSON.parse(JSON.stringify(definition.contracts,(_key,value)=>typeof value==='bigint'?value.toString():value));
const valueDefaults=Object.entries(originalContracts).flatMap(([contract,definition])=>Object.entries(definition.fields)
 .filter(([,field])=>Object.hasOwn(field,'default')).map(([field,definition])=>({contract,field,value:definition.default})));
const set={id:'schema-test',inventory,snapshot:{...inventory,installedRevision:0,installedAt:0},
 sources:artifact.sources.map(({path,sha256})=>({path,sha256})),canonicalModels:canonical.models,artifactModels:artifact.models,
 valueTypes:artifact.valueTypes,originalContracts,valueDefaults,
 declarations:[{id:guard.rule,source:{kind:'send-guard',rule:guard.rule,source:origin,owner:guard.owner,
 node:guard.node,binding:guard.binding,target:guard.target,inputs:guard.inputs},profile}]};
const bind=value=>bindOpaqueFileDeclarations([value],candidate=>{
 assert.deepEqual(candidate.canonicalModels,canonical.models);
 assert.deepEqual(candidate.artifactModels,artifact.models);
}).get('schema-test');
const bound=bind(set), projection={kind:'inputs',declarationId:guard.rule,path:['inputs']};
const request={source:'source',revision:'1',profile:'profile',policy_revision:'policy',
 messages:[{role:'user',content:'message',attachments:[{id:'message-file'}]}],
 max_input_tokens:'100',max_output_tokens:'10',max_duration:'1000'};
const wire={enabled:true,item:{id:'item',version:'1'},values:['1'],empties:[],upload:{id:'upload-file'},
 payload:{attachment:{id:'payload-file'},copies:[{id:'copy-file'}],note:null},request,prompt:'source',initial:'1'};
assert.deepEqual(resolveOpaqueFileProjection(bound,projection,wire),[
 {path:['upload'],ref:'upload-file'},
 {path:['payload','attachment'],ref:'payload-file'},
 {path:['payload','copies',0],ref:'copy-file'},
 {path:['request','messages',0,'attachments',0],ref:'message-file'},
]);
assert.deepEqual(resolveOpaqueFileProjection(bound,projection,{...wire,item:null}),
 resolveOpaqueFileProjection(bound,projection,wire));
assert.throws(()=>resolveOpaqueFileProjection(bound,projection,{...wire,values:[]}));
assert.throws(()=>resolveOpaqueFileProjection(bound,projection,{...wire,values:['1','2','3','4','5']}));
for(const change of [
 value=>value.declarations[0].profile.canonical[0].name='foreign',
 value=>value.declarations[0].profile.artifact[0].valueType='int',
 value=>value.declarations[0].profile.artifact.reverse(),
 value=>value.declarations[0].source.source.sha256='0'.repeat(64),
 value=>value.declarations[0].profile.artifact[1].nullable=false,
 value=>value.declarations[0].profile.artifact[2].min=2,
 value=>value.valueTypes.contracts=value.valueTypes.contracts.filter(item=>item.name!=='TextMessage'),
 value=>value.declarations[0].profile.artifact[6].field.name='UnreleasedRequest',
 value=>{value.declarations[0].profile.canonical[1].required=false;value.declarations[0].profile.artifact[1].required=false;},
 value=>{value.declarations[0].profile.canonical[2].required=false;value.declarations[0].profile.artifact[2].required=false;},
 value=>value.declarations[0].source.inputs.reverse(),
 value=>value.declarations[0].source.inputs.pop(),
]) {
 const changed=structuredClone(set);change(changed);assert.throws(()=>bind(changed));
}
for(const missing of ['item','values','empties']) {
 const changed={...wire};delete changed[missing];
 assert.throws(()=>resolveOpaqueFileProjection(bound,projection,changed),`missing frozen slot ${missing}`);
}
assert.throws(()=>resolveOpaqueFileProjection(bound,{...projection,path:[]},wire));
for(const changed of [
 {...wire,upload:{id:'upload-file',extra:true}},
 {...wire,payload:{...wire.payload,copies:[{id:'copy-file',extra:true}]}},
 {...wire,request:{...request,messages:[{...request.messages[0],attachments:[{id:'message-file',extra:true}]}]}},
 {...wire,item:{id:'item'}},
 {...wire,foreign:'unowned'},
]) assert.throws(()=>resolveOpaqueFileProjection(bound,projection,changed));
const {valueSchema}=normalizeValueTypes(artifact.valueTypes,artifact.models.map(model=>model.name));
const inputs={...wire,item:{id:'item',version:1n,enabled:true},values:[1n],initial:1n,
 upload:validateValue(valueSchema,'file',wire.upload,'create'),
 payload:validateValue(valueSchema,'SendInputs.Payload',wire.payload,'create'),
 request:validateValue(valueSchema,'TextRequest',wire.request,'create')};
inputs.payload={...inputs.payload,attachment:inputs.upload};
let rule=registry;for(const part of callable.member)rule=rule[part];
assert.equal(await rule(undefined,inputs),true);
assert.equal(await rule(undefined,{...inputs,enabled:false}),false);
assert.equal(await rule(undefined,{...inputs,values:[]}),false);
assert.equal(await rule(undefined,{...inputs,initial:0n}),false);
console.log('Actual CLI SEND source/rule/input order and installed State typed File census passed; native authority remains external');
"#).unwrap();
    let run = Command::new("node")
        .arg(&runner)
        .arg(root())
        .arg(&artifact)
        .arg(&source)
        .arg(scratch.path().join("modules"))
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&run.stdout),
        String::from_utf8_lossy(&run.stderr)
    );
    eprint!("{}", String::from_utf8_lossy(&run.stdout));
}
