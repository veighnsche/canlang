/**
 * Lane 03 S5 create tests (test worker): happy create with literal and
 * parent-bound defaults, metadata/parent persistence, input validation
 * (required/unknown/server-only/id shape/parent eligibility), duplicate-id
 * rejection, real-storage unique conflicts, and receipt resolvedDefaults.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { QueryPredicate } from '@canlang/contracts';
import { CRUD_MAX_ID_LENGTH, crudDefs } from '../../src/mutation/index.js';
import type { ByPredicate } from '../../src/policy/roles.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  captureStateError,
  crudCreate,
  field,
  freshOperationId,
  modelDef,
  mustLoad,
  readCrudReceipt,
  seedStoredRow,
  setupMutation,
} from './fixtures.js';

const TODO = 'Acme.Todo';
const LIST = 'Acme.Checklist';

function todoModel() {
  return modelDef(TODO, {
    fields: {
      title: field({ required: true }),
      status: field({ default: 'open' }),
      assignee: field({ default: { parentPath: 'owner' } }),
      token: field({ serverOnly: true, default: 'srv-1' }),
    },
  });
}

async function seedListWithOwner(store: Parameters<typeof seedStoredRow>[0], id: string) {
  return seedStoredRow(store, asModel(LIST), { id, data: { owner: 'user-bob' } });
}

describe('mutation create', () => {
  it('applies literal + parent-bound defaults, metadata, and parent linkage', async () => {
    const world = await setupMutation([todoModel()]);
    await seedListWithOwner(world.store, 'list-1');
    const { out, operationId } = await crudCreate(world, TODO, {
      id: 'todo-1',
      data: { title: 'Write tests' },
      parent: { model: LIST, id: 'list-1' },
    });
    assert.equal(out.status, 'committed');
    assert.equal(out.operation_id, operationId);
    const stored = await mustLoad(world.store, asModel(TODO), 'todo-1');
    assert.equal(stored.version, 1);
    assert.equal(stored.created, FIXED_NOW);
    assert.equal(stored.updated, FIXED_NOW);
    assert.equal(stored.createdBy, world.alice.user.user_id);
    assert.equal(stored.updatedBy, world.alice.user.user_id);
    assert.equal(stored.archivedAt, null);
    assert.deepEqual(stored.parent ?? null, { model: LIST, id: 'list-1' });
    assert.deepEqual(stored.data, {
      title: 'Write tests',
      status: 'open',
      assignee: 'user-bob',
      token: 'srv-1',
    });
    assert.deepEqual(out.result, stored);
  });

  it('rejects a missing required field with validation', async () => {
    const world = await setupMutation([todoModel()]);
    await seedListWithOwner(world.store, 'list-1');
    const error = await captureStateError(
      crudCreate(world, TODO, {
        data: {},
        parent: { model: LIST, id: 'list-1' },
      }),
    );
    assert.equal(error.code, 'validation');
    assert.equal(await world.store.load(asModel(TODO), asId('todo-1')), null);
  });

  it('rejects unknown fields with validation', async () => {
    const world = await setupMutation([todoModel()]);
    const error = await captureStateError(
      crudCreate(world, TODO, { data: { title: 't', bogus: 1 } }),
    );
    assert.equal(error.code, 'validation');
  });

  it('rejects caller-supplied server-only fields with validation', async () => {
    const world = await setupMutation([todoModel()]);
    const error = await captureStateError(
      crudCreate(world, TODO, { data: { title: 't', token: 'forged' } }),
    );
    assert.equal(error.code, 'validation');
  });

  it('rejects duplicate ids with validation and keeps the original', async () => {
    const world = await setupMutation([todoModel()]);
    await seedListWithOwner(world.store, 'list-1');
    const parent = { model: LIST, id: 'list-1' };
    await crudCreate(world, TODO, { id: 'dup-1', data: { title: 'first' }, parent });
    const error = await captureStateError(
      crudCreate(world, TODO, { id: 'dup-1', data: { title: 'second' }, parent }),
    );
    assert.equal(error.code, 'validation');
    assert.deepEqual((await mustLoad(world.store, asModel(TODO), 'dup-1')).data, {
      title: 'first',
      status: 'open',
      assignee: 'user-bob',
      token: 'srv-1',
    });
  });

  it('rejects empty and too-long ids with validation', async () => {
    const world = await setupMutation([todoModel()]);
    const empty = await captureStateError(crudCreate(world, TODO, { id: '', data: {} }));
    assert.equal(empty.code, 'validation');
    const long = await captureStateError(
      crudCreate(world, TODO, { id: 'x'.repeat(CRUD_MAX_ID_LENGTH + 1), data: {} }),
    );
    assert.equal(long.code, 'validation');
    // The boundary id (exactly 128 chars) is accepted.
    await seedListWithOwner(world.store, 'list-1');
    const boundary = 'y'.repeat(CRUD_MAX_ID_LENGTH);
    const { out } = await crudCreate(world, TODO, {
      id: boundary,
      data: { title: 'edge' },
      parent: { model: LIST, id: 'list-1' },
    });
    assert.equal(out.status, 'committed');
    assert.ok((await world.store.load(asModel(TODO), asId(boundary))) !== null);
  });

  it('rejects missing parents with validation', async () => {
    const world = await setupMutation([todoModel()]);
    const error = await captureStateError(
      crudCreate(world, TODO, {
        data: { title: 'orphan' },
        parent: { model: LIST, id: 'ghost' },
      }),
    );
    assert.equal(error.code, 'validation');
  });

  it('rejects archived parents with validation', async () => {
    const world = await setupMutation([todoModel()]);
    await seedStoredRow(world.store, asModel(LIST), {
      id: 'list-arch',
      data: { owner: 'user-bob' },
      archivedAt: FIXED_NOW,
    });
    const error = await captureStateError(
      crudCreate(world, TODO, {
        data: { title: 't' },
        parent: { model: LIST, id: 'list-arch' },
      }),
    );
    assert.equal(error.code, 'validation');
  });

  it('reads parent-path defaults as missing without a parent (required decides)', async () => {
    const world = await setupMutation([todoModel()]);
    // Optional parent-bound `assignee` never blocks a parentless create.
    const { out } = await crudCreate(world, TODO, { id: 'todo-1', data: { title: 't' } });
    assert.equal(out.status, 'committed');
    const stored = await mustLoad(world.store, asModel(TODO), 'todo-1');
    assert.ok(!('assignee' in stored.data), 'unresolved default stays absent, not null');

    // A REQUIRED parent-bound field still fails — as missing, not as a
    // parent error.
    const strict = await setupMutation([
      modelDef(TODO, {
        fields: {
          title: field({ required: true }),
          assignee: field({ required: true, default: { parentPath: 'owner' } }),
        },
      }),
    ]);
    const error = await captureStateError(crudCreate(strict, TODO, { data: { title: 't' } }));
    assert.equal(error.code, 'validation');
  });

  it('maps a real storage unique conflict on second create to conflict', async () => {
    const world = await setupMutation([
      modelDef('Acme.User', {
        fields: { email: field({ required: true }) },
        uniqueKeys: ['email'],
      }),
    ]);
    await crudCreate(world, 'Acme.User', { id: 'u-1', data: { email: 'a@example.test' } });
    const secondId = freshOperationId();
    const error = await captureStateError(
      crudCreate(world, 'Acme.User', {
        id: 'u-2',
        data: { email: 'a@example.test' },
        operationId: secondId,
      }),
    );
    assert.equal(error.code, 'conflict');
    // The losing batch persisted nothing: no row, and (commit errors never
    // receipt) no receipt either.
    assert.equal(await world.store.load(asModel('Acme.User'), asId('u-2')), null);
    assert.equal(
      await readCrudReceipt(world, { operation: 'Acme.User.create', operationId: secondId }),
      null,
    );
    assert.deepEqual((await mustLoad(world.store, asModel('Acme.User'), 'u-1')).data, {
      email: 'a@example.test',
    });
  });

  it('freezes crudDefs output and clones the input opts', () => {
    const terms: ByPredicate[] = ['members'];
    const when: QueryPredicate = { op: 'eq', field: 'status', value: 'open' };
    const defs = crudDefs(asModel('Acme.T'), { by: { and: terms }, when });
    for (const def of [defs.create, defs.update, defs.remove]) {
      assert.equal(Object.isFrozen(def), true);
      assert.equal(Object.isFrozen(def.by), true);
      assert.equal(Object.isFrozen(def.inputs), true);
    }
    // Mutating the caller's opts afterwards cannot alter the built defs.
    terms.push('owner');
    (when as { value: unknown }).value = 'closed';
    assert.deepEqual(defs.update.by, { and: ['members'] });
    assert.deepEqual(defs.update.when, { op: 'eq', field: 'status', value: 'open' });
  });

  it('persists only defaulted fields in receipt resolvedDefaults', async () => {
    const world = await setupMutation([todoModel()]);
    await seedListWithOwner(world.store, 'list-1');
    const { operationId } = await crudCreate(world, TODO, {
      id: 'todo-9',
      data: { title: 'supplied', status: 'custom' },
      parent: { model: LIST, id: 'list-1' },
    });
    const receipt = await readCrudReceipt(world, {
      operation: `${TODO}.create`,
      operationId,
    });
    assert.ok(receipt !== null);
    // Supplied `title`/`status` are absent; only applied defaults persist.
    assert.deepEqual(receipt.resolvedDefaults, { assignee: 'user-bob', token: 'srv-1' });
    assert.deepEqual((await mustLoad(world.store, asModel(TODO), 'todo-9')).data, {
      title: 'supplied',
      status: 'custom',
      assignee: 'user-bob',
      token: 'srv-1',
    });
  });
});
