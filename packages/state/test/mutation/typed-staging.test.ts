import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CanTypeId } from '@canlang/contracts';
import { StateError } from '../../src/errors.js';
import { runMutationWrites, type MutationWrite } from '../../src/mutation/pipeline.js';
import {
  FIXED_NOW, asId, asModel, asOperation, captureStateError, field, hook,
  modelDef, pipelineContext, seedStoredRow, setupMutation,
} from './fixtures.js';

const MODEL = asModel('Acme.Counter');
const CHILD = asModel('Acme.Child');
const typed = { ...field(), valueType: 'int' as const };
const context = () => pipelineContext({ operation: 'Acme.Counter.change' });
const create = (id: string, data: Record<string, unknown> = {}): MutationWrite => ({
  op: 'create', model: MODEL, id: asId(id), data,
});

// This injected converter tests State's checkpoint, not the Values codec.
function observingEncoder(seen: unknown[]) {
  return (type: CanTypeId, value: unknown): unknown => {
    assert.equal(type, 'int');
    seen.push(value);
    return typeof value === 'bigint' ? String(value) : value;
  };
}

describe('typed mutation staging checkpoint', () => {
  it('encodes checked bigint fields into JSON-safe rows and history without changing caller data', async () => {
    const world = await setupMutation([modelDef(MODEL, {
      fields: { count: typed, note: field() }, uniqueKeys: ['count'],
    })]);
    const seen: unknown[] = [];
    const data = { count: 9007199254740993n, note: 'unchanged' };
    const result = await runMutationWrites({
      table: world.table, store: world.store, context: context(),
      writes: [create('one', data)], encodeField: observingEncoder(seen),
    });
    assert.deepEqual(seen, [9007199254740993n]);
    const write = result.writes[0];
    assert.ok(write?.kind === 'insert');
    assert.deepEqual(write.row.data, { count: '9007199254740993', note: 'unchanged' });
    assert.deepEqual(result.history[0]?.after, write.row.data);
    assert.equal(result.uniqueClaims[0]?.keyValue, '9007199254740993');
    assert.equal(data.count, 9007199254740993n);
    assert.doesNotThrow(() => JSON.stringify(result));
    assert.equal(await world.store.load(MODEL, asId('one')), null);
  });

  it('keeps bigint refusal without a converter and on untyped fields', async () => {
    const world = await setupMutation([modelDef(MODEL, {
      fields: { count: typed, raw: field() },
    })]);
    const absent = await captureStateError(runMutationWrites({
      table: world.table, store: world.store, context: context(),
      writes: [create('one', { count: 1n })],
    }));
    assert.equal(absent.code, 'validation');
    assert.match(absent.message, /non-JSON/);
    const seen: unknown[] = [];
    const untyped = await captureStateError(runMutationWrites({
      table: world.table, store: world.store, context: context(),
      writes: [create('one', { raw: 1n })], encodeField: observingEncoder(seen),
    }));
    assert.equal(untyped.code, 'validation');
    assert.deepEqual(seen, []);
    const unsafe = await captureStateError(runMutationWrites({
      table: world.table, store: world.store, context: context(),
      writes: [create('one', { count: 1n })], encodeField: (_type, value) => value,
    }));
    assert.equal(unsafe.code, 'validation');
    assert.match(unsafe.message, /non-JSON/);
  });

  it('visits present candidate fields only, preserving update omission, undefined and explicit null', async () => {
    const world = await setupMutation([modelDef(MODEL, {
      fields: { count: typed, missing: typed, note: field() },
    })]);
    await seedStoredRow(world.store, MODEL, { id: 'one', data: { count: '4' } });
    for (const patch of [{}, { count: undefined }, { count: null }]) {
      const seen: unknown[] = [];
      const result = await runMutationWrites({
        table: world.table, store: world.store, context: context(),
        writes: [{ op: 'update', model: MODEL, id: asId('one'), data: patch }],
        encodeField: observingEncoder(seen),
      });
      const write = result.writes[0];
      assert.ok(write?.kind === 'update');
      const expected = patch.count === null ? null : '4';
      assert.deepEqual(seen, [expected]);
      assert.deepEqual(write.row.data, { count: expected });
      assert.equal(Object.hasOwn(write.row.data, 'missing'), false);
    }
    const seen: unknown[] = [];
    await runMutationWrites({
      table: world.table, store: world.store, context: context(),
      writes: [create('empty')], encodeField: observingEncoder(seen),
    });
    assert.deepEqual(seen, []);
  });

  it('runs creation defaults and hook adjustments before conversion', async () => {
    for (const fallback of ['3', 3n]) {
      const order: unknown[] = [];
      const world = await setupMutation([modelDef(CHILD, {
        fields: { count: field() },
      }), modelDef(MODEL, {
        fields: {
          count: { ...typed, default: fallback },
          inherited: { ...typed, default: { parentPath: 'count' } },
        },
        hooks: [hook('increment', ['create'], (candidate) => {
          order.push(['hook', candidate['count'], candidate['inherited']]);
          return { ...candidate, count: BigInt(candidate['count'] as string | bigint) + 1n };
        })],
      })]);
      await seedStoredRow(world.store, CHILD, { id: 'parent', data: { count: '5' } });
      const result = await runMutationWrites({
        table: world.table, store: world.store, context: context(),
        writes: [{ ...create('one'), parent: { model: CHILD, id: asId('parent') } }],
        encodeField: (type, value) => {
          order.push(['encode', type, value]);
          return String(value);
        },
      });
      assert.deepEqual(order, [
        ['hook', fallback, '5'], ['encode', 'int', 4n], ['encode', 'int', '5'],
        ['encode', 'int', fallback], ['encode', 'int', '5'],
      ]);
      const write = result.writes[0];
      assert.ok(write?.kind === 'insert');
      assert.deepEqual(write.row.data, { count: '4', inherited: '5' });
      assert.equal(result.resolvedDefaults['count'], '3');
      assert.doesNotThrow(() => JSON.stringify(result));
      assert.doesNotThrow(() => JSON.stringify({
        outcome: { status: 'committed', resolvedDefaults: result.resolvedDefaults },
      }));
    }
  });

  it('leaves storage untouched when encoding the original default refuses', async () => {
    const world = await setupMutation([modelDef(MODEL, {
      fields: { count: { ...typed, default: 3n } },
      hooks: [hook('adjust', ['create'], (candidate) => ({ ...candidate, count: 4n }))],
    })]);
    const revision = await world.store.readRevision();
    const seen: unknown[] = [];
    const refusal = new StateError('validation', 'default conversion refused');
    const error = await captureStateError(runMutationWrites({
      table: world.table, store: world.store, context: context(), writes: [create('one')],
      encodeField: (_type, value) => {
        seen.push(value);
        if (value === 3n) throw refusal;
        return String(value);
      },
    }));
    assert.equal(error, refusal);
    assert.deepEqual(seen, [4n, 3n]);
    assert.equal(await world.store.readRevision(), revision);
    assert.equal(await world.store.load(MODEL, asId('one')), null);
    assert.deepEqual(await world.store.historyFor(MODEL, asId('one')), []);
  });

  it('preserves resolved-default collision attribution across writes', async () => {
    const world = await setupMutation([modelDef(MODEL, {
      fields: { count: { ...typed, default: 3n } },
    })]);
    const seen: unknown[] = [];
    const revision = await world.store.readRevision();
    const error = await captureStateError(runMutationWrites({
      table: world.table, store: world.store, context: context(),
      writes: [create('one'), create('two')], encodeField: observingEncoder(seen),
    }));
    assert.equal(error.code, 'validation');
    assert.match(error.message, /Resolved-default collision/);
    assert.match(error.message, /create Acme.Counter one \(batch write #1\)/);
    assert.match(error.message, /create Acme.Counter two \(batch write #2\)/);
    assert.deepEqual(seen, [3n, 3n]);
    assert.equal(await world.store.readRevision(), revision);
    assert.equal(await world.store.load(MODEL, asId('one')), null);
    assert.equal(await world.store.load(MODEL, asId('two')), null);
  });

  it('rejects targets and caller field violations before conversion', async () => {
    const world = await setupMutation([modelDef(MODEL, {
      fields: {
        count: typed, secret: { ...typed, serverOnly: true },
        status: { ...field(), default: 'draft', machine: {
          initial: 'draft', states: ['draft', 'done'], transitions: [],
        } },
      },
    })]);
    await seedStoredRow(world.store, MODEL, {
      id: 'archived', archivedAt: FIXED_NOW, data: { status: 'draft' },
    });
    const cases: Array<[MutationWrite, string, RegExp]> = [
      [{ op: 'update', model: MODEL, id: asId('missing'), data: { count: 1n } }, 'not_found', /not found/],
      [{ op: 'update', model: MODEL, id: asId('archived'), data: { count: 1n } }, 'validation', /Archived/],
      [{ ...create('one', { count: 1n }), parent: { model: MODEL, id: asId('missing') } }, 'validation', /Parent record not found/],
      [create('one', { count: 1n, unknown: 2 }), 'validation', /Unknown field/],
      [create('one', { count: 1n, secret: 2n }), 'validation', /server-only/],
      [create('one', { count: 1n, status: 'done' }), 'validation', /Machine field/],
    ];
    const seen: unknown[] = [];
    for (const [write, code, message] of cases) {
      const error = await captureStateError(runMutationWrites({
        table: world.table, store: world.store, context: context(),
        writes: [write], gateArchivedTargets: true, encodeField: observingEncoder(seen),
      }));
      assert.equal(error.code, code);
      assert.match(error.message, message);
    }
    await assert.rejects(runMutationWrites({
      table: world.table, store: world.store, context: context(),
      writes: [{ ...create('one', { count: 1n }), model: asModel('Acme.Unknown') }],
      encodeField: observingEncoder(seen),
    }), /Unknown model in mutation write/);
    assert.deepEqual(seen, []);
  });

  it('checks required fields and hook failures before conversion', async () => {
    const seen: unknown[] = [];
    for (const hooks of [
      [],
      [hook('unknown', ['create'], (candidate) => ({ ...candidate, extra: true }))],
      [hook('erase', ['create'], (candidate) => ({ ...candidate, needed: null }))],
      [hook('reject', ['create'], () => { throw new StateError('rule_failed', 'hook refused'); })],
    ]) {
      const world = await setupMutation([modelDef(MODEL, {
        fields: { count: typed, needed: field({ required: true }) }, hooks,
      })]);
      const error = await captureStateError(runMutationWrites({
        table: world.table, store: world.store, context: context(),
        writes: [create('one', hooks.length === 0 ? { count: 1n } : { count: 1n, needed: 'yes' })],
        encodeField: observingEncoder(seen),
      }));
      assert.equal(error.code, hooks[0]?.name === 'reject' ? 'rule_failed' : 'validation');
    }
    assert.deepEqual(seen, []);
  });

  it('discards preceding writes, history, unique claims and hook schedules on conversion refusal', async () => {
    const world = await setupMutation([
      modelDef(MODEL, {
        fields: { count: typed }, uniqueKeys: ['count'],
        hooks: [hook('stage-child', ['create'], (candidate, ctx) => {
          ctx.stage({ op: 'create', model: CHILD, id: asId('child'), data: { count: -1n } });
          ctx.schedule({ key: 'deadline', at: FIXED_NOW + 1000, event: asOperation('Acme.Counter.deadline'), payload: {} });
          return candidate;
        })],
      }),
      modelDef(CHILD, { fields: { count: typed }, uniqueKeys: ['count'] }),
    ]);
    const revision = await world.store.readRevision();
    const seen: unknown[] = [];
    const refusal = new StateError('validation', 'conversion refused');
    const error = await captureStateError(runMutationWrites({
      table: world.table, store: world.store, context: context(), writes: [create('one', { count: 7n })],
      encodeField: (type, value) => {
        seen.push(value);
        if (value === -1n) throw refusal;
        return observingEncoder([])(type, value);
      },
    }));
    assert.equal(error, refusal);
    assert.deepEqual(seen, [7n, -1n]);
    assert.equal(await world.store.readRevision(), revision);
    for (const [model, id] of [[MODEL, 'one'], [CHILD, 'child']] as const) {
      assert.equal(await world.store.load(model, asId(id)), null);
      assert.deepEqual(await world.store.historyFor(model, asId(id)), []);
    }
    assert.equal(await world.store.scheduleGet('deadline'), null);
    assert.deepEqual(world.probe.outboxAll(), []);
    // Claim the same values with new records: refusal leaked no reservations.
    const recovered = await runMutationWrites({
      table: world.table, store: world.store, context: context(),
      writes: [create('replacement', { count: 7n })], encodeField: observingEncoder([]),
    });
    await world.store.commit({
      expectedRevision: revision, writes: recovered.writes, history: recovered.history,
      uniqueClaims: recovered.uniqueClaims, uniqueReleases: recovered.uniqueReleases,
      schedules: recovered.schedules, receipt: null, outbox: [],
    });
    assert.equal((await world.store.load(MODEL, asId('replacement')))?.data['count'], '7');
  });
});
