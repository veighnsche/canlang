import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanTypeId } from '@canlang/contracts';
import { StateError } from '../errors.js';
import { validateGivenFields, type GivenFieldValidationRule } from '../effects/staging.js';
import { runMutationWrites } from './pipeline.js';
import { buildModelTable } from './models.js';
import { field, modelDef, hook, setupMutation, crudCreate, crudUpdate, pipelineContext, asModel, asId } from '../../test/mutation/fixtures.js';

const MODEL = 'Lab.Entry';
const utf8 = (value: string): boolean => new TextEncoder().encode(value).byteLength <= 128;
const barcode = (value: string): boolean => {
  if (value.length !== 13 || !/^[0-9]{13}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += (value.charCodeAt(i) - 48) * (i % 2 === 0 ? 1 : 3);
  return (10 - sum % 10) % 10 === value.charCodeAt(12) - 48;
};
const requiredText = { ...field({ required: true }), valueType: 'text' as CanTypeId, trim: true, min: 1, max: 100 };
const rules: GivenFieldValidationRule[] = [
  { rule: 'budget', field: 'code', evaluate: utf8 },
  { rule: 'ean', field: 'barcode', evaluate: barcode },
];
const definition = () => ({
  ...modelDef(MODEL, { fields: { code: requiredText, barcode: { ...requiredText, trim: false, min: 13, max: 13 } } }),
  givenFieldValidations: rules,
  givenUniqueKeys: [{ rule: 'key', field: 'code', evaluate: (value: string) => value.normalize('NFKC').replace(/[A-Z]/g, c => c.toLowerCase()) }],
});
const invalid = (error: unknown): boolean => error instanceof StateError && error.code === 'validation';

test('pure field checks enforce UTF8 and EAN boundaries and exact boolean results', async () => {
  for (const value of ['4006381333931', '9780306406157']) await validateGivenFields([rules[1]!], { barcode: value });
  for (const value of ['4006381333932', '４006381333931', '4006381333931\n']) {
    await assert.rejects(validateGivenFields([rules[1]!], { barcode: value }), invalid);
  }
  await validateGivenFields([rules[0]!], { code: 'é'.repeat(64) });
  await assert.rejects(validateGivenFields([rules[0]!], { code: 'é'.repeat(65) }), invalid);
  for (const evaluate of [() => false, () => 1 as unknown as boolean, () => { throw new Error('private checker detail'); }]) {
    await assert.rejects(validateGivenFields([{ rule: 'bad', field: 'code', evaluate }], { code: 'x' }),
      error => invalid(error) && !(error as Error).message.includes('private checker detail'));
  }
  let called = false;
  await assert.rejects(validateGivenFields([{ rule: 'bad', field: 'code', evaluate: () => { called = true; return true; } }], { code: null }), invalid);
  assert.equal(called, false);
});

test('CRUD validates normalized final values, preserves rows/history/claims on failure and replays', async () => {
  const world = await setupMutation([definition()]);
  const created = await crudCreate(world, MODEL, { id: 'one', data: { code: '  Ａlice  ', barcode: '4006381333931' } });
  assert.equal(created.out.status, 'committed');
  assert.equal((await world.store.load(asModel(MODEL), asId('one')))?.data['code'], 'Ａlice');
  const before = await world.store.load(asModel(MODEL), asId('one'));
  const history = [...world.probe.historyFor(asModel(MODEL), asId('one'))];
  await assert.rejects(crudUpdate(world, MODEL, 'one', { version: 1, patch: { code: 'Bob', barcode: '4006381333932' } }), invalid);
  assert.deepEqual(await world.store.load(asModel(MODEL), asId('one')), before);
  assert.deepEqual(world.probe.historyFor(asModel(MODEL), asId('one')), history);
  assert.equal((await crudCreate(world, MODEL, { id: 'two', data: { code: 'Bob', barcode: '9780306406157' } })).out.status, 'committed', 'failed update did not claim Bob');
  await assert.rejects(crudCreate(world, MODEL, { id: 'collision', data: { code: 'Alice', barcode: '9780306406157' } }),
    error => error instanceof StateError && error.code === 'conflict', 'old canonical claim is retained');
  const replay = await crudCreate(world, MODEL, { id: 'one', operationId: created.operationId, data: { code: '  Ａlice  ', barcode: '4006381333931' } });
  assert.equal(replay.out.status, 'replayed');
});

test('source batches reject late invalid writes without committing earlier values or history', async () => {
  const world = await setupMutation([definition()]);
  await crudCreate(world, MODEL, { id: 'one', data: { code: 'Alice', barcode: '4006381333931' } });
  const before = await world.store.load(asModel(MODEL), asId('one'));
  const history = [...world.probe.historyFor(asModel(MODEL), asId('one'))];
  await assert.rejects(runMutationWrites({ table: world.table, store: world.store, context: pipelineContext({ operation: 'Lab.change' }), writes: [
    { op: 'update', model: asModel(MODEL), id: asId('one'), data: { code: 'Carol' } },
    { op: 'update', model: asModel(MODEL), id: asId('one'), data: { barcode: '4006381333932' } },
  ] }), invalid);
  assert.deepEqual(await world.store.load(asModel(MODEL), asId('one')), before);
  assert.deepEqual(world.probe.historyFor(asModel(MODEL), asId('one')), history);
  assert.equal((await crudCreate(world, MODEL, { id: 'two', data: { code: 'Carol', barcode: '9780306406157' } })).out.status, 'committed');
});

test('trusted hook adjustments precede field checks; staged writes use the same checks', async () => {
  const seen: string[] = [];
  const def = definition();
  const world = await setupMutation([{ ...def,
    hooks: [hook('repair', ['create', 'update'], candidate => ({ ...candidate, barcode: candidate['code'] === 'broken' ? '4006381333932' : '4006381333931' }))],
    givenFieldValidations: [rules[0]!, { ...rules[1]!, evaluate: value => { seen.push(value); return barcode(value); } }],
  }]);
  assert.equal((await crudCreate(world, MODEL, { id: 'fixed', data: { code: 'valid', barcode: '4006381333932' } })).out.status, 'committed');
  assert.deepEqual(seen, ['4006381333931'], 'only the normalized hook-adjusted final value is checked');
  const before = await world.store.load(asModel(MODEL), asId('fixed'));
  await assert.rejects(crudUpdate(world, MODEL, 'fixed', { version: 1, patch: { code: 'broken' } }), invalid);
  assert.deepEqual(seen, ['4006381333931', '4006381333932']);
  assert.deepEqual(await world.store.load(asModel(MODEL), asId('fixed')), before);
  assert.throws(() => buildModelTable([{ ...def, fields: { ...def.fields, code: { ...requiredText, valueType: 'text?' as CanTypeId, nullable: true } } }]), /nonnullable native text/);
});
