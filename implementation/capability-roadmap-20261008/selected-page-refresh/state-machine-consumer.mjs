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
const created = await invoke('Images.Job.create',{});
assert.ok('result' in created,JSON.stringify(created));
const row = created.result.result;
assert.equal(row.data.status,'idle');
const envelopeId=operationId();
const input={job:{id:row.id,version:String(row.version)}};
const advanced=await invoke('Images.advance',input,envelopeId);
assert.ok('result' in advanced,JSON.stringify(advanced));
assert.equal((await store.load('Images.Job',row.id)).data.status,'generating');
assert.equal((await store.load('Images.Job',row.id)).version,2,'two transitions reserve one transaction version');
const revision = await store.readRevision();
const replay = await invoke('Images.advance',input,envelopeId);
assert.equal(replay.result.status,'replayed');
assert.equal(await store.readRevision(),revision);
const stale = await invoke('Images.finish',input);
assert.equal(stale.error.code,'conflict');
const second = await invoke('Images.Job.create',{});
const rollback = await invoke('Images.rollback',{job:{id:second.result.result.id,version:'1'}});
assert.equal(rollback.error.code,'rule_failed');
assert.equal((await store.load('Images.Job',second.result.result.id)).data.status,'idle');
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
console.log('compiled machine: graph, gated capability, canonical creation/ordered transitions/replay/conflict/rollback, projected state UI and one partial main verified');
