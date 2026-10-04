/**
 * Lane 03 S5 lock tests (test worker): matching pre-state blocks updates and
 * archives, non-matching pre-state allows (including the lock-establishing
 * transition), and creates skip locks entirely.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  asModel,
  captureStateError,
  crudCreate,
  crudRemove,
  crudUpdate,
  field,
  lock,
  modelDef,
  mustLoad,
  seedStoredRow,
  setupMutation,
} from './fixtures.js';

const DOC = 'Acme.Doc';

function docModel() {
  return modelDef(DOC, {
    fields: { title: field({ required: true }), status: field() },
    locks: [lock('closed-lock', { op: 'eq', field: 'status', value: 'closed' })],
  });
}

describe('mutation locks', () => {
  it('blocks updates and archives when the pre-state matches', async () => {
    const world = await setupMutation([docModel()]);
    await seedStoredRow(world.store, asModel(DOC), {
      id: 'doc-1',
      data: { title: 't', status: 'closed' },
    });
    const onUpdate = await captureStateError(
      crudUpdate(world, DOC, 'doc-1', { version: 1, patch: { title: 't2' } }),
    );
    assert.equal(onUpdate.code, 'rule_failed');
    const onArchive = await captureStateError(crudRemove(world, DOC, 'doc-1', { version: 1 }));
    assert.equal(onArchive.code, 'rule_failed');
    const stored = await mustLoad(world.store, asModel(DOC), 'doc-1');
    assert.equal(stored.version, 1);
    assert.equal(stored.archivedAt, null);
    assert.deepEqual(stored.data, { title: 't', status: 'closed' });
  });

  it('allows non-matching pre-state, including the lock-establishing write', async () => {
    const world = await setupMutation([docModel()]);
    await seedStoredRow(world.store, asModel(DOC), {
      id: 'doc-1',
      data: { title: 't', status: 'open' },
    });
    const open = await crudUpdate(world, DOC, 'doc-1', { version: 1, patch: { title: 't2' } });
    assert.equal(open.out.status, 'committed');
    // Pre-state is unlocked, so establishing the lock succeeds...
    const establishing = await crudUpdate(world, DOC, 'doc-1', {
      version: 2,
      patch: { status: 'closed' },
    });
    assert.equal(establishing.out.status, 'committed');
    // ...and the next write is blocked.
    const blocked = await captureStateError(
      crudUpdate(world, DOC, 'doc-1', { version: 3, patch: { title: 't3' } }),
    );
    assert.equal(blocked.code, 'rule_failed');
  });

  it('skips locks on create', async () => {
    const world = await setupMutation([docModel()]);
    // `status: closed` would match the lock as pre-state, but creates have
    // no pre-state, so the write lands.
    const { out } = await crudCreate(world, DOC, {
      id: 'doc-1',
      data: { title: 't', status: 'closed' },
    });
    assert.equal(out.status, 'committed');
    assert.deepEqual((await mustLoad(world.store, asModel(DOC), 'doc-1')).data, {
      title: 't',
      status: 'closed',
    });
  });
});
