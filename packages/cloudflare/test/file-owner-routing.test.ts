/** Native typed File host: current whole-field readers are State-authorized,
 * while actual SQLite receiving provenance and byte validity remain Files-owned. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { DatabaseSync } from 'node:sqlite';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, MutationEnvelope, StoragePort } from '@canlang/contracts';
import type { UploadDeps } from '@canlang/interfaces';
import { distribution } from '@canlang/values/distribution';
import { createD1OwnerRouter } from '@canlang/state/storage/owner-router';
import { ensureSchema } from '@canlang/state/storage/d1';
import { asId, asModel, asOperation, asOperationId, asVersion, FIXED_NOW, makeBatch, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { createD1Storage, STATE_FILE_REFERENCE_PRODUCER } from '@canlang/state/storage';
import { WORK_FILE_REFERENCE_PRODUCER } from '@canlang/work';
import { buildSessionCookie, createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity, sha256HexText } from '@canlang/identity';
import { createSqliteFileBindings, createSqliteFileStore, type SqliteFileStore } from '@canlang/files/host/sqlite';
import { blobKeyForFile } from '@canlang/files/finalize';
import { sha256Hex, stagingKeyForIntent } from '@canlang/files/upload';
import { createFileJourneyKernel } from '@canlang/interfaces/uploads/kernel';
import { assembleModules, importVerifiedAssemblyModule } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker, createTeamOwnerStorageBoundary } from '@canlang/cloudflare/worker/assembly';
import { createBoundFileHandler, createCanonicalFileBinding } from '@canlang/cloudflare/runtime/bound-files';
import { createNativeFileRetirementBinding } from '../dist/runtime/file-retirement.js';
import { createBoundCohortTick } from '../dist/runtime/cohort-tick.js';
import { invokeDueSourceRoutingCanonical, invokeRetainedHandlerOccurrenceCanonical } from '@canlang/cloudflare/runtime/invoke';
import { WORK_SCHEDULE_MODEL, readScheduleRow, WORK_OCCURRENCE_MODEL, readOccurrenceRow } from '@canlang/work/kernel/tables';
import { WORK_HANDLER_OCCURRENCE_MODEL, readHandlerOccurrenceRow } from '@canlang/work/kernel/handler-occurrence';

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
    let finalReadGate: {started:ReturnType<typeof deferred>;release:ReturnType<typeof deferred>;ready:boolean}|undefined;
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
        const store=await genuineBoundary.forIdentity(identity);
        if(finalReadGate?.ready!==true)return store;
        const held=finalReadGate;
        return {...store,async query(...args:Parameters<StoragePort['query']>) {
          const rows=await store.query(...args);
          held.started.resolve();await held.release.promise;
          return rows;
        }};
      }};
      const storeA=await boundary.forIdentity(identityA),storeB=await boundary.forIdentity(identityB);
      let fallbackReads=0,fallbackCommits=0;
      const fallback:StoragePort={...storeA,load:async(...args)=>{fallbackReads++;return storeA.load(...args);},
        query:async(...args)=>{fallbackReads++;return storeA.query(...args);},commit:async batch=>{fallbackCommits++;return storeA.commit(batch);}};
      physical=createSqliteFileStore(join(dir,'files.sqlite'));
      const nativeKernel=createFileJourneyKernel(createSqliteFileBindings(physical,{clock,intentTtlMs:60000,urlBase:'https://test.invalid'}));
      const byteReads: {ref:string;owner:string;principal:string}[]=[];
      let legacyReadCalls=0,provenanceReadCalls=0;
      const kernel={...nativeKernel,
        async readBytes():Promise<Uint8Array|null> {legacyReadCalls++;throw new Error('Protected download used legacy readBytes');},
        async readProvenance():Promise<never> {provenanceReadCalls++;throw new Error('Protected download used separate readProvenance');},
        async readCurrentSnapshot(ref:string,receiver:Parameters<typeof nativeKernel.readCurrentSnapshot>[1],retention:Parameters<typeof nativeKernel.readCurrentSnapshot>[2]) {
          byteReads.push({ref,owner:receiver.owner,principal:receiver.principal});
          const snapshot=await nativeKernel.readCurrentSnapshot(ref,receiver,retention);
          if(gate!==undefined) {const held=gate;held.started.resolve();await held.release.promise;}
          if(finalReadGate!==undefined)finalReadGate.ready=true;
          return snapshot;
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
        assert.deepEqual(await all(),before);assert.equal(legacyReadCalls,0);assert.equal(provenanceReadCalls,0);
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
      assert.equal(legacyReadCalls,0);assert.equal(provenanceReadCalls,0);
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
      assert.equal(legacyReadCalls,0);assert.equal(provenanceReadCalls,0);assert.equal(fallbackReads,0);assert.equal(fallbackCommits,0);
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
        assert.equal(legacyReadCalls,0);assert.equal(provenanceReadCalls,0);assert.equal(fallbackReads,0);assert.equal(fallbackCommits,0);
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
      assert.deepEqual(await snapshot(idDb),afterSelection);assert.equal(fallbackReads,0);assert.equal(fallbackCommits,0);assert.equal(legacyReadCalls,0);assert.equal(provenanceReadCalls,0);
      // Replace the actual selected File via canonical attachment after the
      // original download has obtained its genuine snapshot. The request may
      // add no effects beyond this deliberate business mutation.
      const alternate=await uploadFile('routing-a-replacement',B_BYTES,grants[0]!.token);
      const beforeReplacement=await all(),replacementReads=byteReads.length;
      gate={started:deferred(),release:deferred()};
      const replacementPending=handler(request(downloadPath,'GET',undefined,otherGrant.token));
      await Promise.race([gate.started.promise,replacementPending.then(response=>{throw new Error(`Expected held current snapshot; received HTTP ${response.status}`);})]);
      const replacementRow=await storeA.load(MODEL,asId(sharedId));assert.ok(replacementRow);
      await mutate('attach',{entry:{id:sharedId,version:String(replacementRow.version)},attachment:{id:alternate.ref},accept:true},identityA);
      const afterReplacement=await all();
      assert.deepEqual(afterReplacement.b,beforeReplacement.b);assert.deepEqual(afterReplacement.identity,beforeReplacement.identity);
      const replaced=await storeA.load(MODEL,asId(sharedId));assert.ok(replaced);
      assert.equal(replaced.version,replacementRow.version+1);assert.deepEqual(replaced.data['attachment'],{id:alternate.ref});
      const replacementHeld=gate;gate=undefined;replacementHeld.release.resolve();
      const replacementRefusal=await replacementPending;
      assert.ok(replacementRefusal.status>=400&&replacementRefusal.status<500,String(replacementRefusal.status));
      const replacementBody=new Uint8Array(await replacementRefusal.arrayBuffer());
      assert.notDeepEqual(replacementBody,A_BYTES);assert.notDeepEqual(replacementBody,B_BYTES);
      assert.equal(byteReads.length,replacementReads+1);assert.equal(byteReads.at(-1)!.ref,uploadedA.ref);
      assert.deepEqual(await all(),afterReplacement);
      // A copied assembly has no genuine issuer capability, even when all
      // public artifact and URL fields are identical.
      const beforeCopied=await all(),copiedReads=byteReads.length;
      let copiedResponse:Response|undefined;
      try {
        const copiedHandler=createBoundFileHandler({...opts,asm:{...asm}});
        copiedResponse=await copiedHandler(request(downloadPath,'GET',undefined,otherGrant.token));
      } catch(error) {
        assert.ok(error instanceof Error,'copied assembly must explicitly refuse');
      }
      if(copiedResponse!==undefined) {
        assert.ok(copiedResponse.status>=400&&copiedResponse.status<600,String(copiedResponse.status));
        const copiedBody=new Uint8Array(await copiedResponse.arrayBuffer());
        assert.notDeepEqual(copiedBody,A_BYTES);assert.notDeepEqual(copiedBody,B_BYTES);
      }
      assert.equal(byteReads.length,copiedReads);assert.deepEqual(await all(),beforeCopied);
      assert.equal(fallbackReads,0);assert.equal(fallbackCommits,0);assert.equal(legacyReadCalls,0);assert.equal(provenanceReadCalls,0);
      // Hold the final canonical query after its genuine owner-store result;
      // source drift in that await must not release already selected bytes.
      const stagedModule=fileURLToPath(asm.entryUrl),originalModule=await readFile(stagedModule);
      const beforeSourceDrift=await all(),sourceDriftReads=byteReads.length;
      finalReadGate={started:deferred(),release:deferred(),ready:false};
      const sourceDriftPending=handler(request(downloadPath,'GET',undefined,otherGrant.token));
      try {
        await Promise.race([finalReadGate.started.promise,sourceDriftPending.then(response=>{throw new Error(`Expected held final canonical read; received HTTP ${response.status}`);})]);
        await writeFile(stagedModule,Buffer.concat([originalModule,Buffer.from('\n// changed during final canonical read\n')]));
        finalReadGate.release.resolve();
        const sourceRefusal=await sourceDriftPending;
        assert.ok(sourceRefusal.status>=400&&sourceRefusal.status<600,String(sourceRefusal.status));
        const sourceBody=new Uint8Array(await sourceRefusal.arrayBuffer());
        assert.notDeepEqual(sourceBody,A_BYTES);assert.notDeepEqual(sourceBody,B_BYTES);
        assert.equal(byteReads.length,sourceDriftReads+1);assert.equal(byteReads.at(-1)!.ref,alternate.ref);
        assert.deepEqual(await all(),beforeSourceDrift);
        assert.equal(fallbackReads,0);assert.equal(fallbackCommits,0);assert.equal(legacyReadCalls,0);assert.equal(provenanceReadCalls,0);
      } finally {
        finalReadGate?.release.resolve();finalReadGate=undefined;
        await writeFile(stagedModule,originalModule);
      }
      assert.deepEqual(await readFile(stagedModule),originalModule);
      assert.deepEqual(await Promise.all(paths.map(async path=>digest(await readFile(path)))),hashes);
    } finally {gate?.release.resolve();finalReadGate?.release.resolve();physical?.close();await worker?.dispose();await rm(dir,{recursive:true,force:true});}
  });

test('native File retirement guards every owner writer and resumes original SQLite deletion after interruption and reopen',
  {timeout:120000}, async () => {
    const fixture=fileURLToPath(new URL('./fixtures/native-file-retirement.can',import.meta.url));
    const compiler=process.env.CAN_COMPILER_BIN??join(root,'compiler/target/debug/can'),catalog=fileURLToPath(distribution.catalog);
    const paths=[fixture,compiler,catalog],digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
    const hashes=await Promise.all(paths.map(async path=>digest(await readFile(path))));
    const dir=await mkdtemp(join(tmpdir(),'can-native-file-retirement-'));
    const app='NativeFileRetirement',model=asModel(`${app}.Entry`),filePath=join(dir,'files.sqlite');
    let worker:Miniflare|undefined,physical:SqliteFileStore|undefined,sequence=0,now=FIXED_NOW;
    const clock={nowMs:()=>now},retention={unattachedHorizonMs:120000,retentionMs:600000};
    const nextId=()=>asOperationId(uuidv7(FIXED_NOW,++sequence));
    try {
      const env={...process.env};delete env.CAN_CATALOG;
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,fixture],
        {cwd:root,env,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact,originalArtifact=JSON.stringify(artifact);
      assert.ok(artifact.sources.some(source=>resolve(source.path)===fixture&&source.sha256===hashes[0]));
      assert.deepEqual(artifact.valueTypes?.contracts.map(contract=>contract.name),[`${app}.Metadata`,`${app}.UnusedDefaults`]);
      assert.equal(artifact.operations?.find(operation=>operation.name===`${app}.attach`)?.result?.disclosure?.version,1);
      const asm=await assembleModules({artifact,sourcePath:fixture},{workDir:join(dir,'modules'),
        stdlibUrl:import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),uiUrl:import.meta.resolve('@canlang/ui')});
      worker=new Miniflare({compatibilityDate:'2026-07-15',modules:true,script:'export default {fetch(){return new Response("ok")}}',
        d1Databases:{IDENTITY:'retirement-identity',A:'retirement-a',B:'retirement-b'},d1Persist:join(dir,'d1')});
      const idDb=await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const a=await worker.getD1Database('A') as unknown as D1Database,b=await worker.getD1Database('B') as unknown as D1Database;
      await ensureIdentitySchema(idDb);await ensureSchema(a);await ensureSchema(b);
      const identities=createD1IdentityStore(idDb,{clock}),team=await identities.createTeam({timezone:'UTC'}),otherTeam=await identities.createTeam({timezone:'UTC'});
      const user=await identities.createUser({email:'native-retirement@example.test',password_hash:'unused',email_verified:true});
      for(const selected of [team,otherTeam])await identities.createMembership({user_id:user.user_id,team_id:selected.team_id,is_owner:true,roles:[]});
      const grant=await issueMcpGrant(identities,{user_id:user.user_id,team_id:team.team_id,client_id:'native-retirement'},{clock});
      const otherGrant=await issueMcpGrant(identities,{user_id:user.user_id,team_id:otherTeam.team_id,client_id:'native-retirement-other'},{clock});
      const identity=await resolveIdentity(identities,{mcp_grant_token:grant.token},{clock});
      const foreign=await resolveIdentity(identities,{mcp_grant_token:otherGrant.token},{clock});
      // Existing adapters opened before installation must obey the permanent
      // guard too; their absence of an issuer never creates a bypass.
      const legacy=createD1Storage(a),participating=createD1Storage(a,undefined,[STATE_FILE_REFERENCE_PRODUCER,WORK_FILE_REFERENCE_PRODUCER]);
      physical=createSqliteFileStore(filePath);
      const scope={app,ownerPackage:app,owner:team.team_id};
      const input={artifact,asm,scope,identities,db:a,stateStoreId:'native-retirement-owner-a',physicalSqliteFileStore:physical,
        initializeFresh:true as const,clock,intentTtlMs:60000,urlBase:'https://test.invalid',retention,maxRows:100,maxReferences:100};
      let binding=await createNativeFileRetirementBinding(input);
      const installed=await binding.store.readFileReferenceInventory(app);assert.ok(installed);
      assert.equal(installed.inventory.frameworkModels.length,13);
      assert.deepEqual(installed.inventory.artifactModels,artifact.models);
      assert.deepEqual(installed.inventory.valueTypes,artifact.valueTypes);
      const declarationSets=installed.inventory.opaqueDeclarationSets;assert.ok(declarationSets);
      assert.equal(declarationSets.length,1);
      const originalSet=declarationSets[0]!;
      assert.equal(originalSet.id,`${installed.inventory.snapshotId}:declarations`);
      assert.deepEqual(originalSet.sources,artifact.sources);
      assert.deepEqual(originalSet.canonicalModels,installed.inventory.canonicalModels);
      assert.deepEqual(originalSet.artifactModels,artifact.models);
      assert.deepEqual(originalSet.valueTypes,artifact.valueTypes);
      assert.deepEqual(originalSet.originalContracts,{
        [`${app}.Metadata`]:{fields:{note:{type:'text'}}},
        [`${app}.UnusedDefaults`]:{fields:{
          optional:{type:'text?',default:null},optional_file:{type:'file?',default:null},
          enabled:{type:'bool',default:false},label:{type:'text',default:''},
          attachments:{type:'file[]',min:'0',max:'4',default:[]},
          trimmed:{type:'text',default:' padded ',trim:true,min:'0',max:'16'},required:{type:'text'},
        }},
      },'complete original own metadata preserves absent defaults and raw literals before normalization');
      assert.deepEqual(originalSet.valueDefaults,[
        {contract:`${app}.UnusedDefaults`,field:'optional',value:null},
        {contract:`${app}.UnusedDefaults`,field:'optional_file',value:null},
        {contract:`${app}.UnusedDefaults`,field:'enabled',value:false},
        {contract:`${app}.UnusedDefaults`,field:'label',value:''},
        {contract:`${app}.UnusedDefaults`,field:'attachments',value:[]},
        {contract:`${app}.UnusedDefaults`,field:'trimmed',value:' padded '},
      ],'one exact original default per own default, including unused File-free leaves');
      assert.deepEqual(originalSet.declarations.map(declaration=>declaration.id).sort(),[
        `${app}.Entry.create:inputs`,`${app}.Entry.update:inputs`,`${app}.Entry.delete:inputs`,
        `${app}.attach:inputs`,`${app}.attach:result`,
      ].sort(),'complete actual four-callable input census and only the declared attach result');
      for(const declaration of originalSet.declarations){
        assert.equal(declaration.source.kind,'callable');
        if(declaration.source.kind!=='callable')throw new Error('Native declaration lacks its original callable source');
        const originalSource=declaration.source;
        assert.deepEqual(originalSource.callable,artifact.callables.find(callable=>
          `${callable.id}:${declaration.profile.kind}`===declaration.id));
        assert.ok(artifact.sources.some(source=>source.path===originalSource.source.path&&
          source.sha256===originalSource.source.sha256));
        assert.equal(originalSource.source.module,originalSource.callable.module);
      }
      assert.equal(binding.store.fileRetirementAuthority.fileStoreId,physical.fileStoreId);
      const routed=await binding.ownerStorage.forIdentity(identity);
      assert.deepEqual(routed.fileRetirementAuthority,binding.store.fileRetirementAuthority);
      assert.deepEqual(await routed.readFileReferenceInventory(app),installed,'each genuine routed adapter retains the same original inventory');
      const physicalState=()=>({fileStoreId:physical!.fileStoreId,files:physical!.files.listAll(),intents:physical!.intents.listAll(),
        bytes:physical!.files.listAll().map(record=>physical!.blobs.read(blobKeyForFile(record.file.id))),
        staging:physical!.intents.listAll().map(intent=>physical!.blobs.read(stagingKeyForIntent(intent.intentId)))});
      const resources=async()=>({a:await snapshot(a),b:await snapshot(b),identity:await snapshot(idDb),files:physicalState()});
      const noEffects=async(action:()=>Promise<unknown>)=>{const before=await resources();await assert.rejects(action);assert.deepEqual(await resources(),before);};
      await noEffects(()=>createNativeFileRetirementBinding({...input,asm:{...asm}}));
      await noEffects(()=>createNativeFileRetirementBinding({...input,stateStoreId:'copied-store-pin'}));
      await noEffects(()=>createNativeFileRetirementBinding({...input,scope:{...scope,owner:otherTeam.team_id}}));
      await noEffects(()=>binding.ownerStorage.forIdentity(foreign));
      const kernel=createFileJourneyKernel(binding.bindings);
      const upload:UploadDeps&{kernel:typeof kernel}={app:{appId:app,brand:app,appDefaultLocale:'en',ownerLabels:new Map()},
        files:{usesFiles:()=>true},kernel,clock,logger:{log:()=>{}},
        identity:{store:identities,clock,mail:{sendMail:async()=>{}},verifyBaseUrl:'',recoveryBaseUrl:'',inviteBaseUrl:'',sessionMaxAgeSeconds:3600}};
      const handler=createBoundFileHandler({artifact,asm,store:binding.store,memberships:identities,identityStore:identities,
        clock,upload,ownerStorage:binding.ownerStorage,retention,physicalFiles:physical.files,fileReferenceBounds:{maxRows:100,maxReferences:100}});
      const request=(path:string,method:string,body:string|Uint8Array)=>new Request(path.startsWith('https:')?path:`https://test.invalid${path}`,
        {method,headers:{authorization:`Bearer ${grant.token}`,'content-type':body instanceof Uint8Array?'application/octet-stream':'application/json',
          ...(method==='PUT'?{'upload-offset':'0'}:{})},body});
      const uploadFile=async(uploadId:string)=>{
        const response=await handler(request('/files/intents','POST',JSON.stringify({upload_id:uploadId,operation:`${app}.attach`,field:'/attachment',
          arguments:{},name:'retirement.pdf',type:'application/pdf',size:String(A_BYTES.length)})));
        assert.equal(response.status,200,await response.clone().text());
        const intent=await response.json() as {content:string;finalize:string};
        assert.equal((await handler(request(intent.content,'PUT',A_BYTES))).status,200);
        const finalized=await handler(request(intent.finalize,'POST',JSON.stringify({upload_id:uploadId,bytes_digest:sha256Hex(A_BYTES)})));
        assert.equal(finalized.status,200,await finalized.clone().text());
        return (await finalized.json() as {file:string}).file;
      };
      const originalFiles=createCanonicalFileBinding(kernel,retention);
      let invoker=buildInvoker(artifact,asm,binding.store,{appId:app,memberships:identities,now:clock.nowMs,
        files:originalFiles,ownerStorage:binding.ownerStorage});
      const invoke=async(operation:string,inputs:MutationEnvelope['inputs'],id=nextId())=>{
        const result=await invoker.invokeMutation({operation:`${app}.${operation}`,operation_id:id,inputs},identity);
        assert.ok('result' in result,JSON.stringify(result));return result.result;
      };
      const create=async()=>{const id=nextId();assert.equal((await invoke('Entry.create',{},id)).status,'committed');return id;};
      const attach=async(id:string,ref:string,accept=true)=>{
        const row=await binding.store.load(model,asId(id));assert.ok(row);
        const operationId=nextId(),inputs={entry:{id,version:String(row.version)},attachment:{id:ref},accept};
        const result=await invoke('attach',inputs,operationId);return {result,inputs,operationId};
      };
      const shared=await uploadFile('shared'),replacement=await uploadFile('replacement'),raceFile=await uploadFile('race'),interrupted=await uploadFile('interrupted');
      const first=await create(),second=await create();
      const sharedFirst=await attach(first,shared),sharedSecond=await attach(second,shared);
      assert.equal(sharedFirst.result.status,'committed');assert.equal(sharedSecond.result.status,'committed');
      const replacementOwner=await create();
      assert.equal((await attach(replacementOwner,replacement)).result.status,'committed','replacement receives a genuine timely attachment before the horizon');
      now=FIXED_NOW+retention.unattachedHorizonMs+1;
      await noEffects(()=>binding.retireAndDelete(shared,'orphaned'));
      assert.equal((await attach(first,replacement)).result.status,'committed');
      await noEffects(()=>binding.retireAndDelete(shared,'orphaned'));
      assert.equal((await attach(second,replacement)).result.status,'committed');
      const beforeReplay=await resources();
      for(const original of [sharedFirst,sharedSecond]) {
        const expected=JSON.parse(JSON.stringify(original.result));expected.status='replayed';delete expected.deliveries;
        // Saved File observations authorize the original scalar result; the
        // receipt projection withholds File fields from saved record views.
        for(const record of expected.records)delete record.data.attachment;
        assert.deepEqual(await invoke('attach',original.inputs,original.operationId),expected);
      }
      assert.deepEqual(await resources(),beforeReplay,'saved replay after replacement cannot restore removed slots');
      const beforeRejected=await resources(),rejectedRevision=await binding.store.readRevision();
      const rejectRow=await binding.store.load(model,asId(first));assert.ok(rejectRow);
      const rejectedOperation=nextId(),rejectedInputs={entry:{id:first,version:String(rejectRow.version)},attachment:{id:replacement},accept:false};
      const rejectedEnvelope={operation:`${app}.attach`,operation_id:rejectedOperation,inputs:rejectedInputs};
      const authoredRejection=await invoker.invokeMutation(rejectedEnvelope,identity);
      assert.ok('error' in authoredRejection);assert.equal(authoredRejection.error.code,'rule_failed');
      const rejectedReceipt=await binding.store.readReceipt({app,owner:team.team_id,principal:user.user_id,
        operation:asOperation(`${app}.attach`),operationId:rejectedOperation});assert.ok(rejectedReceipt);
      assert.deepEqual(rejectedReceipt.outcome,{status:'rejected',code:'rule_failed',message:'forbidden'});
      const rejectedState=await snapshot(a);
      assert.equal(await binding.store.readRevision(),rejectedRevision+1);
      for(const table of Object.keys(beforeRejected.a))if(!['receipts','fence','fence_log'].includes(table))assert.deepEqual(rejectedState[table],beforeRejected.a[table],table);
      assert.equal(rejectedState.receipts!.length,beforeRejected.a.receipts!.length+1);
      assert.equal(rejectedState.fence_log!.length,beforeRejected.a.fence_log!.length+1);
      assert.deepEqual(physicalState(),beforeRejected.files);assert.deepEqual(await snapshot(b),beforeRejected.b);assert.deepEqual(await snapshot(idDb),beforeRejected.identity);
      const rejectedSnapshot=await resources();
      assert.deepEqual(await invoker.invokeMutation(rejectedEnvelope,identity),authoredRejection);
      assert.deepEqual(await resources(),rejectedSnapshot,'late authored rejection replays its canonical receipt without effects');
      // A genuine independently opened writer races the real retirement.
      // Exactly one fence may win; neither outcome permits a dangling reference.
      const beforeRace=await resources(),raceRow=await binding.store.load(model,asId(first));assert.ok(raceRow);
      const raceRevision=await binding.store.readRevision();
      const writerBatch=makeBatch(raceRevision,{writes:[{kind:'update',model,id:raceRow.id,expectedVersion:raceRow.version,
        row:{...raceRow,version:asVersion(raceRow.version+1),data:{...raceRow.data,attachment:{id:raceFile}}}}]});
      const [retiredRace,writerRace]=await Promise.allSettled([binding.retireAndDelete(raceFile,'orphaned'),participating.commit(writerBatch)]);
      assert.equal(Number(retiredRace.status==='fulfilled')+Number(writerRace.status==='fulfilled'),1,'one original State fence wins');
      assert.deepEqual(await snapshot(b),beforeRace.b);assert.deepEqual(await snapshot(idDb),beforeRace.identity);
      if(writerRace.status==='fulfilled') {
        assert.equal(await binding.store.readFinalizedFileRetirement(raceFile),null);
        assert.deepEqual(physical.blobs.read(blobKeyForFile(raceFile)),A_BYTES);
        await noEffects(()=>binding.retireAndDelete(raceFile,'orphaned'));
        assert.equal((await attach(first,replacement)).result.status,'committed');
      } else {
        assert.ok(await binding.store.readFinalizedFileRetirement(raceFile));
        assert.equal(physical.blobs.read(blobKeyForFile(raceFile)),null);
        assert.deepEqual((await binding.store.load(model,asId(first)))?.data.attachment,{id:replacement});
      }
      const raceFinished=await binding.retireAndDelete(raceFile,'orphaned');
      assert.ok(['deleted','already-deleted'].includes(raceFinished.result));
      const retired=await binding.retireAndDelete(shared,'orphaned');assert.equal(retired.result,'deleted');
      assert.equal(physical.files.get(shared)?.state,'orphaned');assert.equal(physical.blobs.read(blobKeyForFile(shared)),null);
      const afterRetired=await resources();
      for(const original of [sharedFirst,sharedSecond]) {
        const result=await invoker.invokeMutation({operation:`${app}.attach`,operation_id:original.operationId,inputs:original.inputs},identity);
        const expected=JSON.parse(JSON.stringify(original.result));expected.status='replayed';delete expected.deliveries;
        for(const record of expected.records)delete record.data.attachment;
        assert.ok('result' in result);assert.deepEqual(result.result,expected,'original independent scalar replays while retired File fields remain withheld');
      }
      assert.deepEqual(await resources(),afterRetired,'withheld retired saved results cannot restore references or bytes');
      const current=await binding.store.load(model,asId(first));assert.ok(current);
      const reintroduce=makeBatch(await binding.store.readRevision(),{writes:[{kind:'update',model,id:current.id,expectedVersion:current.version,
        row:{...current,version:asVersion(current.version+1),data:{...current.data,attachment:{id:shared}}}}]});
      await noEffects(()=>legacy.commit(reintroduce));await noEffects(()=>participating.commit(reintroduce));
      const retiredInputs={entry:{id:first,version:String(current.version)},attachment:{id:shared},accept:true},retiredOperation=nextId();
      const retiredAttemptRevision=await binding.store.readRevision();
      const retiredAttempt=await invoker.invokeMutation({operation:`${app}.attach`,operation_id:retiredOperation,inputs:retiredInputs},identity);
      assert.ok('error' in retiredAttempt);assert.equal(retiredAttempt.error.code,'validation');
      const retiredReceipt=await binding.store.readReceipt({app,owner:team.team_id,principal:user.user_id,
        operation:asOperation(`${app}.attach`),operationId:retiredOperation});assert.ok(retiredReceipt);
      assert.equal(retiredReceipt.outcome.status,'rejected');
      const afterAttempt=await snapshot(a);
      for(const table of Object.keys(afterRetired.a))if(!['receipts','fence','fence_log'].includes(table))assert.deepEqual(afterAttempt[table],afterRetired.a[table],table);
      assert.equal(afterAttempt.receipts!.length,afterRetired.a.receipts!.length+1);
      assert.equal(retiredReceipt.committedRevision,retiredAttemptRevision+1);
      assert.equal(await binding.store.readRevision(),retiredAttemptRevision+1);
      assert.equal(afterAttempt.fence_log!.length,afterRetired.a.fence_log!.length+1);
      assert.deepEqual(physicalState(),afterRetired.files);assert.deepEqual(await snapshot(b),afterRetired.b);assert.deepEqual(await snapshot(idDb),afterRetired.identity);
      const afterAttemptResources=await resources();
      assert.deepEqual(await invoker.invokeMutation({operation:`${app}.attach`,operation_id:retiredOperation,inputs:retiredInputs},identity),retiredAttempt);
      assert.deepEqual(await resources(),afterAttemptResources,'retired File rejection replays without restoring anything');
      // An actual SQLite DELETE failure occurs AFTER permanent State retirement.
      // Metadata, byte deletion and the terminal journal must roll back together.
      const inspection=new DatabaseSync(filePath);
      try {
        const blob=blobKeyForFile(interrupted).replaceAll("'","''");
        inspection.exec(`CREATE TRIGGER interrupt_retired_bytes BEFORE DELETE ON files_blobs WHEN OLD.key='${blob}' BEGIN SELECT RAISE(ABORT,'intentional native deletion interruption'); END;`);
        const beforeInterrupted=await resources(),revision=await binding.store.readRevision();
        await assert.rejects(()=>binding.retireAndDelete(interrupted,'orphaned'),/intentional native deletion interruption/);
        const decision=await binding.store.readFinalizedFileRetirement(interrupted);assert.ok(decision);
        assert.equal(await binding.store.readRevision(),revision+1);
        assert.deepEqual(physicalState(),beforeInterrupted.files);
        assert.equal(inspection.prepare('SELECT json FROM files_retirement_journal WHERE id=?').get(interrupted),undefined);
        const after=await snapshot(a);
        for(const table of Object.keys(beforeInterrupted.a))if(!['file_retirements','fence','fence_log'].includes(table))assert.deepEqual(after[table],beforeInterrupted.a[table],table);
        assert.deepEqual(await snapshot(b),beforeInterrupted.b);assert.deepEqual(await snapshot(idDb),beforeInterrupted.identity);
        inspection.exec('DROP TRIGGER interrupt_retired_bytes');
      } finally {inspection.close();}
      const originalDecision=await binding.store.readFinalizedFileRetirement(interrupted),beforeReopen=await resources();
      const originalBinding=binding;
      // The owner router opens a genuine port per selection. Pin one literal
      // store registry with the original File port through a saved replay.
      const originalPort=buildInvoker(artifact,asm,originalBinding.store,{appId:app,memberships:identities,now:clock.nowMs,
        files:originalFiles});
      const originalReplay=await originalPort.invokeMutation({operation:`${app}.attach`,operation_id:sharedFirst.operationId,
        inputs:sharedFirst.inputs},identity);
      assert.ok('result' in originalReplay);assert.deepEqual(await resources(),beforeReopen);
      const fileStoreId=physical.fileStoreId;physical.close();physical=createSqliteFileStore(filePath);
      // A restarted host receives a freshly verified issuing assembly and a new
      // store registry. The original registry retains its installed File port.
      const reopenedArtifact=JSON.parse(originalArtifact) as CompileArtifact;
      const reopenedAssembly=await assembleModules({artifact:reopenedArtifact,sourcePath:fixture},{workDir:join(dir,'reopened-modules'),
        stdlibUrl:import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),uiUrl:import.meta.resolve('@canlang/ui')});
      binding=await createNativeFileRetirementBinding({...input,artifact:reopenedArtifact,asm:reopenedAssembly,physicalSqliteFileStore:physical});
      assert.equal(physical.fileStoreId,fileStoreId);assert.deepEqual(await resources(),beforeReopen,'genuine rebind preserves original inventory and fence');
      const reopenedInventory=await binding.store.readFileReferenceInventory(app);assert.ok(reopenedInventory);
      assert.deepEqual(reopenedInventory,installed,'physical reopen retains the complete original snapshot and declaration/default closure');
      assert.deepEqual(reopenedInventory.inventory.opaqueDeclarationSets,[originalSet]);
      const resumed=await binding.retireAndDelete(interrupted,'orphaned');assert.equal(resumed.result,'deleted');
      assert.deepEqual(resumed.retirement,originalDecision);assert.equal(physical.blobs.read(blobKeyForFile(interrupted)),null);
      const journal=new DatabaseSync(filePath);
      try {const entry=journal.prepare('SELECT json FROM files_retirement_journal WHERE id=?').get(interrupted);assert.equal(typeof entry?.json,'string');
        assert.deepEqual(JSON.parse(entry!.json as string).retirement,originalDecision);}finally{journal.close();}
      const completed=await resources();
      const replay=await binding.retireAndDelete(interrupted,'orphaned');assert.equal(replay.result,'already-deleted');assert.deepEqual(replay.retirement,originalDecision);
      assert.deepEqual(await resources(),completed,'durable terminal retry advances neither State nor physical stores');
      const reopenedKernel=createFileJourneyKernel(binding.bindings);
      const reopenedFiles=createCanonicalFileBinding(reopenedKernel,retention);
      const replacedPort=buildInvoker(artifact,asm,originalBinding.store,{appId:app,memberships:identities,now:clock.nowMs,
        files:reopenedFiles});
      const reopenedBefore=await resources(),originalPortRow=await binding.store.load(model,asId(first));assert.ok(originalPortRow);
      const portRefusal=await replacedPort.invokeMutation({operation:`${app}.attach`,operation_id:nextId(),
        inputs:{entry:{id:first,version:String(originalPortRow.version)},attachment:{id:replacement},accept:true}},identity);
      assert.ok('error' in portRefusal);assert.equal(portRefusal.error.code,'validation');
      assert.match(portRefusal.error.message,/original installed receiving port/);assert.deepEqual(await resources(),reopenedBefore);
      invoker=buildInvoker(reopenedArtifact,reopenedAssembly,binding.store,{appId:app,memberships:identities,now:clock.nowMs,
        files:reopenedFiles,ownerStorage:binding.ownerStorage});
      assert.equal((await attach(first,replacement)).result.status,'committed','genuine reopened owner continues canonical writes');
      const reopenedRow=await binding.store.load(model,asId(first));assert.ok(reopenedRow);
      const reopenedRevision=await binding.store.readRevision();
      await noEffects(()=>participating.commit(makeBatch(reopenedRevision,{writes:[{kind:'update',model,
        id:reopenedRow.id,expectedVersion:reopenedRow.version,row:{...reopenedRow,version:asVersion(reopenedRow.version+1),
          data:{...reopenedRow.data,attachment:{id:interrupted}}}}]})));
      assert.equal(JSON.stringify(artifact),originalArtifact);
      assert.deepEqual(await Promise.all(paths.map(async path=>digest(await readFile(path)))),hashes);
    } finally {physical?.close();await worker?.dispose();await rm(dir,{recursive:true,force:true});}
  });

test('unchanged TypedFileJourney installs its emitted empty File inventory and retires replaced references across reopen',
  {timeout:120000}, async () => {
    const fixture=fileURLToPath(new URL('./fixtures/typed-file-journey.can',import.meta.url));
    const compiler=join(root,'compiler/target/debug/can'),catalog=fileURLToPath(distribution.catalog);
    const paths=[fixture,compiler,catalog],digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
    const hashes=await Promise.all(paths.map(async path=>digest(await readFile(path))));
    const dir=await mkdtemp(join(tmpdir(),'can-file-empty-inventory-')),filePath=join(dir,'files.sqlite');
    let worker:Miniflare|undefined,physical:SqliteFileStore|undefined,sequence=0,now=FIXED_NOW;
    const clock={nowMs:()=>now},retention={unattachedHorizonMs:120000,retentionMs:600000};
    const nextId=()=>asOperationId(uuidv7(FIXED_NOW,++sequence));
    try {
      const env={...process.env};delete env.CAN_CATALOG;
      // This original void scenario stays on the ordinary native path.
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--catalog',catalog,fixture],
        {cwd:root,env,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact,originalArtifact=JSON.stringify(artifact);
      assert.deepEqual(artifact.valueTypes,{contracts:[]},'actual Compiler declaration census, not a host-supplied empty schema');
      assert.ok(artifact.sources.some(source=>resolve(source.path)===fixture&&source.sha256===hashes[0]));
      const attachDescriptor=artifact.operations?.find(operation=>operation.name===`${APP}.attach`);
      assert.ok(attachDescriptor);assert.deepEqual(attachDescriptor.result,{type:'void'},'unchanged void source claims no saved result disclosure');
      const asm=await assembleModules({artifact,sourcePath:fixture},{workDir:join(dir,'modules'),
        stdlibUrl:import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),uiUrl:import.meta.resolve('@canlang/ui')});
      worker=new Miniflare({compatibilityDate:'2026-07-15',modules:true,script:'export default {fetch(){return new Response("ok")}}',
        d1Databases:{IDENTITY:'empty-inventory-identity',OWNER:'empty-inventory-owner'},d1Persist:join(dir,'d1')});
      const idDb=await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const db=await worker.getD1Database('OWNER') as unknown as D1Database;
      await ensureIdentitySchema(idDb);await ensureSchema(db);
      const identities=createD1IdentityStore(idDb,{clock}),team=await identities.createTeam({timezone:'UTC'});
      const user=await identities.createUser({email:'empty-inventory@example.test',password_hash:'unused',email_verified:true});
      await identities.createMembership({user_id:user.user_id,team_id:team.team_id,is_owner:true,roles:[]});
      const grant=await issueMcpGrant(identities,{user_id:user.user_id,team_id:team.team_id,client_id:'empty-inventory'},{clock});
      const identity=await resolveIdentity(identities,{mcp_grant_token:grant.token},{clock});
      assert.equal(identity.actor?.user_id,user.user_id);assert.equal(identity.team?.team_id,team.team_id);
      physical=createSqliteFileStore(filePath);
      const input={artifact,asm,scope:{app:APP,ownerPackage:APP,owner:team.team_id},identities,db,
        stateStoreId:'typed-file-empty-inventory',physicalSqliteFileStore:physical,initializeFresh:true as const,
        clock,intentTtlMs:60000,urlBase:'https://test.invalid',retention,maxRows:100,maxReferences:100};
      let binding=await createNativeFileRetirementBinding(input);
      const installed=await binding.store.readFileReferenceInventory(APP);assert.ok(installed);
      assert.deepEqual(installed.inventory.valueTypes,{contracts:[]});
      assert.deepEqual(installed.inventory.artifactModels,artifact.models);
      assert.equal(installed.inventory.frameworkModels.length,13);
      const routed=await binding.ownerStorage.forIdentity(identity);
      assert.deepEqual(await routed.readFileReferenceInventory(APP),installed);
      assert.equal(routed.fileRetirementAuthority.fileStoreId,physical.fileStoreId);
      const physicalState=()=>({fileStoreId:physical!.fileStoreId,files:physical!.files.listAll(),intents:physical!.intents.listAll(),
        bytes:physical!.files.listAll().map(record=>physical!.blobs.read(blobKeyForFile(record.file.id))),
        staging:physical!.intents.listAll().map(intent=>physical!.blobs.read(stagingKeyForIntent(intent.intentId)))});
      const resources=async()=>({state:await snapshot(db),identity:await snapshot(idDb),files:physicalState()});
      const kernel=createFileJourneyKernel(binding.bindings);
      const upload:UploadDeps&{kernel:typeof kernel}={app:{appId:APP,brand:APP,appDefaultLocale:'en',ownerLabels:new Map()},
        files:{usesFiles:()=>true},kernel,clock,logger:{log:()=>{}},
        identity:{store:identities,clock,mail:{sendMail:async()=>{}},verifyBaseUrl:'',recoveryBaseUrl:'',inviteBaseUrl:'',sessionMaxAgeSeconds:3600}};
      const handler=createBoundFileHandler({artifact,asm,store:binding.store,memberships:identities,identityStore:identities,
        clock,upload,ownerStorage:binding.ownerStorage,retention,physicalFiles:physical.files,fileReferenceBounds:{maxRows:100,maxReferences:100}});
      const request=(path:string,method:string,body:string|Uint8Array)=>new Request(path.startsWith('https:')?path:`https://test.invalid${path}`,
        {method,headers:{authorization:`Bearer ${grant.token}`,'content-type':body instanceof Uint8Array?'application/octet-stream':'application/json',
          ...(method==='PUT'?{'upload-offset':'0'}:{})},body});
      const uploadFile=async(uploadId:string)=>{
        const response=await handler(request('/files/intents','POST',JSON.stringify({upload_id:uploadId,operation:`${APP}.attach`,field:'/attachment',
          arguments:{},name:'empty-inventory.pdf',type:'application/pdf',size:String(A_BYTES.length)})));
        assert.equal(response.status,200,await response.clone().text());
        const intent=await response.json() as {content:string;finalize:string};
        assert.equal((await handler(request(intent.content,'PUT',A_BYTES))).status,200);
        const finalized=await handler(request(intent.finalize,'POST',JSON.stringify({upload_id:uploadId,bytes_digest:sha256Hex(A_BYTES)})));
        assert.equal(finalized.status,200,await finalized.clone().text());
        const ref=(await finalized.json() as {file:string}).file;assert.equal(typeof ref,'string');return ref;
      };
      const invoker=buildInvoker(artifact,asm,binding.store,{appId:APP,memberships:identities,now:clock.nowMs,
        files:createCanonicalFileBinding(kernel,retention),ownerStorage:binding.ownerStorage});
      const create=async()=>{
        const result=await invoker.invokeMutation({operation:`${MODEL}.create`,operation_id:nextId(),inputs:{}},identity);
        assert.ok('result' in result,JSON.stringify(result));assert.equal(result.result.status,'committed');
        const records=result.result.records;assert.ok(records);assert.equal(records.length,1);
        const record=records[0];assert.ok(record!==null&&typeof record==='object'&&'id' in record);assert.ok(typeof record.id==='string');
        const id=record.id,row=await binding.store.load(MODEL,asId(id));assert.ok(row);
        assert.equal(row.version,1);assert.deepEqual(row.data,{label:'Uploaded',attachment:null});return id;
      };
      const attach=async(id:string,ref:string)=>{
        const before=await binding.store.load(MODEL,asId(id));assert.ok(before);
        const operationId=nextId(),revision=await binding.store.readRevision();
        const result=await invoker.invokeMutation({operation:`${APP}.attach`,operation_id:operationId,
          inputs:{entry:{id,version:String(before.version)},attachment:{id:ref},accept:true}},identity);
        assert.ok('result' in result,JSON.stringify(result));assert.equal(result.result.status,'committed');
        const after=await binding.store.load(MODEL,asId(id));assert.ok(after);
        assert.equal(after.version,before.version+1);assert.deepEqual(after.data,{...before.data,attachment:{id:ref}});
        assert.equal(await binding.store.readRevision(),revision+1);
        const receipt=await binding.store.readReceipt({app:APP,owner:team.team_id,principal:user.user_id,
          operation:asOperation(`${APP}.attach`),operationId});assert.ok(receipt);assert.equal(receipt.outcome.status,'committed');
        const history=await binding.store.historyFor(MODEL,after.id);assert.equal(history.length,after.version);
        assert.equal(history.at(-1)!.operationId,operationId);assert.deepEqual(history.at(-1)!.before,before.data);
        assert.deepEqual(history.at(-1)!.after,after.data);
      };
      const original=await uploadFile('original'),replacement=await uploadFile('replacement');assert.notEqual(original,replacement);
      const first=await create(),second=await create();
      await attach(first,original);await attach(second,replacement);
      now=FIXED_NOW+retention.unattachedHorizonMs+1;
      const referenced=await resources();await assert.rejects(()=>binding.retireAndDelete(original,'orphaned'));
      assert.deepEqual(await resources(),referenced,'original source field remains a genuine retirement barrier');
      await attach(first,replacement);
      const beforeRetirement=await resources(),retirementRevision=await binding.store.readRevision();
      const retired=await binding.retireAndDelete(original,'orphaned');assert.equal(retired.result,'deleted');
      const originalDecision=await binding.store.readFinalizedFileRetirement(original);assert.deepEqual(originalDecision,retired.retirement);
      assert.equal(await binding.store.readRevision(),retirementRevision+1);
      const afterRetirement=await resources();
      for(const table of Object.keys(beforeRetirement.state))if(!['file_retirements','fence','fence_log'].includes(table))
        assert.deepEqual(afterRetirement.state[table],beforeRetirement.state[table],table);
      assert.deepEqual(afterRetirement.identity,beforeRetirement.identity);
      assert.equal(physical.files.get(original)?.state,'orphaned');assert.equal(physical.blobs.read(blobKeyForFile(original)),null);
      assert.deepEqual(physical.blobs.read(blobKeyForFile(replacement)),A_BYTES);
      const fileStoreId=physical.fileStoreId;physical.close();physical=createSqliteFileStore(filePath);
      const reopenedArtifact=JSON.parse(originalArtifact) as CompileArtifact;
      const reopenedAssembly=await assembleModules({artifact:reopenedArtifact,sourcePath:fixture},{workDir:join(dir,'reopened-modules'),
        stdlibUrl:import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),uiUrl:import.meta.resolve('@canlang/ui')});
      binding=await createNativeFileRetirementBinding({...input,artifact:reopenedArtifact,asm:reopenedAssembly,physicalSqliteFileStore:physical});
      assert.equal(physical.fileStoreId,fileStoreId);
      assert.deepEqual(await binding.store.readFileReferenceInventory(APP),installed);
      assert.deepEqual(await binding.store.readFinalizedFileRetirement(original),originalDecision);
      assert.deepEqual(await resources(),afterRetirement,'reopen preserves the installed declaration and original permanent decision');
      const retry=await binding.retireAndDelete(original,'orphaned');assert.equal(retry.result,'already-deleted');
      assert.deepEqual(retry.retirement,originalDecision);assert.deepEqual(await resources(),afterRetirement,'terminal retry has no effects');
      assert.equal(JSON.stringify(artifact),originalArtifact);
      assert.deepEqual(await Promise.all(paths.map(async path=>digest(await readFile(path)))),hashes);
    } finally {physical?.close();await worker?.dispose();await rm(dir,{recursive:true,force:true});}
  });


/** Genuine compiled deferred File path; no original application or provider qualification. */
test('native deferred File payload survives its original schedule fence and reopen, then runs the retained source once',
  {timeout:120000}, async () => {
    const app='NativeFileDeferred',model=asModel(`${app}.Entry`),event=`${app}.Retained`,privateHandler=`${app}.fire`;
    const fixture=fileURLToPath(new URL('./fixtures/native-file-deferred.can',import.meta.url));
    const compiler=join(root,'compiler/target/debug/can'),catalog=fileURLToPath(distribution.catalog);
    const inputs=[fixture,compiler,catalog],hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
    const originalHashes=await Promise.all(inputs.map(async path=>hash(await readFile(path))));
    const dir=await mkdtemp(join(tmpdir(),'can-native-file-deferred-')),filePath=join(dir,'files.sqlite');
    let worker:Miniflare|undefined,physical:SqliteFileStore|undefined,now=FIXED_NOW,sequence=0;
    const clock={nowMs:()=>now},retention={unattachedHorizonMs:120000,retentionMs:600000};
    const nextId=()=>asOperationId(uuidv7(FIXED_NOW,++sequence));
    const object=(value:unknown):Record<string,unknown>=>{
      assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));return value as Record<string,unknown>;
    };
    try {
      const env={...process.env};delete env.CAN_CATALOG;
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--catalog',catalog,fixture],
        {cwd:root,env,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as CompileArtifact,originalArtifact=JSON.stringify(artifact);
      assert.ok(artifact.sources.some(source=>resolve(source.path)===fixture&&source.sha256===originalHashes[0]));
      assert.deepEqual(artifact.valueTypes,{contracts:[]});
      for(const operation of ['arm','cancel_pending'])assert.deepEqual(artifact.operations?.find(value=>value.name===`${app}.${operation}`)?.result,{type:'void'});
      const fire=artifact.callables.find(value=>value.id===privateHandler&&value.kind==='handler');assert.ok(fire);
      let asm=await assembleModules({artifact,sourcePath:fixture},{workDir:join(dir,'modules'),
        stdlibUrl:import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),uiUrl:import.meta.resolve('@canlang/ui')});
      const namespace=object(await importVerifiedAssemblyModule(asm,fire.module,artifact)),definition=object(namespace.appDefinition);
      assert.equal(definition.id,app);
      const declaredInputs=object(object(object(definition.events)[event]).inputs);
      assert.deepEqual(Object.keys(declaredInputs).sort(),['attachment','entry','note']);
      assert.equal(object(declaredInputs.attachment).type,'file');assert.equal(object(declaredInputs.entry).type,model);
      const note=object(declaredInputs.note);assert.equal(note.type,'text');
      assert.equal(String(note.min),'1');assert.equal(String(note.max),'16');assert.equal(note.trim,true);
      assert.equal(object(object(definition.operations)[privateHandler]).event,event);
      worker=new Miniflare({compatibilityDate:'2026-07-15',modules:true,script:'export default {fetch(){return new Response("ok")}}',
        d1Databases:{IDENTITY:'deferred-file-identity',A:'deferred-file-a',B:'deferred-file-b'},d1Persist:join(dir,'d1')});
      const idDb=await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const a=await worker.getD1Database('A') as unknown as D1Database,b=await worker.getD1Database('B') as unknown as D1Database;
      await ensureIdentitySchema(idDb);await ensureSchema(a);await ensureSchema(b);
      const identities=createD1IdentityStore(idDb,{clock}),team=await identities.createTeam({timezone:'UTC'}),otherTeam=await identities.createTeam({timezone:'UTC'});
      const user=await identities.createUser({email:'native-deferred-file@example.test',password_hash:'unused',email_verified:true});
      for(const selected of [team,otherTeam])await identities.createMembership({user_id:user.user_id,team_id:selected.team_id,is_owner:true,roles:[]});
      const grant=await issueMcpGrant(identities,{user_id:user.user_id,team_id:team.team_id,client_id:'deferred-file'},{clock});
      const identity=await resolveIdentity(identities,{mcp_grant_token:grant.token},{clock});
      assert.equal(identity.actor?.user_id,user.user_id);assert.equal(identity.team?.team_id,team.team_id);
      physical=createSqliteFileStore(filePath);
      const scope={app,ownerPackage:app,owner:team.team_id};
      const bindingInput={artifact,asm,scope,identities,db:a,stateStoreId:'native-deferred-file-owner-a',physicalSqliteFileStore:physical,
        initializeFresh:true as const,clock,intentTtlMs:60000,urlBase:'https://test.invalid',retention,maxRows:100,maxReferences:100};
      let binding=await createNativeFileRetirementBinding(bindingInput);
      const installed=await binding.store.readFileReferenceInventory(app);assert.ok(installed);
      const declarations=installed.inventory.opaqueDeclarationSets;assert.ok(declarations);assert.equal(declarations.length,1);
      const eventDeclaration=declarations[0]!.declarations.find(value=>value.source.kind==='event'&&value.source.event===event);assert.ok(eventDeclaration);
      assert.equal(eventDeclaration.profile.kind,'inputs');assert.deepEqual(eventDeclaration.source.source,
        {path:artifact.sources[0]!.path,sha256:artifact.sources[0]!.sha256,module:fire.module});
      assert.equal(installed.inventory.frameworkModels.length,13);
      const physicalState=()=>({fileStoreId:physical!.fileStoreId,files:physical!.files.listAll(),intents:physical!.intents.listAll(),
        bytes:physical!.files.listAll().map(record=>physical!.blobs.read(blobKeyForFile(record.file.id))),
        staging:physical!.intents.listAll().map(intent=>physical!.blobs.read(stagingKeyForIntent(intent.intentId)))});
      const resources=async()=>({a:await snapshot(a),b:await snapshot(b),identity:await snapshot(idDb),files:physicalState()});
      const query=(name:string)=>binding.store.query({model:asModel(name),authority:'owner',archived:'include',order:[{field:'id',direction:'asc'}]});
      const setup=()=>{
        const kernel=createFileJourneyKernel(binding.bindings),files=createCanonicalFileBinding(kernel,retention);
        const upload:UploadDeps&{kernel:typeof kernel}={app:{appId:app,brand:app,appDefaultLocale:'en',ownerLabels:new Map()},
          files:{usesFiles:()=>true},kernel,clock,logger:{log:()=>{}},
          identity:{store:identities,clock,mail:{sendMail:async()=>{}},verifyBaseUrl:'',recoveryBaseUrl:'',inviteBaseUrl:'',sessionMaxAgeSeconds:3600}};
        return {files,handler:createBoundFileHandler({artifact,asm,store:binding.store,memberships:identities,identityStore:identities,
          clock,upload,ownerStorage:binding.ownerStorage,retention,physicalFiles:physical!.files,fileReferenceBounds:{maxRows:100,maxReferences:100}}),
          invoker:buildInvoker(artifact,asm,binding.store,{appId:app,memberships:identities,now:clock.nowMs,files,ownerStorage:binding.ownerStorage})};
      };
      let host=setup();
      const created=await host.invoker.invokeMutation({operation:`${model}.create`,operation_id:nextId(),inputs:{}},identity);
      assert.ok('result' in created,JSON.stringify(created));assert.equal(created.result.status,'committed');
      const records=created.result.records;assert.ok(records);assert.equal(records.length,1);
      const entry=object(records[0]);assert.equal(typeof entry.id,'string');const entryId=asId(String(entry.id));
      const originalRow=await binding.store.load(model,entryId);assert.ok(originalRow);assert.equal(originalRow.version,1);
      const uploadFile=async(uploadId:string,due:number)=>{
        const request=(path:string,method:string,body:string|Uint8Array)=>new Request(path.startsWith('https:')?path:`https://test.invalid${path}`,
          {method,headers:{authorization:`Bearer ${grant.token}`,'content-type':body instanceof Uint8Array?'application/octet-stream':'application/json',
            ...(method==='PUT'?{'upload-offset':'0'}:{})},body});
        const response=await host.handler(request('/files/intents','POST',JSON.stringify({upload_id:uploadId,operation:`${app}.arm`,field:'/attachment',
          arguments:{entry:{id:entryId,version:'1'},due:new Date(due).toISOString(),accept:true},
          name:'deferred.pdf',type:'application/pdf',size:String(A_BYTES.length)})));
        assert.equal(response.status,200,await response.clone().text());
        const intent=await response.json() as {content:string;finalize:string};
        assert.equal((await host.handler(request(intent.content,'PUT',A_BYTES))).status,200);
        const finalized=await host.handler(request(intent.finalize,'POST',JSON.stringify({upload_id:uploadId,bytes_digest:sha256Hex(A_BYTES)})));
        assert.equal(finalized.status,200,await finalized.clone().text());
        const ref=(await finalized.json() as {file:string}).file;assert.equal(typeof ref,'string');return ref;
      };
      const dueAt=FIXED_NOW+300000,ref=await uploadFile('cancelled-original',dueAt);
      const arm=(file:string,at:number,accept:boolean):MutationEnvelope=>({operation:`${app}.arm`,operation_id:nextId(),
        inputs:{entry:{id:entryId,version:'1'},attachment:{id:file},due:new Date(at).toISOString(),accept}});
      const rejectedEnvelope=arm(ref,dueAt,false),beforeRejected=await resources(),rejectedRevision=await binding.store.readRevision();
      const rejected=await host.invoker.invokeMutation(rejectedEnvelope,identity);assert.ok('error' in rejected,JSON.stringify(rejected));
      assert.equal(rejected.error.code,'rule_failed');
      const afterRejected=await resources();
      for(const table of Object.keys(beforeRejected.a))if(!['receipts','fence','fence_log'].includes(table))assert.deepEqual(afterRejected.a[table],beforeRejected.a[table],table);
      assert.equal(afterRejected.a.receipts!.length,beforeRejected.a.receipts!.length+1);
      assert.equal(await binding.store.readRevision(),rejectedRevision+1);
      assert.deepEqual(afterRejected.b,beforeRejected.b);assert.deepEqual(afterRejected.identity,beforeRejected.identity);assert.deepEqual(afterRejected.files,beforeRejected.files);
      const rejectedReplay=await resources();await host.invoker.invokeMutation(rejectedEnvelope,identity);assert.deepEqual(await resources(),rejectedReplay);
      const envelope=arm(ref,dueAt,true),revision=await binding.store.readRevision();
      const accepted=await host.invoker.invokeMutation(envelope,identity);assert.ok('result' in accepted,JSON.stringify(accepted));assert.equal(accepted.result.status,'committed');
      assert.equal(await binding.store.readRevision(),revision+1);assert.deepEqual(await binding.store.load(model,entryId),originalRow);
      let schedules=await query(WORK_SCHEDULE_MODEL);assert.equal(schedules.length,1);
      const queued=readScheduleRow(schedules[0]!);assert.equal(queued.state,'pending');assert.equal(queued.event,event);
      assert.equal(queued.payload.note,'Retained');assert.deepEqual(queued.payload.attachment,{id:ref});
      assert.ok(queued.filePayloadOrigin);assert.equal(queued.filePayloadOrigin.slot.id,schedules[0]!.id);
      assert.equal(queued.filePayloadOrigin.slot.model,WORK_SCHEDULE_MODEL);
      assert.equal(queued.filePayloadOrigin.origin.kind,'event-input');assert.equal(queued.filePayloadOrigin.declarationSetId,declarations[0]!.id);
      assert.equal(queued.filePayloadOrigin.files.length,1);assert.deepEqual(queued.filePayloadOrigin.files[0]!.path,['attachment']);
      assert.equal(queued.filePayloadOrigin.files[0]!.file.ref,ref);
      const committed=await resources();const replay=await host.invoker.invokeMutation(envelope,identity);
      assert.ok('error' in replay,JSON.stringify(replay));assert.equal(replay.error.code,'validation');
      assert.match(replay.error.message,/no supported execution association/);
      assert.deepEqual(await resources(),committed,'ordinary void source withholds legacy saved content without repeating schedule effects');
      now=FIXED_NOW+retention.unattachedHorizonMs+1;
      const queuedResources=await resources();await assert.rejects(()=>binding.retireAndDelete(ref,'orphaned'));assert.deepEqual(await resources(),queuedResources);
      const fileStoreId=physical.fileStoreId;physical.close();physical=createSqliteFileStore(filePath);
      asm=await assembleModules({artifact,sourcePath:fixture},{workDir:join(dir,'reopened-modules'),
        stdlibUrl:import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),uiUrl:import.meta.resolve('@canlang/ui')});
      binding=await createNativeFileRetirementBinding({...bindingInput,asm,physicalSqliteFileStore:physical});host=setup();
      assert.equal(physical.fileStoreId,fileStoreId);assert.deepEqual(await binding.store.readFileReferenceInventory(app),installed);
      assert.deepEqual(readScheduleRow((await query(WORK_SCHEDULE_MODEL))[0]!).filePayloadOrigin,queued.filePayloadOrigin);
      assert.deepEqual(await resources(),queuedResources);
      await assert.rejects(()=>binding.retireAndDelete(ref,'orphaned'));assert.deepEqual(await resources(),queuedResources);
      const cancelEnvelope:MutationEnvelope={operation:`${app}.cancel_pending`,operation_id:nextId(),inputs:{entry:{id:entryId,version:'1'}}};
      const cancelled=await host.invoker.invokeMutation(cancelEnvelope,identity);assert.ok('result' in cancelled,JSON.stringify(cancelled));assert.equal(cancelled.result.status,'committed');
      const cancelledSchedule=readScheduleRow((await query(WORK_SCHEDULE_MODEL))[0]!);
      assert.equal(cancelledSchedule.state,'cancelled');
      assert.deepEqual(cancelledSchedule.payload,queued.payload);
      assert.deepEqual(cancelledSchedule.filePayloadOrigin,queued.filePayloadOrigin);
      const afterCancel=await resources();await host.invoker.invokeMutation(cancelEnvelope,identity);assert.deepEqual(await resources(),afterCancel);
      await assert.rejects(()=>binding.retireAndDelete(ref,'orphaned'));
      assert.deepEqual(await resources(),afterCancel,'cancelled retained payload remains a retirement barrier without effects');
      assert.deepEqual(physical.blobs.read(blobKeyForFile(ref)),A_BYTES);
      const fireAt=FIXED_NOW+200000,fireRef=await uploadFile('delivered-original',fireAt),fireEnvelope=arm(fireRef,fireAt,true);
      const fireArm=await host.invoker.invokeMutation(fireEnvelope,identity);assert.ok('result' in fireArm,JSON.stringify(fireArm));assert.equal(fireArm.result.status,'committed');
      schedules=await query(WORK_SCHEDULE_MODEL);const pending=schedules.map(readScheduleRow).find(value=>value.state==='pending');assert.ok(pending);
      assert.ok(pending.filePayloadOrigin);now=fireAt;
      // Delivery remains gated on the defining actor-null File observation join; no synthetic receiver is supplied.
      const due={key:pending.key,scope,occurrenceId:pending.occurrenceId,event:pending.event,at:pending.at,filePayloadOrigin:pending.filePayloadOrigin};
      const options={artifact,asm,app,handler:privateHandler,due,store:binding.store,identities,now:clock.nowMs,files:host.files};
      const beforeRouting=await resources();
      const trustedIdentity={...identity,actor:null};
      assert.equal(await host.files.observe!(fireRef,trustedIdentity,app),null,'ordinary actor-null observation remains refused');
      assert.equal(await host.files.validate(fireRef,trustedIdentity,app),false,'saved receiver does not grant normal attachment');
      const {files:omittedFiles,...withoutFiles}=options;
      await assert.rejects(()=>invokeDueSourceRoutingCanonical(withoutFiles),/genuine observer/);
      assert.deepEqual(await resources(),beforeRouting);
      await assert.rejects(()=>invokeDueSourceRoutingCanonical({...options,files:{...omittedFiles}}),/no longer available/);
      assert.deepEqual(await resources(),beforeRouting,'copied host binding has no retained observation authority');
      const incompatibleFiles=createCanonicalFileBinding(createFileJourneyKernel(binding.bindings),{...retention,retentionMs:retention.retentionMs+1});
      await assert.rejects(()=>invokeDueSourceRoutingCanonical({...options,files:incompatibleFiles}),/no longer available/);
      assert.deepEqual(await resources(),beforeRouting,'current host policy cannot recapture incompatible original File horizons');
      assert.equal(object(await invokeDueSourceRoutingCanonical(options)).status,'completed');
      assert.deepEqual(await binding.store.load(model,entryId),originalRow);
      const sourceRow=await binding.store.load(WORK_OCCURRENCE_MODEL,asId(pending.occurrenceId));assert.ok(sourceRow);
      const sourceReceipt=readOccurrenceRow(sourceRow);assert.equal(sourceReceipt.status,'completed');
      assert.ok(sourceReceipt.filePayloadOrigin);assert.equal(sourceReceipt.filePayloadOrigin.slot.model,WORK_OCCURRENCE_MODEL);
      assert.equal(sourceReceipt.filePayloadOrigin.slot.id,sourceRow.id);assert.equal(sourceReceipt.filePayloadOrigin.slot.field,'result');
      assert.equal(sourceReceipt.filePayloadOrigin.origin.kind,'source-routing');assert.deepEqual(sourceReceipt.filePayloadOrigin.files,[]);
      const routes=await query(WORK_HANDLER_OCCURRENCE_MODEL);assert.equal(routes.length,1);
      const retained=readHandlerOccurrenceRow(routes[0]!);assert.equal(retained.state,'pending');
      assert.equal(retained.handler,privateHandler);assert.equal(retained.sourceOccurrence,pending.occurrenceId);assert.equal(retained.payload.note,'Retained');
      assert.ok(retained.filePayloadOrigin);assert.equal(retained.filePayloadOrigin.slot.id,routes[0]!.id);
      assert.equal(retained.filePayloadOrigin.slot.model,WORK_HANDLER_OCCURRENCE_MODEL);
      assert.notDeepEqual(retained.filePayloadOrigin.slot,pending.filePayloadOrigin.slot,'handler header is issued for its own genuine row');
      assert.deepEqual(retained.filePayloadOrigin.files,pending.filePayloadOrigin.files);
      const routed=await resources();assert.equal(routed.a.schedules!.length,beforeRouting.a.schedules!.length-1,'actual source routing cancels its L3 schedule');assert.equal(object(await invokeDueSourceRoutingCanonical(options)).status,'replayed');assert.deepEqual(await resources(),routed);
      const selector={sourceOccurrence:retained.sourceOccurrence,handler:retained.handler,event:retained.event,scope,filePayloadOrigin:retained.filePayloadOrigin};
      const handlerOptions={artifact,asm,app,selector,store:binding.store,identities,now:clock.nowMs,files:host.files};
      const beforeHandlerRevision=await binding.store.readRevision();
      const tick=await createBoundCohortTick({artifact,asm,identities,ownerStorage:binding.ownerStorage,scope,now:clock.nowMs,files:host.files});
      const tickResults=await tick.tick();assert.ok(Array.isArray(tickResults));assert.equal(tickResults.length,2);
      assert.equal(object(tickResults[0]).status,'completed','actual installed tick forwards the original handler header and genuine File binding');
      assert.deepEqual(tickResults[1],{wrapped:false},'the original tick also reports its empty navigation check without a write');
      assert.equal(await binding.store.readRevision(),beforeHandlerRevision+1);
      const terminal=await resources();assert.equal(readHandlerOccurrenceRow((await query(WORK_HANDLER_OCCURRENCE_MODEL))[0]!).state,'completed');
      const terminalRow=await binding.store.load(WORK_OCCURRENCE_MODEL,asId(retained.occurrenceId));assert.ok(terminalRow);
      const terminalReceipt=readOccurrenceRow(terminalRow);assert.equal(terminalReceipt.status,'completed');
      assert.ok(terminalReceipt.filePayloadOrigin);assert.equal(terminalReceipt.filePayloadOrigin.slot.model,WORK_OCCURRENCE_MODEL);
      assert.equal(terminalReceipt.filePayloadOrigin.slot.id,terminalRow.id);assert.equal(terminalReceipt.filePayloadOrigin.slot.field,'result');
      const resultOrigin=terminalReceipt.filePayloadOrigin.origin;assert.equal(resultOrigin.kind,'handler-result');
      if(resultOrigin.kind==='handler-result'){
        assert.equal(resultOrigin.occurrenceId,routes[0]!.id);assert.deepEqual(resultOrigin.event,retained.filePayloadOrigin.origin);
      }
      assert.deepEqual(terminalReceipt.filePayloadOrigin.files,[],'genuine declared void result records no File occurrences');
      assert.deepEqual(await binding.store.load(model,entryId),originalRow);
      assert.equal(terminal.a.receipts!.length,routed.a.receipts!.length+1,'one actual private handler canonical receipt');
      assert.deepEqual(terminal.a.records!.filter(row=>row.model===model),beforeRouting.a.records!.filter(row=>row.model===model));
      for(const table of ['history','outbox','schedules','unique_claims']){assert.ok(terminal.a[table]);assert.deepEqual(terminal.a[table],routed.a[table],table);}
      assert.deepEqual(terminal.b,beforeRouting.b);assert.deepEqual(terminal.identity,beforeRouting.identity);assert.deepEqual(terminal.files,beforeRouting.files);
      assert.equal(object(await invokeRetainedHandlerOccurrenceCanonical(handlerOptions)).status,'replayed');assert.deepEqual(await resources(),terminal);
      assert.equal(JSON.stringify(artifact),originalArtifact);
      assert.deepEqual(await Promise.all(inputs.map(async path=>hash(await readFile(path)))),originalHashes);
    } finally {physical?.close();await worker?.dispose();await rm(dir,{recursive:true,force:true});}
  });
