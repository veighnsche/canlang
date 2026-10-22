/** A declared read scenario selects only rows admitted by the current viewer policy. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
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
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
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
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
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


it('uses staged receipt and amendment aggregates for the exact post-write purchase ALL', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'purchase-all-runtime-'));
  try {
    const sourcePath = join(root, 'compiler/tests/fixtures/purchase-receive-all.can');
    const { stdout } = await promisify(execFile)(compiler,
      ['compile', '--format=json', '--native-scenario-receipts', '--catalog', catalog, sourcePath],
      { cwd: root, timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
    const artifact = JSON.parse(stdout) as CompileArtifact;
    const assembly = await assembleModules({ artifact, sourcePath }, { workDir: directory,
      stdlibUrl: new URL('./stdlib.js', import.meta.url).href, uiUrl: import.meta.resolve('@canlang/ui') });
    const now = Date.now(), clock = createFrozenClock(now), identities = createMemoryIdentityStore({ clock });
    const team = await identities.createTeam({ timezone: 'UTC' });
    const user = await identities.createUser({ email: 'purchase-all@example.test', password_hash: 'unused', email_verified: true });
    await identities.createMembership({ team_id: team.team_id, user_id: user.user_id, is_owner: false, roles: [] });
    const token = `purchase-all-${randomBytes(8).toString('hex')}`;
    await identities.createSession({ user_id: user.user_id, token_sha256: await sha256HexText(token),
      last_team_id: team.team_id, expires_at: new Date(now + 3600000).toISOString() });
    const identity = await resolveIdentity(identities, { session_token: token }, { clock });
    const { store: backing, probe } = createTestMemoryStorage();
    const failedBatches: CommitBatch[] = [];
    let raceAtCommit: (() => Promise<void>) | undefined;
    const store: StoragePort = { ...backing, commit: async batch => {
      const race = raceAtCommit; raceAtCommit = undefined;
      if (race !== undefined) await race();
      try { return await backing.commit(batch); }
      catch (error) { failedBatches.push(batch); throw error; }
    } };
    const invoker = buildInvoker(artifact, assembly, store, { memberships: identities, now: () => now });
    const id = (): OperationId => {
      const time = now.toString(16).padStart(12, '0'), random = randomBytes(10).toString('hex');
      return `${time.slice(0,8)}-${time.slice(8)}-7${random.slice(0,3)}-8${random.slice(4,7)}-${random.slice(7,19)}` as OperationId;
    };
    const invoke = (name: string, inputs: Record<string, unknown>, operationId = id()) =>
      invoker.invokeMutation({ operation: `purchase.${name}`, inputs, operation_id: operationId }, identity);
    const create = async (name: string, inputs: Record<string, unknown>) => {
      const operationId = id(), result = await invoke(`${name}.create`, inputs, operationId);
      assert.ok('result' in result, JSON.stringify(result)); return operationId;
    };
    const ref = async (model: string, record: string) => {
      const row = await store.load(`purchase.${model}` as ModelName, record as RecordId);
      assert.ok(row); return { id: record, version: String(row.version) };
    };
    const location = await create('Location', { name: 'Warehouse' });
    const employee = await create('Employee', { user: { id: user.user_id }, home: await ref('Location', location) });
    const request = await create('Request', { state: 'approved' });
    const order = await create('Order', { parent: await ref('Request', request), location: await ref('Location', location), reference: 'PO-1' });
    const lineA = await create('Line', { parent: await ref('Order', order), sku: 'A', unit: 'box', quantity: '2' });
    const lineB = await create('Line', { parent: await ref('Order', order), sku: 'B', unit: 'box', quantity: '1' });
    await create('Amendment', { parent: await ref('Line', lineB), quantity: '1' });
    const receiptInputs = async (line: string, source: string, accepted: string, rejected = '0') => ({
      line: await ref('Line', line), source, accepted, rejected, received_on: '2026-10-22', evidence: 'Delivery evidence',
    });
    const firstInputs = await receiptInputs(lineA, 'A', '2'), firstId = id();
    const first = await invoke('receive', firstInputs, firstId);
    assert.ok('result' in first, JSON.stringify(first));
    assert.equal((await store.load('purchase.Order' as ModelName, order as unknown as RecordId))?.data.state, 'part_received',
      'an incomplete sibling keeps the Order partial');
    const second = await invoke('receive', await receiptInputs(lineB, 'B-1', '1'));
    assert.ok('result' in second, JSON.stringify(second));
    assert.equal((await store.load('purchase.Order' as ModelName, order as unknown as RecordId))?.data.state, 'part_received',
      'the Amendment contributes to the actual ordered quantity');
    const zero = await invoke('receive', await receiptInputs(lineB, 'B-rejected', '0', '1'));
    assert.ok('result' in zero, JSON.stringify(zero));
    const receiptsAfterZero = await store.query({ model: 'purchase.Receipt' as ModelName, authority: 'owner', archived: 'include' });
    assert.equal(receiptsAfterZero.find(row => row.data.source === 'B-rejected')?.data.posting, 'confirmed');
    assert.equal(probe.outboxAll().length, 2, 'zero accepted creates no provider intent');
    const last = await invoke('receive', await receiptInputs(lineB, 'B-2', '1'));
    assert.ok('result' in last, JSON.stringify(last));
    assert.equal((await store.load('purchase.Order' as ModelName, order as unknown as RecordId))?.data.state, 'received',
      'the new staged receipt participates in ALL before it commits');
    const originalReceipt = (await store.query({ model: 'purchase.Receipt' as ModelName, authority: 'owner', archived: 'include' })).find(row => row.data.source === 'A')!;
    const locked = await invoke('Receipt.update', { record: await ref('Receipt', originalReceipt.id), evidence: 'Changed' });
    assert.ok('error' in locked, JSON.stringify(locked));
    assert.equal((await store.load('purchase.Receipt' as ModelName, originalReceipt.id))?.data.evidence, 'Delivery evidence');
    await create('Return', { parent: await ref('Receipt', originalReceipt.id), source: 'return-source', quantity: '1' });
    const ruleOrder = await create('Order', { parent: await ref('Request', request), location: await ref('Location', location), reference: 'PO-rule' });
    const ruleLine = await create('Line', { parent: await ref('Order', ruleOrder), sku: 'rule', unit: 'box', quantity: '1' });
    const beforeRuleOutbox = probe.outboxAll();
    const deniedByRule = await invoke('receive', await receiptInputs(ruleLine, 'return-source', '1'));
    assert.ok('error' in deniedByRule, JSON.stringify(deniedByRule));
    assert.equal((await store.load('purchase.Order' as ModelName, ruleOrder as unknown as RecordId))?.data.state, 'ordered');
    assert.deepEqual(probe.outboxAll(), beforeRuleOutbox, 'the original Receipt invariant rolls back the queued Stock intent too');
    assert.equal((await store.query({ model: 'purchase.Receipt' as ModelName, authority: 'owner', archived: 'include' })).some(row => row.data.source === 'return-source'), false);
    const closed = await invoke('Order.update', { record: await ref('Order', order), state: 'closed' });
    assert.ok('result' in closed, JSON.stringify(closed));
    const beforeReplay = { order: await store.load('purchase.Order' as ModelName, order as unknown as RecordId),
      receipts: await store.query({ model: 'purchase.Receipt' as ModelName, authority: 'owner', archived: 'include' }),
      outbox: probe.outboxAll() };
    const replay = await invoke('receive', firstInputs, firstId);
    assert.ok('result' in replay, JSON.stringify(replay)); assert.equal(replay.result.status, 'replayed');
    const previous = await invoke('receive', firstInputs);
    assert.ok('result' in previous, JSON.stringify(previous));
    assert.deepEqual(previous.result.result, first.result.result);
    assert.deepEqual({ order: await store.load('purchase.Order' as ModelName, order as unknown as RecordId),
      receipts: await store.query({ model: 'purchase.Receipt' as ModelName, authority: 'owner', archived: 'include' }),
      outbox: probe.outboxAll() }, beforeReplay, 'both replay paths avoid writes and provider posting');
    const shortOrder = await create('Order', { parent: await ref('Request', request), location: await ref('Location', location), reference: 'PO-short' });
    const shortLines: string[] = [];
    for (const sku of ['one', 'two', 'three']) shortLines.push(await create('Line', {
      parent: await ref('Order', shortOrder), sku, unit: 'box', quantity: '1',
    }));
    shortLines.sort();
    const late = shortLines[2]!;
    const overflowQuantity = await invoke('Line.update', { record: await ref('Line', late), quantity: '9223372036854775807' });
    assert.ok('result' in overflowQuantity, JSON.stringify(overflowQuantity));
    await create('Amendment', { parent: await ref('Line', late), quantity: '1' });
    const short = await invoke('receive', await receiptInputs(shortLines[1]!, 'short-circuit', '1'));
    assert.ok('result' in short, JSON.stringify(short));
    assert.equal((await store.load('purchase.Order' as ModelName, shortOrder as unknown as RecordId))?.data.state, 'part_received',
      'the first incomplete Line prevents evaluating a later overflowing ordered aggregate');
    const raceOrder = await create('Order', { parent: await ref('Request', request), location: await ref('Location', location), reference: 'PO-race' });
    const raceLine = await create('Line', { parent: await ref('Order', raceOrder), sku: 'race', unit: 'box', quantity: '1' });
    const beforeRaceOutbox = probe.outboxAll().length;
    raceAtCommit = async () => {
      await create('Amendment', { parent: await ref('Line', raceLine), quantity: '1' });
    };
    const raced = await invoke('receive', await receiptInputs(raceLine, 'domain-insert-race', '1'));
    assert.ok('result' in raced, JSON.stringify(raced));
    assert.equal(failedBatches.length, 1, 'the original complete decision loses its domain revision fence');
    assert.equal((await store.load('purchase.Order' as ModelName, raceOrder as unknown as RecordId))?.data.state, 'part_received',
      'the fresh retry observes the inserted Amendment and recomputes ALL');
    assert.equal(probe.outboxAll().length, beforeRaceOutbox + 1, 'only the winning retry posts');
    assert.equal((await store.query({ model: 'purchase.Receipt' as ModelName, authority: 'owner', archived: 'include' })).filter(row => row.data.source === 'domain-insert-race').length, 1);
    const deniedOrder = await create('Order', { parent: await ref('Request', request), location: await ref('Location', location), reference: 'PO-hidden' });
    const visible = await create('Line', { parent: await ref('Order', deniedOrder), sku: 'visible', unit: 'box', quantity: '1' });
    await create('Line', { parent: await ref('Order', deniedOrder), sku: 'hidden', unit: 'box', quantity: '1' });
    const beforeHidden = { order: await store.load('purchase.Order' as ModelName, deniedOrder as unknown as RecordId), outbox: probe.outboxAll() };
    const hiddenSibling = await invoke('receive', await receiptInputs(visible, 'hidden-sibling', '1'));
    assert.ok('error' in hiddenSibling, JSON.stringify(hiddenSibling));
    assert.deepEqual(await store.load('purchase.Order' as ModelName, deniedOrder as unknown as RecordId), beforeHidden.order);
    assert.equal((await store.query({ model: 'purchase.Receipt' as ModelName, authority: 'owner', archived: 'include' })).some(row => row.data.source === 'hidden-sibling'), false);
    assert.deepEqual(probe.outboxAll(), beforeHidden.outbox, 'hidden sibling aborts Receipt, Order and posting atomically');
    const receiptOrder = await create('Order', { parent: await ref('Request', request), location: await ref('Location', location), reference: 'PO-hidden-receipt' });
    const receiptLine = await create('Line', { parent: await ref('Order', receiptOrder), sku: 'receipt', unit: 'box', quantity: '2' });
    await create('Receipt', { parent: await ref('Line', receiptLine), source: 'old-hidden', accepted: '1', rejected: '0',
      received: '2026-10-22', evidence: 'hidden' });
    const beforeReceipt = { order: await store.load('purchase.Order' as ModelName, receiptOrder as unknown as RecordId), outbox: probe.outboxAll() };
    const hiddenReceipt = await invoke('receive', await receiptInputs(receiptLine, 'hidden-receipt', '1'));
    assert.ok('error' in hiddenReceipt, JSON.stringify(hiddenReceipt));
    assert.deepEqual(await store.load('purchase.Order' as ModelName, receiptOrder as unknown as RecordId), beforeReceipt.order);
    assert.deepEqual(probe.outboxAll(), beforeReceipt.outbox);
    const updateOrder = await create('Order', { parent: await ref('Request', request), location: await ref('Location', location), reference: 'PO-update-race' });
    const updateLine = await create('Line', { parent: await ref('Order', updateOrder), sku: 'update', unit: 'box', quantity: '1' });
    const amendment = await create('Amendment', { parent: await ref('Line', updateLine), quantity: '1' });
    const failuresBeforeUpdate = failedBatches.length;
    raceAtCommit = async () => {
      const changed = await invoke('Amendment.update', { record: await ref('Amendment', amendment), quantity: '2' });
      assert.ok('result' in changed, JSON.stringify(changed));
    };
    const updated = await invoke('receive', await receiptInputs(updateLine, 'domain-update-race', '2'));
    assert.ok('result' in updated, JSON.stringify(updated));
    assert.equal(failedBatches.length, failuresBeforeUpdate + 1);
    assert.equal((await store.load('purchase.Order' as ModelName, updateOrder as unknown as RecordId))?.data.state, 'part_received');
    const authorityOrder = await create('Order', { parent: await ref('Request', request), location: await ref('Location', location), reference: 'PO-authority-race' });
    const authorityLine = await create('Line', { parent: await ref('Order', authorityOrder), sku: 'authority', unit: 'box', quantity: '1' });
    const beforeAuthority = probe.outboxAll();
    raceAtCommit = async () => {
      const changed = await invoke('Employee.update', { record: await ref('Employee', employee), active: false });
      assert.ok('result' in changed, JSON.stringify(changed));
    };
    const deniedAuthority = await invoke('receive', await receiptInputs(authorityLine, 'authority-race', '1'));
    assert.ok('error' in deniedAuthority, JSON.stringify(deniedAuthority));
    assert.equal((await store.load('purchase.Order' as ModelName, authorityOrder as unknown as RecordId))?.data.state, 'ordered');
    assert.deepEqual(probe.outboxAll(), beforeAuthority);
    assert.equal((await store.query({ model: 'purchase.Receipt' as ModelName, authority: 'owner', archived: 'include' })).some(row => row.data.source === 'authority-race'), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
