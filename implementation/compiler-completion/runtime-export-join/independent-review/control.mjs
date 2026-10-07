import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as producer from '@canlang/state/effects/guards';
import * as facade from '@canlang/stdlib';
import * as compatibility from '@canlang/cloudflare/runtime/stdlib';
import { hasRole as policyRole } from '@canlang/state/policy/roles';
import { assembleModules } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker } from '@canlang/cloudflare/worker/assembly';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
const out = new URL('./',import.meta.url);
const inputs = new URL('../implementation/',import.meta.url);
const hash = data => createHash('sha256').update(data).digest('hex');
const pinManifest = JSON.parse(await readFile(new URL('pins.json',inputs),'utf8'));
const pinResults = [];
for (const [path,expected] of Object.entries(pinManifest.pins)) {
 const actual = hash(await readFile(path)); pinResults.push({path,expected,actual,matches:actual===expected});
}
const lease = ['packages/state/src/effects/guards.ts','packages/state/test/effects/guards.test.ts','packages/state/package.json','packages/cloudflare/src/runtime/stdlib.ts','packages/stdlib/src/index.ts','packages/stdlib/test/assembly.test.ts'];
for (const path of lease) assert.equal(pinResults.find(x=>x.path===path).matches,true,path);
for (const name of ['require','hasRole']) { assert.equal(producer[name],facade[name]); assert.equal(producer[name],compatibility[name]); }
assert.notEqual(policyRole, producer.hasRole);
assert.equal(policyRole.constructor.name,'AsyncFunction');
const patch=await readFile(new URL('changes.patch',inputs),'utf8');
const cloudPart=patch.split('--- a/packages/cloudflare/src/runtime/stdlib.ts')[1].split('--- /dev/null')[0];
const original=cloudPart.split('\n').filter(x=>x.startsWith('-')&&!x.startsWith('---')).map(x=>x.slice(1)).join('\n').replaceAll('export function','function').replace('(condition: unknown, code', '(condition, code').replace('): void {', ') {').replace('(c: HandlerContext, role: string, subject?: unknown): boolean {', '(c, role, subject) {');
const originalFunctions = new Function('unsupported', original+'\nreturn {require,hasRole};')((name,reason)=>{throw new Error(`unsupported(${name}): ${reason}`)});
const cases=[];
function observe(fn, role, subject, mode) {
 const reads=[]; const sentinel=new Error('getter sentinel');
 let times=0;
 const context={get canonical(){ reads.push('canonical');times++; if(mode==='throw')throw sentinel; if(mode==='absent')return undefined; if(mode==='second-null'&&times===2)return null; return {get builtinRoles(){reads.push('builtinRoles');return mode==='missing'?undefined:['members'];}}},get memberships(){reads.push('memberships');return ['Shop.editor','owner'];}};
 try{return {result:fn(context,role,subject),reads}}catch(e){return {error:{name:e.name,message:e.message,sentinel:e===sentinel},reads}}
}
for(const role of ['public','authenticated','members','owner','Shop.editor'])for(const mode of ['present','absent','missing','throw','second-null'])for(const subject of [undefined,null,0]) {
 const before=observe(originalFunctions.hasRole,role,subject,mode); const after=observe(producer.hasRole,role,subject,mode);assert.deepEqual(after,before);cases.push({role,mode,subject:subject===undefined?'undefined':subject,...after});
}
for(const value of [false,null,undefined,0,-0,NaN,'',1,{},[],Symbol('x')])for(const code of [undefined,'','limit',null,0]) {
 const observeRequire=fn=>{try{fn(value,code);return 'returned'}catch(e){return {name:e.name,message:e.message}}};assert.deepEqual(observeRequire(producer.require),observeRequire(originalFunctions.require));
}
const raw = await readFile(new URL('mutation-guard.compile.json',inputs));
const artifact=JSON.parse(raw);const assembled=await assembleModules({artifact,sourcePath:fileURLToPath(new URL('mutation-guard.can',inputs))},{workDir:fileURLToPath(new URL('modules/',out)),stdlibUrl:import.meta.resolve('@canlang/stdlib')});
const now=Date.now();const clock=createFrozenClock(now);const identityStore=createMemoryIdentityStore({clock});
const team=await identityStore.createTeam({});const user=await identityStore.createUser({email:'independent-guard@test.invalid',password_hash:'x',email_verified:true});
const membership=await identityStore.createMembership({team_id:team.team_id,user_id:user.user_id,is_owner:false,roles:[]});
const token='independent-guard-session';await identityStore.createSession({user_id:user.user_id,token_sha256:await sha256HexText(token),expires_at:new Date(now+3600000).toISOString(),last_team_id:team.team_id});
const held=await resolveIdentity(identityStore,{session_token:token},{clock});
const {store}=createTestMemoryStorage();const invoker=buildInvoker(artifact,assembled,store,{memberships:identityStore,now:()=>now});
function opId(){const t=now.toString(16).padStart(12,'0');const r=randomUUID();return `${t.slice(0,8)}-${t.slice(8)}-7${r.slice(15,18)}-8${r.slice(20,23)}-${r.slice(24)}`}
const envelope=()=>({operation:'Guard.gate',operation_id:opId(),inputs:{flag:true}});
const first=envelope();const admitted=await invoker.invokeMutation(first,held);assert.equal(admitted.result?.status,'committed');
await identityStore.removeMembership(membership.membership_id);
const removed=envelope();const denied=await invoker.invokeMutation(removed,held);assert.equal(denied.error?.code,'forbidden');
const deniedReplay=await invoker.invokeMutation(removed,held);assert.deepEqual(deniedReplay,denied);
await identityStore.reactivateMembership(membership.membership_id,{is_owner:false,roles:[]});
const restored=await invoker.invokeMutation(envelope(),held);assert.equal(restored.result?.status,'committed');
const historicalDenial=await invoker.invokeMutation(removed,held);assert.equal(historicalDenial.result?.status,'committed');
assert.equal(hash(await readFile(new URL('mutation-guard.compile.json',inputs))),hash(raw));
const receipt={qualification:'Real public exports and actual assembleModules/buildInvoker; identity resolver and live membership reader with package memory stores. No durable or production deployment claim. Local getter matrices are behavior equivalence only.',publicUrls:{producer:import.meta.resolve('@canlang/state/effects/guards'),facade:import.meta.resolve('@canlang/stdlib'),compatibility:import.meta.resolve('@canlang/cloudflare/runtime/stdlib')},sourcePins:pinResults,originalBodyComparison:{roleCases:cases,requireCases:55,publicFunctionIdentity:true,asyncPolicyRouteSeparate:true},canonical:{artifactSha256:hash(raw),admitted,denied,deniedReplay,restored,historicalDenial},unchangedArtifact:true};
await writeFile(new URL('receipt.json',out),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({status:'passed',roleCases:cases.length,requireCases:55,sourcePinMismatches:pinResults.filter(x=>!x.matches).map(x=>x.path),canonical:receipt.canonical},null,2));
