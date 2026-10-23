#!/usr/bin/env node
/** Exercise only the production subtree: setup, private administration and app serving. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,readdir,stat,unlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createSodaTestGateway,openSodaHttpClient} from './verify-soda-runtime.mjs';

const option=name=>{const index=process.argv.indexOf(name);assert.ok(index>=0&&process.argv[index+1],`${name} is required`);return resolve(process.argv[index+1]);};
const runtime=option('--runtime'),bundle=option('--bundle'),toolRoot=option('--tool-root'),root=option('--state');
assert.ok(root.startsWith('/home/'));await mkdir(root,{recursive:true,mode:0o700});const state=await mkdtemp(join(root,'run-'));
const data=join(state,'data'),privateDir=join(state,'private');await mkdir(data,{mode:0o700});await mkdir(privateDir,{mode:0o700});
const command=join(runtime,'bin/can-soda');
const scan=async path=>{for(const item of await readdir(path,{withFileTypes:true})){assert.ok(!['miniflare','wrangler','testkit','compiler'].includes(item.name),`Development dependency in runtime: ${item.name}`);if(item.isDirectory())await scan(join(path,item.name));}};await scan(runtime);
assert.ok(JSON.parse(execFileSync(command,['inventory'],{encoding:'utf8'})).d1.supported);
assert.ok(JSON.parse(execFileSync(command,['help'],{encoding:'utf8'})).commands.setup);
assert.throws(()=>execFileSync(command,['build'],{stdio:'ignore'}));
const input=JSON.parse(await readFile(bundle,'utf8'));
const gateway=await createSodaTestGateway(toolRoot,state,{origin:input.environment.vars.CAN_AUTH_ORIGIN});
const token={operation:randomUUID(),token:randomBytes(32).toString('base64url'),expires_at:Math.floor(Date.now()/1000)+600};
const tokenPath=join(privateDir,'token.json'),receiptPath=join(privateDir,'receipt.json'),credentialsPath=join(privateDir,'owner.json');
const credentials={email:'owner@native-setup.test',password:randomBytes(32).toString('base64url'),timezone:'UTC'};
await writeFile(tokenPath,JSON.stringify(token),{mode:0o600});await writeFile(credentialsPath,JSON.stringify(credentials),{mode:0o600});
let running;
async function start(mode,extra=[]){
 const child=spawn(command,[mode,'--bundle',bundle,'--data',data,'--host','127.0.0.1','--port',String(gateway.backendPort),...extra],{stdio:['ignore','pipe','pipe']});
 const closed=once(child,'close');let output='',errors='';child.stderr.on('data',bytes=>{errors+=bytes;});
 try{await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Production command startup timed out')),20000);
  child.once('close',()=>{clearTimeout(timeout);reject(new Error(`Production command exited before ready (${errors.slice(0,500)})`));});
  child.stdout.on('data',bytes=>{output+=bytes;if(output.length>65536){reject(new Error('Unbounded production readiness'));return;}for(const line of output.split('\n')){try{const value=JSON.parse(line);if(value.ok&&value.command===mode){clearTimeout(timeout);resolve();}}catch{}}});
 });}catch(error){child.kill('SIGKILL');await closed;throw error;}
 assert.ok(!output.includes(token.token)&&!output.includes(credentials.password)&&!errors.includes(credentials.password),'Readiness must not disclose setup secrets');
 return {async stop(){child.kill('SIGTERM');const deadline=setTimeout(()=>child.kill('SIGKILL'),16000);try{const [code,signal]=await closed;assert.equal(code,0,`Production shutdown failed (${signal}): ${errors.slice(0,500)}`);}finally{clearTimeout(deadline);}}};
}
const setup=()=>start('setup',['--setup-token-file',tokenPath,'--setup-receipt-file',receiptPath]);
const claim=async(change={},origin=gateway.origin)=>{const response=await fetch(`${gateway.origin}/setup/claim`,{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({...token,...credentials,expires_at:undefined,...change})});return {status:response.status,body:await response.json()};};
try{
 running=await setup();
 for(const path of ['/','/mcp','/auth/login','/__soda_ready'])assert.equal((await fetch(`${gateway.origin}${path}`)).status,404);
 const form=await fetch(`${gateway.origin}/setup`);assert.equal(form.status,200);assert.ok((await form.text()).includes('Create SodaRuntime owner'));
 assert.equal((await claim({},'https://foreign.test')).status,400);assert.equal((await claim({token:'wrong-token'})).status,400);assert.equal((await claim({operation:'foreign-operation'})).status,400);
 const completed=await claim();assert.equal(completed.status,200,JSON.stringify(completed.body));
 const receipt=completed.body;assert.equal(receipt.schema,'canlang.soda.setup.v1');assert.equal(receipt.bundleDigest,input.bundle.mixedSha256);assert.equal(receipt.artifactDigest,input.descriptor.identity.artifactDigest);assert.equal(receipt.operation,token.operation);
 const saved=await readFile(receiptPath,'utf8');assert.deepEqual(JSON.parse(saved),receipt);assert.equal((await stat(receiptPath)).mode&0o777,0o600);assert.ok(!saved.includes(token.token)&&!saved.includes(credentials.password));
 assert.deepEqual((await claim()).body,receipt);assert.equal((await claim({password:'ConflictingPassword123'})).status,400);
 await unlink(receiptPath);assert.deepEqual((await claim()).body,receipt);assert.deepEqual(JSON.parse(await readFile(receiptPath,'utf8')),receipt);
 await running.stop();running=undefined;
 running=await setup();assert.deepEqual((await claim()).body,receipt);await running.stop();running=undefined;
 const owner=JSON.parse(execFileSync(command,['bootstrap','--bundle',bundle,'--data',data,'--credentials',credentialsPath],{encoding:'utf8'}));assert.equal(owner.teamId,receipt.ownerTeam);
 const memberCredentials={email:'member@native-setup.test',password:randomBytes(32).toString('base64url')};const memberFile=join(privateDir,'member.json');await writeFile(memberFile,JSON.stringify(memberCredentials),{mode:0o600});
 const member=JSON.parse(execFileSync(command,['member','--bundle',bundle,'--data',data,'--owner',receipt.ownerTeam,'--credentials',memberFile],{encoding:'utf8'}));assert.equal(member.teamId,receipt.ownerTeam);
 const serve=()=>start('serve',['--owner',receipt.ownerTeam]);running=await serve();
 const actors=[{label:'Ava',...credentials},{label:'Ben',...memberCredentials}];
 const client=await openSodaHttpClient({toolRoot,origin:gateway.origin,actors},'Ava');const ordinary=await openSodaHttpClient({toolRoot,origin:gateway.origin,actors},'Ben');
 const created=await client.mutate('Entry.create',{label:'Offline direct runtime'});const entry=created.records[0];await client.upload(entry);
 assert.equal((await ordinary.request(`/files/read/SodaRuntime.Entry/${entry.id}/attachment`)).status,404);
 const current=(await client.entries()).find(row=>row.id===entry.id);const due=Date.now()+1800;await client.mutate('arm',{entry:{id:current.id,version:String(current.version)},due:new Date(due).toISOString()});
 await running.stop();running=undefined;await new Promise(resolve=>setTimeout(resolve,Math.max(0,due+200-Date.now())));running=await serve();
 let retained;for(let i=0;i<80;i++){retained=(await client.entries()).find(row=>row.id===entry.id);if(retained.data.ticks==='1')break;await new Promise(resolve=>setTimeout(resolve,100));}
 assert.equal(retained.data.ticks,'1');const file=await client.request(`/files/read/SodaRuntime.Entry/${entry.id}/attachment`);assert.equal(file.status,200);assert.deepEqual(Buffer.from(await file.arrayBuffer()),Buffer.from('%PDF-1.4\ntrailer\n'));
 await running.stop();running=undefined;
 await writeFile(tokenPath,JSON.stringify({...token,expires_at:1}),{mode:0o600});
 assert.throws(()=>execFileSync(command,['setup','--bundle',bundle,'--data',data,'--host','127.0.0.1','--port',String(gateway.backendPort),'--setup-token-file',tokenPath,'--setup-receipt-file',receiptPath],{stdio:'ignore',timeout:15000}));
 console.log(JSON.stringify({ok:true,productionClosure:true,noMiniflare:true,protectedSetup:true,ownerAndTokenAtomic:true,matchingReplay:true,conflictingClaimRefused:true,expiredRefused:true,lostReceiptRecovered:true,restartReceipt:true,privateReceipt:true,offlineBootstrapMemberServe:true,realLoginMcpFilesWork:true,retainedRestart:true,state}));
}finally{try{await running?.stop();}finally{await gateway.close();}}
