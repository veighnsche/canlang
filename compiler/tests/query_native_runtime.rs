//! Native public read and private finite-query child through actual CLI modules.
//! Run with the coherent native query publication and installed Dev dispatch unit.
#![cfg(unix)]

use std::{path::Path, process::Command};

const SOURCE: &str = r#"app QueryNative uses=[workbench]
package rent_catalog
 Given
  export Location {name:text}
  policy Location read=members
 When
  crud Location by=members fields=name
 Then
package todo
 use rent_catalog {Location}
 Given
  export Task {location:Location?,title:text,description:text?,due:datetime?,priority:enum(low,normal,high)=normal,done:bool=false}
  policy Task read=members
 When
  crud Task by=members fields=location,title,description,due,priority,done
 Then
package workbench
 use rent_catalog {Location}
 use todo {Task}
 Given
  contract Scope {targets:Task[]! min=1 max=10}
  export contract Fact {task:Task,version:int min=1,title:Task.title max=2000,description:Task.description max=8000,due:Task.due,priority:Task.priority,done:bool}
 When
  scenario context(location:Location,targets:Scope.targets) read=true -> Fact[] by=members
   require count(targets)>0
   do
    let visible=Task as task where task in targets and task.location==location
    require count(visible)==count(targets)
    return visible as task select Fact {task,version=task.version,title=task.title,description=task.description,due=task.due,priority=task.priority,done=task.done}
  scenario parent(location:Location,targets:Scope.targets,accept:bool) -> int by=members
   do
    call context {targets,location} as facts
    require accept
    return 1
 Then
"#;

#[test]
fn original_native_query_reads_and_unused_private_child_preserve_lifetimes() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let original = include_str!("../../draft/CanWorkbench.can");
    let retained: Vec<_> = SOURCE
        .lines()
        .filter(|line| {
            line.starts_with("    let visible=")
                || line.starts_with("    require count(visible)")
                || line.starts_with("    return visible")
        })
        .collect();
    assert_eq!(retained.len(), 3);
    for line in retained {
        assert!(original.lines().any(|authored| authored == line));
    }
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("query-native.can");
    std::fs::write(&input, SOURCE).unwrap();
    let compiled = Command::new(env!("CARGO_BIN_EXE_can"))
        .args([
            "compile",
            "--format=json",
            "--native-scenario-receipts",
            "--catalog",
        ])
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
    std::fs::write(scratch.path().join("native.json"), compiled.stdout).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(&runner, r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
assert.equal(Number(process.versions.node.split('.')[0]),24,'use the installed Node 24 runtime');
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
const operation=name=>artifact.operations.find(op=>op.name===name);
const context=operation('workbench.context'),parent=operation('workbench.parent');
assert.equal(context.kind,'read');assert.equal(context.result.type,'workbench.Fact[]');
assert.equal(parent.kind,'scenario');assert.equal(parent.result.type,'int');
const plan=context.result.disclosure;
assert.equal(plan.version,1);assert.equal(plan.queries.length,1);
assert.equal(plan.queries[0].model,'todo.Task');
assert.equal(plan.returns.length,1);
assert.equal(plan.returns[0].projection.kind,'query-contract-array');
assert.equal(plan.returns[0].projection.fields.length,7);
assert.equal(parent.result.disclosure.version,1);
const sourceHash=createHash('sha256').update(readFileSync(resolve(base,'query-native.can'))).digest('hex');
for(const op of [context,parent]){
 assert.equal(realpathSync(op.result.disclosure.source.path),realpathSync(resolve(base,'query-native.can')));
 assert.equal(op.result.disclosure.source.sha256,sourceHash);
 assert.equal(op.result.disclosure.source.module,artifact.callables.find(call=>call.id===op.name).module);
}
for(const [op,requireVersion] of [[context,false],[parent,true]]){
 const fields=op.inputs.fields,location=fields.find(field=>field.name==='location'),targets=fields.find(field=>field.name==='targets');
 assert.equal(location.required,true);assert.equal(location.field.model,'rent_catalog.Location');
 assert.equal(location.field.requireVersion,requireVersion);
 assert.equal(targets.required,false);assert.deepEqual(targets.array,{required:false});
 assert.equal(targets.min,1);assert.equal(targets.max,10);
 assert.equal(targets.field.model,'todo.Task');assert.equal(targets.field.requireVersion,requireVersion);
}
const js=artifact.modules.map(module=>module.js).join('\n');
for(const helper of ['executeScenarioReceiptQuery','observeScenarioReceiptQueryDependency','bindScenarioReceiptQueryResult','invokeScenarioReceiptCall'])assert.ok(js.includes(helper),helper);
// Transparent observations call only the installed canonical public facades.
// They supply no context, plan, candidate, session or definition of their own.
const seamUrl=pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
const shim=resolve(base,'observed-stdlib.mjs');
writeFileSync(shim,`
export * from ${JSON.stringify(seamUrl)};
import {executeScenarioReceiptQuery as query,invokeScenarioReceiptCall as call} from ${JSON.stringify(seamUrl)};
export async function executeScenarioReceiptQuery(...args){globalThis.nativeQueryTrace.push({kind:'query',queryId:args[1]});return await query(...args);}
export async function invokeScenarioReceiptCall(...args){globalThis.nativeQueryTrace.push({kind:'call',site:args[1],target:args[2],keys:Object.keys(args[3])});return await call(...args);}
`);
const asm=await assembleModules({artifact,sourcePath:resolve(base,'query-native.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(shim).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const entry=await import(asm.entryUrl);
assert.deepEqual(entry.canApp().operations,artifact.operations,'actual generated descriptor publication');
const loaded=await loadCanonicalDescriptors(asm,artifact);
const {store:backing,probe}=createTestMemoryStorage();
const batches=[];const store={...backing,commit:async batch=>{const result=await backing.commit(batch);batches.push(structuredClone(batch));return result;}};
const memberships=createMemoryIdentityStore(),member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
let sequence=0;const requests=[];
const request=(operation,inputs)=>{const req={operation,operation_id:uuidv7(FIXED_NOW,++sequence),inputs};requests.push(req);return req;};
const receiptFor=(req,who=identity)=>store.readReceipt({app:'QueryNative',owner:who.team.team_id,principal:who.actor.user_id,
 operation:req.operation,operationId:req.operation_id});
async function committed(req){const outcome=await invoker.invokeMutation(req,identity);assert.ok('result'in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'committed');return outcome.result;}
async function create(model,inputs){const result=await committed(request(`${model}.create`,inputs));assert.equal(result.result,null);assert.equal(result.records.length,1);return result.records[0];}
const ref=row=>({id:row.id,version:String(row.version)});
const location=await create('rent_catalog.Location',{name:'selected workplace'});
const otherLocation=await create('rent_catalog.Location',{name:'other workplace'});
const due='2031-03-04T05:06:07.000Z';
const one=await create('todo.Task',{location:ref(location),title:'first',description:null,due:null,priority:'high',done:false});
const two=await create('todo.Task',{location:ref(location),title:'second',description:'details',due,priority:'low',done:true});
const unselected=await create('todo.Task',{location:null,title:'unselected',description:null,due:null,priority:'normal',done:false});
const rows=[[location,'rent_catalog.Location'],[otherLocation,'rent_catalog.Location'],[one,'todo.Task'],[two,'todo.Task'],[unselected,'todo.Task']];
const ordered=await store.query({model:'todo.Task',authority:'owner',archived:'exclude'});
const selected=ordered.filter(row=>row.id===one.id||row.id===two.id);
assert.equal(selected.length,2);
const facts=selected.map(row=>({task:ref(row),version:String(row.version),title:row.data.title,
 description:row.data.description,due:row.data.due,priority:row.data.priority,done:row.data.done}));
const durable=async()=>({revision:await store.readRevision(),commits:batches.length,
 rows:await Promise.all(rows.map(([row,model])=>store.load(model,row.id))),
 history:await Promise.all(rows.map(([row,model])=>store.historyFor(model,row.id))),
 receipts:await Promise.all(requests.map(req=>receiptFor(req))),outbox:probe.outboxAll(),
 schedules:await store.schedulesDue(Number.MAX_SAFE_INTEGER,100)});
const domain=async()=>{const {rows,history,outbox,schedules}=await durable();return {rows,history,outbox,schedules};};
globalThis.nativeQueryTrace=[];
async function read(inputs,who=identity){
 const before=await durable();globalThis.nativeQueryTrace=[];
 const outcome=await invoker.invokeRead({operation:'workbench.context',inputs},who);
 assert.deepEqual(await durable(),before,'public native read leaves all durable state and receipts unchanged');return outcome;
}
const readInputs={location:{id:location.id},targets:[...selected].reverse().map(row=>({id:row.id}))};
const publicRead=await read(readInputs);
assert.ok('result'in publicRead,JSON.stringify(publicRead));
assert.deepEqual(publicRead.result,{result:facts,revision:await store.readRevision()},'full Fact[] follows query order rather than reversed supplied targets');
assert.deepEqual(globalThis.nativeQueryTrace,[{kind:'query',queryId:plan.queries[0].id}]);
const parentInputs={location:ref(location),targets:[...selected].reverse().map(ref),accept:true};
const success=request('workbench.parent',parentInputs),beforeParent=await durable();
globalThis.nativeQueryTrace=[];
const result=await committed(success);
assert.equal(result.result,'1');assert.deepEqual(result.records,[]);
assert.equal(await store.readRevision(),beforeParent.revision+1);assert.equal(batches.length,beforeParent.commits+1);
const receipt=await receiptFor(success);assert.equal(receipt.outcome.result,'1');
const association=readScenarioReceiptAssociation(receipt);assert.ok(association,'State-owned parent capture');
assert.deepEqual(association.plan,parent.result.disclosure);
assert.equal(association.calls.length,1);const child=association.calls[0];
assert.equal(child.caller,'workbench.parent');assert.equal(child.target,'workbench.context');
assert.deepEqual(JSON.parse(child.targetInterface),loaded.registry.get('workbench.context').descriptor);
assert.deepEqual(child.result,facts,'unused opaque child result retained privately');
assert.deepEqual(child.scenario.plan,plan);assert.equal(child.scenario.resultType,'workbench.Fact[]');
assert.equal(child.scenario.returnId,plan.returns[0].id);
assert.deepEqual(child.references.map(ref=>`${ref.model}:${ref.row.id}`).sort(),
 [`rent_catalog.Location:${location.id}`,`todo.Task:${one.id}`,`todo.Task:${two.id}`].sort());
const query=child.scenario.queries[0];assert.equal(query.queryId,plan.queries[0].id);
assert.equal(query.revision,beforeParent.revision);
assert.deepEqual(query.candidates.map(candidate=>candidate.record.id),ordered.map(row=>row.id));
assert.deepEqual(query.candidates.map(candidate=>candidate.matched),ordered.map(row=>row.id!==unselected.id));
assert.deepEqual(query.selectedIndices,ordered.flatMap((row,index)=>row.id===unselected.id?[]:[index]));
for(const candidate of query.candidates){
 assert.deepEqual(candidate.dependencies,candidate.matched?plan.queries[0].dependencies.map(dep=>dep.id):[],
  'false membership preserves skipped location/projection reads');
}
assert.deepEqual(globalThis.nativeQueryTrace,[{kind:'call',site:child.site,target:'workbench.context',keys:['targets','location']},
 {kind:'query',queryId:plan.queries[0].id}],'authored input order and single child query');
assert.equal(JSON.stringify(result).includes('scenario-result/v1'),false,'private receipt stays off public response');
assert.deepEqual(await domain(),{rows:beforeParent.rows,history:beforeParent.history,outbox:beforeParent.outbox,schedules:beforeParent.schedules});
assert.equal(batches.at(-1).receipt.identity.operation,'workbench.parent','child shares the one parent commit');
const stable=await durable();globalThis.nativeQueryTrace=[];
const replay=await invoker.invokeMutation(success,identity);
assert.ok('result'in replay,JSON.stringify(replay));assert.equal(replay.result.status,'replayed');
assert.equal(replay.result.result,'1');assert.deepEqual(replay.result.records,[]);
assert.deepEqual(await durable(),stable);assert.deepEqual(globalThis.nativeQueryTrace,[],'replay executes neither parent call nor child query');
assert.deepEqual(await projectScenarioReceipt({receipt,registry:loaded.registry,policy:loaded.policy,app:'QueryNative',identity,store,memberships}),{result:'1',records:[]});
async function rejectedParent(inputs,code,executed,who=identity){
 const req=request('workbench.parent',inputs),before=await durable();globalThis.nativeQueryTrace=[];
 const outcome=await invoker.invokeMutation(req,who);assert.ok('error'in outcome,JSON.stringify(outcome));assert.equal(outcome.error.code,code);
 assert.deepEqual(await domain(),{rows:before.rows,history:before.history,outbox:before.outbox,schedules:before.schedules},'refusal rolls back every domain effect');
 const rejected=await receiptFor(req,who);
 if(executed){assert.ok(rejected);assert.equal(rejected.outcome.status,'rejected');assert.equal(rejected.outcome.code,code);
  assert.equal(readScenarioReceiptAssociation(rejected),null);assert.equal(await store.readRevision(),before.revision+1);assert.equal(batches.length,before.commits+1);
  assert.equal(globalThis.nativeQueryTrace.filter(event=>event.kind==='query').length,1);
 }else{assert.equal(rejected,null);assert.equal(await store.readRevision(),before.revision);assert.equal(batches.length,before.commits);assert.deepEqual(globalThis.nativeQueryTrace,[]);}
 assert.deepEqual(await Promise.all(requests.slice(0,-1).map(req=>receiptFor(req))),before.receipts.slice(0,-1),'other receipts remain unchanged');
 const saved=await durable();globalThis.nativeQueryTrace=[];
 const repeated=await invoker.invokeMutation(req,who);assert.ok('error'in repeated);assert.equal(repeated.error.code,code);
 assert.deepEqual(await durable(),saved);assert.deepEqual(globalThis.nativeQueryTrace,[],'failed replay has no effects or child execution');
}
await rejectedParent({...parentInputs,accept:false},'rule_failed',true);
await rejectedParent({...parentInputs,targets:[ref(one),ref(one)]},'rule_failed',true);
await rejectedParent({...parentInputs,location:ref(otherLocation)},'rule_failed',true);
await rejectedParent({...parentInputs,targets:[]},'validation',false);
await rejectedParent({...parentInputs,targets:Array.from({length:11},()=>ref(one))},'validation',false);
await rejectedParent({...parentInputs,location:{id:location.id}},'validation',false);
for(const [inputs,code] of [
 [{...readInputs,location:{id:otherLocation.id}},'rule_failed'],
 [{...readInputs,targets:[{id:one.id},{id:one.id}]},'rule_failed'],
 [{...readInputs,targets:[{id:unselected.id}]},'rule_failed'],
 [{...readInputs,targets:[]},'validation'],
 [{...readInputs,targets:Array.from({length:11},()=>({id:one.id}))},'validation'],
]){const refusal=await read(inputs);assert.ok('error'in refusal);assert.equal(refusal.error.code,code);}
const outsider=makeIdentity({userId:'nonmember',team:member.team,membership:null});
const forbidden=await read(readInputs,outsider);assert.ok('error'in forbidden);assert.equal(forbidden.error.code,'forbidden');assert.deepEqual(globalThis.nativeQueryTrace,[]);
await rejectedParent(parentInputs,'forbidden',false,outsider);
await memberships.removeMembership(member.membership.membership_id);
const revoked=await read(readInputs);assert.ok('error'in revoked);assert.equal(revoked.error.code,'forbidden');assert.deepEqual(globalThis.nativeQueryTrace,[]);
await rejectedParent(parentInputs,'forbidden',false);
const beforeRevokedReplay=await durable();globalThis.nativeQueryTrace=[];
const revokedReplay=await invoker.invokeMutation(success,identity);assert.ok('result'in revokedReplay,JSON.stringify(revokedReplay));
assert.equal(revokedReplay.result.status,'replayed');assert.equal(revokedReplay.result.result,null);assert.deepEqual(revokedReplay.result.records,[],
 'saved identity remains replayable while current membership withholds disclosure');
const retainedReplay=await invoker.invokeRetainedMutation(success,identity);assert.ok('error'in retainedReplay,JSON.stringify(retainedReplay));assert.equal(retainedReplay.error.code,'forbidden');
assert.deepEqual(await durable(),beforeRevokedReplay);assert.deepEqual(globalThis.nativeQueryTrace,[]);
assert.deepEqual(await projectScenarioReceipt({receipt,registry:loaded.registry,policy:loaded.policy,app:'QueryNative',identity,store,memberships}),{result:null,records:[]});
console.log('native original query: public ordered read, private unused child, real receipt replay, rollback, bounds, references and live authority passed');
"#).unwrap();
    let executed = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
