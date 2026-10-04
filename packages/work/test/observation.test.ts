/** S6: receipt observation — leaf grants, availability, revision echo, triples. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ReceiptError,
  ReceiptProperty,
  ReceiptStatus,
} from '../../contracts/src/work.js';
import {
  TestOnlyAllowAllGrants,
  TestOnlyAvailabilityMap,
  TestOnlyDenyAllGrants,
  TestOnlyGrantSet,
  TestOnlyScriptedAvailability,
} from '../src/observation/ports.ts';
import type {
  ContentPolicyPort,
  GrantPort,
  ObservationGrantContext,
} from '../src/observation/ports.ts';
import { observeReceipt } from '../src/observation/observation.ts';
import type { StoredReceipt } from '../src/observation/observation.ts';

const NOW = 1_791_120_000_000;
const ALL: readonly ReceiptProperty[] = ['id', 'status', 'result', 'error'];

function storedReceipt(overrides: Partial<StoredReceipt> = {}): StoredReceipt {
  return {
    deliveryId: 'del_1',
    revision: 7,
    status: 'succeeded',
    result: { reference: 'pay_1' },
    error: null,
    contentRef: 'content_1',
    ...overrides,
  };
}

/** Test-local recording grants (the shipped doubles do not record calls). */
class RecordingGrants implements GrantPort {
  readonly calls: Array<{ property: ReceiptProperty; context: ObservationGrantContext }> = [];
  private readonly granted: ReadonlySet<ReceiptProperty>;

  constructor(granted: ReadonlySet<ReceiptProperty>) {
    this.granted = granted;
  }

  mayObserve(property: ReceiptProperty, context: ObservationGrantContext): boolean {
    this.calls.push({ property, context });
    return this.granted.has(property);
  }
}

/** Test-local recording availability. */
class RecordingAvailability implements ContentPolicyPort {
  readonly calls: Array<{ contentRef: string; nowMs: number }> = [];
  private readonly available: boolean;

  constructor(available: boolean) {
    this.available = available;
  }

  isResultAvailable(contentRef: string, nowMs: number): boolean {
    this.calls.push({ contentRef, nowMs });
    return this.available;
  }
}

describe('observation: leaf-grant matrix', () => {
  it('full grant discloses every requested leaf', () => {
    const observed = observeReceipt({
      receipt: storedReceipt(),
      requested: ALL,
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap({ content_1: true }),
      nowMs: NOW,
    });
    assert.deepEqual(observed, {
      id: 'del_1',
      revision: 7,
      status: 'succeeded',
      result: { reference: 'pay_1' },
      error: null,
    });
  });

  it('status-only grant sees status with null result/error but keeps id', () => {
    const observed = observeReceipt({
      receipt: storedReceipt(),
      requested: ALL,
      grants: new TestOnlyGrantSet(['status']),
      content: new TestOnlyAvailabilityMap({ content_1: true }),
      nowMs: NOW,
    });
    assert.deepEqual(observed, {
      id: 'del_1',
      revision: 7,
      status: 'succeeded',
      result: null,
      error: null,
    });
  });

  it('no grant sees nulls but keeps id and the status summary', () => {
    // Pinned behavior: id/status/revision are the always-truthful summary
    // (the contract cannot represent a withheld status); only result/error
    // gate to null. Readers without the status grant are handled by the
    // projection layer above, which omits the field.
    const observed = observeReceipt({
      receipt: storedReceipt(),
      requested: ALL,
      grants: new TestOnlyDenyAllGrants(),
      content: new TestOnlyAvailabilityMap({ content_1: true }),
      nowMs: NOW,
    });
    assert.deepEqual(observed, {
      id: 'del_1',
      revision: 7,
      status: 'succeeded',
      result: null,
      error: null,
    });
  });

  it('result-only grant discloses the result while the error stays null', () => {
    const observed = observeReceipt({
      receipt: storedReceipt(),
      requested: ALL,
      grants: new TestOnlyGrantSet(['result']),
      content: new TestOnlyAvailabilityMap({ content_1: true }),
      nowMs: NOW,
    });
    assert.deepEqual(observed.result, { reference: 'pay_1' });
    assert.equal(observed.error, null);
    assert.equal(observed.status, 'succeeded');
  });

  it('error-only grant discloses a failed error', () => {
    const observed = observeReceipt({
      receipt: storedReceipt({
        status: 'failed',
        result: null,
        error: { code: 'rejected', message: 'nope' },
        contentRef: null,
      }),
      requested: ALL,
      grants: new TestOnlyGrantSet(['error']),
      content: new TestOnlyAvailabilityMap(),
      nowMs: NOW,
    });
    assert.deepEqual(observed.error, { code: 'rejected', message: 'nope' });
    assert.equal(observed.result, null);
    assert.equal(observed.status, 'failed');
  });

  it('unrequested leaves read null even when granted', () => {
    const observed = observeReceipt({
      receipt: storedReceipt(),
      requested: ['status'],
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap({ content_1: true }),
      nowMs: NOW,
    });
    assert.deepEqual(observed, {
      id: 'del_1',
      revision: 7,
      status: 'succeeded',
      result: null,
      error: null,
    });
  });

  it('empty request still carries the id/status summary', () => {
    const observed = observeReceipt({
      receipt: storedReceipt(),
      requested: [],
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap({ content_1: true }),
      nowMs: NOW,
    });
    assert.deepEqual(observed, {
      id: 'del_1',
      revision: 7,
      status: 'succeeded',
      result: null,
      error: null,
    });
  });

  it('unknown requested properties throw instead of leaking', () => {
    assert.throws(
      () =>
        observeReceipt({
          receipt: storedReceipt(),
          requested: ['bogus' as unknown as ReceiptProperty],
          grants: new TestOnlyAllowAllGrants(),
          content: new TestOnlyAvailabilityMap(),
          nowMs: NOW,
        }),
      RangeError,
    );
  });

  it('grant port is consulted exactly for requested nullable leaves', () => {
    const grants = new RecordingGrants(new Set(ALL));
    observeReceipt({
      receipt: storedReceipt(),
      requested: ALL,
      grants,
      content: new TestOnlyAvailabilityMap({ content_1: true }),
      nowMs: NOW,
    });
    assert.deepEqual(
      grants.calls.map((call) => call.property),
      ['result', 'error'],
    );
    for (const call of grants.calls) {
      assert.deepEqual(call.context, { deliveryId: 'del_1', revision: 7 });
    }

    const statusOnly = new RecordingGrants(new Set(ALL));
    observeReceipt({
      receipt: storedReceipt(),
      requested: ['status'],
      grants: statusOnly,
      content: new TestOnlyAvailabilityMap(),
      nowMs: NOW,
    });
    assert.equal(statusOnly.calls.length, 0);
  });

  it('duplicate requests consult the grant port once', () => {
    const grants = new RecordingGrants(new Set(ALL));
    observeReceipt({
      receipt: storedReceipt(),
      requested: ['result', 'result'],
      grants,
      content: new TestOnlyAvailabilityMap({ content_1: true }),
      nowMs: NOW,
    });
    assert.equal(grants.calls.length, 1);
    assert.equal(grants.calls[0]?.property, 'result');
  });
});

describe('observation: revision echo and fence signaling', () => {
  it('echoes the enrolled observation revision', () => {
    const observed = observeReceipt({
      receipt: storedReceipt({ revision: 42 }),
      requested: ['status'],
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap(),
      nowMs: NOW,
    });
    assert.equal(observed.revision, 42);
  });

  it('a newer receipt revision differs so the fence invalidates', () => {
    const base = {
      requested: ALL,
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap({ content_1: true }),
      nowMs: NOW,
    } as const;
    const held = observeReceipt({
      ...base,
      receipt: storedReceipt({ revision: 5, status: 'pending', result: null, contentRef: null }),
    });
    const current = observeReceipt({ ...base, receipt: storedReceipt({ revision: 6 }) });
    assert.equal(held.revision, 5);
    assert.equal(current.revision, 6);
    // The comparison the runtime read fence performs: an intervening update
    // (revision drift) invalidates/retries evaluation under conflict rules.
    assert.notEqual(held.revision, current.revision);
  });
});

describe('observation: withheld vs pending vs failed triples', () => {
  interface TripleCase {
    name: string;
    status: ReceiptStatus;
    result: unknown;
    error: ReceiptError | null;
    contentRef: string | null;
    available: boolean;
    expected: [ReceiptStatus, unknown, ReceiptError | null];
  }

  const cases: TripleCase[] = [
    {
      name: 'pending has no outcome',
      status: 'pending',
      result: null,
      error: null,
      contentRef: null,
      available: false,
      expected: ['pending', null, null],
    },
    {
      name: 'succeeded discloses an available result',
      status: 'succeeded',
      result: { reference: 'pay_1' },
      error: null,
      contentRef: 'content_1',
      available: true,
      expected: ['succeeded', { reference: 'pay_1' }, null],
    },
    {
      name: 'succeeded with withheld result keeps its summary',
      status: 'succeeded',
      result: { reference: 'pay_1' },
      error: null,
      contentRef: 'content_1',
      available: false,
      expected: ['succeeded', null, null],
    },
    {
      name: 'succeeded with genuinely-null result',
      status: 'succeeded',
      result: null,
      error: null,
      contentRef: null,
      available: false,
      expected: ['succeeded', null, null],
    },
    {
      name: 'failed discloses its closed error',
      status: 'failed',
      result: null,
      error: { code: 'rejected', message: 'nope' },
      contentRef: null,
      available: false,
      expected: ['failed', null, { code: 'rejected', message: 'nope' }],
    },
    {
      name: 'unknown carries a diagnostic error or null',
      status: 'unknown',
      result: null,
      error: { code: 'timeout', message: 'maybe committed' },
      contentRef: null,
      available: false,
      expected: ['unknown', null, { code: 'timeout', message: 'maybe committed' }],
    },
    {
      name: 'unknown without diagnostics',
      status: 'unknown',
      result: null,
      error: null,
      contentRef: null,
      available: false,
      expected: ['unknown', null, null],
    },
    {
      name: 'skipped discloses nothing',
      status: 'skipped',
      result: null,
      error: null,
      contentRef: null,
      available: false,
      expected: ['skipped', null, null],
    },
  ];

  for (const triple of cases) {
    it(triple.name, () => {
      const observed = observeReceipt({
        receipt: storedReceipt({
          status: triple.status,
          result: triple.result,
          error: triple.error,
          contentRef: triple.contentRef,
        }),
        requested: ALL,
        grants: new TestOnlyAllowAllGrants(),
        content: new TestOnlyAvailabilityMap({ content_1: triple.available }),
        nowMs: NOW,
      });
      assert.deepEqual([observed.status, observed.result, observed.error], triple.expected);
    });
  }

  it('withheld, ungranted and genuinely-null results share one triple', () => {
    const shape = { id: 'del_1', revision: 7, status: 'succeeded', result: null, error: null };
    const withheld = observeReceipt({
      receipt: storedReceipt(),
      requested: ALL,
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap({ content_1: false }),
      nowMs: NOW,
    });
    const ungranted = observeReceipt({
      receipt: storedReceipt(),
      requested: ALL,
      grants: new TestOnlyDenyAllGrants(),
      content: new TestOnlyAvailabilityMap({ content_1: true }),
      nowMs: NOW,
    });
    const genuinelyNull = observeReceipt({
      receipt: storedReceipt({ result: null, contentRef: null }),
      requested: ALL,
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap(),
      nowMs: NOW,
    });
    assert.deepEqual(withheld, shape);
    assert.deepEqual(ungranted, shape);
    assert.deepEqual(genuinelyNull, shape);
  });

  it('denied result never consults the availability policy', () => {
    const content = new RecordingAvailability(true);
    const observed = observeReceipt({
      receipt: storedReceipt(),
      requested: ALL,
      grants: new TestOnlyGrantSet(['status']),
      content,
      nowMs: NOW,
    });
    assert.equal(observed.result, null);
    assert.equal(content.calls.length, 0);
  });

  it('inline results never consult the availability policy', () => {
    const content = new RecordingAvailability(false);
    const observed = observeReceipt({
      receipt: storedReceipt({ contentRef: null }),
      requested: ALL,
      grants: new TestOnlyAllowAllGrants(),
      content,
      nowMs: NOW,
    });
    assert.deepEqual(observed.result, { reference: 'pay_1' });
    assert.equal(content.calls.length, 0);
  });

  it('remote results consult the policy once with ref and time', () => {
    const content = new RecordingAvailability(true);
    observeReceipt({
      receipt: storedReceipt(),
      requested: ALL,
      grants: new TestOnlyAllowAllGrants(),
      content,
      nowMs: NOW,
    });
    assert.deepEqual(content.calls, [{ contentRef: 'content_1', nowMs: NOW }]);
  });

  it('withheld content is never refilled: repeat reads stay null', () => {
    const receipt = storedReceipt();
    const requested: readonly ReceiptProperty[] = ['status', 'result'];
    Object.freeze(receipt);
    Object.freeze(requested);
    const input = {
      receipt,
      requested,
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap({ content_1: false }),
      nowMs: NOW,
    } as const;
    const first = observeReceipt({ ...input });
    const second = observeReceipt({ ...input });
    assert.deepEqual([first.status, first.result, first.error], ['succeeded', null, null]);
    assert.deepEqual(second, first);
  });
});

describe('observation: no lookup by text id', () => {
  it('values flow only from the supplied stored receipt', () => {
    // By construction: the signature takes the loaded record and offers no
    // store/fetch port, so there is no channel for an id-based lookup.
    const input = {
      receipt: storedReceipt({
        deliveryId: 'del_only_from_input',
        revision: 11,
        status: 'failed',
        result: null,
        error: { code: 'gone', message: 'gone' },
        contentRef: null,
      }),
      requested: ALL,
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap(),
      nowMs: NOW,
    } as const;
    assert.deepEqual(Object.keys(input).sort(), [
      'content',
      'grants',
      'nowMs',
      'receipt',
      'requested',
    ]);
    assert.equal(observeReceipt.length, 1);
    const observed = observeReceipt({ ...input });
    assert.deepEqual(observed, {
      id: 'del_only_from_input',
      revision: 11,
      status: 'failed',
      result: null,
      error: { code: 'gone', message: 'gone' },
    });
  });
});

describe('observation: input validation', () => {
  it('rejects bad clocks, receipts and content refs', () => {
    const base = {
      receipt: storedReceipt(),
      requested: ALL,
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap({ content_1: true }),
    } as const;
    for (const nowMs of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      assert.throws(() => observeReceipt({ ...base, nowMs }), RangeError);
    }
    assert.throws(
      () => observeReceipt({ ...base, receipt: storedReceipt({ deliveryId: '' }), nowMs: NOW }),
      RangeError,
    );
    for (const revision of [-1, 1.5, Number.NaN]) {
      assert.throws(
        () => observeReceipt({ ...base, receipt: storedReceipt({ revision }), nowMs: NOW }),
        RangeError,
      );
    }
    assert.throws(
      () =>
        observeReceipt({
          ...base,
          receipt: storedReceipt({ contentRef: '' }),
          nowMs: NOW,
        }),
      RangeError,
    );
  });

  it('ignores unusable content refs when the result is not disclosed', () => {
    const observed = observeReceipt({
      receipt: storedReceipt({ contentRef: '' }),
      requested: ['status'],
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap(),
      nowMs: NOW,
    });
    assert.equal(observed.result, null);
  });

  it('normalizes undefined stored payloads to null', () => {
    const observed = observeReceipt({
      receipt: storedReceipt({ result: undefined, contentRef: 'content_1' }),
      requested: ALL,
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap({ content_1: true }),
      nowMs: NOW,
    });
    assert.equal(observed.result, null);
  });
});

describe('observation: test-only doubles', () => {
  it('allow-all, deny-all and grant sets decide per leaf', () => {
    const context = { deliveryId: 'del_1', revision: 7 };
    const allow = new TestOnlyAllowAllGrants();
    const deny = new TestOnlyDenyAllGrants();
    const set = new TestOnlyGrantSet(['status', 'result']);
    for (const property of ALL) {
      assert.equal(allow.mayObserve(property, context), true);
      assert.equal(deny.mayObserve(property, context), false);
    }
    assert.equal(set.mayObserve('status', context), true);
    assert.equal(set.mayObserve('result', context), true);
    assert.equal(set.mayObserve('error', context), false);
    assert.equal(set.mayObserve('id', context), false);
  });

  it('scripted availability replays then repeats, rejecting empty scripts', () => {
    const scripted = new TestOnlyScriptedAvailability([true, false]);
    assert.equal(scripted.isResultAvailable('a', NOW), true);
    assert.equal(scripted.isResultAvailable('a', NOW), false);
    assert.equal(scripted.isResultAvailable('a', NOW), false);
    assert.throws(() => new TestOnlyScriptedAvailability([]), RangeError);
  });

  it('availability map fails closed on unknown refs', () => {
    assert.equal(new TestOnlyAvailabilityMap().isResultAvailable('missing', NOW), false);
    const map = new TestOnlyAvailabilityMap({ a: true, b: false });
    assert.equal(map.isResultAvailable('a', NOW), true);
    assert.equal(map.isResultAvailable('b', NOW), false);
    assert.equal(map.isResultAvailable('c', NOW), false);
  });
});
