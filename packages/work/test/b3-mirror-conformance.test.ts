/**
 * D3a work-side B3 mirror conformance pins: the T25 receipt join's
 * structural mirrors agree with the work kernels verdict-for-verdict.
 *
 * Direction (complement of B3's work-loader, which runs REAL work fns
 * on the B3 store): these suites run REAL B3 exports — loaded from the
 * built `state/dist` (test-only, durable-suite precedent) — against
 * REAL work kernels imported from source, over shared batteries:
 *
 * - A: locator differential (`resolveAssociationLocator` vs
 *   `resolveJoinLocator`): identical error classes on malformed
 *   shapes, identical acceptance on valid shapes, plus the one
 *   explicit delta (B3's record-id rule, L3-only by design).
 * - B: B3's `createSelectedGrants` closures plugged into REAL work
 *   `observeSelectedReceipt`: field scope, whole-field subsumption,
 *   leaf exactness, no upward expansion, deny-before-presence.
 * - C: B3's `createRetentionContentPolicy` closures plugged into REAL
 *   work `observeReceipt`: availability, expiry boundary (the expiry
 *   instant itself is expired), ref mismatch, inline bypass.
 * - D (static, tsc-enforced): bidirectional type pins across the join
 *   boundary in the exact runtime data-flow directions, plus the
 *   work-loader mirror types against work's live exports.
 * - E (re-pointing): receipt rows provisioned BEFORE associating, then
 *   association writes re-pointing at the pre-existing receipts,
 *   committed through REAL B3 `commitJoin` (same-batch rule proved
 *   from D call sites, including its negative), loaded via B3
 *   readers and consumed by REAL work kernels.
 * - F (join differential): REAL B3 `observeSelectedReceiptJoin` over
 *   a memory store (REAL work `observeSelectedReceipt` injected
 *   directly — no loader needed work-side) agrees with REAL work
 *   `observeSelectedReceipt` on observed/denied/null outcomes.
 *
 * Explicitly NOT pinned (no work counterpart): `assertDeliveryField` /
 * delivery schema membership (L3-only declared-schema source),
 * `resolveLeafGrantPaths` (B-internal policy evaluation; its OUTPUT
 * feeds suite B), row codecs beyond round-trip, fence enrollment
 * mechanics. T26 relation/progress/terminal surfaces are UNMIRRORED
 * in B3 (verified zero T26 references in state/src/receipt) and stay
 * out of this battery per coordinator ruling (D1-track, not B's).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AssociatedReceipt,
  ReceiptAssociation,
  ReceiptProperty,
  ReceiptStatus,
} from '@canlang/contracts';
import type {
  CommitBatch,
  DomainWrite,
  ModelName,
  RecordId,
  RecordVersion,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import {
  applyReceiptProgress,
  resolveAssociationLocator,
} from '../src/observation/association.js';
import type { ReceiptProgressOutcome } from '../src/observation/association.js';
import {
  observeReceipt,
  observeSelectedReceipt,
} from '../src/observation/observation.js';
import type {
  SelectedReceiptInput,
  SelectedReceiptOutcome,
  StoredReceipt,
} from '../src/observation/observation.js';
import { isConsistentCompletion } from '../src/receipt/index.js';
import { resolveJoinLocator } from '@canlang/state/receipt/join';
import { observeSelectedReceiptJoin } from '@canlang/state/receipt/join';
import type {
  JoinObserverInput,
  JoinObserverOutcome,
  JoinStoredReceipt,
  SelectedReceiptObserver,
} from '@canlang/state/receipt/join';
import {
  assertDeliveryField,
  createDeliverySchema,
  createRetentionContentPolicy,
  createSelectedGrants,
  resolveLeafGrantPaths,
} from '@canlang/state/receipt/grants';
import type { DeliveryFieldSchema } from '@canlang/state/receipt/grants';
import {
  RECEIPT_ASSOCIATION_MODEL,
  RECEIPT_MODEL,
  associationRowId,
  createReceiptJoinPort,
  newAssociationRow,
  newReceiptRow,
  readAssociationRow,
  readReceiptRow,
  withAssociationRowData,
  withReceiptRowData,
} from '@canlang/state/receipt/tables';
import type {
  AssociationRowData,
  ReceiptRowData,
} from '@canlang/state/receipt/tables';
import type {
  ApplyReceiptProgressFn,
  IsConsistentCompletionFn,
  WorkProgressOutcome,
} from '../src/receipt/index.js';
import { createTestMemoryStorage } from '@canlang/state/storage/memory';
import { buildPolicyTable } from '@canlang/state/policy/grants';
import type { MembershipReader } from '@canlang/state/policy/roles';
import { StateError } from '@canlang/state/errors';

const ITEM = 'Acme.Item';
const ITEM_MODEL = ITEM as ModelName;
const FIELD = 'notification';
const SOURCE = 'mailroom.Mail.send';
const ACTOR = 'd3a-pins';
const NOW = 1_791_120_000_000;
const T0 = 1_758_000_000_000;

/* -- Shared fixtures: owner rows, batches,Null memberships. -- */

function ownerRow(id: string, nowMs: number): StoredRow {
  return {
    id: id as RecordId,
    version: 1 as RecordVersion,
    created: nowMs,
    updated: nowMs,
    createdBy: ACTOR,
    updatedBy: ACTOR,
    archivedAt: null,
    parent: null,
    data: { service: 'svc-1', notice_state: 'pending', notification: 'decoy-id' },
  };
}

async function commitWrites(store: StoragePort, writes: ReadonlyArray<DomainWrite>): Promise<void> {
  const batch: CommitBatch = {
    expectedRevision: await store.readRevision(),
    writes,
    history: [],
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
  };
  await store.commit(batch);
}

const nullMemberships: MembershipReader = {
  findMembership: async () => null,
};

function publicPolicy(fields: ReadonlyArray<string>) {
  return buildPolicyTable([
    { model: ITEM_MODEL, secretFields: [], grants: [{ by: 'public', fields }] },
  ]);
}

function stored(
  receipt: AssociatedReceipt,
  contentRef: string | null = null,
): StoredReceipt {
  return { ...receipt, contentRef };
}

/* -- Suite A: locator differential. -- */

describe('d3a locator differential (work vs B3 mirror)', () => {
  const malformed: ReadonlyArray<{ readonly name: string; readonly locator: unknown }> = [
    { name: 'null', locator: null },
    { name: 'undefined', locator: undefined },
    { name: 'string', locator: 'rec_1' },
    { name: 'array', locator: [] },
    { name: 'extra key', locator: { record: { id: 'rec_1' }, field: FIELD, model: ITEM } },
    { name: 'record text id', locator: { record: 'rec_1', field: FIELD } },
    { name: 'record null', locator: { record: null, field: FIELD } },
    { name: 'record array', locator: { record: [], field: FIELD } },
    { name: 'field non-string', locator: { record: { id: 'rec_1' }, field: 7 } },
    { name: 'field empty', locator: { record: { id: 'rec_1' }, field: '' } },
    { name: 'field dotted', locator: { record: { id: 'rec_1' }, field: 'a.b' } },
    { name: 'field brackets', locator: { record: { id: 'rec_1' }, field: 'a[0]' } },
  ];

  for (const { name, locator } of malformed) {
    it(`throws the same class on ${name}`, () => {
      let workError: unknown = null;
      let joinError: unknown = null;
      try {
        resolveAssociationLocator(locator);
      } catch (error) {
        workError = error;
      }
      try {
        resolveJoinLocator(locator);
      } catch (error) {
        joinError = error;
      }
      assert.ok(workError !== null, 'work must throw');
      assert.ok(joinError !== null, 'B3 mirror must throw');
      assert.equal(
        (joinError as Error).constructor,
        (workError as Error).constructor,
        `class drift on ${name}`,
      );
    });
  }

  it('accepts the same valid shapes with mirrored outputs', () => {
    const record = { id: 'item-1' };
    assert.deepEqual(resolveAssociationLocator({ record, field: FIELD }), { record, field: FIELD });
    assert.deepEqual(resolveJoinLocator({ record, field: FIELD }), {
      recordId: 'item-1',
      field: FIELD,
    });
  });

  it('pins the explicit delta: B3 requires the record store id, work does not', () => {
    // L3-only rule by design (the ONLY lookup key); the mechanism
    // re-validates the original locator authoritatively, so any
    // divergence still fails closed inside.
    assert.deepEqual(resolveAssociationLocator({ record: {}, field: FIELD }), {
      record: {},
      field: FIELD,
    });
    assert.throws(() => resolveJoinLocator({ record: {}, field: FIELD }), TypeError);
    assert.deepEqual(resolveAssociationLocator({ record: { id: 7 }, field: FIELD }), {
      record: { id: 7 },
      field: FIELD,
    });
    assert.throws(() => resolveJoinLocator({ record: { id: 7 }, field: FIELD }), TypeError);
  });
});

/* -- Suite B: B3 grant closures through REAL work observeSelectedReceipt. -- */

describe('d3a B3 grant closures satisfy the work leaf-grant contract', () => {
  const record = { id: 'item-1' };
  const association: ReceiptAssociation = {
    locator: { recordId: 'item-1', field: FIELD },
    deliveryId: 'del_1',
    source: SOURCE,
    revision: 3,
  };
  const receipt: AssociatedReceipt = {
    deliveryId: 'del_1',
    revision: 3,
    status: 'succeeded',
    result: { ok: true },
    error: null,
  };

  function observe(
    paths: ReadonlyArray<string>,
    selected: readonly ReceiptProperty[],
    present: boolean,
  ) {
    return observeSelectedReceipt({
      locator: { record, field: FIELD },
      selected,
      association: present ? association : null,
      receipt: present ? stored(receipt) : null,
      grants: createSelectedGrants({ field: FIELD, paths: new Set(paths) }),
      content: { isResultAvailable: () => true },
      nowMs: NOW,
    });
  }

  it('whole-field grants authorize every leaf', () => {
    assert.deepEqual(observe(['notification'], ['id', 'status', 'result', 'error'], true), {
      outcome: 'observed',
      projection: { id: 'del_1', status: 'succeeded', result: { ok: true }, error: null },
      fenceRevision: 3,
    });
  });

  it('leaf grants authorize exactly that leaf', () => {
    assert.deepEqual(observe(['notification.status'], ['status'], true), {
      outcome: 'observed',
      projection: { status: 'succeeded' },
      fenceRevision: 3,
    });
    assert.deepEqual(observe(['notification.status'], ['status', 'result'], true), {
      outcome: 'denied',
      denied: ['result'],
    });
  });

  it('grants nothing on other fields and never expands upward', () => {
    assert.deepEqual(observe(['notice.status'], ['status'], true), {
      outcome: 'denied',
      denied: ['status'],
    });
    assert.deepEqual(observe(['notification.result.reference'], ['result'], true), {
      outcome: 'denied',
      denied: ['result'],
    });
    assert.deepEqual(observe([], ['id'], true), { outcome: 'denied', denied: ['id'] });
  });

  it('denies before presence: null association consults the same closures', () => {
    assert.deepEqual(observe([], ['status'], false), { outcome: 'denied', denied: ['status'] });
    assert.deepEqual(observe(['notification.status'], ['status'], false), {
      outcome: 'null-association',
    });
  });

  it('is consulted exactly once per unique selected leaf', () => {
    const seen: ReceiptProperty[] = [];
    const counting = createSelectedGrants({ field: FIELD, paths: new Set(['notification']) });
    const outcome = observeSelectedReceipt({
      locator: { record, field: FIELD },
      selected: ['status', 'result', 'status'],
      association,
      receipt: stored(receipt),
      grants: {
        mayObserve: (property, context) => {
          seen.push(property);
          return counting.mayObserve(property, context);
        },
      },
      content: { isResultAvailable: () => true },
      nowMs: NOW,
    });
    assert.equal(outcome.outcome, 'observed');
    assert.deepEqual(seen, ['status', 'result']);
  });
});

/* -- Suite C: B3 retention closures through REAL work observeReceipt. -- */

describe('d3a B3 retention closures satisfy the work content contract', () => {
  const base: StoredReceipt = {
    deliveryId: 'del_1',
    revision: 3,
    status: 'succeeded',
    result: { ok: true },
    error: null,
    contentRef: 'content-1',
  };
  const grants = { mayObserve: () => true };

  function read(contentRef: string | null, resultExpiresAtMs: number | null, nowMs: number) {
    return observeReceipt({
      receipt: { ...base, contentRef },
      requested: ['result'],
      grants,
      content: createRetentionContentPolicy({ contentRef, resultExpiresAtMs }),
      nowMs,
    });
  }

  it('discloses retained content before expiry', () => {
    assert.deepEqual(read('content-1', NOW + 1000, NOW).result, { ok: true });
    assert.deepEqual(read('content-1', null, NOW + 1_000_000).result, { ok: true });
  });

  it('withholds at and past the expiry instant (boundary inclusive)', () => {
    assert.equal(read('content-1', NOW, NOW).result, null);
    assert.equal(read('content-1', NOW - 1, NOW).result, null);
  });

  it('fails closed on ref mismatch', () => {
    const observed = observeReceipt({
      receipt: base,
      requested: ['result'],
      grants,
      content: createRetentionContentPolicy({
        contentRef: 'other-content',
        resultExpiresAtMs: null,
      }),
      nowMs: NOW,
    });
    assert.equal(observed.result, null);
  });

  it('bypasses the closure for inline content without consulting it', () => {
    let calls = 0;
    const observed = observeReceipt({
      receipt: { ...base, contentRef: null },
      requested: ['result'],
      grants,
      content: {
        isResultAvailable: (ref, nowMs) => {
          calls += 1;
          return createRetentionContentPolicy({
            contentRef: null,
            resultExpiresAtMs: null,
          }).isResultAvailable(ref, nowMs);
        },
      },
      nowMs: NOW,
    });
    assert.deepEqual(observed.result, { ok: true });
    assert.equal(calls, 0);
  });
});

/* -- Suite D: static cross-boundary pins (tsc-enforced). -- */

// Pinned data-flow directions: B3 inputs flow INTO work fns; work
// outputs flow back INTO B3's join; B3's loader types mirror work's
// live exports. A drifted mirror fails work tsc loudly.
const joinInputFlowsToWork: SelectedReceiptInput = null as unknown as JoinObserverInput;
const workOutputFlowsToJoin: JoinObserverOutcome = null as unknown as SelectedReceiptOutcome;
const workProgressFlowsToLoader: WorkProgressOutcome = null as unknown as ReceiptProgressOutcome;
const liveObserveMatchesLoader: SelectedReceiptObserver = observeSelectedReceipt;
const liveApplyMatchesLoader: ApplyReceiptProgressFn = applyReceiptProgress;
const liveConsistencyMatchesLoader: IsConsistentCompletionFn = isConsistentCompletion;

describe('d3a static pins hold at runtime', () => {
  it('live work exports satisfy the B3 loader mirror types', () => {
    assert.equal(typeof liveObserveMatchesLoader, 'function');
    assert.equal(typeof liveApplyMatchesLoader, 'function');
    assert.equal(typeof liveConsistencyMatchesLoader, 'function');
    assert.equal(joinInputFlowsToWork === null, true);
    assert.equal(workOutputFlowsToJoin === null, true);
    assert.equal(workProgressFlowsToLoader === null, true);
  });
});

/* -- Suites E/F shared store helpers (real B3 port + memory store). -- */

async function batchWith(
  store: StoragePort,
  writes: ReadonlyArray<DomainWrite>,
): Promise<CommitBatch> {
  return {
    expectedRevision: await store.readRevision(),
    writes,
    history: [],
    receipt: null,
    outbox: [],
    schedules: [],
    uniqueClaims: [],
    uniqueReleases: [],
  };
}

async function setupStore(): Promise<StoragePort> {
  const { store } = createTestMemoryStorage();
  await commitWrites(store, [{ kind: 'insert', model: ITEM_MODEL, row: ownerRow('item-1', T0) }]);
  return store;
}

function assocData(deliveryId: string, revision: number): AssociationRowData {
  return {
    recordModel: ITEM,
    recordId: 'item-1',
    field: FIELD,
    deliveryId,
    source: SOURCE,
    revision,
  };
}

function receiptData(
  deliveryId: string,
  revision: number,
  status: ReceiptStatus,
  result: unknown = null,
): ReceiptRowData {
  return {
    deliveryId,
    revision,
    status,
    result,
    error: null,
    contentRef: null,
    resultExpiresAtMs: null,
  };
}

function handAssoc(deliveryId: string, revision: number): ReceiptAssociation {
  return { locator: { recordId: 'item-1', field: FIELD }, deliveryId, source: SOURCE, revision };
}

function handReceipt(
  deliveryId: string,
  revision: number,
  status: ReceiptStatus,
  result: unknown = null,
): AssociatedReceipt {
  return { deliveryId, revision, status, result, error: null };
}

/* -- Suite E: re-pointing at pre-existing receipts (real B3 port). -- */

describe('d3a re-pointing consumes B3 rows in work kernels', () => {
  it('provisions a receipt first, then associates it in a later batch', async () => {
    const store = await setupStore();
    const port = createReceiptJoinPort({ store });
    await port.commitJoin(
      await batchWith(store, [
        {
          kind: 'insert',
          model: RECEIPT_MODEL as ModelName,
          row: newReceiptRow(receiptData('del_A', 0, 'pending'), { nowMs: T0, actor: ACTOR }),
        },
      ]),
    );
    const existing = await store.load(RECEIPT_MODEL as ModelName, 'del_A' as RecordId);
    assert.ok(existing !== null);
    const touched = readReceiptRow(existing);
    await port.commitJoin(
      await batchWith(store, [
        {
          kind: 'insert',
          model: RECEIPT_ASSOCIATION_MODEL as ModelName,
          row: newAssociationRow(assocData('del_A', 0), { nowMs: T0, actor: ACTOR }),
        },
        {
          kind: 'update',
          model: RECEIPT_MODEL as ModelName,
          id: existing.id,
          expectedVersion: existing.version,
          row: withReceiptRowData(
            existing,
            {
              deliveryId: touched.receipt.deliveryId,
              revision: touched.receipt.revision,
              status: touched.receipt.status,
              result: touched.receipt.result,
              error: touched.receipt.error,
              contentRef: touched.contentRef,
              resultExpiresAtMs: touched.resultExpiresAtMs,
            },
            { nowMs: T0, actor: ACTOR },
          ),
        },
      ]),
    );

    const assocRow = await store.load(
      RECEIPT_ASSOCIATION_MODEL as ModelName,
      associationRowId(ITEM, 'item-1', FIELD) as RecordId,
    );
    const receiptRow = await store.load(RECEIPT_MODEL as ModelName, 'del_A' as RecordId);
    assert.ok(assocRow !== null && receiptRow !== null);
    const loadedAssoc = readAssociationRow(assocRow);
    const loadedReceipt = readReceiptRow(receiptRow).receipt;
    const envelope = {
      delivery_id: 'del_A',
      source: SOURCE,
      revision: 1,
      status: 'succeeded' as ReceiptStatus,
      result: { ok: 1 },
      error: null,
    };
    const viaB3 = applyReceiptProgress(loadedAssoc, loadedReceipt, envelope);
    const viaDirect = applyReceiptProgress(
      handAssoc('del_A', 0),
      handReceipt('del_A', 0, 'pending'),
      envelope,
    );
    assert.deepEqual(viaB3, viaDirect);
    assert.equal(viaB3.applied, true);
    assert.ok(viaB3.applied);
    assert.equal(viaB3.receipt.revision, 1);
    assert.deepEqual(viaB3.receipt.result, { ok: 1 });
  });

  it('refuses association writes without a same-batch receipt (D call sites)', async () => {
    const store = await setupStore();
    const port = createReceiptJoinPort({ store });
    let threw = false;
    try {
      await port.commitJoin(
        await batchWith(store, [
          {
            kind: 'insert',
            model: RECEIPT_ASSOCIATION_MODEL as ModelName,
            row: newAssociationRow(assocData('del_lonely', 0), { nowMs: T0, actor: ACTOR }),
          },
        ]),
      );
    } catch (error) {
      threw = true;
      assert.equal(error instanceof StateError, true);
      assert.match((error as StateError).message, /no receipt row in this batch/);
    }
    assert.equal(threw, true);
    assert.equal(
      await store.load(
        RECEIPT_ASSOCIATION_MODEL as ModelName,
        associationRowId(ITEM, 'item-1', FIELD) as RecordId,
      ),
      null,
    );
  });

  it('re-points one field across two pre-existing receipts', async () => {
    const store = await setupStore();
    const port = createReceiptJoinPort({ store });
    await port.commitJoin(
      await batchWith(store, [
        {
          kind: 'insert',
          model: RECEIPT_MODEL as ModelName,
          row: newReceiptRow(receiptData('del_1', 0, 'pending'), { nowMs: T0, actor: ACTOR }),
        },
        {
          kind: 'insert',
          model: RECEIPT_MODEL as ModelName,
          row: newReceiptRow(receiptData('del_2', 0, 'pending'), { nowMs: T0, actor: ACTOR }),
        },
      ]),
    );
    const touch = async (deliveryId: string) => {
      const row = await store.load(RECEIPT_MODEL as ModelName, deliveryId as RecordId);
      assert.ok(row !== null);
      const current = readReceiptRow(row);
      return {
        kind: 'update' as const,
        model: RECEIPT_MODEL as ModelName,
        id: row.id,
        expectedVersion: row.version,
        row: withReceiptRowData(
          row,
          {
            deliveryId: current.receipt.deliveryId,
            revision: current.receipt.revision,
            status: current.receipt.status,
            result: current.receipt.result,
            error: current.receipt.error,
            contentRef: current.contentRef,
            resultExpiresAtMs: current.resultExpiresAtMs,
          },
          { nowMs: T0, actor: ACTOR },
        ),
      };
    };
    await port.commitJoin(
      await batchWith(store, [
        {
          kind: 'insert',
          model: RECEIPT_ASSOCIATION_MODEL as ModelName,
          row: newAssociationRow(assocData('del_1', 0), { nowMs: T0, actor: ACTOR }),
        },
        await touch('del_1'),
      ]),
    );
    const assocRow = await store.load(
      RECEIPT_ASSOCIATION_MODEL as ModelName,
      associationRowId(ITEM, 'item-1', FIELD) as RecordId,
    );
    assert.ok(assocRow !== null);
    await port.commitJoin(
      await batchWith(store, [
        {
          kind: 'update',
          model: RECEIPT_ASSOCIATION_MODEL as ModelName,
          id: assocRow.id,
          expectedVersion: assocRow.version,
          row: withAssociationRowData(assocRow, assocData('del_2', 0), {
            nowMs: T0,
            actor: ACTOR,
          }),
        },
        await touch('del_2'),
      ]),
    );

    const repointed = await store.load(
      RECEIPT_ASSOCIATION_MODEL as ModelName,
      associationRowId(ITEM, 'item-1', FIELD) as RecordId,
    );
    const receiptRow = await store.load(RECEIPT_MODEL as ModelName, 'del_2' as RecordId);
    assert.ok(repointed !== null && receiptRow !== null);
    const loadedAssoc = readAssociationRow(repointed);
    const loadedReceipt = readReceiptRow(receiptRow).receipt;
    assert.equal(loadedAssoc.deliveryId, 'del_2');
    // The superseded attempt's envelopes no longer match the current
    // association; its own receipt still applies them in isolation.
    assert.deepEqual(
      applyReceiptProgress(loadedAssoc, loadedReceipt, {
        delivery_id: 'del_1',
        source: SOURCE,
        revision: 1,
        status: 'succeeded' as ReceiptStatus,
        result: null,
        error: null,
      }),
      { applied: false, reason: 'id-mismatch' },
    );
    const oldRow = await store.load(RECEIPT_MODEL as ModelName, 'del_1' as RecordId);
    assert.ok(oldRow !== null);
    const oldReceipt = readReceiptRow(oldRow).receipt;
    const own = applyReceiptProgress(handAssoc('del_1', 0), oldReceipt, {
      delivery_id: 'del_1',
      source: SOURCE,
      revision: 1,
      status: 'succeeded' as ReceiptStatus,
      result: { late: true },
      error: null,
    });
    assert.equal(own.applied, true);
  });
});

/* -- Suite F: B3 join vs work kernel differential (memory store). -- */

describe('d3a join differential (B3 read path vs work mechanism)', () => {
  const caller = { actorUserId: null, teamId: null };

  async function seedPair(
    store: StoragePort,
    deliveryId: string,
    revision: number,
    status: ReceiptStatus,
    result: unknown,
    contentRef: string | null = null,
    resultExpiresAtMs: number | null = null,
  ): Promise<void> {
    const port = createReceiptJoinPort({ store });
    await port.commitJoin(
      await batchWith(store, [
        {
          kind: 'insert',
          model: RECEIPT_ASSOCIATION_MODEL as ModelName,
          row: newAssociationRow(assocData(deliveryId, revision), { nowMs: T0, actor: ACTOR }),
        },
        {
          kind: 'insert',
          model: RECEIPT_MODEL as ModelName,
          row: newReceiptRow(
            {
              deliveryId,
              revision,
              status,
              result,
              error: null,
              contentRef,
              resultExpiresAtMs,
            },
            { nowMs: T0, actor: ACTOR },
          ),
        },
      ]),
    );
  }

  async function workSide(
    store: StoragePort,
    policy: ReturnType<typeof publicPolicy>,
    selected: readonly ReceiptProperty[],
    seed: {
      deliveryId: string;
      revision: number;
      status: ReceiptStatus;
      result: unknown;
      contentRef: string | null;
      resultExpiresAtMs: number | null;
      present: boolean;
    },
  ) {
    const owner = await store.load(ITEM_MODEL, 'item-1' as RecordId);
    assert.ok(owner !== null);
    const paths = await resolveLeafGrantPaths({
      policy,
      model: ITEM_MODEL,
      caller,
      memberships: nullMemberships,
      row: owner,
    });
    return observeSelectedReceipt({
      locator: { record: { id: 'item-1' }, field: FIELD },
      selected,
      association: seed.present ? handAssoc(seed.deliveryId, seed.revision) : null,
      receipt: seed.present
        ? stored(handReceipt(seed.deliveryId, seed.revision, seed.status, seed.result), seed.contentRef)
        : null,
      grants: createSelectedGrants({ field: FIELD, paths }),
      content: createRetentionContentPolicy({
        contentRef: seed.contentRef,
        resultExpiresAtMs: seed.resultExpiresAtMs,
      }),
      nowMs: NOW,
    });
  }

  async function joinSide(
    store: StoragePort,
    schema: DeliveryFieldSchema,
    policy: ReturnType<typeof publicPolicy>,
    selected: readonly ReceiptProperty[],
  ) {
    assertDeliveryField(schema, ITEM_MODEL, FIELD);
    const outcome = await observeSelectedReceiptJoin({
      locator: { record: { id: 'item-1' }, field: FIELD },
      selected,
      model: ITEM_MODEL,
      schema,
      policy,
      caller,
      memberships: nullMemberships,
      store,
      nowMs: NOW,
      observeSelected: observeSelectedReceipt,
    });
    assert.equal(typeof outcome.readRevision, 'number');
    const { readRevision: _read, ...rest } = outcome;
    void _read;
    return rest;
  }

  it('agrees on full selected reads (granted leaves, fence revision)', async () => {
    const store = await setupStore();
    await seedPair(store, 'del_1', 3, 'succeeded', { ok: 1 });
    const schema = createDeliverySchema([[ITEM, [FIELD]]]);
    const policy = publicPolicy(['notification']);
    const seed = {
      deliveryId: 'del_1',
      revision: 3,
      status: 'succeeded' as ReceiptStatus,
      result: { ok: 1 },
      contentRef: null,
      resultExpiresAtMs: null,
      present: true,
    };
    const selected = ['status', 'result'] as const;
    const joined = await joinSide(store, schema, policy, selected);
    const direct = await workSide(store, policy, selected, seed);
    assert.deepEqual(joined, direct);
    assert.deepEqual(joined, {
      outcome: 'observed',
      projection: { status: 'succeeded', result: { ok: 1 } },
      fenceRevision: 3,
    });
  });

  it('agrees on leaf denial (same denied set, nothing else)', async () => {
    const store = await setupStore();
    await seedPair(store, 'del_1', 3, 'succeeded', { ok: 1 });
    const schema = createDeliverySchema([[ITEM, [FIELD]]]);
    const policy = publicPolicy(['notification.status']);
    const seed = {
      deliveryId: 'del_1',
      revision: 3,
      status: 'succeeded' as ReceiptStatus,
      result: { ok: 1 },
      contentRef: null,
      resultExpiresAtMs: null,
      present: true,
    };
    const selected = ['status', 'result'] as const;
    const joined = await joinSide(store, schema, policy, selected);
    const direct = await workSide(store, policy, selected, seed);
    assert.deepEqual(joined, direct);
    assert.deepEqual(joined, { outcome: 'denied', denied: ['result'] });
  });

  it('agrees on null association (no receipt, no fence)', async () => {
    const store = await setupStore();
    const schema = createDeliverySchema([[ITEM, [FIELD]]]);
    const policy = publicPolicy(['notification']);
    const seed = {
      deliveryId: 'del_1',
      revision: 0,
      status: 'pending' as ReceiptStatus,
      result: null,
      contentRef: null,
      resultExpiresAtMs: null,
      present: false,
    };
    const selected = ['status'] as const;
    const joined = await joinSide(store, schema, policy, selected);
    const direct = await workSide(store, policy, selected, seed);
    assert.deepEqual(joined, direct);
    assert.deepEqual(joined, { outcome: 'null-association' });
  });

  it('agrees on retained-content expiry through the join binding', async () => {
    for (const resultExpiresAtMs of [NOW - 1, NOW + 10_000]) {
      const store = await setupStore();
      await seedPair(store, 'del_1', 3, 'succeeded', { ok: 1 }, 'content-9', resultExpiresAtMs);
      const schema = createDeliverySchema([[ITEM, [FIELD]]]);
      const policy = publicPolicy(['notification']);
      const seed = {
        deliveryId: 'del_1',
        revision: 3,
        status: 'succeeded' as ReceiptStatus,
        result: { ok: 1 },
        contentRef: 'content-9',
        resultExpiresAtMs,
        present: true,
      };
      const selected = ['result'] as const;
      const joined = await joinSide(store, schema, policy, selected);
      const direct = await workSide(store, policy, selected, seed);
      assert.deepEqual(joined, direct);
      assert.deepEqual(joined, {
        outcome: 'observed',
        projection: { result: resultExpiresAtMs > NOW ? { ok: 1 } : null },
        fenceRevision: 3,
      });
    }
  });
});
