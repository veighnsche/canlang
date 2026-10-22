/** A declared read scenario selects only rows admitted by the current viewer policy. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { promisify } from 'node:util';
import type { CompileArtifact, CommitBatch, ModelName, OperationId, RecordId, StoragePort } from '@canlang/contracts';
import { resolveIdentity, sha256HexText } from '@canlang/identity';
import { createFrozenClock, createMemoryIdentityStore } from '@canlang/identity/testing';
import { createMemoryStorage, createTestMemoryStorage } from '@canlang/state/storage/memory';
import { asId, asModel, makeBatch, makeRow } from '@canlang/state/testing/invocation/fixtures';
import { assembleModules } from './modules.js';
import { buildInvoker } from '../worker/assembly.js';
import { invokeReadCanonical } from './invoke.js';

const root = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const source = join(root, 'packages/cloudflare/test/fixtures/native-viewer-first.can');
const compiler = process.env.CAN_COMPILER_BIN ?? join(root, 'compiler/target/debug/can');
const catalog = process.env.CAN_NATIVE_CATALOG ?? join(root, 'packages/cloudflare/dist/native-catalog.json');

it('keeps hidden first rows out of a viewer read and rechecks membership', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'can-viewer-first-'));
  try {
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, source],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const asm = await assembleModules({ artifact, sourcePath: source }, { workDir: directory,
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const user = await identities.createUser({ email: 'viewer-first@example.test', password_hash: 'unused', email_verified: true });
    const membership = await identities.createMembership({ team_id: team.team_id, user_id: user.user_id,
      is_owner: false, roles: [] });
    const token = `viewer-first-${randomBytes(8).toString('hex')}`;
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const store = createMemoryStorage();
    const read = () => invokeReadCanonical({ asm, artifact, operation: 'NativeViewerFirst.preview',
      inputs: {}, identity, store, memberships: identities, now: () => now });

    assert.equal((await read() as { result: unknown }).result, null);
    await store.commit(makeBatch(await store.readRevision(), { writes: [
      { kind: 'insert', model: asModel('NativeViewerFirst.Item'),
        row: { ...makeRow({ id: asId('a-hidden'), data: { label: 'Secret', hidden: true } }), parent: null } },
      { kind: 'insert', model: asModel('NativeViewerFirst.Item'),
        row: { ...makeRow({ id: asId('a-ignored'), data: { label: 'Ignored', hidden: false } }), parent: null } },
      { kind: 'insert', model: asModel('NativeViewerFirst.Item'),
        row: { ...makeRow({ id: asId('b-visible'), data: { label: 'Visible', hidden: false } }), parent: null } },
    ] }));
    assert.equal((await read() as { result: unknown }).result, 'Visible');
    await identities.removeMembership(membership.membership_id);
    await assert.rejects(read());
  } finally { await rm(directory, { recursive: true, force: true }); }
});


it('commits a source-sealed parent SET with receipt creation and replays without repeating it', { timeout: 120000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'native-parent-receipt-'));
  const sourcePath = join(scratch, 'ParentReplay.can');
  await writeFile(sourcePath, `app ParentReplay
Given
 Order {state:text}
 Line in Order {sku:text}
 Receipt in Line {source:text unique,accepted:int}
 policy Order read=members and row.state!="hidden"
 policy Line read=members
 policy Receipt read=members
When
 crud Order by=members fields=state
 crud Line by=members fields=sku
 crud Receipt by=members fields=source,accepted
 scenario receive(line:Line,source:text,accepted:int) -> Receipt by=members
  do
   let previous=first(Receipt as receipt where receipt.source==source order=receipt.id)
   if previous!=null
    require previous.parent==line and previous.accepted==accepted
    return previous
   create Receipt {parent=line,source,accepted} as receipt
   set line.parent {state="part"}
   return receipt
Then
`);
  try {
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, sourcePath],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const emitted = JSON.parse(stdout) as CompileArtifact;
    assert.ok(emitted.operations?.find(operation => operation.name === 'ParentReplay.receive')?.result?.disclosure);
    const assembly = await assembleModules({ artifact: emitted, sourcePath }, { workDir: join(scratch, 'assembly'),
      stdlibUrl: import.meta.resolve('@canlang/cloudflare/runtime/stdlib'), uiUrl: import.meta.resolve('@canlang/ui') });
    const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const user = await identities.createUser({ email: 'parent-receipt@example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    const token = `parent-receipt-${randomBytes(8).toString('hex')}`;
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const { store: backing, probe } = createTestMemoryStorage();
    const batches: CommitBatch[] = [], failedBatches: CommitBatch[] = [];
    let raceAtCommit: (() => Promise<void>) | undefined;
    const store: StoragePort = { ...backing, commit: async batch => {
      const race = raceAtCommit; raceAtCommit = undefined;
      if (race !== undefined) await race();
      try { const result = await backing.commit(batch); batches.push(batch); return result; }
      catch (error) { failedBatches.push(batch); throw error; }
    } };
    const invoker = buildInvoker(emitted, assembly, store, { memberships: identities, now: () => now });
    const f = { now, identity, store, invoker, batches, probe };
    const operationId = (_at: number): OperationId => {
      const time = now.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
      return `${time.slice(0,8)}-${time.slice(8)}-7${random.slice(0,3)}-8${random.slice(4,7)}-${random.slice(7,19)}` as OperationId;
    };
    const invoke = (name: string, inputs: Record<string, unknown>, id = operationId(f.now)) =>
      f.invoker.invokeMutation({ operation: `ParentReplay.${name}`, inputs, operation_id: id }, f.identity);
    const orderId = operationId(f.now);
    const createdOrder = await invoke('Order.create', { state: 'ordered' }, orderId);
    assert.ok('result' in createdOrder, JSON.stringify(createdOrder));
    const lineId = operationId(f.now);
    const line = await invoke('Line.create', { parent: { id: orderId, version: '1' }, sku: 'one' }, lineId);
    assert.ok('result' in line, JSON.stringify(line));
    const inputs = { line: { id: lineId, version: '1' }, source: 'delivery-A', accepted: '2' };
    const id = operationId(f.now), received = await invoke('receive', inputs, id);
    assert.ok('result' in received, JSON.stringify(received));
    assert.equal(received.result.status, 'committed');
    const order = await f.store.load('ParentReplay.Order' as ModelName, orderId as unknown as RecordId);
    assert.equal(order?.data.state, 'part');
    assert.equal(order?.version, 2);
    const receipts = await f.store.query({ model: 'ParentReplay.Receipt' as ModelName, authority: 'owner', archived: 'include' });
    assert.equal(receipts.length, 1);
    const batch = f.batches.at(-1)!;
    assert.equal(batch.writes.length, 2, 'one atomic receipt-create and parent-update batch');
    const revision = await f.store.readRevision(), batchCount = f.batches.length;
    const replay = await invoke('receive', inputs, id);
    assert.ok('result' in replay, JSON.stringify(replay));
    assert.equal(replay.result.status, 'replayed');
    assert.deepEqual(replay.result.result, received.result.result);
    assert.equal(await f.store.readRevision(), revision);
    assert.equal(f.batches.length, batchCount);
    const prior = await invoke('receive', inputs);
    assert.ok('result' in prior, JSON.stringify(prior));
    assert.deepEqual(prior.result.result, received.result.result, 'new invocation reuses prior domain receipt');
    assert.deepEqual(await f.store.load('ParentReplay.Order' as ModelName, orderId as unknown as RecordId), order);
    assert.equal((await f.store.query({ model: 'ParentReplay.Receipt' as ModelName, authority: 'owner', archived: 'include' })).length, 1);

    const hiddenOrderId = operationId(f.now), hiddenLineId = operationId(f.now);
    const hiddenOrder = await invoke('Order.create', { state: 'hidden' }, hiddenOrderId);
    assert.ok('result' in hiddenOrder, JSON.stringify(hiddenOrder));
    const hiddenLine = await invoke('Line.create', { parent: { id: hiddenOrderId, version: '1' }, sku: 'hidden' }, hiddenLineId);
    assert.ok('result' in hiddenLine, JSON.stringify(hiddenLine));
    const beforeDenied = await f.store.load('ParentReplay.Order' as ModelName, hiddenOrderId as unknown as RecordId);
    const denied = await invoke('receive', { ...inputs, line: { id: hiddenLineId, version: '1' }, source: 'hidden-delivery' });
    assert.ok('error' in denied, JSON.stringify(denied));
    assert.deepEqual(await f.store.load('ParentReplay.Order' as ModelName, hiddenOrderId as unknown as RecordId), beforeDenied);
    assert.equal((await f.store.query({ model: 'ParentReplay.Receipt' as ModelName, authority: 'owner', archived: 'include' })).length, 1,
      'unreadable parent refuses without persisting the staged receipt');

    raceAtCommit = async () => {
      const concurrent = await invoke('Order.update', { record: { id: orderId, version: '2' }, state: 'raced' });
      assert.ok('result' in concurrent, JSON.stringify(concurrent));
    };
    const raced = await invoke('receive', { ...inputs, source: 'delivery-race' });
    assert.ok('result' in raced, JSON.stringify(raced));
    assert.equal(raced.result.status, 'committed', 'the invoker retries from a fresh fenced snapshot');
    assert.equal(failedBatches.length, 1, 'the stale atomic attempt is rejected by the real storage fence');
    assert.equal(failedBatches[0]!.writes.length, 2);
    const afterRace = await f.store.load('ParentReplay.Order' as ModelName, orderId as unknown as RecordId);
    assert.equal(afterRace?.data.state, 'part');
    assert.equal(afterRace?.version, 4, 'only the concurrent update and winning retry advance the parent');
    assert.equal((await f.store.query({ model: 'ParentReplay.Receipt' as ModelName, authority: 'owner', archived: 'include' })).length, 2,
      'only the winning retry creates the second receipt');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
