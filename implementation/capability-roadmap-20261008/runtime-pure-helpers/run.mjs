import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
const snapshot='/private/tmp/canlang-runtime-pure-after-db57c379';
const out=fileURLToPath(new URL('./',import.meta.url));
const privateRoot='/private/tmp/canlang-runtime-pure-d1-final-db57c379';
const json=v=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?{runtimeType:'bigint',decimal:x.toString()}:x,2)+'\n';
const sha=v=>createHash('sha256').update(v).digest('hex');
const require=createRequire(`${snapshot}/packages/cloudflare/package.json`);
const resolution={};for(const name of ['@canlang/values','@canlang/state','@canlang/contracts','@canlang/identity','miniflare']){const p=require.resolve(name);resolution[name]={path:p,realpath:await realpath(p),sha256:sha(await readFile(p))};}
const {Miniflare}=require('miniflare');
const {assembleModules}=await import(`${snapshot}/packages/cloudflare/dist/runtime/modules.js`);
const {buildInvoker}=await import(`${snapshot}/packages/cloudflare/dist/worker/assembly.js`);
const {createD1Storage,ensureSchema}=await import(`${snapshot}/packages/state/dist/src/storage/d1.js`);
const {createMemoryIdentityStore,createFrozenClock}=await import(`${snapshot}/packages/identity/dist/src/testing.js`);
const {resolveIdentity}=await import(`${snapshot}/packages/identity/dist/src/index.js`);
const peerUrl=pathToFileURL(`${snapshot}/packages/cloudflare/dist/runtime/stdlib.js`).href;
const pure=await import(peerUrl);const values=await import(resolution['@canlang/values'].path);
const report={qualification:'Historical frozen db57 compiler/producer outputs with acknowledged current runtime pure reexports; actual canonical State/D1 route, memory identity, same Node host. No current compiler refresh, nullable repair, installed/provider/durable claim.',node:process.version,snapshot,privateRoot,resolution,preload:{peerUrl,success:true,identity:Object.fromEntries(['int64','datetime','compareInstant'].map(n=>[n,pure[n]===values[n]]))},receipts:[],checks:[]};
assert.ok(Object.values(report.preload.identity).every(Boolean));
const check=(name,passed,detail)=>report.checks.push({name,passed:!!passed,detail});
const save=()=>writeFile(`${out}/runtime-results.json`,json(report));
const now=Date.now(),clock=createFrozenClock(now),identities=createMemoryIdentityStore({clock});
const identity=await resolveIdentity(identities,{},{clock});
const opId=()=>{const t=now.toString(16).padStart(12,'0'),r=randomUUID();return `${t.slice(0,8)}-${t.slice(8)}-7${r.slice(15,18)}-8${r.slice(20,23)}-${r.slice(24)}`;};
await mkdir(privateRoot,{recursive:true});
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:'runtime-pure'},d1Persist:`${privateRoot}/persist`});
try{
 const db=await mf.getD1Database('DB');await ensureSchema(db);const store=createD1Storage(db);
 async function snap(){const tables={};for(const t of ['records','history','receipts','outbox','schedules','fence','fence_log'])tables[t]=(await db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results;return {revision:await store.readRevision(),tables};}
 async function setup(name,path,source){const raw=await readFile(path),artifact=JSON.parse(raw);report[name]={artifactPath:path,sha256:sha(raw),sourcePath:source,sourceSha256:sha(await readFile(source)),modules:artifact.modules};const assembled=await assembleModules({artifact,sourcePath:source},{workDir:`${privateRoot}/modules/${name}`,stdlibUrl:peerUrl,uiUrl:pathToFileURL(`${snapshot}/packages/ui/dist/src/index.js`).href});report[name].assembled=assembled;return buildInvoker(artifact,assembled,store,{memberships:identities,now:()=>now});}
 async function invoke(name,invoker,operation,inputs,id=opId()){
  const before=await snap(),envelope={operation,operation_id:id,inputs},outcome=await invoker.invokeMutation(envelope,identity),after=await snap();
  report.receipts.push({name,envelope,outcome,resultType:'result' in outcome?typeof outcome.result?.result:null,before,after});await save();return outcome;
 }
 const numeric=await setup('numeric',`${out}/../f1-invocation/numeric-control-compile.json`,`${out}/../f1-invocation/NumericControl.can`);
 const created=await invoke('numeric-create',numeric,'NumericControl.Job.create',{});
 check('numeric genuine module preload and actual omitted-default row creation','result' in created,created);
 const rows=(await db.prepare('SELECT * FROM records WHERE model = ?').bind('NumericControl.Job').all()).results;
 report.numeric.rows=rows;
 if(rows.length===1){const row=rows[0];const ref={id:row.id,version:String(row.version)};report.numeric.actualRef=ref;const result=await invoke('numeric-increment',numeric,'NumericControl.increment',{job:ref});report.numeric.observedArithmetic=result;check('numeric actual arithmetic result equals 2n','result' in result&&result.result.result===2n,result);}
 else report.numeric.arithmeticStatus='blocked: no genuine created row';
 const temporal=await setup('datetime',`${out}/datetime-compile.json`,`${out}/DatetimeControl.can`);
 const js=report.datetime.modules.map(m=>m.js).join('\n');check('datetime caller text constructor and real fixed datetime comparison emitted',js.includes('compareInstant(')&&js.includes('datetime(')&&js.includes('2026-10-08T00:00:00.000Z'),js);
 for(const [name,stamp,expected] of [['earlier','2026-10-07T23:59:59.999Z',true],['equal','2026-10-08T00:00:00.000Z',false],['later','2026-10-08T00:00:00.001Z',false]]){
  const id=opId(),result=await invoke(`datetime-${name}`,temporal,'DatetimeControl.before',{stamp},id);check(`datetime ${name} caller text yields exact boolean`,'result' in result&&result.result.result===expected,result);
  if(name==='earlier'){const replay=await invoke('datetime-earlier-replay',temporal,'DatetimeControl.before',{stamp},id);check('datetime boolean replay exact result','result' in result && 'result' in replay && replay.result.status==='replayed' && replay.result.result===result.result.result,{result,replay});}
 }
 const invalid=await invoke('datetime-invalid',temporal,'DatetimeControl.before',{stamp:'malformed'});check('datetime malformed runtime text refuses','error' in invalid,invalid);
 report.counts={passed:report.checks.filter(c=>c.passed).length,failed:report.checks.filter(c=>!c.passed).length};await save();console.log(json({counts:report.counts,preload:report.preload,checks:report.checks.map(({name,passed})=>({name,passed})),numeric:report.numeric.observedArithmetic}));
} catch(error){report.fatal={name:error.name,message:error.message,stack:error.stack};await save();throw error;}finally{await mf.dispose();}
