/**
 * B2 conflict-currents proofs (colocated): L3-carried 409 currents per
 * the pinned Q3 contract (`ConflictCurrent` on `BusinessError`,
 * coordinator commit bb1ca7a, synced as 3e89d8e).
 *
 * - Admission stale-ref denials carry FULL per-binding currents (row in
 *   hand, zero extra reads): metadata + submitted-input names intersect
 *   row data, MINUS holder-threaded serverOnly exclusions, MINUS
 *   secret-kind values by shape. Unknown exclusions carry metadata
 *   only — fail closed, never guessed.
 * - Commit-race version conflicts carry metadata + empty `values`
 *   (adapters attach the compared row; re-reading there would be
 *   TOCTOU-indicative). Missing-row versions, uniques, receipt-reuse,
 *   and fence-moved conflicts carry NOTHING.
 * - `toBusinessError` renders `conflict` through; absent everywhere else.
 *
 * Generated-def paths run the REAL `t18-shop.can` artifact (serverOnly
 * and secret branches use small hand-mutated COPIES of the real slice,
 * labeled as such — the T18 precedent). Memory store; D1/DO adapter
 * attachment rides in `b2-reads-durable.test.ts`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ArtifactOperation,
  CompileArtifact,
} from '../../../contracts/src/artifact.js';
import type {
  ModelName,
  OperationName,
  RecordId,
  StoragePort,
  StoredRow,
} from '../../../contracts/src/state.js';
import {
  loadArtifactDescriptors,
  type ArtifactDescriptorSlice,
  type LoadedArtifactDescriptors,
} from './registry.js';
import {
  admit,
  revalidateCommitForFence,
  type ConflictServerOnly,
} from './admission.js';
import { buildContext } from './context.js';
import {
  StateError,
  storageToStateError,
  toBusinessError,
} from '../errors.js';
import { StorageConstraintError } from '../storage/port.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import {
  FIXED_NOW,
  asModel,
  asRevision,
  asVersion,
  captureStateError,
  createMemoryIdentityStore,
  makeBatch,
  makeIdentity,
  makeReceipt,
  seedMember,
  seedRow,
  updateRow,
  uuidv7,
  type SeededMember,
  type TestMembershipStore,
} from '../../test/invocation/fixtures.js';
import { T18_SHOP_ARTIFACT_JSON } from '../mutation/t18-shop.artifact.js';

const APP = 'acme-app';
const TEAM = 'Shop.Team';
const TEAM_UPDATE = 'Shop.Team.update';
const EXPECTED_ISO = new Date(FIXED_NOW).toISOString();

function shopSlice(): ArtifactDescriptorSlice {
  const artifact = JSON.parse(T18_SHOP_ARTIFACT_JSON) as CompileArtifact;
  const { operations, models } = artifact;
  assert.equal(artifact.artifact_version, 1);
  assert.ok(Array.isArray(operations) && operations.length > 0);
  assert.ok(Array.isArray(models) && models.length > 0);
  return { artifact_version: artifact.artifact_version, operations, models };
}

function loadShop(): LoadedArtifactDescriptors {
  return loadArtifactDescriptors(shopSlice(), { by: 'members' });
}

interface CurrentSetup {
  store: StoragePort;
  memberships: TestMembershipStore;
  alice: SeededMember;
  loaded: LoadedArtifactDescriptors;
}

async function setupCurrents(): Promise<CurrentSetup> {
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  return { store, memberships, alice, loaded: loadShop() };
}

/**
 * Holder-pattern exclusions: the seam builds this from the loaded
 * models (serverOnly flags), keyed by model name. Models without
 * serverOnly fields carry an EMPTY set (values flow).
 */
function holderExclusions(loaded: LoadedArtifactDescriptors): ConflictServerOnly {
  const map = new Map<string, ReadonlySet<string>>();
  for (const model of loaded.models) {
    const names = new Set<string>();
    for (const [field, def] of Object.entries(model.fields)) {
      if (def.serverOnly) {
        names.add(field);
      }
    }
    map.set(model.name as string, names);
  }
  return map;
}

let b2Seq = 30000;

function staleUpdate(
  setup: CurrentSetup,
  row: StoredRow,
  inputs: Record<string, unknown>,
  conflictServerOnly?: ConflictServerOnly,
) {
  const def = setup.loaded.registry.get(TEAM_UPDATE);
  assert.ok(def !== undefined);
  const context = buildContext({
    identity: makeIdentity({
      membership: setup.alice.membership,
      email: setup.alice.user.email,
    }),
    operation: TEAM_UPDATE as OperationName,
    operationId: uuidv7(FIXED_NOW, (b2Seq += 1)),
    app: APP,
    source: 'test',
    now: FIXED_NOW,
  });
  return admit({
    def,
    inputs: { record: { id: row.id, version: '1' }, ...inputs },
    context,
    store: setup.store,
    memberships: setup.memberships,
    ...(conflictServerOnly !== undefined ? { conflictServerOnly } : {}),
  });
}

describe('B2 conflict currents: admission stale-ref', () => {
  it('carries full currents with holder exclusions (real artifact)', async () => {
    const setup = await setupCurrents();
    const first = await seedRow(setup.store, TEAM as ModelName, {
      id: 'team-1',
      data: { name: 'team-one', stock: '0' },
    });
    const current = await updateRow(setup.store, TEAM as ModelName, first, {
      data: { name: 'team-two', stock: '5' },
    });
    assert.equal(current.version, 2);
    const error = await captureStateError(
      staleUpdate(
        setup,
        current,
        { name: 'team-submitted', stock: '9' },
        holderExclusions(setup.loaded),
      ),
    );
    assert.equal(error.code, 'conflict');
    assert.equal(error.message, 'Stale record version.');
    const conflict = error.conflict;
    assert.ok(conflict !== undefined);
    assert.equal(
      conflict.message,
      'Input "/record" is stale (expected version 1, current 2).',
    );
    assert.equal(conflict.current.model, TEAM);
    assert.equal(conflict.current.id, 'team-1');
    assert.equal(conflict.current.version, 2);
    assert.equal(conflict.current.updated, EXPECTED_ISO);
    assert.equal(conflict.current.updatedBy, 'user-alice');
    // CURRENT row values — not the submitted ones.
    assert.deepEqual(conflict.current.values, { name: 'team-two', stock: '5' });
  });

  it('excludes serverOnly fields and secret-kind values (hand-mutated copy)', async () => {
    // HAND-MUTATED COPY of the real slice (labeled, T18 precedent): the
    // emitter excludes server-owned fields from operation inputs, so the
    // exclusion branches need synthetic `made`/`vault` inputs. The models
    // (and their serverOnly flags) are untouched real emission.
    const setup = await setupCurrents();
    const slice = shopSlice();
    const ops = slice.operations as ArtifactOperation[];
    const update = ops.find((op) => op.name === TEAM_UPDATE);
    assert.ok(update !== undefined);
    update.inputs.fields.push(
      { name: 'made', field: { kind: 'string' }, required: false },
      { name: 'vault', field: { kind: 'string' }, required: false },
    );
    const loaded = loadArtifactDescriptors(slice, { by: 'members' });
    const first = await seedRow(setup.store, TEAM as ModelName, {
      id: 'team-1',
      data: { name: 'team-one', made: EXPECTED_ISO, vault: { kind: 'secret', cipher: 'x' } },
    });
    const current = await updateRow(setup.store, TEAM as ModelName, first, {
      data: { name: 'team-two', made: EXPECTED_ISO, vault: { kind: 'secret', cipher: 'y' } },
    });
    const def = loaded.registry.get(TEAM_UPDATE);
    assert.ok(def !== undefined);
    const context = buildContext({
      identity: makeIdentity({
        membership: setup.alice.membership,
        email: setup.alice.user.email,
      }),
      operation: TEAM_UPDATE as OperationName,
      operationId: uuidv7(FIXED_NOW, (b2Seq += 1)),
      app: APP,
      source: 'test',
      now: FIXED_NOW,
    });
    const error = await captureStateError(
      admit({
        def,
        inputs: {
          record: { id: current.id, version: '1' },
          name: 'team-submitted',
          made: '2030-01-01T00:00:00.000Z',
          vault: 'tampered',
        },
        context,
        store: setup.store,
        memberships: setup.memberships,
        conflictServerOnly: holderExclusions(loaded),
      }),
    );
    assert.equal(error.code, 'conflict');
    const conflict = error.conflict;
    assert.ok(conflict !== undefined);
    // `made` excluded by holder exclusion (serverOnly in real emission);
    // `vault` excluded by secret shape (not in exclusions — defense in
    // depth stands alone).
    assert.deepEqual(conflict.current.values, { name: 'team-two' });
  });

  it('absent exclusions carry metadata only (fail closed)', async () => {
    const setup = await setupCurrents();
    const first = await seedRow(setup.store, TEAM as ModelName, {
      id: 'team-1',
      data: { name: 'team-one' },
    });
    const current = await updateRow(setup.store, TEAM as ModelName, first, {
      data: { name: 'team-two' },
    });
    const error = await captureStateError(
      staleUpdate(setup, current, { name: 'team-submitted' }),
    );
    assert.equal(error.code, 'conflict');
    const conflict = error.conflict;
    assert.ok(conflict !== undefined);
    assert.equal(conflict.current.version, 2);
    assert.deepEqual(conflict.current.values, {});
  });

  it('missing model entry carries metadata only (fail closed)', async () => {
    const setup = await setupCurrents();
    const first = await seedRow(setup.store, TEAM as ModelName, {
      id: 'team-1',
      data: { name: 'team-one' },
    });
    const current = await updateRow(setup.store, TEAM as ModelName, first, {
      data: { name: 'team-two' },
    });
    const error = await captureStateError(
      staleUpdate(setup, current, { name: 'team-submitted' }, new Map([['Other.Model', new Set()]])),
    );
    assert.equal(error.code, 'conflict');
    assert.ok(error.conflict !== undefined);
    assert.deepEqual(error.conflict.current.values, {});
  });
});

describe('B2 conflict currents: commit race + row-less denials', () => {
  it('commit-race version conflicts carry metadata and empty values', async () => {
    const setup = await setupCurrents();
    const first = await seedRow(setup.store, TEAM as ModelName, {
      id: 'team-1',
      data: { name: 'team-one' },
    });
    const current = await updateRow(setup.store, TEAM as ModelName, first, {
      data: { name: 'team-two' },
    });
    // A genuinely stale write: expects v1 against stored v2.
    const revision = await setup.store.readRevision();
    let thrown: unknown = null;
    try {
      await setup.store.commit(
        makeBatch(revision as number, {
          writes: [
            {
              kind: 'update',
              model: TEAM as ModelName,
              id: 'team-1' as RecordId,
              expectedVersion: first.version,
              row: current,
            },
          ],
        }),
      );
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof StorageConstraintError);
    assert.equal(thrown.kind, 'version');
    assert.deepEqual(thrown.conflictRow, {
      model: TEAM,
      id: 'team-1',
      version: 2,
      updated: FIXED_NOW,
      updatedBy: 'user-alice',
    });
    const mapped = storageToStateError(thrown);
    assert.ok(mapped instanceof StateError);
    assert.equal(mapped.code, 'conflict');
    assert.equal(mapped.message, 'Stale record version.');
    assert.ok(mapped.conflict !== undefined);
    assert.equal(mapped.conflict.current.version, 2);
    assert.equal(mapped.conflict.current.updated, EXPECTED_ISO);
    assert.deepEqual(mapped.conflict.current.values, {});
  });

  it('missing-row versions, uniques, and receipt-reuse carry nothing', async () => {
    const setup = await setupCurrents();
    // Missing-row version: no stored row to carry.
    const ghost = await setup.store
      .commit(
        makeBatch((await setup.store.readRevision()) as number, {
          writes: [
            {
              kind: 'update',
              model: TEAM as ModelName,
              id: 'ghost' as RecordId,
              expectedVersion: firstVersion(),
              row: ghostRow(),
            },
          ],
        }),
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(ghost instanceof StorageConstraintError);
    assert.equal(ghost.conflictRow, undefined);
    assert.equal(storageToStateError(ghost).conflict, undefined);

    // Unique violation: no row denial.
    const r1 = await setup.store.readRevision();
    await setup.store.commit(
      makeBatch(r1 as number, {
        uniqueClaims: [
          { model: TEAM as ModelName, keyName: 'code', keyValue: 'K', recordId: 'a' as RecordId },
        ],
      }),
    );
    const dup = await setup.store
      .commit(
        makeBatch((await setup.store.readRevision()) as number, {
          uniqueClaims: [
            { model: TEAM as ModelName, keyName: 'code', keyValue: 'K', recordId: 'b' as RecordId },
          ],
        }),
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(dup instanceof StorageConstraintError);
    assert.equal(dup.kind, 'unique');
    assert.equal(storageToStateError(dup).conflict, undefined);

    // Receipt reuse: identity-level, no row.
    const receipt = makeReceipt();
    const r3 = await setup.store.readRevision();
    await setup.store.commit(makeBatch(r3 as number, { receipt }));
    const reuse = await setup.store
      .commit(makeBatch((await setup.store.readRevision()) as number, { receipt }))
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(reuse instanceof StorageConstraintError);
    assert.equal(reuse.kind, 'receipt_reuse');
    const mapped = storageToStateError(reuse);
    assert.ok(mapped instanceof StateError);
    assert.equal(mapped.code, 'conflict');
    assert.equal(mapped.conflict, undefined);
  });

  it('fence-moved conflicts carry nothing (revision-level)', async () => {
    const setup = await setupCurrents();
    await seedRow(setup.store, TEAM as ModelName, { id: 'team-1', data: {} });
    assert.equal(await setup.store.readRevision(), 1);
    const error = await captureStateError(
      revalidateCommitForFence({
        checkpoint: { revision: asRevision(0), owner: 'team-a', dependencies: [] },
        by: 'public',
        guards: [],
        actorUserId: null,
        teamId: null,
        kind: 'user',
        store: setup.store,
        memberships: setup.memberships,
      }),
    );
    assert.equal(error.code, 'conflict');
    assert.match(error.message, /Checkpoint moved/);
    assert.equal(error.conflict, undefined);
  });

  it('toBusinessError renders conflict through and omits it otherwise', async () => {
    const setup = await setupCurrents();
    const first = await seedRow(setup.store, TEAM as ModelName, {
      id: 'team-1',
      data: { name: 'team-one' },
    });
    const current = await updateRow(setup.store, TEAM as ModelName, first, {
      data: { name: 'team-two' },
    });
    const stale = await captureStateError(
      staleUpdate(
        setup,
        current,
        { name: 'team-submitted' },
        holderExclusions(setup.loaded),
      ),
    );
    const opId = uuidv7(FIXED_NOW, (b2Seq += 1));
    const wire = toBusinessError(stale, opId);
    assert.equal(wire.code, 'conflict');
    assert.ok(wire.conflict !== undefined);
    assert.deepEqual(wire.conflict, stale.conflict);
    assert.equal(wire.operation_id, opId);

    const plain = toBusinessError(new StateError('validation', 'Bad input.'));
    assert.ok(!Object.hasOwn(plain, 'conflict'));
  });
});

/** Version-one brand for the ghost-row write (shape-only; never compared). */
function firstVersion(): StoredRow['version'] {
  return asVersion(1);
}

/** Ghost-row write target (shape-only; the pre-check fails first). */
function ghostRow(): StoredRow {
  return {
    id: 'ghost' as RecordId,
    version: asVersion(2),
    created: FIXED_NOW,
    updated: FIXED_NOW,
    createdBy: 'user-alice',
    updatedBy: 'user-alice',
    archivedAt: null,
    data: {},
  };
}
