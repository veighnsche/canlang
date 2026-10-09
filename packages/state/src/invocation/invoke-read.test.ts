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
} from '@canlang/contracts';
import type { ReadEnvelope } from '@canlang/contracts';
import type { Receipt, StoragePort, StoredRow } from '@canlang/contracts';
import {
  loadArtifactDescriptors,
  type ArtifactDescriptorSlice,
} from './registry.js';
import { buildModelTableFromCanonical, type ModelTable } from '../mutation/models.js';
import { generatedCrudExecute } from '../mutation/crud.js';
import { invoke, invokeRead, invokeReadScenario, projectGeneratedCrudReceipt,
  type AdmittedReadScenarioCall, type CommittedReceiptOutcome } from './invoke.js';
import { createReadInvoker, createReadScenarioInvoker } from '../ports/transact.js';
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
  updateRow,
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

describe('saved generated CRUD disclosure', () => {
  async function savedWorld() {
    const { store } = createTestMemoryStorage();
    const memberships = createMemoryIdentityStore();
    const alice = await seedMember(memberships, { isOwner: false, roles: ['Shop.reader'] });
    const slice = readSlice();
    // The creating declaration owns this typed secret; a later public grant
    // over the same field name cannot declassify its saved content.
    const code = slice.models![0]!.fields.find(field => field.name === 'code')!;
    code.field = { kind: 'secret' }; code.required = false; code.serverOnly = true;
    code.default = { kind: 'server', init: 'random_secret' };
    for (const op of slice.operations!) {
      if (op.name === `${GADGET}.create` || op.name === `${GADGET}.update`) {
        op.inputs.fields = op.inputs.fields.filter(field => field.name !== 'code');
      }
    }
    const loaded = loadArtifactDescriptors(slice, { by: 'members' });
    const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs,
      serverInits: loaded.serverInits, nullableFields: loaded.nullableFields });
    let observed: Receipt | undefined;
    const envelope = makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, ++readSeq), { title: 'saved', stock: '5' });
    const result = await invoke({ registry: loaded.registry,
      envelope,
      identity: identityFor(alice), app: APP, source: 'test', store, memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute: generatedCrudExecute({ table, store,
        secretFields: new Map([...loaded.secretFields].map(([model, fields]) => [model, [...fields]])) }),
      observeCommittedReceipt: receipt => { observed = receipt; },
    });
    assert.ok(observed);
    const saved = result.result as StoredRow;
    const current = await updateRow(store, asModel(GADGET), saved, {
      updated: FIXED_NOW + 1000, data: { ...saved.data, title: 'current', stock: '9' },
    });
    const policy = buildPolicyTable([{ model: asModel(GADGET), secretFields: ['stock'], grants: [{
      by: { role: 'Shop.reader' }, fields: ['title', 'code'],
      when: { op: 'eq', field: 'title', value: 'current' },
    }] }]);
    return { store, memberships, alice, registry: loaded.registry, receipt: observed,
      policy, saved, current, envelope, app: APP, identity: identityFor(alice) };
  }

  it('retained-receipt-only preserves the replay observer and current secret/grant projection', async () => {
    const world = await savedWorld();
    const revision = await world.store.readRevision();
    let executions = 0, commits = 0, observed: Receipt | undefined;
    const recovery = { ...world, admissionMode: 'retained-receipt-only' as const,
      source: 'test', clock: { nowMs: () => FIXED_NOW + 16 * 60 * 1000 },
      store: { ...world.store, commit: async (batch: Parameters<typeof world.store.commit>[0]) => {
        commits += 1; return world.store.commit(batch);
      } }, execute: async () => { executions += 1; throw new Error('Recovery must not execute.'); },
      observeCommittedReceipt: (receipt: Receipt) => { observed = receipt; },
    };
    assert.equal((await invoke(recovery)).status, 'replayed');
    assert.deepEqual(observed, world.receipt);
    const projected = await projectGeneratedCrudReceipt({ ...world, receipt: observed! });
    assert.deepEqual(projected.records[0]?.data, { title: 'saved' });
    assert.equal(projected.records[0]?.version, world.saved.version);
    const memberships = { ...world.memberships, findMembership: async (team: string, user: string) => {
      const current = await world.memberships.findMembership(team, user);
      return current === null ? null : { ...current, roles: [] };
    } };
    await invoke({ ...recovery, memberships });
    assert.deepEqual(await projectGeneratedCrudReceipt({ ...world, memberships, receipt: observed! }),
      { result: null, records: [] });
    assert.equal(executions, 0);
    assert.equal(commits, 0);
    assert.equal(await world.store.readRevision(), revision);
  });

  it('uses live grant conditions but preserves saved values, versions and secret exclusions', async () => {
    const world = await savedWorld();
    const before = structuredClone(world.receipt);
    const revision = await world.store.readRevision();
    const projected = await projectGeneratedCrudReceipt(world);
    assert.equal(projected.result, null);
    assert.deepEqual(projected.records[0]?.data, { title: 'saved' });
    assert.equal(projected.records[0]?.version, world.saved.version);
    assert.equal(projected.records[0]?.updated, world.saved.updated);
    assert.notEqual(projected.records[0]?.updated, world.current.updated);
    assert.deepEqual(world.receipt, before);
    assert.equal(await world.store.readRevision(), revision);
    assert.ok(typeof world.saved.data.code === 'string');
    const deniedWhen = buildPolicyTable([{ model: asModel(GADGET), secretFields: [], grants: [{
      by: 'members', fields: ['title'], when: { op: 'eq', field: 'title', value: 'saved' },
    }] }]);
    assert.deepEqual(await projectGeneratedCrudReceipt({ ...world, policy: deniedWhen }), { result: null, records: [] });
  });

  it('withholds content when a read role or mutation gate is revoked while membership survives', async () => {
    const world = await savedWorld();
    const live = { ...world.memberships, findMembership: async (team: string, user: string) => {
      const membership = await world.memberships.findMembership(team, user);
      return membership === null ? null : { ...membership, roles: [] };
    } };
    assert.equal((await live.findMembership(world.alice.team.team_id, world.alice.user.user_id))?.status, 'active');
    assert.deepEqual(await projectGeneratedCrudReceipt({ ...world, memberships: live }), { result: null, records: [] });
    const denied = loadArtifactDescriptors(readSlice(), { by: 'owner' }).registry;
    assert.deepEqual(await projectGeneratedCrudReceipt({ ...world, registry: denied }), { result: null, records: [] });
    const withoutMembership = { ...world.memberships, findMembership: async () => null };
    assert.deepEqual(await projectGeneratedCrudReceipt({ ...world, memberships: withoutMembership }), { result: null, records: [] });
  });

  it('refuses missing, unknown or inconsistent execution metadata without classifying old results', async () => {
    const world = await savedWorld();
    assert.equal(world.receipt.outcome.status, 'committed');
    const outcome = world.receipt.outcome as CommittedReceiptOutcome;
    const association = outcome.generatedCrud!;
    const variants: CommittedReceiptOutcome[] = [
      { status: 'committed', result: outcome.result, recordVersions: outcome.recordVersions },
      { ...outcome, generatedCrud: { ...association, kind: 'unknown' } } as unknown as CommittedReceiptOutcome,
      { ...outcome, generatedCrud: { kind: association.kind, model: association.model, record: association.record } },
      { ...outcome, generatedCrud: { ...association, model: asModel(PUB) } },
      { ...outcome, generatedCrud: { ...association, record: { id: world.saved.id, version: world.current.version } } },
      { ...outcome, recordVersions: [] },
      { ...outcome, result: { echoed: 'ordinary value' } },
      { ...outcome, generatedCrud: { ...association, record: null } },
      { ...outcome, generatedCrud: { ...association, secretFields: ['code..token'] } },
      { ...outcome, generatedCrud: { ...association, secretFields: new Array<string>(1) } },
    ];
    for (const changed of variants) {
      const error = await captureStateError(() => projectGeneratedCrudReceipt({ ...world,
        receipt: { ...world.receipt, outcome: changed } }));
      assert.equal(error.code, 'validation');
    }
    let accessorRan = false;
    const hostile: CommittedReceiptOutcome = { ...outcome };
    Object.defineProperty(hostile, 'generatedCrud', { get: () => { accessorRan = true; return association; } });
    const secretSlots: string[] = [];
    Object.defineProperty(secretSlots, '0', { get: () => { accessorRan = true; return 'code'; } });
    const nested: CommittedReceiptOutcome = { ...outcome, generatedCrud: { ...association, secretFields: secretSlots } };
    for (const changed of [hostile, nested]) {
      const error = await captureStateError(() => projectGeneratedCrudReceipt({ ...world,
        receipt: { ...world.receipt, outcome: changed } }));
      assert.equal(error.code, 'validation');
    }
    assert.equal(accessorRan, false);
    const error = await captureStateError(() => projectGeneratedCrudReceipt({ ...world, app: 'foreign-app' }));
    assert.equal(error.code, 'forbidden');
  });

  it('withholds missing, archived or reparented live rows and authority changing during disclosure', async () => {
    const world = await savedWorld();
    for (const row of [null, { ...world.current, archivedAt: FIXED_NOW },
      { ...world.current, parent: { model: asModel(PUB), id: world.current.id } }]) {
      const store = { ...world.store, load: async () => row };
      assert.deepEqual(await projectGeneratedCrudReceipt({ ...world, store }), { result: null, records: [] });
    }
    let reads = 0;
    const memberships = { ...world.memberships, findMembership: async (team: string, user: string) => {
      const member = await world.memberships.findMembership(team, user);
      return member === null || ++reads < 3 ? member : { ...member, roles: [] };
    } };
    assert.deepEqual(await projectGeneratedCrudReceipt({ ...world, memberships }), { result: null, records: [] });
    let revisions = 0;
    const store = { ...world.store, readRevision: async () => {
      const revision = await world.store.readRevision();
      return ++revisions < 2 ? revision : (revision + 1) as typeof revision;
    } };
    assert.deepEqual(await projectGeneratedCrudReceipt({ ...world, store }), { result: null, records: [] });
  });

  it('keeps an actual hard-removal outcome empty without another execution or commit', async () => {
    const world = await savedWorld();
    const slice = readSlice(); slice.models![0]!.deleteMode = 'remove';
    const loaded = loadArtifactDescriptors(slice, { by: 'members' });
    const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
    let observed: Receipt | undefined;
    await invoke({ ...world, registry: loaded.registry,
      envelope: makeEnvelope(`${GADGET}.delete`, uuidv7(FIXED_NOW, ++readSeq), {
        record: { id: world.current.id, version: String(world.current.version) },
      }), source: 'test', clock: { nowMs: () => FIXED_NOW },
      execute: generatedCrudExecute({ table, store: world.store,
        secretFields: new Map([[asModel(GADGET), []]]) }),
      observeCommittedReceipt: receipt => { observed = receipt; },
    });
    assert.ok(observed);
    const revision = await world.store.readRevision();
    assert.deepEqual(await projectGeneratedCrudReceipt({ ...world, registry: loaded.registry, receipt: observed }),
      { result: null, records: [] });
    assert.equal(await world.store.load(asModel(GADGET), world.current.id), null);
    assert.equal(await world.store.readRevision(), revision);
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


describe('ordinary source read scenarios', () => {
  async function scenarioSetup() {
    const setup = await setupReads();
    const slice = readSlice();
    const loaded = loadArtifactDescriptors({ ...slice, operations: [...slice.operations!, {
      name: 'Shop.inspect', kind: 'read', description: 'Return visible gadget details.',
      inputs: { fields: [refInput('gadget', GADGET, true),
        { name: 'labels', field: { kind: 'string' }, required: false, array: { required: false } },
        { name: 'counts', field: { kind: 'integer' }, required: false,
          array: { required: false }, default: { kind: 'literal', value: ['2'] } }] },
    }] }, { by: 'members' });
    return { ...setup, registry: loaded.registry };
  }

  it('executes the source callback with projected refs/normalized omissions and no mutation surfaces', async () => {
    const setup = await scenarioSetup();
    const row = await seedGadget(setup, { title: 'drill', code: 'source', stock: '3' });
    const store: StoragePort = { ...setup.store,
      commit: async () => { assert.fail('read committed'); },
      readReceipt: async () => { assert.fail('read checked a receipt'); } };
    const args = { envelope: readEnvelope('Shop.inspect', { gadget: { id: row.id, version: '1' } }),
      identity: identityFor(setup.alice), execute: async (call: AdmittedReadScenarioCall) => {
        assert.deepEqual(call.inputs, { gadget: { id: row.id, version: '1' }, labels: [] });
        assert.deepEqual(call.recordRefs[0]!.row.data, { title: 'drill', code: 'source' });
        assert.equal(call.membership!.is_owner, false);
        assert.equal('context' in call, false);
        assert.equal('inputHash' in call, false);
        return { title: call.recordRefs[0]!.row.data['title'] };
      } };
    const served = await createReadScenarioInvoker({ ...setup, store })(args);
    assert.deepEqual(served, { result: { title: 'drill' }, revision: 1 });
    assert.equal(await setup.store.readRevision(), 1);
  });

  it('rejects shape errors and stale-before-archive references before executing', async () => {
    const setup = await scenarioSetup();
    const row = await seedGadget(setup, { title: 'drill', code: 'source-order' });
    let ran = false;
    const run = (inputs: Record<string, unknown>, store = setup.store) => invokeReadScenario({
      ...setup, store, envelope: readEnvelope('Shop.inspect', inputs),
      identity: identityFor(setup.alice), execute: async () => { ran = true; return null; },
    });
    const closed = await captureStateError(() => run({ gadget: { id: row.id, version: '1' }, extra: true }));
    assert.equal(closed.code, 'validation');
    const archived: StoragePort = { ...setup.store, load: async () => ({ ...row, archivedAt: FIXED_NOW }) };
    assert.equal((await captureStateError(() => run({ gadget: { id: row.id, version: '2' } }, archived))).code, 'conflict');
    assert.equal((await captureStateError(() => run({ gadget: { id: row.id, version: '1' } }, archived))).code, 'validation');
    // Arbitrary IDs disclose neither stale nor archive facts without a grant.
    const denied = (version: string) => invokeReadScenario({ ...setup, store: archived,
      policy: buildPolicyTable([]),
      envelope: readEnvelope('Shop.inspect', { gadget: { id: row.id, version } }),
      identity: identityFor(setup.alice), execute: async () => { ran = true; return null; },
    });
    for (const version of ['1', '2']) {
      assert.equal((await captureStateError(() => denied(version))).code, 'not_found');
    }
    assert.equal(ran, false);
  });

  it('voids a result when the real revision changes during source evaluation', async () => {
    const setup = await scenarioSetup();
    const row = await seedGadget(setup, { title: 'drill', code: 'source-fence' });
    const error = await captureStateError(() => invokeReadScenario({ ...setup,
      envelope: readEnvelope('Shop.inspect', { gadget: { id: row.id, version: '1' } }),
      identity: identityFor(setup.alice), execute: async () => {
        await seedGadget(setup, { title: 'saw', code: 'fence-write' });
        return 'stale';
      },
    }));
    assert.equal(error.code, 'conflict');
  });

  it('voids role/owner changes even when the members operation gate still holds', async () => {
    const setup = await scenarioSetup();
    const row = await seedGadget(setup, { title: 'drill', code: 'source-roles' });
    let changed = false;
    const memberships = { ...setup.memberships, findMembership: async (team: string, user: string) => {
      const member = await setup.memberships.findMembership(team, user);
      return member !== null && changed ? { ...member, is_owner: true } : member;
    } };
    const error = await captureStateError(() => invokeReadScenario({ ...setup, memberships,
      envelope: readEnvelope('Shop.inspect', { gadget: { id: row.id, version: '1' } }),
      identity: identityFor(setup.alice), execute: async () => { changed = true; return 'old-authority'; },
    }));
    assert.equal(error.code, 'forbidden');
  });

  it('rechecks ref grant subjects independently of the caller membership', async () => {
    const setup = await scenarioSetup();
    const row = await seedGadget(setup, { title: 'drill', code: 'source-grants' });
    const reviewer = await seedMember(setup.memberships, { isOwner: true, teamId: setup.alice.team.team_id });
    const policy = buildPolicyTable([{ model: asModel(GADGET), secretFields: [], grants: [{
      by: { roleSubject: { role: 'owner', person: reviewer.user.user_id } }, fields: ['title'],
    }] }]);
    const error = await captureStateError(() => invokeReadScenario({ ...setup, policy,
      envelope: readEnvelope('Shop.inspect', { gadget: { id: row.id, version: '1' } }),
      identity: identityFor(setup.alice), execute: async () => {
        await setup.memberships.removeMembership(reviewer.membership.membership_id);
        return 'revoked-data';
      },
    }));
    assert.equal(error.code, 'not_found');
  });

  it('uses live caller membership instead of forged identity roles', async () => {
    const setup = await scenarioSetup();
    const row = await seedGadget(setup, { title: 'drill', code: 'source-forged' });
    await setup.memberships.removeMembership(setup.alice.membership.membership_id);
    const error = await captureStateError(() => invokeReadScenario({ ...setup,
      envelope: readEnvelope('Shop.inspect', { gadget: { id: row.id, version: '1' } }),
      identity: identityFor(setup.alice), execute: async () => assert.fail('forged identity executed'),
    }));
    assert.equal(error.code, 'forbidden');
  });
});
