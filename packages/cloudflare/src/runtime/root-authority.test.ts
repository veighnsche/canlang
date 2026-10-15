import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { CompileArtifact, ModelName, RecordId, RecordVersion } from '@canlang/contracts';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1IdentityStore, ensureIdentitySchema, sha256HexText } from '@canlang/identity';
import { createRootRecordAllocator, resolveRootAuthority, rootIdOfRecord, rejectRootModelsInD1 } from './root-authority.js';
import { createD1Storage, ensureSchema } from '@canlang/state/storage/d1';
import { createD1RootDirectory, browseRootAuthorities } from './root-authority-directory.js';

// Component metadata matches the compiler ABI. The parent integration separately
// supplies actual compiled source and the canonical main/allocator composition.
const artifact = {
  artifact_version: 1, language_version: '1.0', tool_version: 'component', sources: [], tests: [], modules: [], callables: [], pages: [], requires: [],
  runtimeBindings: [{ owner: 'CalendarDemo', name: 'Schedule', kind: 'durable-object', binding: 'CalendarDemo.Schedule', key: 'CalendarDemo.Calendar' }],
  models: [
    { name: 'CalendarDemo.Calendar', fields: [], deleteMode: 'archive' },
    { name: 'CalendarDemo.Booking', parent: 'CalendarDemo.Calendar', fields: [], deleteMode: 'archive' },
  ], operations: [
    { name: 'CalendarDemo.Calendar.create', kind: 'create', description: '', inputs: { fields: [{ name: 'name', field: { kind: 'string' }, required: true }] } },
    { name: 'CalendarDemo.Calendar.read', kind: 'read', description: '', inputs: { fields: [] } },
    { name: 'CalendarDemo.Booking.create', kind: 'create', description: '', inputs: { fields: [{ name: 'parent', field: { kind: 'ref', model: 'CalendarDemo.Calendar' }, required: true }] } },
    { name: 'CalendarDemo.Booking.update', kind: 'update', description: '', inputs: { fields: [
      { name: 'record', field: { kind: 'ref', model: 'CalendarDemo.Booking' as ModelName, requireVersion: true }, required: true },
      { name: 'other', field: { kind: 'ref', model: 'CalendarDemo.Calendar' }, required: false },
    ] } },
  ],
} as CompileArtifact;

test('root routing derives complete identity and directly locates children without an index', async () => {
  const invocation = { operation: 'CalendarDemo.Calendar.create', operation_id: '019c0000-0000-7000-8000-000000000001', inputs: { name: 'A' } };
  const identity = { app: 'CalendarDemo', owner: 'team-a', principal: 'user-a' };
  const first = await resolveRootAuthority(artifact, invocation, identity); assert.ok(first && !('browse' in first));
  assert.deepEqual(await resolveRootAuthority(artifact, invocation, identity), first);
  assert.notEqual((await resolveRootAuthority(artifact, invocation, { ...identity, owner: 'team-b' }) as typeof first).rootId, first.rootId);
  assert.notEqual((await resolveRootAuthority(artifact, invocation, { ...identity, principal: 'user-b' }) as typeof first).rootId, first.rootId);
  const root = (await createRootRecordAllocator(artifact, first, invocation))('CalendarDemo.Calendar'); assert.equal(root, first.rootId);
  const childInvocation = { operation: 'CalendarDemo.Booking.create', operation_id: '019c0000-0000-7000-8000-000000000002', inputs: { parent: { id: root } } };
  const childScope = await resolveRootAuthority(artifact, childInvocation, identity); assert.ok(childScope && !('browse' in childScope));
  const child = (await createRootRecordAllocator(artifact, childScope, childInvocation))('CalendarDemo.Booking');
  assert.equal(rootIdOfRecord(child), root); assert.ok(child.length < 200);
  const second = await resolveRootAuthority(artifact, { ...invocation, operation_id: '019c0000-0000-7000-8000-000000000003' }, identity); assert.ok(second && !('browse' in second));
  await assert.rejects(resolveRootAuthority(artifact, { operation: 'CalendarDemo.Booking.update', operation_id: invocation.operation_id,
    inputs: { record: { id: child, version: '1' }, other: { id: second.rootId } } }, identity), /cross root/);
});

test('real SQLite root actors keep records, replay, ownership and eventual discovery isolated across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-root-authority-'));
  const module = resolve('packages/cloudflare/src/runtime/root-authority.ts');
  const directoryModule = resolve('packages/cloudflare/src/runtime/root-authority-directory.ts');
  const source = `
    import {createRootAuthorityClass,rootExecutionForEnv,resolveRootAuthority,rootAuthorityRequest} from ${JSON.stringify(module)};
    import {createD1RootDirectory} from ${JSON.stringify(directoryModule)};
    import {createD1IdentityStore,resolveIdentity} from '@canlang/identity';
    const artifact=${JSON.stringify(artifact)};
    const invocation=async request=>request.clone().json();
    const authenticate=async(request,env)=>{
      const token=request.headers.get('authorization')?.replace(/^Bearer /,'');
      const actual=await resolveIdentity(createD1IdentityStore(env.DB),{session_token:token});
      if(!actual.actor||!actual.team||actual.membership?.status!=='active')throw Error('Authenticated active team required.');
      return {app:'CalendarDemo',owner:actual.team.team_id,principal:actual.actor.user_id};
    };
    export const CanRootAuthority=createRootAuthorityClass({artifact,invocation,authenticate,
      directory:env=>{const actual=createD1RootDirectory(env.DB);return {...actual,publish:entry=>env.INDEX_OFF?Promise.reject(Error('Index offline')):actual.publish(entry)}} ,
      async execute(request,env){
        const selected=rootExecutionForEnv(env);if(!selected)throw Error('Missing genuine actor composition.');
        const call=await invocation(request),store=selected.store,scope=selected.scope;
        const again=await authenticate(request,env);await selected.assertInvocation(call,again);if(again.owner!==scope.owner||again.principal!==scope.principal)throw Error('Identity changed.');
        if(call.operation.endsWith('.read'))return Response.json(await store.query({model:scope.model,authority:'owner'}));
        const receiptIdentity={app:scope.app,owner:scope.owner,principal:scope.principal,operation:call.operation,operationId:call.operation_id};
        const saved=await store.readReceipt(receiptIdentity),inputHash=JSON.stringify(call.inputs);
        if(saved){if(saved.inputHash!==inputHash)throw Error('Replay input conflict');return Response.json(saved.outcome.result)}
        const revision=await store.readRevision();let model,id,parent=null,write;
        if(call.operation==='CalendarDemo.Calendar.create')model='CalendarDemo.Calendar';
        else model='CalendarDemo.Booking';
        if(call.operation.endsWith('.create')){
          id=selected.allocateId(model);parent=call.inputs.parent?{model:'CalendarDemo.Calendar',id:call.inputs.parent.id}:null;
          if(parent&&!await store.load(parent.model,parent.id))throw Error('Parent missing');
          const row={id,version:1,created:Date.now(),updated:Date.now(),createdBy:scope.principal,updatedBy:scope.principal,archivedAt:null,parent,data:{name:call.inputs.name??'booking'}};
          write={kind:'insert',model,row};
        }else{
          id=call.inputs.record.id;const old=await store.load(model,id);if(!old)throw Error('Record missing');
          if(String(old.version)!==call.inputs.record.version)throw Error('Version conflict');
          write={kind:'update',model,id,expectedVersion:old.version,row:{...old,version:old.version+1,data:{name:call.inputs.name}}};
        }
        const result={id,version:String(write.row.version)};
        await store.commit({expectedRevision:revision,writes:[write],history:[],receipt:{identity:receiptIdentity,inputHash,resolvedDefaults:{},outcome:{status:'committed',result,recordVersions:[]},committedRevision:revision+1,createdAt:Date.now()},outbox:[],schedules:[],uniqueClaims:[],uniqueReleases:[]});
        return Response.json(result);
      }});
    export default {async fetch(request,env){try{
      const call=await invocation(request),auth=await authenticate(request,env),route=await resolveRootAuthority(artifact,call,auth);
      if(!route)throw Error('No D1 fallback');
      const hint=request.headers.get('x-root-locator');const rootId='browse' in route?hint:route.rootId;
      if(!rootId)throw Error('Directory browsing needs a selected root locator');
      const target=env[route.binding].get(env[route.binding].idFromName(rootId));
      return await target.fetch(rootAuthorityRequest(request,{binding:route.binding,rootId}));
    }catch(error){return Response.json({error:error.message},{status:403})}}};
  `;
  const bundled = await build({ stdin: { contents: source, resolveDir: resolve('packages/cloudflare'), sourcefile: 'root-authority-component.js' },
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022', write: false, legalComments: 'none' });
  const code = bundled.outputFiles[0]!.text;
  const options = (indexOff: boolean) => ({ compatibilityDate: '2026-07-15', modules: true as const, script: code,
    bindings: { INDEX_OFF: indexOff }, d1Databases: { DB: 'identity-index' }, d1Persist: join(directory, 'd1'),
    durableObjects: { 'CalendarDemo.Schedule': { className: 'CanRootAuthority', useSQLite: true } }, durableObjectsPersist: join(directory, 'do') });
  let mf = new Miniflare(options(true));
  try {
    const db = await mf.getD1Database('DB') as unknown as D1Database; await ensureIdentitySchema(db);
    const identities = createD1IdentityStore(db);
    const team = await identities.createTeam({}), otherTeam = await identities.createTeam({});
    const user = await identities.createUser({ email: 'root@example.test', password_hash: 'unused', email_verified: true });
    const other = await identities.createUser({ email: 'other@example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: true, roles: [] });
    await identities.createMembership({ team_id: otherTeam.team_id, user_id: other.user_id, is_owner: true, roles: [] });
    for (const [token,actor,owner] of [['first',user,team],['other',other,otherTeam]] as const) await identities.createSession({ user_id: actor.user_id,
      token_sha256: await sha256HexText(token), expires_at: new Date(Date.now()+3600000).toISOString(), last_team_id: owner.team_id });
    let sequence = 0;
    const mutate = (operation: string, inputs: Record<string, unknown>, operation_id = `component-op-${++sequence}`, token = 'first') =>
      mf.dispatchFetch('http://app.test/invoke', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ operation, operation_id, inputs }) });
    const create = 'CalendarDemo.Calendar.create', op = 'same-operation';
    let response = await mutate(create, { name: 'One' }, op); assert.equal(response.status, 200);
    const first = await response.json() as { id: string; version: string };
    assert.deepEqual(await (await mutate(create, { name: 'One' }, op)).json(), first);
    assert.equal((await mutate(create, { name: 'Changed' }, op)).status, 403);
    const second = await (await mutate(create, { name: 'Two' })).json() as { id: string };
    assert.notEqual(first.id, second.id);
    const child = await (await mutate('CalendarDemo.Booking.create', { parent: { id: first.id }, name: 'Booking' })).json() as { id: string; version: string };
    assert.equal(rootIdOfRecord(child.id), first.id);
    const changed = await mutate('CalendarDemo.Booking.update', { record: child, name: 'Updated' }); assert.equal(changed.status, 200);
    assert.equal((await mutate('CalendarDemo.Booking.update', { record: { id: child.id, version: '2' }, other: { id: second.id }, name: 'Cross' })).status, 403);
    assert.equal((await mutate('CalendarDemo.Booking.update', { record: { id: child.id, version: '2' }, name: 'Foreign' }, 'foreign', 'other')).status, 403);
    const read = async (rootId: string) => mf.dispatchFetch('http://app.test/invoke', { method: 'POST', headers: { authorization: 'Bearer first', 'x-root-locator': rootId },
      body: JSON.stringify({ operation: 'CalendarDemo.Calendar.read', inputs: {} }) });
    assert.equal((await read(first.id)).status, 200, 'direct references route while the directory is unavailable');
    const index = createD1RootDirectory(db), indexScope = { app: 'CalendarDemo', owner: team.team_id, binding: 'CalendarDemo.Schedule', model: 'CalendarDemo.Calendar' };
    assert.deepEqual(await index.list(indexScope, { limit: 10 }), []);
    await mf.dispose(); mf = new Miniflare(options(false));
    assert.deepEqual(await (await mutate(create, { name: 'One' }, op)).json(), first, 'same root and canonical receipt survive actor restart');
    const reopenedDb = await mf.getD1Database('DB') as unknown as D1Database;
    const reopenedIndex = createD1RootDirectory(reopenedDb);
    for (let i=0;i<100 && (await reopenedIndex.list(indexScope,{limit:10})).length===0;i++) await new Promise(resolve=>setTimeout(resolve,10));
    const seen = await browseRootAuthorities({ directory: reopenedIndex, scope: indexScope, page: { limit: 10 }, loadAuthorizedRoot: async entry => {
      const response = await read(entry.rootId); assert.equal(response.status, 200); return (await response.json() as unknown[])[0] ?? null;
    } });
    assert.equal(seen.values.length, 1);
    assert.deepEqual(await reopenedIndex.list({ ...indexScope, owner: otherTeam.team_id }, { limit: 10 }), []);
    await assert.rejects(reopenedIndex.list(indexScope, { limit: 101 }), /bounded/);
    const tables = await reopenedDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'").all();
    assert.equal(tables.results.length, 0, 'Identity/index D1 has no writable business record copy');
  } finally { await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
});


test('actual D1 ports refuse every rooted domain access while retaining their genuine owner capability', async () => {
  const mf = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
    script: 'export default {fetch(){return new Response("ok")}}', d1Databases: { DB: 'reject-root-fallback' } });
  try {
    const db = await mf.getD1Database('DB') as unknown as D1Database; await ensureSchema(db);
    const port = createD1Storage(db), original = port;
    assert.equal(rejectRootModelsInD1(port, artifact), original);
    await assert.rejects(port.load('CalendarDemo.Calendar' as ModelName, 'unknown' as RecordId), /actual Durable Object/);
    await assert.rejects(port.query({ model: 'CalendarDemo.Booking' as ModelName, authority: 'owner' }), /actual Durable Object/);
    await assert.rejects(port.historyFor('CalendarDemo.Booking' as ModelName, 'unknown' as RecordId), /actual Durable Object/);
    await assert.rejects(port.commit({ expectedRevision: await port.readRevision(),
      writes: [{kind: 'remove', model: 'CalendarDemo.Booking' as ModelName, id: 'unknown' as RecordId, expectedVersion: 1 as RecordVersion}], history: [],
      receipt: null, outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [] }), /actual Durable Object/);
    assert.deepEqual(await port.query({ model: 'Other.D1Model' as ModelName, authority: 'owner' }), []);
    assert.equal(rejectRootModelsInD1(port, artifact), original, 'Cached selections retain the same guarded port.');
  } finally { await mf.dispose(); }
});
