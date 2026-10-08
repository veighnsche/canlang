/**
 * T25-L3 receipt join proofs on the memory store: persist linkage, the
 * leaf-grant matrix, locator rejection, null/stale/revoked
 * associations, fence enrollment and retention — every read through
 * the REAL T25a `observeSelectedReceipt` (dynamically loaded, see
 * `work-loader.ts`) on the REAL store. The D1/DO durable proofs live
 * in `t25-receipt-durable.test.ts`.
 *
 * Mail-shaped world: `Acme.Item` rows carry a `notification` delivery
 * field whose canonical wire agrees with the protected association,
 * and recipient-like
 * policies grant `notification.status` without the whole association.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  DomainWrite,
  ModelName,
  RecordId,
  StoragePort,
} from '@canlang/contracts';
import type { ReceiptProperty } from '@canlang/contracts';
import { StateError } from '@canlang/state/errors';
import {
  openFenceScope,
  revalidateCommitForFence,
} from '@canlang/state/invocation/admission';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import {
  FIXED_NOW,
  asId,
  asModel,
  makeBatch,
  makeRow,
} from '@canlang/state/testing/invocation/fixtures';
import type { SeededMember } from '@canlang/state/testing/invocation/fixtures';
import {
  REVIEWER,
  grant,
  modelPolicy,
  policyTable,
  seedStandardTeam,
} from '@canlang/state/testing/query/fixtures';
import type { TestMembershipStore } from '@canlang/state/testing/query/fixtures';
import type { PolicyTable } from '@canlang/state/policy/grants';
import {
  RECEIPT_ASSOCIATION_MODEL,
  RECEIPT_MODEL,
  assertReceiptJoin,
  associationRowId,
  createReceiptJoinPort,
  isStoredReceiptPayload,
  newAssociationRow,
  newReceiptRow,
  readAssociationRow,
  readReceiptRow,
  withAssociationRowData,
  withReceiptRowData,
  ReceiptTableError,
  type AssociationRowData,
  type ReceiptRowData,
} from '@canlang/state/receipt/tables';
import type { DeliveryFieldSchema } from '@canlang/state/receipt/grants';
import {
  loadArtifactDescriptors,
  type ArtifactDescriptorSlice,
} from '@canlang/state/invocation/registry';
import {
  observeSelectedReceiptJoin,
  type SelectedReceiptJoinInput,
  type SelectedReceiptJoinOutcome,
} from '@canlang/state/receipt/join';
import { loadWorkReceiptFns, type WorkReceiptFns } from './work-loader.js';

const ITEM = 'Acme.Item';
const ITEM_MODEL = asModel(ITEM);
const SOURCE = 'std.MailV1.send';
const ACTOR = 't25-test';

/**
 * B3: the world's schema is loader-built from L1-shaped T15b tags (the
 * `notification` delivery descriptor mirrors `JsDeliveryDescriptor`
 * JSON), never hand-built — the loader is the schema's only source.
 */
const DELIVERY_SLICE: ArtifactDescriptorSlice = {
  artifact_version: 1,
  operations: [],
  models: [
    {
      name: ITEM,
      fields: [
        { name: 'service', field: { kind: 'string' }, required: true, serverOnly: false },
        { name: 'notice_state', field: { kind: 'string' }, required: true, serverOnly: false },
        {
          name: 'notification',
          field: {
            kind: 'delivery',
            capability: 'std.MailV1',
            operation: 'send',
            version: 1,
            result: { name: 'MailSend', fields: [] },
          },
          required: false,
          serverOnly: false,
        },
      ],
      deleteMode: 'none',
    },
  ],
};

const fns: WorkReceiptFns = await loadWorkReceiptFns();

interface World {
  readonly store: StoragePort;
  readonly memberships: TestMembershipStore;
  readonly teamId: string;
  readonly alice: SeededMember;
  readonly carol: SeededMember;
  readonly dave: SeededMember;
  readonly outsider: SeededMember;
  readonly schema: DeliveryFieldSchema;
}

async function setupWorld(): Promise<World> {
  const { store } = createTestMemoryStorage();
  const team = await seedStandardTeam();
  return {
    store,
    memberships: team.memberships,
    teamId: team.team.team_id,
    alice: team.alice,
    carol: team.carol,
    dave: team.dave,
    outsider: team.outsider,
    schema: loadArtifactDescriptors(DELIVERY_SLICE, { by: 'members' }).deliveryFields,
  };
}

/** One owner row; `notification` starts clear until the pair is associated. */
async function seedOwner(
  store: StoragePort,
  id = 'item-1',
  data: Record<string, unknown> = {},
): Promise<void> {
  const row = makeRow({
    id,
    data: { service: 'svc-1', notice_state: 'pending', notification: null, ...data },
  });
  const revision = await store.readRevision();
  await store.commit(
    makeBatch(revision as number, { writes: [{ kind: 'insert', model: ITEM_MODEL, row }] }),
  );
}

/** Recipient-like policy: the leaf grant WITHOUT the whole association. */
function recipientPolicy(fields: ReadonlyArray<string> = []): PolicyTable {
  return policyTable(
    modelPolicy(ITEM_MODEL, {
      grants: [grant('members', ['service', 'notice_state', ...fields])],
    }),
  );
}

function joinInput(
  world: World,
  policy: PolicyTable,
  member: SeededMember,
  over: Partial<SelectedReceiptJoinInput> = {},
): SelectedReceiptJoinInput {
  return {
    locator: { record: { id: 'item-1' }, field: 'notification' },
    selected: ['status'],
    model: ITEM_MODEL,
    schema: world.schema,
    declaredSource: SOURCE,
    policy,
    caller: { actorUserId: member.user.user_id, teamId: world.teamId },
    memberships: world.memberships,
    store: world.store,
    nowMs: FIXED_NOW,
    observeSelected: fns.observeSelectedReceipt,
    ...over,
  };
}

interface AssociateOpts {
  readonly recordId?: string;
  readonly field?: string;
  readonly deliveryId?: string;
  readonly source?: string;
  readonly revision?: number;
  readonly status?: ReceiptRowData['status'];
  readonly result?: unknown;
  readonly error?: ReceiptRowData['error'];
  readonly contentRef?: string | null;
  readonly resultExpiresAtMs?: number | null;
}

/** Persist one association + receipt pair through the join port. */
async function associate(store: StoragePort, opts: AssociateOpts = {}): Promise<void> {
  const port = createReceiptJoinPort({ store });
  const deliveryId = opts.deliveryId ?? 'del_1';
  const revision = opts.revision ?? 0;
  const assoc = newAssociationRow(
    {
      recordModel: ITEM,
      recordId: opts.recordId ?? 'item-1',
      field: opts.field ?? 'notification',
      deliveryId,
      source: opts.source ?? SOURCE,
      revision,
    },
    { nowMs: FIXED_NOW, actor: ACTOR },
  );
  const receipt = newReceiptRow(
    {
      deliveryId,
      revision,
      status: opts.status ?? 'pending',
      result: opts.result ?? null,
      error: opts.error ?? null,
      contentRef: opts.contentRef ?? null,
      resultExpiresAtMs: opts.resultExpiresAtMs ?? null,
    },
    { nowMs: FIXED_NOW, actor: ACTOR },
  );
  const owner = await store.load(ITEM_MODEL, asId(opts.recordId ?? 'item-1'));
  assert.ok(owner !== null);
  const revisionNow = await store.readRevision();
  await port.commitJoin(
    makeBatch(revisionNow as number, {
      writes: [
        {
          kind: 'update', model: ITEM_MODEL, id: owner.id, expectedVersion: owner.version,
          row: { ...owner, version: ((owner.version as number) + 1) as typeof owner.version,
            data: { ...(owner.data as Record<string, unknown>),
              [opts.field ?? 'notification']: { id: deliveryId, operation: opts.source ?? SOURCE } } },
        },
        { kind: 'insert', model: RECEIPT_ASSOCIATION_MODEL as ModelName, row: assoc },
        { kind: 'insert', model: RECEIPT_MODEL as ModelName, row: receipt },
      ],
    }),
  );
}

interface ProgressOpts {
  readonly deliveryId?: string;
  readonly source?: string;
  readonly revision: number;
  readonly status: ReceiptRowData['status'];
  readonly result?: unknown;
  readonly error?: ReceiptRowData['error'];
  readonly contentRef?: string | null;
  readonly resultExpiresAtMs?: number | null;
}

/**
 * Apply one receipt-progress envelope through the REAL work applier and
 * persist the returned pair through the join port. Returns the applier
 * verdict; refused progress commits nothing.
 */
async function progress(
  store: StoragePort,
  opts: ProgressOpts,
): Promise<{ readonly applied: boolean; readonly reason?: string }> {
  const deliveryId = opts.deliveryId ?? 'del_1';
  const assocRow = await store.load(
    RECEIPT_ASSOCIATION_MODEL as ModelName,
    associationRowId(ITEM, 'item-1', 'notification') as RecordId,
  );
  const receiptRow = await store.load(RECEIPT_MODEL as ModelName, deliveryId as RecordId);
  assert.ok(assocRow !== null && receiptRow !== null);
  const assoc = readAssociationRow(assocRow);
  const stored = readReceiptRow(receiptRow);
  const verdict = fns.applyReceiptProgress(assoc, stored.receipt, {
    delivery_id: deliveryId,
    source: opts.source ?? SOURCE,
    revision: opts.revision,
    status: opts.status,
    result: opts.result ?? null,
    error: opts.error ?? null,
  });
  if (!verdict.applied) {
    return { applied: false, reason: verdict.reason };
  }
  const nextAssoc: AssociationRowData = {
    recordModel: ITEM,
    recordId: 'item-1',
    field: 'notification',
    deliveryId: verdict.association.deliveryId,
    source: verdict.association.source,
    revision: verdict.association.revision,
  };
  const nextReceipt: ReceiptRowData = {
    deliveryId: verdict.receipt.deliveryId,
    revision: verdict.receipt.revision,
    status: verdict.receipt.status,
    result: verdict.receipt.result,
    error: verdict.receipt.error,
    contentRef: opts.contentRef ?? stored.contentRef,
    resultExpiresAtMs: opts.resultExpiresAtMs ?? stored.resultExpiresAtMs,
  };
  const port = createReceiptJoinPort({ store });
  const revisionNow = await store.readRevision();
  await port.commitJoin(
    makeBatch(revisionNow as number, {
      writes: [
        {
          kind: 'update',
          model: RECEIPT_ASSOCIATION_MODEL as ModelName,
          id: assocRow.id,
          expectedVersion: assocRow.version,
          row: withAssociationRowData(assocRow, nextAssoc, { nowMs: FIXED_NOW, actor: ACTOR }),
        },
        {
          kind: 'update',
          model: RECEIPT_MODEL as ModelName,
          id: receiptRow.id,
          expectedVersion: receiptRow.version,
          row: withReceiptRowData(receiptRow, nextReceipt, { nowMs: FIXED_NOW, actor: ACTOR }),
        },
      ],
    }),
  );
  return { applied: true };
}

function assertObserved(
  outcome: SelectedReceiptJoinOutcome,
): asserts outcome is SelectedReceiptJoinOutcome & { outcome: 'observed' } {
  assert.equal(outcome.outcome, 'observed');
}

function assertDenied(
  outcome: SelectedReceiptJoinOutcome,
): asserts outcome is SelectedReceiptJoinOutcome & { outcome: 'denied' } {
  assert.equal(outcome.outcome, 'denied');
}

describe('t25 persist: association + receipt rows in the real store', () => {
  it('commits the pair atomically in one revision', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    assert.equal(await world.store.readRevision(), 2);
    const assocRow = await world.store.load(
      RECEIPT_ASSOCIATION_MODEL as ModelName,
      associationRowId(ITEM, 'item-1', 'notification') as RecordId,
    );
    assert.ok(assocRow !== null);
    assert.deepEqual(readAssociationRow(assocRow), {
      locator: { recordId: 'item-1', field: 'notification' },
      deliveryId: 'del_1',
      source: SOURCE,
      revision: 0,
    });
    const receiptRow = await world.store.load(RECEIPT_MODEL as ModelName, asId('del_1'));
    assert.ok(receiptRow !== null);
    assert.deepEqual(readReceiptRow(receiptRow).receipt, {
      deliveryId: 'del_1',
      revision: 0,
      status: 'pending',
      result: null,
      error: null,
    });
  });

  it('asserts linkage before the store: lonely, disagreeing and inconsistent pairs never commit', async () => {
    const world = await setupWorld();
    const port = createReceiptJoinPort({ store: world.store });
    const assoc = (deliveryId: string, revision: number) =>
      newAssociationRow(
        { recordModel: ITEM, recordId: 'item-1', field: 'notification', deliveryId, source: SOURCE, revision },
        { nowMs: FIXED_NOW, actor: ACTOR },
      );
    const receipt = (
      deliveryId: string,
      revision: number,
      over: Partial<ReceiptRowData> = {},
    ) =>
      newReceiptRow(
        {
          deliveryId,
          revision,
          status: 'pending',
          result: null,
          error: null,
          contentRef: null,
          resultExpiresAtMs: null,
          ...over,
        },
        { nowMs: FIXED_NOW, actor: ACTOR },
      );
    const batch = (writes: ReadonlyArray<DomainWrite>) =>
      makeBatch(0, { writes }) as Parameters<typeof port.commitJoin>[0];
    // Lonely association without its receipt.
    await assert.rejects(
      port.commitJoin(
        batch([
          { kind: 'insert', model: RECEIPT_ASSOCIATION_MODEL as ModelName, row: assoc('del_x', 0) },
        ]),
      ),
      /has no receipt row in this batch/,
    );
    // Revision disagreement across the pair.
    await assert.rejects(
      port.commitJoin(
        batch([
          { kind: 'insert', model: RECEIPT_ASSOCIATION_MODEL as ModelName, row: assoc('del_y', 1) },
          { kind: 'insert', model: RECEIPT_MODEL as ModelName, row: receipt('del_y', 0) },
        ]),
      ),
      /disagrees with association revision/,
    );
    // Duplicate writes to one row.
    await assert.rejects(
      port.commitJoin(
        batch([
          { kind: 'insert', model: RECEIPT_MODEL as ModelName, row: receipt('del_z', 0) },
          { kind: 'insert', model: RECEIPT_MODEL as ModelName, row: receipt('del_z', 0) },
        ]),
      ),
      /duplicate work\.receipt write/,
    );
    assert.equal(await world.store.readRevision(), 0);
    // Inconsistent payloads never construct: failed without a closed error.
    assert.throws(
      () =>
        receipt('del_bad', 0, {
          status: 'failed',
          result: { reference: 'r1' },
          error: { code: 'E', message: 'm' },
        }),
      (error: unknown) => error instanceof ReceiptTableError,
    );
    assert.throws(
      () => receipt('del_bad', 0, { status: 'failed', result: null, error: null }),
      (error: unknown) => error instanceof ReceiptTableError,
    );
  });

  it('allows receipt-only writes (superseded attempts, fixture provisioning)', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    // Fixture-style: a second attempt's receipt provisions before any
    // association names it.
    const port = createReceiptJoinPort({ store: world.store });
    const revision = await world.store.readRevision();
    await port.commitJoin(
      makeBatch(revision as number, {
        writes: [
          {
            kind: 'insert',
            model: RECEIPT_MODEL as ModelName,
            row: newReceiptRow(
              {
                deliveryId: 'del_old',
                revision: 3,
                status: 'failed',
                result: null,
                error: { code: 'E_TIMEOUT', message: 'timed out' },
                contentRef: null,
                resultExpiresAtMs: null,
              },
              { nowMs: FIXED_NOW, actor: ACTOR },
            ),
          },
        ],
      }),
    );
    // Superseded-attempt progress touches only its own receipt row.
    const old = await world.store.load(RECEIPT_MODEL as ModelName, asId('del_old'));
    assert.ok(old !== null);
    const before = await world.store.load(
      RECEIPT_ASSOCIATION_MODEL as ModelName,
      associationRowId(ITEM, 'item-1', 'notification') as RecordId,
    );
    const revision2 = await world.store.readRevision();
    await port.commitJoin(
      makeBatch(revision2 as number, {
        writes: [
          {
            kind: 'update',
            model: RECEIPT_MODEL as ModelName,
            id: old.id,
            expectedVersion: old.version,
            row: withReceiptRowData(
              old,
              {
                deliveryId: 'del_old',
                revision: 4,
                status: 'failed',
                result: null,
                error: { code: 'E_TIMEOUT', message: 'timed out' },
                contentRef: null,
                resultExpiresAtMs: null,
              },
              { nowMs: FIXED_NOW, actor: ACTOR },
            ),
          },
        ],
      }),
    );
    const after = await world.store.load(
      RECEIPT_ASSOCIATION_MODEL as ModelName,
      associationRowId(ITEM, 'item-1', 'notification') as RecordId,
    );
    assert.deepEqual(after, before);
  });

  it('readers fail loud on stored corruption; updates refuse stale revisions', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    const assocRow = await world.store.load(
      RECEIPT_ASSOCIATION_MODEL as ModelName,
      associationRowId(ITEM, 'item-1', 'notification') as RecordId,
    );
    assert.ok(assocRow !== null);
    assert.throws(
      () => readAssociationRow({ ...assocRow, id: asId('wrong-id') }),
      (error: unknown) => error instanceof ReceiptTableError,
    );
    const receiptRow = await world.store.load(RECEIPT_MODEL as ModelName, asId('del_1'));
    assert.ok(receiptRow !== null);
    await progress(world.store, { revision: 1, status: 'succeeded', result: { ok: true } });
    const advanced = await world.store.load(RECEIPT_MODEL as ModelName, asId('del_1'));
    assert.ok(advanced !== null);
    assert.throws(
      () =>
        withReceiptRowData(
          advanced,
          {
            deliveryId: 'del_1',
            revision: 0,
            status: 'pending',
            result: null,
            error: null,
            contentRef: null,
            resultExpiresAtMs: null,
          },
          { nowMs: FIXED_NOW, actor: ACTOR },
        ),
      /stale revision/,
    );
  });

  it('passes ordinary batches trivially (non-receipt callers unaffected)', () => {
    assertReceiptJoin(makeBatch(0, {}));
    assertReceiptJoin(
      makeBatch(0, {
        writes: [{ kind: 'insert', model: ITEM_MODEL, row: makeRow({ id: 'w1' }) }],
      }),
    );
  });
});

describe('t25 consistency mirror: agreement with the real work check', () => {
  it('matches isConsistentCompletion on every non-pending status, and pins the pending receipt rule', () => {
    const closed = { code: 'E', message: 'm' };
    const open = { code: 'E', message: 'm', detail: 'x' };
    const statuses = ['succeeded', 'failed', 'unknown', 'skipped', 'pending', 'bogus'];
    const results: ReadonlyArray<unknown> = [null, undefined, 0, 'r', { reference: 'r1' }];
    const errors: ReadonlyArray<unknown> = [null, undefined, closed, open, 'boom'];
    let compared = 0;
    for (const status of statuses) {
      for (const result of results) {
        for (const error of errors) {
          const mirror = isStoredReceiptPayload(status, result, error);
          if (status === 'pending') {
            // The L3 extension: pending is a stored receipt (no
            // payload), never progress (the real check refuses it).
            assert.equal(mirror, result == null && error == null);
            assert.equal(fns.isConsistentCompletion(status, result, error), false);
          } else {
            assert.equal(
              mirror,
              fns.isConsistentCompletion(status, result, error),
              `status=${status} result=${JSON.stringify(result)} error=${JSON.stringify(error)}`,
            );
            compared += 1;
          }
        }
      }
    }
    assert.equal(compared, 5 * 5 * 5);
  });
});

describe('t25 join: authorized selected read end-to-end (real mechanism, real store)', () => {
  it('observes the granted status leaf with the live row as locator', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    await progress(world.store, { revision: 1, status: 'succeeded', result: { ok: true } });
    const owner = await world.store.load(ITEM_MODEL, asId('item-1'));
    assert.ok(owner !== null);
    // The canonical owner field agrees with the protected association.
    assert.deepEqual((owner.data as Record<string, unknown>)['notification'], { id: 'del_1', operation: SOURCE });
    const outcome = await observeSelectedReceiptJoin(
      joinInput(world, recipientPolicy(['notification.status']), world.alice, {
        locator: { record: owner, field: 'notification' },
      }),
    );
    assertObserved(outcome);
    assert.deepEqual(outcome.projection, { status: 'succeeded' });
    assert.equal(outcome.fenceRevision, 1);
    assert.equal(outcome.readRevision, await world.store.readRevision());
  });

  it('withholds the dependency without the leaf grant; grants it with notification.status', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    await progress(world.store, { revision: 1, status: 'succeeded', result: { ok: true } });
    const bare = await observeSelectedReceiptJoin(
      joinInput(world, recipientPolicy([]), world.alice),
    );
    assertDenied(bare);
    assert.deepEqual(bare.denied, ['status']);
    const granted = await observeSelectedReceiptJoin(
      joinInput(world, recipientPolicy(['notification.status']), world.alice),
    );
    assertObserved(granted);
    assert.deepEqual(granted.projection, { status: 'succeeded' });
  });

  it('denies id/result/error without their leaves; all-or-nothing lists only denied leaves', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    await progress(world.store, {
      revision: 1,
      status: 'failed',
      result: null,
      error: { code: 'E_SEND', message: 'send failed' },
    });
    const policy = recipientPolicy(['notification.status']);
    for (const selected of [
      ['id'],
      ['result'],
      ['error'],
    ] as ReadonlyArray<ReadonlyArray<ReceiptProperty>>) {
      const outcome = await observeSelectedReceiptJoin(
        joinInput(world, policy, world.alice, { selected }),
      );
      assertDenied(outcome);
      assert.deepEqual(outcome.denied, selected);
    }
    // All-or-nothing: one denied leaf fails the whole read, and the
    // denial names exactly the denied leaf in first-selected order.
    const mixed = await observeSelectedReceiptJoin(
      joinInput(world, policy, world.alice, { selected: ['status', 'result'] }),
    );
    assertDenied(mixed);
    assert.deepEqual(mixed.denied, ['result']);
  });

  it('grants nothing upward: notification.result.reference authorizes no leaf; the whole field authorizes all', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    await progress(world.store, { revision: 1, status: 'succeeded', result: { ok: true } });
    const deep = policyTable(
      modelPolicy(ITEM_MODEL, { grants: [grant('members', ['notification.result.reference'])] }),
    );
    const denied = await observeSelectedReceiptJoin(
      joinInput(world, deep, world.alice, { selected: ['result'] }),
    );
    assertDenied(denied);
    assert.deepEqual(denied.denied, ['result']);
    // The whole-field grant subsumes every leaf (result/error still
    // gated by their content checks, which pass here: inline result,
    // null error).
    const whole = policyTable(
      modelPolicy(ITEM_MODEL, { grants: [grant('members', ['notification'])] }),
    );
    const observed = await observeSelectedReceiptJoin(
      joinInput(world, whole, world.alice, {
        selected: ['id', 'status', 'result', 'error'],
      }),
    );
    assertObserved(observed);
    assert.deepEqual(observed.projection, {
      id: 'del_1',
      status: 'succeeded',
      result: { ok: true },
      error: null,
    });
  });

  it('unions matching grants across by-predicates (member status + reviewer error)', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    await progress(world.store, {
      revision: 1,
      status: 'failed',
      result: null,
      error: { code: 'E_SEND', message: 'send failed' },
    });
    const union = policyTable(
      modelPolicy(ITEM_MODEL, {
        grants: [
          grant('members', ['notification.status']),
          grant({ role: REVIEWER }, ['notification.error']),
        ],
      }),
    );
    const carol = await observeSelectedReceiptJoin(
      joinInput(world, union, world.carol, { selected: ['status', 'error'] }),
    );
    assertObserved(carol);
    assert.deepEqual(carol.projection, {
      status: 'failed',
      error: { code: 'E_SEND', message: 'send failed' },
    });
    // Alice matches only the member grant: the reviewer leaf stays denied.
    const alice = await observeSelectedReceiptJoin(
      joinInput(world, union, world.alice, { selected: ['status', 'error'] }),
    );
    assertDenied(alice);
    assert.deepEqual(alice.denied, ['error']);
  });

  it('evaluates row-level when against the current row; revoked rows deny', async () => {
    const world = await setupWorld();
    await seedOwner(world.store, 'item-1', { state: 'live' });
    await associate(world.store);
    await progress(world.store, { revision: 1, status: 'succeeded', result: { ok: true } });
    const gated = policyTable(
      modelPolicy(ITEM_MODEL, {
        grants: [
          grant('members', ['notification.status'], {
            op: 'eq',
            field: 'state',
            value: 'live',
          }),
        ],
      }),
    );
    const open = await observeSelectedReceiptJoin(
      joinInput(world, gated, world.alice),
    );
    assertObserved(open);
    // The row leaves the gated state: the same read now denies.
    const current = await world.store.load(ITEM_MODEL, asId('item-1'));
    assert.ok(current !== null);
    const revision = await world.store.readRevision();
    await world.store.commit(
      makeBatch(revision as number, {
        writes: [
          {
            kind: 'update',
            model: ITEM_MODEL,
            id: current.id,
            expectedVersion: current.version,
            row: {
              ...current,
              version: ((current.version as number) + 1) as typeof current.version,
              updated: FIXED_NOW + 1,
              data: { ...(current.data as Record<string, unknown>), state: 'archived' },
            },
          },
        ],
      }),
    );
    const revoked = await observeSelectedReceiptJoin(
      joinInput(world, gated, world.alice),
    );
    assertDenied(revoked);
    assert.deepEqual(revoked.denied, ['status']);
  });

  it('denies removed members, outsiders and unknown callers', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    const policy = recipientPolicy(['notification.status']);
    for (const member of [world.dave, world.outsider]) {
      const outcome = await observeSelectedReceiptJoin(joinInput(world, policy, member));
      assertDenied(outcome);
      assert.deepEqual(outcome.denied, ['status']);
    }
    const anonymous = await observeSelectedReceiptJoin(
      joinInput(world, policy, world.alice, {
        caller: { actorUserId: null, teamId: null },
      }),
    );
    assertDenied(anonymous);
  });

  it('denies before presence: the denial is identical with and without an association', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    const policy = recipientPolicy([]);
    const before = await observeSelectedReceiptJoin(joinInput(world, policy, world.alice));
    assertDenied(before);
    await associate(world.store);
    await progress(world.store, { revision: 1, status: 'succeeded', result: { ok: true } });
    const after = await observeSelectedReceiptJoin(joinInput(world, policy, world.alice));
    assertDenied(after);
    // Same denied leaves; only the fence checkpoint advanced. The denial
    // reveals nothing about whether an association exists.
    assert.deepEqual(after.denied, before.denied);
    assert.equal(after.denied.length, 1);
  });
});

describe('t25 join: locator and selection rejection', () => {
  it('rejects malformed locators, never resolving a guessed lookup', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    const policy = recipientPolicy(['notification.status']);
    const record = { id: 'item-1' };
    const bad: ReadonlyArray<{ readonly name: string; readonly locator: unknown }> = [
      { name: 'null', locator: null },
      { name: 'array', locator: [] },
      { name: 'string', locator: 'item-1' },
      { name: 'extra model key', locator: { record, field: 'notification', model: ITEM } },
      { name: 'extra id key', locator: { record, field: 'notification', id: 'del_1' } },
      { name: 'text-id record', locator: { record: 'item-1', field: 'notification' } },
      { name: 'null record', locator: { record: null, field: 'notification' } },
      { name: 'array record', locator: { record: [], field: 'notification' } },
      { name: 'record without id', locator: { record: {}, field: 'notification' } },
      { name: 'record with empty id', locator: { record: { id: '' }, field: 'notification' } },
      { name: 'missing field', locator: { record } },
      { name: 'empty field', locator: { record, field: '' } },
      { name: 'non-string field', locator: { record, field: 7 } },
      { name: 'dotted traversal', locator: { record, field: 'notification.status' } },
      { name: 'bracket traversal', locator: { record, field: 'notification[0]' } },
    ];
    for (const { name, locator } of bad) {
      await assert.rejects(
        observeSelectedReceiptJoin(joinInput(world, policy, world.alice, { locator })),
        (error: unknown) => error instanceof TypeError || error instanceof RangeError,
        name,
      );
    }
  });

  it('rejects unknown models, non-delivery fields and cross-model traversal as validation', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    const policy = recipientPolicy(['notification.status']);
    // A record relationship is not a delivery field.
    await assert.rejects(
      observeSelectedReceiptJoin(
        joinInput(world, policy, world.alice, {
          locator: { record: { id: 'item-1' }, field: 'service' },
        }),
      ),
      (error: unknown) =>
        error instanceof StateError &&
        error.code === 'validation' &&
        /not a declared delivery field/.test(error.message),
    );
    // Unknown model in the schema.
    await assert.rejects(
      observeSelectedReceiptJoin(
        joinInput(world, policy, world.alice, { model: asModel('Acme.Missing') }),
      ),
      (error: unknown) =>
        error instanceof StateError && error.code === 'validation' && /unknown model/.test(error.message),
    );
    // A missing owner record is not_found, never a null association.
    await assert.rejects(
      observeSelectedReceiptJoin(
        joinInput(world, policy, world.alice, {
          locator: { record: { id: 'item-gone' }, field: 'notification' },
        }),
      ),
      (error: unknown) => error instanceof StateError && error.code === 'not_found',
    );
  });

  it('rejects empty and unknown selections before any store read', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    const policy = recipientPolicy(['notification.status']);
    const before = await world.store.readRevision();
    await assert.rejects(
      observeSelectedReceiptJoin(joinInput(world, policy, world.alice, { selected: [] })),
      /must not be empty/,
    );
    await assert.rejects(
      observeSelectedReceiptJoin(
        joinInput(world, policy, world.alice, {
          selected: ['status', 'bogus'] as unknown as ReadonlyArray<ReceiptProperty>,
        }),
      ),
      /unknown selected property/,
    );
    assert.equal(await world.store.readRevision(), before);
  });
});

describe('t25 join: null, stale and revoked associations', () => {
  it('returns the authorized null association and enrolls nothing', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    const scope = openFenceScope(await world.store.readRevision(), world.teamId);
    const outcome = await observeSelectedReceiptJoin(
      joinInput(world, recipientPolicy(['notification.status']), world.alice, {
        fence: scope,
      }),
    );
    assert.equal(outcome.outcome, 'null-association');
    assert.deepEqual(scope.dependencies, []);
  });

  it('fails loud when stored rows disagree (association without its receipt, revision drift)', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    // Corrupt the store behind the join port's back: drop the receipt
    // row while the association still names it.
    const receiptRow = await world.store.load(RECEIPT_MODEL as ModelName, asId('del_1'));
    assert.ok(receiptRow !== null);
    const revision = await world.store.readRevision();
    await world.store.commit(
      makeBatch(revision as number, {
        writes: [
          {
            kind: 'remove',
            model: RECEIPT_MODEL as ModelName,
            id: receiptRow.id,
            expectedVersion: receiptRow.version,
          },
        ],
      }),
    );
    await assert.rejects(
      observeSelectedReceiptJoin(
        joinInput(world, recipientPolicy(['notification.status']), world.alice),
      ),
      /missing receipt row for the stored association/,
    );
  });

  it('refuses stale progress through the real applier and commits nothing', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    await progress(world.store, { revision: 2, status: 'succeeded', result: { ok: true } });
    const before = await world.store.readRevision();
    const verdict = await progress(world.store, {
      revision: 1,
      status: 'failed',
      result: null,
      error: { code: 'E_OLD', message: 'old' },
    });
    assert.deepEqual(verdict, { applied: false, reason: 'stale-revision' });
    assert.equal(await world.store.readRevision(), before);
    const outcome = await observeSelectedReceiptJoin(
      joinInput(world, recipientPolicy(['notification.status']), world.alice),
    );
    assertObserved(outcome);
    assert.deepEqual(outcome.projection, { status: 'succeeded' });
    assert.equal(outcome.fenceRevision, 2);
  });

  it('reads a revoked association as the authorized null (never the old receipt)', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    await progress(world.store, { revision: 1, status: 'succeeded', result: { ok: true } });
    const assocRow = await world.store.load(
      RECEIPT_ASSOCIATION_MODEL as ModelName,
      associationRowId(ITEM, 'item-1', 'notification') as RecordId,
    );
    assert.ok(assocRow !== null);
    const owner = await world.store.load(ITEM_MODEL, asId('item-1'));
    assert.ok(owner !== null);
    const revision = await world.store.readRevision();
    await world.store.commit(
      makeBatch(revision as number, {
        writes: [
          {
            kind: 'update', model: ITEM_MODEL, id: owner.id, expectedVersion: owner.version,
            row: { ...owner, version: ((owner.version as number) + 1) as typeof owner.version,
              data: { ...(owner.data as Record<string, unknown>), notification: null } },
          },
          {
            kind: 'remove',
            model: RECEIPT_ASSOCIATION_MODEL as ModelName,
            id: assocRow.id,
            expectedVersion: assocRow.version,
          },
        ],
      }),
    );
    const outcome = await observeSelectedReceiptJoin(
      joinInput(world, recipientPolicy(['notification.status']), world.alice),
    );
    assert.equal(outcome.outcome, 'null-association');
  });

  it('rejects stale or malformed current owner values before returning a protected receipt', async () => {
    for (const notification of [
      'decoy-id', null, { id: 'del_replaced', operation: SOURCE },
      { id: 'del_1', operation: 'std.MailV1.other' },
      { id: 'del_1', operation: SOURCE, extra: true },
      { id: '', operation: SOURCE },
    ]) {
      const world = await setupWorld();
      await seedOwner(world.store);
      await associate(world.store);
      const owner = await world.store.load(ITEM_MODEL, asId('item-1'));
      assert.ok(owner !== null);
      await world.store.commit(makeBatch(await world.store.readRevision() as number, {
        writes: [{ kind: 'update', model: ITEM_MODEL, id: owner.id, expectedVersion: owner.version,
          row: { ...owner, version: ((owner.version as number) + 1) as typeof owner.version,
            data: { ...(owner.data as Record<string, unknown>), notification } } }],
      }));
      await assert.rejects(observeSelectedReceiptJoin(
        joinInput(world, recipientPolicy(['notification.status']), world.alice),
      ), (error: unknown) => error instanceof Error && !(error instanceof StateError));
    }
  });

  it('fails closed on missing declaration or a missing protected association', async () => {
    const world = await setupWorld();
    await seedOwner(world.store, 'item-1', { notification: { id: 'del_1', operation: SOURCE } });
    const input = joinInput(world, recipientPolicy(['notification.status']), world.alice);
    await assert.rejects(observeSelectedReceiptJoin({ ...input, declaredSource: undefined as unknown as string }),
      /missing declared delivery source/);
    await assert.rejects(observeSelectedReceiptJoin(input), /missing association/);
  });

  it('denies unique leaves before any protected load or current-field consistency check', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    const owner = await world.store.load(ITEM_MODEL, asId('item-1'));
    assert.ok(owner !== null);
    const association = await world.store.load(RECEIPT_ASSOCIATION_MODEL as ModelName,
      associationRowId(ITEM, 'item-1', 'notification') as RecordId);
    const receipt = await world.store.load(RECEIPT_MODEL as ModelName, asId('del_1'));
    assert.ok(association !== null && receipt !== null);
    await world.store.commit(makeBatch(await world.store.readRevision() as number, {
      writes: [
        { kind: 'update', model: ITEM_MODEL, id: owner.id, expectedVersion: owner.version,
          row: { ...owner, version: ((owner.version as number) + 1) as typeof owner.version,
            data: { ...(owner.data as Record<string, unknown>), notification: 'decoy-id' } } },
        { kind: 'update', model: RECEIPT_ASSOCIATION_MODEL as ModelName, id: association.id,
          expectedVersion: association.version,
          row: { ...association, version: ((association.version as number) + 1) as typeof association.version, data: {} } },
        { kind: 'remove', model: RECEIPT_MODEL as ModelName, id: receipt.id, expectedVersion: receipt.version },
      ],
    }));
    let protectedLoads = 0;
    const store = new Proxy(world.store, {
      get(target, property) {
        if (property === 'load') return async (model: ModelName, id: RecordId) => {
          if (model === RECEIPT_ASSOCIATION_MODEL || model === RECEIPT_MODEL) {
            protectedLoads++;
            throw new Error('protected load must not occur');
          }
          return target.load(model, id);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const scope = openFenceScope(await world.store.readRevision(), world.teamId);
    const outcome = await observeSelectedReceiptJoin(joinInput(world, recipientPolicy([]), world.alice, {
      store, selected: ['error', 'status', 'error'], fence: scope,
      declaredSource: undefined as unknown as string,
    }));
    assert.deepEqual(outcome, { outcome: 'denied', denied: ['error', 'status'], readRevision: scope.revision });
    assert.equal(protectedLoads, 0);
    assert.deepEqual(scope.dependencies, []);
  });

  it('fails loud on revision drift between the stored pair', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    // Corrupt the store behind the join port's back: advance the
    // association revision without its receipt half.
    const assocRow = await world.store.load(
      RECEIPT_ASSOCIATION_MODEL as ModelName,
      associationRowId(ITEM, 'item-1', 'notification') as RecordId,
    );
    assert.ok(assocRow !== null);
    const revision = await world.store.readRevision();
    await world.store.commit(
      makeBatch(revision as number, {
        writes: [
          {
            kind: 'update',
            model: RECEIPT_ASSOCIATION_MODEL as ModelName,
            id: assocRow.id,
            expectedVersion: assocRow.version,
            row: withAssociationRowData(
              assocRow,
              {
                recordModel: ITEM,
                recordId: 'item-1',
                field: 'notification',
                deliveryId: 'del_1',
                source: SOURCE,
                revision: 1,
              },
              { nowMs: FIXED_NOW, actor: ACTOR },
            ),
          },
        ],
      }),
    );
    await assert.rejects(
      observeSelectedReceiptJoin(
        joinInput(world, recipientPolicy(['notification.status']), world.alice),
      ),
      /receipt revision disagrees with the association/,
    );
  });
});

describe('t25 join: owner read-fence enrollment', () => {
  it('enrolls the current receipt row on observed mutable reads; id-only, denied and null enroll nothing', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    await progress(world.store, { revision: 1, status: 'succeeded', result: { ok: true } });
    const receiptRow = await world.store.load(RECEIPT_MODEL as ModelName, asId('del_1'));
    assert.ok(receiptRow !== null);
    // Mutable selected properties enroll the receipt revision.
    const scope = openFenceScope(await world.store.readRevision(), world.teamId);
    const observed = await observeSelectedReceiptJoin(
      joinInput(world, recipientPolicy(['notification.status']), world.alice, {
        fence: scope,
      }),
    );
    assertObserved(observed);
    assert.equal(observed.fenceRevision, 1);
    assert.deepEqual(scope.dependencies, [
      { kind: 'record', model: RECEIPT_MODEL, id: asId('del_1'), version: receiptRow.version },
    ]);
    // Id-only reads enroll nothing (no mutable-status precondition).
    const whole = policyTable(
      modelPolicy(ITEM_MODEL, { grants: [grant('members', ['notification.id'])] }),
    );
    const idScope = openFenceScope(await world.store.readRevision(), world.teamId);
    const idOnly = await observeSelectedReceiptJoin(
      joinInput(world, whole, world.alice, { selected: ['id'], fence: idScope }),
    );
    assertObserved(idOnly);
    assert.deepEqual(idOnly.projection, { id: 'del_1' });
    assert.equal(idOnly.fenceRevision, null);
    assert.deepEqual(idScope.dependencies, []);
    // Denied reads enroll nothing.
    const deniedScope = openFenceScope(await world.store.readRevision(), world.teamId);
    const denied = await observeSelectedReceiptJoin(
      joinInput(world, recipientPolicy([]), world.alice, { fence: deniedScope }),
    );
    assertDenied(denied);
    assert.deepEqual(deniedScope.dependencies, []);
  });

  it('fences concurrent observations: a moved checkpoint conflicts the read and voids the commit', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    const policy = recipientPolicy(['notification.status']);
    const scope = openFenceScope(await world.store.readRevision(), world.teamId);
    const observed = await observeSelectedReceiptJoin(
      joinInput(world, policy, world.alice, { fence: scope }),
    );
    assertObserved(observed);
    assert.equal(observed.fenceRevision, 0);
    const ownerBefore = await world.store.load(ITEM_MODEL, asId('item-1'));
    // Concurrent receipt progress lands first: the owner row is
    // untouched (receipt progress performs no domain write), but the
    // fence moved.
    await progress(world.store, { revision: 1, status: 'succeeded', result: { ok: true } });
    const ownerAfter = await world.store.load(ITEM_MODEL, asId('item-1'));
    assert.deepEqual(ownerAfter, ownerBefore);
    // A reread on the stale scope conflicts before consulting any row.
    await assert.rejects(
      observeSelectedReceiptJoin(joinInput(world, policy, world.alice, { fence: scope })),
      (error: unknown) =>
        error instanceof StateError &&
        error.code === 'conflict' &&
        /Fence checkpoint moved before this read/.test(error.message),
    );
    // And the enrolled observation voids its commit at revalidation.
    await assert.rejects(
      revalidateCommitForFence({
        checkpoint: scope.snapshot(),
        by: 'members',
        guards: [],
        actorUserId: world.alice.user.user_id,
        teamId: world.teamId,
        kind: 'user',
        store: world.store,
        memberships: world.memberships,
      }),
      (error: unknown) =>
        error instanceof StateError &&
        error.code === 'conflict' &&
        /Checkpoint moved during the operation/.test(error.message),
    );
    // A fresh scope observes the progressed receipt.
    const fresh = openFenceScope(await world.store.readRevision(), world.teamId);
    const reread = await observeSelectedReceiptJoin(
      joinInput(world, policy, world.alice, { fence: fresh }),
    );
    assertObserved(reread);
    assert.deepEqual(reread.projection, { status: 'succeeded' });
    assert.equal(reread.fenceRevision, 1);
  });
});

describe('t25 join: result retention', () => {
  it('retains status while withholding the expired result (expiry instant counts as expired)', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    const policy = policyTable(
      modelPolicy(ITEM_MODEL, {
        grants: [grant('members', ['notification.status', 'notification.result'])],
      }),
    );
    await progress(world.store, {
      revision: 1,
      status: 'succeeded',
      result: { reference: 'hidden' },
      contentRef: 'content-1',
      resultExpiresAtMs: FIXED_NOW + 1000,
    });
    // Before expiry the granted result discloses.
    const live = await observeSelectedReceiptJoin(
      joinInput(world, policy, world.alice, {
        selected: ['status', 'result'],
        nowMs: FIXED_NOW,
      }),
    );
    assertObserved(live);
    assert.deepEqual(live.projection, { status: 'succeeded', result: { reference: 'hidden' } });
    // After expiry the retained status stays while the result withholds
    // as null under its present key — indistinguishable from an
    // ungranted or genuinely-null result.
    const expired = await observeSelectedReceiptJoin(
      joinInput(world, policy, world.alice, {
        selected: ['status', 'result'],
        nowMs: FIXED_NOW + 1001,
      }),
    );
    assertObserved(expired);
    assert.deepEqual(expired.projection, { status: 'succeeded', result: null });
    // The expiry instant itself already counts as expired.
    const boundary = await observeSelectedReceiptJoin(
      joinInput(world, policy, world.alice, {
        selected: ['status', 'result'],
        nowMs: FIXED_NOW + 1000,
      }),
    );
    assertObserved(boundary);
    assert.deepEqual(boundary.projection, { status: 'succeeded', result: null });
  });

  it('discloses inline results without consulting retention', async () => {
    const world = await setupWorld();
    await seedOwner(world.store);
    await associate(world.store);
    const policy = policyTable(
      modelPolicy(ITEM_MODEL, {
        grants: [grant('members', ['notification.status', 'notification.result'])],
      }),
    );
    // A null content ref marks inline content retained with the
    // summary: it discloses at any clock, past any expiry.
    await progress(world.store, {
      revision: 1,
      status: 'succeeded',
      result: { inline: true },
      contentRef: null,
      resultExpiresAtMs: FIXED_NOW - 1000,
    });
    const outcome = await observeSelectedReceiptJoin(
      joinInput(world, policy, world.alice, {
        selected: ['status', 'result'],
        nowMs: FIXED_NOW,
      }),
    );
    assertObserved(outcome);
    assert.deepEqual(outcome.projection, { status: 'succeeded', result: { inline: true } });
  });
});
