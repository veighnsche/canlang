/** Direct workerd owner. Its inherited checked lock survives until actual exit. */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdtemp, open, rm, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageWorkerdConfig, type DirectWorkerOptions } from './workerd-config.js';

export interface SodaWorker {
  dispatchUrl(url: string, init?: RequestInit): Promise<Response>;
  readonly failed: Promise<Error>;
  dispose(): Promise<void>;
}

async function retainedStorage(path: string | undefined): Promise<void> {
  if (path === undefined || !isAbsolute(path)) throw new Error('required Soda storage must be an existing absolute directory');
  try {
    const info=await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('not a directory');
    await access(path,constants.R_OK|constants.W_OK|constants.X_OK);
    const probe=join(path,`.can-storage-probe-${randomBytes(16).toString('hex')}`);
    const file=await open(probe,'wx',0o600);
    try { await file.writeFile('storage preflight\n'); await file.sync(); }
    finally { await file.close(); await unlink(probe); }
  } catch { throw new Error('required Soda storage is unavailable or unwritable'); }
}

export async function startSodaWorker(options: DirectWorkerOptions, lockFD: number): Promise<SodaWorker> {
  await retainedStorage(options.d1Persist);
  if (options.durableObjects?.length) await retainedStorage(options.durableObjectsPersist);
  const stage = await mkdtemp(join(options.d1Persist,'../tmp/workerd-'));
  let child: ReturnType<typeof spawn> | undefined;
  let stopped = false;
  let closed: Promise<void> = Promise.resolve();
  let closing: Promise<void> | undefined;
  let fail!: (error: Error) => void;
  const failed = new Promise<Error>(resolve=>{fail=resolve;});
  const dispose = (): Promise<void> => closing ??= (async()=>{
    stopped=true;
    if (child?.exitCode===null && child.signalCode===null) child.kill('SIGTERM');
    const deadline=setTimeout(()=>child?.kill('SIGKILL'),10_000);
    try { await closed; } finally { clearTimeout(deadline); await rm(stage,{recursive:true,force:true}); }
  })();
  try {
    const secret=randomBytes(32).toString('base64url');
    const config=await stageWorkerdConfig(options,stage,secret);
    const require=createRequire(import.meta.url);
    const workerd=(require('workerd') as {default:string}).default;
    const guard=fileURLToPath(new URL('../host/can-workerd-exec',import.meta.url));
    child=spawn(guard,[String(process.pid),'4','3',workerd,'--','serve','--experimental','--control-fd=3',config],
      {stdio:['ignore','inherit','inherit','pipe',lockFD]});
    const owned=child;
    closed=new Promise<void>(resolve=>{owned.once('error',()=>resolve());owned.once('close',(code,signal)=>{
      if (!stopped) fail(new Error(`Soda workerd exited unexpectedly (${signal??code})`));
      resolve();
    });});
    const port=await new Promise<number>((resolve,reject)=>{
      let text='';
      const timeout=setTimeout(()=>reject(new Error('Soda workerd startup timed out')),15_000);
      owned.once('error',reject);
      owned.once('close',()=>reject(new Error('Soda workerd exited before readiness')));
      owned.stdio[3]!.on('data',(bytes: Buffer)=>{
        text+=bytes.toString();
        if(text.length>65536){reject(new Error('Invalid Soda workerd control response'));return;}
        for(let newline=text.indexOf('\n');newline>=0;newline=text.indexOf('\n')){
          const line=text.slice(0,newline);text=text.slice(newline+1);
          try{const item=JSON.parse(line) as {event?:string;socket?:string;port?:number};
            if(item.event==='listen' && item.socket==='private' && Number.isInteger(item.port) && item.port!>0){clearTimeout(timeout);resolve(item.port!);}
          }catch{reject(new Error('Invalid Soda workerd control response'));}
        }
      });
      void closed.then(()=>clearTimeout(timeout));
    });
    return {failed,dispose,async dispatchUrl(url,init){
      if(stopped || owned.exitCode!==null || owned.signalCode!==null)throw new Error('Soda workerd is unavailable');
      const headers=new Headers(init?.headers);
      headers.delete('x-soda-dispatch');headers.delete('x-soda-url');
      headers.set('x-soda-dispatch',secret);headers.set('x-soda-url',url);
      return fetch(`http://127.0.0.1:${port}/`,{...init,headers,redirect:'manual'});
    }};
  }catch(error){await dispose();throw error;}
}
