/** Real workerd SQLite Durable Object: Files kernel authority stays inside one isolate. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare } from 'miniflare';
import { it } from 'vitest';
import { createSqliteFileStore } from '../../files/src/host/sqlite.js';
import type { CompileArtifact } from '@canlang/contracts';
import { deriveCsrfToken, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createMemoryStorage } from '@canlang/state/storage/memory';
import { asId, asModel, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';

it('admits native Worker upload intents through current canonical context before granting retries', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'can-native-upload-admission-'));
  const runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-15',
    script: 'export default {fetch(){return new Response("ready")}}',
    d1Databases: { DB: 'native-upload-admission' }, r2Buckets: { FILES: 'native-upload-admission' } });
  try {
    // Run the real Node importer: Vitest rewrites dynamic ESM namespaces to
    // getter-backed objects, unlike the native namespaces checked by this host.
    const requireNative = createRequire(import.meta.url);
    const { assembleModules } = requireNative(fileURLToPath(new URL('../dist/runtime/modules.js', import.meta.url))) as
      typeof import('../src/runtime/modules.js');
    const { createWorkerFiles } = requireNative(fileURLToPath(new URL('../dist/runtime/worker-files.js', import.meta.url))) as
      typeof import('../src/runtime/worker-files.js');
    const fixture = join(root, 'packages/cloudflare/test/fixtures/typed-file-journey.can');
    const source = join(directory, 'typed-file-journey.can');
    await writeFile(source, (await readFile(fixture, 'utf8'))
      .replace(' Entry { label:text="Uploaded", attachment:file? }',
        ' Entry { label:text="Uploaded", attachment:file? }\n contract UploadDraft {entry:Entry,attachment:file,note:text}\n contract OtherDraft {attachment:file}\n contract UploadEnvelope {drafts:UploadDraft[]?}\n contract UnionEnvelope {draft:UploadDraft|OtherDraft}')
      .replace('Then', ' scenario nested(envelope:UploadEnvelope?) by=owner\n  do\n   require true\n scenario unionDraft(payload:UnionEnvelope) by=owner\n  do\n   require true\nThen'));
    const artifact = JSON.parse(execFileSync(process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can'),
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog',
        process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json'), source],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' })) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
      stdlibUrl: new URL('../dist/runtime/stdlib.js', import.meta.url).href,
      uiUrl: pathToFileURL(createRequire(import.meta.url).resolve('@canlang/ui')).href });
    const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const user = await identities.createUser({ email: 'native-upload@example.test', password_hash: 'unused', email_verified: true });
    const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
    const token = 'native-upload-admission-session';
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
    const store = createMemoryStorage();
    const row = makeRow({ id: asId('upload-entry'), data: { label: 'Uploaded', attachment: null } });
    await store.commit(makeBatch(await store.readRevision(), { writes: [
      { kind: 'insert', model: asModel('TypedFileJourney.Entry'), row, parent: null },
    ] }));
    const db = await runtime.getD1Database('DB');
    const files = await createWorkerFiles({ artifact, asm, store, identities, clock,
      env: { DB: db, FILES: await runtime.getR2Bucket('FILES') }, origin: 'https://files.test',
      retention: { unattachedHorizonMs: 86400000, retentionMs: 86400000 }, intentTtlMs: 900000 });
    assert.ok(files, 'the compiler must install its implicit Files binding');
    const headers = { 'content-type': 'application/json', cookie: `can_session=${token}`,
      'x-csrf-token': await deriveCsrfToken(token) };
    const body = { upload_id: 'native-one', operation: 'TypedFileJourney.attach', field: '/attachment',
      arguments: { entry: { id: row.id, version: String(row.version) } }, name: 'native.txt', type: 'text/plain', size: '5' };
    const intent = (input: unknown, withHeaders: HeadersInit = headers) => files.fetch(new Request(files.intentsUrl,
      { method: 'POST', headers: withHeaders, body: JSON.stringify(input) }));
    // accept is deliberately absent: the later business Require remains unevaluated.
    const granted = await intent(body);
    assert.equal(granted.status, 200, await granted.clone().text());
    const grant = await granted.json() as { intent_id: string; content: string; finalize: string };
    assert.deepEqual(await (await intent(body)).json(), grant);
    for (const input of [
      { ...body, operation: 'TypedFileJourney.missing' },
      { ...body, operation: 'TypedFileJourney.Entry.delete' },
      { ...body, field: '/accept' },
      { ...body, arguments: {} },
      { ...body, arguments: { entry: { id: row.id, version: '999' } } },
      { ...body, arguments: { ...body.arguments, unexpected: true } },
    ]) {
      const denied = await intent({ ...input, upload_id: 'invalid' });
      assert.ok([400, 403, 404, 409].includes(denied.status), await denied.clone().text());
    }
    assert.equal((await intent(body, { 'content-type': 'application/json' })).status, 401);
    assert.equal((await intent(body, { ...headers, 'x-csrf-token': 'wrong' })).status, 403);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM can_files_intents').first<{ count: number }>())?.count, 1);
    const nested = { ...body, upload_id: 'nested-one', operation: 'TypedFileJourney.nested',
      field: '/envelope/drafts/0/attachment', arguments: {} };
    for (const args of [{}, { envelope: {} }, { envelope: { drafts: [] } }, { envelope: { drafts: [{}] } }]) {
      assert.equal((await intent({ ...nested, arguments: args })).status, 400,
        'creating optional File ancestors still requires their required record siblings');
    }
    for (const draft of [
      { entry: body.arguments.entry, note: 123 },
      { entry: body.arguments.entry, unknown: true },
      { entry: { id: row.id, version: 'invalid' } },
    ]) {
      assert.equal((await intent({ ...nested, arguments: { envelope: { drafts: [draft] } } })).status, 400,
        'partial drafts still validate supplied scalar, reference and closed-object shape');
    }
    const nestedGranted = await intent({ ...nested,
      arguments: { envelope: { drafts: [{ entry: body.arguments.entry }] } } });
    assert.equal(nestedGranted.status, 200, await nestedGranted.clone().text());
    const union = { ...body, upload_id: 'union-one', operation: 'TypedFileJourney.unionDraft', field: '/payload/draft/value/attachment' };
    for (const draft of [{ value: {} }, { type: 'TypedFileJourney.Unknown', value: {} },
      { type: 'TypedFileJourney.UploadDraft', value: { entry: body.arguments.entry, note: 123 } }]) {
      assert.equal((await intent({ ...union, arguments: { payload: { draft } } })).status, 400,
        'draft unions require a declared discriminator and validate their supplied branch');
    }
    const unionGranted = await intent({ ...union,
      arguments: { payload: { draft: { type: 'TypedFileJourney.UploadDraft', value: { entry: body.arguments.entry } } } } });
    assert.equal(unionGranted.status, 200, await unionGranted.clone().text());
    const appended = await files.fetch(new Request(grant.content, { method: 'PUT',
      headers: { ...headers, 'upload-offset': '0' }, body: 'hello' }));
    assert.equal(appended.status, 200, await appended.clone().text());
    const digest = `sha256:${createHash('sha256').update('hello').digest('hex')}`;
    const finalized = await files.fetch(new Request(grant.finalize, { method: 'POST', headers,
      body: JSON.stringify({ upload_id: body.upload_id, bytes_digest: digest }) }));
    assert.equal(finalized.status, 200, await finalized.clone().text());
    assert.ok(await finalized.json());
    await store.commit(makeBatch(await store.readRevision(), { writes: [
      { kind: 'update', model: asModel('TypedFileJourney.Entry'), id: row.id, expectedVersion: row.version,
        row: makeRow({ id: row.id, version: 2, data: { label: 'Changed', attachment: null } }) },
    ] }));
    assert.equal((await intent(body)).status, 409, 'a retained retry must load the current record version');
    await identities.removeMembership(membership.membership_id);
    assert.notEqual((await intent(body)).status, 200, 'a retained retry must recheck current membership');
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM can_files_intents').first<{ count: number }>())?.count, 3);
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 120000);

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
  const bound = fileURLToPath(new URL('../dist/runtime/bound-files.js', import.meta.url));
  const staging = fileURLToPath(new URL('../dist/runtime/file-staging.js', import.meta.url));
  const kernel = fileURLToPath(new URL('../../interfaces/dist/src/uploads/kernel.js', import.meta.url));
  await writeFile(entry, `
import {createDurableSqliteFileStore,createSqliteFileBindings} from ${JSON.stringify(adapter)};
import {readFinalizedFileObservation} from ${JSON.stringify(finalize)};
import {sha256Hex} from ${JSON.stringify(upload)};
import {createCanonicalFileBinding} from ${JSON.stringify(bound)};
import {readRetainedCanonicalFile} from ${JSON.stringify(staging)};
import {createFileJourneyKernel} from ${JSON.stringify(kernel)};
const receiver={app:'DurableFilesProof',team:'team_1',owner:'team_1',principal:'user_1'};
const retention={unattachedHorizonMs:86400000,retentionMs:86400000};
const json=value=>Response.json(value);
export class FilesProof {
 constructor(ctx){
  this.ctx=ctx;this.now=Date.now();
  this.store=createDurableSqliteFileStore(ctx.storage);
  this.files=createSqliteFileBindings(this.store,{clock:{nowMs:()=>this.now},intentTtlMs:900000,urlBase:'https://files.test'});
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
  if(await this.ctx.storage.get('retained-source-revision')===undefined)await this.ctx.storage.put('retained-source-revision',1);
  const verify=async()=>{if(await this.ctx.storage.get('retained-source-revision')!==1)throw new Error('source-revoked');};
  const physical=createFileJourneyKernel(this.files);let revokeDuringRead=false;
  const originalRead=physical.readCurrentSnapshot.bind(physical);
  physical.readCurrentSnapshot=async(...args)=>{const result=await originalRead(...args);if(revokeDuringRead)await this.ctx.storage.put('retained-source-revision',2);return result;};
  const receiving=createCanonicalFileBinding(physical,retention);
  const read=()=>readRetainedCanonicalFile(receiving,facts,bytes.length,verify);
  const accepted=await read();
  if(new TextDecoder().decode(accepted)!=='durable file bytes')throw new Error('Retained bytes were not the genuine finalized snapshot');
  accepted[0]=0;
  if(new TextDecoder().decode(await read())!=='durable file bytes')throw new Error('Retained consumer changed the physical bytes');
  if(await readRetainedCanonicalFile({...receiving},facts,bytes.length,verify)!==null)throw new Error('Copied binding acquired receiving authority');
  if(await readRetainedCanonicalFile(receiving,facts,bytes.length-1,verify)!==null)throw new Error('Retained read ignored byte bound');
  if(await readRetainedCanonicalFile(receiving,{...facts,receiver:{...facts.receiver,principal:'other-user'}},bytes.length,verify)!==null)throw new Error('Foreign saved receiver acquired bytes');
  if(await readRetainedCanonicalFile(receiving,{...facts,bytesDigest:'sha256:'+'0'.repeat(64)},bytes.length,verify)!==null)throw new Error('Changed saved facts acquired bytes');
  const expectRevoked=async()=>{try{await read();}catch(error){if(error.message==='source-revoked')return;}throw new Error('Revoked source acquired bytes');};
  await this.ctx.storage.put('retained-source-revision',2);await expectRevoked();
  await this.ctx.storage.put('retained-source-revision',1);revokeDuringRead=true;await expectRevoked();
  revokeDuringRead=false;await this.ctx.storage.put('retained-source-revision',1);
  this.now+=retention.unattachedHorizonMs+1;
  if(await read()!==null)throw new Error('Expired retained snapshot acquired bytes');
  this.now-=retention.unattachedHorizonMs+1;
  physical.readCurrentSnapshot=async()=>null;
  try{await read();throw new Error('Changed reader acquired bytes');}catch(error){if(error.message!=='Retained File receiving kernel changed.')throw error;}

  return json({id:record.file.id,store:this.store.fileStoreId,contentType:record.file.contentType,bytes:new TextDecoder().decode(value),genuine:true,copyRejected:true,foreignRejected:true,retainedRead:true});
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
    assert.deepEqual(initial, { ...initial as object, contentType: 'text/plain', bytes: 'durable file bytes', genuine: true, copyRejected: true, foreignRejected: true, retainedRead: true });
  } finally { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); }
}, 60000);
