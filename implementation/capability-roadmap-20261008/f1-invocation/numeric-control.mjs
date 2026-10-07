import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
const frozen='/private/tmp/canlang-roadmap-f1-db57c379',out=fileURLToPath(new URL('./',import.meta.url));
const {Miniflare}=createRequire(`${frozen}/packages/cloudflare/package.json`)('miniflare');
const {assembleModules}=await import(`${frozen}/packages/cloudflare/dist/runtime/modules.js`);
const {buildInvoker}=await import(`${frozen}/packages/cloudflare/dist/worker/assembly.js`);
const {createD1Storage,ensureSchema}=await import(`${frozen}/packages/state/dist/src/storage/d1.js`);
const {createMemoryIdentityStore,createFrozenClock}=await import(`${frozen}/packages/identity/dist/src/testing.js`);
const {resolveIdentity}=await import(`${frozen}/packages/identity/dist/src/index.js`);
const artifact=JSON.parse(await readFile(`${out}/numeric-control-compile.json`));
const now=Date.now(),clock=createFrozenClock(now),identities=createMemoryIdentityStore({clock}),identity=await resolveIdentity(identities,{},{clock});
const opId=()=>{const t=now.toString(16).padStart(12,'0'),r=randomUUID();return `${t.slice(0,8)}-${t.slice(8)}-7${r.slice(15,18)}-8${r.slice(20,23)}-${r.slice(24)}`};
const root='/private/tmp/canlang-f1-invocation-numeric';
const mf=new Miniflare({modules:true,script:'export default { fetch(){return new Response("ok")} }',d1Databases:{DB:'numeric-control'},d1Persist:`${root}/persist`});
const results=[];
try{
 const db=await mf.getD1Database('DB');await ensureSchema(db);const store=createD1Storage(db);
 async function snapshot(){return {revision:await store.readRevision(),records:(await db.prepare('SELECT * FROM records').all()).results,history:(await db.prepare('SELECT * FROM history').all()).results,receipts:(await db.prepare('SELECT * FROM receipts').all()).results}}
 for(const mode of ['cloudflare-runtime','public-facade']){
  const runtimePath=mode==='cloudflare-runtime'?`${frozen}/packages/cloudflare/dist/runtime/stdlib.js`:`${frozen}/packages/stdlib/dist/src/index.js`;
  const asm=await assembleModules({artifact,sourcePath:`${out}/NumericControl.can`},{workDir:`${root}/modules/${mode}`,stdlibUrl:pathToFileURL(runtimePath).href,uiUrl:pathToFileURL(`${frozen}/packages/ui/dist/src/index.js`).href});
  const invoker=buildInvoker(artifact,asm,store,{memberships:identities,now:()=>now});
  const createEnvelope={operation:'NumericControl.Job.create',operation_id:opId(),inputs:{}};
  const before=await snapshot(),create=await invoker.invokeMutation(createEnvelope,identity),after=await snapshot();
  // Failed production preload means no actual current typed default row exists.
  // Record dependent expected arithmetic as blocked; do not invent a row/ref or shim.
  const numericResult={expected:2,expectedRuntimeType:'bigint',status:'blocked_before_actual_default_row',cause:create.error};
  results.push({mode,runtimePath,createEnvelope,create,before,after,numericResult});
 }
 await writeFile(`${out}/numeric-control-results.json`,JSON.stringify({status:'failed_before_numeric_execution',compiledUnchanged:true,scenario:'NumericControl.increment(job:Job) -> int: return job.count+1',emitted:'return int64(job.count + 1n)',expectedNumericResult:2,results,hydrationSourceFacts:{path:`${frozen}/packages/cloudflare/src/runtime/invoke.ts`,function:'scenarioParameters',fieldGetter:'staged.has(key) ? staged.get(key)?.data[field] : admitted[field]',recordVersion:'BigInt(row.version)',claim:'Field data is forwarded without a scalar decoder on this source path; this is static evidence, not an executed arithmetic outcome.'}},null,2)+'\n');
 console.log(JSON.stringify({status:'failed_before_numeric_execution',results:results.map(r=>({mode:r.mode,error:r.create.error,revisionBefore:r.before.revision,revisionAfter:r.after.revision,numericResult:r.numericResult}))},null,2));
}finally{await mf.dispose();}
