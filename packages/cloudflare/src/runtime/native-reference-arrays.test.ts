/** Declaration-labelled State → Dev component fixture. Exact handbuilt source,
 * artifact and generated-shaped handler; not Compiler lowering, native query,
 * Task schema, browser or G2 acceptance evidence. */
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { CanTypeId, CommitBatch, CompileArtifact, ModelName, MutationEnvelope, OperationId, Receipt, StoragePort, StoredRow } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { hashInputs } from '@canlang/state/invocation/replay';
import { FIXED_NOW, seedRow, uuidv7 } from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from './modules.js';
import { buildInvoker } from '../worker/assembly.js';

const require = createRequire(import.meta.url);
const APP = 'ReferenceArrayComponent', MODEL = `${APP}.Row` as ModelName;
const OP = `${APP}.apply`, SOURCE = 'reference-array-component.can', MODULE = 'reference-array-component.mjs';
const sourceText = '## Handbuilt reference-array consumer component; no native Compiler claim.';
const sha = createHash('sha256').update(sourceText).digest('hex');
const dirs: string[] = [];
let sequence = 0;
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

function declaration(): CompileArtifact {
  const origin = { path: SOURCE, sha256: sha, module: MODULE };
  const js = `import {set,selectScenarioReceiptReturn} from '@canlang/stdlib';
let executions=0, observations=[], retained, caught=0;
export const inspect=()=>({executions,observations:structuredClone(observations),caught});
const policy={operations:{'${OP}':{by:['members']}},models:{'${MODEL}':{read:['Row.read.1']}}};
export const appDefinition={id:'${APP}',policy,models:{'${MODEL}':{
 fields:{count:{type:'int'}},readGrants:[{rule:'Row.read.1',by:['members'],fields:['count']}]}}};
export function canApp(){return {policy,read:{'Row.read.1':()=>true},${APP}:{apply:async(c,input)=>{
 executions++;
 if(Object.keys(input).some(key=>key.startsWith('targets/'))) throw new Error('flat reference slots leaked into native parameters');
 if(input.targets===null){observations.push({container:'null'});selectScenarioReceiptReturn(c,'done');return;}
 if(!Array.isArray(input.targets)||!Object.isFrozen(input.targets)) throw new Error('native reference container missing or mutable');
 const before=input.targets.map(row=>({id:row.id,version:row.version,count:row.count}));
 if(input.targets.length){
   const first=input.targets[0];
   await set(c,first,{count:first.count+1n});
   if(input.mode==='copy'||input.mode==='foreign'){
     try{await set(c,input.mode==='copy'?{...first}:retained,{count:99n});}
     catch{caught++;}
   }
   if(input.mode==='hold')retained=first;
 }
 observations.push({container:'array',before,after:input.targets.map(row=>({id:row.id,version:row.version,count:row.count}))});
 selectScenarioReceiptReturn(c,'done');
}}};}`;
  return {
    artifact_version: 1, language_version: 'declaration-labelled component', tool_version: 'consumer component',
    sources: [{ path: SOURCE, sha256: sha }],
    modules: [{ path: MODULE, js, map: { version: 3, file: MODULE, sources: [SOURCE], sourcesContent: [sourceText], names: [], mappings: '' } }],
    callables: [{ id: OP, kind: 'operation', module: MODULE, export: 'apply', member: [APP, 'apply'], inputStyle: 'parameters' }],
    pages: [], tests: [], requires: [{ capability: 'canlang.builtins', min_version: 2 },
      { capability: 'state', min_version: 1 }, { capability: 'state.parameters', min_version: 1 }],
    models: [{ name: MODEL, deleteMode: 'archive', fields: [{ name: 'count', field: { kind: 'integer' }, required: true, serverOnly: false }] }],
    operations: [{ name: OP, kind: 'scenario', description: '', inputs: { fields: [
      { name: 'targets', field: { kind: 'ref', model: MODEL, requireVersion: true }, required: true,
        array: { required: false }, nullable: true, min: 0, max: 3 },
      { name: 'mode', field: { kind: 'string' }, required: true },
    ] }, result: { type: 'void' as CanTypeId,
      disclosure: { version: 1, source: origin, returns: [{ id: 'done', source: origin, influences: [], dependencies: [] }] } } }],
  };
}

interface NativeObservation {
  container: 'null' | 'array';
  before?: Array<{ id: string; version: bigint; count: bigint }>;
  after?: Array<{ id: string; version: bigint; count: bigint }>;
}
async function world() {
  const artifact = declaration();
  const dir = await mkdtemp(join(tmpdir(), 'can-native-ref-array-')); dirs.push(dir);
  const asm = await assembleModules({ artifact, sourcePath: SOURCE }, { workDir: dir,
    stdlibUrl: pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href });
  const clock = createFrozenClock(FIXED_NOW), identities = createMemoryIdentityStore({ clock });
  const team = await identities.createTeam({});
  const user = await identities.createUser({ email: 'member@reference-array.test', password_hash: 'unused', email_verified: true });
  const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
  const token = randomBytes(32).toString('hex');
  await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
    expires_at: new Date(FIXED_NOW + 3600000).toISOString(), last_team_id: team.team_id });
  const identity = await resolveIdentity(identities, { session_token: token }, { clock });
  const { store: physical, probe } = createTestMemoryStorage();
  const seededA = await seedRow(physical, MODEL, { id: uuidv7(FIXED_NOW, ++sequence), data: { count: '3' } });
  const seededB = await seedRow(physical, MODEL, { id: uuidv7(FIXED_NOW, ++sequence), data: { count: '7' } });
  const a = await physical.load(MODEL, seededA.id), b = await physical.load(MODEL, seededB.id);
  assert.ok(a); assert.ok(b);
  const batches: CommitBatch[] = [];
  const store: StoragePort = { ...physical, commit: async batch => {
    const result = await physical.commit(batch); batches.push(batch); return result;
  } };
  const invoker = buildInvoker(artifact, asm, store, { appId: APP, memberships: identities, now: () => FIXED_NOW });
  const namespace = await import(asm.moduleUrls[MODULE]!);
  assert.equal(typeof namespace.inspect, 'function');
  const inspect = namespace.inspect as () => { executions: number; observations: NativeObservation[]; caught: number };
  const envelope = (targets: unknown, mode = 'normal'): MutationEnvelope => ({ operation: OP,
    operation_id: uuidv7(FIXED_NOW, ++sequence) as OperationId, inputs: { targets, mode } });
  const receiptIdentity = (request: MutationEnvelope): Receipt['identity'] => ({ app: APP,
    owner: team.team_id, principal: user.user_id, operation: OP as Receipt['identity']['operation'], operationId: request.operation_id as OperationId });
  const snapshot = async () => ({ revision: await physical.readRevision(), rows: await physical.query({ model: MODEL, authority: 'owner', archived: 'include' }),
    aHistory: probe.historyFor(MODEL, a.id), bHistory: probe.historyFor(MODEL, b.id), outbox: probe.outboxAll(),
    schedules: await physical.schedulesDue(Number.MAX_SAFE_INTEGER, 100), membership: await identities.findMembershipById(membership.membership_id) });
  return { a, b, physical, probe, store, batches, invoker, inspect, envelope, receiptIdentity, snapshot, identities, identity, membership };
}
const ref = (row: StoredRow) => ({ id: row.id, version: String(row.version) });

it('hydrates ordered repeated native root slots and tracks current values with original versions in one receipt and replay', async () => {
  const w = await world(), before = await w.snapshot();
  const request = w.envelope([ref(w.b), ref(w.a), ref(w.b)]);
  const outcome = await w.invoker.invokeMutation(request, w.identity);
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.status, 'committed');
  assert.equal(outcome.result.result, null);
  assert.deepEqual(w.inspect(), { executions: 1, caught: 0, observations: [{ container: 'array',
    before: [{ id: w.b.id, version: 1n, count: 7n }, { id: w.a.id, version: 1n, count: 3n }, { id: w.b.id, version: 1n, count: 7n }],
    after: [{ id: w.b.id, version: 1n, count: 8n }, { id: w.a.id, version: 1n, count: 3n }, { id: w.b.id, version: 1n, count: 8n }],
  }] });
  assert.equal(w.batches.length, 1, 'one outer canonical finalization');
  assert.equal(w.batches[0]!.writes.length, 1);
  assert.equal(w.batches[0]!.history.length, 1);
  assert.equal((await w.physical.load(MODEL, w.b.id))?.version, 2);
  assert.deepEqual(await w.physical.load(MODEL, w.a.id), w.a);
  assert.equal(await w.physical.readRevision(), before.revision + 1);
  const receipt = await w.physical.readReceipt(w.receiptIdentity(request));
  assert.ok(receipt); assert.equal(receipt.outcome.status, 'committed');
  if (receipt.outcome.status !== 'committed') throw new Error('expected committed reference-array receipt');
  assert.deepEqual(receipt.identity, w.receiptIdentity(request));
  assert.equal(receipt.inputHash, await hashInputs(request.inputs));
  assert.deepEqual(receipt.outcome.recordVersions, [{ model: MODEL, id: w.b.id, version: 2 }]);
  assert.deepEqual(w.batches[0]!.outbox, []); assert.deepEqual(w.batches[0]!.schedules, []);
  assert.deepEqual(w.batches[0]!.uniqueClaims, []); assert.deepEqual(w.batches[0]!.uniqueReleases, []);
  const saved = await w.snapshot(), observed = w.inspect();
  const replay = await w.invoker.invokeMutation(request, w.identity);
  assert.ok('result' in replay, JSON.stringify(replay));
  assert.equal(replay.result.status, 'replayed');
  assert.equal(replay.result.result, null);
  assert.deepEqual(await w.snapshot(), saved);
  assert.deepEqual(w.inspect(), observed);
  assert.equal(w.batches.length, 1);
  assert.deepEqual(await w.physical.readReceipt(w.receiptIdentity(request)), receipt);
});

it('preserves actual nullable and empty root containers and rejects owning length or element-null violations', async () => {
  const w = await world();
  for (const targets of [null, []]) {
    const before = await w.snapshot();
    const request = w.envelope(targets);
    const outcome = await w.invoker.invokeMutation(request, w.identity);
    assert.ok('result' in outcome, JSON.stringify(outcome)); assert.equal(outcome.result.status, 'committed');
    const after = await w.snapshot();
    assert.deepEqual(after.rows, before.rows); assert.deepEqual(after.aHistory, before.aHistory); assert.deepEqual(after.bHistory, before.bHistory);
    assert.deepEqual(after.outbox, before.outbox); assert.deepEqual(after.schedules, before.schedules);
    assert.deepEqual(after.membership, before.membership);
    assert.equal(after.revision, before.revision + 1);
    const batch = w.batches.at(-1)!;
    assert.deepEqual(batch.writes, []); assert.deepEqual(batch.history, []);
    const saved = await w.snapshot(), executions = w.inspect().executions;
    const replay = await w.invoker.invokeMutation(request, w.identity);
    assert.ok('result' in replay, JSON.stringify(replay)); assert.equal(replay.result.status, 'replayed');
    assert.deepEqual(await w.snapshot(), saved); assert.equal(w.inspect().executions, executions);
  }
  assert.deepEqual(w.inspect().observations, [{ container: 'null' }, { container: 'array', before: [], after: [] }]);
  for (const targets of [[ref(w.a), ref(w.a), ref(w.a), ref(w.a)], [null], ref(w.a)]) {
    const before = await w.snapshot(), executions = w.inspect().executions, commits = w.batches.length;
    const request = w.envelope(targets);
    const denied = await w.invoker.invokeMutation(request, w.identity);
    assert.ok('error' in denied, JSON.stringify(denied)); assert.equal(denied.error.code, 'validation');
    assert.deepEqual(await w.snapshot(), before); assert.equal(w.inspect().executions, executions); assert.equal(w.batches.length, commits);
    assert.equal(await w.physical.readReceipt(w.receiptIdentity(request)), null);
  }
});

it('refuses stale, missing and foreign-owner elements and revoked callers before handler or physical effects', async () => {
  const w = await world();
  // Another genuine isolated owner store supplies an actual foreign record ID.
  // This tests the selected physical store boundary, not a name-derived grant.
  const foreign = await world();
  for (const [targets, expected] of [
    [[ref(w.a), { id: w.b.id, version: '99' }], 'conflict'],
    [[ref(w.a), { id: uuidv7(FIXED_NOW, ++sequence), version: '1' }], 'not_found'],
    [[ref(w.a), ref(foreign.a)], 'not_found'],
  ] as const) {
    const before = await w.snapshot(), foreignBefore = await foreign.snapshot();
    const request = w.envelope(targets);
    const denied = await w.invoker.invokeMutation(request, w.identity);
    assert.ok('error' in denied, JSON.stringify(denied)); assert.equal(denied.error.code, expected);
    assert.deepEqual(await w.snapshot(), before); assert.deepEqual(await foreign.snapshot(), foreignBefore);
    assert.equal(w.inspect().executions, 0); assert.equal(w.batches.length, 0);
    assert.equal(await w.physical.readReceipt(w.receiptIdentity(request)), null);
  }
  await w.identities.removeMembership(w.membership.membership_id);
  const before = await w.snapshot();
  const denied = await w.invoker.invokeMutation(w.envelope([ref(w.a)]), w.identity);
  assert.ok('error' in denied, JSON.stringify(denied)); assert.equal(denied.error.code, 'forbidden');
  assert.deepEqual(await w.snapshot(), before); assert.equal(w.inspect().executions, 0); assert.equal(w.batches.length, 0);
});

it('latches copied and prior-frame native array views after a real stage and rolls domain and history back', async () => {
  for (const mode of ['copy', 'foreign']) {
    const w = await world();
    if (mode === 'foreign') {
      const held = await w.invoker.invokeMutation(w.envelope([ref(w.b)], 'hold'), w.identity);
      assert.ok('result' in held, JSON.stringify(held)); assert.equal(held.result.status, 'committed');
    }
    const before = await w.snapshot(), commits = w.batches.length, executions = w.inspect().executions;
    const request = w.envelope([ref(w.a)], mode);
    const denied = await w.invoker.invokeMutation(request, w.identity);
    assert.ok('error' in denied, JSON.stringify(denied)); assert.equal(denied.error.code, 'validation');
    const after = await w.snapshot();
    assert.deepEqual(after.rows, before.rows); assert.deepEqual(after.aHistory, before.aHistory); assert.deepEqual(after.bHistory, before.bHistory);
    assert.deepEqual(after.outbox, before.outbox); assert.deepEqual(after.schedules, before.schedules); assert.deepEqual(after.membership, before.membership);
    assert.equal(after.revision, before.revision + 1, 'only exact rejected-receipt bookkeeping may commit');
    assert.equal(w.inspect().executions, executions + 1); assert.equal(w.inspect().caught, 1);
    assert.equal(w.batches.length, commits + 1);
    const batch = w.batches.at(-1)!;
    assert.deepEqual(batch.writes, []); assert.deepEqual(batch.history, []); assert.deepEqual(batch.outbox, []);
    assert.deepEqual(batch.schedules, []); assert.deepEqual(batch.uniqueClaims, []); assert.deepEqual(batch.uniqueReleases, []);
    const receipt = await w.physical.readReceipt(w.receiptIdentity(request));
    assert.ok(receipt); assert.equal(receipt.outcome.status, 'rejected');
    if (receipt.outcome.status !== 'rejected') throw new Error('expected exact rejected receipt');
    assert.equal(receipt.outcome.code, 'validation');
    assert.equal(receipt.outcome.message, denied.error.message);
    assert.deepEqual(receipt.identity, w.receiptIdentity(request));
    assert.deepEqual(receipt.resolvedDefaults, {});
    assert.equal(receipt.inputHash, await hashInputs(request.inputs));
    assert.deepEqual(batch.receipt, receipt);
  }
});
