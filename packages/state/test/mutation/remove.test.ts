/**
 * Lane 03 S5 remove tests (test worker): archive default vs hard remove vs
 * `none`, archived-target validation, disposal scans (remove blocked, archive
 * allowed), archived-ref rules for new vs unchanged links, and the
 * archive-with-hook-adjusted-unique claim regression.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runMutationWrites } from '../../src/mutation/index.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  captureStateError,
  crudCreate,
  crudRemove,
  crudUpdate,
  field,
  hook,
  modelDef,
  mustLoad,
  pipelineContext,
  refDef,
  seedStoredRow,
  setupMutation,
} from './fixtures.js';

const TARGET = 'Acme.Target';
const CHILD = 'Acme.Child';

function targetModel(deleteMode: 'archive' | 'remove' | 'none' = 'archive') {
  return modelDef(TARGET, {
    fields: { email: field({ required: true }) },
    uniqueKeys: ['email'],
    deleteMode,
  });
}

function childModel() {
  return modelDef(CHILD, {
    fields: { target: field(), note: field() },
    refs: [refDef('target', TARGET)],
  });
}

describe('mutation remove', () => {
  it('archives by default: stamps, bumps, keeps uniques reserved', async () => {
    const world = await setupMutation([targetModel()]);
    await crudCreate(world, TARGET, { id: 't-1', data: { email: 'a@example.test' } });
    const { out } = await crudRemove(world, TARGET, 't-1', { version: 1 });
    assert.equal(out.status, 'committed');
    const stored = await mustLoad(world.store, asModel(TARGET), 't-1');
    assert.equal(stored.archivedAt, FIXED_NOW);
    assert.equal(stored.version, 2);
    assert.equal(stored.updatedBy, world.alice.user.user_id);
    const history = world.probe.historyFor(asModel(TARGET), asId('t-1'));
    assert.deepEqual(
      history.map((entry) => entry.change),
      ['create', 'archive'],
    );
    assert.equal(history[1]?.version, 2);
    // Uniques stay reserved: recreating the same unique conflicts.
    const blocked = await captureStateError(
      crudCreate(world, TARGET, { id: 't-2', data: { email: 'a@example.test' } }),
    );
    assert.equal(blocked.code, 'conflict');
  });

  it('rejects archiving an archived row with validation', async () => {
    const world = await setupMutation([targetModel()]);
    await crudCreate(world, TARGET, { id: 't-1', data: { email: 'a@example.test' } });
    await crudRemove(world, TARGET, 't-1', { version: 1 });
    // End-to-end the archived target is ineligible at admission...
    const error = await captureStateError(crudRemove(world, TARGET, 't-1', { version: 2 }));
    assert.equal(error.code, 'validation');
    // ...and the pipeline itself rejects the double archive too.
    const direct = await captureStateError(
      runMutationWrites({
        table: world.table,
        writes: [{ op: 'remove', model: asModel(TARGET), id: asId('t-1') }],
        context: pipelineContext({ operation: `${TARGET}.delete` }),
        store: world.store,
      }),
    );
    assert.equal(direct.code, 'validation');
  });

  it('hard-removes in remove mode: row gone, uniques released', async () => {
    const world = await setupMutation([targetModel('remove')]);
    await crudCreate(world, TARGET, { id: 't-1', data: { email: 'a@example.test' } });
    const { out } = await crudRemove(world, TARGET, 't-1', { version: 1 });
    assert.equal(out.status, 'committed');
    assert.equal(out.result, null);
    assert.equal(await world.store.load(asModel(TARGET), asId('t-1')), null);
    const history = world.probe.historyFor(asModel(TARGET), asId('t-1'));
    assert.deepEqual(
      history.map((entry) => entry.change),
      ['create', 'remove'],
    );
    assert.equal(history[1]?.after, null);
    assert.deepEqual(history[1]?.before, { email: 'a@example.test' });
    // The released unique is reusable.
    const reuse = await crudCreate(world, TARGET, { id: 't-2', data: { email: 'a@example.test' } });
    assert.equal(reuse.out.status, 'committed');
  });

  it('rejects deletes in none mode with validation', async () => {
    const world = await setupMutation([targetModel('none')]);
    await crudCreate(world, TARGET, { id: 't-1', data: { email: 'a@example.test' } });
    const error = await captureStateError(crudRemove(world, TARGET, 't-1', { version: 1 }));
    assert.equal(error.code, 'validation');
    assert.ok((await world.store.load(asModel(TARGET), asId('t-1'))) !== null);
  });

  it('blocks hard remove on incoming refs with rule_failed', async () => {
    const world = await setupMutation([targetModel('remove'), childModel()]);
    await crudCreate(world, TARGET, { id: 't-1', data: { email: 'a@example.test' } });
    await crudCreate(world, CHILD, { id: 'c-1', data: { target: { id: 't-1' } } });
    const error = await captureStateError(crudRemove(world, TARGET, 't-1', { version: 1 }));
    assert.equal(error.code, 'rule_failed');
    assert.ok((await world.store.load(asModel(TARGET), asId('t-1'))) !== null);
    assert.ok((await world.store.load(asModel(CHILD), asId('c-1'))) !== null);
  });

  it('allows archive with incoming refs (history keeps the link)', async () => {
    const world = await setupMutation([targetModel(), childModel()]);
    await crudCreate(world, TARGET, { id: 't-1', data: { email: 'a@example.test' } });
    await crudCreate(world, CHILD, { id: 'c-1', data: { target: { id: 't-1' } } });
    const { out } = await crudRemove(world, TARGET, 't-1', { version: 1 });
    assert.equal(out.status, 'committed');
    assert.equal((await mustLoad(world.store, asModel(TARGET), 't-1')).archivedAt, FIXED_NOW);
    assert.deepEqual((await mustLoad(world.store, asModel(CHILD), 'c-1')).data, {
      target: { id: 't-1' },
    });
  });

  it('rejects new refs to archived rows on create and update', async () => {
    const world = await setupMutation([targetModel(), childModel()]);
    await crudCreate(world, TARGET, { id: 't-1', data: { email: 'a@example.test' } });
    await crudRemove(world, TARGET, 't-1', { version: 1 });
    const onCreate = await captureStateError(
      crudCreate(world, CHILD, { id: 'c-1', data: { target: { id: 't-1' } } }),
    );
    assert.equal(onCreate.code, 'validation');
    await crudCreate(world, CHILD, { id: 'c-2', data: { note: 'plain' } });
    const onUpdate = await captureStateError(
      crudUpdate(world, CHILD, 'c-2', { version: 1, patch: { target: { id: 't-1' } } }),
    );
    assert.equal(onUpdate.code, 'validation');
  });

  it('passes updates that leave an archived ref unchanged', async () => {
    const world = await setupMutation([targetModel(), childModel()]);
    await crudCreate(world, TARGET, { id: 't-1', data: { email: 'a@example.test' } });
    await crudCreate(world, CHILD, { id: 'c-1', data: { target: { id: 't-1' }, note: 'v1' } });
    await crudRemove(world, TARGET, 't-1', { version: 1 });
    const { out } = await crudUpdate(world, CHILD, 'c-1', { version: 1, patch: { note: 'v2' } });
    assert.equal(out.status, 'committed');
    assert.deepEqual((await mustLoad(world.store, asModel(CHILD), 'c-1')).data, {
      target: { id: 't-1' },
      note: 'v2',
    });
  });

  it('archive re-validates hook-set refs against archived targets', async () => {
    const setter = hook('set-target', ['remove'], (candidate) => ({
      ...candidate,
      target: { id: 't-1' },
    }));
    const world = await setupMutation([
      targetModel(),
      modelDef(CHILD, {
        fields: { target: field(), note: field() },
        refs: [refDef('target', TARGET)],
        hooks: [setter],
      }),
    ]);
    await crudCreate(world, TARGET, { id: 't-1', data: { email: 'a@example.test' } });
    await crudCreate(world, CHILD, { id: 'c-1', data: { note: 'plain' } });
    await crudRemove(world, TARGET, 't-1', { version: 1 });
    const error = await captureStateError(crudRemove(world, CHILD, 'c-1', { version: 1 }));
    assert.equal(error.code, 'validation');
    assert.equal((await mustLoad(world.store, asModel(CHILD), 'c-1')).archivedAt, null);
  });

  it('archive with a hook-adjusted unique moves its claim', async () => {
    const recode = hook('recode', ['remove'], (candidate) => ({ ...candidate, code: 'b' }));
    const world = await setupMutation([
      modelDef('Acme.Code', {
        fields: { code: field({ required: true }) },
        uniqueKeys: ['code'],
        hooks: [recode],
      }),
    ]);
    await crudCreate(world, 'Acme.Code', { id: 'rec-1', data: { code: 'a' } });
    await crudRemove(world, 'Acme.Code', 'rec-1', { version: 1 });
    assert.deepEqual((await mustLoad(world.store, asModel('Acme.Code'), 'rec-1')).data, {
      code: 'b',
    });
    // The old claim moved with the hook: `a` is free, `b` is held.
    const freed = await crudCreate(world, 'Acme.Code', { id: 'rec-2', data: { code: 'a' } });
    assert.equal(freed.out.status, 'committed');
    const held = await captureStateError(
      crudCreate(world, 'Acme.Code', { id: 'rec-3', data: { code: 'b' } }),
    );
    assert.equal(held.code, 'conflict');
  });

  it('seed helper rows archive through the same path', async () => {
    // Guard: directly seeded rows (no prior claims) archive without a
    // disposal scan tripping on their own shape.
    const world = await setupMutation([targetModel()]);
    await seedStoredRow(world.store, asModel(TARGET), { id: 't-9', data: { email: 'z' } });
    const { out } = await crudRemove(world, TARGET, 't-9', { version: 1 });
    assert.equal(out.status, 'committed');
    assert.equal((await mustLoad(world.store, asModel(TARGET), 't-9')).archivedAt, FIXED_NOW);
  });
});
