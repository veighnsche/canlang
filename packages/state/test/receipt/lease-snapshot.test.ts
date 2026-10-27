/**
 * Lease snapshot isolation: a policy callback must not be able to poison
 * later same-store/revision reads through the revision-pinned snapshot cache.
 *
 * The genuine chain under test: `evaluateInstalledReadPolicy` invokes the
 * installed read with the live lifetime observation; the read opens a nested
 * `withinInstalledReadObservation` lease whose `loadRow` serves revision-pinned
 * store snapshots. Observations are only shallow-frozen, so without a
 * privately owned immutable snapshot at the cache boundary a read that
 * mutates a nested field of a lease-loaded row would poison every later
 * observation of the same (store, revision, model, id) — invisibly to
 * revision fencing, which cannot see in-memory mutation, while the committed
 * store stays clean.
 *
 * This file lives inside the owning package and reaches the two evaluation
 * primitives through legitimate intra-package relative imports. Both remain
 * internal to State: they are absent from the package barrels, so no external
 * caller can mint a read lifetime from a supplied observation or borrow its
 * navigation lease. The store is the genuine test memory backend and the
 * fixtures are the shared package fixtures; there are no mocks.
 *
 * A first observation runs a mutating policy callback, then a second
 * observation at the same store/revision must still read the original nested
 * field, the malicious lease must be refused, and the store itself must be
 * untouched.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { StoragePort, StoredRow } from '@canlang/contracts';
import {
  evaluateInstalledReadPolicy,
  withinInstalledReadObservation,
} from '../../src/receipt/read-policy-membership.js';
import type { ViewerGenerationCallbackReadObservation } from '../../src/query/source-policy.js';
import { createTestMemoryStorage } from '../../src/storage/memory.js';
import {
  asId,
  asModel,
  makeBatch,
  makeRow,
} from '../invocation/fixtures.js';

const MODEL = asModel('allocation.Credit');
const ROW_ID = asId('credit-0');

function moneyRow(): StoredRow {
  return {
    ...makeRow({ id: 'credit-0', data: { amount: { minor: '1', currency: 'EUR' } } }),
    parent: null,
  };
}

function context(): ViewerGenerationCallbackReadObservation['context'] {
  return {
    actorUserId: 'user-alice',
    teamId: 'team-1',
    membership: null,
    memberships: {
      findMembership: async (_teamId: string, _userId: string) => null,
    },
  };
}

async function seed(): Promise<{
  store: StoragePort;
  revision: ViewerGenerationCallbackReadObservation['revision'];
}> {
  const { store } = createTestMemoryStorage();
  const root = { ...makeRow({ id: 'root', data: { active: true } }), parent: null };
  await store.commit(
    makeBatch(0, { writes: [{ kind: 'insert', model: asModel('allocation.Root'), row: root }] }),
  );
  await store.commit(
    makeBatch(1, {
      writes: [
        {
          kind: 'insert',
          model: MODEL,
          row: { ...moneyRow(), parent: { model: asModel('allocation.Root'), id: asId('root') } },
        },
      ],
    }),
  );
  return { store, revision: await store.readRevision() };
}

function observation(
  revision: ViewerGenerationCallbackReadObservation['revision'],
): ViewerGenerationCallbackReadObservation {
  return { context: context(), row: moneyRow(), revision, fence: undefined };
}

function minorOf(row: StoredRow): string {
  const minor = (row.data['amount'] as Record<string, string>)['minor'];
  if (minor === undefined) throw new Error('seeded amount missing');
  return minor;
}

async function leaseLoadedRow(
  store: StoragePort,
  outer: ViewerGenerationCallbackReadObservation,
): Promise<StoredRow | null> {
  const reader = async (leaseObservation: ViewerGenerationCallbackReadObservation) => {
    return withinInstalledReadObservation(
      leaseObservation,
      { store, model: MODEL, id: ROW_ID },
      async (_checkpoint, loadRow) => loadRow(MODEL, ROW_ID),
    );
  };
  let loaded: StoredRow | null = null;
  const probe = async (leaseObservation: ViewerGenerationCallbackReadObservation) => {
    loaded = await reader(leaseObservation);
    return true;
  };
  await evaluateInstalledReadPolicy(probe, outer, store);
  return loaded;
}

describe('lease snapshot isolation', () => {
  it('refuses a nested-field mutation and keeps later same-revision reads clean', async () => {
    const { store, revision } = await seed();

    let firstError: unknown = null;
    const mutator = async (leaseObservation: ViewerGenerationCallbackReadObservation) => {
      const loaded = await withinInstalledReadObservation(
        leaseObservation,
        { store, model: MODEL, id: ROW_ID },
        async (_checkpoint, loadRow) => loadRow(MODEL, ROW_ID),
      );
      if (loaded === null) throw new Error('seeded row missing');
      (loaded.data['amount'] as Record<string, string>)['minor'] = '999';
      return true;
    };
    try {
      await evaluateInstalledReadPolicy(mutator, observation(revision), store);
    } catch (error) {
      firstError = error;
    }

    const seen = await leaseLoadedRow(store, observation(revision));
    if (seen === null) throw new Error('seeded row missing');
    assert.equal(minorOf(seen), '1');
    assert.notEqual(firstError, null);
    assert.ok(firstError instanceof TypeError);

    const stored = await store.cohortLoad({ model: MODEL, id: ROW_ID, expectedRevision: revision });
    if (stored === null) throw new Error('seeded row missing');
    assert.equal(minorOf(stored), '1');
  });
});
