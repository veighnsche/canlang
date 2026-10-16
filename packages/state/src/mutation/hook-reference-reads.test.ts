import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelName, RecordId, StoredRow } from '@canlang/contracts';
import { assertOwnerMutationHookContext, beginOwnerMutation, type MutationWritesResult, type MutationWrite, type OwnerMutationSession } from './pipeline.js';
import { buildModelTable, type InterimHookContext, type OwnerMutationHookParentReads } from './models.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import { StateError } from '../errors.js';
import { asId, asModel, makeBatch } from '../../test/invocation/fixtures.js';
import { field, hook, modelDef, pipelineContext, readHookReferenceDecision, refDef } from '../../test/mutation/fixtures.js';

/**
 * CAN18-v1 referenced-row reads at the defining State owner (file 14
 * `Account.location` first shape, DESIGN 434/442 gap closure).
 *
 * The owner pipeline serves hook firing/guard (`decision`) reference loads
 * over the trigger's DECLARED stored references from the owner transaction
 * snapshot: a referenced row created or updated EARLIER IN THE SAME owner
 * transaction is visible (read-own-writes), while the committed case reads
 * committed state. Ordinary business-value (`value`) reads refuse here with
 * their exact host-viewer requirement (every data field withheld at State;
 * the host narrows per caller). The ancestor fence in `loadParent` is
 * untouched — referenced identities never go through it. Inline,
 * local-helper and imported-helper loads consume the same site meaning;
 * the loader returns rows, never a boolean verdict.
 *
 * Hooks fire on the CRUD cause; every stage below carries its admitted CRUD
 * inputs. Guessed/foreign/tampered edges refuse at the reference bound
 * without distinguishing the miss; genuine-but-missing targets are
 * `not_found`. Failures void the batch through the existing hook-error
 * path with order preserved (T31 flat, no cascade).
 */

const CUSTOMER = asModel('Acme.Customer');
const LOC = asModel('Acme.Location');
const ACCOUNT = asModel('Acme.Account');
const ASSET = asModel('Acme.Asset');
const OTHER = asModel('Acme.Other');
const bounds = { maxWork: 1000, maxRows: 20 };
const context = () => pipelineContext({ operation: 'Acme.Account.create' });

async function stage(session: OwnerMutationSession, write: MutationWrite): Promise<void> {
  await session.stage(write, { cause: 'crud', input: { ...(write.data ?? {}) } });
}

function tableWith(accountHooks: ReturnType<typeof hook>[]) {
  return buildModelTable([
    modelDef('Acme.Customer', { fields: { name: field() } }),
    modelDef('Acme.Location', { fields: { timezone: field(), secret: field() } }),
    { ...modelDef('Acme.Account', {
        fields: { note: field(), location: field() },
        refs: [refDef('location', 'Acme.Location')],
        hooks: accountHooks,
      }),
      containment: { parent: CUSTOMER } },
    modelDef('Acme.Asset', {
      fields: { note: field(), location: field() },
      refs: [refDef('location', 'Acme.Location')],
    }),
    modelDef('Acme.Other', { fields: { note: field() } }),
  ]);
}

const customerCreate = (id: string): MutationWrite =>
  ({ op: 'create', model: CUSTOMER, id: asId(id), data: { name: 'c' } });
const locationCreate = (id: string, data: Record<string, unknown>): MutationWrite =>
  ({ op: 'create', model: LOC, id: asId(id), data });
const accountCreate = (id: string, customerId: string, locationId: string, note = 'new'): MutationWrite =>
  ({ op: 'create', model: ACCOUNT, id: asId(id),
    parent: { model: CUSTOMER, id: asId(customerId) },
    data: { note, location: { id: locationId } } });

async function commit(store: ReturnType<typeof createTestMemoryStorage>['store'], output: MutationWritesResult) {
  await store.commit(makeBatch(await store.readRevision(), { writes: output.writes, history: output.history,
    uniqueClaims: output.uniqueClaims, uniqueReleases: output.uniqueReleases, schedules: output.schedules }));
}

async function localReadReferenceTimezone(
  ctx: InterimHookContext,
  model: ModelName,
  id: RecordId,
): Promise<unknown> {
  assertOwnerMutationHookContext(ctx);
  const read = await (ctx as unknown as { loadReference: (m: ModelName, i: RecordId, s: 'decision') => Promise<{ row: StoredRow }> })
    .loadReference(model, id, 'decision');
  return read.row.data.timezone;
}

test('child hook decision-load sees the same-transaction referenced update, not committed state', async () => {
  const { store } = createTestMemoryStorage();
  const seen: unknown[] = [];
  const table = tableWith([hook('record-reference', ['create'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    const read = await (ctx as unknown as { loadReference: typeof ctx.loadParent }).loadReference(LOC, asId('loc-1'), 'decision');
    assert.equal(typeof read, 'object');
    assert.ok('row' in read);
    seen.push(read.row.data.timezone);
    return candidate;
  })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, customerCreate('cust-1'));
  await stage(session, locationCreate('loc-1', { timezone: 'UTC', secret: 's3' }));
  await stage(session, { op: 'update', model: LOC, id: asId('loc-1'), data: { timezone: 'Europe/Brussels' } });
  await stage(session, accountCreate('acc-1', 'cust-1', 'loc-1'));
  assert.deepEqual(seen, ['Europe/Brussels']);
  const output = await session.finalize();
  await commit(store, output);
  assert.equal((await store.load(LOC, asId('loc-1')))?.data.timezone, 'Europe/Brussels');
});

test('child hook decision-load reads committed state when the reference is untouched in-batch', async () => {
  const { store } = createTestMemoryStorage();
  const seen: unknown[] = [];
  const table = tableWith([hook('record-reference', ['create'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    seen.push((await (ctx as unknown as { loadReference: typeof ctx.loadParent }).loadReference(LOC, asId('loc-1'), 'decision')).row.data.timezone);
    return candidate;
  })]);
  const first = await beginOwnerMutation({ table, store,
    context: pipelineContext({ operation: 'Acme.Location.create' }), bounds });
  await stage(first, customerCreate('cust-1'));
  await stage(first, locationCreate('loc-1', { timezone: 'UTC', secret: 's3' }));
  await commit(store, await first.finalize());
  const second = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(second, accountCreate('acc-1', 'cust-1', 'loc-1'));
  assert.deepEqual(seen, ['UTC']);
  await commit(store, await second.finalize());
});

test('inline, local-helper and imported-helper decision loads agree exactly', async () => {
  const { store } = createTestMemoryStorage();
  const table = tableWith([hook('agree', ['create'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    const loadRef = (ctx as unknown as { loadReference: typeof ctx.loadParent }).loadReference.bind(ctx);
    const inline = await loadRef(LOC, asId('loc-1'), 'decision');
    const local = await (async () => loadRef(LOC, asId('loc-1'), 'decision'))();
    const viaLocalHelper = await localReadReferenceTimezone(ctx, LOC, asId('loc-1'));
    const imported = await readHookReferenceDecision(ctx, LOC, asId('loc-1'));
    assert.deepEqual(
      { model: inline.model, version: inline.row.version, data: inline.row.data, withheld: [...inline.withheld] },
      { model: imported.model, version: imported.row.version, data: imported.row.data, withheld: [...imported.withheld] });
    assert.deepEqual(local.row.data, inline.row.data);
    assert.equal(viaLocalHelper, inline.row.data.timezone);
    assert.ok(Object.isFrozen(inline.row));
    return candidate;
  })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, customerCreate('cust-1'));
  await stage(session, locationCreate('loc-1', { timezone: 'UTC', secret: 's3' }));
  await stage(session, accountCreate('acc-1', 'cust-1', 'loc-1'));
  await commit(store, await session.finalize());
});

test('ordered reference writes serve each child hook the current provisional row', async () => {
  const { store } = createTestMemoryStorage();
  const seen: unknown[] = [];
  const table = tableWith([hook('record-reference', ['create'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    seen.push((await (ctx as unknown as { loadReference: typeof ctx.loadParent }).loadReference(LOC, asId('loc-1'), 'decision')).row.data.timezone);
    return candidate;
  })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, customerCreate('cust-1'));
  await stage(session, locationCreate('loc-1', { timezone: 'UTC', secret: 's3' }));
  await stage(session, accountCreate('acc-1', 'cust-1', 'loc-1'));
  await stage(session, { op: 'update', model: LOC, id: asId('loc-1'), data: { timezone: 'Europe/Brussels' } });
  await stage(session, accountCreate('acc-2', 'cust-1', 'loc-1'));
  assert.deepEqual(seen, ['UTC', 'Europe/Brussels']);
  await commit(store, await session.finalize());
});

test('a hook-staged reference update stays invisible to the same trigger (flat staging)', async () => {
  const { store } = createTestMemoryStorage();
  const seen: unknown[] = [];
  const table = tableWith([
    hook('a-stage-reference', ['create'], (candidate, ctx) => {
      assertOwnerMutationHookContext(ctx);
      ctx.stage({ op: 'update', model: LOC, id: asId('loc-1'), data: { timezone: 'Europe/Brussels' } });
      return candidate;
    }),
    hook('b-read-reference', ['create'], async (candidate, ctx) => {
      assertOwnerMutationHookContext(ctx);
      seen.push((await (ctx as unknown as { loadReference: typeof ctx.loadParent }).loadReference(LOC, asId('loc-1'), 'decision')).row.data.timezone);
      return candidate;
    }),
  ]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, customerCreate('cust-1'));
  await stage(session, locationCreate('loc-1', { timezone: 'UTC', secret: 's3' }));
  await stage(session, accountCreate('acc-1', 'cust-1', 'loc-1'));
  assert.deepEqual(seen, ['UTC']);
  await commit(store, await session.finalize());
  assert.equal((await store.load(LOC, asId('loc-1')))?.data.timezone, 'Europe/Brussels');
});

test('a reference-load failure voids the batch atomically', async () => {
  const { store } = createTestMemoryStorage();
  const table = tableWith([hook('guard', ['create'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    const read = await (ctx as unknown as { loadReference: typeof ctx.loadParent }).loadReference(LOC, asId('loc-1'), 'decision');
    if (read.row.data.timezone !== 'Europe/Brussels') throw new StateError('rule_failed', 'Location is not Brussels.');
    return candidate;
  })]);
  const revision = await store.readRevision();
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, customerCreate('cust-1'));
  await stage(session, locationCreate('loc-1', { timezone: 'UTC', secret: 's3' }));
  await assert.rejects(stage(session, accountCreate('acc-1', 'cust-1', 'loc-1')), /Location is not Brussels\./);
  await assert.rejects(session.finalize(), /poisoned/);
  assert.equal(await store.readRevision(), revision);
  assert.equal(await store.load(LOC, asId('loc-1')), null);
});

test('value-site loads serve the exact row with every data field withheld', async () => {
  const { store } = createTestMemoryStorage();
  const table = tableWith([hook('value', ['create'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    const loadRef = (ctx as unknown as { loadReference: typeof ctx.loadParent }).loadReference.bind(ctx);
    const read = await loadRef(LOC, asId('loc-1'), 'value');
    assert.equal(read.model, LOC);
    assert.equal(read.row.data.timezone, 'UTC');
    assert.deepEqual([...read.withheld].sort(), ['secret', 'timezone']);
    assert.ok(Object.isFrozen(read.row));
    const decision = await loadRef(LOC, asId('loc-1'), 'decision');
    assert.deepEqual([...decision.withheld], []);
    assert.deepEqual({ ...decision.row.data }, { ...read.row.data });
    return candidate;
  })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, customerCreate('cust-1'));
  await stage(session, locationCreate('loc-1', { timezone: 'UTC', secret: 's3' }));
  await stage(session, accountCreate('acc-1', 'cust-1', 'loc-1'));
  await commit(store, await session.finalize());
});

test('malformed reference reads refuse before touching storage', async () => {
  const { store } = createTestMemoryStorage();
  const table = tableWith([hook('malformed', ['create'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    const loadRef = (ctx as unknown as { loadReference: typeof ctx.loadParent }).loadReference.bind(ctx);
    await assert.rejects(loadRef(LOC, asId('loc-1'), 'bogus' as 'decision'),
      /Hook reference read requires its decision or value site\./);
    await assert.rejects(loadRef(asModel('Acme.Missing'), asId('loc-1'), 'decision'),
      /Owner mutation reads require a known model and record identity\./);
    await assert.rejects(loadRef(LOC, '' as unknown as RecordId, 'decision'),
      /Owner mutation reads require a known model and record identity\./);
    return candidate;
  })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, customerCreate('cust-1'));
  await stage(session, locationCreate('loc-1', { timezone: 'UTC', secret: 's3' }));
  await stage(session, accountCreate('acc-1', 'cust-1', 'loc-1'));
  await commit(store, await session.finalize());
});

test('non-reference reads refuse without distinguishing the miss', async () => {
  const { store } = createTestMemoryStorage();
  const table = tableWith([hook('bounds', ['create'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    const loadRef = (ctx as unknown as { loadReference: typeof ctx.loadParent }).loadReference.bind(ctx);
    // The trigger itself is not its own reference.
    await assert.rejects(loadRef(ACCOUNT, asId('acc-1'), 'decision'),
      /Hook reference read exceeds its trigger reference bound\./);
    // A foreign root without a declared edge stays refused identically.
    await assert.rejects(loadRef(OTHER, asId('other-1'), 'decision'),
      /Hook reference read exceeds its trigger reference bound\./);
    // A guessed id on the genuine target model stays refused identically.
    await assert.rejects(loadRef(LOC, asId('loc-guessed'), 'decision'),
      /Hook reference read exceeds its trigger reference bound\./);
    // A tampered edge (valid model, wrong id vs the trigger's location)
    // refuses identically — never the stored row.
    return candidate;
  })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, customerCreate('cust-1'));
  await stage(session, { op: 'create', model: OTHER, id: asId('other-1'), data: { note: 'x' } });
  await stage(session, locationCreate('loc-1', { timezone: 'UTC', secret: 's3' }));
  await stage(session, accountCreate('acc-1', 'cust-1', 'loc-1'));
  await commit(store, await session.finalize());
});

test('a top-level trigger reads its stored reference (file 20 shape)', async () => {
  const { store } = createTestMemoryStorage();
  const seen: unknown[] = [];
  const assetTable = buildModelTable([
    modelDef('Acme.Location', { fields: { timezone: field(), secret: field() } }),
    { ...modelDef('Acme.Asset', {
        fields: { note: field(), location: field() },
        refs: [refDef('location', 'Acme.Location')],
        hooks: [hook('asset-ref', ['create'], async (candidate, ctx) => {
          assertOwnerMutationHookContext(ctx);
          seen.push((await (ctx as unknown as { loadReference: typeof ctx.loadParent }).loadReference(LOC, asId('loc-1'), 'decision')).row.data.timezone);
          return candidate;
        })],
      }) },
  ]);
  const session = await beginOwnerMutation({ table: assetTable, store,
    context: pipelineContext({ operation: 'Acme.Asset.create' }), bounds });
  await stage(session, locationCreate('loc-1', { timezone: 'UTC', secret: 's3' }));
  await stage(session, { op: 'create', model: ASSET, id: asId('asset-1'), data: { note: 'n', location: { id: 'loc-1' } } });
  assert.deepEqual(seen, ['UTC']);
  await commit(store, await session.finalize());
});

test('decision loads observe the archived referenced row as authority truth', async () => {
  const { store } = createTestMemoryStorage();
  const seen: Array<{ timezone: unknown; archived: unknown }> = [];
  const table = tableWith([hook('archived-reference', ['update'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    const read = await (ctx as unknown as { loadReference: typeof ctx.loadParent }).loadReference(LOC, asId('loc-1'), 'decision');
    seen.push({ timezone: read.row.data.timezone, archived: read.row.archivedAt !== null });
    return candidate;
  })]);
  const setup = await beginOwnerMutation({ table, store,
    context: pipelineContext({ operation: 'Acme.Location.create' }), bounds });
  await stage(setup, customerCreate('cust-1'));
  await stage(setup, locationCreate('loc-1', { timezone: 'UTC', secret: 's3' }));
  await stage(setup, accountCreate('acc-1', 'cust-1', 'loc-1'));
  await commit(store, await setup.finalize());
  // Archive (default delete mode) keeps the row: the decision load still
  // observes the archived authority row.
  const archive = await beginOwnerMutation({ table, store,
    context: pipelineContext({ operation: 'Acme.Location.delete' }), bounds });
  await stage(archive, { op: 'remove', model: LOC, id: asId('loc-1') });
  await commit(store, await archive.finalize());
  assert.notEqual((await store.load(LOC, asId('loc-1')))?.archivedAt, null);
  const update = await beginOwnerMutation({ table, store,
    context: pipelineContext({ operation: 'Acme.Account.update' }), bounds });
  await stage(update, { op: 'update', model: ACCOUNT, id: asId('acc-1'), data: { note: 'bump' } });
  assert.deepEqual(seen, [{ timezone: 'UTC', archived: true }]);
  await commit(store, await update.finalize());
});

test('genuine edges with missing targets are not_found, not the reference bound', async () => {
  const { store } = createTestMemoryStorage();
  const tableWithRemove = buildModelTable([
    modelDef('Acme.Customer', { fields: { name: field() } }),
    modelDef('Acme.Location', { fields: { timezone: field(), secret: field() }, deleteMode: 'remove' as const }),
    { ...modelDef('Acme.Account', {
        fields: { note: field(), location: field() },
        refs: [refDef('location', 'Acme.Location')],
        hooks: [hook('missing', ['create'], async (candidate, ctx) => {
          assertOwnerMutationHookContext(ctx);
          // Genuine declared edge, missing target: passes the reference
          // bound, then throws the precise missing-target failure (which
          // voids the batch through the hook-error path — uncaught here).
          await (ctx as unknown as { loadReference: typeof ctx.loadParent }).loadReference(LOC, asId('loc-1'), 'decision');
          return candidate;
        })],
      }),
      containment: { parent: CUSTOMER } },
  ]);
  const setup = await beginOwnerMutation({ table: tableWithRemove, store,
    context: pipelineContext({ operation: 'Acme.Location.create' }), bounds });
  await stage(setup, customerCreate('cust-1'));
  await stage(setup, locationCreate('loc-1', { timezone: 'UTC', secret: 's3' }));
  await commit(store, await setup.finalize());
  const wipe = await beginOwnerMutation({ table: tableWithRemove, store,
    context: pipelineContext({ operation: 'Acme.Location.delete' }), bounds });
  await stage(wipe, { op: 'remove', model: LOC, id: asId('loc-1') });
  await commit(store, await wipe.finalize());
  assert.equal(await store.load(LOC, asId('loc-1')), null);
  const revision = await store.readRevision();
  const session = await beginOwnerMutation({ table: tableWithRemove, store, context: context(), bounds });
  await assert.rejects(stage(session, accountCreate('acc-9', 'cust-1', 'loc-1')), /Referenced record not found\./);
  await assert.rejects(session.finalize(), /poisoned/);
  assert.equal(await store.readRevision(), revision);
});

test('the reference loader closes with its hook scope', async () => {
  const { store } = createTestMemoryStorage();
  let retained: OwnerMutationHookParentReads['load'] | undefined;
  const table = tableWith([hook('retain', ['create'], (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    retained = (ctx as unknown as { loadReference: OwnerMutationHookParentReads['load'] }).loadReference;
    return candidate;
  })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, customerCreate('cust-1'));
  await stage(session, locationCreate('loc-1', { timezone: 'UTC', secret: 's3' }));
  await stage(session, accountCreate('acc-1', 'cust-1', 'loc-1'));
  await commit(store, await session.finalize());
  assert.ok(retained !== undefined);
  await assert.rejects(retained!(LOC, asId('loc-1'), 'decision'), /Owner hook scope is closed\./);
});
