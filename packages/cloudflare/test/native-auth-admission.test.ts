/** Native AppOwnedPreview + production D1/Identity transports. This qualifies
 * pre-invoker credential timing, not cancellation of already admitted work. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import { buildSessionCookie, createD1IdentityStore, deriveCsrfToken, issueMcpGrant, sha256HexText, requestRecovery, recoverAccount, hashPassword, verifyPassword } from '@canlang/identity';
import { asOperationId, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { handleOperationRequest, handlePageRequest, createMcpHandler, INPUT_CHOICES_VERSION } from '@canlang/interfaces';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { assembleWorker, type HttpDeps as AssemblyHttpDeps } from '@canlang/cloudflare/worker/assembly';
import { buildProductionDeps } from '../dist/runtime/env-assembly.js';
import { createMemberMcpPermissions } from '../dist/runtime/mcp-permissions.js';
import { buildDerivedInputsModule } from '../dist/deploy/bundle.js';
import { prepareLocalPreviewCapture } from '../dist/runtime/native-dev.test-support.js';
import { captureSingleFileSource, captureIsCurrent } from '../dist/runtime/native-dev.test-support.js';
import { compileCapturedSingleFile } from '../dist/runtime/native-dev.test-support.js';
import { localPreviewActivationVerdict } from '../dist/runtime/native-preview.test-support.js';

function gate() {
  let resolve!:()=>void;
  const promise=new Promise<void>(done=>{resolve=done;});
  return {promise,resolve};
}
function object(value:unknown):Record<string,unknown> {
  assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value));
  return value as Record<string,unknown>;
}
async function snapshot(db:D1Database) {
  const tables=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{name:string}>();
  assert.equal(tables.success,true);
  const result:Record<string,readonly Record<string,unknown>[]>={};
  for(const {name} of tables.results) {
    const rows=await db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all<Record<string,unknown>>();
    assert.equal(rows.success,true);
    result[name]=rows.results.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}

async function runAdmissionTiming(cause:'direct'|'recovery'):Promise<void> {
    const root=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
    const fixture=join(root,'tests/integration/can-dev-server/AppOwnedPreview.can');
    const {distribution}=await import('@canlang/values/distribution');
    const capture=await captureSingleFileSource(prepareLocalPreviewCapture({checkoutRoot:root,appPath:fixture,
      compilerPath:join(root,'compiler/target/debug/can'),catalogPath:fileURLToPath(distribution.catalog),
      helpIndexPath:join(root,'docs/specification/CONSTRUCT-HELP.md')}));
    assert.equal(await captureIsCurrent(capture),true);
    const compiled=await compileCapturedSingleFile(capture);assert.equal(compiled.kind,'artifact');
    const artifact=compiled.artifact,originalArtifact=JSON.stringify(artifact);
    assert.deepEqual(artifact.sources,[{path:capture.compilerOperand,sha256:capture.sourceSha256}]);
    assert.ok(artifact.models);assert.equal(artifact.models.length,1);assert.equal(artifact.models[0]!.scope,'app');
    const operation='AppOwnedPreview.Setting.create';assert.ok(artifact.operations?.some(value=>value.name===operation));
    const dir=await mkdtemp(join(tmpdir(),'can-native-auth-admission-'));
    let mf:Miniflare|undefined;
    const releases:Array<()=>void>=[];
    try {
      const asm=await assembleModules({artifact,sourcePath:fixture},{workDir:join(dir,'modules'),
        stdlibUrl:import.meta.resolve('@canlang/cloudflare/runtime/stdlib'),uiUrl:import.meta.resolve('@canlang/ui')});
      mf=new Miniflare({compatibilityDate:'2026-07-15',modules:true,
        script:'export default {fetch(){return new Response("ok")}}',d1Databases:{DB:'native-auth-admission'},d1Persist:join(dir,'d1')});
      const db=await mf.getD1Database('DB') as unknown as D1Database;
      const production=await buildProductionDeps({DB:db,CAN_AUTH_ORIGIN:'https://native-auth.example'});
      const identities=createD1IdentityStore(db);
      const user=await identities.createUser({email:'native-auth@example.test',password_hash:'unused',email_verified:true});
      const team=await identities.createTeam({timezone:'UTC'});
      await identities.createMembership({user_id:user.user_id,team_id:team.team_id,is_owner:true,roles:[]});
      const other=cause==='recovery'?await identities.createUser({email:'native-auth-other@example.test',
        password_hash:await hashPassword('Other account password'),email_verified:true}):undefined;
      if(other!==undefined) {
        await identities.createMembership({user_id:other.user_id,team_id:team.team_id,is_owner:false,roles:[]});
        await identities.createSession({user_id:other.user_id,token_sha256:await sha256HexText(randomBytes(32).toString('hex')),
          expires_at:new Date(Date.now()+3600000).toISOString(),last_team_id:team.team_id});
        await issueMcpGrant(identities,{user_id:other.user_id,team_id:team.team_id,client_id:'other-account'});
      }
      const verdict=await localPreviewActivationVerdict(artifact,capture,db,'native-auth-admission');
      assert.equal(verdict.active,true,'actual installed activation gates must admit the unchanged native source');
      const derivedModule=object(await import(`data:text/javascript,${encodeURIComponent(buildDerivedInputsModule(artifact))}`));
      const derivedInputs=derivedModule.derivedInputs as NonNullable<Parameters<typeof assembleWorker>[2]['http']>['derivedInputs'];
      assert.ok(derivedInputs);
      let sequence=0;
      for(const transport of ['http','mcp'] as const)for(const phase of ['before-entry','entered'] as const) {
        const admitted=gate(),bodyRelease=gate(),bodyRead=gate(),entered=gate(),delegate=gate();
        releases.push(bodyRelease.resolve,delegate.resolve);
        let credentialReads=0,invokerCalls=0;
        const credential=async():Promise<{token:string;hash:string;headers:Record<string,string>;revoke:()=>Promise<void>}>=>{
          if(transport==='http') {
            const token=randomBytes(32).toString('hex'),hash=await sha256HexText(token);
            const session=await identities.createSession({user_id:user.user_id,token_sha256:hash,
              expires_at:new Date(Date.now()+3600000).toISOString(),last_team_id:team.team_id});
            return {token,hash,headers:{cookie:buildSessionCookie(token,{secure:true,maxAgeSeconds:3600}).split(';')[0]!,'x-csrf-token':await deriveCsrfToken(token)},
              revoke:()=>identities.revokeSession(session.session_id)};
          }
          const grant=await issueMcpGrant(identities,{user_id:user.user_id,team_id:team.team_id,client_id:`native-auth-${phase}`});
          return {token:grant.token,hash:await sha256HexText(grant.token),headers:{authorization:`Bearer ${grant.token}`},
            revoke:()=>identities.revokeMcpGrant(grant.grant.grant_id)};
        };
        const presented=await credential();
        const revokePresented=async()=>{
          if(cause==='direct')return presented.revoke();
          // Keep both original credential kinds live at the recovery boundary.
          // The actual recovery command, not individual revocation, kills both.
          const companionToken=randomBytes(32).toString('hex'),companionHash=await sha256HexText(companionToken);
          await identities.createSession({user_id:user.user_id,token_sha256:companionHash,
            expires_at:new Date(Date.now()+3600000).toISOString(),last_team_id:team.team_id});
          const companionGrant=await issueMcpGrant(identities,{user_id:user.user_id,team_id:team.team_id,client_id:`recovery-${transport}-${phase}`});
          const companionGrantHash=await sha256HexText(companionGrant.token);
          assert.equal((await identities.findSessionByTokenHash(companionHash))!.revoked_at,null);
          assert.equal((await identities.findMcpGrantByTokenHash(companionGrantHash))!.revoked_at,null);
          const mail:Array<{to:string;subject:string;body:string}>=[];
          await requestRecovery(identities,{async sendMail(to,subject,body){mail.push({to,subject,body});}},
            {email:user.email},{recoveryBaseUrl:'https://native-auth.example/recover'});
          assert.equal(mail.length,1);assert.equal(mail[0]!.to,user.email);assert.equal(mail[0]!.subject,'Recover your account');
          const link=mail[0]!.body.split('\n').find(line=>line.startsWith('https://native-auth.example/recover?'));assert.ok(link);
          const proof=new URL(link).searchParams.get('token');assert.ok(proof);
          const proofHash=await sha256HexText(proof),token=await identities.findEmailTokenByHash(proofHash);
          assert.ok(token);assert.equal(token.user_id,user.user_id);assert.equal(token.purpose,'recover_account');assert.equal(token.consumed_at,null);
          const beforeRecovery=await snapshot(db),originalUser=await identities.findUserById(user.user_id);assert.ok(originalUser);
          const password=`Recovered ${transport} ${phase} password`;
          assert.equal(typeof identities.recoverAccountWithToken,'function','the installed D1 producer must own atomic recovery');
          assert.deepEqual(await recoverAccount(identities,{token:proof,new_password:password}),{user_id:user.user_id});
          const recoveredUser=await identities.findUserById(user.user_id);assert.ok(recoveredUser);
          assert.notEqual(recoveredUser.password_hash,originalUser.password_hash);
          assert.equal(await verifyPassword(password,recoveredUser.password_hash),true);
          assert.notEqual((await identities.findEmailTokenByHash(proofHash))!.consumed_at,null);
          const original=transport==='http'?await identities.findSessionByTokenHash(presented.hash):await identities.findMcpGrantByTokenHash(presented.hash);
          assert.ok(original);assert.notEqual(original.revoked_at,null);
          assert.notEqual((await identities.findSessionByTokenHash(companionHash))!.revoked_at,null);
          assert.notEqual((await identities.findMcpGrantByTokenHash(companionGrantHash))!.revoked_at,null);
          const recovered=await snapshot(db);
          for(const table of ['identity_sessions','identity_mcp_grants']) {
            const rows=recovered[table]!.filter(row=>row.user_id===user.user_id);assert.ok(rows.length>0);
            assert.ok(rows.every(row=>row.revoked_at!==null),`recovery kills every original ${table}`);
          }
          assert.ok(recovered.identity_email_tokens!.filter(row=>row.user_id===user.user_id&&row.purpose==='recover_account')
            .every(row=>row.consumed_at!==null),'recovery consumes the live proof and outstanding account recovery proofs');
          const recoveryTables=new Set(['identity_users','identity_sessions','identity_mcp_grants','identity_email_tokens']);
          for(const table of Object.keys(beforeRecovery)) {
            if(recoveryTables.has(table)) {
              assert.deepEqual(recovered[table]!.filter(row=>row.user_id!==user.user_id),beforeRecovery[table]!.filter(row=>row.user_id!==user.user_id),`recovery preserves other account ${table}`);
            } else assert.deepEqual(recovered[table],beforeRecovery[table],`recovery preserves ${table}`);
          }
          assert.ok(other);
        };
        const observedIdentity=new Proxy(identities,{get(target,key,receiver){
          if(key==='findSessionByTokenHash')return async(hash:string)=>{
            const row=await target.findSessionByTokenHash(hash);
            if(transport==='http'&&hash===presented.hash){credentialReads++;if(row!==null&&row.revoked_at===null)admitted.resolve();}
            return row;
          };
          if(key==='findMcpGrantByTokenHash')return async(hash:string)=>{
            const row=await target.findMcpGrantByTokenHash(hash);
            if(transport==='mcp'&&hash===presented.hash){credentialReads++;if(row!==null&&row.revoked_at===null)admitted.resolve();}
            return row;
          };
          const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
        }});
        const mounted=await assembleWorker(artifact,asm,{...production,identityStore:observedIdentity,
          http:{derivedInputs,createPageHandler:deps=>req=>handlePageRequest({...deps,identity:{store:observedIdentity}},req),
            createOperationHandler:Object.assign((deps:AssemblyHttpDeps)=>{
              const realInvoker=deps.invoker;
              return (req:Request,op:string)=>handleOperationRequest({...deps,identity:{...deps.identity,store:observedIdentity},
                invoker:{...realInvoker,invokeMutation:async(envelope,identity)=>{
                  invokerCalls++;entered.resolve();if(phase==='entered')await delegate.promise;
                  return realInvoker.invokeMutation(envelope,identity);
                }}},req,op);
            },{inputChoicesVersion:INPUT_CHOICES_VERSION})},
          mcp:{derivedInputs,permissions:createMemberMcpPermissions(artifact),createHandler:deps=>{
            const realInvoker=deps.invoker;
            return createMcpHandler({...deps,identity:{...deps.identity,store:observedIdentity},invoker:{...realInvoker,
              invokeMutation:async(envelope,identity)=>{
                invokerCalls++;entered.resolve();if(phase==='entered')await delegate.promise;
                return realInvoker.invokeMutation(envelope,identity);
              }}});
          }}},verdict);
        const operationId=asOperationId(uuidv7(Date.now(),++sequence)),inputs={name:`${transport}-${phase}`};
        const payload=transport==='http'?{operation_id:operationId,inputs}:
          {jsonrpc:'2.0',id:sequence,method:'tools/call',params:{name:operation,arguments:{operation_id:operationId,...inputs}}};
        const bytes=new TextEncoder().encode(JSON.stringify(payload));
        let supplied=false;
        const body=new ReadableStream<Uint8Array>({async pull(controller){
          if(supplied)return;supplied=true;await bodyRelease.promise;controller.enqueue(bytes);controller.close();
        }});
        const path=transport==='http'?`/api/operations/${operation}`:'/mcp';
        const init:RequestInit&{duplex:'half'}={method:'POST',duplex:'half',body,headers:{...presented.headers,
          'content-type':'application/json',accept:'application/json, text/event-stream'}};
        const request=new Request(`https://native-auth.example${path}`,init);
        const stream=request.body;assert.ok(stream);const getReader=stream.getReader;
        // Observe the defining HTTP/SDK capped-body reader, not stream prefetch.
        // The actual native reader and original receiver still consume every byte.
        Object.defineProperty(stream,'getReader',{value:function(...args:Parameters<typeof getReader>){
          bodyRead.resolve();return Reflect.apply(getReader,stream,args);
        }});
        const pending=mounted.fetch(request);
        await admitted.promise;await bodyRead.promise;
        assert.equal(invokerCalls,0,'genuine credential admission precedes invoker entry');
        if(phase==='before-entry') {
          await revokePresented();const afterRevocation=await snapshot(db);bodyRelease.resolve();
          const response=await pending;const json=object(await response.json());
          if(transport==='http'){assert.equal(response.status,403);assert.equal(json.code,'forbidden');assert.equal(json.message,'Session expired or revoked.');}
          else {assert.equal(response.status,200);const result=object(json.result);assert.equal(result.isError,true);const error=object(result.structuredContent);assert.equal(error.code,'forbidden');assert.equal(error.message,'Session expired or revoked.');}
          assert.ok(credentialReads>=2,'actual credential facts are read again before delegation');
          assert.equal(invokerCalls,0);assert.deepEqual(await snapshot(db),afterRevocation,'transport refusal changes no State/Identity resources');
        } else {
          bodyRelease.resolve();await entered.promise;assert.equal(invokerCalls,1);
          await revokePresented();const beforeDelegate=await snapshot(db),revision=await production.store.readRevision();delegate.resolve();
          const response=await pending;assert.equal(response.status,200,await response.clone().text());
          const json=object(await response.json());
          const result=transport==='http'?json:object(object(json.result).structuredContent);
          assert.equal(result.status,'committed','public operation already admitted to the real invoker finishes normally');
          assert.equal(await production.store.readRevision(),revision+1);
          const committed=await snapshot(db);assert.equal(committed.receipts!.length,beforeDelegate.receipts!.length+1);
          assert.equal(committed.history!.length,beforeDelegate.history!.length+1);assert.equal(committed.records!.length,beforeDelegate.records!.length+1);
          for(const table of Object.keys(beforeDelegate))if(!['records','receipts','history','fence','fence_log','sqlite_sequence'].includes(table))assert.deepEqual(committed[table],beforeDelegate[table],table);
          const live=await credential(),beforeReplay=await snapshot(db);
          const replayResponse=await mounted.fetch(new Request(`https://native-auth.example${path}`,{method:'POST',
            headers:{...live.headers,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify(payload)}));
          assert.equal(replayResponse.status,200,await replayResponse.clone().text());
          const replayJson=object(await replayResponse.json()),replayed=transport==='http'?replayJson:object(object(replayJson.result).structuredContent);
          assert.equal(replayed.status,'replayed');assert.deepEqual(replayed.records,result.records);assert.equal(invokerCalls,2);
          assert.deepEqual(await snapshot(db),beforeReplay,'original envelope replay adds no receipts, history, fences or rows');
        }
      }
      assert.equal(JSON.stringify(artifact),originalArtifact);assert.equal(await captureIsCurrent(capture),true);
    } finally {for(const release of releases)release();try {await mf?.dispose();} finally {await rm(dir,{recursive:true,force:true});}}
}

test('native public CRUD refuses dead HTTP/MCP credentials before entry and preserves actually entered canonical work',
  {timeout:120000},()=>runAdmissionTiming('direct'));

test('native recovery cause refuses dead HTTP/MCP credentials before entry and preserves actually entered canonical work',
  {timeout:120000},()=>runAdmissionTiming('recovery'));
