//! Checked supplied-array concatenation through the production CLI and Values helper.
#![cfg(unix)]

use std::{path::Path, process::Command};

const SOURCE: &str = r#"app ArrayConcat
use std {TextMessage as Message}
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
 contract MessageInputs { left:Message[],right:Message[],tail:Message[] }
 derive message(content:text):Message = Message {role=user,content,attachments=[]}
 derive messageIdentity(values:Message[]):Message[] = values
 derive messages(row:MessageInputs):Message[] = row.left+row.right
 derive awaitedMessages(row:MessageInputs):Message[] = messageIdentity(row.left)+messageIdentity(row.right)
 derive chainedMessages(row:MessageInputs):Message[] = row.left+row.right+row.tail
When
 scenario nativeMessages(left:Message[],right:Message[]) -> Message[] by=members read=true
  do return left+right
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
 stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
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
// These elements come from the original checked nominal constructor. Empty
// attachments exercise the declared file[] shape without issuing File authority.
const fields=entry.appDefinition.contracts.TextMessage.fields;
assert.deepEqual(Object.keys(fields),['role','content','attachments']);
assert.equal(fields.role.type,'enum(system,user,assistant)');
assert.equal(fields.content.type,'text');assert.equal(fields.attachments.type,'file[]');
const messageA=await callable('message')(context,'first'),messageB=await callable('message')(context,'second');
assert.deepEqual(messageA,{role:'user',content:'first',attachments:[]});
assert.deepEqual(messageB,{role:'user',content:'second',attachments:[]});
const messagesLeft=Object.freeze([messageA,messageB,messageA]),messagesRight=Object.freeze([messageB]),messagesTail=Object.freeze([messageA]);
for(const name of ['messages','awaitedMessages','chainedMessages']){
 const trace=[],row={};
 for(const [key,value]of [['left',messagesLeft],['right',messagesRight],['tail',messagesTail]])Object.defineProperty(row,key,{get(){trace.push(key);return value;}});
 const output=await callable(name)(context,row),expected=name==='chainedMessages'?[messageA,messageB,messageA,messageB,messageA]:[messageA,messageB,messageA,messageB];
 assert.equal(Object.isFrozen(output),true);assert.notEqual(output,messagesLeft);assert.notEqual(output,messagesRight);
 assert.equal(output.length,expected.length);for(const [index,value]of expected.entries())assert.equal(output[index],value,'nominal element identity is preserved');
 assert.deepEqual(trace,name==='chainedMessages'?['left','right','tail']:['left','right']);
 assert.deepEqual(messagesLeft,[messageA,messageB,messageA]);assert.deepEqual(messagesRight,[messageB]);
 for(const failed of ['left','right']){
  const failure=new Error(`${name}:${failed}`),trace=[],row={};
  for(const [key,value]of [['left',messagesLeft],['right',messagesRight],['tail',messagesTail]])Object.defineProperty(row,key,{get(){trace.push(key);if(key===failed)throw failure;return value;}});
  await assert.rejects(callable(name)(context,row),error=>error===failure);assert.deepEqual(trace,failed==='left'?['left']:['left','right']);
 }
}
const {buildInvoker}=await load('@canlang/cloudflare/worker/assembly');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const {FIXED_NOW,createMemoryIdentityStore,seedMember,makeIdentity}=await load('@canlang/state/testing/invocation/fixtures');
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false}),identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,assembly,store,{memberships,now:()=>FIXED_NOW}),revision=await store.readRevision();
const native=await invoker.invokeRead({operation:'ArrayConcat.nativeMessages',inputs:{left:messagesLeft,right:messagesRight}},identity);
assert.ok('result' in native,JSON.stringify(native));assert.deepEqual(native.result,{result:[messageA,messageB,messageA,messageB],revision});
assert.equal(await store.readRevision(),revision,'a supplied-array read never commits effects');
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
            "foreign-nominal-owner",
            "app Refusal\nuse std {TextMessage as Message,WorkflowInput as Input}\nGiven\n derive foreign(left:Message[],right:Input[]):Message[] = left+right\nWhen\nThen\n",
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
