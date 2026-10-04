/**
 * Lane 03 S5 invariant tests (test worker): invariants observe the final
 * provisional state after all writes, run in written order with the first
 * throw winning, and violations commit nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StateError } from '../../src/errors.js';
import { runMutationWrites } from '../../src/mutation/index.js';
import type { InterimInvariantView } from '../../src/mutation/index.js';
import { makeBatch } from '../invocation/fixtures.js';
import {
  asId,
  asModel,
  captureStateError,
  field,
  invariant,
  modelDef,
  pipelineContext,
  seedStoredRow,
  setupMutation,
} from './fixtures.js';

const POT = 'Acme.Pot';

/** Sum of `amount` over the two pots, via the invariant view. */
function potTotal(view: InterimInvariantView): number {
  let total = 0;
  for (const id of ['pot-a', 'pot-b']) {
    const row = view.get(asModel(POT), asId(id));
    total += Number(row?.data['amount'] ?? 0);
  }
  return total;
}

function cappedModel() {
  return modelDef(POT, {
    fields: { amount: field({ required: true }) },
    invariants: [
      invariant('cap', (view) => {
        if (potTotal(view) > 100) {
          throw new StateError('rule_failed', 'Combined pots exceed 100.');
        }
      }),
    ],
  });
}

describe('mutation invariants', () => {
  it('sees the final state; violations commit nothing', async () => {
    const world = await setupMutation([cappedModel()]);
    await seedStoredRow(world.store, asModel(POT), { id: 'pot-a', data: { amount: 0 } });
    await seedStoredRow(world.store, asModel(POT), { id: 'pot-b', data: { amount: 0 } });
    // A first write within the cap succeeds and commits.
    const passing = await runMutationWrites({
      table: world.table,
      writes: [{ op: 'update', model: asModel(POT), id: asId('pot-a'), data: { amount: 60 } }],
      context: pipelineContext({ operation: `${POT}.update` }),
      store: world.store,
    });
    assert.equal(passing.writes.length, 1);
    const at = await world.store.readRevision();
    await world.store.commit(
      makeBatch(at as number, {
        writes: passing.writes,
        history: passing.history,
        uniqueClaims: passing.uniqueClaims,
        uniqueReleases: passing.uniqueReleases,
      }),
    );
    // The second write would breach the cap: the pipeline rejects and the
    // store keeps exactly the previously committed state.
    const before = await world.store.readRevision();
    const error = await captureStateError(
      runMutationWrites({
        table: world.table,
        writes: [{ op: 'update', model: asModel(POT), id: asId('pot-b'), data: { amount: 60 } }],
        context: pipelineContext({ operation: `${POT}.update` }),
        store: world.store,
      }),
    );
    assert.equal(error.code, 'rule_failed');
    assert.equal(error.message, 'Combined pots exceed 100.');
    assert.equal(await world.store.readRevision(), before);
    assert.equal((await world.store.load(asModel(POT), asId('pot-a')))?.data['amount'], 60);
    assert.equal((await world.store.load(asModel(POT), asId('pot-b')))?.data['amount'], 0);
  });

  it('runs in written order; the first throw wins', async () => {
    const seen: string[] = [];
    const world = await setupMutation([
      modelDef(POT, {
        fields: { amount: field() },
        invariants: [
          invariant('first', () => {
            seen.push('first');
            throw new StateError('rule_failed', 'first veto');
          }),
          invariant('second', () => {
            seen.push('second');
            throw new StateError('rule_failed', 'second veto');
          }),
        ],
      }),
    ]);
    const error = await captureStateError(
      runMutationWrites({
        table: world.table,
        writes: [{ op: 'create', model: asModel(POT), id: asId('pot-a'), data: { amount: 1 } }],
        context: pipelineContext({ operation: `${POT}.create` }),
        store: world.store,
      }),
    );
    assert.equal(error.code, 'rule_failed');
    assert.equal(error.message, 'first veto');
    assert.deepEqual(seen, ['first']);
  });

  it('sees the combined provisional state, not each write alone', async () => {
    const world = await setupMutation([cappedModel()]);
    await seedStoredRow(world.store, asModel(POT), { id: 'pot-a', data: { amount: 40 } });
    await seedStoredRow(world.store, asModel(POT), { id: 'pot-b', data: { amount: 40 } });
    // Either write alone stays within the cap...
    for (const id of ['pot-a', 'pot-b']) {
      const solo = await runMutationWrites({
        table: world.table,
        writes: [{ op: 'update', model: asModel(POT), id: asId(id), data: { amount: 60 } }],
        context: pipelineContext({ operation: `${POT}.update` }),
        store: world.store,
      });
      assert.equal(solo.writes.length, 1);
    }
    // ...but together they breach it, and nothing is committed.
    const error = await captureStateError(
      runMutationWrites({
        table: world.table,
        writes: [
          { op: 'update', model: asModel(POT), id: asId('pot-a'), data: { amount: 60 } },
          { op: 'update', model: asModel(POT), id: asId('pot-b'), data: { amount: 60 } },
        ],
        context: pipelineContext({ operation: `${POT}.update` }),
        store: world.store,
      }),
    );
    assert.equal(error.code, 'rule_failed');
    assert.equal((await world.store.load(asModel(POT), asId('pot-a')))?.data['amount'], 40);
    assert.equal((await world.store.load(asModel(POT), asId('pot-b')))?.data['amount'], 40);
  });
});
