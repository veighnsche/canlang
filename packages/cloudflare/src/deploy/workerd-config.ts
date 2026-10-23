/** Render only admitted module bytes and explicit local service bindings. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SODA_D1_SOURCE } from '../runtime/soda-d1.js';

export interface DirectWorkerOptions {
  workerName: string;
  compatibilityDate: string;
  compatibilityFlags?: readonly string[];
  mainModule: string;
  modules: Readonly<Record<string,string>>;
  binaryModules?: Readonly<Record<string,Uint8Array>>;
  d1Databases: readonly {binding:string;id:string}[];
  d1Persist: string;
  durableObjects?: readonly {binding:string;className:string;useSQLite:boolean}[];
  durableObjectsPersist?: string;
  vars?: Readonly<Record<string,unknown>>;
}
const quote = (value: string): string => JSON.stringify(value);
const service = (name: string): string => `(name = ${quote(name)})`;
const binding = (name: string, value: string): string => `(name = ${quote(name)}, ${value})`;
const gateway = `export default {async fetch(request,env){
  if(request.headers.get('x-soda-dispatch')!==env.SECRET)return new Response(null,{status:403});
  const target=request.headers.get('x-soda-url');
  const headers=new Headers(request.headers);headers.delete('x-soda-dispatch');headers.delete('x-soda-url');
  return env.APP.fetch(new Request(target,{method:request.method,headers,
    body:['GET','HEAD'].includes(request.method)?undefined:request.body,redirect:'manual'}));
}};`;

export async function stageWorkerdConfig(options: DirectWorkerOptions, stage: string, secret: string): Promise<string> {
  const names = new Set<string>();
  const modules: string[] = [];
  const ordered = [options.mainModule,...Object.keys(options.modules).filter(name=>name!==options.mainModule)];
  if (options.modules[options.mainModule] === undefined) throw new Error('Soda Worker entry module is missing');
  for (const [name, value, type] of [
    ...ordered.map(name=>[name,options.modules[name]!,'esModule'] as const),
    ...Object.entries(options.binaryModules??{}).map(([name,bytes])=>[name,bytes,'wasm'] as const),
  ]) {
    if (!/^[a-zA-Z0-9_@./-]+$/.test(name) || name.startsWith('/') || name.split('/').some(part=>part==='..' || part==='.') || names.has(name))
      throw new Error('Invalid or duplicate Soda module path');
    names.add(name);
    const file = `module-${modules.length}`;
    await writeFile(join(stage,file),value,{flag:'wx',mode:0o600});
    modules.push(`(name = ${quote(name)}, ${type} = embed ${quote(file)})`);
  }
  const d1Bindings = options.d1Databases.map(({binding:name},i)=>binding(name,
    `wrapped = (moduleName = "cloudflare-internal:d1-api", innerBindings = [${binding('fetcher',`service = ${service(`d1-${i}`)}`)}])`));
  const objectBindings = (options.durableObjects??[]).map(object=>binding(object.binding,
    `durableObjectNamespace = (className = ${quote(object.className)})`));
  const vars = Object.entries(options.vars??{}).map(([name,value])=>binding(name,`json = ${quote(JSON.stringify(value))}`));
  const namespaces = (options.durableObjects??[]).map(object=>`(className = ${quote(object.className)}, uniqueKey = ${quote(`${options.workerName}-${object.className}`)}, enableSql = ${object.useSQLite})`);
  const providers = options.d1Databases.map(({id},i)=>`(name = "d1-${i}", worker = (
    compatibilityDate = "2023-07-24", compatibilityFlags = ["nodejs_compat"],
    modules = [(name = "d1.js", esModule = ${quote(SODA_D1_SOURCE)})],
    bindings = [${binding('RESOURCE',`text = ${quote(id)}`)},${binding('DATABASE','durableObjectNamespace = (className = "D1DatabaseObject", serviceName = "d1-objects")')}],
    globalOutbound = ${service('deny')}))`);
  const config = `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "entry", worker = (compatibilityDate = "2026-07-15",
      modules = [(name = "gateway.js", esModule = ${quote(gateway)})],
      bindings = [${binding('SECRET',`text = ${quote(secret)}`)},${binding('APP',`service = ${service('app')}`)}], globalOutbound = ${service('deny')})),
    (name = "app", worker = (compatibilityDate = ${quote(options.compatibilityDate)},
      compatibilityFlags = [${(options.compatibilityFlags??[]).map(quote).join(',')}], modules = [${modules.join(',')}],
      bindings = [${[...d1Bindings,...objectBindings,...vars].join(',')}],
      durableObjectNamespaces = [${namespaces.join(',')}],
      ${namespaces.length ? 'durableObjectStorage = (localDisk = "objects-disk"),' : ''}
      globalOutbound = ${service('deny')})),
    (name = "d1-objects", worker = (compatibilityDate = "2023-07-24", compatibilityFlags = ["nodejs_compat"],
      modules = [(name = "d1.js", esModule = ${quote(SODA_D1_SOURCE)})],
      durableObjectNamespaces = [(className = "D1DatabaseObject", uniqueKey = "miniflare-D1DatabaseObject", enableSql = true)],
      durableObjectStorage = (localDisk = "d1-disk"), globalOutbound = ${service('deny')})),
    ${providers.map(value=>value+',').join('\n')}
    (name = "d1-disk", disk = (path = ${quote(options.d1Persist)}, writable = true)),
    ${options.durableObjectsPersist ? `(name = "objects-disk", disk = (path = ${quote(options.durableObjectsPersist)}, writable = true)),` : ''}
    (name = "deny", network = (allow = []))
  ], sockets = [(name = "private", address = "127.0.0.1:0", http = (), service = ${service('entry')})]
);
`;
  const path = join(stage,'config.capnp');
  await writeFile(path,config,{flag:'wx',mode:0o600});
  return path;
}
