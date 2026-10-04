/**
 * Lane 03 S5 history tests (test worker): the pipeline stages one audit entry
 * per write (actor/kind attribution, before/after null rules, versions, write
 * order), and one end-to-end invoke proves the staged history commits.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runMutationWrites } from '../../src/mutation/index.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  crudCreate,
  field,
  freshOperationId,
  modelDef,
  pipelineContext,
  seedStoredRow,
  setupMutation,
} from './fixtures.js';

const NOTE = 'Acme.Note';
const EPHEM = 'Acme.Ephem';

function noteModel() {
  return modelDef(NOTE, { fields: { title: field({ required: true }) } });
}

function ephemModel() {
  return modelDef(EPHEM, { fields: { title: field() }, deleteMode: 'remove' });
}

describe('mutation history', () => {
  it('stages create history with actor attribution variants', async () => {
    const cases = [
      { label: 'user', ctx: { actor: 'user-alice' as const }, actor: 'user-alice' },
      { label: 'test', ctx: { kind: 'test' as const, actor: null }, actor: 'test' },
      {
        label: 'trusted',
        ctx: { kind: 'trusted' as const, actor: null, trustedSource: 'etl' },
        actor: 'etl',
      },
    ];
    for (const { label, ctx, actor } of cases) {
      const world = await setupMutation([noteModel()]);
      const operationId = freshOperationId();
      const result = await runMutationWrites({
        table: world.table,
        writes: [{ op: 'create', model: asModel(NOTE), id: asId('n-1'), data: { title: 'hi' } }],
        context: pipelineContext({ operation: `${NOTE}.create`, operationId, ...ctx }),
        store: world.store,
      });
      assert.equal(result.history.length, 1, label);
      assert.deepEqual(result.history[0], {
        model: NOTE,
        recordId: 'n-1',
        version: 1,
        operation: `${NOTE}.create`,
        operationId,
        actor,
        at: FIXED_NOW,
        change: 'create',
        before: null,
        after: { title: 'hi' },
      });
    }
  });

  it('stages update history with before/after and the bumped version', async () => {
    const world = await setupMutation([noteModel()]);
    await seedStoredRow(world.store, asModel(NOTE), { id: 'n-1', data: { title: 'old' } });
    const result = await runMutationWrites({
      table: world.table,
      writes: [{ op: 'update', model: asModel(NOTE), id: asId('n-1'), data: { title: 'new' } }],
      context: pipelineContext({ operation: `${NOTE}.update` }),
      store: world.store,
    });
    assert.equal(result.history.length, 1);
    const entry = result.history[0];
    assert.equal(entry?.change, 'update');
    assert.equal(entry?.version, 2);
    assert.deepEqual(entry?.before, { title: 'old' });
    assert.deepEqual(entry?.after, { title: 'new' });
  });

  it('stages archive history with the bumped version', async () => {
    const world = await setupMutation([noteModel()]);
    await seedStoredRow(world.store, asModel(NOTE), { id: 'n-1', data: { title: 't' } });
    const result = await runMutationWrites({
      table: world.table,
      writes: [{ op: 'remove', model: asModel(NOTE), id: asId('n-1') }],
      context: pipelineContext({ operation: `${NOTE}.delete` }),
      store: world.store,
    });
    assert.equal(result.history.length, 1);
    const entry = result.history[0];
    assert.equal(entry?.change, 'archive');
    assert.equal(entry?.version, 2);
    assert.deepEqual(entry?.before, { title: 't' });
    assert.deepEqual(entry?.after, { title: 't' });
  });

  it('stages remove history at the deleted version with after null', async () => {
    const world = await setupMutation([ephemModel()]);
    await seedStoredRow(world.store, asModel(EPHEM), {
      id: 'e-1',
      version: 3,
      data: { title: 't' },
    });
    const result = await runMutationWrites({
      table: world.table,
      writes: [{ op: 'remove', model: asModel(EPHEM), id: asId('e-1') }],
      context: pipelineContext({ operation: `${EPHEM}.delete` }),
      store: world.store,
    });
    assert.equal(result.history.length, 1);
    const entry = result.history[0];
    assert.equal(entry?.change, 'remove');
    assert.equal(entry?.version, 3);
    assert.deepEqual(entry?.before, { title: 't' });
    assert.equal(entry?.after, null);
  });

  it('stages one entry per write in write order', async () => {
    const world = await setupMutation([noteModel()]);
    const result = await runMutationWrites({
      table: world.table,
      writes: [
        { op: 'create', model: asModel(NOTE), id: asId('n-1'), data: { title: 'first' } },
        { op: 'create', model: asModel(NOTE), id: asId('n-2'), data: { title: 'second' } },
      ],
      context: pipelineContext({ operation: `${NOTE}.create` }),
      store: world.store,
    });
    assert.deepEqual(
      result.history.map((entry) => [entry.recordId, entry.change, entry.after]),
      [
        ['n-1', 'create', { title: 'first' }],
        ['n-2', 'create', { title: 'second' }],
      ],
    );
  });

  it('commits staged history end-to-end through invoke', async () => {
    const world = await setupMutation([noteModel()]);
    const { out, operationId } = await crudCreate(world, NOTE, {
      id: 'n-1',
      data: { title: 'hi' },
    });
    assert.equal(out.status, 'committed');
    // The fenced commit persisted exactly the staged entry.
    assert.deepEqual(world.probe.historyFor(asModel(NOTE), asId('n-1')), [
      {
        model: NOTE,
        recordId: 'n-1',
        version: 1,
        operation: `${NOTE}.create`,
        operationId,
        actor: world.alice.user.user_id,
        at: FIXED_NOW,
        change: 'create',
        before: null,
        after: { title: 'hi' },
      },
    ]);
  });
});
