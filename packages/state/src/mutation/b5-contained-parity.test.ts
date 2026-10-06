/**
 * B5 canonical-containment proofs (colocated): declared ownership
 * (`ArtifactModel.parent`/`scope`, carrying adopted T28-A) flows from the
 * artifact loader through an engine-local `containment` channel into the
 * model table, and the pipeline enforces it verdict-for-verdict on every
 * path (CRUD invoke, scenario-shaped staging, hook-staged writes share the
 * one create block, so they agree by construction).
 *
 * Proves, over canonical dotted names (`expenses.Expense in
 * employee.Employee`) plus the REAL `t18-shop` artifact:
 * - loader: per-model containment entries (child, team-implicit root,
 *   app root); dangling parent / parent+scope / bad scope reject the
 *   WHOLE set;
 * - table: containment cycles (self, 2-, 3-model) reject at build;
 *   declared multi-level DAGs build;
 * - pipeline: child creates require the DECLARED parent model
 *   (missing/wrong-model fail `validation`); declared roots reject a
 *   smuggled parent; undeclared (hand-built interim) tables keep the
 *   exact legacy accept-any posture;
 * - storage: same-batch parent+child co-commit atomically and a failing
 *   child rolls the parent back (the T28-A same-store atomicity proof);
 *   reverse `parent` collections resolve imported linkage; archiving a
 *   parent leaves children live (no subtree cascade — pinned current
 *   behavior, explicit remainder) while new children under an archived
 *   parent stay rejected.
 *
 * Cited, not duplicated: imported-parent same-owner fence enrollment
 * (`t32b-fence.test.ts`), parent immutability on update/remove
 * (pipeline rejects; pinned once here at the enforcement seam),
 * `parent.*` predicate paths (no T04b vocabulary — out of scope).
 * Lifetime: `StoredRow` carries none and L1 owes lifetime descriptors
 * (`migration/stage.ts`), so no lifetime rule is enforceable here —
 * named owed contract, not silent coverage.
 * Team: rows carry no team; the fence owner stays team ?? app and
 * containment adds no cross-owner boundary (same-owner enrollment).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CompileArtifact } from '../../../contracts/src/artifact.js';
import type {
  RecordId,
  StoragePort,
  StoredRow,
} from '../../../contracts/src/state.js';
import {
  IncompatibleArtifactError,
  artifactToDescriptorSet,
  loadArtifactDescriptors,
  type ArtifactDescriptorSlice,
  type LoadedArtifactDescriptors,
} from '../invocation/registry.js';
import {
  buildModelTable,
  buildModelTableFromCanonical,
  type InterimContainment,
  type ModelTable,
} from './models.js';
import { generatedCrudExecute } from './crud.js';
import { runMutationWrites, type MutationWritesResult } from './pipeline.js';
import { invoke } from '../invocation/invoke.js';
import { createTestMemoryStorage } from '../storage/memory.js';
import {
  FIXED_NOW,
  asModel,
  captureStateError,
  createMemoryIdentityStore,
  makeBatch,
  makeEnvelope,
  makeIdentity,
  seedMember,
  uuidv7,
  type SeededMember,
  type TestMembershipStore,
} from '../../test/invocation/fixtures.js';
import {
  field,
  hook,
  modelDef,
  pipelineContext,
  seedStoredRow,
} from '../../test/mutation/fixtures.js';
import { T18_SHOP_ARTIFACT_JSON } from './t18-shop.artifact.js';

const APP = 'acme-app';
const APP_OP = 'Acme.scenarioBatch';
const TEAM = asModel('Shop.Team');
const MEMBER = asModel('Shop.Member');
const MEMBER_CREATE = 'Shop.Member.create';
const TEAM_CREATE = 'Shop.Team.create';

const EMPLOYEE = asModel('employee.Employee');
const EXPENSE = asModel('expenses.Expense');
const CHECKLIST = asModel('onboard.Checklist');
const STEP = asModel('onboard.Step');
const CONFIG = asModel('hr.Config');

function shopSlice(): ArtifactDescriptorSlice {
  const artifact = JSON.parse(T18_SHOP_ARTIFACT_JSON) as CompileArtifact;
  const { operations, models } = artifact;
  assert.equal(artifact.artifact_version, 1);
  assert.ok(Array.isArray(operations) && operations.length > 0);
  assert.ok(Array.isArray(models) && models.length > 0);
  return { artifact_version: artifact.artifact_version, operations, models };
}

function containedDef(
  model: string,
  parent: string | null,
  opts: { scope?: 'app' } = {},
): ReturnType<typeof modelDef> & { containment: InterimContainment } {
  const base = modelDef(model, { fields: { title: field() }, deleteMode: 'archive' });
  return {
    ...base,
    containment: {
      ...(parent !== null ? { parent: asModel(parent) } : {}),
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    },
  };
}

/** Hand-built imported world: Expense in Employee, Step in Checklist in Employee, app Config. */
function importedTable(): ModelTable {
  return buildModelTable([
    { ...modelDef('employee.Employee', { fields: { name: field() } }), containment: {} },
    containedDef('expenses.Expense', 'employee.Employee'),
    containedDef('onboard.Checklist', 'employee.Employee'),
    containedDef('onboard.Step', 'onboard.Checklist'),
    containedDef('hr.Config', null, { scope: 'app' }),
  ]);
}

function ctx() {
  return pipelineContext({ operation: APP_OP as unknown as string });
}

async function commitOutput(
  store: StoragePort,
  output: MutationWritesResult,
): Promise<void> {
  const revision = await store.readRevision();
  await store.commit(
    makeBatch(revision as number, {
      writes: [...output.writes],
      history: [...output.history],
      uniqueClaims: [...output.uniqueClaims],
      uniqueReleases: [...output.uniqueReleases],
    }),
  );
}

let b5Seq = 31000;

function nextOperationId(): string {
  b5Seq += 1;
  return uuidv7(FIXED_NOW, b5Seq);
}

interface B5World {
  store: StoragePort;
  memberships: TestMembershipStore;
  alice: SeededMember;
  loaded: LoadedArtifactDescriptors;
  table: ModelTable;
}

async function setupShopWorld(): Promise<B5World> {
  const { store } = createTestMemoryStorage();
  const memberships = createMemoryIdentityStore();
  const alice = await seedMember(memberships, { isOwner: false });
  const loaded = loadArtifactDescriptors(shopSlice(), { by: 'members' });
  const table = buildModelTableFromCanonical(loaded.models, {
    refs: loaded.refs,
    serverInits: loaded.serverInits,
    nullableFields: loaded.nullableFields,
    containment: loaded.containment,
  });
  return { store, memberships, alice, loaded, table };
}

async function crudInvoke(
  world: B5World,
  operation: string,
  operationId: string,
  inputs: Record<string, unknown>,
) {
  return invoke({
    registry: world.loaded.registry,
    envelope: makeEnvelope(operation, operationId, inputs),
    identity: makeIdentity({
      membership: world.alice.membership,
      email: world.alice.user.email,
    }),
    app: APP,
    source: 'test',
    store: world.store,
    memberships: world.memberships,
    clock: { nowMs: () => FIXED_NOW },
    execute: generatedCrudExecute({ table: world.table, store: world.store }),
  });
}

function minimalTeamInputs(): Record<string, unknown> {
  return { name: 'team-one', owner: { id: 'u-boss' }, flags: ['f1'] };
}

describe('B5 loader: declared ownership channel', () => {
  it('exposes per-model containment from the real shop artifact', () => {
    const loaded = loadArtifactDescriptors(shopSlice(), { by: 'members' });
    assert.equal(loaded.containment.size, 2);
    assert.deepEqual(loaded.containment.get(MEMBER), { parent: TEAM });
    // Shop.Team declares neither member: team scope is implicit, and the
    // empty entry marks a DECLARED root (smuggled parents reject).
    assert.deepEqual(loaded.containment.get(TEAM), {});
  });

  it('rejects a dangling declared parent for the whole set', () => {
    const slice = shopSlice();
    const models = (slice.models as unknown[]).map((model) =>
      (model as { name?: unknown }).name === 'Shop.Member'
        ? { ...(model as Record<string, unknown>), parent: 'Shop.Missing' }
        : model,
    );
    const tampered = { ...slice, models } as ArtifactDescriptorSlice;
    assert.throws(
      () => artifactToDescriptorSet(tampered),
      (error: unknown) =>
        error instanceof IncompatibleArtifactError &&
        /has no descriptor in this set/.test(error.message),
    );
  });

  it('rejects parent+scope together for the whole set', () => {
    const slice = shopSlice();
    const models = (slice.models as unknown[]).map((model) =>
      (model as { name?: unknown }).name === 'Shop.Member'
        ? { ...(model as Record<string, unknown>), scope: 'app' }
        : model,
    );
    const tampered = { ...slice, models } as ArtifactDescriptorSlice;
    assert.throws(
      () => artifactToDescriptorSet(tampered),
      (error: unknown) =>
        error instanceof IncompatibleArtifactError && /mutually exclusive/.test(error.message),
    );
  });

  it('rejects a non-app scope for the whole set', () => {
    const slice = shopSlice();
    const models = (slice.models as unknown[]).map((model) =>
      (model as { name?: unknown }).name === 'Shop.Team'
        ? { ...(model as Record<string, unknown>), scope: 'team' }
        : model,
    );
    const tampered = { ...slice, models } as ArtifactDescriptorSlice;
    assert.throws(
      () => artifactToDescriptorSet(tampered),
      (error: unknown) =>
        error instanceof IncompatibleArtifactError && /scope is "app" when present/.test(error.message),
    );
  });
});

describe('B5 table: cycle + shape validation', () => {
  it('builds the declared imported DAG (multi-level, dotted names)', () => {
    const table = importedTable();
    assert.equal(table.get(EXPENSE)?.containment?.parent, EMPLOYEE);
    assert.equal(table.get(STEP)?.containment?.parent, CHECKLIST);
    assert.equal(table.get(CONFIG)?.containment?.scope, 'app');
  });

  it('rejects a self-parent cycle at build', () => {
    assert.throws(
      () =>
        buildModelTable([
          {
            ...modelDef('Acme.Loop', { fields: { title: field() } }),
            containment: { parent: asModel('Acme.Loop') },
          },
        ]),
      /containment cycle Acme\.Loop -> Acme\.Loop/,
    );
  });

  it('rejects a two-model cross-package cycle at build', () => {
    assert.throws(
      () =>
        buildModelTable([
          {
            ...modelDef('alpha.A', { fields: { title: field() } }),
            containment: { parent: asModel('beta.B') },
          },
          {
            ...modelDef('beta.B', { fields: { title: field() } }),
            containment: { parent: asModel('alpha.A') },
          },
        ]),
      /containment cycle alpha\.A -> beta\.B -> alpha\.A/,
    );
  });

  it('rejects parent+scope together at build', () => {
    assert.throws(
      () =>
        buildModelTable([
          {
            ...modelDef('Acme.Both', { fields: { title: field() } }),
            containment: { parent: asModel('Acme.Other'), scope: 'app' },
          },
          modelDef('Acme.Other', { fields: { title: field() } }),
        ]),
      /mutually exclusive/,
    );
  });
});

describe('B5 pipeline: declared-parent enforcement', () => {
  it('creates a child under its canonical imported parent', async () => {
    const { store } = createTestMemoryStorage();
    const table = importedTable();
    await seedStoredRow(store, EMPLOYEE, { id: 'e-1', data: { name: 'ada' } });
    const output = await runMutationWrites({
      table,
      writes: [
        {
          op: 'create',
          model: EXPENSE,
          id: 'x-1' as RecordId,
          parent: { model: EMPLOYEE, id: 'e-1' as RecordId },
          data: { title: 'lunch' },
        },
      ],
      context: ctx(),
      store,
    });
    await commitOutput(store, output);
    const row = (await store.load(EXPENSE, 'x-1' as RecordId)) as StoredRow;
    assert.deepEqual(row.parent, { model: EMPLOYEE, id: 'e-1' });
  });

  it('rejects a child create with no parent', async () => {
    const { store } = createTestMemoryStorage();
    const table = importedTable();
    const error = await captureStateError(
      runMutationWrites({
        table,
        writes: [
          { op: 'create', model: EXPENSE, id: 'x-1' as RecordId, data: { title: 'lunch' } },
        ],
        context: ctx(),
        store,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.equal(error.message, 'Missing required parent for model "expenses.Expense".');
  });

  it('rejects a child create under the wrong parent model', async () => {
    const { store } = createTestMemoryStorage();
    const table = importedTable();
    await seedStoredRow(store, CHECKLIST, {
      id: 'c-1',
      parent: { model: EMPLOYEE, id: 'e-1' },
      data: { title: 'c' },
    });
    const error = await captureStateError(
      runMutationWrites({
        table,
        writes: [
          {
            op: 'create',
            model: EXPENSE,
            id: 'x-1' as RecordId,
            parent: { model: CHECKLIST, id: 'c-1' as RecordId },
            data: { title: 'lunch' },
          },
        ],
        context: ctx(),
        store,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.equal(
      error.message,
      'Invalid parent for model "expenses.Expense": expected parent model "employee.Employee".',
    );
  });

  it('rejects a smuggled parent on a declared app root', async () => {
    const { store } = createTestMemoryStorage();
    const table = importedTable();
    await seedStoredRow(store, EMPLOYEE, { id: 'e-1', data: { name: 'ada' } });
    const error = await captureStateError(
      runMutationWrites({
        table,
        writes: [
          {
            op: 'create',
            model: CONFIG,
            id: 'k-1' as RecordId,
            parent: { model: EMPLOYEE, id: 'e-1' as RecordId },
            data: { title: 'k' },
          },
        ],
        context: ctx(),
        store,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.equal(error.message, 'Parent linkage is not allowed for model "hr.Config".');
  });

  it('rejects a smuggled parent on a declared team root', async () => {
    const { store } = createTestMemoryStorage();
    const table = importedTable();
    await seedStoredRow(store, EMPLOYEE, { id: 'e-1', data: { name: 'ada' } });
    const error = await captureStateError(
      runMutationWrites({
        table,
        writes: [
          {
            op: 'create',
            model: EMPLOYEE,
            id: 'e-2' as RecordId,
            parent: { model: EMPLOYEE, id: 'e-1' as RecordId },
            data: { name: 'bob' },
          },
        ],
        context: ctx(),
        store,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.equal(error.message, 'Parent linkage is not allowed for model "employee.Employee".');
  });

  it('keeps legacy accept-any posture for undeclared tables', async () => {
    const { store } = createTestMemoryStorage();
    const table = buildModelTable([
      modelDef('Acme.Gadget', { fields: { title: field() } }),
      modelDef('Acme.Widget', { fields: { title: field() } }),
    ]);
    await seedStoredRow(store, asModel('Acme.Gadget'), { id: 'g-1', data: { title: 'g' } });
    // Undeclared parent linkage still links (pre-B5 behavior, intact).
    const linked = await runMutationWrites({
      table,
      writes: [
        {
          op: 'create',
          model: asModel('Acme.Widget'),
          id: 'w-1' as RecordId,
          parent: { model: asModel('Acme.Gadget'), id: 'g-1' as RecordId },
          data: { title: 'w' },
        },
      ],
      context: ctx(),
      store,
    });
    await commitOutput(store, linked);
    const row = (await store.load(asModel('Acme.Widget'), 'w-1' as RecordId)) as StoredRow;
    assert.deepEqual(row.parent, { model: asModel('Acme.Gadget'), id: 'g-1' });
  });

  it('rejects hook-staged child creates under the wrong parent', async () => {
    const { store } = createTestMemoryStorage();
    const table = buildModelTable([
      { ...modelDef('employee.Employee', { fields: { name: field() } }), containment: {} },
      containedDef('expenses.Expense', 'employee.Employee'),
      {
        ...modelDef('onboard.Checklist', {
          fields: { title: field() },
          hooks: [
            hook('stage-expense', ['create'], (candidate, hookCtx) => {
              hookCtx.stage({
                op: 'create',
                model: asModel('expenses.Expense'),
                id: 'x-staged' as RecordId,
                parent: { model: asModel('onboard.Checklist'), id: 'c-1' as RecordId },
                data: { title: 'staged' },
              });
              return candidate;
            }),
          ],
        }),
        containment: { parent: asModel('employee.Employee') },
      },
    ]);
    await seedStoredRow(store, EMPLOYEE, { id: 'e-1', data: { name: 'ada' } });
    const error = await captureStateError(
      runMutationWrites({
        table,
        writes: [
          {
            op: 'create',
            model: asModel('onboard.Checklist'),
            id: 'c-1' as RecordId,
            parent: { model: EMPLOYEE, id: 'e-1' as RecordId },
            data: { title: 'c' },
          },
        ],
        context: ctx(),
        store,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.equal(
      error.message,
      'Invalid parent for model "expenses.Expense": expected parent model "employee.Employee".',
    );
  });

  it('keeps parent linkage immutable on update', async () => {
    const { store } = createTestMemoryStorage();
    const table = importedTable();
    await seedStoredRow(store, EMPLOYEE, { id: 'e-1', data: { name: 'ada' } });
    await seedStoredRow(store, EXPENSE, {
      id: 'x-1',
      parent: { model: EMPLOYEE, id: 'e-1' },
      data: { title: 'lunch' },
    });
    const error = await captureStateError(
      runMutationWrites({
        table,
        writes: [
          {
            op: 'update',
            model: EXPENSE,
            id: 'x-1' as RecordId,
            parent: { model: EMPLOYEE, id: 'e-1' as RecordId },
            data: { title: 'dinner' },
          },
        ],
        context: ctx(),
        store,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.equal(error.message, 'Parent linkage is immutable.');
  });
});

describe('B5 invoke: generated child/root agreement', () => {
  it('Member.create without parent fails at admission (required input)', async () => {
    const world = await setupShopWorld();
    const error = await captureStateError(
      crudInvoke(world, MEMBER_CREATE, nextOperationId(), { name: 'm-no-parent' }),
    );
    assert.equal(error.code, 'validation');
    assert.equal(error.message, 'Invalid operation inputs.');
    assert.deepEqual(
      (error.fields ?? []).map((field) => field.path),
      ['/parent'],
    );
  });

  it('Team.create with a smuggled parent fails closed', async () => {
    const world = await setupShopWorld();
    const error = await captureStateError(
      crudInvoke(world, TEAM_CREATE, nextOperationId(), {
        ...minimalTeamInputs(),
        parent: { id: 'team-x' },
      }),
    );
    assert.equal(error.code, 'validation');
    // Admission's closed input shape fires first (`parent` is undeclared
    // on Team.create); the pipeline root rule is defense in depth.
    assert.equal(error.message, 'Invalid operation inputs.');
    assert.deepEqual(
      (error.fields ?? []).map((field) => field.path),
      ['/parent'],
    );
  });

  it('Team.create stays clean and Member.create links under it', async () => {
    const world = await setupShopWorld();
    const teamId = nextOperationId();
    const team = await crudInvoke(world, TEAM_CREATE, teamId, minimalTeamInputs());
    assert.equal(team.status, 'committed');
    const member = await crudInvoke(world, MEMBER_CREATE, nextOperationId(), {
      name: 'm-one',
      parent: { id: teamId },
    });
    assert.equal(member.status, 'committed');
    const row = member.result as StoredRow;
    assert.deepEqual(row.parent, { model: TEAM, id: teamId });
  });
});

describe('B5 storage: atomicity, collections, lifecycle pins', () => {
  it('co-commits a same-batch imported parent+child atomically', async () => {
    const { store } = createTestMemoryStorage();
    const table = importedTable();
    const output = await runMutationWrites({
      table,
      writes: [
        { op: 'create', model: EMPLOYEE, id: 'e-1' as RecordId, data: { name: 'ada' } },
        {
          op: 'create',
          model: EXPENSE,
          id: 'x-1' as RecordId,
          parent: { model: EMPLOYEE, id: 'e-1' as RecordId },
          data: { title: 'lunch' },
        },
      ],
      context: ctx(),
      store,
    });
    await commitOutput(store, output);
    const parent = await store.load(EMPLOYEE, 'e-1' as RecordId);
    const child = (await store.load(EXPENSE, 'x-1' as RecordId)) as StoredRow;
    assert.ok(parent !== null);
    assert.deepEqual(child.parent, { model: EMPLOYEE, id: 'e-1' });
  });

  it('rolls a same-batch parent back when the child fails containment', async () => {
    const { store } = createTestMemoryStorage();
    const table = importedTable();
    const error = await captureStateError(
      runMutationWrites({
        table,
        writes: [
          { op: 'create', model: EMPLOYEE, id: 'e-1' as RecordId, data: { name: 'ada' } },
          {
            op: 'create',
            model: EXPENSE,
            id: 'x-1' as RecordId,
            parent: { model: asModel('onboard.Checklist'), id: 'c-9' as RecordId },
            data: { title: 'lunch' },
          },
        ],
        context: ctx(),
        store,
      }),
    );
    assert.equal(error.code, 'validation');
    // Validation throws before anything commits: the parent never lands.
    assert.equal(await store.load(EMPLOYEE, 'e-1' as RecordId), null);
  });

  it('serves reverse parent collections over imported linkage', async () => {
    const { store } = createTestMemoryStorage();
    const table = importedTable();
    await seedStoredRow(store, EMPLOYEE, { id: 'e-1', data: { name: 'ada' } });
    await seedStoredRow(store, EXPENSE, {
      id: 'x-1',
      parent: { model: EMPLOYEE, id: 'e-1' },
      data: { title: 'a' },
    });
    await seedStoredRow(store, EXPENSE, {
      id: 'x-2',
      parent: { model: EMPLOYEE, id: 'e-1' },
      data: { title: 'b' },
    });
    assert.equal(table.get(EXPENSE)?.containment?.parent, EMPLOYEE);
    const children = await store.query({
      model: EXPENSE,
      parent: { model: EMPLOYEE, id: 'e-1' as RecordId },
      authority: 'owner',
    });
    assert.deepEqual(
      children.map((row) => row.id).sort(),
      ['x-1', 'x-2'],
    );
  });

  it('pins no subtree cascade: archiving a parent leaves children live', async () => {
    const { store } = createTestMemoryStorage();
    const table = importedTable();
    await seedStoredRow(store, EMPLOYEE, { id: 'e-1', data: { name: 'ada' } });
    await seedStoredRow(store, EXPENSE, {
      id: 'x-1',
      parent: { model: EMPLOYEE, id: 'e-1' },
      data: { title: 'lunch' },
    });
    const output = await runMutationWrites({
      table,
      writes: [{ op: 'remove', model: EMPLOYEE, id: 'e-1' as RecordId }],
      context: ctx(),
      store,
    });
    await commitOutput(store, output);
    // No cascade (explicit remainder): the child row is untouched and live.
    const child = (await store.load(EXPENSE, 'x-1' as RecordId)) as StoredRow;
    assert.equal(child.archivedAt, null);
    assert.deepEqual(child.parent, { model: EMPLOYEE, id: 'e-1' });
    // ...but new children under the archived parent stay rejected.
    const error = await captureStateError(
      runMutationWrites({
        table,
        writes: [
          {
            op: 'create',
            model: EXPENSE,
            id: 'x-2' as RecordId,
            parent: { model: EMPLOYEE, id: 'e-1' as RecordId },
            data: { title: 'more' },
          },
        ],
        context: ctx(),
        store,
      }),
    );
    assert.equal(error.code, 'validation');
    assert.equal(error.message, 'Parent record is archived.');
  });
});
