import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { DomainWrite, StoredRow } from '@canlang/contracts';
import type { SystemCommandContext } from '@canlang/state';
import { WORK_HANDLER_OCCURRENCE_MODEL, handlerOccurrencePendingQuery, handlerOccurrenceRowId,
  readHandlerOccurrenceRow, stageHandlerOccurrence, stageHandlerOccurrenceTerminal,
  stageRetainedHandlerOccurrence } from '../src/kernel/handler-occurrence.js';
import type { HandlerOccurrenceSelector } from '../src/kernel/handler-occurrence.js';
import { WORK_OCCURRENCE_MODEL, KernelTableError, newOccurrenceRow } from '../src/kernel/tables.js';

const scope = { app: 'app', owner: 'team-1', ownerPackage: 'demo' };
const source = () => ({ occurrenceId: 'source/a', event: 'demo.changed', payload: { nested: { version: 1 } }, scope: { ...scope } });
const selector = (handler = 'demo.handler'): HandlerOccurrenceSelector =>
  ({ sourceOccurrence: 'source/a', event: 'demo.changed', handler, scope: { ...scope } });
const receipt = { status: 'completed' as const, result: { done: true }, code: null, message: null, recordedAtMs: 100 };

function readers(rows = new Map<string, StoredRow>()): SystemCommandContext {
  return { actor: 'owner-host', now: 100, operation: 'checked-intake',
    load: async (model, id) => rows.get(`${model}\0${id}`) ?? null,
    query: async () => { throw new Error('no scan needed for one route'); } };
}

function retain(rows: Map<string, StoredRow>, writes: ReadonlyArray<DomainWrite> = []): void {
  for (const write of writes) {
    if (write.kind !== 'insert' && write.kind !== 'update') throw new Error('unexpected effect');
    rows.set(`${write.model}\0${write.row.id}`, write.row);
  }
}

it('captures exact checked source before await and gives each canonical sibling an independent stable route', async () => {
  const supplied = source();
  const ctx = readers();
  const stage = stageHandlerOccurrence({ source: supplied, handler: 'demo.handler' }, {
    ...ctx, load: async (model, id) => {
      supplied.payload.nested.version = 99;
      supplied.scope.owner = 'other';
      supplied.event = 'other.event';
      return ctx.load(model, id);
    },
  });
  const staged = await stage;
  assert.equal(staged.status, 'ready');
  if (staged.status !== 'ready') return;
  assert.equal(staged.row.version, 1);
  assert.equal(staged.row.createdBy, 'owner-host');
  assert.equal(staged.row.updated, 100);
  assert.equal(staged.occurrence.scopeOwner, 'team-1');
  assert.equal(staged.occurrence.event, 'demo.changed');
  assert.deepEqual(staged.occurrence.payload, { nested: { version: 1 } });
  assert.ok(Object.isFrozen(staged.occurrence.payload['nested']));
  const sibling = await stageHandlerOccurrence({ source: source(), handler: 'demo.sibling' }, ctx);
  assert.equal(sibling.status, 'ready');
  if (sibling.status === 'ready') assert.notEqual(sibling.row.id, staged.row.id);
  assert.equal(handlerOccurrenceRowId('source/a', 'demo.handler'), 'handler/v1/source%2Fa/demo.handler');
  assert.notEqual(handlerOccurrenceRowId('a/b', 'c'), handlerOccurrenceRowId('a', 'b/c'));
  assert.equal(staged.effects.writes?.[0]?.model, WORK_HANDLER_OCCURRENCE_MODEL);
});

it('replays only matching route facts and refuses payload/event/scope collisions without effects', async () => {
  const rows = new Map<string, StoredRow>();
  const ctx = readers(rows);
  const admitted = await stageHandlerOccurrence({ source: source(), handler: 'demo.handler' }, ctx);
  if (admitted.status !== 'ready') throw new Error('missing fixture');
  retain(rows, admitted.effects.writes);
  const replay = await stageHandlerOccurrence({ source: source(), handler: 'demo.handler' }, ctx);
  assert.equal(replay.status, 'replayed');
  if (replay.status === 'replayed') assert.deepEqual(replay.effects, {});
  for (const changed of [
    { ...source(), payload: { nested: { version: 2 } } },
    { ...source(), event: 'other.event' },
    { ...source(), scope: { ...scope, owner: 'other' } },
  ]) {
    assert.deepEqual(await stageHandlerOccurrence({ source: changed, handler: 'demo.handler' }, ctx),
      { status: 'refused', reason: 'mismatched' });
  }
  assert.equal((await stageRetainedHandlerOccurrence(selector(), ctx)).status, 'ready');
  assert.deepEqual(await stageRetainedHandlerOccurrence({ ...selector(), event: 'other' }, ctx),
    { status: 'refused', reason: 'mismatched' });
});

it('joins terminal update and existing receipt, fences stale versions, and leaves a refused sibling pending', async () => {
  const rows = new Map<string, StoredRow>();
  const ctx = readers(rows);
  for (const handler of ['demo.handler', 'demo.sibling']) {
    const staged = await stageHandlerOccurrence({ source: source(), handler }, ctx);
    if (staged.status !== 'ready') throw new Error('missing fixture');
    retain(rows, staged.effects.writes);
  }
  assert.deepEqual(await stageHandlerOccurrenceTerminal({ ...selector(), expectedVersion: 2, receipt }, ctx),
    { status: 'refused', reason: 'stale' });
  const failed = { ...receipt, status: 'failed' as const, code: 'authored-refusal', message: 'no' };
  const terminal = await stageHandlerOccurrenceTerminal({ ...selector(), expectedVersion: 1, receipt: failed }, ctx);
  assert.equal(terminal.status, 'ready');
  if (terminal.status !== 'ready') return;
  const update = terminal.effects.writes?.[0];
  assert.equal(update?.kind, 'update');
  if (update?.kind === 'update') {
    assert.equal(update.expectedVersion, 1);
    assert.equal(update.row.version, 2);
    assert.equal(update.row.created, 100);
    assert.equal(readHandlerOccurrenceRow(update.row).state, 'failed');
  }
  assert.equal(terminal.effects.writes?.[1]?.model, WORK_OCCURRENCE_MODEL);
  assert.equal(terminal.effects.writes?.length, 2);
  retain(rows, terminal.effects.writes);
  const replay = await stageHandlerOccurrenceTerminal({ ...selector(), expectedVersion: 1, receipt }, ctx);
  assert.equal(replay.status, 'replayed');
  if (replay.status === 'replayed') assert.equal(replay.receipt.code, 'authored-refusal');
  const sibling = await stageRetainedHandlerOccurrence(selector('demo.sibling'), ctx);
  assert.equal(sibling.status, 'ready');
  if (sibling.status === 'ready') assert.equal(sibling.occurrence.state, 'pending');
  assert.equal((await stageHandlerOccurrence({ source: source(), handler: 'demo.handler' }, ctx)).status, 'replayed');
});

it('refuses orphan and inconsistent receipts, and terminal rows missing their receipt', async () => {
  const rows = new Map<string, StoredRow>();
  const ctx = readers(rows);
  const id = handlerOccurrenceRowId('source/a', 'demo.handler');
  rows.set(`${WORK_OCCURRENCE_MODEL}\0${id}`, newOccurrenceRow({ ...receipt, occurrenceId: id }, { nowMs: 100, actor: 'owner-host' }));
  assert.deepEqual(await stageHandlerOccurrence({ source: source(), handler: 'demo.handler' }, ctx),
    { status: 'refused', reason: 'orphan-receipt' });
  rows.clear();
  const staged = await stageHandlerOccurrence({ source: source(), handler: 'demo.handler' }, ctx);
  if (staged.status !== 'ready') throw new Error('missing fixture');
  retain(rows, staged.effects.writes);
  rows.set(`${WORK_OCCURRENCE_MODEL}\0${id}`, newOccurrenceRow({ ...receipt, occurrenceId: id }, { nowMs: 100, actor: 'owner-host' }));
  assert.deepEqual(await stageRetainedHandlerOccurrence(selector(), ctx), { status: 'refused', reason: 'mismatched-receipt' });
  rows.delete(`${WORK_OCCURRENCE_MODEL}\0${id}`);
  rows.set(`${WORK_HANDLER_OCCURRENCE_MODEL}\0${id}`, { ...staged.row, data: { ...staged.row.data, state: 'completed' } });
  assert.deepEqual(await stageRetainedHandlerOccurrence(selector(), ctx), { status: 'refused', reason: 'missing-receipt' });
});

it('fails closed on invalid own JSON and derived identity, and returns a frozen decoded payload', async () => {
  const staged = await stageHandlerOccurrence({ source: source(), handler: 'demo.handler' }, readers());
  if (staged.status !== 'ready') throw new Error('missing fixture');
  const data = { ...staged.row.data };
  delete data['handler'];
  const inherited = Object.assign(Object.create({ handler: 'demo.handler' }), data);
  for (const bad of [
    { ...staged.row, data: inherited },
    { ...staged.row, id: 'wrong' as StoredRow['id'] },
    { ...staged.row, data: { ...staged.row.data, payload: { value: Number.NaN } } },
    { ...staged.row, data: { ...staged.row.data, payload: { value: new Date(100) } } },
  ]) assert.throws(() => readHandlerOccurrenceRow(bad), KernelTableError);
  const decoded = readHandlerOccurrenceRow(staged.row);
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.payload['nested']));
  assert.throws(() => { (decoded.payload['nested'] as { version: number }).version = 3; }, TypeError);
});

it('defines a bounded exact-scope pending scan and rejects invalid page selectors', () => {
  const query = handlerOccurrencePendingQuery(scope, { cursor: 'handler/v1/a/h', limit: 2 });
  assert.equal(query.model, WORK_HANDLER_OCCURRENCE_MODEL);
  assert.equal(query.limit, 2);
  assert.deepEqual(query.order, [{ field: 'id', direction: 'asc' }]);
  assert.deepEqual(query.where, { op: 'and', args: [
    { op: 'eq', field: 'scopeApp', value: 'app' },
    { op: 'eq', field: 'scopeOwner', value: 'team-1' },
    { op: 'eq', field: 'scopeOwnerPackage', value: 'demo' },
    { op: 'eq', field: 'state', value: 'pending' },
    { op: 'gt', field: 'id', value: 'handler/v1/a/h' },
  ] });
  for (const options of [{ cursor: '', limit: 1 }, { cursor: null, limit: 0 }, { cursor: null, limit: 1.5 }]) {
    assert.throws(() => handlerOccurrencePendingQuery(scope, options), KernelTableError);
  }
});
