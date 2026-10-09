/** Actual native source -> installed portable bundle -> workerd and owner D1. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import type { ActivationVerdict, ClosedInputs, CompileArtifact } from '@canlang/contracts';
import type { D1Database } from '@cloudflare/workers-types';
import { deriveCsrfToken } from '@canlang/identity';
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
import { buildDeployBundle, writeDeployBundle, writeDeployBundleWithAssets } from '../deploy/bundle.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const model = 'NativeLocalRules.Item';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function operationId(): string {
  const time = Date.now().toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0,8)}-${time.slice(8)}-7${random.slice(0,3)}-8${random.slice(4,7)}-${random.slice(7,19)}`;
}
interface ItemData { quantity: string; label: string; locked: boolean; state: 'open' | 'closed' }
interface Projection { id: string; data: ItemData }
interface MutationWire { status?: string; code?: string; records?: Projection[] }
interface McpWire { error?: { code: number | string }; result?: { isError?: boolean; structuredContent?: { records?: Projection[] } } }
interface StoredRow { id: string; version: number; data: string }
interface ReceiptRow { app: string; owner: string; principal: string; operation: string; operation_id: string;
  input_hash: string; resolved_defaults: string; outcome: string; committed_revision: number; created_at: number }
interface FenceRow { id: number; revision: number }
interface FenceLogRow { revision: number; operation: string; at: number }
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
  assert.equal(typeof data.locked, 'boolean'); assert.ok(data.state === 'open' || data.state === 'closed');
  return { id: word(row.id), data: { quantity: word(data.quantity), label: word(data.label),
    locked: data.locked as boolean, state: data.state as 'open' | 'closed' } };
}
function mutationWire(value: unknown): MutationWire {
  const body = object(value);
  if (body.records !== undefined) assert.ok(Array.isArray(body.records));
  return { ...(body.status === undefined ? {} : { status: word(body.status) }),
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

it('consumes captured native rules through real portable owner D1, auth and MCP', { timeout: 180000 }, async () => {
  let worker: LocalDev | undefined, bridge: ProtectedPreview | undefined, provisioning: LocalDev | undefined;
  let persistence: string | undefined;
  let capture: Awaited<ReturnType<typeof captureSingleFileSource>> | undefined;
  try {
    capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root,
      appPath: join(root, 'tests/integration/can-dev-server/NativeLocalRules.can'),
      compilerPath: join(root, 'compiler/target/debug/can'), catalogPath: fileURLToPath(distribution.catalog),
      helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
    assert.equal(await captureIsCurrent(capture), true);
    const compiled = await compileCapturedSingleFile(capture);
    assert.equal(compiled.kind, 'artifact');
    if (compiled.kind !== 'artifact') throw new Error('Native policy fixture did not compile');
    const artifact: CompileArtifact = compiled.artifact;
    assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
    assert.equal(artifact.pages.length, 0, 'fixture has no page; no page readiness is claimed');
    assert.equal(artifact.models?.find(item => item.name === model)?.deleteMode, 'remove');
    assert.equal(artifact.modelPolicies?.[0]?.abi, 'state.owner-model-policies@1');
    assert.deepEqual(artifact.modelPolicies?.[0]?.rules.map(rule => [rule.kind, rule.id]), [
      ['invariant', `${model}.require.1`], ['lock', `${model}.lock.1`], ['invariant', `${model}.require.2`],
    ]);

    const preflight = await preflightLocalPreviewActivation(artifact, capture);
    assert.equal(preflight.active, true, 'real preflight activation must qualify this native profile');
    if (!preflight.active) throw new Error('NativeLocalRules real preflight refused');
    const evidence = await produceInstalledPortableBundle({ artifact, capture,
      verdict: preflight as ActivationVerdict & { active: true }, assets: { browser: true, valuesWasm: true } });
    assert.equal(evidence.captureEpochMaterial, capture.epochMaterial);
    assert.equal(evidence.artifactJsonSha256, digest(artifact));
    assert.equal(await captureIsCurrent(capture), true);

    // Test only the real generated host's private capability; no test issuer,
    // request option or URL map registers authority. The application below
    // still uses the complete unmodified installed Worker/D1 bundle.
    const entry = artifact.modules[0]!.path;
    const controls = await startLocalDev({ workerName: `native-capability-${randomUUID()}`,
      compatibilityDate: PINNED_COMPATIBILITY_DATE, mainModule: 'worker/capability-controls.js',
      binaryModules: evidence.bundle.binaries,
      modules: { ...evidence.bundle.modules, 'worker/capability-controls.js': `
        import { artifact, modules } from './artifact.js';
        import { importVerifiedAssemblyModule } from '../runtime/assembly-verification.js';
        export default { async fetch() {
          const path = ${JSON.stringify(entry)}, facts = {};
          const original = await importVerifiedAssemblyModule(modules, path, artifact);
          facts.nativeBinding = typeof original.canApp === 'function';
          async function refuses(label, fn, expected) {
            try { await fn(); facts[label] = false; }
            catch (error) { facts[label] = expected.test(String(error.message)); }
          }
          await refuses('copiedAssembly', () => importVerifiedAssemblyModule({ ...modules }, path, artifact), /not assembler-owned/);
          await refuses('unknownPath', () => importVerifiedAssemblyModule(modules, '__missing_module__.js', artifact), /unknown artifact module/);
          for (const member of ['sources', 'js', 'map', 'policies']) {
            const changed = JSON.parse(JSON.stringify(artifact));
            if (member === 'sources') changed.sources[0].sha256 = '0'.repeat(64);
            if (member === 'js') changed.modules[0].js += '\\n';
            if (member === 'map') changed.modules[0].map.names.push('changed');
            if (member === 'policies') changed.modelPolicies[0].rules[0].id += '.changed';
            await refuses(member, () => importVerifiedAssemblyModule(modules, path, changed), /artifact differs/);
          }
          await refuses('frozenGraph', async () => { modules.moduleUrls[path] = '../other.js'; }, /read only|readonly|not writable|Cannot assign/);
          await refuses('frozenArtifact', async () => { artifact.modules[0].js += '\\n'; }, /read only|readonly|not writable|Cannot assign/);
          facts.currentOriginal = (await importVerifiedAssemblyModule(modules, path, artifact)) === original;
          return Response.json(facts);
        } };
      ` } });
    try {
      const response = await controls.dispatch('/');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { nativeBinding: true, copiedAssembly: true, unknownPath: true,
        sources: true, js: true, map: true, policies: true, frozenGraph: true, frozenArtifact: true, currentOriginal: true });
    } finally { await controls.dispose(); }
    // Plain publication must bind the same real native source and verdict;
    // changing staged application code cannot retain the frozen host's authority.
    const plain = buildDeployBundle(artifact, { verdict: preflight });
    const plainOutput = await mkdtemp(join(tmpdir(), 'can-native-plain-bundle-'));
    try {
      const changedPlain = { ...plain, modules: { ...plain.modules,
        [entry]: `${plain.modules[entry]}\n// changed native application bytes` } };
      assert.throws(() => writeDeployBundle(changedPlain, plainOutput), /text digest mismatch/);
      assert.deepEqual(await readdir(plainOutput), [], 'plain changed native code refuses before any file output');
      const written = writeDeployBundle(plain, plainOutput);
      assert.equal(written.mainFile, join(plainOutput, plain.mainModule));
      const manifest = JSON.parse(await readFile(join(plainOutput, 'bundle.json'), 'utf8')) as {
        sha256: string; moduleCount: number; modules: { key: string; bytes: number }[] };
      assert.equal(manifest.sha256, plain.sha256);
      assert.equal(manifest.moduleCount, Object.keys(plain.modules).length);
      assert.deepEqual(manifest.modules.map(row => row.key), Object.keys(plain.modules).sort());
      for (const [key, text] of Object.entries(plain.modules))
        assert.equal(await readFile(join(plainOutput, key), 'utf8'), text, `exact checked native graph ${key}`);
    } finally { await rm(plainOutput, { recursive: true, force: true }); }

    const refusedOutput = await mkdtemp(join(tmpdir(), 'can-native-stale-bundle-'));
    try {
      const changed = { ...evidence.bundle, modules: { ...evidence.bundle.modules,
        [entry]: `${evidence.bundle.modules[entry]}\n` } };
      assert.throws(() => writeDeployBundleWithAssets(changed, refusedOutput), /mixed digest mismatch/);
      assert.deepEqual(await readdir(refusedOutput), [], 'changed installed module bytes refuse before output');
    } finally { await rm(refusedOutput, { recursive: true, force: true }); }

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
      compatibilityDate: PINNED_COMPATIBILITY_DATE, mainModule: evidence.bundle.mainModule,
      modules: evidence.bundle.modules, binaryModules: evidence.bundle.binaries,
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
    const bookkeeping = new Set(['receipts','fence','fence_log']);
    const domain = (snapshot: Awaited<ReturnType<typeof tables>>) => Object.fromEntries(Object.entries(snapshot).filter(([name]) => !bookkeeping.has(name)));
    async function mutation(actor: Actor | null, kind: string, inputs: ClosedInputs, id=operationId()) {
      const response = await request(actor, `/api/operations/${model}.${kind}`, { operation_id: id, inputs });
      return { response, body: mutationWire(await response.json()), id };
    }
    async function commit(actor: Actor, kind: string, inputs: ClosedInputs, id?: string) {
      const result = await mutation(actor, kind, inputs, id);
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
    async function update(id: string, changes: Record<string, unknown>) {
      const stored = await row(id); assert.ok(stored);
      return commit(ben, 'update', { record: { id, version:String(stored.version) }, ...changes });
    }
    async function ruleRefusal(kind: string, inputs: ClosedInputs) {
      const allBefore = await resources(), ownerKey = `owner:${ava.owner}`, before = allBefore[ownerKey]!, id = operationId();
      const revision = await cedar.prepare('SELECT * FROM fence').first<FenceRow>(); assert.ok(revision);
      assert.equal(revision.id, 1); assert.ok(Number.isSafeInteger(revision.revision));
      const refused = await mutation(ava, kind, inputs, id);
      assert.equal(refused.response.status, 422); assert.equal(refused.body.code, 'rule_failed');
      const allAfter = await resources(), after = allAfter[ownerKey]!;
      assert.deepEqual(Object.keys(allAfter).sort(), Object.keys(allBefore).sort());
      for (const key of Object.keys(allBefore)) if (key !== ownerKey)
        assert.deepEqual(allAfter[key], allBefore[key], `${key}: every table and bookkeeping unchanged`);
      assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
      assert.deepEqual(domain(after), domain(before), 'invoking owner domain/history/effects unchanged');
      assert.equal(after.receipts!.count, before.receipts!.count+1);
      assert.equal(after.fence_log!.count, before.fence_log!.count+1);
      const receipt = await cedar.prepare('SELECT * FROM receipts WHERE operation_id=?').bind(id).first<ReceiptRow>(); assert.ok(receipt);
      assert.equal(receipt.operation_id, id); assert.ok(Number.isSafeInteger(receipt.created_at));
      assert.ok(Number.isSafeInteger(receipt.committed_revision));
      assert.equal(receipt.app, 'NativeLocalRules'); assert.equal(receipt.owner, ava.owner); assert.equal(receipt.principal, ava.principal);
      assert.equal(receipt.operation, `${model}.${kind}`); assert.equal(receipt.input_hash, await hashInputs(inputs));
      assert.deepEqual(JSON.parse(receipt.resolved_defaults), {});
      const outcome = object(JSON.parse(receipt.outcome)); assert.equal(outcome.status, 'rejected'); assert.equal(outcome.code, 'rule_failed');
      assert.equal(receipt.committed_revision, revision.revision+1);
      assert.equal(after.fence!.count, before.fence!.count);
      assert.deepEqual(await cedar.prepare('SELECT * FROM fence').first<FenceRow>(),
        { ...revision, revision: receipt.committed_revision }, 'only invoking singleton fence revision increments');
      const fence = await cedar.prepare('SELECT * FROM fence_log WHERE revision=?').bind(receipt.committed_revision).first<FenceLogRow>();
      assert.deepEqual(fence, { revision: receipt.committed_revision, operation: receipt.operation, at: receipt.created_at });
      const oldReceipts = (await cedar.prepare('SELECT * FROM receipts').all()).results
        .filter(item => item.operation_id !== id);
      assert.equal(digest(oldReceipts.map(item => JSON.stringify(item)).sort()), before.receipts!.digest,
        'pre-existing receipts unchanged');
      const oldFenceLog = (await cedar.prepare('SELECT * FROM fence_log').all()).results
        .filter(item => item.revision !== receipt.committed_revision);
      assert.equal(digest(oldFenceLog.map(item => JSON.stringify(item)).sort()), before.fence_log!.digest,
        'pre-existing fence log unchanged');
      const changed = Object.keys(after).filter(name => digest(after[name]) !== digest(before[name]));
      assert.deepEqual(changed.sort(), ['fence', 'fence_log', 'receipts'],
        'only invoking owner exact canonical rejection bookkeeping changes');
    }

    const id = operationId(), inputs = { quantity:'9223372036854775807', label:'large open item' };
    const created = await commit(ava, 'create', inputs, id);
    assert.deepEqual((await row(id))!.data, { ...inputs, locked:false, state:'open' });
    const saved = await tables(cedar), replay = await mutation(ava, 'create', inputs, id);
    assert.equal(replay.response.status, 200); assert.equal(replay.body.status, 'replayed');
    assert.deepEqual(replay.body.records, created.body.records); assert.deepEqual(await tables(cedar), saved);
    assert.ok((await read(ben)).some(item => item.id===id && item.data.quantity===inputs.quantity));
    await ruleRefusal('create', { quantity:'-1', label:'first invariant' });
    await ruleRefusal('create', { quantity:'101', label:'second invariant', state:'closed' });
    await update(id, { quantity:'100', state:'closed' });
    await ruleRefusal('update', { record:{ id, version:String((await row(id))!.version) }, quantity:'101' });
    await update(id, { locked:true }); await update(id, { quantity:'7' }); await update(id, { label:inputs.label });
    await ruleRefusal('update', { record:{ id, version:String((await row(id))!.version) }, label:'changed', locked:false });
    await update(id, { locked:false }); await update(id, { label:'changed' }); await update(id, { locked:true });
    await ruleRefusal('delete', { record:{ id, version:String((await row(id))!.version) } });
    await update(id, { locked:false });
    await commit(ava, 'delete', { record:{ id, version:String((await row(id))!.version) } });
    assert.equal(await row(id), null); assert.deepEqual(await read(ben), []);

    const shared = operationId(); await commit(ava, 'create', { quantity:'1', label:'Cedar' }, shared);
    assert.deepEqual(await read(cal), []);
    await commit(cal, 'create', { quantity:'2', label:'Oak' });
    assert.equal((await read(cal)).length, 1); assert.equal((await read(ben)).length, 1);
    for (const actor of [cal, dee, null]) {
      const before = await resources();
      const denied = await mutation(actor, 'update', { record:{ id:shared, version:String((await row(shared))!.version) }, label:'unauthorized' });
      assert.ok(denied.response.status>=400, 'cross-team/nonmember/public mutation refused');
      assert.deepEqual(await resources(), before,
        'pre-engine authority denial changes no Identity/owner table, receipt, revision, history or effect');
    }
    const beforeGrant = await resources();
    const grant = await request(dee, '/mcp/grants', { client_id:'native-rules-denied-read' });
    if (grant.status === 401 || grant.status === 403) {
      const admission = object(await grant.json()); assert.ok(word(admission.error), 'actual grant admission error');
      if (grant.status === 403) assert.equal(admission.error, 'mcp-grant needs an active team membership');
      assert.deepEqual(await resources(), beforeGrant, 'denied nonmember grant is an admission refusal with zero writes');
      // No anonymous read is mislabeled as Dee: actual grant admission already refused her.
    } else {
      assert.equal(grant.status, 200); dee.grant = word(object(await grant.json()).token); assert.ok(dee.grant);
      const before = await resources(); // grant provisioning is intentionally outside read-purity snapshot
      const response = await request(dee, '/mcp', { jsonrpc:'2.0', id:2, method:'tools/call',
        params:{ name:`${model}.read`, arguments:{} } }, dee.grant);
      const body = mcpWire(await response.json());
      assert.ok(response.status>=400 || body.error || body.result?.isError===true,
        'actual authenticated nonmember declared read refused');
      assert.deepEqual(await resources(), before, 'Dee read denial changes no admitted resource');
    }
    const beforePublicRead = await resources();
    const publicRead = await request(null, '/mcp', { jsonrpc:'2.0', id:3, method:'tools/call',
      params:{ name:`${model}.read`, arguments:{} } });
    assert.ok(publicRead.status === 401 || publicRead.status === 403, 'public MCP admission refused');
    const publicAdmission = object(object(await publicRead.json()).error);
    assert.equal(publicAdmission.code, 'forbidden'); assert.equal(publicAdmission.message, 'Authentication required.');
    assert.deepEqual(await resources(), beforePublicRead, 'public read admission changes no admitted resource');
    assert.equal(await captureIsCurrent(capture), true);
  } finally {
    try { await bridge?.close(); }
    finally { try { await worker?.dispose(); }
      finally { try { await provisioning?.dispose(); }
        finally { if (persistence) await rm(persistence,{recursive:true,force:true});
          if (capture) assert.equal(await captureIsCurrent(capture),true,'finish source-current'); } } }
  }
});
