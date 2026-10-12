//! Bound Mailbox source metadata and verified module/schema correspondence.
//! Provider verification, ingress identity and File authority remain separate.
use std::{path::Path, process::Command};

const SOURCE: &str = r#"app MailboxSource uses=[inbox]
package inbox
 use std {MailboxV1 as Post} from=deployment.inbox
 use std {IncomingEmail}
 Given
 When
  scenario received on=Post.received
   do let incoming=event.value
 Then
"#;

#[test]
fn checked_mailbox_source_publishes_complete_payload_and_private_handler_input() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("mailbox-source.can");
    std::fs::write(&input, SOURCE.as_bytes()).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/cloudflare/dist/native-catalog.json"))
        .arg(&input)
        .current_dir(root)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&compiled.stdout),
        String::from_utf8_lossy(&compiled.stderr)
    );
    let artifact: serde_json::Value = serde_json::from_slice(&compiled.stdout).unwrap();
    let hash = canlang_compiler::source::sha256_hex(SOURCE.as_bytes());
    assert_eq!(
        artifact["sources"],
        serde_json::json!([{"path":input.to_str().unwrap(),"sha256":hash}])
    );
    let contracts = artifact["valueTypes"]["contracts"].as_array().unwrap();
    let email = contracts
        .iter()
        .find(|contract| contract["name"] == "IncomingEmail")
        .unwrap();
    let fields = email["fields"].as_array().unwrap();
    let expected = [
        ("mailbox", "text"),
        ("source", "text"),
        ("thread", "text"),
        ("sender", "text"),
        ("reply_to", "text?"),
        ("subject", "text"),
        ("body", "text"),
        ("body_complete", "bool"),
        ("attachments", "file[]"),
        ("attachment_count", "int"),
        ("attachments_complete", "bool"),
        ("received", "datetime"),
    ];
    assert_eq!(
        fields
            .iter()
            .map(|field| (
                field["name"].as_str().unwrap(),
                field["type"].as_str().unwrap()
            ))
            .collect::<Vec<_>>(),
        expected
    );
    let handlers = artifact["callables"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|callable| callable["id"] == "inbox.received")
        .collect::<Vec<_>>();
    assert_eq!(handlers.len(), 1);
    assert_eq!(handlers[0]["kind"], "handler");
    assert_eq!(handlers[0]["member"], serde_json::json!(["inbox.received"]));
    assert!(
        !artifact["operations"]
            .as_array()
            .unwrap()
            .iter()
            .any(|operation| operation["name"] == "inbox.received"),
        "private handler stays out of public operation admission"
    );
    assert!(
        artifact["models"].as_array().unwrap().is_empty(),
        "implicit event does not create a stored model"
    );
    std::fs::write(scratch.path().join("artifact.json"), &compiled.stdout).unwrap();
    let runner = scratch.path().join("mailbox-source.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const base=dirname(fileURLToPath(import.meta.url)),root=realpathSync(process.argv[2]),sourcePath=process.argv[3];
const require=createRequire(resolve(root,'package.json'));
const own=specifier=>{
 const file=realpathSync(require.resolve(specifier));
 assert.ok(file.startsWith(root+'/'),specifier+' must use this compiler worktree output');
 return pathToFileURL(file);
};
const {assembleModules,importVerifiedAssemblyModule}=await import(own('@canlang/cloudflare/runtime/modules'));
const {normalizeValueTypes,normalizeSchema}=await import(own('@canlang/values'));
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
assert.equal(createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),process.argv[4]);
const assembly=await assembleModules({artifact,sourcePath},{workDir:resolve(base,'modules'),stdlibUrl:own('@canlang/cloudflare/runtime/stdlib').href});
const callable=artifact.callables.find(value=>value.id==='inbox.received');
const {appDefinition:definition,canApp}=await importVerifiedAssemblyModule(assembly,callable.module,artifact);
const registry=canApp();let handler=registry;for(const member of callable.member) handler=handler[member];
assert.equal(typeof handler,'function');
const route=definition.operations[callable.id];
assert.equal(route.event,'inbox.Post.received');
assert.equal(route.read,false);
assert.equal(route.invocation.name,callable.id);
assert.equal(route.invocation.kind,'scenario');
assert.deepEqual(route.invocation.inputs.fields,[{name:'value',field:{kind:'nominal',name:'IncomingEmail'},valueType:'IncomingEmail',required:true}]);
assert.deepEqual(route.invocation.result,{type:'void'});
assert.deepEqual(Object.keys(definition.events),['inbox.Post.received']);
assert.deepEqual(definition.events[route.event],{inputs:{value:{type:'IncomingEmail'}}});
const binding=definition.bindings['inbox.Post'];
assert.equal(binding.capability,'std.MailboxV1');assert.equal(binding.from,'deployment.inbox');
assert.deepEqual(definition.capabilities[binding.capability].events.received,{value:{type:'IncomingEmail'}});
assert.equal(Object.hasOwn(definition.models,route.event),false);
const expected={mailbox:'text',source:'text',thread:'text',sender:'text',reply_to:'text?',subject:'text',body:'text',
 body_complete:'bool',attachments:'file[]',attachment_count:'int',attachments_complete:'bool',received:'datetime'};
const fields=definition.contracts.IncomingEmail.fields;
assert.deepEqual(Object.keys(fields),Object.keys(expected));
for(const [name,type] of Object.entries(expected)) assert.deepEqual(fields[name],{type});
const declarations={contracts:definition.contracts,enums:definition.enums,
 ...(definition.aliases===undefined?{}:{aliases:definition.aliases})};
const {valueSchema}=normalizeValueTypes(artifact.valueTypes,artifact.models.map(model=>model.name));
assert.deepEqual(normalizeSchema(declarations),valueSchema,'complete owning catalog schema, not a shape guess');
assert.equal(valueSchema.contracts.IncomingEmail.fields.attachments.typeId,'file[]');
assert.equal(valueSchema.contracts.IncomingEmail.fields.received.typeId,'datetime');
normalizeSchema({...declarations,operations:{[route.event]:{inputs:definition.events[route.event].inputs}}});
// Loading this metadata or resolving the handler supplies no verifier output,
// native invocation context, receiving File observation or durable authority.
console.log('Mailbox source: verified private handler/event pair and all twelve IncomingEmail fields agree; ingress/File authority unqualified');
"#).unwrap();
    let executed = Command::new("node")
        .arg(&runner)
        .arg(root)
        .arg(&input)
        .arg(&hash)
        .current_dir(scratch.path())
        .output()
        .unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
