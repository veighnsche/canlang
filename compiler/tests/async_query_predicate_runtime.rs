//! S9-Q02: source-owned async read predicate through canonical Memory invocation.
//! Predicate observers delegate once; fresh authorization never replays source.
#![cfg(unix)]

use std::{path::Path, process::Command};

#[test]
fn async_read_predicates_run_once_and_preserve_fresh_viewer_authorization() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let input = scratch.path().join("async-query-predicate.can");
    std::fs::write(&input, include_str!("fixtures/async_query_predicate.can")).unwrap();
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
const app='AsyncQueryPredicate',entry=`${app}.Entry`,probe=`${app}.Probe`,selected=`${app}.selected`;
const descriptor=artifact.operations.find(item=>item.name===selected);
assert.equal(descriptor.kind,'read');assert.deepEqual(descriptor.result,{type:`${entry}[]`});
// Observe only the installed records owner and its genuine emitted callback.
// Preserve native context/record references, callback receiver, Boolean result
// and thrown identity. The one scheduled membership change below is a real
// fixture-store revocation after the original query completes, not a provider.
const seamUrl=pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href;
const shim=resolve(base,'observed-stdlib.mjs');
writeFileSync(shim,`
export * from ${JSON.stringify(seamUrl)};
import {records as nativeRecords} from ${JSON.stringify(seamUrl)};
const log=event=>globalThis.asyncQueryTrace.push(event);
export async function records(...args){
 const [context,model,query]=args;
 log({kind:'records-call',context,model,query});
 if(typeof query?.where==='function'){
  const original=query.where;
  args[2]={...query,where:async function(...callbackArgs){
   const row=callbackArgs[0];log({kind:'predicate-call',row});
   try{
    const result=await original.apply(this,callbackArgs);
    log({kind:'predicate-return',row,result});return result;
   }catch(error){log({kind:'predicate-error',row,error});throw error;}
  }};
 }
 try{
  const rows=await nativeRecords(...args);
  log({kind:'records-return',context,model,rows});
  if(typeof query?.where==='function'&&globalThis.afterAsyncSelection){
   const action=globalThis.afterAsyncSelection;globalThis.afterAsyncSelection=undefined;await action();
  }
  return rows;
 }catch(error){log({kind:'records-error',context,model,error});throw error;}
}
`);
const asm=await assembleModules({artifact,sourcePath:resolve(base,'async-query-predicate.can')},{
 workDir:resolve(base,'modules'),stdlibUrl:pathToFileURL(shim).href,
 uiUrl:pathToFileURL(require.resolve('@canlang/ui')).href,
});
const {store}=createTestMemoryStorage(),memberships=createMemoryIdentityStore();
const member=await seedMember(memberships,{isOwner:false});
const identity=makeIdentity({membership:member.membership,email:member.user.email});
const invoker=buildInvoker(artifact,asm,store,{memberships,now:()=>FIXED_NOW});
const trace=[];globalThis.asyncQueryTrace=trace;let sequence=0;
async function mutate(operation,inputs,who=identity){
 return invoker.invokeMutation({operation,operation_id:uuidv7(FIXED_NOW,++sequence),inputs},who);
}
function committed(outcome){
 assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'committed');
 return outcome.result.result;
}
const probeRow=committed(await mutate(`${probe}.create`,{}));
const entries=[];
for(const [enabled,divisor] of [[false,'0'],[true,'2'],[true,'5']]){
 const row=committed(await mutate(`${entry}.create`,{enabled,divisor}));
 assert.equal(row.data.count,'0');entries.push(row);
}
const domain=[{model:probe,id:probeRow.id},...entries.map(row=>({model:entry,id:row.id}))];
async function snapshot(){
 return {revision:await store.readRevision(),
  rows:await Promise.all(domain.map(({model,id})=>store.load(asModel(model),asId(id)))),
  history:await Promise.all(domain.map(({model,id})=>store.historyFor(asModel(model),asId(id))))};
}
async function read(who=identity){trace.length=0;return invoker.invokeRead({operation:selected,inputs:{}},who);}
const completeKinds=[
 'records-call','predicate-call','predicate-return',
 'predicate-call','records-call','records-return','predicate-return',
 'predicate-call','records-call','records-return','predicate-return','records-return',
];
function completeSelection(empty=false){
 assert.deepEqual(trace.map(event=>event.kind),completeKinds,
  'every source predicate runs once; nested reads complete before inclusion; reauthorization does not replay source');
 const outer=trace[0];assert.equal(outer.model,entry);
 assert.equal(outer.query.where.constructor.name,'AsyncFunction');
 assert.equal(Object.hasOwn(outer.query,'order'),false,'source authors no structured ordering');
 const calls=trace.filter(event=>event.kind==='predicate-call');
 assert.deepEqual(calls.map(event=>event.row.id),entries.map(row=>row.id),'native Memory insertion scan visits seeded divisor 0, 2, 5');
 assert.deepEqual(calls.map(event=>event.row.divisor),[0n,2n,5n]);
 const returns=trace.filter(event=>event.kind==='predicate-return');
 assert.deepEqual(returns.map(event=>event.result),empty?[false,false,false]:[false,true,true]);
 for(let index=0;index<calls.length;index++)assert.equal(returns[index].row,calls[index].row);
 const nested=trace.filter(event=>event.kind==='records-call'&&event.model===probe);
 assert.equal(nested.length,2,'disabled first row short circuits eligible, including its nested query');
 for(const call of nested){assert.equal(call.context,outer.context);assert.deepEqual(call.query,{});}
 for(const returned of trace.filter(event=>event.kind==='records-return'&&event.model===probe)){
  assert.equal(returned.context,outer.context);assert.equal(returned.rows.length,empty?0:1);
  if(!empty)assert.equal(returned.rows[0].id,probeRow.id);
 }
 const returned=trace.at(-1);assert.equal(returned.model,entry);assert.equal(returned.context,outer.context);
 assert.deepEqual(returned.rows.map(row=>row.id),empty?[]:entries.slice(1).map(row=>row.id));
}
const before=await snapshot();
const success=await read();assert.ok('result' in success,JSON.stringify(success));
assert.deepEqual(success.result,{revision:before.revision,
 result:entries.slice(1).map(row=>({id:row.id,version:String(row.version)}))});
completeSelection();assert.deepEqual(await snapshot(),before,'successful read commits no domain effects or receipt');
// Actual CRUD changes the first candidate, using its current version. Its
// nested read must finish before native BigInt modulo-by-zero rejects.
const current=before.rows[1];
const updated=committed(await mutate(`${entry}.update`,{
 record:{id:current.id,version:String(current.version)},enabled:true,divisor:'0',
}));
assert.equal(updated.version,current.version+1);assert.equal(updated.data.enabled,true);
const preFailure=await snapshot();
const failed=await read();assert.ok('error' in failed,JSON.stringify(failed));assert.equal(failed.error.code,'rule_failed');
assert.deepEqual(trace.map(event=>event.kind),[
 'records-call','predicate-call','records-call','records-return','predicate-error','records-error',
],'first rejected predicate prevents all later predicates, nested reads and inclusion');
assert.equal(trace[0].model,entry);assert.equal(trace[1].row.id,entries[0].id);assert.equal(trace[1].row.divisor,0n);
assert.equal(trace[2].model,probe);assert.equal(trace[2].context,trace[0].context);
assert.equal(trace[3].model,probe);assert.equal(trace[3].rows.length,1);assert.equal(trace[3].rows[0].id,probeRow.id);
const arithmetic=trace[4].error;assert.ok(arithmetic instanceof RangeError);assert.match(arithmetic.message,/zero/i);
assert.equal(trace[5].error,arithmetic,'observers rethrow the original arithmetic object');
assert.equal(failed.error.message,arithmetic.message,'canonical public read retains the native diagnostic');
assert.deepEqual(await snapshot(),preFailure,'failed read preserves rows, versions, histories and receipt-free fence');
// Restore only the candidate through real CRUD, then revoke the real member
// after original predicates finish. Fresh viewer reauthorization must refuse
// that result while never re-entering source or changing the domain store.
const restored=committed(await mutate(`${entry}.update`,{
 record:{id:updated.id,version:String(updated.version)},enabled:false,
}));
assert.equal(restored.data.enabled,false);
const another=await seedMember(memberships,{teamId:member.team.team_id,isOwner:false});
const anotherIdentity=makeIdentity({membership:another.membership,email:another.user.email});
const beforeRevocation=await snapshot();
globalThis.afterAsyncSelection=()=>memberships.removeMembership(member.membership.membership_id);
const revoked=await read();assert.ok('error' in revoked,JSON.stringify(revoked));assert.equal(revoked.error.code,'forbidden');
completeSelection();assert.equal(globalThis.afterAsyncSelection,undefined);
assert.deepEqual(await snapshot(),beforeRevocation,'fresh grant refusal has no writes or read receipt');
// The other genuine member keeps this same team authorized after the first
// revocation. Real generated CRUD archives Probe; count(Probe) now observes
// an empty nested viewer domain, so all source candidates return false.
committed(await mutate(`${probe}.delete`,{
 record:{id:probeRow.id,version:String(probeRow.version)},
},anotherIdentity));
const beforeEmpty=await snapshot();
assert.notEqual(beforeEmpty.rows[0].archivedAt,null);
const empty=await read(anotherIdentity);assert.ok('result' in empty,JSON.stringify(empty));
assert.deepEqual(empty.result,{result:[],revision:beforeEmpty.revision});
completeSelection(true);assert.deepEqual(await snapshot(),beforeEmpty,'empty nested read commits no domain effects or receipt');
// Retain false candidates and the empty nested read through current-grant
// checking. Revocation after original evaluation must still reject the empty
// result without entering any original predicate a second time.
globalThis.afterAsyncSelection=()=>memberships.removeMembership(another.membership.membership_id);
const emptyRevoked=await read(anotherIdentity);
assert.ok('error' in emptyRevoked,JSON.stringify(emptyRevoked));assert.equal(emptyRevoked.error.code,'forbidden');
completeSelection(true);assert.equal(globalThis.afterAsyncSelection,undefined);
assert.deepEqual(await snapshot(),beforeEmpty,'empty-domain fresh grant refusal commits no domain effects or receipt');
console.log('async read predicate: once in native Memory scan order, short circuit, awaited nonempty and empty nested reads, first arithmetic failure and fresh member revocations passed');

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
