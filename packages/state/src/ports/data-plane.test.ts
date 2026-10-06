/**
 * T17a data-plane migration tests (colocated): generated create/update/
 * delete/query persist end to end through the canonical engine — bound
 * mutation/read ports (`createInvoker`/`createReadInvoker`, the exact T17b
 * consumption surface), canonical admission, the mutation pipeline, fenced
 * commits with receipts/history, and viewer projection.
 *
 * Covers the T17a proof matrix: migration positives, rollback (execute-
 * time and commit-time), no-change stability, duplicate delivery
 * (replay, concurrent exactly-once, conflicting reuse), stale conflicts,
 * unchanged-state negatives, replay identity, history reproduction, and
 * retirement pins (interim engine retained and serving; interim input
 * validation retired onto the canonical validator with an equivalence
 * matrix). Durable-substrate proofs live in `storage/data-plane-durable`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ArtifactModel,
  ArtifactModelField,
  ArtifactOperation,
  ArtifactOperationInput,
} from '@canlang/contracts';
import type {
  HistoryEntry,
  OutboxIntent,
  QueryPredicate,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import {
  loadArtifactDescriptors,
  type ArtifactDescriptorSlice,
  type LoadDescriptorSetOptions,
} from '../invocation/registry.js';
import { validateCallInputs } from '../invocation/admission.js';
import {
  buildModelTable,
  buildModelTableFromCanonical,
  type ModelTable,
} from '../mutation/models.js';
import { crudDefs, crudExecute, generatedCrudExecute } from '../mutation/crud.js';
import { createInvoker, createReadInvoker } from './transact.js';
import { createTestMemoryStorage, type MemoryStoreProbe } from '../storage/memory.js';
import { buildPolicyTable, type PolicyTable } from '../policy/grants.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  asOperation,
  asOperationId,
  captureStateError,
  createMemoryIdentityStore,
  fieldPaths,
  makeDef,
  makeEnvelope,
  makeIdentity,
  seedMember,
  uuidv7,
  type SeededMember,
  type TestMembershipStore,
} from '../../test/invocation/fixtures.js';

const APP = 'acme-app';
const GADGET = 'Shop.Gadget';
const KEEPER = 'Shop.Keeper';

function scalarInput(name: string, kind: 'string' | 'integer', required: boolean) {
  return { name, field: { kind }, required } as ArtifactOperationInput;
}

function refInput(name: string, model: string, requireVersion: boolean): ArtifactOperationInput {
  return { name, field: { kind: 'ref', model, requireVersion }, required: true };
}

function modelField(
  name: string,
  field: ArtifactModelField['field'],
  opts: { required?: boolean; default?: ArtifactModelField['default'] } = {},
): ArtifactModelField {
  return {
    name,
    field,
    required: opts.required ?? false,
    serverOnly: false,
    ...(opts.default !== undefined ? { default: opts.default } : {}),
  };
}

function planeSlice(): ArtifactDescriptorSlice {
  const gadget: ArtifactModel = {
    name: GADGET,
    fields: [
      modelField('title', { kind: 'string' }, { required: true }),
      modelField('stock', { kind: 'integer' }, { default: { kind: 'literal', value: '0' } }),
      modelField('code', { kind: 'string' }, { required: true }),
    ],
    deleteMode: 'archive',
    uniqueKeys: ['code'],
  };
  const keeper: ArtifactModel = {
    name: KEEPER,
    fields: [modelField('name', { kind: 'string' }, { required: true })],
    deleteMode: 'remove',
  };
  const gadgetInputs: ArtifactOperationInput[] = [
    scalarInput('title', 'string', true),
    scalarInput('stock', 'integer', false),
    scalarInput('code', 'string', true),
  ];
  return {
    artifact_version: 1,
    operations: [
      { name: `${GADGET}.create`, kind: 'create', description: '', inputs: { fields: gadgetInputs } },
      {
        name: `${GADGET}.update`,
        kind: 'update',
        description: '',
        inputs: {
          fields: [
            refInput('record', GADGET, true),
            ...gadgetInputs.map((field) => ({ ...field, required: false })),
          ],
        },
      },
      {
        name: `${GADGET}.delete`,
        kind: 'delete',
        description: '',
        inputs: { fields: [refInput('record', GADGET, true)] },
      },
      { name: `${GADGET}.read`, kind: 'read', description: '', inputs: { fields: [] } },
      {
        name: `${KEEPER}.create`,
        kind: 'create',
        description: '',
        inputs: { fields: [scalarInput('name', 'string', true)] },
      },
      {
        name: `${KEEPER}.delete`,
        kind: 'delete',
        description: '',
        inputs: { fields: [refInput('record', KEEPER, true)] },
      },
      { name: `${KEEPER}.read`, kind: 'read', description: '', inputs: { fields: [] } },
    ],
    models: [gadget, keeper],
  };
}

interface PlaneSetup {
  store: StoragePort;
  probe: MemoryStoreProbe;
  memberships: TestMembershipStore;
  alice: SeededMember;
  table: ModelTable;
  policy: PolicyTable;
  registry: ReturnType<typeof loadArtifactDescriptors>['registry'];
  mutate: (
    operation: string,
    inputs: Record<string, unknown>,
    opts?: { identity?: ReturnType<typeof makeIdentity>; operationId?: string },
  ) => Promise<{ status: string; operation_id: string; result: unknown }>;
  read: (
    operation: string,
    opts?: { identity?: ReturnType<typeof makeIdentity> },
  ) => Promise<{ records: Array<{ id: unknown; data: Record<string, unknown> }>; revision: number }>;
}

async function setupPlane(when?: LoadDescriptorSetOptions['when']): Promise<PlaneSetup> {
  const { store, probe } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const loaded = loadArtifactDescriptors(planeSlice(), {
    by: 'members',
    ...(when !== undefined ? { when } : {}),
  });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
  const policy = buildPolicyTable([
    {
      model: asModel(GADGET),
      secretFields: [],
      grants: [{ by: 'members', fields: ['title', 'code', 'stock'] }],
    },
    {
      model: asModel(KEEPER),
      secretFields: [],
      grants: [{ by: 'members', fields: ['name'] }],
    },
  ]);
  const execute = generatedCrudExecute({ table, store });
  const invoker = createInvoker({
    registry: loaded.registry,
    store,
    memberships,
    clock: { nowMs: () => FIXED_NOW },
  });
  const reader = createReadInvoker({ registry: loaded.registry, policy, store, memberships });
  const identity = makeIdentity({ membership: alice.membership, email: alice.user.email });
  let seq = 7000;
  return {
    store,
    probe,
    memberships,
    alice,
    table,
    policy,
    registry: loaded.registry,
    mutate: async (operation, inputs, opts = {}) => {
      const operationId = opts.operationId ?? uuidv7(FIXED_NOW, (seq += 1));
      const result = await invoker({
        envelope: makeEnvelope(operation, operationId, inputs),
        identity: opts.identity ?? identity,
        app: APP,
        source: 'test',
        execute,
      });
      return {
        status: result.status,
        operation_id: result.operation_id as string,
        result: result.result,
      };
    },
    read: async (operation, opts = {}) => {
      const served = await reader({
        envelope: { operation, inputs: {} },
        identity: opts.identity ?? identity,
      });
      return {
        records: served.records.map((record) => ({ id: record.id, data: record.data })),
        revision: served.revision as number,
      };
    },
  };
}

/** Full domain snapshot (rows + history + outbox) for no-change proofs. */
async function snapshotDomain(
  setup: PlaneSetup,
  models: ReadonlyArray<string>,
): Promise<{
  rows: Record<string, StoredRow[]>;
  history: Record<string, ReadonlyArray<HistoryEntry>>;
  outbox: ReadonlyArray<OutboxIntent>;
}> {
  const rows: Record<string, StoredRow[]> = {};
  const history: Record<string, ReadonlyArray<HistoryEntry>> = {};
  for (const model of models) {
    const found = await setup.store.query({ model: asModel(model), authority: 'owner' });
    const sorted = [...found].sort((a, b) => ((a.id as string) < (b.id as string) ? -1 : 1));
    rows[model] = sorted;
    for (const row of sorted) {
      history[`${model}/${row.id as string}`] = setup.probe.historyFor(asModel(model), row.id);
    }
  }
  return { rows, history, outbox: setup.probe.outboxAll() };
}

describe('T17a data plane: migrated positives', () => {
  it('creates, reads, updates, deletes, and replays through the bound ports', async () => {
    const setup = await setupPlane();
    const created = await setup.mutate(`${GADGET}.create`, { title: 'drill', code: 'E-1' });
    assert.equal(created.status, 'committed');
    const id = (created.result as StoredRow).id as string;
    assert.equal(id, created.operation_id);

    const seen = await setup.read(`${GADGET}.read`);
    assert.equal(seen.revision, 1);
    assert.deepEqual(seen.records, [{ id, data: { title: 'drill', code: 'E-1', stock: '0' } }]);

    const updated = await setup.mutate(`${GADGET}.update`, {
      record: { id, version: '1' },
      stock: '7',
    });
    assert.equal(updated.status, 'committed');
    assert.equal((updated.result as StoredRow).version, 2);

    const removed = await setup.mutate(`${GADGET}.delete`, {
      record: { id, version: '2' },
    });
    assert.equal(removed.status, 'committed');
    assert.equal((removed.result as StoredRow).archivedAt, FIXED_NOW);

    const afterDelete = await setup.read(`${GADGET}.read`);
    assert.equal(afterDelete.revision, 3);
    assert.deepEqual(afterDelete.records, []);

    // Receipts persisted under the canonical identity for every commit.
    for (const [operation, operationId] of [
      [`${GADGET}.create`, created.operation_id],
      [`${GADGET}.update`, updated.operation_id],
      [`${GADGET}.delete`, removed.operation_id],
    ] as const) {
      const receipt = await setup.store.readReceipt({
        app: APP,
        owner: setup.alice.team.team_id,
        principal: setup.alice.user.user_id,
        operation: asOperation(operation),
        operationId: asOperationId(operationId),
      });
      assert.ok(receipt);
      assert.equal(receipt.outcome.status, 'committed');
    }
    // History reproduces the full trail with dense revisions.
    const trail = setup.probe.historyFor(asModel(GADGET), asId(id));
    assert.deepEqual(
      trail.map((entry) => [entry.change, entry.version, entry.operationId]),
      [
        ['create', 1, created.operation_id],
        ['update', 2, updated.operation_id],
        ['archive', 3, removed.operation_id],
      ],
    );
    assert.deepEqual(trail[0]?.before, null);
    assert.deepEqual(trail[2]?.after, (removed.result as StoredRow).data);
  });

  it('honors remove deleteMode end to end with hard-row disappearance', async () => {
    const setup = await setupPlane();
    const created = await setup.mutate(`${KEEPER}.create`, { name: 'rita' });
    const id = (created.result as StoredRow).id as string;
    const beforeDelete = await setup.read(`${KEEPER}.read`);
    assert.equal(beforeDelete.records.length, 1);
    const removed = await setup.mutate(`${KEEPER}.delete`, {
      record: { id, version: '1' },
    });
    assert.equal(removed.result, null);
    assert.equal(await setup.store.load(asModel(KEEPER), asId(id)), null);
    const afterDelete = await setup.read(`${KEEPER}.read`);
    assert.deepEqual(afterDelete.records, []);
    const trail = setup.probe.historyFor(asModel(KEEPER), asId(id));
    assert.deepEqual(
      trail.map((entry) => entry.change),
      ['create', 'remove'],
    );
    assert.deepEqual(trail[1]?.after, null);
  });
});

describe('T17a data plane: rollback and no-change stability', () => {
  it('rolls execute-time rejections back to domain/history/outbox with a receipt only', async () => {
    const when: QueryPredicate = { op: 'eq', field: 'stock', value: '0' };
    const setup = await setupPlane((op) =>
      (op.name as string) === `${GADGET}.update` ? when : undefined,
    );
    const created = await setup.mutate(`${GADGET}.create`, {
      title: 'drill',
      code: 'W-1',
      stock: '5',
    });
    const id = (created.result as StoredRow).id as string;
    const before = await snapshotDomain(setup, [GADGET]);
    const revisionBefore = await setup.store.readRevision();

    const operationId = uuidv7(FIXED_NOW, 7777);
    const failed = await captureStateError(
      setup.mutate(
        `${GADGET}.update`,
        { record: { id, version: '1' }, title: 'still-five' },
        { operationId },
      ),
    );
    assert.equal(failed.code, 'rule_failed');
    // Bookkeeping only: revision +1 for the rejected receipt; every domain
    // surface is byte-identical.
    assert.equal(await setup.store.readRevision(), (revisionBefore as number) + 1);
    assert.deepEqual(await snapshotDomain(setup, [GADGET]), before);
    const receipt = await setup.store.readReceipt({
      app: APP,
      owner: setup.alice.team.team_id,
      principal: setup.alice.user.user_id,
      operation: asOperation(`${GADGET}.update`),
      operationId: asOperationId(operationId),
    });
    assert.deepEqual(receipt?.outcome, {
      status: 'rejected',
      code: 'rule_failed',
      message: failed.message,
    });
  });

  it('rolls commit-time unique conflicts back with no receipt and no revision move', async () => {
    const setup = await setupPlane();
    await setup.mutate(`${GADGET}.create`, { title: 'a', code: 'K-1' });
    const before = await snapshotDomain(setup, [GADGET]);
    const revisionBefore = await setup.store.readRevision();

    const operationId = uuidv7(FIXED_NOW, 7778);
    const dupe = await captureStateError(
      setup.mutate(`${GADGET}.create`, { title: 'b', code: 'K-1' }, { operationId }),
    );
    assert.equal(dupe.code, 'conflict');
    // Store-level failure: nothing persisted at all.
    assert.equal(await setup.store.readRevision(), revisionBefore);
    assert.deepEqual(await snapshotDomain(setup, [GADGET]), before);
    assert.equal(
      await setup.store.readReceipt({
        app: APP,
        owner: setup.alice.team.team_id,
        principal: setup.alice.user.user_id,
        operation: asOperation(`${GADGET}.create`),
        operationId: asOperationId(operationId),
      }),
      null,
    );
  });

  it('keeps no-change updates stable and convergent', async () => {
    const setup = await setupPlane();
    const created = await setup.mutate(`${GADGET}.create`, { title: 'drill', code: 'N-1' });
    const id = (created.result as StoredRow).id as string;
    const firstData = (created.result as StoredRow).data;
    // Empty patch: commits cleanly, data identical, version advances.
    const noop = await setup.mutate(`${GADGET}.update`, { record: { id, version: '1' } });
    assert.equal(noop.status, 'committed');
    assert.equal((noop.result as StoredRow).version, 2);
    assert.deepEqual((noop.result as StoredRow).data, firstData);
    // Repeating the no-change write converges on the same data.
    const again = await setup.mutate(`${GADGET}.update`, {
      record: { id, version: '2' },
      title: 'drill',
    });
    assert.equal((again.result as StoredRow).version, 3);
    assert.deepEqual((again.result as StoredRow).data, firstData);
    const seen = await setup.read(`${GADGET}.read`);
    assert.deepEqual(seen.records, [
      { id, data: { title: 'drill', code: 'N-1', stock: '0' } },
    ]);
  });
});

describe('T17a data plane: duplicates, staleness, and negatives', () => {
  it('never double-applies duplicate delivery: replay, concurrent exactly-once, reuse conflict', async () => {
    const setup = await setupPlane();
    const operationId = uuidv7(FIXED_NOW, 7801);
    const inputs = { title: 'drill', code: 'X-1' };
    const first = await setup.mutate(`${GADGET}.create`, inputs, { operationId });
    assert.equal(first.status, 'committed');
    const revisionAfterCommit = await setup.store.readRevision();

    const replayed = await setup.mutate(`${GADGET}.create`, inputs, { operationId });
    assert.equal(replayed.status, 'replayed');
    assert.deepEqual(replayed.result, first.result);
    assert.equal(await setup.store.readRevision(), revisionAfterCommit);

    // Concurrent duplicates: the fence admits exactly one winner; the loser
    // retries into the winner's receipt and replays (never a second row).
    const raceId = uuidv7(FIXED_NOW, 7802);
    const raceInputs = { title: 'race', code: 'X-2' };
    const [winner, loser] = await Promise.all([
      setup.mutate(`${GADGET}.create`, raceInputs, { operationId: raceId }),
      setup.mutate(`${GADGET}.create`, raceInputs, { operationId: raceId }),
    ]);
    assert.deepEqual([winner.status, loser.status].sort(), ['committed', 'replayed']);
    const committed = winner.status === 'committed' ? winner : loser;
    const replayedRace = winner.status === 'replayed' ? winner : loser;
    assert.deepEqual(replayedRace.result, committed.result);
    const rows = await setup.store.query({ model: asModel(GADGET), authority: 'owner' });
    assert.equal(rows.filter((row) => (row.data as Record<string, unknown>)['code'] === 'X-2').length, 1);

    // Same identity, different inputs: conflicting reuse, never applied.
    const rowsBefore = rows.length;
    const conflict = await captureStateError(
      setup.mutate(`${GADGET}.create`, { title: 'changed', code: 'X-1' }, { operationId }),
    );
    assert.equal(conflict.code, 'conflict');
    assert.match(conflict.message, /Conflicting reuse/);
    assert.equal(
      (await setup.store.query({ model: asModel(GADGET), authority: 'owner' })).length,
      rowsBefore,
    );
  });

  it('conflicts stale revisions without touching the stored row', async () => {
    const setup = await setupPlane();
    const created = await setup.mutate(`${GADGET}.create`, { title: 'v1', code: 'S-1' });
    const id = (created.result as StoredRow).id as string;
    await setup.mutate(`${GADGET}.update`, { record: { id, version: '1' }, title: 'v2' });
    const before = await snapshotDomain(setup, [GADGET]);
    const revisionBefore = await setup.store.readRevision();

    const stale = await captureStateError(
      setup.mutate(`${GADGET}.update`, { record: { id, version: '1' }, title: 'stale' }),
    );
    assert.equal(stale.code, 'conflict');
    assert.equal(await setup.store.readRevision(), revisionBefore);
    assert.deepEqual(await snapshotDomain(setup, [GADGET]), before);
    const row = await setup.store.load(asModel(GADGET), asId(id));
    assert.equal(row?.version, 2);
    assert.equal((row?.data as Record<string, unknown>)['title'], 'v2');
  });

  it('mutates nothing on admission rejections: forbidden, validation, not_found, conflict', async () => {
    const setup = await setupPlane();
    const created = await setup.mutate(`${GADGET}.create`, { title: 'v1', code: 'Z-1' });
    const id = (created.result as StoredRow).id as string;
    const stranger = await seedMember(setup.memberships, { isOwner: false });
    const strangerIdentity = makeIdentity({
      membership: stranger.membership,
      teamId: setup.alice.team.team_id,
      email: stranger.user.email,
    });
    const before = await snapshotDomain(setup, [GADGET]);
    const revisionBefore = await setup.store.readRevision();
    let seq = 7900;

    const cases: Array<{
      name: string;
      operation: string;
      inputs: Record<string, unknown>;
      identity?: ReturnType<typeof makeIdentity>;
      code: string;
    }> = [
      {
        name: 'forbidden',
        operation: `${GADGET}.create`,
        inputs: { title: 'x', code: 'Z-2' },
        identity: strangerIdentity,
        code: 'forbidden',
      },
      {
        name: 'validation',
        operation: `${GADGET}.create`,
        inputs: { code: 'Z-3' },
        code: 'validation',
      },
      {
        name: 'not_found',
        operation: `${GADGET}.update`,
        inputs: { record: { id: 'ghost', version: '1' }, title: 'x' },
        code: 'not_found',
      },
      {
        name: 'conflict',
        operation: `${GADGET}.update`,
        inputs: { record: { id, version: '9' }, title: 'x' },
        code: 'conflict',
      },
    ];
    for (const rejection of cases) {
      const operationId = uuidv7(FIXED_NOW, (seq += 1));
      const error = await captureStateError(
        setup.mutate(rejection.operation, rejection.inputs, {
          operationId,
          ...(rejection.identity !== undefined ? { identity: rejection.identity } : {}),
        }),
      );
      assert.equal(error.code, rejection.code, rejection.name);
      // Admission rejections persist no receipt.
      const principal =
        rejection.identity === undefined ? setup.alice.user.user_id : stranger.user.user_id;
      assert.equal(
        await setup.store.readReceipt({
          app: APP,
          owner: setup.alice.team.team_id,
          principal,
          operation: asOperation(rejection.operation),
          operationId: asOperationId(operationId),
        }),
        null,
        rejection.name,
      );
    }
    assert.equal(await setup.store.readRevision(), revisionBefore);
    assert.deepEqual(await snapshotDomain(setup, [GADGET]), before);
  });

  it('replays committed and rejected outcomes identically with frozen history', async () => {
    const when: QueryPredicate = { op: 'eq', field: 'title', value: 'nope' };
    const setup = await setupPlane((op) =>
      (op.name as string) === `${GADGET}.update` ? when : undefined,
    );
    const createId = uuidv7(FIXED_NOW, 7951);
    const createInputs = { title: 'a', code: 'J-1' };
    const committed = await setup.mutate(`${GADGET}.create`, createInputs, {
      operationId: createId,
    });
    const id = (committed.result as StoredRow).id as string;

    const rejectId = uuidv7(FIXED_NOW, 7952);
    const rejectInputs = { record: { id, version: '1' }, title: 'b' };
    const rejected = await captureStateError(
      setup.mutate(`${GADGET}.update`, rejectInputs, { operationId: rejectId }),
    );
    assert.equal(rejected.code, 'rule_failed');

    const trailBefore = setup.probe.historyFor(asModel(GADGET), asId(id));
    const revisionBefore = await setup.store.readRevision();
    const replayedCommit = await setup.mutate(`${GADGET}.create`, createInputs, {
      operationId: createId,
    });
    assert.equal(replayedCommit.status, 'replayed');
    assert.deepEqual(replayedCommit.result, committed.result);
    const replayedRejection = await captureStateError(
      setup.mutate(`${GADGET}.update`, rejectInputs, { operationId: rejectId }),
    );
    assert.equal(replayedRejection.code, 'rule_failed');
    assert.equal(replayedRejection.message, rejected.message);
    assert.equal(await setup.store.readRevision(), revisionBefore);
    assert.deepEqual(setup.probe.historyFor(asModel(GADGET), asId(id)), trailBefore);
  });
});

describe('T17a data plane: retirement pins', () => {
  it('keeps the interim engine serving through the same bound port (retained, not retired)', async () => {
    const { store } = createTestMemoryStorage();
    const memberships = createMemoryIdentityStore();
    const alice = await seedMember(memberships, { isOwner: false });
    const table = buildModelTable([
      {
        model: asModel('Shop.Legacy'),
        fields: { title: { required: true, serverOnly: false } },
        refs: [],
        uniqueKeys: [],
        deleteMode: 'archive',
        hooks: [],
        invariants: [],
        locks: [],
      },
    ]);
    const defs = crudDefs(asModel('Shop.Legacy'), { by: 'members' });
    const invoker = createInvoker({
      registry: new Map([
        [defs.create.name as string, defs.create],
        [defs.update.name as string, defs.update],
        [defs.remove.name as string, defs.remove],
      ]),
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
    });
    const identity = makeIdentity({ membership: alice.membership, email: alice.user.email });
    const execute = crudExecute({ table, model: asModel('Shop.Legacy'), store });
    const created = await invoker({
      envelope: makeEnvelope('Shop.Legacy.create', uuidv7(FIXED_NOW, 8101), {
        id: 'legacy-1',
        data: { title: 'old' },
      }),
      identity,
      app: APP,
      source: 'test',
      execute,
    });
    assert.equal(created.status, 'committed');
    const updated = await invoker({
      envelope: makeEnvelope('Shop.Legacy.update', uuidv7(FIXED_NOW, 8102), {
        ref: { id: 'legacy-1', version: '1' },
        patch: { title: 'new' },
      }),
      identity,
      app: APP,
      source: 'test',
      execute,
    });
    assert.equal((updated.result as StoredRow).version, 2);
    const row = await store.load(asModel('Shop.Legacy'), asId('legacy-1'));
    assert.deepEqual(row?.data, { title: 'new' });
  });

  it('validates interim inputs through the canonical validator with identical outcomes', async () => {
    const def = makeDef({
      name: asOperation('Acme.file'),
      kind: 'crud.update',
      inputs: {
        rec: { type: 'record', model: asModel(GADGET), versioned: true, required: true },
        note: { type: 'scalar', required: false },
      },
    });
    // Positive: pending refs plus the caller's inputs object (same
    // reference — interim execution keeps the pre-T17a contract).
    const inputs = { rec: { id: 'r1', version: '3' } };
    const validated = validateCallInputs(def, inputs);
    assert.deepEqual(validated.refs, [
      { param: 'rec', model: GADGET, id: 'r1', expectedVersion: 3 },
    ]);
    assert.ok(validated.normalized === inputs);

    const codes = async (candidate: Record<string, unknown>): Promise<[string[], string[]]> => {
      const error = await captureStateError(() => validateCallInputs(def, candidate));
      assert.equal(error.code, 'validation');
      const fields = error.fields ?? [];
      return [
        fields.map((field) => field.path),
        fields.map((field) => field.code),
      ];
    };
    assert.deepEqual(await codes({}), [['/rec'], ['required']]);
    assert.deepEqual(await codes({ rec: { id: 'r1', version: '3' }, bogus: 1 }), [
      ['/bogus'],
      ['unknown_input'],
    ]);
    assert.deepEqual(await codes({ rec: { id: 'r1' } }), [['/rec'], ['version_required']]);
    assert.deepEqual(await codes({ rec: { id: 'r1', version: '0' } }), [
      ['/rec'],
      ['invalid_version'],
    ]);
    assert.deepEqual(await codes({ rec: { id: 'r1', version: '1.5' } }), [
      ['/rec'],
      ['invalid_version'],
    ]);
    assert.deepEqual(await codes({ rec: 'x' }), [['/rec'], ['invalid_ref']]);
    assert.deepEqual(await codes({ rec: { id: '' } }), [['/rec'], ['invalid_ref']]);
    assert.deepEqual(await codes({ rec: null }), [['/rec'], ['invalid_ref']]);

    // Field order pin: unknown members first (inputs key order), then
    // required checks (def order) — the retired body's exact order.
    const ordered = makeDef({
      inputs: {
        rec: { type: 'record', model: asModel(GADGET), versioned: true, required: true },
        note: { type: 'scalar', required: true },
      },
    });
    const orderError = await captureStateError(() => validateCallInputs(ordered, { bogus: 1 }));
    assert.deepEqual(
      (orderError.fields ?? []).map((field) => field.path),
      ['/bogus', '/rec', '/note'],
    );
    assert.deepEqual(
      (orderError.fields ?? []).map((field) => field.code),
      ['unknown_input', 'required', 'required'],
    );

    // Unversioned interim refs: version optional but honored when present.
    const unversioned = makeDef({
      inputs: {
        rec: { type: 'record', model: asModel(GADGET), versioned: false, required: true },
      },
    });
    assert.deepEqual(validateCallInputs(unversioned, { rec: { id: 'r1' } }).refs, [
      { param: 'rec', model: GADGET, id: 'r1', expectedVersion: null },
    ]);
    assert.deepEqual(validateCallInputs(unversioned, { rec: { id: 'r1', version: '2' } }).refs, [
      { param: 'rec', model: GADGET, id: 'r1', expectedVersion: 2 },
    ]);
  });

  it('shares the one validator between generated writes and generated reads', async () => {
    const setup = await setupPlane();
    const update = setup.registry.get(`${GADGET}.update`);
    assert.ok(update);
    // Generated writes: normalized COPY (ordinary-array fills applied).
    const writeInputs = { record: { id: 'r1', version: '1' }, title: 'x' };
    const writeValidated = validateCallInputs(update, writeInputs);
    assert.deepEqual(writeValidated.refs, [
      { param: 'record', model: GADGET, id: 'r1', expectedVersion: 1 },
    ]);
    assert.ok(writeValidated.normalized !== writeInputs);
    assert.deepEqual(writeValidated.normalized, writeInputs);
    // Same shape failures as the interim matrix above.
    const error = await captureStateError(() =>
      validateCallInputs(update, { record: { id: 'r1' }, bogus: 1 }),
    );
    assert.deepEqual(fieldPaths(error), ['/bogus', '/record']);
  });
});
