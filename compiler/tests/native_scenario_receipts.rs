//! Opt-in native capture through unchanged CLI output and installed owners.
//! Saved disclosure projection is State-owned; generic public scenario projection remains separate.
#![cfg(unix)]
use serde_json::Value;
use std::{path::Path, process::Command};
const SOURCE: &str = r#"app NativeReceipts
Given
 Item {value:int,enabled:bool,optional:int?,state:enum(a,b)=a}
 policy Item read=members
 derive value(item:Item):int = item.value
When
 crud Item by=members fields=value,enabled,optional delete=none
 scenario literal() -> int by=members
  do return 7
 scenario input(value:int) -> int by=members
  do return value
 scenario checked(item:Item) -> int by=members
  do
   require item.enabled
   return 7
 scenario field(item:Item) -> int by=members
  do return item.value
 scenario branch(item:Item) -> int by=members
  do
   if item.enabled
    return item.value
   else
    return 0
 scenario conjunction(item:Item) -> bool by=members
  do return item.enabled and item.value>0
 scenario disjunction(item:Item) -> bool by=members
  do return item.enabled or item.value>0
 scenario fallback(item:Item) -> int by=members
  do return item.optional ?? item.value
 scenario matched(value:Item.state) -> int by=members
  do
   match value
    case a
     return 1
    case b
     return 2
 scenario implicit_void() by=members
  do require true
 scenario conditional_void(selected:bool) by=members
  do
   if selected
    require true
   else
    require true
 scenario ignored(item:Item) -> int by=members
  do
   let unused=item.optional ?? item.value
   return 7
 scenario reused(item:Item) -> bool by=members
  do
   let enabled=item.enabled
   return enabled and enabled
 scenario query() read=true -> int by=members
  do return count(Item)
 scenario absent(item:Item?) -> int? by=members
  do return item?.value
 scenario composite(value:int[]) -> int[] by=members
  do return value
 scenario model(item:Item) -> Item by=members
  do return item
 scenario derived(item:Item) -> int by=members
  do return value(item)
 scenario changed(item:Item) -> int by=members
  do
   set item {value=2}
   return 1
Then
"#;
fn compile(scratch: &Path, native: bool) -> Value {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let source = scratch.join("native-receipts.can");
    std::fs::write(&source, SOURCE).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_can"));
    command
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"));
    if native {
        command.arg("--native-scenario-receipts");
    }
    let output = command
        .arg(source)
        .env_remove("CAN_CATALOG")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let artifact = serde_json::from_slice(&output.stdout).unwrap();
    std::fs::write(
        scratch.join(if native {
            "native.json"
        } else {
            "default.json"
        }),
        output.stdout,
    )
    .unwrap();
    artifact
}
fn operation<'a>(artifact: &'a Value, name: &str) -> &'a Value {
    artifact["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|op| op["name"] == format!("NativeReceipts.{name}"))
        .unwrap()
}
#[test]
fn opt_in_native_capture_retains_selected_paths_replays_and_current_state_projection() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let refused = Command::new(env!("CARGO_BIN_EXE_can"))
        .args(["check", "--native-scenario-receipts"])
        .arg(scratch.path().join("native-receipts.can"))
        .output()
        .unwrap();
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("only applies to can compile"));
    let default = compile(scratch.path(), false);
    let artifact = compile(scratch.path(), true);
    for op in default["operations"].as_array().unwrap() {
        assert!(op["result"].get("disclosure").is_none());
    }
    for module in default["modules"].as_array().unwrap() {
        let js = module["js"].as_str().unwrap();
        assert!(!js.contains("observeScenarioReceiptDependency"));
        assert!(!js.contains("selectScenarioReceiptReturn"));
    }
    for name in [
        "literal",
        "input",
        "checked",
        "field",
        "branch",
        "conjunction",
        "disjunction",
        "fallback",
        "matched",
        "implicit_void",
        "conditional_void",
        "ignored",
        "reused",
    ] {
        let op = operation(&artifact, name);
        let plan = &op["result"]["disclosure"];
        assert_eq!(plan["version"], 1, "{name}");
        let callable = artifact["callables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|call| call["id"] == op["name"])
            .unwrap();
        for origin in std::iter::once(&plan["source"]).chain(
            plan["returns"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|returned| {
                    std::iter::once(&returned["source"]).chain(
                        returned["dependencies"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|dep| &dep["source"]),
                    )
                }),
        ) {
            assert_eq!(origin["module"], callable["module"]);
            assert!(
                artifact["sources"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|source| source["path"] == origin["path"]
                        && source["sha256"] == origin["sha256"])
            );
        }
        assert_eq!(callable["module"], artifact["modules"][0]["path"]);
        assert_eq!(
            op["result"]["type"],
            operation(&default, name)["result"]["type"]
        );
    }
    for name in [
        "query",
        "absent",
        "composite",
        "model",
        "derived",
        "changed",
    ] {
        assert!(
            operation(&artifact, name)["result"]
                .get("disclosure")
                .is_none(),
            "whole unsupported recipe omitted: {name}"
        );
    }
    let runner = scratch.path().join("native.mjs");
    std::fs::write(&runner, RUNNER).unwrap();
    let output = Command::new("node")
        .arg(&runner)
        .arg(root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
const RUNNER: &str = r#"
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const base=dirname(fileURLToPath(import.meta.url)),root=process.argv[2];
const require=createRequire(resolve(root,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules}=await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker}=await load('@canlang/cloudflare/worker/assembly');
const {loadCanonicalDescriptors}=await load('@canlang/cloudflare/runtime/invoke');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const {readScenarioReceiptAssociation,projectScenarioReceipt}=await load('@canlang/state/invocation');
const {FIXED_NOW,createMemoryIdentityStore,seedMember,makeIdentity,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const artifact=JSON.parse(readFileSync(resolve(base,'native.json'),'utf8'));
const asm=await assembleModules({artifact,sourcePath:resolve(base,'native-receipts.can')},{workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href});
const entry=await import(asm.entryUrl);
assert.deepEqual(entry.canApp().operations,artifact.operations,'actual imported canApp publication');
const loaded=await loadCanonicalDescriptors(asm,artifact);
const {store:backing,probe}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
let commits=0;const store={...backing,commit:async batch=>{commits++;return backing.commit(batch);}};
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
let sequence=0;
const request=(name,inputs)=>({operation:'NativeReceipts.'+name,operation_id:uuidv7(FIXED_NOW,++sequence),inputs});
const receiptFor=req=>store.readReceipt({app:'NativeReceipts',owner:identity.team.team_id,principal:identity.actor.user_id,operation:req.operation,operationId:req.operation_id});
const invoke=req=>invoker.invokeMutation(req,identity);
const committed=async req=>{const value=await invoke(req);assert.ok('result' in value,JSON.stringify(value));assert.equal(value.result.status,'committed');return value.result;};
const create=async data=>{const req=request('Item.create',data);const result=await committed(req);assert.equal(result.records.length,1);return result.records[0];};
const yes=await create({value:'17',enabled:true,optional:null});
const no=await create({value:'-3',enabled:false,optional:'9'});
const ref=row=>({id:row.id,version:String(row.version)});
const saved=[];
for(const [name,inputs,expected,fields] of [
 ['literal',{},'7',[]],['input',{value:'9223372036854775807'},'9223372036854775807',[]],
 ['checked',{item:ref(yes)},'7',[]],['field',{item:ref(yes)},'17',['value']],
 ['branch',{item:ref(yes)},'17',['enabled','value']],['branch',{item:ref(no)},'0',['enabled']],
 ['conjunction',{item:ref(yes)},true,['enabled','value']],['conjunction',{item:ref(no)},false,['enabled']],
 ['disjunction',{item:ref(yes)},true,['enabled']],['disjunction',{item:ref(no)},false,['enabled','value']],
 ['fallback',{item:ref(yes)},'17',['optional','value']],['fallback',{item:ref(no)},'9',['optional']],
 ['matched',{value:'a'},'1',[]],['matched',{value:'b'},'2',[]],
 ['implicit_void',{},null,[]],['conditional_void',{selected:true},null,[]],['conditional_void',{selected:false},null,[]],
 ['ignored',{item:ref(yes)},'7',[]],['ignored',{item:ref(no)},'7',[]],
 ['reused',{item:ref(yes)},true,['enabled']],['reused',{item:ref(no)},false,['enabled']],
]){
 const req=request(name,inputs),result=await committed(req),receipt=await receiptFor(req);
 assert.equal(result.result,expected);assert.equal(receipt.outcome.result,expected);
 const association=readScenarioReceiptAssociation(receipt);assert.ok(association,'native State-owned capture');
 const descriptor=artifact.operations.find(op=>op.name===req.operation);
 assert.deepEqual(association.plan,descriptor.result.disclosure);
 const path=association.plan.returns.find(value=>value.id===association.returnId);assert.ok(path);
 assert.deepEqual([...new Set(path.dependencies.map(dep=>dep.field))].sort(),[...fields].sort());
 assert.deepEqual([...association.observations.map(observation=>observation.dependencyId)].sort(),[...path.dependencies.map(dep=>dep.id)].sort());
 assert.deepEqual(association.changed,[]);
 if(name==='reused')assert.equal(new Set(path.dependencies.map(dep=>dep.field)).size,1,'one checked field reused across data/control');
 for(const observation of association.observations){assert.equal(observation.model,'NativeReceipts.Item');assert.equal(observation.row.id,inputs.item.id);assert.deepEqual(observation.row.data,(inputs.item.id===yes.id?yes:no).data);}
 const revision=await store.readRevision(),count=commits,history=await store.historyFor('NativeReceipts.Item',yes.id);
 const replay=await invoke(req);assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');assert.equal(replay.result.result,expected);
 assert.equal(commits,count);assert.equal(await store.readRevision(),revision);assert.deepEqual(await receiptFor(req),receipt);assert.deepEqual(await store.historyFor('NativeReceipts.Item',yes.id),history);
 const projected=await projectScenarioReceipt({receipt,registry:loaded.registry,policy:loaded.policy,app:'NativeReceipts',identity,store,memberships});
 assert.equal(projected.result,expected);assert.deepEqual(projected.records,[]);
 saved.push({req,receipt,expected});
}
// Initial validation/business refusal keeps the actual checked pipeline controls.
const failed=request('checked',{item:ref(no)}),denied=await invoke(failed);
assert.ok('error' in denied,JSON.stringify(denied));assert.equal(denied.error.code,'rule_failed');
assert.equal((await receiptFor(failed)).outcome.status,'rejected');
const invalid=request('input',{value:'not-an-int'}),bad=await invoke(invalid);
assert.ok('error' in bad,JSON.stringify(bad));assert.equal(bad.error.code,'validation');
// Current row changes cannot substitute for the genuinely saved scalar or rerun the handler.
const current=await store.load('NativeReceipts.Item',yes.id);
await committed(request('Item.update',{record:ref(current),value:'99'}));
const field=saved.find(value=>value.req.operation==='NativeReceipts.field');
const before={revision:await store.readRevision(),commits};
const replay=await invoke(field.req);assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');assert.equal(replay.result.result,'17');
assert.equal(commits,before.commits);assert.equal(await store.readRevision(),before.revision);
assert.equal((await projectScenarioReceipt({receipt:field.receipt,registry:loaded.registry,policy:loaded.policy,app:'NativeReceipts',identity,store,memberships})).result,'17');
// Revocation is checked by the released State projection over that exact native receipt.
await memberships.removeMembership(member.membership.membership_id);
for(const value of saved){assert.deepEqual(await projectScenarioReceipt({receipt:value.receipt,registry:loaded.registry,policy:loaded.policy,app:'NativeReceipts',identity,store,memberships}),{result:null,records:[]});}
assert.equal(commits,before.commits);assert.equal(await store.readRevision(),before.revision);
assert.equal(probe.outboxAll().length,0);
"#;
