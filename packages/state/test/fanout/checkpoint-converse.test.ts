/** GAP-L04: each checkpoint update joins its own fanout's terminal outcome. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import type { D1Database } from '@cloudflare/workers-types';
import type {
  CommitBatch, DomainWrite, ModelName, OperationId, OperationName,
  Receipt, RecordId, RecordVersion, Revision, StoragePort, StoredRow,
} from '@canlang/contracts';
import { StateError } from '../../src/errors.js';
import { createFanoutChildJoinPort } from '../../src/ports/transact.js';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { createD1Storage, ensureSchema } from '../../src/storage/d1.js';
import { FenceConflictError, StorageConstraintError } from '../../src/storage/port.js';
import {
  FANOUT_CHECKPOINT_MODEL, FANOUT_CHILD_MODEL, newFanoutCheckpointRow,
  newFanoutChildRow, readFanoutCheckpointRow, withFanoutRowData,
} from '../../src/fanout/tables.js';
import {
  stageFanoutChildOutcomeWrite, stageFanoutCheckpointAdvanceWrite,
  type StageFanoutOutcomeInput,
} from '../../src/fanout/outcome.js';

const meta = { nowMs: 1_700_000_000_000, actor: 'checkpoint-converse' };
const domainModel = 'App.CheckpointConverse' as ModelName;
const asModel = (name: string): ModelName => name as ModelName;
const asId = (id: string): RecordId => id as RecordId;

function batch(revision: Revision, writes: ReadonlyArray<DomainWrite>): CommitBatch {
  return { expectedRevision: revision, writes, history: [], receipt: null,
    outbox: [], schedules: [], uniqueClaims: [], uniqueReleases: [] };
}

async function seed(store: StoragePort, label: string) {
  const scopes = ['a', 'b'].map((scope) => {
    const fanoutId = `${label}-${scope}`;
    return {
      checkpoint: newFanoutCheckpointRow({ fanoutId, cursor: 'resume' }, meta),
      child: newFanoutChildRow({ fanoutId, parentOccurrence: fanoutId,
        handler: 'App.fanout', recordId: 'shared-record', state: 'running' }, meta),
    };
  });
  const a = scopes[0]!;
  const b = scopes[1]!;
  await store.commit(batch(await store.readRevision(), scopes.flatMap((scope) => [
    { kind: 'insert' as const, model: asModel(FANOUT_CHECKPOINT_MODEL), row: scope.checkpoint },
    { kind: 'insert' as const, model: asModel(FANOUT_CHILD_MODEL), row: scope.child },
  ])));
  const outcome = (scope: typeof a, result: StageFanoutOutcomeInput['result'] = { kind: 'completed' }) => stageFanoutChildOutcomeWrite({
    row: scope.child, result,
    policy: { maxAttempts: 5, horizonMs: 60_000 },
    nowMs: meta.nowMs + 1, firstAttemptAtMs: meta.nowMs, meta,
  }).write;
  const cover = (scope: typeof a) => stageFanoutCheckpointAdvanceWrite({
    row: scope.checkpoint, recordId: 'shared-record', meta,
  });
  return { a, b, outcome, cover };
}

function effects(revision: Revision, writes: ReadonlyArray<DomainWrite>, label: string): CommitBatch {
  const row: StoredRow = { ...newFanoutCheckpointRow({ fanoutId: label }, meta), data: { value: label } };
  const identity: Receipt['identity'] = { app: 'app', owner: 'owner', principal: 'actor',
    operation: 'App.fanout' as OperationName, operationId: label as OperationId };
  return { ...batch(revision, [{ kind: 'insert', model: domainModel, row }, ...writes]),
    history: [{ model: domainModel, recordId: row.id, version: row.version,
      operation: identity.operation, operationId: identity.operationId, actor: meta.actor,
      at: meta.nowMs, change: 'create', before: null, after: row.data }],
    receipt: { identity, inputHash: label, resolvedDefaults: {},
      outcome: { status: 'committed', result: {}, recordVersions: [
        { model: domainModel, id: row.id, version: row.version },
      ] },
      committedRevision: (revision + 1) as Revision, createdAt: meta.nowMs },
    outbox: [{ intentId: label, operation: identity.operation, operationId: identity.operationId,
      target: 'App.effect', arguments: {}, occurrenceIndex: 0 }],
    schedules: [{ op: 'replace', key: label, at: meta.nowMs,
      event: 'App.due' as OperationName, payload: {} }],
  };
}

function counted(store: StoragePort) {
  let commits = 0;
  return { store: { ...store, commit: (input: CommitBatch) => { commits++; return store.commit(input); } },
    commits: () => commits };
}

function validation(error: unknown): boolean {
  return error instanceof StateError && error.code === 'validation';
}

async function noEffects(store: StoragePort, input: CommitBatch, revision: Revision) {
  assert.equal(await store.readRevision(), revision);
  const row = input.writes[0]!;
  assert.equal(row.kind, 'insert');
  if (row.kind !== 'insert') throw new Error('expected domain insert');
  assert.equal(await store.load(domainModel, row.row.id), null);
  assert.deepEqual(await store.historyFor(domainModel, row.row.id), []);
  assert.equal(await store.readReceipt(input.receipt!.identity), null);
  assert.equal((await store.outboxPending()).some((intent) => intent.intentId === input.outbox[0]!.intentId), false);
  assert.equal(await store.scheduleGet(input.schedules[0]!.key), null);
}

describe('fanout checkpoint converse through the child-join port', () => {
  it('refuses an unrelated checkpoint even when another outcome covers the same record id', async () => {
    const store = createMemoryStorage();
    const world = await seed(store, 'unrelated');
    const tracked = counted(store);
    const input = effects(await store.readRevision(),
      [world.outcome(world.a), world.cover(world.a), world.cover(world.b)], 'unrelated-effects');
    await assert.rejects(createFanoutChildJoinPort({ store: tracked.store }).commitJoin(input), validation);
    assert.equal(tracked.commits(), 0);
    await noEffects(store, input, input.expectedRevision);
    assert.deepEqual(readFanoutCheckpointRow((await store.load(asModel(FANOUT_CHECKPOINT_MODEL), world.b.checkpoint.id))!).completed, []);
  });

  it('a non-terminal update cannot justify its checkpoint alongside another terminal fanout', async () => {
    const store = createMemoryStorage();
    const world = await seed(store, 'nonterminal');
    const tracked = counted(store);
    const running: DomainWrite = { kind: 'update', model: asModel(FANOUT_CHILD_MODEL),
      id: world.b.child.id, expectedVersion: world.b.child.version,
      row: withFanoutRowData(world.b.child, { ...world.b.child.data, attempts: 1 }, meta) };
    await assert.rejects(createFanoutChildJoinPort({ store: tracked.store }).commitJoin(
      batch(await store.readRevision(), [world.outcome(world.a), world.cover(world.a), running, world.cover(world.b)])), validation);
    assert.equal(tracked.commits(), 0);
  });

  it('preserves forward cover, duplicate-row and nonempty checkpoint-insert refusals', async () => {
    const store = createMemoryStorage();
    const world = await seed(store, 'existing-refusals');
    const tracked = counted(store);
    const port = createFanoutChildJoinPort({ store: tracked.store });
    const terminal = world.outcome(world.a);
    const cover = world.cover(world.a);
    const fabricated = { kind: 'insert' as const, model: asModel(FANOUT_CHECKPOINT_MODEL),
      row: newFanoutCheckpointRow({ fanoutId: 'fabricated', completed: ['shared-record'] }, meta) };
    for (const writes of [[terminal, world.cover(world.b)], [terminal, terminal, cover],
      [terminal, cover, cover], [terminal, cover, fabricated]]) {
      await assert.rejects(port.commitJoin(batch(await store.readRevision(), writes)), validation);
    }
    assert.equal(tracked.commits(), 0);
  });

  it('allows empty checkpoint inserts and pending child inserts without fabricated completion', async () => {
    const store = createMemoryStorage();
    const checkpoint = newFanoutCheckpointRow({ fanoutId: 'new-fanout' }, meta);
    const child = newFanoutChildRow({ fanoutId: 'new-fanout', parentOccurrence: 'new-parent',
      handler: 'App.fanout', recordId: 'new-record' }, meta);
    await createFanoutChildJoinPort({ store }).commitJoin(batch(await store.readRevision(), [
      { kind: 'insert', model: asModel(FANOUT_CHECKPOINT_MODEL), row: checkpoint },
      { kind: 'insert', model: asModel(FANOUT_CHILD_MODEL), row: child },
    ]));
    assert.deepEqual(readFanoutCheckpointRow((await store.load(asModel(FANOUT_CHECKPOINT_MODEL), checkpoint.id))!).completed, []);
  });

  it('accepts skipped and failed outcomes with their own covers without narrowing completed sets', async () => {
    const store = createMemoryStorage();
    const world = await seed(store, 'terminal-causes');
    const cover = world.cover(world.a);
    const broaderCover = { ...cover, row: { ...cover.row,
      data: { ...cover.row.data, completed: ['prior-record', 'shared-record'] } } };
    await createFanoutChildJoinPort({ store }).commitJoin(batch(await store.readRevision(), [
      world.outcome(world.a, { kind: 'skipped', reason: 'non-applicable' }), broaderCover,
      world.outcome(world.b, { kind: 'failed', reason: 'terminal' }), world.cover(world.b),
    ]));
    assert.equal((await store.load(asModel(FANOUT_CHILD_MODEL), world.a.child.id))!.data['state'], 'skipped');
    assert.equal((await store.load(asModel(FANOUT_CHILD_MODEL), world.b.child.id))!.data['state'], 'failed');
  });

  it('keeps cursor-only maintenance on the ordinary store and refuses it on the child-join port', async () => {
    const store = createMemoryStorage();
    const world = await seed(store, 'maintenance');
    const update: DomainWrite = { kind: 'update', model: asModel(FANOUT_CHECKPOINT_MODEL),
      id: world.a.checkpoint.id, expectedVersion: world.a.checkpoint.version,
      row: withFanoutRowData(world.a.checkpoint, { ...world.a.checkpoint.data, cursor: null }, meta) };
    const input = batch(await store.readRevision(), [update]);
    await assert.rejects(createFanoutChildJoinPort({ store }).commitJoin(input), validation);
    await store.commit(input);
    assert.equal(readFanoutCheckpointRow((await store.load(asModel(FANOUT_CHECKPOINT_MODEL), world.a.checkpoint.id))!).cursor, null);
  });

  it('retains ordinary batches and non-terminal child claims without checkpoint writes', async () => {
    const store = createMemoryStorage();
    const port = createFanoutChildJoinPort({ store });
    await port.commitJoin(effects(await store.readRevision(), [], 'ordinary-effects'));
    assert.ok(await store.load(domainModel, asId('ordinary-effects')));
    const world = await seed(store, 'claim-only');
    await port.commitJoin(batch(await store.readRevision(), [{ kind: 'update',
      model: asModel(FANOUT_CHILD_MODEL), id: world.a.child.id,
      expectedVersion: world.a.child.version,
      row: withFanoutRowData(world.a.child,
        { ...world.a.child.data, state: 'pending', attempts: 1 }, meta) }]));
    assert.equal((await store.load(asModel(FANOUT_CHILD_MODEL), world.a.child.id))!.data['state'], 'pending');
  });
});

interface Handles { store: StoragePort; peer: StoragePort; close(): Promise<void> }

async function d1Handles(): Promise<Handles> {
  const mf = new Miniflare({ modules: true,
    script: 'export default { fetch() { return new Response("ok"); } }', d1Databases: ['DB'] });
  const db = await mf.getD1Database('DB') as unknown as D1Database;
  await ensureSchema(db);
  return { store: createD1Storage(db), peer: createD1Storage(db), close: () => mf.dispose() };
}

async function doHandles(): Promise<Handles> {
  const mf = new Miniflare({ modules: true,
    modulesRoot: fileURLToPath(new URL('../../../', import.meta.url)),
    scriptPath: fileURLToPath(new URL('../../../test/storage/do-test-worker.js', import.meta.url)),
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }], compatibilityDate: '2025-01-01',
    durableObjects: { TEST_DO: { className: 'TestDO', useSQLite: true, unsafePreventEviction: true } } });
  const proxy = (): StoragePort => new Proxy({} as StoragePort, {
    get: (_target, method: string) => async (...args: unknown[]) => {
      const response = await mf.dispatchFetch('http://localhost/call', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
      const data = await response.json() as { ok: boolean; value: unknown;
        error: { name: string; message: string; kind: StorageConstraintError['kind'];
          expected: Revision; actual: Revision | null } };
      if (data.ok) return data.value;
      if (data.error.name === 'FenceConflictError') throw new FenceConflictError(data.error.expected, data.error.actual);
      if (data.error.name === 'StorageConstraintError') throw new StorageConstraintError(data.error.kind, data.error.message);
      throw new Error(data.error.message);
    },
  });
  return { store: proxy(), peer: proxy(), close: () => mf.dispose() };
}

for (const [name, open] of [['D1', d1Handles], ['DO SQLite', doHandles]] as const) {
  describe(`fanout checkpoint converse on real ${name}`, () => {
    let handles: Handles | undefined;
    before(async () => { handles = await open(); });
    after(async () => { await handles?.close(); });

    it('rejects a mixed-fanout checkpoint before submitting any child effects', async () => {
      const { store, peer } = handles!;
      const world = await seed(store, `${name}-refusal`);
      const tracked = counted(store);
      const input = effects(await store.readRevision(),
        [world.outcome(world.a), world.cover(world.a), world.cover(world.b)], `${name}-refused-effects`);
      await assert.rejects(createFanoutChildJoinPort({ store: tracked.store }).commitJoin(input), validation);
      assert.equal(tracked.commits(), 0);
      await noEffects(peer, input, input.expectedRevision);
      assert.deepEqual((await peer.load(asModel(FANOUT_CHILD_MODEL), world.a.child.id))!.data, world.a.child.data);
      assert.deepEqual((await peer.load(asModel(FANOUT_CHECKPOINT_MODEL), world.b.checkpoint.id))!.data, world.b.checkpoint.data);
    });

    it('commits two fanouts with their own covers and all child effects in one revision', async () => {
      const { store, peer } = handles!;
      const world = await seed(store, `${name}-accept`);
      const input = effects(await store.readRevision(), [world.outcome(world.a), world.cover(world.a),
        world.outcome(world.b), world.cover(world.b)], `${name}-accepted-effects`);
      const committed = await createFanoutChildJoinPort({ store }).commitJoin(input);
      assert.equal(committed.revision, input.expectedRevision + 1);
      for (const scope of [world.a, world.b]) {
        assert.equal((await peer.load(asModel(FANOUT_CHILD_MODEL), scope.child.id))!.data['state'], 'completed');
        assert.deepEqual(readFanoutCheckpointRow((await peer.load(asModel(FANOUT_CHECKPOINT_MODEL), scope.checkpoint.id))!).completed, ['shared-record']);
      }
      assert.equal((await peer.load(domainModel, asId(`${name}-accepted-effects`)))!.data['value'], `${name}-accepted-effects`);
      assert.equal((await peer.historyFor(domainModel, asId(`${name}-accepted-effects`))).length, 1);
      assert.ok(await peer.readReceipt(input.receipt!.identity));
      assert.ok((await peer.outboxPending()).some(intent => intent.intentId === input.outbox[0]!.intentId));
      assert.ok(await peer.scheduleGet(input.schedules[0]!.key));
    });

    it('rolls back valid join halves and all effects when a child version predicate loses', async () => {
      const { store, peer } = handles!;
      const world = await seed(store, `${name}-rollback`);
      const terminal = world.outcome(world.a);
      if (terminal.kind !== 'update') throw new Error('expected outcome update');
      const input = effects(await store.readRevision(),
        [{ ...terminal, expectedVersion: 999 as RecordVersion }, world.cover(world.a)], `${name}-rolled-back-effects`);
      const tracked = counted(store);
      await assert.rejects(createFanoutChildJoinPort({ store: tracked.store }).commitJoin(input),
        error => error instanceof StateError && error.code === 'conflict');
      assert.equal(tracked.commits(), 1);
      await noEffects(peer, input, input.expectedRevision);
      assert.deepEqual((await peer.load(asModel(FANOUT_CHILD_MODEL), world.a.child.id))!.data, world.a.child.data);
      assert.deepEqual((await peer.load(asModel(FANOUT_CHECKPOINT_MODEL), world.a.checkpoint.id))!.data, world.a.checkpoint.data);
    });
  });
}
