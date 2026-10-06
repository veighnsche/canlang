/**
 * B2 canonical-read proofs (colocated): the consumable read scope on
 * existing vocabulary (T17a posture kept exactly — whole-model viewer
 * reads, archived excluded, descriptor-input reads refused pending
 * T04b).
 *
 * - Emitted reads carry NO descriptor inputs (real `t18-shop.can`
 *   artifact): transport-supplied inputs to them reject closed-shape.
 *   No live caller passes descriptor inputs: the scenario seam calls
 *   `invokeRead` with `inputs: {}` always (cloudflare
 *   runtime/invoke.ts `readModel`), stdlib refuses filtered shapes
 *   before the engine (`assertServableReadQuery`), and the compiler
 *   emits no-input reads per policy-bearing model (this file pins the
 *   shop case). The WITH-inputs refusal (T17a-pinned) is therefore
 *   dead-code-safe, not a live branch.
 * - History: reads observe exactly committed writes (versions advance,
 *   `historyFor` matches served rows); uncommitted pipeline output is
 *   invisible to reads; denied reads leave no trace (revision, rows,
 *   and history all unchanged).
 *
 * Engine filtered/owner/archived/policy execution itself is pinned by
 * the query suites (`test/query/scope`, `authority`, `projection`,
 * `aggregates`) — cited green, not duplicated. Durable substrates
 * (adapter attachment, restart, replay) ride in
 * `b2-reads-durable.test.ts`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CompileArtifact } from '@canlang/contracts';
import type {
  ModelName,
  OperationName,
  RecordId,
  StoragePort,
  StoredRow,
} from '@canlang/contracts';
import type { ReadEnvelope } from '@canlang/contracts';
import {
  loadArtifactDescriptors,
  type ArtifactDescriptorSlice,
  type LoadedArtifactDescriptors,
} from './registry.js';
import { buildModelTableFromCanonical, type ModelTable } from '../mutation/models.js';
import { generatedCrudExecute } from '../mutation/crud.js';
import { runMutationWrites } from '../mutation/pipeline.js';
import { invoke, invokeRead } from './invoke.js';
import { buildContext } from './context.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import { buildPolicyTable, type PolicyTable } from '../policy/grants.js';
import {
  FIXED_NOW,
  asModel,
  captureStateError,
  createMemoryIdentityStore,
  fieldPaths,
  makeBatch,
  makeEnvelope,
  makeIdentity,
  seedMember,
  uuidv7,
  type SeededMember,
  type TestMembershipStore,
} from '../../test/invocation/fixtures.js';
import { T18_SHOP_ARTIFACT_JSON } from '../mutation/t18-shop.artifact.js';

const APP = 'acme-app';
const TEAM = 'Shop.Team';
const TEAM_CREATE = 'Shop.Team.create';
const TEAM_UPDATE = 'Shop.Team.update';
const TEAM_READ = 'Shop.Team.read';
const MEMBER_READ = 'Shop.Member.read';

function shopSlice(): ArtifactDescriptorSlice {
  const artifact = JSON.parse(T18_SHOP_ARTIFACT_JSON) as CompileArtifact;
  const { operations, models } = artifact;
  assert.equal(artifact.artifact_version, 1);
  assert.ok(Array.isArray(operations) && operations.length > 0);
  assert.ok(Array.isArray(models) && models.length > 0);
  return { artifact_version: artifact.artifact_version, operations, models };
}

interface B2Setup {
  store: StoragePort;
  memberships: TestMembershipStore;
  alice: SeededMember;
  loaded: LoadedArtifactDescriptors;
  table: ModelTable;
  policy: PolicyTable;
}

async function setupReads(): Promise<B2Setup> {
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const loaded = loadArtifactDescriptors(shopSlice(), { by: 'members' });
  const table = buildModelTableFromCanonical(loaded.models, {
    refs: loaded.refs,
    serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields,
  });
  const policy = buildPolicyTable([
    {
      model: asModel(TEAM),
      secretFields: [],
      grants: [{ by: 'members', fields: ['name', 'stock'] }],
    },
  ]);
  return { store, memberships, alice, loaded, table, policy };
}

function identityFor(member: SeededMember) {
  return makeIdentity({ membership: member.membership, email: member.user.email });
}

let b2Seq = 40000;

function nextOperationId(): string {
  b2Seq += 1;
  return uuidv7(FIXED_NOW, b2Seq);
}

function minimalTeamInputs(): Record<string, unknown> {
  return { name: 'team-one', owner: { id: 'u-boss' }, flags: ['f1'] };
}

async function readTeam(setup: B2Setup, inputs: Record<string, unknown> = {}) {
  const envelope: ReadEnvelope = { operation: TEAM_READ, inputs };
  return invokeRead({
    registry: setup.loaded.registry,
    envelope,
    identity: identityFor(setup.alice),
    policy: setup.policy,
    store: setup.store,
    memberships: setup.memberships,
  });
}

async function createTeam(
  setup: B2Setup,
  inputs: Record<string, unknown> = minimalTeamInputs(),
): Promise<StoredRow> {
  const result = await invoke({
    registry: setup.loaded.registry,
    envelope: makeEnvelope(TEAM_CREATE, nextOperationId(), inputs),
    identity: identityFor(setup.alice),
    app: APP,
    source: 'test',
    store: setup.store,
    memberships: setup.memberships,
    clock: { nowMs: () => FIXED_NOW },
    execute: generatedCrudExecute({ table: setup.table, store: setup.store }),
  });
  assert.equal(result.status, 'committed');
  return result.result as StoredRow;
}

describe('B2 reads: emitted scope + refusal boundary', () => {
  it('emitted reads carry no descriptor inputs; transport inputs reject closed-shape', async () => {
    const setup = await setupReads();
    for (const name of [TEAM_READ, MEMBER_READ]) {
      const def = setup.loaded.registry.get(name);
      assert.ok(def !== undefined && 'descriptor' in def);
      assert.deepEqual(def.descriptor.inputs, []);
    }
    // A transport caller supplying filter-ish inputs to a no-input read
    // rejects closed-shape (unknown member) — never served, never
    // mis-filtered.
    const rejected = await captureStateError(readTeam(setup, { q: 'x' }));
    assert.equal(rejected.code, 'validation');
    assert.deepEqual(fieldPaths(rejected), ['/q']);
    assert.equal(await setup.store.readRevision(), 0);
  });
});

describe('B2 reads: history agreement', () => {
  it('reads observe exactly committed writes with matching history', async () => {
    const setup = await setupReads();
    const created = await createTeam(setup);
    const first = await readTeam(setup);
    assert.equal(first.revision, 1);
    assert.equal(first.records.length, 1);
    assert.equal(first.records[0]?.version, 1);
    assert.deepEqual(first.records[0]?.data, { name: 'team-one', stock: '0' });

    const updateId = nextOperationId();
    const updated = await invoke({
      registry: setup.loaded.registry,
      envelope: makeEnvelope(TEAM_UPDATE, updateId, {
        record: { id: created.id, version: '1' },
        name: 'team-two',
      }),
      identity: identityFor(setup.alice),
      app: APP,
      source: 'test',
      store: setup.store,
      memberships: setup.memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute: generatedCrudExecute({ table: setup.table, store: setup.store }),
    });
    assert.equal(updated.status, 'committed');
    const second = await readTeam(setup);
    assert.equal(second.revision, 2);
    assert.equal(second.records.length, 1);
    assert.equal(second.records[0]?.version, 2);
    assert.deepEqual(second.records[0]?.data, { name: 'team-two', stock: '0' });

    // The served versions match the committed history entry for entry.
    const history = await setup.store.historyFor(TEAM as ModelName, created.id);
    assert.equal(history.length, 2);
    assert.equal(history[0]?.version, 1);
    assert.equal(history[0]?.change, 'create');
    assert.equal(history[1]?.version, 2);
    assert.equal(history[1]?.change, 'update');
    assert.equal(history[1]?.operationId, updateId);
    assert.equal(history[1]?.actor, setup.alice.membership.user_id);
  });

  it('reads never observe uncommitted pipeline output', async () => {
    const setup = await setupReads();
    const context = buildContext({
      identity: identityFor(setup.alice),
      operation: TEAM_CREATE as OperationName,
      operationId: nextOperationId(),
      app: APP,
      source: 'test',
      now: FIXED_NOW,
    });
    const staged = await runMutationWrites({
      table: setup.table,
      writes: [
        {
          op: 'create',
          model: TEAM as ModelName,
          id: 'ghost-1' as RecordId,
          data: minimalTeamInputs(),
        },
      ],
      context,
      store: setup.store,
    });
    assert.equal(staged.writes.length, 1);
    // Staged but uncommitted: reads see nothing (no provisional leak —
    // reads consult the committed store only).
    const before = await readTeam(setup);
    assert.deepEqual(before.records, []);
    assert.equal(before.revision, 0);
    // After the commit lands, the same read serves it.
    const revision = await setup.store.readRevision();
    await setup.store.commit(
      makeBatch(revision as number, {
        writes: [...staged.writes],
        history: [...staged.history],
        uniqueClaims: [...staged.uniqueClaims],
        uniqueReleases: [...staged.uniqueReleases],
      }),
    );
    const after = await readTeam(setup);
    assert.equal(after.records.length, 1);
    assert.equal(after.records[0]?.id, 'ghost-1');
  });

  it('denied reads leave revision, rows, and history all unchanged', async () => {
    const setup = await setupReads();
    const row = await createTeam(setup);
    // Non-member of Alice's team: the members gate denies (T17a pins
    // revision purity; this extends the pin to rows and history).
    const outsider = await seedMember(setup.memberships, { isOwner: false });
    const denied = await captureStateError(
      invokeRead({
        registry: setup.loaded.registry,
        envelope: { operation: TEAM_READ, inputs: {} },
        identity: makeIdentity({
          membership: outsider.membership,
          teamId: setup.alice.team.team_id,
          email: outsider.user.email,
        }),
        policy: setup.policy,
        store: setup.store,
        memberships: setup.memberships,
      }),
    );
    assert.equal(denied.code, 'forbidden');
    assert.equal(await setup.store.readRevision(), 1);
    const rows = await setup.store.query({ model: TEAM as ModelName, authority: 'owner' });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.data, row.data);
    const history = await setup.store.historyFor(TEAM as ModelName, row.id);
    assert.equal(history.length, 1);
  });
});
