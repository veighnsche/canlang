/** App-local first-owner setup; the provisioner retains exclusive storage custody. */
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {constants} from 'node:fs';
import {createServer,type IncomingMessage} from 'node:http';
import {link,lstat,open,realpath,unlink} from 'node:fs/promises';
import {dirname,isAbsolute,join} from 'node:path';
import {provisionSodaStorage} from './soda-run.js';
import type {SodaBundle} from './soda-contract.js';

interface SetupToken {operation:string;token:string;expires_at:number}
export interface SodaSetupReceipt {
  schema:'canlang.soda.setup.v1';operation:string;app:string;artifactDigest:string;bundleDigest:string;
  storageFingerprint:string;ownerTeam:string;completedAt:number;
}
export interface SodaSetupOptions {dataDir:string;tokenFile:string;receiptFile:string;host:string;port:number}

async function privateJSON(path:string):Promise<unknown>{
  if(!isAbsolute(path))throw new Error('Setup file must have an absolute path');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=await file.stat();
    if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o7777)!==0o600||stat.size>65536)
      throw new Error('Setup file must be a private account-owned regular file (mode 0600)');
    return JSON.parse(await file.readFile('utf8')) as unknown;
  }finally{await file.close();}
}
async function receiptDirectory(path:string):Promise<void>{
  if(!isAbsolute(path)||!(await realpath(dirname(path))).startsWith('/home/'))throw new Error('Setup receipt directory must be under /home');
  const stat=await lstat(dirname(path));
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||stat.mode&0o077)
    throw new Error('Setup receipt requires a private account-owned directory');
}
async function saveReceipt(path:string,receipt:SodaSetupReceipt):Promise<void>{
  const temporary=join(dirname(path),`.setup-receipt-${randomBytes(16).toString('hex')}`);
  const bytes=JSON.stringify(receipt);
  const file=await open(temporary,'wx',0o600);
  try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
  try{
    try{await link(temporary,path);}catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      if(JSON.stringify(await privateJSON(path))!==bytes)throw new Error('Setup receipt already belongs to another completion');
    }
    const directory=await open(dirname(path),constants.O_RDONLY);
    try{await directory.sync();}finally{await directory.close();}
  }finally{await unlink(temporary);}
}
async function body(request:IncomingMessage):Promise<Record<string,unknown>>{
  let count=0;const chunks:Buffer[]=[];
  for await(const chunk of request){const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as string);count+=value.length;if(count>65536)throw new Error('Setup request exceeds bound');chunks.push(value);}
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if(typeof input!=='object'||input===null||Array.isArray(input)||Object.keys(input).some(key=>!['operation','token','email','password','timezone'].includes(key)))
    throw new Error('Invalid setup request');
  return input as Record<string,unknown>;
}
function page(app:string,nonce:string):string{
  const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Create ${escape(app)} owner</title>
<style nonce="${nonce}">body{font:16px system-ui;max-width:32rem;margin:8vh auto;padding:1.5rem;color:#e8e9ec;background:#15171b}label{display:block;margin:1rem 0}input,button{box-sizing:border-box;width:100%;padding:.7rem;font:inherit;border:1px solid #64676e;border-radius:.35rem}button{cursor:pointer;background:#cfe3c8}p{line-height:1.5}</style>
<h1>Create ${escape(app)} owner</h1><p>This account belongs to this application. Use an email address and a password for its first owner.</p>
<form hidden><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="512" required></label><label>Timezone<input name="timezone" required></label><button>Create owner</button></form><p role="status">Open the setup link from SodaOS to continue.</p>
<script nonce="${nonce}">const params=new URLSearchParams(location.hash.slice(1));const operation=params.get('operation'),token=params.get('token');history.replaceState(null,'',location.pathname);const form=document.querySelector('form'),status=document.querySelector('[role=status]');if(operation&&token){form.hidden=false;status.textContent='';form.elements.timezone.value=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const response=await fetch('/setup/claim',{method:'POST',credentials:'omit',headers:{'content-type':'application/json'},body:JSON.stringify({operation,token,email:form.elements.email.value,password:form.elements.password.value,timezone:form.elements.timezone.value})});if(!response.ok)throw Error();form.reset();form.hidden=true;status.textContent='Owner created. Return to SodaOS to start the application.';}catch{status.textContent='Setup could not complete. Check your details and the setup link, then try again.';button.disabled=false;}});</script></html>`;
}

export async function startSodaSetup(input:SodaBundle,options:SodaSetupOptions):Promise<{origin:string;dispose:()=>Promise<void>}>{
  const token=await privateJSON(options.tokenFile) as SetupToken;
  if(typeof token!=='object'||token===null||Object.keys(token).sort().join(',')!=='expires_at,operation,token'||
    typeof token.operation!=='string'||!/^[A-Za-z0-9._:-]{1,160}$/.test(token.operation)||
    typeof token.token!=='string'||token.token.length<32||token.token.length>512||
    !Number.isSafeInteger(token.expires_at)||token.expires_at<Math.floor(Date.now()/1000))
    throw new Error('Setup token is malformed or expired');
  await receiptDirectory(options.receiptFile);
  const origin=input.environment.vars.CAN_AUTH_ORIGIN!;
  const parsed=new URL(origin);
  if(parsed.origin!==origin||parsed.protocol!=='https:')throw new Error('First-owner setup requires the exact HTTPS application origin');
  const context={app:input.descriptor.identity.appName,artifactDigest:input.descriptor.identity.artifactDigest,
    bundleDigest:input.bundle.mixedSha256,storageFingerprint:input.storageFingerprint};
  const contextJSON=JSON.stringify(context);
  const tokenBytes=Buffer.from(token.token);
  const provision=await provisionSodaStorage(input,options.dataDir);
  const server=createServer((request,response)=>{
    response.setHeader('cache-control','no-store');response.setHeader('referrer-policy','no-referrer');response.setHeader('x-content-type-options','nosniff');
    const path=request.url??'/';
    if(request.method==='GET'&&path==='/setup'){
      const nonce=randomBytes(18).toString('base64');
      response.setHeader('content-security-policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'`);
      response.setHeader('content-type','text/html;charset=utf-8');response.end(page(context.app,nonce));return;
    }
    if(request.method!=='POST'||path!=='/setup/claim'){response.writeHead(404);response.end();return;}
    void(async()=>{
      if(request.headers.origin!==origin||request.headers['content-type']!=='application/json')throw new Error('Setup origin refused');
      const claim=await body(request);
      const offered=typeof claim.token==='string'?Buffer.from(claim.token):Buffer.alloc(0);
      if(claim.operation!==token.operation||offered.length!==tokenBytes.length||!timingSafeEqual(offered,tokenBytes)||Math.floor(Date.now()/1000)>token.expires_at)
        throw new Error('Setup admission refused');
      const result=await provision.dispatchUrl('https://private.invalid/setup',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({email:claim.email,password:claim.password,...(claim.timezone===undefined?{}:{timezone:claim.timezone}),
          setup:{operation:token.operation,tokenHash:createHash('sha256').update(tokenBytes).digest('hex'),context:contextJSON,expiresAt:token.expires_at}})});
      if(!result.ok)throw new Error('Setup claim refused');
      const owner=await result.json() as {teamId:string;completedAt:number};
      if(!/^[a-f0-9-]{36}$/i.test(owner.teamId)||!Number.isSafeInteger(owner.completedAt))throw new Error('Setup completion unavailable');
      const receipt:SodaSetupReceipt={schema:'canlang.soda.setup.v1',operation:token.operation,...context,ownerTeam:owner.teamId,completedAt:owner.completedAt};
      await saveReceipt(options.receiptFile,receipt);
      response.setHeader('content-type','application/json');response.end(JSON.stringify(receipt));
    })().catch(()=>{if(!response.headersSent)response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({error:'Setup could not complete. Check the details and setup link.'}));});
  });
  server.requestTimeout=10_000;server.headersTimeout=5_000;
  let closing:Promise<void>|undefined;
  const dispose=()=>closing??=(async()=>{
    try{if(server.listening)await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeIdleConnections();});}
    finally{await provision.dispose();}
  })();
  try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port,options.host,resolve);});}
  catch(error){await dispose();throw error;}
  void provision.failed.then(async()=>{process.exitCode=1;await dispose();});
  return {origin,dispose};
}
