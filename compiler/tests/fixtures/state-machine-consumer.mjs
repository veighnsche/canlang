import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const [root, artifactPath, scratch] = process.argv.slice(2);
const load = path => import(pathToFileURL(resolve(root, path)).href);
const { loadArtifactFile } = await load('packages/cloudflare/dist/runtime/artifact.js');
const { assembleModules } = await load('packages/cloudflare/dist/runtime/modules.js');
const { buildInvoker } = await load('packages/cloudflare/dist/worker/assembly.js');
const { createTestMemoryStorage } = await load('packages/state/dist/src/storage/memory.js');
const { readScenarioReceiptAssociation } = await load('packages/state/dist/src/invocation/index.js');
const { renderPage } = await load('packages/ui/dist/src/shell.js');
const { DEFAULT_THEME } = await load('packages/contracts/dist/index.js');
const loaded = loadArtifactFile(artifactPath);
const artifact = loaded.artifact;
assert.deepEqual(artifact.models[0].fields.find(f=>f.name==='status').machine, {
 initial:'idle', states:['idle','queued','generating','ready','failed'], transitions:[
  {from:'idle',to:'queued',operation:'Images.advance'},
  {from:'queued',to:'generating',operation:'Images.advance'},
  {from:'generating',to:'ready',operation:'Images.finish'},
  {from:'idle',to:'queued',operation:'Images.rollback'},
  {from:'generating',to:'ready',operation:'Images.branch'},
  {from:'generating',to:'failed',operation:'Images.branch'},
  {from:'idle',to:'ready',operation:'Images.defaults'},
  {from:'idle',to:'ready',operation:'Images.optional'},
  {from:'idle',to:'ready',operation:'Images.optional_scalar'},
 ]
});
assert.ok(artifact.requires.some(r=>r.capability==='state.machines'&&r.min_version===1));
assert.equal(artifact.callables.find(c=>c.id==='Images.advance').inputStyle,'parameters');
const asm = await assembleModules(loaded, { workDir:resolve(scratch,'modules'),
 stdlibUrl:pathToFileURL(resolve(root,'packages/cloudflare/dist/runtime/stdlib.js')).href,
 uiUrl:pathToFileURL(resolve(root,'packages/ui/dist/src/index.js')).href });
const {store} = createTestMemoryStorage();
const now = Date.now();
const identity = { actor:null, team:null, membership:null, binding:{kind:'none'}, admitted_at:new Date(now).toISOString() };
const memberships = { findMembership:async()=>null };
const invoker = buildInvoker(artifact, asm, store, {memberships,now:()=>now});
// Canonical UUIDv7 at this test's frozen time.
const operationId = () => { const t=now.toString(16).padStart(12,'0'), r=randomUUID().replaceAll('-','');return `${t.slice(0,8)}-${t.slice(8)}-7${r.slice(0,3)}-8${r.slice(4,7)}-${r.slice(8,20)}`; };
async function invoke(operation,inputs,id=operationId()) { return invoker.invokeMutation({operation,operation_id:id,inputs},identity); }
function createdRecord(outcome) {
 assert.ok('result' in outcome,JSON.stringify(outcome));
 assert.equal(outcome.result.status,'committed');
 assert.equal(outcome.result.result,null);
 assert.equal(outcome.result.records.length,1);
 const row=outcome.result.records[0];
 assert.deepEqual(Object.keys(row).sort(),['archivedAt','created','createdBy','data','id','parent','updated','updatedBy','version']);
 assert.equal(typeof row.id,'string');assert.ok(row.id.length>0);
 assert.equal(row.version,1);
 return row;
}
const created = await invoke('Images.Job.create',{});
const row = createdRecord(created);
assert.equal(row.data.status,'idle');
const envelopeId=operationId();
const input={job:{id:row.id,version:String(row.version)}};
const advanced=await invoke('Images.advance',input,envelopeId);
assert.ok('result' in advanced,JSON.stringify(advanced));
assert.equal(advanced.result.status,'committed');
assert.equal((await store.load('Images.Job',row.id)).data.status,'generating');
assert.equal((await store.load('Images.Job',row.id)).version,2,'two transitions reserve one transaction version');
const receiptIdentity={app:'Images',owner:'app',principal:'public',operation:'Images.advance',operationId:envelopeId};
const savedReceipt=await store.readReceipt(receiptIdentity);
assert.ok(savedReceipt,'canonical invocation saves the actual transition receipt');
const association=readScenarioReceiptAssociation(savedReceipt);
assert.ok(association,'native transition execution owns its source association');
const advanceDescriptor=artifact.operations.find(operation=>operation.name==='Images.advance');
assert.deepEqual(association.plan,advanceDescriptor.result.disclosure);
assert.equal(association.resultType,'void');
const selectedReturn=association.plan.returns.find(returned=>returned.id===association.returnId);
assert.ok(selectedReturn,'the actual implicit return is selected after both transitions');
assert.equal(selectedReturn.dependencies.length,2,'both transition old-state controls are required');
assert.deepEqual(association.observations.map(observation=>observation.dependencyId),
 selectedReturn.dependencies.map(dependency=>dependency.id),'observations retain authored transition order');
assert.equal(new Set(selectedReturn.dependencies.map(dependency=>dependency.id)).size,2);
for(const dependency of selectedReturn.dependencies){
 assert.equal(dependency.role,'control');
 assert.equal(dependency.model,'Images.Job');
 assert.equal(dependency.field,'status');
 assert.equal(dependency.type,'enum(idle,queued,generating,ready,failed)');
}
assert.deepEqual(association.observations.map(observation=>observation.row.data.status),['idle','queued'],
 'each marker captures its genuine old state, including the issued session intermediate row');
for(const observation of association.observations){assert.equal(observation.model,'Images.Job');assert.equal(observation.row.id,row.id);}
assert.equal(association.changed.length,1,'ordered transitions retain one final net write');
assert.equal(association.changed[0].model,'Images.Job');
assert.equal(association.changed[0].row.version,2);
assert.equal(association.changed[0].row.data.status,'generating');
assert.deepEqual(association.changed[0].row,await store.load('Images.Job',row.id));
assert.equal(JSON.stringify(advanced).includes('scenario-result/v1'),false,'public output excludes protected association');
const revision = await store.readRevision();
const history=await store.historyFor('Images.Job',row.id);
const savedRow=await store.load('Images.Job',row.id);
const replay = await invoke('Images.advance',input,envelopeId);
assert.ok('result' in replay,JSON.stringify(replay));
assert.equal(replay.result.status,'replayed');
assert.deepEqual(replay.result.result,advanced.result.result);
assert.deepEqual(replay.result.records,advanced.result.records);
assert.equal(await store.readRevision(),revision);
assert.deepEqual(await store.historyFor('Images.Job',row.id),history);
assert.deepEqual(await store.load('Images.Job',row.id),savedRow);
assert.deepEqual(await store.readReceipt(receiptIdentity),savedReceipt);
// The dedicated public entry recovers this same saved receipt after nonce age.
let retainedCommits=0,fileReads=0;
const readonlyStore={...store,commit:async()=>{retainedCommits++;throw new Error('retained transition commit tripwire');}};
const files=new Proxy({},{get(){fileReads++;throw new Error('retained transition file tripwire');}});
const retainedInvoker=buildInvoker(artifact,asm,readonlyStore,{memberships,now:()=>now+16*60000,files});
const retained=await retainedInvoker.invokeRetainedMutation({operation:'Images.advance',operation_id:envelopeId,inputs:input},identity);
assert.ok('result' in retained,JSON.stringify(retained));assert.equal(retained.result.status,'replayed');
assert.deepEqual(retained.result.result,advanced.result.result);
assert.deepEqual(retained.result.records,advanced.result.records);
assert.equal(JSON.stringify(retained).includes('scenario-result/v1'),false);
assert.equal(retainedCommits,0);assert.equal(fileReads,0);
assert.equal(await store.readRevision(),revision);
assert.deepEqual(await store.historyFor('Images.Job',row.id),history);
assert.deepEqual(await store.load('Images.Job',row.id),savedRow);
assert.deepEqual(await store.readReceipt(receiptIdentity),savedReceipt);
const stale = await invoke('Images.finish',input);
assert.equal(stale.error.code,'conflict');
const second = createdRecord(await invoke('Images.Job.create',{}));
const rollback = await invoke('Images.rollback',{job:{id:second.id,version:'1'}});
assert.equal(rollback.error.code,'rule_failed');
assert.equal((await store.load('Images.Job',second.id)).data.status,'idle');
const pageRef=artifact.pages[0];
const entry=await import(asm.moduleUrls[pageRef.module]);
const descriptor=entry[pageRef.export];
assert.equal(descriptor.poll,2000n);
const context={preferredLocales:[],appDefaultLocale:'en',theme:DEFAULT_THEME,path:'/',isPartial:true,
 pollContext:'same-authorized-view',csrfToken:'',principal:identity,invocation:identity,
 query:async()=>{const record=await store.load('Images.Job',row.id);return {rows:[{id:record.id,version:String(record.version),fields:record.data}],columns:[]};}};
async function html() { return renderPage(context,descriptor,[await descriptor.render(context,{})]); }
const running=await html();
assert.equal((running.match(/<main/g)||[]).length,1);
assert.match(running,/Generating/);
assert.doesNotMatch(running,/Image ready/);
const current=await store.load('Images.Job',row.id);
const finished=await invoke('Images.finish',{job:{id:row.id,version:String(current.version)}});
assert.ok('result' in finished,JSON.stringify(finished));
const ready=await html();
assert.match(ready,/Image ready/);
assert.doesNotMatch(ready,/Generating/);
// Explicit slots use the real session; omitted-default mutation stays refused
// until State releases the defining frozen input-default contribution contract.
const explicit=createdRecord(await invoke('Images.Job.create',{}));
const defaultAllowed=await invoke('Images.defaults',{job:{id:explicit.id,version:'1'},selected:true});
assert.ok('result' in defaultAllowed,JSON.stringify(defaultAllowed));assert.equal(defaultAllowed.result.status,'committed');
assert.equal((await store.load('Images.Job',explicit.id)).data.status,'ready');
const omitted=createdRecord(await invoke('Images.Job.create',{}));
const omittedBefore={row:await store.load('Images.Job',omitted.id),history:await store.historyFor('Images.Job',omitted.id)};
const defaultDenied=await invoke('Images.defaults',{job:{id:omitted.id,version:'1'}});
assert.ok('error' in defaultDenied,JSON.stringify(defaultDenied));assert.equal(defaultDenied.error.code,'validation');
assert.deepEqual(await store.load('Images.Job',omitted.id),omittedBefore.row);
assert.deepEqual(await store.historyFor('Images.Job',omitted.id),omittedBefore.history);
// A private selector controls changed-record existence on BOTH outcomes.
for(const operation of ['Images.optional','Images.optional_scalar']) for(const choice of [true,false]){
 const created=createdRecord(await invoke('Images.Job.create',{private_choice:choice}));
 assert.equal(Object.hasOwn(created.data,'private_choice'),false,'declared read grant omits the private selector');
 const request={operation,operation_id:operationId(),inputs:{job:{id:created.id,version:'1'}}};
 const outcome=await invoker.invokeMutation(request,identity);
 assert.ok('result' in outcome,JSON.stringify(outcome));assert.equal(outcome.result.status,'committed');
 assert.equal(outcome.result.result,null,'unreadable influence withholds scalar and void results');
 assert.deepEqual(outcome.result.records,[],'private influence withholds every changed public record');
 const stored=await store.load('Images.Job',created.id);
 assert.equal(stored.data.status,choice?'ready':'idle');assert.equal(stored.version,choice?2:1);
 const key={app:'Images',owner:'app',principal:'public',operation,operationId:request.operation_id};
 const receipt=await store.readReceipt(key),association=readScenarioReceiptAssociation(receipt);
 assert.ok(association,'actual private-control execution has its own saved association');
 const returned=association.plan.returns.find(value=>value.id===association.returnId);
 assert.equal(returned.dependencies.length,choice?2:1,'the no-write path still retains its selector');
 assert.equal(returned.dependencies[0].field,'private_choice');assert.equal(returned.dependencies[0].role,'control');
 assert.deepEqual(association.observations.map(value=>value.dependencyId),returned.dependencies.map(value=>value.id));
 assert.equal(association.observations[0].row.data.private_choice,choice);
 assert.equal(association.changed.length,choice?1:0);
 assert.equal(receipt.outcome.result,operation==='Images.optional_scalar'?'7':null,'physical scalar result remains frozen');
 const before={revision:await store.readRevision(),row:stored,history:await store.historyFor('Images.Job',created.id),receipt};
 for(const dedicated of [false,true]){
  const recovered=await (dedicated?retainedInvoker.invokeRetainedMutation(request,identity):invoker.invokeMutation(request,identity));
  assert.ok('result' in recovered,JSON.stringify(recovered));assert.equal(recovered.result.status,'replayed');
  assert.equal(recovered.result.result,null);assert.deepEqual(recovered.result.records,[]);
  assert.equal(await store.readRevision(),before.revision);assert.deepEqual(await store.load('Images.Job',created.id),before.row);
  assert.deepEqual(await store.historyFor('Images.Job',created.id),before.history);assert.deepEqual(await store.readReceipt(key),before.receipt);
 }
}
assert.equal(retainedCommits,0);assert.equal(fileReads,0);
console.log('compiled machine: graph, gated capability, canonical creation/ordered transitions/replay/conflict/rollback, projected state UI, private optional-write withholding, frozen input-default refusal and no-write retained recovery verified');
