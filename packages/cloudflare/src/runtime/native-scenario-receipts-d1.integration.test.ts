/** Actual native source -> installed portable bundle -> workerd and owner D1. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import type { ActivationVerdict, ArtifactModelField, ClosedInputs, CompileArtifact, ModelName, RecordId } from '@canlang/contracts';
import type { D1Database } from '@cloudflare/workers-types';
import { createD1IdentityStore, deriveCsrfToken } from '@canlang/identity';
import { hashInputs } from '@canlang/state/invocation/replay';
import { createD1Storage } from '@canlang/state/storage/d1';
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
const jobModel = 'NativeSavedScenario.Job';
const jobModelName = jobModel as ModelName;
const asRecordId = (value: string) => value as RecordId;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function operationId(): string {
  const time = Date.now().toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0,8)}-${time.slice(8)}-7${random.slice(0,3)}-8${random.slice(4,7)}-${random.slice(7,19)}`;
}
interface ItemData { quantity: string; label: string; available: boolean; optional: string | null; values: string[] | null; flags: boolean[]; names: string[] }
interface Projection { id: string; data: ItemData }
interface JobProjection { id: string; data: { status: string } }
interface MutationWire { status?: string; code?: string; result?: unknown; records?: Array<Projection | JobProjection> }
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
  assert.ok(data.values === null || Array.isArray(data.values));
  assert.ok(Array.isArray(data.flags)); assert.ok(Array.isArray(data.names));
  const values = data.values === null ? null : (data.values as unknown[]).map(value => {
    const integer = word(value); assert.match(integer, /^-?(0|[1-9][0-9]*)$/); return integer;
  });
  const flags = (data.flags as unknown[]).map(value => { assert.equal(typeof value, 'boolean'); return value as boolean; });
  const names = (data.names as unknown[]).map(word);
  return { id: word(row.id), data: { quantity: word(data.quantity), label: word(data.label),
    available: data.available as boolean, optional: data.optional === null ? null : word(data.optional), values, flags, names } };
}
function mutationWire(value: unknown): MutationWire {
  const body = object(value);
  if (body.records !== undefined) assert.ok(Array.isArray(body.records));
  return { result: body.result, ...(body.status === undefined ? {} : { status: word(body.status) }),
    ...(body.code === undefined ? {} : { code: word(body.code) }),
    ...(body.records === undefined ? {} : { records: (body.records as unknown[]).map(value => {
      const row = object(value), data = object(row.data);
      if (Object.hasOwn(data, 'quantity')) return projection(value);
      assert.deepEqual(Object.keys(data), ['status'], 'Job read grant withholds its private selector');
      const status = word(data.status); assert.ok(['idle','queued','generating','ready'].includes(status));
      return { id: word(row.id), data: { status } };
    }) }) };
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

it('consumes captured native saved scalar, array, derive and machine scenarios through real portable owner D1, auth and MCP', { timeout: 180000 }, async () => {
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
    if (compiled.kind !== 'artifact') throw new Error('Native saved scenario fixture did not compile');
    const artifact: CompileArtifact = compiled.artifact;
    assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
    assert.equal(artifact.pages.length, 0, 'fixture has no page; no page readiness is claimed');
    assert.equal(artifact.models?.find(item => item.name === model)?.deleteMode, 'archive');
    const itemModel = artifact.models?.find(item => item.name === model); assert.ok(itemModel);
    for (const name of ['values', 'flags', 'names']) {
      const field: ArtifactModelField | undefined = itemModel.fields.find(field => field.name === name); assert.ok(field);
      assert.deepEqual(field.array, { required: false });
      if (name === 'values') { assert.equal(field.field.kind, 'integer'); assert.equal(field.nullable, true); }
    }
    const descriptorFields = ['quantity', 'available', 'values', 'flags', 'names'];
    const descriptorTypes = ['int', 'bool', 'int[]?', 'bool[]', 'text[]'];
    const descriptors = ['quantity', 'availability', 'values', 'flags', 'names',
      'nested', 'repeated', 'reordered', 'derived_default', 'derived_override', 'derived_lazy'].map((name, index) => {
      const op = artifact.operations?.find(item => item.name === `NativeSavedScenario.${name}`); assert.ok(op);
      const plan = op.result?.disclosure;
      assert.ok(plan, 'requires actual native local-derive compiler in owning capture adapter');
      assert.equal(op.result?.type, index < 5 ? descriptorTypes[index] : 'int');
      for (const returned of plan.returns) for (const dependency of returned.dependencies) {
        assert.equal(dependency.model, model);
        if (index < 5) { assert.equal(dependency.field, descriptorFields[index]); assert.equal(dependency.type, descriptorTypes[index]); }
        else { assert.ok(['quantity','optional','available'].includes(dependency.field));
          assert.equal(dependency.type, dependency.field === 'available' ? 'bool' : dependency.field === 'optional' ? 'int?' : 'int'); }
      }
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
      if (index < 5) assert.deepEqual([...new Set(plan.returns.flatMap(returned => returned.dependencies.map(dep => dep.field)))],
        [descriptorFields[index]]);
      if (name === 'derived_override') assert.ok(plan.returns.every(returned => returned.dependencies.length === 0));
      return op;
    });
    const machine = artifact.models?.find(item => item.name === jobModel)?.fields.find(field => field.name === 'status')?.machine;
    assert.ok(machine); assert.equal(machine.initial, 'idle');
    assert.deepEqual(machine.states, ['idle','queued','generating','ready']);
    assert.ok(artifact.requires.some(requirement => requirement.capability === 'state.machines' && requirement.min_version === 1));
    assert.deepEqual(machine.transitions,[
      {from:'idle',to:'queued',operation:'NativeSavedScenario.advance'},
      {from:'queued',to:'generating',operation:'NativeSavedScenario.advance'},
      {from:'generating',to:'ready',operation:'NativeSavedScenario.finish'},
      {from:'idle',to:'queued',operation:'NativeSavedScenario.rollback'},
      {from:'idle',to:'ready',operation:'NativeSavedScenario.optional'},
      {from:'idle',to:'ready',operation:'NativeSavedScenario.optional_scalar'},
      {from:'idle',to:'ready',operation:'NativeSavedScenario.default_scalar'},
      {from:'idle',to:'ready',operation:'NativeSavedScenario.computed_scalar'},
      {from:'idle',to:'ready',operation:'NativeSavedScenario.default_reference'},
      {from:'idle',to:'ready',operation:'NativeSavedScenario.stored_private_scalar'},
      {from:'idle',to:'ready',operation:'NativeSavedScenario.stored_public_scalar'},
    ]);
    const transitions = ['advance','finish','rollback','optional','optional_scalar',
      'default_scalar','computed_scalar','default_reference','stored_private_scalar','stored_public_scalar'].map(name => {
      const op = artifact.operations?.find(item => item.name === `NativeSavedScenario.${name}`); assert.ok(op);
      const plan = op.result?.disclosure; assert.ok(plan, 'actual native machine capture must be published');
      assert.equal(op.result?.type, name.endsWith('_scalar') ? 'int' : 'void');
      const callable = artifact.callables.find(item => item.id === op.name); assert.ok(callable);
      const emitted = artifact.modules.find(item => item.path === callable.module); assert.ok(emitted);
      assert.match(emitted.js, /await[^;]*observeScenarioReceiptDependency/);
      for (const returned of plan.returns) for (const dependency of returned.dependencies) {
        assert.equal(dependency.role, 'control');
        if (dependency.model === model) {
          assert.equal(name,'stored_public_scalar'); assert.equal(dependency.field,'optional'); assert.equal(dependency.type,'int?');
        } else {
          assert.equal(dependency.model,jobModel);
          assert.equal(dependency.type, dependency.field === 'status' ? 'enum(idle,queued,generating,ready)' : 'bool');
          assert.ok(['status','private_choice'].includes(dependency.field));
        }
      }
      for (const origin of [plan.source, ...plan.returns.flatMap(returned =>
        [returned.source, ...returned.dependencies.map(dependency => dependency.source)])]) {
        assert.equal(origin.module, callable.module);
        assert.ok(artifact.sources.some(source => source.path === origin.path && source.sha256 === origin.sha256));
      }
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
    async function readJobs(actor: Actor) {
      if (!actor.grant) await read(actor);
      const response = await request(actor, '/mcp', { jsonrpc:'2.0', id:2, method:'tools/call',
        params:{ name:`${jobModel}.read`, arguments:{} } }, actor.grant);
      assert.equal(response.status, 200);
      const content = object(object(object(await response.json()).result).structuredContent);
      assert.ok(Array.isArray(content.records));
      return content.records.map(value => {
        const record = object(value), data = object(record.data);
        assert.deepEqual(Object.keys(data), ['status'], 'actual MCP read never discloses private_choice');
        return { id: word(record.id), data: { status: word(data.status) } };
      });
    }
    const id=operationId(); await commit(ava,`${model}.create`,{quantity:'17',label:'saved values',optional:null,values:null,flags:[],names:[]},id);
    const initial=await row(id); assert.ok(initial);
    // Provision a genuine grant before purity snapshots; reads then own no writes.
    assert.equal((await read(ben))[0]?.data.quantity,'17'); assert.deepEqual(await read(cal),[]);
    const arrayInput = artifact.operations?.find(op => op.name === 'NativeSavedScenario.array_input'); assert.ok(arrayInput);
    assert.equal(arrayInput.result?.type, 'int[]?'); assert.ok(arrayInput.result?.disclosure);
    assert.ok(arrayInput.result.disclosure.returns.every(returned => returned.dependencies.length === 0));
    // The real public HTTP transport validates both array shape and elements
    // before canonical State admission; neither refusal writes a receipt.
    for (const values of [42, ['not-int']]) {
      const before = await resources(), operation_id = operationId();
      const inputs = { values }, rejected = await mutation(ava, arrayInput.name, inputs, operation_id);
      assert.equal(rejected.body.code, 'validation'); assert.ok(rejected.response.status >= 400);
      assert.deepEqual(await resources(), before, 'public malformed array admission changes no table');
      assert.equal(await cedar.prepare('SELECT * FROM receipts WHERE operation_id=?').bind(operation_id).first(), null);
    }
    const saved=[];
    for (const [shapeIndex, shape] of [
      { values: null, flags: [], names: [], optional: null, available: true },
      { values: [], flags: [], names: [], optional: '9', available: false },
      { values: ['9223372036854775807','-2'], flags: [true,false], names: ['saved','original'], optional: '9', available: true },
    ].entries()) {
      let captured = await row(id); assert.ok(captured);
      if (shapeIndex > 0) {
        await commit(ben, `${model}.update`, { record: { id, version: String(captured.version) }, ...shape });
        captured = await row(id); assert.ok(captured);
      }
      assert.deepEqual((await read(ben))[0]?.data, captured.data);
      const cases: Array<readonly [index: number, inputs: ClosedInputs, expected: unknown, expectedFields?: readonly string[]]> = [];
      if (shapeIndex === 0) cases.push([0,{item:{id,version:String(captured.version)}},'17'],
        [1,{item:{id,version:String(captured.version)}},true]);
      cases.push(
        [2,{item:{id,version:String(captured.version)}},shape.values],
        [3,{item:{id,version:String(captured.version)}},shape.flags],
        [4,{item:{id,version:String(captured.version)}},shape.names],
      );
      const ref = { item: { id, version: String(captured.version) } };
      if (shapeIndex === 0) cases.push(
        [5,ref,'18',['quantity']], [6,ref,'34',['quantity','quantity']],
        [7,ref,'0',['quantity','optional','optional','quantity']],
        [8,ref,'17',['quantity']], [9,ref,'42',[]],
        [10,ref,'17',['optional','optional','quantity','available']],
      );
      if (shapeIndex === 1) cases.push(
        [7,ref,'-8',['quantity','optional','optional']], [10,ref,'9',['optional','optional','available']],
      );
      for(const [index, inputs, expected, expectedFields] of cases) {
        const descriptor=descriptors[index]!, operation_id=operationId();
        const envelope={operation:descriptor.name,operation_id,inputs};
        const fresh=await commit(ava,envelope.operation,inputs,operation_id);
        assert.deepEqual(fresh.body.result,expected); assert.deepEqual(fresh.body.records,[]);
        const physical=await receipt(operation_id); assert.equal(physical.operation,descriptor.name);
        assert.equal(physical.input_hash,await hashInputs(inputs));
        const outcome=object(JSON.parse(physical.outcome)), association=object(outcome.scenario);
        assert.deepEqual(outcome.result,expected); assert.equal(association.kind,'scenario-result/v1'); assert.equal(association.resultType,descriptor.result!.type);
        assert.deepEqual(association.plan,descriptor.result!.disclosure);
        assert.ok(Array.isArray(association.observations));
        const selected = descriptor.result!.disclosure!.returns.find(returned => returned.id === association.returnId); assert.ok(selected);
        const observations = association.observations.map(object);
        assert.deepEqual(observations.map(observation => observation.dependencyId), selected.dependencies.map(dependency => dependency.id),
          'actual awaited marker order agrees with selected source-carried path');
        assert.deepEqual(selected.dependencies.map(dependency => dependency.field), expectedFields ?? [descriptorFields[index]]);
        if (index === 6) { assert.equal(selected.dependencies.length,2);
          assert.notEqual(selected.dependencies[0]!.id,selected.dependencies[1]!.id,'repeated derive callsites have distinct defining IDs'); }
        if (index === 9) assert.deepEqual(observations,[],'explicit override never evaluates the read default');
        for (const observation of observations) {
          assert.equal(observation.model,model);
          const capturedRow=object(observation.row); assert.equal(capturedRow.id,id); assert.equal(capturedRow.version,captured.version);
          assert.deepEqual(capturedRow.data,captured.data);
        }
        assert.deepEqual(association.changed,[]);
        const before=await resources();
        const ordinary=await mutation(ava,envelope.operation,inputs,operation_id);
        assert.equal(ordinary.body.status,'replayed'); assert.deepEqual(ordinary.body.result,expected); assert.deepEqual(ordinary.body.records,[]);
        const retained=await recovery(ava,envelope); const replay=object(retained.result);
        assert.equal(replay.status,'replayed'); assert.deepEqual(replay.result,expected); assert.deepEqual(replay.records,[]);
        assert.deepEqual(await resources(),before); assert.deepEqual(await receipt(operation_id),physical);
        assert.equal(JSON.stringify({ordinary:ordinary.body,retained}).includes('scenario-result/v1'),false);
        saved.push({envelope,physical,expected,rowDependent:selected.dependencies.length > 0});
      }
    }
    assert.equal(saved.length,19,'retain every qualified scalar/array/derive case');
    const jobs = createD1Storage(cedar);
    const machineSaved: Array<{ envelope:{operation:string;operation_id:string;inputs:ClosedInputs}; physical:ReceiptRow;
      records:NonNullable<MutationWire['records']>; expected:unknown; jobId:string; rowDependent:boolean }> = [];
    async function machineCall(name: string, jobId: string, supplied?:ClosedInputs, expectedDefaults:Record<string,unknown>={}) {
      const descriptor = transitions.find(op => op.name === `NativeSavedScenario.${name}`); assert.ok(descriptor);
      const entry = await jobs.load(jobModelName,asRecordId(jobId)); assert.ok(entry);
      const before = await resources(), history = await jobs.historyFor(jobModelName,asRecordId(jobId));
      const fence = await cedar.prepare('SELECT * FROM fence').first<{id:number;revision:number}>(); assert.ok(fence);
      const envelope = { operation:descriptor.name, operation_id:operationId(), inputs:supplied ?? {job:{id:jobId,version:String(entry.version)}} };
      const itemRef = envelope.inputs.item === undefined ? null : object(envelope.inputs.item);
      const itemEntry = itemRef ? await jobs.load(model as ModelName,asRecordId(word(itemRef.id))) : null;
      if (itemRef) { assert.ok(itemEntry); assert.equal(String(itemEntry.version),itemRef.version); }
      const fresh = await commit(ava,envelope.operation,envelope.inputs,envelope.operation_id);
      const physical = await receipt(envelope.operation_id), outcome = object(JSON.parse(physical.outcome));
      const association = object(outcome.scenario), plan = descriptor.result!.disclosure!;
      assert.equal(physical.operation,envelope.operation); assert.equal(physical.input_hash,await hashInputs(envelope.inputs));
      assert.deepEqual(JSON.parse(physical.resolved_defaults),expectedDefaults);
      assert.equal(outcome.status,'committed'); assert.equal(association.kind,'scenario-result/v1');
      assert.equal(association.resultType,descriptor.result!.type); assert.deepEqual(association.plan,plan);
      const selected = plan.returns.find(returned => returned.id === association.returnId); assert.ok(selected);
      assert.ok(Array.isArray(association.observations) && Array.isArray(association.changed));
      const observations = association.observations.map(object), changed = association.changed.map(object);
      assert.deepEqual(observations.map(value => value.dependencyId),selected.dependencies.map(value => value.id));
      for (const observation of observations) {
        if (observation.model === model) { assert.ok(itemEntry); assert.deepEqual(observation.row,itemEntry); }
        else { assert.equal(observation.model,jobModel); assert.equal(object(observation.row).id,jobId); }
      }
      const final = await jobs.load(jobModelName,asRecordId(jobId)); assert.ok(final);
      assert.equal(changed.length,final.version === entry.version ? 0 : 1);
      if (changed.length) { assert.equal(changed[0]!.model,jobModel); assert.deepEqual(changed[0]!.row,final); }
      const after = await resources(), ownerKey = `owner:${ava.owner}`;
      for (const key of Object.keys(before)) if (key !== ownerKey) assert.deepEqual(after[key],before[key]);
      const ownerBefore = before[ownerKey]!, ownerAfter = after[ownerKey]!;
      for (const table of Object.keys(ownerBefore)) {
        if (['receipts','fence','fence_log',...(changed.length ? ['records','history'] : [])].includes(table)) continue;
        assert.deepEqual(ownerAfter[table],ownerBefore[table],`transition leaves ${table} unchanged`);
      }
      assert.equal(ownerAfter.records!.count,ownerBefore.records!.count);
      assert.equal(ownerAfter.history!.count,ownerBefore.history!.count+changed.length);
      assert.equal(ownerAfter.receipts!.count,ownerBefore.receipts!.count+1);
      assert.equal(ownerAfter.fence_log!.count,ownerBefore.fence_log!.count+1);
      assert.equal(physical.committed_revision,fence.revision+1);
      assert.deepEqual(await cedar.prepare('SELECT * FROM fence').first(),{...fence,revision:physical.committed_revision});
      assert.deepEqual(await cedar.prepare('SELECT * FROM fence_log WHERE revision=?').bind(physical.committed_revision).first(),
        {revision:physical.committed_revision,operation:physical.operation,at:physical.created_at});
      const oldReceipts = (await cedar.prepare('SELECT * FROM receipts').all()).results.filter(value => value.operation_id !== envelope.operation_id);
      assert.equal(digest(oldReceipts.map(value => JSON.stringify(value)).sort()),ownerBefore.receipts!.digest);
      const oldFenceLog = (await cedar.prepare('SELECT * FROM fence_log').all()).results.filter(value => value.revision !== physical.committed_revision);
      assert.equal(digest(oldFenceLog.map(value => JSON.stringify(value)).sort()),ownerBefore.fence_log!.digest);
      const finalHistory = await jobs.historyFor(jobModelName,asRecordId(jobId));
      assert.deepEqual(finalHistory.slice(0,history.length),history);
      assert.equal(finalHistory.length,history.length+changed.length);
      if (changed.length) {
        const net = finalHistory.at(-1)!;
        assert.equal(net.operation,envelope.operation); assert.equal(net.operationId,envelope.operation_id);
        assert.equal(net.actor,ava.principal); assert.equal(net.version,entry.version+1);
        assert.deepEqual(net.before,entry.data); assert.deepEqual(net.after,final.data);
      }
      assert.equal(JSON.stringify(fresh.body).includes('scenario-result/v1'),false);
      machineSaved.push({envelope,physical,records:fresh.body.records!,expected:fresh.body.result,jobId,rowDependent:selected.dependencies.length>0});
      return {entry,final,fresh,physical,outcome,association,selected,observations,changed};
    }
    // Two real stages expose the issued intermediate snapshot and one final
    // owner write/version/history entry through this same portable execution.
    const advancedId = operationId(); await commit(ava,`${jobModel}.create`,{private_choice:false},advancedId);
    const advanced = await machineCall('advance',advancedId);
    assert.equal(advanced.entry.data.status,'idle'); assert.equal(advanced.final.data.status,'generating');
    assert.equal(advanced.final.version,2); assert.equal(advanced.changed.length,1);
    assert.equal(advanced.selected.dependencies.length,2);
    assert.equal(new Set(advanced.selected.dependencies.map(value => value.id)).size,2);
    assert.ok(advanced.selected.dependencies.every(value => value.field === 'status' && value.role === 'control'));
    assert.deepEqual(advanced.observations.map(value => object(object(value.row).data).status),['idle','queued']);
    assert.deepEqual(advanced.observations.map(value => object(value.row).version),[1,2]);
    assert.deepEqual(advanced.observations[0]!.row,advanced.entry);
    assert.equal(advanced.fresh.body.result,null);
    assert.deepEqual(advanced.fresh.body.records,[{id:advancedId,data:{status:'generating'}}]);
    assert.equal((await readJobs(ben)).find(value => value.id === advancedId)?.data.status,'generating');
    assert.deepEqual(await readJobs(cal),[]);
    // A fresh stale reference refuses; the original receipt still recovers.
    const staleBefore = await resources();
    const stale = await mutation(ava,'NativeSavedScenario.finish',{job:{id:advancedId,version:'1'}});
    assert.equal(stale.body.code,'conflict'); assert.ok(stale.response.status>=400);
    assert.deepEqual(await resources(),staleBefore);
    await machineCall('finish',advancedId);
    assert.equal((await jobs.load(jobModelName,asRecordId(advancedId)))?.data.status,'ready');
    assert.equal((await readJobs(ben)).find(value => value.id === advancedId)?.data.status,'ready');
    // The failed second transition discards the first stage. Only the actual
    // canonical rejected receipt/fence is allowed to change.
    const rollbackId = operationId(); await commit(ava,`${jobModel}.create`,{private_choice:false},rollbackId);
    const rollbackBefore = await resources(), rollbackRow = await jobs.load(jobModelName,asRecordId(rollbackId));
    const rollbackHistory = await jobs.historyFor(jobModelName,asRecordId(rollbackId)), rollbackOperation = operationId();
    const rollbackFence = await cedar.prepare('SELECT * FROM fence').first<{id:number;revision:number}>(); assert.ok(rollbackFence);
    const rollbackInputs = {job:{id:rollbackId,version:'1'}};
    const rolledBack = await mutation(ava,'NativeSavedScenario.rollback',rollbackInputs,rollbackOperation);
    assert.equal(rolledBack.body.code,'rule_failed'); assert.equal(rolledBack.response.status,422);
    assert.deepEqual(await jobs.load(jobModelName,asRecordId(rollbackId)),rollbackRow);
    assert.deepEqual(await jobs.historyFor(jobModelName,asRecordId(rollbackId)),rollbackHistory);
    const rollbackAfter = await resources(), ownerKey = `owner:${ava.owner}`;
    for (const key of Object.keys(rollbackBefore)) if (key !== ownerKey) assert.deepEqual(rollbackAfter[key],rollbackBefore[key]);
    for (const table of Object.keys(rollbackBefore[ownerKey]!)) if (!['receipts','fence','fence_log'].includes(table))
      assert.deepEqual(rollbackAfter[ownerKey]![table],rollbackBefore[ownerKey]![table]);
    assert.equal(rollbackAfter[ownerKey]!.receipts!.count,rollbackBefore[ownerKey]!.receipts!.count+1);
    assert.equal(rollbackAfter[ownerKey]!.fence_log!.count,rollbackBefore[ownerKey]!.fence_log!.count+1);
    const rejected = await receipt(rollbackOperation);
    assert.equal(rejected.operation,'NativeSavedScenario.rollback'); assert.equal(rejected.input_hash,await hashInputs(rollbackInputs));
    assert.deepEqual(JSON.parse(rejected.resolved_defaults),{});
    assert.equal(object(JSON.parse(rejected.outcome)).status,'rejected');
    assert.equal(object(JSON.parse(rejected.outcome)).code,'rule_failed');
    assert.equal(rejected.committed_revision,rollbackFence.revision+1);
    assert.deepEqual(await cedar.prepare('SELECT * FROM fence').first(),{...rollbackFence,revision:rejected.committed_revision});
    assert.deepEqual(await cedar.prepare('SELECT * FROM fence_log WHERE revision=?').bind(rejected.committed_revision).first(),
      {revision:rejected.committed_revision,operation:rejected.operation,at:rejected.created_at});
    const priorReceipts = (await cedar.prepare('SELECT * FROM receipts').all()).results.filter(value => value.operation_id !== rollbackOperation);
    assert.equal(digest(priorReceipts.map(value => JSON.stringify(value)).sort()),rollbackBefore[ownerKey]!.receipts!.digest);
    const priorFenceLog = (await cedar.prepare('SELECT * FROM fence_log').all()).results.filter(value => value.revision !== rejected.committed_revision);
    assert.equal(digest(priorFenceLog.map(value => JSON.stringify(value)).sort()),rollbackBefore[ownerKey]!.fence_log!.digest);
    // The private control is required on both write/no-write paths, for void
    // and scalar returns. Protected receipts retain facts; public output hides
    // the scalar and every changed record rather than revealing that choice.
    for (const name of ['optional','optional_scalar']) for (const choice of [true,false]) {
      const jobId = operationId(); await commit(ava,`${jobModel}.create`,{private_choice:choice},jobId);
      const optional = await machineCall(name,jobId);
      assert.equal(optional.final.data.status,choice?'ready':'idle'); assert.equal(optional.final.version,choice?2:1);
      assert.equal(optional.selected.dependencies.length,choice?2:1);
      assert.equal(optional.selected.dependencies[0]!.field,'private_choice');
      assert.equal(object(object(optional.observations[0]!.row).data).private_choice,choice);
      assert.deepEqual(optional.observations[0]!.row,optional.entry);
      assert.equal(optional.changed.length,choice?1:0);
      assert.equal(optional.outcome.result,name==='optional_scalar'?'7':null);
      assert.equal(optional.fresh.body.result,null); assert.deepEqual(optional.fresh.body.records,[]);
    }
    // State owns the admitted literal/null/computed union. Generated callbacks
    // contribute only after actual native value/reference checks; overrides
    // do not become defaults. These use the same source, capture and stores.
    for (const omitted of [true,false]) {
      const jobId=operationId(); await commit(ava,`${jobModel}.create`,{private_choice:false},jobId);
      const inputs={job:{id:jobId,version:'1'},...(omitted?{}:{selected:false,optional:null})};
      const outcome=await machineCall('default_scalar',jobId,inputs,omitted?{selected:true,optional:null}:{});
      assert.equal(outcome.final.data.status,omitted?'ready':'idle'); assert.equal(outcome.final.version,omitted?2:1);
      assert.equal(outcome.fresh.body.result,'7'); assert.equal(outcome.selected.dependencies.length,omitted?1:0);
      assert.equal(outcome.fresh.body.records!.length,omitted?1:0);
    }
    for (const [choice,override] of [[true,undefined],[false,undefined],[false,true]] as const) {
      const jobId=operationId(); await commit(ava,`${jobModel}.create`,{private_choice:false},jobId);
      const inputs={job:{id:jobId,version:'1'},choice,...(override===undefined?{}:{selected:override})};
      const outcome=await machineCall('computed_scalar',jobId,inputs,override===undefined?{selected:choice}:{});
      const selected=override ?? choice;
      assert.equal(outcome.final.data.status,selected?'ready':'idle'); assert.equal(outcome.final.version,selected?2:1);
      assert.equal(outcome.fresh.body.result,'7'); assert.equal(outcome.selected.dependencies.length,selected?1:0);
      assert.equal(outcome.fresh.body.records!.length,selected?1:0);
    }
    for (const omitted of [true,false]) {
      const jobId=operationId(); await commit(ava,`${jobModel}.create`,{private_choice:false},jobId);
      const ref={id:jobId,version:'1'}, inputs={seed:ref,...(omitted?{}:{job:ref})};
      const outcome=await machineCall('default_reference',jobId,inputs,omitted?{job:ref}:{});
      assert.equal(outcome.final.data.status,'ready'); assert.equal(outcome.final.version,2);
      assert.equal(outcome.fresh.body.result,null); assert.equal(outcome.selected.dependencies.length,1);
      assert.deepEqual(outcome.observations[0]!.row,outcome.entry);
      assert.deepEqual(outcome.fresh.body.records,[{id:jobId,data:{status:'ready'}}]);
    }
    // Grouped stored reads execute in declaration order before prior default
    // bindings are consumed. Private influence withholds BOTH branches;
    // explicit prior/final overrides never read that private field.
    for (const choice of [true,false]) for (const mode of ['omitted','prior','both'] as const) {
      const jobId=operationId(); await commit(ava,`${jobModel}.create`,{private_choice:choice},jobId);
      const selected=mode==='omitted'?choice:!choice;
      const inputs={job:{id:jobId,version:'1'},...(mode==='omitted'?{}:{first:selected}),...(mode==='both'?{selected}: {})};
      const defaults=mode==='omitted'?{first:choice,selected:choice}:mode==='prior'?{selected}:{};
      const outcome=await machineCall('stored_private_scalar',jobId,inputs,defaults);
      assert.equal(outcome.final.data.status,selected?'ready':'idle'); assert.equal(outcome.final.version,selected?2:1);
      const fields=[...(mode==='omitted'?['private_choice']:[]),...(selected?['status']:[])];
      assert.deepEqual(outcome.selected.dependencies.map(value => value.field),fields);
      assert.deepEqual(outcome.observations.map(value => value.row),fields.map(() => outcome.entry));
      assert.equal(outcome.outcome.result,'7'); assert.equal(outcome.changed.length,selected?1:0);
      assert.equal(outcome.fresh.body.result,mode==='omitted'?null:'7');
      assert.deepEqual(outcome.fresh.body.records,mode!=='omitted'&&selected?[{id:jobId,data:{status:'ready'}}]:[]);
    }
    const publicDefaultReturns: string[]=[];
    for (const optional of [null,'2','0']) {
      const current=await row(id); assert.ok(current);
      await commit(ben,`${model}.update`,{record:{id,version:String(current.version)},optional});
      const admitted=await row(id); assert.ok(admitted);
      const jobId=operationId(); await commit(ava,`${jobModel}.create`,{private_choice:false},jobId);
      const selected=optional??'0', inputs={job:{id:jobId,version:'1'},item:{id,version:String(admitted.version)}};
      const outcome=await machineCall('stored_public_scalar',jobId,inputs,{first:selected,selected});
      const writes=selected!=='0';
      assert.equal(outcome.final.data.status,writes?'ready':'idle'); assert.equal(outcome.final.version,writes?2:1);
      assert.equal(outcome.fresh.body.result,'7'); assert.equal(outcome.changed.length,writes?1:0);
      assert.deepEqual(outcome.fresh.body.records,writes?[{id:jobId,data:{status:'ready'}}]:[]);
      assert.deepEqual(outcome.selected.dependencies.map(value => value.field),['optional',...(writes?['status']:[])]);
      assert.equal(object(object(outcome.observations[0]!.row).data).optional,optional);
      publicDefaultReturns.push(outcome.selected.id);
    }
    assert.notEqual(publicDefaultReturns[0],publicDefaultReturns[2],'coalesce RHS and skipped RHS have distinct source-carried paths');
    for (const supplied of [{first:'3'},{first:'9',selected:'0'}]) {
      const admitted=await row(id); assert.ok(admitted);
      const jobId=operationId(); await commit(ava,`${jobModel}.create`,{private_choice:false},jobId);
      const inputs={job:{id:jobId,version:'1'},item:{id,version:String(admitted.version)},...supplied};
      const selected=supplied.selected??supplied.first;
      const outcome=await machineCall('stored_public_scalar',jobId,inputs,supplied.selected===undefined?{selected}:{});
      const writes=selected!=='0';
      assert.equal(outcome.final.data.status,writes?'ready':'idle'); assert.equal(outcome.final.version,writes?2:1);
      assert.equal(outcome.fresh.body.result,'7');
      assert.deepEqual(outcome.selected.dependencies.map(value => value.field),writes?['status']:[],
        'explicit header bypasses the stored read, while only omitted later defaults contribute');
      assert.deepEqual(outcome.observations.map(value => value.row),writes?[outcome.entry]:[]);
    }
    assert.equal(machineSaved.length,24,'retain six transitions, seven previous defaults and eleven stored-read/default overrides');
    const defaultWitnesses = ['default_scalar','computed_scalar','default_reference','stored_private_scalar','stored_public_scalar'].map(name => {
      const witness=machineSaved.find(value => value.envelope.operation === `NativeSavedScenario.${name}`); assert.ok(witness);
      return witness;
    });
    for (const witness of defaultWitnesses) {
      const defaults=object(JSON.parse(witness.physical.resolved_defaults));
      const supplied={...witness.envelope.inputs,...defaults};
      const before=await resources();
      const ordinary=await mutation(ava,witness.envelope.operation,supplied,witness.envelope.operation_id);
      assert.equal(ordinary.body.code,'conflict'); assert.ok(ordinary.response.status>=400);
      const retained=await recovery(ava,{...witness.envelope,inputs:supplied});
      assert.equal(object(retained.error).code,'conflict','same resolved value never erases original raw omission');
      assert.deepEqual(await resources(),before); assert.deepEqual(await receipt(witness.envelope.operation_id),witness.physical);
    }
    // Later physical changes invalidate the original supplied refs. Recovery
    // must use the frozen receipt/default observations without fresh execution.
    for (const witness of machineSaved.filter(value => value.envelope.operation.includes('.stored_'))) {
      const current=await jobs.load(jobModelName,asRecordId(witness.jobId)); assert.ok(current);
      await commit(ben,`${jobModel}.update`,{record:{id:witness.jobId,version:String(current.version)},private_choice:!current.data.private_choice});
    }
    const beforeMachineReplay = await resources();
    for (const value of machineSaved) {
      const ordinary = await mutation(ava,value.envelope.operation,value.envelope.inputs,value.envelope.operation_id);
      assert.equal(ordinary.body.status,'replayed'); assert.deepEqual(ordinary.body.result,value.expected);
      assert.deepEqual(ordinary.body.records,value.records);
      const retained = await recovery(ava,value.envelope), replay = object(retained.result);
      assert.equal(replay.status,'replayed'); assert.deepEqual(replay.result,value.expected);
      // Dedicated recovery returns the full public record metadata; compare
      // its declared visible data against the actual HTTP projection.
      assert.ok(Array.isArray(replay.records));
      assert.deepEqual(replay.records.map(value => {const record=object(value);return {id:record.id,data:record.data};}),value.records);
      assert.equal(JSON.stringify({ordinary:ordinary.body,retained}).includes('scenario-result/v1'),false);
      assert.deepEqual(await receipt(value.envelope.operation_id),value.physical);
    }
    assert.deepEqual(await resources(),beforeMachineReplay);
    const machineWitness = machineSaved[0]!;
    for (const actor of [cal,dee,null]) {
      const before = await resources(), denied = await recovery(actor,machineWitness.envelope);
      assert.ok(denied.error); assert.deepEqual(await resources(),before);
      const refused = await mutation(actor,machineWitness.envelope.operation,machineWitness.envelope.inputs);
      assert.ok(refused.response.status>=400); assert.deepEqual(await resources(),before);
    }
    for (const control of ['issuer-copy','source-change','js-change','map-change']) {
      const before = await resources(), refused = await recovery(ava,machineWitness.envelope,control);
      assert.ok(refused.error); assert.deepEqual(await resources(),before);
    }
    const derivedWitness = saved.find(value => value.envelope.operation === 'NativeSavedScenario.nested'); assert.ok(derivedWitness);
    const authorityWitnesses = [saved[0]!,derivedWitness];
    for(const witness of authorityWitnesses) for(const actor of [cal,dee,null]) {
      const before=await resources(), denied=await recovery(actor,witness.envelope);
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
    await commit(ben,`${model}.update`,{record:{id,version:String(current.version)},quantity:'99',available:false,optional:'2',values:['11'],flags:[false],names:['changed']});
    const updated = (await read(ben))[0]; assert.ok(updated);
    assert.equal(updated.data.quantity,'99'); assert.deepEqual(updated.data.values,['11']);
    assert.deepEqual(updated.data.flags,[false]); assert.deepEqual(updated.data.names,['changed']);
    const beforeReplay=await resources();
    for(const value of saved) {
      const ordinary=await mutation(ava,value.envelope.operation,value.envelope.inputs,value.envelope.operation_id);
      assert.equal(ordinary.body.status,'replayed'); assert.deepEqual(ordinary.body.result,value.expected);
      const retained=await recovery(ava,value.envelope); assert.deepEqual(object(retained.result).result,value.expected);
      assert.deepEqual(await receipt(value.envelope.operation_id),value.physical);
      // Fresh source would now return changed scalar/array values; old refs are stale.
      // Exact original wire values and full stores prove no fresh execution or commit.
    }
    assert.deepEqual(await resources(),beforeReplay);
    for(const value of authorityWitnesses) for(const control of ['issuer-copy','source-change','js-change','map-change']) {
      const before=await resources(), refused=await recovery(ava,value.envelope,control);
      assert.ok(refused.error,'current source/issuer correspondence must refuse');
      assert.deepEqual(await resources(),before);
    }
    for(const witness of authorityWitnesses) for(const actor of [cal,dee,null]) {
      const before=await resources();
      const refused=await mutation(actor,witness.envelope.operation,witness.envelope.inputs);
      assert.ok(refused.response.status>=400); assert.deepEqual(await resources(),before);
    }
    const live=await row(id); assert.ok(live);
    await commit(ava,`${model}.delete`,{record:{id,version:String(live.version)}});
    assert.deepEqual(await read(ben),[]);
    for (const jobId of new Set(machineSaved.map(value => value.jobId))) {
      const current = await jobs.load(jobModelName,asRecordId(jobId)); assert.ok(current);
      await commit(ava,`${jobModel}.delete`,{record:{id:jobId,version:String(current.version)}});
    }
    const beforeWithheld=await resources();
    for(const value of saved) {
      const ordinary=await mutation(ava,value.envelope.operation,value.envelope.inputs,value.envelope.operation_id);
      assert.equal(ordinary.body.status,'replayed'); assert.deepEqual(ordinary.body.result,value.rowDependent ? null : value.expected); assert.deepEqual(ordinary.body.records,[]);
      const retained=await recovery(ava,value.envelope); assert.deepEqual(object(retained.result).result,value.rowDependent ? null : value.expected);
      assert.deepEqual(await receipt(value.envelope.operation_id),value.physical);
    }
    for (const value of machineSaved) {
      const ordinary = await mutation(ava,value.envelope.operation,value.envelope.inputs,value.envelope.operation_id);
      assert.equal(ordinary.body.status,'replayed'); assert.deepEqual(ordinary.body.result,value.rowDependent?null:value.expected); assert.deepEqual(ordinary.body.records,[]);
      const retained = await recovery(ava,value.envelope), replay = object(retained.result);
      assert.equal(replay.status,'replayed'); assert.deepEqual(replay.result,value.rowDependent?null:value.expected); assert.deepEqual(replay.records,[]);
      assert.deepEqual(await receipt(value.envelope.operation_id),value.physical);
    }
    assert.deepEqual(await resources(),beforeWithheld);
    const identityStore=createD1IdentityStore(identityDb);
    const membership=await identityStore.findMembership(ava.owner,ava.principal); assert.ok(membership);
    await identityStore.removeMembership(membership.membership_id);
    const beforeRevoked=await resources();
    const pureOverride = saved.find(value => value.envelope.operation === 'NativeSavedScenario.derived_override'); assert.ok(pureOverride);
    for (const witness of [...authorityWitnesses, pureOverride, machineWitness, ...defaultWitnesses]) {
      const revoked=await recovery(ava,witness.envelope); assert.equal(object(revoked.error).code,'forbidden');
    }
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
