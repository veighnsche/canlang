//! One source-owned bounded query loop through canonical Memory invocation.
//! Observers delegate to installed owners; provisional writes must roll back.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn bounded_query_writes_await_in_domain_order_and_roll_back_atomically() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("bounded-query-rollback.can");
    std::fs::write(&input, include_str!("fixtures/bounded_query_rollback.can")).unwrap();
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
    std::fs::write(scratch.path().join("artifact.json"), compiled.stdout).unwrap();
    let runner = scratch.path().join("execute.mjs");
    std::fs::write(
        &runner,
        r#"
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const base=dirname(fileURLToPath(import.meta.url)),root=process.argv[2];
const require=createRequire(resolve(root,'package.json'));
const load=specifier=>import(pathToFileURL(require.resolve(specifier)));
const {assembleModules}=await load('@canlang/cloudflare/runtime/modules');
const {buildInvoker}=await load('@canlang/cloudflare/worker/assembly');
const {createTestMemoryStorage}=await load('@canlang/state/storage/memory');
const {FIXED_NOW,asId,asModel,createMemoryIdentityStore,seedMember,makeIdentity,uuidv7}=await load('@canlang/state/testing/invocation/fixtures');
const artifact=JSON.parse(readFileSync(resolve(base,'artifact.json'),'utf8'));
const model='BoundedQueryRollback.Entry',operation='BoundedQueryRollback.sweep';
assert.equal(artifact.operations.find(entry=>entry.name===operation).kind,'scenario');
// Native records(c,model,query) returns operation-bound native views. Native
// set(c,record,patch) consumes those same views. Keep their identity intact;
// observers neither construct bindings nor substitute reads or writes.
const seamUrl=pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
const shim=resolve(base,'observed-stdlib.mjs');
writeFileSync(shim,`
export * from ${JSON.stringify(seamUrl)};
import {records as nativeRecords,set as nativeSet,require as nativeRequire} from ${JSON.stringify(seamUrl)};
export async function records(...args){
 globalThis.boundedQueryTrace.push({kind:'records-call',model:args[1],query:args[2]});
 const rows=await nativeRecords(...args);
 globalThis.boundedQueryTrace.push({kind:'records-return',rows});return rows;
}
export async function set(...args){
 globalThis.boundedQueryTrace.push({kind:'set-call',record:args[1],patch:{...args[2]},before:args[1].count});
 const row=await nativeSet(...args);
 globalThis.boundedQueryTrace.push({kind:'set-return',record:args[1],row,count:row.count});return row;
}
function check(...args){globalThis.boundedQueryTrace.push({kind:'require',condition:args[0],code:args[1]});return nativeRequire(...args);}
export {check as require};
`);
const asm=await assembleModules({artifact,sourcePath:resolve(base,'bounded-query-rollback.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(shim).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
const trace=[];globalThis.boundedQueryTrace=trace;let sequence=0,lastRequest;
const envelope=(name,inputs)=>({operation:name,operation_id:uuidv7(FIXED_NOW,++sequence),inputs});
async function invoke(name,inputs){trace.length=0;lastRequest=envelope(name,inputs);return invoker.invokeMutation(lastRequest,identity);}
function committed(outcome){assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'committed');return outcome.result.result;}
function rejected(outcome,code){assert.ok('error' in outcome,JSON.stringify(outcome));assert.equal(outcome.error.code,code);}
const ids=[];
async function create(){
 const row=committed(await invoke(`${model}.create`,{}));
 assert.equal(row.data.count,'0');assert.equal(row.version,1);ids.push(row.id);
}
// Read-only storage inspection includes wire rows, versions, per-row history
// and the global fence revision. Native rejected receipts advance that fence
// while the provisional domain rows, versions and history remain unchanged.
async function snapshot(){
 return {revision:await store.readRevision(),rows:await Promise.all(ids.map(id=>store.load(asModel(model),asId(id)))),
  history:await Promise.all(ids.map(id=>store.historyFor(asModel(model),asId(id))))};
}
async function rejectedReceipt(before,after,code){
 assert.deepEqual(after.rows,before.rows,'rejection preserves domain rows and versions');
 assert.deepEqual(after.history,before.history,'rejection preserves domain history');
 const receipt=await store.readReceipt({app:'BoundedQueryRollback',owner:identity.team.team_id,
  principal:identity.actor.user_id,operation:lastRequest.operation,operationId:lastRequest.operation_id});
 assert.ok(receipt,'canonical rejection persists its native receipt');
 assert.equal(receipt.outcome.status,'rejected');assert.equal(receipt.outcome.code,code);
 assert.deepEqual(receipt.resolvedDefaults,{});
 assert.equal(after.revision,before.revision+1,'rejected receipt advances the global fence once');
 assert.equal(receipt.committedRevision,after.revision);
}
function loopTrace(accept){
 const calls=trace.filter(event=>event.kind==='records-call');assert.equal(calls.length,1);
 assert.equal(calls[0].model,model);assert.deepEqual(calls[0].query,{});
 const returns=trace.filter(event=>event.kind==='records-return');assert.equal(returns.length,1);
 const domain=returns[0].rows;assert.equal(domain.length,2);
 const bound=trace.findIndex(event=>event.kind==='require'&&event.code==='limit');
 assert.ok(bound>trace.indexOf(returns[0]),'bound follows completed domain fetch');
 assert.equal(trace[bound].condition,true);
 const body=trace.slice(bound+1);
 assert.deepEqual(body.map(event=>event.kind),['set-call','set-return','set-call','set-return','require']);
 for(let index=0;index<domain.length;index++){
  const call=body[index*2],returned=body[index*2+1];
  assert.equal(call.record,domain[index],'write follows returned domain identity/order');
  assert.deepEqual(call.patch,{count:call.before+1n});
  assert.equal(returned.record,domain[index]);assert.equal(returned.count,call.before+1n);
 }
 assert.equal(body.at(-1).condition,accept,'authored guard follows all completed writes');
 return body.filter(event=>event.kind==='set-call').map(event=>event.record.id);
}
await create();await create();assert.notEqual(ids[0],ids[1]);
const before=await snapshot();
// Both native writes finish in the provisional overlay before authored failure.
rejected(await invoke(operation,{accept:false}),'rule_failed');loopTrace(false);
const rolledBack=await snapshot();await rejectedReceipt(before,rolledBack,'rule_failed');
// The same owning loop commits both writes once in the returned-domain order.
assert.equal(committed(await invoke(operation,{accept:true})),true);
const writeOrder=loopTrace(true);assert.deepEqual([...writeOrder].sort(),[...ids].sort());
const after=await snapshot();assert.equal(after.revision,rolledBack.revision+1);
for(let index=0;index<ids.length;index++){
 assert.equal(after.rows[index].data.count,'1');assert.equal(after.rows[index].version,before.rows[index].version+1);
 assert.deepEqual(after.history[index].slice(0,-1),before.history[index]);
 assert.equal(after.history[index].length,before.history[index].length+1);
}
// A third admitted row makes the whole domain overflow: fetch once, reject
// the generated bound before any write, and preserve the committed domain.
await create();const crowded=await snapshot();
const overflowOutcome=await invoke(operation,{accept:true});
rejected(overflowOutcome,'rule_failed');
assert.equal(overflowOutcome.error.message,'limit','generated bound retains its diagnostic');
const fetched=trace.filter(event=>event.kind==='records-return');assert.equal(fetched.length,1);
assert.equal(trace.filter(event=>event.kind==='records-call').length,1);
assert.equal(fetched[0].rows.length,3);
const overflow=trace.findIndex(event=>event.kind==='require'&&event.code==='limit');
assert.ok(overflow>trace.indexOf(fetched[0]));assert.equal(trace[overflow].condition,false);
assert.equal(trace.filter(event=>event.kind==='set-call'||event.kind==='set-return').length,0);
assert.equal(overflow,trace.length-1,'failed bound precedes authored guard');
await rejectedReceipt(crowded,await snapshot(),'rule_failed');
console.log('bounded query rollback: one fetch, pre-write bound, awaited ordered native writes, rollback and commit passed');
"#,
    )
    .unwrap();
    let executed = Command::new("node").arg(runner).arg(root).output().unwrap();
    assert!(
        executed.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&executed.stdout),
        String::from_utf8_lossy(&executed.stderr)
    );
}
