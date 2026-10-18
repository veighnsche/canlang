#!/usr/bin/env node
// Fixed SDK calls only. Native code supplies all plans, resource IDs and ordering.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PROTOCOL,MAX_FRAME,Outputs,readReference,request} from './protocol.mjs';
import {createApi,COMMANDS} from './sdk.mjs';

const session=process.argv[process.argv.indexOf('--session')+1];
if(!session||process.argv.indexOf('--session')<0)throw Error('SDK host needs its native session identity');
let logBytes=0;
const log=()=>{if(logBytes>=64*1024)return;const line=JSON.stringify({protocol:PROTOCOL,kind:'log',sessionId:session,generationId:null,operationId:null,source:'runtime',message:'SDK output withheld'})+'\n';logBytes+=Buffer.byteLength(line);process.stderr.write(line);};
console.log=log;console.info=log;console.warn=log;console.error=log;console.debug=log;
delete process.env.NODE_INSPECTOR_INFO;
const resources=new Map(),operations=new Map(),closingParents=new Set();
let stopped=false;
function boundedId(id){if(typeof id!=='string'||id.length<1||id.length>512||/[\u0000-\u0020]/.test(id))throw Error('invalid SDK resource identity');return id;}
function allocate(parent,handle,kind){
  boundedId(parent);boundedId(handle);
  if(stopped||closingParents.has(parent)||resources.has(handle)||resources.size>=256)throw Error('SDK resource is not allocatable');
  const entry={parent,handle,kind,value:undefined,pending:new Set()};resources.set(handle,entry);return entry;
}
function find(parent,handle,kind){
  const entry=resources.get(boundedId(handle));
  if(!entry||entry.parent!==parent||entry.kind!==kind||entry.value===undefined)throw Error('SDK resource is unavailable');
  return entry;
}
async function tracked(entry,action){const pending=Promise.resolve().then(action);entry.pending.add(pending);try{return await pending;}finally{entry.pending.delete(pending);}}
async function dispose(entry){
  if(entry.closing)return entry.closing;
  const pending=(async()=>{
    if(entry.value===undefined)throw Error('SDK allocation outcome remains uncertain');
    if(entry.kind==='mf'){
      try{await entry.value.dispose();}catch(error){if(error!==entry.startupError)throw error;}
    }else if(entry.kind==='browser'||entry.kind==='context'){await entry.value.close();}
    await Promise.allSettled([...entry.pending]);
    resources.delete(entry.handle);
  })();
  entry.closing=pending;
  try{await pending;}catch(error){delete entry.closing;entry.failed=true;throw error;}
}
function allocation(parent){
  const owned=[...resources.values()].filter(r=>r.parent===parent);
  return owned.some(r=>r.failed)?'release_failed':owned.length?'owned':'none';
}
async function release(parent){
  boundedId(parent);closingParents.add(parent);
  const work=[...operations.values()].filter(o=>o.parent===parent);
  for(const op of work)op.cancel.abort();
  const initial=[...resources.values()].filter(r=>r.parent===parent&&r.value!==undefined);
  // Dispose runtimes before joining dispatches which require runtime termination.
  const first=await Promise.allSettled(initial.map(dispose));
  await Promise.allSettled(work.map(o=>o.done));
  const initialIds=new Set(initial.map(r=>r.handle));
  const late=[...resources.values()].filter(r=>r.parent===parent&&!initialIds.has(r.handle));
  const second=await Promise.allSettled(late.map(dispose));
  if([...first,...second].some(r=>r.status==='rejected')||[...resources.values()].some(r=>r.parent===parent))throw Error('SDK parent release remains incomplete');
  closingParents.delete(parent);return {released:true};
}
let directory,outputs,api;
function send(value){const line=JSON.stringify(value)+'\n';if(Buffer.byteLength(line)>MAX_FRAME)throw Error('SDK response frame limit');process.stdout.write(line);}
async function respond(value){
  const identity={protocol:PROTOCOL,kind:'result',sessionId:session,operationId:value.operationId,generationId:value.generationId};
  try{
    let result;
    if(value.command==='release'||value.command==='retry')result=await release(value.generationId);
    else if(value.command==='cancel'){
      const op=operations.get(value.payload.operationId);
      if(op&&op.parent!==value.generationId)throw Error('SDK cancellation parent differs');
      op?.cancel.abort();if(op){
        // Termination may be required to settle an SDK dispatch. Cancellation
        // closes this native-issued scope before joining its pending calls.
        if(value.generationId!==null)await release(value.generationId);
        else await op.done;
      }result={cancelled:!!op};
    }else if(value.command==='consume')result=await outputs.consume(value.payload.files);
    else{
      if(stopped||closingParents.has(value.generationId)||operations.has(value.operationId)||operations.size>=16)throw Error('SDK request not admitted');
      let settle;const done=new Promise(resolve=>{settle=resolve;});const cancel=new AbortController();
      operations.set(value.operationId,{parent:value.generationId,cancel,done});
      try{
        const payload=value.payload.input===undefined?value.payload:JSON.parse((await readReference(value.payload.input)).toString('utf8'));
        result=await api(value.command,payload,value.generationId,cancel.signal);
      }finally{operations.delete(value.operationId);settle();}
    }
    if(Buffer.byteLength(JSON.stringify(result))>24*1024)result={output:await outputs.json(result)};
    send({...identity,ok:true,allocation:['release','retry'].includes(value.command)?'released':allocation(value.generationId),result});
  }catch{
    send({...identity,ok:false,allocation:allocation(value.generationId),error:{code:allocation(value.generationId)==='release_failed'?'CLEANUP_REQUIRED':'SDK_OPERATION_FAILED',message:`SDK operation failed: ${value.command}`}});
  }
}
let closing;
function close(){return closing??=(async()=>{
  stopped=true;process.stdin.pause();
  for(const op of operations.values())op.cancel.abort();
  const parents=new Set([...resources.values()].map(r=>r.parent));
  const results=await Promise.allSettled([...parents].map(release));
  await Promise.allSettled([...operations.values()].map(o=>o.done));
  if(results.some(r=>r.status==='rejected')||resources.size){process.exitCode=1;return;}
  if(directory)await rm(directory,{recursive:true,force:true});
})();}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void close().finally(()=>process.exit(process.exitCode??0));});
try{
  directory=await mkdtemp(join(tmpdir(),'can-sdk-host-'));outputs=new Outputs(directory);
  api=await createApi({allocate,find,dispose,tracked,resources,hostPath:new URL(import.meta.url).pathname});
  send({protocol:PROTOCOL,kind:'ready',sessionId:session,pid:process.pid,profile:'local-d1-identity',commands:[...COMMANDS,'consume','cancel','release','retry']});
  let buffered=Buffer.alloc(0);const pending=new Set();
  for await(const chunk of process.stdin){
    if(stopped)break;buffered=Buffer.concat([buffered,chunk]);let index;
    while((index=buffered.indexOf(10))!==-1){const frame=buffered.subarray(0,index);buffered=buffered.subarray(index+1);const value=request(frame,session);const job=respond(value);pending.add(job);void job.finally(()=>pending.delete(job)).catch(()=>{process.exitCode=1;void close();});}
    if(buffered.length>MAX_FRAME)throw Error('unterminated SDK request');
  }
  await close();
  await Promise.allSettled(pending);
}catch{process.exitCode=1;}
finally{await close();}
