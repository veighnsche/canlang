/**
 * Lane 03 S5 update tests (test worker): patch merge with version bump and
 * attribution, no defaults on update, undefined/null patch semantics,
 * unknown/server-only rejection, unique release+claim, CRUD `when`, and hook
 * adjustment/rejection/order/required-recheck.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StateError } from '../../src/errors.js';
import { runMutationWrites } from '../../src/mutation/index.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  captureStateError,
  crudCreate,
  crudUpdate,
  field,
  freshOperationId,
  hook,
  modelDef,
  mustLoad,
  pipelineContext,
  readCrudReceipt,
  seedStoredRow,
  setupMutation,
} from './fixtures.js';

const TODO = 'Acme.Todo';
const USER = 'Acme.User';

function todoModel(): ReturnType<typeof modelDef> {
  return modelDef(TODO, {
    fields: {
      title: field({ required: true }),
      status: field({ default: 'open' }),
      token: field({ serverOnly: true }),
      trail: field(),
    },
  });
}

function userModel(): ReturnType<typeof modelDef> {
  return modelDef(USER, {
    fields: { email: field({ required: true }), name: field() },
    uniqueKeys: ['email'],
  });
}

describe('mutation update', () => {
  it('merges the patch, bumps the version, stamps attribution, applies no defaults', async () => {
    const world = await setupMutation([todoModel()]);
    // Seeded without `status`: no default may backfill it on update.
    await seedStoredRow(world.store, asModel(TODO), {
      id: 'todo-1',
      data: { title: 'before' },
      updated: FIXED_NOW - 1000,
      updatedBy: 'user-bob',
    });
    const { out } = await crudUpdate(world, TODO, 'todo-1', {
      version: 1,
      patch: { title: 'after' },
    });
    assert.equal(out.status, 'committed');
    const stored = await mustLoad(world.store, asModel(TODO), 'todo-1');
    assert.equal(stored.version, 2);
    assert.equal(stored.created, FIXED_NOW);
    assert.equal(stored.updated, FIXED_NOW);
    assert.equal(stored.createdBy, 'user-alice');
    assert.equal(stored.updatedBy, world.alice.user.user_id);
    assert.deepEqual(stored.data, { title: 'after' });
    assert.deepEqual(out.result, stored);
  });

  it('ignores undefined patch values; null fails required', async () => {
    const world = await setupMutation([todoModel()]);
    await seedStoredRow(world.store, asModel(TODO), {
      id: 'todo-1',
      data: { title: 'keep', status: 'open' },
    });
    // `undefined` cannot cross admission's fail-closed input hash, so the
    // pipeline's ignore-undefined rule is exercised at the pipeline seam.
    const staged = await runMutationWrites({
      table: world.table,
      writes: [
        {
          op: 'update',
          model: asModel(TODO),
          id: asId('todo-1'),
          data: { title: undefined, status: 'closed' },
        },
      ],
      context: pipelineContext({ operation: `${TODO}.update` }),
      store: world.store,
    });
    const write = staged.writes[0];
    assert.ok(write?.kind === 'update');
    assert.deepEqual(write.row.data, { title: 'keep', status: 'closed' });
    // `null` is a real value and still fails required end-to-end.
    const error = await captureStateError(
      crudUpdate(world, TODO, 'todo-1', { version: 1, patch: { title: null } }),
    );
    assert.equal(error.code, 'validation');
  });

  it('rejects unknown and server-only patch fields with validation', async () => {
    const world = await setupMutation([todoModel()]);
    await seedStoredRow(world.store, asModel(TODO), { id: 'todo-1', data: { title: 't' } });
    const unknown = await captureStateError(
      crudUpdate(world, TODO, 'todo-1', { version: 1, patch: { bogus: 1 } }),
    );
    assert.equal(unknown.code, 'validation');
    const serverOnly = await captureStateError(
      crudUpdate(world, TODO, 'todo-1', { version: 1, patch: { token: 'forged' } }),
    );
    assert.equal(serverOnly.code, 'validation');
  });

  it('unique change releases the old value and claims the new one', async () => {
    const world = await setupMutation([userModel()]);
    await crudCreate(world, USER, { id: 'u-1', data: { email: 'a@example.test' } });
    await crudCreate(world, USER, { id: 'u-2', data: { email: 'b@example.test' } });
    const { out } = await crudUpdate(world, USER, 'u-1', {
      version: 1,
      patch: { email: 'c@example.test' },
    });
    assert.equal(out.status, 'committed');
    // The released value is reusable by another row...
    const reuse = await crudCreate(world, USER, { id: 'u-3', data: { email: 'a@example.test' } });
    assert.equal(reuse.out.status, 'committed');
    // ...while the newly claimed value is blocked.
    const blocked = await captureStateError(
      crudCreate(world, USER, { id: 'u-4', data: { email: 'c@example.test' } }),
    );
    assert.equal(blocked.code, 'conflict');
  });

  it('leaves unique claims alone when the unique value is unchanged', async () => {
    const world = await setupMutation([userModel()]);
    await crudCreate(world, USER, { id: 'u-1', data: { email: 'a@example.test' } });
    const { out } = await crudUpdate(world, USER, 'u-1', { version: 1, patch: { name: 'Ann' } });
    assert.equal(out.status, 'committed');
    // No release happened: the value is still claimed.
    const blocked = await captureStateError(
      crudCreate(world, USER, { id: 'u-2', data: { email: 'a@example.test' } }),
    );
    assert.equal(blocked.code, 'conflict');
  });

  it('passes a true CRUD when and rejects a false one with rule_failed', async () => {
    const world = await setupMutation([todoModel()], {
      by: 'members',
      when: { op: 'eq', field: 'status', value: 'open' },
    });
    await seedStoredRow(world.store, asModel(TODO), {
      id: 'todo-1',
      data: { title: 't', status: 'open' },
    });
    const pass = await crudUpdate(world, TODO, 'todo-1', { version: 1, patch: { title: 't2' } });
    assert.equal(pass.out.status, 'committed');
    // The candidate closes the todo, so `when` (status == open) fails.
    const failId = freshOperationId();
    const error = await captureStateError(
      crudUpdate(world, TODO, 'todo-1', {
        version: 2,
        patch: { status: 'closed' },
        operationId: failId,
      }),
    );
    assert.equal(error.code, 'rule_failed');
    assert.deepEqual((await mustLoad(world.store, asModel(TODO), 'todo-1')).data, {
      title: 't2',
      status: 'open',
    });
    const receipt = await readCrudReceipt(world, {
      operation: `${TODO}.update`,
      operationId: failId,
    });
    assert.deepEqual(receipt?.outcome, {
      status: 'rejected',
      code: 'rule_failed',
      message: 'Precondition failed.',
    });
  });

  it('applies hook adjustments and commits a receipt on hook rejection', async () => {
    const stamp = hook('stamp', ['update'], (candidate) => ({ ...candidate, token: 'hooked' }));
    const world = await setupMutation([
      modelDef(TODO, {
        fields: {
          title: field({ required: true }),
          token: field({ serverOnly: true }),
        },
        hooks: [stamp],
      }),
    ]);
    await seedStoredRow(world.store, asModel(TODO), { id: 'todo-1', data: { title: 't' } });
    await crudUpdate(world, TODO, 'todo-1', { version: 1, patch: { title: 't2' } });
    // Hooks are trusted: they may set server-only fields callers cannot.
    assert.deepEqual((await mustLoad(world.store, asModel(TODO), 'todo-1')).data, {
      title: 't2',
      token: 'hooked',
    });

    const reject = hook('reject', ['update'], () => {
      throw new StateError('rule_failed', 'Hook vetoed this update.');
    });
    const rejecting = await setupMutation([
      modelDef(TODO, {
        fields: { title: field({ required: true }) },
        hooks: [reject],
      }),
    ]);
    await seedStoredRow(rejecting.store, asModel(TODO), { id: 'todo-1', data: { title: 't' } });
    const rejectId = freshOperationId();
    const error = await captureStateError(
      crudUpdate(rejecting, TODO, 'todo-1', {
        version: 1,
        patch: { title: 't2' },
        operationId: rejectId,
      }),
    );
    assert.equal(error.code, 'rule_failed');
    assert.equal(error.message, 'Hook vetoed this update.');
    assert.deepEqual((await mustLoad(rejecting.store, asModel(TODO), 'todo-1')).data, {
      title: 't',
    });
    const receipt = await readCrudReceipt(rejecting, {
      operation: `${TODO}.update`,
      operationId: rejectId,
    });
    assert.deepEqual(receipt?.outcome, {
      status: 'rejected',
      code: 'rule_failed',
      message: 'Hook vetoed this update.',
    });
  });

  it('runs hooks in written order', async () => {
    const seen: string[] = [];
    const first = hook('first', ['update'], (candidate) => {
      seen.push('first');
      return { ...candidate, trail: `${String(candidate['trail'])}-h1` };
    });
    const second = hook('second', ['update'], (candidate) => {
      seen.push('second');
      return { ...candidate, trail: `${String(candidate['trail'])}-h2` };
    });
    const world = await setupMutation([
      modelDef(TODO, {
        fields: { title: field({ required: true }), trail: field() },
        hooks: [first, second],
      }),
    ]);
    await seedStoredRow(world.store, asModel(TODO), {
      id: 'todo-1',
      data: { title: 't', trail: 'start' },
    });
    await crudUpdate(world, TODO, 'todo-1', { version: 1, patch: {} });
    assert.deepEqual(seen, ['first', 'second']);
    assert.equal((await mustLoad(world.store, asModel(TODO), 'todo-1')).data['trail'], 'start-h1-h2');
  });

  it('re-checks required after hooks (a hook deleting required fails)', async () => {
    const deleter = hook('deleter', ['update'], (candidate) => {
      const next = { ...candidate };
      delete next['title'];
      return next;
    });
    const world = await setupMutation([
      modelDef(TODO, {
        fields: { title: field({ required: true }) },
        hooks: [deleter],
      }),
    ]);
    await seedStoredRow(world.store, asModel(TODO), { id: 'todo-1', data: { title: 't' } });
    const error = await captureStateError(
      crudUpdate(world, TODO, 'todo-1', { version: 1, patch: { title: 't2' } }),
    );
    assert.equal(error.code, 'validation');
    assert.deepEqual((await mustLoad(world.store, asModel(TODO), 'todo-1')).data, { title: 't' });
  });
});
