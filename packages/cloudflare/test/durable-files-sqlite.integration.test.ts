/** Real workerd SQLite Durable Object: Files kernel authority stays inside one isolate. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare } from 'miniflare';
import { it } from 'vitest';
import { createSqliteFileStore } from '../../files/src/host/sqlite.js';

it('migrates retained Node blobs without changing store identity or bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-legacy-files-'));
  const path = join(directory, 'files.sqlite');
  const bytes = new Uint8Array(131073).map((_, index) => index % 251);
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE files_blobs (key TEXT PRIMARY KEY, bytes BLOB NOT NULL);
    CREATE TABLE files_store_identity (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), file_store_id TEXT NOT NULL, authority_json TEXT);
    INSERT INTO files_store_identity VALUES (1, 'retained-physical-store', NULL)`);
  legacy.prepare('INSERT INTO files_blobs (key, bytes) VALUES (?, ?)').run('legacy.bin', bytes);
  legacy.prepare('INSERT INTO files_blobs (key, bytes) VALUES (?, ?)').run('empty.bin', new Uint8Array());
  legacy.close();
  try {
    const store = createSqliteFileStore(path);
    try {
      assert.equal(store.fileStoreId, 'retained-physical-store');
      assert.deepEqual(store.blobs.read('legacy.bin'), bytes);
      assert.deepEqual(store.blobs.read('empty.bin'), new Uint8Array());
      const suffix = new Uint8Array([1, 2, 3]);
      store.blobs.append('legacy.bin', suffix);
      assert.deepEqual(store.blobs.read('legacy.bin'), new Uint8Array([...bytes, ...suffix]));
    } finally { store.close(); }
    const reopened = createSqliteFileStore(path);
    try {
      assert.equal(reopened.fileStoreId, 'retained-physical-store');
      assert.equal(reopened.blobs.sizeOf('legacy.bin'), bytes.byteLength + 3);
      assert.deepEqual(reopened.blobs.read('empty.bin'), new Uint8Array());
    } finally { reopened.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('persists real finalized bytes and metadata, preserves observation issuance, and rolls back both', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-durable-files-'));
  const entry = join(directory, 'entry.js');
  const output = join(directory, 'worker.js');
  const adapter = fileURLToPath(new URL('../../files/dist/src/host/durable-sqlite.js', import.meta.url));
  const finalize = fileURLToPath(new URL('../../files/dist/src/finalize/index.js', import.meta.url));
  const upload = fileURLToPath(new URL('../../files/dist/src/upload/index.js', import.meta.url));
  await writeFile(entry, `
import {createDurableSqliteFileStore,createSqliteFileBindings} from ${JSON.stringify(adapter)};
import {readFinalizedFileObservation} from ${JSON.stringify(finalize)};
import {sha256Hex} from ${JSON.stringify(upload)};
const receiver={app:'DurableFilesProof',team:'team_1',owner:'team_1',principal:'user_1'};
const retention={unattachedHorizonMs:86400000,retentionMs:86400000};
const json=value=>Response.json(value);
export class FilesProof {
 constructor(ctx){
  this.store=createDurableSqliteFileStore(ctx.storage);
  this.files=createSqliteFileBindings(this.store,{clock:{nowMs:()=>Date.now()},intentTtlMs:900000,urlBase:'https://files.test'});
 }
 async fetch(request){
  if(new URL(request.url).pathname==='/maximum'){
   const large=new Uint8Array(10*1024*1024).fill(65);
   if(this.files.maxBytes!==large.length)throw new Error('Files default policy changed');
   if(request.method==='POST'){
    const input={upload_id:'maximum-upload',operation:'DurableFilesProof.Document.create',field:'/file',arguments:{},name:'maximum.txt',type:'text/plain',size:String(large.length)};
    const created=this.files.createIntent({request:input,receiver,binding:{adapter:'deployment.web',deliveryId:'maximum-request',resultPath:'file'}});
    if(created.status!=='granted')throw new Error('maximum intent failed');
    for(const [start,end] of [[0,65535],[65535,131073],[131073,large.length]]){
     const appended=this.files.append(created.intentId,receiver,large.subarray(start,end),start);
     if(appended.status!=='appended'||appended.receivedBytes!==end)throw new Error('maximum append failed');
    }
    const repeated=this.files.append(created.intentId,receiver,large.subarray(0,65535),0);
    if(repeated.status!=='appended'||repeated.receivedBytes!==65535)throw new Error('maximum replay duplicated bytes');
    if(this.files.complete(created.intentId,receiver).status!=='completed')throw new Error('maximum completion failed');
    const finalized=this.files.finalize({intentId:created.intentId,retryId:input.upload_id,caller:receiver,bytesDigest:sha256Hex(large)});
    if(finalized.status!=='finalized')throw new Error('maximum finalize failed');
   }
   const record=this.store.files.listAll().find(record=>record.file.sizeBytes===large.length);
   const bytes=this.files.readBytes(record.file.id,receiver);
   return json({ref:record.file.id,store:this.store.fileStoreId,size:bytes.length,digest:sha256Hex(bytes)});
  }
  const bytes=new TextEncoder().encode('durable file bytes');
  if(request.method==='POST'){
   const input={upload_id:'one-upload',operation:'DurableFilesProof.Document.create',field:'/file',arguments:{},name:'proof.txt',type:'text/plain',size:String(bytes.length)};
   const created=this.files.createIntent({request:input,receiver,binding:{adapter:'deployment.web',deliveryId:'one-request',resultPath:'file'}});
   if(created.status!=='granted')throw new Error('intent failed '+JSON.stringify(created));
   const appended=this.files.append(created.intentId,receiver,bytes,0);
   if(appended.status!=='appended')throw new Error('append failed');
   const completed=this.files.complete(created.intentId,receiver);
   if(completed.status!=='completed')throw new Error('complete failed');
   const finalized=this.files.finalize({intentId:created.intentId,retryId:input.upload_id,caller:receiver,bytesDigest:sha256Hex(bytes)});
   if(finalized.status!=='finalized')throw new Error('finalize failed '+JSON.stringify(finalized));
   const record=this.store.files.get(finalized.file.id);
   try {this.store.transaction(()=>{
    this.store.blobs.write('rollback.bin',bytes);
    this.store.files.put({...record,attachedRecord:'rolled-back-record'});
    throw new Error('injected interruption');
   });} catch(error){if(error.message!=='injected interruption')throw error;}
   if(this.store.blobs.read('rollback.bin')!==null||this.store.files.get(finalized.file.id).attachedRecord!==null)throw new Error('rollback lost atomicity');
  }
  const record=this.store.files.listAll()[0];
  if(!record)throw new Error('persistent metadata missing');
  const value=this.files.readBytes(record.file.id,receiver);
  if(value===null)throw new Error('persistent bytes missing');
  const observation=this.files.observeFile(record.file.id,receiver,retention);
  const facts=readFinalizedFileObservation(observation);
  const copied=readFinalizedFileObservation(JSON.parse(JSON.stringify(observation)));
  const foreign=this.files.readBytes(record.file.id,{...receiver,principal:'other-user'});
  if(facts===null||copied!==null||foreign!==null)throw new Error('Files authority weakened');
  return json({id:record.file.id,store:this.store.fileStoreId,contentType:record.file.contentType,bytes:new TextDecoder().decode(value),genuine:true,copyRejected:true,foreignRejected:true});
 }
}
export default {fetch(request,env){return env.FILES.get(env.FILES.idFromName('one-app')).fetch(request);}};
`);
  execFileSync('bun', ['build', '--target=browser', '--format=esm', entry, '--outfile', output], { stdio: 'pipe' });
  const script = await readFile(output, 'utf8');
  const start = () => new Miniflare({ name: 'can-durable-files-proof', compatibilityDate: '2026-07-15', modules: true, script,
    durableObjects: { FILES: { className: 'FilesProof', useSQLite: true } }, durableObjectsPersist: join(directory, 'persist') });
  let runtime = start();
  try {
    const written = await runtime.dispatchFetch('https://files.test/', { method: 'POST' });
    assert.equal(written.status, 200, await written.clone().text());
    const initial = await written.json();
    await runtime.dispose();
    runtime = start();
    const reopened = await runtime.dispatchFetch('https://files.test/');
    assert.equal(reopened.status, 200, await reopened.clone().text());
    assert.deepEqual(await reopened.json(), initial);
    const maximum = await runtime.dispatchFetch('https://files.test/maximum', { method: 'POST' });
    assert.equal(maximum.status, 200, await maximum.clone().text());
    const maximumResult = await maximum.json() as { size: number; digest: string };
    assert.equal(maximumResult.size, 10 * 1024 * 1024);
    assert.equal(maximumResult.digest, `sha256:${createHash('sha256').update(Buffer.alloc(10 * 1024 * 1024, 65)).digest('hex')}`);
    await runtime.dispose();
    runtime = start();
    const maximumReopened = await runtime.dispatchFetch('https://files.test/maximum');
    assert.equal(maximumReopened.status, 200, await maximumReopened.clone().text());
    assert.deepEqual(await maximumReopened.json(), maximumResult);
    assert.deepEqual(initial, { ...initial as object, contentType: 'text/plain', bytes: 'durable file bytes', genuine: true, copyRejected: true, foreignRejected: true });
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 60000);
