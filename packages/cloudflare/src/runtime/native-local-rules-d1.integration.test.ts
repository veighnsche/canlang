/** Actual native source -> installed portable bundle -> workerd and owner D1. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import type { ActivationVerdict, ClosedInputs, CompileArtifact } from '@canlang/contracts';
import type { D1Database } from '@cloudflare/workers-types';
import { deriveCsrfToken } from '@canlang/identity';
import { hashInputs } from '@canlang/state/invocation/replay';
import { distribution } from '@canlang/values/distribution';
import { prepareLocalPreviewCapture } from './native-dev.test-support.js';
import { captureIsCurrent, captureSingleFileSource, verifyCompilerSources } from './native-dev.test-support.js';
import { compileCapturedSingleFile } from './native-dev.test-support.js';
import { selectPreviewWorkerVars, type LocalPreviewSeed, localPreviewActivationVerdict,
  seedLocalPreviewActors, nativePreviewEvidence, openNativePreview, startLocalDev, type LocalDev,
  startNativeGateway, type ProtectedPreview } from './native-preview.test-support.js';
import { PINNED_COMPATIBILITY_DATE } from '../cli/artifact-defaults.js';
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
  // Create/update failures include retry data; delete failures use the plain BusinessError.
  const error = body.retry === undefined ? body : object(body.error);
  if (error.code !== undefined) { word(error.message); assert.equal(error.retryable, false); }
  if (body.records !== undefined) assert.ok(Array.isArray(body.records));
  return { ...(body.status === undefined ? {} : { status: word(body.status) }),
    ...(error.code === undefined ? {} : { code: word(error.code) }),
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

    const { verdict: preflight, ...evidence } = await nativePreviewEvidence(artifact, capture);
    assert.equal(preflight.active, true, 'real preflight activation must qualify this native profile');
    if (!preflight.active) throw new Error('NativeLocalRules real preflight refused');
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
    const plainOutput = await realpath(await mkdtemp(join(tmpdir(), 'can-native-plain-bundle-')));
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

    const refusedOutput = await realpath(await mkdtemp(join(tmpdir(), 'can-native-stale-bundle-')));
    try {
      const changed = { ...evidence.bundle, modules: { ...evidence.bundle.modules,
        [entry]: `${evidence.bundle.modules[entry]}\n` } };
      assert.throws(() => writeDeployBundleWithAssets(changed, refusedOutput), /mixed digest mismatch/);
      assert.deepEqual(await readdir(refusedOutput), [], 'changed installed module bytes refuse before output');
    } finally { await rm(refusedOutput, { recursive: true, force: true }); }

    bridge = await startNativeGateway();
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
      d1Persist: persistence, vars: { ...await selectPreviewWorkerVars({ resources: { d1: { binding:'DB', availability:'real_local' }, identity: { backingBinding:'DB', availability:'real_local' } } }, origin),
        CAN_STATE_OWNERS: { version: 1, owners: owners.map(item => ({ owner: item.owner,
          binding: item.binding, initializeFresh: true })) } } });
    await bridge.setBackend(worker.backend);
    const identityDb = await worker.getD1Database('DB');
    const dbs = new Map<string, D1Database>();
    for (const owner of owners) {
      const db: D1Database = await worker.getD1Database(owner.binding); dbs.set(owner.owner, db);
      assert.equal((await localPreviewActivationVerdict(artifact, capture, db, owner.id, owner.owner, identityDb)).active,
        true, 'each genuine serving owner D1 must activate');
    }
    assert.equal(await captureIsCurrent(capture), true);

    const bootstrap = await fetch(await bridge.issueOpenUrl(), { redirect: 'manual' });
    assert.equal(bootstrap.status, 303);
    const bridgeCookie = bootstrap.headers.getSetCookie().find(item => item.startsWith('can_dev_preview='))?.split(';',1)[0];
    assert.ok(bridgeCookie);
    const request = (actor: Actor | null, path: string, body?: unknown, token?: string, additionalCookie?: string) => fetch(new URL(path, origin), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual', headers: {
        cookie: [bridgeCookie, actor?.cookie, additionalCookie].filter(Boolean).join('; '), origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(path === '/mcp' ? { accept: 'application/json, text/event-stream' } : {}),
        ...(actor?.csrf ? { 'x-csrf-token': actor.csrf } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    async function login(label: string): Promise<Actor> {
      const seeded = seed.actors.find(item => item.label === label); assert.ok(seeded);
      const descriptor = await request(null, '/auth/login'); assert.equal(descriptor.status, 200);
      const form = object(await descriptor.json());
      const preSessionToken = word(form.preSessionToken);
      const bindings = descriptor.headers.getSetCookie().filter(item => item.startsWith('can_presession='));
      assert.equal(bindings.length, 1);
      const binding = bindings[0]!.split(';', 1)[0]; assert.ok(binding && binding !== 'can_presession=');
      const response = await request(null, '/auth/login', { email: seeded.email, password: seeded.password,
        _presession: preSessionToken }, undefined, binding); assert.equal(response.status, 200);
      const sessions = response.headers.getSetCookie().filter(item => item.startsWith('can_session='));
      assert.equal(sessions.length, 1);
      const cookie = sessions[0]!.split(';',1)[0]; assert.ok(cookie && cookie !== 'can_session=');
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

for (const contextual of [false, true]) it(contextual
  ? 'consumes unchanged native contextual HookOrder with portable D1 attribution, defaults and late rollback'
  : 'consumes unchanged native HookOrder with one portable D1 fence and late staged-Audit rollback', { timeout: 180000 }, async () => {
  const sourcePath = join(root, 'compiler/tests/fixtures', contextual ? 'hook_order_contextual.can' : 'hook_order_rollback.can');
  const originalSource = await readFile(sourcePath, 'utf8');
  if (contextual) assert.equal(createHash('sha256').update(originalSource).digest('hex'),
    '4c4ebefea8e03bd50f59c471608ca534a6ed0ba6d21ad8f3c377b061951970f7', 'exact released owning contextual source');
  const entryModel = 'HookOrder.Entry', auditModel = 'HookOrder.Audit';
  let worker: LocalDev | undefined, bridge: ProtectedPreview | undefined, provisioning: LocalDev | undefined;
  let persistence: string | undefined;
  let capture: Awaited<ReturnType<typeof captureSingleFileSource>> | undefined;
  try {
    capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root, appPath: sourcePath,
      compilerPath: join(root, 'compiler/target/debug/can'), catalogPath: fileURLToPath(distribution.catalog),
      helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
    assert.equal(await captureIsCurrent(capture), true);
    const compiled = await compileCapturedSingleFile(capture);
    assert.equal(compiled.kind, 'artifact', 'the original native HookOrder source must compile');
    if (compiled.kind !== 'artifact') throw new Error('Original HookOrder did not compile');
    const artifact = compiled.artifact, originalArtifact = JSON.stringify(artifact);
    assert.equal(verifyCompilerSources(capture, { complete: true, sources: artifact.sources }).ok, true);
    assert.deepEqual(artifact.sources, [{ path: capture.compilerOperand, sha256: capture.sourceSha256 }]);
    assert.equal(artifact.pages.length, 0);
    const policy = artifact.modelPolicies?.find(item => item.model === entryModel); assert.ok(policy);
    assert.deepEqual(policy.hooks, [{ id: 'HookOrder.adjustEntry', op: 'update', operation: `${entryModel}.update` }]);
    assert.equal(artifact.callables.filter(item => item.id === 'HookOrder.adjustEntry' && item.module === policy.module &&
      item.member.join('.') === 'hooks.HookOrder.Entry.update.run').length, 1);
    const { verdict: preflight, ...evidence } = await nativePreviewEvidence(artifact, capture);
    assert.equal(preflight.active, true, 'actual installed native hook preflight');
    if (!preflight.active) throw new Error('Original HookOrder preflight refused');
    assert.equal(evidence.captureEpochMaterial, capture.epochMaterial);
    assert.equal(evidence.artifactJsonSha256, digest(artifact));
    assert.equal(await captureIsCurrent(capture), true);

    bridge = await startNativeGateway();
    const origin = bridge.url;
    persistence = await mkdtemp(join(tmpdir(), 'can-native-hook-order-d1-'));
    const databaseId = `hook-order-identity-${randomUUID()}`;
    provisioning = await startLocalDev({ workerName: `hook-order-provision-${randomUUID()}`,
      compatibilityDate: PINNED_COMPATIBILITY_DATE, mainModule: 'provision.js',
      modules: { 'provision.js': 'export default {fetch(){return new Response(null,{status:404})}};' },
      d1Databases: [{ binding: 'DB', id: databaseId }], d1Persist: persistence });
    const seed = await seedLocalPreviewActors(await provisioning.getD1Database('DB'));
    await provisioning.dispose(); provisioning = undefined;
    const owners = seed.owners.map(owner => ({ ...owner, id: `hook-order-owner-${randomUUID()}` }));
    worker = await startLocalDev({ workerName: `hook-order-${randomUUID()}`,
      compatibilityDate: PINNED_COMPATIBILITY_DATE, mainModule: evidence.bundle.mainModule,
      modules: evidence.bundle.modules, binaryModules: evidence.bundle.binaries,
      d1Databases: [{ binding: 'DB', id: databaseId }, ...owners.map(owner => ({ binding: owner.binding, id: owner.id }))],
      d1Persist: persistence, vars: { ...await selectPreviewWorkerVars({ resources: {
        d1: { binding: 'DB', availability: 'real_local' }, identity: { backingBinding: 'DB', availability: 'real_local' } } }, origin),
        CAN_STATE_OWNERS: { version: 1, owners: owners.map(owner => ({ owner: owner.owner,
          binding: owner.binding, initializeFresh: true })) } } });
    await bridge.setBackend(worker.backend);
    const identityDb = await worker.getD1Database('DB'), dbs = new Map<string, D1Database>();
    for (const owner of owners) {
      const db: D1Database = await worker.getD1Database(owner.binding); dbs.set(owner.owner, db);
      assert.equal((await localPreviewActivationVerdict(artifact, capture, db, owner.id, owner.owner, identityDb)).active, true);
    }
    assert.equal(dbs.size, 2);
    const bootstrap = await fetch(await bridge.issueOpenUrl(), { redirect: 'manual' }); assert.equal(bootstrap.status, 303);
    const bridgeCookie = bootstrap.headers.getSetCookie().find(item => item.startsWith('can_dev_preview='))?.split(';', 1)[0];
    assert.ok(bridgeCookie);
    const request = (actor: Actor | null, path: string, body?: unknown, token?: string, additionalCookie?: string) => fetch(new URL(path, origin), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'manual', headers: {
        cookie: [bridgeCookie, actor?.cookie, additionalCookie].filter(Boolean).join('; '), origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(path === '/mcp' ? { accept: 'application/json, text/event-stream' } : {}),
        ...(actor ? { 'x-csrf-token': actor.csrf } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const login = async (label: string): Promise<Actor> => {
      const seeded = seed.actors.find(item => item.label === label); assert.ok(seeded);
      const descriptor = await request(null, '/auth/login');
      let bootFailure: string | undefined;
      if (descriptor.status !== 200) {
        const failure = object(await descriptor.clone().json());
        bootFailure = JSON.stringify({ code: typeof failure.code === 'string' ? failure.code : undefined,
          message: typeof failure.message === 'string' ? failure.message.slice(0, 512) : undefined });
      }
      assert.equal(descriptor.status, 200, bootFailure);
      const preSessionToken = word(object(await descriptor.json()).preSessionToken);
      const bindings = descriptor.headers.getSetCookie().filter(item => item.startsWith('can_presession='));
      assert.equal(bindings.length, 1);
      const binding = bindings[0]!.split(';', 1)[0]; assert.ok(binding && binding !== 'can_presession=');
      const response = await request(null, '/auth/login', { email: seeded.email, password: seeded.password,
        _presession: preSessionToken }, undefined, binding); assert.equal(response.status, 200);
      const sessions = response.headers.getSetCookie().filter(item => item.startsWith('can_session='));
      assert.equal(sessions.length, 1);
      const cookie = sessions[0]!.split(';', 1)[0]; assert.ok(cookie && cookie !== 'can_session=');
      const principal = await identityDb.prepare('SELECT user_id FROM identity_users WHERE email_lc=?')
        .bind(seeded.email.toLowerCase()).first<{ user_id: string }>(); assert.ok(principal);
      const actor: Actor = { cookie, csrf: await deriveCsrfToken(decodeURIComponent(cookie.slice('can_session='.length))),
        owner: null, principal: principal.user_id };
      const listing = await request(actor, '/auth/teams'); assert.equal(listing.status, 200);
      const teams = object(await listing.json()); assert.ok(Array.isArray(teams.teams));
      actor.owner = teams.teams.length ? word(object(teams.teams[0]).team_id) : null;
      if (actor.owner) assert.equal((await request(actor, '/auth/select-team', { team: actor.owner, _csrf: actor.csrf })).status, 200);
      return actor;
    };
    const ava = await login('Ava'), ben = await login('Ben'); assert.ok(ava.owner); assert.equal(ben.owner, ava.owner);
    const grant = await request(ben, '/mcp/grants', { client_id: 'native-hook-order-d1-test' }); assert.equal(grant.status, 200);
    ben.grant = word(object(await grant.json()).token);
    const db = dbs.get(ava.owner)!;
    const tables = async (database: D1Database) => {
      const names = (await database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all<{ name: string }>()).results.map(row => row.name).filter(name => !name.startsWith('_cf_') &&
          (!name.startsWith('sqlite_') || name === 'sqlite_sequence'));
      const result: Record<string, Record<string, unknown>[]> = {};
      for (const name of names) {
        assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
        result[name] = (await database.prepare(`SELECT * FROM "${name}"`).all()).results
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      return result;
    };
    const resources = async () => ({ identity: await tables(identityDb), owners: Object.fromEntries(
      await Promise.all([...dbs].map(async ([owner, database]) => [owner, await tables(database)] as const))) });
    const physical = async (name: string) => (await db.prepare('SELECT model,id,version,data FROM records WHERE model=? ORDER BY id')
      .bind(name).all<{ model: string; id: string; version: number; data: string }>()).results
      .map(row => ({ ...row, data: object(JSON.parse(row.data)) }));
    const read = async (name: string) => {
      const response = await request(ben, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: `${name}.read`, arguments: {} } }, ben.grant); assert.equal(response.status, 200);
      const result = object(object(await response.json()).result); assert.notEqual(result.isError, true);
      const rows = object(result.structuredContent).records; assert.ok(Array.isArray(rows));
      return rows.map(item => { const row = object(item); return { id: word(row.id), data: object(row.data) }; });
    };
    const mutate = async (kind: string, inputs: ClosedInputs, id = operationId()) => {
      const response = await request(ava, `/api/operations/${entryModel}.${kind}`, { operation_id: id, inputs });
      return { status: response.status, body: object(await response.json()), id, inputs, operation: `${entryModel}.${kind}` };
    };
    type Mutation = Awaited<ReturnType<typeof mutate>>;
    const receipt = async (result: Mutation, expectedDefaults: Record<string, unknown> = {}) => {
      const row = await db.prepare('SELECT * FROM receipts WHERE operation_id=?').bind(result.id).first<ReceiptRow>(); assert.ok(row);
      assert.equal(row.app, 'HookOrder'); assert.equal(row.owner, ava.owner); assert.equal(row.principal, ava.principal);
      assert.equal(row.operation, result.operation); assert.equal(row.input_hash, await hashInputs(result.inputs));
      assert.deepEqual(JSON.parse(row.resolved_defaults), expectedDefaults); assert.ok(Number.isSafeInteger(row.created_at));
      assert.ok(Number.isSafeInteger(row.committed_revision)); return row;
    };
    const history = async () => (await db.prepare('SELECT * FROM history ORDER BY seq').all()).results;
    const assertFence = (before: Awaited<ReturnType<typeof resources>>, after: Awaited<ReturnType<typeof resources>>,
      saved: ReceiptRow, changes: string[]) => {
      assert.deepEqual(after.identity, before.identity);
      for (const owner of dbs.keys()) if (owner !== ava.owner) assert.deepEqual(after.owners[owner], before.owners[owner]);
      const previous = before.owners[ava.owner!]!, current = after.owners[ava.owner!]!;
      assert.deepEqual(Object.keys(current), Object.keys(previous));
      const fence = previous.fence![0]!;
      assert.equal(saved.committed_revision, Number(fence.revision) + 1);
      assert.deepEqual(current.fence, [{ ...fence, revision: saved.committed_revision }]);
      assert.equal(current.fence_log!.length, previous.fence_log!.length + 1);
      assert.deepEqual(current.fence_log!.filter(row => row.revision === saved.committed_revision),
        [{ revision: saved.committed_revision, at: saved.created_at, operation: saved.operation }]);
      assert.deepEqual(current.fence_log!.filter(row => row.revision !== saved.committed_revision), previous.fence_log);
      assert.equal(current.receipts!.length, previous.receipts!.length + 1);
      assert.deepEqual(current.receipts!.filter(row => row.operation_id !== saved.operation_id), previous.receipts);
      for (const name of Object.keys(previous)) if (!['receipts', 'fence', 'fence_log', ...changes].includes(name))
        assert.deepEqual(current[name], previous[name], `${name}: no unrelated table effects`);
    };
    const assertHistorySequence = (before: Awaited<ReturnType<typeof resources>>, after: Awaited<ReturnType<typeof resources>>, count: number) => {
      const previous = before.owners[ava.owner!]!.sqlite_sequence ?? [], current = after.owners[ava.owner!]!.sqlite_sequence ?? [];
      assert.deepEqual(current.filter(row => row.name !== 'history'), previous.filter(row => row.name !== 'history'));
      assert.deepEqual(current.filter(row => row.name === 'history'),
        [{ name: 'history', seq: Number(previous.find(row => row.name === 'history')?.seq ?? 0) + count }]);
    };
    const beforeCreate = await resources(), created = await mutate('create', { state: 'initial', accept: true });
    assert.equal(created.status, 200); assert.equal(created.body.status, 'committed');
    const initial = (await physical(entryModel))[0]!; assert.equal(initial.id, created.id); assert.equal(initial.version, 1);
    assert.deepEqual(initial.data, created.inputs); assert.deepEqual(await physical(auditModel), []);
    assert.deepEqual(await read(entryModel), [{ id: initial.id, data: initial.data }]); assert.deepEqual(await read(auditModel), []);
    const createReceipt = await receipt(created), createOutcome = object(JSON.parse(createReceipt.outcome));
    assert.equal(createOutcome.status, 'committed');
    assert.deepEqual(createOutcome.recordVersions, [{ model: entryModel, id: initial.id, version: 1 }]);
    const afterCreate = await resources(); assertFence(beforeCreate, afterCreate, createReceipt, ['records', 'history', 'sqlite_sequence']);
    assertHistorySequence(beforeCreate, afterCreate, 1);
    assert.equal(afterCreate.owners[ava.owner]!.records!.length, beforeCreate.owners[ava.owner]!.records!.length + 1);
    const initialPhysical = afterCreate.owners[ava.owner]!.records!.find(row => row.model === entryModel && row.id === initial.id)!;
    assert.ok(initialPhysical); assert.equal(initialPhysical.created, createReceipt.created_at);
    assert.equal(initialPhysical.updated, createReceipt.created_at); assert.equal(initialPhysical.created_by, ava.principal);
    assert.equal(initialPhysical.updated_by, ava.principal); assert.equal(initialPhysical.archived_at, null);
    assert.equal(initialPhysical.parent_model, null); assert.equal(initialPhysical.parent_id, null);
    const firstHistory = await history(); assert.equal(firstHistory.length, 1);
    assert.equal(firstHistory[0]!.model, entryModel); assert.equal(firstHistory[0]!.record_id, initial.id);
    assert.equal(firstHistory[0]!.version, 1); assert.equal(firstHistory[0]!.change, 'create'); assert.equal(firstHistory[0]!.before, null);
    assert.deepEqual(JSON.parse(word(firstHistory[0]!.after)), initial.data);

    const updated = await mutate('update', { record: { id: initial.id, version: '1' }, state: 'proposed', accept: true });
    assert.equal(updated.status, 200); assert.equal(updated.body.status, 'committed');
    const current = (await physical(entryModel))[0]!, audits = await physical(auditModel); assert.equal(audits.length, 1);
    const audit = audits[0]!; assert.equal(current.id, initial.id); assert.equal(current.version, 2);
    assert.deepEqual(current.data, { state: 'second', accept: true }); assert.equal(audit.version, 1);
    const expectedAudit: Record<string, unknown> = { note: 'first' };
    if (contextual) {
      const actorFacts = await identityDb.prepare('SELECT email,email_verified FROM identity_users WHERE user_id=?')
        .bind(ava.principal).first<{ email: string; email_verified: number }>(); assert.ok(actorFacts);
      const teamFacts = await identityDb.prepare('SELECT timezone FROM identity_teams WHERE team_id=?')
        .bind(ava.owner).first<{ timezone: string }>(); assert.ok(teamFacts);
      const invocationTime = await db.prepare('SELECT created_at FROM receipts WHERE operation_id=?')
        .bind(updated.id).first<{ created_at: number }>(); assert.ok(invocationTime);
      const admittedNow = new Date(invocationTime.created_at).toISOString();
      Object.assign(expectedAudit, { author: { id: ava.principal }, at: admittedNow,
        explicit_author: { id: ava.principal }, explicit_at: admittedNow, team_id: ava.owner,
        team_timezone: teamFacts.timezone, operation_id: updated.id, operation_source: 'http',
        actor_email: actorFacts.email, actor_verified: actorFacts.email_verified === 1 });
      assert.deepEqual(audit.data.explicit_author, audit.data.author, 'explicit native actor equals State server=actor');
      assert.equal(audit.data.explicit_at, audit.data.at, 'explicit native now equals State server=now');
    }
    assert.deepEqual(audit.data, expectedAudit, 'the staged child observes the first source-ordered candidate and exact admitted context');
    assert.deepEqual(await read(entryModel), [{ id: current.id, data: current.data }]);
    assert.deepEqual(await read(auditModel), [{ id: audit.id, data: { note: 'first' } }],
      'the original member policy discloses only note, including in the contextual fixture');
    const updateDefaults = contextual ? { '1:HookOrder.Audit.author': { id: ava.principal },
      '1:HookOrder.Audit.at': expectedAudit.at } : {};
    const updateReceipt = await receipt(updated, updateDefaults), updateOutcome = object(JSON.parse(updateReceipt.outcome));
    assert.equal(updateOutcome.status, 'committed');
    // The owner finalizer orders net writes by model/id; history below keeps
    // the actual source stage order instead of inventing extra root versions.
    assert.deepEqual(updateOutcome.recordVersions, [{ model: auditModel, id: audit.id, version: 1 },
      { model: entryModel, id: current.id, version: 2 }]);
    const afterUpdate = await resources(); assertFence(afterCreate, afterUpdate, updateReceipt, ['records', 'history', 'sqlite_sequence']);
    assertHistorySequence(afterCreate, afterUpdate, 2);
    assert.equal(afterUpdate.owners[ava.owner]!.records!.length, afterCreate.owners[ava.owner]!.records!.length + 1);
    const updatedPhysical = afterUpdate.owners[ava.owner]!.records!.find(row => row.model === entryModel && row.id === current.id)!;
    assert.ok(updatedPhysical);
    assert.deepEqual({ ...updatedPhysical, version: initialPhysical.version, data: initialPhysical.data,
      updated: initialPhysical.updated, updated_by: initialPhysical.updated_by }, initialPhysical,
    'the winning hook preserves every original root storage field except its final data/version/update attribution');
    assert.equal(updatedPhysical.updated, updateReceipt.created_at); assert.equal(updatedPhysical.updated_by, ava.principal);
    const auditPhysical = afterUpdate.owners[ava.owner]!.records!.find(row => row.model === auditModel && row.id === audit.id)!;
    assert.ok(auditPhysical); assert.equal(auditPhysical.created, updateReceipt.created_at);
    assert.equal(auditPhysical.updated, updateReceipt.created_at); assert.equal(auditPhysical.created_by, ava.principal);
    assert.equal(auditPhysical.updated_by, ava.principal); assert.equal(auditPhysical.archived_at, null);
    assert.equal(auditPhysical.parent_model, null); assert.equal(auditPhysical.parent_id, null);
    const committedHistory = await history(); assert.equal(committedHistory.length, 3);
    assert.deepEqual(committedHistory.slice(0, 1), firstHistory);
    const changes = committedHistory.slice(1); assert.deepEqual(changes.map(row => [row.model, row.record_id, row.version, row.change]),
      [[entryModel, current.id, 2, 'update'], [auditModel, audit.id, 1, 'create']]);
    assert.deepEqual(JSON.parse(word(changes[0]!.before)), initial.data); assert.deepEqual(JSON.parse(word(changes[0]!.after)), current.data);
    assert.equal(changes[1]!.before, null); assert.deepEqual(JSON.parse(word(changes[1]!.after)), audit.data);
    for (const row of committedHistory) {
      const saved = row.operation_id === created.id ? createReceipt : updateReceipt;
      assert.equal(row.operation_id, saved.operation_id); assert.equal(row.operation, saved.operation);
      assert.equal(row.actor, ava.principal); assert.equal(row.at, saved.created_at);
    }
    const replay = async (original: Mutation, before: Awaited<ReturnType<typeof resources>>) => {
      const result = await mutate(original.operation.slice(entryModel.length + 1), original.inputs, original.id);
      assert.equal(result.status, original.status);
      if (original.status === 200) { assert.equal(result.body.status, 'replayed'); assert.deepEqual(result.body.records, original.body.records); }
      else {
        assert.deepEqual(Object.keys(result.body).sort(), ['error', 'retry']);
        assert.deepEqual(result.body.error, original.body.error, 'replay retains the original rejection');
        const retry = object(result.body.retry), previousRetry = object(original.body.retry);
        assert.deepEqual(Object.keys(retry), ['operation_id']);
        assert.deepEqual(Object.keys(previousRetry), ['operation_id']);
        const fresh = word(retry.operation_id), previous = word(previousRetry.operation_id);
        for (const id of [fresh, previous]) {
          assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
          assert.notEqual(id, original.id);
        }
        assert.notEqual(fresh, previous, 'each retry offer has its own new operation identity');
      }
      assert.deepEqual(await resources(), before);
    };
    await replay(created, afterUpdate); await replay(updated, afterUpdate);
    const refused = await mutate('update', { record: { id: current.id, version: '2' }, state: 'proposed', accept: false });
    assert.equal(refused.status, 422); const error = object(refused.body.error);
    assert.equal(error.code, 'rule_failed'); assert.equal(error.retryable, false);
    const rejectedReceipt = await receipt(refused), rejectedOutcome = object(JSON.parse(rejectedReceipt.outcome));
    assert.equal(rejectedOutcome.status, 'rejected'); assert.equal(rejectedOutcome.code, 'rule_failed');
    const afterReject = await resources(); assertFence(afterUpdate, afterReject, rejectedReceipt, []);
    assert.deepEqual(await physical(entryModel), [current]); assert.deepEqual(await physical(auditModel), [audit]);
    assert.deepEqual(await history(), committedHistory, 'late failure rolls back both candidate adjustments and the staged Audit');
    await replay(refused, afterReject);
    assert.equal(JSON.stringify(artifact), originalArtifact); assert.equal(await readFile(sourcePath, 'utf8'), originalSource);
    assert.equal(await captureIsCurrent(capture), true, 'original source/compiler/catalog and installed portable graph stay current');
  } finally {
    try { await bridge?.close(); }
    finally { try { await worker?.dispose(); }
      finally { try { await provisioning?.dispose(); }
        finally { if (persistence) await rm(persistence, { recursive: true, force: true });
          if (capture) assert.equal(await captureIsCurrent(capture), true, 'HookOrder finish source-current'); } } }
  }
});

/** Complete owning URL recipe, consumed through the portable root host only. */
it('serves the unchanged native URL recipe with the protected preview deployment base', { timeout: 180000 }, async () => {
  const recipePath = join(root, 'compiler/tests/fixtures/anonymous-message-consumer.mjs');
  const recipeBytes = await readFile(recipePath);
  const recipe = recipeBytes.toString('utf8');
  const start = 'const urlSource=`';
  const end = '`;\nconst urlFixture=';
  assert.equal(recipe.split(start).length, 2);
  const sourceStart = recipe.indexOf(start) + start.length;
  const sourceEnd = recipe.indexOf(end, sourceStart);
  assert.ok(sourceEnd > sourceStart);
  const source = recipe.slice(sourceStart, sourceEnd);
  // Extract the entire literal; never recreate or narrow its source declarations.
  assert.ok(source.startsWith('app UrlDestinations\n'));
  assert.ok(source.endsWith('   require false\n'));
  assert.ok(!source.includes('`'));
  assert.ok(!source.includes('${'));
  const sourceBytes = Buffer.from(source, 'utf8');
  const scratch = await mkdtemp(join(root, 'compiler/target/url-preview-'));
  try {
    const appPath = join(scratch, 'UrlDestinations.can');
    await writeFile(appPath, sourceBytes);
    const capture = await captureSingleFileSource(prepareLocalPreviewCapture({
      checkoutRoot: root, appPath,
      compilerPath: join(root, 'compiler/target/debug/can'),
      catalogPath: fileURLToPath(distribution.catalog),
      helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md'),
    }));
    const assertCurrent = async () => {
      assert.deepEqual(await readFile(recipePath), recipeBytes);
      assert.deepEqual(await readFile(appPath), sourceBytes);
      assert.equal(await captureIsCurrent(capture), true);
    };
    assert.equal(capture.sourceText, source);
    assert.equal(capture.sourceBytes, sourceBytes.length);
    assert.equal(capture.sourceSha256, createHash('sha256').update(sourceBytes).digest('hex'));
    await assertCurrent();
    const compiled = await compileCapturedSingleFile(capture);
    assert.equal(compiled.kind, 'artifact', JSON.stringify(compiled.kind === 'artifact' ? {} : compiled));
    if (compiled.kind !== 'artifact') throw new Error('native URL recipe compilation failed');
    assert.deepEqual(compiled.artifact.models ?? [], []);
    assert.deepEqual(compiled.artifact.operations, []);
    assert.deepEqual(compiled.artifact.pages.map(page => page.path), ['/url-static', '/url-order']);
    assert.deepEqual(compiled.artifact.sources, [{ path: capture.compilerOperand, sha256: capture.sourceSha256 }]);
    const artifactBytes = new Uint8Array(compiled.artifactBytes);
    const artifactJson = JSON.stringify(compiled.artifact);
    const preview = await openNativePreview(compiled.artifact, capture, compiled.artifactBytes);
    try {
      await assertCurrent();
      if (typeof preview.issueOpenUrl !== 'function') throw new Error('installed preview has no protected-open producer');
      const opened = await preview.issueOpenUrl();
      const origin = new URL(opened).origin;
      assert.equal(new URL(origin).hostname, '127.0.0.1');
      assert.notEqual(new URL(origin).port, '');
      assert.equal(new URL(origin).pathname, '/');
      const cookies = new Map<string, string>();
      const request = async (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        if (cookies.size > 0) headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
        if (init.method === 'POST' && !headers.has('origin')) headers.set('origin', origin);
        const response = await fetch(new URL(path, origin), { ...init, headers, redirect: 'manual' });
        for (const cookie of response.headers.getSetCookie()) {
          const pair = cookie.split(';', 1)[0]!;
          const index = pair.indexOf('=');
          cookies.set(pair.slice(0, index), pair.slice(index + 1));
        }
        return response;
      };
      assert.equal((await fetch(new URL('/url-static', origin), { redirect: 'manual' })).status, 401);
      const bootstrap = await request(opened);
      assert.equal(bootstrap.status, 303);
      assert.equal(bootstrap.headers.get('location'), '/');
      assert.equal((await request(opened)).status, 403);
      const actor = preview.issueLocalActors().find(candidate => candidate.label === 'Ava');
      assert.ok(actor);
      const descriptor = await request('/auth/login');
      assert.equal(descriptor.status, 200);
      const loginDescriptor = await descriptor.json() as { preSessionToken: string };
      const login = await request('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: actor!.email, password: actor!.password, _presession: loginDescriptor.preSessionToken }) });
      assert.equal(login.status, 200);
      const session = cookies.get('can_session');
      assert.ok(session);
      const teamsResponse = await request('/auth/teams');
      assert.equal(teamsResponse.status, 200);
      const teams = await teamsResponse.json() as { teams: Array<{ team_id: string }> };
      assert.equal(teams.teams.length, 1);
      const team = teams.teams[0]!.team_id;
      assert.match(team, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const csrf = await deriveCsrfToken(decodeURIComponent(session!));
      const select = { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ team, _csrf: csrf }) };
      assert.equal((await request('/auth/select-team', select)).status, 200);
      assert.equal((await request('/auth/select-team', { ...select, headers: { ...select.headers, origin: 'http://foreign.invalid' } })).status, 403);
      const hrefs = [
        `href="${origin}/">Home</a>`,
        `href="${origin}/search?q=%3Ctag%3E&amp;page=1">Search &lt;all&gt;</a>`,
      ];
      for (const partial of [false, true]) {
        for (const spoof of [false, true]) {
          const headers = new Headers(partial ? { 'HX-Request': 'true' } : {});
          if (spoof) {
            headers.set('origin', 'http://foreign.invalid');
            headers.set('x-forwarded-host', 'foreign.invalid');
            headers.set('x-deployment-base', 'https://foreign.invalid/mount');
          }
          const page = await request('/url-static', { headers });
          assert.equal(page.status, 200);
          assert.ok(page.headers.get('content-type')?.includes('text/html'));
          const html = await page.text();
          for (const href of hrefs) assert.ok(html.includes(href), href);
          assert.ok(!html.includes('href="https://foreign.invalid'));
          assert.ok(!html.includes('href="http://foreign.invalid'));
          if (!partial) assert.ok(html.includes('/assets/browser/bootstrap.js'));
        }
        // The genuine team UUID is not a slash-prefixed app path. Values rejects
        // it during rendering; Interfaces intentionally exposes a safe envelope.
        const order = await request('/url-order', { headers: partial ? { 'HX-Request': 'true' } : {} });
        assert.equal(order.status, 422);
        assert.ok(order.headers.get('content-type')?.includes('application/json'));
        const refusal = object(await order.json());
        assert.equal(refusal.code, 'rule_failed'); assert.equal(refusal.retryable, false);
      }
      for (const path of ['/assets/browser/bootstrap.js', '/assets/browser/can-style.css', '/assets/browser/polling.js']) {
        const asset = await request(path);
        assert.equal(asset.status, 200, path);
        assert.ok(asset.headers.get('content-type')?.includes(path.endsWith('.css') ? 'text/css' : 'application/javascript'));
        assert.ok((await asset.arrayBuffer()).byteLength > 0);
      }
      assert.deepEqual(compiled.artifactBytes, artifactBytes);
      assert.equal(JSON.stringify(compiled.artifact), artifactJson);
      await assertCurrent();
    } finally { await preview.dispose(); }
    assert.throws(() => preview.issueLocalActors(), /disposal/);
    await assertCurrent();
  } finally { await rm(scratch, { recursive: true, force: true }); }
  assert.deepEqual(await readFile(recipePath), recipeBytes);
});
