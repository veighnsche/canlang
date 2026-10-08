//! Frozen checked source through native callable/Values codec ABI only.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn checked_std_delivery_field_reaches_owning_metadata_and_codec() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let fixture = root.join("packages/cloudflare/test/fixtures/typed-delivery-observer.can");
    let output = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"))
        .arg(&fixture)
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
    std::fs::write(stdlib.join("index.mjs"),r#"
import assert from 'node:assert/strict';
export function hasRole(context,role){assert.equal(context,globalThis.probe.context);return context.memberships.includes(role);}
function check(value){globalThis.probe.trace.push(['check',value]);if(!value)throw Error('authored refusal');}
export {check as require};
export async function send(context,operation,request,options){assert.equal(context,globalThis.probe.context);assert.equal(operation,'std.EmailV1.send');assert.deepEqual(request,{to:'a@b.test',subject:'Actual notification',body:'Associated delivery'});assert.deepEqual(options,{binding:'TypedDeliveryObserver.Mail'});globalThis.probe.trace.push(['send']);return globalThis.probe.attempt;}
export async function set(context,record,changes){assert.equal(context,globalThis.probe.context);assert.equal(record,globalThis.probe.record);assert.equal(changes.notification,globalThis.probe.attempt);globalThis.probe.trace.push(['set']);}
export async function create(){throw Error('unexpected create');}
export async function deleteRecord(){throw Error('unexpected delete');}
"#).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner,r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.argv[2];
const {decodeValue,encodeValue}=await import(pathToFileURL(resolve(root,'packages/values/dist/src/index.js')));
const base=dirname(new URL(import.meta.url).pathname);
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
for(const module of artifact.modules){const path=resolve(base,module.path);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,module.js);}
const entry=await import(pathToFileURL(resolve(base,artifact.modules[0].path)));
const definition=entry.appDefinition;
assert.deepEqual(definition.models['TypedDeliveryObserver.Entry'].fields.notification,{type:'delivery',operation:'std.EmailV1.send',nullable:true});
assert.deepEqual(definition.bindings['TypedDeliveryObserver.Mail'],{capability:'std.EmailV1',from:'deployment.mail'});
const model=artifact.models.find(model=>model.name==='TypedDeliveryObserver.Entry');assert(model);
const field=model.fields.find(field=>field.name==='notification');
assert.equal(field.nullable,true);assert.equal(field.field.kind,'delivery');
assert.equal(field.field.capability,'std.EmailV1');assert.equal(field.field.operation,'send');assert.equal(field.field.version,1);
assert.equal(field.field.result.name,'EmailAccepted');assert.deepEqual(field.field.result.fields,[{name:'reference',type:'text'}]);
const type='delivery(std.EmailV1.send)?';const wire={id:'attempt',operation:'std.EmailV1.send'};
const attempt=decodeValue(type,wire);assert(Object.isFrozen(attempt));assert.deepEqual(encodeValue(type,attempt),wire);assert.equal(decodeValue(type,null),null);
assert.throws(()=>decodeValue(type,{id:'attempt',operation:'std.PaymentsV1.collect'}));
assert.throws(()=>decodeValue(type,{...wire,status:'accepted'}));
const context={operation:'Other.origin',memberships:['members']};const record={id:'entry',version:3n};const trace=[];globalThis.probe={context,record,attempt,trace};
const descriptor=artifact.callables.find(item=>item.id==='TypedDeliveryObserver.notify');assert(descriptor);
let notify=entry.canApp();for(const part of descriptor.member)notify=notify[part];assert.equal(typeof notify,'function');
await notify(context,{entry:record,to:'a@b.test',accept:true});assert.deepEqual(trace,[['check',true],['send'],['set'],['check',true]]);
trace.length=0;await assert.rejects(notify(context,{entry:record,to:'a@b.test',accept:false}),{message:'authored refusal'});assert.deepEqual(trace,[['check',true],['send'],['set'],['check',false]]);
console.log('frozen std delivery source, canonical metadata/codec and unchanged native association order passed');
"#).unwrap();
    let executed = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
