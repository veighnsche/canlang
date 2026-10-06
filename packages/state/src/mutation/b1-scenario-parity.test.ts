/**
 * B1 scenario-parity proofs (colocated): the pipeline agreements the
 * scenario seam needs to match the CRUD path verdict-for-verdict.
 *
 * - `gateArchivedTargets`: scenario-staged writes bypass per-write
 *   admission, so gated pipeline calls enforce admission's EXACT
 *   archived-target rule (CRUD inherits it from admission). Ungated
 *   (default) calls keep privileged archived-row access for
 *   migrations/backfill.
 * - Same-batch unique netting: self-canceling batches (create+remove,
 *   update+remove one id) drop the removed row's staged claims and free
 *   its first-touch (committed) keys — no dangling claims, no stranded
 *   committed keys. Single-touch removes are byte-identical to before.
 * - Resolved-default collision guard: same-named defaulted fields across
 *   writes in one batch reject LOUD (`validation`) before anything
 *   commits — flat receipts cannot attribute two resolutions of one
 *   name, so colliding batches never persist silently.
 *
 * Memory store + hand-built tables throughout (agreement MECHANISM proofs);
 * generated-descriptor CRUD-vs-scenario agreement rides in
 * b1-generated-parity.test.ts, durable substrates in
 * b1-scenario-parity-durable.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelName, RecordId } from '../../../contracts/src/state.js';
import { runMutationWrites, type MutationWritesResult } from './pipeline.js';
import { buildModelTable, type InterimFieldDef } from './models.js';
import { admit } from '../invocation/admission.js';
import { crudDefs } from './crud.js';
import { storageToStateError } from '../errors.js';
import { StorageConstraintError } from '../storage/port.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import {
  FIXED_NOW,
  asModel,
  captureStateError,
  makeBatch,
  seedRow,
} from '../../test/invocation/fixtures.js';
import {
  field,
  hook,
  modelDef,
  pipelineContext,
} from '../../test/mutation/fixtures.js';

const APP_OP = 'Acme.scenarioBatch';
const GADGET = asModel('Acme.Gadget');
const WIDGET = asModel('Acme.Widget');

function gadgetTable() {
  return buildModelTable([
    modelDef('Acme.Gadget', {
      fields: { title: field() },
      uniqueKeys: ['title'],
      deleteMode: 'remove',
    }),
    modelDef('Acme.Widget', {
      fields: { title: field() },
      uniqueKeys: ['title'],
      deleteMode: 'remove',
    }),
  ]);
}

function ctx() {
  return pipelineContext({ operation: APP_OP });
}

/** Commit pipeline output at the store's current revision (all parts). */
async function commitOutput(
  store: ReturnType<typeof createTestMemoryStorage>['store'],
  output: MutationWritesResult,
): Promise<void> {
  const revision = await store.readRevision();
  await store.commit(
    makeBatch(revision as number, {
      writes: [...output.writes],
      history: [...output.history],
      uniqueClaims: [...output.uniqueClaims],
      uniqueReleases: [...output.uniqueReleases],
    }),
  );
}

describe('B1 scenario parity: archived-target gating', () => {
  it('gated updates on archived rows report admission\'s exact verdict', async () => {
    const { store } = createTestMemoryStorage();
    const table = gadgetTable();
    await seedRow(store, GADGET, { id: 'g-1', archivedAt: FIXED_NOW, data: { title: 'old' } });
    const error = await captureStateError(
      runMutationWrites({
        table,
        writes: [{ op: 'update', model: GADGET, id: 'g-1' as RecordId, data: { title: 'new' } }],
        context: ctx(),
        store,
        gateArchivedTargets: true,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.equal(error.message, 'Archived records cannot be used here.');
  });

  it('gated hard removes on archived rows report admission\'s exact verdict', async () => {
    const { store } = createTestMemoryStorage();
    const table = gadgetTable();
    await seedRow(store, GADGET, { id: 'g-1', archivedAt: FIXED_NOW, data: { title: 'old' } });
    const error = await captureStateError(
      runMutationWrites({
        table,
        writes: [{ op: 'remove', model: GADGET, id: 'g-1' as RecordId }],
        context: ctx(),
        store,
        gateArchivedTargets: true,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.equal(error.message, 'Archived records cannot be used here.');
  });

  it('gated archive-mode removes report the admission verdict, not already-archived', async () => {
    const { store } = createTestMemoryStorage();
    const table = buildModelTable([
      modelDef('Acme.Gadget', { fields: { title: field() }, deleteMode: 'archive' }),
    ]);
    await seedRow(store, GADGET, { id: 'g-1', archivedAt: FIXED_NOW, data: { title: 'old' } });
    // CRUD parity: admission rejects archived targets before execution, so
    // the CRUD path never reports `already archived` for them either — the
    // gated scenario path must agree with the admission verdict.
    const error = await captureStateError(
      runMutationWrites({
        table,
        writes: [{ op: 'remove', model: GADGET, id: 'g-1' as RecordId }],
        context: ctx(),
        store,
        gateArchivedTargets: true,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.equal(error.message, 'Archived records cannot be used here.');
  });

  it('ungated pipeline calls keep privileged archived-row access', async () => {
    const { store } = createTestMemoryStorage();
    const table = gadgetTable();
    await seedRow(store, GADGET, { id: 'g-1', archivedAt: FIXED_NOW, data: { title: 'old' } });
    // Default (flag absent): migrations/backfill may touch archived rows.
    const updated = await runMutationWrites({
      table,
      writes: [{ op: 'update', model: GADGET, id: 'g-1' as RecordId, data: { title: 'new' } }],
      context: ctx(),
      store,
    });
    assert.equal(updated.writes.length, 1);
    await commitOutput(store, updated);
    const removed = await runMutationWrites({
      table,
      writes: [{ op: 'remove', model: GADGET, id: 'g-1' as RecordId }],
      context: ctx(),
      store,
    });
    assert.equal(removed.writes.length, 1);
    assert.equal(removed.writes[0]?.kind, 'remove');
  });

  it('gated verdicts equal admission verdicts for the same target', async () => {
    const { store } = createTestMemoryStorage();
    const table = gadgetTable();
    await seedRow(store, GADGET, { id: 'g-1', archivedAt: FIXED_NOW, data: { title: 'old' } });
    const memberships = { findMembership: async () => null };
    const defs = crudDefs(GADGET, { by: 'public' });
    // Admission's own verdict for an archived update target, verbatim
    // (ref versions ride the canonical string spelling).
    const admitted = await captureStateError(
      admit({
        def: defs.update,
        inputs: { ref: { id: 'g-1', version: '1' }, patch: { title: 'new' } },
        context: ctx(),
        store,
        memberships,
      }),
    );
    const gated = await captureStateError(
      runMutationWrites({
        table,
        writes: [{ op: 'update', model: GADGET, id: 'g-1' as RecordId, data: { title: 'new' } }],
        context: ctx(),
        store,
        gateArchivedTargets: true,
      }),
    );
    assert.equal(gated.code, admitted.code);
    assert.equal(gated.message, admitted.message);
  });
});

describe('B1 scenario parity: same-batch unique netting', () => {
  it('create+remove one id nets to no unique touches', async () => {
    const { store } = createTestMemoryStorage();
    const table = gadgetTable();
    const output = await runMutationWrites({
      table,
      writes: [
        { op: 'create', model: GADGET, id: 'g-1' as RecordId, data: { title: 'k' } },
        { op: 'remove', model: GADGET, id: 'g-1' as RecordId },
      ],
      context: ctx(),
      store,
    });
    assert.deepEqual(output.uniqueClaims, []);
    assert.deepEqual(output.uniqueReleases, []);
    // The batch itself still fails at commit by the settled double-touch
    // rule (adapters pre-check expectedVersion against stored state on
    // every backend): netting keeps the OUTPUT self-consistent for
    // inspection/retry paths, and unique divergence can never persist
    // because the commit never lands.
    const revision = await store.readRevision();
    let constraint: unknown = null;
    try {
      await commitOutput(store, output);
    } catch (error) {
      constraint = error;
    }
    assert.ok(constraint instanceof StorageConstraintError);
    assert.equal(constraint.kind, 'version');
    const failure = storageToStateError(constraint);
    assert.equal(failure.code, 'conflict');
    assert.equal(await store.readRevision(), revision);
  });

  it('update+remove frees the committed key and never claims the provisional one', async () => {
    const { store } = createTestMemoryStorage();
    const table = gadgetTable();
    await seedRow(store, GADGET, { id: 'g-1', data: { title: 'k1' } });
    const seeded = await store.readRevision();
    await store.commit(
      makeBatch(seeded as number, {
        uniqueClaims: [{ model: GADGET, keyName: 'title', keyValue: 'k1', recordId: 'g-1' as RecordId }],
      }),
    );
    const output = await runMutationWrites({
      table,
      writes: [
        { op: 'update', model: GADGET, id: 'g-1' as RecordId, data: { title: 'k2' } },
        { op: 'remove', model: GADGET, id: 'g-1' as RecordId },
      ],
      context: ctx(),
      store,
    });
    // The provisional k2 claim is dropped (the row is gone); the committed
    // k1 key is freed (twice: the update's release plus the remove's
    // first-touch release — releases are idempotent).
    assert.deepEqual(output.uniqueClaims, []);
    assert.ok(output.uniqueReleases.length >= 1);
    for (const release of output.uniqueReleases) {
      assert.equal(release.keyValue, 'k1');
    }
    // Double-touch batches fail at commit by the settled version rule —
    // the netted output above is what inspection/retry paths observe.
    const revision = await store.readRevision();
    let constraint: unknown = null;
    try {
      await commitOutput(store, output);
    } catch (error) {
      constraint = error;
    }
    assert.ok(constraint instanceof StorageConstraintError);
    assert.equal(constraint.kind, 'version');
    assert.equal(await store.readRevision(), revision);
  });

  it('single-touch removes release exactly the committed keys', async () => {
    const { store } = createTestMemoryStorage();
    const table = gadgetTable();
    await seedRow(store, GADGET, { id: 'g-1', data: { title: 'k1' } });
    const output = await runMutationWrites({
      table,
      writes: [{ op: 'remove', model: GADGET, id: 'g-1' as RecordId }],
      context: ctx(),
      store,
    });
    assert.deepEqual(output.uniqueClaims, []);
    assert.deepEqual(output.uniqueReleases, [
      { model: GADGET, keyName: 'title', keyValue: 'k1' },
    ]);
  });

  it('multi-row batches keep other rows touches intact', async () => {
    const { store } = createTestMemoryStorage();
    const table = gadgetTable();
    await seedRow(store, GADGET, { id: 'g-1', data: { title: 'ka' } });
    const output = await runMutationWrites({
      table,
      writes: [
        { op: 'remove', model: GADGET, id: 'g-1' as RecordId },
        { op: 'create', model: WIDGET, id: 'w-1' as RecordId, data: { title: 'kb' } },
      ],
      context: ctx(),
      store,
    });
    assert.deepEqual(output.uniqueReleases, [
      { model: GADGET, keyName: 'title', keyValue: 'ka' },
    ]);
    assert.deepEqual(output.uniqueClaims, [
      { model: WIDGET, keyName: 'title', keyValue: 'kb', recordId: 'w-1' as RecordId },
    ]);
    await commitOutput(store, output);
    assert.equal(await store.load(GADGET, 'g-1' as RecordId), null);
    assert.equal((await store.load(WIDGET, 'w-1' as RecordId))?.data['title'], 'kb');
  });
});

describe('B1 scenario parity: resolved-default collision guard', () => {
  const tagged: InterimFieldDef = { required: false, serverOnly: false, default: 'tag' };

  it('same-named literal defaults across two creates reject loud', async () => {
    const { store } = createTestMemoryStorage();
    const table = buildModelTable([
      modelDef('Acme.Gadget', { fields: { tag: { ...tagged, default: 'g' } } }),
      modelDef('Acme.Widget', { fields: { tag: { ...tagged, default: 'w' } } }),
    ]);
    const error = await captureStateError(
      runMutationWrites({
        table,
        writes: [
          { op: 'create', model: GADGET, id: 'g-1' as RecordId, data: {} },
          { op: 'create', model: WIDGET, id: 'w-1' as RecordId, data: {} },
        ],
        context: ctx(),
        store,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /Resolved-default collision in one mutation batch/);
    assert.match(error.message, /"tag"/);
    // Both writers are named for attribution.
    assert.match(error.message, /create Acme\.Gadget g-1/);
    assert.match(error.message, /create Acme\.Widget w-1/);
    // Nothing committed: the batch voids before any receipt is written.
    assert.equal(await store.readRevision(), 0);
  });

  it('same-model double creates with server inits reject loud', async () => {
    const { store } = createTestMemoryStorage();
    const stamped: InterimFieldDef = { required: false, serverOnly: true, server: 'now' };
    const table = buildModelTable([
      modelDef('Acme.Gadget', { fields: { stampedAt: stamped } }),
    ]);
    const error = await captureStateError(
      runMutationWrites({
        table,
        writes: [
          { op: 'create', model: GADGET, id: 'g-1' as RecordId, data: {} },
          { op: 'create', model: GADGET, id: 'g-2' as RecordId, data: {} },
        ],
        context: ctx(),
        store,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /"stampedAt"/);
    assert.equal(await store.readRevision(), 0);
  });

  it('single writes and disjoint batches resolve normally', async () => {
    const { store } = createTestMemoryStorage();
    const table = buildModelTable([
      modelDef('Acme.Gadget', { fields: { tag: tagged } }),
      modelDef('Acme.Widget', { fields: { label: { ...tagged, default: 'w' } } }),
    ]);
    const single = await runMutationWrites({
      table,
      writes: [{ op: 'create', model: GADGET, id: 'g-1' as RecordId, data: {} }],
      context: ctx(),
      store,
    });
    assert.deepEqual(single.resolvedDefaults, { tag: 'tag' });
    const disjoint = await runMutationWrites({
      table,
      writes: [
        { op: 'create', model: GADGET, id: 'g-2' as RecordId, data: {} },
        { op: 'create', model: WIDGET, id: 'w-1' as RecordId, data: {} },
      ],
      context: ctx(),
      store,
    });
    assert.deepEqual(disjoint.resolvedDefaults, { tag: 'tag', label: 'w' });
  });

  it('hook-staged writes join the same collision scope', async () => {
    const { store } = createTestMemoryStorage();
    const staging = hook('stage-widget', ['create'], (candidate, hookCtx) => {
      hookCtx.stage({ op: 'create', model: WIDGET, id: 'w-1' as RecordId, data: {} });
      return candidate;
    });
    const table = buildModelTable([
      modelDef('Acme.Gadget', { fields: { tag: tagged }, hooks: [staging] }),
      modelDef('Acme.Widget', { fields: { tag: { ...tagged, default: 'w' } } }),
    ]);
    // One caller write, but the staged secondary resolves the same name —
    // the receipt still cannot attribute two resolutions, so it rejects.
    const error = await captureStateError(
      runMutationWrites({
        table,
        writes: [{ op: 'create', model: GADGET, id: 'g-1' as RecordId, data: {} }],
        context: ctx(),
        store,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /Resolved-default collision in one mutation batch/);
    assert.match(error.message, /"tag"/);
  });

  it('nullable fills and array empties join the same guard', async () => {
    const { store } = createTestMemoryStorage();
    const maybe: InterimFieldDef = { required: false, serverOnly: false, nullable: true };
    const table = buildModelTable([
      modelDef('Acme.Gadget', { fields: { note: maybe } }),
      modelDef('Acme.Widget', { fields: { note: maybe } }),
    ]);
    const error = await captureStateError(
      runMutationWrites({
        table,
        writes: [
          { op: 'create', model: GADGET, id: 'g-1' as RecordId, data: {} },
          { op: 'create', model: WIDGET, id: 'w-1' as RecordId, data: {} },
        ],
        context: ctx(),
        store,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /"note"/);
  });
});
