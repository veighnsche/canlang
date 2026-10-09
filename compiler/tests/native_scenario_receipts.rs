//! Opt-in native capture through unchanged CLI output and installed owners.
//! Actual public ordinary and retained transports project State-owned saved associations.
#![cfg(unix)]
use serde_json::Value;
use std::{path::Path, process::Command};
const LIBRARY: &str = r#"package receiptlib
 Given
  export Shared {value:int}
  policy Shared read=members
  export derive caption(shared:Shared):int = shared.value
 When
  crud Shared by=members fields=value
 Then
"#;
const SOURCE: &str = r#"app NativeReceipts
use receiptlib {Shared,caption}
Given
 Item {value:int,enabled:bool,optional:int?,state:enum(a,b)=a,values:int[]?,required:int[]!}
 Machine {state:enum(idle,queued,ready)=idle machine}
 contract Packet {value:int}
 policy Item read=members
 derive value(item:Item):int = item.value
 derive nested_value(item:Item):int = value(item)+1
 derive difference(first:int,second:int):int = first-second
 derive default_value(item:Item,total:int=item.value):int = total
 derive fallback_value(item:Item):int = item.optional ?? value(item)
 derive enabled(item:Item):bool = item.enabled
 derive choice(value:Item.state):Item.state = value
When
 crud Item by=members fields=value,enabled,optional,values,required
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
 scenario named_result(value:Item.state) -> Item.state by=members
  do return value
 scenario arrays(values:int[]?) -> int[]? by=members
  do return values
 scenario stored_array(item:Item) -> int[]? by=members
  do return item.values
 scenario literal_array(item:Item) -> int[] by=members
  do return [item.value,item.optional ?? item.value]
 scenario required_array(item:Item) -> int[] by=members
  do return item.required
 scenario composite(value:Packet[]) -> Packet[] by=members
  do return value
 scenario model_array(value:Item[]) -> Item[] by=members
  do return value
 scenario model(item:Item) -> Item by=members
  do return item
 scenario derived(item:Item) -> int by=members
  do return value(item)
 scenario imported(shared:Shared) -> int by=members
  do return caption(shared)
 scenario nested(item:Item) -> int by=members
  do return nested_value(item)
 scenario repeated(item:Item) -> int by=members
  do return value(item)+value(item)
 scenario reordered(item:Item) -> int by=members
  do return difference(second=value(item),first=fallback_value(item))
 scenario derived_default(item:Item) -> int by=members
  do return default_value(item)
 scenario derived_override(item:Item) -> int by=members
  do return default_value(item,total=42)
 scenario derived_lazy(item:Item) -> int by=members
  do
   let selected=fallback_value(item)
   if enabled(item)
    return selected
   else
    return selected
 scenario derived_match(item:Item,selected:Item.state) -> int by=members
  do
   match choice(selected)
    case a
     return value(item)
    case b
     return nested_value(item)
 scenario machine_read(job:Machine) -> bool by=members
  do return job.state==idle
 scenario machine(job:Machine) by=members
  do
   transition job.state idle -> queued
   transition job.state queued -> ready
 scenario changed(item:Item) -> int by=members
  do
   set item {value=2}
   return 1
Then
"#;
fn compile(scratch: &Path, native: bool) -> Value {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let source = scratch.join("native-receipts.can");
    let library = scratch.join("receiptlib.can");
    std::fs::write(&source, SOURCE).unwrap();
    std::fs::write(&library, LIBRARY).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_can"));
    command
        .args(["compile", "--format=json", "--catalog"])
        .arg(root.join("packages/values/dist/catalog.json"));
    if native {
        command.arg("--native-scenario-receipts");
    }
    let output = command
        .arg(source)
        .arg(library)
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
        "arrays",
        "stored_array",
        "literal_array",
        "named_result",
        "derived",
        "imported",
        "nested",
        "repeated",
        "reordered",
        "derived_default",
        "derived_override",
        "derived_lazy",
        "derived_match",
        "machine",
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
    let imported = &operation(&artifact, "imported")["result"]["disclosure"];
    let imported_origin = &imported["returns"][0]["dependencies"][0]["source"];
    assert!(
        imported_origin["path"]
            .as_str()
            .unwrap()
            .ends_with("receiptlib.can")
    );
    assert_ne!(imported_origin["path"], imported["source"]["path"]);
    assert_ne!(imported_origin["sha256"], imported["source"]["sha256"]);
    for name in [
        "query",
        "absent",
        "composite",
        "model_array",
        "required_array",
        "model",
        "changed",
        "machine_read",
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
const {StateError}=await load('@canlang/state/errors');
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
const yes=await create({value:'17',enabled:true,optional:null,values:null,required:[]});
const no=await create({value:'-3',enabled:false,optional:'9',values:[],required:[]});
const populated=await create({value:'5',enabled:true,optional:null,values:['9223372036854775807','-2'],required:[]});
const sharedRequest={...request('unused',{value:'23'}),operation:'receiptlib.Shared.create'};
const sharedResult=await committed(sharedRequest);assert.equal(sharedResult.records.length,1);
const shared=sharedResult.records[0];
const rows=new Map([yes,no,populated,shared].map(row=>[row.id,row]));
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
 ['arrays',{values:null},null,[]],['arrays',{values:[]},[],[]],['arrays',{values:['9223372036854775807','-2']},['9223372036854775807','-2'],[]],
 ['stored_array',{item:ref(yes)},null,['values']],['stored_array',{item:ref(no)},[],['values']],['stored_array',{item:ref(populated)},['9223372036854775807','-2'],['values']],
 ['literal_array',{item:ref(yes)},['17','17'],['value','optional']],['literal_array',{item:ref(no)},['-3','9'],['value','optional']],
 ['named_result',{value:'a'},'a',[]],['named_result',{value:'b'},'b',[]],
 ['derived',{item:ref(yes)},'17',['value']],['imported',{shared:ref(shared)},'23',['value']],
 ['nested',{item:ref(yes)},'18',['value']],['repeated',{item:ref(yes)},'34',['value']],
 ['reordered',{item:ref(yes)},'0',['value','optional']],['reordered',{item:ref(no)},'12',['value','optional']],
 ['derived_default',{item:ref(yes)},'17',['value']],['derived_override',{item:ref(yes)},'42',[]],
 ['derived_lazy',{item:ref(yes)},'17',['optional','value','enabled']],['derived_lazy',{item:ref(no)},'9',['optional','enabled']],
 ['derived_match',{item:ref(yes),selected:'a'},'17',['value']],['derived_match',{item:ref(yes),selected:'b'},'18',['value']],
]){
 const req=request(name,inputs),result=await committed(req),receipt=await receiptFor(req);
 assert.deepEqual(result.result,expected);assert.deepEqual(receipt.outcome.result,expected);
 assert.equal(JSON.stringify(result).includes('scenario-result/v1'),false,'association metadata remains private');
 const association=readScenarioReceiptAssociation(receipt);assert.ok(association,'native State-owned capture');
 const descriptor=artifact.operations.find(op=>op.name===req.operation);
 assert.deepEqual(association.plan,descriptor.result.disclosure);
 const path=association.plan.returns.find(value=>value.id===association.returnId);assert.ok(path);
 assert.deepEqual([...new Set(path.dependencies.map(dep=>dep.field))].sort(),[...fields].sort());
 assert.deepEqual([...association.observations.map(observation=>observation.dependencyId)].sort(),[...path.dependencies.map(dep=>dep.id)].sort());
 assert.deepEqual(association.changed,[]);
 if(name==='literal_array'){
  assert.deepEqual(association.observations.map(observation=>observation.dependencyId),path.dependencies.map(dep=>dep.id),'actual left-to-right marker sequence');
  const ordered=path.dependencies.map(dep=>dep.field);assert.equal(ordered[0],'value');
  assert.equal(ordered[1],'optional');
  assert.equal(ordered.filter(field=>field==='value').length,inputs.item.id===yes.id?2:1,'fallback read remains lazy');
 }
 if(name==='stored_array')assert.equal(path.dependencies[0].type,'int[]?');
 if(name==='reused')assert.equal(new Set(path.dependencies.map(dep=>dep.field)).size,1,'one checked field reused across data/control');
 if(['derived','imported','nested','repeated','reordered','derived_default','derived_override','derived_lazy','derived_match'].includes(name)){
  assert.deepEqual(association.observations.map(observation=>observation.dependencyId),path.dependencies.map(dep=>dep.id),'derive markers preserve actual evaluation chronology');
 }
 if(name==='repeated'){
  assert.equal(path.dependencies.length,2,'two calls read the same defining callee member twice');
  assert.notEqual(path.dependencies[0].id,path.dependencies[1].id,'checked callchains distinguish repeated callee sites');
  assert.equal(new Set(association.observations.map(observation=>observation.dependencyId)).size,2);
 }
 if(name==='reordered'){
  assert.deepEqual(path.dependencies.map(dep=>dep.field),inputs.item.id===yes.id?['value','optional','optional','value']:['value','optional','optional'],'source arguments execute before declaration-slot reorder');
 }
 if(name==='derived_default')assert.equal(path.dependencies.length,1,'omitted source default evaluates one stored read');
 if(name==='derived_override')assert.deepEqual(association.observations,[],'explicit argument skips the source default');
 if(name==='derived_lazy')assert.equal(path.dependencies.filter(dep=>dep.field==='value').length,inputs.item.id===yes.id?1:0,'derive fallback keeps its RHS lazy');
 for(const observation of association.observations){const input=name==='imported'?inputs.shared:inputs.item;assert.equal(observation.model,name==='imported'?'receiptlib.Shared':'NativeReceipts.Item');assert.equal(observation.row.id,input.id);assert.deepEqual(observation.row.data,rows.get(input.id).data);}
 const revision=await store.readRevision(),count=commits,history=await store.historyFor('NativeReceipts.Item',yes.id);
 const replay=await invoke(req);assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');assert.deepEqual(replay.result.result,expected);
 assert.equal(commits,count);assert.equal(await store.readRevision(),revision);assert.deepEqual(await receiptFor(req),receipt);assert.deepEqual(await store.historyFor('NativeReceipts.Item',yes.id),history);
 const projected=await projectScenarioReceipt({receipt,registry:loaded.registry,policy:loaded.policy,app:'NativeReceipts',identity,store,memberships});
 assert.deepEqual(projected.result,expected);assert.deepEqual(projected.records,[]);
 saved.push({req,receipt,expected});
}
// Initial validation/business refusal keeps the actual checked pipeline controls.
const failed=request('checked',{item:ref(no)}),denied=await invoke(failed);
assert.ok('error' in denied,JSON.stringify(denied));assert.equal(denied.error.code,'rule_failed');
assert.equal((await receiptFor(failed)).outcome.status,'rejected');
const invalid=request('input',{value:'not-an-int'}),bad=await invoke(invalid);
assert.ok('error' in bad,JSON.stringify(bad));assert.equal(bad.error.code,'validation');
// Current row changes cannot substitute for the genuinely saved scalar or rerun the handler.
for(const values of [42,{},['not-int'],[null],['1',null]]){
 const req=request('arrays',{values}),before=await store.readRevision(),result=await invoke(req);
 assert.ok('error' in result,JSON.stringify(result));assert.equal(result.error.code,'validation');
 if(Array.isArray(values)){
  const receipt=await receiptFor(req);assert.equal(receipt.outcome.status,'rejected');assert.equal(receipt.outcome.code,'validation');assert.equal(await store.readRevision(),before+1);
 }else{assert.equal(await receiptFor(req),null,'nonarray native inputs refuse before State admission');assert.equal(await store.readRevision(),before);}
}
const current=await store.load('NativeReceipts.Item',yes.id);
await committed(request('Item.update',{record:ref(current),value:'99',values:['8','9']}));
const arrayCurrent=await store.load('NativeReceipts.Item',populated.id);
await committed(request('Item.update',{record:ref(arrayCurrent),values:['11']}));
const field=saved.find(value=>value.req.operation==='NativeReceipts.field');
const before={revision:await store.readRevision(),commits};
const replay=await invoke(field.req);assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');assert.equal(replay.result.result,'17');
assert.equal(commits,before.commits);assert.equal(await store.readRevision(),before.revision);
assert.equal((await projectScenarioReceipt({receipt:field.receipt,registry:loaded.registry,policy:loaded.policy,app:'NativeReceipts',identity,store,memberships})).result,'17');
const originalArray=saved.find(value=>value.req.operation==='NativeReceipts.stored_array'&&value.req.inputs.item.id===populated.id);
const originalDerived=saved.find(value=>value.req.operation==='NativeReceipts.nested');
const derivedReplay=await invoke(originalDerived.req);assert.ok('result' in derivedReplay,JSON.stringify(derivedReplay));
assert.equal(derivedReplay.result.status,'replayed');assert.equal(derivedReplay.result.result,'18','nested derive does not reread the current value 99');
const arrayReplay=await invoke(originalArray.req);assert.ok('result' in arrayReplay,JSON.stringify(arrayReplay));
assert.equal(arrayReplay.result.status,'replayed');assert.deepEqual(arrayReplay.result.result,['9223372036854775807','-2']);
assert.deepEqual(readScenarioReceiptAssociation(await receiptFor(originalArray.req)).observations[0].row.data.values,['9223372036854775807','-2']);
assert.deepEqual((await projectScenarioReceipt({receipt:originalArray.receipt,registry:loaded.registry,policy:loaded.policy,app:'NativeReceipts',identity,store,memberships})).result,['9223372036854775807','-2']);
assert.equal(commits,before.commits);assert.equal(await store.readRevision(),before.revision);
// Dedicated recovery uses the actual public entry with no writable or file capability.
let retainedCommits=0,fileReads=0;
const readonlyStore={...store,commit:async()=>{retainedCommits++;throw new Error('retained commit tripwire');}};
const fileTripwire=new Proxy({},{get(){fileReads++;throw new Error('retained file metadata tripwire');}});
const retainedInvoker=buildInvoker(artifact,asm,readonlyStore,{memberships,now:()=>FIXED_NOW+16*60000,files:fileTripwire});
const retainedCases=[field,originalArray,originalDerived];
const snapshot=async()=>({receipts:await Promise.all(retainedCases.map(value=>receiptFor(value.req))),
 revision:await store.readRevision(),rows:await store.query({model:'NativeReceipts.Item',authority:'owner',archived:'include'}),
 history:await Promise.all([yes,no,populated].map(row=>store.historyFor('NativeReceipts.Item',row.id))),
 outbox:probe.outboxAll(),schedules:await store.schedulesDue(Number.MAX_SAFE_INTEGER,100)});
let retainedBefore=await snapshot();
for(const value of retainedCases){
 const replay=await retainedInvoker.invokeRetainedMutation(value.req,identity);
 assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');
 assert.deepEqual(replay.result.result,value.expected);assert.deepEqual(replay.result.records,[]);
 assert.equal(JSON.stringify(replay).includes('scenario-result/v1'),false,'dedicated output excludes association');
}
assert.deepEqual(await snapshot(),retainedBefore);assert.equal(retainedCommits,0);assert.equal(fileReads,0);
// Existing storage seam: reject the actual observation load after one admission load.
const failure=new StateError('validation','native array observation refused');let targetLoads=0;
const faultStore={...store,load:async(model,id)=>{
 if(model==='NativeReceipts.Item'&&id===yes.id&&++targetLoads===2)throw failure;
 return store.load(model,id);
}};
const faultInvoker=buildInvoker(artifact,asm,faultStore,{memberships,now:()=>FIXED_NOW});
const live=await store.load('NativeReceipts.Item',yes.id),faultRequest=request('literal_array',{item:ref(live)});
const effectsBefore={row:live,history:await store.historyFor('NativeReceipts.Item',yes.id),outbox:probe.outboxAll()};
const refused=await faultInvoker.invokeMutation(faultRequest,identity);
assert.ok('error' in refused,JSON.stringify(refused));assert.equal(refused.error.code,'validation');
assert.equal(targetLoads,2,'first observation rejection starts no later observation');
const rejected=await receiptFor(faultRequest);assert.equal(rejected.outcome.status,'rejected');
assert.equal(readScenarioReceiptAssociation(rejected),null,'no selected successful association');
assert.deepEqual(await store.load('NativeReceipts.Item',yes.id),effectsBefore.row);
assert.deepEqual(await store.historyFor('NativeReceipts.Item',yes.id),effectsBefore.history);
assert.deepEqual(probe.outboxAll(),effectsBefore.outbox);
// This does not claim instrumentation of unobserved pure element evaluation.
// Real generated CRUD archive changes current lifetime; public transports withhold saved values.
for(const row of [yes,populated]){
 const current=await store.load('NativeReceipts.Item',row.id);
 await committed(request('Item.delete',{record:ref(current)}));
 assert.notEqual((await store.load('NativeReceipts.Item',row.id)).archivedAt,null);
}
retainedBefore=await snapshot();
for(const value of retainedCases){
 for(const dedicated of [false,true]){
  const replay=await (dedicated?retainedInvoker.invokeRetainedMutation(value.req,identity):invoke(value.req));
  assert.ok('result' in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');
  assert.equal(replay.result.result,null);assert.deepEqual(replay.result.records,[]);
  assert.equal(JSON.stringify(replay).includes('scenario-result/v1'),false);
 }
}
assert.deepEqual(await snapshot(),retainedBefore);assert.equal(retainedCommits,0);assert.equal(fileReads,0);
const afterArchive={revision:await store.readRevision(),commits};
// Revocation is checked by the released State projection over that exact native receipt.
await memberships.removeMembership(member.membership.membership_id);
for(const value of saved){assert.deepEqual(await projectScenarioReceipt({receipt:value.receipt,registry:loaded.registry,policy:loaded.policy,app:'NativeReceipts',identity,store,memberships}),{result:null,records:[]});}
for(const value of retainedCases){
 const denied=await retainedInvoker.invokeRetainedMutation(value.req,identity);
 assert.ok('error' in denied,JSON.stringify(denied));assert.equal(denied.error.code,'forbidden');
 assert.equal(JSON.stringify(denied).includes('scenario-result/v1'),false);
}
assert.deepEqual(await snapshot(),retainedBefore);assert.equal(retainedCommits,0);assert.equal(fileReads,0);
assert.equal(commits,afterArchive.commits);assert.equal(await store.readRevision(),afterArchive.revision);
assert.equal(probe.outboxAll().length,0);
"#;
