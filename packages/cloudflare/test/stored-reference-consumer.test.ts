/** Genuine native stored-source/query-child D1 join over an explicitly authored
 * composition. This does not qualify the complete original Workbench app. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type { CompileArtifact, MutationEnvelope, ScenarioResultDisclosurePlan, StoragePort, StoredRow } from '@canlang/contracts';
import { distribution } from '@canlang/values/distribution';
import { createD1OwnerRouter } from '@canlang/state/storage/owner-router';
import { ensureSchema } from '@canlang/state/storage/d1';
import { asId, asModel, asOperationId, FIXED_NOW, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { readScenarioReceiptAssociation } from '@canlang/state/invocation';
import { createD1IdentityStore, ensureIdentitySchema, resolveIdentity, sha256HexText } from '@canlang/identity';
import { assembleModules, importVerifiedAssemblyModule } from '@canlang/cloudflare/runtime/modules';
import { buildInvoker, createTeamOwnerStorageBoundary } from '@canlang/cloudflare/worker/assembly';

const root = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const APP = 'StoredReferenceSource', PARENT = 'workbench.parent', CHILD = 'workbench.context';
const STEP = asModel('workbench.Step'), RUN = asModel('workbench.Run'), TASK = asModel('todo.Task');
const LOCATION = asModel('rent_catalog.Location');
const ref = (row: StoredRow) => ({ id: row.id, version: String(row.version) });
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function snapshot(db: D1Database) {
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='_cf_METADATA' ORDER BY name").all<{ name: string }>();
  assert.equal(tables.success, true);
  const values: Record<string, readonly Record<string, unknown>[]> = {};
  for (const { name } of tables.results) {
    const rows = await db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all<Record<string, unknown>>();
    assert.equal(rows.success, true);
    values[name] = rows.results.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return values;
}

test('native stored parent references retain actual child query/source identity and no-effect saved recovery in D1',
  { timeout: 120000 }, async () => {
    const fixture = fileURLToPath(new URL('./fixtures/typed-stored-reference.can', import.meta.url));
    const compiler = join(root, 'compiler/target/debug/can'), catalog = fileURLToPath(distribution.catalog);
    const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    const producerPaths = [fixture, compiler, catalog];
    const hashes = await Promise.all(producerPaths.map(async path => digest(await readFile(path))));
    const dir = await mkdtemp(join(tmpdir(), 'can-stored-reference-consumer-'));
    let worker: Miniflare | undefined, sequence = 0, taskQueries = 0;
    const nextId = () => asOperationId(uuidv7(FIXED_NOW, ++sequence));
    const clock = { nowMs: () => FIXED_NOW };
    try {
      const env = { ...process.env }; delete env.CAN_CATALOG;
      const { stdout } = await promisify(execFile)(compiler,
        ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, fixture],
        { cwd: root, env, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      const artifact = JSON.parse(stdout) as CompileArtifact;
      assert.equal(artifact.artifact_version, 1); assert.ok(artifact.modules.length > 0);
      assert.ok(artifact.sources.some(source => resolve(source.path) === fixture && source.sha256 === hashes[0]));
      const parent = artifact.operations?.find(def => def.name === PARENT), child = artifact.operations?.find(def => def.name === CHILD);
      const plan = parent?.result?.disclosure, childPlan = child?.result?.disclosure;
      assert.ok(plan); assert.ok(childPlan); assert.equal(parent.result?.type, 'int'); assert.equal(child.result?.type, 'workbench.Fact[]');
      assert.equal(plan.source.sha256, hashes[0]); assert.equal(childPlan.source.sha256, hashes[0]);
      for (const [model, field, type] of [['workbench.Step','parent','workbench.Run'],
        ['workbench.Run','location','rent_catalog.Location'], ['workbench.Run','targets','todo.Task[]']]) {
        const dependencies = plan.returns.flatMap(returned => returned.dependencies).filter(dep => dep.model === model && dep.field === field);
        assert.ok(dependencies.length > 0); assert.ok(dependencies.every(dep => dep.type === type && dep.source.sha256 === hashes[0]));
      }
      assert.ok(plan.returns.some(returned => returned.dependencies.some(dep => dep.field === 'targets' && dep.role === 'control')));
      assert.equal(childPlan.queries?.length, 1);
      const targetsInput = child.inputs.fields.find(field=>field.name==='targets'); assert.ok(targetsInput);
      assert.deepEqual([targetsInput.field.kind, targetsInput.array?.required, targetsInput.min, targetsInput.max], ['ref',false,1,10]);
      const asm = await assembleModules({ artifact, sourcePath: fixture }, { workDir: join(dir, 'modules'),
        stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
      for (const name of [PARENT, CHILD]) {
        const callable = artifact.callables.find(def => def.id === name); assert.ok(callable);
        const namespace = object(await importVerifiedAssemblyModule(asm, callable.module, artifact));
        assert.equal(typeof namespace[callable.export], 'string');
        const emitted = artifact.modules.find(module => module.path === callable.module); assert.ok(emitted);
        for (const helper of name === PARENT ? ['invokeScenarioReceiptCall','observeScenarioReceiptDependency'] : ['executeScenarioReceiptQuery'])
          assert.ok(emitted.js.includes(helper));
      }
      worker = new Miniflare({ compatibilityDate: '2026-07-15', modules: true, script: 'export default {fetch(){return new Response("ok")}}',
        d1Databases: { IDENTITY: 'stored-reference-identity', A: 'stored-reference-a', B: 'stored-reference-b' }, d1Persist: join(dir, 'd1') });
      const identityDb = await worker.getD1Database('IDENTITY') as unknown as D1Database;
      const a = await worker.getD1Database('A') as unknown as D1Database, b = await worker.getD1Database('B') as unknown as D1Database;
      await ensureIdentitySchema(identityDb); await ensureSchema(a); await ensureSchema(b);
      const identities = createD1IdentityStore(identityDb, { clock });
      const team = await identities.createTeam({ timezone: 'UTC' }), otherTeam = await identities.createTeam({ timezone: 'UTC' });
      const user = await identities.createUser({ email: 'stored-member@example.test', password_hash: 'unused', email_verified: true });
      const membership = await identities.createMembership({ user_id: user.user_id, team_id: team.team_id, is_owner: true, roles: [] });
      const replacementOwner = await identities.createUser({ email: 'replacement-owner@stored-reference.example.test', password_hash: 'unused', email_verified: true });
      await identities.createMembership({ team_id: team.team_id, user_id: replacementOwner.user_id, is_owner: true, roles: [] });
      const token = randomBytes(32).toString('hex');
      await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
        expires_at: new Date(FIXED_NOW + 48 * 3600000).toISOString(), last_team_id: team.team_id });
      const identity = await resolveIdentity(identities, { session_token: token }, { clock });
      const boundary = await createTeamOwnerStorageBoundary({ artifact, asm, app: APP, identities,
        router: createD1OwnerRouter({ resolveBinding: selected => selected.app === APP && [team.team_id,otherTeam.team_id].includes(selected.owner)
          ? { ...selected, db: selected.owner === team.team_id ? a : b, initializeFresh: true } : null }) });
      const store = await boundary.forIdentity(identity);
      const foreign = await boundary.forTrustedScope({ app: APP, owner: otherTeam.team_id, ownerPackage: 'workbench' }, FIXED_NOW);
      const all = async () => ({ a: await snapshot(a), b: await snapshot(b), identity: await snapshot(identityDb) });
      const batches: Parameters<StoragePort['commit']>[0][] = [];
      const observed: StoragePort = { ...store, commit: async batch => { batches.push(batch); return store.commit(batch); },
        query: async query => { if (query.model === TASK) taskQueries++; return store.query(query); } };
      const invoker = (storage = observed, now = FIXED_NOW) => buildInvoker(artifact, asm, storage,
        { appId: APP, memberships: identities, now: () => now });
      const mutate = async (operation: string, inputs: MutationEnvelope['inputs']) => {
        const envelope: MutationEnvelope = { operation, operation_id: nextId(), inputs };
        const count = batches.length, result = await invoker().invokeMutation(envelope, identity);
        assert.ok('result' in result, JSON.stringify({ operation, result,
          inputs: artifact.operations?.find(def => def.name === operation)?.inputs })); assert.equal(result.result.status, 'committed');
        assert.equal(batches.length, count + 1); assert.ok(batches.at(-1)!.receipt);
        return { envelope, outcome: result.result, batch: batches.at(-1)! };
      };
      const create = async (model: string, inputs: MutationEnvelope['inputs']) => {
        const result = await mutate(`${model}.create`, inputs), row = await store.load(asModel(model), asId(result.envelope.operation_id));
        assert.ok(row); return row;
      };
      const location = await create(LOCATION, { name: 'Site' }), elsewhere = await create(LOCATION, { name: 'Elsewhere' });
      const first = await create(TASK, { location: ref(location), title: 'First' });
      const second = await create(TASK, { location: ref(location), title: 'Second', description: 'Details' });
      const excluded = await create(TASK, { location: ref(elsewhere), title: 'False candidate' });
      const run = await create(RUN, { location: ref(location), targets: [ref(second),ref(first)] });
      const step = await create(STEP, { ordinal: '1', parent: ref(run) });
      assert.deepEqual(step.parent, { model: RUN, id: run.id });
      const beforeRows = await all(), beforeRevision = await store.readRevision(), beforeQueries = taskQueries;
      const fresh = await mutate(PARENT, { step: ref(step) });
      assert.equal(fresh.outcome.result, '1'); assert.equal(taskQueries, beforeQueries + 1);
      assert.deepEqual(fresh.outcome.records, []); assert.deepEqual(fresh.batch.writes, []); assert.deepEqual(fresh.batch.history, []);
      for (const effect of [fresh.batch.outbox,fresh.batch.schedules,fresh.batch.uniqueClaims,fresh.batch.uniqueReleases]) assert.deepEqual(effect, []);
      assert.equal(await store.readRevision(), Number(beforeRevision) + 1);
      const afterFresh = await all();
      for (const [name, rows] of Object.entries(beforeRows.a)) if (!['receipts','fence','fence_log'].includes(name))
        assert.deepEqual(afterFresh.a[name],rows,`read-child root changed unrelated table ${name}`);
      assert.equal(afterFresh.a['receipts']!.length,beforeRows.a['receipts']!.length+1);
      assert.equal(afterFresh.a['fence_log']!.length,beforeRows.a['fence_log']!.length+1);
      for (const row of [location,elsewhere,first,second,excluded,run,step]) assert.deepEqual(await store.load(
        row === run ? RUN : row === step ? STEP : row === location || row === elsewhere ? LOCATION : TASK,row.id),row);
      assert.deepEqual(await snapshot(b), beforeRows.b); assert.deepEqual(await snapshot(identityDb), beforeRows.identity);
      const receipt = fresh.batch.receipt!; assert.deepEqual(await store.readReceipt(receipt.identity), receipt);
      const association = readScenarioReceiptAssociation(receipt); assert.ok(association);
      assert.deepEqual(association.plan, plan); assert.deepEqual(association.changed, []); assert.equal(association.calls?.length, 1);
      const called = association.calls![0]!; assert.equal(called.caller, PARENT); assert.equal(called.target, CHILD);
      assert.deepEqual(called.references.map(value => [value.model,value.row.id,value.row.version]),
        [[LOCATION,location.id,location.version],[TASK,second.id,second.version],[TASK,first.id,first.version]]);
      assert.ok(called.scenario); assert.deepEqual(called.scenario.plan, childPlan); assert.equal(called.scenario.queries?.length, 1);
      const query = called.scenario.queries![0]!;
      assert.deepEqual(query.candidates.filter(candidate => !candidate.matched).map(candidate=>candidate.record.id),[excluded.id]);
      const selected = query.selectedIndices.map(index=>query.candidates[index]!.record);
      assert.deepEqual(selected.map(row=>row.id),[first.id,second.id].sort());
      assert.deepEqual(called.result, selected.map(row=>({ task: { id:row.id,version:String(row.version) }, version:String(row.version),
        title:row.data['title'], description:row.data['description'], due:row.data['due'], priority:row.data['priority'], done:row.data['done'] })));
      for (const observation of association.observations) {
        const dependency: ScenarioResultDisclosurePlan['returns'][number]['dependencies'][number] | undefined =
          plan.returns.flatMap(returned=>returned.dependencies).find(dep=>dep.id===observation.dependencyId); assert.ok(dependency);
        assert.ok([RUN,STEP].includes(dependency.model));
        assert.equal(observation.row.id, dependency.model === STEP ? step.id : run.id);
        assert.equal(observation.row.version, dependency.model === STEP ? step.version : run.version);
      }
      const noEffects: StoragePort = { ...observed, commit: async () => { throw new Error('saved recovery tried to commit'); } };
      const recover = async (dedicated: boolean) => {
        const before = await all(), queries = taskQueries, count = batches.length;
        const result = dedicated ? await invoker(noEffects,FIXED_NOW+16*60000).invokeRetainedMutation(fresh.envelope,identity)
          : await invoker(noEffects).invokeMutation(fresh.envelope,identity);
        assert.ok('result' in result,JSON.stringify(result)); assert.equal(result.result.status,'replayed'); assert.equal(result.result.result,'1');
        assert.deepEqual(await all(),before); assert.equal(taskQueries,queries); assert.equal(batches.length,count);
        assert.deepEqual(await store.readReceipt(receipt.identity),receipt);
      };
      await recover(false); await recover(true);
      // Replacing current stored source values does not execute the old child or
      // change its original snapshot. Recovery still enforces current grants.
      await mutate(`${RUN}.update`, { record:ref(run), location:ref(elsewhere), targets:[ref(excluded)] });
      await recover(false); await recover(true);
      // A repeated ordered stored slot must exercise the original count guard;
      // the child query returns unique rows, so [A,A] cannot silently pass as two.
      const duplicateRun = await create(RUN,{location:ref(location),targets:[ref(first),ref(first)]});
      const duplicateStep = await create(STEP,{ordinal:'1',parent:ref(duplicateRun)});
      const beforeRejected = await all(), beforeRejectBatches=batches.length;
      const domainBefore = await Promise.all([TASK,RUN,STEP].map(model=>store.query({model,authority:'owner',archived:'include'})));
      const rejected = await invoker().invokeMutation({operation:PARENT,operation_id:nextId(),inputs:{step:ref(duplicateStep)}},identity);
      assert.ok('error' in rejected,JSON.stringify(rejected)); assert.equal(rejected.error.code,'rule_failed');
      assert.deepEqual(await Promise.all([TASK,RUN,STEP].map(model=>store.query({model,authority:'owner',archived:'include'}))),domainBefore);
      assert.equal(batches.length,beforeRejectBatches+1);
      const afterRejected=await all(); assert.deepEqual(afterRejected.b,beforeRejected.b); assert.deepEqual(afterRejected.identity,beforeRejected.identity);
      for (const [name,rows] of Object.entries(beforeRejected.a)) if (!['receipts','fence','fence_log'].includes(name))
        assert.deepEqual(afterRejected.a[name],rows,`rejected guard changed unrelated table ${name}`);
      assert.equal(afterRejected.a['receipts']!.length,beforeRejected.a['receipts']!.length+1);
      assert.equal(await store.readRevision(), Number(batches.at(-1)!.expectedRevision)+1);
      const rejectedReceipt = batches.at(-1)!.receipt; assert.ok(rejectedReceipt); assert.equal(rejectedReceipt.outcome.status,'rejected');
      for (const effect of [batches.at(-1)!.writes,batches.at(-1)!.history,batches.at(-1)!.outbox,batches.at(-1)!.schedules]) assert.deepEqual(effect,[]);
      // Archived original query dependency withholds the saved scalar; the
      // replacement Run must not redirect replay into a new successful query.
      await mutate(`${TASK}.delete`,{record:ref(first)});
      for (const dedicated of [false,true]) {
        const before=await all(),queries=taskQueries;
        const result=dedicated?await invoker(noEffects,FIXED_NOW+16*60000).invokeRetainedMutation(fresh.envelope,identity)
          :await invoker(noEffects).invokeMutation(fresh.envelope,identity);
        assert.ok('result' in result,JSON.stringify(result)); assert.equal(result.result.result,null); assert.deepEqual(result.result.records,[]);
        assert.deepEqual(await all(),before); assert.equal(taskQueries,queries);
      }
      // Original assembled source capability remains required after cache reuse.
      const beforeCopied=await all();
      const copied=await buildInvoker(artifact,{...asm,moduleUrls:{...asm.moduleUrls}},noEffects,{appId:APP,memberships:identities,now:clock.nowMs})
        .invokeRetainedMutation(fresh.envelope,identity);
      assert.ok('error' in copied,JSON.stringify(copied)); assert.deepEqual(await all(),beforeCopied);
      const beforeForeign=await all();
      const deniedForeign=await invoker(foreign.store).invokeRetainedMutation(fresh.envelope,identity);
      assert.ok('error' in deniedForeign,JSON.stringify(deniedForeign)); assert.deepEqual(await all(),beforeForeign);
      const publicIdentity=await resolveIdentity(identities,{}, {clock});
      const beforePublic=await all();
      const publicDenied=await invoker(noEffects).invokeMutation({operation:PARENT,operation_id:nextId(),inputs:{step:ref(step)}},publicIdentity);
      assert.ok('error' in publicDenied,JSON.stringify(publicDenied)); assert.deepEqual(await all(),beforePublic);
      // Keep this saved result's influences live so membership revocation,
      // independently of the preceding archive, must withhold its disclosure.
      const revocableRun=await create(RUN,{location:ref(elsewhere),targets:[ref(excluded)]});
      const revocableStep=await create(STEP,{ordinal:'1',parent:ref(revocableRun)});
      const revocable=await mutate(PARENT,{step:ref(revocableStep)});
      assert.equal(revocable.outcome.result,'1');
      await identities.removeMembership(membership.membership_id);
      const beforeRevoked=await all(), queriesBeforeRevoked=taskQueries, batchesBeforeRevoked=batches.length;
      for (const dedicated of [false,true]) {
        const denied=dedicated?await invoker(noEffects,FIXED_NOW+16*60000).invokeRetainedMutation(revocable.envelope,identity)
          :await invoker(noEffects).invokeMutation(revocable.envelope,identity);
        if (dedicated) assert.ok('error' in denied,JSON.stringify(denied));
        else {
          // State's ordinary saved-outcome contract masks current forbidden
          // influences; dedicated admission separately refuses lost membership.
          assert.ok('result' in denied,JSON.stringify(denied)); assert.equal(denied.result.status,'replayed');
          assert.equal(denied.result.result,null); assert.deepEqual(denied.result.records,[]);
        }
        assert.deepEqual(await all(),beforeRevoked); assert.equal(taskQueries,queriesBeforeRevoked);
        assert.equal(batches.length,batchesBeforeRevoked);
        assert.deepEqual(await store.readReceipt(revocable.batch.receipt!.identity),revocable.batch.receipt);
      }
      const freshRevoked=await invoker(noEffects).invokeMutation({operation:PARENT,operation_id:nextId(),inputs:{step:ref(step)}},identity);
      assert.ok('error' in freshRevoked,JSON.stringify(freshRevoked)); assert.deepEqual(await all(),beforeRevoked);
      assert.deepEqual(await Promise.all(producerPaths.map(async path=>digest(await readFile(path)))),hashes);
    } finally { await worker?.dispose(); await rm(dir,{recursive:true,force:true}); }
  });
