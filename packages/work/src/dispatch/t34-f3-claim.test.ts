/**
 * T34-F3 fanout child claim: exactly-one-winner per parent+handler+record,
 * stale-snapshot refusal, claim-time guard re-evaluation on a CURRENT
 * snapshot, T32-wire refusal preservation (reused seam, not modified),
 * and duplicate-delivery replay identity.
 *
 * Scope: claim only. Record/retry lives in `t34-f3-record.test.ts`;
 * progress/scheduling lives in `t34-f3-progress.test.ts`. No membership
 * enumeration (F5), no recovery scanning (F4), no quota, no syntax.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FanoutChildId } from '../../../contracts/src/work.js';
import type { StoredRow } from '../../../contracts/src/state.js';
import { TestOnlyManualClock } from '../ports.ts';
import {
  fanoutChildRowId,
  fanoutIntentRowId,
  newFanoutChildRow,
  readFanoutChildRow,
} from '../kernel/tables.ts';
import type { GuardEvaluator } from './index.ts';
import {
  FANOUT_T32_REFUSAL_REASON,
  TestOnlyMemoryFanoutChildStore,
  fanoutChildIdentityKey,
} from './index.ts';

const META = { nowMs: 1_758_000_000_000, actor: 't34-f3-test' };
const OCC = 'occ_f3_claim';
const HANDLER = 'Shift.review_commitment';
const SIBLING_HANDLER = 'Shift.review_swap';
const FANOUT = fanoutIntentRowId(OCC, HANDLER, 'model');

function child(recordId: string, handler: string = HANDLER): FanoutChildId {
  return { parentOccurrence: OCC, handler, recordId };
}

function admittedRow(
  recordId: string,
  handler: string = HANDLER,
  fanoutId: string = FANOUT,
): StoredRow {
  return newFanoutChildRow(
    { fanoutId, parentOccurrence: OCC, handler, recordId },
    META,
  );
}

function storeWith(recordIds: readonly string[]): TestOnlyMemoryFanoutChildStore {
  const store = new TestOnlyMemoryFanoutChildStore(new TestOnlyManualClock(META.nowMs));
  for (const recordId of recordIds) {
    store.insert(admittedRow(recordId));
  }
  return store;
}

const unconditional = { predicate: null };
const currentOf = (snapshot: unknown) => () => snapshot;

describe('t34-f3 claim: exactly-one-winner under concurrency', () => {
  it('grants one winner; the loser holds the existing claim, never a duplicate', async () => {
    const store = storeWith(['rec-1']);
    const id = child('rec-1');
    const before = store.get(id);
    assert.ok(before !== null);
    assert.equal(before.version, 1);
    const attempt = {
      child: id,
      snapshotVersion: 1,
      guard: unconditional,
      frozenInputs: {},
      readCurrentSnapshot: currentOf({}),
    };
    const evaluate: GuardEvaluator = () => true;
    const raced = await Promise.all([
      Promise.resolve().then(() => store.claim(evaluate, attempt)),
      Promise.resolve().then(() => store.claim(evaluate, attempt)),
    ]);
    const claimed = raced.filter((outcome) => outcome.status === 'claimed');
    const held = raced.filter((outcome) => outcome.status === 'held');
    assert.equal(claimed.length, 1);
    assert.equal(held.length, 1);
    // Same child identity, same row: the loser observes the winner.
    assert.equal(claimed[0]?.row.id, held[0]?.row.id);
    assert.equal(claimed[0]?.row.id, fanoutChildRowId(OCC, HANDLER, 'rec-1'));
    // One version bump total (1 -> 2 running); the hold minted nothing.
    assert.equal(claimed[0]?.row.version, 2);
    assert.equal(held[0]?.row.version, 2);
    assert.equal(readFanoutChildRow(held[0]?.row as StoredRow).state, 'running');
    assert.equal(store.listAll().length, 1);
  });

  it('serializes unconditional racers (null snapshot) the same way', async () => {
    const store = storeWith(['rec-race']);
    const id = child('rec-race');
    const evaluate: GuardEvaluator = () => true;
    const input = {
      child: id,
      snapshotVersion: null,
      guard: unconditional,
      frozenInputs: {},
      readCurrentSnapshot: currentOf({}),
    };
    const raced = await Promise.all([
      Promise.resolve().then(() => store.claim(evaluate, input)),
      Promise.resolve().then(() => store.claim(evaluate, input)),
      Promise.resolve().then(() => store.claim(evaluate, input)),
    ]);
    assert.equal(raced.filter((o) => o.status === 'claimed').length, 1);
    assert.equal(raced.filter((o) => o.status === 'held').length, 2);
    assert.equal(store.listAll().length, 1);
  });

  it('keys claims by parent+handler+record: sibling handlers never collide', () => {
    assert.notEqual(
      fanoutChildIdentityKey(child('rec-1', HANDLER)),
      fanoutChildIdentityKey(child('rec-1', SIBLING_HANDLER)),
    );
    const store = new TestOnlyMemoryFanoutChildStore(new TestOnlyManualClock(META.nowMs));
    store.insert(admittedRow('rec-1', HANDLER));
    store.insert(admittedRow('rec-1', SIBLING_HANDLER));
    const evaluate: GuardEvaluator = () => true;
    const first = store.claim(evaluate, {
      child: child('rec-1', HANDLER),
      snapshotVersion: null,
      guard: unconditional,
      frozenInputs: {},
      readCurrentSnapshot: currentOf({}),
    });
    const second = store.claim(evaluate, {
      child: child('rec-1', SIBLING_HANDLER),
      snapshotVersion: null,
      guard: unconditional,
      frozenInputs: {},
      readCurrentSnapshot: currentOf({}),
    });
    // Both win independently: distinct identities, distinct rows.
    assert.equal(first.status, 'claimed');
    assert.equal(second.status, 'claimed');
    assert.notEqual(
      (first as { row: StoredRow }).row.id,
      (second as { row: StoredRow }).row.id,
    );
  });

  it('fails closed when the producer row is missing (never invents)', () => {
    const store = storeWith(['rec-1']);
    assert.throws(
      () =>
        store.claim(() => true, {
          child: child('rec-missing'),
          snapshotVersion: null,
          guard: unconditional,
          frozenInputs: {},
          readCurrentSnapshot: currentOf({}),
        }),
      /producer write missing/,
    );
  });
});

describe('t34-f3 claim: stale snapshots never admit', () => {
  it('refuses a stale version without running fence or guard', () => {
    const store = storeWith(['rec-stale']);
    const id = child('rec-stale');
    const evaluate: GuardEvaluator = () => true;
    // Winner advances 1 -> 2 (running), then back to pending 2 -> 3 via retry.
    const won = store.claim(evaluate, {
      child: id,
      snapshotVersion: 1,
      guard: unconditional,
      frozenInputs: {},
      readCurrentSnapshot: currentOf({}),
    });
    assert.equal(won.status, 'claimed');
    const retried = store.record({
      child: id,
      result: { kind: 'transient' },
      nowMs: META.nowMs,
      firstAttemptAtMs: META.nowMs,
      policy: { maxAttempts: 8, horizonMs: 86_400_000 },
    });
    assert.equal(retried.status, 'retried');
    assert.equal((retried as { row: StoredRow }).row.version, 3);
    let guardRan = false;
    let fenceRan = false;
    const stale = store.claim(
      () => {
        guardRan = true;
        return true;
      },
      {
        child: id,
        snapshotVersion: 1,
        guard: { predicate: 'body.applies' },
        frozenInputs: {},
        readCurrentSnapshot: () => ({}),
        fence: {
          checkpoint: { revision: 4, owner: 'team-a' },
          triggerRevision: { revision: 3 },
          revalidateAuthority: () => {
            fenceRan = true;
            return true;
          },
        },
      },
    );
    assert.equal(stale.status, 'refused-stale');
    assert.equal(guardRan, false);
    assert.equal(fenceRan, false);
    // Current row returned (pending v3, attempts 1); nothing admitted.
    const current = (stale as { row: StoredRow }).row;
    assert.equal(current.version, 3);
    assert.deepEqual(
      [readFanoutChildRow(current).state, readFanoutChildRow(current).attempts],
      ['pending', 1],
    );
  });
});

describe('t34-f3 claim: guard re-evaluated on the CURRENT snapshot', () => {
  it('sees the claim-time value, never the frozen inputs', () => {
    const store = storeWith(['rec-guard']);
    const seen: unknown[] = [];
    const evaluate: GuardEvaluator = (_predicate, _inputs, snapshot) => {
      seen.push(snapshot);
      return (snapshot as { held: number }).held < 2;
    };
    // State moved between staging and claim: frozen says held:1 (admit),
    // current says held:5 (skip). The guard must observe current.
    const outcome = store.claim(evaluate, {
      child: child('rec-guard'),
      snapshotVersion: null,
      guard: { predicate: 'spend.bounded' },
      frozenInputs: { held: 1 },
      readCurrentSnapshot: currentOf({ held: 5 }),
    });
    assert.equal(outcome.status, 'skipped');
    assert.deepEqual(seen, [{ held: 5 }]);
    if (outcome.status !== 'skipped') throw new Error('unreachable');
    assert.deepEqual(outcome.outcome, {
      child: child('rec-guard'),
      state: 'skipped',
      attempts: 0,
      cause: { kind: 'skipped', reason: 'non-applicable' },
    });
    // Skips never increment attempts (T24 precedent).
    assert.equal(readFanoutChildRow(outcome.row).attempts, 0);
  });

  it('claims when the current snapshot passes', () => {
    const store = storeWith(['rec-pass']);
    const outcome = store.claim(() => true, {
      child: child('rec-pass'),
      snapshotVersion: null,
      guard: { predicate: 'body.applies' },
      frozenInputs: {},
      readCurrentSnapshot: currentOf({ eligible: true }),
    });
    assert.equal(outcome.status, 'claimed');
  });

  it('propagates evaluator throws with the row still pending (fail-closed)', () => {
    const store = storeWith(['rec-throw']);
    const id = child('rec-throw');
    assert.throws(
      () =>
        store.claim(
          () => {
            throw new Error('guard exploded');
          },
          {
            child: id,
            snapshotVersion: null,
            guard: { predicate: 'body.applies' },
            frozenInputs: {},
            readCurrentSnapshot: currentOf({}),
          },
        ),
      /guard exploded/,
    );
    const current = store.get(id);
    assert.ok(current !== null);
    assert.equal(readFanoutChildRow(current).state, 'pending');
    assert.equal(current.version, 1);
  });
});

describe('t34-f3 claim: T32 fence consulted (reused seam)', () => {
  it('claims when the transitive scope is fresh and authority revalidates', () => {
    const store = storeWith(['rec-fresh']);
    const outcome = store.claim(() => true, {
      child: child('rec-fresh'),
      snapshotVersion: null,
      guard: { predicate: 'spend.bounded' },
      frozenInputs: {},
      readCurrentSnapshot: currentOf({ held: 1 }),
      fence: {
        checkpoint: { revision: 4, owner: 'team-a' },
        triggerRevision: { revision: 3 },
        revalidateAuthority: () => true,
      },
    });
    assert.equal(outcome.status, 'claimed');
  });

  it('preserves refused-inherited-scope as failed without running the guard', () => {
    const store = storeWith(['rec-inherited']);
    const id = child('rec-inherited');
    let guardRan = false;
    const outcome = store.claim(
      () => {
        guardRan = true;
        return true;
      },
      {
        child: id,
        snapshotVersion: null,
        guard: { predicate: 'spend.bounded' },
        frozenInputs: {},
        readCurrentSnapshot: () => {
          throw new Error('current snapshot must not be read on inherited scope');
        },
        fence: {
          checkpoint: { revision: 3, owner: 'team-a' },
          triggerRevision: { revision: 3 },
          revalidateAuthority: () => true,
        },
      },
    );
    assert.equal(outcome.status, 'refused-inherited-scope');
    assert.equal(guardRan, false);
    assert.equal(FANOUT_T32_REFUSAL_REASON, 'inaccessible-record');
    if (outcome.status !== 'refused-inherited-scope') throw new Error('unreachable');
    assert.deepEqual(outcome.outcome, {
      child: id,
      state: 'failed',
      attempts: 0,
      cause: { kind: 'failed', reason: 'inaccessible-record' },
    });
    // Terminal failed: never retried as pending, never deletion.
    const current = store.get(id);
    assert.ok(current !== null);
    assert.deepEqual(
      [
        readFanoutChildRow(current).state,
        readFanoutChildRow(current).causeReason,
        readFanoutChildRow(current).attempts,
      ],
      ['failed', 'inaccessible-record', 0],
    );
  });

  it('preserves refused-revoked as failed after the guard passes', () => {
    const store = storeWith(['rec-revoked']);
    const id = child('rec-revoked');
    let guardRan = false;
    const outcome = store.claim(
      () => {
        guardRan = true;
        return true;
      },
      {
        child: id,
        snapshotVersion: null,
        guard: { predicate: 'spend.bounded' },
        frozenInputs: {},
        readCurrentSnapshot: currentOf({ held: 1 }),
        fence: {
          checkpoint: { revision: 4, owner: 'team-a' },
          triggerRevision: { revision: 3 },
          revalidateAuthority: () => false,
        },
      },
    );
    assert.equal(outcome.status, 'refused-revoked');
    assert.equal(guardRan, true);
    if (outcome.status !== 'refused-revoked') throw new Error('unreachable');
    assert.deepEqual(outcome.outcome.cause, { kind: 'failed', reason: 'inaccessible-record' });
    assert.deepEqual(outcome.outcome.child, id);
    const current = store.get(id);
    assert.ok(current !== null);
    assert.equal(readFanoutChildRow(current).state, 'failed');
  });

  it('keeps exact pre-T32b behavior when no fence is presented', () => {
    const store = storeWith(['rec-nofence']);
    const outcome = store.claim(() => true, {
      child: child('rec-nofence'),
      snapshotVersion: null,
      guard: { predicate: 'spend.bounded' },
      frozenInputs: {},
      readCurrentSnapshot: currentOf({}),
    });
    assert.equal(outcome.status, 'claimed');
  });
});

describe('t34-f3 claim: duplicate delivery replays the recorded outcome', () => {
  it('replays terminal outcomes, minting nothing (no version bump)', () => {
    const store = storeWith(['rec-replay']);
    const id = child('rec-replay');
    const claimed = store.claim(() => true, {
      child: id,
      snapshotVersion: null,
      guard: unconditional,
      frozenInputs: {},
      readCurrentSnapshot: currentOf({}),
    });
    assert.equal(claimed.status, 'claimed');
    const recorded = store.record({
      child: id,
      result: { kind: 'completed' },
      nowMs: META.nowMs,
      firstAttemptAtMs: META.nowMs,
      policy: { maxAttempts: 3, horizonMs: 1000 },
    });
    assert.equal(recorded.status, 'recorded');
    if (recorded.status !== 'recorded') throw new Error('unreachable');
    const version = recorded.row.version;
    // Duplicate claim replays the recorded outcome with the identical row.
    const replay = store.claim(() => true, {
      child: id,
      snapshotVersion: 1,
      guard: { predicate: 'ignored-after-terminal' },
      frozenInputs: {},
      readCurrentSnapshot: () => {
        throw new Error('replay must not read the snapshot');
      },
      fence: {
        checkpoint: { revision: 9, owner: 'team-a' },
        triggerRevision: { revision: 9 },
        revalidateAuthority: () => false,
      },
    });
    assert.equal(replay.status, 'replayed');
    if (replay.status !== 'replayed') throw new Error('unreachable');
    assert.deepEqual(replay.outcome, recorded.outcome);
    assert.equal(replay.row.version, version);
    assert.equal(store.listAll().length, 1);
  });
});
