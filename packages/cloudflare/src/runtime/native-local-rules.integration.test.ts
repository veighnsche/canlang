/** Actual native compile and canonical memory consumer; no whole-app or D1 claim. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
import { prepareLocalPreviewCapture } from '../dev/preview-inputs.js';
import { captureIsCurrent, captureSingleFileSource } from '../dev/source-capture.js';
import { compileCapturedSingleFile } from '../dev/compiler-check.js';
import { assembleModules, type AssembledModules } from './modules.js';
import { buildInvoker } from '../worker/assembly.js';
import { loadCanonicalDescriptors } from './invoke.js';

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

async function fixture() {
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
  const invoker = buildInvoker(artifact, asm, store, { memberships: identities, now: () => now });
  const invoke = (kind: string, inputs: Record<string, unknown>, id = operationId(now)) =>
    invoker.invokeMutation({ operation: `${model}.${kind}`, operation_id: id, inputs }, identity);
  const rows = () => store.query({ model, authority: 'owner', archived: 'include' });
  const snapshot = async () => ({ rows: await rows(), outbox: probe.outboxAll(), revision: await store.readRevision() });
  const commit = async (kind: string, inputs: Record<string, unknown>, id?: OperationId): Promise<MutationResult> => {
    const result = await invoke(kind, inputs, id);
    assert.ok('result' in result, JSON.stringify(result));
    assert.equal(result.result.status, 'committed');
    return result.result;
  };
  const record = async (id: OperationId) => {
    const row = await store.load(model, id as unknown as RecordId);
    assert.ok(row); return row;
  };
  const update = async (id: OperationId, changes: Record<string, unknown>) => {
    const row = await record(id);
    return commit('update', { record: { id, version: String(row.version) }, ...changes });
  };
  const deny = async (kind: string, inputs: Record<string, unknown>, target?: OperationId) => {
    const before = await snapshot(), beforeBatches = batches.length, id = operationId(now);
    const history = target === undefined ? [] : probe.historyFor(model, target as unknown as RecordId);
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
    const receipt = await store.readReceipt({ app: 'NativeLocalRules', owner: team.team_id,
      principal: user.user_id, operation: `${model}.${kind}` as OperationName, operationId: id });
    assert.ok(receipt);
    assert.deepEqual(batch.receipt, receipt);
    assert.equal(receipt.inputHash, await hashInputs(inputs));
    assert.equal(receipt.committedRevision, after.revision);
    assert.ok(receipt.outcome.status === 'rejected');
    assert.equal(receipt.outcome.code, 'rule_failed');
    assert.deepEqual(receipt.resolvedDefaults, {});
    if (target !== undefined) assert.deepEqual(probe.historyFor(model, target as unknown as RecordId), history);
    assert.deepEqual(probe.historyFor(model, id as unknown as RecordId), []);
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
  const loaded = await loadCanonicalDescriptors(asm, artifact);
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
