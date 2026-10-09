/**
 * T16a descriptor-join tests (colocated): the L1 artifact slice loads into
 * the canonical admission path — loader acceptance/rejection, then generated
 * calls through `invoke`/`admit` with canonical denied/stale/rejected/
 * replayed behavior and L3-layer context negatives. Mutation field semantics
 * and projection live in `mutation/generated-crud.test.ts`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ArtifactModel,
  ArtifactModelField,
  ArtifactOperation,
  ArtifactOperationInput,
} from '@canlang/contracts';
import type { ExecutionDescriptorSet } from '@canlang/contracts';
import {
  IncompatibleArtifactError,
  artifactToDescriptorSet,
  isGeneratedOperationDef,
  loadArtifactDescriptors,
  loadExecutionDescriptorSet,
  type ArtifactDescriptorSlice,
  type GeneratedOperationDef,
} from './registry.js';
import { buildModelTableFromCanonical } from '../mutation/models.js';
import { generatedCrudExecute } from '../mutation/crud.js';
import { invoke, type ExecuteHandler, type ExecutionEffects } from './invoke.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import type { StoragePort } from '@canlang/contracts';
import {
  FIXED_NOW,
  asModel,
  asOperation,
  asOperationId,
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

type ScalarKind = 'string' | 'integer' | 'decimal' | 'money' | 'datetime' | 'boolean' | 'file';

function scalarInput(name: string, kind: ScalarKind, required: boolean): ArtifactOperationInput {
  return { name, field: { kind } as ArtifactOperationInput['field'], required };
}

function refInput(
  name: string,
  model: string,
  requireVersion: boolean,
  required = true,
): ArtifactOperationInput {
  return { name, field: { kind: 'ref', model, requireVersion }, required };
}

function crudCreateOp(model: string, fields: ArtifactOperationInput[]): ArtifactOperation {
  return { name: `${model}.create`, kind: 'create', description: '', inputs: { fields } };
}

function crudUpdateOp(model: string, fields: ArtifactOperationInput[]): ArtifactOperation {
  return {
    name: `${model}.update`,
    kind: 'update',
    description: '',
    inputs: { fields: [refInput('record', model, true), ...fields] },
  };
}

function crudDeleteOp(model: string): ArtifactOperation {
  return {
    name: `${model}.delete`,
    kind: 'delete',
    description: '',
    inputs: { fields: [refInput('record', model, true)] },
  };
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

function gadgetModel(): ArtifactModel {
  return {
    name: GADGET,
    fields: [
      modelField('title', { kind: 'string' }, { required: true }),
      modelField('stock', { kind: 'integer' }, { default: { kind: 'literal', value: '0' } }),
    ],
    deleteMode: 'archive',
  };
}

function keeperModel(): ArtifactModel {
  return {
    name: KEEPER,
    fields: [modelField('name', { kind: 'string' }, { required: true })],
    deleteMode: 'archive',
  };
}

function gadgetOps(): ArtifactOperation[] {
  return [
    crudCreateOp(GADGET, [
      scalarInput('title', 'string', true),
      scalarInput('stock', 'integer', false),
    ]),
    crudUpdateOp(GADGET, [
      scalarInput('title', 'string', false),
      scalarInput('stock', 'integer', false),
    ]),
    crudDeleteOp(GADGET),
  ];
}

function fullSlice(): ArtifactDescriptorSlice {
  return { artifact_version: 1, operations: gadgetOps(), models: [gadgetModel(), keeperModel()] };
}

function asSlice(value: unknown): ArtifactDescriptorSlice {
  return value as ArtifactDescriptorSlice;
}

function asSet(value: unknown): ExecutionDescriptorSet {
  return value as ExecutionDescriptorSet;
}

async function captureArtifactError(run: () => unknown): Promise<IncompatibleArtifactError> {
  try {
    await run();
  } catch (error) {
    assert.ok(
      error instanceof IncompatibleArtifactError,
      `expected IncompatibleArtifactError, got ${error?.constructor?.name ?? typeof error}`,
    );
    return error;
  }
  throw new assert.AssertionError({ message: 'expected incompatible-artifact rejection' });
}

describe('T16a loader: artifact slice to intake', () => {
  it('retains owning enum model tags through canonical intake and mutation tables', async () => {
    const field = (): ArtifactModelField => ({ name: 'priority',
      field: { kind: 'enum', values: ['low', 'high'] }, required: false, serverOnly: false });
    for (const array of [false, true]) for (const nullable of [false, true]) {
      for (const requiredArray of array ? [false, true] : [false]) {
        const slice = fullSlice();
        const enumeration = field();
        Object.assign(enumeration, { nullable, ...(array ? { array: { required: requiredArray } } : {}) });
        slice.models![0]!.fields.push(enumeration);
        const type = `enum(low,high)${array ? '[]' : ''}${nullable ? '?' : ''}`;
        const converted = artifactToDescriptorSet(slice);
        const loaded = loadExecutionDescriptorSet(converted.set, { by: 'members' });
        const canonical = loaded.models[0]!.fields['priority']!;
        assert.equal(canonical.valueType, type);
        assert.equal(canonical.nullable, nullable);
        const table = buildModelTableFromCanonical(loaded.models, { nullableFields: converted.nullableFields });
        assert.equal(table.get(asModel(GADGET))!.fields['priority']!.valueType, type);
        assert.deepEqual(canonical.array, array ? { required: requiredArray } : undefined);
      }
    }
    for (const patch of [
      { valueType: 'text' }, { valueType: 'enum(high,low)' }, { valueType: 'enum(low)' },
      { valueType: 'enum(low,high)?' }, { valueType: 'enum(low,high)[]' },
      { field: { kind: 'enum', values: [] } }, { field: { kind: 'enum', values: ['low', 'low'] } },
      { field: { kind: 'enum', values: ['low', 1] } }, { nullable: 'yes' }, { array: { required: 'yes' } },
    ]) {
      const slice = fullSlice();
      slice.models![0]!.fields.push(Object.assign(field(), patch));
      const error = await captureArtifactError(() => loadArtifactDescriptors(slice, { by: 'members' }));
      assert.equal(error.reason, 'malformed_descriptor');
    }
  });

  it('loads a T15a-shaped slice: registry ops, folded models, derived refs', () => {
    const slice = fullSlice();
    const converted = artifactToDescriptorSet(slice);
    assert.equal(converted.set.contractVersion, 1);
    assert.equal(converted.set.operations.length, 3);
    assert.equal(converted.set.models.length, 2);
    const gadget = converted.set.models.find((model) => (model.name as string) === GADGET);
    assert.ok(gadget);
    assert.deepEqual(Object.keys(gadget.fields).sort(), ['stock', 'title']);
    assert.equal(gadget.fields['title']?.required, true);
    assert.deepEqual(gadget.fields['stock']?.default, { kind: 'literal', value: '0' });
    // No ref tags on these fields, so no derived refs.
    assert.deepEqual(converted.refs.get(asModel(GADGET)), []);

    const loaded = loadArtifactDescriptors(slice, { by: 'members' });
    assert.equal(loaded.registry.size, 3);
    for (const op of gadgetOps()) {
      const def = loaded.registry.get(op.name);
      assert.ok(def && isGeneratedOperationDef(def), `generated def for ${op.name}`);
      assert.equal((def as GeneratedOperationDef).by, 'members');
      assert.equal((def as GeneratedOperationDef).descriptor.kind, op.kind);
    }
  });

  it('derives engine-local refs from singular ref tags; skips array-of-ref', () => {
    const slice = fullSlice();
    const models = slice.models as ArtifactModel[];
    const gadget = models[0];
    assert.ok(gadget);
    gadget.fields.push(
      modelField('keeper', { kind: 'ref', model: KEEPER }),
      modelField('watchers', { kind: 'ref', model: KEEPER }, { array: { required: false } }),
    );
    const converted = artifactToDescriptorSet(slice);
    assert.deepEqual(converted.refs.get(asModel(GADGET)), [
      { field: 'keeper', model: KEEPER },
    ]);
  });

  it('treats absent operations/models as empty, never as an error', () => {
    const loaded = loadArtifactDescriptors({ artifact_version: 1 }, { by: 'members' });
    assert.equal(loaded.registry.size, 0);
    assert.deepEqual(loaded.models, []);
  });

  it('rejects artifact_version mismatch precisely, never silently', async () => {
    const error = await captureArtifactError(() =>
      artifactToDescriptorSet(asSlice({ ...fullSlice(), artifact_version: 2 })),
    );
    assert.equal(error.reason, 'version_mismatch');
    assert.match(error.message, /artifact_version 2/);
    assert.match(error.message, /required artifact contract 1/);
  });

  it('rejects contractVersion mismatch on intake-direct loads', async () => {
    const converted = artifactToDescriptorSet(fullSlice());
    const error = await captureArtifactError(() =>
      loadExecutionDescriptorSet(
        asSet({ ...converted.set, contractVersion: 2 }),
        { by: 'members' },
      ),
    );
    assert.equal(error.reason, 'version_mismatch');
    assert.match(error.message, /contractVersion 2/);
  });

  it('rejects unknown operation kinds for the whole set', async () => {
    const slice = fullSlice();
    (slice.operations as ArtifactOperation[]).push({
      name: 'Shop.frob',
      kind: 'frob',
      description: '',
      inputs: { fields: [] },
    } as unknown as ArtifactOperation);
    const error = await captureArtifactError(() => loadArtifactDescriptors(slice, { by: 'members' }));
    assert.equal(error.reason, 'unknown_operation_kind');
    assert.match(error.message, /"frob"/);
    assert.match(error.message, /Shop\.frob/);
  });

  it('rejects unknown input kinds for the whole set', async () => {
    const slice = fullSlice();
    const ops = slice.operations as ArtifactOperation[];
    const create = ops[0];
    assert.ok(create);
    create.inputs.fields.push({
      name: 'mystery',
      field: { kind: 'teleport' },
      required: false,
    } as unknown as ArtifactOperationInput);
    const error = await captureArtifactError(() => loadArtifactDescriptors(slice, { by: 'members' }));
    assert.equal(error.reason, 'unknown_input_kind');
    assert.match(error.message, /"teleport"/);
    assert.match(error.message, /mystery/);
  });

  it('rejects unknown default kinds', async () => {
    const slice = fullSlice();
    const ops = slice.operations as ArtifactOperation[];
    const create = ops[0];
    assert.ok(create);
    const stock = create.inputs.fields[1];
    assert.ok(stock);
    stock.default = { kind: 'horoscope' } as unknown as NonNullable<
      ArtifactOperationInput['default']
    >;
    const error = await captureArtifactError(() => loadArtifactDescriptors(slice, { by: 'members' }));
    assert.equal(error.reason, 'unknown_default_kind');
    assert.match(error.message, /"horoscope"/);
  });

  it('rejects dangling ref models and undescribed create models', async () => {
    const dangling = fullSlice();
    (dangling.operations as ArtifactOperation[]).push({
      name: 'Shop.haunt',
      kind: 'scenario',
      description: '',
      inputs: { fields: [refInput('ghost', 'Shop.Ghost', true)] },
    });
    const refError = await captureArtifactError(() =>
      loadArtifactDescriptors(dangling, { by: 'members' }),
    );
    assert.equal(refError.reason, 'dangling_reference');
    assert.match(refError.message, /Shop\.Ghost/);

    const noModel = fullSlice();
    (noModel.operations as ArtifactOperation[]).push(crudCreateOp('Shop.Missing', []));
    const createError = await captureArtifactError(() =>
      loadArtifactDescriptors(noModel, { by: 'members' }),
    );
    assert.equal(createError.reason, 'dangling_reference');
    assert.match(createError.message, /Shop\.Missing/);
  });

  it('rejects unexecutable update/delete shapes and composite uniques', async () => {
    const noRef = fullSlice();
    (noRef.operations as ArtifactOperation[]).push({
      name: 'Shop.Gadget.update',
      kind: 'update',
      description: '',
      inputs: { fields: [scalarInput('title', 'string', false)] },
    });
    // Duplicate name fires first; drop it to reach the shape check.
    (noRef.operations as ArtifactOperation[]).splice(1, 1);
    const shapeError = await captureArtifactError(() =>
      loadArtifactDescriptors(noRef, { by: 'members' }),
    );
    assert.equal(shapeError.reason, 'malformed_descriptor');
    assert.match(shapeError.message, /versioned "record" ref/);

    const composite = fullSlice();
    const models = composite.models as ArtifactModel[];
    const gadget = models[0];
    assert.ok(gadget);
    gadget.uniqueKeys = ['title,stock'];
    const uniqueError = await captureArtifactError(() =>
      loadArtifactDescriptors(composite, { by: 'members' }),
    );
    assert.equal(uniqueError.reason, 'unsupported_composite_unique');
    assert.match(uniqueError.message, /T04b/);
  });

  it('rejects duplicates and bad enum intake on direct set loads', async () => {
    const converted = artifactToDescriptorSet(fullSlice());
    const dupe = await captureArtifactError(() =>
      loadExecutionDescriptorSet(
        asSet({ ...converted.set, operations: [...converted.set.operations, converted.set.operations[0]] }),
        { by: 'members' },
      ),
    );
    assert.equal(dupe.reason, 'duplicate_name');

    const badEnum = artifactToDescriptorSet(fullSlice()).set;
    const ops = badEnum.operations.map((op) => ({ ...op, inputs: [...op.inputs] }));
    const target = ops[0];
    assert.ok(target);
    target.inputs.push({
      name: 'kind',
      kind: 'string',
      required: false,
      enumValues: ['a'],
    } as unknown as (typeof target.inputs)[number]);
    const enumError = await captureArtifactError(() =>
      loadExecutionDescriptorSet(asSet({ ...badEnum, operations: ops }), { by: 'members' }),
    );
    assert.equal(enumError.reason, 'malformed_descriptor');
    assert.match(enumError.message, /enumValues is present exactly for enum/);
  });

  it('maps engine-local by/when policy per operation', () => {
    const loaded = loadArtifactDescriptors(fullSlice(), {
      by: (op) => ((op.name as string).endsWith('.delete') ? 'owner' : 'members'),
      when: (op) =>
        (op.name as string).endsWith('.update')
          ? { op: 'eq', field: 'title', value: 'x' }
          : undefined,
    });
    const create = loaded.registry.get(`${GADGET}.create`);
    const update = loaded.registry.get(`${GADGET}.update`);
    const remove = loaded.registry.get(`${GADGET}.delete`);
    assert.ok(create && isGeneratedOperationDef(create));
    assert.ok(update && isGeneratedOperationDef(update));
    assert.ok(remove && isGeneratedOperationDef(remove));
    assert.equal(create.by, 'members');
    assert.equal(update.by, 'members');
    assert.deepEqual(update.when, { op: 'eq', field: 'title', value: 'x' });
    assert.equal(remove.by, 'owner');
    assert.equal(remove.when, undefined);
  });
});

/* -- Generated calls through canonical invoke/admit. -- */

interface JoinSetup {
  store: StoragePort;
  memberships: TestMembershipStore;
  alice: SeededMember;
  registry: ReturnType<typeof loadArtifactDescriptors>['registry'];
}

async function setupJoin(
  by: 'members' | 'owner' | 'authenticated' | 'public' = 'members',
): Promise<JoinSetup> {
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const loaded = loadArtifactDescriptors(fullSlice(), { by });
  return { store, memberships, alice, registry: loaded.registry };
}

function identityFor(member: SeededMember) {
  return makeIdentity({ membership: member.membership, email: member.user.email });
}

let opSeq = 100;

function nextOperationId(): string {
  opSeq += 1;
  return uuidv7(FIXED_NOW, opSeq);
}

describe('T16a join: generated calls through canonical admission', () => {
  it('admits a positive generated create to commit', async () => {
    const { store, memberships, alice, registry } = await setupJoin();
    const loaded = loadArtifactDescriptors(fullSlice(), { by: 'members' });
    const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
    const execute = generatedCrudExecute({ table, store });
    const operationId = nextOperationId();
    const result = await invoke({
      registry,
      envelope: makeEnvelope(`${GADGET}.create`, operationId, { title: 'drill', stock: '3' }),
      identity: identityFor(alice),
      app: APP,
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
    });
    assert.equal(result.status, 'committed');
    assert.equal(result.operation_id, operationId);
    const row = result.result as { id: string; version: number; data: Record<string, unknown> };
    assert.equal(row.id, operationId);
    assert.equal(row.version, 1);
    assert.deepEqual(row.data, { title: 'drill', stock: '3' });
  });

  it('denies unauthorized callers without persisting a receipt', async () => {
    const { store, memberships, alice, registry } = await setupJoin();
    const loaded = loadArtifactDescriptors(fullSlice(), { by: 'members' });
    const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
    const execute = generatedCrudExecute({ table, store });
    const stranger = await seedMember(memberships, { isOwner: false });
    // Stranger is a member of ANOTHER team; call in alice's team scope.
    const identity = makeIdentity({
      membership: stranger.membership,
      teamId: alice.team.team_id,
      email: stranger.user.email,
    });
    const operationId = nextOperationId();
    const before = await store.readRevision();
    const error = await captureStateError(
      invoke({
        registry,
        envelope: makeEnvelope(`${GADGET}.create`, operationId, { title: 'drill' }),
        identity,
        app: APP,
        source: 'test',
        store,
        memberships,
        clock: { nowMs: () => FIXED_NOW },
        execute,
      }),
    );
    assert.equal(error.code, 'forbidden');
    assert.equal(await store.readRevision(), before);
    const receipt = await store.readReceipt({
      app: APP,
      owner: alice.team.team_id,
      principal: stranger.user.user_id,
      operation: asOperation(`${GADGET}.create`),
      operationId: asOperationId(operationId),
    });
    assert.equal(receipt, null);
  });

  it('ignores forged identity contents: the live membership store wins both ways', async () => {
    const { store, memberships, alice, registry } = await setupJoin();
    const loaded = loadArtifactDescriptors(fullSlice(), { by: 'members' });
    const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
    const execute = generatedCrudExecute({ table, store });
    const base = {
      registry,
      app: APP,
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
    };
    // Forged owner claim with no store membership: denied.
    const forged = await captureStateError(
      invoke({
        ...base,
        envelope: makeEnvelope(`${GADGET}.create`, nextOperationId(), { title: 'x' }),
        identity: makeIdentity({ userId: 'user-ghost', teamId: alice.team.team_id, isOwner: true }),
      }),
    );
    assert.equal(forged.code, 'forbidden');
    // Null claimed membership with a live store membership: allowed.
    const ok = await invoke({
      ...base,
      envelope: makeEnvelope(`${GADGET}.create`, nextOperationId(), { title: 'real' }),
      identity: makeIdentity({
        membership: null,
        userId: alice.user.user_id,
        teamId: alice.team.team_id,
      }),
    });
    assert.equal(ok.status, 'committed');
  });

  it('rejects malformed identity, stale identity, and trusted-without-source', async () => {
    const { store, memberships, alice, registry } = await setupJoin();
    const loaded = loadArtifactDescriptors(fullSlice(), { by: 'public' });
    const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
    const execute = generatedCrudExecute({ table, store });
    const base = {
      registry,
      app: APP,
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
      identity: identityFor(alice),
    };
    const malformed = await captureStateError(
      invoke({
        ...base,
        envelope: makeEnvelope(`${GADGET}.create`, 'not-a-uuid', { title: 'x' }),
      }),
    );
    assert.equal(malformed.code, 'validation');

    const staleIdentity = await captureStateError(
      invoke({
        ...base,
        envelope: makeEnvelope(
          `${GADGET}.create`,
          uuidv7(FIXED_NOW - 25 * 60 * 60 * 1000, 7),
          { title: 'x' },
        ),
      }),
    );
    assert.equal(staleIdentity.code, 'validation');
    assert.match(staleIdentity.message, /older than 24 hours/);

    const trusted = await captureStateError(
      invoke({
        ...base,
        kind: 'trusted',
        envelope: makeEnvelope(`${GADGET}.create`, nextOperationId(), { title: 'x' }),
      }),
    );
    assert.equal(trusted.code, 'validation');
    assert.match(trusted.message, /verified trusted source/);

    const unknown = await captureStateError(
      invoke({
        ...base,
        envelope: makeEnvelope('Shop.Nope.create', nextOperationId(), {}),
      }),
    );
    assert.equal(unknown.code, 'validation');
    assert.match(unknown.message, /Unknown operation/);
  });

  it('conflicts on stale versions and validates archived targets', async () => {
    const { store, memberships, alice, registry } = await setupJoin();
    const loaded = loadArtifactDescriptors(fullSlice(), { by: 'members' });
    const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
    const execute = generatedCrudExecute({ table, store });
    const base = {
      registry,
      app: APP,
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
      identity: identityFor(alice),
    };
    const created = await invoke({
      ...base,
      envelope: makeEnvelope(`${GADGET}.create`, nextOperationId(), { title: 'v1' }),
    });
    const id = (created.result as { id: string }).id;
    const bumped = await invoke({
      ...base,
      envelope: makeEnvelope(`${GADGET}.update`, nextOperationId(), {
        record: { id, version: '1' },
        title: 'v2',
      }),
    });
    assert.equal((bumped.result as { version: number }).version, 2);

    const before = await store.readRevision();
    const stale = await captureStateError(
      invoke({
        ...base,
        envelope: makeEnvelope(`${GADGET}.update`, nextOperationId(), {
          record: { id, version: '1' },
          title: 'stale',
        }),
      }),
    );
    assert.equal(stale.code, 'conflict');
    assert.equal(await store.readRevision(), before);

    await invoke({
      ...base,
      envelope: makeEnvelope(`${GADGET}.delete`, nextOperationId(), {
        record: { id, version: '2' },
      }),
    });
    const archived = await captureStateError(
      invoke({
        ...base,
        envelope: makeEnvelope(`${GADGET}.update`, nextOperationId(), {
          record: { id, version: '3' },
          title: 'late',
        }),
      }),
    );
    assert.equal(archived.code, 'validation');
    assert.match(archived.message, /Archived records/);
  });

  it('unique violations conflict at commit without receipts and change nothing', async () => {
    const slice = fullSlice();
    const models = slice.models as ArtifactModel[];
    const gadget = models[0];
    assert.ok(gadget);
    gadget.fields.push(modelField('code', { kind: 'string' }, { required: true }));
    gadget.uniqueKeys = ['code'];
    const ops = slice.operations as ArtifactOperation[];
    const create = ops[0];
    const update = ops[1];
    assert.ok(create && update);
    create.inputs.fields.push(scalarInput('code', 'string', true));
    update.inputs.fields.push(scalarInput('code', 'string', false));

    const { store } = createTestMemoryStorage();
    const memberships = createMemoryIdentityStore();
    const alice = await seedMember(memberships, { isOwner: false });
    const loaded = loadArtifactDescriptors(slice, { by: 'members' });
    const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
    const execute = generatedCrudExecute({ table, store });
    const base = {
      registry: loaded.registry,
      app: APP,
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
      identity: identityFor(alice),
    };
    const firstId = nextOperationId();
    await invoke({
      ...base,
      envelope: makeEnvelope(`${GADGET}.create`, firstId, { title: 'a', code: 'K-1' }),
    });

    // Store-level unique conflicts surface at COMMIT time, so the frozen
    // invoke path maps them to `conflict` with no rejected receipt (only
    // execute-time StateErrors receipt). Retries recompute the same code.
    const dupeId = nextOperationId();
    const dupeEnvelope = makeEnvelope(`${GADGET}.create`, dupeId, { title: 'b', code: 'K-1' });
    const revisionBefore = await store.readRevision();
    const dupe = await captureStateError(invoke({ ...base, envelope: dupeEnvelope }));
    assert.equal(dupe.code, 'conflict');
    assert.equal(
      await store.readReceipt({
        app: APP,
        owner: alice.team.team_id,
        principal: alice.user.user_id,
        operation: asOperation(`${GADGET}.create`),
        operationId: asOperationId(dupeId),
      }),
      null,
    );
    assert.equal(await store.readRevision(), revisionBefore);
    const rows = await store.query({ model: asModel(GADGET), authority: 'owner' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, firstId);
    const retry = await captureStateError(invoke({ ...base, envelope: dupeEnvelope }));
    assert.equal(retry.code, 'conflict');
  });

  it('persists execute-time rejections and replays both outcomes exactly', async () => {
    const { store } = createTestMemoryStorage();
    const memberships = createMemoryIdentityStore();
    const alice = await seedMember(memberships, { isOwner: false });
    // `when` fails in the executor (rule_failed), which is the execute-time
    // rejection path that persists a rejected receipt. (Creates never carry
    // `when`, mirroring interim CRUD, so it hangs on update.)
    const when = { op: 'eq', field: 'title', value: 'nope' } as const;
    const loaded = loadArtifactDescriptors(fullSlice(), {
      by: 'members',
      when: (op) => ((op.name as string).endsWith('.update') ? { ...when } : undefined),
    });
    const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
    const execute = generatedCrudExecute({ table, store });
    const base = {
      registry: loaded.registry,
      app: APP,
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      execute,
      identity: identityFor(alice),
    };
    const committedId = nextOperationId();
    const committedEnvelope = makeEnvelope(`${GADGET}.create`, committedId, { title: 'a' });
    const committed = await invoke({ ...base, envelope: committedEnvelope });
    assert.equal(committed.status, 'committed');
    const id = (committed.result as { id: string }).id;

    const rejectedId = nextOperationId();
    const rejectedEnvelope = makeEnvelope(`${GADGET}.update`, rejectedId, {
      record: { id, version: '1' },
      title: 'b',
    });
    const rejected = await captureStateError(invoke({ ...base, envelope: rejectedEnvelope }));
    assert.equal(rejected.code, 'rule_failed');
    const receipt = await store.readReceipt({
      app: APP,
      owner: alice.team.team_id,
      principal: alice.user.user_id,
      operation: asOperation(`${GADGET}.update`),
      operationId: asOperationId(rejectedId),
    });
    assert.ok(receipt);
    assert.equal(receipt.outcome.status, 'rejected');
    assert.deepEqual(receipt.outcome, {
      status: 'rejected',
      code: 'rule_failed',
      message: rejected.message,
    });
    // Domain state unchanged by the rejection: the row keeps version 1.
    const rows = await store.query({ model: asModel(GADGET), authority: 'owner' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.version, 1);

    const replayedRejection = await captureStateError(
      invoke({ ...base, envelope: rejectedEnvelope }),
    );
    assert.equal(replayedRejection.code, 'rule_failed');
    assert.equal(replayedRejection.message, rejected.message);

    // Committed outcomes replay identically without new writes.
    const revisionBefore = await store.readRevision();
    const replayed = await invoke({ ...base, envelope: committedEnvelope });
    assert.equal(replayed.status, 'replayed');
    assert.equal(replayed.operation_id, committedId);
    assert.deepEqual(replayed.result, committed.result);
    assert.equal(await store.readRevision(), revisionBefore);
  });

  it('routes generated reads away from invoke; scenarios admit through the seam', async () => {
    const slice = fullSlice();
    (slice.operations as ArtifactOperation[]).push(
      { name: `${GADGET}.read`, kind: 'read', description: '', inputs: { fields: [] } },
      {
        name: 'Shop.restock',
        kind: 'scenario',
        description: '',
        inputs: {
          fields: [
            scalarInput('sku', 'string', true),
            {
              name: 'tags',
              field: { kind: 'string' },
              required: false,
              array: { required: false },
            },
          ],
        },
      },
    );
    const { store } = createTestMemoryStorage();
    const memberships = createMemoryIdentityStore();
    const alice = await seedMember(memberships, { isOwner: false });
    const loaded = loadArtifactDescriptors(slice, { by: 'members' });
    const table = buildModelTableFromCanonical(loaded.models, { refs: loaded.refs });
    const execute = generatedCrudExecute({ table, store });
    const base = {
      registry: loaded.registry,
      app: APP,
      source: 'test',
      store,
      memberships,
      clock: { nowMs: () => FIXED_NOW },
      identity: identityFor(alice),
    };
    const readError = await captureStateError(
      invoke({ ...base, execute, envelope: makeEnvelope(`${GADGET}.read`, nextOperationId(), {}) }),
    );
    assert.equal(readError.code, 'validation');
    assert.match(readError.message, /query port/);

    // Unknown members still reject on scenarios (closed shape).
    const stub: ExecuteHandler = async (call): Promise<ExecutionEffects> => ({
      writes: [],
      history: [],
      outbox: [],
      schedules: [],
      uniqueClaims: [],
      uniqueReleases: [],
      resolvedDefaults: {},
      result: { seen: call.inputs },
    });
    const shapeError = await captureStateError(
      invoke({
        ...base,
        execute: stub,
        envelope: makeEnvelope('Shop.restock', nextOperationId(), { sku: 's', bogus: 1 }),
      }),
    );
    assert.equal(shapeError.code, 'validation');
    assert.deepEqual(fieldPaths(shapeError), ['/bogus']);

    // Omitted ordinary-array scenario inputs arrive as [] (T16 honors it).
    const restocked = await invoke({
      ...base,
      execute: stub,
      envelope: makeEnvelope('Shop.restock', nextOperationId(), { sku: 's' }),
    });
    assert.equal(restocked.status, 'committed');
    assert.deepEqual(restocked.result, { seen: { sku: 's', tags: [] } });
  });
});
