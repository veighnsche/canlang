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
import type { CanTypeId, CompileArtifact, ModelName, OperationId, ProjectedRecord, Receipt, RecordId, RecordVersion, ScenarioResultDisclosurePlan,
  StoragePort } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { invoke, observeScenarioReceiptDependency, selectScenarioReceiptReturn, readScenarioReceiptAssociation } from '@canlang/state/invocation';
import { seedRow, updateRow, uuidv7, FIXED_NOW } from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from './modules.js';
import { AssemblyCorrespondenceError } from './assembly-verification.js';
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
function declaration(legacy = false, fresh = false, handlerBody?: string): CompileArtifact {
  // Data-only read selector provenance, not Function.toString() inference.
  const js = `${fresh ? 'import { set, observeScenarioReceiptDependency, selectScenarioReceiptReturn } from "@canlang/stdlib";' : ''}let executions=0;
export const executionCount=()=>executions;
let handlerProbe;
export const setHandlerProbe=probe=>{handlerProbe=probe;};
const policy={operations:{"Shop.saved":{by:["members"]}},models:{"Shop.Record":{read:["Record.read.1"]}}};
export const appDefinition={id:"SavedScenario",policy,models:{"Shop.Record":{
 fields:{visible:{type:"text"},private:{type:"text"},token:{type:"secret",init:"random_secret"}},
 readGrants:[{rule:"Record.read.1",by:["members"],fields:["visible","private"]}]}}};
export function canApp(){return {policy,read:{"Record.read.1":()=>true},Shop:{saved:async(c,input,reportDefault)=>{
 executions++; ${handlerBody ?? (legacy ? 'return "fresh legacy result";' : fresh ? 'const value=input.record.visible; await observeScenarioReceiptDependency(c,"Shop.Record",input.record,"visible","visible-value"); selectScenarioReceiptReturn(c,"selected"); return value;' : 'throw new Error("scenario replay execution tripwire");')}
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
async function world(legacy = false, fresh = false, handlerBody?: string, configure?: (artifact: CompileArtifact) => void) {
  const artifact = declaration(legacy, fresh, handlerBody); configure?.(artifact);
  const dir = await mkdtemp(join(tmpdir(), 'can-scenario-receipt-')); dirs.push(dir);
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
    inputs: Object.fromEntries(artifact.operations![0]!.inputs.fields.filter(field=>field.field.kind==='ref')
      .map(field=>[field.name,{id:row.id,version:String(row.version)}])) };
  let receipt: Receipt | undefined;
  // Only State's active admitted execution creates the association. No receipt
  // or association metadata is supplied by this executor or a request.
  await invoke({ registry: loaded.registry as Parameters<typeof invoke>[0]['registry'], envelope,
    app, identity, store, memberships: identities, source: 'consumer fixture', clock: { nowMs: () => FIXED_NOW },
    execute: async call => {
      const original = call.recordRefs[0]!.row;
      if (!legacy) {
        const returned = artifact.operations![0]!.result!.disclosure!.returns[0]!;
        for (const dependency of returned.dependencies) await observeScenarioReceiptDependency(call, store,
          { dependencyId: dependency.id, model, row: original, field: dependency.field });
        selectScenarioReceiptReturn(call, store, returned.id);
      }
      return { result: artifact.operations![0]!.result?.type === 'void' ? null : original.data['visible'], writes: [{ kind: 'update', model, id: original.id,
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
  assert.deepEqual(projectedRecords(masked.result),[],'an unavailable required dependency withholds every influenced changed record');
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


it('refuses closure drift after descriptor load and before the actual handler without canonical writes', async () => {
  const w = await world(false, true), before = await w.snapshot();
  const current = await w.store.load(model, w.row.id); assert.ok(current);
  const operationId = uuidv7(FIXED_NOW, ++sequence) as OperationId;
  const path = fileURLToPath(w.asm.moduleUrls[modulePath]!), original = await readFile(path);
  let commits = 0, drifts = 0;
  const store: StoragePort = { ...w.store,
    readReceipt: async identity => {
      const receipt = await w.store.readReceipt(identity);
      if (identity.operationId === operationId) {
        drifts++; await writeFile(path, Buffer.concat([original, Buffer.from('\n ')]));
      }
      return receipt;
    },
    commit: async () => { commits++; throw new Error('invalid source canonical commit tripwire'); },
  };
  try {
    await assert.rejects(invokeMutationCanonical({ asm: w.asm, artifact: w.artifact, operation, operationId,
      inputs: { record: { id: current.id, version: String(current.version) } }, identity: w.identity,
      app, source: 'consumer fixture', store, memberships: w.identities, now: () => FIXED_NOW }),
      AssemblyCorrespondenceError);
    assert.ok(drifts >= 1, 'real State admission reached the deliberate post-load drift');
    assert.equal(commits, 0);
    assert.equal(await w.store.readReceipt({ ...w.receipt.identity, operationId }), null);
    assert.deepEqual(await w.snapshot(), before);
    assert.deepEqual(w.counters(), { commits: 0, files: 0, executions: 0 });
  } finally { await writeFile(path, original); }
});

it('post-verifies throwing handlers for JS and map drift without converting infrastructure failure into a rejected receipt', async () => {
  for (const target of ['js', 'map'] as const) {
    const body = 'await handlerProbe(); throw new Error("business throw after source drift");';
    const w = await world(false, true, body), before = await w.snapshot();
    const current = await w.store.load(model, w.row.id); assert.ok(current);
    const operationId = uuidv7(FIXED_NOW, ++sequence) as OperationId;
    const path = fileURLToPath(target === 'js' ? w.asm.moduleUrls[modulePath]! : w.asm.mapUrls![modulePath]!);
    const original = await readFile(path);
    // Trusted fixture hook supplies the deliberate host filesystem event; the
    // artifact keeps the production import policy and exact registered bytes.
    const namespace: unknown = await import(w.asm.moduleUrls[modulePath]!);
    assert.ok(namespace && typeof namespace === 'object' && 'setHandlerProbe' in namespace &&
      typeof namespace.setHandlerProbe === 'function');
    namespace.setHandlerProbe(async () => { await writeFile(path, Buffer.concat([original, Buffer.from('\n ')])); });
    let commits = 0;
    const store: StoragePort = { ...w.store, commit: async () => {
      commits++; throw new Error('drifting handler canonical commit tripwire');
    } };
    try {
      await assert.rejects(invokeMutationCanonical({ asm: w.asm, artifact: w.artifact, operation, operationId,
        inputs: { record: { id: current.id, version: String(current.version) } }, identity: w.identity,
        app, source: 'consumer fixture', store, memberships: w.identities, now: () => FIXED_NOW }),
        AssemblyCorrespondenceError);
      assert.equal(commits, 0);
      assert.equal(await w.store.readReceipt({ ...w.receipt.identity, operationId }), null);
      assert.deepEqual(await w.snapshot(), before);
      assert.deepEqual(w.counters(), { commits: 0, files: 0, executions: 1 });
    } finally { await writeFile(path, original); }
  }
});

it('retains an unchanged-source business rejection as exactly one rejected receipt', async () => {
  const w = await world(false, true, 'throw new Error("unchanged-source business rejection");');
  const before = await w.snapshot(), current = await w.store.load(model, w.row.id); assert.ok(current);
  const operationId = uuidv7(FIXED_NOW, ++sequence) as OperationId;
  let commits = 0;
  const store: StoragePort = { ...w.store, commit: async batch => { commits++; return w.store.commit(batch); } };
  await assert.rejects(invokeMutationCanonical({ asm: w.asm, artifact: w.artifact, operation, operationId,
    inputs: { record: { id: current.id, version: String(current.version) } }, identity: w.identity,
    app, source: 'consumer fixture', store, memberships: w.identities, now: () => FIXED_NOW }),
    error => error instanceof Error && 'code' in error && error.code === 'rule_failed' &&
      error.message === 'unchanged-source business rejection');
  assert.equal(commits, 1);
  const receipt = await w.store.readReceipt({ ...w.receipt.identity, operationId }); assert.ok(receipt);
  assert.equal(receipt.outcome.status, 'rejected');
  if (receipt.outcome.status !== 'rejected') throw new Error('expected unchanged-source rejection');
  assert.equal(receipt.outcome.code, 'rule_failed');
  assert.equal(receipt.outcome.message, 'unchanged-source business rejection');
  const after = await w.snapshot();
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual({ ...after, revision: before.revision }, before);
  assert.deepEqual(w.counters(), { commits: 0, files: 0, executions: 1 });
});


/** Direct Dev consumer of State b949 owner-session issuance, not native
 * mutation compilation: declarations and handler are explicitly hand-built. */
function ownerPlan(voidResult = false): ScenarioResultDisclosurePlan {
  const origin = { path: source, sha256: sha, module: modulePath };
  return { version: 1, source: origin, returns: [{ id: 'selected', source: origin, influences: [],
    dependencies: voidResult
      ? [{ id: 'private-control', source: origin, role: 'control', model, field: 'private', type: 'text' as CanTypeId }]
      : [{ id: 'old-visible', source: origin, role: 'data', model, field: 'visible', type: 'text' as CanTypeId },
        { id: 'middle-visible', source: origin, role: 'data', model, field: 'visible', type: 'text' as CanTypeId }] }] };
}

it('requires the positive owner producer for fresh execution while retained recovery constructs no session', async () => {
  const w=await world(false,true), entry=await w.store.load(model,w.row.id); assert.ok(entry);
  const producer=w.loaded.producers.invoke as {beginScenarioReceiptMutation?: typeof import('@canlang/state/invocation').beginScenarioReceiptMutation};
  const original=producer.beginScenarioReceiptMutation; assert.ok(original !== undefined); assert.equal(typeof original,'function');
  const batches:Array<Parameters<StoragePort['commit']>[0]>=[];
  const captureStore:StoragePort={...w.store,commit:async batch=>{batches.push(batch);return w.store.commit(batch);}};
  const before=await w.snapshot(); delete producer.beginScenarioReceiptMutation;
  try {
    const outcome=await buildInvoker(w.artifact,w.asm,captureStore,{appId:app,memberships:w.identities,now:()=>FIXED_NOW})
      .invokeMutation({...w.envelope,operation_id:uuidv7(FIXED_NOW,++sequence),
        inputs:{record:{id:entry.id,version:String(entry.version)}}},w.identity);
    assert.ok('error' in outcome,JSON.stringify(outcome)); assert.equal(outcome.error.code,'validation');
    assert.match(outcome.error.message,/installed State producer/); assert.equal(w.counters().executions,0);
    const after=await w.snapshot(); assert.deepEqual({...after,revision:before.revision},before);
    for(const batch of batches) { assert.deepEqual(batch.writes,[]); assert.deepEqual(batch.history,[]);
      assert.deepEqual(batch.outbox,[]); assert.deepEqual(batch.schedules,[]);
      assert.deepEqual(batch.uniqueClaims,[]); assert.deepEqual(batch.uniqueReleases,[]); }
    const retainedBefore=await w.snapshot();
    const retained=await w.invoker(w.readonlyStore,true).invokeRetainedMutation(w.envelope,w.identity);
    assert.ok('result' in retained,JSON.stringify(retained)); assert.equal(retained.result.result,'original visible');
    assert.deepEqual(await w.snapshot(),retainedBefore); assert.deepEqual(w.counters(),{commits:0,files:0,executions:0});
  } finally { producer.beginScenarioReceiptMutation=original; }
});

it('refreshes an unchanged issued row after staging a different admitted record', async () => {
  const w=await world(false,true,`
    const old=input.record.visible;
    await observeScenarioReceiptDependency(c,"Shop.Record",input.record,"visible","old-visible");
    await set(c,input.other,{visible:"other final"});
    const current=input.record.visible;
    await observeScenarioReceiptDependency(c,"Shop.Record",input.record,"visible","middle-visible");
    selectScenarioReceiptReturn(c,"selected"); return old+"|"+current;
  `, artifact=>{
    artifact.operations![0]!.inputs.fields.push({name:'other',field:{kind:'ref',model,requireVersion:true},required:true});
    artifact.operations![0]!.result={type:'text' as CanTypeId,disclosure:ownerPlan()};
  });
  const entry=await w.store.load(model,w.row.id); assert.ok(entry);
  const other=await seedRow(w.store,model,{id:uuidv7(FIXED_NOW,++sequence) as RecordId,
    data:{visible:'other original',private:'other private',token:'other secret'}});
  const envelope={...w.envelope,operation_id:uuidv7(FIXED_NOW,++sequence),inputs:{
    record:{id:entry.id,version:String(entry.version)},other:{id:other.id,version:String(other.version)}}};
  const fresh=await buildInvoker(w.artifact,w.asm,w.store,{appId:app,memberships:w.identities,now:()=>FIXED_NOW})
    .invokeMutation(envelope,w.identity);
  assert.ok('result' in fresh,JSON.stringify(fresh)); assert.equal(fresh.result.result,'committed visible|committed visible');
  const physical=await w.store.readReceipt({...w.receipt.identity,operationId:envelope.operation_id as OperationId}); assert.ok(physical);
  const association=readScenarioReceiptAssociation(physical); assert.ok(association);
  assert.deepEqual(association.observations.map(observation=>observation.row),[entry,entry]);
  assert.equal(association.changed.length,1); assert.equal(association.changed[0]!.row.id,other.id);
  assert.equal(association.changed[0]!.row.data['visible'],'other final');
  assert.deepEqual(await w.store.load(model,entry.id),entry);
  assert.equal((await w.store.load(model,other.id))?.version,other.version+1);
});

it('joins receipt-aware stage/read/finalize into one net State row and saved intermediate result', async () => {
  const w = await world(false,true,`
    const old=input.record.visible;
    await observeScenarioReceiptDependency(c,"Shop.Record",input.record,"visible","old-visible");
    const middle=await set(c,input.record,{visible:"middle visible"});
    const value=middle.visible;
    await observeScenarioReceiptDependency(c,"Shop.Record",middle,"visible","middle-visible");
    await set(c,middle,{visible:"final visible"});
    selectScenarioReceiptReturn(c,"selected"); return old+"|"+value;
  `, artifact => { artifact.operations![0]!.result = { type: 'text' as CanTypeId, disclosure: ownerPlan() }; });
  const entry=await w.store.load(model,w.row.id); assert.ok(entry);
  const envelope={...w.envelope,operation_id:uuidv7(FIXED_NOW,++sequence),
    inputs:{record:{id:entry.id,version:String(entry.version)}}};
  const batches: Array<Parameters<StoragePort['commit']>[0]> = [];
  const captureStore: StoragePort={...w.store,commit:async batch=>{batches.push(batch);return w.store.commit(batch);}};
  const beforeHistory=await w.store.historyFor(model,entry.id);
  const fresh=await buildInvoker(w.artifact,w.asm,captureStore,{appId:app,memberships:w.identities,now:()=>FIXED_NOW})
    .invokeMutation(envelope,w.identity);
  assert.ok('result' in fresh,JSON.stringify(fresh)); assert.equal(fresh.result.status,'committed');
  assert.equal(fresh.result.result,'committed visible|middle visible');
  assert.equal(batches.length,1,'one actual State commit');
  const batch=batches[0]!; assert.equal(batch.writes.length,1); assert.equal(batch.history.length,1);
  const write=batch.writes[0]!; assert.equal(write.kind,'update');
  if(write.kind!=='update') throw new Error('expected one net update');
  assert.equal(write.expectedVersion,entry.version); assert.equal(write.row.version,entry.version+1);
  assert.deepEqual(write.row.data,{...entry.data,visible:'final visible'});
  assert.deepEqual(batch.history[0]!.before,entry.data); assert.deepEqual(batch.history[0]!.after,write.row.data);
  assert.deepEqual(batch.uniqueClaims,[]); assert.deepEqual(batch.uniqueReleases,[]);
  const physical=await w.store.readReceipt({...w.receipt.identity,operationId:envelope.operation_id as OperationId}); assert.ok(physical);
  assert.deepEqual(physical.resolvedDefaults,{},'no default is invented for updates');
  assert.deepEqual(await w.store.load(model,entry.id),write.row);
  assert.equal((await w.store.historyFor(model,entry.id)).length,beforeHistory.length+1);
  const association=readScenarioReceiptAssociation(physical); assert.ok(association);
  assert.deepEqual(association.plan,ownerPlan()); assert.equal(association.returnId,'selected');
  assert.deepEqual(association.observations.map(observation=>observation.dependencyId),['old-visible','middle-visible']);
  assert.deepEqual(association.observations[0]!.row,entry);
  assert.equal(association.observations[1]!.row.version,entry.version+1);
  assert.deepEqual(association.observations[1]!.row.data,{...entry.data,visible:'middle visible'});
  assert.deepEqual(association.changed.map(changed=>changed.row),[write.row]);
  assert.equal(JSON.stringify(fresh).includes('scenario-result/v1'),false);
  const committed=await w.store.load(model,entry.id); assert.ok(committed);
  await updateRow(w.store,model,committed,{data:{...committed.data,visible:'later visible'}});
  const before={state:await w.snapshot(),physical:await w.store.readReceipt(physical.identity)};
  for(const dedicated of [false,true]) {
    const replay=dedicated?await w.invoker(w.readonlyStore,true).invokeRetainedMutation(envelope,w.identity)
      :await w.invoker().invokeMutation(envelope,w.identity);
    assert.ok('result' in replay,JSON.stringify(replay)); assert.equal(replay.result.status,'replayed');
    assert.equal(replay.result.result,fresh.result.result);
    assert.equal(projectedRecords(replay.result)[0]?.data['visible'],'final visible');
    assert.equal(JSON.stringify(replay).includes('scenario-result/v1'),false);
    assert.deepEqual({state:await w.snapshot(),physical:await w.store.readReceipt(physical.identity)},before);
    assert.deepEqual(w.counters(),{commits:0,files:0,executions:1});
  }
});

it('withholds every public void changed record when its required read dependency is unavailable', async () => {
  const w=await world(false,true,`
    const selected=input.record.private;
    await observeScenarioReceiptDependency(c,"Shop.Record",input.record,"private","private-control");
    await set(c,input.record,{visible:selected});
    selectScenarioReceiptReturn(c,"selected"); return;
  `, artifact=>{
    artifact.operations![0]!.result={type:'void' as CanTypeId,disclosure:ownerPlan(true)};
    artifact.modules[0]!.js=artifact.modules[0]!.js.replace('"Shop.saved":{by:["members"]}', '"Shop.saved":{by:["public"]}')
      .replace('fields:["visible","private"]','fields:["visible"]');
  });
  const entry=await w.store.load(model,w.row.id); assert.ok(entry);
  const envelope={...w.envelope,operation_id:uuidv7(FIXED_NOW,++sequence),inputs:{record:{id:entry.id,version:String(entry.version)}}};
  const fresh=await buildInvoker(w.artifact,w.asm,w.store,{appId:app,memberships:w.identities,now:()=>FIXED_NOW})
    .invokeMutation(envelope,w.identity);
  assert.ok('result' in fresh,JSON.stringify(fresh)); assert.equal(fresh.result.status,'committed');
  assert.equal(fresh.result.result,null); assert.deepEqual(fresh.result.records,[],'unreadable control cannot disclose a changed value');
  const physical=await w.store.readReceipt({...w.receipt.identity,operationId:envelope.operation_id as OperationId}); assert.ok(physical);
  const association=readScenarioReceiptAssociation(physical); assert.ok(association);
  assert.equal(association.observations[0]!.row.data['private'],entry.data['private']);
  assert.equal(association.changed[0]!.row.data['visible'],entry.data['private']);
  const {buildPolicyTable}=await import('@canlang/state/policy/grants');
  for(const secret of [false,true]) {
    // Genuine current policy table: absent grant versus newly secret mask.
    const loaded=w.loaded as unknown as {policy:ReturnType<typeof buildPolicyTable>};
    loaded.policy=buildPolicyTable([{model,secretFields:secret?['private']:[],
      grants:[{by:'members',fields:['visible']}]}]);
    const before: { state: Awaited<ReturnType<typeof w.snapshot>>; physical: Receipt | null } =
      {state:await w.snapshot(),physical:await w.store.readReceipt(physical.identity)};
    for(const dedicated of [false,true]) {
      const replay=dedicated?await w.invoker(w.readonlyStore,true).invokeRetainedMutation(envelope,w.identity)
        :await w.invoker().invokeMutation(envelope,w.identity);
      assert.ok('result' in replay,JSON.stringify(replay)); assert.equal(replay.result.status,'replayed');
      assert.equal(replay.result.result,null); assert.deepEqual(replay.result.records,[]);
      assert.deepEqual({state:await w.snapshot(),physical:await w.store.readReceipt(physical.identity)},before);
      assert.deepEqual(w.counters(),{commits:0,files:0,executions:1});
    }
  }
});

it('refuses a caught cloned intermediate marker before committing staged changes', async () => {
  const w=await world(false,true,`
    const middle=await set(c,input.record,{visible:"must not commit"});
    try { await observeScenarioReceiptDependency(c,"Shop.Record",{...middle},"visible","visible-value"); } catch {}
    selectScenarioReceiptReturn(c,"selected"); return "caught";
  `);
  const entry=await w.store.load(model,w.row.id); assert.ok(entry);
  const before=await w.snapshot(), envelope={...w.envelope,operation_id:uuidv7(FIXED_NOW,++sequence),
    inputs:{record:{id:entry.id,version:String(entry.version)}}};
  const outcome=await buildInvoker(w.artifact,w.asm,w.store,{appId:app,memberships:w.identities,now:()=>FIXED_NOW})
    .invokeMutation(envelope,w.identity);
  assert.ok('error' in outcome,JSON.stringify(outcome)); assert.equal(outcome.error.code,'validation');
  const after=await w.snapshot(); assert.deepEqual(after.rows,before.rows); assert.deepEqual(after.history,before.history);
  assert.deepEqual(after.outbox,before.outbox); assert.deepEqual(after.schedules,before.schedules);
  assert.deepEqual(after.receipt,before.receipt,'original retained receipt unchanged');
  assert.deepEqual(w.counters(),{commits:0,files:0,executions:1});
});

it('retains a caught unsupported query refusal and discards earlier successful owner stages', async () => {
  const w=await world(false,true,`
    const old=input.record.visible;
    await observeScenarioReceiptDependency(c,"Shop.Record",input.record,"visible","old-visible");
    await set(c,input.record,{visible:"must not partially commit"});
    try { await c.canonical.readModel("Shop.Record",{}); } catch {}
    const middle=input.record.visible;
    await observeScenarioReceiptDependency(c,"Shop.Record",input.record,"visible","middle-visible");
    selectScenarioReceiptReturn(c,"selected"); return old+"|"+middle;
  `, artifact=>{artifact.operations![0]!.result={type:'text' as CanTypeId,disclosure:ownerPlan()};});
  const entry=await w.store.load(model,w.row.id); assert.ok(entry);
  const before=await w.snapshot(), envelope={...w.envelope,operation_id:uuidv7(FIXED_NOW,++sequence),
    inputs:{record:{id:entry.id,version:String(entry.version)}}};
  const batches:Array<Parameters<StoragePort['commit']>[0]>=[];
  const captureStore:StoragePort={...w.store,commit:async batch=>{batches.push(batch);return w.store.commit(batch);}};
  const outcome=await buildInvoker(w.artifact,w.asm,captureStore,{appId:app,memberships:w.identities,now:()=>FIXED_NOW})
    .invokeMutation(envelope,w.identity);
  assert.ok('error' in outcome,JSON.stringify(outcome)); assert.equal(outcome.error.code,'validation');
  assert.match(outcome.error.message,/query reads require their defining provenance/);
  const after=await w.snapshot(); assert.deepEqual({...after,revision:before.revision},before);
  assert.equal(batches.length,1,'only the real rejected receipt/fence is committed');
  for(const batch of batches) {assert.deepEqual(batch.writes,[]);assert.deepEqual(batch.history,[]);
    assert.deepEqual(batch.uniqueClaims,[]);assert.deepEqual(batch.uniqueReleases,[]);
    assert.deepEqual(batch.outbox,[]);assert.deepEqual(batch.schedules,[]);}
  const receipt=await w.store.readReceipt({...w.receipt.identity,operationId:envelope.operation_id as OperationId}); assert.ok(receipt);
  assert.equal(receipt.outcome.status,'rejected'); assert.equal(w.counters().executions,1);
});


it('joins omitted literal/nullable input defaults to the actual read-only or mutating owner effects', async () => {
  for(const mutates of [false,true]) {
    const w=await world(false,true,`
      if(input.optional!==null) throw new Error("nullable omission did not hydrate native null");
      if(input.message!=="defaulted input") throw new Error("literal omission did not hydrate native text");
      ${mutates ? 'await set(c,input.record,{visible:"default final"});' : ''}
      selectScenarioReceiptReturn(c,"selected"); return input.message;
    `, artifact=>{
      artifact.operations![0]!.inputs.fields.push(
        {name:'message',field:{kind:'string'},required:false,valueType:'text' as CanTypeId,
          default:{kind:'literal',value:'defaulted input'}},
        {name:'optional',field:{kind:'string'},required:false,valueType:'text?' as CanTypeId,nullable:true},
      );
      const origin={path:source,sha256:sha,module:modulePath};
      artifact.operations![0]!.result={type:'text' as CanTypeId,disclosure:{version:1,source:origin,
        returns:[{id:'selected',source:origin,influences:[],dependencies:[]}]}};
    });
    const entry=await w.store.load(model,w.row.id); assert.ok(entry);
    const envelope={...w.envelope,operation_id:uuidv7(FIXED_NOW,++sequence),
      inputs:{record:{id:entry.id,version:String(entry.version)}}};
    const before=await w.snapshot(), batches:Array<Parameters<StoragePort['commit']>[0]>=[];
    const captureStore:StoragePort={...w.store,commit:async batch=>{batches.push(batch);return w.store.commit(batch);}};
    const fresh=await buildInvoker(w.artifact,w.asm,captureStore,{appId:app,memberships:w.identities,now:()=>FIXED_NOW})
      .invokeMutation(envelope,w.identity);
    const after=await w.snapshot();
    assert.deepEqual(after.outbox,before.outbox); assert.deepEqual(after.schedules,before.schedules);
    assert.deepEqual(after.receipt,before.receipt,'original retained receipt stays unchanged');
    for(const batch of batches) {
      assert.equal(batch.writes.length,mutates?1:0); assert.equal(batch.history.length,mutates?1:0); assert.deepEqual(batch.outbox,[]);
      assert.deepEqual(batch.schedules,[]); assert.deepEqual(batch.uniqueClaims,[]); assert.deepEqual(batch.uniqueReleases,[]);
    }
    assert.ok('result' in fresh,JSON.stringify(fresh)); assert.equal(fresh.result.status,'committed');
    assert.equal(fresh.result.result,'defaulted input');
    const physical=await w.store.readReceipt({...w.receipt.identity,operationId:envelope.operation_id as OperationId}); assert.ok(physical);
    assert.deepEqual(physical.resolvedDefaults,{message:'defaulted input',optional:null});
    const association=readScenarioReceiptAssociation(physical); assert.ok(association);
    assert.deepEqual(association.observations,[]); assert.equal(association.changed.length,mutates?1:0);
    if(mutates) {
      const final=await w.store.load(model,entry.id); assert.ok(final);
      assert.equal(final.data['visible'],'default final'); assert.equal(final.version,entry.version+1);
      assert.deepEqual(association.changed[0]!.row,final);
      assert.equal(after.history.length,before.history.length+1);
      assert.equal(projectedRecords(fresh.result)[0]?.data['visible'],'default final');
    } else {
      assert.deepEqual(after.rows,before.rows); assert.deepEqual(after.history,before.history);
      assert.deepEqual(fresh.result.records,[]);
    }
    const retainedBefore={state:await w.snapshot(),physical:await w.store.readReceipt(physical.identity)};
    for(const dedicated of [false,true]) {
      const replay=dedicated?await w.invoker(w.readonlyStore,true).invokeRetainedMutation(envelope,w.identity)
        :await w.invoker().invokeMutation(envelope,w.identity);
      assert.ok('result' in replay,JSON.stringify(replay)); assert.equal(replay.result.status,'replayed');
      assert.equal(replay.result.result,'defaulted input'); assert.deepEqual(replay.result.records,fresh.result.records);
      assert.deepEqual({state:await w.snapshot(),physical:await w.store.readReceipt(physical.identity)},retainedBefore);
      assert.deepEqual(w.counters(),{commits:0,files:0,executions:1});
    }
  }
});


it('joins actual computed input-default reports to owner mutation and keeps explicit overrides report-free', async () => {
  for(const mode of ['omitted-readonly','omitted-mutation','explicit-mutation'] as const) {
    const w=await world(false,true,`
      const old=input.record.visible;
      await observeScenarioReceiptDependency(c,"Shop.Record",input.record,"visible","visible-value");
      let message=input.message;
      if(message===undefined) { message=old+":computed"; reportDefault("message",message); }
      ${mode === 'omitted-readonly' ? '' : 'await set(c,input.record,{visible:"explicit final"});'}
      selectScenarioReceiptReturn(c,"selected"); return message;
    `, artifact=>{
      artifact.operations![0]!.inputs.fields.push({name:'message',field:{kind:'string'},
        valueType:'text' as CanTypeId,required:false,computedDefault:true});
      // Both exact owning descriptor channels claim the generated omission.
      artifact.modules[0]!.js=artifact.modules[0]!.js.replace('id:"SavedScenario",policy,models:',
        'id:"SavedScenario",policy,operations:{"Shop.saved":{inputs:{message:{type:"text",computedDefault:true}}}},models:');
    });
    const entry=await w.store.load(model,w.row.id); assert.ok(entry);
    const inputs={record:{id:entry.id,version:String(entry.version)},...(mode==='explicit-mutation'?{message:'explicit'}:{})};
    const envelope={...w.envelope,operation_id:uuidv7(FIXED_NOW,++sequence),inputs};
    const before=await w.snapshot(), batches:Array<Parameters<StoragePort['commit']>[0]>=[];
    const captureStore:StoragePort={...w.store,commit:async batch=>{batches.push(batch);return w.store.commit(batch);}};
    const fresh=await buildInvoker(w.artifact,w.asm,captureStore,{appId:app,memberships:w.identities,now:()=>FIXED_NOW})
      .invokeMutation(envelope,w.identity);
    assert.ok('result' in fresh,JSON.stringify(fresh)); assert.equal(fresh.result.status,'committed');
    const expected=mode==='explicit-mutation'?'explicit':entry.data['visible']+':computed';
    assert.equal(fresh.result.result,expected);
    const physical=await w.store.readReceipt({...w.receipt.identity,operationId:envelope.operation_id as OperationId}); assert.ok(physical);
    assert.deepEqual(physical.resolvedDefaults,mode==='explicit-mutation'?{}:{message:expected});
    const association=readScenarioReceiptAssociation(physical); assert.ok(association);
    assert.deepEqual(association.observations.map(observation=>observation.dependencyId),['visible-value']);
    assert.deepEqual(association.observations[0]!.row,entry);
    if(mode!=='omitted-readonly') {
      assert.equal(association.changed.length,1);
      const final=await w.store.load(model,entry.id); assert.ok(final);
      assert.equal(final.version,entry.version+1); assert.deepEqual(association.changed[0]!.row,final);
      assert.equal(final.data['visible'],'explicit final');
      for(const batch of batches) { assert.equal(batch.writes.length,1); assert.equal(batch.history.length,1); assert.ok(batch.receipt);
        assert.deepEqual(batch.receipt.resolvedDefaults,mode==='explicit-mutation'?{}:{message:expected}); }
    }
    else { assert.deepEqual(association.changed,[]); const after=await w.snapshot();
      assert.deepEqual(after.rows,before.rows); assert.deepEqual(after.history,before.history); }
    const retainedBefore={state:await w.snapshot(),physical:await w.store.readReceipt(physical.identity)};
    for(const dedicated of [false,true]) {
      const replay=dedicated?await w.invoker(w.readonlyStore,true).invokeRetainedMutation(envelope,w.identity)
        :await w.invoker().invokeMutation(envelope,w.identity);
      assert.ok('result' in replay,JSON.stringify(replay)); assert.equal(replay.result.status,'replayed');
      assert.equal(replay.result.result,expected); assert.deepEqual(replay.result.records,fresh.result.records);
      assert.deepEqual({state:await w.snapshot(),physical:await w.store.readReceipt(physical.identity)},retainedBefore);
      assert.deepEqual(w.counters(),{commits:0,files:0,executions:1});
    }
  }
});

it('forwards computed references only after private seed proof and refuses copied or missing producers before commit', async () => {
  for(const mode of ['admitted','caught-copy','missing-producer'] as const) {
    const w=await world(false,true,`
      const old=input.record.visible;
      ${mode==='caught-copy' ? 'await set(c,input.record,{visible:"discard caught copy stage"}); try {reportDefault("alias",{...input.record});} catch {}' :
        'if(input.alias===undefined) reportDefault("alias",input.record); await set(c,input.record,{visible:"reference final"});'}
      await observeScenarioReceiptDependency(c,"Shop.Record",input.record,"visible","visible-value");
      selectScenarioReceiptReturn(c,"selected"); return old;
    `,artifact=>{
      artifact.operations![0]!.inputs.fields.push({name:'alias',field:{kind:'ref',model,requireVersion:true},required:false,computedDefault:true});
      artifact.modules[0]!.js=artifact.modules[0]!.js.replace('id:"SavedScenario",policy,models:',
        'id:"SavedScenario",policy,operations:{"Shop.saved":{inputs:{alias:{type:"Shop.Record",computedDefault:true}}}},models:');
    });
    const entry=await w.store.load(model,w.row.id); assert.ok(entry);
    const envelope={...w.envelope,operation_id:uuidv7(FIXED_NOW,++sequence),inputs:{record:{id:entry.id,version:String(entry.version)}}};
    const before=await w.snapshot(), batches:Array<Parameters<StoragePort['commit']>[0]>=[];
    const store:StoragePort={...w.store,commit:async batch=>{batches.push(batch);return w.store.commit(batch);}};
    const producer=w.loaded.producers.invoke as {observeScenarioInputComputedDefault?:typeof import('@canlang/state/invocation').observeScenarioInputComputedDefault};
    const original=producer.observeScenarioInputComputedDefault; assert.ok(original);
    if(mode==='missing-producer') delete producer.observeScenarioInputComputedDefault;
    let fresh: Awaited<ReturnType<ReturnType<typeof buildInvoker>['invokeMutation']>>;
    try { fresh=await buildInvoker(w.artifact,w.asm,store,{appId:app,memberships:w.identities,now:()=>FIXED_NOW})
      .invokeMutation(envelope,w.identity); }
    finally { producer.observeScenarioInputComputedDefault=original; }
    const after=await w.snapshot();
    if(mode!=='admitted') {
      assert.ok('error' in fresh,JSON.stringify(fresh)); assert.equal(fresh.error.code,'validation');
      assert.match(fresh.error.message,mode==='missing-producer'?/installed State contribution producer/:/earlier admitted singular nonnullable/);
      assert.equal(w.counters().executions,mode==='missing-producer'?0:1);
      assert.deepEqual({...after,revision:before.revision},before);
      assert.equal(batches.length,1); assert.ok(batches[0]!.receipt); assert.equal(batches[0]!.receipt.outcome.status,'rejected');
      for(const batch of batches) { assert.deepEqual(batch.writes,[]); assert.deepEqual(batch.history,[]);
        assert.deepEqual(batch.outbox,[]); assert.deepEqual(batch.schedules,[]);
        assert.deepEqual(batch.uniqueClaims,[]); assert.deepEqual(batch.uniqueReleases,[]); }
      continue;
    }
    assert.ok('result' in fresh,JSON.stringify(fresh)); assert.equal(fresh.result.status,'committed');
    const physical=await w.store.readReceipt({...w.receipt.identity,operationId:envelope.operation_id as OperationId}); assert.ok(physical);
    assert.deepEqual(physical.resolvedDefaults,{alias:{id:entry.id,version:String(entry.version)}});
    const final=await w.store.load(model,entry.id); assert.ok(final);
    assert.equal(final.data['visible'],'reference final'); assert.equal(final.version,entry.version+1);
    const retainedBefore={state:await w.snapshot(),physical};
    for(const dedicated of [false,true]) {
      const replay=dedicated?await w.invoker(w.readonlyStore,true).invokeRetainedMutation(envelope,w.identity):await w.invoker().invokeMutation(envelope,w.identity);
      assert.ok('result' in replay,JSON.stringify(replay)); assert.equal(replay.result.status,'replayed');
      assert.deepEqual(replay.result.result,fresh.result.result); assert.deepEqual(replay.result.records,fresh.result.records);
      assert.deepEqual({state:await w.snapshot(),physical:await w.store.readReceipt(physical.identity)},retainedBefore);
      assert.deepEqual(w.counters(),{commits:0,files:0,executions:1});
    }
  }
});
