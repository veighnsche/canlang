#!/usr/bin/env node
/** Real built-in D1 -> owned provider -> native disk, alarms and exec lifetime. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,mkdtemp,open,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startSodaWorker} from '@canlang/cloudflare/deploy/soda-workerd';

const option=name=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
const root=resolve(option('--state')??'/home/vince/Projects/.canlang-runtime-work/direct');
assert.ok(root.startsWith('/home/'));
await mkdir(root,{recursive:true,mode:0o700});
const state=process.argv.includes('--child')?root:await mkdtemp(join(root,'run-'));
for(const name of ['d1','objects','tmp'])await mkdir(join(state,name),{recursive:true,mode:0o700});
const source=String.raw`
export class GateActor {
  constructor(state){this.state=state;this.sql=state.storage.sql;this.sql.exec('CREATE TABLE IF NOT EXISTS alarms(value INTEGER)');}
  async fetch(request){if(new URL(request.url).pathname==='/arm'){await this.state.storage.setAlarm(Date.now()+1200);await this.state.storage.sync();}
    return Response.json([...this.sql.exec('SELECT * FROM alarms')]);}
  async alarm(){this.sql.exec('INSERT INTO alarms(value) VALUES(1)');await this.state.storage.sync();}
}
export default {async fetch(request,env){
 const path=new URL(request.url).pathname;
 if(path==='/arm'||path==='/alarms')return env.ACTOR.get(env.ACTOR.idFromName('gate')).fetch(request);
 if(path==='/contract'){
  await env.DB.exec('CREATE TABLE IF NOT EXISTS records(id INTEGER PRIMARY KEY, value TEXT UNIQUE, bytes BLOB, optional TEXT)');
  const inserted=await env.DB.prepare('INSERT INTO records(value,bytes,optional) VALUES(?,?,?) RETURNING id,value').bind('acknowledged',new Uint8Array([0,127,255]),null).first();
  let rejected=false;try{await env.DB.batch([env.DB.prepare("INSERT INTO records(value) VALUES ('must-rollback')"),env.DB.prepare("INSERT INTO records(value) VALUES ('acknowledged')")]);}catch{rejected=true;}
  const rows=await env.DB.prepare('SELECT id,value,hex(bytes) AS bytes,optional,json_extract(?,\'$.number\') AS number FROM records').bind('{"number":7}').all();
  const updates=await Promise.all([1,2].map(()=>env.DB.prepare('UPDATE records SET optional=? WHERE optional IS NULL').bind('claimed').run()));
  await env.OTHER.exec('CREATE TABLE IF NOT EXISTS records(value TEXT)');
  const separate=await env.OTHER.prepare('SELECT count(*) AS n FROM records').first('n');
  const snapshot=await env.DB.batch([env.DB.prepare('SELECT count(*) AS n FROM records'),env.DB.prepare('SELECT count(*) AS n FROM records')]);
  return Response.json({inserted,rejected,rows,changes:updates.map(result=>result.meta.changes),separate,snapshot:snapshot.map(result=>result.results[0].n)});
 }
 return Response.json(await env.DB.prepare('SELECT value FROM records ORDER BY id').all());
}};`;
const options={workerName:'direct-gate',compatibilityDate:'2026-07-15',mainModule:'gate.js',modules:{'gate.js':source},
 d1Databases:[{binding:'DB',id:'identity'},{binding:'OTHER',id:'state'}],d1Persist:join(state,'d1'),
 durableObjects:[{binding:'ACTOR',className:'GateActor',useSQLite:true}],durableObjectsPersist:join(state,'objects')};

async function acquire(){
 const file=await open(join(state,'lock'),'a+',0o600);
 const holder=spawn('sh',['-c','flock -n 3 || exit 1; printf "locked\\n"; exec cat'],{stdio:['pipe','pipe','inherit',file.fd]});
 const closed=once(holder,'close');
 await Promise.race([once(holder.stdout,'data'),closed.then(()=>{throw new Error('writer already held');})]);
 holder.stdin.end();await closed;return file;
}
function compete(){try{execFileSync('flock',['-n',join(state,'lock'),'true'],{stdio:'ignore'});return true;}catch{return false;}}
async function start(){const file=await acquire();try{const runtime=await startSodaWorker(options,file.fd);
 return {...runtime,stop:async()=>{try{await runtime.dispose();}finally{await file.close();}}};}catch(error){await file.close();throw error;}}
const request=async(runtime,path)=>{const result=await runtime.dispatchUrl(`https://gate.test${path}`);assert.equal(result.status,200,await result.clone().text());return result.json();};

if(process.argv.includes('--child')){
 const runtime=await start();
 const children=(await readFile(`/proc/${process.pid}/task/${process.pid}/children`,'utf8')).trim().split(/\s+/).map(Number);
 process.send({ready:true,pid:children[0]});
 process.on('message',async message=>{if(message==='stop'){await runtime.stop();process.disconnect();}});
}else{
 let runtime=await start();
 try{
  assert.equal(compete(),false,'checked Node/workerd description must exclude another writer after acquisition helper exit');
  const contract=await request(runtime,'/contract');
  assert.equal(contract.inserted.value,'acknowledged');assert.equal(contract.rejected,true);
  assert.equal(contract.rows.results.length,1);assert.equal(contract.rows.results[0].bytes,'007FFF');
  assert.equal(contract.rows.results[0].optional,null);assert.equal(contract.rows.results[0].number,7);
  assert.deepEqual([...contract.changes].sort(),[0,1]);assert.equal(contract.separate,0);assert.deepEqual(contract.snapshot,[1,1]);
  await request(runtime,'/arm');
 }finally{await runtime.stop();}
 assert.equal(compete(),true);
 runtime=await start();
 try{
  // No public request or manual wake after restart until the overdue alarm fires.
  await new Promise(resolve=>setTimeout(resolve,1800));
  assert.equal((await request(runtime,'/alarms')).length,1);
  assert.deepEqual((await request(runtime,'/')).results,[{value:'acknowledged'}]);
 }finally{await runtime.stop();}
 const script=fileURLToPath(import.meta.url);
 const parent=spawn(process.execPath,[script,'--child','--state',state],{stdio:['ignore','inherit','inherit','ipc']});
 const parentClosed=once(parent,'close');
 const [ready]=await once(parent,'message');assert.equal(ready.ready,true);assert.equal(compete(),false);
 assert.match(await readFile(`/proc/${ready.pid}/fdinfo/4`,'utf8'),/FLOCK/,'shipping workerd retains the inherited lock FD');
 parent.kill('SIGKILL');await parentClosed;
 for(let i=0;i<100&&!compete();i++)await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(compete(),true,'parent death must retire workerd before another writer starts');
 const mismatch=spawn(resolve('packages/cloudflare/dist/host/can-workerd-exec'),['1','4','3',process.execPath,'--','-e','process.exit(88)'],
  {stdio:['ignore','ignore','pipe','pipe','pipe']});
 const [code]=await once(mismatch,'close');assert.equal(code,1,'a dead/mismatched expected parent refuses before exec');
 runtime=await start();try{assert.deepEqual((await request(runtime,'/')).results,[{value:'acknowledged'}]);}finally{await runtime.stop();}
 runtime=await start();
 const nativeChildren=(await readFile(`/proc/${process.pid}/task/${process.pid}/children`,'utf8')).trim().split(/\s+/).map(Number);
 assert.equal(nativeChildren.length,1);
 process.kill(nativeChildren[0],'SIGSTOP');
 const stopping=runtime.stop();
 await new Promise(resolve=>setTimeout(resolve,100));assert.equal(compete(),false,'a delayed writer must keep its inherited lock until it actually exits');
 await assert.rejects(stopping,/forced termination|termination failed/);assert.equal(compete(),true);
 console.log(JSON.stringify({ok:true,nativeD1:true,atomicFailedBatch:true,blobNullReturningJSON:true,oneWinnerChanges:true,
  separateDatabases:true,coherentBatch:true,acknowledgedRecovery:true,autonomousAlarmRecovery:true,inheritedFlock:true,parentKill:true,parentRaceRefusal:true,forcedTerminationFails:true,delayedWriterExclusion:true,state}));
}
