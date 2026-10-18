/** Semantic-test SDK objects. Rust owns preview policy and configuration. */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { D1Database } from '@cloudflare/workers-types';
import type { ActivationVerdict, CompileArtifact } from '@canlang/contracts';
import type { DispatchFetch, Miniflare } from 'miniflare';
import type { PackageDeployBundle } from '../deploy/bundle.js';
import type { SingleFileCapture } from './native-dev.test-support.js';
import { ResourceCleanupError, retryableDispose } from './resource-lifetime.js';

const checkout = fileURLToPath(new URL('../../../../', import.meta.url)), limit = 64 * 1024 * 1024;
type Json = Record<string, any>;
type Entry = { parent: string; handle: string; kind: string; value?: any; pending: Set<Promise<unknown>>; workerName?: string; startupError?: unknown; analyticsError?: unknown; closing?: Promise<void>; physicallyDisposed?: boolean };
type Handler = (payload: Json, signal: AbortSignal, registry: Awaited<ReturnType<typeof sdkRegistry>>, parent: string) => Promise<unknown>;
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes,no) => { resolve=yes; reject=no; }); return { promise, resolve, reject }; }
function wire(value: unknown): string { return JSON.stringify(value, (_key,item) => typeof item === 'bigint' ? item.toString() : item instanceof Uint8Array ? { type:'Buffer', data:[...item] } : item); }
function revive(value: any): any { if (value?.type === 'Buffer' && Array.isArray(value.data)) return new Uint8Array(value.data); if (Array.isArray(value)) return value.map(revive); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,revive(item)])); return value; }
function waiting<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> { signal.throwIfAborted(); return new Promise((resolve,reject) => { const abort=()=>reject(signal.reason); signal.addEventListener('abort',abort,{once:true}); promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort)); }); }
async function sdkRegistry(databases: Record<string,D1Database> = {}) {
  const resources = new Map<string,Entry>(), paths = new Set<string>();
  const allocate = (parent:string,handle:string,kind:string) => { if (resources.has(handle)) throw Error('duplicate SDK test handle'); const entry:Entry={parent,handle,kind,pending:new Set()}; resources.set(handle,entry); return entry; };
  const borrowed = { getD1Database:async(binding:string) => { if (!databases[binding]) throw Error('unbound semantic-test database'); return databases[binding]; } };
  const find = (parent:string,handle:string,kind:string):Entry => {
    if(handle==='policy-input' && kind==='mf') return {parent,handle,kind,value:borrowed,pending:new Set()};
    const entry=resources.get(handle); if(!entry || entry.parent!==parent || entry.kind!==kind || entry.value===undefined || entry.physicallyDisposed || entry.closing) throw Error('SDK test resource unavailable'); return entry;
  };
  const tracked = async <T>(entry:Entry, action:()=>Promise<T>):Promise<T> => { const pending=Promise.resolve().then(action); entry.pending.add(pending); try{return await pending;}finally{entry.pending.delete(pending);} };
  const dispose = async (entry:Entry):Promise<void> => {
    if(entry.closing)return entry.closing;
    const closing=(async()=>{ if(entry.value===undefined)throw Error('SDK test allocation outcome uncertain'); if(!entry.physicallyDisposed){ if(entry.kind==='mf'){try{await entry.value.dispose();}catch(error){if(error!==entry.startupError)throw error;}}else if(['browser','context','page'].includes(entry.kind)){await entry.value.close();}else{throw Error('unknown test SDK disposal kind');}entry.physicallyDisposed=true; } await Promise.allSettled([...entry.pending]); if(entry.analyticsError){const error=entry.analyticsError;delete entry.analyticsError;throw error;}resources.delete(entry.handle); })();
    entry.closing=closing; try{await closing;}catch(error){delete entry.closing;throw error;}
  };
  const stopResources = async () => { const result=await Promise.allSettled([...resources.values()].map(dispose)); const failed=result.filter(row=>row.status==='rejected'); if(failed.length===1)throw (failed[0] as PromiseRejectedResult).reason;if(failed.length>1)throw new AggregateError(failed.map(row=>(row as PromiseRejectedResult).reason),'SDK test cleanup incomplete'); };
  const release = async () => { await stopResources(); for(const path of paths)await rm(path,{recursive:true,force:true}); paths.clear(); return {released:true}; };
  const host=process.env.CAN_DEV_RUNTIME_HOST ?? join(checkout,'dev-server/host/entry.mjs');
  const {createApi}=await import(pathToFileURL(join(dirname(host),'sdk.mjs')).href);
  const api=await createApi({allocate,find,dispose,tracked,resources});
  return {resources,paths,api,release,stopResources,tracked,dispose};
}
async function policy<T>(operation:string,input:unknown,databases:Record<string,D1Database>={},handlers:Record<string,Handler>={}):Promise<T> {
  const registry=await sdkRegistry(databases), cancel=new AbortController();
  const candidate=join(checkout,'compiler/target/debug/can-dev');
  const child=spawn(process.env.CAN_DEV_BIN ?? (existsSync(candidate)?candidate:'can-dev'),['policy-api'],{stdio:['pipe','pipe','pipe'],env:process.env});
  let buffer=Buffer.alloc(0), queue=Promise.resolve(), final:Json|undefined, failure:unknown;
  const send=(value:unknown)=>{const frame=wire(value)+'\n';if(Buffer.byteLength(frame)>limit)throw Error('policy reply exceeds limit');child.stdin.write(frame);};
  child.stdin.on('error',()=>{}); child.stderr.resume();
  // Stop actual SDK objects before joining callbacks: mf.ready/dispatch may need destruction to settle.
  const stop = (reason:unknown) => { cancel.abort(reason); void registry.stopResources().catch(error=>{failure??=error;}); };
  const timer=setTimeout(()=>{failure=Error('native semantic policy timed out');stop(failure);child.stdin.end();child.kill('SIGTERM');},180_000);
  child.stdout.on('data',(chunk:Buffer)=>{
    buffer=Buffer.concat([buffer,chunk]); if(buffer.length>limit){failure=Error('native policy frame exceeds limit');stop(failure);child.stdin.end();child.kill('SIGTERM');return;}
    for(;;){const end=buffer.indexOf(10);if(end<0)break;const line=buffer.subarray(0,end);buffer=buffer.subarray(end+1);queue=queue.then(async()=>{
      const frame=JSON.parse(line.toString()) as Json;
      if(frame.kind==='done'){final=frame;child.stdin.end();return;}
      if(frame.kind!=='call'||!Number.isSafeInteger(frame.id)||typeof frame.generation!=='string')throw Error('invalid native policy request');
      try{let result:unknown;if(frame.command==='test.release')result=await registry.release();else if(frame.command==='test.resourcePath'){registry.paths.add(frame.payload.path);result=null;}else if(frame.command==='resource.paths'){if(typeof frame.payload.temporary==='string')registry.paths.add(frame.payload.temporary);result={registered:true};}else if(handlers[frame.command])result=await handlers[frame.command]!(frame.payload,cancel.signal,registry,frame.generation);else result=await registry.api(frame.command,frame.payload,frame.generation,cancel.signal);send({id:frame.id,ok:true,result});}
      catch(error){failure=error;send({id:frame.id,ok:false});}
    }).catch(error=>{failure??=error;stop(error);child.stdin.end();child.kill('SIGTERM');});}
  });
  const closed=new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',()=>{stop(Error('native policy closed'));resolve();});});
  try{send({operation,input});await closed;await queue;if(!final?.ok)throw failure??Error(final?.detail??'native policy process failed');return revive(final.result) as T;}
  finally{clearTimeout(timer);cancel.abort();try{await registry.release();}catch(cleanupError){throw new ResourceCleanupError(failure??Error('native SDK cleanup incomplete'),cleanupError,retryableDispose(async()=>{await queue;await registry.release();}));}}
}
export interface LocalWorkerOptions {
  workerName:string;compatibilityDate:string;mainModule:string;modules:Readonly<Record<string,string>>;
  compatibilityFlags?:readonly string[];binaryModules?:Readonly<Record<string,Uint8Array>>;vars?:Readonly<Record<string,unknown>>;sourceMaps?:Readonly<Record<string,unknown>>;denyOutbound?:boolean;
  d1Databases?:readonly {binding:string;id:string}[];r2Buckets?:readonly {binding:string;id:string}[];kvNamespaces?:readonly {binding:string;id:string}[];
  durableObjects?:readonly {binding:string;className:string;scriptName?:string;useSQLite?:boolean}[];
  queueProducers?:Readonly<Record<string,string|{queueName:string;deliveryDelay?:number}>>;queueConsumers?:Readonly<Record<string,unknown>>;serviceBindings?:Readonly<Record<string,unknown>>;
  analyticsEngineDatasets?:readonly {binding:string;dataset:string}[];
}
export interface LocalDevOptions extends LocalWorkerOptions { resourceRecovery?:boolean;d1PersistenceRequired?:boolean; companionWorkers?:readonly LocalWorkerOptions[];d1Persist?:string;r2Persist?:string;kvPersist?:string;durableObjectsPersist?:string;analyticsEnginePersist?:string }
export interface LocalRuntimeBackend {origin:string;header:'x-can-local-dispatch';secret:string;urlHeader:'x-can-local-url'}
export interface LocalAnalyticsDataPoint {dataset:string;workerName:string;timestamp:string;point:{indexes:Array<string|number[]|null>;blobs:Array<string|number[]|null>;doubles:number[]}}
export interface LocalDev {
  backend:LocalRuntimeBackend;dispatch:(path:string,init?:Parameters<DispatchFetch>[1])=>ReturnType<DispatchFetch>;dispatchUrl:(url:string,init?:Parameters<DispatchFetch>[1])=>ReturnType<DispatchFetch>;
  getD1Database:(binding:string)=>Promise<D1Database>;getR2Bucket:(binding:string)=>ReturnType<Miniflare['getR2Bucket']>;getKVNamespace:(binding:string)=>ReturnType<Miniflare['getKVNamespace']>;getDurableObjectNamespace:(binding:string)=>ReturnType<Miniflare['getDurableObjectNamespace']>;getQueueProducer:(binding:string)=>ReturnType<Miniflare['getQueueProducer']>;getAnalyticsDataPoints:(dataset:string)=>Promise<readonly LocalAnalyticsDataPoint[]>;dispose:()=>Promise<void>;
}
export async function startLocalDev(options:LocalDevOptions):Promise<LocalDev> {
  const ready=deferred<{payload:Json;registry:Awaited<ReturnType<typeof sdkRegistry>>}>(), close=deferred<void>();
  let stopped=false, terminalError:unknown;
  const running=policy('worker',{options},{},{
    'test.worker.ready':async(payload,_signal,registry)=>{ready.resolve({payload,registry});return null;},
    'test.worker.close':async(_payload,signal)=>{await waiting(close.promise,signal);return null;},
    'test.worker.next':async(payload,signal)=>{if(payload.waitMs!==1000)throw Error('invalid native recovery interval');if(!stopped){let timer:ReturnType<typeof setTimeout>|undefined;try{await waiting(Promise.race([close.promise,new Promise<void>(resolve=>{timer=setTimeout(resolve,payload.waitMs);})]),signal);}finally{clearTimeout(timer);}}return {close:stopped};},
  });
  void running.catch(error=>{terminalError=error;ready.reject(error);});
  const {payload,registry}=await ready.promise, backend=payload.backend as LocalRuntimeBackend;
  const entry=registry.resources.get(payload.handle)!;const mf=entry.value as Miniflare;
  const check=()=>{if(terminalError)throw terminalError;if(stopped)throw Error('SDK test resource disposal requested');};
  const dispatchUrl=(url:string,init:Parameters<DispatchFetch>[1]={})=>registry.tracked(entry,async()=>{check();const headers=new Headers(init?.headers as any);headers.set(backend.header,backend.secret);headers.set(backend.urlHeader,url);return mf.dispatchFetch(url,{...init,headers:Object.fromEntries(headers)});});
  const getAnalyticsDataPoints=async(dataset:string):Promise<readonly LocalAnalyticsDataPoint[]>=>{check();if(entry.analyticsError)throw entry.analyticsError;const path=payload.analytics?.sinkPaths[dataset];if(typeof path!=='string')throw Error('analytics dataset is not configured');try{return (await readFile(path,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line) as LocalAnalyticsDataPoint);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}};
  let attempted=false;
  const dispose=retryableDispose(async()=>{stopped=true;close.resolve();if(attempted){await registry.release();return;}attempted=true;const physical=registry.stopResources();const result=await Promise.allSettled([physical,running]);const errors=[...new Set(result.filter(row=>row.status==='rejected').map(row=>(row as PromiseRejectedResult).reason))];if(errors.length===1)throw errors[0];if(errors.length>1)throw new AggregateError(errors,'SDK test disposal incomplete');});
  return {backend,dispatchUrl,dispatch:(path,init)=>dispatchUrl(new URL(path,'http://localhost').href,init),getD1Database:binding=>{check();return mf.getD1Database(binding,options.workerName) as unknown as Promise<D1Database>;},getR2Bucket:binding=>{check();return mf.getR2Bucket(binding,options.workerName);},getKVNamespace:binding=>{check();return mf.getKVNamespace(binding,options.workerName);},getDurableObjectNamespace:binding=>{check();return mf.getDurableObjectNamespace(binding,options.workerName);},getQueueProducer:binding=>{check();return mf.getQueueProducer(binding,options.workerName);},getAnalyticsDataPoints,dispose};
}
export interface LocalPreviewActor {label:string;email:string;password:string;teams:readonly string[]}
export interface LocalPreviewSeed {actors:readonly LocalPreviewActor[];probe:{email:string;password:string;teamId:string};owners:readonly {owner:string;binding:string}[]}
export function seedLocalPreviewActors(db:D1Database):Promise<LocalPreviewSeed>{return policy('seed',{}, {DB:db});}
export function localPreviewActivationVerdict(artifact:CompileArtifact,capture:SingleFileCapture,db:D1Database,databaseId:string,owner?:string,identityDb?:D1Database):Promise<ActivationVerdict>{return policy('activation',{artifact,artifactJson:JSON.stringify(artifact),capture,databaseId,owner,identityBinding:identityDb===undefined?undefined:identityDb===db?'STATE':'IDENTITY'},{STATE:db,...(identityDb===undefined?{}:{IDENTITY:identityDb})});}
export function selectPreviewWorkerVars(_configuration:unknown,origin:string):Promise<Record<string,unknown>>{return policy('vars',{origin});}
export function nativePreviewEvidence(artifact:CompileArtifact,capture:SingleFileCapture):Promise<{verdict:ActivationVerdict;bundle:PackageDeployBundle;captureEpochMaterial:string;artifactJsonSha256:string;consumedInputs:SingleFileCapture['inputs']}>{return policy('evidence',{artifact,artifactJson:JSON.stringify(artifact),capture});}
function previewControl() {
  let next=deferred<Json>(), response:ReturnType<typeof deferred<string>>|undefined, stopped=false, serial=Promise.resolve();
  const selected=deferred<void>();void selected.promise.catch(()=>{});
  const accept=async(payload:Json,signal:AbortSignal)=>{if(typeof payload.openUrl==='string'){response?.resolve(payload.openUrl);response=undefined;}selected.resolve();return waiting(next.promise,signal);};
  const issueOpenUrl=():Promise<string>=>{
    const minted=serial.then(async()=>{if(stopped)throw Error('preview disposal requested');await selected.promise;if(stopped)throw Error('preview disposal requested');response=deferred<string>();const command=next;next=deferred<Json>();command.resolve({operation:'mint'});return response.promise;});
    serial=minted.then(()=>undefined,()=>undefined);return minted;
  };
  const close=async()=>{stopped=true;selected.resolve();await serial;const command=next;next=deferred<Json>();command.resolve({operation:'close'});};
  const fail=(error:unknown)=>{selected.reject(error);response?.reject(error);};
  return {accept,issueOpenUrl,close,selected:selected.promise,fail};
}
export interface ProtectedPreview {url:string;issueOpenUrl:()=>Promise<string>;setBackend:(backend:LocalRuntimeBackend)=>Promise<void>;close:()=>Promise<void>}
export async function startNativeGateway():Promise<ProtectedPreview>{
  const ready=deferred<Json>(), backend=deferred<LocalRuntimeBackend|null>(), control=previewControl();
  const running=policy('gateway',{}, {}, {'test.gateway.backend':async(payload,signal)=>{ready.resolve(payload);return waiting(backend.promise,signal);},'test.gateway.control':control.accept,'test.preview.control':control.accept});
  void running.catch(error=>{ready.reject(error);control.fail(error);});
  const result=await ready.promise;
  return {url:result.url,issueOpenUrl:control.issueOpenUrl,setBackend:async(value)=>{backend.resolve(value);await control.selected;},close:retryableDispose(async()=>{backend.resolve(null);await control.close();await running;})};
}
export async function openNativePreview(artifact:CompileArtifact,capture:SingleFileCapture,artifactBytes:Uint8Array){
  const ready=deferred<Json>(), control=previewControl();
  const running=policy('preview',{artifact,capture,artifactJson:Buffer.from(artifactBytes).toString('utf8')},{},{'test.preview.ready':async(payload,signal)=>{ready.resolve(payload);return control.accept(payload,signal);},'test.preview.control':control.accept});
  void running.catch(error=>{ready.reject(error);control.fail(error);});const value=await ready.promise;let disposed=false;
  return {origin:value.url as string,issueOpenUrl:control.issueOpenUrl,issueLocalActors:():readonly LocalPreviewActor[]=>{if(disposed)throw Error('preview disposal requested');return value.actors;},dispose:retryableDispose(async()=>{disposed=true;await control.close();await running;})};
}

export function resolvePreviewRoles(roles:Readonly<Record<string,readonly string[]>>,definition:unknown):Promise<Record<string,string[]>> { return policy('roles',{roles,definition}); }

/** Physical-browser semantic test hook; plans and assertions execute in browser_test.rs. */
export function runNativeBrowser(artifact:CompileArtifact,capture:SingleFileCapture,artifactBytes:Uint8Array,handlers:Record<string,Handler>):Promise<unknown> {
  return policy('browser',{artifact,capture,artifactJson:Buffer.from(artifactBytes).toString('utf8')},{},handlers);
}
