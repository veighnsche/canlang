/** Observe-venue dispatch re-materializes the current Change/Event pair and
 * refuses stale, cancelled, swapped, replayed, or tampered rows. The frozen
 * lexical Change snapshot alone never authorizes the Rooms.confirm claim. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ModelName, RecordId, RecordVersion, StoredRow } from '@canlang/contracts';
import { asId, asVersion } from '@canlang/state/testing/invocation/fixtures';
import { prepareObserveVenueDispatchDecision } from './invoke.js';

const REVISION = 41;
const INTENT = 'intent-observe-venue-1';
const CHANGE_ID = asId('chg-observe-1');
const EVENT_ID = asId('evt-observe-1');

const frozenChange: StoredRow = {
  id: CHANGE_ID,
  version: asVersion(5),
  created: 100,
  updated: 100,
  createdBy: 'test-worker',
  updatedBy: 'test-worker',
  archivedAt: null,
  parent: { model: 'events.Event' as ModelName, id: EVENT_ID },
  data: {
    state: 'confirming',
    source: 'tour',
    resource: { kind: 'ref', model: 'events.Venue', id: 'ven-observe-1' },
    confirm_delivery: INTENT,
  },
};

function changeRow(overrides: Partial<StoredRow> & { data?: Record<string, unknown> } = {}): StoredRow {
  return { ...frozenChange, ...overrides, data: { ...frozenChange.data, ...(overrides.data ?? {}) } };
}

function eventRow(overrides: { data?: Record<string, unknown> } & Partial<StoredRow> = {}): StoredRow {
  const { data, ...rest } = overrides;
  return {
    id: EVENT_ID,
    version: asVersion(9),
    created: 50,
    updated: 50,
    createdBy: 'test-worker',
    updatedBy: 'test-worker',
    archivedAt: null,
    parent: null,
    ...rest,
    data: {
      cancelled: false,
      pending_change: { kind: 'ref', model: 'events.Change', id: CHANGE_ID },
      ...data,
    },
  };
}

function loadedPort() {
  return {
    producers: {
      errors: class extends Error {
        constructor(type: string, message: string) {
          super(`${type}: ${message}`);
        }
      },
    },
  } as unknown as Parameters<typeof prepareObserveVenueDispatchDecision>[0]['loaded'];
}

function snapshotsPort(frozen: StoredRow | null) {
  return {
    snapshot: (model: string, wire: unknown) => {
      assert.equal(model, 'events.Change');
      // The staged snapshot is pinned to the original observed Change; a
      // lexical wire pointing anywhere else is an altered source.
      const id = (wire as { readonly id?: unknown } | null)?.id;
      if (id !== (CHANGE_ID as unknown as string)) throw new Error(`snapshot wire mismatch: ${String(id)}`);
      if (frozen === null) throw new Error('snapshot missing');
      return frozen;
    },
  } as unknown as Parameters<typeof prepareObserveVenueDispatchDecision>[0]['snapshots'];
}

function storePort(rows: Map<string, StoredRow>, revisions: number[]) {
  let reads = 0;
  return {
    readRevision: async () => revisions[Math.min(reads++, revisions.length - 1)]!,
    cohortLoad: async ({ model, id }: {
      readonly model: string; readonly id: string; readonly expectedRevision: number }) => {
      // Pinned loads observe the row as of the checked revision; revision
      // movement is caught by readRevision, not by row comparison here.
      return rows.get(`${model}:${String(id)}`) ?? null;
    },
  } as unknown as Parameters<typeof prepareObserveVenueDispatchDecision>[0]['store'];
}

async function decide(current: { change?: StoredRow; event?: StoredRow; revisions?: number[]; frozen?: StoredRow | null; wireId?: string; intentId?: string } = {}) {
  const change = current.change ?? changeRow();
  const event = current.event ?? eventRow();
  const rows = new Map<string, StoredRow>([
    [`events.Change:${String(change.id)}`, change],
    [`events.Event:${String(event.id)}`, event],
  ]);
  return prepareObserveVenueDispatchDecision({
    loaded: loadedPort(),
    store: storePort(rows, current.revisions ?? [REVISION, REVISION]),
    revision: REVISION as Parameters<typeof prepareObserveVenueDispatchDecision>[0]['revision'],
    snapshots: snapshotsPort(current.frozen === undefined ? frozenChange : current.frozen),
    lexical: { change: { kind: 'ref', model: 'events.Change', id: current.wireId ?? (CHANGE_ID as unknown as string), version: 5 } },
    intentId: current.intentId ?? INTENT,
  });
}

describe('observe-venue dispatch decision', () => {
  it('admits the pristine confirming pair and revalidates stable', { timeout: 60000 }, async () => {
    const prepared = await decide();
    assert.equal(prepared.eligible, true);
    assert.equal(await prepared.revalidate(), true);
  });

  it('throws conflict when the owner revision moves under the claim', { timeout: 60000 }, async () => {
    await assert.rejects(() => decide({ revisions: [REVISION, REVISION + 1] }), /owner revision changed/);
  });

  it('refuses a cancelled parent event', { timeout: 60000 }, async () => {
    const prepared = await decide({ event: eventRow({ data: { cancelled: true } }) });
    assert.equal(prepared.eligible, false);
  });

  it('refuses a swapped pending_change identity', { timeout: 60000 }, async () => {
    const prepared = await decide({ event: eventRow({ data: {
      pending_change: { kind: 'ref', model: 'events.Change', id: 'chg-observe-other' } } }) });
    assert.equal(prepared.eligible, false);
  });

  it('refuses a replayed delivery binding', { timeout: 60000 }, async () => {
    const prepared = await decide({
      change: changeRow({ data: { confirm_delivery: 'intent-observe-venue-0' } }),
    });
    assert.equal(prepared.eligible, false);
  });

  it('refuses when the Change leaves confirming', { timeout: 60000 }, async () => {
    const prepared = await decide({ change: changeRow({ version: asVersion(6), data: { state: 'holding' } }) });
    assert.equal(prepared.eligible, false);
  });

  it('throws validation on a tampered frozen snapshot', { timeout: 60000 }, async () => {
    await assert.rejects(
      () => decide({ frozen: changeRow({ archivedAt: 123 }) }), /lost its original confirming Change/);
  });

  it('throws on an altered lexical change wire', { timeout: 60000 }, async () => {
    await assert.rejects(() => decide({ wireId: 'chg-observe-other' }), /wire mismatch/);
  });
});
