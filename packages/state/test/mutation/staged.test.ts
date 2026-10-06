/**
 * T31 (Rule A) staged hook writes: memory-only semantics.
 *
 * MEMORY-ONLY: every claim here concerns deterministic engine semantics
 * (batch shape, staging order, error mapping, receipt/history identity,
 * static negatives). Durability, crash atomicity, and real-concurrency
 * fencing are proven in staged-durable.test.ts on miniflare D1 + workerd
 * DO — nothing here claims them.
 *
 * Rule A: a create/update hook may adjust the pending record AND stage
 * secondary writes (create/set on other models, same-model barred) plus
 * schedule/cancel timers, committing atomically with the trigger in one
 * owner transaction. Staged writes re-run invariants/locks, reserve their
 * own versions, enroll in the existing fence via the single batch commit,
 * record history under the trigger's operation identity, and never
 * re-invoke CRUD hooks (flat, no cascade).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StoredRow } from '@canlang/contracts';
import { StateError } from '../../src/errors.js';
import { storageToStateError } from '../../src/errors.js';
import { runMutationWrites } from '../../src/mutation/pipeline.js';
import type {
  InterimHookContext,
  InterimHookStagedWrite,
} from '../../src/mutation/models.js';
import { StorageConstraintError } from '../../src/storage/port.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  asOperation,
  captureStateError,
  crudCall,
  crudCreate,
  crudRemove,
  crudUpdate,
  field,
  freshOperationId,
  hook,
  invariant,
  lock,
  modelDef,
  mustLoad,
  pipelineContext,
  readCrudReceipt,
  refDef,
  refValue,
  setupMutation,
} from './fixtures.js';

const CHECK = 'Acme.Check';
const TRANSITION = 'Acme.Transition';
const NOTICE = 'Acme.Notice';

function checkModel(
  opts: Parameters<typeof modelDef>[1] = {},
): ReturnType<typeof modelDef> {
  return modelDef(CHECK, {
    fields: { state: field(), revision: field() },
    ...opts,
  });
}

function childModel(
  model: string,
  opts: Parameters<typeof modelDef>[1] = {},
): ReturnType<typeof modelDef> {
  return modelDef(model, { fields: { note: field() }, ...opts });
}

/** Non-StateError catcher for storage-layer failures (fence/version). */
async function captureFailure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected failure, got success.');
}

describe('T31 staged hook writes (memory-only)', () => {
  it('update hook stages parented children atomically (pending v+1 once, children v1)', async () => {
    const stageChildren = hook('stage-children', ['update'], (candidate, ctx) => {
      ctx.stage({
        op: 'create',
        model: asModel(TRANSITION),
        id: asId('t-1'),
        parent: { model: ctx.triggerModel, id: ctx.triggerId },
        data: { note: 'first' },
      });
      ctx.stage({
        op: 'create',
        model: asModel(NOTICE),
        id: asId('n-1'),
        parent: { model: ctx.triggerModel, id: ctx.triggerId },
        data: { note: 'ping' },
      });
      return { ...candidate, state: 'configured' };
    });
    const world = await setupMutation([
      checkModel({ hooks: [stageChildren] }),
      childModel(TRANSITION),
      childModel(NOTICE),
    ]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    const revisionBefore = await world.store.readRevision();
    const { out, operationId } = await crudUpdate(world, CHECK, 'c-1', {
      version: 1,
      patch: { revision: 2 },
    });
    assert.equal(out.status, 'committed');
    // One owner transaction: a single fence revision covers trigger + set.
    assert.equal(await world.store.readRevision(), (revisionBefore as number) + 1);
    // Pending parent reserved v+1 exactly once; hook adjustment landed.
    const check = await mustLoad(world.store, asModel(CHECK), 'c-1');
    assert.equal(check.version, 2);
    assert.deepEqual(check.data, { state: 'configured', revision: 2 });
    // Children are their own version-1 rows parented to the pending record.
    const transition = await mustLoad(world.store, asModel(TRANSITION), 't-1');
    assert.equal(transition.version, 1);
    assert.deepEqual(transition.parent, { model: CHECK, id: 'c-1' });
    const notice = await mustLoad(world.store, asModel(NOTICE), 'n-1');
    assert.equal(notice.version, 1);
    assert.deepEqual(notice.parent, { model: CHECK, id: 'c-1' });
    // Operation identity spans the staged set.
    const receipt = await readCrudReceipt(world, {
      operation: `${CHECK}.update`,
      operationId,
    });
    assert.equal(receipt?.outcome.status, 'committed');
    assert.deepEqual(
      receipt?.outcome.status === 'committed' ? receipt.outcome.recordVersions : null,
      [
        { model: CHECK, id: 'c-1', version: 2 },
        { model: TRANSITION, id: 't-1', version: 1 },
        { model: NOTICE, id: 'n-1', version: 1 },
      ],
    );
    for (const [model, id] of [
      [CHECK, 'c-1'],
      [TRANSITION, 't-1'],
      [NOTICE, 'n-1'],
    ] as const) {
      const entries = await world.store.historyFor(asModel(model), asId(id));
      const last = entries[entries.length - 1];
      assert.equal(last?.operationId, operationId);
      assert.equal(last?.operation, `${CHECK}.update`);
    }
  });

  it('create hook stages a child parented to the pending create (v1 throughout)', async () => {
    const stageOnCreate = hook('stage-on-create', ['create'], (candidate, ctx) => {
      assert.equal(ctx.before, null);
      ctx.stage({
        op: 'create',
        model: asModel(TRANSITION),
        id: asId('t-9'),
        parent: { model: ctx.triggerModel, id: ctx.triggerId },
        data: { note: 'born-staged' },
      });
      return { ...candidate, state: 'initial' };
    });
    const world = await setupMutation([
      checkModel({ hooks: [stageOnCreate] }),
      childModel(TRANSITION),
    ]);
    const { out } = await crudCreate(world, CHECK, { id: 'c-9', data: {} });
    assert.equal(out.status, 'committed');
    // Created row holds version 1 throughout its creating transaction,
    // including create-hook adjustments (settled version rule).
    const check = await mustLoad(world.store, asModel(CHECK), 'c-9');
    assert.equal(check.version, 1);
    assert.deepEqual(check.data, { state: 'initial' });
    const transition = await mustLoad(world.store, asModel(TRANSITION), 't-9');
    assert.equal(transition.version, 1);
    assert.deepEqual(transition.parent, { model: CHECK, id: 'c-9' });
  });

  it('a failing staged invariant voids the trigger (atomic rollback)', async () => {
    const stageBadChild = hook('stage-bad-child', ['update'], (candidate, ctx) => {
      ctx.stage({
        op: 'create',
        model: asModel(TRANSITION),
        id: asId('t-bad'),
        parent: { model: ctx.triggerModel, id: ctx.triggerId },
        data: { note: 'doomed' },
      });
      return { ...candidate, state: 'configured' };
    });
    const world = await setupMutation([
      checkModel({ hooks: [stageBadChild] }),
      childModel(TRANSITION, {
        invariants: [
          invariant('no-doomed', () => {
            throw new StateError('rule_failed', 'Doomed children rejected.');
          }),
        ],
      }),
    ]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    const error = await captureStateError(
      crudUpdate(world, CHECK, 'c-1', { version: 1, patch: { revision: 2 } }),
    );
    assert.equal(error.code, 'rule_failed');
    // Trigger + staged set rolled back together: nothing persisted.
    const check = await mustLoad(world.store, asModel(CHECK), 'c-1');
    assert.equal(check.version, 1);
    assert.deepEqual(check.data, { state: 'initial' });
    assert.equal(await world.store.load(asModel(TRANSITION), asId('t-bad')), null);
    assert.deepEqual(await world.store.historyFor(asModel(TRANSITION), asId('t-bad')), []);
    const triggerHistory = await world.store.historyFor(asModel(CHECK), asId('c-1'));
    assert.equal(triggerHistory.length, 1);
    assert.equal(triggerHistory[0]?.change, 'create');
  });

  it('a failing staged lock voids the trigger (atomic rollback)', async () => {
    const bumpLocked = hook('bump-locked', ['update'], (candidate, ctx) => {
      ctx.stage({
        op: 'update',
        model: asModel(NOTICE),
        id: asId('n-locked'),
        data: { note: 'bumped' },
      });
      return candidate;
    });
    const world = await setupMutation([
      checkModel({ hooks: [bumpLocked] }),
      childModel(NOTICE, {
        locks: [lock('frozen', { op: 'eq', field: 'note', value: 'frozen' })],
      }),
    ]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    await crudCreate(world, NOTICE, { id: 'n-locked', data: { note: 'frozen' } });
    const error = await captureStateError(
      crudUpdate(world, CHECK, 'c-1', { version: 1, patch: { revision: 2 } }),
    );
    assert.equal(error.code, 'rule_failed');
    assert.equal((await mustLoad(world.store, asModel(CHECK), 'c-1')).version, 1);
    const notice = await mustLoad(world.store, asModel(NOTICE), 'n-locked');
    assert.equal(notice.version, 1);
    assert.deepEqual(notice.data, { note: 'frozen' });
  });

  it('a staged unique conflict voids the trigger (atomic rollback)', async () => {
    const stageDupe = hook('stage-dupe', ['update'], (candidate, ctx) => {
      ctx.stage({
        op: 'create',
        model: asModel(TRANSITION),
        id: asId('t-dupe'),
        data: { note: 'taken' },
      });
      return candidate;
    });
    const world = await setupMutation([
      checkModel({ hooks: [stageDupe] }),
      childModel(TRANSITION, { uniqueKeys: ['note'] }),
    ]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    await crudCreate(world, TRANSITION, { id: 't-held', data: { note: 'taken' } });
    const error = await captureStateError(
      crudUpdate(world, CHECK, 'c-1', { version: 1, patch: { revision: 2 } }),
    );
    assert.equal(error.code, 'conflict');
    assert.equal((await mustLoad(world.store, asModel(CHECK), 'c-1')).version, 1);
    assert.equal(await world.store.load(asModel(TRANSITION), asId('t-dupe')), null);
  });

  it('an intervening commit to a staged target invalidates the batch (fence, then version)', async () => {
    const bumpTarget = hook('bump-target', ['update'], (candidate, ctx) => {
      ctx.stage({
        op: 'update',
        model: asModel(NOTICE),
        id: asId('n-1'),
        data: { note: 'staged-bump' },
      });
      ctx.schedule({
        key: 'deadline:c-1',
        at: FIXED_NOW + 1000,
        event: asOperation('Acme.Check.deadline'),
        payload: {},
      });
      return candidate;
    });
    const world = await setupMutation([
      checkModel({ hooks: [bumpTarget] }),
      childModel(NOTICE),
    ]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    await crudCreate(world, NOTICE, { id: 'n-1', data: { note: 'v1' } });
    const effects = await runMutationWrites({
      table: world.table,
      writes: [
        {
          op: 'update',
          model: asModel(CHECK),
          id: asId('c-1'),
          data: { revision: 2 },
        },
      ],
      context: pipelineContext({ operation: `${CHECK}.update` }),
      store: world.store,
    });
    assert.equal(effects.writes.length, 2);
    const fence = await world.store.readRevision();
    // Intervene directly: bump the staged target (v1 -> v2) on the fence.
    const target = await mustLoad(world.store, asModel(NOTICE), 'n-1');
    const bumped: StoredRow = {
      ...target,
      version: 2 as StoredRow['version'],
      updated: FIXED_NOW + 1,
    };
    await world.store.commit({
      expectedRevision: fence,
      writes: [
        {
          kind: 'update',
          model: asModel(NOTICE),
          id: asId('n-1'),
          expectedVersion: target.version,
          row: bumped,
        },
      ],
      history: [],
      receipt: null,
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
    });
    // The staged batch committed at the stale fence loses the fence first.
    const fenceFailure = await captureFailure(
      world.store.commit({
        expectedRevision: fence,
        writes: effects.writes,
        history: effects.history,
        receipt: null,
        outbox: [],
        schedules: effects.schedules,
        uniqueClaims: effects.uniqueClaims,
        uniqueReleases: effects.uniqueReleases,
      }),
    );
    assert.equal(fenceFailure.name, 'FenceConflictError');
    // At a fresh fence the stale staged-target version conflicts instead —
    // never a silent overwrite.
    const freshFence = await world.store.readRevision();
    const versionFailure = await captureFailure(
      world.store.commit({
        expectedRevision: freshFence,
        writes: effects.writes,
        history: effects.history,
        receipt: null,
        outbox: [],
        schedules: effects.schedules,
        uniqueClaims: effects.uniqueClaims,
        uniqueReleases: effects.uniqueReleases,
      }),
    );
    if (!(versionFailure instanceof StorageConstraintError)) {
      throw new Error(`Expected a version conflict, got ${versionFailure.name}.`);
    }
    assert.equal(versionFailure.kind, 'version');
    assert.equal(storageToStateError(versionFailure).code, 'conflict');
    // Nothing from the staged batch persisted: only the intervention stands.
    assert.equal(await world.store.readRevision(), (fence as number) + 1);
    assert.equal((await mustLoad(world.store, asModel(CHECK), 'c-1')).version, 1);
    assert.deepEqual((await mustLoad(world.store, asModel(NOTICE), 'n-1')).data, {
      note: 'v1',
    });
    assert.equal(await world.store.scheduleGet('deadline:c-1'), null);
  });

  it('a concurrent change to the pending record conflicts, never silent', async () => {
    const stageChild = hook('stage-child', ['update'], (candidate, ctx) => {
      ctx.stage({
        op: 'create',
        model: asModel(TRANSITION),
        id: asId('t-race'),
        parent: { model: ctx.triggerModel, id: ctx.triggerId },
        data: { note: 'raced' },
      });
      return candidate;
    });
    const world = await setupMutation([
      checkModel({ hooks: [stageChild] }),
      childModel(TRANSITION),
    ]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    const effects = await runMutationWrites({
      table: world.table,
      writes: [
        { op: 'update', model: asModel(CHECK), id: asId('c-1'), data: { revision: 2 } },
      ],
      context: pipelineContext({ operation: `${CHECK}.update` }),
      store: world.store,
    });
    const fence = await world.store.readRevision();
    // Intervene on the PENDING record itself (v1 -> v2) on the fence.
    const pending = await mustLoad(world.store, asModel(CHECK), 'c-1');
    await world.store.commit({
      expectedRevision: fence,
      writes: [
        {
          kind: 'update',
          model: asModel(CHECK),
          id: asId('c-1'),
          expectedVersion: pending.version,
          row: { ...pending, version: 2 as StoredRow['version'], updated: FIXED_NOW + 1 },
        },
      ],
      history: [],
      receipt: null,
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
    });
    const freshFence = await world.store.readRevision();
    const failure = await captureFailure(
      world.store.commit({
        expectedRevision: freshFence,
        writes: effects.writes,
        history: effects.history,
        receipt: null,
        outbox: [],
        schedules: effects.schedules,
        uniqueClaims: effects.uniqueClaims,
        uniqueReleases: effects.uniqueReleases,
      }),
    );
    if (!(failure instanceof StorageConstraintError)) {
      throw new Error(`Expected a version conflict, got ${failure.name}.`);
    }
    assert.equal(failure.kind, 'version');
    assert.equal(storageToStateError(failure).code, 'conflict');
    assert.equal(await world.store.load(asModel(TRANSITION), asId('t-race')), null);
  });

  it('hooks evaluate once in written order; staged writes commit in staging order', async () => {
    const order: string[] = [];
    const first = hook('first', ['update'], (candidate, ctx) => {
      order.push('first');
      ctx.stage({
        op: 'create',
        model: asModel(TRANSITION),
        id: asId('t-a'),
        data: { note: 'a' },
      });
      return { ...candidate, state: 'first-seen' };
    });
    const second = hook('second', ['update'], (candidate, ctx) => {
      order.push('second');
      // Written-order chaining: the second hook observes the first hook's
      // adjustment on the proposed state.
      assert.equal(candidate['state'], 'first-seen');
      ctx.stage({
        op: 'create',
        model: asModel(NOTICE),
        id: asId('n-b'),
        data: { note: 'b' },
      });
      return candidate;
    });
    const world = await setupMutation([
      checkModel({ hooks: [first, second] }),
      childModel(TRANSITION),
      childModel(NOTICE),
    ]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    const { out, operationId } = await crudUpdate(world, CHECK, 'c-1', {
      version: 1,
      patch: {},
    });
    assert.equal(out.status, 'committed');
    assert.deepEqual(order, ['first', 'second']);
    const receipt = await readCrudReceipt(world, {
      operation: `${CHECK}.update`,
      operationId,
    });
    assert.deepEqual(
      receipt?.outcome.status === 'committed' ? receipt.outcome.recordVersions : null,
      [
        { model: CHECK, id: 'c-1', version: 2 },
        { model: TRANSITION, id: 't-a', version: 1 },
        { model: NOTICE, id: 'n-b', version: 1 },
      ],
    );
  });

  it('staged writes observe earlier staged rows (ordered provisional reads)', async () => {
    const POLICY = 'Acme.Policy';
    const EVIDENCE = 'Acme.Evidence';
    const stageChain = hook('stage-chain', ['update'], (candidate, ctx) => {
      ctx.stage({
        op: 'create',
        model: asModel(POLICY),
        id: asId('p-1'),
        data: { note: 'policy' },
      });
      // Second staged write parents to + references the FIRST staged row,
      // which exists only provisionally until commit.
      ctx.stage({
        op: 'create',
        model: asModel(EVIDENCE),
        id: asId('e-1'),
        parent: { model: asModel(POLICY), id: asId('p-1') },
        data: { note: 'evidence', policy: refValue('p-1') },
      });
      return candidate;
    });
    const world = await setupMutation([
      checkModel({ hooks: [stageChain] }),
      childModel(POLICY),
      modelDef(EVIDENCE, {
        fields: { note: field(), policy: field() },
        refs: [refDef('policy', POLICY)],
      }),
    ]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    const { out } = await crudUpdate(world, CHECK, 'c-1', { version: 1, patch: {} });
    assert.equal(out.status, 'committed');
    const evidence = await mustLoad(world.store, asModel(EVIDENCE), 'e-1');
    assert.deepEqual(evidence.parent, { model: POLICY, id: 'p-1' });
    assert.deepEqual(evidence.data, { note: 'evidence', policy: { id: 'p-1' } });
  });

  it('staged writes never re-invoke CRUD hooks (flat, no cascade)', async () => {
    const calls: string[] = [];
    const noisy = hook('noisy-create', ['create'], (candidate) => {
      calls.push('noisy-create');
      return candidate;
    });
    const rejector = hook('reject-all', ['create'], () => {
      throw new StateError('rule_failed', 'Must never run for staged writes.');
    });
    const stageBoth = hook('stage-both', ['update'], (candidate, ctx) => {
      ctx.stage({
        op: 'create',
        model: asModel(TRANSITION),
        id: asId('t-flat'),
        data: { note: 'flat' },
      });
      ctx.stage({
        op: 'create',
        model: asModel(NOTICE),
        id: asId('n-flat'),
        data: { note: 'flat' },
      });
      return candidate;
    });
    const world = await setupMutation([
      checkModel({ hooks: [stageBoth] }),
      childModel(TRANSITION, { hooks: [noisy] }),
      childModel(NOTICE, { hooks: [rejector] }),
    ]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    const { out } = await crudUpdate(world, CHECK, 'c-1', { version: 1, patch: {} });
    assert.equal(out.status, 'committed');
    assert.deepEqual(calls, []);
    assert.equal((await mustLoad(world.store, asModel(TRANSITION), 't-flat')).version, 1);
    assert.equal((await mustLoad(world.store, asModel(NOTICE), 'n-flat')).version, 1);
  });

  it('staged creates resolve defaults on the shared per-write path', async () => {
    const stageDefaulted = hook('stage-defaulted', ['update'], (candidate, ctx) => {
      ctx.stage({
        op: 'create',
        model: asModel(TRANSITION),
        id: asId('t-dflt'),
        parent: { model: ctx.triggerModel, id: ctx.triggerId },
        data: {},
      });
      return candidate;
    });
    const world = await setupMutation([
      checkModel({ hooks: [stageDefaulted] }),
      modelDef(TRANSITION, {
        fields: {
          note: field({ default: 'auto' }),
          stateCopy: field({ default: { parentPath: 'state' } }),
        },
      }),
    ]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    const { out } = await crudUpdate(world, CHECK, 'c-1', { version: 1, patch: {} });
    assert.equal(out.status, 'committed');
    // Literal + parent-path defaults resolve for staged creates exactly as
    // for caller creates (DESIGN:332 prep timing, shared path).
    assert.deepEqual((await mustLoad(world.store, asModel(TRANSITION), 't-dflt')).data, {
      note: 'auto',
      stateCopy: 'initial',
    });
  });

  it('staged writes into the triggering CRUD path fail (same-model bar)', async () => {
    let behavior: 'update-same' | 'create-same' = 'update-same';
    const recursor = hook('recursor', ['update'], (candidate, ctx) => {
      if (behavior === 'update-same') {
        ctx.stage({
          op: 'update',
          model: asModel(CHECK),
          id: asId('c-1'),
          data: { revision: 99 },
        });
      } else {
        ctx.stage({
          op: 'create',
          model: asModel(CHECK),
          id: asId('c-2'),
          data: { state: 'sneaked' },
        });
      }
      return candidate;
    });
    const world = await setupMutation([checkModel({ hooks: [recursor] })]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    // Triggering-path recursion (Check.update from a Check update hook).
    const direct = await captureStateError(
      crudUpdate(world, CHECK, 'c-1', { version: 1, patch: {} }),
    );
    assert.equal(direct.code, 'validation');
    assert.match(direct.message, /same-model/);
    // Same-model via a different op (Check.create from a Check update hook)
    // is barred too — the narrower bar adopted for T31.
    behavior = 'create-same';
    const crossOp = await captureStateError(
      crudUpdate(world, CHECK, 'c-1', { version: 1, patch: {} }),
    );
    assert.equal(crossOp.code, 'validation');
    assert.match(crossOp.message, /same-model/);
    assert.equal((await mustLoad(world.store, asModel(CHECK), 'c-1')).version, 1);
    assert.equal(await world.store.load(asModel(CHECK), asId('c-2')), null);
  });

  it('staged deletes fail (pending-source deletion is a forbidden shape)', async () => {
    const deleter = hook('deleter', ['update'], (candidate, ctx) => {
      ctx.stage({
        op: 'remove',
        model: asModel(TRANSITION),
        id: asId('t-1'),
      } as unknown as InterimHookStagedWrite);
      return candidate;
    });
    const world = await setupMutation([
      checkModel({ hooks: [deleter] }),
      childModel(TRANSITION),
    ]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    await crudCreate(world, TRANSITION, { id: 't-1', data: { note: 'keep' } });
    const error = await captureStateError(
      crudUpdate(world, CHECK, 'c-1', { version: 1, patch: {} }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /create\/set only/);
    // Neither the pending source nor the staged target was deleted.
    assert.equal((await mustLoad(world.store, asModel(CHECK), 'c-1')).version, 1);
    assert.equal((await mustLoad(world.store, asModel(TRANSITION), 't-1')).version, 1);
  });

  it('delete hooks cannot stage writes or timers', async () => {
    let behavior: 'write' | 'schedule' | 'cancel' = 'write';
    const stager = hook('stager', ['remove'], (candidate, ctx) => {
      if (behavior === 'write') {
        ctx.stage({
          op: 'create',
          model: asModel(TRANSITION),
          id: asId('t-nope'),
          data: {},
        });
      } else if (behavior === 'schedule') {
        ctx.schedule({
          key: 'k-nope',
          at: FIXED_NOW,
          event: asOperation('Acme.Check.deadline'),
          payload: {},
        });
      } else {
        ctx.cancel('k-nope');
      }
      return candidate;
    });
    const world = await setupMutation([
      checkModel({ hooks: [stager] }),
      childModel(TRANSITION),
    ]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    for (const next of ['write', 'schedule', 'cancel'] as const) {
      behavior = next;
      const error = await captureStateError(
        crudRemove(world, CHECK, 'c-1', { version: 1 }),
      );
      assert.equal(error.code, 'validation');
      assert.match(error.message, /runs on a delete/);
    }
    // The trigger row survives unarchived; nothing staged.
    assert.equal((await mustLoad(world.store, asModel(CHECK), 'c-1')).archivedAt, null);
    assert.equal(await world.store.load(asModel(TRANSITION), asId('t-nope')), null);
    assert.equal(await world.store.scheduleGet('k-nope'), null);
  });

  it('before/input snapshots are immutable to hooks', async () => {
    let frozenBefore = false;
    let frozenData = false;
    const observer = hook('observer', ['update'], (candidate, ctx) => {
      frozenBefore = Object.isFrozen(ctx.before);
      frozenData = ctx.before !== null && Object.isFrozen(ctx.before.data);
      return candidate;
    });
    const mutator = hook('mutator', ['update'], (candidate, ctx) => {
      assert.notEqual(ctx.before, null);
      (ctx.before?.data as Record<string, unknown>)['state'] = 'corrupted';
      return candidate;
    });
    const world = await setupMutation([checkModel({ hooks: [observer, mutator] })]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    await assert.rejects(crudUpdate(world, CHECK, 'c-1', { version: 1, patch: {} }), {
      name: 'TypeError',
    });
    // The earlier hook in written order still observed the frozen snapshot.
    assert.equal(frozenBefore, true);
    assert.equal(frozenData, true);
    // The failed trigger persisted nothing.
    const check = await mustLoad(world.store, asModel(CHECK), 'c-1');
    assert.equal(check.version, 1);
    assert.deepEqual(check.data, { state: 'initial' });
  });

  it('malformed staged shapes fail closed with hook attribution', async () => {
    let attempt = 0;
    const attempts: Array<(ctx: InterimHookContext) => void> = [
      (ctx) => ctx.stage({ op: 'create', model: asModel(TRANSITION), id: asId('') }),
      (ctx) =>
        ctx.stage({
          op: 'create',
          model: asModel(TRANSITION),
          id: asId('t-x'),
          data: 'nope' as unknown as Record<string, unknown>,
        }),
      (ctx) =>
        ctx.stage({
          op: 'create',
          model: asModel(TRANSITION),
          id: asId('t-x'),
          parent: { model: asModel(CHECK), id: asId('') },
        }),
      (ctx) =>
        ctx.stage({
          op: 'update',
          model: asModel(TRANSITION),
          id: asId('t-1'),
          parent: { model: asModel(CHECK), id: asId('c-1') },
        } as unknown as InterimHookStagedWrite),
      (ctx) => ctx.stage('nope' as unknown as InterimHookStagedWrite),
      (ctx) =>
        ctx.schedule({
          key: '',
          at: FIXED_NOW,
          event: asOperation('Acme.Check.deadline'),
          payload: {},
        }),
      (ctx) =>
        ctx.schedule({
          key: 'k-x',
          at: -1,
          event: asOperation('Acme.Check.deadline'),
          payload: {},
        }),
      (ctx) =>
        ctx.schedule({
          key: 'k-x',
          at: FIXED_NOW,
          event: asOperation('Acme.Check.deadline'),
          payload: 'nope' as unknown as Record<string, unknown>,
        }),
      (ctx) => ctx.cancel(''),
    ];
    const fuzzer = hook('fuzzer', ['update'], (candidate, ctx) => {
      const run = attempts[attempt];
      if (run === undefined) {
        throw new Error('Fuzz battery misaligned.');
      }
      run(ctx);
      return candidate;
    });
    const world = await setupMutation([
      checkModel({ hooks: [fuzzer] }),
      childModel(TRANSITION),
    ]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    for (attempt = 0; attempt < attempts.length; attempt += 1) {
      const error = await captureStateError(
        crudUpdate(world, CHECK, 'c-1', { version: 1, patch: {} }),
      );
      assert.equal(error.code, 'validation');
      assert.match(error.message, /Hook "fuzzer"/);
    }
    assert.equal((await mustLoad(world.store, asModel(CHECK), 'c-1')).version, 1);
  });

  it('unknown staged models are programmer bugs, like unknown caller models', async () => {
    const stager = hook('stager', ['update'], (candidate, ctx) => {
      ctx.stage({
        op: 'create',
        model: asModel('Acme.Missing'),
        id: asId('m-1'),
        data: {},
      });
      return candidate;
    });
    const world = await setupMutation([checkModel({ hooks: [stager] })]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    await assert.rejects(crudUpdate(world, CHECK, 'c-1', { version: 1, patch: {} }), /unknown model/);
  });

  it('the staged set replays by operation identity with the same result', async () => {
    const stageChild = hook('stage-child', ['update'], (candidate, ctx) => {
      ctx.stage({
        op: 'create',
        model: asModel(TRANSITION),
        id: asId('t-re'),
        parent: { model: ctx.triggerModel, id: ctx.triggerId },
        data: { note: 'replayable' },
      });
      return { ...candidate, state: 'configured' };
    });
    const world = await setupMutation([
      checkModel({ hooks: [stageChild] }),
      childModel(TRANSITION),
    ]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    const inputs = { ref: { id: 'c-1', version: '1' }, patch: {} };
    const operationId = freshOperationId();
    const first = await crudCall({
      world,
      operation: `${CHECK}.update`,
      inputs: structuredClone(inputs),
      operationId,
    });
    assert.equal(first.status, 'committed');
    const revisionAfterCommit = await world.store.readRevision();
    const replayed = await crudCall({
      world,
      operation: `${CHECK}.update`,
      inputs: structuredClone(inputs),
      operationId,
    });
    assert.equal(replayed.status, 'replayed');
    assert.deepEqual(replayed.result, first.result);
    // Replay commits nothing new: one trigger row version, one child.
    assert.equal(await world.store.readRevision(), revisionAfterCommit);
    assert.equal((await mustLoad(world.store, asModel(CHECK), 'c-1')).version, 2);
    assert.equal((await mustLoad(world.store, asModel(TRANSITION), 't-re')).version, 1);
  });

  it('hook-staged schedule/cancel ops commit with the trigger', async () => {
    const retimer = hook('retimer', ['update'], (candidate, ctx) => {
      ctx.cancel('deadline:old');
      ctx.schedule({
        key: `deadline:${ctx.triggerId}`,
        at: FIXED_NOW + 5000,
        event: asOperation('Acme.Check.deadline'),
        payload: { revision: 2 },
      });
      return candidate;
    });
    const world = await setupMutation([checkModel({ hooks: [retimer] })]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    const fence = await world.store.readRevision();
    await world.store.commit({
      expectedRevision: fence,
      writes: [],
      history: [],
      receipt: null,
      outbox: [],
      schedules: [
        {
          op: 'replace',
          key: 'deadline:old',
          at: FIXED_NOW,
          event: asOperation('Acme.Check.deadline'),
          payload: {},
        },
      ],
      uniqueClaims: [],
      uniqueReleases: [],
    });
    const { out } = await crudUpdate(world, CHECK, 'c-1', { version: 1, patch: {} });
    assert.equal(out.status, 'committed');
    assert.equal(await world.store.scheduleGet('deadline:old'), null);
    assert.deepEqual(await world.store.scheduleGet('deadline:c-1'), {
      key: 'deadline:c-1',
      at: FIXED_NOW + 5000,
      event: 'Acme.Check.deadline',
      payload: { revision: 2 },
    });
  });

  it('hook-side server-owned adjustment stays accepted (R27-open, zero change)', async () => {
    // Boundary 2: no adopted T18 rule exists, so the engine preserves the
    // current hook-side acceptance exactly (CanCheck armed adjustment keeps
    // working) while the ordinary path keeps rejecting. T18 adjudicates.
    const armed = hook('armed', ['update'], (candidate, ctx) => ({ ...candidate, armed: ctx.now }));
    const world = await setupMutation([
      modelDef(CHECK, {
        fields: { state: field(), armed: field({ serverOnly: true }) },
        hooks: [armed],
      }),
    ]);
    await crudCreate(world, CHECK, { id: 'c-1', data: { state: 'initial' } });
    // Ordinary path: server-owned writes still rejected (unchanged).
    const ordinary = await captureStateError(
      crudUpdate(world, CHECK, 'c-1', { version: 1, patch: { armed: FIXED_NOW } }),
    );
    assert.equal(ordinary.code, 'validation');
    // Hook path: hook-set server-owned values still accepted (unchanged).
    const { out } = await crudUpdate(world, CHECK, 'c-1', { version: 1, patch: {} });
    assert.equal(out.status, 'committed');
    assert.deepEqual((await mustLoad(world.store, asModel(CHECK), 'c-1')).data, {
      state: 'initial',
      armed: FIXED_NOW,
    });
  });
});
