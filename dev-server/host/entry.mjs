#!/usr/bin/env node
// Fixed SDK calls only. Native code supplies all plans, resource IDs and ordering.
import {AsyncLocalStorage} from 'node:async_hooks';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PROTOCOL,MAX_FRAME,Outputs,readReference,request} from './protocol.mjs';
import {createApi,COMMANDS} from './sdk.mjs';

const sessionIndex=process.argv.indexOf('--session');
const session=process.argv[sessionIndex+1];
if(sessionIndex<0)throw Error('SDK host needs its native session identity');
boundedId(session);
let logBytes=0;
const log=()=>{if(logBytes>=64*1024)return;const line=JSON.stringify({protocol:PROTOCOL,kind:'log',sessionId:session,generationId:null,operationId:null,source:'runtime',message:'SDK output withheld'})+'\n';logBytes+=Buffer.byteLength(line);process.stderr.write(line);};
console.log=log;console.info=log;console.warn=log;console.error=log;console.debug=log;
delete process.env.NODE_INSPECTOR_INFO;
const resources=new Map(),operations=new Map(),closingParents=new Set(),releases=new Map(),responses=new Set();
const currentOperation=new AsyncLocalStorage();
let stopped=false,directory,outputs,api,closing;
function boundedId(id){if(typeof id!=='string'||id.length<1||id.length>512||/[\u0000-\u0020]/.test(id))throw Error('invalid SDK resource identity');return id;}
function retainOperation(entry){
  const op=currentOperation.getStore();
  // A disposal operation cannot await its own completion.
  if(!op||['mf.dispose','testkit.dispose','browser.close'].includes(op.command)||entry.pending.has(op.done))return;
  entry.pending.add(op.done);void op.done.then(()=>entry.pending.delete(op.done));
}
function allocate(parent,handle,kind){
  boundedId(parent);boundedId(handle);
  if(stopped||closingParents.has(parent)||resources.has(handle)||resources.size>=256)throw Error('SDK resource is not allocatable');
  const entry={parent,handle,kind,value:undefined,pending:new Set()};resources.set(handle,entry);retainOperation(entry);return entry;
}
function find(parent,handle,kind){
  const entry=resources.get(boundedId(handle));
  if(!entry||entry.parent!==parent||entry.kind!==kind||entry.value===undefined)throw Error('SDK resource is unavailable');
  const disposing=['mf.dispose','testkit.dispose','browser.close'].includes(currentOperation.getStore()?.command);
  if(entry.closing&&!disposing)throw Error('SDK resource is closing');
  retainOperation(entry);return entry;
}
async function tracked(entry,action){const pending=Promise.resolve().then(action);entry.pending.add(pending);try{return await pending;}finally{entry.pending.delete(pending);}}
async function dispose(entry){
  if(entry.closing)return entry.closing;
  const pending=(async()=>{
    if(entry.value===undefined)throw Error('SDK allocation outcome remains uncertain');
    if(!entry.physicallyDisposed){
      if(entry.kind==='mf'){
        try{await entry.value.dispose();}catch(error){if(error!==entry.startupError)throw error;}
      }else if(['browser','context','page'].includes(entry.kind)){await entry.value.close();}
      entry.physicallyDisposed=true;
    }
    // Destruction comes first: SDK dispatches may require termination to settle.
    await Promise.allSettled([...entry.pending]);
    if(entry.analyticsError){const error=entry.analyticsError;delete entry.analyticsError;throw error;}
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
  boundedId(parent);
  if(releases.has(parent))return releases.get(parent);
  closingParents.add(parent);
  const pending=(async()=>{
    const work=[...operations.values()].filter(o=>o.parent===parent);
    for(const op of work)op.cancel.abort();
    const initial=[...resources.values()].filter(r=>r.parent===parent&&r.value!==undefined);
    const first=await Promise.allSettled(initial.map(dispose));
    await Promise.allSettled(work.map(o=>o.done));
    // A browser or suite can become allocated while its constructor is joining.
    const initialIds=new Set(initial.map(r=>r.handle));
    const late=[...resources.values()].filter(r=>r.parent===parent&&!initialIds.has(r.handle));
    const second=await Promise.allSettled(late.map(dispose));
    if([...first,...second].some(r=>r.status==='rejected')||[...resources.values()].some(r=>r.parent===parent))throw Error('SDK parent release remains incomplete');
    closingParents.delete(parent);return {released:true};
  })();
  releases.set(parent,pending);
  try{return await pending;}finally{releases.delete(parent);}
}
function send(value){const line=JSON.stringify(value)+'\n';if(Buffer.byteLength(line)>MAX_FRAME)throw Error('SDK response frame limit');process.stdout.write(line);}
async function respond(value){
  const identity={protocol:PROTOCOL,kind:'result',sessionId:session,operationId:value.operationId,generationId:value.generationId};
  let active,settle;
  try{
    let result;
    if(value.command==='release'||value.command==='retry')result=await release(value.generationId);
    else if(value.command==='cancel'){
      const op=operations.get(value.payload.operationId);
      if(op&&op.parent!==value.generationId)throw Error('SDK cancellation parent differs');
      op?.cancel.abort();if(op){if(value.generationId!==null)await release(value.generationId);else await op.done;}
      // A result may already have reached stdout before native cancellation won
      // its wait. The spool still owns and retires that exact operation's file.
      await outputs.discard(value.payload.operationId,value.generationId);
      result={cancelled:!!op};
    }else if(value.command==='consume')result=await outputs.consume(value.payload.files);
    else{
      if(stopped||closingParents.has(value.generationId)||operations.has(value.operationId)||operations.size>=16)throw Error('SDK request not admitted');
      const done=new Promise(resolve=>{settle=resolve;});const cancel=new AbortController();
      active={parent:value.generationId,command:value.command,cancel,done};operations.set(value.operationId,active);
      result=await currentOperation.run(active,async()=>{
        const payload=value.payload.input===undefined||Object.keys(value.payload).length!==1?value.payload:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readReference(value.payload.input)));
        return api(value.command,payload,value.generationId,cancel.signal);
      });
    }
    active?.cancel.signal.throwIfAborted();
    result??=null;
    if(Buffer.byteLength(JSON.stringify(result))>24*1024)result={output:await outputs.json(result,value.operationId,value.generationId)};
    active?.cancel.signal.throwIfAborted();
    send({...identity,ok:true,allocation:['release','retry'].includes(value.command)?'released':allocation(value.generationId),result});
  }catch(err){
    if(active)await outputs.discard(value.operationId,value.generationId);
    const state=allocation(value.generationId);
    const cause=err instanceof Error?err.message:String(err);
    send({...identity,ok:false,allocation:state,error:{code:state==='release_failed'?'CLEANUP_REQUIRED':active?.cancel.signal.aborted?'SDK_OPERATION_CANCELLED':'SDK_OPERATION_FAILED',message:`SDK operation failed: ${value.command}: ${cause}`.slice(0,500)}});
  }finally{
    if(active){operations.delete(value.operationId);settle();}
  }
}
function dispatch(frame){
  if(responses.size>=64)throw Error('SDK request concurrency limit');
  const value=request(frame,session),job=respond(value);responses.add(job);
  void job.finally(()=>responses.delete(job)).catch(()=>{process.exitCode=1;void close();});
}
function close(){return closing??=(async()=>{
  stopped=true;process.stdin.pause();
  for(const op of operations.values())op.cancel.abort();
  const parents=new Set([...resources.values()].map(r=>r.parent).concat([...operations.values()].map(o=>o.parent).filter(p=>p!==null)));
  const results=await Promise.allSettled([...parents].map(release));
  await Promise.allSettled([...operations.values()].map(o=>o.done));
  await Promise.allSettled([...responses]);
  if(results.some(r=>r.status==='rejected')||resources.size){process.exitCode=1;return;}
  if(directory)await rm(directory,{recursive:true,force:true});
})();}
process.stdout.on('error',()=>{process.exitCode=1;void close();});
process.stderr.on('error',()=>{});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void close().then(()=>process.exit(process.exitCode??0),()=>process.exit(1));});
try{
  directory=await realpath(await mkdtemp(join(tmpdir(),'can-sdk-host-')));outputs=new Outputs(directory);
  api=await createApi({allocate,find,dispose,tracked,resources,hostPath:new URL(import.meta.url).pathname});
  send({protocol:PROTOCOL,kind:'ready',sessionId:session,pid:process.pid,profile:'local-d1-identity',commands:[...COMMANDS,'consume','cancel','release','retry']});
  let buffered=Buffer.alloc(0);
  for await(const chunk of process.stdin){
    if(stopped)break;let offset=0,index;
    while((index=chunk.indexOf(10,offset))!==-1){
      const part=chunk.subarray(offset,index);if(buffered.length+part.length>MAX_FRAME)throw Error('SDK frame limit');
      const frame=buffered.length?Buffer.concat([buffered,part]):part;buffered=Buffer.alloc(0);dispatch(frame);offset=index+1;
    }
    const part=chunk.subarray(offset);if(buffered.length+part.length>MAX_FRAME)throw Error('unterminated SDK request');
    if(part.length)buffered=Buffer.concat([buffered,part]);
  }
  if(buffered.length)throw Error('unterminated SDK request');
}catch{process.exitCode=1;}
finally{await close();}
