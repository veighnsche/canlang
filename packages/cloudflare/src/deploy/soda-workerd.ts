/** Deployment-owned workerd SDK adapter for Soda's retained D1/DO resources. */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Miniflare, type DispatchFetch, type WorkerOptions } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { cleanupAfterFailure, retryableDispose } from "../runtime/resource-lifetime.js";

type DispatchInit = Parameters<DispatchFetch>[1];
export interface SodaWorker {
  dispatchUrl(url: string, init?: DispatchInit): ReturnType<DispatchFetch>;
  getD1Database(binding: string): Promise<D1Database>;
  dispose(): Promise<void>;
}
interface SodaWorkerOptions {
  workerName: string;
  compatibilityDate: string;
  compatibilityFlags?: readonly string[];
  mainModule: string;
  modules: Readonly<Record<string,string>>;
  binaryModules?: Readonly<Record<string,Uint8Array>>;
  d1Databases: readonly { binding: string; id: string }[];
  d1Persist: string;
  durableObjects?: readonly { binding: string; className: string; useSQLite: boolean }[];
  durableObjectsPersist?: string;
  vars?: Readonly<Record<string,unknown>>;
}
const gateway = `export default {async fetch(request,env){
  if(request.headers.get('x-soda-dispatch')!==env.SECRET)return new Response(null,{status:403});
  const headers=new Headers(request.headers);headers.delete('x-soda-dispatch');
  return env.APP.fetch(new Request(request,{headers}));
}};`;
async function retainedStorage(path: string | undefined): Promise<void> {
  if (path === undefined || !isAbsolute(path)) throw new Error("required Soda storage must be an existing absolute directory");
  try {
    const info=await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("not a directory");
    await access(path,constants.R_OK|constants.W_OK|constants.X_OK);
    const probe=join(path,`.can-storage-probe-${randomBytes(16).toString("hex")}`);
    const file=await open(probe,"wx",0o600);
    try { await file.writeFile("storage preflight\n"); await file.sync(); }
    finally { await file.close(); await unlink(probe); }
  } catch { throw new Error("required Soda storage is unavailable or unwritable"); }
}
export async function startSodaWorker(options: SodaWorkerOptions): Promise<SodaWorker> {
  await retainedStorage(options.d1Persist);
  if (options.durableObjects?.length) await retainedStorage(options.durableObjectsPersist);
  const main=options.modules[options.mainModule];
  if (main===undefined) throw new Error("Soda Worker entry module is missing");
  const modules: Exclude<WorkerOptions["modules"],boolean|undefined>=[{path:options.mainModule,type:"ESModule",contents:main}];
  for (const [path,contents] of Object.entries(options.modules)) if(path!==options.mainModule) modules.push({path,type:"ESModule",contents});
  for (const [path,bytes] of Object.entries(options.binaryModules??{})) {
    if(Object.hasOwn(options.modules,path)) throw new Error("Soda binary module collides with text module");
    modules.push({path,type:"CompiledWasm",contents:new Uint8Array(bytes)});
  }
  const secret=randomBytes(32).toString("base64url");
  const miniflare=new Miniflare({cf:false,host:"127.0.0.1",port:0,d1Persist:options.d1Persist,
    ...(options.durableObjectsPersist===undefined?{}:{durableObjectsPersist:options.durableObjectsPersist}),
    workers:[{name:`soda-gateway-${randomBytes(8).toString("hex")}`,compatibilityDate:options.compatibilityDate,
      modules:true,script:gateway,bindings:{SECRET:secret},serviceBindings:{APP:options.workerName}},
    {name:options.workerName,compatibilityDate:options.compatibilityDate,compatibilityFlags:[...(options.compatibilityFlags??[])],
      outboundService:{network:{allow:[]}},modules,bindings:{...(options.vars??{})},
      d1Databases:Object.fromEntries(options.d1Databases.map(({binding,id})=>[binding,id])),
      durableObjects:Object.fromEntries((options.durableObjects??[]).map(({binding,...definition})=>[binding,definition])),
    }],
  });
  let startupFailure: unknown;
  const dispose=retryableDispose(async()=>{
    try { await miniflare.dispose(); }
    catch(error){if(startupFailure===undefined || error!==startupFailure)throw error;}
  });
  try { await miniflare.ready; }
  catch(error){startupFailure=error;return cleanupAfterFailure(error,dispose);}
  return {
    dispatchUrl(url,init){const headers=new Headers(init?.headers);headers.set("x-soda-dispatch",secret);
      return miniflare.dispatchFetch(url,{...init,headers:[...headers]});},
    getD1Database:binding=>miniflare.getD1Database(binding,options.workerName),
    dispose,
  };
}
