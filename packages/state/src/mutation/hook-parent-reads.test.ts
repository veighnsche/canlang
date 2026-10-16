import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelName, RecordId, RecordVersion, StoredRow } from '@canlang/contracts';
import { assertOwnerMutationHookContext, beginOwnerMutation, type MutationWritesResult, type MutationWrite, type OwnerMutationSession } from './pipeline.js';
import { projectOwnerHookParentRow } from './model-policies.js';
import { buildModelTable, type InterimHookContext, type OwnerMutationHookParentReads } from './models.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import { StateError } from '../errors.js';
import { asId, asModel, makeBatch } from '../../test/invocation/fixtures.js';
import { field, hook, modelDef, pipelineContext, readHookParentDecision } from '../../test/mutation/fixtures.js';

/**
 * Scope-2 hook parent reads at the defining State owner (DESIGN434/442).
 *
 * The owner pipeline serves hook firing/guard (`decision`) parent loads from
 * the owner transaction snapshot: a parent created or updated EARLIER IN THE
 * SAME owner transaction is visible to the child hook (read-own-writes; the
 * committed-only default is withdrawn), while the committed-parent case reads
 * committed state. Ordinary business-value (`value`) reads refuse here with
 * their exact host-viewer requirement; restricted denials stay precise
 * failures, never null fallbacks or new grants. Inline, local-helper and
 * imported-helper loads consume the same site meaning; the loader returns
 * rows, never a boolean verdict.
 *
 * Hooks fire on the CRUD cause (the pipeline's hook path); every stage below
 * carries its admitted CRUD inputs.
 */

const SITE = asModel('Acme.Site');
const LOC = asModel('Acme.Location');
const READ = asModel('Acme.Reading');
const OTHER = asModel('Acme.Other');
const bounds = { maxWork: 1000, maxRows: 20 };
const context = () => pipelineContext({ operation: 'Acme.Reading.create' });

async function stage(session: OwnerMutationSession, write: MutationWrite): Promise<void> {
  await session.stage(write, { cause: 'crud', input: { ...(write.data ?? {}) } });
}

function tableWith(readingHooks: ReturnType<typeof hook>[]) {
  return buildModelTable([
    modelDef('Acme.Site', { fields: { region: field() } }),
    { ...modelDef('Acme.Location', { fields: { active: field(), timezone: field() } }),
      containment: { parent: SITE } },
    { ...modelDef('Acme.Reading', { fields: { taken: field(), snapshot: field() }, hooks: readingHooks }),
      containment: { parent: LOC } },
    modelDef('Acme.Other', { fields: { note: field() } }),
  ]);
}

const locationCreate = (id: string, data: Record<string, unknown>): MutationWrite =>
  ({ op: 'create', model: LOC, id: asId(id),
    parent: { model: SITE, id: asId('site-1') }, data });
const readingCreate = (id: string, parentId: string, data: Record<string, unknown> = { taken: true }): MutationWrite =>
  ({ op: 'create', model: READ, id: asId(id),
    parent: { model: LOC, id: asId(parentId) }, data });

async function commit(store: ReturnType<typeof createTestMemoryStorage>['store'], output: MutationWritesResult) {
  await store.commit(makeBatch(await store.readRevision(), { writes: output.writes, history: output.history,
    uniqueClaims: output.uniqueClaims, uniqueReleases: output.uniqueReleases, schedules: output.schedules }));
}

async function localReadParentActive(
  ctx: InterimHookContext,
  model: ModelName,
  id: RecordId,
): Promise<unknown> {
  assertOwnerMutationHookContext(ctx);
  const read = await ctx.loadParent(model, id, 'decision');
  return read.row.data.active;
}

test('child hook decision-load sees the same-transaction parent update, not committed state', async () => {
  const { store } = createTestMemoryStorage();
  const seen: unknown[] = [];
  const observed: Array<Record<string, unknown>> = [];
  const table = tableWith([hook('record-parent', ['create'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    const read = await ctx.loadParent(LOC, asId('loc-1'), 'decision');
    // No boolean-return shortcut: the loader returns a row the guard compares.
    assert.equal(typeof read, 'object');
    assert.ok('row' in read);
    seen.push(read.row.data.active);
    observed.push({ ...read.row.data });
    return candidate;
  })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, { op: 'create', model: SITE, id: asId('site-1'), data: { region: 'eu' } });
  await stage(session, locationCreate('loc-1', { active: false, timezone: 'UTC' }));
  await stage(session, { op: 'update', model: LOC, id: asId('loc-1'), data: { active: true } });
  await stage(session, readingCreate('read-1', 'loc-1'));
  assert.deepEqual(seen, [true]);
  const output = await session.finalize();
  await commit(store, output);
  assert.equal((await store.load(LOC, asId('loc-1')))?.data.active, true);
  // The hook observed the merged same-transaction row, not committed state.
  assert.deepEqual(observed, [(await store.load(LOC, asId('loc-1')))?.data]);
  assert.deepEqual((await store.load(READ, asId('read-1')))?.parent, { model: LOC, id: 'loc-1' });
});

test('child hook decision-load reads committed state when the parent is untouched in-batch', async () => {
  const { store } = createTestMemoryStorage();
  const seen: unknown[] = [];
  const table = tableWith([hook('record-parent', ['create'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    seen.push((await ctx.loadParent(LOC, asId('loc-1'), 'decision')).row.data.active);
    return candidate;
  })]);
  const first = await beginOwnerMutation({ table, store,
    context: pipelineContext({ operation: 'Acme.Location.create' }), bounds });
  await stage(first, { op: 'create', model: SITE, id: asId('site-1'), data: { region: 'eu' } });
  await stage(first, locationCreate('loc-1', { active: false, timezone: 'UTC' }));
  await commit(store, await first.finalize());
  const second = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(second, readingCreate('read-1', 'loc-1'));
  assert.deepEqual(seen, [false]);
  await commit(store, await second.finalize());
  assert.equal((await store.load(LOC, asId('loc-1')))?.data.active, false);
});

test('inline, local-helper and imported-helper decision loads agree exactly', async () => {
  const { store } = createTestMemoryStorage();
  const table = tableWith([hook('agree', ['create'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    const inline = await ctx.loadParent(LOC, asId('loc-1'), 'decision');
    const local = await (async () => ctx.loadParent(LOC, asId('loc-1'), 'decision'))();
    const viaLocalHelper = await localReadParentActive(ctx, LOC, asId('loc-1'));
    const imported = await readHookParentDecision(ctx, LOC, asId('loc-1'));
    assert.deepEqual(
      { model: inline.model, version: inline.row.version, data: inline.row.data, withheld: [...inline.withheld] },
      { model: imported.model, version: imported.row.version, data: imported.row.data, withheld: [...imported.withheld] });
    assert.deepEqual(local.row.data, inline.row.data);
    assert.equal(viaLocalHelper, inline.row.data.active);
    assert.ok(Object.isFrozen(inline.row));
    return candidate;
  })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, { op: 'create', model: SITE, id: asId('site-1'), data: { region: 'eu' } });
  await stage(session, locationCreate('loc-1', { active: true, timezone: 'UTC' }));
  await stage(session, readingCreate('read-1', 'loc-1'));
  await commit(store, await session.finalize());
});

test('ordered parent writes serve each child hook the current provisional row', async () => {
  const { store } = createTestMemoryStorage();
  const seen: unknown[] = [];
  const table = tableWith([hook('record-parent', ['create'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    seen.push((await ctx.loadParent(LOC, asId('loc-1'), 'decision')).row.data.active);
    return candidate;
  })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, { op: 'create', model: SITE, id: asId('site-1'), data: { region: 'eu' } });
  await stage(session, locationCreate('loc-1', { active: false, timezone: 'UTC' }));
  await stage(session, readingCreate('read-1', 'loc-1'));
  await stage(session, { op: 'update', model: LOC, id: asId('loc-1'), data: { active: true } });
  await stage(session, readingCreate('read-2', 'loc-1'));
  assert.deepEqual(seen, [false, true]);
  await commit(store, await session.finalize());
});

test('a hook-staged parent update stays invisible to the same trigger (flat staging)', async () => {
  const { store } = createTestMemoryStorage();
  const seen: unknown[] = [];
  const table = tableWith([
    hook('a-stage-parent', ['create'], (candidate, ctx) => {
      assertOwnerMutationHookContext(ctx);
      ctx.stage({ op: 'update', model: LOC, id: asId('loc-1'), data: { active: true } });
      return candidate;
    }),
    hook('b-read-parent', ['create'], async (candidate, ctx) => {
      assertOwnerMutationHookContext(ctx);
      seen.push((await ctx.loadParent(LOC, asId('loc-1'), 'decision')).row.data.active);
      return candidate;
    }),
  ]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, { op: 'create', model: SITE, id: asId('site-1'), data: { region: 'eu' } });
  await stage(session, locationCreate('loc-1', { active: false, timezone: 'UTC' }));
  await stage(session, readingCreate('read-1', 'loc-1'));
  // Staged writes drain after the trigger's hooks: the later hook still sees
  // the pre-stage provisional row, while the commit carries the staged update.
  assert.deepEqual(seen, [false]);
  await commit(store, await session.finalize());
  assert.equal((await store.load(LOC, asId('loc-1')))?.data.active, true);
});

test('a parent-load failure voids the batch atomically', async () => {
  const { store } = createTestMemoryStorage();
  const table = tableWith([hook('guard', ['create'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    const read = await ctx.loadParent(LOC, asId('loc-1'), 'decision');
    if (read.row.data.active !== true) throw new StateError('rule_failed', 'Parent is not active.');
    return candidate;
  })]);
  const revision = await store.readRevision();
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, { op: 'create', model: SITE, id: asId('site-1'), data: { region: 'eu' } });
  await stage(session, locationCreate('loc-1', { active: false, timezone: 'UTC' }));
  await assert.rejects(stage(session, readingCreate('read-1', 'loc-1')), /Parent is not active\./);
  await assert.rejects(session.finalize(), /poisoned/);
  assert.equal(await store.readRevision(), revision);
  assert.equal(await store.load(LOC, asId('loc-1')), null);
});

test('value-site loads serve the exact row with every data field withheld', async () => {
  const { store } = createTestMemoryStorage();
  const table = tableWith([hook('value', ['create'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    const read = await ctx.loadParent(LOC, asId('loc-1'), 'value');
    assert.equal(read.model, LOC);
    assert.equal(read.row.data.active, true);
    assert.equal(read.row.data.timezone, 'UTC');
    // State holds no caller read grants: every data field stays withheld
    // until the host viewer projection narrows the baseline per caller.
    assert.deepEqual([...read.withheld].sort(), ['active', 'timezone']);
    assert.ok(Object.isFrozen(read.row));
    // The same row at decision site carries nothing withheld.
    const decision = await ctx.loadParent(LOC, asId('loc-1'), 'decision');
    assert.deepEqual([...decision.withheld], []);
    assert.deepEqual({ ...decision.row.data }, { ...read.row.data });
    return candidate;
  })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, { op: 'create', model: SITE, id: asId('site-1'), data: { region: 'eu' } });
  await stage(session, locationCreate('loc-1', { active: true, timezone: 'UTC' }));
  await stage(session, readingCreate('read-1', 'loc-1'));
  await commit(store, await session.finalize());
});

test('value projection serves granted fields and refuses withheld precisely', async () => {
  const row = {
    id: asId('loc-1'), version: 1 as RecordVersion, created: 1, updated: 1,
    createdBy: 'tester', updatedBy: 'tester', archivedAt: null,
    parent: { model: SITE, id: asId('site-1') }, data: { active: true, timezone: 'UTC' },
  } as unknown as StoredRow;
  const projected = projectOwnerHookParentRow({ row, withheld: new Set(['timezone']) });
  assert.equal((projected.data as Record<string, unknown>).active, true);
  // Withheld reads throw the exact navigation denial — never a null-mask.
  assert.throws(() => (projected.data as Record<string, unknown>).timezone,
    (error: unknown) => {
      assert.ok(error instanceof StateError);
      assert.equal(error.code, 'forbidden');
      assert.equal(error.message, 'Record field is not readable.');
      return true;
    });
});

test('malformed parent reads refuse before touching storage', async () => {
  const { store } = createTestMemoryStorage();
  const table = tableWith([hook('malformed', ['create'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    await assert.rejects(ctx.loadParent(LOC, asId('loc-1'), 'bogus' as 'decision'),
      /Hook parent read requires its decision or value site\./);
    await assert.rejects(ctx.loadParent(asModel('Acme.Missing'), asId('loc-1'), 'decision'),
      /Owner mutation reads require a known model and record identity\./);
    await assert.rejects(ctx.loadParent(LOC, '' as unknown as RecordId, 'decision'),
      /Owner mutation reads require a known model and record identity\./);
    return candidate;
  })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, { op: 'create', model: SITE, id: asId('site-1'), data: { region: 'eu' } });
  await stage(session, locationCreate('loc-1', { active: true, timezone: 'UTC' }));
  await stage(session, readingCreate('read-1', 'loc-1'));
  await commit(store, await session.finalize());
});

test('non-ancestor reads refuse without distinguishing the miss', async () => {
  const { store } = createTestMemoryStorage();
  const table = tableWith([hook('bounds', ['create'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    // The trigger itself is not its own parent.
    await assert.rejects(ctx.loadParent(READ, asId('read-1'), 'decision'),
      /Hook parent read exceeds its trigger containment bound\./);
    // A foreign root is outside the trigger containment.
    await assert.rejects(ctx.loadParent(OTHER, asId('other-1'), 'decision'),
      /Hook parent read exceeds its trigger containment bound\./);
    // A guessed id on the genuine parent model stays refused identically.
    await assert.rejects(ctx.loadParent(LOC, asId('loc-guessed'), 'decision'),
      /Hook parent read exceeds its trigger containment bound\./);
    return candidate;
  })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, { op: 'create', model: SITE, id: asId('site-1'), data: { region: 'eu' } });
  await stage(session, { op: 'create', model: OTHER, id: asId('other-1'), data: { note: 'x' } });
  await stage(session, locationCreate('loc-1', { active: true, timezone: 'UTC' }));
  await stage(session, readingCreate('read-1', 'loc-1'));
  await commit(store, await session.finalize());
});

test('a parentless trigger has no parent chain to read', async () => {
  const { store } = createTestMemoryStorage();
  const rootTable = buildModelTable([
    modelDef('Acme.Site', { fields: { region: field() },
      hooks: [hook('root', ['create'], async (candidate, ctx) => {
        assertOwnerMutationHookContext(ctx);
        await assert.rejects(ctx.loadParent(SITE, asId('site-1'), 'decision'),
          /Hook parent read exceeds its trigger containment bound\./);
        return candidate;
      })] }),
  ]);
  const session = await beginOwnerMutation({ table: rootTable, store,
    context: pipelineContext({ operation: 'Acme.Site.create' }), bounds });
  await stage(session, { op: 'create', model: SITE, id: asId('site-1'), data: { region: 'eu' } });
  await commit(store, await session.finalize());
});

test('grandparent loads walk the exact chain; off-chain ids refuse', async () => {
  const { store } = createTestMemoryStorage();
  const seen: unknown[] = [];
  const table = tableWith([hook('grandparent', ['create'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    const parent = await ctx.loadParent(LOC, asId('loc-1'), 'decision');
    assert.deepEqual(parent.row.parent, { model: SITE, id: 'site-1' });
    const grandparent = await ctx.loadParent(SITE, asId('site-1'), 'decision');
    seen.push(grandparent.row.data.region);
    await assert.rejects(ctx.loadParent(SITE, asId('site-guessed'), 'decision'),
      /Hook parent read exceeds its trigger containment bound\./);
    return candidate;
  })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, { op: 'create', model: SITE, id: asId('site-1'), data: { region: 'eu' } });
  await stage(session, locationCreate('loc-1', { active: true, timezone: 'UTC' }));
  await stage(session, readingCreate('read-1', 'loc-1'));
  assert.deepEqual(seen, ['eu']);
  await commit(store, await session.finalize());
});

test('decision loads observe the archived parent row as authority truth', async () => {
  const { store } = createTestMemoryStorage();
  const seen: Array<{ active: unknown; archived: unknown }> = [];
  const table = tableWith([hook('archived-parent', ['update'], async (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    const read = await ctx.loadParent(LOC, asId('loc-1'), 'decision');
    seen.push({ active: read.row.data.active, archived: read.row.archivedAt !== null });
    return candidate;
  })]);
  const setup = await beginOwnerMutation({ table, store,
    context: pipelineContext({ operation: 'Acme.Location.create' }), bounds });
  await stage(setup, { op: 'create', model: SITE, id: asId('site-1'), data: { region: 'eu' } });
  await stage(setup, locationCreate('loc-1', { active: false, timezone: 'UTC' }));
  await stage(setup, readingCreate('read-1', 'loc-1'));
  await commit(store, await setup.finalize());
  // Archive (default delete mode) keeps the row: children stay live and the
  // decision load still observes the archived authority row.
  const archive = await beginOwnerMutation({ table, store,
    context: pipelineContext({ operation: 'Acme.Location.delete' }), bounds });
  await stage(archive, { op: 'remove', model: LOC, id: asId('loc-1') });
  await commit(store, await archive.finalize());
  assert.notEqual((await store.load(LOC, asId('loc-1')))?.archivedAt, null);
  const update = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(update, { op: 'update', model: READ, id: asId('read-1'), data: { taken: false } });
  assert.deepEqual(seen, [{ active: false, archived: true }]);
  await commit(store, await update.finalize());
});

test('the loader closes with its hook scope', async () => {
  const { store } = createTestMemoryStorage();
  let retained: OwnerMutationHookParentReads['load'] | undefined;
  const table = tableWith([hook('retain', ['create'], (candidate, ctx) => {
    assertOwnerMutationHookContext(ctx);
    retained = ctx.loadParent;
    return candidate;
  })]);
  const session = await beginOwnerMutation({ table, store, context: context(), bounds });
  await stage(session, { op: 'create', model: SITE, id: asId('site-1'), data: { region: 'eu' } });
  await stage(session, locationCreate('loc-1', { active: true, timezone: 'UTC' }));
  await stage(session, readingCreate('read-1', 'loc-1'));
  await commit(store, await session.finalize());
  assert.ok(retained !== undefined);
  await assert.rejects(retained!(LOC, asId('loc-1'), 'decision'), /Owner hook scope is closed\./);
});
