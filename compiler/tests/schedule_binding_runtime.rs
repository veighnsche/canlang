//! Actual compiled callable ABI only; host doubles do not qualify persistence.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn original_delivery_progress_handlers_use_checked_private_event_abi() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let source = "app OwningProgress\nuse std {TextGenerationV1 as LLM} from=deployment.llm\nuse std {ImagesV1 as Images} from=deployment.images\nGiven\n Notice { delivery:text }\nWhen\n crud Notice by=members fields=delivery\n scenario reply_progressed on=LLM.generate.progressed\n  do create Notice {delivery=event.delivery_id} as notice\n scenario image_progressed on=Images.submit.progressed\n  do create Notice {delivery=event.delivery_id} as notice\nThen\n";
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
    let output = compile("progressed", source);
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    std::fs::write(scratch.path().join("artifact.json"), output.stdout).unwrap();
    for (name, refused, code) in [
        (
            "cancel",
            source.replace("LLM.generate.progressed", "LLM.cancel.progressed"),
            "E3010",
        ),
        (
            "inspect",
            source.replace("Images.submit.progressed", "Images.inspect.progressed"),
            "E3010",
        ),
        (
            "unknown",
            source.replace("LLM.generate.progressed", "Missing.generate.progressed"),
            "E3010",
        ),
        (
            "extra_payload",
            source.replace("event.delivery_id", "event.status"),
            "E2013",
        ),
    ] {
        let refusal = compile(name, &refused);
        assert_eq!(refusal.status.code(), Some(10), "{name}");
        let refusal: serde_json::Value = serde_json::from_slice(&refusal.stdout).unwrap();
        assert!(refusal.get("modules").is_none(), "{name}");
        assert!(
            refusal["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["code"] == code),
            "{name}: {refusal}"
        );
    }
    let stdlib = scratch.path().join("node_modules/@canlang/stdlib");
    std::fs::create_dir_all(&stdlib).unwrap();
    std::fs::write(
        stdlib.join("package.json"),
        r#"{"type":"module","exports":"./index.mjs"}"#,
    )
    .unwrap();
    std::fs::write(stdlib.join("index.mjs"), r#"
import assert from 'node:assert/strict';
export function hasRole(){throw Error('unused public mutation');}
export function require(){throw Error('unused public mutation');}
export async function set(){throw Error('unused public mutation');}
export async function deleteRecord(){throw Error('unused public mutation');}
export async function create(context,model,input){
 assert.equal(context,globalThis.probe.context);assert.equal(model,'OwningProgress.Notice');
 assert.deepEqual(input,{delivery:'original-delivery'});globalThis.probe.trace.push(['create',input.delivery]);
}
"#).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const base=dirname(new URL(import.meta.url).pathname);
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
for(const module of artifact.modules){const path=resolve(base,module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const entry=await import(pathToFileURL(resolve(base,artifact.modules[0].path))),registry=entry.canApp();
const context={operation:'progress-consumer'},trace=[];globalThis.probe={context,trace};
for(const [name,eventIdentity]of [['reply_progressed','OwningProgress.LLM.generate.progressed'],['image_progressed','OwningProgress.Images.submit.progressed']]){
 const id=`OwningProgress.${name}`,operation=entry.appDefinition.operations[id];
 assert.equal(operation.event,eventIdentity);
 assert.deepEqual(entry.appDefinition.events[eventIdentity],{inputs:{delivery_id:{type:'text'}}});
 assert.deepEqual(operation.invocation,{name:id,kind:'scenario',description:'',result:{type:'void'},inputs:{fields:[{name:'delivery_id',field:{kind:'string'},valueType:'text',required:true}]}});
 assert(!artifact.operations.some(operation=>operation.name===id));
 const descriptor=artifact.callables.find(item=>item.id===id);assert.equal(descriptor.kind,'handler');
 let fn=registry;for(const part of descriptor.member)fn=fn[part];
 const event={get delivery_id(){trace.push(['read','delivery_id']);return 'original-delivery';}};
 trace.length=0;await fn(context,{event});assert.deepEqual(trace,[['read','delivery_id'],['create','original-delivery']]);
}
assert.deepEqual(Object.keys(entry.appDefinition.events).sort(),['OwningProgress.Images.submit.progressed','OwningProgress.LLM.generate.progressed']);
console.log('original delivery progress: checked identities, private payload and event callable passed');
"#).unwrap();
    let executed = Command::new("node").arg(runner).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}

#[test]
fn ordinary_schedule_uses_checked_declaring_package() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let mut source = "app Composed uses=[alpha,beta]\n".to_string();
    for owner in ["alpha", "beta"] {
        source.push_str(&format!("package {owner}\n Given\n  Entry {{timer:text,due:datetime,title:text}}\n  policy Entry read=members\n  contract Packet {{message:text}}\n  contract UnsupportedPacket {{entry:Entry}}\n  event UnsupportedCompound {{plain:text,details:UnsupportedPacket}}\n  event Compound {{plain:text,details:Packet}}\n  event Due {{entry:Entry,note:text min=1 max=16 trim,tags:text[] max=3,count:int=17 min=0 max=20}}\n When\n  scenario compound on=Compound\n   do require event.details.message==\"Nested\"\n  scenario unsupported_compound on=UnsupportedCompound\n   do require true\n  scenario fire on=Due\n   do require event.entry.title==\"Authored\"\n  scenario arm(record:Entry) by=members\n   do schedule record.timer at=record.due event=Due {{entry=record,note=record.title,tags=[],count=17}}\n  scenario stop(record:Entry) by=members\n   do cancel record.timer\n  scenario later_failure(record:Entry) by=members\n   do\n    schedule record.timer at=record.due event=Due {{entry=record,note=record.title,tags=[],count=17}}\n    require false\n    cancel record.timer\n Then\n"));
    }
    let input = scratch.path().join("schedule.can");
    std::fs::write(&input, &source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&input)
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
    // Authored events currently require complete payloads; Values input
    // normalization below has its own array/default omission contract.
    let omitted = scratch.path().join("omitted.can");
    std::fs::write(&omitted, source.replace(",tags=[],count=17", "")).unwrap();
    let refusal = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&omitted)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert_eq!(refusal.status.code(), Some(10));
    let refusal: serde_json::Value = serde_json::from_slice(&refusal.stdout).unwrap();
    assert!(refusal.get("modules").is_none());
    let diagnostics = refusal["diagnostics"].as_array().unwrap();
    assert!(!diagnostics.is_empty());
    assert!(diagnostics.iter().all(|finding| finding["code"] == "E3001"
        && (finding["message"] == "missing event field 'tags'"
            || finding["message"] == "missing event field 'count'")));

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
function check(value){globalThis.probe.trace.push(['check',value]);if(!value)throw Error('later requirement');}
export {check as require};
export async function schedule(context,key,at,event,payload,options){assert.equal(context,globalThis.probe.context);globalThis.probe.trace.push(['schedule',context,key,at,event,payload,options]);}
export async function cancel(context,key,options){assert.equal(context,globalThis.probe.context);globalThis.probe.trace.push(['cancel',context,key,options]);}
"#).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner,r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {decodeValue,normalizeSchema,validateOperationInput}=await import(pathToFileURL(resolve(process.argv[2],'packages/values/dist/src/index.js')));
const base=dirname(new URL(import.meta.url).pathname);
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
for(const module of artifact.modules){const path=resolve(base,module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const entry=await import(pathToFileURL(resolve(base,artifact.modules[0].path)));
const registry=entry.canApp();
const context={operation:'Composed.origin',memberships:['members']};
const trace=[];globalThis.probe={context,trace};
const due=decodeValue('datetime','2031-03-04T05:06:07.000Z');
function callable(id){const descriptor=artifact.callables.find(item=>item.id===id);assert(descriptor,id);let fn=registry;for(const part of descriptor.member)fn=fn[part];assert.equal(typeof fn,'function');return fn;}
function record(owner){const value={id:`${owner}-record`};for(const [key,result]of [['timer','deadline'],['due',due],['title','Authored']])Object.defineProperty(value,key,{get(){trace.push(['read',key]);return result;}});return value;}
for(const owner of ['alpha','beta']){
 const canonicalEvent=`${owner}.Due`;
 const inputs=entry.appDefinition.events[canonicalEvent].inputs;
 assert.deepEqual(inputs,{entry:{type:`${owner}.Entry`},note:{type:'text',trim:true,min:1,max:16},tags:{type:'text[]',max:3},count:{type:'int',min:'0',max:'20',default:'17'}});
 const schema=normalizeSchema({operations:{[canonicalEvent]:{inputs}}});
 const normalized=validateOperationInput(schema,canonicalEvent,{entry:{id:`${owner}-record`},note:'  Authored  '});
 assert.deepEqual(normalized,{entry:{kind:'ref',model:`${owner}.Entry`,id:`${owner}-record`},note:'Authored',tags:[],count:17n});
 for(const wire of [
  {entry:{id:'r'},note:'Authored',unknown:'x'},
  {entry:{id:'r',extra:true},note:'Authored'},
  {entry:{kind:'ref',model:`${owner}.Entry`,id:'r'},note:'Authored'},
  {entry:'r',note:'Authored'},
  {entry:{id:'r'},note:'   '},
  {entry:{id:'r'},note:'Authored',tags:['a','b','c','d']},
  {entry:{id:'r'},note:'Authored',count:'21'},
 ])assert.throws(()=>validateOperationInput(schema,canonicalEvent,wire));
 assert.equal(entry.appDefinition.operations[`${owner}.fire`].event,canonicalEvent);
 assert.deepEqual(entry.appDefinition.operations[`${owner}.fire`].invocation,{
  name:`${owner}.fire`,kind:'scenario',description:'',result:{type:'void'},inputs:{fields:[
   {name:'entry',field:{kind:'ref',model:`${owner}.Entry`,requireVersion:false},required:true},
   {name:'note',field:{kind:'string'},valueType:'text',required:true},
   {name:'tags',field:{kind:'string'},valueType:'text[]',required:false,array:{required:false}},
   {name:'count',field:{kind:'integer'},required:false,default:{kind:'literal',value:'17'}},
  ]},
 });
 assert(!artifact.operations.some(operation=>operation.name===`${owner}.fire`));
 assert.equal(entry.appDefinition.operations[`${owner}.compound`].event,`${owner}.Compound`);
 assert.deepEqual(entry.appDefinition.operations[`${owner}.compound`].invocation,{
  name:`${owner}.compound`,kind:'scenario',description:'',result:{type:'void'},inputs:{fields:[
   {name:'plain',field:{kind:'string'},valueType:'text',required:true},
   {name:'details',field:{kind:'nominal',name:`${owner}.Packet`},valueType:`${owner}.Packet`,required:true},
  ]},
 });
 assert.deepEqual(entry.appDefinition.events[`${owner}.Compound`].inputs,{plain:{type:'text'},details:{type:`${owner}.Packet`}});
 const packet=artifact.valueTypes.contracts.find(contract=>contract.name===`${owner}.Packet`);
 assert.deepEqual(packet,{name:`${owner}.Packet`,fields:[{name:'message',type:'text'}]});
 const contracts=Object.fromEntries(artifact.valueTypes.contracts.map(contract=>[contract.name,{fields:Object.fromEntries(contract.fields.map(({name,...field})=>[name,field]))}]));
 const compoundSchema=normalizeSchema({contracts,operations:{[`${owner}.Compound`]:{inputs:entry.appDefinition.events[`${owner}.Compound`].inputs}}});
 const compoundPayload=validateOperationInput(compoundSchema,`${owner}.Compound`,{plain:'Outer',details:{message:'Nested'}});
 assert.deepEqual(compoundPayload,{plain:'Outer',details:{message:'Nested'}});
 for(const wire of [
  {plain:'Outer'}, {plain:'Outer',details:{}},
  {plain:'Outer',details:{message:'Nested',extra:true}},
  {plain:'Outer',details:{message:17}}, {plain:'Outer',details:'Nested'},
  {plain:'Outer',details:{message:'Nested'},extra:true},
 ])assert.throws(()=>validateOperationInput(compoundSchema,`${owner}.Compound`,wire));
 trace.length=0;await callable(`${owner}.compound`)(context,{event:compoundPayload});
 assert.deepEqual(trace,[['check',true]]);
 assert.equal(entry.appDefinition.operations[`${owner}.unsupported_compound`].event,`${owner}.UnsupportedCompound`);
 assert.equal(entry.appDefinition.operations[`${owner}.unsupported_compound`].invocation,undefined,'model-containing contract omits the whole private descriptor');
 assert(!artifact.valueTypes.contracts.some(contract=>contract.name===`${owner}.UnsupportedPacket`));
 assert(!artifact.operations.some(operation=>operation.name===`${owner}.unsupported_compound`));
 assert(!artifact.operations.some(operation=>operation.name===`${owner}.compound`));
 assert.equal(artifact.callables.find(item=>item.id===`${owner}.fire`).kind,'handler');
 const current=record(owner);let inputReads=0;const input={};Object.defineProperty(input,'record',{get(){inputReads++;return current;}});
 trace.length=0;await callable(`${owner}.arm`)(context,input);
 assert.equal(inputReads,1);assert.deepEqual(trace[0],['check',true]);assert.deepEqual(trace.slice(1,4),[['read','timer'],['read','due'],['read','title']]);assert.equal(trace.length,5);
 const call=trace[4];assert.equal(call[0],'schedule');assert.equal(call[1],context);assert.equal(call[2],'deadline');assert.equal(call[3],due);assert.equal(call[4],`${owner}.Due`);assert.equal(call[5].entry,current);assert.deepEqual(call[5],{entry:current,note:'Authored',tags:[],count:17n});assert.deepEqual(call[6],{ownerPackage:owner});
 trace.length=0;await callable(`${owner}.stop`)(context,{record:current});
 assert.deepEqual(trace,[['check',true],['read','timer'],['cancel',context,'deadline',{ownerPackage:owner}]]);
 trace.length=0;await assert.rejects(callable(`${owner}.later_failure`)(context,{record:current}),{message:'later requirement'});
 assert.deepEqual(trace.map(item=>item[0]),['check','read','read','read','schedule','check']);assert.deepEqual(trace.at(-1),['check',false]);assert.deepEqual(trace[4][6],{ownerPackage:owner});
 trace.length=0;await callable(`${owner}.fire`)(context,{event:{...normalized,entry:current}});
 assert.deepEqual(trace,[['read','title'],['check',true]]);
 trace.length=0;await assert.rejects(callable(`${owner}.fire`)(context,{event:{...normalized,entry:{id:current.id,title:'Changed'}}}),{message:'later requirement'});
 assert.deepEqual(trace,[['check',false]]);
}
console.log('checked schedule/cancel defining-package ABI, carrier identity and authored order passed');
"#).unwrap();
    let executed = Command::new("node")
        .arg(&runner)
        .arg(root)
        .output()
        .unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
