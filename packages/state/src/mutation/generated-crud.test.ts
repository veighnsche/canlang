/**
 * T16a generated-CRUD tests (colocated): flat generated envelopes through
 * the canonical pipeline — field semantics (defaults, arrays, server-only,
 * refs, uniques, delete modes, `when`), no-change proofs for rejections,
 * and canonical viewer projection of committed state via the query port.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ArtifactModel,
  ArtifactModelField,
  ArtifactOperation,
  ArtifactOperationInput,
} from '@canlang/contracts';
import type { ModelName, QueryPredicate, StoragePort, StoredRow } from '@canlang/contracts';
import {
  loadArtifactDescriptors,
  type ArtifactDescriptorSlice,
  type LoadDescriptorSetOptions,
} from '../invocation/registry.js';
import { buildModelTableFromCanonical, type ModelTable } from './models.js';
import { generatedCrudExecute } from './crud.js';
import { invoke, readGeneratedCrudAssociation } from '../invocation/invoke.js';
import type { CommittedReceiptOutcome } from '../invocation/invoke.js';
import type { Receipt } from '@canlang/contracts';
import { FenceConflictError } from '../storage/port.js';
import { runMutationWrites } from './pipeline.js';
import { buildContext } from '../invocation/context.js';
import { createTestMemoryStorage, type MemoryStoreProbe } from '../storage/memory.js';
import { buildPolicyTable } from '../policy/grants.js';
import { queryRecords } from '../query/engine.js';
import {
  FIXED_NOW,
  asId,
  asModel,
  asOperation,
  captureStateError,
  createMemoryIdentityStore,
  fieldPaths,
  makeEnvelope,
  makeIdentity,
  seedMember,
  uuidv7,
  type SeededMember,
  type TestMembershipStore,
} from '../../test/invocation/fixtures.js';

const APP = 'acme-app';
const GADGET = 'Shop.Gadget';
const KEEPER = 'Shop.Keeper';
const TOKEN = 'Shop.Token';

function scalarInput(
  name: string,
  kind: 'string' | 'integer' | 'enum',
  required: boolean,
  extra: { values?: string[]; array?: { required: boolean } } = {},
): ArtifactOperationInput {
  const field =
    kind === 'enum'
      ? { kind: 'enum' as const, values: extra.values ?? [] }
      : { kind } as ArtifactOperationInput['field'];
  return {
    name,
    field,
    required,
    ...(extra.array !== undefined ? { array: extra.array } : {}),
  };
}

function refInput(name: string, model: string, requireVersion: boolean): ArtifactOperationInput {
  return { name, field: { kind: 'ref', model, requireVersion }, required: true };
}

function modelField(
  name: string,
  field: ArtifactModelField['field'],
  opts: {
    required?: boolean;
    serverOnly?: boolean;
    array?: { required: boolean };
    default?: ArtifactModelField['default'];
  } = {},
): ArtifactModelField {
  return {
    name,
    field,
    required: opts.required ?? false,
    serverOnly: opts.serverOnly ?? false,
    ...(opts.array !== undefined ? { array: opts.array } : {}),
    ...(opts.default !== undefined ? { default: opts.default } : {}),
  };
}

function crudSlice(): ArtifactDescriptorSlice {
  const gadget: ArtifactModel = {
    name: GADGET,
    fields: [
      modelField('title', { kind: 'string' }, { required: true }),
      modelField('stock', { kind: 'integer' }, { default: { kind: 'literal', value: '0' } }),
      modelField('tags', { kind: 'string' }, { array: { required: false } }),
      modelField('serials', { kind: 'string' }, { required: true, array: { required: true } }),
      modelField('code', { kind: 'string' }, { required: true }),
      modelField('kind', { kind: 'enum', values: ['new', 'used'] }),
      modelField('internal', { kind: 'string' }, { serverOnly: true }),
      modelField('owner', { kind: 'ref', model: KEEPER }),
      modelField('lineage', { kind: 'string' }, { default: { kind: 'parent', path: 'name' } }),
    ],
    deleteMode: 'archive',
    uniqueKeys: ['code'],
  };
  const keeper: ArtifactModel = {
    name: KEEPER,
    fields: [modelField('name', { kind: 'string' }, { required: true })],
    deleteMode: 'remove',
  };
  const token: ArtifactModel = {
    name: TOKEN,
    fields: [modelField('code', { kind: 'string' }, { required: true })],
    deleteMode: 'none',
  };
  const gadgetFields: ArtifactOperationInput[] = [
    scalarInput('title', 'string', true),
    scalarInput('stock', 'integer', false),
    scalarInput('tags', 'string', false, { array: { required: false } }),
    scalarInput('serials', 'string', true, { array: { required: true } }),
    scalarInput('code', 'string', true),
    scalarInput('kind', 'enum', false, { values: ['new', 'used'] }),
    { name: 'owner', field: { kind: 'ref', model: KEEPER, requireVersion: true }, required: false },
    scalarInput('lineage', 'string', false),
  ];
  const operations: ArtifactOperation[] = [
    { name: `${GADGET}.create`, kind: 'create', description: '', inputs: { fields: gadgetFields } },
    {
      name: `${GADGET}.update`,
      kind: 'update',
      description: '',
      inputs: {
        fields: [
          refInput('record', GADGET, true),
          ...gadgetFields.map((field) => ({ ...field, required: false })),
        ],
      },
    },
    {
      name: `${GADGET}.delete`,
      kind: 'delete',
      description: '',
      inputs: { fields: [refInput('record', GADGET, true)] },
    },
    {
      name: `${KEEPER}.create`,
      kind: 'create',
      description: '',
      inputs: { fields: [scalarInput('name', 'string', true)] },
    },
    {
      name: `${KEEPER}.delete`,
      kind: 'delete',
      description: '',
      inputs: { fields: [refInput('record', KEEPER, true)] },
    },
    {
      name: `${TOKEN}.create`,
      kind: 'create',
      description: '',
      inputs: { fields: [scalarInput('code', 'string', true)] },
    },
    {
      name: `${TOKEN}.delete`,
      kind: 'delete',
      description: '',
      inputs: { fields: [refInput('record', TOKEN, true)] },
    },
  ];
  return { artifact_version: 1, operations, models: [gadget, keeper, token] };
}

interface CrudSetup {
  store: StoragePort;
  probe: MemoryStoreProbe;
  memberships: TestMembershipStore;
  alice: SeededMember;
  table: ModelTable;
}

async function setupCrud(when?: LoadDescriptorSetOptions['when']): Promise<CrudSetup> {
  const { store, probe } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const loaded = loadArtifactDescriptors(crudSlice(), {
    by: 'members',
    ...(when !== undefined ? { when } : {}),
  });
  const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
  return { store, probe, memberships, alice, table };
}

function identityFor(member: SeededMember) {
  return makeIdentity({ membership: member.membership, email: member.user.email });
}

let crudSeq = 1000;

function callArgs(setup: CrudSetup, execute: ReturnType<typeof generatedCrudExecute>) {
  return {
    app: APP,
    source: 'test',
    store: setup.store,
    memberships: setup.memberships,
    clock: { nowMs: () => FIXED_NOW },
    execute,
    identity: identityFor(setup.alice),
  };
}

function baseGadgetInputs(code: string): Record<string, unknown> {
  return { title: `gadget-${code}`, code, serials: [`s-${code}`] };
}

async function snapshotRows(store: StoragePort, model: string): Promise<StoredRow[]> {
  const rows = await store.query({ model: asModel(model), authority: 'owner' });
  return [...rows].sort((a, b) => ((a.id as string) < (b.id as string) ? -1 : 1));
}

describe('T16a generated CRUD: creates', () => {
  it('retains generated associations and observes durable receipts without retrying failed observers', async () => {
    const setup = await setupCrud();
    const loaded = loadArtifactDescriptors(crudSlice(), { by: 'members' });
    const secretFields = ['internal'];
    const executeCrud = generatedCrudExecute({ table: setup.table, store: setup.store,
      secretFields: new Map([[asModel(GADGET), secretFields]]) });
    let executions = 0;
    const execute = async (call: Parameters<typeof executeCrud>[0]) => {
      executions += 1;
      return executeCrud(call);
    };
    const operationId = uuidv7(FIXED_NOW, (crudSeq += 1));
    const args = { ...callArgs(setup, execute), registry: loaded.registry,
      envelope: makeEnvelope(`${GADGET}.create`, operationId, baseGadgetInputs('OBS-1')) };
    const observed: Array<Receipt & { outcome: CommittedReceiptOutcome }> = [];
    const failure = new FenceConflictError(0 as Receipt['committedRevision'], null);
    const observeCommittedReceipt = (receipt: Receipt & { outcome: CommittedReceiptOutcome }) => {
      observed.push(receipt);
      throw failure;
    };
    await assert.rejects(invoke({ ...args, observeCommittedReceipt }), error => error === failure);
    assert.equal(executions, 1);
    assert.equal(observed.length, 1);
    const saved = await setup.store.readReceipt(observed[0]!.identity);
    assert.deepEqual(saved, observed[0]);
    assert.equal(saved?.outcome.status, 'committed');
    assert.deepEqual(observed[0]!.outcome.generatedCrud, {
      kind: 'generated-crud/v1', model: GADGET, record: { id: operationId, version: 1 }, secretFields: ['internal'],
    });
    secretFields.push('later');
    const revision = await setup.store.readRevision();
    const rows = await snapshotRows(setup.store, GADGET);
    const histories = await setup.store.historyFor(asModel(GADGET), asId(operationId));
    await assert.rejects(invoke({ ...args, observeCommittedReceipt }), error => error === failure);
    assert.equal(observed.length, 2);
    assert.deepEqual(observed[1], saved);
    assert.equal(executions, 1);
    const replay = await invoke(args);
    assert.equal(replay.status, 'replayed');
    assert.deepEqual(replay.result, observed[0]!.outcome.result);
    assert.deepEqual(JSON.parse(JSON.stringify(saved)), saved);
    assert.ok(saved);
    assert.deepEqual(readGeneratedCrudAssociation(saved.outcome), observed[0]!.outcome.generatedCrud);
    assert.equal(readGeneratedCrudAssociation({ status: 'committed', result: null, recordVersions: [] }), null);
    for (const generatedCrud of [null, { kind: 'generated-crud/v1', model: GADGET, record: { id: operationId, version: '1' } },
      { kind: 'generated-crud/v1', model: GADGET, record: null, secretFields: [42] },
      Object.create({ kind: 'generated-crud/v1', model: GADGET, record: null })]) {
      const malformed = { status: 'committed' as const, result: null, recordVersions: [], generatedCrud };
      assert.throws(() => readGeneratedCrudAssociation(malformed), /Invalid generated CRUD/);
    }
    assert.equal(await setup.store.readRevision(), revision);
    assert.deepEqual(await snapshotRows(setup.store, GADGET), rows);
    assert.deepEqual(await setup.store.historyFor(asModel(GADGET), asId(operationId)), histories);
    assert.deepEqual(await setup.store.readReceipt(observed[0]!.identity), saved);
  });

  it('creates flat rows with id=operationId, defaults, and omit-to-empty arrays', async () => {
    const setup = await setupCrud();
    const loaded = loadArtifactDescriptors(crudSlice(), { by: 'members' });
    const execute = generatedCrudExecute({ table: setup.table, store: setup.store });
    const operationId = uuidv7(FIXED_NOW, (crudSeq += 1));
    const result = await invoke({
      ...callArgs(setup, execute),
      registry: loaded.registry,
      envelope: makeEnvelope(`${GADGET}.create`, operationId, baseGadgetInputs('C-1')),
    });
    assert.equal(result.status, 'committed');
    const row = result.result as StoredRow;
    assert.equal(row.id, operationId);
    assert.equal(row.version, 1);
    assert.deepEqual(row.data, {
      title: 'gadget-C-1',
      code: 'C-1',
      serials: ['s-C-1'],
      stock: '0',
      tags: [],
    });
    // Parent-defaulted optional field reads as missing on parentless creates.
    assert.ok(!Object.hasOwn(row.data, 'lineage'));
  });

  it('rejects missing required, unknown members, and required arrays', async () => {
    const setup = await setupCrud();
    const loaded = loadArtifactDescriptors(crudSlice(), { by: 'members' });
    const execute = generatedCrudExecute({ table: setup.table, store: setup.store });
    const args = { ...callArgs(setup, execute), registry: loaded.registry };
    const missing = await captureStateError(
      invoke({
        ...args,
        envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
          code: 'M-1',
          serials: ['s'],
        }),
      }),
    );
    assert.equal(missing.code, 'validation');

    const unknown = await captureStateError(
      invoke({
        ...args,
        envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
          ...baseGadgetInputs('M-2'),
          bogus: 1,
        }),
      }),
    );
    assert.equal(unknown.code, 'validation');

    // Server-owned fields never appear in generated inputs (L1 skips
    // them), so supplying one rejects as an unknown member at admission —
    // the pipeline's server-only enforcement below is the second layer.
    const serverOnly = await captureStateError(
      invoke({
        ...args,
        envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
          ...baseGadgetInputs('M-3'),
          internal: 'smuggled',
        }),
      }),
    );
    assert.equal(serverOnly.code, 'validation');
    assert.deepEqual(fieldPaths(serverOnly), ['/internal']);

    const requiredArray = await captureStateError(
      invoke({
        ...args,
        envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
          title: 't',
          code: 'M-4',
        }),
      }),
    );
    assert.equal(requiredArray.code, 'validation');

    const nonArray = await captureStateError(
      invoke({
        ...args,
        envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
          ...baseGadgetInputs('M-5'),
          tags: 'not-an-array',
        }),
      }),
    );
    assert.equal(nonArray.code, 'validation');
    assert.deepEqual(
      (nonArray.fields ?? []).map((field) => field.code),
      ['invalid_array'],
    );
    assert.deepEqual(await snapshotRows(setup.store, GADGET), []);
  });

  it('validates ref fields: missing, stale, and archived targets fail', async () => {
    const setup = await setupCrud();
    const loaded = loadArtifactDescriptors(crudSlice(), { by: 'members' });
    const execute = generatedCrudExecute({ table: setup.table, store: setup.store });
    const args = { ...callArgs(setup, execute), registry: loaded.registry };

    const missing = await captureStateError(
      invoke({
        ...args,
        envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
          ...baseGadgetInputs('R-0'),
          owner: { id: 'keeper-ghost', version: '1' },
        }),
      }),
    );
    assert.equal(missing.code, 'not_found');

    const keeper = await invoke({
      ...args,
      envelope: makeEnvelope(`${KEEPER}.create`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
        name: 'rita',
      }),
    });
    const keeperId = (keeper.result as StoredRow).id;

    const stale = await captureStateError(
      invoke({
        ...args,
        envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
          ...baseGadgetInputs('R-1'),
          owner: { id: keeperId, version: '9' },
        }),
      }),
    );
    assert.equal(stale.code, 'conflict');

    const ok = await invoke({
      ...args,
      envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
        ...baseGadgetInputs('R-2'),
        owner: { id: keeperId, version: '1' },
      }),
    });
    assert.equal(ok.status, 'committed');
    assert.deepEqual((ok.result as StoredRow).data['owner'], { id: keeperId, version: '1' });
  });
});

describe('T16a generated CRUD: canonical model table', () => {
  it('preserves server-only enforcement at the model layer', async () => {
    const setup = await setupCrud();
    const context = buildContext({
      identity: identityFor(setup.alice),
      operation: asOperation(`${GADGET}.create`),
      operationId: uuidv7(FIXED_NOW, (crudSeq += 1)),
      source: 'test',
      now: FIXED_NOW,
      app: APP,
    });
    const error = await captureStateError(
      runMutationWrites({
        table: setup.table,
        writes: [
          {
            op: 'create',
            model: asModel(GADGET),
            id: asId('direct-1'),
            data: { ...baseGadgetInputs('S-1'), internal: 'smuggled' },
          },
        ],
        context,
        store: setup.store,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.match(error.message, /server-only/);
  });
});

describe('T16a generated CRUD: updates, deletes, whens', () => {
  it('updates partially (omission unchanged), versions fence, archives delete', async () => {
    const setup = await setupCrud();
    const loaded = loadArtifactDescriptors(crudSlice(), { by: 'members' });
    const execute = generatedCrudExecute({ table: setup.table, store: setup.store });
    const outcomes: CommittedReceiptOutcome[] = [];
    const args = { ...callArgs(setup, execute), registry: loaded.registry,
      observeCommittedReceipt: (receipt: Receipt & { outcome: CommittedReceiptOutcome }) => outcomes.push(receipt.outcome) };
    const created = await invoke({
      ...args,
      envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
        ...baseGadgetInputs('U-1'),
        stock: '7',
      }),
    });
    const id = (created.result as StoredRow).id;

    const updated = await invoke({
      ...args,
      envelope: makeEnvelope(`${GADGET}.update`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
        record: { id, version: '1' },
        title: 'renamed',
      }),
    });
    const row = updated.result as StoredRow;
    assert.equal(row.version, 2);
    assert.equal(row.data['title'], 'renamed');
    assert.equal(row.data['stock'], '7');
    assert.deepEqual(row.data['tags'], []);

    const removed = await invoke({
      ...args,
      envelope: makeEnvelope(`${GADGET}.delete`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
        record: { id, version: '2' },
      }),
    });
    assert.equal((removed.result as StoredRow).version, 3);
    assert.equal((removed.result as StoredRow).archivedAt, FIXED_NOW);
    assert.deepEqual(outcomes.map(outcome => outcome.generatedCrud), [1, 2, 3].map(version => ({
      kind: 'generated-crud/v1', model: GADGET, record: { id, version },
    })));

    const twice = await captureStateError(
      invoke({
        ...args,
        envelope: makeEnvelope(`${GADGET}.delete`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
          record: { id, version: '3' },
        }),
      }),
    );
    assert.equal(twice.code, 'validation');
    assert.match(twice.message, /Archived records cannot be used here/);
  });

  it('honors deleteMode none/remove and the disposal scan', async () => {
    const setup = await setupCrud();
    const loaded = loadArtifactDescriptors(crudSlice(), { by: 'members' });
    const execute = generatedCrudExecute({ table: setup.table, store: setup.store });
    const args = { ...callArgs(setup, execute), registry: loaded.registry };

    const token = await invoke({
      ...args,
      envelope: makeEnvelope(`${TOKEN}.create`, uuidv7(FIXED_NOW, (crudSeq += 1)), { code: 'T-1' }),
    });
    const tokenId = (token.result as StoredRow).id;
    const denied = await captureStateError(
      invoke({
        ...args,
        envelope: makeEnvelope(`${TOKEN}.delete`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
          record: { id: tokenId, version: '1' },
        }),
      }),
    );
    assert.equal(denied.code, 'validation');
    assert.match(denied.message, /not allowed/);

    const keeper = await invoke({
      ...args,
      envelope: makeEnvelope(`${KEEPER}.create`, uuidv7(FIXED_NOW, (crudSeq += 1)), { name: 'k' }),
    });
    const keeperId = (keeper.result as StoredRow).id;
    await invoke({
      ...args,
      envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
        ...baseGadgetInputs('D-1'),
        owner: { id: keeperId, version: '1' },
      }),
    });
    const blocked = await captureStateError(
      invoke({
        ...args,
        envelope: makeEnvelope(`${KEEPER}.delete`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
          record: { id: keeperId, version: '1' },
        }),
      }),
    );
    assert.equal(blocked.code, 'rule_failed');
    assert.match(blocked.message, /incoming references/);

    const loner = await invoke({
      ...args,
      envelope: makeEnvelope(`${KEEPER}.create`, uuidv7(FIXED_NOW, (crudSeq += 1)), { name: 'loner' }),
    });
    const lonerId = (loner.result as StoredRow).id;
    let removedOutcome: CommittedReceiptOutcome | undefined;
    const removed = await invoke({
      ...args,
      observeCommittedReceipt: receipt => { removedOutcome = receipt.outcome; },
      envelope: makeEnvelope(`${KEEPER}.delete`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
        record: { id: lonerId, version: '1' },
      }),
    });
    assert.equal(removed.result, null);
    assert.deepEqual(removedOutcome?.generatedCrud, { kind: 'generated-crud/v1', model: KEEPER, record: null });
    assert.equal(await setup.store.load(asModel(KEEPER), lonerId), null);
  });

  it('enforces engine-local when preconditions with rejected receipts', async () => {
    const when: QueryPredicate = { op: 'eq', field: 'stock', value: '0' };
    const setup = await setupCrud((op) =>
      op.name === `${GADGET}.update` ? when : undefined,
    );
    const loaded = loadArtifactDescriptors(crudSlice(), {
      by: 'members',
      when: (op) => ((op.name as string) === `${GADGET}.update` ? when : undefined),
    });
    const execute = generatedCrudExecute({ table: setup.table, store: setup.store });
    const args = { ...callArgs(setup, execute), registry: loaded.registry };
    const createOpId = uuidv7(FIXED_NOW, (crudSeq += 1));
    const created = await invoke({
      ...args,
      envelope: makeEnvelope(`${GADGET}.create`, createOpId, {
        ...baseGadgetInputs('W-1'),
        stock: '5',
      }),
    });
    const id = (created.result as StoredRow).id;

    const before = await snapshotRows(setup.store, GADGET);
    const revisionBefore = await setup.store.readRevision();
    const failed = await captureStateError(
      invoke({
        ...args,
        envelope: makeEnvelope(`${GADGET}.update`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
          record: { id, version: '1' },
          title: 'still-five',
        }),
      }),
    );
    assert.equal(failed.code, 'rule_failed');
    // Execute-time rejection: a rejected receipt commits (revision +1) while
    // domain rows, history, and outbox stay unchanged.
    assert.equal(await setup.store.readRevision(), (revisionBefore as number) + 1);
    assert.deepEqual(await snapshotRows(setup.store, GADGET), before);
    const createdRow = before[0];
    assert.ok(createdRow);
    assert.deepEqual(setup.probe.historyFor(asModel(GADGET), id), [
      {
        model: GADGET,
        recordId: id,
        version: 1,
        operation: `${GADGET}.create`,
        operationId: createOpId,
        actor: setup.alice.user.user_id,
        at: FIXED_NOW,
        change: 'create',
        before: null,
        after: createdRow.data,
      },
    ]);
    assert.deepEqual(setup.probe.outboxAll(), []);

    const allowed = await invoke({
      ...args,
      envelope: makeEnvelope(`${GADGET}.update`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
        record: { id, version: '1' },
        stock: '0',
      }),
    });
    assert.equal((allowed.result as StoredRow).data['stock'], '0');
  });
});

describe('T16a generated CRUD: canonical projection', () => {
  it('reads observe committed state through the viewer query port', async () => {
    const setup = await setupCrud();
    const loaded = loadArtifactDescriptors(crudSlice(), { by: 'members' });
    const execute = generatedCrudExecute({ table: setup.table, store: setup.store });
    const args = { ...callArgs(setup, execute), registry: loaded.registry };
    const created = await invoke({
      ...args,
      envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
        ...baseGadgetInputs('P-1'),
        kind: 'new',
      }),
    });
    const id = (created.result as StoredRow).id;

    const policy = buildPolicyTable([
      {
        model: asModel(GADGET),
        secretFields: [],
        grants: [{ by: 'members', fields: ['title', 'code', 'kind'] }],
      },
    ]);
    const viewer = await queryRecords({
      policy,
      model: asModel(GADGET) as ModelName,
      authority: 'viewer',
      context: { actorUserId: setup.alice.user.user_id, teamId: setup.alice.team.team_id },
      memberships: setup.memberships,
      store: setup.store,
    });
    assert.equal(viewer.records.length, 1);
    assert.equal(viewer.revision, 1);
    const [projected] = viewer.records;
    assert.ok(projected);
    assert.equal(projected.id, id);
    assert.equal(projected.version, 1);
    // Projection, not a double: only granted leaves are present.
    assert.deepEqual(projected.data, { title: 'gadget-P-1', code: 'P-1', kind: 'new' });

    const denied = await queryRecords({
      policy,
      model: asModel(GADGET) as ModelName,
      authority: 'viewer',
      context: { actorUserId: 'user-ghost', teamId: setup.alice.team.team_id },
      memberships: setup.memberships,
      store: setup.store,
    });
    assert.deepEqual(denied.records, []);
  });
});
