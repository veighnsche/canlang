import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker } from '@canlang/cloudflare/worker/assembly';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { resolveIdentity, sha256HexText } from '@canlang/identity';

const artifact = JSON.parse(await readFile(new URL('./guard.compile.json',import.meta.url),'utf8'));
const asm = await assembleModules({artifact,sourcePath:fileURLToPath(new URL('./guard.can',import.meta.url))}, {
  workDir:fileURLToPath(new URL('./canonical-modules/',import.meta.url)),
  stdlibUrl:import.meta.resolve('@canlang/stdlib'),
});
const now = Date.now();
const clock = createFrozenClock(now);
const identityStore = createMemoryIdentityStore({clock});
const team = await identityStore.createTeam({});
const user = await identityStore.createUser({email:'guard-export@test.invalid',password_hash:'x',email_verified:true});
await identityStore.createMembership({team_id:team.team_id,user_id:user.user_id,is_owner:false,roles:[]});
const token='guard-export-probe-session';
await identityStore.createSession({user_id:user.user_id,token_sha256:await sha256HexText(token),expires_at:new Date(now+3600000).toISOString(),last_team_id:team.team_id});
const identity=await resolveIdentity(identityStore,{session_token:token},{clock});
const anonymous=await resolveIdentity(identityStore,{}, {clock});
const {store}=createTestMemoryStorage();
const invoker=buildInvoker(artifact,asm,store,{memberships:identityStore,now:()=>now});
const rows=[];
for(const [name,actor] of [['member',identity],['anonymous',anonymous]]) {
  try { rows.push({name,outcome:await invoker.invokeRead({operation:'Guard.echo',inputs:{value:'HELLO'}},actor)}); }
  catch(error) { rows.push({name,error:error.stack}); }
}
const mutationArtifact=JSON.parse(await readFile(new URL('./mutation-guard.compile.json',import.meta.url),'utf8'));
const mutationAsm=await assembleModules({artifact:mutationArtifact,sourcePath:fileURLToPath(new URL('./mutation-guard.can',import.meta.url))}, {
  workDir:fileURLToPath(new URL('./mutation-canonical-modules/',import.meta.url)),
  stdlibUrl:import.meta.resolve('@canlang/stdlib'),
});
const mutationInvoker=buildInvoker(mutationArtifact,mutationAsm,store,{memberships:identityStore,now:()=>now});
const mutationRows=[];
for(const [name,actor,flag] of [['member allow',identity,true],['member guard reject',identity,false],['anonymous admission reject',anonymous,true]]) {
  const time=now.toString(16).padStart(12,'0');
  const rand=randomBytes(10).toString('hex');
  const operationId=`${time.slice(0,8)}-${time.slice(8)}-7${rand.slice(0,3)}-8${rand.slice(4,7)}-${rand.slice(7,19)}`;
  const envelope={operation:'Guard.gate',operation_id:operationId,inputs:{flag}};
  const outcome=await mutationInvoker.invokeMutation(envelope,actor);
  const replay=await mutationInvoker.invokeMutation(envelope,actor);
  mutationRows.push({name,outcome,replay});
}
const receipts={
  moduleOwner:'Actual assembleModules -> actual buildInvoker canonical seam; original compiler artifact supplied unchanged; stdlib resolves through supported public package.',
  qualification:'Identity and storage use package test memory implementations; no durable storage or production identity deployment claim. Outcomes report the actual seam, including any unsupported read-scenario boundary.',
  rows,
  mutationRows,
};
await writeFile(new URL('./canonical-receipts.json',import.meta.url),JSON.stringify(receipts,null,2)+'\n');
console.log(JSON.stringify(receipts,null,2));
assert.equal(mutationRows[0].outcome.result?.status,'committed');
assert.equal(mutationRows[0].replay.result?.status,'replayed');
assert.equal(mutationRows[1].outcome.error?.code,'rule_failed');
assert.equal(mutationRows[1].outcome.error?.message,'forbidden');
assert.deepEqual(mutationRows[1].replay,mutationRows[1].outcome);
assert.equal(mutationRows[2].outcome.error?.code,'forbidden');
assert.deepEqual(mutationRows[2].replay,mutationRows[2].outcome);
