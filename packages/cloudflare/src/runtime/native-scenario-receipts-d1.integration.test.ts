/** Actual native source -> installed portable bundle -> workerd and owner D1. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import type { ActivationVerdict, ClosedInputs, CompileArtifact } from '@canlang/contracts';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1IdentityStore, deriveCsrfToken } from '@canlang/identity';
import { hashInputs } from '@canlang/state/invocation/replay';
import { distribution } from '@canlang/values/distribution';
import { prepareLocalPreviewCapture } from '../dev/preview-inputs.js';
import { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } from '../dev/source-capture.js';
import { compileCapturedSingleFile } from '../dev/compiler-check.js';
import { selectPreviewWorkerVars, type LocalPreviewSeed } from '../dev/preview-builder.js';
import { preflightLocalPreviewActivation, localPreviewActivationVerdict, produceInstalledPortableBundle,
  seedLocalPreviewActors } from '../dev/preview-host.js';
import { startLocalDev, type LocalDev } from '../dev/local-run.js';
import { startProtectedPreview, type ProtectedPreview } from '../dev/preview-bridge.js';
import { PINNED_COMPATIBILITY_DATE } from '../dev/zero-config.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const model = 'NativeSavedScenario.Item';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function operationId(): string {
  const time = Date.now().toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0,8)}-${time.slice(8)}-7${random.slice(0,3)}-8${random.slice(4,7)}-${random.slice(7,19)}`;
}
interface ItemData { quantity: string; label: string; available: boolean }
interface Projection { id: string; data: ItemData }
interface MutationWire { status?: string; code?: string; result?: unknown; records?: Projection[] }
interface McpWire { error?: { code: number | string }; result?: { isError?: boolean; structuredContent?: { records?: Projection[] } } }
interface StoredRow { id: string; version: number; data: string }
interface ReceiptRow { app: string; owner: string; principal: string; operation: string; operation_id: string;
  input_hash: string; resolved_defaults: string; outcome: string; committed_revision: number; created_at: number }
interface TableSnapshot { count: number; digest: string }
type DatabaseSnapshot = Record<string, TableSnapshot>;
type ResourceSnapshot = Record<string, DatabaseSnapshot>;
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'JSON object');
  return value as Record<string, unknown>;
}
function word(value: unknown): string { assert.equal(typeof value, 'string'); return value as string; }
function projection(value: unknown): Projection {
  const row = object(value), data = object(row.data);
  assert.equal(typeof data.available, 'boolean');
  return { id: word(row.id), data: { quantity: word(data.quantity), label: word(data.label),
    available: data.available as boolean } };
}
function mutationWire(value: unknown): MutationWire {
  const body = object(value);
  if (body.records !== undefined) assert.ok(Array.isArray(body.records));
  return { result: body.result, ...(body.status === undefined ? {} : { status: word(body.status) }),
    ...(body.code === undefined ? {} : { code: word(body.code) }),
    ...(body.records === undefined ? {} : { records: (body.records as unknown[]).map(projection) }) };
}
function mcpWire(value: unknown): McpWire {
  const body = object(value), result: McpWire = {};
  if (body.error !== undefined) { const error = object(body.error); assert.ok(typeof error.code === 'number' || typeof error.code === 'string');
    result.error = { code: error.code as number | string }; }
  if (body.result !== undefined) {
    const wire = object(body.result); result.result = {};
    if (wire.isError !== undefined) { assert.equal(typeof wire.isError, 'boolean'); result.result.isError = wire.isError as boolean; }
    if (wire.structuredContent !== undefined) { const content = object(wire.structuredContent); result.result.structuredContent = {};
      if (content.records !== undefined) { assert.ok(Array.isArray(content.records));
        result.result.structuredContent.records = content.records.map(projection); } }
  }
  return result;
}
type Actor = { cookie: string; csrf: string; owner: string | null; principal: string; grant?: string };

it('consumes captured native saved scalar scenarios through real portable owner D1, auth and MCP', { timeout: 180000 }, async () => {
  let worker: LocalDev | undefined, bridge: ProtectedPreview | undefined, provisioning: LocalDev | undefined;
  let persistence: string | undefined;
  let capture: Awaited<ReturnType<typeof captureSingleFileSource>> | undefined;
  try {
    capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root,
      appPath: join(root, 'tests/integration/can-dev-server/NativeSavedScenario.can'),
      compilerPath: join(root, 'compiler/target/debug/can'), catalogPath: fileURLToPath(distribution.catalog),
      helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
    assert.equal(await captureIsCurrent(capture), true);
    const compiled = await compileCapturedSingleFile(capture);
    assert.equal(compiled.kind, 'artifact', compiled.kind === 'diagnostics' ? JSON.stringify(compiled.envelope.diagnostics) : compiled.kind);
    if (compiled.kind !== 'artifact') throw new Error('Native saved scalar fixture did not compile');
    const artifact: CompileArtifact = compiled.artifact;
    assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
    assert.equal(artifact.pages.length, 0, 'fixture has no page; no page readiness is claimed');
    assert.equal(artifact.models?.find(item => item.name === model)?.deleteMode, 'archive');
    const descriptors = ['quantity', 'availability'].map(name => {
      const op = artifact.operations?.find(item => item.name === `NativeSavedScenario.${name}`); assert.ok(op);
      const plan = op.result?.disclosure;
      assert.ok(plan, 'requires actual Compiler95d flag in owning capture compiler adapter');
      assert.equal(plan.version, 1);
      const callable = artifact.callables.find(item => item.id === op.name); assert.ok(callable);
      for (const origin of [plan.source, ...plan.returns.flatMap(returned =>
        [returned.source, ...returned.dependencies.map(dependency => dependency.source)])]) {
        assert.equal(origin.module, callable.module);
        assert.ok(artifact.sources.some(source => source.path === origin.path && source.sha256 === origin.sha256));
      }
      const module = artifact.modules.find(item => item.path === callable.module); assert.ok(module);
      assert.ok(module.js.includes('observeScenarioReceiptDependency') && module.js.includes('selectScenarioReceiptReturn'),
        'actual emitted framework marker imports');
      assert.match(module.js, /await[^;]*observeScenarioReceiptDependency/, 'actual awaited field marker');
      assert.deepEqual([...new Set(plan.returns.flatMap(returned => returned.dependencies.map(dep => dep.field)))],
        [name === 'quantity' ? 'quantity' : 'available']);
      return op;
    });
    const preflight = await preflightLocalPreviewActivation(artifact, capture);
    assert.equal(preflight.active, true, 'real preflight activation must qualify this native profile');
    if (!preflight.active) throw new Error('NativeSavedScenario real preflight refused');
    const evidence = await produceInstalledPortableBundle({ artifact, capture,
      verdict: preflight as ActivationVerdict & { active: true }, assets: { browser: true, valuesWasm: true } });
    assert.equal(evidence.captureEpochMaterial, capture.epochMaterial);
    assert.equal(evidence.artifactJsonSha256, digest(artifact));
    assert.equal(await captureIsCurrent(capture), true);

    // The only test adapter is a trusted host for the dedicated recovery API.
    // Ordinary auth/HTTP/MCP continue through the actual installed Worker main.
    // No request can register assembly evidence, provide a verdict, or select
    // a State admission mode. Fixed adapter routes select owning host methods.
    const nonce = randomBytes(32).toString('hex');
    const testHost = `
      import original from './main.js';
      import { artifact, modules } from './artifact.js';
      import { buildInvoker, createTeamOwnerStorageBoundary } from './assembly.js';
      import { createD1Storage } from '../vendor/state/storage/d1.js';
      import { createD1OwnerRouter } from '../vendor/state/storage/owner-router.js';
      import { createD1IdentityStore, resolveIdentity, parseSessionCookie } from '../vendor/identity/index.js';
      export default { async fetch(request, env, ctx) {
        const path = new URL(request.url).pathname;
        if (!path.startsWith('/__native_saved/')) return original.fetch(request,env,ctx);
        if (request.method !== 'POST' || request.headers.get('x-native-scenario-test') !== ${JSON.stringify(nonce)})
          return new Response(null,{status:403});
        const identities=createD1IdentityStore(env.DB);
        const token=parseSessionCookie(request.headers.get('cookie')??undefined);
        const identity=await resolveIdentity(identities,token===null?{}:{session_token:token});
        const configured=typeof env.CAN_STATE_OWNERS==='string'?JSON.parse(env.CAN_STATE_OWNERS):env.CAN_STATE_OWNERS;
        const router=createD1OwnerRouter({resolveBinding:scope=>{
          const route=configured.owners.find(value=>value.owner===scope.owner);
          return scope.app==='NativeSavedScenario'&&route?{app:scope.app,owner:scope.owner,db:env[route.binding]}:null;
        }});
        const boundary=await createTeamOwnerStorageBoundary({artifact,asm:modules,app:'NativeSavedScenario',identities,router});
        let commits=0,files=0;
        const ownerStorage={...boundary,forIdentity:async caller=>{
          const selected=await boundary.forIdentity(caller);
          return {...selected,store:{...selected.store,commit:async()=>{commits++;throw new Error('retained commit tripwire');}}};
        }};
        const filesPort=new Proxy({},{get(){files++;throw new Error('retained file tripwire');}});
        const chosen=path==='/__native_saved/issuer-copy'?{...modules}:modules;
        const drift=['source-change','js-change','map-change'].find(name=>path==='/__native_saved/'+name);
        const current=drift?JSON.parse(JSON.stringify(artifact)):artifact;
        if(drift==='source-change')current.sources[0].sha256='0'.repeat(64);
        if(drift==='js-change')current.modules[0].js+='\\n';
        if(drift==='map-change')current.modules[0].map.names.push('changed');
        const invoker=buildInvoker(current,chosen,createD1Storage(env.DB),{appId:'NativeSavedScenario',memberships:identities,
          ownerStorage,files:filesPort,now:()=>Date.now()+16*60000});
        const outcome=await invoker.invokeRetainedMutation(await request.json(),identity);
        return Response.json({outcome,commits,files});
      }};
    `;
    bridge = await startProtectedPreview({ dispatchUrl: (url, init) => {
      if (!worker) return Promise.reject(new Error('actual worker is starting'));
      return worker.dispatchUrl(url, init);
    } });
    const origin = bridge.url;
    persistence = await mkdtemp(join(tmpdir(), 'can-native-d1-'));
    const databaseId = `native-identity-${randomUUID()}`;
    provisioning = await startLocalDev({ workerName: `native-provision-${randomUUID()}`,
      compatibilityDate: PINNED_COMPATIBILITY_DATE, mainModule: 'provision.js',
      modules: { 'provision.js': 'export default {fetch(){return new Response(null,{status:404})}};' },
      d1Databases: [{ binding: 'DB', id: databaseId }], d1Persist: persistence });
    const seed: LocalPreviewSeed = await seedLocalPreviewActors(await provisioning.getD1Database('DB'));
    await provisioning.dispose(); provisioning = undefined;
    const owners = seed.owners.map(owner => ({ ...owner, id: `native-owner-${randomUUID()}` }));
    worker = await startLocalDev({ workerName: `native-rules-${randomUUID()}`,
      compatibilityDate: PINNED_COMPATIBILITY_DATE, mainModule: 'worker/native-scenario-test-host.js',
      modules: { ...evidence.bundle.modules, 'worker/native-scenario-test-host.js': testHost }, binaryModules: evidence.bundle.binaries,
      d1Databases: [{ binding: 'DB', id: databaseId }, ...owners.map(item => ({ binding: item.binding, id: item.id }))],
      d1Persist: persistence, vars: { ...selectPreviewWorkerVars({ resources: { d1: { binding:'DB', availability:'real_local' }, identity: { backingBinding:'DB', availability:'real_local' } } }, origin),
        CAN_STATE_OWNERS: { version: 1, owners: owners.map(item => ({ owner: item.owner,
          binding: item.binding, initializeFresh: true })) } } });
    const identityDb = await worker.getD1Database('DB');
    const dbs = new Map<string, D1Database>();
    for (const owner of owners) {
      const db: D1Database = await worker.getD1Database(owner.binding); dbs.set(owner.owner, db);
      assert.equal((await localPreviewActivationVerdict(artifact, capture, db, owner.id, owner.owner, identityDb)).active,
        true, 'each genuine serving owner D1 must activate');
    }
    assert.equal(await captureIsCurrent(capture), true);

    const bootstrap = await fetch(bridge.issueOpenUrl(), { redirect: 'manual' });
    assert.equal(bootstrap.status, 303);
    const bridgeCookie = bootstrap.headers.getSetCookie().find(item => item.startsWith('can_dev_preview='))?.split(';',1)[0];
    assert.ok(bridgeCookie);
    const request = (actor: Actor | null, path: string, body?: unknown, token?: string) => fetch(new URL(path, origin), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual', headers: {
        cookie: [bridgeCookie, actor?.cookie].filter(Boolean).join('; '), origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(path.startsWith('/__native_saved/') ? { 'x-native-scenario-test': nonce } : {}),
        ...(path === '/mcp' ? { accept: 'application/json, text/event-stream' } : {}),
        ...(actor?.csrf ? { 'x-csrf-token': actor.csrf } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    async function login(label: string): Promise<Actor> {
      const seeded = seed.actors.find(item => item.label === label); assert.ok(seeded);
      const descriptor = await request(null, '/auth/login'); assert.equal(descriptor.status, 200);
      const form = object(await descriptor.json());
      const preSessionToken = word(form.preSessionToken);
      const response = await request(null, '/auth/login', { email: seeded.email, password: seeded.password,
        _presession: preSessionToken }); assert.equal(response.status, 200);
      const cookie = response.headers.getSetCookie().find(item => item.startsWith('can_session='))?.split(';',1)[0];
      assert.ok(cookie);
      const principal = await identityDb.prepare('SELECT user_id FROM identity_users WHERE email_lc=?')
        .bind(seeded.email.toLowerCase()).first<{ user_id: string }>(); assert.ok(principal); assert.equal(typeof principal.user_id, 'string');
      const actor: Actor = { cookie, csrf: await deriveCsrfToken(decodeURIComponent(cookie.slice('can_session='.length))),
        owner: null, principal: principal.user_id };
      const listing = await request(actor, '/auth/teams'); assert.equal(listing.status, 200);
      const teams = object(await listing.json()); assert.ok(Array.isArray(teams.teams));
      const ownerIds = teams.teams.map(item => word(object(item).team_id));
      if (ownerIds.length) {
        actor.owner = ownerIds[0]!;
        assert.equal((await request(actor, '/auth/select-team', { team: actor.owner, _csrf: actor.csrf })).status, 200);
      }
      return actor;
    }
    async function tables(db: D1Database): Promise<DatabaseSnapshot> {
      const names = (await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{name:string}>())
        .results.map(row => row.name).filter(name => !name.startsWith('_cf_'));
      const result: DatabaseSnapshot = {};
      for (const name of names) {
        assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
        const rows = (await db.prepare(`SELECT * FROM "${name}"`).all()).results;
        result[name] = { count: rows.length, digest: digest(rows.map(row => JSON.stringify(row)).sort()) };
      }
      return result;
    }
    async function resources(): Promise<ResourceSnapshot> {
      const result: ResourceSnapshot = { Identity: await tables(identityDb) };
      for (const [owner, db] of dbs) result[`owner:${owner}`] = await tables(db);
      assert.equal(dbs.size, 2, 'both real owner databases observed');
      return result;
    }
    async function mutation(actor: Actor | null, name: string, inputs: ClosedInputs, id=operationId()) {
      const response = await request(actor, `/api/operations/${name}`, { operation_id: id, inputs });
      return { response, body: mutationWire(await response.json()), id };
    }
    async function commit(actor: Actor, name: string, inputs: ClosedInputs, id?: string) {
      const result = await mutation(actor, name, inputs, id);
      assert.equal(result.response.status, 200); assert.equal(result.body.status, 'committed'); return result;
    }
    async function read(actor: Actor) {
      if (!actor.grant) {
        const granted = await request(actor, '/mcp/grants', { client_id: 'native-rules-d1-test' });
        assert.equal(granted.status, 200); actor.grant = word(object(await granted.json()).token); assert.ok(actor.grant);
      }
      const response = await request(actor, '/mcp', { jsonrpc:'2.0', id:1, method:'tools/call',
        params:{ name:`${model}.read`, arguments:{} } }, actor.grant);
      assert.equal(response.status, 200); const body = mcpWire(await response.json());
      assert.notEqual(body.result?.isError, true); assert.ok(Array.isArray(body.result?.structuredContent?.records));
      return body.result!.structuredContent!.records!;
    }
    const ava = await login('Ava'), ben = await login('Ben'), cal = await login('Cal'), dee = await login('Dee');
    assert.ok(ava.owner && cal.owner); assert.equal(ben.owner, ava.owner); assert.notEqual(cal.owner, ava.owner); assert.equal(dee.owner, null);
    const cedar = dbs.get(ava.owner)!;
    async function row(id: string) {
      const stored = await cedar.prepare('SELECT id,version,data FROM records WHERE model=? AND id=?').bind(model,id).first<StoredRow>();
      if (!stored) return null;
      assert.equal(typeof stored.id, 'string'); assert.ok(Number.isSafeInteger(stored.version));
      return { id: stored.id, version: stored.version, data: projection({ id: stored.id, data: JSON.parse(stored.data) }).data };
    }
    async function recovery(actor: Actor | null, envelope: { operation: string; operation_id: string; inputs: ClosedInputs }, control='retained') {
      const response=await request(actor,`/__native_saved/${control}`,envelope); assert.equal(response.status,200);
      const value=object(await response.json()); assert.equal(value.commits,0); assert.equal(value.files,0);
      return object(value.outcome);
    }
    async function receipt(id: string) {
      const stored=await cedar.prepare('SELECT * FROM receipts WHERE operation_id=?').bind(id).first<ReceiptRow>(); assert.ok(stored);
      assert.equal(stored.app,'NativeSavedScenario'); assert.equal(stored.owner,ava.owner); assert.equal(stored.principal,ava.principal);
      return stored;
    }
    const id=operationId(); await commit(ava,`${model}.create`,{quantity:'17',label:'saved scalar'},id);
    const initial=await row(id); assert.ok(initial);
    // Provision a genuine grant before purity snapshots; reads then own no writes.
    assert.equal((await read(ben))[0]?.data.quantity,'17'); assert.deepEqual(await read(cal),[]);
    const saved=[];
    for(const [index, inputs, expected] of [
      [0,{item:{id,version:String(initial.version)}},'17'],
      [1,{item:{id,version:String(initial.version)}},true],
    ] as const) {
      const descriptor=descriptors[index]!, operation_id=operationId();
      const envelope={operation:descriptor.name,operation_id,inputs};
      const fresh=await commit(ava,envelope.operation,inputs,operation_id);
      assert.equal(fresh.body.result,expected); assert.deepEqual(fresh.body.records,[]);
      const physical=await receipt(operation_id); assert.equal(physical.operation,descriptor.name);
      assert.equal(physical.input_hash,await hashInputs(inputs));
      const outcome=object(JSON.parse(physical.outcome)), association=object(outcome.scenario);
      assert.equal(outcome.result,expected); assert.equal(association.kind,'scenario-result/v1');
      assert.deepEqual(association.plan,descriptor.result!.disclosure);
      assert.ok(Array.isArray(association.observations)); assert.equal(association.observations.length,1);
      const observation=object(association.observations[0]); assert.equal(observation.model,model);
      const capturedRow=object(observation.row); assert.equal(capturedRow.id,id); assert.equal(capturedRow.version,initial.version);
      assert.deepEqual(capturedRow.data,initial.data); assert.deepEqual(association.changed,[]);
      const before=await resources();
      const ordinary=await mutation(ava,envelope.operation,inputs,operation_id);
      assert.equal(ordinary.body.status,'replayed'); assert.equal(ordinary.body.result,expected); assert.deepEqual(ordinary.body.records,[]);
      const retained=await recovery(ava,envelope); const replay=object(retained.result);
      assert.equal(replay.status,'replayed'); assert.equal(replay.result,expected); assert.deepEqual(replay.records,[]);
      assert.deepEqual(await resources(),before); assert.deepEqual(await receipt(operation_id),physical);
      assert.equal(JSON.stringify({ordinary:ordinary.body,retained}).includes('scenario-result/v1'),false);
      saved.push({envelope,physical,expected});
    }
    for(const actor of [cal,dee,null]) {
      const before=await resources(), denied=await recovery(actor,saved[0]!.envelope);
      assert.ok(denied.error,'foreign owner/nonmember/public retained authority refused');
      assert.deepEqual(await resources(),before);
    }
    for(const [envelope, expected] of [
      [{...saved[0]!.envelope,operation_id:operationId()},'not_found'],
      [{...saved[0]!.envelope,inputs:{item:{id,version:'999'}}},'conflict'],
    ] as const) {
      const before=await resources(), denied=await recovery(ava,envelope);
      assert.equal(object(denied.error).code,expected);
      assert.deepEqual(await resources(),before);
    }
    const current=await row(id); assert.ok(current);
    await commit(ben,`${model}.update`,{record:{id,version:String(current.version)},quantity:'99',available:false});
    assert.equal((await read(ben))[0]?.data.quantity,'99');
    const beforeReplay=await resources();
    for(const value of saved) {
      const ordinary=await mutation(ava,value.envelope.operation,value.envelope.inputs,value.envelope.operation_id);
      assert.equal(ordinary.body.status,'replayed'); assert.equal(ordinary.body.result,value.expected);
      const retained=await recovery(ava,value.envelope); assert.equal(object(retained.result).result,value.expected);
      assert.deepEqual(await receipt(value.envelope.operation_id),value.physical);
      // Fresh source would now return 99/false; old input refs are also stale.
      // Original scalar plus identical full stores proves no fresh execution or commit.
    }
    assert.deepEqual(await resources(),beforeReplay);
    for(const value of saved) for(const control of ['issuer-copy','source-change','js-change','map-change']) {
      const before=await resources(), refused=await recovery(ava,value.envelope,control);
      assert.ok(refused.error,'current source/issuer correspondence must refuse');
      assert.deepEqual(await resources(),before);
    }
    for(const actor of [cal,dee,null]) {
      const before=await resources();
      const refused=await mutation(actor,saved[0]!.envelope.operation,saved[0]!.envelope.inputs);
      assert.ok(refused.response.status>=400); assert.deepEqual(await resources(),before);
    }
    const live=await row(id); assert.ok(live);
    await commit(ava,`${model}.delete`,{record:{id,version:String(live.version)}});
    assert.deepEqual(await read(ben),[]);
    const beforeWithheld=await resources();
    for(const value of saved) {
      const ordinary=await mutation(ava,value.envelope.operation,value.envelope.inputs,value.envelope.operation_id);
      assert.equal(ordinary.body.status,'replayed'); assert.equal(ordinary.body.result,null); assert.deepEqual(ordinary.body.records,[]);
      const retained=await recovery(ava,value.envelope); assert.equal(object(retained.result).result,null);
      assert.deepEqual(await receipt(value.envelope.operation_id),value.physical);
    }
    assert.deepEqual(await resources(),beforeWithheld);
    const identityStore=createD1IdentityStore(identityDb);
    const membership=await identityStore.findMembership(ava.owner,ava.principal); assert.ok(membership);
    await identityStore.removeMembership(membership.membership_id);
    const beforeRevoked=await resources();
    const revoked=await recovery(ava,saved[0]!.envelope); assert.equal(object(revoked.error).code,'forbidden');
    assert.deepEqual(await resources(),beforeRevoked);
    assert.equal(await captureIsCurrent(capture), true);
  } finally {
    try { await bridge?.close(); }
    finally { try { await worker?.dispose(); }
      finally { try { await provisioning?.dispose(); }
        finally { if (persistence) await rm(persistence,{recursive:true,force:true});
          if (capture) assert.equal(await captureIsCurrent(capture),true,'finish source-current'); } } }
  }
});
