/** Original Office/Warehouse conditional unique through installed Identity/D1.
 * Only the labelled members CRUD setup is test-authored; stripping it restores
 * the exact original source. This is distinct from Office G3 agent trials.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { compileFunction, constants as vmConstants } from 'node:vm';
import { test } from 'vitest';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { ModelName, MutationEnvelope, OperationId, OperationName, ProjectedRecord, ReceiptIdentity } from '@canlang/contracts';
import type { ModelTable } from '@canlang/state/mutation';
import type { MutationOutcome } from '../src/worker/assembly.js';

const root=resolve(fileURLToPath(new URL('../../../',import.meta.url)));
const original=join(root,'packages/cloudflare/test/fixtures/conditional-unique-original-office.can');
const ORIGINAL_SHA256='4016c602d0028d1e91ea8ce96b02ec5e57a9e0b9f05cd22fd6739d95e4e777e5';
const SETUP='  ## BEGIN TEST-AUTHORED SETUP: authenticated Office Item CRUD\n' +
  '  crud Item by=members fields=qty,title,closed\n' +
  '  ## END TEST-AUTHORED SETUP\n';
const APP='Office', ITEM='Office.Item' as ModelName, WAREHOUSE='Warehouse.Item' as ModelName;
const require=createRequire(import.meta.url);
const nodeImport=compileFunction('return import(url)',['url'],{importModuleDynamically:vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
const installed=(path:string)=>pathToFileURL(join(root,'packages/cloudflare/dist',path)).href;
const producer=(name:string)=>pathToFileURL(require.resolve(name)).href;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function committed(value:MutationOutcome,status:'committed'|'replayed'='committed') {
  assert.ok('result' in value,JSON.stringify(value));assert.equal(value.result.status,status);return value.result;
}
async function snapshot(db:D1Database) {
  const names=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{name:string}>();
  assert.equal(names.success,true);const result:Record<string,Record<string,unknown>[]>={};
  for(const {name} of names.results) {
    const rows=await db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all<Record<string,unknown>>();
    assert.equal(rows.success,true);result[name]=rows.results.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}

test('original Office conditional key commits inactive duplicates and refuses active duplicate under native D1',
  {timeout:180000},async()=>{
    const dir=await mkdtemp(join(tmpdir(),'can-native-original-unique-'));
    let worker:Miniflare|undefined;
    try {
      const source=await readFile(original,'utf8');assert.equal(hash(Buffer.from(source)),ORIGINAL_SHA256);
      assert.equal(source.split(' When\n Then\n').length,3);
      const appSource=source.replace(' When\n Then\n',` When\n${SETUP} Then\n`);
      assert.equal(appSource.replace(SETUP,''),source);
      const fixture=join(dir,'original-unique-with-labelled-setup.can');await writeFile(fixture,appSource);
      const {assembleModules}=await nodeImport(installed('runtime/modules.js')) as typeof import('../src/runtime/modules.js');
      const {buildInvoker,createTeamOwnerStorageBoundary}=await nodeImport(installed('worker/assembly.js')) as typeof import('../src/worker/assembly.js');
      const {loadCanonicalDescriptors}=await nodeImport(installed('runtime/invoke.js')) as typeof import('../src/runtime/invoke.js');
      const {distribution}=await nodeImport(producer('@canlang/values/distribution')) as typeof import('@canlang/values/distribution');
      const {createD1IdentityStore,ensureIdentitySchema,issueMcpGrant,resolveIdentity}=await nodeImport(producer('@canlang/identity')) as typeof import('@canlang/identity');
      const {ensureSchema}=await nodeImport(producer('@canlang/state/storage/d1')) as typeof import('@canlang/state/storage/d1');
      const {createD1OwnerRouter}=await nodeImport(producer('@canlang/state/storage/owner-router')) as typeof import('@canlang/state/storage/owner-router');
      const {hashInputs}=await nodeImport(producer('@canlang/state/invocation/replay')) as typeof import('@canlang/state/invocation/replay');
      const {uuidv7}=await nodeImport(producer('@canlang/state/testing/invocation/fixtures')) as typeof import('@canlang/state/testing/invocation/fixtures');
      const compiler=join(root,'compiler/target/debug/can'),catalog=fileURLToPath(distribution.catalog);
      const originals=await Promise.all([compiler,catalog].map(async path=>hash(await readFile(path))));
      const env={...process.env};delete env.CAN_CATALOG;
      const {stdout}=await promisify(execFile)(compiler,['compile','--format=json','--native-scenario-receipts','--catalog',catalog,fixture],
        {cwd:root,env,timeout:60000,maxBuffer:32*1024*1024});
      const artifact=JSON.parse(stdout) as import('@canlang/contracts').CompileArtifact;
      assert.equal(artifact.sources.find(entry=>resolve(entry.path)===fixture)?.sha256,hash(Buffer.from(appSource)));
      assert.equal(artifact.models?.filter(model=>model.name===ITEM).length,1);
      assert.equal(artifact.models?.filter(model=>model.name===WAREHOUSE).length,1);
      const asm=await assembleModules({artifact,sourcePath:fixture},{workDir:join(dir,'modules'),stdlibUrl:installed('runtime/stdlib.js')});
      const loaded=await loadCanonicalDescriptors(asm,artifact);
      const table=loaded.table as ModelTable;
      assert.deepEqual(table.get(ITEM)?.uniqueWhen?.qty,{op:'eq',field:'closed',value:true});
      assert.equal(table.get(WAREHOUSE)?.uniqueWhen?.qty,undefined);
      worker=new Miniflare({compatibilityDate:'2026-07-15',modules:true,script:'export default {fetch(){return new Response("ok")}}',
        d1Persist:join(dir,'d1'),d1Databases:{IDENTITY:'conditional-identity',OWNER:'conditional-owner',FOREIGN:'conditional-foreign'}});
      const identityDb=await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const db=await worker.getD1Database('OWNER') as unknown as D1Database;
      const foreignDb=await worker.getD1Database('FOREIGN') as unknown as D1Database;
      await ensureIdentitySchema(identityDb);await ensureSchema(db);await ensureSchema(foreignDb);
      const now=Date.parse('2026-10-12T16:00:00Z'),clock={nowMs:()=>now};let sequence=0;
      const identities=createD1IdentityStore(identityDb,{clock});const team=await identities.createTeam({timezone:'UTC'});
      const user=await identities.createUser({email:'original-unique@example.test',password_hash:'unused',email_verified:true});
      const membership=await identities.createMembership({team_id:team.team_id,user_id:user.user_id,is_owner:false,roles:[]});
      const grant=await issueMcpGrant(identities,{team_id:team.team_id,user_id:user.user_id,client_id:'original-unique'},{clock});
      const identity=await resolveIdentity(identities,{mcp_grant_token:grant.token},{clock});
      const foreignTeam=await identities.createTeam({timezone:'UTC'});
      const foreignUser=await identities.createUser({email:'foreign-unique@example.test',password_hash:'unused',email_verified:true});
      await identities.createMembership({team_id:foreignTeam.team_id,user_id:foreignUser.user_id,is_owner:false,roles:[]});
      const foreignGrant=await issueMcpGrant(identities,{team_id:foreignTeam.team_id,user_id:foreignUser.user_id,client_id:'foreign-unique'},{clock});
      const foreignIdentity=await resolveIdentity(identities,{mcp_grant_token:foreignGrant.token},{clock});
      const boundary=await createTeamOwnerStorageBoundary({artifact,asm,app:APP,identities,
        router:createD1OwnerRouter({resolveBinding:scope=>scope.app===APP&&[team.team_id,foreignTeam.team_id].includes(scope.owner)
          ? {...scope,db:scope.owner===team.team_id?db:foreignDb,initializeFresh:true}:null})});
      const store=await boundary.forIdentity(identity),foreignStore=await boundary.forIdentity(foreignIdentity);
      const invoker=buildInvoker(artifact,asm,store,{appId:APP,memberships:identities,source:'http',now:clock.nowMs,ownerStorage:boundary});
      const envelope=(title:string,closed:boolean):MutationEnvelope=>({operation:`${ITEM}.create`,operation_id:uuidv7(now,++sequence),
        inputs:{qty:'7',title,closed}});
      const receiptId=(input:MutationEnvelope):ReceiptIdentity=>({app:APP,owner:team.team_id,principal:user.user_id,
        operation:input.operation as OperationName,operationId:input.operation_id as OperationId});
      const create=async(title:string,closed:boolean)=>{
        const input=envelope(title,closed),revision=await store.readRevision();
        const result=committed(await invoker.invokeMutation(input,identity));assert.equal(await store.readRevision(),revision+1);
        const record=result.records?.[0] as ProjectedRecord|undefined;assert.ok(record);
        const row=await store.load(ITEM,record.id);assert.ok(row);assert.equal(row.version,1);
        assert.equal(row.data.qty,'7');assert.equal(row.data.closed,closed);assert.equal(row.data.title,title);
        const receipt=await store.readReceipt(receiptId(input));assert.ok(receipt);
        assert.equal(receipt.outcome.status,'committed');assert.equal(receipt.inputHash,await hashInputs(input.inputs));
        assert.equal(receipt.committedRevision,revision+1);
        assert.equal((await store.historyFor(ITEM,row.id)).length,1);
        return {input,row,result:result.result};
      };
      const inactiveA=await create('inactive-a',false),inactiveB=await create('inactive-b',false);
      const active=await create('active-a',true);
      const before=await snapshot(db),beforeIdentity=await snapshot(identityDb),revision=await store.readRevision();
      const duplicate=envelope('active-b',true),refused=await invoker.invokeMutation(duplicate,identity);
      assert.ok('error' in refused,JSON.stringify(refused));assert.equal(refused.error.code,'conflict');
      assert.equal(await store.readReceipt(receiptId(duplicate)),null,'commit-time unique conflict writes no receipt');
      const after=await snapshot(db),afterIdentity=await snapshot(identityDb);
      assert.deepEqual(afterIdentity,beforeIdentity);assert.equal((await store.query({model:ITEM,authority:'owner'})).length,3);
      assert.deepEqual(await store.load(ITEM,inactiveA.row.id),inactiveA.row);
      assert.deepEqual(await store.load(ITEM,inactiveB.row.id),inactiveB.row);
      assert.deepEqual(await store.load(ITEM,active.row.id),active.row);
      assert.deepEqual(after,before,'commit-time unique conflict changes no owner resource');
      assert.equal(await store.readRevision(),revision);
      const retry=await invoker.invokeMutation(duplicate,identity);assert.ok('error' in retry);assert.deepEqual(await snapshot(db),after);
      const replay=committed(await invoker.invokeRetainedMutation(active.input,identity),'replayed');
      assert.deepEqual(replay.result,active.result);assert.deepEqual(await snapshot(db),after);
      const foreignInput=envelope('foreign-active',true),foreignBefore=await snapshot(foreignDb);
      const foreignResult=committed(await invoker.invokeMutation(foreignInput,foreignIdentity));
      assert.equal(foreignResult.status,'committed');
      const foreignRows=await foreignStore.query({model:ITEM,authority:'owner'});
      assert.equal(foreignRows.length,1);assert.equal(foreignRows[0]!.data.qty,'7');assert.equal(foreignRows[0]!.data.closed,true);
      assert.notDeepEqual(await snapshot(foreignDb),foreignBefore);assert.deepEqual(await snapshot(db),after);
      const foreignCommitted=await snapshot(foreignDb);
      assert.equal(committed(await invoker.invokeRetainedMutation(foreignInput,foreignIdentity),'replayed').status,'replayed');
      assert.deepEqual(await snapshot(foreignDb),foreignCommitted);assert.deepEqual(await snapshot(db),after);
      await identities.removeMembership(membership.membership_id);
      const revoked=await snapshot(db),denied=await invoker.invokeMutation(envelope('withdrawn',false),identity);
      assert.ok('error' in denied);assert.deepEqual(await snapshot(db),revoked);
      await identities.reactivateMembership(membership.membership_id,{is_owner:false,roles:[]});
      const restored=await resolveIdentity(identities,{mcp_grant_token:grant.token},{clock});
      assert.equal(committed(await invoker.invokeRetainedMutation(active.input,restored),'replayed').status,'replayed');
      assert.deepEqual(await snapshot(db),revoked);
      assert.equal(hash(Buffer.from(await readFile(original))),ORIGINAL_SHA256);
      assert.deepEqual(await Promise.all([compiler,catalog].map(async path=>hash(await readFile(path)))),originals);
    } finally {try {await worker?.dispose();} finally {await rm(dir,{recursive:true,force:true});}}
  });
