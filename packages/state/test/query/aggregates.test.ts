/**
 * Lane 03 S4 aggregate tests (worker B): count/sum/avg/min/max over the full
 * authorized set with the empty-domain and currency rules. Memory
 * StoragePort + local membership double.
 *
 * Note: stored money uses number minors (see `storedMoney`): plain-JSON
 * storage cannot round-trip the strict contract's bigint minor.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { queryAggregate } from '../../src/query/index.js';
import type { AggregateSpec } from '@canlang/contracts';
import { createMemoryStorage } from '../../src/storage/memory.js';
import { captureStateError } from '../invocation/fixtures.js';
import {
  asModel,
  aggregateInput,
  grant,
  modelPolicy,
  ownerAggregateInput,
  policyTable,
  seedRows,
  seedStandardTeam,
  storedMoney,
  type EngineCallOpts,
  type PolicyTable,
} from './fixtures.js';

const MODEL = asModel('Acme.Ledger');

async function setup(policy: PolicyTable) {
  const store = createMemoryStorage();
  const std = await seedStandardTeam();
  const call: Omit<EngineCallOpts, 'caller' | 'where' | 'order' | 'limit' | 'archived'> = {
    store,
    memberships: std.memberships,
    policy,
    model: MODEL,
    scope: std.team,
  };
  return { store, std, call };
}

type Setup = Awaited<ReturnType<typeof setup>>;

function summarize(s: Setup, spec: AggregateSpec, extra: Partial<EngineCallOpts> = {}) {
  return queryAggregate(
    aggregateInput({ ...s.call, caller: s.std.alice, spec, ...extra }),
  );
}

const FULL_POLICY = policyTable(
  modelPolicy(MODEL, { grants: [grant('members', ['amount', 'category', 'price'])] }),
);

describe('aggregates', () => {
  it('counts rows, including 0 on an empty set', async () => {
    const s = await setup(FULL_POLICY);
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { amount: 10 } },
      { id: 'rec-2', data: { amount: 20 } },
    ]);
    const some = await summarize(s, { op: 'count' });
    assert.deepEqual(some.result, { op: 'count', value: 2 });

    const none = await summarize(s, { op: 'count' }, { where: { op: 'eq', field: 'id', value: 'rec-x' } });
    assert.deepEqual(none.result, { op: 'count', value: 0 });
  });

  it('rejects count with a field', async () => {
    const s = await setup(FULL_POLICY);
    await seedRows(s.store, MODEL, [{ id: 'rec-1', data: { amount: 10 } }]);
    const failure = await captureStateError(summarize(s, { op: 'count', field: 'amount' }));
    assert.equal(failure.code, 'validation');
  });

  it('sums numbers, and an empty usable set sums to 0', async () => {
    const s = await setup(FULL_POLICY);
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { amount: 10 } },
      { id: 'rec-2', data: { amount: 20 } },
      { id: 'rec-3', data: { amount: 30 } },
    ]);
    const total = await summarize(s, { op: 'sum', field: 'amount' });
    assert.deepEqual(total.result, { op: 'sum', value: 60 });

    const empty = await summarize(
      s,
      { op: 'sum', field: 'amount' },
      { where: { op: 'eq', field: 'id', value: 'rec-x' } },
    );
    assert.deepEqual(empty.result, { op: 'sum', value: 0 });
  });

  it('skips null and missing values', async () => {
    const s = await setup(FULL_POLICY);
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { amount: 10 } },
      { id: 'rec-2', data: { amount: null } },
      { id: 'rec-3', data: {} },
      { id: 'rec-4', data: { amount: 20 } },
    ]);
    const total = await summarize(s, { op: 'sum', field: 'amount' });
    assert.deepEqual(total.result, { op: 'sum', value: 30 });
    const mean = await summarize(s, { op: 'avg', field: 'amount' });
    assert.deepEqual(mean.result, { op: 'avg', value: 15 });
    const least = await summarize(s, { op: 'min', field: 'amount' });
    assert.deepEqual(least.result, { op: 'min', value: 10 });
    const most = await summarize(s, { op: 'max', field: 'amount' });
    assert.deepEqual(most.result, { op: 'max', value: 20 });
    const count = await summarize(s, { op: 'count' });
    assert.deepEqual(count.result, { op: 'count', value: 4 });
  });

  it('sums same-currency money', async () => {
    const s = await setup(FULL_POLICY);
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { price: storedMoney(100, 'USD') } },
      { id: 'rec-2', data: { price: storedMoney(200, 'USD') } },
      { id: 'rec-3', data: { price: storedMoney(150, 'USD') } },
    ]);
    const total = await summarize(s, { op: 'sum', field: 'price' });
    assert.deepEqual(total.result, {
      op: 'sum',
      value: { kind: 'money', minor: 450, currency: 'USD' },
    });
  });

  it('sums an empty money set to 0 (domain unknowable without values)', async () => {
    const s = await setup(FULL_POLICY);
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { price: null } },
      { id: 'rec-2', data: {} },
    ]);
    const total = await summarize(s, { op: 'sum', field: 'price' });
    assert.deepEqual(total.result, { op: 'sum', value: 0 });
  });

  it('rejects mixed-currency money sums', async () => {
    const s = await setup(FULL_POLICY);
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { price: storedMoney(100, 'USD') } },
      { id: 'rec-2', data: { price: storedMoney(200, 'EUR') } },
    ]);
    const failure = await captureStateError(summarize(s, { op: 'sum', field: 'price' }));
    assert.equal(failure.code, 'validation');
  });

  it('rejects money sums with no usable currency', async () => {
    const s = await setup(FULL_POLICY);
    await seedRows(s.store, MODEL, [{ id: 'rec-1', data: { price: { kind: 'money', minor: 5 } } }]);
    const failure = await captureStateError(summarize(s, { op: 'sum', field: 'price' }));
    assert.equal(failure.code, 'validation');
  });

  it('rejects mixed number-and-money sums', async () => {
    const s = await setup(FULL_POLICY);
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { price: 5 } },
      { id: 'rec-2', data: { price: storedMoney(100, 'USD') } },
    ]);
    const failure = await captureStateError(summarize(s, { op: 'sum', field: 'price' }));
    assert.equal(failure.code, 'validation');
  });

  it('averages numbers but rejects empty, money, and non-numeric sets', async () => {
    const s = await setup(FULL_POLICY);
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { amount: 10 } },
      { id: 'rec-2', data: { amount: 20 } },
      { id: 'rec-3', data: { amount: 30 } },
    ]);
    const mean = await summarize(s, { op: 'avg', field: 'amount' });
    assert.deepEqual(mean.result, { op: 'avg', value: 20 });

    const empty = await captureStateError(
      summarize(s, { op: 'avg', field: 'amount' }, { where: { op: 'eq', field: 'id', value: 'rec-x' } }),
    );
    assert.equal(empty.code, 'validation');

    const t = await setup(FULL_POLICY);
    await seedRows(t.store, MODEL, [
      { id: 'rec-1', data: { price: storedMoney(100, 'USD') } },
      { id: 'rec-2', data: { price: storedMoney(200, 'USD') } },
    ]);
    const moneyAvg = await captureStateError(summarize(t, { op: 'avg', field: 'price' }));
    assert.equal(moneyAvg.code, 'validation');

    const u = await setup(FULL_POLICY);
    await seedRows(u.store, MODEL, [{ id: 'rec-1', data: { category: 'x' } }]);
    const textAvg = await captureStateError(summarize(u, { op: 'avg', field: 'category' }));
    assert.equal(textAvg.code, 'validation');
  });

  it('takes min/max of numbers and of strings', async () => {
    const s = await setup(FULL_POLICY);
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { amount: 20, category: 'b' } },
      { id: 'rec-2', data: { amount: 10, category: 'c' } },
      { id: 'rec-3', data: { amount: 30, category: 'a' } },
    ]);
    assert.deepEqual((await summarize(s, { op: 'min', field: 'amount' })).result, { op: 'min', value: 10 });
    assert.deepEqual((await summarize(s, { op: 'max', field: 'amount' })).result, { op: 'max', value: 30 });
    assert.deepEqual((await summarize(s, { op: 'min', field: 'category' })).result, { op: 'min', value: 'a' });
    assert.deepEqual((await summarize(s, { op: 'max', field: 'category' })).result, { op: 'max', value: 'c' });
  });

  it('takes min/max of same-currency money by minor units', async () => {
    const s = await setup(FULL_POLICY);
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { price: storedMoney(200, 'USD') } },
      { id: 'rec-2', data: { price: storedMoney(100, 'USD') } },
      { id: 'rec-3', data: { price: storedMoney(150, 'USD') } },
    ]);
    assert.deepEqual((await summarize(s, { op: 'min', field: 'price' })).result, {
      op: 'min',
      value: storedMoney(100, 'USD'),
    });
    assert.deepEqual((await summarize(s, { op: 'max', field: 'price' })).result, {
      op: 'max',
      value: storedMoney(200, 'USD'),
    });

    const t = await setup(FULL_POLICY);
    await seedRows(t.store, MODEL, [
      { id: 'rec-1', data: { price: storedMoney(100, 'USD') } },
      { id: 'rec-2', data: { price: storedMoney(50, 'EUR') } },
    ]);
    for (const op of ['min', 'max'] as const) {
      const mixed = await captureStateError(summarize(t, { op, field: 'price' }));
      assert.equal(mixed.code, 'validation');
    }
  });

  it('rejects min/max over empty and mixed-type sets', async () => {
    const s = await setup(FULL_POLICY);
    await seedRows(s.store, MODEL, [{ id: 'rec-1', data: { amount: 10 } }]);
    for (const op of ['min', 'max'] as const) {
      const empty = await captureStateError(
        summarize(s, { op, field: 'amount' }, { where: { op: 'eq', field: 'id', value: 'rec-x' } }),
      );
      assert.equal(empty.code, 'validation');
    }

    const t = await setup(FULL_POLICY);
    await seedRows(t.store, MODEL, [
      { id: 'rec-1', data: { amount: 10 } },
      { id: 'rec-2', data: { amount: 'high' } },
    ]);
    for (const op of ['min', 'max'] as const) {
      const mixed = await captureStateError(summarize(t, { op, field: 'amount' }));
      assert.equal(mixed.code, 'validation');
    }
  });

  it('rejects aggregates over ungranted fields', async () => {
    const narrow = policyTable(modelPolicy(MODEL, { grants: [grant('members', ['amount'])] }));
    const s = await setup(narrow);
    await seedRows(s.store, MODEL, [{ id: 'rec-1', data: { amount: 10, price: storedMoney(100, 'USD') } }]);
    const failure = await captureStateError(summarize(s, { op: 'sum', field: 'price' }));
    assert.equal(failure.code, 'validation');
  });

  it('still enforces the overflow limit for aggregates', async () => {
    const s = await setup(FULL_POLICY);
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { amount: 10 } },
      { id: 'rec-2', data: { amount: 20 } },
      { id: 'rec-3', data: { amount: 30 } },
    ]);
    const failure = await captureStateError(summarize(s, { op: 'count' }, { limit: 2 }));
    assert.equal(failure.code, 'validation');
  });

  it('aggregates over the full authorized set with no limit', async () => {
    const s = await setup(FULL_POLICY);
    const rows = [];
    let expected = 0;
    for (let n = 1; n <= 25; n += 1) {
      rows.push({ id: `rec-${n}`, data: { amount: n } });
      expected += n;
    }
    await seedRows(s.store, MODEL, rows);
    const count = await summarize(s, { op: 'count' });
    assert.deepEqual(count.result, { op: 'count', value: 25 });
    const total = await summarize(s, { op: 'sum', field: 'amount' });
    assert.deepEqual(total.result, { op: 'sum', value: expected });
  });

  it('aggregates skip values ungranted for each row (no cross-grant leak)', async () => {
    const narrow = policyTable(
      modelPolicy(MODEL, {
        grants: [
          grant('members', ['salary'], { op: 'eq', field: 'kind', value: 'a' }),
          grant('members', ['title']),
        ],
      }),
    );
    const s = await setup(narrow);
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { kind: 'a', salary: 100, title: 'x' } },
      { id: 'rec-2', data: { kind: 'b', salary: 200, title: 'y' } },
    ]);
    const total = await summarize(s, { op: 'sum', field: 'salary' });
    assert.deepEqual(total.result, { op: 'sum', value: 100 });
  });

  it('owner aggregates bypass grant coverage, including secrets', async () => {
    const policy = policyTable(
      modelPolicy(MODEL, {
        secretFields: ['salary'],
        grants: [grant('members', ['title'])],
      }),
    );
    const s = await setup(policy);
    await seedRows(s.store, MODEL, [
      { id: 'rec-1', data: { salary: 100, title: 'x' } },
      { id: 'rec-2', data: { salary: 200, title: 'y' } },
    ]);
    const total = await queryAggregate(
      ownerAggregateInput({ ...s.call, caller: s.std.owner, spec: { op: 'sum', field: 'salary' } }),
    );
    assert.deepEqual(total.result, { op: 'sum', value: 300 });
  });
});
