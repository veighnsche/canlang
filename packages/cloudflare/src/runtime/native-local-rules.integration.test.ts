/** Actual native compile and canonical memory consumer; no whole-app or D1 claim. */
import { createCheckoutScratch } from './checkout-scratch.test-support.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { before, after, it } from 'node:test';
import type { CommitBatch, CompileArtifact, ModelName, MutationResult, OperationId, OperationName, RecordId, StoragePort } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { hashInputs } from '@canlang/state/invocation/replay';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { distribution } from '@canlang/values/distribution';
import { prepareLocalPreviewCapture } from './native-dev.test-support.js';
import { captureIsCurrent, captureSingleFileSource } from './native-dev.test-support.js';
import { compileCapturedSingleFile } from './native-dev.test-support.js';
import { assembleModules, type AssembledModules } from './modules.js';
import { buildInvoker } from '../worker/assembly.js';
import { loadCanonicalDescriptors, nativeHandlersUseTeamOwnerScope } from './invoke.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const require = createRequire(join(root, 'package.json'));
const source = 'tests/integration/can-dev-server/NativeLocalRules.can';
const model = 'NativeLocalRules.Item' as ModelName;
let artifact: CompileArtifact, asm: AssembledModules, staging: string;
let capture: Awaited<ReturnType<typeof captureSingleFileSource>>;
function operationId(at: number): OperationId {
  const time = at.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
  return `${time.slice(0,8)}-${time.slice(8)}-7${random.slice(0,3)}-8${random.slice(4,7)}-${random.slice(7,19)}` as OperationId;
}
before(async () => {
  capture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root,
    appPath: join(root, source), compilerPath: join(root, 'compiler/target/debug/can'),
    catalogPath: fileURLToPath(distribution.catalog), helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
  assert.equal(await captureIsCurrent(capture), true);
  const compiled = await compileCapturedSingleFile(capture);
  assert.equal(compiled.kind, 'artifact', `actual native compilation: ${compiled.kind}`);
  if (compiled.kind !== 'artifact') throw new Error('Native policy fixture did not compile');
  artifact = compiled.artifact;
  assert.deepEqual(artifact.sources, [{ path: capture.compilerOperand, sha256: capture.sourceSha256 }]);
  assert.equal(artifact.models?.find(candidate => candidate.name === model)?.deleteMode, 'remove', 'authored hard removal contract');
  assert.equal(artifact.modelPolicies?.length, 1);
  const policies = artifact.modelPolicies![0]!;
  assert.equal(policies.abi, 'state.owner-model-policies@1');
  assert.equal(policies.model, model);
  assert.equal(policies.ownerPackage, 'NativeLocalRules');
  assert.equal(policies.module, artifact.modules[0]!.path);
  assert.deepEqual(policies.rules.map(rule => [rule.kind, rule.id]), [
    ['invariant', `${model}.require.1`], ['lock', `${model}.lock.1`], ['invariant', `${model}.require.2`],
  ]);
  assert.deepEqual(policies.hooks, []);
  staging = await mkdtemp(join(tmpdir(), 'can-native-local-rules-'));
  asm = await assembleModules({ artifact, sourcePath: source }, { workDir: staging,
    stdlibUrl: pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href });
}, { timeout: 120000 });
after(async () => {
  try { if (capture) assert.equal(await captureIsCurrent(capture), true, 'consumer must finish source-current'); }
  finally { if (staging) await rm(staging, { recursive: true, force: true }); }
});

async function fixture(selectedAssembly: AssembledModules = asm, selectedArtifact = artifact, selectedModel = model) {
  const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
  const team = await identities.createTeam({});
  const user = await identities.createUser({ email: 'member@native-local-rules.test', password_hash: 'unused', email_verified: true });
  await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
  const token = randomBytes(32).toString('hex');
  await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
    expires_at: new Date(now + 3600000).toISOString(), last_team_id: team.team_id });
  const identity = await resolveIdentity(identities, { session_token: token }, { clock });
  const { store: backing, probe } = createTestMemoryStorage();
  const batches: CommitBatch[] = [];
  const store: StoragePort = { ...backing, commit: async batch => { batches.push(batch); return backing.commit(batch); } };
  const invoker = buildInvoker(selectedArtifact, selectedAssembly, store, { memberships: identities, now: () => now });
  const invoke = (kind: string, inputs: Record<string, unknown>, id = operationId(now)) =>
    invoker.invokeMutation({ operation: `${selectedModel}.${kind}`, operation_id: id, inputs }, identity);
  const rows = () => store.query({ model: selectedModel, authority: 'owner', archived: 'include' });
  const snapshot = async () => ({ rows: await rows(), outbox: probe.outboxAll(), revision: await store.readRevision() });
  const commit = async (kind: string, inputs: Record<string, unknown>, id?: OperationId): Promise<MutationResult> => {
    const result = await invoke(kind, inputs, id);
    assert.ok('result' in result, JSON.stringify(result));
    assert.equal(result.result.status, 'committed');
    return result.result;
  };
  const record = async (id: OperationId) => {
    const row = await store.load(selectedModel, id as unknown as RecordId);
    assert.ok(row); return row;
  };
  const update = async (id: OperationId, changes: Record<string, unknown>) => {
    const row = await record(id);
    return commit('update', { record: { id, version: String(row.version) }, ...changes });
  };
  const deny = async (kind: string, inputs: Record<string, unknown>, target?: OperationId) => {
    const before = await snapshot(), beforeBatches = batches.length, id = operationId(now);
    const history = target === undefined ? [] : probe.historyFor(selectedModel, target as unknown as RecordId);
    const result = await invoke(kind, inputs, id);
    assert.ok('error' in result, JSON.stringify(result));
    assert.equal(result.error.code, 'rule_failed');
    const after = await snapshot();
    assert.deepEqual(after.rows, before.rows);
    assert.deepEqual(after.outbox, before.outbox);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(batches.length, beforeBatches + 1, 'one actual rejection batch');
    const batch = batches.at(-1)!;
    assert.equal(batch.expectedRevision, before.revision);
    for (const field of ['writes', 'history', 'outbox', 'schedules', 'uniqueClaims', 'uniqueReleases', 'outboxAck'] as const)
      assert.deepEqual(batch[field] ?? [], [], `rejection stages no ${field}`);
    const receipt = await store.readReceipt({ app: selectedModel.slice(0, selectedModel.lastIndexOf('.')), owner: team.team_id,
      principal: user.user_id, operation: `${selectedModel}.${kind}` as OperationName, operationId: id });
    assert.ok(receipt);
    assert.deepEqual(batch.receipt, receipt);
    assert.equal(receipt.inputHash, await hashInputs(inputs));
    assert.equal(receipt.committedRevision, after.revision);
    assert.ok(receipt.outcome.status === 'rejected');
    assert.equal(receipt.outcome.code, 'rule_failed');
    assert.deepEqual(receipt.resolvedDefaults, {});
    if (target !== undefined) assert.deepEqual(probe.historyFor(selectedModel, target as unknown as RecordId), history);
    assert.deepEqual(probe.historyFor(selectedModel, id as unknown as RecordId), []);
  };
  return { now, identity, invoker, store, probe, batches, invoke, commit, record, update, deny };
}

it('consumes native int64 policies through create, saved replay, and current member read projection', async () => {
  const f = await fixture(), id = operationId(f.now);
  const inputs = { quantity: '9223372036854775807', label: 'large open item' };
  const first = await f.commit('create', inputs, id);
  assert.deepEqual((await f.record(id)).data, { ...inputs, locked: false, state: 'open' });
  const before = { revision: await f.store.readRevision(), batches: f.batches.length,
    history: f.probe.historyFor(model, id as unknown as RecordId) };
  const replay = await f.invoke('create', inputs, id);
  assert.ok('result' in replay, JSON.stringify(replay));
  assert.equal(replay.result.status, 'replayed');
  assert.deepEqual(replay.result.records, first.records);
  assert.equal(await f.store.readRevision(), before.revision);
  assert.equal(f.batches.length, before.batches);
  assert.deepEqual(f.probe.historyFor(model, id as unknown as RecordId), before.history);
  await f.update(id, { quantity: '7' });
  const read = await f.invoker.invokeRead({ operation: `${model}.read`, inputs: {} }, f.identity);
  assert.ok('result' in read, JSON.stringify(read));
  const projected = read.result as { records: readonly { data: Readonly<Record<string, unknown>> }[] };
  assert.ok(projected && Array.isArray(projected.records), 'actual canonical read projection');
  assert.equal(projected.records.length, 1);
  assert.deepEqual(projected.records[0]!.data, { ...inputs, quantity: '7', locked: false, state: 'open' });
});

it('keeps genuine unsupported delete hooks refused without executing their body', async () => {
  const scratch = await createCheckoutScratch(root, 'native-unclaimed-hook-');
  const sourcePath = join(scratch, 'NativeUnclaimedHook.can');
  const text = 'app NativeUnclaimedHook\nGiven\n Item {label:text}\nWhen\n crud Item by=members fields=label\n scenario changed on=Item.delete\n  do require event.before.label!="never"\nThen\n';
  await writeFile(sourcePath, text);
  const hookCapture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root,
    appPath: sourcePath, compilerPath: join(root, 'compiler/target/debug/can'),
    catalogPath: fileURLToPath(distribution.catalog), helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
  try {
    const compiled = await compileCapturedSingleFile(hookCapture);
    assert.equal(compiled.kind, 'artifact', `actual hook compilation: ${compiled.kind}`);
    if (compiled.kind !== 'artifact') throw new Error('Native hook fixture did not compile');
    const emitted = compiled.artifact;
    const originalArtifact = JSON.stringify(emitted);
    const owningModel = 'NativeUnclaimedHook.Item' as ModelName;
    const operation = `${owningModel}.delete`;
    assert.equal(emitted.modelPolicies?.some(policy => policy.hooks.some(hook => hook.operation === operation)) ?? false, false,
      'delete remains outside the released checked hook profile');
    assert.equal(emitted.callables.filter(callable => callable.kind === 'handler' && callable.member.join('.') === `hooks.${operation}.run`).length, 1);
    const assembly = await assembleModules({ artifact: emitted, sourcePath }, { workDir: join(scratch, 'assembly'),
      stdlibUrl: pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href });
    const loaded = await loadCanonicalDescriptors(assembly, emitted);
    assert.equal(loaded.unsupportedHookOperations?.has(operation), true);
    const f = await fixture(assembly, emitted, owningModel);
    const createId = operationId(f.now);
    const created = await f.commit('create', { label: 'Original' }, createId);
    assert.equal(created.operation_id, createId);
    const row = await f.store.load(owningModel, createId as unknown as RecordId);
    assert.ok(row);
    const before = { revision: await f.store.readRevision(), history: f.probe.historyFor(owningModel, row.id), outbox: f.probe.outboxAll(), batches: f.batches.length };
    const inputs = { record: { id: row.id, version: String(row.version) } };
    const id = operationId(f.now);
    const denied = await f.invoke('delete', inputs, id);
    assert.ok('error' in denied, JSON.stringify(denied));
    assert.equal(denied.error.code, 'validation');
    assert.match(denied.error.message, /requires unsupported canonical hooks/);
    assert.deepEqual(await f.store.load(owningModel, row.id), row, 'unsupported hook leaves the actual record untouched');
    assert.deepEqual(f.probe.historyFor(owningModel, row.id), before.history);
    assert.deepEqual(f.probe.outboxAll(), before.outbox);
    assert.equal(await f.store.readRevision(), before.revision + 1);
    assert.equal(f.batches.length, before.batches + 1, 'one genuine State rejection batch');
    const rejectedBatch = f.batches.at(-1)!;
    assert.equal(rejectedBatch.expectedRevision, before.revision);
    for (const field of ['writes', 'history', 'outbox', 'schedules', 'uniqueClaims', 'uniqueReleases', 'outboxAck'] as const)
      assert.deepEqual(rejectedBatch[field] ?? [], [], `rejection stages no ${field}`);
    assert.ok(f.identity.actor && f.identity.team);
    const receipt = await f.store.readReceipt({ app: 'NativeUnclaimedHook', owner: f.identity.team.team_id,
      principal: f.identity.actor.user_id, operation: operation as OperationName, operationId: id });
    assert.ok(receipt && receipt.outcome.status === 'rejected');
    assert.equal(receipt.outcome.code, 'validation');
    assert.equal(receipt.inputHash, await hashInputs(inputs));
    assert.equal(receipt.committedRevision, before.revision + 1);
    assert.deepEqual(rejectedBatch.receipt, receipt);
    assert.deepEqual(receipt.resolvedDefaults, {});
    assert.deepEqual(await f.invoke('delete', inputs, id), denied, 'rejected replay preserves original refusal');
    const replay = await f.invoke('create', { label: 'Original' }, createId);
    assert.ok('result' in replay, JSON.stringify(replay));
    assert.equal(replay.result.status, 'replayed');
    assert.deepEqual(replay.result.records, created.records, 'original create replay stays exact');
    assert.equal(await f.store.readRevision(), before.revision + 1);
    assert.equal(f.batches.length, before.batches + 1);
    assert.equal(JSON.stringify(emitted), originalArtifact, 'artifact is consumed without repair');
    assert.equal(await readFile(sourcePath, 'utf8'), text);
    assert.equal(await captureIsCurrent(hookCapture), true);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

it('executes the unchanged native HookOrder candidate sequence and rolls back its staged Audit on a late guard', {timeout:120000}, async () => {
  const sourcePath = join(root, 'compiler/tests/fixtures/hook_order_rollback.can');
  const originalSource = await readFile(sourcePath, 'utf8');
  const hookCapture = await captureSingleFileSource(prepareLocalPreviewCapture({ checkoutRoot: root,
    appPath: sourcePath, compilerPath: join(root, 'compiler/target/debug/can'),
    catalogPath: fileURLToPath(distribution.catalog), helpIndexPath: join(root, 'docs/specification/CONSTRUCT-HELP.md') }));
  const scratch = await mkdtemp(join(tmpdir(), 'can-native-checked-hook-'));
  try {
    const compiled = await compileCapturedSingleFile(hookCapture);
    assert.equal(compiled.kind, 'artifact', `unchanged original HookOrder native compilation: ${compiled.kind}`);
    if (compiled.kind !== 'artifact') throw new Error('Original HookOrder fixture did not compile');
    const emitted = compiled.artifact, originalArtifact = JSON.stringify(emitted);
    assert.deepEqual(emitted.sources, [{ path: hookCapture.compilerOperand, sha256: hookCapture.sourceSha256 }]);
    const owningModel = 'HookOrder.Entry' as ModelName, auditModel = 'HookOrder.Audit' as ModelName;
    const policy = emitted.modelPolicies?.find(policy => policy.model === owningModel);
    assert.ok(policy);
    assert.deepEqual(policy.hooks, [{id:'HookOrder.adjustEntry',op:'update',operation:'HookOrder.Entry.update'}]);
    assert.equal(emitted.callables.filter(callable => callable.id === 'HookOrder.adjustEntry' &&
      callable.module === policy.module && callable.member.join('.') === 'hooks.HookOrder.Entry.update.run').length, 1);
    const assembly = await assembleModules({artifact:emitted,sourcePath}, {workDir:join(scratch,'assembly'),
      stdlibUrl:pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href});
    const loaded = await loadCanonicalDescriptors(assembly, emitted);
    assert.equal(loaded.unsupportedHookOperations.has('HookOrder.Entry.update'),false);
    assert.equal(await nativeHandlersUseTeamOwnerScope(assembly, emitted), true,
      'the generated CRUD hook keeps its owner route without an ordinary operation entry');
    const f = await fixture(assembly, emitted, owningModel), id = operationId(f.now);
    assert.ok(f.identity.actor && f.identity.team);
    const receipt = async (kind:string,operation_id:OperationId) => {
      const saved = await f.store.readReceipt({app:'HookOrder',owner:f.identity.team!.team_id,
        principal:f.identity.actor!.user_id,operation:`${owningModel}.${kind}` as OperationName,operationId:operation_id});
      assert.ok(saved);return saved;
    };
    const resources = async () => {
      const entries = await f.store.query({model:owningModel,authority:'owner',archived:'include'});
      const audits = await f.store.query({model:auditModel,authority:'owner',archived:'include'});
      return {entries,audits,history:await Promise.all([...entries.map(row=>[owningModel,row.id] as const),
        ...audits.map(row=>[auditModel,row.id] as const)].map(([model,id])=>f.store.historyFor(model,id))),
        revision:await f.store.readRevision(),batches:f.batches.length,outbox:f.probe.outboxAll(),schedules:f.batches.flatMap(batch=>batch.schedules??[])};
    };
    const createInputs = {state:'initial',accept:true};
    const created = await f.commit('create',createInputs,id);
    const initial = await f.record(id);assert.equal(initial.version,1);assert.deepEqual(initial.data,createInputs);
    const createdReceipt = await receipt('create',id);assert.equal(createdReceipt.outcome.status,'committed');
    const updateId = operationId(f.now), inputs = {record:{id:initial.id,version:'1'},state:'proposed',accept:true};
    const updated = await f.commit('update',inputs,updateId);
    const current = await f.record(id);assert.equal(current.version,2);assert.deepEqual(current.data,{state:'second',accept:true});
    const audits = await f.store.query({model:auditModel,authority:'owner',archived:'include'});
    assert.equal(audits.length,1);assert.equal(audits[0]!.version,1);assert.deepEqual(audits[0]!.data,{note:'first'});
    const batch = f.batches.at(-1)!;
    assert.equal(batch.writes.length,2);assert.equal(batch.history.length,2);
    const entryHistory = await f.store.historyFor(owningModel,current.id);
    assert.equal(entryHistory.length,2);assert.deepEqual(entryHistory.at(-1)!.before,initial.data);assert.deepEqual(entryHistory.at(-1)!.after,current.data);
    const auditHistory = await f.store.historyFor(auditModel,audits[0]!.id);
    assert.equal(auditHistory.length,1);assert.equal(auditHistory[0]!.before,null);assert.deepEqual(auditHistory[0]!.after,audits[0]!.data);
    const saved = await receipt('update',updateId);
    assert.equal(saved.inputHash,await hashInputs(inputs));assert.deepEqual(batch.receipt,saved);
    assert.equal(saved.outcome.status,'committed');assert.equal(saved.committedRevision,await f.store.readRevision());
    const beforeReplay = await resources();
    const replay = await f.invoke('update',inputs,updateId);assert.ok('result' in replay);
    assert.equal(replay.result.status,'replayed');assert.deepEqual(replay.result.records,updated.records);
    assert.deepEqual(await resources(),beforeReplay);
    const createReplay = await f.invoke('create',createInputs,id);assert.ok('result' in createReplay);
    assert.equal(createReplay.result.status,'replayed');assert.deepEqual(createReplay.result.records,created.records);
    assert.deepEqual(await resources(),beforeReplay);
    const rejectedId = operationId(f.now), rejectedInputs = {record:{id:current.id,version:'2'},state:'proposed',accept:false};
    const rejected = await f.invoke('update',rejectedInputs,rejectedId);assert.ok('error' in rejected);
    assert.equal(rejected.error.code,'rule_failed');
    const afterReject = await resources();
    assert.deepEqual({...afterReject,revision:beforeReplay.revision,batches:beforeReplay.batches},beforeReplay);
    assert.equal(afterReject.revision,beforeReplay.revision+1);assert.equal(afterReject.batches,beforeReplay.batches+1);
    const rejectionBatch = f.batches.at(-1)!, rejectedReceipt = await receipt('update',rejectedId);
    assert.ok(rejectedReceipt.outcome.status==='rejected');assert.equal(rejectedReceipt.outcome.code,'rule_failed');
    assert.equal(rejectedReceipt.inputHash,await hashInputs(rejectedInputs));assert.deepEqual(rejectionBatch.receipt,rejectedReceipt);
    for(const name of ['writes','history','outbox','schedules','uniqueClaims','uniqueReleases','outboxAck'] as const)
      assert.deepEqual(rejectionBatch[name]??[],[],`late guard rolls back ${name}`);
    assert.deepEqual(await f.invoke('update',rejectedInputs,rejectedId),rejected);
    assert.deepEqual(await resources(),afterReject);
    const copied = await fixture({...assembly,moduleUrls:{...assembly.moduleUrls}},emitted,owningModel);
    const refused = await copied.invoke('create',createInputs);assert.ok('error' in refused);assert.equal(refused.error.code,'validation');
    assert.equal(copied.batches.length,0);assert.equal(await copied.store.readRevision(),0);
    assert.deepEqual(await copied.store.query({model:owningModel,authority:'owner',archived:'include'}),[]);
    assert.deepEqual(await copied.store.query({model:auditModel,authority:'owner',archived:'include'}),[]);
    assert.equal(JSON.stringify(emitted),originalArtifact);
    assert.equal(await readFile(sourcePath,'utf8'),originalSource);assert.equal(await captureIsCurrent(hookCapture),true);
  } finally {await rm(scratch,{recursive:true,force:true});}
});

it('rejects each source-ordered false invariant with exact receipt bookkeeping and no domain effects', async () => {
  const f = await fixture();
  await f.deny('create', { quantity: '-1', label: 'first invariant' });
  await f.deny('create', { quantity: '101', label: 'second invariant', state: 'closed' });
  const id = operationId(f.now);
  await f.commit('create', { quantity: '100', label: 'boundary', state: 'closed' }, id);
  const row = await f.record(id);
  await f.deny('update', { record: { id, version: String(row.version) }, quantity: '101' }, id);
});

it('enforces entry locks while allowing unrelated and same-value writes, then unlocking in the next transaction', async () => {
  const f = await fixture(), id = operationId(f.now);
  await f.commit('create', { quantity: '1', label: 'protected', locked: true }, id);
  await f.update(id, { quantity: '2' });
  await f.update(id, { label: 'protected' });
  let row = await f.record(id);
  await f.deny('update', { record: { id, version: String(row.version) }, label: 'changed', locked: false }, id);
  await f.update(id, { locked: false });
  await f.update(id, { label: 'changed' });
  assert.equal((await f.record(id)).data.label, 'changed');
  await f.update(id, { locked: true });
  row = await f.record(id);
  await f.deny('delete', { record: { id, version: String(row.version) } }, id);
  await f.update(id, { locked: false });
  row = await f.record(id);
  await f.commit('delete', { record: { id, version: String(row.version) } });
  assert.equal(await f.store.load(model, id as unknown as RecordId), null, 'unlocked hard removal deletes the actual stored row');
});


it('refuses loss of the dedicated installed owner-session producer without legacy execution or receipt writes', async () => {
  const f = await fixture();
  const loaded = await loadCanonicalDescriptors(asm, artifact, f.store);
  const original = loaded.producers.crud.generatedCrudExecuteOwnerSession;
  assert.equal(typeof original, 'function', 'actual positive installed producer');
  const producer = loaded.producers.crud as { generatedCrudExecuteOwnerSession?: typeof original };
  delete producer.generatedCrudExecuteOwnerSession;
  try {
    const result = await f.invoke('create', { quantity: '1', label: 'must refuse' });
    assert.ok('error' in result, JSON.stringify(result));
    assert.equal(result.error.code, 'validation');
    assert.equal(f.batches.length, 0, 'no legacy executor or canonical rejection batch is selected');
    assert.equal(await f.store.readRevision(), 0);
    assert.deepEqual(await f.store.query({ model, authority: 'owner', archived: 'include' }), []);
  } finally { if (original !== undefined) producer.generatedCrudExecuteOwnerSession = original; }
});

it('refuses copied and swapped assemblies after native policy descriptors are cached', async () => {
  const loaded = await loadCanonicalDescriptors(asm, artifact);
  const copied: AssembledModules = { ...asm, moduleUrls: { ...asm.moduleUrls } };
  const swapped = await assembleModules({ artifact, sourcePath: source }, {
    workDir: join(staging, 'swapped'),
    stdlibUrl: pathToFileURL(require.resolve('@canlang/cloudflare/runtime/stdlib')).href,
  });
  for (const [label, selected] of [['copied', copied], ['swapped', swapped]] as const) {
    await assert.rejects(loadCanonicalDescriptors(selected, artifact), /original verified assembly/, label);
    const f = await fixture(selected);
    const result = await f.invoke('create', { quantity: '1', label: `must refuse ${label}` });
    assert.ok('error' in result, label);
    assert.equal(result.error.code, 'validation', label);
    assert.equal(f.batches.length, 0, `${label}: no execution or rejection batch`);
    assert.equal(await f.store.readRevision(), 0, label);
    assert.deepEqual(await f.store.query({ model, authority: 'owner', archived: 'include' }), [], label);
    assert.deepEqual(f.probe.outboxAll(), [], label);
  }
  assert.strictEqual(await loadCanonicalDescriptors(asm, artifact), loaded, 'current original assembly still reuses descriptors');
});

it('refuses changed staged JS and maps on native cache hits and canonical invocation', async () => {
  const loaded = await loadCanonicalDescriptors(asm, artifact);
  const path = artifact.modules[0]!.path;
  const js = asm.moduleUrls[path], map = asm.mapUrls?.[path];
  assert.equal(typeof js, 'string', 'actual assembler JS URL');
  assert.equal(typeof map, 'string', 'actual assembler map URL');
  const f = await fixture();
  for (const [label, url] of [['JS', js!], ['map', map!]] as const) {
    const file = fileURLToPath(url), original = await readFile(file);
    try {
      // Even semantically neutral drift invalidates exact captured bytes.
      await writeFile(file, Buffer.concat([original, Buffer.from('\n')]));
      await assert.rejects(loadCanonicalDescriptors(asm, artifact), /captured artifact or module closure|staged module bytes changed/, label);
      const result = await f.invoke('create', { quantity: '1', label: `must refuse stale ${label}` });
      assert.ok('error' in result, label);
      assert.equal(result.error.code, 'validation', label);
      assert.equal(f.batches.length, 0, `${label}: no execution or rejection batch`);
      assert.equal(await f.store.readRevision(), 0, label);
      assert.deepEqual(await f.store.query({ model, authority: 'owner', archived: 'include' }), [], label);
      assert.deepEqual(f.probe.outboxAll(), [], label);
    } finally { await writeFile(file, original); }
    assert.strictEqual(await loadCanonicalDescriptors(asm, artifact), loaded, `${label}: restored current assembly reuses descriptors`);
  }
});
