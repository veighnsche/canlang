/**
 * T17a generated-read tests (colocated): `invokeRead` serves generated
 * `<Model>.read` operations through canonical admission plus the viewer
 * query port — the migration target for the interim `records()` data-plane
 * operation (direct store queries, owner rows, no admission).
 *
 * Covers: projected serving at the fence revision, denied-not-unknown,
 * routing (unknown/mutation/interim/model-less), closed-shape validation,
 * core-scope refusals (reads WITH inputs, malformed names), trusted and
 * forged identity handling, read purity (no commits, no receipts, stable
 * revision), archived exclusion, policy-miss emptiness, and bound/unbound
 * parity (`createReadInvoker` is the T17b consumption surface).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ArtifactModel,
  ArtifactModelField,
  ArtifactOperation,
  ArtifactOperationInput,
} from '../../../contracts/src/artifact.js';
import type { ReadEnvelope } from '../../../contracts/src/wire.js';
import type { StoragePort, StoredRow } from '../../../contracts/src/state.js';
import {
  loadArtifactDescriptors,
  type ArtifactDescriptorSlice,
} from './registry.js';
import { buildModelTableFromCanonical, type ModelTable } from '../mutation/models.js';
import { generatedCrudExecute } from '../mutation/crud.js';
import { invoke, invokeRead } from './invoke.js';
import { createReadInvoker } from '../ports/transact.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import { buildPolicyTable, type PolicyTable } from '../policy/grants.js';
import {
  FIXED_NOW,
  asModel,
  captureStateError,
  createMemoryIdentityStore,
  fieldPaths,
  makeDef,
  makeEnvelope,
  makeIdentity,
  seedMember,
  uuidv7,
  type SeededMember,
  type TestMembershipStore,
} from '../../test/invocation/fixtures.js';

const APP = 'acme-app';
const GADGET = 'Shop.Gadget';
const PUB = 'Shop.Pub';

function scalarInput(
  name: string,
  kind: 'string' | 'integer' | 'enum',
  required: boolean,
): ArtifactOperationInput {
  const field =
    kind === 'enum'
      ? { kind: 'enum' as const, values: ['new', 'used'] }
      : ({ kind } as ArtifactOperationInput['field']);
  return { name, field, required };
}

function refInput(name: string, model: string, requireVersion: boolean): ArtifactOperationInput {
  return { name, field: { kind: 'ref', model, requireVersion }, required: true };
}

function modelField(
  name: string,
  field: ArtifactModelField['field'],
  opts: { required?: boolean; default?: ArtifactModelField['default'] } = {},
): ArtifactModelField {
  return {
    name,
    field,
    required: opts.required ?? false,
    serverOnly: false,
    ...(opts.default !== undefined ? { default: opts.default } : {}),
  };
}

function readOp(model: string, fields: ArtifactOperationInput[] = []): ArtifactOperation {
  return { name: `${model}.read`, kind: 'read', description: '', inputs: { fields } };
}

/** Core-scope slice: CRUD plus no-input `<Model>.read` per policy-bearing model. */
function readSlice(): ArtifactDescriptorSlice {
  const gadget: ArtifactModel = {
    name: GADGET,
    fields: [
      modelField('title', { kind: 'string' }, { required: true }),
      modelField('stock', { kind: 'integer' }, { default: { kind: 'literal', value: '0' } }),
      modelField('code', { kind: 'string' }, { required: true }),
    ],
    deleteMode: 'archive',
    uniqueKeys: ['code'],
  };
  const pub: ArtifactModel = {
    name: PUB,
    fields: [modelField('title', { kind: 'string' }, { required: true })],
    deleteMode: 'archive',
  };
  const gadgetInputs: ArtifactOperationInput[] = [
    scalarInput('title', 'string', true),
    scalarInput('stock', 'integer', false),
    scalarInput('code', 'string', true),
  ];
  return {
    artifact_version: 1,
    operations: [
      { name: `${GADGET}.create`, kind: 'create', description: '', inputs: { fields: gadgetInputs } },
      {
        name: `${GADGET}.update`,
        kind: 'update',
        description: '',
        inputs: {
          fields: [
            refInput('record', GADGET, true),
            ...gadgetInputs.map((field) => ({ ...field, required: false })),
          ],
        },
      },
      {
        name: `${GADGET}.delete`,
        kind: 'delete',
        description: '',
        inputs: { fields: [refInput('record', GADGET, true)] },
      },
      readOp(GADGET),
      {
        name: `${PUB}.create`,
        kind: 'create',
        description: '',
        inputs: { fields: [scalarInput('title', 'string', true)] },
      },
      readOp(PUB),
    ],
    models: [gadget, pub],
  };
}

function readEnvelope(operation: string, inputs: Record<string, unknown> = {}): ReadEnvelope {
  return { operation, inputs };
}

interface ReadSetup {
  store: StoragePort;
  memberships: TestMembershipStore;
  alice: SeededMember;
  table: ModelTable;
  policy: PolicyTable;
  registry: ReturnType<typeof loadArtifactDescriptors>['registry'];
}

async function setupReads(): Promise<ReadSetup> {
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const loaded = loadArtifactDescriptors(readSlice(), { by: 'members' });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
  const policy = buildPolicyTable([
    {
      model: asModel(GADGET),
      secretFields: [],
      grants: [{ by: 'members', fields: ['title', 'code'] }],
    },
    {
      model: asModel(PUB),
      secretFields: [],
      grants: [{ by: 'public', fields: ['title'] }],
    },
  ]);
  return { store, memberships, alice, table, policy, registry: loaded.registry };
}

function identityFor(member: SeededMember) {
  return makeIdentity({ membership: member.membership, email: member.user.email });
}

let readSeq = 5000;

async function seedGadget(
  setup: ReadSetup,
  inputs: Record<string, unknown>,
): Promise<StoredRow> {
  const execute = generatedCrudExecute({ table: setup.table, store: setup.store });
  const result = await invoke({
    registry: setup.registry,
    envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, (readSeq += 1)), inputs),
    identity: identityFor(setup.alice),
    app: APP,
    source: 'test',
    store: setup.store,
    memberships: setup.memberships,
    clock: { nowMs: () => FIXED_NOW },
    execute,
  });
  assert.equal(result.status, 'committed');
  return result.result as StoredRow;
}

describe('T17a invokeRead: projected serving', () => {
  it('serves committed rows grant-projected at the fence revision', async () => {
    const setup = await setupReads();
    const first = await seedGadget(setup, { title: 'drill', code: 'R-1', stock: '3' });
    const second = await seedGadget(setup, { title: 'saw', code: 'R-2' });
    assert.equal(await setup.store.readRevision(), 2);

    const served = await invokeRead({
      registry: setup.registry,
      envelope: readEnvelope(`${GADGET}.read`),
      identity: identityFor(setup.alice),
      policy: setup.policy,
      store: setup.store,
      memberships: setup.memberships,
    });
    assert.equal(served.revision, 2);
    assert.equal(served.records.length, 2);
    // Deterministic order: same-created rows tiebreak by id.
    const ids = served.records.map((record) => record.id).sort();
    assert.deepEqual(ids, [first.id, second.id].sort());
    for (const record of served.records) {
      // Projection, not owner rows: granted leaves only (stock dropped).
      assert.deepEqual(Object.keys(record.data).sort(), ['code', 'title']);
    }
    const byId = new Map(served.records.map((record) => [record.id, record]));
    assert.deepEqual(byId.get(first.id)?.data, { title: 'drill', code: 'R-1' });
    assert.deepEqual(byId.get(second.id)?.data, { title: 'saw', code: 'R-2' });
    // Reads commit nothing.
    assert.equal(await setup.store.readRevision(), 2);
  });

  it('matches unbound and bound serving byte-for-byte', async () => {
    const setup = await setupReads();
    await seedGadget(setup, { title: 'drill', code: 'B-1' });
    const reader = createReadInvoker({
      registry: setup.registry,
      policy: setup.policy,
      store: setup.store,
      memberships: setup.memberships,
    });
    const identity = identityFor(setup.alice);
    const envelope = readEnvelope(`${GADGET}.read`);
    const unbound = await invokeRead({
      registry: setup.registry,
      envelope,
      identity,
      policy: setup.policy,
      store: setup.store,
      memberships: setup.memberships,
    });
    const bound = await reader({ envelope, identity });
    assert.deepEqual(bound, unbound);
  });

  it('serves empty records on a policy miss (fail closed, no invented error)', async () => {
    const setup = await setupReads();
    await seedGadget(setup, { title: 'drill', code: 'P-1' });
    const emptyPolicy = buildPolicyTable([]);
    const served = await invokeRead({
      registry: setup.registry,
      envelope: readEnvelope(`${GADGET}.read`),
      identity: identityFor(setup.alice),
      policy: emptyPolicy,
      store: setup.store,
      memberships: setup.memberships,
    });
    assert.deepEqual(served.records, []);
    assert.equal(served.revision, 1);
  });

  it('excludes archived rows from viewer reads', async () => {
    const setup = await setupReads();
    const row = await seedGadget(setup, { title: 'drill', code: 'A-1' });
    const execute = generatedCrudExecute({ table: setup.table, store: setup.store });
    await invoke({
      registry: setup.registry,
      envelope: makeEnvelope(`${GADGET}.delete`, uuidv7(FIXED_NOW, (readSeq += 1)), {
        record: { id: row.id, version: '1' },
      }),
      identity: identityFor(setup.alice),
      app: APP,
      source: 'test',
      store: setup.store,
      memberships: setup.memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
    });
    const served = await invokeRead({
      registry: setup.registry,
      envelope: readEnvelope(`${GADGET}.read`),
      identity: identityFor(setup.alice),
      policy: setup.policy,
      store: setup.store,
      memberships: setup.memberships,
    });
    assert.deepEqual(served.records, []);
    assert.equal(served.revision, 2);
  });
});

describe('T17a invokeRead: denied-not-unknown and routing', () => {
  it('denies unauthorized callers without touching state', async () => {
    const setup = await setupReads();
    await seedGadget(setup, { title: 'drill', code: 'D-1' });
    const stranger = await seedMember(setup.memberships, { isOwner: false });
    const identity = makeIdentity({
      membership: stranger.membership,
      teamId: setup.alice.team.team_id,
      email: stranger.user.email,
    });
    const before = await setup.store.readRevision();
    const denied = await captureStateError(
      invokeRead({
        registry: setup.registry,
        envelope: readEnvelope(`${GADGET}.read`),
        identity,
        policy: setup.policy,
        store: setup.store,
        memberships: setup.memberships,
      }),
    );
    assert.equal(denied.code, 'forbidden');
    assert.equal(await setup.store.readRevision(), before);
  });

  it('rejects unknown operations, mutations, and interim defs precisely', async () => {
    const setup = await setupReads();
    const identity = identityFor(setup.alice);
    const base = {
      registry: setup.registry,
      identity,
      policy: setup.policy,
      store: setup.store,
      memberships: setup.memberships,
    };
    const unknown = await captureStateError(
      invokeRead({ ...base, envelope: readEnvelope('Shop.Nope.read') }),
    );
    assert.equal(unknown.code, 'validation');
    assert.match(unknown.message, /Unknown operation "Shop\.Nope\.read"/);

    const mutation = await captureStateError(
      invokeRead({ ...base, envelope: readEnvelope(`${GADGET}.create`, { title: 'x' }) }),
    );
    assert.equal(mutation.code, 'validation');
    assert.match(mutation.message, /mutation envelope/);

    const interim = await captureStateError(
      invokeRead({
        ...base,
        registry: new Map([['Acme.approve', makeDef()]]),
        envelope: readEnvelope('Acme.approve'),
      }),
    );
    assert.equal(interim.code, 'validation');
    assert.match(interim.message, /generated read operations only/);
    assert.equal(await setup.store.readRevision(), 0);
  });

  it('refuses reads that name no model', async () => {
    const slice = readSlice();
    (slice.operations as ArtifactOperation[]).push({
      name: 'Shop.Gadget.list',
      kind: 'read',
      description: '',
      inputs: { fields: [] },
    });
    const loaded = loadArtifactDescriptors(slice, { by: 'members' });
    const setup = await setupReads();
    const refused = await captureStateError(
      invokeRead({
        registry: loaded.registry,
        envelope: readEnvelope('Shop.Gadget.list'),
        identity: identityFor(setup.alice),
        policy: setup.policy,
        store: setup.store,
        memberships: setup.memberships,
      }),
    );
    assert.equal(refused.code, 'validation');
    assert.match(refused.message, /<Model>\.read/);
    assert.equal(await setup.store.readRevision(), 0);
  });

  it('validates closed shape, then refuses reads WITH inputs instead of mis-serving', async () => {
    const setup = await setupReads();
    const identity = identityFor(setup.alice);
    const base = {
      registry: setup.registry,
      identity,
      policy: setup.policy,
      store: setup.store,
      memberships: setup.memberships,
    };
    const shape = await captureStateError(
      invokeRead({ ...base, envelope: readEnvelope(`${GADGET}.read`, { bogus: 1 }) }),
    );
    assert.equal(shape.code, 'validation');
    assert.deepEqual(fieldPaths(shape), ['/bogus']);

    const slice = readSlice();
    const ops = slice.operations as ArtifactOperation[];
    const gadgetRead = ops.find((op) => op.name === `${GADGET}.read`);
    assert.ok(gadgetRead);
    gadgetRead.inputs.fields.push(scalarInput('q', 'string', false));
    const loaded = loadArtifactDescriptors(slice, { by: 'members' });
    const refused = await captureStateError(
      invokeRead({ ...base, registry: loaded.registry, envelope: readEnvelope(`${GADGET}.read`) }),
    );
    assert.equal(refused.code, 'validation');
    assert.match(refused.message, /T04b carries filter inputs/);
    assert.equal(await setup.store.readRevision(), 0);
  });
});

describe('T17a invokeRead: identity, trust, and purity', () => {
  it('ignores forged identity contents: the live membership store wins both ways', async () => {
    const setup = await setupReads();
    await seedGadget(setup, { title: 'drill', code: 'F-1' });
    const base = {
      registry: setup.registry,
      envelope: readEnvelope(`${GADGET}.read`),
      policy: setup.policy,
      store: setup.store,
      memberships: setup.memberships,
    };
    const forged = await captureStateError(
      invokeRead({
        ...base,
        identity: makeIdentity({
          userId: 'user-ghost',
          teamId: setup.alice.team.team_id,
          isOwner: true,
        }),
      }),
    );
    assert.equal(forged.code, 'forbidden');

    const ok = await invokeRead({
      ...base,
      identity: makeIdentity({
        membership: null,
        userId: setup.alice.user.user_id,
        teamId: setup.alice.team.team_id,
      }),
    });
    assert.equal(ok.records.length, 1);
  });

  it('serves trusted reads on verified-source authority with public grants', async () => {
    const setup = await setupReads();
    const execute = generatedCrudExecute({ table: setup.table, store: setup.store });
    await invoke({
      registry: setup.registry,
      envelope: makeEnvelope(`${PUB}.create`, uuidv7(FIXED_NOW, (readSeq += 1)), {
        title: 'notice',
      }),
      identity: identityFor(setup.alice),
      app: APP,
      source: 'test',
      store: setup.store,
      memberships: setup.memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
    });
    const base = {
      registry: setup.registry,
      envelope: readEnvelope(`${PUB}.read`),
      identity: identityFor(setup.alice),
      policy: setup.policy,
      store: setup.store,
      memberships: setup.memberships,
    };
    const missingSource = await captureStateError(
      invokeRead({ ...base, kind: 'trusted' as const }),
    );
    assert.equal(missingSource.code, 'validation');
    assert.match(missingSource.message, /verified trusted source/);

    // Trusted skips the op-level gate; row grants still evaluate (actor
    // null): the public grant serves, members-only grants would not.
    const served = await invokeRead({ ...base, kind: 'trusted' as const, trustedSource: 'worker' });
    assert.equal(served.records.length, 1);
    assert.deepEqual(served.records[0]?.data, { title: 'notice' });
    assert.equal(await setup.store.readRevision(), 1);
  });

  it('repeats byte-identically with the revision frozen and no receipts', async () => {
    const setup = await setupReads();
    const row = await seedGadget(setup, { title: 'drill', code: 'Y-1' });
    const args = {
      registry: setup.registry,
      envelope: readEnvelope(`${GADGET}.read`),
      identity: identityFor(setup.alice),
      policy: setup.policy,
      store: setup.store,
      memberships: setup.memberships,
    };
    const first = await invokeRead(args);
    const second = await invokeRead(args);
    const third = await invokeRead(args);
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.equal(await setup.store.readRevision(), 1);
    // Domain state untouched by the read burst.
    const rows = await setup.store.query({ model: asModel(GADGET), authority: 'owner' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, row.id);
    assert.equal(rows[0]?.version, row.version);
    assert.deepEqual(rows[0]?.data, row.data);
  });
});
