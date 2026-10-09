/** Declaration-labelled consumer fixture. Actual installed State admission,
 * capture and projection plus Identity and exact staged fixture modules.
 * This is not native Compiler disclosure/marker acceptance. */
import assert from 'node:assert/strict';
import { it, afterEach } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type { CanTypeId, CompileArtifact, ModelName, OperationId, ProjectedRecord, Receipt, RecordVersion, ScenarioResultDisclosurePlan,
  StoragePort } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { invoke, observeScenarioReceiptDependency, selectScenarioReceiptReturn } from '@canlang/state/invocation';
import { seedRow, updateRow, uuidv7, FIXED_NOW } from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from './modules.js';
import { buildInvoker } from '../worker/assembly.js';
import { invokeMutationCanonical, loadCanonicalDescriptors } from './invoke.js';

const require = createRequire(import.meta.url);
const model = 'Shop.Record' as ModelName, operation = 'Shop.saved', app = 'SavedScenario';
const source = 'saved-fixture.can', modulePath = 'saved.mjs';
const sourceText = '## Declaration-labelled saved scalar fixture, not compiled Can.';
const sha = createHash('sha256').update(sourceText).digest('hex');
let sequence = 0;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
function projectedRecords(value: { readonly records?: readonly unknown[] }): readonly ProjectedRecord[] {
  assert.ok(Array.isArray(value.records));
  for (const row of value.records) {
    assert.ok(typeof row === 'object' && row !== null && !Array.isArray(row));
    const data = Object.getOwnPropertyDescriptor(row, 'data');
    assert.ok(data !== undefined && 'value' in data && typeof data.value === 'object' && data.value !== null && !Array.isArray(data.value));
  }
  return value.records as readonly ProjectedRecord[];
}

function plan(): ScenarioResultDisclosurePlan {
  const origin = { path: source, sha256: sha, module: modulePath };
  return { version: 1, source: origin, returns: [{ id: 'selected', source: origin, influences: [],
    dependencies: [{ id: 'visible-value', source: origin, role: 'data', model, field: 'visible', type: 'text' as CanTypeId }] }] };
}
function declaration(legacy = false, fresh = false): CompileArtifact {
  // Data-only read selector provenance, not Function.toString() inference.
  const js = `${fresh ? 'import { observeScenarioReceiptDependency, selectScenarioReceiptReturn } from "@canlang/stdlib";' : ''}let executions=0;
export const executionCount=()=>executions;
const policy={operations:{"Shop.saved":{by:["members"]}},models:{"Shop.Record":{read:["Record.read.1"]}}};
export const appDefinition={id:"SavedScenario",policy,models:{"Shop.Record":{
 fields:{visible:{type:"text"},private:{type:"text"},token:{type:"secret",init:"random_secret"}},
 readGrants:[{rule:"Record.read.1",by:["members"],fields:["visible","private"]}]}}};
export function canApp(){return {policy,read:{"Record.read.1":()=>true},Shop:{saved:async(c,input)=>{
 executions++; ${legacy ? 'return "fresh legacy result";' : fresh ? 'const value=input.record.visible; await observeScenarioReceiptDependency(c,"Shop.Record",input.record,"visible","visible-value"); selectScenarioReceiptReturn(c,"selected"); return value;' : 'throw new Error("scenario replay execution tripwire");'}
}}};}`;
  return { artifact_version: 1, language_version: 'declaration-labelled fixture', tool_version: 'consumer fixture',
    sources: [{ path: source, sha256: sha }], modules: [{ path: modulePath, js,
      map: { version: 3, file: modulePath, sources: [source], sourcesContent: [sourceText], names: [], mappings: '' } }],
    callables: [{ id: operation, kind: 'operation', module: modulePath, export: 'saved', member: ['Shop','saved'], inputStyle: 'parameters' }],
    pages: [], tests: [], requires: [{ capability: 'canlang.builtins', min_version: 2 }, { capability: 'state', min_version: 1 }, { capability: 'state.parameters', min_version: 1 }],
    models: [{ name: model, deleteMode: 'archive', fields: [
      { name: 'visible', field: { kind: 'string' }, required: true, serverOnly: false },
      { name: 'private', field: { kind: 'string' }, required: true, serverOnly: false },
      { name: 'token', field: { kind: 'secret' }, required: false, serverOnly: true,
        default: { kind: 'server', init: 'random_secret' } },
    ] }], operations: [{ name: operation, kind: 'scenario', description: '',
      inputs: { fields: [{ name: 'record', field: { kind: 'ref', model, requireVersion: true }, required: true }] },
      ...(legacy ? {} : { result: { type: 'text' as CanTypeId, disclosure: plan() } }) }],
  };
}
async function world(legacy = false, fresh = false) {
  const artifact = declaration(legacy, fresh), dir = await mkdtemp(join(tmpdir(), 'can-scenario-receipt-')); dirs.push(dir);
  const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: dir,
    stdlibUrl: pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href });
  const clock = createFrozenClock(FIXED_NOW), identities = createMemoryIdentityStore({ clock });
  const team = await identities.createTeam({});
  const user = await identities.createUser({ email: 'member@saved-scenario.test', password_hash: 'unused', email_verified: true });
  const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
  const token = randomBytes(32).toString('hex');
  await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
    expires_at: new Date(FIXED_NOW+3600000).toISOString(), last_team_id: team.team_id });
  const identity = await resolveIdentity(identities, { session_token: token }, { clock });
  const { store, probe } = createTestMemoryStorage();
  const row = await seedRow(store, model, { data: { visible: 'original visible', private: 'original private', token: 'original secret' } });
  const loaded = await loadCanonicalDescriptors(asm, artifact);
  const envelope = { operation, operation_id: uuidv7(FIXED_NOW, ++sequence),
    inputs: { record: { id: row.id, version: String(row.version) } } };
  let receipt: Receipt | undefined;
  // Only State's active admitted execution creates the association. No receipt
  // or association metadata is supplied by this executor or a request.
  await invoke({ registry: loaded.registry as Parameters<typeof invoke>[0]['registry'], envelope,
    app, identity, store, memberships: identities, source: 'consumer fixture', clock: { nowMs: () => FIXED_NOW },
    execute: async call => {
      const original = call.recordRefs[0]!.row;
      if (!legacy) {
        await observeScenarioReceiptDependency(call, store, { dependencyId: 'visible-value', model, row: original, field: 'visible' });
        selectScenarioReceiptReturn(call, store, 'selected');
      }
      return { result: original.data['visible'], writes: [{ kind: 'update', model, id: original.id,
        expectedVersion: original.version, row: { ...original, version: (original.version+1) as RecordVersion,
          data: { ...original.data, visible: 'committed visible' } } }], history: [], outbox: [], schedules: [],
        uniqueClaims: [], uniqueReleases: [], resolvedDefaults: {} };
    }, observeCommittedReceipt: value => { receipt = value; } });
  assert.ok(receipt);
  const namespace: unknown = await import(asm.moduleUrls[modulePath]!);
  assert.ok(namespace && typeof namespace === 'object' && 'executionCount' in namespace);
  const executionCount = (namespace as { executionCount: () => number }).executionCount;
  let commits = 0, files = 0;
  const readonlyStore: StoragePort = { ...store, commit: async () => { commits++; throw new Error('replay commit tripwire'); } };
  const fileTripwire = new Proxy({}, { get() { files++; throw new Error('replay file tripwire'); } });
  // No property can be accessed, including inspection of optional file methods.
  const invoker = (selected = readonlyStore, aged = false) => buildInvoker(artifact, asm, selected,
    { appId: app, memberships: identities, now: () => FIXED_NOW+(aged ? 16*60000 : 0),
      files: fileTripwire as NonNullable<NonNullable<Parameters<typeof buildInvoker>[3]>['files']> });
  const snapshot = async () => ({ receipt: await store.readReceipt(receipt!.identity), revision: await store.readRevision(),
    rows: await store.query({ model, authority: 'owner', archived: 'include' }),
    history: probe.historyFor(model, row.id), outbox: probe.outboxAll(),
    schedules: await store.schedulesDue(Number.MAX_SAFE_INTEGER, 100) });
  const counters = () => ({ commits, files, executions: executionCount() });
  return { artifact, asm, loaded, store, readonlyStore, invoker, snapshot, counters, identities, identity, membership,
    row, envelope, receipt, legacy };
}

it('projects original saved scalar and changed snapshots through ordinary and dedicated transport with no execution, commit or file access', async () => {
  const w = await world(), before = await w.snapshot();
  const crud=w.loaded.producers.crud, ordinaryFactory=crud.generatedCrudExecute,
    ownerFactory=crud.generatedCrudExecuteOwnerSession;
  let factoryCalls=0;
  crud.generatedCrudExecute=()=>{factoryCalls++;throw new Error('retained ordinary factory tripwire');};
  const mutable=crud as {generatedCrudExecuteOwnerSession?:typeof ownerFactory};
  delete mutable.generatedCrudExecuteOwnerSession;
  try {
    const retained=await w.invoker(w.readonlyStore,true).invokeRetainedMutation(w.envelope,w.identity);
    assert.ok('result' in retained,JSON.stringify(retained)); assert.equal(retained.result.result,'original visible');
    assert.equal(factoryCalls,0,'retained admission constructs no ordinary or owner executor');
    assert.deepEqual(await w.snapshot(),before); assert.deepEqual(w.counters(),{commits:0,files:0,executions:0});
  } finally { crud.generatedCrudExecute=ordinaryFactory; if (ownerFactory === undefined) delete mutable.generatedCrudExecuteOwnerSession; else mutable.generatedCrudExecuteOwnerSession=ownerFactory; }
  for (const dedicated of [false, true]) {
    const outcome = dedicated ? await w.invoker(w.readonlyStore,true).invokeRetainedMutation(w.envelope,w.identity)
      : await w.invoker().invokeMutation(w.envelope,w.identity);
    assert.ok('result' in outcome, JSON.stringify(outcome));
    assert.equal(outcome.result.status,'replayed'); assert.equal(outcome.result.result,'original visible');
    assert.equal(projectedRecords(outcome.result)[0]?.data['visible'],'committed visible');
    assert.equal(Object.hasOwn(projectedRecords(outcome.result)[0]!.data,'token'),false);
    assert.equal(JSON.stringify(outcome).includes('scenario-result/v1'),false,'association stays private');
    assert.deepEqual(await w.snapshot(),before); assert.deepEqual(w.counters(),{commits:0,files:0,executions:0});
  }
  for (const [envelope, code] of [
    [{...w.envelope,operation_id:uuidv7(FIXED_NOW,++sequence)},'not_found'],
    [{...w.envelope,inputs:{record:{id:w.row.id,version:'999'}}},'conflict'],
  ] as const) {
    const denied=await w.invoker(w.readonlyStore,true).invokeRetainedMutation(envelope,w.identity);
    assert.ok('error' in denied,JSON.stringify(denied)); assert.equal(denied.error.code,code);
    assert.deepEqual(await w.snapshot(),before); assert.deepEqual(w.counters(),{commits:0,files:0,executions:0});
  }
  const canonical = await invokeMutationCanonical({ asm:w.asm,artifact:w.artifact,operation,
    operationId:w.envelope.operation_id,inputs:w.envelope.inputs,identity:w.identity,app,source:'consumer fixture',
    store:w.readonlyStore,memberships:w.identities,now:()=>FIXED_NOW });
  assert.equal(canonical.result,'original visible'); assert.deepEqual(await w.snapshot(),before);
  assert.deepEqual(w.counters(),{commits:0,files:0,executions:0});
});

it('uses current secret masks and lifetime, then refuses revoked membership without changing the physical receipt or stores', async () => {
  const w = await world();
  // Policy is already the defining State table, not a parallel projector.
  // Mutate the current checked table only via its existing producer, retaining
  // original saved association; this is a labelled authority-change control.
  const { buildPolicyTable } = await import('@canlang/state/policy/grants');
  const held = w.loaded as unknown as { policy: ReturnType<typeof buildPolicyTable> };
  held.policy = buildPolicyTable([{ model, secretFields:['visible'],
    grants:[{by:'members',fields:['private','token']}] }]);
  let before = await w.snapshot();
  const masked = await w.invoker(w.readonlyStore,true).invokeRetainedMutation(w.envelope,w.identity);
  assert.ok('result' in masked,JSON.stringify(masked)); assert.equal(masked.result.result,null);
  assert.deepEqual(projectedRecords(masked.result)[0]?.data,{private:'original private'});
  assert.deepEqual(await w.snapshot(),before);
  const current = await w.store.load(model,w.row.id); assert.ok(current);
  await updateRow(w.store,model,current,{archivedAt:FIXED_NOW+1}); before=await w.snapshot();
  const expired = await w.invoker().invokeMutation(w.envelope,w.identity);
  assert.ok('result' in expired,JSON.stringify(expired)); assert.equal(expired.result.result,null); assert.deepEqual(expired.result.records,[]);
  assert.deepEqual(await w.snapshot(),before);
  await w.identities.removeMembership(w.membership.membership_id);
  const revoked = await w.invoker(w.readonlyStore,true).invokeRetainedMutation(w.envelope,w.identity);
  assert.ok('error' in revoked,JSON.stringify(revoked)); assert.equal(revoked.error.code,'forbidden');
  assert.deepEqual(await w.snapshot(),before); assert.deepEqual(w.counters(),{commits:0,files:0,executions:0});
});

it('refuses malformed association and legacy saved results without disclosing or upgrading them', async () => {
  for (const legacy of [false,true]) {
    const w = await world(legacy), before=await w.snapshot();
    // Malformed test store preserves the physical original and returns a damaged
    // copy to the consumer; the exact State reader owns validation.
    const broken: StoragePort = legacy ? w.readonlyStore : { ...w.readonlyStore,readReceipt:async identity => {
      const receipt=await w.store.readReceipt(identity); if(!receipt) return null;
      assert.equal(receipt.outcome.status,'committed');
      return { ...receipt,outcome:{ ...receipt.outcome,scenario:{kind:'unknown-association'} } } as unknown as Receipt;
    } };
    for(const dedicated of [false,true]) {
      const outcome=dedicated?await w.invoker(broken,true).invokeRetainedMutation(w.envelope,w.identity)
        :await w.invoker(broken).invokeMutation(w.envelope,w.identity);
      assert.ok('error' in outcome,JSON.stringify(outcome)); assert.equal(outcome.error.code,'validation');
      assert.deepEqual(await w.snapshot(),before); assert.deepEqual(w.counters(),{commits:0,files:0,executions:0});
    }
  }
});

it('refuses missing scenario projection support before fresh claimed execution or retained admission', async () => {
  const w=await world(), before=await w.snapshot();
  const producer=w.loaded.producers.invoke as { projectScenarioReceipt?: typeof import('@canlang/state/invocation').projectScenarioReceipt };
  const original=producer.projectScenarioReceipt;
  assert.ok(original !== undefined);
  assert.equal(typeof original,'function');
  delete producer.projectScenarioReceipt;
  try {
    for(const dedicated of [false,true]) {
      const envelope=dedicated?w.envelope:{...w.envelope,operation_id:uuidv7(FIXED_NOW,++sequence)};
      const outcome=dedicated?await w.invoker(w.readonlyStore,true).invokeRetainedMutation(envelope,w.identity):await w.invoker().invokeMutation(envelope,w.identity);
      assert.ok('error' in outcome,JSON.stringify(outcome)); assert.equal(outcome.error.code,'validation');
      assert.match(outcome.error.message,/cannot disclose a saved scenario outcome/);
      assert.deepEqual(await w.snapshot(),before); assert.deepEqual(w.counters(),{commits:0,files:0,executions:0});
    }
  } finally { producer.projectScenarioReceipt=original; }
});

it('preserves fresh truly unclaimed legacy scenario behavior', async () => {
  const w=await world(true), current=await w.store.load(model,w.row.id); assert.ok(current);
  const invoker=buildInvoker(w.artifact,w.asm,w.store,{appId:app,memberships:w.identities,now:()=>FIXED_NOW});
  const outcome=await invoker.invokeMutation({...w.envelope,operation_id:uuidv7(FIXED_NOW,++sequence),
    inputs:{record:{id:current.id,version:String(current.version)}}},w.identity);
  assert.ok('result' in outcome,JSON.stringify(outcome)); assert.equal(outcome.result.status,'committed');
  assert.equal(outcome.result.result,'fresh legacy result'); assert.equal(w.counters().executions,1);
});


it('captures and projects a fresh claimed scalar through actual canonical seam and installed facade markers', async () => {
  // Separate prepared tuple retains a valid State-generated saved receipt for
  // the earlier recovery controls; this fresh ID executes the real host seam.
  const w=await world(false,true), current=await w.store.load(model,w.row.id); assert.ok(current);
  const envelope={...w.envelope,operation_id:uuidv7(FIXED_NOW,++sequence),
    inputs:{record:{id:current.id,version:String(current.version)}}};
  const fresh=buildInvoker(w.artifact,w.asm,w.store,{appId:app,memberships:w.identities,now:()=>FIXED_NOW});
  const outcome=await fresh.invokeMutation(envelope,w.identity);
  assert.ok('result' in outcome,JSON.stringify(outcome)); assert.equal(outcome.result.status,'committed');
  assert.equal(outcome.result.result,'committed visible'); assert.deepEqual(outcome.result.records,[]);
  assert.equal(w.counters().executions,1,'real emitted-shaped handler ran exactly once');
  const receipt=await w.store.readReceipt({...w.receipt.identity,operationId:envelope.operation_id as OperationId});
  assert.ok(receipt); assert.equal(receipt.outcome.status,'committed');
  if(receipt.outcome.status!=='committed') throw new Error('fresh scenario did not commit');
  assert.ok(receipt.outcome.scenario,'actual active capture produced physical association');
  assert.equal(JSON.stringify(outcome).includes('scenario-result/v1'),false);
  const before={physical:receipt,revision:await w.store.readRevision(),rows:await w.store.query({model,authority:'owner',archived:'include'}),
    history:await w.store.historyFor(model,w.row.id),outbox:await w.store.outboxPending(),schedules:await w.store.schedulesDue(Number.MAX_SAFE_INTEGER,100)};
  const recovery=buildInvoker(w.artifact,w.asm,w.readonlyStore,{appId:app,memberships:w.identities,now:()=>FIXED_NOW+16*60000});
  const replay=await recovery.invokeRetainedMutation(envelope,w.identity);
  assert.ok('result' in replay,JSON.stringify(replay)); assert.equal(replay.result.status,'replayed');
  assert.equal(replay.result.result,outcome.result.result); assert.deepEqual(replay.result.records,outcome.result.records);
  assert.deepEqual({physical:await w.store.readReceipt(receipt.identity),revision:await w.store.readRevision(),rows:await w.store.query({model,authority:'owner',archived:'include'}),
    history:await w.store.historyFor(model,w.row.id),outbox:await w.store.outboxPending(),schedules:await w.store.schedulesDue(Number.MAX_SAFE_INTEGER,100)},before);
  assert.deepEqual(w.counters(),{commits:0,files:0,executions:1});
});


it('requires the original issuer and unchanged whole staged closure for cached scenario disclosure', async () => {
  const w = await world(), before = await w.snapshot();
  const assertUnchanged = async () => {
    assert.deepEqual(await w.snapshot(), before);
    assert.deepEqual(w.counters(), { commits: 0, files: 0, executions: 0 });
  };
  // A structural copy has no issuer; another genuine assembly still is not
  // the assembly whose checked registry and disclosure plan were cached.
  const dir = await mkdtemp(join(tmpdir(), 'can-scenario-receipt-swapped-')); dirs.push(dir);
  const swapped = await assembleModules({ artifact: w.artifact, sourcePath: source }, { workDir: dir,
    stdlibUrl: pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href });
  await assert.rejects(loadCanonicalDescriptors({ ...w.asm }, { ...w.artifact }), /not assembler-owned/);
  await assertUnchanged();
  for (const asm of [{ ...w.asm }, swapped]) {
    await assert.rejects(loadCanonicalDescriptors(asm, w.artifact), /original verified assembly/);
    await assertUnchanged();
  }
  const op = w.artifact.operations![0]!;
  for (const [object, key] of [[op, 'result'], [op.result!, 'disclosure']] as const) {
    const original = Object.getOwnPropertyDescriptor(object, key)!;
    let reads = 0;
    try {
      Object.defineProperty(object, key, { configurable: true, enumerable: true,
        get() { reads++; throw new Error('disclosure accessor tripwire'); } });
      await assert.rejects(loadCanonicalDescriptors(w.asm, w.artifact), /data-only/);
      assert.equal(reads, 0, 'source presence gate never evaluates metadata accessors');
      await assertUnchanged();
    } finally { Object.defineProperty(object, key, original); }
  }
  for (const url of [w.asm.moduleUrls[modulePath]!, w.asm.mapUrls![modulePath]!]) {
    const path = fileURLToPath(url), original = await readFile(path);
    try {
      await writeFile(path, Buffer.concat([original, Buffer.from('\n ')]));
      await assert.rejects(loadCanonicalDescriptors(w.asm, w.artifact), /staged module bytes changed/);
      const outcome = await w.invoker(w.readonlyStore, true).invokeRetainedMutation(w.envelope, w.identity);
      assert.ok('error' in outcome, JSON.stringify(outcome));
      await assertUnchanged();
    } finally { await writeFile(path, original); }
    assert.equal(await loadCanonicalDescriptors(w.asm, w.artifact), w.loaded);
  }
  const outcome = await w.invoker(w.readonlyStore, true).invokeRetainedMutation(w.envelope, w.identity);
  assert.ok('result' in outcome, JSON.stringify(outcome));
  assert.equal(outcome.result.result, 'original visible');
  await assertUnchanged();
});
