//! Generated source-owned equality keeps business tags inside their Contracts.
#![cfg(unix)]
use serde_json::Value;
use std::{path::Path, process::Command};

const SOURCE: &str = r#"package Shared
 use std {OperationOutcome}
 Given
  export contract Evidence {kind:text,model:text,id:text,version:int,recipient:email}
  export contract LinkEvidence {address:url,state:OperationOutcome.state}
  export LinkEntry {value:LinkEvidence}
  export Entry {fact:Evidence}
  export Other {fact:Evidence}
 When
 Then
app ContractKinds
use Shared {Evidence as Fact,Entry,Other,LinkEvidence as LinkFact,LinkEntry}
Given
 contract Envelope {fact:Fact,optional:Fact?,facts:Fact[]}
 contract UrlShapes {address:url,optional:url?,addresses:url[],optional_addresses:url[]?,required_addresses:url[]!}
 contract EmailShapes {address:email,optional:email?,addresses:email[],optional_addresses:email[]?}
 derive url_equal(left:LinkFact,right:LinkFact):bool = left==right
 derive url_reused(left:LinkEntry.value,right:LinkEntry.value):bool = left==right
 derive url_literal(value:LinkFact):bool = LinkFact {address="https://example.test/path",state=confirmed}==value
 derive equal(left:Fact,right:Fact):bool = left==right
 derive unequal(left:Fact,right:Fact):bool = left!=right
 derive nullable(left:Fact?,right:Fact?):bool = left==right
 derive sequence(left:Fact[],right:Fact[]):bool = left==right
 derive member(value:Fact,values:Fact[]):bool = value in values
 derive reused(left:Entry.fact,right:Entry.fact):bool = left==right
 derive nested(left:Envelope,right:Envelope):bool = left==right
 derive model_sequence(left:Entry|Other[],right:Entry|Other[]):bool = left==right
 derive mixed_sequence(left:Fact|Entry[],right:Fact|Entry[]):bool = left==right
 derive literal(value:Fact):bool = Fact {kind="ref",model="business",id="invoice",version=1,recipient="billing@example.test"}==value
When
 scenario preserve on=Entry.update
  do
   require event.before.fact==event.after.fact
Then
"#;

#[test]
fn generated_normal_and_hook_equality_share_exact_contract_schema() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("kinds.can");
    std::fs::write(&input, SOURCE).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&input)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact: Value = serde_json::from_slice(&compiled.stdout).unwrap();
    let entry = artifact["modules"][0]["js"].as_str().unwrap();
    assert_eq!(
        entry.matches("const $valueSchema=normalizeSchema(").count(),
        1
    );
    assert!(entry.contains("equalValue(\"Shared.Evidence\", "));
    assert!(entry.contains(",undefined,$valueSchema)"));
    assert!(entry.contains("\"kind\":{\"type\":\"text\"},\"model\":{\"type\":\"text\"},\"id\":{\"type\":\"text\"},\"version\":{\"type\":\"int\"}"), "source field order retained");
    let evidence = artifact["valueTypes"]["contracts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|contract| contract["name"] == "Shared.Evidence")
        .unwrap();
    assert_eq!(
        evidence["fields"].as_array().unwrap().last().unwrap()["type"],
        "email"
    );
    assert!(entry.contains("\"recipient\":{\"type\":\"email\"}"));
    std::fs::write(scratch.path().join("artifact.json"), compiled.stdout).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const root=process.argv[2],base=process.argv[3];
const require=createRequire(resolve(root,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules,importVerifiedAssemblyModule}=await load('@canlang/cloudflare/runtime/modules');
const {normalizeValueTypes,validateValue,encodeValue,SchemaError,makeUnionValue,makeRecordRef}=await load('@canlang/values');
const {isAuthoredRequireFailure}=await load('@canlang/state/effects/guards');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const assembly=await assembleModules({artifact,sourcePath:resolve(base,'kinds.can')},{workDir:resolve(base,'modules'),
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href});
const module=await importVerifiedAssemblyModule(assembly,artifact.modules[0].path,artifact);
const registry=module.canApp();
const {valueSchema}=normalizeValueTypes(artifact.valueTypes,artifact.models.map(model=>model.name));
const callable=name=>{const spec=artifact.callables.find(callable=>callable.id===`ContractKinds.${name}`);assert(spec,name);
 let result=registry;for(const member of spec.member)result=result[member];return result;};
const wire={kind:'ref',model:'business',id:'invoice',version:'1',recipient:'billing@example.test'};
const plain={...wire,version:1n};
const decoded=validateValue(valueSchema,'Shared.Evidence',wire,'create');
assert.equal(await callable('literal')(undefined,decoded),true,'plain compiler literal shares exact imported declaration');
for(const kind of ['ref','file','datetime','decimal','union','secret']){
 const left={...plain,kind},right=validateValue(valueSchema,'Shared.Evidence',{...wire,kind},'create');
 for(const name of ['equal','reused'])assert.equal(await callable(name)(undefined,left,right),true,`${name} ${kind}`);
 for(const [field,value] of Object.entries({kind:'other',model:'other',id:'other',version:2n,recipient:'other@example.test'})){
  const different={...right,[field]:value};
  assert.equal(await callable('equal')(undefined,left,different),false,`${kind} business ${field}`);
  assert.equal(await callable('unequal')(undefined,left,different),true);
  assert.equal(await callable('member')(undefined,left,[different]),false);
 }
 assert.equal(await callable('nullable')(undefined,left,right),true);
 assert.equal(await callable('sequence')(undefined,[left],[right]),true);
 assert.equal(await callable('member')(undefined,left,[right]),true);
 assert.equal(await callable('nested')(undefined,{fact:left,optional:left,facts:[left]},{fact:right,optional:right,facts:[right]}),true);
 assert.equal(await callable('nested')(undefined,{fact:left,optional:null,facts:[left]},{fact:right,optional:null,facts:[{...right,version:2n}]}),false);
}
assert.equal(await callable('nullable')(undefined,null,null),true);
assert.equal(await callable('nullable')(undefined,null,decoded),false);
const first=makeRecordRef('Shared.Entry','row',1n),refreshed=makeRecordRef('Shared.Entry','row',2n);
assert.equal(await callable('model_sequence')(undefined,[makeUnionValue('Shared.Entry',first)],[makeUnionValue('Shared.Entry',refreshed)]),true,'Model-only union keeps reference version identity');
assert.equal(await callable('mixed_sequence')(undefined,[makeUnionValue('Shared.Entry',first)],[makeUnionValue('Shared.Entry',refreshed)]),true,'mixed union keeps Model identity');
assert.equal(await callable('mixed_sequence')(undefined,[makeUnionValue('Shared.Evidence',plain)],[makeUnionValue('Shared.Evidence',{...decoded,version:2n})]),false,'mixed union preserves Contract business version');
assert.equal(valueSchema.contracts['Shared.Evidence'].fields.recipient.typeId,'email');
assert.equal(module.appDefinition.contracts['Shared.Evidence'].fields.recipient.type,'email');
assert.deepEqual(encodeValue('Shared.Evidence',decoded,undefined,valueSchema),wire);
const emailShapes={address:wire.recipient,optional:null,addresses:[wire.recipient],optional_addresses:null};
assert.deepEqual(validateValue(valueSchema,'ContractKinds.EmailShapes',emailShapes,'create'),emailShapes);
for(const [field,type] of Object.entries({address:'email',optional:'email?',addresses:'email[]',optional_addresses:'email[]?'})){
 assert.equal(valueSchema.contracts['ContractKinds.EmailShapes'].fields[field].typeId,type);
 const value=type.includes('[]')?['invalid']: 'invalid';
 assert.throws(()=>validateValue(valueSchema,'ContractKinds.EmailShapes',{...emailShapes,[field]:value},'create'),error=>error instanceof SchemaError&&error.violations.some(violation=>violation.code==='format'&&violation.path[0]===field));
}
for(const recipient of ['invalid','@example.test','local@']){
 assert.throws(()=>validateValue(valueSchema,'Shared.Evidence',{...wire,recipient},'create'),error=>error instanceof SchemaError&&error.violations.some(violation=>violation.code==='format'&&violation.path.join('/')==='recipient'));
}
const linkWire={address:'https://example.test/path',state:'confirmed'};
const linkDecoded=validateValue(valueSchema,'Shared.LinkEvidence',linkWire,'create');
for(const name of ['url_equal','url_reused']){
 assert.equal(await callable(name)(undefined,linkWire,linkDecoded),true);
 assert.equal(await callable(name)(undefined,linkWire,{...linkDecoded,address:'https://other.test'}),false);
 assert.equal(await callable(name)(undefined,linkWire,{...linkDecoded,state:'pending'}),false);
}
assert.equal(await callable('url_literal')(undefined,linkDecoded),true);
assert.deepEqual(encodeValue('Shared.LinkEvidence',linkDecoded,undefined,valueSchema),linkWire);
const states='enum(pending,confirmed,unavailable,failed,unknown,released)';
assert.equal(valueSchema.contracts['Shared.LinkEvidence'].fields.state.typeId,states);
assert.equal(module.appDefinition.contracts['Shared.LinkEvidence'].fields.state.type,states);
assert.equal(valueSchema.enums?.['Shared.LinkEvidence.state'],undefined,'inline standard cases gain no synthetic nominal owner');
assert.throws(()=>validateValue(valueSchema,'Shared.LinkEvidence',{...linkWire,state:'invented'},'create'),error=>error instanceof SchemaError);
const urlShapes={address:linkWire.address,optional:null,addresses:[linkWire.address],optional_addresses:null,required_addresses:[]};
assert.deepEqual(validateValue(valueSchema,'ContractKinds.UrlShapes',urlShapes,'create'),urlShapes);
assert.deepEqual(encodeValue('ContractKinds.UrlShapes',urlShapes,undefined,valueSchema),urlShapes);
for(const [field,type] of Object.entries({address:'url',optional:'url?',addresses:'url[]',optional_addresses:'url[]?',required_addresses:'url[]!'})){
 assert.equal(valueSchema.contracts['ContractKinds.UrlShapes'].fields[field].typeId,type);
 for(const invalid of ['invalid','ftp://example.test/file']){
  const value=type.includes('[]')?[invalid]:invalid;
  assert.throws(()=>validateValue(valueSchema,'ContractKinds.UrlShapes',{...urlShapes,[field]:value},'create'),error=>error instanceof SchemaError&&error.violations.some(violation=>violation.code==='format'&&violation.path[0]===field));
  assert.throws(()=>encodeValue('ContractKinds.UrlShapes',{...urlShapes,[field]:value},undefined,valueSchema),error=>error.code==='invalid-construction');
 }
}
const {required_addresses,...missingRequiredUrls}=urlShapes;
assert.throws(()=>validateValue(valueSchema,'ContractKinds.UrlShapes',missingRequiredUrls,'create'),error=>error instanceof SchemaError&&error.violations.some(violation=>violation.code==='required'&&violation.path[0]==='required_addresses'));
const hook=callable('preserve');
const before={fact:plain,data:{fact:plain},id:'entry',version:1,parent:null};
const context=fact=>({before,after:{fact,version:2},triggerId:'entry'});
assert.deepEqual(await hook({fact:decoded},context(decoded)),{fact:decoded});
await assert.rejects(()=>hook({fact:{...decoded,version:2n}},context({...decoded,version:2n})),error=>isAuthoredRequireFailure(error)&&error.message==='forbidden');
await assert.rejects(()=>hook({fact:{...decoded,recipient:'other@example.test'}},context({...decoded,recipient:'other@example.test'})),error=>isAuthoredRequireFailure(error)&&error.message==='forbidden');
console.log('generated imported/reused Contract literal, decoded, nested, nullable, array, membership and hook equality preserve business tags and exact email/URL/inline-enum leaves; canonical receiver rejects invalid inputs');
"#).unwrap();
    let run = Command::new("node")
        .arg(&runner)
        .arg(root)
        .arg(scratch.path())
        .current_dir(root)
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
