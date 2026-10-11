/** Finite native local consumer of State's bounded current-authorized history. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, StoragePort } from '@canlang/contracts';
import { distribution } from '@canlang/values/distribution';
import { ensureSchema } from '@canlang/state/storage/d1';
import { createD1Storage } from '@canlang/state/storage';
import { asId, asModel, asOperationId, FIXED_NOW, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { queryRecordHistoryForViewer, type ViewerHistoryInput } from '@canlang/state/query';
import { createD1IdentityStore, ensureIdentitySchema, issueMcpGrant, resolveIdentity } from '@canlang/identity';
import { assembleModules, importVerifiedAssemblyModule } from '@canlang/cloudflare/runtime/modules';
import { invokeMutationCanonical, loadCanonicalDescriptors, withCanonicalCommitGuard,
  withDispatchJoinPort, withStagedOverlay } from '@canlang/cloudflare/runtime/invoke';
import { withDispatchProducer } from '../dist/runtime/executors.js';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const app = 'NativeHistory', model = asModel(`${app}.Entry`);
async function snapshot(db: D1Database) {
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{name:string}>();
  assert.equal(tables.success, true);
  const result: Record<string, readonly Record<string, unknown>[]> = {};
  for (const { name } of tables.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true);
    result[name] = rows.results.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('native local canonical stages retain complete bounded history through all production wrappers',
  { timeout: 120000 }, async () => {
    const fixture = fileURLToPath(new URL('./fixtures/native-history.can', import.meta.url));
    const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
    const paths = [fixture, compiler, catalog];
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const captured = await Promise.all(paths.map(async path => hash(await readFile(path))));
    const dir = await mkdtemp(join(tmpdir(), 'can-native-history-'));
    let worker: Miniflare | undefined, sequence = 0, now = FIXED_NOW;
    const clock = { nowMs: () => now }, nextId = () => asOperationId(uuidv7(FIXED_NOW, ++sequence));
    try {
      const env = { ...process.env }; delete env.CAN_CATALOG;
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--catalog', catalog, fixture],
        { cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact, originalArtifact = JSON.stringify(artifact);
      assert.equal(artifact.artifact_version, 1);
      assert.ok(artifact.sources.some(source => resolve(source.path) === fixture && source.sha256 === captured[0]));
      const asm = await assembleModules({ artifact, sourcePath: fixture }, { workDir: join(dir, 'modules'),
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      const loaded = await loadCanonicalDescriptors(asm, artifact);
      assert.equal(loaded.models.length, 1); assert.equal(loaded.models[0]!.name, model);
      assert.deepEqual(loaded.secretFields.get(model), ['token']);
      const namespace = object(await importVerifiedAssemblyModule(asm, artifact.modules[0]!.path, artifact));
      const definition = object(namespace.appDefinition), declaration = object(object(definition.models)[model]);
      assert.equal(definition.id, app);
      // This is the complete one-model source profile, checked by the genuine
      // canonical loader. No parent grant is substituted for the model read.
      assert.deepEqual(declaration.readGrants, [{ rule: 'Entry.read.1', by: ['members'] }]);
      assert.equal(object(object(declaration.fields).token).type, 'secret');
      const containment = loaded.containment.get(model);
      assert.ok(containment === undefined || object(containment).parent === undefined);
      const grants = declaration.readGrants as { rule: string; by: ['members'] }[];
      const readPolicies: ViewerHistoryInput['readPolicies'] = new Map([[model, { by: grants[0]!.by[0] }]]);
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true,
        script: 'export default {fetch(){return new Response("ok")}}',
        d1Databases: { IDENTITY: 'native-history-identity', STATE: 'native-history-state' }, d1Persist: join(dir, 'd1') });
      const idDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const db = await worker.getD1Database('STATE') as unknown as D1Database;
      await ensureIdentitySchema(idDb); await ensureSchema(db);
      const identities = createD1IdentityStore(idDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' });
      const user = await identities.createUser({ email: 'native-history@example.test', password_hash: 'unused', email_verified: true });
      const membership = await identities.createMembership({ user_id: user.user_id, team_id: team.team_id, is_owner: true, roles: [] });
      const grant = await issueMcpGrant(identities, { user_id: user.user_id, team_id: team.team_id, client_id: 'native-history' }, { clock });
      const identity = await resolveIdentity(identities, { mcp_grant_token: grant.token }, { clock });
      assert.equal(identity.actor?.user_id, user.user_id); assert.equal(identity.team?.team_id, team.team_id);
      const physical = createD1Storage(db);
      const resources = async () => ({ state: await snapshot(db), identity: await snapshot(idDb) });
      const createId = nextId();
      const options = { artifact, asm, app, identity, source: 'worker', store: physical, memberships: identities, now: clock.nowMs };
      const createOptions = { ...options, operation: `${model}.create`, operationId: createId, inputs: {} };
      const created = await invokeMutationCanonical(createOptions);
      assert.equal(created.status, 'committed');
      const id = asId(createId), row = await physical.load(model, id); assert.ok(row);
      assert.equal(row.version, 1); assert.match(String(row.data.token), /^[a-f0-9]{64}$/);
      const changeId = nextId(), beforeChange = await resources(), revision = await physical.readRevision();
      now++;
      const changeOptions = { ...options, operation: `${app}.change_twice`, operationId: changeId,
        inputs: { entry: { id, version: '1' } } };
      const changed = await invokeMutationCanonical(changeOptions); assert.equal(changed.status, 'committed');
      assert.equal(await physical.readRevision(), revision + 1);
      const afterChange = await resources();
      assert.equal(afterChange.state.receipts!.length, beforeChange.state.receipts!.length + 1);
      assert.equal(afterChange.state.fence_log!.length, beforeChange.state.fence_log!.length + 1);
      assert.deepEqual(afterChange.identity, beforeChange.identity);
      for (const name of Object.keys(beforeChange.state)) if (!['records','history','receipts','fence','fence_log','sqlite_sequence'].includes(name))
        assert.deepEqual(afterChange.state[name], beforeChange.state[name], name);
      assert.deepEqual(afterChange.state.sqlite_sequence, beforeChange.state.sqlite_sequence!.map(entry =>
        entry.name === 'history' ? { ...entry, seq: Number(entry.seq) + 2 } : entry),
      'only the two authored history stages advance their physical insertion sequence');
      assert.equal((await invokeMutationCanonical(createOptions)).status, 'replayed');
      assert.deepEqual(await resources(), afterChange, 'old CRUD replay produces no effects');
      assert.equal(artifact.operations!.find(operation => operation.name === changeOptions.operation)?.result?.disclosure,
        undefined, 'this ordinary source has no checked saved-result disclosure association');
      await assert.rejects(() => invokeMutationCanonical(changeOptions), /no supported execution association/);
      assert.deepEqual(await resources(), afterChange, 'legacy scenario replay withholds saved content with no effects');

      const physicalRead = physical.historyReadBounded; assert.ok(physicalRead);
      const raw = await physicalRead.call(physical, { model, recordId: id, expectedRevision: await physical.readRevision(), limit: 3 });
      assert.equal(raw.length, 3);
      for (const entry of raw) assert.deepEqual(entry.auditProjection,
        { created: row.created, createdBy: row.createdBy, secretFields: ['token'] });
      assert.deepEqual(raw.map(entry => [entry.version, entry.after?.label]), [[1,'First'],[2,'Middle'],[2,'Last']]);
      assert.deepEqual(raw[2]!.before, raw[1]!.after);
      let boundedReads = 0, legacyReads = 0, directCommits = 0, revokeDuringRead = false;
      physical.historyReadBounded = async function (request) {
        assert.equal(this, physical, 'production wrappers retain the original physical receiver'); boundedReads++;
        const result = await physicalRead.call(this, request);
        if (revokeDuringRead) { revokeDuringRead = false; await identities.removeMembership(membership.membership_id); }
        return result;
      };
      physical.load = async () => { legacyReads++; throw new Error('legacy load forbidden'); };
      physical.historyFor = async () => { legacyReads++; throw new Error('legacy history forbidden'); };
      const guarded = withCanonicalCommitGuard(physical, 'NativeHistory.history');
      const produced = withDispatchProducer(guarded, null, { clock: clock.nowMs, actor: user.user_id });
      const joined = withDispatchJoinPort(produced, { commitJoin: async () => { directCommits++; throw new Error('history committed'); } });
      const input: ViewerHistoryInput = { model, recordId: id, limit: 3, store: joined, memberships: identities,
        policy: loaded.policy as ViewerHistoryInput['policy'], readPolicies,
        context: { actorUserId: user.user_id, teamId: team.team_id } };
      const readBaseline = await resources();
      const result = await queryRecordHistoryForViewer(input);
      assert.deepEqual(result.entries.map(entry => entry.before), [null,{label:'First'},{label:'Middle'}]);
      assert.deepEqual(result.entries.map(entry => entry.after), [{label:'First'},{label:'Middle'},{label:'Last'}]);
      assert.deepEqual(result.entries.map(entry => [entry.version,entry.actor,entry.operationId]),
        [[1,user.user_id,createId],[2,user.user_id,changeId],[2,user.user_id,changeId]]);
      assert.equal(result.revision, await physical.readRevision());
      assert.ok(!JSON.stringify(result).includes(String(row.data.token)));
      for (const entry of result.entries) assert.equal(Object.hasOwn(entry, 'auditProjection'), false);
      assert.throws(() => guarded.commit({} as Parameters<StoragePort['commit']>[0]), /direct state commit/);
      await assert.rejects(() => queryRecordHistoryForViewer({ ...input, limit: 2 }), /bounded|limit|complete/i);
      await assert.rejects(() => queryRecordHistoryForViewer({ ...input, readPolicies: new Map() }), /checked model read/);
      await assert.rejects(() => queryRecordHistoryForViewer({ ...input, store: withStagedOverlay(joined, new Map()) }), /staged overlay/);
      const legacy: StoragePort = { ...joined }; delete legacy.historyReadBounded;
      await assert.rejects(() => queryRecordHistoryForViewer({ ...input, store: legacy }), /bounded viewer-history/);
      assert.deepEqual(await resources(), readBaseline, 'all reads and refusals leave every local resource unchanged');
      const readsBeforeRevoke = boundedReads;
      revokeDuringRead = true;
      await assert.rejects(() => queryRecordHistoryForViewer(input), error => object(error).code === 'forbidden');
      const revoked = await resources();
      assert.deepEqual(revoked.state, readBaseline.state);
      await assert.rejects(() => queryRecordHistoryForViewer(input), /not found/i);
      assert.equal(boundedReads, readsBeforeRevoke + 1, 'revoked membership refuses before history fetch');
      assert.deepEqual(await resources(), revoked);
      assert.equal(legacyReads, 0); assert.equal(directCommits, 0);
      assert.equal(JSON.stringify(artifact), originalArtifact);
      assert.deepEqual(await Promise.all(paths.map(async path => hash(await readFile(path)))), captured);
    } finally { await worker?.dispose(); await rm(dir, { recursive: true, force: true }); }
  });
