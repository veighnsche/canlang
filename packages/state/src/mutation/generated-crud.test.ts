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
import { buildModelTable, buildModelTableFromCanonical, type ModelTable } from './models.js';
import { generatedCrudExecute, generatedCrudExecuteOwnerSession,
  type GeneratedCrudOwnerFrame, type GeneratedCrudOwnerFrameFactory } from './crud.js';
import { bindOwnerModelPolicies } from './model-policies.js';
import { invoke, readGeneratedCrudAssociation } from '../invocation/invoke.js';
import type { CommittedReceiptOutcome } from '../invocation/invoke.js';
import type { Receipt } from '@canlang/contracts';
import { FenceConflictError } from '../storage/port.js';
import { assertOwnerMutationHookContext, runMutationWrites, type OwnerMutationSession } from './pipeline.js';
import { StateError } from '../errors.js';
import { decodeValue, encodeValue } from '@canlang/values';
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
import { field, modelDef } from '../../test/mutation/fixtures.js';

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

  it('validates owning enum cases without transport metadata and rolls back invalid writes', async () => {
    const setup = await setupCrud();
    const slice = crudSlice();
    Object.assign(slice.models![0]!.fields.find(field => field.name === 'kind')!, {
      field: { kind: 'enum', values: ['low', 'high'] }, nullable: true,
    });
    for (const operation of slice.operations!) {
      const field = operation.inputs.fields.find(field => field.name === 'kind');
      if (field !== undefined) Object.assign(field, { field: { kind: 'enum', values: ['low', 'high'] }, nullable: true });
    }
    const loaded = loadArtifactDescriptors(slice, { by: 'members' });
    const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs, nullableFields: loaded.nullableFields });
    const execute = generatedCrudExecute({ table, store: setup.store, encodeField: (type, value) => {
      try { return encodeValue(type, decodeValue(type, value)); }
      catch (error) { throw new StateError('validation', error instanceof Error ? error.message : String(error)); }
    } });
    const args = { ...callArgs(setup, execute), registry: loaded.registry };
    const invalidId = uuidv7(FIXED_NOW, (crudSeq += 1));
    const failure = await captureStateError(invoke({ ...args,
      envelope: makeEnvelope(`${GADGET}.create`, invalidId, { ...baseGadgetInputs('E-1'), kind: 'urgent' }),
    }));
    assert.equal(failure.code, 'validation');
    assert.deepEqual(await snapshotRows(setup.store, GADGET), []);
    assert.deepEqual(await setup.store.historyFor(asModel(GADGET), asId(invalidId)), []);

    const acceptedId = uuidv7(FIXED_NOW, (crudSeq += 1));
    const accepted = await invoke({ ...args,
      envelope: makeEnvelope(`${GADGET}.create`, acceptedId, { ...baseGadgetInputs('E-1'), kind: 'high' }),
    });
    assert.equal(accepted.status, 'committed');
    const saved = await snapshotRows(setup.store, GADGET);
    assert.equal(saved[0]!.version, 1);
    assert.equal(saved[0]!.data['kind'], 'high');
    assert.equal(saved[0]!.data['stock'], '0');
    const rejectedUpdate = await captureStateError(invoke({ ...args,
      envelope: makeEnvelope(`${GADGET}.update`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
        record: { id: acceptedId, version: '1' }, kind: 'urgent',
      }),
    }));
    assert.equal(rejectedUpdate.code, 'validation');
    assert.deepEqual(await snapshotRows(setup.store, GADGET), saved);
    assert.equal((await setup.store.historyFor(asModel(GADGET), asId(acceptedId))).length, 1);
    for (const [code, input] of [['E-2', { kind: null }], ['E-3', {}]] as const) {
      const result = await invoke({ ...args,
        envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, (crudSeq += 1)), {
          ...baseGadgetInputs(code), ...input,
        }),
      });
      assert.equal(result.status, 'committed');
      assert.equal((result.result as StoredRow).data['kind'], null);
    }
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

describe('generated CRUD: checked owner policies and actual session frames', () => {
  const bounds = { maxWork: 1000, maxRows: 100 };
  const identity = { module: 'shop.mjs', ownerPackage: 'Shop', model: asModel(GADGET) };

  it('enforces final invariants and entry locks across create/update/archive with one receipt per call', async () => {
    const setup = await setupCrud();
    const loaded = loadArtifactDescriptors(crudSlice(), { by: 'members' });
    let active = false, opened = 0, closed = 0;
    const policies = bindOwnerModelPolicies({ table: setup.table, descriptors: [{
      abi: 'state.owner-model-policies@1', ...identity,
      rules: [{ kind: 'lock', id: 'stock-lock', fields: ['stock'] },
        { kind: 'invariant', id: 'nonnegative', dependencies: [] }], hooks: [],
    }], bindings: [
      { ...identity, id: 'stock-lock', kind: 'lock', evaluate: (_context, row) => {
        assert.equal(active, true); return row.data.kind === 'used';
      } },
      { ...identity, id: 'nonnegative', kind: 'invariant', evaluate: ({ context }, row) => {
        assert.equal(active, true); assert.ok(Object.isFrozen(context));
        return typeof row.data.stock === 'string' && /^\d+$/.test(row.data.stock);
      } },
    ] });
    const execute = generatedCrudExecuteOwnerSession({ table: setup.table, store: setup.store,
      ownerPolicies: policies, ownerBounds: bounds,
      createOwnerFrame: async ({ call, session, context }) => {
        assert.equal(context, session.views.context);
        assert.deepEqual(context, call.context);
        assert.ok(Object.isFrozen(context) && Object.isFrozen(context.actor));
        opened += 1; active = true;
        return { close: async () => { active = false; closed += 1; } };
      } });
    const args = { ...callArgs(setup, execute), registry: loaded.registry };
    const failed = await captureStateError(invoke({ ...args,
      envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, ++crudSeq),
        { ...baseGadgetInputs('OWNER-BAD'), stock: '-1' }) }));
    assert.equal(failed.code, 'rule_failed');
    assert.deepEqual(await snapshotRows(setup.store, GADGET), []);
    assert.equal(active, false);
    const id = uuidv7(FIXED_NOW, ++crudSeq);
    const created = await invoke({ ...args,
      envelope: makeEnvelope(`${GADGET}.create`, id, baseGadgetInputs('OWNER-OK')) });
    assert.equal((created.result as StoredRow).data.stock, '0');
    const changed = await invoke({ ...args, envelope: makeEnvelope(`${GADGET}.update`, uuidv7(FIXED_NOW, ++crudSeq),
      { record: { id, version: '1' }, stock: '2', kind: 'used' }) });
    assert.equal((changed.result as StoredRow).version, 2);
    const locked = await captureStateError(invoke({ ...args,
      envelope: makeEnvelope(`${GADGET}.update`, uuidv7(FIXED_NOW, ++crudSeq),
        { record: { id, version: '2' }, stock: '3' }) }));
    assert.equal(locked.code, 'rule_failed');
    assert.equal((await setup.store.load(asModel(GADGET), asId(id)))!.data.stock, '2');
    const archived = await invoke({ ...args,
      envelope: makeEnvelope(`${GADGET}.delete`, uuidv7(FIXED_NOW, ++crudSeq), { record: { id, version: '2' } }) });
    assert.equal((archived.result as StoredRow).archivedAt, FIXED_NOW);
    assert.equal((archived.result as StoredRow).version, 3);
    assert.equal(opened, 5); assert.equal(closed, opened); assert.equal(active, false);
  });

  it('returns the finalized target and association when a checked hook adds an earlier sorted secondary write', async () => {
    const setup = await setupCrud();
    const audit = asModel('Shop.Audit');
    const table = buildModelTable([...setup.table.values(),
      modelDef(audit, { fields: { name: field({ required: true }) }, deleteMode: 'remove' })]);
    const loaded = loadArtifactDescriptors(crudSlice(), { by: 'members' });
    let active = false, closed = 0;
    const policies = bindOwnerModelPolicies({ table, descriptors: [{
      abi: 'state.owner-model-policies@1', ...identity, rules: [],
      hooks: [{ id: 'created', op: 'create', operation: asOperation(`${GADGET}.create`) }],
    }], bindings: [{ ...identity, id: 'created', kind: 'hook', run: (candidate, context) => {
      assert.equal(active, true); assertOwnerMutationHookContext(context);
      assert.equal(context.input.title, 'gadget-HOOK');
      context.stage({ op: 'create', model: audit, id: asId('audit-1'), data: { name: 'created' } });
      return { ...candidate, title: 'hook-final', internal: 'server-secret' };
    } }] });
    const secretFields = ['internal'];
    const execute = generatedCrudExecute({ table, store: setup.store,
      ownerPolicies: policies, ownerBounds: bounds,
      secretFields: new Map([[asModel(GADGET), secretFields]]),
      createOwnerFrame: async () => { active = true; return { close: () => { active = false; closed += 1; } }; } });
    const saved: Array<Receipt & { outcome: CommittedReceiptOutcome }> = [];
    const id = uuidv7(FIXED_NOW, ++crudSeq);
    const args = { ...callArgs(setup, execute), registry: loaded.registry,
      envelope: makeEnvelope(`${GADGET}.create`, id, baseGadgetInputs('HOOK')),
      observeCommittedReceipt: (receipt: Receipt & { outcome: CommittedReceiptOutcome }) => {
        assert.equal(active, false); saved.push(receipt);
      } };
    const result = await invoke(args);
    assert.equal((result.result as StoredRow).id, id);
    assert.equal((result.result as StoredRow).data.title, 'hook-final');
    assert.deepEqual(saved[0]!.outcome.generatedCrud, { kind: 'generated-crud/v1', model: GADGET,
      record: { id, version: 1 }, secretFields: ['internal'] });
    assert.deepEqual(saved[0]!.outcome.recordVersions.map(ref => [ref.model, ref.id, ref.version]),
      [[audit, 'audit-1', 1], [GADGET, id, 1]]);
    assert.equal((await setup.store.load(audit, asId('audit-1')))!.data.name, 'created');
    assert.equal(await setup.store.readRevision(), 1);
    secretFields.push('later');
    const replay = await invoke(args);
    assert.equal(replay.status, 'replayed'); assert.equal(closed, 1);
    assert.deepEqual(replay.result, result.result);
    assert.deepEqual(saved[1]!.outcome.generatedCrud?.secretFields, ['internal']);
  });

  it('closes the real frame after candidate when, budgets, and finalizer failure; cleanup failure prevents commit', async () => {
    for (const failure of ['when', 'budget', 'cleanup'] as const) {
      const when: QueryPredicate = { op: 'eq', field: 'stock', value: '99' };
      const setup = await setupCrud(failure === 'when' ? when : undefined);
      const loaded = loadArtifactDescriptors(crudSlice(), { by: 'members',
        ...(failure === 'when' ? { when } : {}) });
      const initial = await invoke({ ...callArgs(setup, generatedCrudExecute({ table: setup.table, store: setup.store })),
        registry: loaded.registry, envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, ++crudSeq),
          baseGadgetInputs(`FRAME-${failure}`)) });
      const before = initial.result as StoredRow;
      const cleanupError = new Error('native frame cleanup failed');
      let closed = 0;
      const execute = generatedCrudExecute({ table: setup.table, store: setup.store,
        ownerBounds: failure === 'budget' ? { maxWork: 1, maxRows: 1 } : bounds,
        createOwnerFrame: async () => ({ close: () => { closed += 1; if (failure === 'cleanup') throw cleanupError; } }) });
      await assert.rejects(invoke({ ...callArgs(setup, execute), registry: loaded.registry,
        envelope: makeEnvelope(`${GADGET}.update`, uuidv7(FIXED_NOW, ++crudSeq),
          { record: { id: before.id, version: '1' }, title: 'changed' }) }),
      error => failure === 'cleanup' ? error === cleanupError : error instanceof StateError);
      assert.equal(closed, 1);
      assert.deepEqual(await setup.store.load(asModel(GADGET), before.id), before);
    }
  });

  it('requires checked policies and explicit bounds, and refuses substitute sessions or cleanup accessors', async () => {
    const setup = await setupCrud();
    assert.throws(() => generatedCrudExecute({ table: setup.table, store: setup.store,
      createOwnerFrame: async () => ({ close: () => {} }) }), /explicit mutation bounds/);
    const loaded = loadArtifactDescriptors(crudSlice(), { by: 'members' });
    let opened = 0;
    const forged = generatedCrudExecute({ table: setup.table, store: setup.store, ownerBounds: bounds,
      ownerPolicies: { beforeStage: async () => {}, finalize: async () => {}, hooks: new Map() },
      createOwnerFrame: async () => { opened += 1; return { close: () => {} }; } });
    const unverified = await captureStateError(invoke({ ...callArgs(setup, forged), registry: loaded.registry,
      envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, ++crudSeq), baseGadgetInputs('FORGED')) }));
    assert.equal(unverified.code, 'validation'); assert.equal(opened, 0);
    let getterReads = 0, closed = 0;
    for (const accessor of [false, true]) {
      const factory: GeneratedCrudOwnerFrameFactory = async () => accessor
        ? Object.defineProperty({}, 'close', { get: () => { getterReads += 1; return () => {}; } }) as never
        : { close: () => { closed += 1; }, session: {} } as never;
      const execute = generatedCrudExecute({ table: setup.table, store: setup.store,
        ownerBounds: bounds, createOwnerFrame: factory });
      const invalid = await captureStateError(invoke({ ...callArgs(setup, execute), registry: loaded.registry,
        envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, ++crudSeq), baseGadgetInputs('FRAME-INVALID')) }));
      assert.equal(invalid.code, 'validation');
    }
    assert.equal(getterReads, 0); assert.equal(closed, 1);
    assert.deepEqual(await snapshotRows(setup.store, GADGET), []);
  });

  it('uses the same owner session for hard delete and rejects mixed target identities before opening a frame', async () => {
    const setup = await setupCrud();
    const loaded = loadArtifactDescriptors(crudSlice(), { by: 'members' });
    let opened = 0, closed = 0;
    const sessions: OwnerMutationSession[] = [];
    const execute = generatedCrudExecute({ table: setup.table, store: setup.store, ownerBounds: bounds,
      createOwnerFrame: async ({ session }) => { opened += 1; sessions.push(session);
        return { close: () => { closed += 1; } }; } });
    const args = { ...callArgs(setup, execute), registry: loaded.registry };
    const id = uuidv7(FIXED_NOW, ++crudSeq);
    await invoke({ ...args, envelope: makeEnvelope(`${KEEPER}.create`, id, { name: 'keeper' }) });
    const removed = await invoke({ ...args,
      envelope: makeEnvelope(`${KEEPER}.delete`, uuidv7(FIXED_NOW, ++crudSeq), { record: { id, version: '1' } }) });
    assert.equal(removed.result, null);
    assert.equal(await setup.store.load(asModel(KEEPER), asId(id)), null);
    assert.equal(opened, 2); assert.equal(closed, 2);
    assert.notEqual(sessions[0], sessions[1]);
    await assert.rejects(sessions[1]!.read(asModel(KEEPER), asId(id)), /finalized/);
    await assert.rejects(invoke({ ...args,
      envelope: makeEnvelope(`${KEEPER}.create`, uuidv7(FIXED_NOW, ++crudSeq), { name: 'mixed' }),
      execute: async call => execute({ ...call, context: { ...call.context, operation: asOperation(`${GADGET}.create`) } }),
    }), /operation identities disagree/);
    assert.equal(opened, 2);
  });

  it('invokes the captured cleanup function with its original verified frame receiver on success and failure', async () => {
    for (const reject of [false, true]) {
      const setup = await setupCrud();
      const loaded = loadArtifactDescriptors(crudSlice(), { by: 'members' });
      let frame: GeneratedCrudOwnerFrame | undefined, closed = 0;
      const policies = bindOwnerModelPolicies({ table: setup.table, descriptors: [{
        abi: 'state.owner-model-policies@1', ...identity,
        rules: [{ kind: 'invariant', id: 'receiver-check', dependencies: [] }], hooks: [],
      }], bindings: [{ ...identity, id: 'receiver-check', kind: 'invariant', evaluate: () => {
        assert.ok(frame !== undefined);
        Object.defineProperty(frame, 'close', { value: () => { throw new Error('replacement cleanup must not run'); } });
        return !reject;
      } }] });
      const execute = generatedCrudExecuteOwnerSession({ table: setup.table, store: setup.store,
        ownerBounds: bounds, ownerPolicies: policies,
        createOwnerFrame: async () => {
          frame = { close(this: GeneratedCrudOwnerFrame) { assert.equal(this, frame); closed += 1; } };
          return frame;
        } });
      const invoking = invoke({ ...callArgs(setup, execute), registry: loaded.registry,
        envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, ++crudSeq), baseGadgetInputs('RECEIVER')) });
      if (reject) await assert.rejects(invoking, error => error instanceof StateError && error.code === 'rule_failed');
      else assert.equal((await invoking).status, 'committed');
      assert.equal(closed, 1);
      assert.equal((await snapshotRows(setup.store, GADGET)).length, reject ? 0 : 1);
    }
  });

  it('dedicated owner support refuses missing or invalid session inputs before any domain mutation', async () => {
    const setup = await setupCrud();
    const base = { table: setup.table, store: setup.store };
    const createOwnerFrame: GeneratedCrudOwnerFrameFactory = async () => ({ close: () => {} });
    for (const options of [
      {}, { ownerBounds: bounds }, { createOwnerFrame },
      { ownerBounds: undefined, createOwnerFrame }, { ownerBounds: null, createOwnerFrame },
      { ownerBounds: bounds, createOwnerFrame: undefined }, { ownerBounds: bounds, createOwnerFrame: null },
      { ownerBounds: bounds, createOwnerFrame: false }, { ownerBounds: { maxRows: 1 }, createOwnerFrame },
      { ownerBounds: Object.create(bounds), createOwnerFrame },
      { ownerBounds: bounds, createOwnerFrame, ownerPolicies: undefined },
      { ownerBounds: bounds, createOwnerFrame, ownerPolicies: { beforeStage: async () => {}, finalize: async () => {}, hooks: new Map() } },
    ]) {
      assert.throws(() => generatedCrudExecuteOwnerSession({ ...base, ...options } as never),
        error => error instanceof StateError && error.code === 'validation');
    }
    let getterReads = 0;
    const getterInputs = { ...base, ownerBounds: bounds, createOwnerFrame };
    Object.defineProperty(getterInputs, 'createOwnerFrame', { get: () => { getterReads += 1; return createOwnerFrame; } });
    assert.throws(() => generatedCrudExecuteOwnerSession(getterInputs), /own explicit/);
    const getterBounds = { ...bounds };
    Object.defineProperty(getterBounds, 'maxWork', { get: () => { getterReads += 1; return 1000; } });
    assert.throws(() => generatedCrudExecuteOwnerSession({ ...base, ownerBounds: getterBounds, createOwnerFrame }), /own numeric/);
    assert.equal(getterReads, 0);
    const loaded = loadArtifactDescriptors(crudSlice(), { by: 'members' });
    let frames = 0;
    for (const invalidBounds of [{ maxRows: 0, maxWork: 100 }, { maxRows: 1, maxWork: Number.NaN }]) {
      const execute = generatedCrudExecuteOwnerSession({ ...base, ownerBounds: invalidBounds,
        createOwnerFrame: async () => { frames += 1; return { close: () => {} }; } });
      const failure = await captureStateError(invoke({ ...callArgs(setup, execute), registry: loaded.registry,
        envelope: makeEnvelope(`${GADGET}.create`, uuidv7(FIXED_NOW, ++crudSeq), baseGadgetInputs('BAD-BOUNDS')) }));
      assert.equal(failure.code, 'validation');
    }
    assert.equal(frames, 0);
    assert.deepEqual(await snapshotRows(setup.store, GADGET), []);
  });
});
