/**
 * D3b live-serving read-envelope addressing: work-side mechanics the
 * served receipt-read convention relies on.
 *
 * The D3 proposal (see packet notes): a served read envelope carries
 * `{recordId, field, selected[]}`; the model resolves statically from
 * the serving operation's binding (never from envelope text); the
 * runtime resolves `recordId` to the live row through its authorized,
 * fenced read path and calls the join with the loaded row OBJECT.
 *
 * These pins prove the kernel side of that contract, whatever the
 * approved wire bytes are:
 *
 * - loaded-row-shaped record objects satisfy the locator (extra row
 *   keys allowed on the record; the locator itself stays exactly
 *   `{record, field}`);
 * - text-id records STILL throw (the server must resolve first; the
 *   kernel never performs id lookup — served or not);
 * - envelope field/selected malformations throw with the classes the
 *   server maps to validation errors (table in comments below);
 * - duplicate selected leaves collapse to first-selected order;
 * - a served-shape read observes with its fence revision, and
 *   denied-before-presence holds (denied never masquerades as null).
 *
 * Server/fence/policy/wire behavior belongs to B/E/C approvals and
 * the C invoke-side follow-up; this file pins only work mechanics.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AssociatedReceipt,
  ReceiptAssociation,
  ReceiptProperty,
} from '../../contracts/src/work.js';
import { resolveAssociationLocator } from '../src/observation/association.ts';
import {
  authorizeSelectedLeaves,
  observeSelectedReceipt,
} from '../src/observation/observation.ts';
import type { StoredReceipt } from '../src/observation/observation.ts';
import { TestOnlyAllowAllGrants, TestOnlyAvailabilityMap } from '../src/observation/ports.ts';

const NOW = 1_791_120_000_000;

/**
 * Served-envelope validation map (server behavior, pinned here by the
 * kernel classes the server must translate): every malformation below
 * throws TypeError/RangeError in the kernel and MUST surface as a
 * caller validation error on the wire — never as a silent null, a
 * guessed lookup, or an authorized observation.
 */
describe('d3b served envelope validation map', () => {
  it('accepts loaded-row-shaped records with extra row keys', () => {
    const row = {
      id: 'item-1',
      version: 4,
      data: { service: 'svc-1', notification: 'decoy-id' },
    };
    assert.deepEqual(resolveAssociationLocator({ record: row, field: 'notification' }), {
      record: row,
      field: 'notification',
    });
  });

  it('rejects text-id records: the server resolves, the kernel never looks up', () => {
    for (const record of ['item-1', '', 7, null]) {
      assert.throws(
        () => resolveAssociationLocator({ record, field: 'notification' }),
        TypeError,
        `record ${JSON.stringify(record)} must never resolve in-kernel`,
      );
    }
  });

  it('rejects envelope-shape violations as caller validation errors', () => {
    const row = { id: 'item-1' };
    // Locator must be exactly {record, field}: extra keys (a smuggled
    // model/id/handle) are rejected, never ignored.
    assert.throws(
      () => resolveAssociationLocator({ record: row, field: 'notification', model: 'Acme.Item' }),
      RangeError,
    );
    assert.throws(() => resolveAssociationLocator({ record: row }), TypeError);
    assert.throws(() => resolveAssociationLocator(null), TypeError);
    // Field must be a plain declared name: traversal is rejected.
    for (const field of ['', 'a.b', 'a[0]', 'notification.status']) {
      assert.throws(() => resolveAssociationLocator({ record: row, field }), RangeError);
    }
  });

  it('rejects malformed selected sets as caller validation errors', () => {
    const grants = new TestOnlyAllowAllGrants();
    const context = { field: 'notification', deliveryId: null, revision: null };
    assert.throws(() => authorizeSelectedLeaves([], grants, context), RangeError);
    assert.throws(
      () => authorizeSelectedLeaves(['status', 'bogus'] as ReceiptProperty[], grants, context),
      RangeError,
    );
    assert.throws(
      () => authorizeSelectedLeaves('status' as unknown as ReceiptProperty[], grants, context),
      TypeError,
    );
  });

  it('collapses duplicate leaves to first-selected order', () => {
    const grants = new TestOnlyAllowAllGrants();
    const context = { field: 'notification', deliveryId: 'del_1', revision: 3 };
    assert.deepEqual(
      authorizeSelectedLeaves(['result', 'status', 'result'], grants, context),
      { authorized: true, leaves: ['result', 'status'] },
    );
  });
});

describe('d3b served-shape reads through work mechanics', () => {
  const row = {
    id: 'item-1',
    version: 4,
    data: { service: 'svc-1', notification: 'decoy-id' },
  };
  const association: ReceiptAssociation = {
    locator: { recordId: 'item-1', field: 'notification' },
    deliveryId: 'del_1',
    source: 'mailroom.Mail.send',
    revision: 3,
  };
  const receipt: StoredReceipt = {
    deliveryId: 'del_1',
    revision: 3,
    status: 'succeeded',
    result: { ok: 1 },
    error: null,
    contentRef: null,
  };

  it('observes with the fence revision the server enrolls', () => {
    assert.deepEqual(
      observeSelectedReceipt({
        locator: { record: row, field: 'notification' },
        selected: ['status', 'result'],
        association,
        receipt,
        grants: new TestOnlyAllowAllGrants(),
        content: new TestOnlyAvailabilityMap(),
        nowMs: NOW,
      }),
      {
        outcome: 'observed',
        projection: { status: 'succeeded', result: { ok: 1 } },
        fenceRevision: 3,
      },
    );
  });

  it('reads id-only without a fence revision', () => {
    assert.deepEqual(
      observeSelectedReceipt({
        locator: { record: row, field: 'notification' },
        selected: ['id'],
        association,
        receipt,
        grants: new TestOnlyAllowAllGrants(),
        content: new TestOnlyAvailabilityMap(),
        nowMs: NOW,
      }),
      { outcome: 'observed', projection: { id: 'del_1' }, fenceRevision: null },
    );
  });

  it('denies before presence: denial reveals nothing servable as null', () => {
    const denied = observeSelectedReceipt({
      locator: { record: row, field: 'notification' },
      selected: ['status'],
      association,
      receipt,
      grants: { mayObserve: () => false },
      content: new TestOnlyAvailabilityMap(),
      nowMs: NOW,
    });
    assert.deepEqual(denied, { outcome: 'denied', denied: ['status'] });
    const nulled = observeSelectedReceipt({
      locator: { record: row, field: 'notification' },
      selected: ['status'],
      association: null,
      receipt: null,
      grants: new TestOnlyAllowAllGrants(),
      content: new TestOnlyAvailabilityMap(),
      nowMs: NOW,
    });
    assert.deepEqual(nulled, { outcome: 'null-association' });
    assert.notDeepEqual(denied, nulled);
  });

  it('defends against row/decoy disagreement loudly', () => {
    const skewed: AssociatedReceipt = { ...receipt, deliveryId: 'del_other' };
    assert.throws(
      () =>
        observeSelectedReceipt({
          locator: { record: row, field: 'notification' },
          selected: ['status'],
          association,
          receipt: { ...skewed, contentRef: null },
          grants: new TestOnlyAllowAllGrants(),
          content: new TestOnlyAvailabilityMap(),
          nowMs: NOW,
        }),
      /does not belong/,
    );
  });
});
