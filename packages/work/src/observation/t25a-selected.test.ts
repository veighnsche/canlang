/**
 * T25a selected receipt reads: locator resolution, all-or-nothing
 * selected-leaf authorization, exact-leaf projection, fence enrollment and
 * the status-only disclosure boundary. ISOLATED MECHANISM proofs: pure
 * functions over store-supplied records, no fetch, no fence execution, no
 * dispatch. Shape pins against the fence/dispatch interfaces are labeled
 * as such; the L1/L3 joins ride after T18, and durable proofs ride with
 * them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  CanonicalNominalResult,
  OutboxId,
  ReceiptAssociation,
  ReceiptProperty,
} from '@canlang/contracts';
import { DELIVERY_RESULT_LEAVES } from '@canlang/contracts';
import type { DispatchFence } from '../dispatch/index.js';
import {
  TestOnlyAllowAllGrants,
  TestOnlyAvailabilityMap,
  TestOnlyDenyAllGrants,
  TestOnlyGrantSet,
} from './ports.js';
import type {
  ContentPolicyPort,
  SelectedGrantContext,
  SelectedGrantPort,
} from './ports.js';
import { resolveAssociationLocator } from './association.js';
import {
  authorizeSelectedLeaves,
  observeReceipt,
  observeSelectedReceipt,
  projectSelectedLeaves,
  selectedRequiresFence,
} from './observation.js';
import type { StoredReceipt } from './observation.js';

const NOW = 1_791_120_000_000;
const TEXT_RESULT: CanonicalNominalResult = { name: 'TextRun', fields: DELIVERY_RESULT_LEAVES['TextRun'] };

function association(overrides: Partial<ReceiptAssociation> = {}): ReceiptAssociation {
  return {
    locator: { recordId: 'rec_1', field: 'notification' },
    deliveryId: 'del_1',
    source: 'Mail.send',
    revision: 7,
    ...overrides,
  };
}

function receipt(overrides: Partial<StoredReceipt> = {}): StoredReceipt {
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

/** Test-local recording selected grants. */
class RecordingSelectedGrants implements SelectedGrantPort {
  readonly calls: Array<{ property: ReceiptProperty; context: SelectedGrantContext }> = [];
  private readonly granted: ReadonlySet<ReceiptProperty>;

  constructor(granted: ReadonlySet<ReceiptProperty>) {
    this.granted = granted;
  }

  mayObserve(property: ReceiptProperty, context: SelectedGrantContext): boolean {
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

describe('t25a locator: resolving the record/field binding', () => {
  it('resolves the live record object and the plain field name', () => {
    const record = { id: 'rec_1' };
    const resolved = resolveAssociationLocator({ record, field: 'notification' });
    assert.equal(resolved.record, record);
    assert.equal(resolved.field, 'notification');
  });

  it('rejects non-object locators', () => {
    for (const locator of [null, undefined, 0, 'del_1', true, [], ['record']]) {
      assert.throws(() => resolveAssociationLocator(locator), TypeError);
    }
  });

  it('rejects a text id as the record: there is no string-ID lookup', () => {
    assert.throws(
      () => resolveAssociationLocator({ record: 'del_1', field: 'notification' }),
      /never a text id/,
    );
    assert.throws(
      () => resolveAssociationLocator({ record: 'rec_1', field: 'notification' }),
      TypeError,
    );
  });

  it('rejects null, missing and non-object records', () => {
    assert.throws(() => resolveAssociationLocator({ record: null, field: 'n' }), TypeError);
    assert.throws(() => resolveAssociationLocator({ field: 'notification' }), TypeError);
    assert.throws(
      () => resolveAssociationLocator({ record: ['rec_1'], field: 'notification' }),
      TypeError,
    );
    assert.throws(
      () => resolveAssociationLocator({ record: 7, field: 'notification' }),
      TypeError,
    );
  });

  it('rejects smuggled locator keys instead of ignoring them', () => {
    const record = { id: 'rec_1' };
    for (const extra of ['model', 'id', 'deliveryId', 'delivery_id', 'recordId', 'handle']) {
      assert.throws(
        () => resolveAssociationLocator({ record, field: 'notification', [extra]: 'x' }),
        /unknown locator key/,
      );
    }
  });

  it('rejects empty, missing, non-string and traversal fields', () => {
    const record = { id: 'rec_1' };
    assert.throws(() => resolveAssociationLocator({ record, field: '' }), RangeError);
    assert.throws(() => resolveAssociationLocator({ record }), TypeError);
    assert.throws(() => resolveAssociationLocator({ record, field: 7 }), TypeError);
    for (const field of ['service.notification', 'a.b.c', 'items[0]', 'n[', ']x', '.']) {
      assert.throws(() => resolveAssociationLocator({ record, field }), /never traversal/);
    }
  });
});

describe('t25a authorize: every selected leaf must be granted', () => {
  const context: SelectedGrantContext = { field: 'notification', deliveryId: 'del_1', revision: 7 };

  it('authorizes a fully granted selection', () => {
    assert.deepEqual(
      authorizeSelectedLeaves(['status'], new TestOnlyGrantSet(['status']), context),
      { authorized: true, leaves: ['status'] },
    );
  });

  it('denies the whole read when any selected leaf is denied', () => {
    // A status-only grant cannot observe result: the verdict names the
    // denied leaf and authorizes nothing.
    assert.deepEqual(
      authorizeSelectedLeaves(
        ['status', 'result'],
        new TestOnlyGrantSet(['status']),
        context,
      ),
      { authorized: false, denied: ['result'] },
    );
    assert.deepEqual(
      authorizeSelectedLeaves(
        ['id', 'status', 'result', 'error'],
        new TestOnlyGrantSet(['status']),
        context,
      ),
      { authorized: false, denied: ['id', 'result', 'error'] },
    );
  });

  it('consults the port exactly once per unique leaf, including id/status', () => {
    const grants = new RecordingSelectedGrants(new Set(['id', 'status', 'result', 'error']));
    const verdict = authorizeSelectedLeaves(
      ['status', 'id', 'status', 'result'],
      grants,
      context,
    );
    assert.deepEqual(verdict, { authorized: true, leaves: ['status', 'id', 'result'] });
    assert.deepEqual(
      grants.calls.map((call) => call.property),
      ['status', 'id', 'result'],
    );
    for (const call of grants.calls) {
      assert.deepEqual(call.context, context);
    }
  });

  it('rejects empty, unknown and non-array selections', () => {
    const grants = new TestOnlyAllowAllGrants();
    assert.throws(() => authorizeSelectedLeaves([], grants, context), /must not be empty/);
    assert.throws(
      () =>
        authorizeSelectedLeaves(['bogus' as unknown as ReceiptProperty], grants, context),
      RangeError,
    );
    assert.throws(
      () =>
        authorizeSelectedLeaves('status' as unknown as readonly ReceiptProperty[], grants, context),
      TypeError,
    );
  });
});

describe('t25a project: exactly the selected leaves, nothing more', () => {
  const observed = {
    id: 'del_1',
    revision: 7,
    status: 'succeeded' as const,
    result: { reference: 'pay_1' },
    error: null,
  };

  it('projects precisely the unique selected keys', () => {
    assert.deepEqual(projectSelectedLeaves(observed, ['status']), { status: 'succeeded' });
    assert.deepEqual(Object.keys(projectSelectedLeaves(observed, ['status'])), ['status']);
    assert.deepEqual(projectSelectedLeaves(observed, ['result', 'status', 'result']), {
      result: { reference: 'pay_1' },
      status: 'succeeded',
    });
  });

  it('projects an empty object for an empty selection', () => {
    assert.deepEqual(projectSelectedLeaves(observed, []), {});
  });

  it('rejects unknown and non-array selections', () => {
    assert.throws(
      () => projectSelectedLeaves(observed, ['bogus' as unknown as ReceiptProperty]),
      RangeError,
    );
    assert.throws(
      () => projectSelectedLeaves(observed, 'status' as unknown as readonly ReceiptProperty[]),
      TypeError,
    );
  });
});

describe('t25a fence: mutable selections enroll, id-only does not', () => {
  it('enrolls status/result/error and skips id-only reads', () => {
    assert.equal(selectedRequiresFence(['id']), false);
    assert.equal(selectedRequiresFence([]), false);
    for (const leaf of ['status', 'result', 'error'] as const) {
      assert.equal(selectedRequiresFence([leaf]), true);
      assert.equal(selectedRequiresFence(['id', leaf]), true);
    }
    assert.equal(selectedRequiresFence(['id', 'status', 'result', 'error']), true);
  });

  it('rejects unknown and non-array selections', () => {
    assert.throws(
      () => selectedRequiresFence(['bogus' as unknown as ReceiptProperty]),
      RangeError,
    );
    assert.throws(
      () => selectedRequiresFence('id' as unknown as readonly ReceiptProperty[]),
      TypeError,
    );
  });
});

describe('t25a entry: status-only disclosure stays restricted', () => {
  const record = { id: 'rec_1' };
  const available = new TestOnlyAvailabilityMap({ content_1: true });

  it('observes exactly the granted status leaf with its fence revision', () => {
    const outcome = observeSelectedReceipt({
      locator: { record, field: 'notification' },
      selected: ['status'],
      association: association(),
      receipt: receipt(),
      grants: new TestOnlyGrantSet(['status']),
      content: available,
      nowMs: NOW,
    });
    assert.deepEqual(outcome, {
      outcome: 'observed',
      projection: { status: 'succeeded' },
      fenceRevision: 7,
    });
    if (outcome.outcome === 'observed') {
      // No ID or locator in a status projection: it is not a handle.
      assert.deepEqual(Object.keys(outcome.projection), ['status']);
    }
  });

  it('projects a granted subset even under a full grant', () => {
    // The selection is a projection request, never an authority request:
    // unselected leaves stay omitted even when granted.
    const outcome = observeSelectedReceipt({
      locator: { record, field: 'notification' },
      selected: ['result'],
      association: association(),
      receipt: receipt(),
      grants: new TestOnlyAllowAllGrants(),
      content: available,
      nowMs: NOW,
    });
    assert.deepEqual(outcome, {
      outcome: 'observed',
      projection: { result: { reference: 'pay_1' } },
      fenceRevision: 7,
    });
  });

  it('denies a wider selection under a status-only grant', () => {
    const content = new RecordingAvailability(true);
    const outcome = observeSelectedReceipt({
      locator: { record, field: 'notification' },
      selected: ['status', 'result'],
      association: association(),
      receipt: receipt(),
      grants: new TestOnlyGrantSet(['status']),
      content,
      nowMs: NOW,
    });
    assert.deepEqual(outcome, { outcome: 'denied', denied: ['result'] });
    // Denied before disclosure mechanics: the content policy is never
    // consulted and no projection exists to leak through.
    assert.equal(content.calls.length, 0);
  });

  it('denies id reads under a status-only grant', () => {
    const outcome = observeSelectedReceipt({
      locator: { record, field: 'notification' },
      selected: ['id'],
      association: association(),
      receipt: receipt(),
      grants: new TestOnlyGrantSet(['status']),
      content: available,
      nowMs: NOW,
    });
    assert.deepEqual(outcome, { outcome: 'denied', denied: ['id'] });
  });

  it('reads id-only without a fence enrollment', () => {
    const grants = new RecordingSelectedGrants(new Set(['id']));
    const outcome = observeSelectedReceipt({
      locator: { record, field: 'notification' },
      selected: ['id'],
      association: association(),
      receipt: receipt(),
      grants,
      content: available,
      nowMs: NOW,
    });
    assert.deepEqual(outcome, {
      outcome: 'observed',
      projection: { id: 'del_1' },
      fenceRevision: null,
    });
    assert.deepEqual(
      grants.calls.map((call) => call.property),
      ['id'],
    );
    assert.deepEqual(grants.calls[0]?.context, {
      field: 'notification',
      deliveryId: 'del_1',
      revision: 7,
    });
  });
});

describe('t25a entry: null means an actually null association', () => {
  const record = { id: 'rec_1' };
  const available = new TestOnlyAvailabilityMap();

  it('returns null-association for a granted unassociated read', () => {
    const grants = new RecordingSelectedGrants(new Set(['status']));
    const outcome = observeSelectedReceipt({
      locator: { record, field: 'notification' },
      selected: ['status'],
      association: null,
      receipt: null,
      grants,
      content: available,
      nowMs: NOW,
    });
    assert.deepEqual(outcome, { outcome: 'null-association' });
    // Grants are still consulted: presence traversal needs the grant.
    assert.deepEqual(
      grants.calls.map((call) => call.property),
      ['status'],
    );
    assert.deepEqual(grants.calls[0]?.context, {
      field: 'notification',
      deliveryId: null,
      revision: null,
    });
  });

  it('denies an unassociated read instead of returning null', () => {
    const outcome = observeSelectedReceipt({
      locator: { record, field: 'notification' },
      selected: ['status'],
      association: null,
      receipt: null,
      grants: new TestOnlyDenyAllGrants(),
      content: available,
      nowMs: NOW,
    });
    assert.deepEqual(outcome, { outcome: 'denied', denied: ['status'] });
  });
});

describe('t25a entry: withheld content and snapshot reads', () => {
  const record = { id: 'rec_1' };

  it('keeps the granted result key present-but-null when withheld', () => {
    // A successful read never silently drops a requested property: the
    // granted result key stays present with null, indistinguishable from a
    // genuinely-null result by design.
    const outcome = observeSelectedReceipt({
      locator: { record, field: 'notification' },
      selected: ['result'],
      association: association(),
      receipt: receipt(),
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap({ content_1: false }),
      nowMs: NOW,
    });
    assert.deepEqual(outcome, {
      outcome: 'observed',
      projection: { result: null },
      fenceRevision: 7,
    });
  });

  it('returns snapshots: later store changes never rewrite a projection', () => {
    const held = receipt();
    const first = observeSelectedReceipt({
      locator: { record, field: 'notification' },
      selected: ['status'],
      association: association(),
      receipt: held,
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap(),
      nowMs: NOW,
    });
    held.status = 'failed';
    const second = observeSelectedReceipt({
      locator: { record, field: 'notification' },
      selected: ['status'],
      association: association(),
      receipt: held,
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap(),
      nowMs: NOW,
    });
    assert.deepEqual(first, {
      outcome: 'observed',
      projection: { status: 'succeeded' },
      fenceRevision: 7,
    });
    assert.deepEqual(second, {
      outcome: 'observed',
      projection: { status: 'failed' },
      fenceRevision: 7,
    });
  });

  it('never accepts a projection back as a locator', () => {
    for (const selected of [['status'], ['id', 'status']] as const) {
      const outcome = observeSelectedReceipt({
        locator: { record, field: 'notification' },
        selected: [...selected],
        association: association(),
        receipt: receipt(),
        grants: new TestOnlyAllowAllGrants(),
        content: new TestOnlyAvailabilityMap(),
        nowMs: NOW,
      });
      assert.equal(outcome.outcome, 'observed');
      if (outcome.outcome === 'observed') {
        // A projection carries no locator: neither the status projection
        // nor the id-bearing one can serve as an observation locator.
        assert.ok(!('record' in outcome.projection));
        assert.ok(!('field' in outcome.projection));
        assert.throws(() => resolveAssociationLocator(outcome.projection), RangeError);
      }
    }
  });
});

describe('t25a entry: trusted store agreement throws loudly', () => {
  const record = { id: 'rec_1' };
  const available = new TestOnlyAvailabilityMap();

  function read(over: {
    association?: ReceiptAssociation | null;
    receipt?: StoredReceipt | null;
  }): void {
    observeSelectedReceipt({
      locator: { record, field: 'notification' },
      selected: ['status'],
      association: over.association === undefined ? association() : over.association,
      receipt: over.receipt === undefined ? receipt() : over.receipt,
      grants: new TestOnlyAllowAllGrants(),
      content: available,
      nowMs: NOW,
    });
  }

  it('rejects null disagreement and foreign or skewed rows', () => {
    assert.throws(() => read({ association: null }), /agree on null presence/);
    assert.throws(() => read({ receipt: null }), /agree on null presence/);
    assert.throws(
      () => read({ receipt: receipt({ deliveryId: 'del_other' }) }),
      /does not belong/,
    );
    assert.throws(() => read({ receipt: receipt({ revision: 8 }) }), /disagrees/);
    assert.throws(
      () => read({ association: association({ deliveryId: '' }) }),
      /must be non-empty/,
    );
    assert.throws(
      () => read({ association: association({ revision: -1 }) }),
      /non-negative integer/,
    );
  });

  it('rejects malformed locators, selections and clocks', () => {
    assert.throws(
      () =>
        observeSelectedReceipt({
          locator: { record: 'del_1', field: 'notification' },
          selected: ['status'],
          association: association(),
          receipt: receipt(),
          grants: new TestOnlyAllowAllGrants(),
          content: available,
          nowMs: NOW,
        }),
      /never a text id/,
    );
    assert.throws(
      () =>
        observeSelectedReceipt({
          locator: { record, field: 'notification' },
          selected: [],
          association: association(),
          receipt: receipt(),
          grants: new TestOnlyAllowAllGrants(),
          content: available,
          nowMs: NOW,
        }),
      /must not be empty/,
    );
    assert.throws(
      () =>
        observeSelectedReceipt({
          locator: { record, field: 'notification' },
          selected: ['status'],
          association: association(),
          receipt: receipt(),
          grants: new TestOnlyAllowAllGrants(),
          content: available,
          nowMs: -1,
        }),
      RangeError,
    );
  });
});

describe('t25a pins: fence and dispatch shapes (no execution join)', () => {
  const record = { id: 'rec_1' };

  it('pins the enrolled revision to the stored and echoed revisions', () => {
    // Same-package consistency pin: the selected entry enrolls exactly the
    // revision the store holds and the projection kernel echoes.
    const held = association({ revision: 11 });
    const stored = receipt({ revision: 11 });
    const outcome = observeSelectedReceipt({
      locator: { record, field: 'notification' },
      selected: ['status'],
      association: held,
      receipt: stored,
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap(),
      nowMs: NOW,
    });
    assert.deepEqual(outcome, {
      outcome: 'observed',
      projection: { status: 'succeeded' },
      fenceRevision: 11,
    });
    const echoed = observeReceipt({
      receipt: stored,
      requested: ['status'],
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap(),
      nowMs: NOW,
    });
    assert.equal(echoed.revision, 11);
  });

  it('pins delivery ids to the dispatch outbox id shape', () => {
    // Shape pin against the T24 dispatch/outbox interface: association
    // delivery ids are outbox ids. No dispatch executes here.
    const outboxId = 'obx_staged' as OutboxId;
    const held = association({ deliveryId: outboxId });
    const pinned: OutboxId = held.deliveryId;
    assert.equal(pinned, outboxId);
  });

  it('pins the enrolled revision to the fence checkpoint slot', () => {
    // Shape pin against the T32b fence interface: the enrolled revision
    // fits the checkpoint revision slot. No fence executes here; the L3
    // enrollment join rides after T18.
    const outcome = observeSelectedReceipt({
      locator: { record, field: 'notification' },
      selected: ['status'],
      association: association({ revision: 9 }),
      receipt: receipt({ revision: 9 }),
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap(),
      nowMs: NOW,
    });
    assert.equal(outcome.outcome, 'observed');
    if (outcome.outcome === 'observed') {
      assert.notEqual(outcome.fenceRevision, null);
      const checkpoint: DispatchFence['checkpoint'] = {
        revision: outcome.fenceRevision as number,
        owner: 't25a-shape-pin-only',
      };
      assert.equal(checkpoint.revision, 9);
    }
  });
});


describe('t25a result.content: checked exact disclosure', () => {
  const textRun = { source: 'text_1', revision: '1', sequence: '3', state: 'succeeded',
    content: 'Partial text', used_tokens: null, detail: 'private sibling' };
  function input() {
    return { locator: { record: { id: 'rec_1' }, field: 'notification' },
      selected: ['result.content'] as ReceiptProperty[], declaredResult: TEXT_RESULT,
      association: association(), receipt: receipt({ result: textRun }),
      grants: new TestOnlyGrantSet(['result.content']), content: new RecordingAvailability(true), nowMs: NOW };
  }

  it('projects each closed scalar leaf with only its exact child grant and preserves nullable values', () => {
    const expected = { 'result.source': 'text_1', 'result.revision': '1', 'result.sequence': '3',
      'result.state': 'succeeded', 'result.content': 'Partial text', 'result.used_tokens': null,
      'result.detail': 'private sibling' };
    for (const [property, value] of Object.entries(expected)) {
      const leaf = property as ReceiptProperty;
      const grants = new RecordingSelectedGrants(new Set([leaf]));
      const content = new RecordingAvailability(true);
      const outcome = observeSelectedReceipt({ ...input(), selected: [leaf, leaf], grants, content });
      assert.deepEqual(outcome, { outcome: 'observed', projection: { [property]: value }, fenceRevision: 7 });
      assert.deepEqual(grants.calls.map(call => call.property), [leaf]);
      assert.equal(content.calls.length, 1);
      assert.equal(selectedRequiresFence([leaf]), true);
      assert.deepEqual(observeSelectedReceipt({ ...input(), selected: [leaf],
        grants: new TestOnlyGrantSet(['result']) }), { outcome: 'denied', denied: [leaf] });
      assert.deepEqual(observeSelectedReceipt({ ...input(), selected: [leaf], grants,
        content: new RecordingAvailability(false) }),
        { outcome: 'observed', projection: { [property]: null }, fenceRevision: 7 });
    }
    for (const property of ['result.sequence.value', 'result.anything', 'result.content.length']) {
      assert.throws(() => observeSelectedReceipt({ ...input(), selected: [property as ReceiptProperty] }), /unknown selected property/);
    }
  });

  it('projects flat exact keys, authorizes once in first-selected order and fences content', () => {
    const grants = new RecordingSelectedGrants(new Set(['result.content', 'status']));
    const content = new RecordingAvailability(true);
    const outcome = observeSelectedReceipt({ ...input(),
      selected: ['result.content', 'status', 'result.content'], grants, content });
    assert.deepEqual(outcome, { outcome: 'observed',
      projection: { 'result.content': 'Partial text', status: 'succeeded' }, fenceRevision: 7 });
    assert.equal(outcome.outcome, 'observed');
    if (outcome.outcome === 'observed') assert.deepEqual(Object.keys(outcome.projection), ['result.content', 'status']);
    assert.deepEqual(grants.calls.map((call) => call.property), ['result.content', 'status']);
    assert.deepEqual(content.calls, [{ contentRef: 'content_1', nowMs: NOW }]);
    assert.equal(selectedRequiresFence(['result.content']), true);
  });

  it('requires the declared TextRun content:text leaf without guessing from stored content', () => {
    for (const declaredResult of [undefined, { name: 'Other', fields: TEXT_RESULT.fields },
      { name: 'TextRun', fields: [] }, { name: 'TextRun', fields: [{ name: 'content', type: 'int' }] },
      { name: 'TextRun', fields: [{ name: 'content', type: 'text' }, { name: 'content', type: 'text' }] }]) {
      assert.throws(() => observeSelectedReceipt({ ...input(), declaredResult }), /canonical TextRun/);
    }
    assert.throws(() => observeSelectedReceipt({ ...input(), selected: ['result.missing' as ReceiptProperty] }),
      /unknown selected property/);
  });

  it('denies before null disagreement, corrupt bindings or content and never checks retention', () => {
    for (const over of [{ association: null }, { receipt: null },
      { receipt: receipt({ deliveryId: '', revision: -1, result: { content: 42 } }) }]) {
      const content = new RecordingAvailability(true);
      const grants = new RecordingSelectedGrants(new Set());
      const outcome = observeSelectedReceipt({ ...input(), ...over,
        selected: ['result.content', 'status', 'result.content'], grants, content });
      assert.deepEqual(outcome, { outcome: 'denied', denied: ['result.content', 'status'] });
      assert.deepEqual(grants.calls.map((call) => call.property), ['result.content', 'status']);
      assert.deepEqual(content.calls, []);
    }
    assert.deepEqual(observeSelectedReceipt({ ...input(), association: null, receipt: null }),
      { outcome: 'null-association' });
  });

  it('keeps withheld or null results null and retains inline text without a content lookup', () => {
    const withheld = new RecordingAvailability(false);
    assert.deepEqual(observeSelectedReceipt({ ...input(), content: withheld }),
      { outcome: 'observed', projection: { 'result.content': null }, fenceRevision: 7 });
    assert.equal(withheld.calls.length, 1);
    const content = new RecordingAvailability(false);
    for (const result of [null, textRun]) {
      assert.deepEqual(observeSelectedReceipt({ ...input(), receipt: receipt({ result, contentRef: null }), content }),
        { outcome: 'observed', projection: { 'result.content': result === null ? null : 'Partial text' }, fenceRevision: 7 });
    }
    assert.deepEqual(content.calls, []);
  });

  it('refuses corrupt or inherited content after authorization and preserves explicitly selected whole results', () => {
    for (const result of [42, [], {}, { content: null }, { content: 42 }, Object.create({ content: 'inherited' }),
      { get content() { throw new Error('must not invoke accessor'); } }]) {
      assert.throws(() => observeSelectedReceipt({ ...input(), receipt: receipt({ result, contentRef: null }) }),
        /stored TextRun object|own declared text value/);
    }
    const content = new RecordingAvailability(true);
    assert.deepEqual(observeSelectedReceipt({ ...input(), selected: ['result.content', 'result'],
      grants: new TestOnlyAllowAllGrants(), content }), { outcome: 'observed',
      projection: { 'result.content': 'Partial text', result: textRun }, fenceRevision: 7 });
    assert.equal(content.calls.length, 1);
    assert.deepEqual(observeSelectedReceipt({ ...input(), selected: ['result', 'id', 'status', 'error'],
      grants: new TestOnlyGrantSet(['result.content']) }),
      { outcome: 'denied', denied: ['result', 'id', 'status', 'error'] });
  });
});
