/** Native typed File host: current whole-field readers are State-authorized,
 * while actual SQLite receiving provenance and byte validity remain Files-owned. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, MutationEnvelope, StoragePort } from '@canlang/contracts';
import type { UploadDeps } from '@canlang/interfaces';
import { distribution } from '@canlang/values/distribution';
import { createD1OwnerRouter } from '@canlang/state/storage/owner-router';
import { ensureSchema } from '@canlang/state/storage/d1';
import { asId, asModel, asOperationId, FIXED_NOW, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { buildSessionCookie, createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity, sha256HexText } from '@canlang/identity';
import { createSqliteFileBindings, createSqliteFileStore, type SqliteFileStore } from '@canlang/files/host/sqlite';
import { blobKeyForFile } from '@canlang/files/finalize';
import { sha256Hex, stagingKeyForIntent } from '@canlang/files/upload';
import { createFileJourneyKernel } from '@canlang/interfaces/uploads/kernel';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker, createTeamOwnerStorageBoundary } from '@canlang/cloudflare/worker/assembly';
import { createBoundFileHandler, createCanonicalFileBinding } from '@canlang/cloudflare/runtime/bound-files';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const APP = 'TypedFileJourney', MODEL = asModel(`${APP}.Entry`);
const A_BYTES = new TextEncoder().encode('%PDF-1.4\nOwner A actual bytes\ntrailer\n');
const B_BYTES = new TextEncoder().encode('%PDF-1.4\nOwner B actual bytes\ntrailer\n');
async function snapshot(db: D1Database) {
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{name:string}>();
  assert.equal(tables.success,true);
  const result: Record<string,readonly Record<string,unknown>[]> = {};
  for (const {name} of tables.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all<Record<string,unknown>>();
    assert.equal(rows.success,true); result[name]=rows.results.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {resolve=done;});
  return {promise,resolve};
}

test('native typed File downloads select the current D1 owner without fallback and reject a team switch during byte read',
  {timeout:120000}, async () => {
    const fixture=fileURLToPath(new URL('./fixtures/typed-file-journey.can',import.meta.url));
    const compiler=join(root,'compiler/target/debug/can'), catalog=fileURLToPath(distribution.catalog);
    const paths=[fixture,compiler,catalog], digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
    const hashes=await Promise.all(paths.map(async path=>digest(await readFile(path))));
    const dir=await mkdtemp(join(tmpdir(),'can-file-owner-routing-'));
    let worker:Miniflare|undefined, physical:SqliteFileStore|undefined, sequence=0;
    let gate: {started:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>}|undefined;
    let now=FIXED_NOW;
    const clock={nowMs:()=>now}, nextId=()=>asOperationId(uuidv7(FIXED_NOW,++sequence));
    try {
      const env={...process.env}; delete env.CAN_CATALOG;
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--catalog',catalog,fixture],
        {cwd:root,env,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact;
      assert.equal(artifact.artifact_version,1); assert.ok(artifact.modules.length>0);
      assert.ok(artifact.sources.some(source=>resolve(source.path)===fixture&&source.sha256===hashes[0]));
      assert.equal(artifact.operations?.find(operation=>operation.name===`${APP}.attach`)?.result?.disclosure,undefined,
        'unchanged ordinary typed File fixture; no invented saved disclosure');
      const asm=await assembleModules({artifact,sourcePath:fixture},{workDir:join(dir,'modules'),
        stdlibUrl:import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),uiUrl:import.meta.resolve('@canlang/ui')});
      worker=new Miniflare({compatibilityDate:'2026-07-15',modules:true,script:'export default {fetch(){return new Response("ok")}}',
        d1Databases:{IDENTITY:'file-routing-identity',A:'file-routing-a',B:'file-routing-b'},d1Persist:join(dir,'d1')});
      const idDb=await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const a=await worker.getD1Database('A') as unknown as D1Database,b=await worker.getD1Database('B') as unknown as D1Database;
      await ensureIdentitySchema(idDb); await ensureSchema(a); await ensureSchema(b);
      const identities=createD1IdentityStore(idDb,{clock});
      const teamA=await identities.createTeam({timezone:'UTC'}),teamB=await identities.createTeam({timezone:'UTC'});
      const unmounted=await identities.createTeam({timezone:'UTC'});
      const user=await identities.createUser({email:'file-routing-owner@example.test',password_hash:'unused',email_verified:true});
      for(const team of [teamA,teamB,unmounted]) await identities.createMembership({user_id:user.user_id,team_id:team.team_id,is_owner:true,roles:[]});
      const other=await identities.createUser({email:'file-routing-other@example.test',password_hash:'unused',email_verified:true});
      const otherMembership=await identities.createMembership({user_id:other.user_id,team_id:teamA.team_id,is_owner:true,roles:[]});
      const limited=await identities.createUser({email:'file-routing-label-only@example.test',password_hash:'unused',email_verified:true});
      await identities.createMembership({user_id:limited.user_id,team_id:teamA.team_id,is_owner:false,roles:[]});
      const noTeam=await identities.createUser({email:'file-routing-no-team@example.test',password_hash:'unused',email_verified:true});
      const grants=await Promise.all([teamA,teamB,unmounted].map(team=>issueMcpGrant(identities,
        {user_id:user.user_id,team_id:team.team_id,client_id:'file-routing'},{clock})));
      const otherGrant=await issueMcpGrant(identities,{user_id:other.user_id,team_id:teamA.team_id,client_id:'file-routing-other'},{clock});
      const limitedGrant=await issueMcpGrant(identities,{user_id:limited.user_id,team_id:teamA.team_id,client_id:'file-routing-label-only'},{clock});
      const sessionToken=randomBytes(32).toString('hex');
      const session=await identities.createSession({user_id:user.user_id,token_sha256:await sha256HexText(sessionToken),
        expires_at:new Date(FIXED_NOW+3600000).toISOString(),last_team_id:teamA.team_id});
      const noTeamToken=randomBytes(32).toString('hex');
      await identities.createSession({user_id:noTeam.user_id,token_sha256:await sha256HexText(noTeamToken),
        expires_at:new Date(FIXED_NOW+3600000).toISOString(),last_team_id:null});
      const cookie=buildSessionCookie(sessionToken,{maxAgeSeconds:3600}).split(';')[0]!;
      const noTeamCookie=buildSessionCookie(noTeamToken,{maxAgeSeconds:3600}).split(';')[0]!;
      const identityA=await resolveIdentity(identities,{mcp_grant_token:grants[0]!.token},{clock});
      const identityB=await resolveIdentity(identities,{mcp_grant_token:grants[1]!.token},{clock});
      const genuineBoundary=await createTeamOwnerStorageBoundary({artifact,asm,app:APP,identities,
        router:createD1OwnerRouter({resolveBinding:selected=>selected.app===APP&&[teamA.team_id,teamB.team_id].includes(selected.owner)
          ?{...selected,db:selected.owner===teamA.team_id?a:b,initializeFresh:true}:null})});
      let postByteRace=false,bRoutesDuringRace=0;
      const boundary={...genuineBoundary,async forIdentity(identity:Parameters<typeof genuineBoundary.forIdentity>[0]) {
        if(postByteRace&&identity.team?.team_id===teamB.team_id)bRoutesDuringRace++;
        return genuineBoundary.forIdentity(identity);
      }};
      const storeA=await boundary.forIdentity(identityA),storeB=await boundary.forIdentity(identityB);
      let fallbackReads=0,fallbackCommits=0;
      const fallback:StoragePort={...storeA,load:async(...args)=>{fallbackReads++;return storeA.load(...args);},
        query:async(...args)=>{fallbackReads++;return storeA.query(...args);},commit:async batch=>{fallbackCommits++;return storeA.commit(batch);}};
      physical=createSqliteFileStore(join(dir,'files.sqlite'));
      const nativeKernel=createFileJourneyKernel(createSqliteFileBindings(physical,{clock,intentTtlMs:60000,urlBase:'https://test.invalid'}));
      const byteReads: {ref:string;owner:string;principal:string}[]=[];
      let legacyReadCalls=0;
      const kernel={...nativeKernel,
        async readBytes():Promise<Uint8Array|null> {legacyReadCalls++;throw new Error('Protected download used legacy readBytes');},
        async readCurrentBytes(ref:string,receiver:Parameters<typeof nativeKernel.readCurrentBytes>[1],retention:Parameters<typeof nativeKernel.readCurrentBytes>[2]) {
          byteReads.push({ref,owner:receiver.owner,principal:receiver.principal});
          const bytes=await nativeKernel.readCurrentBytes(ref,receiver,retention);
          if(gate!==undefined) {const held=gate;held.started.resolve();await held.release.promise;}
          return bytes;
        }};
      const upload:UploadDeps&{kernel:typeof kernel}={app:{appId:APP,brand:APP,appDefaultLocale:'en',ownerLabels:new Map()},
        files:{usesFiles:()=>true},kernel,clock,logger:{log:()=>{}},
        identity:{store:identities,clock,mail:{sendMail:async()=>{}},verifyBaseUrl:'',recoveryBaseUrl:'',inviteBaseUrl:'',sessionMaxAgeSeconds:3600}};
      const retention={unattachedHorizonMs:120000,retentionMs:600000};
      const opts={artifact,asm,store:fallback,memberships:identities,identityStore:identities,clock,upload,ownerStorage:boundary,
        retention,physicalFiles:physical.files,fileReferenceBounds:{maxRows:100,maxReferences:100}};
      const handler=createBoundFileHandler(opts);
      assert.throws(()=>createBoundFileHandler({...opts,ownerStorage:{...boundary,app:'OtherApp'}}),/app|owner/i);
      const canonicalFiles=createCanonicalFileBinding(nativeKernel,retention);
      const invoker=buildInvoker(artifact,asm,fallback,{appId:APP,memberships:identities,now:clock.nowMs,files:canonicalFiles,ownerStorage:boundary});
      const request=(path:string,method='GET',body?:string|Uint8Array,token?:string,selectedCookie?:string)=>new Request(
        path.startsWith('https:')?path:`https://test.invalid${path}`,{method,headers:{...(token===undefined?{}:{authorization:`Bearer ${token}`}),
          ...(selectedCookie===undefined?{}:{cookie:selectedCookie}),...(method==='PUT'?{'upload-offset':'0'}:{}),
          'content-type':body instanceof Uint8Array?'application/octet-stream':'application/json'},...(body===undefined?{}:{body})});
      const mutate=async(operation:string,inputs:MutationEnvelope['inputs'],identity=identityA,id=nextId())=>{
        const result=await invoker.invokeMutation({operation:`${APP}.${operation}`,operation_id:id,inputs},identity);
        assert.ok('result' in result,JSON.stringify(result));assert.equal(result.result.status,'committed');return result.result;
      };
      // Identical record ids, versions and physical revisions across two real
      // canonical owner transactions must still select different owning bytes.
      const sharedId=nextId();
      const createdA=await mutate('Entry.create',{},identityA,sharedId),createdB=await mutate('Entry.create',{},identityB,sharedId);
      for(const created of [createdA,createdB]) {
        assert.equal(created.records?.length,1);
        const record=created.records![0];assert.ok(record!==null&&typeof record==='object'&&!Array.isArray(record));
        assert.equal(Object.getOwnPropertyDescriptor(record,'id')?.value,sharedId,'actual canonical create record id');
      }
      const uploadFile=async(uploadId:string,bytes:Uint8Array,token:string)=>{
        const intentResponse=await handler(request('/files/intents','POST',JSON.stringify({upload_id:uploadId,operation:`${APP}.attach`,
          field:'/attachment',arguments:{},name:'actual.pdf',type:'application/pdf',size:String(bytes.length)}),token));
        assert.equal(intentResponse.status,200,await intentResponse.clone().text());
        const intent=await intentResponse.json() as {intent_id:string;content:string;finalize:string};
        assert.equal((await handler(request(intent.content,'PUT',bytes,token))).status,200);
        const finalized=await handler(request(intent.finalize,'POST',JSON.stringify({upload_id:uploadId,bytes_digest:sha256Hex(bytes)}),token));
        assert.equal(finalized.status,200,await finalized.clone().text());
        const ref=(await finalized.json() as {file:string}).file; assert.ok(ref);
        return {ref,intent};
      };
      const uploadedA=await uploadFile('routing-a',A_BYTES,grants[0]!.token),uploadedB=await uploadFile('routing-b',B_BYTES,grants[1]!.token);
      const uploadedOther=await uploadFile('routing-other-principal',A_BYTES,otherGrant.token);
      await mutate('attach',{entry:{id:sharedId,version:'1'},attachment:{id:uploadedA.ref},accept:true},identityA);
      await mutate('attach',{entry:{id:sharedId,version:'1'},attachment:{id:uploadedB.ref},accept:true},identityB);
      const rowA=await storeA.load(MODEL,asId(sharedId)),rowB=await storeB.load(MODEL,asId(sharedId));assert.ok(rowA);assert.ok(rowB);
      assert.equal(rowA.version,2);assert.equal(rowB.version,2);assert.equal(await storeA.readRevision(),await storeB.readRevision());
      assert.deepEqual(rowA.data['attachment'],{id:uploadedA.ref});assert.deepEqual(rowB.data['attachment'],{id:uploadedB.ref});
      assert.ok(physical.files.get(uploadedA.ref)?.attachedRecord);assert.ok(physical.files.get(uploadedB.ref)?.attachedRecord);
      const fileState=()=>({files:physical!.files.listAll(),intents:physical!.intents.listAll(),
        bytes:physical!.files.listAll().map(value=>physical!.blobs.read(blobKeyForFile(value.file.id))),
        staging:physical!.intents.listAll().map(value=>physical!.blobs.read(stagingKeyForIntent(value.intentId)))});
      const all=async()=>({a:await snapshot(a),b:await snapshot(b),identity:await snapshot(idDb),files:fileState()});
      const downloadPath=`/files/read/${MODEL}/${sharedId}/attachment`;
      for(const [grant,bytes,owner] of [[grants[0]!,A_BYTES,teamA.team_id],[grants[1]!,B_BYTES,teamB.team_id],[otherGrant,A_BYTES,teamA.team_id]] as const) {
        const before=await all(),count=byteReads.length;
        const response=await handler(request(downloadPath,'GET',undefined,grant.token));
        assert.equal(response.status,200,await response.clone().text());assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
        assert.equal(byteReads.length,count+1);assert.equal(byteReads.at(-1)!.owner,owner);assert.equal(byteReads.at(-1)!.principal,user.user_id, 'physical uploader remains distinct from current shared reader');
        assert.deepEqual(await all(),before);assert.equal(legacyReadCalls,0);
      }
      // A-only locator must not fall back to store A for the selected B owner.
      const uploadedAOnly=await uploadFile('routing-a-only',A_BYTES,grants[0]!.token);
      const uploadedBOnly=await uploadFile('routing-b-only',B_BYTES,grants[1]!.token);
      const aOnly=nextId();await mutate('Entry.create',{label:'Only A'},identityA,aOnly);
      await mutate('attach',{entry:{id:aOnly,version:'1'},attachment:{id:uploadedAOnly.ref},accept:true},identityA);
      const bOnly=nextId();await mutate('Entry.create',{label:'Only B'},identityB,bOnly);
      await mutate('attach',{entry:{id:bOnly,version:'1'},attachment:{id:uploadedBOnly.ref},accept:true},identityB);
      // Real receiving bindings forbid sharing one File across teams; the
      // primary rows still have identical ids/versions and owner revisions.
      const onlyAPath=`/files/read/${MODEL}/${aOnly}/attachment`;
      const refusal=async(req:Request,expectNoFileRead=true)=>{
        const before=await all(),reads=byteReads.length;
        const response=await handler(req);assert.ok(response.status>=400&&response.status<500,String(response.status));
        const body=new Uint8Array(await response.arrayBuffer());assert.notDeepEqual(body,A_BYTES);assert.notDeepEqual(body,B_BYTES);
        if(expectNoFileRead)assert.equal(byteReads.length,reads);
        assert.deepEqual(await all(),before);assert.equal(fallbackReads,0);assert.equal(fallbackCommits,0);
      };
      await refusal(request(onlyAPath,'GET',undefined,grants[1]!.token));
      await refusal(request(downloadPath));
      await refusal(request(downloadPath,'GET',undefined,undefined,noTeamCookie));
      await refusal(request(downloadPath,'GET',undefined,grants[2]!.token));
      await refusal(request(downloadPath,'GET',undefined,limitedGrant.token)); // Current member lacks whole attachment field grant.
      assert.equal(legacyReadCalls,0);
      // Corrupt only physical receiving metadata through the actual SQLite
      // store, using other genuine finalized receivers. No new authority is minted.
      const originalPhysical=physical!.files.get(uploadedA.ref);assert.ok(originalPhysical);
      for(const wrong of [uploadedB,uploadedOther]) {
        const wrongPhysical=physical!.files.get(wrong.ref);assert.ok(wrongPhysical);
        physical!.files.put({...originalPhysical,owner:wrongPhysical.owner});
        await refusal(request(downloadPath,'GET',undefined,otherGrant.token),false);
        physical!.files.put(originalPhysical);
      }
      const originalBytes=physical!.blobs.read(blobKeyForFile(uploadedA.ref));assert.ok(originalBytes);
      physical!.blobs.write(blobKeyForFile(uploadedA.ref),new Uint8Array(originalBytes.length).fill(120));
      await refusal(request(downloadPath,'GET',undefined,otherGrant.token),false);
      physical!.blobs.write(blobKeyForFile(uploadedA.ref),originalBytes);
      now=FIXED_NOW+retention.retentionMs+1;
      await refusal(request(downloadPath,'GET',undefined,otherGrant.token),false);
      now=FIXED_NOW;
      // A byte read begun against real metadata must not disclose those bytes
      // after the physical checkpoint changes, even with unchanged owner/ref.
      const beforeMetadataRace=await all(),beforeMetadataReads=byteReads.length;
      gate={started:deferred(),release:deferred()};
      const metadataPending=handler(request(downloadPath,'GET',undefined,otherGrant.token));
      await Promise.race([gate.started.promise,metadataPending.then(response=>{throw new Error(`Expected held current-byte read; received HTTP ${response.status}`);})]);
      physical!.files.put({...originalPhysical,file:{...originalPhysical.file,contentType:'application/octet-stream'}});
      const afterMetadataChange=await all();
      assert.deepEqual(afterMetadataChange.a,beforeMetadataRace.a);assert.deepEqual(afterMetadataChange.b,beforeMetadataRace.b);
      assert.deepEqual(afterMetadataChange.identity,beforeMetadataRace.identity);
      const metadataHeld=gate;gate=undefined;metadataHeld.release.resolve();
      const metadataRefusal=await metadataPending;
      assert.ok(metadataRefusal.status>=400&&metadataRefusal.status<500,String(metadataRefusal.status));
      assert.notDeepEqual(new Uint8Array(await metadataRefusal.arrayBuffer()),A_BYTES);
      assert.equal(byteReads.length,beforeMetadataReads+1);assert.deepEqual(await all(),afterMetadataChange);
      assert.equal(legacyReadCalls,0);assert.equal(fallbackReads,0);assert.equal(fallbackCommits,0);
      physical!.files.put(originalPhysical);
      const heldDownload=async(action:()=>Promise<void>,changesDomain=false)=>{
        const beforeHeld=await all();
        gate={started:deferred(),release:deferred()};
        const pending=handler(request(downloadPath,'GET',undefined,otherGrant.token));
        await Promise.race([gate.started.promise,pending.then(response=>{throw new Error(`Expected held current-byte read; received HTTP ${response.status}`);})]);
        await action();const afterAction=await all();
        assert.deepEqual(afterAction.files,beforeHeld.files);
        if(!changesDomain){assert.deepEqual(afterAction.a,beforeHeld.a);assert.deepEqual(afterAction.b,beforeHeld.b);}
        const held=gate;gate=undefined;held.release.resolve();
        const response=await pending;assert.ok(response.status>=400&&response.status<500,String(response.status));
        assert.notDeepEqual(new Uint8Array(await response.arrayBuffer()),A_BYTES);assert.deepEqual(await all(),afterAction);
        assert.equal(legacyReadCalls,0);assert.equal(fallbackReads,0);assert.equal(fallbackCommits,0);
      };
      await heldDownload(()=>identities.removeMembership(otherMembership.membership_id));
      await identities.reactivateMembership(otherMembership.membership_id,{is_owner:true,roles:[]});
      await heldDownload(async()=>{
        const row=await storeA.load(MODEL,asId(sharedId));assert.ok(row);
        await mutate('Entry.update',{record:{id:row.id,version:String(row.version)},label:'Changed during physical read'},identityA);
      },true);
      // Match the row version/revision again using a real B-owner update; the
      // original session race below must refuse before B routing, independently
      // of the two genuine finalized File ids.
      const currentB=await storeB.load(MODEL,asId(sharedId));assert.ok(currentB);
      await mutate('Entry.update',{record:{id:currentB.id,version:String(currentB.version)},label:'Matching B version'},identityB);
      assert.equal((await storeA.load(MODEL,asId(sharedId)))!.version,(await storeB.load(MODEL,asId(sharedId)))!.version);
      assert.equal(await storeA.readRevision(),await storeB.readRevision());
      const beforeRace=await all(),beforeRaceReads=byteReads.length;
      gate={started:deferred(),release:deferred()};
      const pending=handler(request(downloadPath,'GET',undefined,undefined,cookie));
      await Promise.race([gate.started.promise,pending.then(response=>{throw new Error(`Expected held current-byte read; received HTTP ${response.status}`);})]);
      postByteRace=true;
      await identities.setSessionTeam(session.session_id,teamB.team_id);
      const afterSelection=await snapshot(idDb);
      const held=gate;gate=undefined;held.release.resolve();
      const refused=await pending;postByteRace=false;assert.ok(refused.status>=400&&refused.status<500,String(refused.status));
      assert.equal(bRoutesDuringRace,0,'changed selected team refuses before routing another owner for the second read');
      const deniedBytes=new Uint8Array(await refused.arrayBuffer());assert.notDeepEqual(deniedBytes,A_BYTES);assert.notDeepEqual(deniedBytes,B_BYTES);
      assert.equal(byteReads.length,beforeRaceReads+1);assert.equal(byteReads.at(-1)!.ref,uploadedA.ref);
      assert.deepEqual(await snapshot(a),beforeRace.a);assert.deepEqual(await snapshot(b),beforeRace.b);assert.deepEqual(fileState(),beforeRace.files);
      assert.deepEqual(await snapshot(idDb),afterSelection);assert.equal(fallbackReads,0);assert.equal(fallbackCommits,0);assert.equal(legacyReadCalls,0);
      assert.deepEqual(await Promise.all(paths.map(async path=>digest(await readFile(path)))),hashes);
    } finally {gate?.release.resolve();physical?.close();await worker?.dispose();await rm(dir,{recursive:true,force:true});}
  });
