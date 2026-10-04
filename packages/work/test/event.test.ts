/** S3: occurrence admission — idempotent execution, committed-change handling. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CommittedChangeEvent } from '../../contracts/src/work.js';
import {
  TestOnlyManualClock,
  TestOnlyMemoryOccurrenceStore,
} from '../src/ports.ts';
import type { EventDeps } from '../src/event/index.ts';
import { admitCommittedChange, admitOccurrence } from '../src/event/index.ts';

function setup(): EventDeps {
  return {
    occurrences: new TestOnlyMemoryOccurrenceStore(),
    clock: new TestOnlyManualClock(1_000_000),
  };
}

describe('event: occurrence admission', () => {
  it('executes once and records the receipt', () => {
    const deps = setup();
    let executions = 0;
    const admission = admitOccurrence(deps, 'occ_1', () => {
      executions += 1;
      return { status: 'completed', result: { ok: true } };
    });
    assert.equal(executions, 1);
    assert.equal(admission.duplicate, false);
    assert.equal(admission.receipt.occurrenceId, 'occ_1');
    assert.equal(admission.receipt.status, 'completed');
    assert.deepEqual(admission.receipt.result, { ok: true });
    assert.equal(admission.receipt.recordedAtMs, 1_000_000);
  });

  it('replays the recorded receipt on duplicate delivery without re-executing', () => {
    const deps = setup();
    let executions = 0;
    const first = admitOccurrence(deps, 'occ_1', () => {
      executions += 1;
      return { status: 'completed', result: 42 };
    });
    const second = admitOccurrence(deps, 'occ_1', () => {
      executions += 1;
      return { status: 'completed', result: 43 };
    });
    assert.equal(executions, 1);
    assert.equal(second.duplicate, true);
    assert.deepEqual(second.receipt, first.receipt);
    assert.equal(second.receipt.result, 42);
  });

  it('records terminal failures and replays them', () => {
    const deps = setup();
    let executions = 0;
    const run = () =>
      admitOccurrence(deps, 'occ_9', () => {
        executions += 1;
        return { status: 'failed', code: 'require-false', message: 'rejected' };
      });
    const first = run();
    const second = run();
    assert.equal(executions, 1);
    assert.equal(first.receipt.status, 'failed');
    assert.equal(first.receipt.result, null);
    assert.equal(first.receipt.code, 'require-false');
    assert.equal(second.duplicate, true);
    assert.deepEqual(second.receipt, first.receipt);
  });

  it('propagates transient throws without recording so the same occurrence retries', () => {
    const deps = setup();
    let executions = 0;
    assert.throws(
      () =>
        admitOccurrence(deps, 'occ_t', () => {
          executions += 1;
          throw new Error('connection reset');
        }),
      /connection reset/,
    );
    assert.equal(deps.occurrences.hasReceipt('occ_t'), false);
    const retry = admitOccurrence(deps, 'occ_t', () => {
      executions += 1;
      return { status: 'completed', result: 'recovered' };
    });
    assert.equal(executions, 2);
    assert.equal(retry.duplicate, false);
    assert.equal(retry.receipt.result, 'recovered');
  });

  it('keeps independent occurrences independent', () => {
    const deps = setup();
    admitOccurrence(deps, 'occ_a', () => ({ status: 'completed', result: 'a' }));
    const other = admitOccurrence(deps, 'occ_b', () => ({ status: 'completed', result: 'b' }));
    assert.equal(other.duplicate, false);
    assert.equal(other.receipt.result, 'b');
  });
});

describe('event: committed-change payload handling', () => {
  const event: CommittedChangeEvent = {
    recordId: 'rec_1',
    owner: 'team_1',
    version: 3,
    occurrenceId: 'occ_chg_1',
  };

  it('loads current authority state and handles on first delivery', () => {
    const deps = setup();
    let loads = 0;
    let handled: unknown = null;
    const admission = admitCommittedChange(
      deps,
      event,
      (incoming) => {
        loads += 1;
        assert.equal(incoming.recordId, 'rec_1');
        assert.equal(incoming.owner, 'team_1');
        return { title: 'current' };
      },
      (handling) => {
        handled = handling.current;
        assert.equal(handling.event.version, 3);
        return { status: 'completed', result: 'done' };
      },
    );
    assert.equal(loads, 1);
    assert.deepEqual(handled, { title: 'current' });
    assert.equal(admission.duplicate, false);
  });

  it('skips loading and handling on duplicate delivery', () => {
    const deps = setup();
    let loads = 0;
    let handles = 0;
    const run = () =>
      admitCommittedChange(
        deps,
        event,
        () => {
          loads += 1;
          return { title: 'current' };
        },
        () => {
          handles += 1;
          return { status: 'completed', result: 'done' };
        },
      );
    run();
    const replay = run();
    assert.equal(loads, 1);
    assert.equal(handles, 1);
    assert.equal(replay.duplicate, true);
  });

  it('passes a null current state when the record is gone', () => {
    const deps = setup();
    const admission = admitCommittedChange(
      deps,
      event,
      () => null,
      (handling) => {
        assert.equal(handling.current, null);
        return { status: 'completed', result: 'obsolete-check-done' };
      },
    );
    assert.equal(admission.receipt.result, 'obsolete-check-done');
  });

  it('rejects malformed committed-change payloads', () => {
    const deps = setup();
    const load = () => null;
    const handle = () => ({ status: 'completed' as const, result: null });
    assert.throws(
      () => admitCommittedChange(deps, { ...event, recordId: '' }, load, handle),
      RangeError,
    );
    assert.throws(
      () => admitCommittedChange(deps, { ...event, occurrenceId: '' }, load, handle),
      RangeError,
    );
    assert.throws(
      () => admitCommittedChange(deps, { ...event, version: -1 }, load, handle),
      RangeError,
    );
  });
});
