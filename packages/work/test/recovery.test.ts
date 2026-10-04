/** S3: recovery — inventory, bounded due scans, stale-claim expiry. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  DispatchClaim,
  OutboxId,
  OutboxItem,
  ScheduledOccurrence,
  WorkScope,
} from '../../contracts/src/work.js';
import {
  buildInventory,
  drainDueScan,
  findStaleClaims,
  isClaimStale,
  releaseStaleClaims,
  scanDueBatch,
} from '../src/recovery/index.ts';
import type { DueRowSupplier } from '../src/recovery/index.ts';

const scope: WorkScope = { app: 'CanApprove', ownerPackage: 'Approval', owner: 'team_1' };

function outboxItem(id: string, state: OutboxItem['state']): OutboxItem {
  return {
    id,
    operationId: '0193f2c0-0000-7000-8000-000000000001',
    source: 'Mail.send',
    occurrenceIndex: 0,
    request: {},
    attempts: 0,
    state,
  };
}

function dueOccurrence(key: string): ScheduledOccurrence {
  return {
    key,
    scope,
    at: 1_791_120_000_000,
    event: 'Approval.remind',
    payload: {},
    state: 'pending',
  };
}

describe('recovery: pending-work inventory', () => {
  it('counts states and reports the oldest uncertain commit', () => {
    const committed = new Map<OutboxId, number>([
      ['obx_u1', 5000],
      ['obx_u2', 2000],
    ]);
    const inventory = buildInventory({
      outboxItems: [
        outboxItem('obx_p1', 'pending'),
        outboxItem('obx_p2', 'pending'),
        outboxItem('obx_c', 'claimed'),
        outboxItem('obx_u1', 'uncertain'),
        outboxItem('obx_u2', 'uncertain'),
        outboxItem('obx_d', 'dead'),
        outboxItem('obx_done', 'delivered'),
        outboxItem('obx_f', 'failed'),
      ],
      dueOccurrences: [dueOccurrence('a'), dueOccurrence('b'), dueOccurrence('c')],
      committedAtMs: (id) => committed.get(id) ?? null,
    });
    assert.deepEqual(inventory, {
      outboxPending: 2,
      outboxClaimed: 1,
      outboxUncertain: 2,
      outboxDead: 1,
      dueOccurrences: 3,
      oldestUncertainAt: 2000,
    });
  });

  it('reports null oldestUncertainAt when nothing is uncertain', () => {
    const inventory = buildInventory({
      outboxItems: [outboxItem('obx_p', 'pending')],
      dueOccurrences: [],
      committedAtMs: () => 1234,
    });
    assert.equal(inventory.oldestUncertainAt, null);
    assert.equal(inventory.outboxUncertain, 0);
  });
});

describe('recovery: bounded due-work scan', () => {
  const rows = ['r0', 'r1', 'r2', 'r3', 'r4'];
  // Cursor is the next index encoded as text.
  const supplier: DueRowSupplier<string> = (cursor, limit) => {
    const start = cursor === null ? 0 : Number(cursor);
    const slice = rows.slice(start, start + limit);
    const end = start + slice.length;
    return { rows: slice, nextCursor: end < rows.length ? String(end) : null };
  };

  it('pages through batches with an explicit resume cursor', () => {
    const first = scanDueBatch(supplier, { limit: 2 });
    assert.deepEqual(first.rows, ['r0', 'r1']);
    assert.equal(first.done, false);
    assert.equal(first.nextCursor, '2');
    const second = scanDueBatch(supplier, { cursor: first.nextCursor, limit: 2 });
    assert.deepEqual(second.rows, ['r2', 'r3']);
    assert.equal(second.done, false);
    const third = scanDueBatch(supplier, { cursor: second.nextCursor, limit: 2 });
    assert.deepEqual(third.rows, ['r4']);
    assert.equal(third.done, true);
    assert.equal(third.nextCursor, null);
  });

  it('never silently truncates: drain reports done=false with a resume cursor at the cap', () => {
    const partial = drainDueScan(supplier, { limit: 2, maxBatches: 1 });
    assert.deepEqual(partial.rows, ['r0', 'r1']);
    assert.equal(partial.done, false);
    assert.equal(partial.batches, 1);
    const resumed = drainDueScan(supplier, {
      limit: 2,
      maxBatches: 10,
      startCursor: partial.nextCursor,
    });
    assert.deepEqual(resumed.rows, ['r2', 'r3', 'r4']);
    assert.equal(resumed.done, true);
    // Full drain in one call assembles the identical set.
    const full = drainDueScan(supplier, { limit: 2, maxBatches: 10 });
    assert.deepEqual(full.rows, rows);
    assert.equal(full.done, true);
  });

  it('rejects invalid limits and loud over-delivery', () => {
    assert.throws(() => scanDueBatch(supplier, { limit: 0 }), RangeError);
    const greedy: DueRowSupplier<string> = () => ({ rows: ['a', 'b'], nextCursor: null });
    assert.throws(() => scanDueBatch(greedy, { limit: 1 }), /over-delivered/);
    assert.throws(() => drainDueScan(supplier, { limit: 2, maxBatches: 0 }), RangeError);
  });
});

describe('recovery: stale-claim expiry', () => {
  const claim = (claimId: string, outboxId: string, claimedAt: number): DispatchClaim => ({
    outboxId,
    claimId,
    claimedAt,
  });

  it('treats the age boundary as stale', () => {
    assert.equal(isClaimStale(claim('c', 'o', 1000), 2000, 1000), true);
    assert.equal(isClaimStale(claim('c', 'o', 1000), 1999, 1000), false);
    assert.throws(() => isClaimStale(claim('c', 'o', 1000), 2000, -1), RangeError);
  });

  it('finds stale claims in stable order', () => {
    const found = findStaleClaims(
      [claim('c_z', 'o_z', 0), claim('c_a', 'o_a', 0), claim('c_fresh', 'o_f', 1900)],
      2000,
      1000,
    );
    assert.deepEqual(
      found.map((c) => c.claimId),
      ['c_a', 'c_z'],
    );
  });

  it('releases only claimed items whose recorded claim is stale', () => {
    const items = [
      outboxItem('obx_stale', 'claimed'),
      outboxItem('obx_fresh', 'claimed'),
      outboxItem('obx_orphan', 'claimed'),
      outboxItem('obx_pending', 'pending'),
      outboxItem('obx_dead', 'dead'),
    ];
    const claims = [claim('c1', 'obx_stale', 0), claim('c2', 'obx_fresh', 1900)];
    const result = releaseStaleClaims(items, claims, 2000, 1000);
    assert.deepEqual(result.releasedIds, ['obx_stale']);
    const byId = new Map(result.items.map((item) => [item.id, item.state]));
    assert.equal(byId.get('obx_stale'), 'pending');
    assert.equal(byId.get('obx_fresh'), 'claimed');
    assert.equal(byId.get('obx_orphan'), 'claimed');
    assert.equal(byId.get('obx_pending'), 'pending');
    assert.equal(byId.get('obx_dead'), 'dead');
  });
});
